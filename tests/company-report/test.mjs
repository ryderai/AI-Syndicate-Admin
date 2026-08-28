/* Tests for the firm scan — api/sales-score.js, Aug 27 2026.
 *
 * Run with:  bash tests/company-report/run.sh
 *        or: node tests/company-report/test.mjs
 *
 * No database, no key, no network, no browser. Everything under test is pure,
 * and nothing of ours is mocked — the readers, the score-column rule, the
 * baseline rule, the row lock and the timeline wording are all exported from
 * the endpoint itself and called directly.
 *
 * THE ONE THING THIS SUITE IS REALLY FOR.
 * A null is not a zero. A firm shown as 0 for AI Access reads as the worst
 * website anybody has ever measured — the widest possible gap, and therefore
 * the hardest a rep goes in. It is the most dangerous wrong number this feature
 * can produce, and every falsy check in JavaScript wants to produce it:
 * `Number("")` is 0, `Number(null)` is 0, `Number([])` is 0, `Number(true)` is
 * 1, and `score || null` swallows a real, measured zero. So the pair of tests
 * that matter most are these two, together:
 *   * a measured 0 is STORED as 0
 *   * a missing score is STORED as null
 * Either one alone can be passed by a broken reader. Both cannot.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  readScore, readAiAccess, readSeo, readPromptSim, readFindings, readReport,
  effectiveScore, reportKind, leadBelongs, looksLikeId, parkableLeadIds, scoreLine,
  cleanDomain, scoreReady,
} from "../../api/sales-score.js";
import { ROE } from "../../lib/sales-rules.js";
import { readCompanyReport } from "../../src/lib/salesSheet.js";

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const SRC = readFileSync(new URL("../../api/sales-score.js", import.meta.url), "utf8");

/** The file with its comments taken out.
 *
 *  Prose about a rule is not the same as code obeying it. The comments in that
 *  file name the fields they exist to warn about — `body.domain` among them —
 *  so a test that greps the whole file for a field name reads the warning and
 *  calls it the bug. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** A full, healthy platform answer. Everything else in this file is this shape
 *  with a hole knocked in it. */
const FULL = {
  ai_access_score: 41,
  seo_score: 64,
  prompt_sim_hits: 2,
  prompt_sim_total: 10,
  findings: [
    { title: "No schema on the homepage", detail: "Nothing tells an AI what the firm sells.", severity: "high" },
    { title: "No llms.txt", detail: "There is no file for an AI crawler to read.", severity: "medium" },
  ],
};

console.log("\n=== The firm scan ===");

/* ================================================================== */
/* 1. ALL THREE NUMBERS                                                */
/* ================================================================== */

t("a full answer reads all three numbers and both findings", () => {
  const r = readReport(FULL);
  assert.equal(r.aiAccess, 41);
  assert.equal(r.seo, 64);
  assert.equal(r.simHits, 2);
  assert.equal(r.simTotal, 10);
  assert.equal(r.findings.length, 2);
  assert.equal(r.droppedFindings, 0);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.notes, []);
  assert.equal(r.readable, true);
});

t("each number is read independently — one missing does not take the others", () => {
  const r = readReport({ ...FULL, seo_score: undefined });
  assert.equal(r.aiAccess, 41);
  assert.equal(r.seo, null, "and the missing one is NULL, not zero");
  assert.equal(r.simHits, 2);
  assert.deepEqual(r.missing, ["SEO"]);
  assert.equal(r.readable, true, "some of it readable still saves a row");
});

t("the names are read forgivingly — camelCase, nested, and the old shape", () => {
  assert.equal(readAiAccess({ aiAccessScore: 55 }), 55);
  assert.equal(readAiAccess({ scores: { ai_access: 55 } }), 55);
  assert.equal(readAiAccess({ result: { ai_access_score: 55 } }), 55);
  assert.equal(readAiAccess({ score: 55 }), 55, "the shape this endpoint shipped with");
  assert.equal(readAiAccess({ overall: 55 }), 55);
  assert.equal(readSeo({ seoScore: 30 }), 30);
  assert.equal(readSeo({ seo: { score: 30 } }), 30);
  assert.equal(readSeo({ data: { seo_score: 30 } }), 30);
});

t("the specific name beats the generic one", () => {
  // A payload carrying both means the one that says what it is. Reading
  // `score` first would have filed the overall number as AI Access.
  assert.equal(readAiAccess({ ai_access_score: 41, score: 88 }), 41);
});

t("readScore still exists and still means AI Access", () => {
  // Kept exported and kept meaning the same thing: it is the name the rest of
  // the repo and every earlier test already know.
  assert.equal(readScore({ ai_access_score: 41 }), 41);
  assert.equal(readScore({ score: 41 }), 41);
  assert.equal(readScore({}), null);
});

/* ================================================================== */
/* 2. ZERO IS A SCORE. MISSING IS NOT ZERO.                            */
/* ================================================================== */

t("a measured 0 is stored as 0 — never swallowed by a falsy check", () => {
  const r = readReport({ ...FULL, ai_access_score: 0 });
  assert.equal(r.aiAccess, 0);
  assert.notEqual(r.aiAccess, null, "0 is a real measurement: the site is invisible");
  assert.equal(r.missing.includes("AI Access"), false, "so it is not reported as missing");
  assert.equal(effectiveScore(r).score, 0, "and it is the number that goes in the column");
});

t("a MISSING score is stored as null — never turned into 0", () => {
  // The key absent altogether, and the four ways it can be present and empty.
  const gone = { seo_score: 64, prompt_sim_hits: 2, prompt_sim_total: 10 };
  assert.equal(readReport(gone).aiAccess, null, "the key is not there at all");
  for (const hole of [null, undefined, "", "   "]) {
    const r = readReport({ ...gone, ai_access_score: hole });
    assert.equal(r.aiAccess, null, `ai_access_score of ${JSON.stringify(hole)} must read as null`);
    assert.ok(r.missing.includes("AI Access"), "and it is named as missing");
  }
});

t("and the two really are different, all the way to the browser's reader", () => {
  // The round trip that matters: what this endpoint writes is what
  // readCompanyReport() in the browser reads back off the row.
  const zero = readCompanyReport({ ai_access_score: readReport({ ai_access_score: 0 }).aiAccess });
  const missing = readCompanyReport({ ai_access_score: readReport({ seo_score: 64 }).aiAccess });
  assert.equal(zero.aiAccess, 0);
  assert.equal(missing.aiAccess, null);
});

/* ================================================================== */
/* 3. THE VALUE IS READ STRICTLY                                       */
/* ================================================================== */

t('"", null, "abc", -5, 150 are not scores; 0, 100 and "87" are', () => {
  assert.equal(readAiAccess({ ai_access_score: "" }), null);
  assert.equal(readAiAccess({ ai_access_score: null }), null);
  assert.equal(readAiAccess({ ai_access_score: "abc" }), null);
  assert.equal(readAiAccess({ ai_access_score: -5 }), null, "not clamped to 0");
  assert.equal(readAiAccess({ ai_access_score: 150 }), null, "not clamped to 100");
  assert.equal(readAiAccess({ ai_access_score: NaN }), null);
  assert.equal(readAiAccess({ ai_access_score: Infinity }), null);
  assert.equal(readAiAccess({ ai_access_score: 0 }), 0);
  assert.equal(readAiAccess({ ai_access_score: 100 }), 100);
  assert.equal(readAiAccess({ ai_access_score: "87" }), 87, "a numeric string is a number");
  assert.equal(readAiAccess({ ai_access_score: " 87 " }), 87);
});

t("an empty array and a true are not scores of 0 and 1", () => {
  // `Number([])` is 0 and `Number(true)` is 1. Without the typeof guard a
  // payload of {"score": []} scored a firm ZERO and it was quotable.
  assert.equal(readAiAccess({ ai_access_score: [] }), null);
  assert.equal(readAiAccess({ ai_access_score: [5] }), null);
  assert.equal(readAiAccess({ ai_access_score: true }), null);
  assert.equal(readAiAccess({ ai_access_score: {} }), null);
  assert.equal(readSeo({ seo_score: [] }), null);
});

t("a decimal is rounded to the column's precision, not refused", () => {
  // 87.6 really was measured. Rounding says the same fact at the precision the
  // int column holds — which is a different thing from clamping, where the
  // number that comes out was never measured at all.
  assert.equal(readAiAccess({ ai_access_score: 87.6 }), 88);
  assert.equal(readAiAccess({ ai_access_score: 0.4 }), 0);
});

t("a bad value falls through to the next candidate rather than poisoning the read", () => {
  assert.equal(readAiAccess({ ai_access_score: "n/a", score: 62 }), 62);
});

/* ================================================================== */
/* 4. BUYER QUESTIONS — BOTH HALVES OR NEITHER                         */
/* ================================================================== */

t("both halves read together", () => {
  const r = readPromptSim({ prompt_sim_hits: 2, prompt_sim_total: 10 });
  assert.equal(r.hits, 2);
  assert.equal(r.total, 10);
  assert.equal(r.why, null);
});

t("0 of 10 is a real measurement and survives", () => {
  // "Named in none of ten buyer questions" is the strongest line a rep has.
  const r = readPromptSim({ prompt_sim_hits: 0, prompt_sim_total: 10 });
  assert.equal(r.hits, 0);
  assert.equal(r.total, 10);
});

t("hits with no total is refused whole, and says so", () => {
  const r = readPromptSim({ prompt_sim_hits: 2 });
  assert.equal(r.hits, null);
  assert.equal(r.total, null);
  assert.ok(r.why && r.why.includes("out of how many"), "the response has to be able to say what went missing");
});

t("total with no hits is refused whole, and says so", () => {
  const r = readPromptSim({ prompt_sim_total: 10 });
  assert.equal(r.hits, null);
  assert.equal(r.total, null);
  assert.ok(r.why);
});

t("hits bigger than total is refused, not clamped", () => {
  // Clamping would print a confident 10 of 10 on a firm that is invisible.
  const r = readPromptSim({ prompt_sim_hits: 11, prompt_sim_total: 10 });
  assert.equal(r.hits, null);
  assert.equal(r.total, null);
  assert.ok(r.why && r.why.includes("cannot be right"));
});

t("a total of 0 is not a sample", () => {
  // 0 of 0 is not a measurement, and it is a divide by zero waiting on screen.
  const r = readPromptSim({ prompt_sim_hits: 0, prompt_sim_total: 0 });
  assert.equal(r.hits, null);
  assert.equal(r.total, null);
});

t("negative hits are refused", () => {
  assert.equal(readPromptSim({ prompt_sim_hits: -1, prompt_sim_total: 10 }).hits, null);
});

t("a big sample is a bigger sample, not a broken one", () => {
  const r = readPromptSim({ prompt_sim_hits: 40, prompt_sim_total: 250 });
  assert.equal(r.hits, 40);
  assert.equal(r.total, 250);
});

t("neither half present is quiet — there is nothing to report", () => {
  const r = readPromptSim({});
  assert.equal(r.hits, null);
  assert.equal(r.why, null, "a scan that does not do buyer questions is not a fault");
});

t("a refused pair reaches the response as a problem, not as silence", () => {
  const r = readReport({ ai_access_score: 41, prompt_sim_hits: 2 });
  assert.equal(r.simHits, null);
  assert.equal(r.notes.length, 1);
  assert.ok(r.missing.includes("buyer questions"));
});

/* ================================================================== */
/* 5. FINDINGS                                                         */
/* ================================================================== */

t("anything that is not an array becomes an empty list", () => {
  for (const junk of ["three things", 7, true, { title: "one" }]) {
    const r = readFindings({ findings: junk });
    assert.deepEqual(r.findings, [], `${JSON.stringify(junk)} is not a list of findings`);
    assert.ok(r.why, "and it is reported rather than passed over");
  }
});

t("no findings at all is not a fault", () => {
  const r = readFindings({});
  assert.deepEqual(r.findings, []);
  assert.equal(r.why, null);
});

t("a junk member is dropped and COUNTED", () => {
  // "We found 4 things" printed over a list of 3 is a small lie a prospect
  // notices, and silence about a dropped row lets a broken field name live for
  // a month.
  const r = readFindings({ findings: [
    { title: "No schema", detail: "d", severity: "high" },
    "just a string",
    null,
    42,
    ["nested"],
  ] });
  assert.equal(r.findings.length, 1);
  assert.equal(r.dropped, 4);
  assert.ok(r.why && r.why.includes("4"));
});

t("a finding with nothing to read is dropped too", () => {
  const r = readFindings({ findings: [{}, { severity: "high" }, { title: "Real one" }] });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].title, "Real one");
  assert.equal(r.dropped, 2, "a blank bullet in a pitch reads as carelessness");
});

t("a finding keeps its three parts and nothing else", () => {
  const r = readFindings({ findings: [{ title: " A ", description: " B ", level: "high", secret: "x" }] });
  assert.deepEqual(r.findings[0], { title: "A", detail: "B", severity: "high" });
});

t("findings are read from the other names too", () => {
  assert.equal(readFindings({ issues: [{ title: "x" }] }).findings.length, 1);
  assert.equal(readFindings({ result: { findings: [{ title: "x" }] } }).findings.length, 1);
});

/* ================================================================== */
/* 6. NOTHING READABLE SAVES NOTHING                                   */
/* ================================================================== */

t("an empty answer, an error answer and a page of HTML are all unreadable", () => {
  for (const nothing of [{}, null, undefined, { error: "scan failed" }, { html: "<!doctype html>" }, []]) {
    const r = readReport(nothing);
    assert.equal(r.readable, false, `${JSON.stringify(nothing)} must be unreadable`);
    assert.equal(r.aiAccess, null);
    assert.equal(r.seo, null);
    assert.equal(r.simHits, null);
  }
});

t("findings on their own do not make a measurement", () => {
  // This is the score endpoint. A row holding three nulls and a list of
  // complaints draws on screen as a measurement without being one.
  const r = readReport({ findings: [{ title: "No schema", detail: "d" }] });
  assert.equal(r.readable, false);
  assert.equal(r.findings.length, 1, "they are still read, so the refusal can say what was thrown away");
});

t("any ONE of the three numbers is enough to save a row", () => {
  assert.equal(readReport({ ai_access_score: 41 }).readable, true);
  assert.equal(readReport({ seo_score: 41 }).readable, true);
  assert.equal(readReport({ prompt_sim_hits: 0, prompt_sim_total: 8 }).readable, true);
});

t("the endpoint refuses BEFORE it writes anything", () => {
  // The guard is worth nothing if a later edit moves a write above it. Read in
  // the source: the unreadable branch returns 502 before the first insert.
  const guard = SRC.indexOf("if (!read.readable)");
  const firstInsert = SRC.indexOf(".insert(");
  assert.ok(guard > 0, "the guard is still there");
  assert.ok(firstInsert > guard, "nothing is written above the refusal");
  const branch = SRC.slice(guard, guard + 1400);
  assert.ok(branch.includes("res.status(502)"), "and it is a 502");
  assert.ok(branch.includes("Nothing was saved"), "and it says so in plain words");
});

t("with no PLATFORM_SCORE_URL the endpoint is not ready", () => {
  const had = process.env.PLATFORM_SCORE_URL;
  delete process.env.PLATFORM_SCORE_URL;
  assert.equal(scoreReady(), false);
  process.env.PLATFORM_SCORE_URL = "https://example.com/scan";
  assert.equal(scoreReady(), true);
  if (had === undefined) delete process.env.PLATFORM_SCORE_URL; else process.env.PLATFORM_SCORE_URL = had;
});

t("the 503 names the variable and the request never names the domain", () => {
  assert.ok(SRC.includes("waitingOnKey: KEY_NAME"), "the screen has to be able to say which key");
  // Prose about it is not the same as code doing it: the check is that NOTHING
  // is ever read out of the request body except the two ids.
  const readsFromBody = CODE.match(/body\??\.[a-zA-Z_]+/g) || [];
  assert.deepEqual([...new Set(readsFromBody)].sort(), ["body?.companyId", "body?.leadId"],
    "a domain posted in the request is still ignored — the request may only name WHICH firm");
  assert.ok(SRC.includes("cleanDomain(company.domain)"), "the domain comes off our own record");
});

/* ================================================================== */
/* 7. THE FIRM'S SCORE COLUMN                                          */
/* ================================================================== */

t("the column takes AI Access first, then SEO", () => {
  assert.deepEqual(effectiveScore({ aiAccess: 41, seo: 64 }), { score: 41, from: "AI Access" });
  assert.deepEqual(effectiveScore({ aiAccess: null, seo: 64 }), { score: 64, from: "SEO" });
});

t("a measured 0 wins over a real SEO score, because it was measured", () => {
  assert.equal(effectiveScore({ aiAccess: 0, seo: 64 }).score, 0);
});

t("both null leaves the column alone rather than emptying it", () => {
  const e = effectiveScore({ aiAccess: null, seo: null });
  assert.equal(e.score, null);
  assert.equal(e.from, null);
  assert.ok(SRC.includes("left exactly as it was rather than being emptied"),
    "and the response says so, so nobody thinks the number was refreshed");
});

t("the 90 gate reads the same number the column got", () => {
  // A firm showing 93 on screen with its contacts still in the pool is the bug
  // this ordering prevents.
  assert.ok(SRC.includes("eff.score >= ROE.SKIP_SCORE_AT_OR_ABOVE"));
  assert.equal(ROE.SKIP_SCORE_AT_OR_ABOVE, 90);
});

/* ================================================================== */
/* 8. BASELINE OR RE-SCAN                                              */
/* ================================================================== */

t("baseline only when the firm has no earlier report", () => {
  assert.equal(reportKind({ found: false }), "baseline");
  assert.equal(reportKind({ found: true }), "rescan");
  assert.equal(reportKind({}), "baseline");
});

t("a failed read defaults to rescan, never to baseline", () => {
  // Calling a re-scan the baseline relabels history: it makes today look like
  // the first time we ever measured this firm, which is the line a rep would
  // use out loud. The other way round is one wrong label and nothing else.
  assert.equal(reportKind({ failed: true }), "rescan");
  assert.equal(reportKind({ found: false, failed: true }), "rescan");
  assert.ok(SRC.includes("filed as a re-scan"), "and it is reported, not silent");
});

t("the browser reads the kind back off the row", () => {
  assert.equal(readCompanyReport({ kind: reportKind({ found: true }) }).kind, "rescan");
  assert.equal(readCompanyReport({ kind: reportKind({ found: false }) }).kind, "baseline");
});

/* ================================================================== */
/* 9. THE LEAD ID IS VERIFIED, NOT TRUSTED                             */
/* ================================================================== */

t("a lead at this firm is accepted", () => {
  assert.equal(leadBelongs({ id: "l1", company_id: "co1" }, "co1"), true);
});

t("a lead at ANOTHER firm is refused", () => {
  // An unrelated id would hang our reading of one firm's website off a
  // different person's record.
  assert.equal(leadBelongs({ id: "l9", company_id: "co2" }, "co1"), false);
});

t("a lead with no firm, a missing lead and a missing firm are all refused", () => {
  assert.equal(leadBelongs({ id: "l9", company_id: null }, "co1"), false);
  assert.equal(leadBelongs(null, "co1"), false);
  assert.equal(leadBelongs(undefined, "co1"), false);
  assert.equal(leadBelongs({ id: "l9", company_id: "co1" }, ""), false);
});

t("a junk id is a 400 in words, not a 500 full of Postgres", () => {
  // `invalid input syntax for type uuid: "co1"` went to the screen as a 500,
  // which reads as "the console is broken" when a caller sent a junk id.
  assert.equal(looksLikeId("6f1c2b6e-3a4d-4f2b-9c8a-1d2e3f4a5b6c"), true);
  assert.equal(looksLikeId("6F1C2B6E-3A4D-4F2B-9C8A-1D2E3F4A5B6C"), true, "case does not matter");
  for (const junk of ["co1", "", null, undefined, 7, "6f1c2b6e-3a4d-4f2b-9c8a", "; drop table"]) {
    assert.equal(looksLikeId(junk), false, `${JSON.stringify(junk)}`);
  }
  assert.ok(CODE.includes("looksLikeId(companyId)") && CODE.includes("looksLikeId(leadIdWanted)"),
    "both ids the request may name are checked");
});

t("it is checked before the platform is called, and it is a 400", () => {
  const check = SRC.indexOf("leadBelongs(askedLead, companyId)");
  const call = SRC.indexOf("await fetch(process.env[KEY_NAME]");
  assert.ok(check > 0 && call > check, "a bad id is a bug in the caller, not worth spending a scan on");
  assert.ok(SRC.slice(check, check + 400).includes("res.status(400)"));
});

/* ================================================================== */
/* 10. THE ROW LOCK ON THE SKIP                                        */
/* ================================================================== */

const FIRM_PEOPLE = [
  { id: "l1", owner_id: null },
  { id: "l2", owner_id: "rep-a" },
  { id: "l3", owner_id: "rep-b" },
];

t("an owner or admin may park every contact at the firm", () => {
  for (const role of ["owner", "admin"]) {
    const r = parkableLeadIds(FIRM_PEOPLE, { role, userId: "boss" });
    assert.deepEqual(r.allowed, ["l1", "l2", "l3"]);
    assert.deepEqual(r.blocked, []);
  }
});

t("a rep may park their own and the unclaimed ones only", () => {
  const r = parkableLeadIds(FIRM_PEOPLE, { role: "sales", userId: "rep-a" });
  assert.deepEqual(r.allowed, ["l1", "l2"]);
  assert.deepEqual(r.blocked, ["l3"], "another rep's row is left alone");
});

t("a rep with no id gets the unclaimed rows only", () => {
  // `undefined === undefined` matching every unowned row is the accident that
  // turns a lock into a doorway.
  const r = parkableLeadIds(FIRM_PEOPLE, { role: "sales" });
  assert.deepEqual(r.allowed, ["l1"]);
  assert.deepEqual(r.blocked, ["l2", "l3"]);
});

t("a role nobody has taught this file about keeps working", () => {
  // The same direction canEditLead() takes: written as "not sales" so a new
  // role does not silently lose the ability to do its job.
  assert.deepEqual(parkableLeadIds(FIRM_PEOPLE, { role: "ops", userId: "x" }).blocked, []);
});

t("no contacts, or a junk list, parks nothing and throws nothing", () => {
  assert.deepEqual(parkableLeadIds([], { role: "sales", userId: "rep-a" }).allowed, []);
  assert.deepEqual(parkableLeadIds(null, { role: "sales", userId: "rep-a" }).allowed, []);
});

t("what was left alone is reported, and only conversations that never started are parked", () => {
  assert.ok(SRC.includes("held by another rep"), "the rep has to be told what did not happen");
  assert.ok(SRC.includes('.in("stage", ["new", "researching"])'),
    "marking somebody Skip mid-conversation would throw away a live deal");
  assert.ok(SRC.includes("THE TIMELINE LINE IS NOT SCOPED"),
    "the trade-off between the two side effects is written down, not silently picked");
});

/* ================================================================== */
/* 11. THE WORDS ON THE TIMELINE                                       */
/* ================================================================== */

t("the line names all three numbers and the day they were read", () => {
  const s = scoreLine({
    domain: "summitroofing.com", aiAccess: 41, seo: 64, simHits: 2, simTotal: 10,
    measuredOn: "2026-08-27", findingCount: 2,
  });
  assert.ok(s.includes("summitroofing.com"));
  assert.ok(s.includes("AI Access 41/100"));
  assert.ok(s.includes("SEO 64/100"));
  assert.ok(s.includes("named in 2 of 10 buyer questions"));
  assert.ok(s.includes("2026-08-27"), "a number without the day it was read is not a measurement");
  assert.ok(s.includes("2 things to fix"));
});

t("a half that did not come back prints a dash, never a zero", () => {
  const s = scoreLine({ domain: "x.com", aiAccess: null, seo: 64, measuredOn: "2026-08-27" });
  assert.ok(s.includes("AI Access —"), s);
  assert.ok(!s.includes("AI Access 0"), "0 would read as the worst site anybody has measured");
  assert.ok(s.includes("buyer questions not measured (—)"));
});

t("a measured zero prints as a zero", () => {
  const s = scoreLine({ domain: "x.com", aiAccess: 0, seo: null, simHits: 0, simTotal: 12, measuredOn: "2026-08-27" });
  assert.ok(s.includes("AI Access 0/100"));
  assert.ok(s.includes("named in 0 of 12"));
  assert.ok(s.includes("SEO —"));
});

t("one finding is not '1 things'", () => {
  assert.ok(scoreLine({ domain: "x.com", measuredOn: "2026-08-27", findingCount: 1 }).includes("1 thing to fix"));
  assert.ok(!scoreLine({ domain: "x.com", measuredOn: "2026-08-27", findingCount: 0 }).includes("to fix"));
});

t("at 90 or above the line says to stop", () => {
  const s = scoreLine({ domain: "x.com", aiAccess: 93, measuredOn: "2026-08-27", skip: true });
  assert.ok(s.includes("not a prospect"));
  assert.ok(s.includes(String(ROE.SKIP_SCORE_AT_OR_ABOVE)));
});

t("the day on the line is the team's calendar day, not UTC", () => {
  // An ISO string is UTC, so `now.slice(0,10)` printed tomorrow's date on the
  // timeline from 7pm Central. This repo has shipped that bug three times.
  assert.ok(SRC.includes("teamDate("), "the day a person reads is in their own calendar");
  assert.ok(!SRC.includes("now.slice(0, 10)"), "and the UTC slice is gone");
  assert.ok(SRC.includes("measured_at: now"), "while the stored timestamp stays a full UTC one");
});

/* ================================================================== */
/* 12. THE DOMAIN                                                      */
/* ================================================================== */

t("a website is cleaned down to a bare hostname", () => {
  assert.equal(cleanDomain("https://www.Summit-Roofing.com/contact?x=1"), "summit-roofing.com");
  assert.equal(cleanDomain("summit.com."), "summit.com");
  assert.equal(cleanDomain(" SUMMIT.COM "), "summit.com");
});

t("something that is not a website is nothing", () => {
  for (const junk of ["", null, undefined, "summit", "two words.com", "  "]) {
    assert.equal(cleanDomain(junk), null, `${JSON.stringify(junk)}`);
  }
});

/* ================================================================== */
/* 13. WHAT THE BROWSER READS BACK                                     */
/* ================================================================== */

t("a full row written by this endpoint reads back whole in the browser", () => {
  const r = readReport(FULL);
  const back = readCompanyReport({
    id: "r1", kind: "baseline",
    ai_access_score: r.aiAccess, seo_score: r.seo,
    prompt_sim_hits: r.simHits, prompt_sim_total: r.simTotal,
    findings: r.findings, domain: "summit.com",
    measured_at: "2026-08-27T14:00:00Z", measured_by: "u1",
  });
  assert.equal(back.aiAccess, 41);
  assert.equal(back.seo, 64);
  assert.equal(back.simHits, 2);
  assert.equal(back.simTotal, 10);
  assert.equal(back.findings.length, 2);
  assert.equal(back.domain, "summit.com");
  assert.equal(back.measuredAt, "2026-08-27T14:00:00Z");
  assert.equal(back.measuredBy, "u1");
});

t("a half-empty row reads back half-empty, not half-zero", () => {
  const r = readReport({ seo_score: 64, prompt_sim_hits: 3 });
  const back = readCompanyReport({
    ai_access_score: r.aiAccess, seo_score: r.seo,
    prompt_sim_hits: r.simHits, prompt_sim_total: r.simTotal, findings: r.findings,
  });
  assert.equal(back.aiAccess, null);
  assert.equal(back.seo, 64);
  assert.equal(back.simHits, null);
  assert.equal(back.simTotal, null);
  assert.deepEqual(back.findings, []);
});

t("every number this endpoint can write passes the table's own CHECK", () => {
  // 0019 constrains both scores to 0-100, hits to >= 0 and total to > 0. A
  // reader that let anything else through would fail at the database with a
  // message nobody on screen could read.
  const shapes = [
    FULL, {}, { ai_access_score: -5 }, { ai_access_score: 150 }, { ai_access_score: "87" },
    { seo_score: 0 }, { prompt_sim_hits: 11, prompt_sim_total: 10 }, { prompt_sim_total: 0 },
    { ai_access_score: [] }, { ai_access_score: true },
  ];
  for (const s of shapes) {
    const r = readReport(s);
    for (const n of [r.aiAccess, r.seo]) {
      assert.ok(n === null || (Number.isInteger(n) && n >= 0 && n <= 100), `${JSON.stringify(s)} -> ${n}`);
    }
    assert.ok(r.simHits === null || (Number.isInteger(r.simHits) && r.simHits >= 0));
    assert.ok(r.simTotal === null || (Number.isInteger(r.simTotal) && r.simTotal > 0));
    assert.ok((r.simHits === null) === (r.simTotal === null), "both halves or neither");
    assert.ok(Array.isArray(r.findings));
  }
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
