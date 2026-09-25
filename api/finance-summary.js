/* GET /api/finance-summary[?refresh=1] — THE FINANCE PAGE'S ONE STRIPE READ.
 * 24 Sep 2026. Owners only.
 *
 * Ryder: "we need to seperate this to two departments, one for the platform
 * and just people buy the platform, then one for the largest agency
 * purchases where we actually are helping them implement."
 *
 * So every payment leaves here with a DEPARTMENT on it:
 *
 *   platform — paid through a Stripe SUBSCRIPTION (someone bought the
 *              software). Stripe's own invoice says billing_reason
 *              "subscription_create / _cycle / _update".
 *   agency   — a one-off invoice we sent by hand ("Payment for Invoice",
 *              billing_reason "manual") or any other one-off payment. On
 *              24 Sep 2026 that is Joseph Ikeguchi, Dahler, Jessica
 *              Mackrael, Michelle Creamer and Justin Dyar.
 *
 * The automatic rule is right for everybody we could see on 24 Sep 2026. For
 * the day it is not, an owner flips a customer on the page and the choice is
 * stored in admin_finance_departments (migration 0041). A stored choice
 * always beats the rule.
 *
 * WHAT COMES BACK is one row per payment, per refund and per subscription —
 * not month totals. There are dozens of them, not thousands, and handing the
 * page the rows is what lets it answer ANY date range (a custom week, a
 * quarter, all time) without asking Stripe again. Dates are the team's
 * calendar (Chicago), so a payment at 9pm on the 31st lands in the month it
 * happened in, not the next one.
 *
 * Nothing here writes to Stripe.
 */

import { requireMember, getAdminSupabase } from "../lib/supabase-server.js";
import { getStripe, isStripeConfigured, subscriptionMrrCents } from "../lib/stripe-server.js";
import { teamDate } from "../lib/brain-context.js";

const CACHE_MS = 60_000;
let cache = null;

const MAX_PAGES = 20; // 20 × 100 rows per resource

async function listAll(fn, params, max = MAX_PAGES) {
  const out = [];
  let startingAfter;
  let truncated = false;
  for (let page = 0; page < max; page += 1) {
    const batch = await fn({ limit: 100, ...params, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    out.push(...batch.data);
    if (!batch.has_more) return { rows: out, truncated: false };
    startingAfter = batch.data[batch.data.length - 1]?.id;
    if (page === max - 1) truncated = true;
  }
  return { rows: out, truncated };
}

const day = (unix) => (unix ? teamDate(unix * 1000) : null);
const idOf = (x) => (typeof x === "string" ? x : x?.id || null);

/** Which side a payment belongs to, and the one-line reason — shown on the
 * page next to every payment, so a wrong call is easy to spot and flip. */
export function departmentFor({ override, invoiceReason, hasSubscription, description }) {
  if (override === "platform" || override === "agency") return { dept: override, why: "set by an owner" };
  if (invoiceReason) {
    if (/^subscription/.test(invoiceReason)) return { dept: "platform", why: "subscription payment" };
    if (invoiceReason === "manual") return { dept: "agency", why: "one-off invoice" };
  }
  if (hasSubscription) return { dept: "platform", why: "subscription payment" };
  if (/^subscription/i.test(description || "")) return { dept: "platform", why: "subscription payment" };
  if (/payment for invoice/i.test(description || "")) return { dept: "agency", why: "one-off invoice" };
  return { dept: "agency", why: "one-off payment" };
}

/* What a subscription really charges a month after its discounts. Percent off
 * is applied; a fixed amount off is spread per month the same way the price
 * is. A "once" coupon has already been used up by the first invoice. */
export function discountedMrr(sub, mrr) {
  const list = [
    ...(Array.isArray(sub?.discounts) ? sub.discounts : []),
    ...(sub?.discount ? [sub.discount] : []),
  ].filter((d) => d && typeof d === "object");
  let out = mrr;
  for (const d of list) {
    const c = d.coupon || d.source?.coupon;
    if (!c || c.duration === "once") continue;
    if (d.end && d.end * 1000 < Date.now()) continue;
    if (typeof c.percent_off === "number") out = out * (1 - c.percent_off / 100);
    else if (typeof c.amount_off === "number") {
      const rec = sub.items?.data?.[0]?.price?.recurring;
      const months = rec?.interval === "year" ? 12 * (rec.interval_count || 1) : (rec?.interval_count || 1);
      out -= c.amount_off / months;
    }
  }
  return Math.max(0, Math.round(out));
}

async function readOverrides() {
  const admin = getAdminSupabase();
  if (!admin) return { map: {}, ready: false };
  const { data, error } = await admin.from("admin_finance_departments").select("stripe_customer_id, department, note, set_at");
  if (error) return { map: {}, ready: false, error: error.message };
  return { map: Object.fromEntries((data || []).map((r) => [r.stripe_customer_id, r.department])), ready: true };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req, ["owner"]);
  if (!member) return res.status(401).json({ error: "Owners only." });
  if (!isStripeConfigured()) return res.status(200).json({ configured: false });

  const refresh = (req.query || {}).refresh === "1";
  if (cache && !refresh && Date.now() - cache.at < CACHE_MS) {
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({ ...cache.body, cached: true });
  }

  const started = Date.now();
  const stripe = getStripe();
  try {
    /* Everything at once. Five lists, read side by side. */
    const [cust, subs, charges, refunds, invoices, overrides] = await Promise.all([
      listAll((p) => stripe.customers.list(p), {}),
      /* Discounts expanded, so a 100%-off seat is not counted as paying at
       * list price. */
      listAll((p) => stripe.subscriptions.list(p), { status: "all", expand: ["data.discounts"] }).catch(() =>
        listAll((p) => stripe.subscriptions.list(p), { status: "all" })),
      /* The fee lives on the balance transaction, not the charge. Expanding
       * it is the only way to know what Stripe actually took. */
      listAll((p) => stripe.charges.list(p), { expand: ["data.balance_transaction"] }),
      listAll((p) => stripe.refunds.list(p), {}, 10),
      /* `payments` links an invoice to the payment intent that paid it, which
       * is how a charge finds its invoice on this API version (Charge.invoice
       * was removed). Asked for, and read defensively below. */
      listAll((p) => stripe.invoices.list(p), { expand: ["data.payments"] }).catch(() =>
        listAll((p) => stripe.invoices.list(p), {})),
      readOverrides(),
    ]);

    const customers = {};
    for (const c of cust.rows) {
      customers[c.id] = { id: c.id, name: c.name || c.email || c.id, email: c.email || null, created: day(c.created) };
    }
    const nameOf = (id) => customers[id]?.name || id || "Unknown";

    /* Invoice by payment intent, and by id. `invoicesLinked` says whether the
     * payments link came back at all — without it every charge is sorted by
     * its description alone, and the page says so. */
    const invoicesLinked = invoices.rows.some((i) => Array.isArray(i.payments?.data));
    const invoiceByPi = {};
    const invoiceById = {};
    for (const inv of invoices.rows) {
      invoiceById[inv.id] = inv;
      const pi = idOf(inv.payment_intent);
      if (pi) invoiceByPi[pi] = inv;
      for (const p of inv.payments?.data || []) {
        const ppi = idOf(p?.payment?.payment_intent) || idOf(p?.payment_intent);
        if (ppi) invoiceByPi[ppi] = inv;
        const pch = idOf(p?.payment?.charge);
        if (pch) invoiceById[`charge:${pch}`] = inv;
      }
    }

    /* ---- subscriptions: who bought the platform, and what they pay ---- */
    const subscriptions = subs.rows.map((s) => {
      const mrr = discountedMrr(s, subscriptionMrrCents(s));
      const price = s.items?.data?.[0]?.price;
      const cid = idOf(s.customer);
      return {
        id: s.id,
        customerId: cid,
        customerName: nameOf(cid),
        status: s.status,
        mrrCents: (s.status === "active" || s.status === "trialing" || s.status === "past_due") ? mrr : 0,
        lastMrrCents: mrr,
        plan: price?.nickname || price?.lookup_key || null,
        priceId: price?.id || null,
        started: day(s.start_date || s.created),
        ended: day(s.ended_at || s.canceled_at),
        cancelAt: day(s.cancel_at),
        trialEnd: day(s.trial_end),
      };
    });
    const hasSub = new Set(subscriptions.map((s) => s.customerId));

    /* ---- payments ---- */
    let feesMeasured = true;
    const chargeDept = {};
    const transactions = [];
    for (const ch of charges.rows) {
      /* Captured only: an authorised-but-not-captured charge is not money. */
      if (ch.status !== "succeeded" || !ch.paid || ch.captured === false) continue;
      const cid = idOf(ch.customer);
      const inv = invoiceById[idOf(ch.invoice)] || invoiceByPi[idOf(ch.payment_intent)] || invoiceById[`charge:${ch.id}`] || null;
      const facts = {
        invoiceReason: inv?.billing_reason || null,
        hasSubscription: Boolean(inv?.parent?.subscription_details?.subscription),
        description: ch.description,
      };
      const { dept, why } = departmentFor({ override: overrides.map[cid], ...facts });
      /* What the rule alone would say — the page shows it beside an owner's
       * override, so undoing a flip is one click with the answer in view. */
      const autoDept = departmentFor(facts).dept;
      chargeDept[ch.id] = dept;
      const bt = ch.balance_transaction;
      let fee = null;
      if (bt && typeof bt === "object" && typeof bt.fee === "number") fee = bt.fee;
      else feesMeasured = false;
      transactions.push({
        id: ch.id,
        date: day(ch.created),
        cents: ch.amount,
        refundedCents: ch.amount_refunded || 0,
        feeCents: fee,
        customerId: cid,
        customerName: cid ? nameOf(cid) : (ch.billing_details?.name || ch.billing_details?.email || "Unknown"),
        dept,
        autoDept,
        why,
        description: ch.description || null,
        invoiceNumber: inv?.number || null,
      });
    }

    /* ---- refunds, on the day the money went back ---- */
    const refundRows = [];
    for (const r of refunds.rows) {
      if (r.status && r.status !== "succeeded" && r.status !== "pending") continue;
      const chId = idOf(r.charge);
      const tx = transactions.find((t) => t.id === chId);
      refundRows.push({
        id: r.id,
        date: day(r.created),
        cents: r.amount || 0,
        chargeId: chId,
        dept: chargeDept[chId] || "agency",
        customerName: tx?.customerName || null,
      });
    }

    /* ---- invoices still owed (agency money on its way) ---- */
    const openInvoices = invoices.rows
      .filter((i) => i.status === "open" && (i.amount_remaining || 0) > 0)
      .map((i) => {
        const cid = idOf(i.customer);
        const { dept } = departmentFor({
          override: overrides.map[cid],
          invoiceReason: i.billing_reason,
          hasSubscription: Boolean(i.parent?.subscription_details?.subscription),
          description: null,
        });
        return {
          id: i.id,
          number: i.number || null,
          customerId: cid,
          customerName: i.customer_name || nameOf(cid),
          dueCents: i.amount_remaining,
          totalCents: i.total,
          created: day(i.created),
          dueDate: day(i.due_date),
          dept,
          hostedUrl: i.hosted_invoice_url || null,
        };
      })
      .sort((a, b) => (a.dueDate || a.created || "").localeCompare(b.dueDate || b.created || ""));

    /* Each customer's side, for the page's "flip" control and for the AI
     * Cost page (a workspace owned by an agency client is agency cost). */
    for (const c of Object.values(customers)) {
      const mine = transactions.filter((t) => t.customerId === c.id);
      const auto = mine.length
        ? (mine.some((t) => t.autoDept === "agency") ? "agency" : "platform")
        : (hasSub.has(c.id) ? "platform" : "agency");
      c.override = overrides.map[c.id] || null;
      c.dept = c.override || auto;
      c.auto = auto;
    }

    const dates = transactions.map((t) => t.date).filter(Boolean).sort();
    const body = {
      configured: true,
      livemode: !String(process.env.STRIPE_SECRET_KEY).includes("_test_"),
      today: teamDate(Date.now()),
      earliest: dates[0] || null,
      transactions,
      refunds: refundRows,
      subscriptions,
      openInvoices,
      customers,
      overridesReady: overrides.ready,
      invoicesLinked,
      feesMeasured,
      truncated: cust.truncated || subs.truncated || charges.truncated || refunds.truncated || invoices.truncated,
      ms: Date.now() - started,
      fetchedAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), body };
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json(body);
  } catch (err) {
    return res.status(502).json({ error: `Stripe error: ${err.message}` });
  }
}
