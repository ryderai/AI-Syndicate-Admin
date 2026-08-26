/* THE SHEET + THE LIFETIME TIMELINE — the pure half.
 *
 * Everything here runs in plain node against the real modules the browser
 * loads. No mocks of our own code: a test that agrees with a stub is not a
 * test, which this repo learned the hard way when three files wrote column
 * names the tables do not have and every fixture had invented the same wrong
 * names.
 */
import {
  SHEET_COLUMNS, DEFAULT_SHEET_COLUMNS, SORTABLE, FILTERABLE, GROUPABLE,
  CLAIM_ORDER, CLAIM_LABELS, CLAIM_COLOR,
  splitName, joinName, nameParts, contactedState, readScore,
  sheetRow, sheetRows, sortValue, sortRowsBy, defaultOrder, nextSort,
  facetValue, facetValues, groupRows, contestedCompanies, companyHeadcount,
  sheetDate, sheetDateLong, columnLabel,
} from "../../src/lib/salesSheet.js";
import { buildPersonTimeline, timelineSummary, readWhen, TIMELINE_CAP } from "../../lib/person-timeline.js";
import { claimState } from "../../lib/sales-rules.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const NOW = "2026-08-25T15:00:00Z";
const days = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString();

console.log("\nTHE COLUMNS");
ok("every default column is a real column", DEFAULT_SHEET_COLUMNS.every((k) => SHEET_COLUMNS.some((c) => c.key === k)));
ok("the sheet's six human columns all exist",
  ["owner", "contacted", "stage", "first_contact", "last_touch", "next_step"].every((k) => SHEET_COLUMNS.some((c) => c.key === k)));
/* All six of the spreadsheet's hand-filled columns, in its order — not the
 * first three. Asserting a slice(0,3) left columns 4-6 free to be reordered
 * while the test name claimed six. */
eq("the sheet's six human columns come first, in the sheet's own order",
  SHEET_COLUMNS.filter((c) => ["owner", "contacted", "stage", "first_contact", "last_touch", "next_step"].includes(c.key)).map((c) => c.label),
  ["Sales Owner", "Contacted?", "Sales Cycle Status", "First Contact", "Last Touch", "Next Steps/Notes"]);
/* Ryder, Aug 26 2026: Next Steps/Notes moved to the far right, so the run of
 * hand-filled columns at the front is now five long, not seven. The rule this
 * test guards has not changed — nothing but Claim may sit among them — and the
 * notes column is checked separately, at the end, where he asked for it. */
eq("...and nothing but Claim is allowed to sit among them",
  SHEET_COLUMNS.slice(0, 6).map((c) => c.key),
  ["owner", "contacted", "stage", "claim", "first_contact", "last_touch"]);
eq("Next Steps/Notes is the last column of the sheet",
  SHEET_COLUMNS[SHEET_COLUMNS.length - 1].key, "next_step");
eq("...and the last of the default columns too",
  DEFAULT_SHEET_COLUMNS[DEFAULT_SHEET_COLUMNS.length - 1], "next_step");
ok("no column is filterable or groupable without being sortable",
  [...FILTERABLE, ...GROUPABLE].every((k) => SORTABLE.has(k)));
ok("every column has a label", SHEET_COLUMNS.every((c) => c.label && c.label.trim()));
eq("an unknown key labels as itself rather than crashing", columnLabel("nope"), "nope");
/* The three columns a person must NOT be able to type over, and why. */
ok("Contacted?, First Contact and Last Touch are not editable",
  ["contacted", "first_contact", "last_touch"].every((k) => SHEET_COLUMNS.find((c) => c.key === k).edit === null));

console.log("\nEVERY CLAIM STATE claimState() CAN RETURN HAS A WORD AND A COLOUR");
/* This is the check that catches the class of bug the Operations table shipped:
 * a state the sort ranks but the screen has no word for reads as raw
 * snake_case to a person, and one that is not in CLAIM_ORDER sorts last with
 * no explanation. Driven from real leads, not from a hand-written list. */
const stateCases = [
  { stage: "won", owner_id: "u1" },                                                   // closed
  { stage: "new", owner_id: null },                                                   // unclaimed
  { stage: "new", owner_id: "u1", claimed_at: days(0.2) },                            // first_contact
  { stage: "new", owner_id: "u1", claimed_at: days(2) },                              // first_contact_due
  { stage: "new", owner_id: "u1", claimed_at: days(20) },                             // claim_expired
  { stage: "contacted", owner_id: "u1", claimed_at: days(30), claim_contacted_at: days(29), last_touch_at: days(1) },  // working
  { stage: "contacted", owner_id: "u1", claimed_at: days(30), claim_contacted_at: days(29), last_touch_at: days(13) }, // going_cold
  { stage: "contacted", owner_id: "u1", claimed_at: days(30), claim_contacted_at: days(29), last_touch_at: days(20) }, // cold
  { stage: "new", owner_id: "u1", claimed_at: "not-a-date" },                         // working (unreadable)
];
const seen = new Set(stateCases.map((l) => claimState(l, NOW).state));
ok(`${seen.size} distinct claim states produced by real leads`, seen.size >= 8, [...seen].join(", "));
for (const st of seen) {
  ok(`"${st}" has a word a person can read`, Boolean(CLAIM_LABELS[st]));
  ok(`"${st}" has a colour`, Boolean(CLAIM_COLOR[st]));
  ok(`"${st}" is in CLAIM_ORDER, so it sorts somewhere on purpose`, CLAIM_ORDER.includes(st));
}

console.log("\nNAMES");
eq("a two-word name splits the obvious way", splitName("Anna Jones"), { first: "Anna", last: "Jones", derived: true });
eq("a long name keeps everything after the first word", splitName("Mary Jo Van Der Berg"), { first: "Mary", last: "Jo Van Der Berg", derived: true });
eq("one word is a first name", splitName("Cher"), { first: "Cher", last: "", derived: true });
eq("nothing in, nothing guessed", splitName("   "), { first: "", last: "", derived: false });
eq("double spaces do not become an empty last name", splitName("Anna   Jones"), { first: "Anna", last: "Jones", derived: true });
eq("joining drops an empty half without leaving a space", joinName("Anna", ""), "Anna");
eq("joining nothing gives null, not an empty string", joinName("", ""), null);
eq("stored halves win over the guess", nameParts({ name: "Wrong Guess", first_name: "Real", last_name: "Name" }), { first: "Real", last: "Name", derived: false });
eq("one stored half is enough to stop guessing", nameParts({ name: "Wrong Guess", first_name: "Real" }), { first: "Real", last: "", derived: false });
eq("no stored halves falls back and says it guessed", nameParts({ name: "Anna Jones" }), { first: "Anna", last: "Jones", derived: true });

console.log("\nCONTACTED? IS COUNTED, NOT TYPED");
eq("a logged touch means yes", contactedState({}, 3).value, "yes");
eq("a first-contact date with nothing inside the window is its OWN answer, not \"no\"", contactedState({ first_contact_at: days(9) }, 0).value, "older");
eq("nothing at all is no", contactedState({}, 0).value, "no");
eq("an unreadable touch count is not treated as a touch", contactedState({}, "banana").value, "no");
ok("every answer carries a reason a person can read", ["yes", "older", "no"].every((v) => {
  const s = v === "yes" ? contactedState({}, 1) : v === "older" ? contactedState({ first_contact_at: days(1) }, 0) : contactedState({}, 0);
  return s.why && s.why.length > 20;
}));
/* THE ONE THIS FUNCTION EXISTS FOR. getSalesBoard reads a 90-day window, so a
 * count of 0 means "nothing lately", never "nothing ever". The first version
 * said "Nothing has ever been logged against this person" from that count. */
ok("no answer claims to know about anything outside the window it was given",
  ["yes", "older", "no"].every((v) => {
    const st = v === "yes" ? contactedState({}, 1, 90)
      : v === "older" ? contactedState({ first_contact_at: days(1) }, 0, 90)
        : contactedState({}, 0, 90);
    return !/\bever\b/i.test(st.why) && st.why.includes("90 days");
  }), JSON.stringify(["yes", "older", "no"].map((v) => (v === "yes" ? contactedState({}, 1, 90) : v === "older" ? contactedState({ first_contact_at: days(1) }, 0, 90) : contactedState({}, 0, 90)).why)));
ok("the window in the words is the window that was passed in",
  contactedState({}, 0, 30).why.includes("30 days"));
eq("one touch is singular", contactedState({}, 1).label, "Yes · 1 touch");

console.log("\nA SCORE IS A SCORE, OR IT IS UNKNOWN");
eq("an empty string is not a score of zero", readScore(""), null);
eq("null is not a score of zero", readScore(null), null);
eq("a real zero survives", readScore(0), 0);
eq("101 is not a score", readScore(101), null);
eq("-1 is not a score", readScore(-1), null);
eq("a numeric string is read", readScore("93"), 93);
eq("text is not a score", readScore("high"), null);

console.log("\nDATES ARE COUNTED IN THE TEAM'S OWN DAY");
eq("2:30am UTC is still the previous evening in Chicago", sheetDate("2026-08-25T02:30:00Z"), "8/24/26");
eq("winter is UTC-6, not a hardcoded -5", sheetDate("2026-01-01T05:30:00Z"), "12/31/25");
eq("summer is UTC-5", sheetDate("2026-07-01T04:30:00Z"), "6/30/26");
eq("nothing in, nothing out", sheetDate(null), null);
eq("junk in, nothing out — never today", sheetDate("banana"), null);
ok("the long form is a different, fuller string", sheetDateLong("2026-08-25T02:30:00Z")?.length > sheetDate("2026-08-25T02:30:00Z").length);

console.log("\nSORTING");
const teamName = (id) => ({ u1: "Larry Pike", u2: "Brandon Roberts" }[id] || null);
const companies = new Map([
  ["co1", { id: "co1", name: "Harborline Realty", domain: "harborline.com", site_score: 58 }],
  ["co2", { id: "co2", name: "Acme Serhant", domain: "acme.com", site_score: null }],
  ["co3", { id: "co3", name: "Bright Coast Medspa", domain: "bright.com", site_score: 93 }],
]);
const lists = new Map([["li1", { id: "li1", name: "Luxury Agents" }]]);
const LEADS = [
  { id: "l1", name: "Priya Patel", company_id: "co1", list_id: "li1", stage: "new", owner_id: "u1", claimed_at: days(20), title: "Realtor", email: "p@x.com", state: "CA", created_at: days(20) },
  { id: "l2", name: "Marcus Webb", company_id: "co1", list_id: "li1", stage: "new", owner_id: null, created_at: days(9) },
  { id: "l3", name: "Dana Whitfield", company_id: "co1", stage: "contacted", owner_id: "u2", claimed_at: days(30), claim_contacted_at: days(29), last_touch_at: days(2), created_at: days(30) },
  { id: "l4", name: "Sarah Chen", company_id: "co3", stage: "proposal", owner_id: "u1", claimed_at: days(9), claim_contacted_at: days(8), last_touch_at: days(1), created_at: days(9) },
  { id: "l5", name: "No Firm Person", company_id: null, stage: "new", owner_id: null, created_at: days(2) },
];
const ctx = { companyById: companies, teamName, touchCounts: { l3: 2, l4: 5 }, listById: lists, now: NOW };
const rows = sheetRows(LEADS, ctx);

eq("one row per person — the firm is a column, not a wrapper", rows.length, LEADS.length);
eq("the firm's name comes off the firm record", rows[0].companyName, "Harborline Realty");
eq("a person with no firm still gets a row", rows[4].companyName, null);
eq("the score comes off the firm, not the person", rows[0].score, 58);
eq("an unscored firm is unknown, not zero", sheetRow({ id: "x", company_id: "co2", stage: "new" }, ctx).score, null);
ok("the 90+ gate is on the row", rows[3].gate.skip === true);

const claimSorted = sortRowsBy(rows, { key: "claim", dir: "asc" }).map((r) => r.claim.state);
eq("sorting by claim puts the ones that ran out first", claimSorted[0], "claim_expired");
const byLast = sortRowsBy(rows, { key: "last_touch", dir: "desc" });
ok("rows with no last-touch date sink even when sorting newest-first",
  byLast.slice(-3).every((r) => !r.lead.last_touch_at), byLast.map((r) => r.lead.last_touch_at).join(" | "));
const byScore = sortRowsBy(rows, { key: "site_score", dir: "asc" });
ok("an unscored firm never sorts as the lowest score",
  byScore[0].score !== null, `first row scored ${byScore[0].score}`);
eq("an unknown sort key falls back to the table's own order, not a silent reshuffle",
  sortRowsBy(rows, { key: "not_a_column", dir: "asc" }).map((r) => r.id),
  defaultOrder(rows).map((r) => r.id));
ok("sorting never mutates the array it was given", (() => {
  const before = rows.map((r) => r.id).join();
  sortRowsBy(rows, { key: "company", dir: "desc" });
  return rows.map((r) => r.id).join() === before;
})());
eq("the default order leads with the thing that is late", defaultOrder(rows)[0].claim.state, "claim_expired");
/* PROVEN BY MUTATION, not by hope. A reviewer deleted the null-clock branch in
 * defaultOrder and all 117 checks still passed, because no fixture paired a
 * null-clock row against a clocked one INSIDE THE SAME rank group — which is
 * the only place that branch runs. These two do. */
const sameRank = sheetRows([
  { id: "n1", name: "No clock", company_id: null, stage: "new", owner_id: "u1", claimed_at: "not-a-date", created_at: days(1) },
  { id: "n2", name: "Ten days quiet", company_id: null, stage: "contacted", owner_id: "u1", claimed_at: days(40), claim_contacted_at: days(39), last_touch_at: days(10), created_at: days(40) },
], ctx);
eq("both of those really are in the same claim rank", [...new Set(sameRank.map((r) => r.claim.state))], ["working"]);
eq("inside one rank, the row with a running clock sorts above the one with none",
  defaultOrder(sameRank).map((r) => r.id), ["n2", "n1"]);
eq("...and it is not just input order", defaultOrder([...sameRank].reverse()).map((r) => r.id), ["n2", "n1"]);

console.log("\nSORT IS A THREE-STATE CLICK");
eq("click 1", nextSort(null, "stage"), { key: "stage", dir: "asc" });
eq("click 2", nextSort({ key: "stage", dir: "asc" }, "stage"), { key: "stage", dir: "desc" });
eq("click 3 turns it off", nextSort({ key: "stage", dir: "desc" }, "stage"), null);
eq("a different column starts again", nextSort({ key: "stage", dir: "desc" }, "owner"), { key: "owner", dir: "asc" });
eq("an unsortable column changes nothing", nextSort({ key: "stage", dir: "asc" }, "not_a_column"), { key: "stage", dir: "asc" });

console.log("\nFILTERING AND GROUPING");
eq("an empty owner travels as __none, the same string the filter compares", facetValue(rows[1], "owner"), "__none");
const ownerFacets = facetValues(rows, "owner");
ok("the values menu is commonest first with none last", ownerFacets[ownerFacets.length - 1][0] === "__none", JSON.stringify(ownerFacets));
eq("a column nobody can filter offers nothing", facetValues(rows, "email"), []);
const flat = groupRows(rows, "none", { labelFor: () => "x" });
eq("flat is one unnamed group — that is the whole point of the rebuild", [flat.length, flat[0].label], [1, null]);
const grouped = groupRows(rows, "company", { labelFor: (k, v) => (v === "__none" ? "No firm" : v) });
eq("grouping by company makes three groups", grouped.length, 3);
eq("the no-firm group sorts last", grouped[grouped.length - 1].key, "__none");
eq("an ungroupable column is treated as flat rather than crashing", groupRows(rows, "email", { labelFor: () => "x" }).length, 1);
eq("every row survives grouping", grouped.reduce((n, g) => n + g.rows.length, 0), rows.length);

console.log("\nONE FIRM, ONE REP — THE RULE THE GROUPING USED TO CARRY");
const contested = contestedCompanies(LEADS);
eq("a firm two reps are both working is flagged", contested.get("co1")?.length, 2);
eq("a firm with one rep is not", contested.has("co3"), false);
/* THE ONE THAT MATTERS: counted across the whole pipeline, not the rows on
 * screen. Filtered to your own leads, a contested firm would otherwise stop
 * looking contested at exactly the moment you need telling. */
const mineOnly = LEADS.filter((l) => l.owner_id === "u1");
eq("filtering to your own leads does not hide that somebody else is on the firm",
  contestedCompanies(LEADS).has("co1"), true);
eq("...and computing it from the filtered rows would have hidden it (this is why the whole set is passed)",
  contestedCompanies(mineOnly).has("co1"), false);
eq("headcount counts people at a firm", companyHeadcount(LEADS).get("co1"), 3);
eq("a person with no firm is not counted at a firm", companyHeadcount(LEADS).get(undefined), undefined);
eq("an unclaimed lead does not make a firm contested", contestedCompanies([
  { id: "a", company_id: "c", owner_id: null, stage: "new" }, { id: "b", company_id: "c", owner_id: "u1", stage: "new" },
]).size, 0);
/* The drawer's own warning (companyClaimWarning in lib/sales-rules.js) filters
 * on open stages. This one did not, so a firm where one rep's contact was LOST
 * and another's was live showed "2 reps are working this firm" on every row
 * while the drawer for the same firm showed no warning at all. Two parts of one
 * page giving opposite answers is worse than either answer alone. */
eq("a contact nobody is chasing any more does not make a firm contested", contestedCompanies([
  { id: "a", company_id: "c", owner_id: "u1", stage: "lost" },
  { id: "b", company_id: "c", owner_id: "u2", stage: "contacted" },
]).size, 0);
eq("...and two LIVE contacts still do", contestedCompanies([
  { id: "a", company_id: "c", owner_id: "u1", stage: "meeting" },
  { id: "b", company_id: "c", owner_id: "u2", stage: "contacted" },
]).size, 1);

console.log("\nTHE LIFETIME TIMELINE");
eq("a bare date is not midnight UTC (that is the evening before, in Chicago)", readWhen("2026-08-01"), "2026-08-01T12:00:00.000Z");
eq("junk is not silently filed under today", readWhen("banana"), null);
eq("nothing in, nothing out", readWhen(null), null);

const LEAD = { id: "l1", created_at: "2026-06-01T10:00:00Z", source: "sheet", became_customer: true, became_customer_at: "2026-08-01T15:00:00Z" };
const T = buildPersonTimeline({
  lead: LEAD,
  activity: [
    { id: "a1", created_at: "2026-06-02T10:00:00Z", type: "call", outcome: "talked", body: "Spoke.", actor: "u1" },
    { id: "a2", created_at: "not-a-date", type: "note", body: "undated" },
  ],
  proposals: [{ id: "p1", title: "GEO", sent_at: "2026-07-01T10:00:00Z", viewed_at: null, decided_at: "2026-08-01T15:00:00Z", status: "won", amount_cents: 250000 }],
  tasks: [
    { id: "t1", status: "done", name: "Shipped llms.txt", updated_at: "2026-08-10T10:00:00Z", assigned_to: "u1" },
    { id: "t2", status: "todo", name: "A plan, not a fact" },
  ],
}, { teamName });

eq("newest first", T.events[0].title, "Shipped llms.txt");
eq("the chase and the client work are both on ONE list", T.total, 5);
eq("a to-do is not history", T.events.some((e) => e.title === "A plan, not a fact"), false);
eq("a proposal nobody opened is a non-event, not a dropped entry", T.dropped, 1);
eq("an entry with an unreadable date is counted and reported", timelineSummary(T).includes("1 entry had no readable date"), true);
eq("what was NOT read is named", T.notCounted.length, 4);
ok("the summary names the unread sources", timelineSummary(T).includes("Not counted here"));
eq("the day they started paying is on record", T.becameClientAt, "2026-08-01T15:00:00.000Z");
eq("work done after the sale is client-era", T.events.find((e) => e.title === "Shipped llms.txt").era, "client");
eq("the first call is chase-era", T.events.find((e) => e.head === "Call").era, "chase");
ok("every single line says which table it came from", T.events.every((e) => e.source && e.sourceLabel));
ok("every line is marked logged, system or theirs", T.events.every((e) => ["logged", "system", "theirs"].includes(e.by)));

const NEVER = buildPersonTimeline({ lead: { id: "x", created_at: "2026-06-01T10:00:00Z", source: "manual" }, activity: [] }, {});
eq("somebody who never became a client has no line drawn", NEVER.becameClientAt, null);
ok("...and nothing is marked client-era on a guess", NEVER.events.every((e) => e.era === "chase"));
ok("an unread source and an empty one are worded differently",
  timelineSummary(NEVER).includes("Not counted here") && NEVER.notCounted.includes("proposals"));
eq("a source that WAS read and came back empty is not listed as uncounted",
  buildPersonTimeline({ lead: LEAD, activity: [], proposals: [], tasks: [], weekly: [], reports: [], invoices: [], tickets: [] }, {}).notCounted.length, 0);

const BIG = buildPersonTimeline({
  lead: { id: "b", created_at: "2020-01-01T00:00:00Z" },
  activity: Array.from({ length: TIMELINE_CAP + 25 }, (_, i) => ({
    id: `a${i}`, created_at: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 60000).toISOString(),
    type: "note", body: `n${i}`,
  })),
}, {});
eq("the cap is applied", BIG.events.length, TIMELINE_CAP);
ok("...and the reader is told, with the number", BIG.truncated?.includes(String(BIG.total)), BIG.truncated);
eq("the total is the real total, not the shown count", BIG.total, TIMELINE_CAP + 26);

/* Stability: two rows written in the same millisecond must not swap places on
 * every refresh, which reads as data changing when it is not. */
const same = { lead: null, activity: [
  { id: "b", created_at: "2026-01-01T00:00:00Z", type: "note", body: "b" },
  { id: "a", created_at: "2026-01-01T00:00:00Z", type: "note", body: "a" },
] };
eq("identical timestamps order stably", buildPersonTimeline(same, {}).events.map((e) => e.id), ["a:a", "a:b"]);


console.log("\nTHE TIMELINE'S HONESTY RULES");
/* A bare date is widened; a real timestamp is not. */
eq("a real timestamp is left exactly where it is", readWhen("2026-08-01T17:31:00Z"), "2026-08-01T17:31:00.000Z");
/* admin_invoices.paid_at is `last_paid::timestamptz` — midnight UTC, which is
 * the EVENING BEFORE in Chicago. A payment on the day a deal closed landed on
 * the wrong side of the "became a client" line. */
eq("a midnight-UTC day stamp is read as that DAY, not the evening before",
  readWhen("2026-08-01T00:00:00Z", { dayStamp: true }), "2026-08-01T12:00:00.000Z");
eq("...and only when it is asked for", readWhen("2026-08-01T00:00:00Z"), "2026-08-01T00:00:00.000Z");
eq("...and a real timestamp is never shifted by it",
  readWhen("2026-08-01T17:31:00Z", { dayStamp: true }), "2026-08-01T17:31:00.000Z");

const MONEY = buildPersonTimeline({
  lead: { id: "m", created_at: "2026-06-01T10:00:00Z", became_customer: true, became_customer_at: "2026-08-01T15:00:00Z" },
  proposals: [{ id: "p", title: "GEO", sent_at: "2026-07-01T10:00:00Z", viewed_at: "2026-07-02T10:00:00Z", status: "sent" }],
  invoices: [{ id: "i", number: "INV-1", sent_at: "2026-08-05T00:00:00Z", paid_at: "2026-08-09T00:00:00Z", total_cents: 250000, amount_paid_cents: 120000 }],
  tasks: [{ id: "t", status: "done", name: "Shipped it", updated_at: "2026-08-10T10:00:00Z" }],
}, {});
eq("a proposal THEY opened is attributed to them, not to one of us",
  MONEY.events.find((e) => e.title?.includes("opened by them")).by, "theirs");
eq("a payment reads the real paid column, not the invoice total",
  MONEY.events.find((e) => e.kind === "payment").amountCents, 120000);
eq("a payment recorded on the 9th is shown on the 9th",
  MONEY.events.find((e) => e.kind === "payment").at.slice(0, 10), "2026-08-09");
ok("a finished task says its date is when the task was last edited",
  MONEY.events.find((e) => e.kind === "task").detail.includes("last edited"));

const CAPPED = buildPersonTimeline({
  lead: { id: "c", created_at: "2026-06-01T10:00:00Z" },
  activity: [], proposals: [], tasks: [], weekly: [], reports: [],
  invoices: [], tickets: [], incomplete: ["invoices"],
}, {});
eq("a source read only in part is reported", CAPPED.partial, ["invoices"]);
ok("...and it is worded differently from one that was not read at all",
  timelineSummary(CAPPED).includes("Only partly read") && !timelineSummary(CAPPED).includes("Not counted here"));

/* The star sentence used to promise "everything above it is the work" even when
 * the star was at the very top with nothing above it, and to promise a star at
 * all when none was drawn. */
const ONLY_CHASE = buildPersonTimeline({
  lead: { id: "a", created_at: "2026-06-01T10:00:00Z", became_customer: true, became_customer_at: "2026-08-01T15:00:00Z" },
  activity: [{ id: "x", created_at: "2026-06-02T10:00:00Z", type: "call", body: "b" }],
}, {});
ok("with nothing logged since the sale, it does not promise a 'work' half",
  timelineSummary(ONLY_CHASE).includes("Nothing has been logged since"), timelineSummary(ONLY_CHASE));
const ONLY_AFTER = buildPersonTimeline({
  lead: { id: "b", created_at: "2026-09-01T10:00:00Z", became_customer: true, became_customer_at: "2026-08-01T15:00:00Z" },
  activity: [{ id: "y", created_at: "2026-09-02T10:00:00Z", type: "note", body: "b" }],
}, {});
ok("with nothing before the sale, it does not promise a star that is never drawn",
  !timelineSummary(ONLY_AFTER).includes("The star marks"), timelineSummary(ONLY_AFTER));
const BOTH = buildPersonTimeline({
  lead: { id: "c", created_at: "2026-06-01T10:00:00Z", became_customer: true, became_customer_at: "2026-08-01T15:00:00Z" },
  activity: [
    { id: "x", created_at: "2026-06-02T10:00:00Z", type: "call", body: "b" },
    { id: "y", created_at: "2026-09-02T10:00:00Z", type: "note", body: "b" },
  ],
}, {});
ok("with both halves, it counts each one", timelineSummary(BOTH).includes("from the chase before it"), timelineSummary(BOTH));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
