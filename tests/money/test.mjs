/* MONEY PAGES — the date range, the department split, the maths. 24 Sep 2026.
 * Run: node tests/money/test.mjs   (tests/money/run.sh runs it in 4 zones)
 * Names are invented; the SHAPES are copied from the live Stripe reply read
 * on 24 Sep 2026 (a $0 subscription, a refunded charge, a fee per charge). */
import assert from "node:assert/strict";
import {
  presetRange, previousRange, rangeToInstants, monthsIn, daysIn, bucketFor, rangeLabel,
  normalizeRange, teamMidnightUtcMs, dayCount, monthRange, pickableMonths, rangeMonth,
} from "../../lib/money-range.js";
import { financeView, expenseInRange, aiDept, changeVs } from "../../lib/money-view.js";
import { departmentFor } from "../../api/finance-summary.js";
import { groupRows, jobOf } from "../../api/ai-cost.js";
import { aiCostView, NO_ACCOUNT } from "../../lib/ai-cost-view.js";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const TODAY = "2026-09-24";

/* ---------------- the range ---------------- */
test("This month opens on the 1st and ends today", () => {
  assert.deepEqual(presetRange("this-month", TODAY), { from: "2026-09-01", to: "2026-09-24" });
});
test("Last month is the whole previous calendar month", () => {
  assert.deepEqual(presetRange("last-month", TODAY), { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(presetRange("last-month", "2026-03-10"), { from: "2026-02-01", to: "2026-02-28" });
});
test("Last 3 months counts this month as one of them", () => {
  assert.deepEqual(presetRange("last-3", TODAY), { from: "2026-07-01", to: TODAY });
});
test("All time starts at the first payment", () => {
  assert.deepEqual(presetRange("all", TODAY, { earliest: "2026-06-25" }), { from: "2026-06-25", to: TODAY });
});
test("the range before a whole month is the whole month before", () => {
  assert.deepEqual(previousRange({ from: "2026-08-01", to: "2026-08-31" }), { from: "2026-07-01", to: "2026-07-31" });
  assert.deepEqual(previousRange({ from: "2026-09-01", to: "2026-09-24" }), { from: "2026-08-01", to: "2026-08-24" }, "month to date = same days last month");
  assert.deepEqual(previousRange({ from: "2026-03-01", to: "2026-03-31" }), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(previousRange({ from: "2026-03-01", to: "2026-03-30" }), { from: "2026-02-01", to: "2026-02-28" }, "clamped to a short month");
  assert.deepEqual(previousRange({ from: "2026-09-10", to: "2026-09-19" }), { from: "2026-08-31", to: "2026-09-09" }, "any other range = the same number of days before");
});
test("midnight in Chicago is 05:00Z in summer and 06:00Z in winter", () => {
  assert.equal(new Date(teamMidnightUtcMs("2026-09-01")).toISOString(), "2026-09-01T05:00:00.000Z");
  assert.equal(new Date(teamMidnightUtcMs("2026-12-01")).toISOString(), "2026-12-01T06:00:00.000Z");
  const w = rangeToInstants({ from: "2026-09-01", to: "2026-09-30" });
  assert.equal(new Date(w.toMs).toISOString(), "2026-10-01T05:00:00.000Z");
});
test("the day DST ends is 25 hours long and still one day", () => {
  const a = teamMidnightUtcMs("2026-11-01"), b = teamMidnightUtcMs("2026-11-02");
  assert.equal((b - a) / 3600000, 25);
});
test("short ranges draw days, long ones months", () => {
  assert.equal(bucketFor({ from: "2026-09-01", to: "2026-09-30" }), "day");
  assert.equal(bucketFor({ from: "2026-01-01", to: "2026-09-24" }), "month");
  assert.equal(monthsIn({ from: "2025-11-15", to: "2026-02-01" }).join(","), "2025-11,2025-12,2026-01,2026-02");
  assert.equal(daysIn({ from: "2026-02-27", to: "2026-03-02" }).length, 4);
  assert.equal(dayCount({ from: "2026-09-01", to: "2026-09-30" }), 30);
});
test("labels read like a person wrote them", () => {
  assert.equal(rangeLabel({ from: "2026-08-01", to: "2026-08-31" }), "August 2026");
  assert.equal(rangeLabel({ from: "2026-07-01", to: "2026-09-24" }), "Jul 1 – Sep 24, 2026");
});
test("a bad or future range cannot blank the page", () => {
  assert.deepEqual(normalizeRange({ from: "nope", to: "x" }, TODAY), { from: "2026-09-01", to: TODAY });
  assert.deepEqual(normalizeRange({ from: "2026-09-30", to: "2026-09-10" }, TODAY), { from: "2026-09-10", to: TODAY });
  assert.deepEqual(normalizeRange({ from: "2026-12-01", to: "2026-12-05" }, TODAY), { from: TODAY, to: TODAY });
  assert.deepEqual(normalizeRange({ from: "2026-02-30", to: "2026-03-01" }, TODAY), { from: "2026-09-01", to: TODAY });
});

test("a month chip: this month runs to today, an older month is the whole month", () => {
  assert.deepEqual(monthRange("2026-09", TODAY), { from: "2026-09-01", to: TODAY });
  assert.deepEqual(monthRange("2026-06", TODAY), { from: "2026-06-01", to: "2026-06-30" });
  assert.deepEqual(monthRange("2026-02", TODAY), { from: "2026-02-01", to: "2026-02-28" });
  assert.equal(rangeMonth(monthRange("2026-06", TODAY), TODAY), "2026-06");
  assert.equal(rangeMonth({ from: "2026-06-01", to: "2026-06-15" }, TODAY), null, "half a month is not a month chip");
});
test("the picker offers months from the first payment to now", () => {
  assert.deepEqual(pickableMonths(TODAY, "2026-06-25"), ["2026-06", "2026-07", "2026-08", "2026-09"]);
  assert.equal(pickableMonths(TODAY).length, 12, "no first date = the last 12");
  assert.equal(pickableMonths(TODAY, "2020-01-01").length, 24, "never more than 24");
});

/* ---------------- which side ---------------- */
test("a subscription payment is platform, a hand-sent invoice is agency", () => {
  assert.equal(departmentFor({ invoiceReason: "subscription_cycle" }).dept, "platform");
  assert.equal(departmentFor({ invoiceReason: "manual" }).dept, "agency");
  assert.equal(departmentFor({ description: "Subscription creation" }).dept, "platform");
  assert.equal(departmentFor({ description: "Payment for Invoice" }).dept, "agency");
  assert.equal(departmentFor({}).dept, "agency", "a one-off payment is agency");
});
test("an owner's choice beats the rule", () => {
  assert.equal(departmentFor({ override: "platform", invoiceReason: "manual" }).dept, "platform");
  assert.equal(departmentFor({ override: "agency", invoiceReason: "subscription_create" }).dept, "agency");
});

/* ---------------- the page, on a September shaped like the real one ---------------- */
const summary = {
  customers: {
    cA: { id: "cA", name: "Agency One", dept: "agency" },
    cB: { id: "cB", name: "Agency Two", dept: "agency" },
    cP: { id: "cP", name: "Software Buyer", dept: "platform" },
    cF: { id: "cF", name: "Free Seat", dept: "platform" },
  },
  transactions: [
    { id: "ch1", date: "2026-08-07", cents: 850000, feeCents: 24680, customerId: "cA", customerName: "Agency One", dept: "agency" },
    { id: "ch2", date: "2026-08-11", cents: 20145, feeCents: 614, customerId: "cP", customerName: "Software Buyer", dept: "platform" },
    { id: "ch3", date: "2026-09-08", cents: 850000, feeCents: 24680, customerId: "cA", customerName: "Agency One", dept: "agency" },
    { id: "ch4", date: "2026-09-11", cents: 850000, feeCents: 24680, customerId: "cP", customerName: "Software Buyer", dept: "platform" },
    { id: "ch5", date: "2026-09-16", cents: 19900, feeCents: 607, customerId: "cP", customerName: "Software Buyer", dept: "platform" },
    { id: "ch6", date: "2026-09-24", cents: 300000, feeCents: 8730, customerId: "cB", customerName: "Agency Two", dept: "agency" },
  ],
  refunds: [{ id: "re1", date: "2026-09-12", cents: 850000, chargeId: "ch4", dept: "platform" }],
  subscriptions: [
    { customerName: "Software Buyer", status: "active", lastMrrCents: 19900, mrrCents: 19900, started: "2026-08-11", ended: null },
    { customerName: "Free Seat", status: "active", lastMrrCents: 0, mrrCents: 0, started: "2026-08-12", ended: null },
    { customerName: "Gone", status: "canceled", lastMrrCents: 19900, mrrCents: 0, started: "2026-09-03", ended: "2026-09-06" },
  ],
  openInvoices: [
    { id: "in1", customerName: "Agency Three", dueCents: 250000, dueDate: "2026-09-20", dept: "agency" },
    { id: "in2", customerName: "Agency Four", dueCents: 500000, dueDate: "2026-10-07", dept: "agency" },
  ],
};
const ai = {
  workspaces: { w1: { stripeCustomerId: "cP" }, w2: { stripeCustomerId: "cA" }, w3: {} },
  rows: [
    { day: "2026-09-02", workspace_id: "w1", calls: 10, priced_calls: 10, cost_micros: 5_000_000 },
    { day: "2026-09-02", workspace_id: "w2", calls: 4, priced_calls: 4, cost_micros: 2_000_000 },
    { day: "2026-09-03", workspace_id: "w3", calls: 2, priced_calls: 1, cost_micros: 1_000_000 },
    { day: "2026-09-03", workspace_id: null, calls: 7, priced_calls: 0, cost_micros: 0 },
    { day: "2026-09-04", workspace_id: null, source: "platform", calls: 3, priced_calls: 3, cost_micros: 3_000_000 },
    { day: "2026-08-30", workspace_id: "w1", calls: 1, priced_calls: 1, cost_micros: 9_000_000 },
  ],
};
const expenses = [
  { incurred_on: "2026-06-01", interval: "monthly", amount_cents: 3000, category: "Software", department: null },
  { incurred_on: "2026-09-10", interval: "one_time", amount_cents: 50000, category: "Contractors", department: "agency" },
];
const SEP = { from: "2026-09-01", to: "2026-09-30" };
const v = financeView({ summary, ai, expenses, range: SEP, today: "2026-09-24", aiDollars: true });
const vTok = financeView({ summary, ai, expenses, range: SEP, today: "2026-09-24" });

test("money in, per side, nets the refund on the day it went back", () => {
  assert.equal(v.sides.agency.in, 1150000);
  assert.equal(v.sides.platform.gross, 869900);
  assert.equal(v.sides.platform.refunds, 850000);
  assert.equal(v.sides.platform.in, 19900);
  assert.equal(v.all.in, 1169900);
});
test("card fees land on the side of the payment", () => {
  assert.equal(v.sides.agency.fees, 24680 + 8730);
  assert.equal(v.sides.platform.fees, 24680 + 607);
});
test("AI: an agency client's workspace is agency cost, no account is shared", () => {
  assert.equal(v.sides.platform.ai, 600, "w1 $5 + w3 $1");
  assert.equal(v.sides.agency.ai, 200);
  assert.equal(v.sides.shared.ai, 300);
  assert.equal(v.ai.unpricedCalls, 8, "unpriced calls are counted, not priced at $0");
  assert.equal(aiDept({ client_id: "x" }), "agency");
});
test("by default AI adds NO dollars to money out (tokens only, 24 Sep 2026)", () => {
  assert.equal(vTok.all.ai, 0);
  assert.equal(vTok.all.out, v.all.out - v.all.ai);
  assert.equal(vTok.series.reduce((a, b) => a + b.out, 0), vTok.all.out, "the chart agrees");
  assert.equal(vTok.ai.dollars, false);
});
test("typed costs: one-off on its day, monthly once per month, blank side = shared", () => {
  assert.equal(v.sides.agency.typed, 50000);
  assert.equal(v.sides.shared.typed, 3000);
  const part = expenseInRange(expenses[0], { from: "2026-09-01", to: "2026-09-10" }, "day");
  assert.equal(Object.values(part).reduce((a, b) => a + b, 0), 1000, "10 of 30 days = a third");
  assert.equal(Object.keys(expenseInRange(expenses[0], { from: "2026-05-01", to: "2026-05-31" }, "month")).length, 0, "not before it started");
});
test("out and kept add up exactly", () => {
  const out = v.sides.platform.out + v.sides.agency.out + v.sides.shared.out;
  assert.equal(v.all.out, out);
  assert.equal(v.all.kept, v.all.in - v.all.out);
  const sumSeriesIn = v.series.reduce((a, b) => a + b.platformIn + b.agencyIn, 0);
  assert.equal(sumSeriesIn, v.all.in, "the chart and the tiles agree");
  const sumSeriesOut = v.series.reduce((a, b) => a + b.out, 0);
  assert.equal(sumSeriesOut, v.all.out);
});
test("a $0 subscription is a free seat, not a paying client", () => {
  assert.equal(v.platform.paying.length, 1);
  assert.equal(v.platform.mrrCents, 19900);
  assert.equal(v.platform.free.length, 1);
  assert.equal(v.platform.newPaying.length, 1, "Gone started in September");
  assert.equal(v.platform.cancelled.length, 1);
});
test("a past period counts the subscribers who were live on its last day", () => {
  const aug = financeView({ summary, ai, expenses, range: { from: "2026-08-01", to: "2026-08-31" }, today: "2026-09-24" });
  assert.equal(aug.platform.paying.length, 1, "Software Buyer started Aug 11");
  assert.equal(aug.platform.free.length, 1, "Free Seat started Aug 12");
  assert.equal(aug.platform.asOf, "2026-08-31");
  const jul = financeView({ summary, ai, expenses, range: { from: "2026-07-01", to: "2026-07-31" }, today: "2026-09-24" });
  assert.equal(jul.platform.paying.length, 0, "nobody had started yet");
});
test("agency: owed and overdue come from open invoices", () => {
  assert.equal(v.agency.owedCents, 750000);
  assert.equal(v.agency.overdue.length, 1);
});
test("August does not leak into September", () => {
  const aug = financeView({ summary, ai, expenses, range: { from: "2026-08-01", to: "2026-08-31" }, aiDollars: true });
  assert.equal(aug.all.in, 870145);
  assert.equal(aug.sides.platform.ai, 900);
});
test("changeVs never invents a change from nothing", () => {
  assert.equal(changeVs(10, 0), null);
  assert.equal(changeVs(0, 0), 0);
  assert.equal(changeVs(15, 10), 0.5);
});

/* ---------------- AI rows get a tag ---------------- */
test("every AI row gets the most specific label it carries", () => {
  assert.equal(jobOf({ platform_feature: "brand.scan", meta: { feature_name: "X" } }), "brand.scan");
  assert.equal(jobOf({ meta: { feature_name: "Lead capture", entry: "/api/lead/" } }), "Lead capture");
  assert.equal(jobOf({ meta: { entry: "/api/lead/" } }), "/api/lead/");
  assert.equal(jobOf({ feature: "client_report", meta: {} }), "console · client_report");
  assert.equal(jobOf({ feature: "other", meta: {} }), null);
});
test("Node grouping follows the SQL rollup rules (tests/money/sql.sh checks the SQL side): team-calendar day, priced vs unpriced", () => {
  const g = groupRows([
    { ts: "2026-09-02T04:30:00Z", provider: "anthropic", workspace_id: "w", cost_micros: "1000" },
    { ts: "2026-09-02T04:40:00Z", provider: "anthropic", workspace_id: "w", cost_micros: null },
    { ts: "2026-09-02T05:10:00Z", provider: "anthropic", workspace_id: "w", cost_micros: 500 },
  ]);
  const sep1 = g.find((x) => x.day === "2026-09-01");
  const sep2 = g.find((x) => x.day === "2026-09-02");
  assert.equal(sep1.calls, 2);
  assert.equal(sep1.priced_calls, 1);
  assert.equal(sep1.cost_micros, 1000, "a string bigint is added, not glued on");
  assert.equal(sep2.cost_micros, 500);
});

/* ---------------- AI Cost is TOKENS (24 Sep 2026) ---------------- */
const tokData = {
  workspaces: { w1: { name: "Dahler" }, w2: { name: "Ryan" } },
  credits: [{ workspace_id: "w1", spent: 40, refunded: 5, spends: 2 }],
  rows: [
    { day: "2026-09-02", workspace_id: "w1", provider: "anthropic", model: "m", job: "brand.scan", calls: 10, input_tokens: 1000, cache_write_tokens: 500, output_tokens: 200, cache_read_tokens: 9000, cost_micros: 999 },
    { day: "2026-09-03", workspace_id: "w2", provider: "openai", model: "g", job: "social.post", calls: 4, input_tokens: 3000, output_tokens: 1000 },
    { day: "2026-09-03", workspace_id: null, source: "platform", provider: "serpapi", model: null, job: "Lead capture", calls: 50 },
    { day: "2026-08-30", workspace_id: "w1", provider: "anthropic", model: "m", job: "brand.scan", calls: 1, input_tokens: 77, output_tokens: 1 },
  ],
};
const tv = aiCostView(tokData, SEP);
test("tokens = in (input + cache writes) + out; cache reads are counted apart", () => {
  assert.equal(tv.total.tokensIn, 4500);
  assert.equal(tv.total.tokensOut, 1200);
  assert.equal(tv.total.tokens, 5700);
  assert.equal(tv.total.cacheRead, 9000, "not in the headline");
});
test("services with no tokens are counted as calls, not as tokens", () => {
  assert.equal(tv.total.tokenlessCalls, 50);
  assert.equal(tv.total.calls, 64);
});
test("accounts rank by tokens, and the no-account row is its own line", () => {
  assert.equal(tv.accounts[0].info.name, "Ryan", "4,000 tokens beats 1,700");
  assert.equal(tv.accounts[1].tokens, 1700);
  assert.ok(tv.accounts.some((a) => a.key === NO_ACCOUNT && a.calls === 50 && a.tokens === 0));
  assert.equal(tv.accountShare, 1, "every token here is tied to an account");
  assert.equal(tv.accounts[1].credits, 35, "credits land on the same account");
});
test("the over-time chart counts tokens, and August stays out of September", () => {
  assert.equal(tv.series.reduce((a, b) => a + b.tagged + b.none, 0), 5700);
});

console.log(`\n${pass} passed, ${fail} failed (TZ=${process.env.TZ || "unset"})`);
process.exit(fail ? 1 : 0);
