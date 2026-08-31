/* THE FLOOR — THE LOCK IS ON THE ROW, AND THERE IS ONLY ONE READ.
 *
 * The pure half of the Floor rebuild (Aug 27 2026). Plain node against the real
 * modules the browser loads — no mocks of our own code, because a test that
 * agrees with a stub is not a test. This repo learned that when three files
 * wrote column names the tables do not have and every fixture had invented the
 * same wrong names.
 *
 * WHAT THIS FILE IS FOR, in one line each:
 *   1. canEditLead() is the whole feature. Nothing may re-derive it and it must
 *      fail CLOSED — a page that does not know who is looking at it gets a
 *      read-only row.
 *   2. The three-state availability switch is a FILTER over one board, never a
 *      second fetch.
 *   3. Filters stack: AND across columns, OR inside one column.
 *   4. Every band is null-safe. A firm with no score is not the worst site
 *      anybody has seen.
 *   5. One source, three layouts — asserted by reading the components as text,
 *      because "the page fetches its own leads" is not a thing a unit test on a
 *      pure module can ever notice.
 *
 * The row-level lock's WORKING half is RLS, and that is proven by
 * tests/floor-scoping/sql.sh against a real Postgres. This file only proves the
 * polite half agrees with it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isOpenStage } from "../../lib/sales-rules.js";
import {
  canEditLead, heldByLabel,
  AVAILABILITY, cleanAvailability, availabilityOf, byAvailability, availabilityCounts,
  facetValue, facetValuesOf, facetValuesMulti, matchesFacets, applyFacets,
  toggleFacetValue, clearFacet, anyFacetOn, facetChips,
  scoreBandOf, sizeBandOf, touchBandOf, readCount,
  readCompanyReport, newestReportByCompany,
  sortValue, sortRowsBy, sheetRows,
  /* 30 Aug 2026 — who may SEE a lead, and the firm marker that replaces what
   * the old see-everything rule was protecting. */
  visibleToMember, firmsHeldByOthers, FIRM_BUSY_LABEL,
} from "../../src/lib/salesSheet.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, "..", "..", p), "utf8");

/* ------------------------------------------------------------------ */
/* Who is looking                                                      */
/* ------------------------------------------------------------------ */
const REP = { user_id: "u-rep", role: "sales", full_name: "Larry Pike" };
const REP2 = { user_id: "u-rep2", role: "sales", full_name: "Brandon Roberts" };
const OWNER = { user_id: "u-owner", role: "owner", full_name: "CJ Britton" };
const ADMIN = { user_id: "u-admin", role: "admin", full_name: "Andrew Soncini" };
const teamName = (id) => ({
  "u-rep": "Larry Pike", "u-rep2": "Brandon Roberts",
  "u-owner": "CJ Britton", "u-admin": "Andrew Soncini",
}[id] || null);

const MINE = { id: "l1", owner_id: "u-rep", stage: "new" };
const THEIRS = { id: "l3", owner_id: "u-rep2", stage: "contacted" };
const FLOOR_NULL = { id: "l2", owner_id: null, stage: "new" };
const FLOOR_UNDEF = { id: "l2b", stage: "new" };

console.log("\ncanEditLead — THE ONE EDITABILITY CHECK IN THE CONSOLE");
ok("a rep may edit a lead they hold", canEditLead(MINE, REP) === true);
/* BOTH shapes of "nobody holds this". Supabase returns null, a row built in the
 * browser before a save has the key missing, and `=== null` would have let one
 * of the two through and locked the other out. */
ok("a rep may edit a lead nobody holds (owner_id null)", canEditLead(FLOOR_NULL, REP) === true);
ok("a rep may edit a lead nobody holds (owner_id absent entirely)", canEditLead(FLOOR_UNDEF, REP) === true);
ok("a rep may NOT edit another rep's lead", canEditLead(THEIRS, REP) === false);
ok("an owner may edit anybody's lead", canEditLead(THEIRS, OWNER) === true);
ok("an admin may edit anybody's lead", canEditLead(THEIRS, ADMIN) === true);
ok("an owner may edit a lead nobody holds", canEditLead(FLOOR_NULL, OWNER) === true);
/* THE FAIL-CLOSED ONES. `member` is null on exactly one code path, and a
 * fail-open default would hand the whole floor to a page that does not know who
 * is looking at it. */
ok("a NULL member gets a read-only row, never an editable one", canEditLead(MINE, null) === false);
ok("an UNDEFINED member gets a read-only row too", canEditLead(MINE, undefined) === false);
/* A ROLE THAT IS PRESENT BUT UNKNOWN keeps working. That is the deliberate
 * direction of the check and it is the right one: the roles that exist are
 * constrained where they are decided (admin_users.role, 0001), and a role added
 * next month must not silently lose the ability to work. */
ok("a member with a role nobody taught this file about keeps working — that is the deliberate direction",
  canEditLead(THEIRS, { user_id: "u-x", role: "manager" }) === true);
/* ...BUT THE ABSENCE OF A ROLE IS NOT AN UNKNOWN ROLE, and the two are being
 * conflated. A member object with no `role` at all is the FAIL-OPEN case
 * src/components/AdminDashboard.jsx:36-43 names in its own words — "A member
 * with no role FAILS OPEN in three places ... SalesPage reads `role !== \"sales\"`
 * and hands out the admin controls" — and the guard that file relies on to stop
 * it (`if (!member) return null`, line 162) cannot fire, because line 47 builds
 * `member` with an object spread and `{ ...null, user_id: x }` is a truthy
 * object. So a signed-in user with no admin_users row would reach this function
 * as `{ user_id }` with no role, and be handed every lead on the floor.
 *
 * BOTH HALVES ARE FIXED NOW, and they had to be fixed together: canEditLead
 * refuses a member with no role, and AdminDashboard stopped spreading a null
 * membership into a truthy object, so the guard its own comment relies on can
 * actually fire. Aug 27 2026. */
ok("a member with NO role must not be handed another rep's lead — the absence of a role is not an unknown role",
  canEditLead(THEIRS, { user_id: "u-x" }) === false,
  "canEditLead returned TRUE for a member with no role — src/lib/salesSheet.js conflates \"a role we do not know\" with \"no role at all\"");
ok("a null lead is not editable", canEditLead(null, OWNER) === false);
ok("an undefined lead is not editable", canEditLead(undefined, OWNER) === false);
ok("a rep whose id is missing cannot edit an OWNED lead by accident",
  canEditLead(THEIRS, { role: "sales" }) === false);

/* Read as TEXT, because the DIRECTION the check is written in is the thing being
 * pinned and no amount of black-box probing can see it. `member.role !== "sales"`
 * means a role nobody has taught this file about keeps working; an
 * ["owner","admin"] allow-list would silently strip a future role of the ability
 * to work, which is a worse failure than the one it guards against — the roles
 * that exist are constrained where they are decided, in admin_users.role (0001). */
const SHEET_SRC = src("src/lib/salesSheet.js");
const CAN_EDIT_SRC = SHEET_SRC.slice(
  SHEET_SRC.indexOf("export function canEditLead"),
  SHEET_SRC.indexOf("export function heldByLabel"),
);
ok("the rule is written as `member.role !== \"sales\"` — a NOT-SALES test, so an unknown role keeps working rather than silently losing the floor",
  /member\.role\s*!==\s*"sales"/.test(CAN_EDIT_SRC), CAN_EDIT_SRC);
ok("...and NOT as an owner-or-admin allow-list, which would lock out any role added later",
  !/\bincludes\s*\(/.test(CAN_EDIT_SRC) && !/===\s*"owner"/.test(CAN_EDIT_SRC), CAN_EDIT_SRC);
ok("...and it fails closed on a missing member in the first line of the function",
  /if\s*\(!lead\s*\|\|\s*!member\)\s*return false;/.test(CAN_EDIT_SRC), CAN_EDIT_SRC);

console.log("\nheldByLabel — A MARKER ON YOUR OWN ROW IS NOISE");
eq("no marker on a lead you hold", heldByLabel(MINE, REP, teamName), null);
eq("no marker on a lead nobody holds", heldByLabel(FLOOR_NULL, REP, teamName), null);
eq("no marker for an owner, who may edit everything", heldByLabel(THEIRS, OWNER, teamName), null);
eq("another rep's row names who has it", heldByLabel(THEIRS, REP, teamName), "Held by Brandon Roberts");
eq("with no teamName function it still says something true", heldByLabel(THEIRS, REP, null), "Held by another rep");
eq("a name the team list does not know falls back rather than printing 'null'",
  heldByLabel({ id: "q", owner_id: "u-gone" }, REP, teamName), "Held by another rep");

console.log("\nTHE AVAILABILITY SWITCH — A FILTER OVER ONE BOARD, NOT A SECOND FETCH");
eq("the three states, in the order the bar draws them", AVAILABILITY, ["mine", "available", "all"]);
/* A typo in a stored preference must show a rep TOO MUCH of their own company's
 * pipeline, which is harmless because visibility is deliberately wide — never
 * `mine`, which hides rows they hold and makes the page look broken. */
eq("junk falls back to `all` — too much is harmless here, too little looks broken", cleanAvailability("banana"), "all");
eq("null falls back to `all`, not to `mine`", cleanAvailability(null), "all");
eq("undefined falls back to `all`, not to `mine`", cleanAvailability(undefined), "all");
eq("an empty string falls back to `all`, not to `mine`", cleanAvailability(""), "all");
eq("a real value survives", cleanAvailability("mine"), "mine");

eq("a lead nobody holds is available", availabilityOf(FLOOR_NULL, REP), "available");
eq("a lead with the key missing is available too", availabilityOf(FLOOR_UNDEF, REP), "available");
eq("your own is mine", availabilityOf(MINE, REP), "mine");
eq("somebody else's is a THIRD state, never folded into either", availabilityOf(THEIRS, REP), "theirs");
eq("with no member, nothing is claimed to be yours", availabilityOf(MINE, null), "theirs");

const SWITCH_LEADS = [MINE, FLOOR_NULL, FLOOR_UNDEF, THEIRS, { id: "l4", owner_id: "u-rep", stage: "proposal" }];
eq("mine is the rows you hold", byAvailability(SWITCH_LEADS, "mine", REP).map((l) => l.id), ["l1", "l4"]);
eq("available is the rows nobody holds", byAvailability(SWITCH_LEADS, "available", REP).map((l) => l.id), ["l2", "l2b"]);
eq("all is everything, including the ones you cannot edit",
  byAvailability(SWITCH_LEADS, "all", REP).map((l) => l.id), ["l1", "l2", "l2b", "l3", "l4"]);
/* `all` hands BACK THE SAME ARRAY, not a copy: the caller never mutates it and
 * copying two thousand rows on every keystroke is a page that feels slow for no
 * reason. Asserted on identity, because a `.slice()` would pass a deep-equal. */
ok("`all` returns the same array, not a copy", byAvailability(SWITCH_LEADS, "all", REP) === SWITCH_LEADS);
eq("a junk mode is `all`, matching cleanAvailability", byAvailability(SWITCH_LEADS, "nonsense", REP).length, 5);
eq("no leads at all is an empty list, not a crash", byAvailability(null, "mine", REP), []);
eq("with no member, `mine` is empty rather than everybody's book", byAvailability(SWITCH_LEADS, "mine", null), []);

const COUNTS = availabilityCounts(SWITCH_LEADS, REP);
eq("mine counts the rows you hold", COUNTS.mine, 2);
eq("available counts the rows nobody holds", COUNTS.available, 2);
eq("all is the total", COUNTS.all, SWITCH_LEADS.length);
/* The three numbers have to account for every row exactly once, or the button
 * and the list under it disagree. `theirs` has no button, so it is counted here
 * to prove nothing has gone missing. */
const theirs = SWITCH_LEADS.filter((l) => l.owner_id && l.owner_id !== REP.user_id).length;
eq("mine + available + somebody-else's = all, with nothing double-counted and nothing lost",
  COUNTS.mine + COUNTS.available + theirs, COUNTS.all);
ok("every count agrees with the filter it is a count of",
  COUNTS.mine === byAvailability(SWITCH_LEADS, "mine", REP).length
  && COUNTS.available === byAvailability(SWITCH_LEADS, "available", REP).length);
/* COUNTED FROM THE SET IT IS HANDED. Pass it an already-filtered set and every
 * number is a number about the filter, not about the pipeline — which is how a
 * tile ends up disagreeing with the list under it. */
eq("counting from an already-filtered set is what would make the buttons lie",
  availabilityCounts(byAvailability(SWITCH_LEADS, "mine", REP), REP),
  { mine: 2, available: 0, all: 2 });
eq("...while the honest total, from the whole board, is", availabilityCounts(SWITCH_LEADS, REP).all, 5);

/* ------------------------------------------------------------------ */
/* One fixture, built once, for the rest of the file                   */
/* ------------------------------------------------------------------ */
const NOW = "2026-08-27T15:00:00Z";   // 10:00 in Chicago
const at = (d, t = "15:00:00") => `2026-08-${String(d).padStart(2, "0")}T${t}Z`;

const companies = new Map([
  ["co1", { id: "co1", name: "Harborline Realty", domain: "harborline.com", site_score: 58, employees: 24, vertical: "realtor" }],
  ["co2", { id: "co2", name: "Acme Serhant", domain: "acme.com", site_score: null, employees: null, vertical: null }],
  ["co3", { id: "co3", name: "Bright Coast Medspa", domain: "bright.com", site_score: 93, employees: 4, vertical: "medspa" }],
]);
const tagsById = new Map([
  ["t-hot", { id: "t-hot", slug: "hot", label: "Hot", color: "red", sort: 0 }],
  ["t-med", { id: "t-med", slug: "medspa", label: "Medspa", color: "pink", sort: 1 }],
  ["t-qui", { id: "t-qui", slug: "quiet", label: "Quiet", color: "gray", sort: 2 }],
]);
const tagsByLead = new Map([
  ["l1", [{ lead_id: "l1", tag_id: "t-hot", action: "added", at: at(20) }]],
  ["l3", [
    { lead_id: "l3", tag_id: "t-med", action: "added", at: at(20) },
    { lead_id: "l3", tag_id: "t-qui", action: "added", at: at(21) },
  ]],
  /* Added and then taken off again. The tags are an EVENT LOG, so this lead has
   * NO tags right now — and it must therefore filter as "No tags", not vanish. */
  ["l4", [
    { lead_id: "l4", tag_id: "t-hot", action: "added", at: at(20) },
    { lead_id: "l4", tag_id: "t-hot", action: "removed", at: at(22) },
  ]],
]);
const reportByCompany = new Map([
  ["co1", {
    id: "r1", company_id: "co1", ai_access_score: 41, seo_score: 66,
    prompt_sim_hits: 2, prompt_sim_total: 10, findings: [{ id: "f1" }],
    domain: "harborline.com", measured_at: at(20), measured_by: "u-owner", kind: "baseline",
  }],
  ["co3", {
    id: "r2", company_id: "co3", ai_access_score: null, seo_score: 88,
    prompt_sim_hits: null, prompt_sim_total: null, findings: null,
    domain: "bright.com", measured_at: at(24), measured_by: "u-owner", kind: "rescan",
  }],
]);
const LEADS = [
  { id: "l1", name: "Priya Patel", company_id: "co1", stage: "new", owner_id: "u-rep", claimed_at: at(20), city: "Destin", state: "FL", last_touch_at: at(26), created_at: at(20) },
  { id: "l2", name: "Marcus Webb", company_id: "co1", stage: "new", owner_id: null, city: "Destin", state: "AL", created_at: at(18) },
  { id: "l3", name: "Dana Whitfield", company_id: "co1", stage: "contacted", owner_id: "u-rep2", claimed_at: at(19), claim_contacted_at: at(19), last_touch_at: at(13), city: "Mobile", state: "FL", created_at: at(19) },
  { id: "l4", name: "Sarah Chen", company_id: "co3", stage: "proposal", owner_id: "u-rep", claimed_at: at(20), claim_contacted_at: at(20), last_touch_at: at(26), city: "Destin", state: "FL", created_at: at(20) },
  { id: "l5", name: "No Firm Person", company_id: null, stage: "new", owner_id: null, created_at: at(25) },
];
const ctx = {
  companyById: companies, teamName, touchCounts: { l3: 2, l4: 5 }, listById: new Map(),
  now: NOW, tagsByLead, tagsById, reportByCompany, member: REP,
};
const rows = sheetRows(LEADS, ctx);
const byId = (id) => rows.find((r) => r.id === id);

console.log("\nTHE ROW CARRIES THE LOCK, DERIVED ONCE");
eq("your own row is editable", byId("l1").editable, true);
eq("an unclaimed row is editable", byId("l2").editable, true);
eq("another rep's row is not", byId("l3").editable, false);
eq("...and it says who has it", byId("l3").heldBy, "Held by Brandon Roberts");
eq("your own row carries no marker", byId("l1").heldBy, null);
/* A caller that does not say who is looking gets READ-ONLY rows. sheetRow's
 * `member` defaults to null for older callers, and the default has to be the
 * safe one. */
eq("a board built without a member is read-only throughout",
  sheetRows(LEADS, { ...ctx, member: null }).every((r) => r.editable === false), true);

console.log("\nFILTERS THAT STACK — AND ACROSS COLUMNS, OR INSIDE ONE");
eq("a single-valued column returns exactly one value", facetValuesOf(byId("l1"), "state"), ["FL"]);
eq("a single-valued column with nothing in it returns the one string the filter compares",
  facetValuesOf(byId("l5"), "state"), ["__none"]);
eq("tags returns EVERY slug on the row", facetValuesOf(byId("l3"), "tags"), ["medspa", "quiet"]);
eq("one tag is still a one-item list, so every caller has one shape", facetValuesOf(byId("l1"), "tags"), ["hot"]);
/* A row with no tags returns ["__none"] — a REAL value a rep filters FOR. An
 * empty array would make the row match nothing, so it would disappear from every
 * count while still being on the board. */
eq("a lead with no tags is \"__none\", which is a value somebody filters FOR — not an empty list that matches nothing",
  facetValuesOf(byId("l2"), "tags"), ["__none"]);
eq("a lead whose only tag was TAKEN OFF is also \"__none\", because tags are an event log",
  facetValuesOf(byId("l4"), "tags"), ["__none"]);
eq("a row object with no tags key at all does not crash", facetValuesOf({}, "tags"), ["__none"]);

/* THE AND/OR CASE, built so that getting it the wrong way round changes the
 * answer. "State is FL or AL" AND "stage is new":
 *   right     — l1 (FL/new) and l2 (AL/new)                       → 2 rows
 *   OR across columns  — l3 and l4 are FL, so they come too       → 4 rows
 *   AND inside a column — no row is both FL and AL                → 0 rows
 * All three answers differ, so this assertion cannot pass on a wrong build. */
const STACKED = { state: new Set(["FL", "AL"]), stage: new Set(["new"]) };
eq("two states OR'd, AND'd with one stage, gives the rows a person means",
  applyFacets(rows, STACKED).map((r) => r.id), ["l1", "l2"]);
eq("...and the number is 2 — OR'd across columns it would be 4, AND'd inside one column it would be 0",
  applyFacets(rows, STACKED).length, 2);
ok("matchesFacets agrees with applyFacets row by row",
  rows.every((r) => matchesFacets(r, STACKED) === applyFacets(rows, STACKED).includes(r)));
eq("a filter on tags stacks with the rest the same way",
  applyFacets(rows, { tags: new Set(["medspa"]), state: new Set(["FL"]) }).map((r) => r.id), ["l3"]);
eq("filtering FOR untagged rows really returns them",
  applyFacets(rows, { tags: new Set(["__none"]) }).map((r) => r.id), ["l2", "l4", "l5"]);

/* An empty Set is a column nobody has filtered, not a column that matches
 * nothing. The bar sets one the moment a menu is opened and closed again. */
eq("an EMPTY set is ignored rather than matching nothing", applyFacets(rows, { state: new Set() }).length, rows.length);
eq("...and matchesFacets says the same", matchesFacets(byId("l5"), { state: new Set() }), true);
eq("a null facets object matches everything", matchesFacets(byId("l1"), null), true);
eq("a facets value that is not a Set is ignored rather than throwing",
  matchesFacets(byId("l1"), { state: ["FL"] }), true);
/* Nothing on hands the rows straight back — asserted on identity, so a needless
 * copy of the whole board on every render would fail here. */
ok("nothing on returns the rows themselves", applyFacets(rows, {}) === rows);
ok("...and so does a null facets object", applyFacets(rows, null) === rows);

console.log("\nTOGGLING A FILTER NEVER MUTATES WHAT IT WAS GIVEN");
const BASE = { state: new Set(["FL"]) };
const ADDED = toggleFacetValue(BASE, "state", "AL");
/* React only re-renders when the identity changes. A mutated Set is a filter
 * that applies on the next unrelated keystroke instead of on the click. */
ok("the object handed in is a different object from the one handed back", ADDED !== BASE);
ok("...and so is the Set inside it", ADDED.state !== BASE.state);
eq("the original is untouched", [...BASE.state], ["FL"]);
eq("the new one has both", [...ADDED.state].sort(), ["AL", "FL"]);
eq("toggling a value that is on takes it off", [...toggleFacetValue(ADDED, "state", "FL").state], ["AL"]);
eq("taking the LAST value off drops the whole column rather than leaving an empty set behind",
  Object.keys(toggleFacetValue(BASE, "state", "FL")), []);
eq("toggling onto a null facets object works", [...toggleFacetValue(null, "stage", "new").stage], ["new"]);
eq("clearFacet drops one column and leaves the rest", Object.keys(clearFacet(STACKED, "state")), ["stage"]);
ok("clearFacet does not mutate either", Object.keys(STACKED).length === 2);
eq("nothing on is nothing on", anyFacetOn({}), false);
eq("an empty set is not something on", anyFacetOn({ state: new Set() }), false);
eq("a value on is something on", anyFacetOn(BASE), true);

/* ONE CHIP PER VALUE, not per column. Three values across two columns is three
 * chips, because a person takes off "AL" without taking off "FL". */
const CHIPS = facetChips(STACKED, { labelFor: (k, v) => `${k}:${v}` });
eq("three values across two columns is THREE chips, not two", CHIPS.length, 3);
eq("every chip names the column it came from and the value it removes",
  CHIPS.map((c) => `${c.key}=${c.value}`).sort(), ["stage=new", "state=AL", "state=FL"]);
eq("each chip carries the words to print", CHIPS.map((c) => c.label).sort(), ["stage:new", "state:AL", "state:FL"]);
eq("nothing on is no chips", facetChips({}, { labelFor: () => "x" }), []);
eq("an empty column produces no chip", facetChips({ state: new Set() }, { labelFor: () => "x" }), []);

console.log("\nTHE TAG MENU COUNTS A ROW ONCE PER TAG");
const TAG_MENU = facetValuesMulti(rows, "tags");
eq("every slug on the board is offered, with __none last",
  TAG_MENU.map(([v]) => v), ["hot", "medspa", "quiet", "__none"]);
eq("the untagged rows are counted, not dropped", TAG_MENU.find(([v]) => v === "__none")[1], 3);
eq("the counts add up to more than the rows, because a lead with two tags is under both",
  TAG_MENU.reduce((n, [, c]) => n + c, 0), 6);

console.log("\nTHE BANDS — AND NULL IS NEVER A ZERO-ISH BAND");
eq("no score at all", scoreBandOf(null), "__none");
eq("undefined is not a score", scoreBandOf(undefined), "__none");
eq("an EMPTY STRING is not a score of zero", scoreBandOf(""), "__none");
eq("text is not a score", scoreBandOf("abc"), "__none");
eq("-1 is not a score", scoreBandOf(-1), "__none");
eq("150 is not a score", scoreBandOf(150), "__none");
eq("101 is not a score", scoreBandOf(101), "__none");
/* THE ONE THAT MATTERS: an unscored firm must NOT land in the worst band. A firm
 * shown as under-60 reads as the widest gap on the list, which is the one a rep
 * goes at hardest — off a number nobody measured. */
ok("null lands in \"no score yet\" and NOT in the worst band, which is what a rep would go at hardest",
  scoreBandOf(null) === "__none" && scoreBandOf(null) !== "under60");
eq("a real zero is a real score", scoreBandOf(0), "under60");
eq("59 is under 60", scoreBandOf(59), "under60");
eq("60 opens the 60s", scoreBandOf(60), "60s");
eq("79 closes the 60s", scoreBandOf(79), "60s");
eq("80 opens the 80s", scoreBandOf(80), "80s");
eq("89 closes the 80s", scoreBandOf(89), "80s");
eq("90 is the skip line", scoreBandOf(90), "90plus");
eq("100 is still 90+", scoreBandOf(100), "90plus");
eq("a numeric string is read", scoreBandOf("93"), "90plus");

eq("no head count", sizeBandOf(null), "__none");
eq("undefined head count", sizeBandOf(undefined), "__none");
eq("an empty string is not a one-person business", sizeBandOf(""), "__none");
eq("whitespace is not a one-person business", sizeBandOf("   "), "__none");
eq("text is not a head count", sizeBandOf("abc"), "__none");
eq("zero people is unknown, not solo", sizeBandOf(0), "__none");
eq("-1 people is unknown", sizeBandOf(-1), "__none");
eq("1 is solo", sizeBandOf(1), "solo");
eq("2 is small", sizeBandOf(2), "small");
eq("10 closes small", sizeBandOf(10), "small");
eq("11 opens mid", sizeBandOf(11), "mid");
eq("50 closes mid", sizeBandOf(50), "mid");
eq("51 is large", sizeBandOf(51), "large");
eq("150 is large", sizeBandOf(150), "large");
eq("a numeric string is read", sizeBandOf("24"), "mid");

eq("nothing in, never touched", touchBandOf(null, NOW), "__none");
eq("an empty string is never touched", touchBandOf("", NOW), "__none");
/* An unreadable date is UNKNOWN, not today. "today" would put a broken row at
 * the front of the healthy list and hide the bad value behind a band. */
eq("an unreadable date is unknown, NOT today", touchBandOf("banana", NOW), "__none");
eq("touched at this instant is today", touchBandOf(NOW, NOW), "today");
eq("midnight in Chicago is still today", touchBandOf("2026-08-27T05:00:00Z", NOW), "today");
/* THE TIMEZONE ONE. 02:30Z on the 27th is 9:30pm Central on the 26th — ONE day
 * ago in the team's own calendar. A subtraction of two timestamps says the same
 * UTC day and reads "today", which is how a rep who has not called since last
 * night looks freshly touched. Counted through daysBetween(), which asks Intl
 * for the real Chicago offset rather than hardcoding -5. */
eq("a touch at 9:30pm Central last night is ONE day ago, not today — a UTC subtraction would say today",
  touchBandOf("2026-08-27T02:30:00Z", NOW), "week");
eq("six days is within a week", touchBandOf(at(21), NOW), "week");
eq("seven days is over seven", touchBandOf(at(20), NOW), "over7");
eq("thirteen days is still over seven", touchBandOf(at(14), NOW), "over7");
eq("fourteen days is over fourteen — the day a claim reopens to the floor", touchBandOf(at(13), NOW), "over14");
eq("thirty days is over fourteen", touchBandOf("2026-07-28T15:00:00Z", NOW), "over14");
/* A future date must not read as over-fourteen. d < 0 falls in the `d <= 0`
 * branch on purpose. */
eq("a date in the future reads as today rather than as ancient", touchBandOf("2026-09-01T15:00:00Z", NOW), "today");
/* `now` IS AN ARGUMENT AND NOTHING IN HERE READS A CLOCK. Proven by feeding the
 * SAME touch two different `now` values and getting two different answers — if
 * it were reading Date.now() the answer could not move. */
eq("the same touch with an earlier `now` is today", touchBandOf(at(13), at(13)), "today");
eq("...and with a later `now` is over fourteen — so `now` is the argument, not the clock",
  touchBandOf(at(13), NOW), "over14");
eq("a Date object for `now` is accepted and agrees with the string", touchBandOf(at(20), new Date(NOW)), "over7");
eq("a millisecond number for `now` is accepted and agrees too", touchBandOf(at(20), Date.parse(NOW)), "over7");
/* THE PROCESS TIMEZONE CANNOT CHANGE AN ANSWER. daysBetween counts in
 * America/Chicago through a module-level Intl formatter with the zone written
 * out, so nothing here consults process.env.TZ. The five-timezone loop in
 * run.sh is what actually proves it end to end; this assertion pins the boundary
 * value that loop re-checks, and pins that the answer is not a function of the
 * host. */
ok("the boundary answers do not move with the host timezone (run.sh re-checks all of them in five zones)",
  [touchBandOf("2026-08-27T02:30:00Z", NOW), touchBandOf(at(21), NOW), touchBandOf(at(20), NOW), touchBandOf(at(13), NOW)]
    .join("|") === "week|week|over7|over14",
  `TZ=${process.env.TZ || "(host default)"}`);

console.log("\nreadCount — A HEAD COUNT, OR NOTHING");
eq("nothing in, nothing out", readCount(null), null);
eq("undefined is not a head count", readCount(undefined), null);
eq("an empty string is not one person", readCount(""), null);
eq("whitespace is not one person", readCount("   "), null);
eq("text is not a head count", readCount("abc"), null);
eq("zero people is unknown, not zero — a firm with no head count must not sort as the smallest",
  readCount(0), null);
eq("-1 is unknown", readCount(-1), null);
eq("1 is one person", readCount(1), 1);
eq("150 is 150", readCount(150), 150);
eq("a numeric string is read", readCount("24"), 24);
eq("a fraction of a person is floored, not rounded up", readCount(12.7), 12);
eq("Infinity is not a head count", readCount(Infinity), null);

console.log("\nreadCompanyReport — EVERY HALF INDEPENDENTLY NULLABLE, AND NULL NEVER BECOMES 0");
eq("no row at all is null, not an empty report", readCompanyReport(null), null);
eq("undefined is null", readCompanyReport(undefined), null);
const EMPTY_REPORT = readCompanyReport({ id: "r0", company_id: "co9" });
eq("a row with nothing measured has a null AI Access score", EMPTY_REPORT.aiAccess, null);
eq("...and a null SEO score", EMPTY_REPORT.seo, null);
eq("...and no prompt simulation", [EMPTY_REPORT.simHits, EMPTY_REPORT.simTotal], [null, null]);
eq("...and an empty findings list rather than null", EMPTY_REPORT.findings, []);
/* THE MOST DANGEROUS WRONG NUMBER THIS FEATURE COULD PRODUCE. A firm shown as 0
 * for AI Access reads as the worst site anybody has ever seen, which is the
 * hardest a rep would ever go in — off a measurement nobody took. */
eq("a missing AI Access score stays null and NEVER becomes 0 — a firm shown as 0 reads as the worst site anybody has seen",
  readCompanyReport({ ai_access_score: null, seo_score: 66 }).aiAccess, null);
eq("an EMPTY STRING AI Access score is null, not 0", readCompanyReport({ ai_access_score: "" }).aiAccess, null);
eq("a 150 is not a score", readCompanyReport({ ai_access_score: 150 }).aiAccess, null);
eq("a -1 is not a score", readCompanyReport({ seo_score: -1 }).seo, null);
eq("a REAL zero survives, because 0 is a measurement somebody took", readCompanyReport({ ai_access_score: 0 }).aiAccess, 0);
eq("the SEO half can be measured while AI Access is not", readCompanyReport({ seo_score: 88 }).seo, 88);
eq("...and the other way round", readCompanyReport({ ai_access_score: 41 }).seo, null);
/* HITS OUT OF TOTAL OR NOTHING. 2 of 10 and 20% are the same number and only one
 * of them says how big the sample was; 1 of 2 printed as 50% is a claim nobody
 * measured. */
eq("both halves of the simulation, together", [
  readCompanyReport({ prompt_sim_hits: 2, prompt_sim_total: 10 }).simHits,
  readCompanyReport({ prompt_sim_hits: 2, prompt_sim_total: 10 }).simTotal,
], [2, 10]);
eq("a hit count with no total is neither half", [
  readCompanyReport({ prompt_sim_hits: 2 }).simHits,
  readCompanyReport({ prompt_sim_hits: 2 }).simTotal,
], [null, null]);
eq("a total with no hit count is neither half", [
  readCompanyReport({ prompt_sim_total: 10 }).simHits,
  readCompanyReport({ prompt_sim_total: 10 }).simTotal,
], [null, null]);
eq("a total of zero is not a sample", readCompanyReport({ prompt_sim_hits: 0, prompt_sim_total: 0 }).simTotal, null);
eq("zero hits out of ten IS a measurement and survives", readCompanyReport({ prompt_sim_hits: 0, prompt_sim_total: 10 }).simHits, 0);
eq("more hits than prompts is refused outright — it cannot be a real reading",
  readCompanyReport({ prompt_sim_hits: 11, prompt_sim_total: 10 }).simHits, null);
eq("a negative hit count is refused", readCompanyReport({ prompt_sim_hits: -1, prompt_sim_total: 10 }).simTotal, null);
eq("findings that are not an array become an empty array", readCompanyReport({ findings: "nope" }).findings, []);
eq("null findings become an empty array", readCompanyReport({ findings: null }).findings, []);
eq("real findings survive", readCompanyReport({ findings: [{ id: "f" }] }).findings.length, 1);
/* The four halves of a measurement, carried together: the number, what it was
 * measured against, the day it was read, and who read it. */
eq("what it was measured against travels with the number",
  readCompanyReport({ domain: "x.com", measured_at: at(20), measured_by: "u1" }).domain, "x.com");
eq("the day it was read travels too", readCompanyReport({ measured_at: at(20) }).measuredAt, at(20));
eq("who read it travels too", readCompanyReport({ measured_by: "u1" }).measuredBy, "u1");
eq("an unstated kind is a baseline", readCompanyReport({}).kind, "baseline");
eq("a stated kind survives", readCompanyReport({ kind: "rescan" }).kind, "rescan");

console.log("\nnewestReportByCompany — WHICH SCAN IS CURRENT CANNOT DEPEND ON READ ORDER");
const SCANS = [
  { id: "a", company_id: "co1", measured_at: at(10) },
  { id: "b", company_id: "co1", measured_at: at(24) },
  { id: "c", company_id: "co1", measured_at: at(18) },
  { id: "d", company_id: "co2", measured_at: at(5) },
  { id: "e", measured_at: at(26) },                       // no firm — must be skipped
];
eq("the newest scan of a firm wins", newestReportByCompany(SCANS).get("co1").id, "b");
eq("...whatever order the rows arrive in", newestReportByCompany([...SCANS].reverse()).get("co1").id, "b");
eq("a firm with one scan gets that one", newestReportByCompany(SCANS).get("co2").id, "d");
eq("a row with no firm on it is skipped rather than filed under undefined", newestReportByCompany(SCANS).has(undefined), false);
eq("no rows at all is an empty map, not a crash", newestReportByCompany(null).size, 0);
/* TIES BROKEN ON ID. Two scans written in the same second are ordinary — the
 * overnight sweep writes a batch — and without a tie-break the winner depends on
 * whatever order Postgres handed the rows back, so two reads of the SAME rows
 * disagree about which number is current. */
const TIED = [
  { id: "scan-a", company_id: "co1", measured_at: at(24), ai_access_score: 41 },
  { id: "scan-z", company_id: "co1", measured_at: at(24), ai_access_score: 77 },
];
eq("two scans in the same second break the tie on id, not on read order", newestReportByCompany(TIED).get("co1").id, "scan-z");
eq("...and the reversed list gives the SAME answer, so two reads cannot disagree",
  newestReportByCompany([...TIED].reverse()).get("co1").id, "scan-z");
eq("a scan with no measured_at loses to one that has a date",
  newestReportByCompany([{ id: "n", company_id: "co1" }, { id: "m", company_id: "co1", measured_at: at(1) }]).get("co1").id, "m");

console.log("\nSORTING THE FOUR NEW COLUMNS — BLANK IS ITS OWN FIELD, NEVER A MAGIC NUMBER");
/* Encoding "missing" as -1 or 0 is what made the Operations table sort and group
 * disagree: the row lands in the middle of the order one way and at the end the
 * other way. */
eq("a row with tags is not blank, and sorts on the FIRST tag's label",
  sortValue(byId("l3"), "tags"), { blank: false, v: "medspa" });
eq("a row with ONE tag sorts on that one", sortValue(byId("l1"), "tags"), { blank: false, v: "hot" });
eq("a row with NO tags is BLANK, not \"zero tags\"", sortValue(byId("l2"), "tags"), { blank: true, v: "" });
eq("a row whose tags were removed is blank too", sortValue(byId("l4"), "tags"), { blank: true, v: "" });

eq("a firm with both scores is not blank", sortValue(byId("l1"), "scores"), { blank: false, v: 41066 });
/* A firm with an SEO score and no AI Access score has BEEN MEASURED — just not
 * on the thing this agency leads with — so it is not blank. It sorts after every
 * firm with both and before every firm with neither. */
eq("a firm measured on SEO but not on AI Access is NOT blank — it has been measured, just not on what we lead with",
  sortValue(byId("l4"), "scores"), { blank: false, v: 1000088 });
eq("a firm with no scan at all is blank", sortValue(byId("l5"), "scores"), { blank: true, v: 0 });
eq("a firm whose scan measured nothing is blank", sortValue({ report: { aiAccess: null, seo: null } }, "scores"), { blank: true, v: 0 });

eq("a firm with a head count is not blank", sortValue(byId("l1"), "employees"), { blank: false, v: 24 });
eq("a firm with a NULL head count is blank, not a one-person business",
  sortValue({ company: { employees: null }, lead: {} }, "employees"), { blank: true, v: 0 });
eq("an EMPTY-STRING head count is blank too, not zero people",
  sortValue({ company: { employees: "" }, lead: {} }, "employees"), { blank: true, v: 0 });
eq("a row with no firm record at all is blank", sortValue(byId("l5"), "employees"), { blank: true, v: 0 });

eq("the firm's line of business is not blank", sortValue(byId("l1"), "vertical"), { blank: false, v: "realtor" });
eq("the FIRM's vertical wins over the copied-down text on the lead",
  sortValue({ company: { vertical: "medspa" }, lead: { vertical: "realtor" } }, "vertical"), { blank: false, v: "medspa" });
eq("the lead's copied-down text is the fallback",
  sortValue({ company: null, lead: { vertical: "lawyer" } }, "vertical"), { blank: false, v: "lawyer" });
eq("no vertical anywhere is blank", sortValue(byId("l5"), "vertical"), { blank: true, v: "" });

console.log("\nBLANKS SINK IN BOTH DIRECTIONS");
for (const key of ["tags", "scores", "employees", "vertical"]) {
  const asc = sortRowsBy(rows, { key, dir: "asc" });
  const desc = sortRowsBy(rows, { key, dir: "desc" });
  const blankOf = (r) => sortValue(r, key).blank;
  ok(`${key}: every blank row is at the END going up`,
    asc.map(blankOf).join() === [...asc.map(blankOf)].sort((a, b) => (a === b ? 0 : a ? 1 : -1)).join(),
    asc.map((r) => `${r.id}:${blankOf(r)}`).join(" "));
  ok(`${key}: every blank row is at the END going down too — a row with nothing in it floating to the top is not information`,
    desc.map(blankOf).join() === [...desc.map(blankOf)].sort((a, b) => (a === b ? 0 : a ? 1 : -1)).join(),
    desc.map((r) => `${r.id}:${blankOf(r)}`).join(" "));
}
ok("sorting the new columns never mutates the array it was given", (() => {
  const before = rows.map((r) => r.id).join();
  for (const key of ["tags", "scores", "employees", "vertical"]) {
    sortRowsBy(rows, { key, dir: "asc" });
    sortRowsBy(rows, { key, dir: "desc" });
  }
  return rows.map((r) => r.id).join() === before;
})());
eq("the facet value for a banded column is the BAND, while the cell keeps the real number",
  [facetValue(byId("l1"), "site_score"), facetValue(byId("l1"), "employees"), facetValue(byId("l1"), "last_touch")],
  ["under60", "mid", "week"]);

console.log("\nONE SOURCE, THREE LAYOUTS — ASSERTED STRUCTURALLY");
/* A pure module cannot see a component fetching its own leads, and "two
 * snapshots of one pipeline" is exactly how a tile ends up disagreeing with the
 * list under it. So the components are read as TEXT. Crude on purpose: crude and
 * true beats clever and absent. */
const SALES_PAGE = src("src/components/admin/SalesPage.jsx");
const REP_OVERVIEW = src("src/components/admin/repOverview.jsx");
/* Comments are stripped before counting, so a sentence ABOUT getFloorBoard() in
 * a comment cannot be mistaken for a second call to it — and so that adding a
 * comment can never turn a green assertion red. */
const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const count = (text, re) => (codeOf(text).match(re) || []).length;

/* WHAT A NAME COUNT CANNOT SEE, and why this is checked a second way.
 *
 * A reviewer broke the assertion below by importing a second reader UNDER AN
 * ALIAS — `import { getSalesBoard as secondSnapshot }` — and calling
 * `secondSnapshot()`. Every count in this block stayed green while the page was
 * taking two snapshots of the pipeline, which is the exact defect they exist to
 * catch. Counting call sites can only ever see the names it was told to look for.
 *
 * So the IMPORT LIST is read instead: whatever these files pull out of
 * src/lib/data.js, alias and all, is compared against the readers that hand back
 * leads. A second one cannot arrive without a name appearing here, whatever it is
 * then called locally. Aug 27 2026, after a review. */
const LEAD_READERS = [
  "getFloorBoard", "getSalesBoard", "listLeads", "listAllLeadActivity",
  "listCompanies", "listProposals", "askRepReport",
];
/** Every name imported from src/lib/data.js, as the ORIGINAL export name. */
function importedFromData(text) {
  const out = [];
  /* `[^}]*?` and NOT `[\s\S]*?`. The lazy any-character version still crosses a
   * closing brace when the match has to reach a later import, so on a file whose
   * data.js import is not the first one it swallowed everything from the FIRST
   * `import {` onwards — and the names then came back as "import { getFloorBoard"
   * rather than "getFloorBoard", so the filter found nothing and the assertion
   * read as "imports no lead reader at all". A named-import list has no nested
   * braces, so refusing to cross one is exactly right here. */
  const re = /import\s*\{([^}]*?)\}\s*from\s*["'][^"']*lib\/data\.js["']/g;
  for (const m of codeOf(text).matchAll(re)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) out.push(name);
    }
  }
  return out;
}
eq("SalesPage imports exactly ONE reader that hands back leads, and it is the board",
  importedFromData(SALES_PAGE).filter((n) => LEAD_READERS.includes(n)).sort(),
  ["getFloorBoard"]);
eq("SalesPage reads the board exactly ONCE", count(SALES_PAGE, /getFloorBoard\(/g), 1);
eq("...and never calls getSalesBoard directly, which would be a second snapshot",
  count(SALES_PAGE, /getSalesBoard\(/g), 0);
eq("...and never calls listLeads()", count(SALES_PAGE, /listLeads\(/g), 0);
eq("...and never queries a table itself — no .from( anywhere in the file",
  count(SALES_PAGE, /\.from\(/g), 0);
eq("...and never names admin_leads", count(SALES_PAGE, /admin_leads/g), 0);
eq("the row builder is sheetRows, and it is called ONCE — every layout reads the same rows",
  count(SALES_PAGE, /sheetRows\(/g), 1);
ok("...and it is imported from the one module that owns the rule",
  /from "\.\.\/\.\.\/lib\/salesSheet\.js"|from "\.\.\/\.\.\/src\/lib\/salesSheet\.js"|salesSheet\.js/.test(SALES_PAGE));
ok("SalesPage builds no rows of its own with a second builder",
  count(SALES_PAGE, /sheetRow\(/g) === 0, `sheetRow( appears ${count(SALES_PAGE, /sheetRow\(/g)} times`);

eq("the rep's Overview imports exactly ONE lead reader too, whatever it calls it locally",
  importedFromData(REP_OVERVIEW).filter((n) => LEAD_READERS.includes(n)).sort(),
  ["getFloorBoard"]);
eq("the rep's Overview reads the SAME board function, once", count(REP_OVERVIEW, /getFloorBoard\(/g), 1);
eq("...and does not fetch leads itself — a page that fetches its own leads is a page with its own snapshot",
  count(REP_OVERVIEW, /\.from\(/g) + count(REP_OVERVIEW, /listLeads\(/g) + count(REP_OVERVIEW, /getSalesBoard\(/g), 0);
eq("...and never names admin_leads either", count(REP_OVERVIEW, /admin_leads/g), 0);

/* The three copies of the row-level rule have to be findable from each other, or
 * the next person changes one and ships a hole. 0020 names canEditLead and
 * canEditLead names 0020. */
const RLS = src("supabase/migrations/0020_rep_scoping.sql");
ok("the migration points at canEditLead()", /canEditLead\(\)/.test(RLS));
ok("...and canEditLead points back at the migration", /0020_rep_scoping\.sql/.test(CAN_EDIT_SRC + SHEET_SRC.slice(SHEET_SRC.indexOf("THE LOCK IS ON THE ROW"), SHEET_SRC.indexOf("export function canEditLead"))));
ok("the migration names the test that proves it", /tests\/floor-scoping\/sql\.sh/.test(RLS));


/* ================================================================== */
/* WHO MAY SEE A LEAD AT ALL — 30 Aug 2026                             */
/*                                                                     */
/* Ryder reversed the Aug 27 rule: a rep no longer sees a lead that     */
/* somebody else holds. This section is the whole of that rule, and     */
/* the marker that keeps the protection the old rule was there for.    */
/* ================================================================== */
console.log("\nWHO MAY SEE A LEAD AT ALL");

const idsOf = (list) => list.map((l) => l.id);

eq("a rep sees their own leads and the unclaimed ones, and nothing else",
  idsOf(visibleToMember(LEADS, REP)), ["l1", "l2", "l4", "l5"]);
eq("...so another rep's row is GONE, not merely read-only",
  visibleToMember(LEADS, REP).some((l) => l.id === "l3"), false);
eq("the other rep sees the mirror image of it",
  idsOf(visibleToMember(LEADS, REP2)), ["l2", "l3", "l5"]);
eq("an owner still sees every lead", idsOf(visibleToMember(LEADS, OWNER)), idsOf(LEADS));
eq("an admin still sees every lead", idsOf(visibleToMember(LEADS, ADMIN)), idsOf(LEADS));
eq("...and an owner gets the SAME ARRAY back, not a copy — this runs on every keystroke",
  visibleToMember(LEADS, OWNER) === LEADS, true);

/* FAIL CLOSED, both directions. A page that has lost track of who is looking at
 * it must not hand out the whole pipeline, and a role nobody has taught this
 * file about is not an owner. Both fall to the narrow rule, which is never
 * empty in the way returning [] would be. */
eq("a member with no role gets the narrow set, not everything",
  idsOf(visibleToMember(LEADS, { user_id: "u-rep", full_name: "x" })), ["l1", "l2", "l4", "l5"]);
/* AN UNKNOWN ROLE SEES EVERYTHING, and that is deliberate, not an oversight.
 * canEditLead has said "every role that is not `sales` may edit anything" since
 * Aug 27, on the ground that a role nobody has taught the file about must not
 * silently lose the ability to work. So a role like this can already change
 * every lead in the company. Hiding those same leads from it would leave the two
 * rules disagreeing about one person, which is worse than either answer alone.
 * The pair moves together or not at all — change one and this assertion fires. */
eq("an unknown role sees everything, exactly as canEditLead lets it edit everything",
  idsOf(visibleToMember(LEADS, { user_id: "u-rep", role: "intern" })), idsOf(LEADS));
eq("...and canEditLead agrees about that same person",
  LEADS.every((l) => canEditLead(l, { user_id: "u-rep", role: "intern" })), true);
eq("a member with no role can edit nothing, and gets the narrow set",
  canEditLead(LEADS[2], { user_id: "u-rep" }), false);
eq("no member at all sees only the unclaimed rows",
  idsOf(visibleToMember(LEADS, null)), ["l2", "l5"]);
/* "UNCLAIMED" IS `!l.owner_id`, the same convention byAvailability, the tiles and
 * contestedCompanies all use. An empty string is not a user id and reads as
 * unclaimed here exactly as it does everywhere else in this file — the point of
 * asserting it is that the four places agree, not that any of them is clever. */
eq("an empty-string owner_id reads as unclaimed, the same as everywhere else",
  idsOf(visibleToMember([{ id: "x", owner_id: "" }], null)), ["x"]);
eq("...and byAvailability says the same thing about it",
  idsOf(byAvailability([{ id: "x", owner_id: "" }], "available", REP)), ["x"]);
eq("no leads is an empty list, not a throw", visibleToMember(null, REP), []);

/* THE CLAIM/RELEASE ROUND TRIP. Both halves of a rep's set are on their page,
 * so neither button can push a record out from under the person pressing it —
 * which is what lets the drawer read the page's set instead of the board. */
{
  const claimed = LEADS.map((l) => (l.id === "l2" ? { ...l, owner_id: REP.user_id } : l));
  eq("claiming an unclaimed lead keeps it on the rep's page",
    visibleToMember(claimed, REP).some((l) => l.id === "l2"), true);
  eq("...and takes it off every other rep's page",
    visibleToMember(claimed, REP2).some((l) => l.id === "l2"), false);
  const released = LEADS.map((l) => (l.id === "l1" ? { ...l, owner_id: null } : l));
  eq("releasing one of your own keeps it on your page",
    visibleToMember(released, REP).some((l) => l.id === "l1"), true);
  eq("...and puts it on everybody else's", 
    visibleToMember(released, REP2).some((l) => l.id === "l1"), true);
}

console.log("\nTHE FIRM MARKER — THE PROTECTION THE OLD RULE WAS FOR");

/* This is the whole reason the rows can be hidden safely. It has to be counted
 * from the WHOLE board: pass it the narrowed list and it can only ever come back
 * empty, and the marker silently never appears. */
{
  const busyForRep = firmsHeldByOthers(LEADS, REP);
  eq("co1 is busy for the rep — rep2 holds Dana there", busyForRep.has("co1"), true);
  eq("co3 is not — the only claim there is the rep's own", busyForRep.has("co3"), false);
  eq("nothing but company ids comes out",
    [...busyForRep].every((v) => typeof v === "string" && v.startsWith("co")), true);

  const busyFromNarrowed = firmsHeldByOthers(visibleToMember(LEADS, REP), REP);
  eq("COUNTED FROM THE NARROWED LIST IT IS EMPTY — this is the mistake the comment warns about",
    busyFromNarrowed.size, 0);

  eq("for an owner, every claimed firm is 'somebody else' — which is why the page passes null instead",
    firmsHeldByOthers(LEADS, OWNER).has("co1"), true);
  eq("a lead with no firm can never make a firm busy",
    firmsHeldByOthers([{ id: "z", owner_id: "u-rep2", company_id: null }], REP).size, 0);
  eq("an unclaimed lead can never make a firm busy",
    firmsHeldByOthers([{ id: "z", owner_id: null, company_id: "co9" }], REP).size, 0);
  eq("no leads is an empty set, not a throw", firmsHeldByOthers(null, REP).size, 0);

  /* OPEN STAGES ONLY — the same filter contestedCompanies and companyClaimWarning
   * both apply. Without it a contact somebody marked Lost in March marks that
   * firm busy for ever, while the drawer's warning on the same firm — which does
   * filter — shows nothing. Two parts of one page, opposite answers. */
  eq("a LOST contact of another rep's does not make a firm busy",
    firmsHeldByOthers([{ id: "z", owner_id: "u-rep2", company_id: "co9", stage: "lost" }], REP).size, 0);
  eq("nor does a WON one — a converted client is not a firm somebody is still working",
    firmsHeldByOthers([{ id: "z", owner_id: "u-rep2", company_id: "co9", stage: "won" }], REP).size, 0);
  eq("an open one does", 
    firmsHeldByOthers([{ id: "z", owner_id: "u-rep2", company_id: "co9", stage: "contacted" }], REP).size, 1);
  eq("...and the drawer's warning agrees about that same firm",
    firmsHeldByOthers(LEADS, REP).has("co1"),
    LEADS.some((l) => l.company_id === "co1" && l.owner_id === "u-rep2" && isOpenStage(l.stage)));

  /* NOBODY HOLDS AN UNCLAIMED ROW. Only reachable for a roleless member, but it
   * printed "Held by another rep" on a free row. */
  eq("an unclaimed row never carries a held-by marker",
    heldByLabel({ id: "z", owner_id: null }, { user_id: "x" }, teamName), null);

  /* And on the row itself. Only ever true for an UNCLAIMED row: on a row you
   * hold, the firm being busy is you; on a row somebody else holds, you are not
   * seeing it at all any more. */
  const busyRows = sheetRows(visibleToMember(LEADS, REP), { ...ctx, firmsBusy: busyForRep });
  const bid = (id) => busyRows.find((r) => r.id === id);
  eq("the unclaimed row at the busy firm is marked", bid("l2").firmBusy, true);
  /* YOUR OWN ROW AT THAT FIRM IS MARKED TOO, and the first draft had this the
   * other way round on the reasoning that "a firm you are in is busy with you".
   * That is wrong: firmsHeldByOthers has already excluded your own claims, so
   * the set only holds firms SOMEBODY ELSE is in — and a rep who holds one
   * contact at a firm another rep is also working is exactly the person the
   * warning is for. The old test silenced them. Found by an adversarial review,
   * 30 Aug 2026.
   *
   * It is also what replaces contestedCompanies on a rep's page: that needs two
   * owners in one list and a rep's list can now hold at most one. */
  eq("YOUR OWN row at that same firm is marked too — the collision is the point",
    bid("l1").firmBusy, true);
  eq("your own row at a quiet firm is not", bid("l4").firmBusy, false);
  eq("a row with no firm at all is not", bid("l5").firmBusy, false);
  eq("with no firmsBusy passed, nothing is marked — the owner's page",
    sheetRows(LEADS, ctx).every((r) => r.firmBusy === false), true);
  ok("the marker names nobody", !/\brep\b|\bLarry\b|\bBrandon\b|\bDana\b/i.test(FIRM_BUSY_LABEL));
}

console.log("\nTHE NARROWING HAPPENS ONCE, AND THE ADDRESS BAR CANNOT WALK ROUND IT");
{
  const P = src("src/components/admin/SalesPage.jsx");
  eq("visibleToMember is called exactly once on the page", count(P, /visibleToMember\(/g), 1);
  ok("the page's set IS that call",
    /const scopeLeads = useMemo\(\s*\(\) => visibleToMember\(/.test(P));
  ok("firmsHeldByOthers reads board.leads, never scopeLeads",
    /firmsHeldByOthers\(board\?\.leads \|\| \[\], member\)/.test(P));
  ok("the deep-link guard checks the page's set", /if \(!scopeLeads\.some\(\(l\) => l\.id === id\)\) \{/.test(P));
  ok("the ?lead= pre-check checks the same set",
    /if \(scopeLeads\.some\(\(l\) => l\.id === linkedLeadId\)\)/.test(P));
  ok("the drawer reads the page's set", /const openLead = openId \? scopeLeads\.find/.test(P));
  ok("nothing on the page still opens a lead out of the raw board",
    !/board\?\.leads \|\| \[\]\)\.find\(\(l\) => l\.id === openId\)/.test(P));
  ok("the Firms view counts people from the page's set, not the board",
    /const people = scopeLeads\.filter\(\(l\) => l\.company_id === c\.id\)/.test(P));

  /* NO NAMES FOR A REP. Hiding a record and then printing the holder's name in
   * a warning beside it would hand back exactly what was hidden. */
  const PROF = src("src/components/admin/salesProfile.jsx");
  ok("the drawer's firm warning names nobody for a rep",
    /member\.role === "sales"[\s\S]{0,120}Somebody on the team/.test(PROF));
  ok("...and the warning itself is still built, from every contact at the firm",
    /companyClaimWarning\(lead, siblings, warnName/.test(PROF));
  const SH = src("src/components/admin/salesSheet.jsx");
  ok("the sheet's firm cell knows whether it may name people",
    /const hideNames = member\?\.role === "sales";/.test(SH));
  ok("...and passes it to the cell that would print a name", /hideNames=\{hideNames\}/.test(SH));
}


console.log("\nTHE AI IS A SECOND DOOR INTO THE SAME ROWS, AND IT IS SHUT TOO");
/* An adversarial review found this open on the day the rule was written: the
 * Sales page hid another rep's leads, and AI Brain handed the model every one of
 * them WITH THE HOLDER'S NAME. Both files run on the SERVICE ROLE, which ignores
 * row-level security, so these lines are the guard — the same shape as the
 * reminders filter an Aug 20 review found missing in the same file. */
{
  const BC = src("lib/brain-context.js");
  const AT = src("lib/assistant-tools.js");

  ok("brain-context has one rep lead filter, defined once",
    /const repLeadFilter = \(q\) => \(repScoped \? q\.or\(`owner_id\.eq\.\$\{userId\},owner_id\.is\.null`\) : q\);/.test(BC));
  eq("...and BOTH lead reads go through it — filtering one leaves the other carrying the rows",
    count(BC, /readTable\(admin, "admin_leads", \(q\) => repLeadFilter\(q\)/g), 2);
  eq("...so no unfiltered admin_leads read is left in the file",
    count(BC, /readTable\(admin, "admin_leads", \(q\) => q\n/g), 0);
  ok("the lead ACTIVITY is pruned to the leads that came back",
    /snap\.leadActivity = snap\.leadActivity\.filter\(\(a\) => !a\.lead_id \|\| seen\.has\(a\.lead_id\)\);/.test(BC));
  ok("...and says when it pruned, so a thin list does not read as 'nothing happened'",
    /snap\.leadActivityScoped/.test(BC));
  ok("the doc comment no longer claims userId is not used for filtering",
    !/used for "yours" markers, not for filtering/.test(BC));

  ok("the assistant's search scopes a rep's leads as well",
    /if \(role === "sales" && me\) query = query\.or\(`owner_id\.eq\.\$\{me\},owner_id\.is\.null`\);/.test(AT));
  ok("...and it is applied before the limit, not after the rows come back",
    AT.indexOf('query = query.or(`owner_id.eq.${me}') < AT.indexOf("await query.limit(limit)"));

  /* THE THREE DOORS HAVE TO NAME EACH OTHER, or the next person changes one and
   * ships a hole. This repo already learned that with canEditLead and 0020. */
  ok("brain-context points at the page's rule", /visibleToMember/.test(BC));
  ok("the assistant points at both of the others",
    /visibleToMember/.test(AT) && /brain-context\.js/.test(AT));
  ok("and the page's rule warns that it is not the only door",
    /not a security boundary/.test(src("src/lib/salesSheet.js")));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
