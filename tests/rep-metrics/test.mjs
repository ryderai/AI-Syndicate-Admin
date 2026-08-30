/* Tests for the Sales · Stats bar chart's ranking — lib/rep-metrics.js.
 *
 * Run with:  bash tests/rep-metrics/run.sh
 *
 * No database, no network, no browser. This file exists because the chart makes
 * a CLAIM about a person — "this rep performed best" — in front of two owners.
 * A chart that sorts the wrong way, or crowns somebody on a failed read, is
 * worse than no chart, so every one of those cases is pinned here.
 *
 * The stat objects below are shaped like the real ones: the fields are the
 * fields `repStats` (lib/sales-rules.js) and `outreachFor` (lib/outreach.js)
 * actually return, checked against those files rather than invented, because a
 * fixture that agrees with the reader instead of with the producer proves
 * nothing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REP_METRICS, REP_METRIC_KEYS, REP_METRIC_GROUPS, DEFAULT_REP_METRIC,
  metricFor, formatMetric, rankReps, barPct,
  PERIOD_ALL, PERIOD_WINDOW, PERIOD_NOW,
} from "../../lib/rep-metrics.js";
import { repStats } from "../../lib/sales-rules.js";
import { outreachFor } from "../../lib/outreach.js";

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try { fn(); passed += 1; results.push(`  ok   ${name}`); }
  catch (err) { failed += 1; results.push(`  FAIL ${name}\n       ${err.message}`); }
}

/* A rep row is exactly what SalesStats builds: the member, their repStats, and
 * their outreach stats. Anything not named falls back to a measured zero, so a
 * test that cares about one field says only that field. */
const ZERO_S = {
  claimed: 0, open: 0, calls: 0, emails: 0, texts: 0, meetings: 0, proposals: 0,
  won: 0, lost: 0, speed_days: null, speed_sample: 0, at_risk: 0, decided: 0,
  close_rate: null,
};
const ZERO_O = {
  emailed: 0, replied: 0, bounced: 0, replyBase: 0, replyRate: null,
  logged: { email: 0, call: 0, text: 0, linkedin: 0 },
  proposalsOut: 0, proposalCents: null,
};
const rep = (name, s = {}, o = {}) => ({
  rep: { user_id: `u-${name}`, full_name: name, role: "sales", active: true },
  s: { ...ZERO_S, userId: `u-${name}`, ...s },
  o: o === null ? null : { ...ZERO_O, ...o, logged: { ...ZERO_O.logged, ...(o.logged || {}) } },
});
const order = (r) => r.bars.map((b) => b.rep.full_name);

/* ================================================================== */
/* THE LIST ITSELF                                                     */
/* ================================================================== */

test("every metric key is unique", () => {
  assert.equal(new Set(REP_METRIC_KEYS).size, REP_METRIC_KEYS.length);
});

test("the default metric exists in the list", () => {
  assert.ok(metricFor(DEFAULT_REP_METRIC), `${DEFAULT_REP_METRIC} is not a metric`);
});

test("every metric carries a label, a period, a direction, a unit and a plain-words explanation", () => {
  for (const m of REP_METRICS) {
    assert.ok(m.label && m.label.length > 2, `${m.key} has no label`);
    assert.ok([PERIOD_ALL, PERIOD_WINDOW, PERIOD_NOW].includes(m.period), `${m.key} has no period`);
    assert.ok(["high", "low"].includes(m.better), `${m.key} has no direction`);
    assert.ok(["count", "percent", "days"].includes(m.unit), `${m.key} has a strange unit`);
    /* Every chip's tooltip. A filter whose name is the only thing explaining it
     * is a filter two owners will read two different ways. */
    assert.ok(m.what && m.what.length > 20, `${m.key} has no plain-words explanation`);
    assert.equal(typeof m.read, "function", `${m.key} cannot be read`);
  }
});

test("the three metrics where fewer is better are the three we mean", () => {
  const low = REP_METRICS.filter((m) => m.better === "low").map((m) => m.key).sort();
  assert.deepEqual(low, ["at_risk", "lost", "speed"]);
});

test("every rate metric prints the counts behind it", () => {
  /* An average with no denominator on screen is the one-reply-out-of-one bug. */
  for (const m of REP_METRICS.filter((x) => x.rate)) {
    assert.equal(typeof m.sub, "function", `${m.key} is a rate with no counts beside it`);
  }
});

test("grouping keeps every metric exactly once, in order", () => {
  const flat = REP_METRIC_GROUPS.flatMap((g) => g.metrics.map((m) => m.key));
  assert.deepEqual(flat, REP_METRIC_KEYS);
});

test("an unknown metric key falls back to the default instead of throwing", () => {
  const r = rankReps([rep("A")], "not_a_metric");
  assert.equal(r.metric.key, DEFAULT_REP_METRIC);
});

/* ================================================================== */
/* THE FIELDS ARE REAL FIELDS                                          */
/* ================================================================== */
/* The point of failure this catches: a metric reading `s.wins` instead of
 * `s.won` returns undefined for everybody, every bar disappears, and the page
 * says "not measured" for the whole team rather than crashing. Silent. So the
 * readers are run against the OUTPUT OF THE REAL FUNCTIONS, not a fixture. */

test("every metric reads a field the real repStats/outreachFor actually return", () => {
  const now = "2026-08-30T17:00:00.000Z";
  const nowMs = Date.parse(now);
  const leads = [{
    id: "l1", owner_id: "u1", stage: "won", claimed_at: "2026-08-20T12:00:00.000Z",
    claim_contacted_at: "2026-08-21T12:00:00.000Z", first_contact_at: "2026-08-21T12:00:00.000Z",
    first_email_at: "2026-08-21T12:00:00.000Z", first_reply_at: "2026-08-22T12:00:00.000Z",
    closed_at: "2026-08-25T12:00:00.000Z", bounced_at: null,
  }];
  const activity = [{ actor: "u1", type: "call", created_at: "2026-08-22T12:00:00.000Z" }];
  const proposals = [{ lead_id: "l1", status: "sent", amount_cents: 250000 }];

  const s = repStats(leads, activity, { userId: "u1", now });
  const o = outreachFor({ leads, activity, proposals, userId: "u1", nowMs });
  const row = { rep: { user_id: "u1", full_name: "Real" }, s, o };

  for (const m of REP_METRICS) {
    const v = m.read(row);
    assert.ok(v !== undefined, `${m.key} read undefined — the field name is wrong`);
    assert.ok(v === null || Number.isFinite(v), `${m.key} read a non-number: ${v}`);
  }
  /* And at least the obvious ones landed on real values rather than all nulls. */
  assert.equal(metricFor("won").read(row), 1);
  assert.equal(metricFor("claimed").read(row), 1);
  assert.equal(metricFor("calls").read(row), 1);
  assert.equal(metricFor("proposals").read(row), 1);
  assert.equal(metricFor("close_rate").read(row), 100);
});

/* ================================================================== */
/* SORTING                                                             */
/* ================================================================== */

test("more-is-better sorts biggest first", () => {
  const r = rankReps([rep("Low", { won: 1 }), rep("High", { won: 9 }), rep("Mid", { won: 4 })], "won");
  assert.deepEqual(order(r), ["High", "Mid", "Low"]);
});

test("fewer-is-better sorts SMALLEST first — the slow rep is not the leader", () => {
  /* The bug this exists to stop: one sort for every metric, so the rep who
   * takes nine days to touch a lead sits at the top of the chart with the
   * longest bar and a BEST chip on them. */
  const r = rankReps([
    rep("Slow", { speed_days: 9, speed_sample: 4 }),
    rep("Fast", { speed_days: 1, speed_sample: 4 }),
    rep("Mid", { speed_days: 3, speed_sample: 4 }),
  ], "speed");
  assert.deepEqual(order(r), ["Fast", "Mid", "Slow"]);
  assert.equal(r.bars[0].best, true);
  assert.equal(r.bars[2].best, false);
});

test("a tie is sorted by name, not by whoever was loaded first", () => {
  const r = rankReps([rep("Zoe", { won: 3 }), rep("Adam", { won: 3 })], "won");
  assert.deepEqual(order(r), ["Adam", "Zoe"]);
});

/* ================================================================== */
/* NULL IS NOT ZERO                                                    */
/* ================================================================== */

test("a rep whose number could not be read is held OUT of the ranking, at the bottom", () => {
  const r = rankReps([
    rep("Unreadable", {}, { emailed: null }),
    rep("Sent none", {}, { emailed: 0 }),
    rep("Sent some", {}, { emailed: 5 }),
  ], "emailed");
  assert.deepEqual(order(r), ["Sent some", "Sent none", "Unreadable"]);
  assert.equal(r.measured, 2);
  assert.equal(r.unmeasured, 1);
  assert.equal(r.bars[2].measured, false);
  assert.equal(r.bars[2].display, null, "an unmeasured row must have no number to print");
});

test("a measured zero still prints 0 — it is a result, not a gap", () => {
  const r = rankReps([rep("A", { won: 2 }), rep("B", { won: 0 })], "won");
  const b = r.bars.find((x) => x.rep.full_name === "B");
  assert.equal(b.measured, true);
  assert.equal(b.display, "0");
});

test("a failed read is never crowned best, even on a fewer-is-better metric", () => {
  /* null sorts nowhere near zero: on "At risk" a rep we could not read must not
   * come out as the safest person on the team. */
  const r = rankReps([
    rep("Cannot read", { at_risk: null }),
    rep("Two at risk", { at_risk: 2 }),
    rep("Five at risk", { at_risk: 5 }),
  ], "at_risk");
  assert.equal(r.bars[0].rep.full_name, "Two at risk");
  assert.equal(r.bars[0].best, true);
  assert.equal(r.bars[2].best, false);
  assert.equal(r.bars[2].measured, false);
});

test("a whole missing outreach object does not throw", () => {
  const r = rankReps([rep("No outreach", {}, null), rep("Has some", {}, { emailed: 3 })], "reply_rate");
  assert.equal(r.bars.length, 2);
  assert.equal(r.unmeasured, 2, "neither has a reply rate, so neither is ranked");
});

/* ================================================================== */
/* WHO GETS CROWNED                                                    */
/* ================================================================== */

test("nobody is crowned when only one rep has the number", () => {
  const r = rankReps([rep("Only", { won: 4 }), rep("Blank", {}, { emailed: null })], "won");
  /* "Blank" still has a measured won of 0, so this needs a genuinely unread one */
  const r2 = rankReps([rep("Only", { won: 4 }), rep("Blank", { won: null })], "won");
  assert.equal(r2.measured, 1);
  assert.equal(r2.crowned, false);
  assert.equal(r2.bars[0].best, false);
  assert.ok(r.crowned, "two measured reps with a winner above zero should crown");
});

test("nobody is crowned when everybody is on zero", () => {
  const r = rankReps([rep("A", { won: 0 }), rep("B", { won: 0 })], "won");
  assert.equal(r.crowned, false);
  assert.equal(r.bars.every((b) => !b.best), true);
});

test("zero DOES win on a fewer-is-better metric", () => {
  /* Nobody at risk is the best possible result, not an absence of one. */
  const r = rankReps([rep("Clean", { at_risk: 0 }), rep("Messy", { at_risk: 3 })], "at_risk");
  assert.equal(r.crowned, true);
  assert.equal(r.bars[0].rep.full_name, "Clean");
  assert.equal(r.bars[0].best, true);
});

test("everybody tied at the top is marked, not one of them picked", () => {
  const r = rankReps([rep("A", { won: 5 }), rep("B", { won: 5 }), rep("C", { won: 1 })], "won");
  assert.equal(r.bars.filter((b) => b.best).length, 2);
  assert.equal(r.bars[2].best, false);
});

/* ================================================================== */
/* WHAT THE BARS AND LABELS SAY                                        */
/* ================================================================== */

test("bar length is a share of the biggest bar, and never overflows", () => {
  assert.equal(barPct(5, 10), 50);
  assert.equal(barPct(10, 10), 100);
  assert.equal(barPct(0, 10), 0);
  assert.ok(barPct(12, 10) <= 100, "a bar can never be longer than its track");
});

test("no bar is drawn when there is nothing to scale to — 0 of 0 is not 100%", () => {
  assert.equal(barPct(0, 0), 0);
  assert.equal(barPct(null, 0), 0);
  assert.equal(barPct(3, null), 0);
});

test("units print with the unit — a percent is never a bare number", () => {
  assert.equal(formatMetric(42, "percent"), "42%");
  assert.equal(formatMetric(2.5, "days"), "2.5d");
  assert.equal(formatMetric(7, "count"), "7");
  assert.equal(formatMetric(null, "count"), null);
});

test("a rate prints its own denominator beside it", () => {
  const r = rankReps([
    rep("Lucky", { }, { replyRate: 100, replied: 1, replyBase: 1 }),
    rep("Real", { }, { replyRate: 30, replied: 9, replyBase: 30 }),
  ], "reply_rate");
  assert.equal(r.bars[0].rep.full_name, "Lucky");
  /* Lucky is top of the chart on the maths, and the chart says out loud that
   * it is 1 of 1. That is the whole defence against a leaderboard lie. */
  assert.equal(r.bars[0].sub, "1 of 1 who could answer");
  assert.equal(r.bars[1].sub, "9 of 30 who could answer");
});

test("close rate prints how many were decided", () => {
  const r = rankReps([rep("A", { close_rate: 50, won: 1, decided: 2 })], "close_rate");
  assert.equal(r.bars[0].sub, "1 won of 2 decided");
});

test("speed prints how many claims it averaged over", () => {
  const r = rankReps([rep("A", { speed_days: 2, speed_sample: 1 })], "speed");
  assert.equal(r.bars[0].sub, "over 1 claim");
  const r2 = rankReps([rep("A", { speed_days: 2, speed_sample: 6 })], "speed");
  assert.equal(r2.bars[0].sub, "over 6 claims");
});

test("an unmeasured row carries no counts either", () => {
  const r = rankReps([rep("A", { close_rate: null, won: 0, decided: 0 })], "close_rate");
  assert.equal(r.bars[0].sub, null, "a row with no rate must not print a denominator for it");
});

test("an empty team produces an empty chart rather than a crash", () => {
  const r = rankReps([], "won");
  assert.deepEqual(r.bars, []);
  assert.equal(r.max, 0);
  assert.equal(r.crowned, false);
});

test("rankReps does not reorder or mutate the rows it was given", () => {
  const rows = [rep("A", { won: 1 }), rep("B", { won: 9 })];
  const before = rows.map((r) => r.rep.full_name);
  rankReps(rows, "won");
  assert.deepEqual(rows.map((r) => r.rep.full_name), before);
});

/* ================================================================== */
/* THE PAGE AGREES WITH THIS FILE                                      */
/* ================================================================== */
/* Cheap source checks. They catch the class of change where somebody adds a
 * number straight into the chart instead of through a metric. */

const PAGE = readFileSync(new URL("../../src/components/admin/SalesStats.jsx", import.meta.url), "utf8");

/* The page WITHOUT its comments. This file's comment blocks talk about
 * `getSalesBoard()` by name, and counting the calls in the raw text counted the
 * prose too — the first version of the "reads the board once" check failed on a
 * page that reads it exactly once. Strip the comments, then count. */
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the Stats page draws the chart from lib/rep-metrics.js", () => {
  assert.ok(PAGE.includes("rep-metrics.js"), "the page does not import the metric list");
  assert.ok(PAGE.includes("rankReps"), "the page does not rank through rankReps");
});

test("the Stats page still reads the shared maths, not its own", () => {
  assert.ok(PAGE.includes("repStats"), "repStats is gone from the page");
  assert.ok(PAGE.includes("outreachByRep"), "outreachByRep is gone from the page");
  assert.ok(!/const\s+won\s*=\s*.*filter/.test(PAGE) || PAGE.includes("l.stage === \"won\""),
    "the page looks like it is counting wins for itself");
});

test("the chart and the table are handed the SAME rows", () => {
  /* Two reads of the same team is how a chart and a table under it come to
   * disagree. The page must pass `rows` down, not fetch again. */
  assert.ok(/<RepBars[\s\S]{0,200}rows=\{rows\}/.test(CODE), "RepBars is not given the table's rows");
  assert.equal((CODE.match(/getSalesBoard\(/g) || []).length, 1, "the page reads the board more than once");
});

test("the filter chips are real buttons with a pressed state", () => {
  assert.ok(PAGE.includes("aria-pressed"), "the chips do not announce which is chosen");
  assert.ok(PAGE.includes("<button"), "the chips are not buttons");
});

/* ================================================================== */

console.log("\nSALES · STATS — the by-rep chart\n");
console.log(results.join("\n"));
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
