/* Tests for the rep's Work page — Aug 26 2026.
 *
 * Run with:  bash tests/rep-brief/run.sh
 *        or: node tests/rep-brief/test.mjs
 *
 * No database, no key, no network, no browser. Everything under test is pure,
 * which is why it is in src/lib/repBrief.js and not in the .jsx file beside it.
 *
 * WHAT IS WORTH TESTING HERE, and it is not "it renders":
 *   1. The box's PREVIEW answer comes back in the endpoint's exact shape, and it
 *      tells the truth about itself — counted only, not saved.
 *   2. An empty question is refused before anything is read or sent.
 *   3. The numbers under the box come from lib/sales-rules.js and ADD UP. A set
 *      of buckets that quietly loses a state is worse than no buckets.
 *   4. A read that failed is null, never 0.
 *   5. Nothing outside the rep's own scope — money, our clients, another rep's
 *      follow-ups — reaches anything this page builds.
 */

import assert from "node:assert/strict";
import {
  REP_PRESETS, MAX_INSTRUCTION_CHARS, CLAIM_BUCKETS, OWED_REASONS, RULE_SENTENCES,
  checkInstruction, repSnapshotFromRows, buildRepPreviewAnswer,
  buildRepOverview, bucketsAddUp, whyOwed,
  countedOnlyCause, splitCountedFigures, answerDay,
} from "../../src/lib/repBrief.js";
import { teamDayStartOf, teamDayEndOf } from "../../src/lib/teamDay.js";
import { teamDate } from "../../lib/brain-context.js";
import { claimState, ROE, isOpenStage } from "../../lib/sales-rules.js";
import { cleanInstruction } from "../../lib/rep-report.js";

let passed = 0;
let failed = 0;
const TZ = process.env.TZ || "(system)";

function t(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log(`\n=== The rep's Work page · TZ=${TZ} ===`);

/* Wednesday 26 August 2026, mid-afternoon in Chicago. Every fixture date below
 * is chosen against this instant, so the answers do not move with the clock. */
const NOW = Date.parse("2026-08-26T17:00:00Z");
const ME = "u1";

/* One lead in every state claimState can return for a claim somebody holds, so
 * the buckets can be checked for gaps rather than just for totals. The two rows
 * at the bottom are the adversarial ones: another rep's lead, and money and
 * somebody's private note sitting on a row this page reads. */
function leads() {
  return [
    { id: "l1", name: "Greg Olson", company: "Summit Roofing", stage: "contacted", owner_id: ME, claimed_at: "2026-08-24T14:00:00Z", claim_contacted_at: null },
    { id: "l2", name: "Mia Chen", company: "Chen Dental", stage: "contacted", owner_id: ME, claimed_at: "2026-08-01T14:00:00Z", claim_contacted_at: "2026-08-05T14:00:00Z", last_touch_at: "2026-08-09T14:00:00Z", notes: "SECRET-NOTE-ON-A-LEAD", amount_cents: 450000 },
    { id: "l3", name: "Ray Vista", company: "Vista Dental", stage: "follow_up", owner_id: ME, claimed_at: "2026-08-02T14:00:00Z", claim_contacted_at: "2026-08-04T14:00:00Z", last_touch_at: "2026-08-13T14:00:00Z" },
    { id: "l4", name: "Ann Park", company: "Park Legal", stage: "in_conversation", owner_id: ME, claimed_at: "2026-08-20T14:00:00Z", claim_contacted_at: "2026-08-21T14:00:00Z", last_touch_at: "2026-08-25T14:00:00Z" },
    { id: "l5", name: "Neil Fresh", company: "Fresh Signs", stage: "new", owner_id: ME, claimed_at: "2026-08-26T13:00:00Z", claim_contacted_at: null },
    { id: "l6", name: "Ida Late", company: "Late Roofing", stage: "researching", owner_id: ME, claimed_at: "2026-08-18T14:00:00Z", claim_contacted_at: null },
    { id: "l7", name: "Open Floor", company: "Floor Motors", stage: "new", owner_id: null },
    { id: "l8", name: "Nina Lead", company: "Nina Co", stage: "contacted", owner_id: "u2", claimed_at: "2026-08-20T14:00:00Z", claim_contacted_at: "2026-08-21T14:00:00Z", last_touch_at: "2026-08-25T14:00:00Z" },
    { id: "l9", name: "Won One", company: "Won Co", stage: "won", owner_id: ME },
    { id: "l10", name: "Skip One", company: "Skip Co", stage: "skip_90", owner_id: ME },
  ];
}

/* The rows getMyWork puts in `contactable`. One per reason it can be there. */
function contactable() {
  const today = teamDate(NOW);
  return [
    { id: "l2", follow_ms: teamDayStartOf(today) - 1, last_touch: "2026-08-09T14:00:00Z" },
    { id: "l3", follow_ms: teamDayEndOf(today) - 1000, last_touch: "2026-08-13T14:00:00Z" },
    { id: "l6", follow_ms: null, last_touch: null },
    { id: "l1", follow_ms: teamDayStartOf(today) + 9 * 86400000, last_touch: "2026-08-24T14:00:00Z" },
  ];
}

function reminders() {
  return [
    { id: "r1", owner_id: ME, body: "Try Tom on his mobile", due_at: "2026-08-26T14:00:00Z", done_at: null },
    { id: "r2", owner_id: ME, body: "Send the audit before the call", due_at: "2026-08-25T14:00:00Z", done_at: null },
    { id: "r3", owner_id: ME, body: "Book the review", due_at: "2026-08-20T14:00:00Z", done_at: "2026-08-21T14:00:00Z" },
    { id: "r4", owner_id: "u2", body: "OTHER-REP-FOLLOW-UP", due_at: "2026-08-26T14:00:00Z", done_at: null },
  ];
}

const overview = () => buildRepOverview({
  userId: ME, leads: leads(), contactable: contactable(), reminders: reminders(), nowMs: NOW,
});

/* ------------------------------------------------------------------ */
/* 1. The box — what it sends                                          */
/* ------------------------------------------------------------------ */

t("an empty question is refused, with words a person can read", () => {
  const res = checkInstruction("");
  assert.equal(res.ok, false);
  assert.equal(res.error, "Type what you want to know first.");
});

t("whitespace only is the same as empty", () => {
  assert.equal(checkInstruction("   \n\t  ").ok, false);
});

t("an empty question is refused BEFORE the snapshot is even read", () => {
  /* A snapshot that screams if anybody touches it. The refusal must come first:
   * reading the rows to answer an empty box is work nobody asked for, and on the
   * live side it would be a model call that says nothing. */
  const boom = new Proxy({}, { get() { throw new Error("the snapshot was read"); } });
  const res = buildRepPreviewAnswer({ instruction: "  ", snap: boom, nowMs: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.error, "Type what you want to know first.");
});

t("an over-long question is capped, not refused", () => {
  const long = `${"x".repeat(900)} what is going cold?`;
  const res = checkInstruction(long);
  assert.equal(res.ok, true);
  assert.equal(res.instruction.length, MAX_INSTRUCTION_CHARS);
  assert.equal(res.capped, true);
});

t("the cap is the one lib/rep-report.js owns — there is no second cap", () => {
  const long = "y".repeat(2000);
  assert.equal(checkInstruction(long).instruction, cleanInstruction(long));
  assert.equal(MAX_INSTRUCTION_CHARS, 700);
});

t("a normal question passes through trimmed and unchanged", () => {
  const res = checkInstruction("  give me a rundown of my week  ");
  assert.equal(res.ok, true);
  assert.equal(res.instruction, "give me a rundown of my week");
  assert.equal(res.capped, false);
});

t("every preset only fills the box — none of them is empty", () => {
  assert.ok(REP_PRESETS.length >= 3);
  for (const p of REP_PRESETS) {
    assert.ok(p.id && p.label && p.hint, `${p.id} is missing a label`);
    assert.equal(checkInstruction(p.instruction).ok, true, `${p.id} would be refused`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. The preview answer                                              */
/* ------------------------------------------------------------------ */

function previewAnswer(instruction = "give me a rundown of my week") {
  const snap = repSnapshotFromRows({
    userId: ME,
    nowMs: NOW,
    leads: leads(),
    activity: [{ id: "a1", lead_id: "l1", actor: ME, type: "call", created_at: "2026-08-25T14:00:00Z" }],
    reminders: reminders(),
    companies: [{ id: "co1", name: "Summit Roofing", site_score: 58 }],
    lists: [{ id: "li1", name: "Roofers" }],
    proposals: [{ id: "pr1", lead_id: "l1", decided_at: null, amount_cents: 450000 }],
    sources: [],
    team: [{ user_id: ME, full_name: "Sample Rep", role: "sales" }],
  });
  return buildRepPreviewAnswer({ instruction, snap, nowMs: NOW });
}

/* The endpoint's contract, written out here so a change to either side has to
 * change this line too. */
/* `counted_cause` is the Aug 26 2026 addition: which of the three reasons a
 * counted answer happened for. The live endpoint does not send it yet, so the
 * panel reads it when it is there and falls back to the reason sentence when it
 * is not — see countedOnlyCause. */
const REPORT_KEYS = [
  "body", "counted_cause", "counted_only", "facts", "gate_reason", "generated_at",
  "id", "instruction", "saved", "summary",
];

t("the preview answer is the endpoint's exact response shape", () => {
  const res = previewAnswer();
  assert.equal(res.ok, true);
  assert.equal(res.sample, true);
  assert.deepEqual(Object.keys(res.report).sort(), REPORT_KEYS);
});

t("id is null in preview, because nothing was saved to hang an id on", () => {
  assert.equal(previewAnswer().report.id, null);
});

t("counted_only is true and saved is false, and both are said out loud", () => {
  const r = previewAnswer().report;
  assert.equal(r.counted_only, true);
  assert.equal(r.saved, false);
  assert.equal(typeof r.gate_reason, "string");
  assert.ok(r.gate_reason.length > 20, "the reason must be a sentence, not a code");
  assert.ok(!/[A-Z_]{4,}/.test(r.gate_reason), "the reason must be plain words");
});

t("the answer has a summary, a body and the counted figures beside them", () => {
  const r = previewAnswer().report;
  assert.ok(r.summary.trim().length > 20);
  assert.ok(r.body.includes("## The totals"));
  assert.ok(r.body.includes("## What needs you first"));
  assert.ok(Object.keys(r.facts.counts).length > 10);
  assert.ok(Array.isArray(r.facts.cannotAnswer) && r.facts.cannotAnswer.length > 0);
  assert.deepEqual(r.facts.unreadable, []);
});

t("the question comes back with the answer, trimmed", () => {
  assert.equal(previewAnswer("  which of my leads is going cold?  ").report.instruction,
    "which of my leads is going cold?");
});

t("generated_at is a real timestamp", () => {
  assert.equal(previewAnswer().report.generated_at, new Date(NOW).toISOString());
});

t("a failed read is NAMED on the answer, not counted as none", () => {
  const snap = repSnapshotFromRows({
    userId: ME, nowMs: NOW, leads: [], errors: { leads: "connection reset" },
  });
  const r = buildRepPreviewAnswer({ instruction: "what is going cold?", snap, nowMs: NOW }).report;
  assert.deepEqual(r.facts.unreadable, ["leads"]);
  assert.ok(r.facts.cannotAnswer.some((l) => l.includes("UNKNOWN, not empty")));
});

t("the box and the numbers under it agree about how many leads the rep holds", () => {
  /* The one number both halves of this page state. If assembleRepFacts and
   * buildRepOverview ever count "mine" differently, a rep reads two totals for
   * the same pipeline within a hand's width of each other. */
  assert.equal(previewAnswer().report.facts.counts.myLeadsOpen, overview().owned);
});

/* ------------------------------------------------------------------ */
/* 3. The snapshot is rep-scoped                                       */
/* ------------------------------------------------------------------ */

t("the snapshot holds no clients, tasks, invoices, email or tickets", () => {
  const snap = repSnapshotFromRows({ userId: ME, nowMs: NOW, leads: leads() });
  for (const k of ["clients", "tasks", "invoices", "payments", "expenses", "emails", "tickets", "brain", "notes", "weekly", "vault"]) {
    assert.ok(!(k in snap), `${k} must not be in a rep's snapshot at all`);
  }
});

t("the snapshot keeps only the rep's own follow-ups", () => {
  const snap = repSnapshotFromRows({ userId: ME, nowMs: NOW, reminders: reminders() });
  assert.equal(snap.reminders.length, 3);
  assert.ok(snap.reminders.every((r) => r.owner_id === ME));
});

t("no user id means no follow-ups at all, never everybody's", () => {
  const snap = repSnapshotFromRows({ userId: null, nowMs: NOW, reminders: reminders() });
  assert.deepEqual(snap.reminders, []);
});

t("nothing outside the rep's scope reaches the written answer", () => {
  const text = JSON.stringify(previewAnswer());
  for (const leak of ["OTHER-REP-FOLLOW-UP", "SECRET-NOTE-ON-A-LEAD", "450000", "Lakeside"]) {
    assert.ok(!text.includes(leak), `${leak} reached the answer`);
  }
});

t("the answer states no figure of money", () => {
  const r = previewAnswer().report;
  const words = `${r.summary}\n${r.body}`;
  assert.ok(!/\$/.test(words), "a dollar sign appeared in a rep's answer");
  assert.ok(!/cents/i.test(words));
});

/* ------------------------------------------------------------------ */
/* 4. The numbers                                                      */
/* ------------------------------------------------------------------ */

t("the rep's open total counts their own open leads and nobody else's", () => {
  const o = overview();
  assert.equal(o.owned, 6);
  assert.equal(o.floor, 1);
});

t("the claim buckets add up to the open total, with no state lost", () => {
  const o = overview();
  assert.equal(bucketsAddUp(o), true);
  assert.equal(o.buckets.reduce((a, b) => a + b.count, 0), o.owned);
});

t("every bucket count is exactly what claimState says", () => {
  const o = overview();
  const nowIso = new Date(NOW).toISOString();
  const mine = leads().filter((l) => l.owner_id === ME && isOpenStage(l.stage));
  for (const b of o.buckets) {
    const expect = mine.filter((l) => claimState(l, nowIso).state === b.key).length;
    assert.equal(b.count, expect, `${b.key} says ${b.count}, claimState says ${expect}`);
  }
  // and the fixture really does exercise all six, so a gap could show up
  assert.deepEqual(o.buckets.map((b) => b.count), [1, 1, 1, 1, 1, 1]);
});

t("the buckets are the states claimState can return for a held claim", () => {
  const nowIso = new Date(NOW).toISOString();
  const seen = new Set(leads()
    .filter((l) => l.owner_id === ME && isOpenStage(l.stage))
    .map((l) => claimState(l, nowIso).state));
  const named = new Set(CLAIM_BUCKETS.map((b) => b.key));
  for (const s of seen) assert.ok(named.has(s), `claimState returns ${s} and no bucket holds it`);
});

t("the cold line is ROE's, not one of ours", () => {
  const nowIso = new Date(NOW).toISOString();
  // 17 days quiet against a 14-day rule = cold; 13 = going cold; 1 = working.
  assert.equal(claimState(leads()[1], nowIso).state, "cold");
  assert.ok(17 > ROE.COLD_REOPEN_DAYS);
  assert.equal(claimState(leads()[2], nowIso).state, "going_cold");
  assert.ok(ROE.COLD_REOPEN_DAYS - 13 <= ROE.WARN_DAYS_BEFORE);
  assert.ok(CLAIM_BUCKETS.some((b) => b.label.includes(String(ROE.COLD_REOPEN_DAYS))));
});

t("the missing-first-contact list is named, worst first, in claimState's own words", () => {
  const o = overview();
  assert.deepEqual(o.atRisk.map((r) => r.id), ["l6", "l1"]);
  assert.equal(o.atRisk[0].state, "claim_expired");
  assert.equal(o.atRisk[0].label, "Ida Late (Late Roofing)");
  const nowIso = new Date(NOW).toISOString();
  assert.equal(o.atRisk[0].why, claimState(leads()[5], nowIso).why);
});

t("who has gone quiet is named, worst first", () => {
  const o = overview();
  assert.deepEqual(o.quiet.map((r) => r.id), ["l2", "l3"]);
  assert.equal(o.quiet[0].state, "cold");
});

t("a lead somebody else owns is in none of the rep's lists", () => {
  const o = overview();
  const ids = [...o.atRisk, ...o.quiet].map((r) => r.id);
  assert.ok(!ids.includes("l8"));
  assert.ok(!ids.includes("l7"), "an unclaimed lead is nobody's claim");
});

t("won, lost, skipped and bad-contact leads are finished with", () => {
  const o = overview();
  assert.equal(o.stages.reduce((a, s) => a + s.count, 0), o.owned);
  for (const s of o.stages) assert.ok(isOpenStage(s.stage), `${s.stage} is closed`);
  assert.ok(!o.stages.some((s) => ["won", "skip_90"].includes(s.stage)));
});

t("the stage breakdown sums to the open total and is biggest first", () => {
  const o = overview();
  assert.deepEqual(o.stages, [
    { stage: "contacted", count: 2 },
    { stage: "follow_up", count: 1 },
    { stage: "in_conversation", count: 1 },
    { stage: "new", count: 1 },
    { stage: "researching", count: 1 },
  ]);
});

t("claimed with nobody contacted yet is counted", () => {
  assert.equal(overview().neverContacted, 3);
});

t("open reminders are the rep's own and exclude the ticked-off one", () => {
  assert.equal(overview().remindersOpen, 2);
});

/* ------------------------------------------------------------------ */
/* 5. Why somebody is owed a touch                                     */
/* ------------------------------------------------------------------ */

t("the reasons add up to the People-to-contact list they came from", () => {
  const o = overview();
  assert.equal(o.owed, 4);
  assert.equal(o.owedWhy.reduce((a, r) => a + r.count, 0), o.owed);
});

t("each reason is counted once, and only reasons with somebody in them show", () => {
  const o = overview();
  assert.deepEqual(o.owedWhy.map((r) => `${r.key}:${r.count}`),
    ["followup_late:1", "followup_today:1", "never_contacted:1", "gone_quiet:1"]);
  assert.equal(OWED_REASONS.length, 4);
});

t("a follow-up at 10pm tonight in Chicago is due TODAY, in every timezone", () => {
  /* The bug this stops: raw local-time day maths puts the same row in "late" for
   * a browser in New York at 00:30 and "due today" in Los Angeles at 22:00. */
  const today = teamDate(NOW);
  const tenTonight = teamDayEndOf(today) - 2 * 3600000;
  assert.equal(whyOwed({ follow_ms: tenTonight, last_touch: "2026-08-20T14:00:00Z" }, NOW), "followup_today");
  assert.equal(whyOwed({ follow_ms: teamDayStartOf(today) - 1, last_touch: "2026-08-20T14:00:00Z" }, NOW), "followup_late");
});

t("no follow-up date and no touch ever is 'never contacted'", () => {
  assert.equal(whyOwed({ follow_ms: null, last_touch: null }, NOW), "never_contacted");
});

/* ------------------------------------------------------------------ */
/* 6. A read that failed is null, never 0                              */
/* ------------------------------------------------------------------ */

t("leads that could not be read give null counts, not zeros", () => {
  const o = buildRepOverview({ userId: ME, leads: null, contactable: contactable(), reminders: reminders(), nowMs: NOW });
  assert.equal(o.owned, null);
  assert.equal(o.floor, null);
  assert.equal(o.buckets, null);
  assert.equal(o.atRisk, null);
  assert.equal(o.quiet, null);
  assert.equal(o.stages, null);
  assert.equal(o.neverContacted, null);
  assert.ok(o.unreadable.includes("your leads"));
  // and the half that still read is still counted
  assert.equal(o.owed, 4);
});

t("a failed contactable read is null while the leads still count", () => {
  const o = buildRepOverview({ userId: ME, leads: leads(), contactable: null, reminders: reminders(), nowMs: NOW });
  assert.equal(o.owed, null);
  assert.equal(o.owedWhy, null);
  assert.equal(o.owned, 6);
  assert.ok(o.unreadable.includes("who is owed a touch"));
});

t("a failed reminders read is null, not 'no reminders'", () => {
  const o = buildRepOverview({ userId: ME, leads: leads(), contactable: contactable(), reminders: null, nowMs: NOW });
  assert.equal(o.remindersOpen, null);
  assert.ok(o.unreadable.includes("your reminders"));
});

t("every read failing leaves nothing claiming to be zero", () => {
  const o = buildRepOverview({ userId: ME, leads: null, contactable: null, reminders: null, nowMs: NOW });
  for (const [k, v] of Object.entries(o)) {
    if (k === "unreadable" || k === "knowsWho") continue;
    assert.equal(v, null, `${k} should be unknown, not ${v}`);
  }
  assert.equal(o.unreadable.length, 3);
});

t("NO USER ID MEANS NO NUMBERS — never everybody's", () => {
  /* getMyWork's `mine()` filter passes every row in the system when the id is
   * falsy, so a missing id would print another rep's pipeline as yours. */
  const o = buildRepOverview({ userId: null, leads: leads(), contactable: contactable(), reminders: reminders(), nowMs: NOW });
  assert.equal(o.knowsWho, false);
  assert.equal(o.owned, null);
  assert.equal(o.buckets, null);
  assert.equal(o.owed, null);
  assert.deepEqual(o.unreadable, ["who you are signed in as"]);
});

t("nothing outside the rep's own scope reaches the numbers", () => {
  const text = JSON.stringify(overview());
  for (const leak of ["SECRET-NOTE-ON-A-LEAD", "450000", "amount_cents", "OTHER-REP-FOLLOW-UP", "Nina Co", "Won Co"]) {
    assert.ok(!text.includes(leak), `${leak} reached the rep's numbers`);
  }
});

t("the numbers carry no money field at all", () => {
  const text = JSON.stringify(overview()).toLowerCase();
  for (const word of ["cents", "revenue", "invoice", "price", "amount"]) {
    assert.ok(!text.includes(word), `${word} is in a rep's numbers`);
  }
});

/* ------------------------------------------------------------------ */
/* 7. What a counted answer is allowed to SAY it was — Aug 26 2026      */
/* ------------------------------------------------------------------ */

/* `counted_only` is one flag over three different stories, and the panel used to
 * tell the same one for all three: "the written draft was thrown away". In
 * preview mode that printed a thrown-away draft above a reason saying nothing was
 * ever sent. These pin each branch to words that are true for it. */

const COUNTED_KINDS = ["not_sent", "no_draft", "draft_failed", "unrecorded"];

t("preview says outright that nothing was sent, so no draft existed", () => {
  const r = previewAnswer().report;
  assert.equal(r.counted_cause, "not_sent");
  const c = countedOnlyCause(r);
  assert.equal(c.kind, "not_sent");
  assert.ok(/no draft was ever written/i.test(c.lead));
  assert.ok(!/thrown away/i.test(c.lead), "preview must not claim a draft was thrown away");
  assert.ok(!/thrown away/i.test(c.short), "and neither must the toast");
});

t("the endpoint's no-key sentence reads as nothing sent, not as a lost draft", () => {
  const c = countedOnlyCause({
    counted_only: true,
    gate_reason: "there is no ANTHROPIC_API_KEY set, so nothing could be written",
  });
  assert.equal(c.kind, "not_sent");
  assert.ok(!/thrown away/i.test(c.lead));
});

t("a model that errored means no draft ever came back", () => {
  const c = countedOnlyCause({
    counted_only: true,
    gate_reason: "the AI did not answer: 503 overloaded",
  });
  assert.equal(c.kind, "no_draft");
  assert.ok(/nothing usable came back/i.test(c.lead));
  assert.ok(!/thrown away/i.test(c.lead));
});

t("a draft that failed the gate is the one case that says thrown away", () => {
  for (const why of [
    "it printed a number the records do not contain",
    "the answer stopped part way through, so it would have been half a story",
    "it did not come back in the shape we asked for",
  ]) {
    const c = countedOnlyCause({ counted_only: true, gate_reason: why });
    assert.equal(c.kind, "draft_failed", why);
    assert.ok(/failed the checks/i.test(c.lead));
    assert.ok(/thrown away/i.test(c.lead));
    assert.equal(c.reason, why);
  }
});

t("no reason recorded is a fourth answer, not a guess", () => {
  const c = countedOnlyCause({ counted_only: true, gate_reason: null });
  assert.equal(c.kind, "unrecorded");
  assert.equal(c.reason, null);
  assert.ok(/nothing recorded/i.test(c.lead));
  assert.ok(!/thrown away/i.test(c.lead));
});

t("the cause field wins over the sentence the moment the endpoint sends one", () => {
  const c = countedOnlyCause({
    counted_only: true, counted_cause: "no_draft",
    gate_reason: "some wording nobody has written yet",
  });
  assert.equal(c.kind, "no_draft");
  // and a nonsense value is ignored rather than trusted
  assert.equal(countedOnlyCause({ counted_only: true, counted_cause: "banana", gate_reason: "x" }).kind, "draft_failed");
});

t("every branch still says the words are not an AI's, and none of them is a code", () => {
  const cases = [
    { gate_reason: "this is preview mode, so nothing was sent to an AI" },
    { gate_reason: "the AI did not answer: timed out" },
    { gate_reason: "it named a firm that is not in the records" },
    { gate_reason: "" },
  ];
  for (const r of cases) {
    const c = countedOnlyCause(r);
    assert.ok(c.lead.length > 40, "the panel needs a sentence");
    assert.ok(c.short.length > 10, "the toast needs a sentence");
    assert.ok(!/[A-Z_]{4,}/.test(c.lead), "plain words only");
    assert.ok(COUNTED_KINDS.includes(c.kind), c.kind);
  }
});

/* ------------------------------------------------------------------ */
/* 8. A rule is not a figure                                           */
/* ------------------------------------------------------------------ */

t("the house rules are not in the figures grid", () => {
  const { figures, rules } = splitCountedFigures(previewAnswer().report.facts.counts);
  const figureKeys = figures.map((f) => f.key);
  for (const k of Object.keys(RULE_SENTENCES)) {
    assert.ok(!figureKeys.includes(k), `${k} is a rule and must not read as a counted figure`);
    assert.ok(rules.some((r) => r.key === k), `${k} must still be shown, as a rule`);
  }
  // the counts about this rep are all still there
  assert.ok(figureKeys.includes("myLeadsOpen"));
  assert.ok(figureKeys.includes("myLeadsCold"));
  assert.ok(figures.length > 10);
});

t("each rule is a sentence carrying its own value", () => {
  const { rules } = splitCountedFigures(previewAnswer().report.facts.counts);
  for (const r of rules) {
    assert.ok(r.sentence.includes(String(r.value)), `${r.key} lost its number`);
    assert.ok(/\.$/.test(r.sentence), `${r.key} is not a sentence`);
  }
});

t("a count nobody has classified stays a figure, which is the safe way round", () => {
  const { figures, rules } = splitCountedFigures({ somethingNew: 4, coldAfterDays: 14 });
  assert.deepEqual(figures, [{ key: "somethingNew", value: 4 }]);
  assert.equal(rules.length, 1);
  assert.deepEqual(splitCountedFigures(null), { figures: [], rules: [] });
});

/* ------------------------------------------------------------------ */
/* 9. The counted answer is dated with the TEAM's day                  */
/* ------------------------------------------------------------------ */

t("02:30 UTC is still the previous day for the team, and that is the date used", () => {
  /* 02:30 UTC on the 27th is 21:30 on the 26th in Chicago. Raw
   * toISOString().slice(0,10) gave 2026-08-27 and titled the answer with
   * tomorrow. */
  const lateEvening = Date.parse("2026-08-27T02:30:00Z");
  assert.equal(answerDay(lateEvening), "2026-08-26");
  assert.notEqual(answerDay(lateEvening), new Date(lateEvening).toISOString().slice(0, 10));
});

t("mid-afternoon Central and UTC agree, so the fix moved nothing else", () => {
  assert.equal(answerDay(NOW), "2026-08-26");
  assert.equal(answerDay(NOW), teamDate(NOW));
});

/* ------------------------------------------------------------------ */
/* 10. Labels say what is actually counted                             */
/* ------------------------------------------------------------------ */

t("no follow-up label claims the rep set it themselves", () => {
  /* admin_reminders has owner_id AND created_by, and an owner can set a
   * follow-up FOR a rep, so "reminders you set yourself" was counting somebody
   * else's typing. */
  for (const r of OWED_REASONS) {
    assert.ok(!/you set/i.test(r.label), `${r.key}: ${r.label}`);
  }
});

t("the two missing-first-contact states are the ones in that list, and cold is not", () => {
  /* The panel is titled "No first contact logged, and the clock is up" — this is
   * the assertion that the title and the contents cannot drift apart, and that
   * the list does not double up with "Gone quiet" beside it. */
  const o = overview();
  for (const r of o.atRisk) {
    assert.ok(["claim_expired", "first_contact_due"].includes(r.state), r.state);
  }
  const quietIds = o.quiet.map((r) => r.id);
  for (const r of o.atRisk) assert.ok(!quietIds.includes(r.id), "a firm must not be in both lists");
});

console.log(`\n  ${passed} passed, ${failed} failed  (TZ=${TZ})`);
if (failed) process.exit(1);
