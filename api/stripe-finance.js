/* GET /api/stripe-finance — everything the Finance page needs from Stripe that
 * /api/stripe-metrics does not already return. Aug 20 2026.
 *
 * Auth: owner/admin only. Money is not a sales-rep screen.
 *
 * What comes back, and why each piece is here:
 *   subscriptions[]  — one row per subscription with its start and cancel
 *                      dates, so the page can work out what is NEW money and
 *                      what WALKED OUT this month. Stripe will not tell you
 *                      that from a total.
 *   revenueByCustomer[] — 12 months of paid charges grouped by customer, which
 *                      is how "one client is 40% of the money" gets spotted.
 *   dailyRevenue[]   — net of refunds, per day, so any chart can re-bucket.
 *   feesByMonth      — the card fees Stripe actually charged us. A real cost,
 *                      measured, not the 2.9% everyone quotes from memory.
 *   refundsByMonth   — money handed back. Netted out of revenue already; here
 *                      on its own so it can be seen.
 *   invoices[]       — Stripe's own invoices, READ ONLY. Nothing in this
 *                      console ever writes to Stripe.
 *   customersByMonth — how many customers first appeared each month, which is
 *                      the divisor in the cost-per-new-client number.
 *
 * Pagination is capped so a big account cannot run the function past its
 * timeout. When a cap is hit the reply says `truncated: true` and the page
 * prints it — a total that quietly stops counting is a lie.
 */

import { requireMember } from "../lib/supabase-server.js";
import { getStripe, isStripeConfigured, subscriptionMrrCents } from "../lib/stripe-server.js";

const MAX_PAGES = 10; // 10 × 100 rows per resource

function monthOf(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  if (!isStripeConfigured()) return res.status(200).json({ configured: false });

  const stripe = getStripe();
  const now = new Date();
  const monthKeys = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    monthKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const oldest = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1) / 1000);

  try {
    /* ---- customers first: we need names for the by-client table ---- */
    const customerName = {};
    const customersByMonth = Object.fromEntries(monthKeys.map((k) => [k, 0]));
    let customerCount = 0;
    let customersTruncated = false;
    {
      let startingAfter;
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await stripe.customers.list({ limit: 100, starting_after: startingAfter });
        for (const c of batch.data) {
          customerName[c.id] = c.name || c.email || c.id;
          customerCount += 1;
          const k = monthOf(c.created);
          if (k in customersByMonth) customersByMonth[k] += 1;
        }
        if (!batch.has_more) break;
        startingAfter = batch.data[batch.data.length - 1]?.id;
        if (page === MAX_PAGES - 1) customersTruncated = true;
      }
    }

    /* ---- subscriptions: the movement rows ---- */
    const subscriptions = [];
    let subsTruncated = false;
    {
      let startingAfter;
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await stripe.subscriptions.list({ status: "all", limit: 100, starting_after: startingAfter });
        for (const s of batch.data) {
          const mrr = subscriptionMrrCents(s);
          const price = s.items?.data?.[0]?.price;
          subscriptions.push({
            id: s.id,
            customer: typeof s.customer === "string" ? s.customer : s.customer?.id,
            customerName: customerName[typeof s.customer === "string" ? s.customer : s.customer?.id] || null,
            plan: price?.nickname || price?.id || "unknown",
            status: s.status,
            // Live subscriptions carry today's MRR. A cancelled one reports 0,
            // so its old value is carried separately — otherwise churn always
            // looks like zero dollars, which is the flattering kind of wrong.
            mrrCents: (s.status === "active" || s.status === "trialing") ? mrr : 0,
            lastMrrCents: mrr,
            created: s.created,
            canceledAt: s.canceled_at || s.ended_at || null,
            currentPeriodEnd: s.current_period_end || null,
          });
        }
        if (!batch.has_more) break;
        startingAfter = batch.data[batch.data.length - 1]?.id;
        if (page === MAX_PAGES - 1) subsTruncated = true;
      }
    }

    /* ---- charges: daily money in, fees, refunds, and who paid ---- */
    const daily = {};
    const grossByMonth = Object.fromEntries(monthKeys.map((k) => [k, 0]));
    const feesByMonth = Object.fromEntries(monthKeys.map((k) => [k, 0]));
    const refundsByMonth = Object.fromEntries(monthKeys.map((k) => [k, 0]));
    const revenueByCustomer = {};
    const recentTransactions = [];
    let chargesTruncated = false;
    let feesMeasured = true;
    {
      let startingAfter;
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await stripe.charges.list({
          limit: 100, starting_after: startingAfter, created: { gte: oldest },
          // The fee lives on the balance transaction, not the charge. Expanding
          // it is the only way to know what Stripe actually took.
          expand: ["data.balance_transaction"],
        });
        for (const ch of batch.data) {
          if (ch.status !== "succeeded" || !ch.paid) continue;
          const k = monthOf(ch.created);
          /* GROSS, not net. A refund issued in August against a January charge
           * must not rewrite January — January was already reported. Refunds are
           * counted below, in the month the money actually left. */
          const dayKey = new Date(ch.created * 1000).toISOString().slice(0, 10);
          daily[dayKey] = (daily[dayKey] || 0) + ch.amount;
          // Charges are pulled from the first of the oldest month onwards, so
          // every one of them has a key here. Both sides of the page use these
          // same keys, which is what stops a boundary payment falling down a
          // crack between a UTC day and a local month.
          if (k in grossByMonth) grossByMonth[k] += ch.amount;
          const bt = ch.balance_transaction;
          if (bt && typeof bt === "object" && typeof bt.fee === "number") {
            if (k in feesByMonth) feesByMonth[k] += bt.fee;
          } else {
            feesMeasured = false;
          }
          const cid = typeof ch.customer === "string" ? ch.customer : ch.customer?.id;
          if (cid) {
            const rec = revenueByCustomer[cid] || { id: cid, name: customerName[cid] || cid, cents: 0, payments: 0 };
            rec.cents += ch.amount - (ch.amount_refunded || 0);
            rec.payments += 1;
            revenueByCustomer[cid] = rec;
          }
          if (recentTransactions.length < 12) {
            recentTransactions.push({
              kind: "in",
              amountCents: ch.amount - (ch.amount_refunded || 0),
              created: ch.created,
              label: customerName[cid] || ch.billing_details?.email || ch.description || "Payment",
              description: ch.description || null,
            });
          }
        }
        if (!batch.has_more) break;
        startingAfter = batch.data[batch.data.length - 1]?.id;
        if (page === MAX_PAGES - 1) chargesTruncated = true;
      }
    }

    /* ---- refunds, in the month the money actually went back ---- */
    let refundsTruncated = false;
    {
      let startingAfter;
      for (let page = 0; page < 5; page++) {
        const batch = await stripe.refunds.list({ limit: 100, starting_after: startingAfter, created: { gte: oldest } });
        for (const r of batch.data) {
          if (r.status && r.status !== "succeeded" && r.status !== "pending") continue;
          const k = monthOf(r.created);
          if (k in refundsByMonth) refundsByMonth[k] += r.amount || 0;
        }
        if (!batch.has_more) break;
        startingAfter = batch.data[batch.data.length - 1]?.id;
        if (page === 4) refundsTruncated = true;
      }
    }

    // Money in for a month = what was charged, minus what was handed back that
    // same month. One place, so the page cannot bucket it two different ways.
    const revenueByMonth = Object.fromEntries(
      monthKeys.map((k) => [k, grossByMonth[k] - (refundsByMonth[k] || 0)])
    );

    /* ---- Stripe's own invoices, read only ---- */
    const invoices = [];
    let invoicesTruncated = false;
    {
      let startingAfter;
      for (let page = 0; page < 5; page++) {
        const batch = await stripe.invoices.list({ limit: 100, starting_after: startingAfter, created: { gte: oldest } });
        for (const inv of batch.data) {
          invoices.push({
            id: inv.id,
            number: inv.number || null,
            customerName: inv.customer_name || customerName[typeof inv.customer === "string" ? inv.customer : inv.customer?.id] || null,
            customerEmail: inv.customer_email || null,
            status: inv.status,
            totalCents: inv.total,
            paidCents: inv.amount_paid,
            dueCents: inv.amount_remaining,
            created: inv.created,
            dueDate: inv.due_date || null,
            hostedUrl: inv.hosted_invoice_url || null,
            pdfUrl: inv.invoice_pdf || null,
          });
        }
        if (!batch.has_more) break;
        startingAfter = batch.data[batch.data.length - 1]?.id;
        if (page === 4) invoicesTruncated = true;
      }
    }

    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({
      configured: true,
      livemode: !String(process.env.STRIPE_SECRET_KEY).includes("_test_"),
      months: monthKeys,
      subscriptions,
      customerCount,
      customersByMonth,
      // The monthly map is the one the Finance page uses. Both sides bucket by
      // the SAME calendar here, so a boundary charge cannot fall down a crack
      // between a UTC day and a local month.
      revenueByMonth,
      grossByMonth,
      dailyRevenue: Object.keys(daily).sort().map((d) => ({ d, cents: daily[d] })),
      feesByMonth,
      // false = at least one charge did not hand back its fee, so the fee total
      // is a floor, not the whole bill. The page says so when this is false.
      feesMeasured,
      refundsByMonth,
      revenueByCustomer: Object.values(revenueByCustomer).sort((a, b) => b.cents - a.cents),
      recentTransactions,
      invoices,
      truncated: subsTruncated || chargesTruncated || customersTruncated || invoicesTruncated || refundsTruncated,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(502).json({ error: `Stripe error: ${err.message}` });
  }
}
