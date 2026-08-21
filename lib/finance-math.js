/* Finance maths for the admin console — Aug 20 2026.
 *
 * Every number the Finance page shows is worked out in here, and nowhere
 * else. Pure functions: data in, data out. No database, no network, no clock
 * of its own (every function that needs "today" is handed it). That is why
 * tests/finance/test.mjs can check the lot without a single key.
 *
 * THE HONESTY RULE, because a money page that guesses is worse than no page:
 * every figure carries a `basis` saying where it came from.
 *
 *   "stripe"   — measured from Stripe. Real money that moved.
 *   "typed"    — a number a person entered here (an expense, an invoice).
 *   "mixed"    — Stripe money minus typed costs.
 *   "estimate" — worked out from the numbers above using a formula. Says so
 *                on screen, every time.
 *   "unknown"  — we cannot measure it yet. Shown as "not measured", never 0.
 *
 * All money is in CENTS, as whole numbers. Dollars with decimal points drift
 * a penny at a time; cents do not.
 */

/* ------------------------------------------------------------------ */
/* Dates. Months are "YYYY-MM" strings everywhere in this file.        */
/* ------------------------------------------------------------------ */

/* A plain date — "2026-08-01" — is read by JavaScript as MIDNIGHT UTC, which
 * in Chicago is the evening of July 31. Every function below that touches a
 * date reads the string itself instead of handing it to Date(), because the
 * first of the month is the most common billing day there is and booking it to
 * the month before would quietly move money between months. Found by an
 * adversarial review on Aug 20 2026. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function monthKey(d) {
  if (typeof d === "string") {
    const m = DATE_ONLY.exec(d.trim());
    if (m) return `${m[1]}-${m[2]}`;
  }
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
}

/** A date as a plain YYYY-MM-DD string, whatever it arrives as. */
export function dateOnly(d) {
  if (d == null) return null;
  if (typeof d === "string") {
    const m = DATE_ONLY.exec(d.trim());
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const iso = /^(\d{4}-\d{2}-\d{2})T/.exec(d.trim());
    if (iso) return iso[1];
  }
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/** UTC version — for anything that arrives from Stripe as a unix second. */
export function monthKeyUtc(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function addMonths(key, n) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return monthKey(d);
}

/** The last n month keys ending with the month `today` is in, oldest first. */
export function lastMonths(n, today = new Date()) {
  const end = monthKey(today);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addMonths(end, -i));
  return out;
}

/** How many months from one key to another. */
export function monthsApart(a, b) {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

export function monthLabel(key, { long = false } = {}) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return long
    ? d.toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : d.toLocaleDateString("en-US", { month: "short" });
}

export function daysBetween(a, b) {
  /* Both sides are reduced to a plain date first. Comparing a full timestamp
   * against a date-at-midnight is how "paid the same day it was sent" came out
   * as −1 days. */
  const A = dateOnly(a);
  const B = dateOnly(b);
  if (!A || !B) return null;
  const [ay, am, ad] = A.split("-").map(Number);
  const [by, bm, bd] = B.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export function sum(rows, pick = (r) => r) {
  let t = 0;
  for (const r of rows || []) t += Number(pick(r)) || 0;
  return t;
}

/** Percent change from a to b. null when there is no honest answer. */
export function pctChange(a, b) {
  if (!a || a <= 0) return null;
  return ((b - a) / a) * 100;
}

export function safeDiv(a, b) {
  if (!b) return null;
  return a / b;
}

/* ------------------------------------------------------------------ */
/* MONEY IN — subscriptions                                            */
/* ------------------------------------------------------------------ */

/* A subscription that has not been paid for is not revenue. Trials are counted
 * on their own line so the page can say "$4,090 paying, plus $406 in trials"
 * instead of rolling a promise into a MEASURED figure. */
export const PAYING_STATUSES = ["active", "past_due"];

/** Monthly recurring revenue, in cents, from subscriptions that actually pay. */
export function mrrFromSubs(subs, { includeTrialing = false } = {}) {
  const ok = includeTrialing ? [...PAYING_STATUSES, "trialing"] : PAYING_STATUSES;
  return Math.round(sum((subs || []).filter((s) => ok.includes(s.status)), (s) => s.mrrCents));
}

/** What is sitting in trials — a promise, not money. */
export function trialMrr(subs) {
  return Math.round(sum((subs || []).filter((s) => s.status === "trialing"), (s) => s.mrrCents));
}

/** Subscriptions that never got off the ground. Stripe leaves these lying
 * around and counting them as new clients halves the cost-to-win figure. */
const DEAD_ON_ARRIVAL = ["incomplete", "incomplete_expired"];

/** Yearly run rate — MRR × 12. Not a forecast: what a year at today's rate is. */
export function arrFromMrr(mrrCents) {
  return Math.round((mrrCents || 0) * 12);
}

/**
 * What changed inside MRR this month.
 *
 * Measured from subscription start and cancel dates, which is all Stripe hands
 * back without a per-price history. So:
 *   new     — subscriptions that started this month. MEASURED.
 *   churn   — subscriptions that were cancelled this month. MEASURED.
 *   expansion / contraction — a client moving up or down a plan mid-month.
 *             NOT MEASURED. Returned as null with `expansionMeasured: false`,
 *             so the page can say "not tracked yet" instead of drawing a zero
 *             that looks like a fact.
 */
export function mrrMovement(subs, key, { today = new Date() } = {}) {
  const rows = subs || [];
  const inMonth = (unixOrIso) => {
    if (!unixOrIso) return false;
    const d = typeof unixOrIso === "number" ? new Date(unixOrIso * 1000) : new Date(unixOrIso);
    return monthKey(d) === key;
  };
  // A checkout that never completed is not a new client.
  const started = rows.filter((s) => inMonth(s.created) && !DEAD_ON_ARRIVAL.includes(s.status));
  /* Cancelled this month, but NOT started this month. A subscription that was
   * signed and killed inside the same month was never in the starting figure,
   * so adding it back would invent revenue that never existed. */
  const cancelled = rows.filter((s) => inMonth(s.canceledAt) && !inMonth(s.created));
  const sameMonthInAndOut = rows.filter((s) => inMonth(s.canceledAt) && inMonth(s.created));

  const startedPaying = started.filter((s) => PAYING_STATUSES.includes(s.status));
  const newMrr = Math.round(sum(startedPaying, (s) => s.mrrCents));
  // A cancelled subscription's mrrCents is 0 once Stripe closes it, so the
  // amount it used to bring in is carried on the row as `lastMrrCents`.
  const churnMrr = Math.round(sum(cancelled, (s) => s.lastMrrCents || s.mrrCents || 0));
  const end = mrrFromSubs(rows);
  const start = end - newMrr + churnMrr;

  return {
    key,
    startMrr: Math.max(0, start),
    newMrr,
    churnMrr,
    expansionMrr: null,
    contractionMrr: null,
    expansionMeasured: false,
    endMrr: end,
    // Two counts, because they answer two questions. newCount is how many
    // subscriptions began; newPayingCount is how many of those actually pay
    // today. Cost-per-new-client and the start-of-month client count both use
    // the paying one — dividing ad spend by a free trial halves the real cost.
    newCount: started.length,
    newPayingCount: startedPaying.length,
    churnCount: cancelled.length,
    // Signed and gone inside the same month. Counted nowhere else, shown on its
    // own so it cannot silently distort the start-of-month figure.
    inAndOutCount: sameMonthInAndOut.length,
    basis: "stripe",
    isCurrentMonth: key === monthKey(today),
  };
}

/* ------------------------------------------------------------------ */
/* MONEY OUT — expenses we type in                                     */
/* ------------------------------------------------------------------ */

/* The categories. Plain words on purpose — a category nobody can say out loud
 * does not get used, and then the profit number is wrong. */
export const EXPENSE_CATEGORIES = [
  "Contractors", "Software", "AI & APIs", "Ads", "Hosting & domains",
  "Payment fees", "Client costs", "Office & admin", "Taxes", "Other",
];

/* Costs that stay the same whether or not we sign another client. Used for
 * the fixed-vs-variable split and for the break-even number. */
export const FIXED_CATEGORIES = ["Software", "Hosting & domains", "Office & admin"];

/**
 * Spread one expense across the months it actually covers.
 * A monthly subscription typed in once shows up in every month from the day it
 * started; a yearly one is divided by 12 so a single January payment does not
 * make January look like a disaster.
 * Returns [{ month, cents }].
 */
export function expenseToMonths(expense, months) {
  const start = expense.incurred_on || expense.incurredOn;
  const startKey = start ? monthKey(start) : null;
  if (!startKey) return [];
  const endKey = expense.ended_on || expense.endedOn ? monthKey(expense.ended_on || expense.endedOn) : null;
  const amount = Number(expense.amount_cents ?? expense.amountCents) || 0;
  const interval = expense.interval || "one_time";

  if (interval === "one_time") {
    return months.includes(startKey) ? [{ month: startKey, cents: amount }] : [];
  }
  const per = interval === "yearly" ? Math.round(amount / 12) : amount;
  return months
    .filter((m) => m >= startKey && (!endKey || m <= endKey))
    .map((m) => ({ month: m, cents: per }));
}

/** { month: cents } for every month given, from a list of expenses. */
export function expensesByMonth(expenses, months) {
  const out = Object.fromEntries(months.map((m) => [m, 0]));
  for (const e of expenses || []) {
    for (const hit of expenseToMonths(e, months)) out[hit.month] += hit.cents;
  }
  return out;
}

/** { category: cents } for one month. */
export function expensesByCategory(expenses, month) {
  const out = {};
  for (const e of expenses || []) {
    for (const hit of expenseToMonths(e, [month])) {
      const cat = e.category || "Other";
      out[cat] = (out[cat] || 0) + hit.cents;
    }
  }
  return out;
}

/** { vendor: cents } for one month, biggest first. */
export function expensesByVendor(expenses, month, limit = 8) {
  const out = {};
  for (const e of expenses || []) {
    for (const hit of expenseToMonths(e, [month])) {
      const v = (e.vendor || "Unnamed").trim();
      out[v] = (out[v] || 0) + hit.cents;
    }
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([vendor, cents]) => ({ vendor, cents }));
}

/** Costs that keep running whether or not we sell anything, this month. */
export function fixedVsVariable(expenses, month) {
  const byCat = expensesByCategory(expenses, month);
  let fixed = 0;
  let variable = 0;
  for (const [cat, cents] of Object.entries(byCat)) {
    if (FIXED_CATEGORIES.includes(cat)) fixed += cents;
    else variable += cents;
  }
  return { fixed, variable, total: fixed + variable };
}

/* ------------------------------------------------------------------ */
/* PROFIT                                                              */
/* ------------------------------------------------------------------ */

/**
 * Money in, money out and what is left, month by month.
 * revenueByMonth / costByMonth are { "YYYY-MM": cents }.
 */
export function profitSeries(months, revenueByMonth, costByMonth) {
  return months.map((m) => {
    const revenue = Math.round(revenueByMonth[m] || 0);
    const cost = Math.round(costByMonth[m] || 0);
    return {
      month: m,
      label: monthLabel(m),
      tipLabel: monthLabel(m, { long: true }),
      revenue,
      cost,
      profit: revenue - cost,
      marginPct: revenue > 0 ? ((revenue - cost) / revenue) * 100 : null,
    };
  });
}

/**
 * The next n months, projected.
 *
 * Method, said out loud because a forecast whose method is hidden is a wish:
 * take the average month-over-month growth of the last `lookback` months of
 * money in, cap it at ±20% a month so one freak month cannot run away with the
 * chart, and grow the last real month forward. Costs are carried forward as
 * the average of the last 3 months, because that is how costs behave.
 */
export function projectForward(series, n = 3, { lookback = 6, capPct = 20, partialLast = false, today = null } = {}) {
  /* Trim EMPTY MONTHS OFF THE ENDS, never out of the middle. Filtering every
   * empty month out used to throw away the month we are standing in on the 1st
   * of a month, which then got projected a second time — two bars for the same
   * month, and "next month" naming a month already on the chart. */
  let real = [...series];
  while (real.length && real[real.length - 1].revenue === 0 && real[real.length - 1].cost === 0) real.pop();
  while (real.length && real[0].revenue === 0 && real[0].cost === 0) real.shift();
  const need = partialLast ? 3 : 2;
  if (real.length < need) {
    return { rows: [], method: "Not enough history yet — a projection needs at least two finished months with money in them.", growthPct: null };
  }
  /* THE PART-MONTH TRAP. The month we are standing in is not finished, so its
   * money-in figure is always short — on the 20th it holds two thirds of a
   * month. Growing the future from it would predict a fall every single month.
   * So when partialLast is set, the unfinished month is left out of the growth
   * sum and out of the base, and the projection compounds one extra step to
   * step over it. */
  const nowKey = today ? monthKey(today) : null;
  const complete = partialLast
    ? (nowKey ? real.filter((r) => r.month !== nowKey) : real.slice(0, -1))
    : real;
  if (!complete.length) {
    return { rows: [], method: "Nothing has cleared in a finished month yet, so there is nothing to grow from.", growthPct: null };
  }
  const window = complete.slice(-Math.min(lookback, complete.length));
  const rates = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1].revenue;
    if (prev > 0) rates.push((window[i].revenue - prev) / prev);
  }
  let growth = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const cap = capPct / 100;
  const capped = growth > cap || growth < -cap;
  growth = Math.max(-cap, Math.min(cap, growth));

  const costWindow = complete.slice(-3);
  const avgCost = Math.round(sum(costWindow, (s) => s.cost) / costWindow.length);

  const rows = [];
  const base = complete[complete.length - 1];
  // Start after the last month DRAWN, so a projected month can never sit on top
  // of a month the chart already shows.
  let month = series[series.length - 1].month;
  // One extra step of growth when the last drawn month is the unfinished one,
  // because the base is a month older than the chart's final bar.
  const stepsToNow = partialLast ? Math.max(0, monthsApart(base.month, series[series.length - 1].month)) : 0;
  let revenue = Math.round(base.revenue * Math.pow(1 + growth, stepsToNow));
  for (let i = 0; i < n; i++) {
    month = addMonths(month, 1);
    revenue = Math.round(revenue * (1 + growth));
    rows.push({
      month,
      label: monthLabel(month),
      tipLabel: `${monthLabel(month, { long: true })} · projected`,
      revenue,
      cost: avgCost,
      profit: revenue - avgCost,
      projected: true,
    });
  }
  return {
    rows,
    growthPct: growth * 100,
    method: `Grown from ${monthLabel(base.month, { long: true })} at ${(growth * 100).toFixed(1)}% a month — the average of the last ${rates.length} finished month${rates.length === 1 ? "" : "s"}${capped ? ", capped at 20% so one odd month cannot run away with it" : ""}. Costs held at the last 3-month average.${partialLast ? " This month is still running, so it is left out of the growth sum — half a month of money would predict a fall every time." : ""}`,
    basis: "estimate",
  };
}

/* ------------------------------------------------------------------ */
/* CUSTOMER NUMBERS — the ones every agency gets asked about           */
/* ------------------------------------------------------------------ */

/**
 * CAC — what it costs us to win one new paying client.
 * Ads + any sales pay in the month, divided by the number of clients who
 * started paying that month. Null when nobody signed: dividing by zero is not
 * "infinite cost", it is no answer.
 */
export function cac(expenses, month, newCustomers) {
  /* What counts as "winning a client" money: everything in Ads, plus any other
   * expense someone ticked "counts toward winning clients" on (a sales
   * contractor's pay, a lead list, a conference stand). The tick exists because
   * a category alone cannot tell a sales contractor from a delivery one. */
  const spend = sum(
    (expenses || []).filter((e) => e.category === "Ads" || e.counts_toward_cac === true),
    (e) => sum(expenseToMonths(e, [month]), (h) => h.cents)
  );
  if (!newCustomers) {
    return { cents: null, spend, newCustomers: 0, basis: "unknown", why: "No new paying client started this month, so there is nothing to divide by." };
  }
  return {
    cents: Math.round(spend / newCustomers),
    spend,
    newCustomers,
    basis: "mixed",
    why: `${fmtWhy(spend)} of ad spend this month, split across ${newCustomers} new client${newCustomers === 1 ? "" : "s"}.`,
  };
}

function fmtWhy(cents) {
  return `$${Math.round((cents || 0) / 100).toLocaleString()}`;
}

/** Average revenue per account — MRR divided by paying clients. */
export function arpa(mrrCents, payingClients) {
  if (!payingClients) return { cents: null, basis: "unknown" };
  return { cents: Math.round(mrrCents / payingClients), basis: "stripe" };
}

/**
 * Monthly customer churn — the share of clients who left this month.
 * Measured against the count we started the month with.
 */
export function churnRate(startCount, lostCount) {
  if (!startCount) return { pct: null, basis: "unknown" };
  return { pct: (lostCount / startCount) * 100, basis: "stripe" };
}

/** Revenue churn — the share of MRR that walked out. */
export function revenueChurnRate(startMrr, churnedMrr) {
  if (!startMrr) return { pct: null, basis: "unknown" };
  return { pct: (churnedMrr / startMrr) * 100, basis: "stripe" };
}

/**
 * How long a client stays, in months. 1 ÷ monthly churn.
 * With no churn at all there is no honest answer yet — return null rather than
 * the infinity that would make LTV look enormous.
 */
export function avgLifetimeMonths(churnPct) {
  if (churnPct == null || churnPct <= 0) return null;
  return 100 / churnPct;
}

/**
 * LTV — what one client is worth to us over their whole time here, after the
 * cost of serving them. Estimate, always: it multiplies today's churn out into
 * the future, and churn moves.
 */
export function ltv(arpaCents, grossMarginPct, churnPct) {
  const months = avgLifetimeMonths(churnPct);
  if (!arpaCents || months == null || grossMarginPct == null) {
    return { cents: null, months, basis: "unknown", why: "Needs an average client value, a margin, and at least one client lost — otherwise there is nothing to work out." };
  }
  return {
    cents: Math.round(arpaCents * (grossMarginPct / 100) * months),
    months,
    basis: "estimate",
    why: `$${Math.round(arpaCents / 100).toLocaleString()} a month × ${(grossMarginPct).toFixed(0)}% margin × ${months.toFixed(1)} months, which is how long a client stays at today's churn.`,
  };
}

/** LTV ÷ CAC. Above 3 is the usual "healthy" line. */
export function ltvToCac(ltvCents, cacCents) {
  if (!ltvCents || !cacCents) return { ratio: null, basis: "unknown" };
  return { ratio: ltvCents / cacCents, basis: "estimate" };
}

/** How many months of a client's payments it takes to earn back what winning them cost. */
export function cacPaybackMonths(cacCents, arpaCents, grossMarginPct) {
  if (!cacCents || !arpaCents || !grossMarginPct) return { months: null, basis: "unknown" };
  const monthly = arpaCents * (grossMarginPct / 100);
  if (monthly <= 0) return { months: null, basis: "unknown" };
  return { months: cacCents / monthly, basis: "estimate" };
}

/**
 * Net revenue retention — of the money we had at the start of the month, how
 * much is still here after churn (and, once we track it, upgrades).
 * 100% = we lost nothing.
 */
export function nrr({ startMrr, expansionMrr = 0, contractionMrr = 0, churnMrr = 0 }) {
  if (!startMrr) return { pct: null, basis: "unknown" };
  return {
    pct: ((startMrr + expansionMrr - contractionMrr - churnMrr) / startMrr) * 100,
    basis: "stripe",
  };
}

/** Quick ratio — money gained vs money lost. Above 4 is strong growth. */
export function quickRatio({ newMrr = 0, expansionMrr = 0, churnMrr = 0, contractionMrr = 0 }) {
  const lost = churnMrr + contractionMrr;
  if (!lost) return { ratio: null, basis: "unknown", why: newMrr ? "Nothing was lost this month, so there is nothing to divide by. That is the good version of no answer." : "No movement either way this month." };
  return { ratio: (newMrr + expansionMrr) / lost, basis: "stripe" };
}

/**
 * Gross margin — of every dollar that came in, how much was left after the
 * cost of actually delivering the work. Delivery costs are the categories that
 * only exist because we have clients.
 */
export const DELIVERY_CATEGORIES = ["Contractors", "AI & APIs", "Client costs", "Payment fees"];

export function grossMargin(revenueCents, expenses, month, { extraDeliveryCents = 0 } = {}) {
  if (!revenueCents) return { pct: null, cents: null, basis: "unknown" };
  const byCat = expensesByCategory(expenses, month);
  /* extraDeliveryCents is the card fee Stripe measured, on months where nobody
   * typed one in. Leaving it out made the margin card claim it included card
   * fees while quietly not doing so. */
  const cost = DELIVERY_CATEGORIES.reduce((s, c) => s + (byCat[c] || 0), 0) + Math.round(extraDeliveryCents || 0);
  return {
    pct: ((revenueCents - cost) / revenueCents) * 100,
    cents: revenueCents - cost,
    costCents: cost,
    basis: "mixed",
  };
}

/** Net margin — what is left after every cost, not just delivery. */
export function netMargin(revenueCents, totalCostCents) {
  if (!revenueCents) return { pct: null, basis: "unknown" };
  return { pct: ((revenueCents - totalCostCents) / revenueCents) * 100, basis: "mixed" };
}

/**
 * Runway — how many months the money in the bank lasts at the current burn.
 * Profitable months have no runway question, so this says so instead of
 * printing a made-up number.
 */
export function runwayMonths(cashCents, monthlyProfitCents, { hadActivity = true } = {}) {
  /* A month where nothing came in AND nothing went out is not a profitable
   * month — it is a month with no information in it. Calling that "∞
   * profitable" is exactly the kind of flattering nonsense this file exists to
   * avoid. */
  if (!hadActivity) {
    return { months: null, profitable: false, basis: "unknown", why: "No finished month has any money in it yet, so there is no burn to work from." };
  }
  if (monthlyProfitCents > 0) return { months: null, profitable: true, basis: "mixed" };
  if (monthlyProfitCents === 0) {
    return { months: null, profitable: false, basis: "mixed", why: "That month broke even to the penny — nothing was burned, so there is no runway to count." };
  }
  if (!cashCents) return { months: null, profitable: false, basis: "unknown", why: "Nobody has typed in what is in the bank, so this cannot be worked out." };
  return { months: cashCents / Math.abs(monthlyProfitCents), profitable: false, basis: "mixed" };
}

/** Break-even — the money in we need each month to cover every cost. */
export function breakEven(expenses, month, { extraVariableCents = 0 } = {}) {
  const { fixed, variable, total } = fixedVsVariable(expenses, month);
  const extra = Math.round(extraVariableCents || 0);
  return { cents: total + extra, fixed, variable: variable + extra, basis: "typed" };
}

/* ------------------------------------------------------------------ */
/* WHERE THE MONEY COMES FROM                                          */
/* ------------------------------------------------------------------ */

/**
 * Revenue by client, biggest first, plus the concentration risk: what share
 * the biggest client is, and how many clients make up half the money.
 */
export function revenueConcentration(rows) {
  const list = [...(rows || [])].filter((r) => (r.cents || 0) > 0).sort((a, b) => b.cents - a.cents);
  const total = sum(list, (r) => r.cents);
  if (!total) return { rows: [], total: 0, topSharePct: null, clientsForHalf: null, basis: "stripe" };
  let running = 0;
  let clientsForHalf = list.length;
  for (let i = 0; i < list.length; i++) {
    running += list[i].cents;
    if (running >= total / 2) { clientsForHalf = i + 1; break; }
  }
  return {
    rows: list.map((r) => ({ ...r, sharePct: (r.cents / total) * 100 })),
    total,
    topSharePct: (list[0].cents / total) * 100,
    clientsForHalf,
    basis: "stripe",
  };
}

/* ------------------------------------------------------------------ */
/* INVOICES                                                            */
/* ------------------------------------------------------------------ */

export const INVOICE_STATUSES = ["draft", "sent", "paid", "part_paid", "overdue", "void"];
export const INVOICE_STATUS_LABELS = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  part_paid: "Part paid",
  overdue: "Overdue",
  void: "Cancelled",
};

/** The line-item maths for one invoice. Everything in cents. */
export function invoiceTotals(items, { taxPct = 0, discountCents = 0 } = {}) {
  const lines = (items || []).map((it) => {
    const qty = Number(it.qty ?? 1) || 0;
    const unit = Math.round(Number(it.unit_cents ?? it.unitCents) || 0);
    return { ...it, qty, unit_cents: unit, amount_cents: Math.round(qty * unit) };
  });
  const subtotal = sum(lines, (l) => l.amount_cents);
  const discount = Math.min(Math.round(discountCents) || 0, subtotal);
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * ((Number(taxPct) || 0) / 100));
  return { lines, subtotalCents: subtotal, discountCents: discount, taxCents: tax, totalCents: taxable + tax };
}

/**
 * What an invoice's status really is right now.
 * Stored status wins for draft / void / paid. "Sent" turns into "Overdue" on
 * its own the day after the due date — nobody has to remember to change it.
 */
export function effectiveInvoiceStatus(inv, today = new Date()) {
  if (!inv) return "draft";
  const paid = Number(inv.amount_paid_cents || 0);
  const total = Number(inv.total_cents || 0);
  if (inv.status === "void") return "void";
  if (inv.status === "draft") return "draft";
  if (total > 0 && paid >= total) return "paid";
  // Plain string comparison. An invoice due today is NOT overdue today, and a
  // timezone must never be able to make it look like it is.
  const late = Boolean(inv.due_date) && dateOnly(inv.due_date) < todayIso(today);
  if (paid > 0) return late ? "overdue" : "part_paid";
  return late ? "overdue" : "sent";
}

export function invoiceOutstandingCents(inv) {
  const status = inv.status;
  if (status === "void" || status === "draft") return 0;
  return Math.max(0, Number(inv.total_cents || 0) - Number(inv.amount_paid_cents || 0));
}

/** How old the unpaid money is. The classic four buckets. */
export function agingBuckets(invoices, today = new Date()) {
  const buckets = [
    { id: "current", label: "Not due yet", cents: 0, count: 0 },
    { id: "d1", label: "1–30 days late", cents: 0, count: 0 },
    { id: "d31", label: "31–60 days late", cents: 0, count: 0 },
    { id: "d61", label: "61–90 days late", cents: 0, count: 0 },
    { id: "d90", label: "Over 90 days late", cents: 0, count: 0 },
  ];
  for (const inv of invoices || []) {
    const owed = invoiceOutstandingCents(inv);
    if (owed <= 0) continue;
    const late = inv.due_date ? daysBetween(inv.due_date, todayIso(today)) : 0;
    const b = late <= 0 ? buckets[0]
      : late <= 30 ? buckets[1]
      : late <= 60 ? buckets[2]
      : late <= 90 ? buckets[3]
      : buckets[4];
    b.cents += owed;
    b.count += 1;
  }
  return buckets;
}

/** Average days from sending an invoice to it being paid in full. */
export function avgDaysToPay(invoices) {
  const paid = (invoices || []).filter((i) => i.paid_at && (i.sent_at || i.issue_date));
  if (!paid.length) return { days: null, count: 0, basis: "unknown" };
  /* Dates, not instants, and never negative: the database stamps paid_at as the
   * payment DATE at midnight while sent_at is a full timestamp, so an invoice
   * paid the same hour it was sent used to come out as −1 days. */
  const total = sum(paid, (i) => Math.max(0, daysBetween(i.sent_at || i.issue_date, i.paid_at) || 0));
  return { days: total / paid.length, count: paid.length, basis: "typed" };
}

/** Billed vs actually collected, for a set of invoices. */
export function billedVsCollected(invoices) {
  const live = (invoices || []).filter((i) => i.status !== "void" && i.status !== "draft");
  const billed = sum(live, (i) => i.total_cents);
  const collected = sum(live, (i) => i.amount_paid_cents);
  return {
    billedCents: billed,
    collectedCents: collected,
    outstandingCents: Math.max(0, billed - collected),
    collectedPct: billed ? (collected / billed) * 100 : null,
    basis: "typed",
  };
}

/** The next invoice number: prefix + the highest number we have used, plus one. */
export function nextInvoiceNumber(existing, { prefix = "AIS-", pad = 4 } = {}) {
  let highest = 0;
  for (const inv of existing || []) {
    const m = /(\d+)\s*$/.exec(String(inv.number || ""));
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return `${prefix}${String(highest + 1).padStart(pad, "0")}`;
}

/** Add n days to a date, as a YYYY-MM-DD string. Done in UTC on purpose: a
 * plain date has no time and no zone, and running it through a local Date is
 * what turned "25 August plus 14 days" into 7 September. */
export function addDays(dateish, n) {
  const base = dateOnly(dateish);
  if (!base) return null;
  const [y, m, d] = base.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

export function todayIso(today = new Date()) {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}
