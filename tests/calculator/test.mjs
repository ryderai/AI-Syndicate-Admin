/* Tests for the AI Revenue Calculator's console side — 24 Sep 2026.
 *   bash tests/calculator/run.sh
 * No database, no keys, no network. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CALC_INDUSTRIES, CALC_INDUSTRY_LABELS, cleanRun, cleanPath, leadNote, summarise, upliftShare, baseRevenue, median, mean,
} from "../../lib/calculator.js";

let passed = 0, failed = 0;
const out = [];
function test(name, fn) { try { fn(); passed += 1; out.push(`  ok   ${name}`); } catch (e) { failed += 1; out.push(`  FAIL ${name}\n       ${e.message}`); } }

const MIG = readFileSync(new URL("../../supabase/migrations/0040_revenue_calculator.sql", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
const good = () => ({
  run_key: "abc12345xyz", session_id: "s1", page_path: "/ai-revenue-calculator/roofers/", industry: "roofing",
  inputs: { leads: 40, close: 30, sale: 12000, aiShare: 30, score: 40, target: 80, revenue: 0, clients: 0, margin: 25, repeat: 0.2, spend: 0 },
  result: { addedRevenue: 299557, yearOneRevenue: 224668, addedProfit: 74889, lifetimeRevenue: 359468, extraLeadsYr: 83.2, extraClientsYr: 24.96, capped: false, warnings: 0, plan: "launch" },
  edited: true, device: "desktop", utm: { utm_source: "google" },
});

test("the industry list matches the 0040 check constraint exactly", () => {
  const m = /industry in \(([\s\S]*?)\)\)/.exec(MIG);
  assert.ok(m, "constraint not found");
  const inSql = [...m[1].matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...inSql].sort(), [...CALC_INDUSTRIES].sort());
  for (const k of CALC_INDUSTRIES) assert.ok(CALC_INDUSTRY_LABELS[k], `label for ${k}`);
});
test("a good run is cleaned field for field", () => {
  const r = cleanRun(good());
  assert.equal(r.ok, true);
  assert.equal(r.row.industry, "roofing"); assert.equal(r.row.leads_per_month, 40); assert.equal(r.row.close_rate, 30);
  assert.equal(r.row.added_revenue, 299557); assert.equal(r.row.plan_key, "launch"); assert.equal(r.row.utm_source, "google");
});
test("optional money typed as 0 is stored as null (not typed), never zero", () => {
  const r = cleanRun(good()).row;
  assert.equal(r.yearly_revenue, null); assert.equal(r.clients_per_year, null); assert.equal(r.ad_spend, null);
});
test("out-of-range numbers drop to null instead of refusing the row", () => {
  const b = good(); b.inputs.close = 150; b.inputs.score = -3; b.inputs.leads = "abc";
  const r = cleanRun(b).row;
  assert.equal(r.close_rate, null); assert.equal(r.ai_score, null); assert.equal(r.leads_per_month, null);
});
test("run key, page and industry are required", () => {
  assert.equal(cleanRun({ ...good(), run_key: "x" }).ok, false);
  assert.equal(cleanRun({ ...good(), page_path: "/pricing/" }).ok, false);
  assert.equal(cleanRun({ ...good(), industry: "casino" }).ok, false);
});
test("only our calculator pages are accepted as page_path; query strings are cut", () => {
  assert.equal(cleanPath("/ai-revenue-calculator/"), "/ai-revenue-calculator/");
  assert.equal(cleanPath("/ai-revenue-calculator/law-firms/?i=law"), "/ai-revenue-calculator/law-firms/");
  assert.equal(cleanPath("https://evil.com/ai-revenue-calculator/"), null);
  assert.equal(cleanPath("/ai-revenue-calculator/../admin/"), null);
});
test("the landing-page popup's pages are accepted too (24 Sep 2026), nothing else", () => {
  assert.equal(cleanPath("/home-services/"), "/home-services/");
  assert.equal(cleanPath("/home-services/lawn-care/?utm_source=fb"), "/home-services/lawn-care/");
  assert.equal(cleanPath("/home-management/"), "/home-management/");
  assert.equal(cleanPath("/home-services/checkout/"), null);
  assert.equal(cleanPath("/restaurants/"), null);
  assert.equal(cleanPath("/home-services/../admin/"), null);
  assert.equal(cleanPath("/home-services/lawn-care/extra/"), null);
});
test("a score only counts as measured when a scanned site came with it", () => {
  assert.equal(cleanRun({ ...good(), score_measured: true }).row.score_measured, false);
  const r = cleanRun({ ...good(), score_measured: true, scanned_domain: "https://www.Roof.com/about" }).row;
  assert.equal(r.score_measured, true); assert.equal(r.scanned_domain, "roof.com");
  assert.equal(cleanRun({ ...good(), scanned_domain: "roof.com" }).row.scanned_domain, null);
});
test("the lead note carries the numbers in plain words", () => {
  const n = leadNote(cleanRun(good()).row, "2026-09-24T12:00:00Z");
  assert.match(n, /^2026-09-24 · AI Revenue Calculator \(\/ai-revenue-calculator\/roofers\/\)/);
  assert.match(n, /\+\$299,557\/yr/); assert.match(n, /40 leads\/mo, 30% close, \$12,000 per client/); assert.match(n, /their guess/);
});
test("lift uses typed revenue, else leads × 12 × close × value", () => {
  assert.equal(baseRevenue({ leads_per_month: 40, close_rate: 30, client_value: 12000 }), 1728000);
  assert.equal(baseRevenue({ yearly_revenue: 1000000, leads_per_month: 40, close_rate: 30, client_value: 12000 }), 1000000);
  assert.ok(Math.abs(upliftShare({ leads_per_month: 40, close_rate: 30, client_value: 12000, added_revenue: 172800 }) - 0.1) < 1e-9);
  assert.equal(upliftShare({ added_revenue: 5 }), null);
});
test("averages use edited rows only; counts use every row", () => {
  const rows = [
    { edited: true, added_revenue: 100, leads_per_month: 10, close_rate: 10, client_value: 1000, industry: "law", lead_id: "L1" },
    { edited: true, added_revenue: 300, leads_per_month: 10, close_rate: 10, client_value: 1000, industry: "law" },
    { edited: false, added_revenue: 999999, leads_per_month: 30, close_rate: 25, client_value: 5000, industry: "other" },
  ];
  const s = summarise(rows);
  assert.equal(s.runs, 3); assert.equal(s.edited, 2); assert.equal(s.leads, 1);
  assert.equal(s.medianAdded, 200); assert.equal(s.meanAdded, 200);
  assert.equal(s.byIndustry[0].key, "law"); assert.equal(s.byIndustry[0].runs, 2);
  assert.equal(s.byIndustry.find((g) => g.key === "other").medianAdded, null);
});
test("empty input gives nulls, not zeros or NaN", () => {
  const s = summarise([]);
  assert.equal(s.runs, 0); assert.equal(s.medianAdded, null); assert.equal(s.leadRate, null); assert.equal(s.meanMeasuredScore, null);
  assert.equal(median([]), null); assert.equal(mean([NaN]), null);
});
test("api/calc.js never puts lead_id in the run upsert (a beacon must not unlink a lead)", () => {
  const src = readFileSync(new URL("../../api/calc.js", import.meta.url), "utf8");
  const up = src.slice(src.indexOf('.from("calc_runs").upsert('), src.indexOf('{ onConflict: "run_key" }'));
  assert.ok(up.length > 100); assert.ok(!/lead_id/.test(up));
});

test("a forged result above 25% of the business's year is dropped, and lift is clamped", () => {
  const b = good(); b.result.addedRevenue = 1e12;
  assert.equal(cleanRun(b).row.added_revenue, null);
  assert.equal(upliftShare({ leads_per_month: 0.001, close_rate: 1, client_value: 1, added_revenue: 1e12 }), 0.25);
});
test("blank values are not counted as $0 in medians", () => {
  const s = summarise([{ edited: true, added_revenue: null }, { edited: true, added_revenue: 100 }, { edited: true, added_revenue: 300 }]);
  assert.equal(s.medianAdded, 200);
});
test("people counts distinct leads, not runs", () => {
  assert.equal(summarise([{ lead_id: "a" }, { lead_id: "a" }, { lead_id: "b" }, {}]).people, 2);
});
test("api/calc.js writes the optional phone on insert and fills it only when blank", () => {
  const src = readFileSync(new URL("../../api/calc.js", import.meta.url), "utf8");
  assert.match(src, /phoneDigits\.length >= 10/);
  assert.match(src, /if \(isBlank\(existing\.phone\) && phone\) patch\.phone = phone;/);
  const ins = src.slice(src.indexOf('.from("admin_leads").insert({'), src.indexOf('}).select("id")'));
  assert.match(ins, /\bphone,/);
});

/* ---- PROOF OF CONSENT (25 Sep 2026, lib/lead-consent.js + 0045) ---- */
const { CONSENT_TEXTS, cleanConsent, consentNote, recordConsent } = await import("../../lib/lead-consent.js");
const POPUP = CONSENT_TEXTS["2026-09-24"];
test("consent: a known version is stored with OUR wording, and a match is recorded", () => {
  const c = cleanConsent({ version: "2026-09-24", text: POPUP, at: "2026-09-25T15:00:00.000Z" });
  assert.equal(c.text, POPUP); assert.equal(c.textMatches, true); assert.equal(c.capturedAt, "2026-09-25T15:00:00.000Z");
});
test("consent: forged wording is not stored as the person's words, and is flagged", () => {
  const c = cleanConsent({ version: "2026-09-24", text: "I agree to everything forever", at: "x" });
  assert.equal(c.text, POPUP); assert.equal(c.textMatches, false); assert.equal(c.capturedAt, null);
  assert.match(consentNote(c, "the lawn-care landing page", "2026-09-25T00:00:00Z"), /wording differed/);
});
test("consent: an unknown or missing version is not consent", () => {
  assert.equal(cleanConsent({ version: "1999-01-01", text: POPUP }), null);
  assert.equal(cleanConsent(null), null); assert.equal(cleanConsent("yes"), null);
});
test("consent: curly quotes and spacing from the page still count as the same wording", () => {
  const curly = POPUP.replace('"Show my number"', "\u201cShow my number\u201d").replace("services.", "services.  ");
  assert.equal(cleanConsent({ version: "2026-09-24", text: curly }).textMatches, true);
});
test("consent: the popup ships exactly the wording the console keeps (skipped where the landing-page folder is not beside this repo)", () => {
  let lp = null;
  try { lp = readFileSync(new URL("../../../Home-Services-LP/assets/calc-popup.js", import.meta.url), "utf8"); } catch { return; }
  assert.ok(lp.includes(POPUP), "calc-popup.js CONSENT text differs from CONSENT_TEXTS['2026-09-24']");
});
{ /* async, so run directly: the test() helper above is synchronous */
  const name = "consent: the row lands with the IP and browser, and a failed insert never throws";
  try {
    let row = null;
    const admin = { from: () => ({ insert: (r) => { row = r; return Promise.resolve({ error: null }); } }) };
    const req = { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "user-agent": "UA/1" } };
    const c = cleanConsent({ version: "2026-09-24", text: POPUP });
    assert.equal(await recordConsent(admin, req, "lead-1", c, { source: "hs-lead", pageSlug: "lawn-care" }), true);
    assert.equal(row.ip, "203.0.113.9"); assert.equal(row.user_agent, "UA/1"); assert.deepEqual(row.channels, ["call", "text", "email"]);
    assert.equal(row.consent_text, POPUP); assert.equal(row.lead_id, "lead-1"); assert.equal(row.source, "hs-lead");
    const bad = { from: () => ({ insert: () => Promise.resolve({ error: { message: "expected in this test: no table" } }) }) };
    assert.equal(await recordConsent(bad, req, "lead-1", c, { source: "calc" }), false);
    passed += 1; out.push(`  ok   ${name}`);
  } catch (e) { failed += 1; out.push(`  FAIL ${name}\n       ${e.message}`); }
}
test("consent: both endpoints clean it and record it after the lead exists", () => {
  for (const f of ["api/hs-lead.js", "api/calc.js"]) {
    const src = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
    assert.match(src, /cleanConsent\(b\.consent\)/, f);
    assert.ok(src.indexOf("recordConsent(admin, req, leadId") > src.indexOf("leadId = "), f + " records before the lead id exists");
  }
});
console.log(out.join("\n"));
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
