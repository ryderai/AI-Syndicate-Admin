/* GET /api/stripe-metrics — revenue summary for the Overview page.
 * Auth: owner/admin. Computes everything live from Stripe:
 *   - MRR (active + trialing subscriptions, normalized to monthly)
 *   - active subscription count, total customers
 *   - gross revenue per month for the last 12 months (from charges)
 *   - gross revenue per DAY over the same window, so the Overview chart can
 *     re-bucket into weeks, months or quarters without another Stripe call
 *   - the 10 most recent successful payments
 * Caps pagination hard so a huge account can't blow the function timeout. */

import { requireMember } from "../lib/supabase-server.js";
import { getStripe, isStripeConfigured, subscriptionMrrCents } from "../lib/stripe-server.js";

const MAX_PAGES = 10; // 10 × 100 rows per resource

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  if (!isStripeConfigured()) {
    return res.status(200).json({ configured: false });
  }

  const stripe = getStripe();
  try {
    // ---- Subscriptions → MRR ----
    let mrrCents = 0;
    let activeSubs = 0;
    let trialingSubs = 0;
    const planCounts = {};
    let subsTruncated = false;
    {
      let startingAfter;
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await stripe.subscriptions.list({
          status: "all", limit: 100, starting_after: startingAfter,
        });
        for (const sub of batch.data) {
          if (sub.status === "active" || sub.status === "trialing") {
            mrrCents += subscriptionMrrCents(sub);
            if (sub.status === "active") activeSubs++;
            else trialingSubs++;
            const nickname = sub.items?.data?.[0]?.price?.nickname
              || sub.items?.data?.[0]?.price?.id || "unknown";
            planCounts[nickname] = (planCounts[nickname] || 0) + 1;
          }
        }
        if (!batch.has_more) break;
        startingAfter = batch.data[batch.data.length - 1]?.id;
        if (page === MAX_PAGES - 1) subsTruncated = true;
      }
    }

    // ---- Charges → monthly gross revenue, last 12 months ----
    const now = new Date();
    const monthKeys = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      monthKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    }
    const monthly = Object.fromEntries(monthKeys.map((k) => [k, 0]));
    // Same charges, also kept per day. ~370 numbers, so the client can switch
    // between weekly / monthly / quarterly with no extra round trip.
    const daily = {};
    const oldest = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1) / 1000;
    const recentPayments = [];
    let chargesTruncated = false;
    {
      let startingAfter;
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await stripe.charges.list({
          limit: 100, starting_after: startingAfter, created: { gte: Math.floor(oldest) },
        });
        for (const ch of batch.data) {
          if (ch.status !== "succeeded" || !ch.paid) continue;
          const d = new Date(ch.created * 1000);
          const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
          const net = ch.amount - (ch.amount_refunded || 0);
          if (key in monthly) monthly[key] += net;
          const dayKey = d.toISOString().slice(0, 10);
          daily[dayKey] = (daily[dayKey] || 0) + net;
          if (recentPayments.length < 10) {
            recentPayments.push({
              amount: ch.amount,
              currency: ch.currency,
              created: ch.created,
              description: ch.description || ch.calculated_statement_descriptor || "",
              customerEmail: ch.billing_details?.email || ch.receipt_email || null,
              refunded: Boolean(ch.amount_refunded),
            });
          }
        }
        if (!batch.has_more) break;
        startingAfter = batch.data[batch.data.length - 1]?.id;
        if (page === MAX_PAGES - 1) chargesTruncated = true;
      }
    }

    // ---- Customer count (cheap: search API count is unreliable; list total via pages) ----
    let customerCount = 0;
    let customersTruncated = false;
    {
      let startingAfter;
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await stripe.customers.list({ limit: 100, starting_after: startingAfter });
        customerCount += batch.data.length;
        if (!batch.has_more) break;
        startingAfter = batch.data[batch.data.length - 1]?.id;
        if (page === MAX_PAGES - 1) customersTruncated = true;
      }
    }

    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({
      configured: true,
      livemode: !String(process.env.STRIPE_SECRET_KEY).includes("_test_"),
      mrrCents,
      activeSubs,
      trialingSubs,
      customerCount,
      planCounts,
      monthlyRevenue: monthKeys.map((k) => ({ month: k, cents: monthly[k] })),
      dailyRevenue: Object.keys(daily).sort().map((d) => ({ d, cents: daily[d] })),
      recentPayments,
      truncated: subsTruncated || chargesTruncated || customersTruncated,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(502).json({ error: `Stripe error: ${err.message}` });
  }
}
