/* THE FINANCE PAGE'S MATHS — 24 Sep 2026.
 *
 * Ryder: "remove projected and cash runway. we need to really simplify this
 * to make it easy and the numbers work out correctly … two departments, one
 * for the platform … one for the largest agency purchases … the money in vs
 * money out must be accurate for all costs … filtered at the top by month."
 *
 * So this file answers four questions for any date range, and nothing else:
 *   1. What came IN, on each side (platform, agency)?
 *   2. What went OUT, and on which side?
 *   3. What did we KEEP (in − out)?
 *   4. How does that look over time (one bar per day or per month)?
 * No projections, no runway, no forecasts. Every figure here happened.
 *
 * WHERE EACH NUMBER COMES FROM
 *   money in      Stripe payments, minus refunds on the day the refund went
 *                 out. MEASURED.
 *   card fees     what Stripe actually took on each payment. MEASURED.
 *   AI            what each AI call cost, counted at the moment of the call
 *                 (api/ai-cost.js). METERED — our count, not the AI company's
 *                 bill, and calls to a model with no price are left out and
 *                 counted separately rather than added as $0.
 *   other costs   typed in by an owner (admin_expenses). Nothing else knows
 *                 what we pay for software, people or rent.
 *
 * WHICH SIDE A COST IS ON
 *   card fees     the side of the payment they were taken from.
 *   AI            the side of the account that ran it: a platform workspace
 *                 owned by an agency client's Stripe customer is agency cost;
 *                 any other workspace is platform cost. Calls with no account
 *                 (public tools, our own crons, the console) are SHARED.
 *   typed costs   whatever the owner picked; blank = shared.
 * Shared costs count in the company total and on NEITHER side alone. Splitting
 * them by a made-up percentage would make both sides' "kept" look precise
 * when it is not.
 *
 * ALL MONEY IS WHOLE CENTS except AI, which arrives in micro-dollars and is
 * rounded to cents once per bucket. Pure: data in, data out, no clock.
 */

import { daysIn, monthsIn, bucketFor, dayCount, monthEnd, addMonths } from "./money-range.js";

export const DEPTS = ["platform", "agency"];
export const DEPT_LABEL = { platform: "Platform", agency: "Agency", shared: "Shared" };

const inRange = (d, r) => Boolean(d) && d >= r.from && d <= r.to;
const microsToCents = (m) => Math.round((Number(m) || 0) / 10_000);

function blankSide() {
  return { in: 0, gross: 0, refunds: 0, fees: 0, ai: 0, typed: 0, out: 0, kept: 0, payments: 0 };
}

/* ---------------------------------------------------------------- */
/* Which side an AI row is on                                        */
/* ---------------------------------------------------------------- */

export function aiDept(row, { workspaces = {}, customers = {} } = {}) {
  if (row.workspace_id) {
    const ws = workspaces[row.workspace_id];
    const cust = ws?.stripeCustomerId ? customers[ws.stripeCustomerId] : null;
    if (cust?.dept === "agency") return "agency";
    return "platform";
  }
  if (row.client_id) return "agency";
  return "shared";
}

/* ---------------------------------------------------------------- */
/* Typed costs spread over a range                                    */
/* ---------------------------------------------------------------- */

/**
 * How much of one typed cost falls inside [range], split by bucket key.
 *   one_time  the whole amount on the day it was paid.
 *   monthly   the amount once per calendar month it runs; a range that holds
 *             only part of a month holds that share of it (10 of 30 days =
 *             a third). Said on screen.
 *   yearly    a twelfth per month, the same way.
 */
export function expenseInRange(e, range, bucket) {
  const out = {};
  const amount = Math.round(Number(e.amount_cents) || 0);
  const start = String(e.incurred_on || "").slice(0, 10);
  if (!start) return out;
  const end = e.ended_on ? String(e.ended_on).slice(0, 10) : null;
  const interval = e.interval || "one_time";
  if (interval === "one_time") {
    if (inRange(start, range)) out[bucket === "day" ? start : start.slice(0, 7)] = amount;
    return out;
  }
  const perMonth = interval === "yearly" ? amount / 12 : amount;
  for (const m of monthsIn(range)) {
    if (m < start.slice(0, 7)) continue;
    if (end && m > end.slice(0, 7)) continue;
    const mFrom = `${m}-01`;
    const mTo = monthEnd(mFrom);
    const from = range.from > mFrom ? range.from : mFrom;
    const to = range.to < mTo ? range.to : mTo;
    if (from > to) continue;
    const share = dayCount({ from, to }) / dayCount({ from: mFrom, to: mTo });
    const cents = perMonth * share;
    if (bucket === "month") {
      out[m] = (out[m] || 0) + cents;
    } else {
      /* Spread evenly over the days of that month inside the range. */
      const days = daysIn({ from, to });
      for (const d of days) out[d] = (out[d] || 0) + cents / days.length;
    }
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k]);
  return out;
}

/* ---------------------------------------------------------------- */
/* The whole page, for one range                                      */
/* ---------------------------------------------------------------- */

/**
 * @param summary   api/finance-summary reply (or null)
 * @param ai        api/ai-cost reply for the SAME range (or null)
 * @param expenses  admin_expenses rows
 * @param range     { from, to } inclusive, team calendar
 */
export function financeView({ summary, ai, expenses = [], range, bucket: forced = null, today = null }) {
  const bucket = forced || bucketFor(range);
  const keys = bucket === "day" ? daysIn(range) : monthsIn(range);
  const keyOf = (d) => (bucket === "day" ? d : d.slice(0, 7));
  const customers = summary?.customers || {};

  const sides = { platform: blankSide(), agency: blankSide(), shared: blankSide() };
  const series = Object.fromEntries(keys.map((k) => [k, {
    key: k, platformIn: 0, agencyIn: 0, fees: 0, ai: 0, typed: 0, out: 0, kept: 0,
    outDept: { platform: 0, agency: 0, shared: 0 },
  }]));
  const byCustomer = {};

  /* ---- money in ---- */
  for (const t of summary?.transactions || []) {
    if (!inRange(t.date, range)) continue;
    const s = sides[t.dept] || sides.agency;
    s.gross += t.cents;
    s.payments += 1;
    const b = series[keyOf(t.date)];
    if (b) b[t.dept === "platform" ? "platformIn" : "agencyIn"] += t.cents;
    if (typeof t.feeCents === "number") {
      s.fees += t.feeCents;
      if (b) { b.fees += t.feeCents; b.outDept[t.dept === "platform" ? "platform" : "agency"] += t.feeCents; }
    }
    const c = byCustomer[t.customerId || t.customerName] || (byCustomer[t.customerId || t.customerName] = {
      id: t.customerId, name: t.customerName, dept: t.dept, cents: 0, payments: 0, last: null,
    });
    c.cents += t.cents;
    c.payments += 1;
    if (!c.last || t.date > c.last) c.last = t.date;
  }
  for (const r of summary?.refunds || []) {
    if (!inRange(r.date, range)) continue;
    const s = sides[r.dept] || sides.agency;
    s.refunds += r.cents;
    const b = series[keyOf(r.date)];
    if (b) b[r.dept === "platform" ? "platformIn" : "agencyIn"] -= r.cents;
    const tx = (summary.transactions || []).find((t) => t.id === r.chargeId);
    const c = tx && byCustomer[tx.customerId || tx.customerName];
    if (c) c.cents -= r.cents;
  }

  /* ---- AI, metered ---- */
  const aiByDeptMicros = { platform: 0, agency: 0, shared: 0 };
  let aiUnpricedCalls = 0;
  let aiCalls = 0;
  const aiByBucketMicros = {};
  const aiByBucketDeptMicros = {};
  for (const row of ai?.rows || []) {
    if (!inRange(row.day, range)) continue;
    const dept = aiDept(row, { workspaces: ai.workspaces || {}, customers });
    aiByDeptMicros[dept] += row.cost_micros || 0;
    aiCalls += row.calls || 0;
    aiUnpricedCalls += (row.calls || 0) - (row.priced_calls || 0);
    const k = keyOf(row.day);
    aiByBucketMicros[k] = (aiByBucketMicros[k] || 0) + (row.cost_micros || 0);
    const bd = aiByBucketDeptMicros[k] || (aiByBucketDeptMicros[k] = { platform: 0, agency: 0, shared: 0 });
    bd[dept] += row.cost_micros || 0;
  }
  for (const d of ["platform", "agency", "shared"]) sides[d].ai = microsToCents(aiByDeptMicros[d]);
  for (const [k, m] of Object.entries(aiByBucketMicros)) if (series[k]) series[k].ai = microsToCents(m);
  for (const [k, bd] of Object.entries(aiByBucketDeptMicros)) {
    if (!series[k]) continue;
    for (const d of ["platform", "agency", "shared"]) series[k].outDept[d] += microsToCents(bd[d]);
  }

  /* ---- typed costs ---- */
  const typedByCategory = {};
  const typedRows = [];
  for (const e of expenses || []) {
    const hits = expenseInRange(e, range, bucket);
    const dept = e.department === "platform" || e.department === "agency" ? e.department : "shared";
    let total = 0;
    for (const [k, cents] of Object.entries(hits)) {
      total += cents;
      if (series[k]) { series[k].typed += cents; series[k].outDept[dept] += cents; }
    }
    if (!total) continue;
    sides[dept].typed += total;
    typedByCategory[e.category || "Other"] = (typedByCategory[e.category || "Other"] || 0) + total;
    typedRows.push({ ...e, inRangeCents: total, dept });
  }

  /* ---- totals ---- */
  for (const d of ["platform", "agency", "shared"]) {
    const s = sides[d];
    s.in = s.gross - s.refunds;
    s.out = s.fees + s.ai + s.typed;
    s.kept = s.in - s.out;
  }
  for (const b of Object.values(series)) {
    b.out = b.fees + b.ai + b.typed;
    b.kept = b.platformIn + b.agencyIn - b.out;
  }
  const all = {
    in: sides.platform.in + sides.agency.in,
    gross: sides.platform.gross + sides.agency.gross,
    refunds: sides.platform.refunds + sides.agency.refunds,
    fees: sides.platform.fees + sides.agency.fees + sides.shared.fees,
    ai: sides.platform.ai + sides.agency.ai + sides.shared.ai,
    typed: sides.platform.typed + sides.agency.typed + sides.shared.typed,
  };
  all.out = all.fees + all.ai + all.typed;
  all.kept = all.in - all.out;
  all.margin = all.in > 0 ? all.kept / all.in : null;

  /* ---- the platform: who pays for the software ----
   * AS OF THE END OF THE PERIOD. A subscription counts if it had started by
   * the last day and had not ended by then. For a period that runs to today
   * that is simply "today"; for last month it is how things stood on the
   * 31st — so the subscriber count always matches the money beside it.
   *
   * PAYING = more than $0 a month. On 24 Sep 2026 five of seven active
   * subscriptions were on a $0 price; counting them as "paying clients" is how
   * the old page got to 7 paying and a $56.86 average. They are counted,
   * separately, as free seats. A trial is not paying yet. */
  const subs = summary?.subscriptions || [];
  const endDay = range.to;
  const nowDay = today || endDay;
  const endsToday = endDay >= nowDay;
  const liveAt = (s) => {
    if (endsToday) return ["active", "past_due", "trialing"].includes(s.status);
    return Boolean(s.started) && s.started <= endDay && (!s.ended || s.ended > endDay);
  };
  const isTrial = (s) => (endsToday ? s.status === "trialing" : Boolean(s.trialEnd && s.trialEnd > endDay));
  const payingNow = subs.filter((s) => liveAt(s) && !isTrial(s) && (s.lastMrrCents || 0) > 0);
  const freeNow = subs.filter((s) => liveAt(s) && !(s.lastMrrCents > 0));
  const trialNow = subs.filter((s) => liveAt(s) && isTrial(s) && (s.lastMrrCents || 0) > 0);
  const newPaying = subs.filter((s) => (s.lastMrrCents || 0) > 0 && inRange(s.started, range));
  const cancelled = subs.filter((s) => (s.lastMrrCents || 0) > 0 && inRange(s.ended, range));
  const platform = {
    asOf: endsToday ? "today" : endDay,
    mrrCents: payingNow.reduce((a, s) => a + (s.lastMrrCents || 0), 0),
    paying: payingNow.map((s) => ({ name: s.customerName, mrrCents: s.lastMrrCents, started: s.started, plan: s.plan, pastDue: s.status === "past_due" })),
    free: freeNow.map((s) => ({ name: s.customerName, started: s.started })),
    trialing: trialNow.map((s) => ({ name: s.customerName, mrrCents: s.lastMrrCents, trialEnd: s.trialEnd })),
    newPaying: newPaying.map((s) => ({ name: s.customerName, mrrCents: s.lastMrrCents, started: s.started })),
    cancelled: cancelled.map((s) => ({ name: s.customerName, mrrCents: s.lastMrrCents, ended: s.ended })),
  };

  /* ---- the agency: who we are implementing for ----
   * "Owed" is Stripe's open invoices RIGHT NOW, whatever period is picked —
   * Stripe does not keep what was open on a past day. Late = past due today. */
  const owed = (summary?.openInvoices || []).filter((i) => i.dept === "agency");
  const agency = {
    clientsPaid: Object.values(byCustomer).filter((c) => c.dept === "agency" && c.cents > 0).length,
    owedCents: owed.reduce((a, i) => a + (i.dueCents || 0), 0),
    owed,
    overdue: owed.filter((i) => i.dueDate && i.dueDate < nowDay),
  };

  const customersRanked = Object.values(byCustomer).sort((a, b) => b.cents - a.cents);

  return {
    range, bucket, keys,
    series: keys.map((k) => series[k]),
    sides, all, platform, agency,
    customers: customersRanked,
    typedByCategory, typedRows,
    ai: { calls: aiCalls, unpricedCalls: aiUnpricedCalls, via: ai?.via || null },
    typedCount: (expenses || []).length,
  };
}

/** A change against the range before, as a fraction. null when there is
 * nothing to compare with — "no earlier figure" is not "no change". */
export function changeVs(now, before) {
  if (before === null || before === undefined || now === null || now === undefined) return null;
  if (before === 0) return now === 0 ? 0 : null;
  return (now - before) / Math.abs(before);
}

/** The months a trend chart should show when the chosen range is short: the
 * range's own last month and the eleven before it. */
export function trendMonths(range) {
  const last = range.to.slice(0, 7);
  return Array.from({ length: 12 }, (_, i) => addMonths(last, i - 11));
}
