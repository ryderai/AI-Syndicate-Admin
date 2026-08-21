/* Tests for the finance maths — Aug 20 2026.
 *
 * Run with:  bash tests/finance/run.sh
 *
 * No database, no keys, no network. Every function in lib/finance-math.js takes
 * data and returns data, which is exactly why it was written that way: the
 * money page can be checked without a Stripe account existing.
 *
 * The clock is fixed below. A money test that starts failing at midnight is the
 * kind of bug a test suite is meant to catch, not cause.
 */

import assert from "node:assert/strict";
import {
  monthKey, dateOnly, addMonths, monthsApart, lastMonths, monthLabel, daysBetween, sum, pctChange,
  mrrFromSubs, trialMrr, arrFromMrr, mrrMovement,
  expenseToMonths, expensesByMonth, expensesByCategory, expensesByVendor, fixedVsVariable,
  profitSeries, projectForward,
  cac, arpa, churnRate, revenueChurnRate, avgLifetimeMonths, ltv, ltvToCac,
  cacPaybackMonths, nrr, quickRatio, grossMargin, netMargin, runwayMonths, breakEven,
  revenueConcentration,
  invoiceTotals, effectiveInvoiceStatus, invoiceOutstandingCents, agingBuckets,
  avgDaysToPay, billedVsCollected, nextInvoiceNumber, addDays,
} from "../../lib/finance-math.js";

const NOW = new Date("2026-08-20T12:00:00");
const THIS = "2026-08";

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    results.push(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    results.push(`  FAIL ${name}\n       ${err.message}`);
  }
}

/* ---------------- dates ---------------- */

test("monthKey pads the month", () => {
  assert.equal(monthKey(new Date(2026, 0, 9)), "2026-01");
  assert.equal(monthKey(new Date(2026, 11, 31)), "2026-12");
});

test("addMonths crosses a year boundary both ways", () => {
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2026-08", 3), "2026-11");
});

test("lastMonths ends with the month you are in and is oldest first", () => {
  const m = lastMonths(12, NOW);
  assert.equal(m.length, 12);
  assert.equal(m[11], THIS);
  assert.equal(m[0], "2025-09");
});

test("monthLabel is a short month, or a long one with the year", () => {
  assert.equal(monthLabel("2026-08"), "Aug");
  assert.equal(monthLabel("2026-08", { long: true }), "August 2026");
});

test("daysBetween counts forward and backward", () => {
  assert.equal(daysBetween("2026-08-01", "2026-08-20"), 19);
  assert.equal(daysBetween("2026-08-20", "2026-08-01"), -19);
});

test("pctChange refuses to divide by nothing", () => {
  assert.equal(pctChange(0, 500), null);
  assert.equal(Math.round(pctChange(100, 150)), 50);
});

test("a plain date is read as itself, not as midnight in London", () => {
  // The bug this replaced: new Date("2026-08-01") is UTC midnight, which in
  // Chicago is the evening of July 31, so a cost paid on the 1st was booked to
  // the month before.
  assert.equal(monthKey("2026-08-01"), "2026-08");
  assert.equal(dateOnly("2026-08-01T23:30:00.000Z"), "2026-08-01");
  assert.equal(daysBetween("2026-08-20", "2026-08-20"), 0);
  assert.equal(addDays("2026-08-25", 14), "2026-09-08");
  const oneOff = { incurred_on: "2026-08-01", category: "Software", amount_cents: 60000, interval: "one_time" };
  assert.deepEqual(expenseToMonths(oneOff, ["2026-07", "2026-08"]), [{ month: "2026-08", cents: 60000 }]);
});

test("an invoice due today is not overdue today", () => {
  const inv = { status: "sent", total_cents: 45000, amount_paid_cents: 0, due_date: "2026-08-20" };
  assert.equal(effectiveInvoiceStatus(inv, NOW), "sent");
  assert.equal(agingBuckets([inv], NOW)[0].cents, 45000);   // "not due yet", and the two agree
});

test("monthsApart counts the gap between two month keys", () => {
  assert.equal(monthsApart("2026-07", "2026-08"), 1);
  assert.equal(monthsApart("2025-11", "2026-02"), 3);
});

/* ---------------- MRR ---------------- */

const SUBS = [
  { id: "a", status: "active", mrrCents: 50000, lastMrrCents: 50000, created: Date.UTC(2025, 10, 1) / 1000, canceledAt: null },
  { id: "b", status: "active", mrrCents: 30000, lastMrrCents: 30000, created: new Date(2026, 7, 5).getTime() / 1000, canceledAt: null },
  { id: "c", status: "trialing", mrrCents: 20000, lastMrrCents: 20000, created: new Date(2026, 7, 12).getTime() / 1000, canceledAt: null },
  { id: "d", status: "canceled", mrrCents: 0, lastMrrCents: 15000, created: Date.UTC(2025, 5, 1) / 1000, canceledAt: new Date(2026, 7, 8).getTime() / 1000 },
];

test("MRR counts paying subscriptions only — a trial is a promise, not money", () => {
  assert.equal(mrrFromSubs(SUBS), 80000);                      // a + b
  assert.equal(mrrFromSubs(SUBS, { includeTrialing: true }), 100000);
  assert.equal(trialMrr(SUBS), 20000);                         // c, on its own line
});

test("run rate is twelve times MRR", () => {
  assert.equal(arrFromMrr(100000), 1200000);
});

test("movement: new money and churned money are both measured", () => {
  const m = mrrMovement(SUBS, THIS, { today: NOW });
  assert.equal(m.newMrr, 30000);       // b started this month and pays; c is a trial
  assert.equal(m.newCount, 2);         // both started, only one of them pays yet
  assert.equal(m.churnMrr, 15000);     // d cancelled this month, at its old value
  assert.equal(m.churnCount, 1);
  assert.equal(m.endMrr, 80000);
  assert.equal(m.startMrr, 65000);     // 80000 - 30000 + 15000
});

test("a subscription signed and cancelled in the same month never enters the start figure", () => {
  const subs = [
    { id: "steady", status: "active", mrrCents: 100000, lastMrrCents: 100000, created: new Date(2025, 1, 1).getTime() / 1000, canceledAt: null },
    { id: "flash", status: "canceled", mrrCents: 0, lastMrrCents: 18000, created: new Date(2026, 7, 3).getTime() / 1000, canceledAt: new Date(2026, 7, 20).getTime() / 1000 },
  ];
  const m = mrrMovement(subs, THIS, { today: NOW });
  assert.equal(m.startMrr, 100000);   // NOT 118000 — that money was never there
  assert.equal(m.churnMrr, 0);
  assert.equal(m.inAndOutCount, 1);   // shown on its own instead
  assert.equal(nrr({ startMrr: m.startMrr, churnMrr: m.churnMrr }).pct, 100);
});

test("a checkout that never completed is not a new client", () => {
  const subs = [
    { id: "ok", status: "active", mrrCents: 50000, lastMrrCents: 50000, created: new Date(2026, 7, 4).getTime() / 1000, canceledAt: null },
    { id: "dead1", status: "incomplete", mrrCents: 0, lastMrrCents: 30000, created: new Date(2026, 7, 6).getTime() / 1000, canceledAt: null },
    { id: "dead2", status: "incomplete_expired", mrrCents: 0, lastMrrCents: 30000, created: new Date(2026, 7, 7).getTime() / 1000, canceledAt: null },
  ];
  const m = mrrMovement(subs, THIS, { today: NOW });
  assert.equal(m.newCount, 1);
  assert.equal(m.newMrr, 50000);
});

test("movement never invents an upgrade figure", () => {
  const m = mrrMovement(SUBS, THIS, { today: NOW });
  assert.equal(m.expansionMrr, null);
  assert.equal(m.contractionMrr, null);
  assert.equal(m.expansionMeasured, false);
});

test("a cancelled subscription still reports what it used to bring in", () => {
  // The whole point: Stripe reports 0 MRR on a cancelled row, so churn would
  // always read as $0 if lastMrrCents were not carried.
  const m = mrrMovement([SUBS[3]], THIS, { today: NOW });
  assert.equal(m.churnMrr, 15000);
});

test("new PAYING clients is counted apart from new subscriptions", () => {
  const subs = [
    { id: "old", status: "active", mrrCents: 100000, lastMrrCents: 100000, created: new Date(2025, 1, 1).getTime() / 1000, canceledAt: null },
    { id: "paid", status: "active", mrrCents: 40000, lastMrrCents: 40000, created: new Date(2026, 7, 4).getTime() / 1000, canceledAt: null },
    { id: "trial", status: "trialing", mrrCents: 20000, lastMrrCents: 20000, created: new Date(2026, 7, 9).getTime() / 1000, canceledAt: null },
  ];
  const m = mrrMovement(subs, THIS, { today: NOW });
  assert.equal(m.newCount, 2);        // two subscriptions began
  assert.equal(m.newPayingCount, 1);  // one of them pays
  // The start-of-month client count uses the paying one, so it cannot go
  // negative and print "0 of -1 we started with".
  const paying = subs.filter((x) => x.status === "active").length;
  assert.equal(Math.max(0, paying + m.churnCount - m.newPayingCount), 1);
});

test("a month with nothing in it is not a profitable month", () => {
  const empty = runwayMonths(500000, 0, { hadActivity: false });
  assert.equal(empty.profitable, false);
  assert.equal(empty.basis, "unknown");
  assert.match(empty.why, /no burn/i);
  const flat = runwayMonths(500000, 0, { hadActivity: true });
  assert.equal(flat.profitable, false);
  assert.match(flat.why, /broke even/i);
});

/* ---------------- expenses ---------------- */

const MONTHS = lastMonths(12, NOW);
const EXPENSES = [
  { id: "1", incurred_on: "2025-09-01", ended_on: null, category: "Software", vendor: "Vercel", amount_cents: 4000, interval: "monthly" },
  { id: "2", incurred_on: "2026-08-06", ended_on: null, category: "Contractors", vendor: "J.M.", amount_cents: 60000, interval: "one_time" },
  { id: "3", incurred_on: "2026-01-01", ended_on: null, category: "Software", vendor: "Adobe", amount_cents: 24000, interval: "yearly" },
  { id: "4", incurred_on: "2026-03-01", ended_on: "2026-06-30", category: "Ads", vendor: "Google Ads", amount_cents: 30000, interval: "monthly" },
  { id: "5", incurred_on: "2026-08-02", ended_on: null, category: "Ads", vendor: "Meta", amount_cents: 20000, interval: "monthly" },
];

test("a monthly cost lands in every month from its start", () => {
  const hits = expenseToMonths(EXPENSES[0], MONTHS);
  assert.equal(hits.length, 12);
  assert.equal(hits[0].cents, 4000);
});

test("a yearly cost is split into twelfths, not dumped in one month", () => {
  const hits = expenseToMonths(EXPENSES[2], MONTHS);
  assert.equal(hits[0].cents, 2000);
  assert.equal(hits[0].month, "2026-01");
});

test("a cost that was stopped drops out after its end month", () => {
  const hits = expenseToMonths(EXPENSES[3], MONTHS).map((h) => h.month);
  assert.deepEqual(hits, ["2026-03", "2026-04", "2026-05", "2026-06"]);
  assert.equal(hits.includes("2026-07"), false);
});

test("a one-off lands in exactly one month", () => {
  const hits = expenseToMonths(EXPENSES[1], MONTHS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].month, "2026-08");
});

test("the month total adds up the four kinds of cost together", () => {
  const byMonth = expensesByMonth(EXPENSES, MONTHS);
  // August: Vercel 4000 + J.M. 60000 + Adobe twelfth 2000 + Meta 20000
  assert.equal(byMonth[THIS], 86000);
});

test("categories and vendors both add up to the month total", () => {
  const byCat = expensesByCategory(EXPENSES, THIS);
  assert.equal(byCat.Software, 6000);
  assert.equal(byCat.Contractors, 60000);
  assert.equal(byCat.Ads, 20000);
  const vendors = expensesByVendor(EXPENSES, THIS);
  assert.equal(vendors[0].vendor, "J.M.");
  assert.equal(sum(vendors, (v) => v.cents), 86000);
});

test("fixed and variable split, and they add back to the total", () => {
  const fv = fixedVsVariable(EXPENSES, THIS);
  assert.equal(fv.fixed, 6000);        // Software only
  assert.equal(fv.variable, 80000);    // Contractors + Ads
  assert.equal(fv.fixed + fv.variable, fv.total);
});

/* ---------------- profit and projection ---------------- */

test("profit series subtracts cost from revenue and works out the margin", () => {
  const rows = profitSeries(["2026-07", "2026-08"], { "2026-07": 100000, "2026-08": 200000 }, { "2026-07": 40000, "2026-08": 250000 });
  assert.equal(rows[0].profit, 60000);
  assert.equal(Math.round(rows[0].marginPct), 60);
  assert.equal(rows[1].profit, -50000);   // a losing month is allowed to be negative
});

test("projection needs history, and says so instead of drawing a line", () => {
  const out = projectForward(profitSeries(["2026-08"], { "2026-08": 100000 }, { "2026-08": 0 }), 3);
  assert.equal(out.rows.length, 0);
  assert.match(out.method, /at least two finished months/i);
});

test("projection grows the last real month and labels every row", () => {
  const months = ["2026-05", "2026-06", "2026-07", "2026-08"];
  const rev = { "2026-05": 100000, "2026-06": 110000, "2026-07": 121000, "2026-08": 133100 };
  const cost = { "2026-05": 50000, "2026-06": 50000, "2026-07": 50000, "2026-08": 50000 };
  const out = projectForward(profitSeries(months, rev, cost), 3);
  assert.equal(out.rows.length, 3);
  assert.equal(Math.round(out.growthPct), 10);
  assert.equal(out.rows[0].month, "2026-09");
  assert.equal(out.rows[0].revenue, 146410);
  assert.ok(out.rows.every((r) => r.projected === true));
  assert.equal(out.basis, "estimate");
});

test("the unfinished month is left out of the projection, so growth is not fake-negative", () => {
  // Aug is only two thirds done: 100k, 110k, 121k finished, then 80k so far.
  // Counting that 80k would read as a fall and predict a shrinking business.
  const months = ["2026-05", "2026-06", "2026-07", "2026-08"];
  const rev = { "2026-05": 100000, "2026-06": 110000, "2026-07": 121000, "2026-08": 80000 };
  const series = profitSeries(months, rev, {});
  const naive = projectForward(series, 3);
  const fixed = projectForward(series, 3, { partialLast: true, today: NOW });
  assert.ok(naive.growthPct < 0, "the naive version really does read as a fall");
  assert.equal(Math.round(fixed.growthPct), 10);
  assert.equal(fixed.rows[0].month, "2026-09");
  // Base is July (121000), grown once to step over August, then once more.
  assert.equal(fixed.rows[0].revenue, 146410);
  assert.match(fixed.method, /still running/i);
});

test("an empty current month is not projected twice", () => {
  // On the 1st of a month nothing has cleared yet. The old version filtered the
  // empty month out, then projected it again — two bars for the same month.
  const months = ["2026-05", "2026-06", "2026-07", "2026-08"];
  const rev = { "2026-05": 100000, "2026-06": 110000, "2026-07": 121000, "2026-08": 0 };
  const series = profitSeries(months, rev, {});
  const out = projectForward(series, 3, { partialLast: true, today: NOW });
  assert.deepEqual(out.rows.map((r) => r.month), ["2026-09", "2026-10", "2026-11"]);
  assert.match(out.method, /July 2026/);
  // July → September is two steps of growth, not one.
  assert.equal(out.rows[0].revenue, Math.round(121000 * 1.1 * 1.1));
});

test("projection caps a freak month instead of running away with the chart", () => {
  const months = ["2026-06", "2026-07", "2026-08"];
  const out = projectForward(profitSeries(months, { "2026-06": 10000, "2026-07": 100000, "2026-08": 200000 }, {}), 1);
  assert.ok(out.growthPct <= 20.0001, `growth ${out.growthPct} should be capped at 20%`);
  assert.match(out.method, /capped/);
});

/* ---------------- the client numbers ---------------- */

test("cost to win a client uses ads plus anything ticked, and refuses to divide by zero", () => {
  const withTick = [...EXPENSES, { id: "6", incurred_on: "2026-08-01", category: "Contractors", vendor: "Sales rep", amount_cents: 40000, interval: "one_time", counts_toward_cac: true }];
  const c = cac(withTick, THIS, 2);
  assert.equal(c.spend, 60000);       // Meta 20000 + ticked contractor 40000
  assert.equal(c.cents, 30000);
  const none = cac(withTick, THIS, 0);
  assert.equal(none.cents, null);
  assert.equal(none.basis, "unknown");
});

test("average client value is blank with no clients rather than infinite", () => {
  assert.equal(arpa(100000, 4).cents, 25000);
  assert.equal(arpa(100000, 0).cents, null);
});

test("churn is a share of what we started with", () => {
  assert.equal(churnRate(10, 1).pct, 10);
  assert.equal(churnRate(0, 0).pct, null);
  assert.equal(revenueChurnRate(100000, 15000).pct, 15);
});

test("a client's stay comes from churn, and zero churn is not infinity", () => {
  assert.equal(avgLifetimeMonths(10), 10);
  assert.equal(avgLifetimeMonths(0), null);
  assert.equal(avgLifetimeMonths(null), null);
});

test("what a client is worth uses margin and stay, and is always an estimate", () => {
  const v = ltv(25000, 60, 10);      // $250/mo × 60% × 10 months
  assert.equal(v.cents, 150000);
  assert.equal(v.basis, "estimate");
  assert.equal(ltv(25000, 60, 0).cents, null);
});

test("worth ÷ cost to win, and months to earn a client back", () => {
  assert.equal(ltvToCac(150000, 30000).ratio, 5);
  assert.equal(ltvToCac(150000, 0).ratio, null);
  const p = cacPaybackMonths(30000, 25000, 60);
  assert.equal(p.months, 2);
});

test("revenue kept and gained-vs-lost behave when nothing was lost", () => {
  assert.equal(nrr({ startMrr: 100000, churnMrr: 15000 }).pct, 85);
  assert.equal(nrr({ startMrr: 0 }).pct, null);
  const q = quickRatio({ newMrr: 50000, churnMrr: 10000 });
  assert.equal(q.ratio, 5);
  const none = quickRatio({ newMrr: 50000, churnMrr: 0 });
  assert.equal(none.ratio, null);
  assert.match(none.why, /nothing to divide by/i);
});

test("gross margin only counts delivery costs; net margin counts everything", () => {
  const gm = grossMargin(200000, EXPENSES, THIS);   // delivery = Contractors 60000
  assert.equal(gm.costCents, 60000);
  assert.equal(gm.pct, 70);
  // Floating point: 57 comes back as 56.999…, so compare with a tolerance
  // rather than pretending computers do decimal arithmetic.
  assert.ok(Math.abs(netMargin(200000, 86000).pct - 57) < 0.0001);
  assert.equal(netMargin(0, 100).pct, null);
});

test("gross margin counts the card fee Stripe measured, like the card says it does", () => {
  const exp = [{ incurred_on: "2026-08-01", category: "Contractors", amount_cents: 200000, interval: "one_time" }];
  const plain = grossMargin(1000000, exp, THIS);
  assert.equal(plain.pct, 80);
  const withFee = grossMargin(1000000, exp, THIS, { extraDeliveryCents: 31000 });
  assert.equal(withFee.costCents, 231000);
  assert.ok(Math.abs(withFee.pct - 76.9) < 0.05);
  assert.equal(breakEven(exp, THIS, { extraVariableCents: 31000 }).cents, 231000);
});

test("runway says 'profitable' rather than printing a number", () => {
  const good = runwayMonths(1000000, 50000);
  assert.equal(good.profitable, true);
  assert.equal(good.months, null);
  const bad = runwayMonths(1000000, -100000);
  assert.equal(bad.months, 10);
  const unknown = runwayMonths(0, -100000);
  assert.equal(unknown.months, null);
  assert.match(unknown.why, /typed in/i);
});

test("break even is every cost that lands in the month", () => {
  assert.equal(breakEven(EXPENSES, THIS).cents, 86000);
});

test("concentration finds the biggest client and how few make half the money", () => {
  const c = revenueConcentration([
    { label: "Big", cents: 600000 },
    { label: "Mid", cents: 300000 },
    { label: "Small", cents: 100000 },
  ]);
  assert.equal(c.topSharePct, 60);
  assert.equal(c.clientsForHalf, 1);
  assert.equal(c.rows[0].label, "Big");
  assert.equal(revenueConcentration([]).topSharePct, null);
});

/* ---------------- invoices ---------------- */

test("invoice totals come from the lines, with discount before tax", () => {
  const t = invoiceTotals(
    [{ description: "a", qty: 2, unit_cents: 50000 }, { description: "b", qty: 1, unit_cents: 25000 }],
    { taxPct: 10, discountCents: 25000 }
  );
  assert.equal(t.subtotalCents, 125000);
  assert.equal(t.discountCents, 25000);
  assert.equal(t.taxCents, 10000);      // 10% of 100000
  assert.equal(t.totalCents, 110000);
});

test("a discount can never make an invoice negative", () => {
  const t = invoiceTotals([{ description: "a", qty: 1, unit_cents: 10000 }], { discountCents: 999999 });
  assert.equal(t.discountCents, 10000);
  assert.equal(t.totalCents, 0);
});

test("overdue and part paid are worked out, never stored", () => {
  const base = { status: "sent", total_cents: 100000, amount_paid_cents: 0, due_date: "2026-08-10" };
  assert.equal(effectiveInvoiceStatus(base, NOW), "overdue");
  assert.equal(effectiveInvoiceStatus({ ...base, due_date: "2026-09-10" }, NOW), "sent");
  assert.equal(effectiveInvoiceStatus({ ...base, due_date: "2026-09-10", amount_paid_cents: 40000 }, NOW), "part_paid");
  assert.equal(effectiveInvoiceStatus({ ...base, amount_paid_cents: 100000 }, NOW), "paid");
  assert.equal(effectiveInvoiceStatus({ ...base, status: "void", amount_paid_cents: 100000 }, NOW), "void");
  assert.equal(effectiveInvoiceStatus({ ...base, status: "draft" }, NOW), "draft");
});

test("a draft and a cancelled invoice are owed nothing", () => {
  assert.equal(invoiceOutstandingCents({ status: "draft", total_cents: 100000, amount_paid_cents: 0 }), 0);
  assert.equal(invoiceOutstandingCents({ status: "void", total_cents: 100000, amount_paid_cents: 0 }), 0);
  assert.equal(invoiceOutstandingCents({ status: "sent", total_cents: 100000, amount_paid_cents: 40000 }), 60000);
});

test("aging puts unpaid money in the right bucket", () => {
  const invs = [
    { status: "sent", total_cents: 10000, amount_paid_cents: 0, due_date: "2026-09-01" }, // not due
    { status: "sent", total_cents: 20000, amount_paid_cents: 0, due_date: "2026-08-05" }, // 15 days
    { status: "sent", total_cents: 30000, amount_paid_cents: 0, due_date: "2026-07-01" }, // 50 days
    { status: "sent", total_cents: 40000, amount_paid_cents: 0, due_date: "2026-04-01" }, // over 90
    { status: "void", total_cents: 90000, amount_paid_cents: 0, due_date: "2026-01-01" }, // ignored
  ];
  const b = agingBuckets(invs, NOW);
  assert.equal(b[0].cents, 10000);
  assert.equal(b[1].cents, 20000);
  assert.equal(b[2].cents, 30000);
  assert.equal(b[4].cents, 40000);
  assert.equal(sum(b, (x) => x.cents), 100000);   // the cancelled one is not in it
});

test("an invoice paid the same day it was sent is zero days, not minus one", () => {
  const r = avgDaysToPay([{ sent_at: "2026-08-20T14:00:00.000Z", paid_at: "2026-08-20" }]);
  assert.equal(r.days, 0);
});

test("days to pay is measured from the day it was sent", () => {
  const r = avgDaysToPay([
    { sent_at: "2026-08-01", paid_at: "2026-08-11" },
    { sent_at: "2026-08-01", paid_at: "2026-08-21" },
    { sent_at: "2026-08-01", paid_at: null },
  ]);
  assert.equal(r.days, 15);
  assert.equal(r.count, 2);
  assert.equal(avgDaysToPay([]).days, null);
});

test("billed vs collected leaves drafts and cancelled ones out", () => {
  const r = billedVsCollected([
    { status: "sent", total_cents: 100000, amount_paid_cents: 40000 },
    { status: "paid", total_cents: 100000, amount_paid_cents: 100000 },
    { status: "draft", total_cents: 500000, amount_paid_cents: 0 },
    { status: "void", total_cents: 500000, amount_paid_cents: 0 },
  ]);
  assert.equal(r.billedCents, 200000);
  assert.equal(r.collectedCents, 140000);
  assert.equal(r.outstandingCents, 60000);
  assert.equal(r.collectedPct, 70);
});

test("the next invoice number carries on from the highest one used", () => {
  assert.equal(nextInvoiceNumber([{ number: "AIS-0007" }, { number: "AIS-0002" }], { prefix: "AIS-" }), "AIS-0008");
  assert.equal(nextInvoiceNumber([], { prefix: "AIS-" }), "AIS-0001");
  // A different prefix in the history must not break the count.
  assert.equal(nextInvoiceNumber([{ number: "OLD-0042" }], { prefix: "AIS-" }), "AIS-0043");
});

test("addDays writes a plain date, and rolls the month over", () => {
  assert.equal(addDays("2026-08-25", 14), "2026-09-08");
});

/* ---------------- report ---------------- */

console.log("\nFINANCE MATHS\n");
console.log(results.join("\n"));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
