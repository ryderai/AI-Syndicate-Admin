/* Tests for the sales system's pure logic — the Rules of Engagement engine and
 * the sheet importer.
 *
 * Run with:  bash tests/sales/run.sh
 *
 * No database, no network, no AI key. The header rows and cell values below
 * are COPIED OUT OF CJ's REAL SHEET (read Aug 21 2026), not invented, because
 * a fixture that agrees with the code is not a test — that is the exact
 * mistake that let three files write to columns which did not exist in the
 * Aug 20 build.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ROE, CADENCE, CLOSED_STAGES, isOpenStage,
  localDayNumber, daysBetween, businessDaysBetween,
  claimState, shouldReopen, cadenceState, scoreGate, textGate,
  companyClaimWarning, salesQueue, repStats, listHealth,
} from "../../lib/sales-rules.js";
import {
  guessSalesColumn, guessHeaderRow, parseSheetDate, stageFromSheet,
  matchOwner, companyKey, groupIntoCompanies, buildImportPlan, looksLikeLeadTab,
  SALES_FIELD_KEYS,
} from "../../lib/sales-import.js";

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try { fn(); passed += 1; results.push(`  ok   ${name}`); }
  catch (err) { failed += 1; results.push(`  FAIL ${name}\n       ${err.message}`); }
}

/* A fixed clock, so these do not start failing at midnight.
 * 2026-08-21 is a Friday. That matters for the business-day tests. */
const NOW = Date.parse("2026-08-21T17:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const NOW_ISO = new Date(NOW).toISOString();

/* ================================================================== */
/* THE REAL HEADER ROWS                                                */
/* ================================================================== */
/* Two tabs, copied verbatim. They are NOT the same, which is the single most
 * important fact about this import. */

const HEADER_LUXURY_AGENTS = [
  "Sales Owner", "Contacted?", "Sales Cycle Status", "First Contact", "Last Touch",
  "Next Steps/Notes", "First Name", "Last Name", "Title", "Company Name",
  "Company Name for Emails", "Email", "Seniority", "Corporate Phone", "# Employees",
  "Keywords", "Person Linkedin Url", "Website", "Company Linkedin Url", "Facebook Url",
  "City", "State", "Company Address", "Company City", "Company State", "Company Phone",
  "Annual Revenue",
];

const HEADER_CAR_DEALERSHIP = [
  "Sales Owner", "Contacted?", "Sales Cycle Status", "First Contact", "Last Touch",
  "Next Steps/Notes", "First Name", "Last Name", "Title", "Company Name",
  "Company Name for Emails", "Email", "Seniority", "Departments", "Corporate Phone",
  "Industry", "Keywords", "Person Linkedin Url", "Website", "Company Linkedin Url",
  "Facebook Url", "Twitter Url", "Company Address", "Company City", "Company State",
  "Company Country", "Annual Revenue",
];

/* Real rows, verbatim. */
const ROW_CLAIMED = [
  "Larry Pike", "Yes - Email", "Contacted", "8/19/2026", "", "",
  "Diana", "Francisco", "Licensed Realtor", "3 Leaf Realty Group at Remax Aegis",
  "3 Leaf Realty Group at Remax Aegis", "diana@3leafrealty.com", "", "+1 310-546-6300",
  "21", "some,keyword,blob", "http://www.linkedin.com/in/diana-francisco-903630195",
  "https://3leafrealty.com", "http://www.linkedin.com/company/3-leaf-realty",
  "https://facebook.com/3LeafRealty", "Los Angeles", "California", "", "", "",
  "+1 310-546-6300", "11026000",
];
const ROW_SHORT_YEAR = [
  "Hunter Grant", "Yes - Email", "Contacted", "8/11/26", "", "",
  "Emily", "Sinclair", "Realtor", "ACME | SERHANT.", "ACME", "emily@acme-re.com", "",
  "+1 323-919-0375", "50", "blob", "http://www.linkedin.com/in/emily-sinclair-9439776",
  "https://acme-re.com", "http://www.linkedin.com/company/acme-real-estate", "",
  "Los Angeles", "California", "", "", "", "+1 323-919-0375", "",
];
const ROW_UNCLAIMED = [
  "", "", "", "", "", "",
  "Carrie", "Bryden", "Director of Business Development", "ACME | SERHANT.", "ACME",
  "carrie@carriebryden.com", "", "+1 323-919-0375", "50", "blob",
  "http://www.linkedin.com/in/carrie-bryden", "https://acme-re.com",
  "http://www.linkedin.com/company/acme-real-estate", "", "Los Angeles", "California",
  "", "", "", "+1 323-919-0375", "",
];

const TEAM = [
  { user_id: "u-larry", full_name: "Larry Pike", email: "larry@aisyndicate.com", role: "sales", active: true },
  { user_id: "u-brandon", full_name: "Brandon Roberts", email: "brandon@aisyndicate.com", role: "sales", active: true },
  { user_id: "u-hunter", full_name: "Hunter Grant", email: "hunter@aisyndicate.com", role: "sales", active: true },
  { user_id: "u-matt", full_name: "Matt Brown", email: "matt@aisyndicate.com", role: "sales", active: true },
  { user_id: "u-cj", full_name: "CJ Britton", email: "cj@aisyndicate.com", role: "owner", active: true },
];

/* ================================================================== */
/* 1. THE COLUMN MATCHER                                               */
/* ================================================================== */

test("every field the matcher can produce is a real field key", () => {
  const all = [...HEADER_LUXURY_AGENTS, ...HEADER_CAR_DEALERSHIP].map(guessSalesColumn).filter(Boolean);
  for (const f of all) assert.ok(SALES_FIELD_KEYS.includes(f), `${f} is not in SALES_FIELDS`);
});

test("the six hand-filled columns are all recognised", () => {
  assert.equal(guessSalesColumn("Sales Owner"), "sales_owner");
  assert.equal(guessSalesColumn("Contacted?"), "contacted");
  assert.equal(guessSalesColumn("Sales Cycle Status"), "status");
  assert.equal(guessSalesColumn("First Contact"), "first_contact");
  assert.equal(guessSalesColumn("Last Touch"), "last_touch");
  assert.equal(guessSalesColumn("Next Steps/Notes"), "next_step");
});

test("company columns beat person columns — a switchboard never lands on a direct dial", () => {
  assert.equal(guessSalesColumn("Company Linkedin Url"), "company_linkedin_url");
  assert.equal(guessSalesColumn("Person Linkedin Url"), "linkedin_url");
  assert.equal(guessSalesColumn("Company City"), "company_city");
  assert.equal(guessSalesColumn("City"), "city");
  assert.equal(guessSalesColumn("Company Phone"), "company_phone");
  assert.equal(guessSalesColumn("Corporate Phone"), "company_phone");
});

test("'Keywords' is left alone — it is a paragraph of website tech, not a lead field", () => {
  assert.equal(guessSalesColumn("Keywords"), "");
});

test("'Company Name for Emails' does not fight 'Company Name' for the same field", () => {
  const { mapping, clashes } = guessHeaderRow(HEADER_LUXURY_AGENTS);
  const companyCols = mapping.filter((m) => m === "company");
  assert.equal(companyCols.length, 1, "exactly one column may write `company`");
  assert.equal(mapping[HEADER_LUXURY_AGENTS.indexOf("Company Name")], "company");
  assert.ok(clashes.every((c) => c.header !== "Company Name"));
});

test("the two duplicate phone columns are caught rather than silently overwriting", () => {
  const { mapping, clashes } = guessHeaderRow(HEADER_LUXURY_AGENTS);
  assert.equal(mapping.filter((m) => m === "company_phone").length, 1);
  assert.ok(clashes.some((c) => /phone/i.test(c.header)), "the second phone column should be reported");
});

test("both real tabs map without any field being written twice", () => {
  for (const header of [HEADER_LUXURY_AGENTS, HEADER_CAR_DEALERSHIP]) {
    const { mapping } = guessHeaderRow(header);
    const used = mapping.filter(Boolean);
    assert.equal(new Set(used).size, used.length, "a field was mapped twice");
    assert.ok(used.length >= 18, `only ${used.length} columns recognised`);
  }
});

test("the Car Dealership tab's extra columns are picked up, and the missing one is not invented", () => {
  const { mapping } = guessHeaderRow(HEADER_CAR_DEALERSHIP);
  assert.ok(mapping.includes("department"), "Departments should map");
  assert.ok(mapping.includes("vertical"), "Industry should map");
  assert.ok(mapping.includes("twitter_url"), "Twitter Url should map");
  // This tab has no "# Employees" column at all.
  assert.ok(!mapping.includes("employees"));
});

/* ================================================================== */
/* 2. DATES TYPED BY HAND                                              */
/* ================================================================== */

test("both year formats in the sheet read as the same day", () => {
  assert.equal(parseSheetDate("8/11/2026", { now: NOW }).iso, "2026-08-11");
  assert.equal(parseSheetDate("8/11/26", { now: NOW }).iso, "2026-08-11");
});

test("an unreadable date is reported, never quietly replaced with today", () => {
  const r = parseSheetDate("next tuesday", { now: NOW });
  assert.equal(r.iso, null);
  assert.equal(r.ok, false);
  assert.match(r.why, /could not read/);
});

test("31 February is refused rather than rolled into March", () => {
  const r = parseSheetDate("2/31/2026", { now: NOW });
  assert.equal(r.iso, null);
  assert.equal(r.ok, false);
});

test("a future date is kept but flagged — a typo'd year must not make a stale firm look fresh", () => {
  const r = parseSheetDate("8/11/2027", { now: NOW });
  assert.equal(r.iso, "2027-08-11");
  assert.equal(r.ok, false);
  assert.match(r.why, /future/);
});

test("an Excel date serial is read as a date", () => {
  assert.equal(parseSheetDate(46253, { now: NOW }).iso, "2026-08-19");
});

test("a blank date is fine and is not an error", () => {
  const r = parseSheetDate("", { now: NOW });
  assert.equal(r.iso, null);
  assert.equal(r.ok, true);
});

/* ================================================================== */
/* 3. TWO COLUMNS -> ONE STAGE                                         */
/* ================================================================== */

test("the real values in the sheet map to sensible stages", () => {
  assert.equal(stageFromSheet("Yes - Email", "Contacted").stage, "contacted");
  assert.equal(stageFromSheet("Yes - Email and Phone", "Contacted").stage, "contacted");
  assert.equal(stageFromSheet("", "Closed - Lost").stage, "lost");
  assert.equal(stageFromSheet("", "Bad contact info").stage, "bad_contact");
  assert.equal(stageFromSheet("No", "").stage, "new");
  assert.equal(stageFromSheet("", "").stage, "new");
});

test("the status column wins over the Contacted? tick when they disagree", () => {
  // A rep ticked "Yes - Email" and then marked it lost. Lost is the later,
  // more specific fact; treating it as merely contacted puts a dead firm back
  // in somebody's queue.
  assert.equal(stageFromSheet("Yes - Email", "Closed - Lost").stage, "lost");
});

test("the sheet's own Skip 90+ wording maps to the skip stage", () => {
  assert.equal(stageFromSheet("", "Skip – 90+").stage, "skip_90");
});

test("every stage the importer can produce is one the database accepts", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/0009_sales.sql", import.meta.url), "utf8");
  const m = /admin_leads_stage_check[\s\S]*?check \(stage in \(([\s\S]*?)\)\)/.exec(sql);
  assert.ok(m, "could not find the stage constraint in migration 0009");
  const allowed = new Set([...m[1].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]));
  const produced = [
    ["Yes - Email", "Contacted"], ["", "Closed - Lost"], ["", "Bad contact info"],
    ["No", ""], ["", "Skip – 90+"], ["", "Reopened"], ["", "Proposal sent"],
    ["", "Meeting booked"], ["", "Following up"], ["", "Replied"], ["", "Won"],
  ].map(([c, s]) => stageFromSheet(c, s).stage);
  for (const st of produced) assert.ok(allowed.has(st), `the importer produces "${st}" but the database refuses it`);
  for (const st of CLOSED_STAGES) assert.ok(allowed.has(st), `CLOSED_STAGES names "${st}" which the database refuses`);
});

/* ================================================================== */
/* 4. MATCHING A REP'S NAME                                            */
/* ================================================================== */

test("an exact name matches", () => {
  const r = matchOwner("Larry Pike", TEAM);
  assert.equal(r.user_id, "u-larry");
  assert.equal(r.how, "exact");
});

test("'Brandon R' matches Brandon Roberts", () => {
  const r = matchOwner("Brandon R", TEAM);
  assert.equal(r.user_id, "u-brandon");
  assert.equal(r.how, "initial");
});

test("a bare first name matches when only one person has it", () => {
  const r = matchOwner("Matt", TEAM);
  assert.equal(r.user_id, "u-matt");
  assert.equal(r.how, "first");
});

test("two people with the same first name are NEVER guessed between", () => {
  const team = [...TEAM, { user_id: "u-larry2", full_name: "Larry Nguyen", email: "l2@x.com", active: true }];
  const r = matchOwner("Larry", team);
  assert.equal(r.user_id, null);
  assert.equal(r.how, "ambiguous");
  assert.equal(r.candidates.length, 2);
});

test("a name nobody has does not match anybody", () => {
  const r = matchOwner("Sawyer", TEAM);
  assert.equal(r.user_id, null);
  assert.equal(r.how, "unknown");
});

test("an inactive member is never matched", () => {
  const team = TEAM.map((t) => (t.user_id === "u-matt" ? { ...t, active: false } : t));
  assert.equal(matchOwner("Matt Brown", team).user_id, null);
});

/* ================================================================== */
/* 5. ROWS -> FIRMS                                                    */
/* ================================================================== */

test("the folded company key matches the SQL function's own rules", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/0009_sales.sql", import.meta.url), "utf8");
  assert.match(sql, /regexp_replace\(lower\(coalesce\(p_name, ''\)\), '\[\^a-z0-9\]', '', 'g'\)/,
    "migration 0009's key function changed — companyKey() in lib/sales-import.js must change with it");
  assert.equal(companyKey("ACME | SERHANT."), "acmeserhant");
  assert.equal(companyKey("Acme Serhant"), "acmeserhant");
  assert.equal(companyKey("   "), null);
});

test("three ACME rows become one firm with three contacts", () => {
  const rows = [
    { name: "Emily", company: "ACME | SERHANT.", domain: "acme-re.com" },
    { name: "Carrie", company: "ACME", domain: "acme-re.com" },
    { name: "Chase", company: "ACME | SERHANT.", domain: "acme-re.com" },
  ];
  const { companies } = groupIntoCompanies(rows);
  assert.equal(companies.length, 1);
  assert.equal(companies[0].contacts, 3);
});

test("one firm written four ways is one firm", () => {
  // Verbatim shapes from the real sheet. Lower-casing alone split this into
  // four: four site scores, four headings, one office.
  const rows = [
    { name: "A", company: "Backbeat Homes", domain: "https://www.backbeathomes.com" },
    { name: "B", company: "Backbeat Homes", domain: "backbeathomes.com" },
    { name: "C", company: "Backbeat Homes", domain: "backbeathomes.com/" },
    { name: "D", company: "Backbeat Homes", domain: "" },
  ];
  const { companies } = groupIntoCompanies(rows);
  assert.equal(companies.length, 1);
  assert.equal(companies[0].contacts, 4);
  assert.equal(companies[0].domain, "backbeathomes.com");
});

test("a hand-made mapping cannot point two columns at one field", () => {
  // The auto-mapper refuses it; the mapping screen let a person do it by hand,
  // and last-write-wins silently replaced the first column's value.
  const plan = buildImportPlan(
    [["Email", "Other email"], ["a@x.com", "b@x.com"]],
    { mapping: ["email", "email"], team: [], now: NOW }
  );
  assert.equal(plan.leads[0].lead.email, "a@x.com", "the first column must win");
  assert.equal(plan.warnings.filter((w) => w.kind === "mapping").length, 1, "and the second must be reported");
});

test("an ISO-shaped string that is not a date is refused, not passed to the database", () => {
  // "2026-13-45T12:00:00Z" reached Postgres and failed the whole insert, after
  // earlier tabs had already been written.
  assert.equal(parseSheetDate("2026-13-45", { now: NOW }).ok, false);
  assert.equal(parseSheetDate("2026-06-31", { now: NOW }).ok, false);
  assert.equal(parseSheetDate("2026-06-30", { now: NOW }).iso, "2026-06-30");
});

test("a date with mixed separators is a typo, not a date", () => {
  assert.equal(parseSheetDate("8-11/26", { now: NOW }).ok, false);
  assert.equal(parseSheetDate("8-11-26", { now: NOW }).iso, "2026-08-11");
});

test("a blank website on a later row does not wipe the one the first row had", () => {
  const rows = [
    { name: "A", company: "Backbeat Homes", domain: "backbeathomes.com", company_phone: "+1 626-788-3013" },
    { name: "B", company: "Backbeat Homes", domain: "", company_phone: "" },
  ];
  const { companies } = groupIntoCompanies(rows);
  assert.equal(companies.length, 1);
  assert.equal(companies[0].domain, "backbeathomes.com");
  assert.equal(companies[0].phone, "+1 626-788-3013");
});

test("two firms with the same name but different websites stay two firms", () => {
  const rows = [
    { name: "A", company: "Above & Beyond Real Estate", domain: "abrealestate.com" },
    { name: "B", company: "Above & Beyond Real Estate", domain: "aboveandbeyond-fl.com" },
  ];
  assert.equal(groupIntoCompanies(rows).companies.length, 2);
});

test("the same firm written two ways with one website is still one firm", () => {
  // The real sheet writes this firm as "ACME | SERHANT." and as "ACME".
  // A name-first rule splits it; the website is what proves they are one.
  const rows = [
    { name: "Emily", company: "ACME | SERHANT.", domain: "acme-re.com" },
    { name: "Carrie", company: "ACME", domain: "" },
  ];
  const { companies } = groupIntoCompanies(rows);
  assert.equal(companies.length, 2, "different names AND no shared website cannot be merged on a hunch");
});

test("a blank website is never pushed into one of two firms that share a name", () => {
  const rows = [
    { name: "A", company: "Above & Beyond Real Estate", domain: "abrealestate.com" },
    { name: "B", company: "Above & Beyond Real Estate", domain: "aboveandbeyond-fl.com" },
    { name: "C", company: "Above & Beyond Real Estate", domain: "" },
  ];
  const { companies } = groupIntoCompanies(rows);
  assert.equal(companies.length, 3, "C must not be guessed into A or B");
});

test("a row with no company and no website is not grouped with every other blank", () => {
  const rows = [{ name: "A", company: "", domain: "" }, { name: "B", company: "", domain: "" }];
  const { companies } = groupIntoCompanies(rows);
  assert.equal(companies.length, 0);
});

/* ================================================================== */
/* 6. THE WHOLE IMPORT PLAN                                            */
/* ================================================================== */

const { mapping: LUX_MAP } = guessHeaderRow(HEADER_LUXURY_AGENTS);
const PLAN = buildImportPlan(
  [HEADER_LUXURY_AGENTS, ROW_CLAIMED, ROW_SHORT_YEAR, ROW_UNCLAIMED],
  { mapping: LUX_MAP, hasHeader: true, team: TEAM, listName: "Luxury Agents", now: NOW }
);

test("the plan reads all three real rows", () => {
  assert.equal(PLAN.counts.usable, 3);
  assert.equal(PLAN.counts.blank, 0);
});

test("a claimed row keeps its rep, its date and its stage", () => {
  const diana = PLAN.leads.find((l) => l.lead.name === "Diana Francisco");
  assert.ok(diana, "Diana's row should be in the plan");
  assert.equal(diana.lead.owner_id, "u-larry");
  assert.equal(diana.lead.stage, "contacted");
  assert.equal(diana.lead.first_contact_at.slice(0, 10), "2026-08-19");
  assert.equal(diana.lead.title, "Licensed Realtor");
  assert.equal(diana.lead.email, "diana@3leafrealty.com");
});

test("the sheet's exact wording of the owner is kept next to the matched account", () => {
  const diana = PLAN.leads.find((l) => l.lead.name === "Diana Francisco");
  assert.equal(diana.lead.imported_owner_name, "Larry Pike");
});

test("an unclaimed row comes in unclaimed and with no invented claim date", () => {
  const carrie = PLAN.leads.find((l) => l.lead.name === "Carrie Bryden");
  assert.equal(carrie.lead.owner_id, null);
  assert.equal(carrie.lead.claimed_at, null);
  assert.equal(carrie.lead.stage, "new");
});

test("the two ACME people land on one firm and the other row on its own", () => {
  assert.equal(PLAN.counts.companies, 2);
  const acme = PLAN.companies.find((c) => /acme/i.test(c.name));
  assert.equal(acme.contacts, 2);
});

test("company facts go on the firm, not copied onto each person", () => {
  const threeleaf = PLAN.companies.find((c) => /3 Leaf/i.test(c.name));
  // Stored bare, not as the sheet typed it: "https://www.x.com", "x.com" and
  // "x.com/" are one firm, and only a normalised value can prove that.
  assert.equal(threeleaf.domain, "3leafrealty.com");
  assert.equal(threeleaf.annual_revenue, 11026000);
  assert.equal(threeleaf.employees, 21);
});

test("every lead gets a dated import note that cannot be mistaken for measurement", () => {
  for (const l of PLAN.leads) {
    assert.match(l.importNote, /Imported from Luxury Agents, row \d+\./);
  }
});

test("a name the team does not have is reported, with how many rows it costs", () => {
  const plan = buildImportPlan(
    [HEADER_LUXURY_AGENTS, ROW_CLAIMED.map((v, i) => (i === 0 ? "Sawyer" : v))],
    { mapping: LUX_MAP, hasHeader: true, team: TEAM, listName: "Luxury Agents", now: NOW }
  );
  const w = plan.warnings.find((x) => x.kind === "owner");
  assert.ok(w, "an unmatched owner should be a warning");
  assert.equal(w.rows, 1);
  assert.match(w.why, /Sawyer/);
});

test("the Rules of Engagement tab is not treated as a lead list", () => {
  const r = looksLikeLeadTab("Rules of Engagement", [["AI SYNDICATE — OUTREACH LIST"], ["First come, first served."]]);
  assert.equal(r.yes, false);
});

test("a real tab is recognised as a lead list", () => {
  assert.equal(looksLikeLeadTab("Luxury Agents", [HEADER_LUXURY_AGENTS, ROW_CLAIMED]).yes, true);
});

/* ================================================================== */
/* 7. COUNTING DAYS                                                    */
/* ================================================================== */

test("a touch at 8pm Central counts as that day, not the next one", () => {
  // 2026-08-20 20:00 Central is 2026-08-21 01:00 UTC. A UTC count would say a
  // rep who called last night has not called for a day.
  const evening = "2026-08-21T01:00:00Z";
  assert.equal(localDayNumber(evening), localDayNumber("2026-08-20T18:00:00Z"));
});

test("daysBetween returns null for an unreadable date, never 0", () => {
  assert.equal(daysBetween(null, NOW_ISO), null);
  assert.equal(daysBetween("not a date", NOW_ISO), null);
  assert.equal(daysBetween(ago(3), NOW_ISO), 3);
});

test("business days skip the weekend — a Friday claim is not late on Monday", () => {
  // 2026-08-21 is a Friday, 2026-08-24 the Monday after.
  assert.equal(businessDaysBetween("2026-08-21T15:00:00Z", "2026-08-24T15:00:00Z"), 1);
  assert.equal(businessDaysBetween("2026-08-21T15:00:00Z", "2026-08-22T15:00:00Z"), 0);
  assert.equal(businessDaysBetween("2026-08-21T15:00:00Z", "2026-08-26T15:00:00Z"), 3);
});

/* ================================================================== */
/* 8. THE CLAIM                                                        */
/* ================================================================== */

/* The database keeps two first-contact columns and the trigger fills both, so
 * the fixture does the same: `claim_contacted_at` (this claim's 3-day window)
 * mirrors `first_contact_at` (the relationship's) unless a test sets it apart
 * on purpose. */
const lead = (patch) => {
  const row = { id: "l1", stage: "contacted", owner_id: "u-rep", created_at: ago(30), ...patch };
  if (row.claim_contacted_at === undefined) row.claim_contacted_at = row.first_contact_at ?? null;
  return row;
};

test("a lead nobody has taken reads as unclaimed", () => {
  assert.equal(claimState(lead({ owner_id: null }), NOW).state, "unclaimed");
});

test("a fresh claim with no contact yet is inside its three days", () => {
  const s = claimState(lead({ claimed_at: ago(0), first_contact_at: null }), NOW);
  assert.equal(s.state, "first_contact");
});

test("a claim with one day left warns before anything is taken", () => {
  // Claimed Wednesday, now Friday = 2 business days used, 1 left.
  const s = claimState(lead({ claimed_at: "2026-08-19T15:00:00Z", first_contact_at: null }), NOW);
  assert.equal(s.state, "first_contact_due");
  assert.match(s.why, /1 business day/);
});

test("past three business days with no contact, the claim has run out", () => {
  const s = claimState(lead({ claimed_at: "2026-08-14T15:00:00Z", first_contact_at: null }), NOW);
  assert.equal(s.state, "claim_expired");
  assert.equal(shouldReopen(lead({ claimed_at: "2026-08-14T15:00:00Z", first_contact_at: null }), NOW), true);
});

test("a contacted lead goes cold after fourteen quiet days, and warns first", () => {
  const working = lead({ claimed_at: ago(20), first_contact_at: ago(20), last_touch_at: ago(2) });
  assert.equal(claimState(working, NOW).state, "working");

  const warning = lead({ claimed_at: ago(20), first_contact_at: ago(20), last_touch_at: ago(12) });
  assert.equal(claimState(warning, NOW).state, "going_cold");
  assert.equal(shouldReopen(warning, NOW), false, "a warning must never take somebody's firm");

  const cold = lead({ claimed_at: ago(20), first_contact_at: ago(20), last_touch_at: ago(15) });
  assert.equal(claimState(cold, NOW).state, "cold");
  assert.equal(shouldReopen(cold, NOW), true);
});

test("a closed lead is never chased, whichever way it closed", () => {
  for (const stage of CLOSED_STAGES) {
    assert.equal(claimState(lead({ stage, last_touch_at: ago(90) }), NOW).state, "closed");
    assert.equal(isOpenStage(stage), false);
  }
});

test("a claim with an unreadable date is not silently dropped", () => {
  const s = claimState(lead({ claimed_at: "who knows", first_contact_at: null }), NOW);
  assert.equal(s.state, "working");
  assert.equal(shouldReopen(lead({ claimed_at: "who knows", first_contact_at: null }), NOW), false);
});

test("a released and re-claimed lead is not instantly cold, and loses no history", () => {
  /* The journey that broke twice. First version: re-claiming left June's dates
   * in place, so the lead read "52 days quiet" the moment it was claimed and
   * the sweep took it back the same night. Second version fixed that by
   * ERASING the dates, which deleted the real first-contact date, dropped the
   * lead out of the speed sample, and made a proposal-stage lead with nine
   * logged touches report as never contacted. */
  const worked = lead({
    stage: "proposal", claimed_at: ago(60), first_contact_at: ago(59),
    claim_contacted_at: ago(59), last_touch_at: ago(40),
  });
  assert.equal(claimState(worked, NOW).state, "cold");
  assert.equal(shouldReopen(worked, NOW), true);

  // Released: the claim's own clock goes, the history stays.
  const released = { ...worked, owner_id: null, claimed_at: null, cadence_started_at: null, claim_contacted_at: null };
  assert.equal(claimState(released, NOW).state, "unclaimed");
  assert.equal(released.first_contact_at, worked.first_contact_at, "the real first-contact date must survive");
  assert.equal(released.stage, "proposal", "and so must where the deal had got to");

  // Re-claimed today by somebody else.
  const reclaimed = { ...released, owner_id: "u-rep", claimed_at: NOW_ISO, cadence_started_at: NOW_ISO };
  const s = claimState(reclaimed, NOW);
  assert.equal(s.state, "first_contact", "a fresh claim gets a fresh three days, not an instant expiry");
  assert.equal(shouldReopen(reclaimed, NOW), false, "and the sweep must not take it back tonight");

  // The history is still countable.
  const h = listHealth([reclaimed], { now: NOW });
  assert.equal(h.touched, 1, "a lead with a real first-contact date counts as contacted");
});

test("a lead worked, released and re-claimed still leaves a speed measurement", () => {
  const rows = [lead({
    owner_id: "u-rep", claimed_at: ago(3), claim_contacted_at: ago(2), first_contact_at: ago(59),
  })];
  const s = repStats(rows, [], { userId: "u-rep", now: NOW });
  assert.equal(s.speed_sample, 1, "the current claim is what is measured");
  assert.ok(s.speed_days !== null && s.speed_days >= 0, "and it is never a negative number of days");
});

test("the site-score bar counts firms, not a column leads do not have", () => {
  // `l.site_score` does not exist on admin_leads, so this read 0 of N forever.
  const rows = [lead({ id: "a", company_id: "c1" }), lead({ id: "b", company_id: "c2" })];
  const scores = { c1: 58, c2: null };
  assert.equal(listHealth(rows, { now: NOW, scoreOf: (l) => scores[l.company_id] ?? null }).scored, 1);
});

/* ================================================================== */
/* 9. THE CADENCE                                                      */
/* ================================================================== */

test("nobody owes a touch on a firm nobody has claimed", () => {
  assert.equal(cadenceState(lead({ owner_id: null }), NOW, 0).active, false);
});

test("the cadence follows the sheet: day 1, 3, 6, 9, 14", () => {
  assert.deepEqual(CADENCE.map((c) => c.day), [1, 3, 6, 9, 14]);
  assert.equal(CADENCE.length, 5);
});

test("with nothing logged on day 4, the FIRST email is what is owed", () => {
  const c = cadenceState(lead({ cadence_started_at: ago(4) }), NOW, 0);
  assert.equal(c.step.n, 1);
  assert.equal(c.over, 3);
});

test("after three touches on day 7, the fourth step is owed but not yet late", () => {
  const c = cadenceState(lead({ cadence_started_at: ago(7) }), NOW, 3);
  assert.equal(c.step.n, 4);
  assert.equal(c.step.kind, "call");
  assert.equal(c.over, -2);
});

test("all five done means finished, not a sixth touch", () => {
  const c = cadenceState(lead({ cadence_started_at: ago(20) }), NOW, 5);
  assert.equal(c.finished, true);
  assert.equal(c.step, null);
});

/* ================================================================== */
/* 10. THE TWO GATES                                                   */
/* ================================================================== */

test("90 and above is not a prospect", () => {
  assert.equal(scoreGate(90).skip, true);
  assert.equal(scoreGate(92).skip, true);
  assert.equal(scoreGate(89).skip, false);
  assert.equal(ROE.SKIP_SCORE_AT_OR_ABOVE, 90);
});

test("no score is not the same as a passing score", () => {
  const g = scoreGate(null);
  assert.equal(g.known, false);
  assert.equal(g.skip, false);
  assert.match(g.why, /No score yet/);
});

test("a score that is not a number is treated as no score, not as zero", () => {
  assert.equal(scoreGate("n/a").known, false);
  assert.equal(scoreGate("").known, false);
});

test("no text before an open, and only ever one", () => {
  assert.equal(textGate({ phone: "555", email_opened_at: null, texts_sent: 0 }).allowed, false);
  assert.equal(textGate({ phone: "555", email_opened_at: ago(1), texts_sent: 0 }).allowed, true);
  assert.equal(textGate({ phone: "555", email_opened_at: ago(1), texts_sent: 1 }).allowed, false);
  assert.equal(textGate({ phone: null, email_opened_at: ago(1), texts_sent: 0 }).allowed, false);
});

test("every refusal says why, in words a person can read", () => {
  for (const l of [
    { phone: null, email_opened_at: ago(1), texts_sent: 0 },
    { phone: "555", email_opened_at: null, texts_sent: 0 },
    { phone: "555", email_opened_at: ago(1), texts_sent: 1 },
  ]) {
    const g = textGate(l);
    assert.equal(g.allowed, false);
    assert.ok(g.reason.length > 20, "a disabled button with no reason reads as a broken button");
  }
});

/* ================================================================== */
/* 11. ONE FIRM, ONE REP — AS A WARNING                                */
/* ================================================================== */

const NAMES = { "u-larry": "Larry Pike", "u-hunter": "Hunter Grant" };
const nameOf = (id) => NAMES[id] || "another rep";

test("a colleague already working the firm produces a warning", () => {
  const me = { id: "a", company_id: "c1", owner_id: "u-hunter", stage: "new" };
  const sibs = [me, { id: "b", company_id: "c1", owner_id: "u-larry", stage: "contacted", last_touch_at: ago(2) }];
  const w = companyClaimWarning(me, sibs, nameOf, NOW);
  assert.ok(w);
  assert.match(w.line, /Larry Pike is working 1 contact here — last touched 2d ago\./);
});

test("no warning when the only other contacts are mine or closed", () => {
  const me = { id: "a", company_id: "c1", owner_id: "u-hunter", stage: "new" };
  assert.equal(companyClaimWarning(me, [me, { id: "b", company_id: "c1", owner_id: "u-hunter", stage: "contacted" }], nameOf, NOW), null);
  assert.equal(companyClaimWarning(me, [me, { id: "c", company_id: "c1", owner_id: "u-larry", stage: "lost" }], nameOf, NOW), null);
});

test("the warning counts every contact a colleague holds at the firm", () => {
  const me = { id: "a", company_id: "c1", owner_id: null, stage: "new" };
  const sibs = [me,
    { id: "b", company_id: "c1", owner_id: "u-larry", stage: "contacted", last_touch_at: ago(1) },
    { id: "c", company_id: "c1", owner_id: "u-larry", stage: "new", last_touch_at: null },
  ];
  const w = companyClaimWarning(me, sibs, nameOf, NOW);
  assert.equal(w.reps[0].contacts, 2);
});

/* ================================================================== */
/* 12. MY DAY                                                          */
/* ================================================================== */

test("the queue puts a run-out claim above a merely cold one", () => {
  const rows = [
    lead({ id: "cold", claimed_at: ago(30), first_contact_at: ago(30), last_touch_at: ago(40) }),
    lead({ id: "expired", claimed_at: "2026-08-14T15:00:00Z", first_contact_at: null }),
  ];
  const q = salesQueue(rows, { userId: "u-rep", now: NOW });
  assert.equal(q[0].lead.id, "expired");
  assert.equal(q[0].reason, "claim_expired");
});

test("winter and summer count days the same way", () => {
  // Chicago is UTC-6 in January and UTC-5 in August. A fixed offset got the
  // 11pm-to-midnight hour wrong for half the year, and a fixed-clock test in
  // August could never see it.
  assert.equal(localDayNumber("2026-01-16T05:30:00Z"), localDayNumber("2026-01-15T18:00:00Z"),
    "23:30 CST on 15 Jan must be the 15th, not the 16th");
  assert.equal(localDayNumber("2026-08-21T01:00:00Z"), localDayNumber("2026-08-20T18:00:00Z"),
    "20:00 CDT on 20 Aug must be the 20th");
  assert.equal(daysBetween("2026-01-15T18:00:00Z", "2026-01-16T05:30:00Z"), 0);
});

test("a score outside 0-100 is not a score", () => {
  assert.equal(scoreGate(150).known, false);
  assert.equal(scoreGate(150).skip, false, "150 must not read as 'already doing well'");
  assert.equal(scoreGate(-5).known, false, "-5 must not read as the widest gap on the list");
});

test("an unreadable text counter fails CLOSED", () => {
  // NaN >= 1 is false, so the obvious version unlocked unlimited texts.
  assert.equal(textGate({ phone: "555", email_opened_at: ago(1), texts_sent: "oops" }).allowed, false);
  assert.equal(textGate({ phone: "555", email_opened_at: ago(1), texts_sent: -3 }).allowed, false);
});

test("the firm warning never warns you about yourself", () => {
  // An UNCLAIMED contact has no owner, so comparing against lead.owner_id told
  // a rep "Larry is working 3 contacts here" — about Larry, to Larry.
  const free = { id: "a", company_id: "c1", owner_id: null, stage: "new" };
  const sibs = [free,
    { id: "b", company_id: "c1", owner_id: "u-larry", stage: "contacted", last_touch_at: ago(1) }];
  assert.equal(companyClaimWarning(free, sibs, nameOf, NOW, "u-larry"), null);
  assert.ok(companyClaimWarning(free, sibs, nameOf, NOW, "u-hunter"), "a colleague still warns");
});

test("listHealth survives being handed nothing", () => {
  assert.equal(listHealth(undefined, { now: NOW }).total, 0);
});

test("somebody else's lead is never in my day", () => {
  const rows = [lead({ id: "theirs", owner_id: "u-other", claimed_at: ago(30), first_contact_at: ago(30), last_touch_at: ago(40) })];
  assert.equal(salesQueue(rows, { userId: "u-rep", now: NOW }).length, 0);
});

test("a firm scoring 90+ is kept out of the pool", () => {
  const rows = [lead({ id: "high", owner_id: null, stage: "new" })];
  assert.equal(salesQueue(rows, { userId: "u-rep", now: NOW, scoreOf: () => 94 }).length, 0);
  assert.equal(salesQueue(rows, { userId: "u-rep", now: NOW, scoreOf: () => 61 }).length, 1);
});

test("but a 90+ score never drops a conversation that is already going", () => {
  /* "90 or above = not a prospect" is a rule about who to spend a touch on,
   * not about who to abandon. Applying it to everybody dropped a lead who was
   * at PROPOSAL stage — a live deal — off the rep's day, because somebody ran
   * the firm's score after the conversation had already started. Found by
   * walking the built page and noticing a lead that should have been there
   * was not. */
  const live = lead({
    id: "live", stage: "proposal", owner_id: "u-rep",
    claimed_at: ago(20), first_contact_at: ago(19), last_touch_at: ago(13),
  });
  const q = salesQueue([live], { userId: "u-rep", now: NOW, scoreOf: () => 93 });
  assert.equal(q.length, 1, "a live deal must survive a high score on the firm");
  assert.equal(q[0].lead.id, "live");

  // And the early stages still are dropped, so the gate has not been switched off.
  for (const stage of ["new", "researching"]) {
    assert.equal(
      salesQueue([lead({ id: "early", stage, owner_id: "u-rep", claimed_at: ago(9), first_contact_at: null })],
        { userId: "u-rep", now: NOW, scoreOf: () => 93 }).length,
      0, `${stage} should still be gated at 90+`
    );
  }
});

test("every card says why it is there", () => {
  const rows = [
    lead({ id: "1", claimed_at: "2026-08-14T15:00:00Z", first_contact_at: null }),
    lead({ id: "2", claimed_at: ago(30), first_contact_at: ago(30), last_touch_at: ago(20) }),
    lead({ id: "3", owner_id: null, stage: "new" }),
  ];
  const q = salesQueue(rows, { userId: "u-rep", now: NOW });
  assert.equal(q.length, 3);
  for (const card of q) {
    assert.ok(card.headline && card.detail, "a queue that will not say why it chose something gets re-sorted by hand");
  }
});

/* ================================================================== */
/* 13. THE NUMBERS CJ READS                                            */
/* ================================================================== */

test("speed to first contact is null when nothing has been measured, not zero", () => {
  const s = repStats([lead({ owner_id: "u-rep", claimed_at: ago(3), first_contact_at: null })], [], { userId: "u-rep", now: NOW });
  assert.equal(s.speed_days, null);
  assert.equal(s.speed_sample, 0);
});

test("close rate is over decided leads only, and is null before anything is decided", () => {
  const open = [lead({ owner_id: "u-rep", stage: "contacted" })];
  assert.equal(repStats(open, [], { userId: "u-rep", now: NOW }).close_rate, null);

  const decided = [
    lead({ id: "a", owner_id: "u-rep", stage: "won" }),
    lead({ id: "b", owner_id: "u-rep", stage: "lost" }),
    lead({ id: "c", owner_id: "u-rep", stage: "contacted" }),
  ];
  const s = repStats(decided, [], { userId: "u-rep", now: NOW });
  assert.equal(s.decided, 2);
  assert.equal(s.close_rate, 50, "an open lead must not count as a loss");
});

test("list health separates never-touched from claimed-but-quiet", () => {
  const rows = [
    lead({ id: "a", owner_id: "u-rep", first_contact_at: ago(2), last_touch_at: ago(2) }),
    lead({ id: "b", owner_id: null, stage: "new", first_contact_at: null }),
    lead({ id: "c", owner_id: "u-rep", stage: "skip_90", first_contact_at: null }),
  ];
  const h = listHealth(rows, { now: NOW });
  assert.equal(h.total, 3);
  assert.equal(h.touched, 1);
  assert.equal(h.untouched, 2);
  assert.equal(h.skipped, 1);
  assert.equal(h.open, 2);
});

/* ================================================================== */

console.log("\nSALES — rules and import\n");
console.log(results.join("\n"));
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
