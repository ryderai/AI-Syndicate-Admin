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
  /* null sorts nowhere near zero. On "Speed to first touch" a rep we could not
   * measure must not come out as the fastest person on the team.
   * (Speed rather than At risk: At risk is `crown: false` — see the raw-count
   * rule — so it could not test the crown at all.) */
  const r = rankReps([
    rep("Cannot read", { speed_days: null, speed_sample: 0 }),
    rep("Two days", { speed_days: 2, speed_sample: 5 }),
    rep("Five days", { speed_days: 5, speed_sample: 5 }),
  ], "speed");
  assert.equal(r.bars[0].rep.full_name, "Two days");
  assert.equal(r.bars[0].best, true);
  assert.equal(r.bars[2].best, false);
  assert.equal(r.bars[2].measured, false);
});

test("an unmeasured row goes to the bottom on a metric nobody can win, too", () => {
  /* `crown: false` turns off the CHIP, not the ordering or the null rule. */
  const r = rankReps([
    rep("Cannot read", { at_risk: null }),
    rep("Five at risk", { at_risk: 5 }),
    rep("Two at risk", { at_risk: 2 }),
  ], "at_risk");
  assert.deepEqual(r.bars.map((b) => b.rep.full_name), ["Two at risk", "Five at risk", "Cannot read"]);
  assert.equal(r.bars[2].measured, false);
  assert.equal(r.bars.every((b) => !b.best), true);
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
  /* Touching a lead the same day it was claimed is 0 business days — the best
   * possible result, not an absence of one. This is the case the "winner must
   * be above zero" rule must NOT apply to. */
  const r = rankReps([
    rep("Same day", { speed_days: 0, speed_sample: 6 }),
    rep("Three days", { speed_days: 3, speed_sample: 6 }),
  ], "speed");
  assert.equal(r.crowned, true);
  assert.equal(r.bars[0].rep.full_name, "Same day");
  assert.equal(r.bars[0].best, true);
});

test("everybody tied at the top is marked, not one of them picked", () => {
  const r = rankReps([rep("A", { won: 5 }), rep("B", { won: 5 }), rep("C", { won: 1 })], "won");
  assert.equal(r.bars.filter((b) => b.best).length, 2);
  assert.equal(r.bars[2].best, false);
});

test("the three metrics nobody can win are the three we mean", () => {
  const nocrown = REP_METRICS.filter((m) => m.crown === false).map((m) => m.key).sort();
  assert.deepEqual(nocrown, ["at_risk", "lost", "open"]);
});

test("a rep who did NOTHING is not crowned best on Lost or At risk", () => {
  /* The defect this exists to stop, found by an adversarial review Aug 30 2026:
   * `lost` and `at_risk` were ranked as raw counts, lowest first. A rep who
   * emailed forty people and claimed nothing has lost 0 and holds 0 at risk, so
   * the page put a BEST chip on them above a rep with 200 claims and 3 losses.
   * A count with no denominator is not a performance. */
  const rows = [
    rep("Did nothing", { claimed: 0, lost: 0, at_risk: 0, open: 0 }),
    rep("Worked hard", { claimed: 200, lost: 3, at_risk: 2, open: 40 }),
  ];
  for (const key of ["lost", "at_risk"]) {
    const r = rankReps(rows, key);
    assert.equal(r.crowned, false, `${key} crowned somebody`);
    assert.equal(r.crownable, false, `${key} still claims to be winnable`);
    assert.equal(r.bars.every((b) => !b.best), true, `${key} marked a bar best`);
  }
});

test("hoarding leads is not a win either — Open right now crowns nobody", () => {
  const r = rankReps([rep("Hoarder", { open: 80, claimed: 80 }), rep("Closer", { open: 4, claimed: 40 })], "open");
  assert.equal(r.crowned, false);
  assert.equal(r.bars[0].rep.full_name, "Hoarder", "it should still SORT biggest first and draw the bar");
  assert.equal(r.bars[0].best, false, "it must not put a chip on them");
});

test("every metric nobody can win prints the book its number came out of", () => {
  /* If the page will not name a winner it has to give the reader what they need
   * to judge it themselves. "Lost 3" means nothing; "3 of 200 claimed" does. */
  const row = rep("A", { claimed: 200, lost: 3, at_risk: 2, open: 40 });
  for (const m of REP_METRICS.filter((x) => x.crown === false)) {
    const r = rankReps([row], m.key);
    assert.ok(r.bars[0].sub, `${m.key} draws a bare count with nothing underneath it`);
  }
  assert.equal(rankReps([row], "lost").bars[0].sub, "of 200 they have claimed");
  assert.equal(rankReps([row], "at_risk").bars[0].sub, "of 40 they are holding");
});

test("a winnable metric is still winnable — the crown rule did not turn everything off", () => {
  const r = rankReps([rep("A", { won: 5 }), rep("B", { won: 1 })], "won");
  assert.equal(r.crownable, true);
  assert.equal(r.crowned, true);
  assert.equal(r.bars[0].best, true);
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
  /* Order alone was not enough — `.map()` cannot reorder its input, so that
   * half of this test could never fail. The stat objects are what matter: this
   * page hands the SAME rows to the chart and to the table, so a chart that
   * wrote into them would change the table. */
  const rows = [rep("A", { won: 1 }), rep("B", { won: 9 })];
  const before = JSON.stringify(rows);
  rankReps(rows, "won");
  rankReps(rows, "at_risk");
  assert.equal(JSON.stringify(rows), before, "rankReps changed the rows it was given");
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
  /* IMPORTS, not substrings. The first version of this test grepped the whole
   * file for "repStats" — which passes on a page where the import is unused —
   * and its third line was `!A || B` where B was unconditionally true, so it
   * could never fail. Found by an adversarial review, Aug 30 2026. */
  assert.ok(/import\s*\{[^}]*\brepStats\b[^}]*\}\s*from\s*"[^"]*sales-rules\.js"/.test(CODE),
    "the page does not import repStats from lib/sales-rules.js");
  assert.ok(/import\s*\{[^}]*\boutreachByRep\b[^}]*\}\s*from\s*"[^"]*outreach\.js"/.test(CODE),
    "the page does not import outreachByRep from lib/outreach.js");
  assert.ok(/repStats\(/.test(CODE) && /outreachByRep\(/.test(CODE), "they are imported but never called");

  /* THE ONE PLACE THIS PAGE IS ALLOWED TO COUNT FOR ITSELF is the team line —
   * over every lead, because most of this pipeline has no owner. That is one
   * loop. A SECOND per-rep loop over `leads` would be the page working an
   * answer out twice, which is the whole thing this file exists to stop. */
  const loops = (CODE.match(/for\s*\(const\s+l\s+of\s+leads\)/g) || []).length;
  assert.equal(loops, 1, `the page loops over every lead ${loops} times, not once`);
  assert.ok(!/owner_id === r\.user_id/.test(CODE), "the page looks like it is splitting leads by rep itself");
});

test("the chart and the table are handed the SAME rows", () => {
  /* Two reads of the same team is how a chart and a table under it come to
   * disagree. The page must pass `rows` down, not fetch again. */
  assert.ok(/<RepBars[\s\S]{0,200}rows=\{rows\}/.test(CODE), "RepBars is not given the table's rows");
  assert.equal((CODE.match(/getSalesBoard\(/g) || []).length, 1, "the page reads the board more than once");
});

test("the page can tell the owner that a read FAILED", () => {
  /* getSalesBoard() does not reject on a failed read — it returns an empty list
   * and records the failure in `errors` / `failed`. Without these banners the
   * page prints "Contacts loaded 0 · Won 0" and signs off "every figure here is
   * counted from real rows", and all of it is false. The Sales page and a rep's
   * Overview have carried this pair since Aug 27; this page shipped without it.
   * Found by an adversarial review, Aug 30 2026. */
  assert.ok(CODE.includes("board.errors"), "the page never looks at board.errors");
  assert.ok(CODE.includes("board.truncated"), "the page never looks at board.truncated");
  assert.ok(/role="alert"[\s\S]{0,400}Some of this did not load/.test(CODE)
    || /Some of this did not load[\s\S]{0,400}/.test(CODE), "there is no failed-read banner");
  assert.ok(CODE.includes("Not everything is loaded"), "there is no short-read banner");
});

test("a failed read reaches the outreach maths as null, not as an empty list", () => {
  /* lib/outreach.js's whole null-is-not-zero contract is unreachable unless the
   * page passes null. `board.failed` is what makes it reachable. */
  assert.ok(CODE.includes("board.failed"), "the page never reads board.failed");
  assert.ok(/f\.leads \? null : board\.leads/.test(CODE), "leads are passed through even when the read failed");
  assert.ok(/f\.activity \? null : board\.activity/.test(CODE), "activity is passed through even when the read failed");
  assert.ok(/f\.proposals \? null : board\.proposals/.test(CODE), "proposals are passed through even when the read failed");
});

test("the page does not promise 'real rows' when some of them did not arrive", () => {
  assert.ok(CODE.includes("short"), "there is no short-read flag");
  /* The unconditional version of both of these sentences must be gone. */
  assert.ok(!/>\s*That is an empty list, not a missing one\./.test(CODE),
    "the 'empty not missing' line is still unconditional");
  assert.ok(!/Every figure here is counted from real rows\. <strong>/.test(CODE),
    "the 'real rows' line is still unconditional");
});

test("the chart heading says 'loaded', not 'all time'", () => {
  /* PERIOD_ALL means every row the page managed to READ. On a short read those
   * are very different sentences, and the chart heading was making the stronger
   * one. Found by an adversarial review, Aug 30 2026. */
  assert.ok(CODE.includes('return "over everything loaded"'), "the chart still says 'all time'");
  assert.ok(!/PERIOD_ALL\) return "all time"/.test(CODE), "the old wording is back");
});

test("periodWords has no silent default", () => {
  /* Returning "right now" for anything unrecognised would label an all-time
   * figure as live the day somebody typos a period. */
  assert.ok(/PERIOD_NOW\) return "right now"/.test(CODE), "PERIOD_NOW is not checked explicitly");
  assert.ok(/return "";\s*\n\}/.test(CODE), "an unknown period still falls through to a real label");
});

test("the no-winner sentence has a branch for nobody, not just for one", () => {
  /* The first version read `only {measured === 1 ? "one rep has" : "no reps have"}
   * this number, and best of one is not a comparison` — so a metric nobody has
   * printed "only no reps have this number, and best of one is not a
   * comparison". Caught by loading the page and reading it, not by a test, which
   * is why this one is here now. */
  assert.ok(PAGE.includes("r.measured === 0"), "there is no branch for nobody having the number");
  assert.ok(!PAGE.includes("no reps have"), "the broken sentence is back");
});

test("the page never tells the owner a read FAILED when the number is merely absent", () => {
  /* A rate is null both when the read failed AND when nobody has been emailed
   * yet — no denominator. The first version of the chart footer said "a number
   * this page could not read for them" for every unmeasured row, which on a
   * quiet week is a false claim about our own systems. Caught by reading the
   * live page. */
  assert.ok(!PAGE.includes("could not read for them"), "the overstated sentence is back");
});

test("the filter chips are real buttons, with a pressed state and a name", () => {
  /* Scoped to the chip element itself. Grepping the whole file for "<button"
   * and "aria-pressed" separately would pass on a page whose chips were divs
   * and whose aria-pressed sat on something else entirely. */
  const chip = CODE.match(/<button[\s\S]{0,600}?adm-st-chip[\s\S]{0,600}?>/);
  assert.ok(chip, "the chip is not a <button> carrying the adm-st-chip class");
  assert.ok(/aria-pressed=/.test(chip[0]), "the chip does not say whether it is the chosen one");
  assert.ok(/type="button"/.test(chip[0]), "a button with no type submits a form");
  /* An explanation that lives only in `title` cannot be reached by keyboard and
   * does not exist on a touch screen. */
  assert.ok(/aria-label=/.test(chip[0]), "the chip's meaning is only in a hover tooltip");
});

/* ================================================================== */

console.log("\nSALES · STATS — the by-rep chart\n");
console.log(results.join("\n"));
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
