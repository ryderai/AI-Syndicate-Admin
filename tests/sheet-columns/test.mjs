/* THE COLUMN READER, AGAINST THE REAL WORKBOOK.          Aug 30 2026
 *
 * Every rule in lib/sheet-columns.js, pinned to rows copied out of CJ's actual
 * "Sales Team Outreach Master List" — read through the console's own .xlsx
 * reader, so what these tests see is exactly what the browser sees, ".0" on
 * every whole number and all.
 *
 * WHY THE FIXTURE IS THE REAL FILE AND NOT SOMETHING TIDY
 * Three of these seven tabs disagree with their own heading row and a fourth
 * has no heading row at all. A tidy fixture would pass with a reader that
 * simply trusts the headings — which is the reader this replaced, and which
 * imported 36 of 3,673 people while reporting no error whatsoever.
 *
 * `EXPECTED` below was worked out by hand, column by column, by reading the
 * values. If a change makes the reader start trusting headings again, or start
 * guessing where it should decline, these fail.
 *
 * Four bugs found on 30 Aug 2026 have a test each at the bottom. Every one of
 * them was silent: nothing threw, nothing was logged, and the numbers on
 * screen looked plausible.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { mapColumns, detectHeaderRow, scoreColumn, geoRuns, columnSample } from "../../lib/sheet-columns.js";
import {
  guessSalesColumn, SALES_FIELD_KEYS, autoMapTab, looksLikeLeadTab,
  buildImportPlan, mergeLead, mergeCompany,
} from "../../lib/sales-import.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const { fixtures: TABS, expected: EXPECTED } = JSON.parse(readFileSync(join(HERE, "workbook.json"), "utf8"));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").slice(0, 4).join("\n       ")}`); }
}
const map = (name) => mapColumns(TABS[name], { headerGuess: guessSalesColumn, fields: SALES_FIELD_KEYS });

console.log("\nTHE COLUMN READER\n");

/* ================================================================== */
/* 1. Every column of every tab                                        */
/* ================================================================== */

for (const [name, want] of Object.entries(EXPECTED)) {
  test(`${name} — every column lands where reading the values says it should`, () => {
    const r = map(name);
    for (let i = 0; i < want.length; i += 1) {
      assert.equal(r.mapping[i] || "", want[i],
        `column ${i + 1}${r.hasHeader ? ` (headed "${TABS[name][0][i] || ""}")` : ""} holds ${JSON.stringify(String(TABS[name][r.hasHeader ? 1 : 0][i] || "").slice(0, 40))}`);
    }
    for (let i = want.length; i < r.width; i += 1) {
      assert.equal(r.mapping[i] || "", "", `column ${i + 1} was not expected to be used`);
    }
  });
}

test("no field is ever written by two columns", () => {
  for (const name of Object.keys(EXPECTED)) {
    const seen = new Set();
    for (const f of map(name).mapping.filter(Boolean)) {
      assert.ok(!seen.has(f), `${name} maps "${f}" twice — the second would silently overwrite the first`);
      seen.add(f);
    }
  }
});

test("every field the reader produces is a real field key", () => {
  for (const name of Object.keys(EXPECTED)) {
    for (const f of map(name).mapping.filter(Boolean)) {
      assert.ok(SALES_FIELD_KEYS.includes(f), `${name} produced "${f}", which is not a field`);
    }
  }
});

/* ================================================================== */
/* 2. The tab with no heading row                                      */
/* ================================================================== */

test("Luxury Agents is recognised as having NO heading row", () => {
  const r = map("Luxury Agents");
  assert.equal(r.hasHeader, false);
  assert.match(r.headerWhy, /person, not a heading/);
});

test("the old importer's reason for skipping 821 people no longer applies", () => {
  /* looksLikeLeadTab used to read the heading row and nothing else. On this
   * tab it found nothing, said "0 columns could be recognised", and the tab
   * was left unticked on every single import. Nobody noticed, because an
   * unticked tab is not an error. */
  const v = looksLikeLeadTab("Luxury Agents", TABS["Luxury Agents"]);
  assert.equal(v.yes, true, v.why);
  assert.match(v.why, /no heading row/);
});

test("the first person on a tab with no heading row is not eaten as a heading", () => {
  const plan = buildImportPlan(TABS["Luxury Agents"], { listName: "Luxury Agents" });
  assert.ok(plan.leads.some((l) => l.lead.name === "Sabrina Ulicny"),
    "row 1 is a person and must be imported, not read as column headings");
});

test("first and last name are told apart by POSITION, because nothing else can", () => {
  const r = map("Luxury Agents");
  assert.equal(r.mapping[6], "first_name");
  assert.equal(r.mapping[7], "last_name");
  assert.ok(r.notes.some((n) => n.kind === "position"), "the reason must be said out loud");
});

test("the six hand-filled columns are claimed even though all 821 rows are blank", () => {
  const r = map("Luxury Agents");
  assert.deepEqual(r.mapping.slice(0, 6),
    ["sales_owner", "contacted", "status", "first_contact", "last_touch", "next_step"]);
  assert.ok(r.notes.some((n) => n.kind === "template"));
});

/* ================================================================== */
/* 3. The tabs whose heading row lies                                  */
/* ================================================================== */

test("Jewelry: the heading says Website, the column holds LinkedIn — the data wins", () => {
  const r = map("Jewelry");
  const headed = TABS["Jewelry"][0].indexOf("Website");
  assert.equal(guessSalesColumn("Website"), "domain", "the heading really does say website");
  assert.notEqual(r.mapping[headed], "domain", "and the column under it is NOT the website");
  assert.equal(r.mapping[headed], "vertical");
  assert.equal(r.mapping[21], "domain", "the real website is three columns further right");
});

test("Jewelry: the email-verification column is not read as the Sales Owner", () => {
  /* Column 13 holds the word "Verified" on all 70 rows. It scored as a rep
   * name, took Sales Owner, and the real Sales Owner column — which has one
   * name in it — lost and was dropped. */
  const r = map("Jewelry");
  assert.equal(r.mapping[12], "", "the Verified column has no field");
  assert.equal(r.mapping[0], "sales_owner", "and the real one keeps it");
});

test("Car Dealership: the contact's town is not filed as the office address", () => {
  const r = map("Car Dealership");
  assert.equal(r.mapping[22], "address", 'headed "Company Address", holds the contact\'s location line');
  assert.equal(r.mapping[23], "city");
  assert.equal(r.mapping[25], "company_address", 'headed "Company Country", holds the street address');
  assert.equal(r.mapping[26], "company_city");
});

test("Car Dealership: nothing from the second record block is used", () => {
  /* The real tab is 84 columns wide: the list, then a SECOND set of address,
     city, state, country, company address, phone, keywords and revenue columns
     somebody pasted alongside it. On the real file its Keywords column was
     beating the real one by a hundredth of a point. The fixture is the first
     forty rows, where that block is empty; the rule that cuts it is tested on
     its own below. What is checked here is the outcome: nothing past the list
     is ever used. */
  const r = map("Car Dealership");
  for (let i = 32; i < r.width; i += 1) {
    assert.equal(r.mapping[i] || "", "", `column ${i + 1} is past the end of the list`);
  }
});

test("a second company address ends the list, and everything after it is left out", () => {
  /* Built by hand rather than taken from the fixture, because the fixture's
     first forty rows do not reach the second block. These are the two blocks
     the real Car Dealership tab has, side by side, at the smallest size that
     shows the rule working. */
  const rows = [
    ["First Name", "Email", "Website", "Company Address", "Keywords", "", "Company Address", "Keywords"],
    ...Array.from({ length: 8 }, (_, i) => [
      ["Dana", "Wong", "Rami", "Kim", "Alex", "Sam", "Jo", "Lee"][i],
      `p${i}@audimv.com`, "https://audimv.com",
      `${100 + i} Marguerite Pkwy, Mission Viejo, California, United States, 92692`,
      "Google Search Console, Akamai CDN, Microsoft 365, Facebook Pixel, Google Tag Manager, Adobe Experience Cloud",
      "",
      `${900 + i} Wilshire Blvd, Bellevue, Washington, United States, 98004`,
      "Shopify, Klaviyo, Cloudflare, Google Analytics, Hotjar, YouTube, Open Graph, HTTP/3",
    ]),
  ];
  const r = mapColumns(rows, { headerGuess: guessSalesColumn, fields: SALES_FIELD_KEYS });
  assert.ok(r.notes.some((n) => n.kind === "extra"), "the cut has to be said out loud");
  assert.equal(r.mapping[3], "company_address", "the first block's address is the one used");
  assert.equal(r.mapping[4], "keywords", "and the first block's keywords");
  assert.equal(r.mapping[6] || "", "", "the second block's address is left out");
  assert.equal(r.mapping[7] || "", "", "and its keywords");
});

test("every disagreement between a heading and its data is reported, not swallowed", () => {
  const r = map("Jewelry");
  const overrides = r.notes.filter((n) => n.kind === "override");
  assert.ok(overrides.length >= 8, `expected the Jewelry tab to report its shift, got ${overrides.length}`);
  for (const n of overrides) {
    assert.match(n.why, /^Column \d+ is headed/);
    assert.ok(!/undefined|NaN|\[object/.test(n.why), "a warning nobody can read is not a warning");
  }
});

/* ================================================================== */
/* 4. Whose address is it                                              */
/* ================================================================== */

test("a run of place columns after a STREET address belongs to the firm", () => {
  for (const name of ["Real Estate Marketing Directors", "Jewelry", "Car Dealership"]) {
    const r = map(name);
    const street = r.mapping.indexOf("company_address");
    const city = r.mapping.indexOf("company_city");
    assert.ok(street >= 0 && city > street,
      `${name}: the firm's city must follow the firm's street address, got ${street} then ${city}`);
  }
});

test("a tab with only one place run gives it to the CONTACT", () => {
  const r = map("Luxury Agents");
  assert.equal(r.mapping[18], "city");
  assert.equal(r.mapping[19], "state");
  assert.ok(!r.mapping.includes("company_city"), "there is no second run, so no firm city is invented");
});

test("a tab whose only run STARTS with a street address gives it to the firm", () => {
  const r = map("Medspas");
  assert.ok(!r.mapping.includes("city"), "Medspas has no contact city column");
  assert.equal(r.mapping[23], "company_city");
});

test("geoRuns never claims a column of people's names", () => {
  /* The first version tested "a short word that is not a state", which also
   * describes the Sales Owner column, the Seniority column and half the job
   * titles — and it read "Larry Pike" as a city on five tabs at once. */
  for (const name of Object.keys(EXPECTED)) {
    const rows = TABS[name];
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const hasHeader = detectHeaderRow(rows, { headerMatcher: (c) => !!guessSalesColumn(c) }).hasHeader;
    const columns = [];
    for (let i = 0; i < width; i += 1) {
      const c = columnSample(rows, i, { skipFirst: hasHeader ? 1 : 0 });
      columns.push({ index: i, values: c.values, fill: c.fill, filled: c.filled, content: {} });
    }
    for (const g of geoRuns(columns)) {
      const sample = columns[g.index].values[0] || "";
      assert.ok(!/^(Larry Pike|Brandon|Andrew|Troy|Sawyer|Matt Brown|Verified)/.test(sample),
        `${name} column ${g.index + 1} holds "${sample}" and was called ${g.field}`);
    }
  }
});

/* ================================================================== */
/* 5. The four silent bugs found on 30 Aug 2026                        */
/* ================================================================== */

test("BUG 1 — a decimal number is not a website", () => {
  /* The browser's .xlsx reader returns every whole number with ".0" on it, and
   * the bare-hostname pattern had no letter top-level domain, so "42.0" read
   * as a hostname. The employee-count column took the Website field off the
   * real website column, on three tabs. */
  const s = scoreColumn(["42.0", "110.0", "26.0", "59.0", "15.0", "8.0"]);
  assert.ok(!(s.domain > 0.5), `a column of headcounts scored ${s.domain} as a website`);
  assert.ok(s.employees > 0.8, "and it is recognised as a headcount");
});

test("BUG 2 — scientific notation is a number, not a phone number", () => {
  /* Excel writes ten million as "1.0156E7". The loose phone pattern includes
   * the letters of "ext", so it matched — and the Annual Revenue column lost
   * to a switchboard on three tabs. */
  const s = scoreColumn(["1.0156E7", "5028000.0", "8173000.0", "4.146E7", "3438000.0", "3153000.0"]);
  assert.ok(!(s.company_phone > 0.5), `revenue scored ${s.company_phone} as a phone number`);
  assert.ok(s.annual_revenue > 0.8, "and it is recognised as revenue");
});

test("BUG 2b — a bare ten-digit phone number is still a phone number", () => {
  /* The first fix for BUG 2 refused every number, which took real phone
   * numbers with it. Only a decimal point or an exponent disqualifies one. */
  const s = scoreColumn(["5614062878", "9258660100", "7132227211", "4085597177", "3106592980", "8662765962"]);
  assert.ok(s.company_phone > 0.8, `a column of bare phone numbers scored ${s.company_phone}`);
});

test("BUG 3 — scientific notation reaches the database as the number it is", () => {
  /* Stripping everything but digits, dots and minus signs turned "1.0156E7"
   * into "1.01567", and a firm with ten million dollars of revenue was saved
   * as 1. */
  const plan = buildImportPlan([
    ["Company Name", "Website", "Annual Revenue"],
    ["Eiseman Jewels", "https://eisemanjewels.com", "1.0156E7"],
    ["Polacheck's", "https://polachecks.com", "5028000.0"],
  ], { listName: "t" });
  const rev = plan.companies.map((c) => c.annual_revenue).sort((a, b) => a - b);
  assert.deepEqual(rev, [5028000, 10156000]);
});

test("BUG 4 — a row is not cut short at its first empty cell", () => {
  /* This one lived in src/lib/sheet.js, not here, and it is the reason all of
   * the above went unnoticed for ten days: an empty cell is written
   * `<c r="A2" s="7"/>`, and the row pattern ended at the first `/>`. Every
   * row was cut at its first empty cell. The Jewelry tab came back as 3 rows
   * instead of 71, and the import reported no error at all.
   *
   * Tested here rather than in the reader's own file because the evidence is
   * the fixture: it was read through the fixed reader, so a row that begins
   * with empty cells and still carries a full record is the proof. */
  const jewelry = TABS["Jewelry"];
  const row = jewelry[1];
  assert.equal(String(row[0] || ""), "", "this row starts with an empty cell");
  assert.ok(String(row[11] || "").includes("@"), "and still has the email 12 columns later");
  assert.ok(row.length > 30, `the row is ${row.length} cells long, not truncated`);
});

/* ================================================================== */
/* 6. Nothing is ever deleted                                          */
/* ================================================================== */

console.log("\nNOTHING IS EVER DELETED\n");

test("an empty cell never blanks a value that is already there", () => {
  const before = { name: "Kate Simnitt", title: "Digital Marketing Manager", phone: "+1 555 0000", city: "Houston" };
  const { patch } = mergeLead(before, { name: "Kate Simnitt", title: "", phone: null, city: undefined });
  assert.deepEqual(patch, {}, "a blank column means the export did not have it, not delete it");
});

test("a stage never moves backwards, and a closed deal never reopens", () => {
  assert.deepEqual(mergeLead({ stage: "won" }, { stage: "contacted" }).patch, {});
  assert.deepEqual(mergeLead({ stage: "lost" }, { stage: "meeting" }).patch, {});
  assert.deepEqual(mergeLead({ stage: "proposal" }, { stage: "contacted" }).patch, {});
  assert.equal(mergeLead({ stage: "new" }, { stage: "contacted" }).patch.stage, "contacted",
    "forwards is still allowed");
});

test("a claimed lead is never taken off the rep working it", () => {
  const held = mergeLead({ owner_id: "rep-a" }, { owner_id: "rep-b" });
  assert.equal(held.patch.owner_id, undefined);
  const free = mergeLead({ owner_id: null }, { owner_id: "rep-b", claimed_at: "2026-08-11T12:00:00Z" });
  assert.equal(free.patch.owner_id, "rep-b", "but an unclaimed one can be claimed");
});

test("the timers widen, never narrow", () => {
  const a = mergeLead(
    { first_contact_at: "2026-08-20T12:00:00Z", last_touch_at: "2026-08-20T12:00:00Z" },
    { first_contact_at: "2026-08-11T12:00:00Z", last_touch_at: "2026-08-11T12:00:00Z" },
  );
  assert.equal(a.patch.first_contact_at, "2026-08-11T12:00:00Z", "earliest first contact wins");
  assert.equal(a.patch.last_touch_at, undefined, "an older last touch is ignored");
});

test("a typed next step is kept, and the sheet's version is not thrown away", () => {
  const r = mergeLead({ next_step: "call him Tuesday" }, { next_step: "send the deck" });
  assert.equal(r.patch.next_step, undefined, "what a person typed stays");
  assert.ok(r.spare.some((t) => t.includes("send the deck")), "and the sheet's text survives on the timeline");
});

test("a firm's site score is ours, and no spreadsheet may write it — on INSERT too", () => {
  /* The first version of this test asserted `mergeCompany(...).patch.site_score
   * === undefined` and proved nothing: site_score is not in mergeCompany's
   * field list at all, so the assertion was `undefined === undefined` and it
   * passed with the guard deleted. Meanwhile the INSERT path was writing the
   * score straight from a spreadsheet cell. Both halves are checked now, and
   * the insert half is the one that was actually broken. Found 30 Aug 2026 by
   * an adversarial reviewer. */
  const r = mergeCompany({ site_score: 74 }, { site_score: 99, name: "X" });
  assert.equal(r.patch.site_score, undefined, "an update may not touch it");

  const plan = buildImportPlan([
    ["Company Name", "Website", "Site Score"],
    ["Bishop Ranch", "https://bishopranch.com", "88"],
  ], { listName: "t" });
  assert.equal(plan.companies[0].site_score, null,
    "a firm created by an import has NO score — a number from a spreadsheet and a number we measured must never share a field");
  assert.equal(plan.companies[0].site_score_from_sheet, 88,
    "and the sheet's number is still read, so it can be reported");
});

test("STAGE_ORDER covers every stage the database accepts", () => {
  /* Read out of the migration rather than copied, so the two cannot drift.
   * `researching` was missing, which made a lead the console had at
   * researching score the same as one nobody had touched. */
  const sql = readFileSync(join(HERE, "../../supabase/migrations/0009_sales.sql"), "utf8");
  const block = /admin_leads_stage_check[\s\S]*?check \(stage in \(([\s\S]*?)\)\)/.exec(sql);
  assert.ok(block, "the stage constraint has to be findable");
  const stages = [...block[1].matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
  assert.ok(stages.length >= 12, `only found ${stages.length} stages`);
  for (const st of stages) {
    /* A stage missing from the table scores 0 via `?? 0`, which is silently
     * "never worked" — so it can never be reached and never protects. */
    const forward = mergeLead({ stage: "new" }, { stage: st }).patch.stage;
    const backward = mergeLead({ stage: st }, { stage: "new" }).patch.stage;
    assert.equal(backward, undefined, `${st} must never fall back to new`);
    if (st !== "new") {
      assert.equal(forward, st, `${st} is not reachable — it is missing from STAGE_ORDER`);
    }
  }
});

test("a reopened lead can still be moved on", () => {
  assert.equal(mergeLead({ stage: "reopened" }, { stage: "contacted" }).patch.stage, "contacted");
  assert.equal(mergeLead({ stage: "contacted" }, { stage: "reopened" }).patch.stage, undefined);
});

test("text is not zero", () => {
  /* "N/A".replace(/[^0-9.-]/g,"") is "" and Number("") is 0, so a cell reading
   * N/A was saved as a revenue of zero, a headcount of zero and a site score
   * of zero — and 0/100 is a real score meaning the site failed everything. */
  const plan = buildImportPlan([
    ["Company Name", "Website", "Annual Revenue", "# Employees", "Total Funding"],
    ["Acme", "https://acme.com", "N/A", "unknown", "--"],
  ], { listName: "t" });
  const c = plan.companies[0];
  assert.equal(c.annual_revenue, null);
  assert.equal(c.employees, null);
  assert.equal(c.total_funding, null);
  /* And a null must never overwrite a real figure on the way back in. */
  assert.deepEqual(mergeCompany({ annual_revenue: 10156000 }, { annual_revenue: null }).patch, {});
});

test("a weak match never rewrites one person with another", () => {
  /* Colleagues at a firm share a switchboard and a website, and the dedupe key
   * falls back to both. Under an email match the sheet refreshes who somebody
   * is; under anything weaker it must not. */
  const existing = { name: "Agent A", title: "Broker", email: "a@firm.com", city: "" };
  const incoming = { name: "Agent B", title: "Realtor", city: "Houston" };
  for (const kind of ["p", "d", "c"]) {
    const r = mergeLead(existing, incoming, { keyKind: kind });
    assert.equal(r.patch.name, undefined, `matched on ${kind}: the name must not move`);
    assert.equal(r.patch.title, undefined, `matched on ${kind}: the title must not move`);
    assert.equal(r.patch.city, "Houston", `matched on ${kind}: a plain fact still fills in`);
    assert.ok(r.spare.some((t) => t.includes("Agent B")), "and the discarded value is kept for the timeline");
  }
  const sure = mergeLead(existing, incoming, { keyKind: "e" });
  assert.equal(sure.patch.name, "Agent B", "an email match is certain enough to refresh");
});

test("a claim writes its dates AND says so", () => {
  const r = mergeLead({ owner_id: null }, {
    owner_id: "rep-a", claimed_at: "2026-08-11T12:00:00Z", cadence_started_at: "2026-08-11T12:00:00Z",
  });
  assert.equal(r.patch.claimed_at, "2026-08-11T12:00:00Z");
  assert.ok(r.changes.some((c) => /chase clock/.test(c)),
    "the cadence clock decides when somebody is chased — starting it silently is not acceptable");
});

/* ---- the rules that had no test until an adversarial pass looked ---- */

test("a column with almost nothing in it does not win a field", () => {
  /* Three stray emails at the bottom of a nine-hundred-row column must not
   * make it the email column. MIN_SAMPLE holds a thin column back in
   * proportion; the floor does the rest. */
  const three = ["a@x.com", "b@x.com", "c@x.com"];
  const thin = scoreColumn(three, { filled: 3, seen: 900 });
  assert.ok(!(thin.email >= 0.5), `three values in nine hundred rows scored ${thin.email} and would have taken the field`);

  /* The same three values in a THREE-row pasted list are the email column, and
   * are meant to be recognised — somebody pasting three rows out of Sheets is
   * a real thing this has to handle. That is the trade the relative threshold
   * buys, and it is the right way round: a thin column in a big tab is a
   * mistake, a full column in a small tab is a small list.
   *
   * (This assertion first read `!(small.email >= 0.5)` — a test written for
   * behaviour nobody actually wanted, which would have forced the wrong fix
   * into the code it was checking.) */
  const small = scoreColumn(three, { filled: 3, seen: 3 });
  assert.ok(small.email >= 0.5, "three of three rows IS the email column");
  const eight = ["a", "b", "c", "d", "e", "f", "g", "h"].map((c) => `${c}@x.com`);
  assert.ok(scoreColumn(eight, { filled: 8, seen: 8 }).email > 0.9, "eight of eight is enough to be sure");
  assert.ok(!(scoreColumn(eight, { filled: 8, seen: 900 }).email >= 0.5),
    "eight in nine hundred rows is not");
});

test("a job title column is not read as a next step", () => {
  /* A next-step column is mostly empty — it holds the rows somebody has
   * worked. A column that is full on every row is a job title, and reading 821
   * job titles as next steps is how the Luxury Agents tab lost its Title
   * column. The `sparse` factor is what separates them. */
  const titles = Array.from({ length: 30 }, (_, i) => ["Director of Marketing", "Vice President, Marketing", "Real Estate Broker"][i % 3]);
  const s = scoreColumn(titles, { fill: 1, filled: 30 });
  assert.ok(s.title > (s.next_step || 0), `title ${s.title} did not beat next step ${s.next_step}`);
});

test("a first-name column with no surname beside it is left out", () => {
  /* Nothing in the values tells a given name from a town. What does is that an
   * export writes the name columns side by side. */
  const rows = [
    ["Sabrina Ulicny", "1031 Crowdfunding LLC", "Los Angeles"],
    ["Dana Wong", "Audi Mission Viejo", "Mission Viejo"],
    ["Rami Alsharif", "Dublin Honda", "Dublin"],
    ["Kim Lee", "Bishop Ranch", "Walnut Creek"],
    ["Alex Ray", "Ohana Real Estate", "Austin"],
    ["Sam Fox", "Berry Law", "Houston"],
    ["Jo Kim", "Amaro Law Firm", "Dallas"],
    ["Lee Park", "Daly Black PC", "Denver"],
    ["Pat Cole", "GLP Attorneys", "Seattle"],
    ["Max Hall", "Corr Cronin LLP", "Boise"],
  ];
  const r = autoMapTab(rows);
  assert.equal(r.hasHeader, false, "there is no heading row, so all ten are people");
  assert.equal(r.mapping[0], "name");
  assert.equal(r.mapping[1], "company");
  assert.ok(!r.mapping.includes("first_name"), "the town column must not be read as a first name");
  const plan = buildImportPlan(rows, { listName: "t" });
  assert.equal(plan.counts.usable, 10, "nobody is eaten as a heading row");
  assert.equal(plan.leads[0].lead.name, "Sabrina Ulicny");
});

test("an empty column with the right heading loses to a full column of the real thing", () => {
  const rows = [
    ["First Name", "Company Name", "Email", "Corporate Phone", "Website"],
    ...["Dana", "Wong", "Rami", "Kim", "Alex", "Sam", "Jo", "Lee", "Pat", "Max", "Ana", "Ivy", "Ted", "Ray"]
      .map((f, i) => [f, "", `Bishop Ranch ${i}`, `d${i}@a.com`, `+1 555-000-00${10 + i}`, `https://a${i}.com`]),
  ];
  const r = mapColumns(rows, { headerGuess: guessSalesColumn, fields: SALES_FIELD_KEYS });
  assert.equal(r.mapping[1] || "", "", "the empty column headed Company Name gets nothing");
  assert.equal(r.mapping[2], "company", "the fourteen real firm names do");
});

test("a second email column does not cut the list short", () => {
  /* A work address and a personal one is normal. Treating a repeated email as
   * the start of a second record threw away six real columns after it. */
  const F = ["Dana", "Wong", "Rami", "Kim", "Alex", "Sam", "Jo", "Lee", "Pat", "Max", "Ana", "Ivy", "Ted", "Ray"];
  const L = ["Wexler", "Cliff", "Alsharif", "Park", "Ray", "Fox", "Kim", "Nash", "Cole", "Hall", "Reid", "Vance", "Oaks", "Bell"];
  const rows = F.map((f, i) => [
    "", "", "", "", "", "", f, L[i], "Director of Marketing", `Acme Holdings ${i}`,
    `w${i}@acme.com`, `p${i}@gmail.com`, `+1 555-000-00${10 + i}`, `https://acme${i}.com`,
    `http://www.linkedin.com/in/x${i}`, "Houston", "Texas", "United States",
  ]);
  const r = mapColumns(rows, { headerGuess: guessSalesColumn, fields: SALES_FIELD_KEYS });
  assert.equal(r.mapping[13], "domain", "the website after the second email is still read");
  assert.equal(r.mapping[15], "city");
  assert.equal(r.mapping[17], "country");
});

test("a column of phone numbers is never read as revenue", () => {
  /* Every tab carries the switchboard twice. The second copy scored below the
   * floor as a phone and 0.95 as revenue, so a dealership was imported with
   * five and a half billion dollars. */
  const phones = ["5614062878", "9258660100", "7132227211", "4085597177", "3106592980", "8662765962", "2143696100"];
  const s = scoreColumn(phones);
  assert.ok(!(s.annual_revenue > 0.5), `bare phone numbers scored ${s.annual_revenue} as revenue`);
});

test("a place run with nothing to anchor it says it is guessing", () => {
  const F = ["Dana", "Wong", "Rami", "Kim", "Alex", "Sam", "Jo", "Lee", "Pat", "Max", "Ana", "Ivy"];
  const rows = [
    ["First Name", "Email", "City", "State", "Country"],
    ...F.map((f, i) => [f, `${f}${i}@x.com`, ["Houston", "Dallas", "Austin"][i % 3], "Texas", "United States"]),
  ];
  const r = mapColumns(rows, { headerGuess: guessSalesColumn, fields: SALES_FIELD_KEYS });
  assert.ok(r.notes.some((n) => n.kind === "geo"),
    "with no street address beside them, whose town it is cannot be known from the values — that has to be said");
});

test("every change is named in words a person can check", () => {
  const r = mergeLead({ title: "", stage: "new" }, { title: "CMO", stage: "contacted" });
  assert.deepEqual(r.changes, ["title filled in", "moved from new to contacted"]);
});

/* ================================================================== */
/* 7. Reading the whole workbook, end to end                           */
/* ================================================================== */

console.log("\nTHE WHOLE WORKBOOK\n");

test("every lead tab is recognised, and the two empty ones and the rules tab are not", () => {
  for (const name of Object.keys(EXPECTED)) {
    assert.equal(looksLikeLeadTab(name, TABS[name]).yes, true, `${name} should import`);
  }
  assert.equal(looksLikeLeadTab("Rules of Engagement", [["AI SYNDICATE — OUTREACH LIST"], ["First come, first served."]]).yes, false);
  assert.equal(looksLikeLeadTab("Template", [TABS.Medspas[0]]).yes, false, "headings with nobody under them is not a list");
});

test("autoMapTab and buildImportPlan agree — the tab is never read twice differently", () => {
  for (const name of Object.keys(EXPECTED)) {
    const a = autoMapTab(TABS[name]);
    const p = buildImportPlan(TABS[name], { listName: name });
    assert.deepEqual(p.mapping, a.mapping, `${name} was read two different ways`);
    assert.equal(p.hasHeader, a.hasHeader);
  }
});

test("nothing in the sheet is dropped for want of a column", () => {
  /* The five fields migration 0025 added. Each was being read and thrown away
   * before it, on every import. */
  const car = buildImportPlan(TABS["Car Dealership"], { listName: "Car Dealership" });
  assert.ok(car.leads.some((l) => l.lead.address), "the contact's own location line");
  assert.ok(car.leads.some((l) => l.lead.country), "the contact's country");
  assert.ok(car.companies.some((c) => c.alias), "the firm's name for emails");
  assert.ok(car.companies.some((c) => c.keywords), "the keyword list");
});

test("the whole workbook reads as thousands of people, not dozens", () => {
  /* The number is the point. Before 30 Aug 2026 this workbook imported 36
   * people and said nothing was wrong. */
  let people = 0;
  for (const name of Object.keys(EXPECTED)) {
    people += buildImportPlan(TABS[name], { listName: name }).counts.usable;
  }
  assert.ok(people >= 270, `only ${people} people read out of the fixture's 7 x 39 rows`);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
