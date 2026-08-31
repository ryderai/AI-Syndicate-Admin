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
  SALES_FIELDS,
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

test("'Keywords' now has a column of its own on the FIRM, and never on the person", () => {
  /* CHANGED Aug 30 2026, deliberately. This used to assert `""` — Keywords was
   * left unmapped because it is a 400-word paragraph of what the firm does and
   * what its website runs on, and it was landing in a rep's notes field.
   *
   * Ryder's rule is to keep every piece of data we ever touch, and thrown away
   * this one cannot be got back without re-exporting from Apollo. So migration
   * 0025 gives it a column on admin_companies. The thing that made it a
   * problem — it is a paragraph, not a label — is handled by WHERE it goes,
   * not by dropping it: `where: "company"`, so no lead row can ever render it.
   */
  assert.equal(guessSalesColumn("Keywords"), "keywords");
  assert.equal(guessSalesColumn("Technologies"), "keywords");
  assert.equal(SALES_FIELDS.find((f) => f.key === "keywords").where, "company");
});

test("the five columns the sheet had and the console did not now have somewhere to go", () => {
  /* Each of these was being read off CJ's sheet and then dropped for want of a
   * column, on every import. Migration 0025. */
  assert.equal(guessSalesColumn("Address"), "address");
  assert.equal(guessSalesColumn("Country"), "country");
  assert.equal(guessSalesColumn("Company Name for Emails"), "company_alias");
  assert.equal(guessSalesColumn("Total Funding"), "total_funding");
  assert.equal(guessSalesColumn("Keywords"), "keywords");

  const where = Object.fromEntries(SALES_FIELDS.map((f) => [f.key, f.where]));
  assert.equal(where.address, "lead", "the contact's own location line belongs to the PERSON");
  assert.equal(where.country, "lead");
  assert.equal(where.company_alias, "company");
  assert.equal(where.total_funding, "company");
});

test("'Total Funding' is not eaten by the loose revenue rule above it", () => {
  /* The revenue rule is `\\b(annual revenue|revenue)\\b` with no anchor, so it
   * matches nothing in "Total Funding" — but the ORDER is what guarantees it
   * stays that way if either pattern is ever loosened. */
  assert.equal(guessSalesColumn("Total Funding"), "total_funding");
  assert.equal(guessSalesColumn("Annual Revenue"), "annual_revenue");
  assert.notEqual(guessSalesColumn("Total Funding"), guessSalesColumn("Annual Revenue"));
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
  /* KNOWING A STAGE IS NOT WRITING ONE.
   *
   * `not_a_fit` is in CLOSED_STAGES before migration 0027 creates it, and
   * deliberately: without it, every lead 0027 merges comes back as an OPEN
   * stage the moment it runs — back on the cadence, back in My Day, back in
   * every count. A closed stage the database cannot hold yet is inert; an open
   * one it CAN hold is a live defect. So the bar here is that every closed
   * stage is either accepted today or named in a migration somebody can point
   * at — and that nothing can WRITE the pending one, which PICKABLE_STAGES
   * enforces and tests/pipeline-spec asserts. */
  const pendingSql = readFileSync(new URL("../../supabase/migrations/0027_pipeline_spec.sql", import.meta.url), "utf8");
  for (const st of CLOSED_STAGES) {
    assert.ok(allowed.has(st) || pendingSql.includes(`'${st}'`),
      `CLOSED_STAGES names "${st}" which no migration creates`);
  }
  /* EVERY PICKABLE STAGE MUST BE ONE THE DATABASE ACCEPTS, and that is the real
   * rule — the earlier version of this assertion said `not_a_fit` must NOT be
   * offered, which was right for the one evening 0027 sat unrun and wrong the
   * morning it was run. A test pinned to a migration's status has to be edited
   * every time the status changes correctly. Pinned to the constraint instead:
   * it now reads BOTH 0009 and 0027, so it answers "can the database hold this"
   * whatever has been run. */
  const dataSrc = readFileSync(new URL("../../src/lib/data.js", import.meta.url), "utf8");
  const pickable = [...dataSrc
    .match(/export const PICKABLE_STAGES = \[([\s\S]*?)\];/)[1]
    .matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
  for (const st of pickable) {
    assert.ok(allowed.has(st) || pendingSql.includes(`'${st}'`),
      `PICKABLE_STAGES offers "${st}" which no migration creates`);
  }
  /* And the two 0027 merged away must not be offered any more — they are still
   * legal values, so only this stops them being written again. */
  for (const st of ["skip_90", "bad_contact"]) {
    assert.ok(!pickable.includes(st), `${st} was merged into not_a_fit and must not be offered`);
  }
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

test("no text before a REPLY, and only ever one", () => {
  /* THE GATE MOVED FROM "THEY OPENED" TO "THEY REPLIED" — Aug 27 2026.
   *
   * It read `email_opened_at`, and NOTHING HAS EVER WRITTEN THAT COLUMN, so this
   * function refused every text ever and the button has never once been usable.
   * Nobody knew, because the assertion below was written with a fixture that
   * filled the column by hand. Migration 0021 moved the database's own copy of
   * this gate to `first_reply_at`; for a few hours the browser's copy was left
   * behind, which is the live-and-preview divergence this repo has a memory note
   * about. Both are on `first_reply_at` now.
   *
   * A reply is a STRONGER signal than an open, not a weaker one: an open can be an
   * image proxy loading a pixel, and a reply is a person typing. */
  assert.equal(textGate({ phone: "555", first_reply_at: null, texts_sent: 0 }).allowed, false);
  assert.equal(textGate({ phone: "555", first_reply_at: ago(1), texts_sent: 0 }).allowed, true);
  assert.equal(textGate({ phone: "555", first_reply_at: ago(1), texts_sent: 1 }).allowed, false);
  assert.equal(textGate({ phone: null, first_reply_at: ago(1), texts_sent: 0 }).allowed, false);
  /* AND THE OLD COLUMN NO LONGER UNLOCKS ANYTHING. This is the assertion that
   * would have caught the divergence: a lead with an open on record and no reply
   * must still be refused. */
  assert.equal(textGate({ phone: "555", email_opened_at: ago(1), first_reply_at: null, texts_sent: 0 }).allowed, false);
  /* The database function agrees, in the same words. tests/floor-scoping/sql.sh
   * proves it against a real Postgres; this reads the file so a drift between the
   * two is caught even where there is no database to run. */
  const sql = readFileSync(new URL("../../supabase/migrations/0021_outreach_tracking.sql", import.meta.url), "utf8");
  assert.match(sql, /and first_reply_at is not null/,
    "admin_lead_claim_text must gate on first_reply_at too, or the browser and the database disagree");
});

test("every refusal says why, in words a person can read", () => {
  for (const l of [
    { phone: null, first_reply_at: ago(1), texts_sent: 0 },
    { phone: "555", first_reply_at: null, texts_sent: 0 },
    { phone: "555", first_reply_at: ago(1), texts_sent: 1 },
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
  /* `first_reply_at` since Aug 27 2026 — see the gate test above. This one would
   * pass either way (an unreadable counter is refused before the reply is even
   * looked at), and it is updated so the fixture cannot be read as evidence that
   * the old column still unlocks anything. */
  assert.equal(textGate({ phone: "555", first_reply_at: ago(1), texts_sent: "oops" }).allowed, false);
  assert.equal(textGate({ phone: "555", first_reply_at: ago(1), texts_sent: -3 }).allowed, false);
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
/* 14. THE REP'S TWO PAGES                                             */
/* ================================================================== */
/* Aug 26 2026: reps got their own logins, and with them Leads (the floor) and
 * My leads — the SAME SalesPage with a mode, not a copy of it. Owner and admin
 * did not change.
 *
 * These read the components as text, the way the vault tests do, because the
 * files are JSX and node cannot import them. The two decision tables inside
 * them are plain data, though, so those are pulled out and evaluated for real
 * rather than matched with a regex: a test that only greps can be satisfied by
 * a comment, and this is exactly the code a checker caught lying yesterday.
 */

const srcOf = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
/* The rules file, read as TEXT as well as imported. Some of what has to be true
 * about it is the shape of the source — that a check exists as one exported
 * function rather than being re-implemented at three call sites — and that is
 * not visible from the imported values. */
const RULES = srcOf("lib/sales-rules.js");
const SIDEBAR = srcOf("src/components/admin/Sidebar.jsx");
const DASH = srcOf("src/components/AdminDashboard.jsx");
const SALESPAGE = srcOf("src/components/admin/SalesPage.jsx");

/** Lift a top-level `const NAME = <literal>;` out of a JSX file and evaluate
 *  it. Only safe for the literals below, which hold strings and arrays and
 *  nothing else — check that before pointing this at anything new. ROE is
 *  handed in because one of those strings quotes the first-contact window from
 *  the rules rather than repeating the number, which is what we want it to do. */
function literal(src, name) {
  const start = src.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `${name} is not declared at the top level any more`);
  const open = src.indexOf("=", start) + 1;
  // Walk the brackets rather than guessing where the literal ends — the
  // declarations below span many lines and carry comments between entries.
  let depth = 0, i = open, started = false;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{" || c === "[") { depth += 1; started = true; }
    else if (c === "}" || c === "]") { depth -= 1; if (started && depth === 0) { i += 1; break; } }
  }
  assert.ok(started && depth === 0, `could not read the ${name} literal`);
  return new Function("ROE", `return (${src.slice(open, i)});`)(ROE);
}

const SECTIONS = literal(SIDEBAR, "SECTIONS");
const MODES = literal(SALESPAGE, "MODES");

/* The two functions the dashboard's role gate is built on. Two lines each in
 * Sidebar.jsx, repeated here because the file cannot be imported — if either
 * changes shape these break, which is the point. */
const groupsFor = (role) => SECTIONS.filter((g) => g.roles.includes(role));
const pageIdsFor = (role) => groupsFor(role).flatMap((g) =>
  g.items.flatMap(([id, , kids]) => [id, ...(kids || []).map(([kid]) => kid)]));

/* ==================================================================
 * REWRITTEN Aug 27 2026 — THE REP CONSOLE IS FOUR PAGES, NOT THREE
 * ==================================================================
 * Eleven assertions in this block pinned the old shape: Work, Leads (unclaimed
 * only) and My leads, with the lock applied to the LIST. Ryder's call on Aug 27
 * replaced that with Overview, The Floor, Gmail and AI Brain, and moved the lock
 * onto the ROW — a rep sees every lead in the company and may only change the
 * ones that are theirs or unclaimed.
 *
 * The old assertions were not deleted, they were REPOINTED. Each one still
 * guards the same rule; the rule's shape changed underneath it. Deleting them
 * would have taken the rep console back to having no test at all at exactly the
 * moment it changed the most.
 */

test("a rep's console is four pages: Overview, The Floor, Gmail and AI Brain", () => {
  assert.deepEqual(pageIdsFor("sales"), ["overview", "floor", "gmail", "brain"]);
  /* The two that went away. Not renamed — absorbed: Work became Overview, and
   * the Floor with the switch on "Mine" IS My leads. An id that stops existing
   * has to stop existing everywhere, or an old bookmark quietly lands on the
   * landing page and nobody reports it as broken. */
  assert.ok(!pageIdsFor("sales").includes("work"), "Work is not a rep's page any more");
  assert.ok(!pageIdsFor("sales").includes("leads"), "Leads is gone; the Floor replaced it");
  assert.ok(!pageIdsFor("sales").includes("mine"), "My leads is gone; the Floor opens on Mine");
});

test("a rep lands on their own Overview, because the landing page is the first one their role has", () => {
  // AdminDashboard: LANDING is "overview" and a rep now HAS it, so both paths
  // agree for the first time.
  assert.equal(pageIdsFor("sales")[0], "overview");
});

test("the owner's Sales group is one entry that opens to Sales and Stats", () => {
  /* CHANGED 30 Aug 2026, deliberately. Ryder: "i would maybe like to add a
   * stats page in the owner and admin part where when you click sales a
   * dropdown appears to click to the stats page."
   *
   * Written as a CHILD of `sales`, not a second top-level entry, so the group
   * stays one line until you go there and Sales stays open while you are on
   * Stats — the mechanism Finance → Invoices already uses. The assertion is on
   * the exact shape because that shape is what makes parentOf() and
   * pageIdsForRole() behave. */
  const owner = pageIdsFor("owner");
  assert.ok(owner.includes("sales"), "the owner must keep the four-tab Sales page");
  assert.ok(owner.includes("sales-stats"), "and must be able to open Stats");
  assert.ok(!owner.includes("floor"), "the Floor is a rep's page, not the owner's");
  assert.ok(!owner.includes("gmail"), "the owner has the shared Inbox, not a rep's own mailbox page");
  assert.ok(owner.includes("work"), "Work is still the owner's page");
  assert.deepEqual(pageIdsFor("owner"), pageIdsFor("admin"), "admin and owner are still the same menu");
  const salesGroup = groupsFor("owner").filter((g) => g.group === "Sales");
  assert.equal(salesGroup.length, 1, "an owner must see exactly one Sales group");
  assert.deepEqual(salesGroup[0].items, [["sales", "Sales", [["sales-stats", "Stats"]]]]);
});

test("STATS IS OWNER AND ADMIN ONLY, and the menu is not the gate", () => {
  /* The page shows every rep's numbers beside every other rep's. A rep must not
   * open it, and "it is not in their menu" is not a permission — AdminDashboard
   * refuses to route to an id the role's own list does not carry, and that list
   * is what this asserts. Same shape of gate as the Vault. */
  assert.ok(!pageIdsFor("sales").includes("sales-stats"),
    "a rep pasting #/dashboard/sales-stats must land somewhere else");
  for (const role of ["owner", "admin"]) {
    assert.ok(pageIdsFor(role).includes("sales-stats"), `${role} must be able to open Stats`);
  }
});

test("opening Stats leaves Sales open in the sidebar", () => {
  /* parentOf() in Sidebar.jsx reads exactly this shape — a child listed under
   * its parent — so asserting the shape asserts the behaviour. Derived here the
   * same way rather than imported, because this suite rebuilds SECTIONS itself
   * and importing the component would drag a browser in with it. */
  const parentOf = (id) => {
    for (const g of SECTIONS) {
      for (const [pid, , kids] of g.items) {
        if ((kids || []).some(([kid]) => kid === id)) return pid;
      }
    }
    return null;
  };
  assert.equal(parentOf("sales-stats"), "sales");
  assert.equal(parentOf("invoices"), "finance", "the mechanism it borrows still works");
});

test("a rep cannot reach a page their role does not list", () => {
  for (const id of ["sales", "work", "clients", "vault", "team", "settings", "operations", "inbox", "notes", "finance"]) {
    assert.ok(!pageIdsFor("sales").includes(id), `${id} must not be openable by a rep`);
  }
});

test("TWO PAGE IDS ARE SHARED WITH THE OWNER, AND THE ROLE PICKS THE COMPONENT", () => {
  /* `overview` and `brain` are deliberately the same ids for everybody, so the
   * role never appears in a URL. The whole safety of that choice is that
   * AdminDashboard renders a DIFFERENT component per role — if it ever stopped,
   * a rep would be routed to the owner's Overview and to the company Brain,
   * which api/ai-draft.js refuses to load for them on purpose (trap #8). */
  assert.ok(pageIdsFor("sales").includes("overview") && pageIdsFor("owner").includes("overview"));
  assert.ok(pageIdsFor("sales").includes("brain") && pageIdsFor("owner").includes("brain"));
  assert.match(DASH, /case "overview": return member\.role === "sales"/);
  assert.match(DASH, /<RepOverview member=\{member\} \/>/);
  assert.match(DASH, /case "brain": return member\.role === "sales"/);
  assert.match(DASH, /<RepBrain member=\{member\} \/>/);
});

test("the rep's four items are named in Ryder's words", () => {
  const items = groupsFor("sales").flatMap((g) => g.items).map(([, label]) => label);
  assert.deepEqual(items, ["Overview", "The Floor", "Gmail", "AI Brain"]);
});

test("every rep page id has a sidebar icon", () => {
  for (const id of pageIdsFor("sales")) {
    assert.ok(new RegExp(`^\\s{2}${id}: <svg`, "m").test(SIDEBAR), `no icon for ${id}`);
  }
});

test("every address a rep could already have bookmarked still lands somewhere true", () => {
  /* THE RULE MOVED OUT OF THE COMPONENT on 31 Aug 2026 — it is now
   * src/lib/pageForAddress.js, with its own suite in tests/page-for-address.
   * It moved because nothing here could reach the DECISION, only the source
   * text of it, and the line that sent a rep back from the Gmail sign-in was
   * wrong in it with every test in this repo green.
   *
   * These assertions are REPOINTED, not deleted: each one still guards the
   * same rule, against the file that now holds it. What this file keeps is the
   * half that is genuinely about the dashboard — that the dashboard asks that
   * module at all, and does not grow its own second copy of the maps. */
  const ROUTE = srcOf("src/lib/pageForAddress.js");
  const renamed = literal(ROUTE, "RENAMED");
  assert.equal(renamed.leads, "sales", "old links that say leads must still reach Sales");
  assert.equal(renamed.customers, "clients");
  const split = literal(ROUTE, "SPLIT_FOR_ROLE");
  /* A MAP PER ROLE now, not one page id — there are five old addresses to
   * catch rather than one. Every one of them has to point at a page the role
   * actually has, or the fallback quietly shows the landing page and the link
   * looks fine while being wrong. */
  assert.equal(split.sales.sales, "floor", "a rep opening the owner's Sales page must land on the Floor");
  assert.equal(split.sales.leads, "floor", "the old floor bookmark must land on the Floor");
  assert.equal(split.sales.mine, "floor", "My leads IS the Floor with the switch on Mine");
  assert.equal(split.sales.work, "overview", "Work became Overview");
  assert.equal(split.sales.inbox, "gmail", "the Gmail sign-in bounces every role to #/dashboard/inbox, and that is not a rep's page");
  for (const [from, to] of Object.entries(split.sales)) {
    assert.ok(pageIdsFor("sales").includes(to), `the split from ${from} points at a page a rep does not have`);
  }
  // And the split is only read when the role cannot open what was named, so an
  // owner's address is untouched.
  assert.match(ROUTE, /ids\.includes\(named\)/);
  assert.match(ROUTE, /SPLIT_FOR_ROLE\[role\]\?\.\[named\]/);
  // The dashboard asks that module and keeps no second copy of the maps.
  assert.match(DASH, /pageForAddress\(\{/);
  assert.ok(!/const SPLIT_FOR_ROLE/.test(DASH), "the dashboard has grown its own copy of the split map again");
  assert.ok(!/const RENAMED/.test(DASH), "the dashboard has grown its own copy of the rename map again");
});

test("the Floor is the ONE SalesPage with a mode, and there is no second copy", () => {
  assert.match(DASH, /case "floor": return <SalesPage member=\{member\} mode="floor" \/>/);
  assert.match(DASH, /case "sales": return <SalesPage member=\{member\} \/>/);
  /* The dead ids are not cases any more. They cannot be reached — they are in no
   * role's list — and a case for an unreachable id reads to the next person as a
   * page that still exists. */
  assert.ok(!/case "mine":/.test(DASH), "the mine route is gone with the page");
  assert.ok(!/case "leads":/.test(DASH), "the leads route is gone with the page");
  // One import of SalesPage. A second component would be the drifted copy.
  assert.equal((DASH.match(/from "\.\/admin\/SalesPage\.jsx"/g) || []).length, 1);
});

test("THE LOCK IS ON THE ROW, NOT ON THE LIST", () => {
  /* THE ASSERTION THIS REPLACED read `MODES.floor.owner === "floor"` and
   * `MODES.mine.owner === "mine"` — the two narrowed lists. Both are gone, and
   * `owner` is gone from MODES with them, because a mode that narrowed the set
   * is exactly what was removed. What has to be true instead:
   *
   *   1. there is one mode, not two;
   *   2. it does NOT narrow anything — no `owner` key at all;
   *   3. the page's set is the whole board;
   *   4. canEditLead is the one thing that decides editability, and it is
   *      imported rather than re-implemented.
   */
  assert.deepEqual(Object.keys(MODES), ["floor"], "one rep lead page, not two");
  assert.ok(!("owner" in MODES.floor), "a mode must not narrow the set any more — the row lock replaced it");
  assert.ok(MODES.floor.saying, "the page still says out loud what it holds");
  /* 30 AUG 2026 — AND THE SET IS NARROWED AGAIN, FOR ONE ROLE.
   *
   * The line above said "the page's set is every lead it read, for every role".
   * Ryder reversed that: a rep no longer sees a lead somebody else holds. What
   * has to be true now is narrower AND stricter — the narrowing happens in
   * exactly one place, through one exported pure function, before any filter. */
  assert.match(SALESPAGE, /const scopeLeads = useMemo\(\s*\(\) => visibleToMember\(board\?\.leads \|\| \[\], member\),/,
    "the page's set is visibleToMember and nothing else");
  assert.equal((SALESPAGE.match(/visibleToMember\(/g) || []).length, 1,
    "the visibility rule is applied ONCE — a second call site is a second rule");
  assert.match(SALESPAGE, /canEditLead/, "the page reads the one editability helper");
  const SHEETLIB = readFileSync(new URL("../../src/lib/salesSheet.js", import.meta.url), "utf8");
  assert.match(SHEETLIB, /export function canEditLead/, "and the helper is exported from one place");
  /* The rule itself, read out of the source rather than trusted: a rep may edit
   * their own or an unclaimed lead, and anybody who is not a rep may edit
   * anything. Written as "not sales" rather than "owner or admin" so a role
   * nobody has taught the file about does not silently lose the ability to work. */
  assert.match(SHEETLIB, /if \(member\.role !== "sales"\) return true;/);
  assert.match(SHEETLIB, /return lead\.owner_id === member\.user_id \|\| lead\.owner_id == null;/);
  /* AND A MISSING MEMBER IS NOT AN OWNER. A page that does not know who is
   * looking at it must get a read-only row, never an editable one. */
  assert.match(SHEETLIB, /if \(!lead \|\| !member\) return false;/);
});

test("the same rule is in the database, not only on the page", () => {
  /* THE POLITE HALF IS NOT THE LOCK. Every file in api/ runs on the service key
   * and ignores row-level security, and a disabled button is something a person
   * sees rather than something that stops a request. So the rule has to be in
   * migration 0020 as well, and this reads it out of the SQL rather than
   * believing a comment. */
  const SQL = readFileSync(new URL("../../supabase/migrations/0020_rep_scoping.sql", import.meta.url), "utf8");
  assert.match(SQL, /create policy "members update leads" on public\.admin_leads/);
  /* The `with check` is the whole point: 0001 had a `using` and no `with check`,
   * which let any rep set any lead's owner_id to their own id by talking to the
   * database directly. */
  assert.match(SQL, /with check \(\s*public\.admin_is_admin\(\)\s*or owner_id = auth\.uid\(\)/);
  assert.match(SQL, /reps work their own mailbox threads/, "a rep's Gmail needs its own policy");
  assert.match(SQL, /admin_rep_reports add column if not exists counted_cause/,
    "the column api/rep-report.js already writes has to exist before 0017 is run");
});

test("no tile on the Floor can widen it, and none is left filtering nothing", () => {
  // "floor", "mine" and "owed" all move the owner filter or the view, so they
  // cannot appear on a rep's page at all.
  /* "floor" and "mine" are the availability switch said a second time — one
   * control saying what another already says is how one of them ends up lying,
   * so they stay off a rep's page for good.
   *
   * "owed" CAME OFF THIS LIST on 30 Aug. It was banned because it switches to My
   * Day, and a locked page had no My Day to switch to. It has one now. */
  for (const [mode, cfg] of Object.entries(MODES)) {
    for (const banned of ["floor", "mine"]) {
      assert.ok(!cfg.tiles.includes(banned), `${mode} must not carry the ${banned} tile`);
    }
  }
  /* THE FLOOR HAS NONE AT ALL. Every tile it could carry either says what the
   * availability switch above the table already says, or belongs on Overview,
   * which is where a rep's own numbers live now. A tile that filters nothing is
   * removed rather than left lit and inert. */
  /* THE FLOOR HAS FOUR NOW — 30 Aug 2026. It had none while "On the floor" and
   * "Yours, open" duplicated the availability switch and the other four counted
   * a book with somebody else's rows in it. A rep's book is now exactly what
   * they may work, so the four that ask a question no other control asks are
   * true about it and Ryder asked for the two pages to show the same things.
   * The two that ARE the availability switch stay off — the ban above is what
   * enforces that, and "owed" stays banned because it is a whole view. */
  assert.deepEqual(MODES.floor.tiles, ["owed", "atRisk", "meetings", "won"],
    "the floor carries the four tiles that ask something no other control on it asks");
});

test("the Floor has a real Claim button, and no paragraph explaining it", () => {
  /* THE HINT LINE IS GONE — Ryder, 30 Aug 2026: "remove this text", pointing at
   * the paragraph between the list tabs and the table.
   *
   * This test used to assert three things ABOUT that sentence, and one of them
   * (the word "read-only") had already survived the rule it described being
   * reversed — the assertion was holding a wrong sentence in place. The lesson
   * generalises: do not assert the wording of a caption. Assert the CONTROL.
   * A button marked Claim explains itself; a paragraph next to it does not. */
  assert.ok(!("hint" in MODES.floor), "MODES must not carry a hint sentence any more");
  assert.ok(!/lock\.hint/.test(SALESPAGE), "and nothing may pass one to the sheet");
  assert.ok(!/\{hint && \(/.test(SALESPAGE), "and the sheet must not render one");

  const SHEET = readFileSync(new URL("../../src/components/admin/salesSheet.jsx", import.meta.url), "utf8");
  /* The button is for UNCLAIMED rows only, it only ever files a lead under YOUR
   * OWN id, and it goes through the same assign path the dropdown uses — so the
   * claim, the clock and the toast cannot behave differently depending on which
   * control was touched. */
  assert.match(SHEET, /editable && free && claimAs/, "the button is for unclaimed rows you may edit");
  assert.match(SHEET, /onAssign\(row, claimAs\)/, "and it goes through the same assign path as the dropdown");
  assert.match(
    SALESPAGE,
    /claimAs=\{lock \? member\.user_id : null\}/,
    "a rep's page is the only one that sends a claimer, and it sends YOU",
  );
  /* A REP MAY NEVER HAND A LEAD TO SOMEBODY ELSE. Only an owner or an admin can,
   * so the person dropdown is not drawn for a rep at all — and assignLead
   * refuses it a second time for the path that does not go through a control. */
  assert.match(SALESPAGE, /canAssign=\{isAdmin\}/);
  /* NOBODY GETS THE PICKER ON A ROW ANY MORE — 30 Aug 2026. Ryder: "i want it
   * so that its a normal row that when you click anything that isnt a tag it
   * opens the client card." Handing a lead to somebody else moved to the card,
   * where the owner dropdown still is and where migration 0020 still refuses it
   * for a rep. The rule this line has always been about — a rep must never be
   * shown a control that will then be refused — is now true of everybody, so it
   * is asserted the stronger way: the sheet has no person picker at all. */
  assert.ok(!SHEET.includes("<PersonCell"), "the sheet still has an owner picker on the row");
  assert.match(SHEET, /Open the record to hand it over/, "and it has to say where handing it over happens");
  assert.match(SALESPAGE, /if \(!isAdmin && userId && userId !== member\.user_id\)/);
});

test("WON AND LOST BOTH ASK WHY, IN FRONT OF THE ONE FUNCTION", () => {
  /* Four buttons can close a deal and all four were routed through markLeadWon
   * on Aug 25. The reason box goes in front of THAT, not in front of the four —
   * putting it on each of them is how three get it and one does not, which is
   * exactly the defect that made one of those four permanently block the only
   * one that worked. */
  assert.match(SALESPAGE, /const askForReason = useCallback\(\(lead, kind\)/);
  /* These two used to `return askForReason(...)`, which returned undefined. On
   * 30 Aug 2026 patchLead started reporting whether it wrote anything, because
   * the sheet's new chip picker follows a successful move with "moved — add a
   * note?" — and it must not say that about a move that has not happened yet.
   * So they now return FALSE explicitly. The rule is unchanged: the reason box
   * goes in front of the one function, never in front of the four buttons. */
  assert.match(SALESPAGE, /if \(patch\.stage === "won" && lead\.stage !== "won"\) \{ askForReason\(lead, "won"\); return false; \}/);
  assert.match(SALESPAGE, /if \(patch\.stage === "lost" && lead\.stage !== "lost"\) \{ askForReason\(lead, "lost"\); return false; \}/);
  const PROFILE = readFileSync(new URL("../../src/components/admin/salesProfile.jsx", import.meta.url), "utf8");
  assert.match(PROFILE, /const doWin = \(\) => doClose\("won"\)/);
  assert.match(PROFILE, /const flipToClient = \(\) => doClose\("won"\)/);
  /* THE HARD-CODED REASON IS GONE. This was the only button in the console that
   * ever wrote lost_reason and it wrote the same sentence every time, so the
   * loss breakdown would have been one bar tall for ever. */
  assert.ok(
    !PROFILE.includes('lost_reason: "No reply after the full cadence."'),
    "the one hard-coded loss reason must be gone — it made the breakdown meaningless",
  );
  /* And the check itself is one function, in the pure module, refusing an empty
   * reason and a one-word note. */
  assert.match(RULES, /export function checkCloseReason/);
  assert.match(RULES, /export const LOST_REASONS/);
  assert.match(RULES, /export const WON_REASONS/);
});

test("the filter chain is ONE function, and every caller hands it the page's set", () => {
  /* REWRITTEN Aug 27 2026. The rule this test guards has not changed — there is
   * exactly one place that decides what the list holds, and no path filters
   * anything but the set the page is about. What changed is what that set IS:
   * the whole board, for every role, because the lock moved onto the row.
   *
   * The two assertions that were removed:
   *   `if (lock.owner === "floor") return all.filter(...)`  — the list lock,
   *      deleted with the two pages it belonged to.
   *   the owner-dropdown check for `if (!lock)` — still there, still asserted
   *      below, but the availability switch is now the rep's version of it and
   *      has to be in the chain too, or a filter would live in a control. */
  /* The opt-outs grew a third on 30 Aug (`skipWatch`), so the argument list is
   * matched loosely and the ONE thing that matters — one chain, one `let list`
   * — is asserted exactly. A regex pinned to the arguments fails every time an
   * argument is added correctly, which teaches people to delete the test. */
  assert.match(SALESPAGE, /const filterLeads = useCallback\(\(source, \{[^}]*\} = \{\}\) => \{\s*\n\s*let list = source;/);
  assert.match(SALESPAGE, /const rows = useMemo\(\(\) => filterLeads\(scopeLeads\), /);
  for (const m of SALESPAGE.match(/filterLeads\([a-zA-Z]+/g) || []) {
    assert.ok(m === "filterLeads(source" || m === "filterLeads(scopeLeads",
      `filterLeads is called on ${m.slice(13)} — every caller must hand it the page's set`);
  }
  /* THE AVAILABILITY SWITCH IS IN THE CHAIN, not in a control. A filter kept in a
   * control is only as good as the controls somebody remembered to wire; applied
   * to the set first, nothing downstream can widen it. */
  assert.match(SALESPAGE, /if \(lock && !skipAvailability\) list = byAvailability\(list, availability, member\);/);
  assert.match(SALESPAGE, /if \(!lock\) \{\s*\n\s*if \(ownerFilter === "mine"\)/);
  // And the owner's control is gone from a rep's page rather than left to be overridden.
  assert.match(SALESPAGE, /\{!lock && \(\s*\n\s*<select className="adm-input adm-sl-sel" data-filter="owner"/);
  /* THE SWITCH'S THREE NUMBERS COUNT FROM THE SAME ROWS THE LIST HOLDS, minus its
   * own filter. Counting from `rows` would make "All" show the size of whichever
   * state happens to be on, which is the class of bug this file is full of. */
  assert.match(SALESPAGE, /availabilityCounts\(filterLeads\(scopeLeads, \{ skipAvailability: true \}\), member\)/);
});

test("switching a tile off returns to the page you are on, not the owner's defaults", () => {
  // tileOff is what pressTile restores. Every one of its values has to come
  // from the lock when there is one — a rep sent back to "all" would be
  // looking at everybody's leads under a page called My leads.
  const m = /const tileOff = useMemo\(\(\) => \(\{([\s\S]*?)\}\), \[/.exec(SALESPAGE);
  assert.ok(m, "tileOff is not built with useMemo any more");
  assert.match(m[1], /view: lock \? "lists"/);
  /* CHANGED Aug 27 2026: it was `owner: lock ? lock.owner`, which read a key a
   * mode no longer has — so it produced `undefined` and put it into a filter that
   * a locked page does not read anyway. Harmless, and exactly the shape of thing
   * that stops being harmless later. The honest value is "all", and the reason a
   * locked page does not need one is that the availability switch replaced it. */
  assert.match(m[1], /owner: lock \? "all"/);
  assert.match(SALESPAGE, /if \(lock && !lock\.tiles\.includes\(id\)\) return;/);
});

test("a locked page has the same four views as the owner's, and its numbers are counted from its own set", () => {
  /* WAS "a locked page is the sheet only". Ryder, 30 Aug 2026: the rep page and
   * the owner page should show the same things. They can now, because a rep's
   * set is exactly the set they may work — My Day, the Pipeline board and Firms
   * all count something true about it, which was not so while it held other
   * reps' rows.
   *
   * The view is still DERIVED rather than trusted: an unknown value falls back
   * to the sheet instead of rendering nothing. */
  assert.match(SALESPAGE, /const shownView = VIEWS\.some\(\(\[v\]\) => v === view\) \? view : "lists";/);
  assert.ok(!/shownView = lock \?/.test(SALESPAGE), "the sheet-only pin is gone, not merely bypassed");
  for (const v of ["day", "lists", "pipeline", "firms"]) {
    assert.ok(SALESPAGE.includes(`{shownView === "${v}" && (`), `the ${v} view still reads raw view state`);
  }
  /* THE TILES COUNT WHAT THE LIST UNDER THEM DRAWS.
   *
   * They used to count the page's whole set with no filter at all. Harmless
   * while the floor had no tiles; a defect the moment four came back, because
   * the availability switch could be on Mine while "Meetings + proposals"
   * counted every unclaimed one too. Found by an adversarial review the same
   * day the tiles were restored. */
  assert.match(SALESPAGE, /const all = lock \? byAvailability\(scopeLeads, availability, member\) : scopeLeads;/,
    "the tiles must count through the availability switch on a locked page");
  /* My Day counts through the availability switch AND the watch list now — the
   * watch was added on 30 Aug and the queue was the one view it did not reach,
   * so a chip stayed lit over a queue it did not filter. Matched on the shape
   * rather than the exact expression, which changed for a good reason. */
  assert.match(SALESPAGE, /return salesQueue\(lock \? byAvailability\(base, availability, member\) : base, \{/,
    "and so must My Day, which now sits under that switch");
  assert.match(SALESPAGE, /const base = listWatch\s*\n?\s*\? scopeLeads\.filter/,
    "My Day must also obey the safety-net list, or the chip lies about what it filters");
  // The tab number is tabScope, which IS the page's set — see the next test.
  assert.match(SALESPAGE, /\{allTabLabel\} <span>\{tabScope\.length\}<\/span>/);
});

/* ================================================================== */
/* THE FOUR DEFECTS A CHECKER FOUND ON THE REP'S TWO PAGES            */
/* Aug 26 2026. Every one of these has a click sequence behind it.     */
/* ================================================================== */

const SHEETJSX = srcOf("src/components/admin/salesSheet.jsx");
const DATAJS = srcOf("src/lib/data.js");

test("1 — a rep cannot open a lead that is not on their page, however they arrive", () => {
  /* #/dashboard/mine?lead=<a lead another rep owns> opened the drawer on it:
   * full timeline, every field editable, and the drawer's own Claim and Release
   * buttons, from a page called "My leads". Both readers checked board.leads —
   * the whole board, which getSalesBoard loads for every role. */
  assert.match(SALESPAGE, /const openLeadById = useCallback\(\(id\) => \{/,
    "opening has to be one guarded call, not setOpenId handed out");
  /* REPOINTED Aug 27 2026, NOT WEAKENED.
   *
   * The old guard refused an id outside the page's narrowed set. The set is not
   * narrowed any more — a rep sees every lead — so that check would now pass for
   * everything and the guard would be theatre. What replaced it:
   *
   *   an id not in the rows we loaded  -> refused, and told why
   *   an id in the rows, not editable  -> opens READ-ONLY, no buttons at all
   *   an id in the rows, editable      -> opens as it always did
   *
   * Read-only rather than refused IS the requirement: a rep has to be able to see
   * that somebody else is already in this building. So the thing to assert is
   * that the read-only decision exists and comes from the one helper. */
  /* AND REPOINTED BACK, 30 Aug 2026, at the set that narrows again.
   * The Aug 27 version checked the whole board, which was the page's own set
   * that day. It is not any more, so checking it would be the Aug 26 hole
   * rebuilt: an address reaching a record the page refuses to list. */
  assert.match(SALESPAGE, /if \(!scopeLeads\.some\(\(l\) => l\.id === id\)\) \{/,
    "the guard has to check the page's OWN set, not the whole board");
  assert.ok(
    !/board\.leads\.some\(\(l\) => l\.id === linkedLeadId\)/.test(SALESPAGE),
    "and the ?lead= pre-check must read the same set as the guard, or they disagree",
  );
  assert.match(SALESPAGE, /readOnly=\{!canEditLead\(openLead, member\)\}/,
    "the drawer's read-only state must come from the ONE editability helper");
  const PROF = srcOf("src/components/admin/salesProfile.jsx");
  assert.match(PROF, /if \(readOnly\) \{/, "the Work tab has to have a read-only body, not disabled buttons");
  assert.match(PROF, /Read-only — \{heldByName\} holds this one\./,
    "and it has to say whose it is, where somebody would look for a button");

  // Nothing may set openId except the guard and the close button.
  const sets = SALESPAGE.match(/setOpenId\([^)]*\)/g) || [];
  assert.deepEqual([...new Set(sets)].sort(), ["setOpenId(id)", "setOpenId(null)"],
    `setOpenId is called with something else: ${sets.join(", ")}`);
  // ...and no view is handed the raw setter any more.
  assert.ok(!SALESPAGE.includes("onOpen={setOpenId}"), "a view still opens leads without the guard");
  assert.equal((SALESPAGE.match(/onOpen=\{openLeadById\}/g) || []).length, 4,
    "all four views open through the guard");

  // The deep link goes through it too.
  /* Repointed with the guard, 30 Aug 2026 — same set, same sentence. */
  assert.match(SALESPAGE, /if \(scopeLeads\.some\(\(l\) => l\.id === linkedLeadId\)\) openLeadById\(linkedLeadId\);/);

  // Silence is the wrong answer: a rep following a stale link is told why.
  assert.match(SALESPAGE, /toast\.error\("That contact is not on this page"/);
  for (const [mode, cfg] of Object.entries(MODES)) {
    assert.ok(cfg.notOnPage && cfg.notOnPage.length > 20, `${mode} has no refusal to say`);
    /* THE OLD WORDING DESCRIBED A LOCK THAT NO LONGER EXISTS. "Somebody has
     * claimed this one, so it is on their page now" was true when the page held
     * only unclaimed rows; the page holds every row now, so the only reason left
     * is that the contact is not in what was loaded. A refusal that names a cause
     * that cannot be the cause sends somebody chasing advice that cannot work. */
    assert.ok(!/claimed this one/i.test(cfg.notOnPage),
      `${mode} still explains the refusal with a lock that was removed`);
  }
});

test("2 — no number on a locked page counts rows the sheet is not showing", () => {
  /* A rep holding 3 won leads and nothing open read "All lists 3" over
   * "Nothing matches those filters" — the tab counted from scopeLeads, which is
   * not stage-filtered, while the sheet defaults to open only. On the floor the
   * tab is the only number on the page, and it was counting lost rows. */
  assert.match(
    SALESPAGE,
    /const tabScope = useMemo\(\s*\n\s*\(\) => \(lock \? filterLeads\(scopeLeads, \{ skipList: true \}\) : scopeLeads\),/,
    "a locked page's tabs must count from the filtered set, minus the tabs' own filter",
  );
  // The owner keeps the old convention — the same expression says both.
  assert.match(SALESPAGE, /tabScope=\{tabScope\}/);
  // Per-list tabs too, not just "All lists".
  assert.match(SALESPAGE, /const n = tabScope\.filter\(\(x\) => x\.list_id === l\.id\)\.length;/);
  // scopeLeads survives for exactly one job: which empty screen is true.
  assert.ok(!/<span>\{scopeLeads\.length\}<\/span>/.test(SALESPAGE),
    "a tab is still printing the unfiltered count");
});

test("2 — a Clear button that cannot change anything is not drawn", () => {
  // Compared against the page's OWN opening values, so the default stage box —
  // a filter nobody set — does not count as something to clear.
  assert.match(SALESPAGE, /const canClear = \(\s*\n\s*q\.trim\(\) !== "" \|\| listFilter !== tileOff\.list \|\| stageFilter !== tileOff\.stage/);
  assert.match(SALESPAGE, /\|\| ownerFilter !== tileOff\.owner \|\| tileFilter !== null/);
  assert.match(SALESPAGE, /canClear=\{canClear\}/);
  assert.match(SALESPAGE, /\{scopeLeads\.length && canClear\s*\n\s*\? <button className="btn" style=\{\{ marginTop: 12 \}\} onClick=\{onClear\}>Clear the filters<\/button>/);
  // And the third empty screen exists: nothing to clear, and rows still hidden.
  assert.match(SALESPAGE, /const stageHiding = !canClear && scopeLeads\.length > 0 && finished === scopeLeads\.length;/,
    "the 'they are all finished' sentence has to be counted, not inferred");
  assert.match(SALESPAGE, /const finished = useMemo\(\(\) => scopeLeads\.filter\(\(l\) => !isOpenStage\(l\.stage\)\)\.length, \[scopeLeads\]\);/);
  assert.match(SALESPAGE, /"Nothing open here right now\."/);
  assert.match(SALESPAGE, /Set the stage box to \"Every stage\" to see/,
    "the empty screen has to name the control that would actually help");
});

test("3 — the column the Claim button lives in cannot be switched off on the floor", () => {
  /* Columns → uncheck "Sales Owner" → every Claim button gone, permanently
   * (one localStorage key, shared by every page that draws this sheet) under a
   * hint that still read "press Claim to take it". */
  assert.match(SHEETJSX, /const pinned = claimAs \? "owner" : null;/,
    "the pin has to be tied to claimAs, which is what 'you claim from this page' means");
  assert.match(SHEETJSX, /const shownKeys = pinned && !columns\.includes\(pinned\)/);
  assert.match(SHEETJSX, /const visible = SHEET_COLUMNS\.filter\(\(c\) => shownKeys\.includes\(c\.key\)\);/,
    "the table must render from the pinned list, not the saved one");
  // The saved preference is untouched, so the owner's page still honours it.
  /* The preference grew a third field on 31 Aug — `seen`, the keys that existed
   * when it was saved — so a column added later can tell whether this person has
   * ever been offered it. Matched on the shape rather than the exact object,
   * which changed for a good reason: a test pinned to a literal fails every time
   * the literal is extended correctly. */
  assert.match(SHEETJSX, /useEffect\(\(\) => \{ savePrefs\(\{ columns, groupBy[^}]*\}\); \}, \[columns, groupBy\]\);/);
  assert.match(SHEETJSX, /seen: SHEET_COLUMN_KEYS/,
    "the preference has to record what was on offer, or a new column stays invisible");
  // The menu says why rather than looking broken.
  assert.match(SHEETJSX, /disabled=\{last \|\| isPinned\}/);
  assert.match(SHEETJSX, /The Claim button lives in this column/);
  // And the menu's own state reads the pinned list, or the tick would be wrong.
  assert.match(SHEETJSX, /const on = shownKeys\.includes\(c\.key\);/);
});

test("4 — the Claim button cannot fire twice", () => {
  assert.match(SHEETJSX, /const \[claiming, setClaiming\] = useState\(null\);/);
  assert.match(SHEETJSX, /disabled=\{busy\}/);
  assert.match(SHEETJSX, /if \(claiming === row\.id\) return;/,
    "disabled is what a person sees; this is what a queued second event meets");
  assert.match(SHEETJSX, /try \{ await onAssign\(row, claimAs\); \} finally \{ setClaiming\(null\); \}/);
  // My Day's Claim button is the same button and gets the same guard.
  assert.match(SALESPAGE, /if \(claimingId\) return;\s*\n\s*setClaimingId\(lead\.id\);/);
  assert.match(SALESPAGE, /disabled=\{claimingId === l\.id\}/);
});

test("4 — the write refuses a lead somebody already holds, in both branches", () => {
  /* claimLead was an unconditional update. Two reps inside the reload window
   * both got a green "Claimed", two "Claimed by X" rows were written, and
   * claimed_at was re-stamped — restarting the 3-business-day clock. */
  assert.match(DATAJS, /expectUnclaimed = false \} = \{\}\) \{/,
    "opt-in, or the owner's reassign-to-another-rep dropdown would start refusing");
  assert.match(DATAJS, /if \(expectUnclaimed\) query = query\.is\("owner_id", null\);/,
    "the database has to decide, not a read a moment earlier");
  assert.match(DATAJS, /const \{ data, error \} = await query\.select\("id"\);/,
    "the rows the predicate let through have to come back in the same statement");
  assert.match(DATAJS, /done = expectUnclaimed \? \(data \|\| \[\]\)\.map\(\(r\) => r\.id\) : ids;/);

  // THE PREVIEW BRANCH IS NOT LOOSER THAN THE LIVE ONE. Bitten twice before.
  assert.match(DATAJS, /if \(expectUnclaimed && previewStore\.leads\[i\]\.owner_id\) continue;/);
  assert.equal((DATAJS.match(/if \(expectUnclaimed && !done\.includes\(leadId\)\) \{/g) || []).length, 2,
    "both branches must refuse the loser at the same point");
  // One refusal message, shared, so the two cannot drift apart.
  assert.match(DATAJS, /const TAKEN = "Somebody else claimed this lead first, so nothing was written\./);
  // A timeline line only for the leads actually written.
  assert.match(DATAJS, /for \(const id of done\) \{/);
  assert.ok(!/for \(const id of ids\) \{\s*\n\s*await addLeadActivity/.test(DATAJS),
    "a sibling that was already somebody's must not get a 'Claimed by X' it never received");

  /* THE LOSER IS TOLD, ON EVERY PATH THAT CAN LOSE — counted against the paths
   * themselves rather than against a number typed here.
   *
   * It was a hard 2, and it broke the moment a third claim path arrived (the
   * Contacted? cell logs a touch, which claims an unclaimed lead — 30 Aug 2026).
   * A count of the code is a test that has to be edited every time the code is
   * right; a count of one thing against another is a test that keeps meaning
   * what it was written to mean. Every `res.taken` branch must carry the
   * message, and there must be at least the three that exist today. */
  const takenBranches = (SALESPAGE.match(/if \(res\.taken\)/g) || []).length;
  const takenToasts = (SALESPAGE.match(/toast\.error\("Somebody got there first", res\.error\)/g) || []).length;
  assert.ok(takenBranches >= 3, `only ${takenBranches} claim paths check for a lost race`);
  assert.equal(takenToasts, takenBranches,
    `${takenBranches} paths can lose the race but only ${takenToasts} say so`);
  assert.match(SALESPAGE, /expectUnclaimed: !lead\.owner_id/);
  // And the owner's deliberate reassignment is not asserted against.
  assert.ok(!/expectUnclaimed: true/.test(SALESPAGE),
    "the flag must follow what the row said, not be hardcoded on");
});

test("the doc block over the rep's readers is true of the code under it", () => {
  /* It said "Both readers below refuse" when handed no user id. There is one
   * reader below, and it did not refuse: listReminders(undefined) returns
   * everybody's rows and a `userId &&` three files away was the only thing
   * stopping them being counted. The code was made true. */
  const sect = DATAJS.slice(DATAJS.indexOf("THE REP'S WORK PAGE"));
  assert.ok(!/Both readers below refuse/.test(sect), "the comment still claims two refusing readers");
  assert.match(sect, /askRepReport now\s*\n \* returns an error before it reads anything\./);
  const fn = sect.slice(sect.indexOf("export async function askRepReport"));
  const gate = fn.indexOf("if (!userId) {");
  assert.ok(gate > 0, "askRepReport does not refuse without a user id");
  assert.ok(gate < fn.indexOf("listReminders("),
    "the refusal has to come BEFORE anything is read, not after");
});

/* ================================================================== */

console.log("\nSALES — rules and import\n");
console.log(results.join("\n"));
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
