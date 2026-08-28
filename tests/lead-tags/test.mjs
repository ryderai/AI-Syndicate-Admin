/* TAGS ON A LEAD — the pure half.  Aug 27 2026
 *
 * Plain node against the real modules the browser loads. No mocks of our own
 * code: a test that agrees with a stub is not a test, which this repo learned
 * the hard way when three files wrote column names the tables do not have and
 * every fixture had invented the same wrong names.
 *
 * WHAT THIS FILE IS FOR, IN ONE LINE EACH:
 *   1. the tag vocabulary exists in THREE places on purpose (the SQL seed, the
 *      rules file, the preview store) and this is the test that stops them
 *      drifting apart;
 *   2. every band function returns "I do not know" rather than a confident
 *      wrong default;
 *   3. the automatic rules read the clock that is handed to them and never the
 *      machine's;
 *   4. an automatic tag a person took off by hand is never put back;
 *   5. two reads of the same events give the same answer, ties and all;
 *   6. a close cannot be saved without a reason somebody can read back.
 */
import { readFileSync } from "node:fs";
import {
  TAG, TAG_SLUGS, EXCLUSIVE_TAG_GROUPS, QUIET_AFTER_DAYS, ROE,
  sizeBandTag, scoreBandTag, autoTagState,
  checkCloseReason, WON_REASONS, LOST_REASONS, MIN_REASON_NOTE_CHARS, reasonLabel,
} from "../../lib/sales-rules.js";
import {
  latestPerTag, currentTags, currentSlugs, removedByHand, autoTagPlan,
  tagIndex, eventsByLead, tagCounts, tagHistory,
} from "../../lib/lead-tags.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const src = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

/* A fixed clock. Nothing below reads the machine's. */
const NOW = "2026-08-25T15:00:00Z";
const days = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString();

/* ================================================================== */
console.log("\nTHE VOCABULARY CANNOT DRIFT FROM THE DATABASE");
/* ================================================================== */
/* There are three copies of this vocabulary and that is deliberate: the SQL
 * seed is what a fresh database gets, TAG/TAG_SLUGS is what the rules point at,
 * and previewStore.leadTags is what preview mode rehearses with. Deriving any
 * one from another would either put a slug on a chip where the console shows a
 * label, or make preview mode a rehearsal of something the real database does
 * not have. So they are copied — and this section is the reason that is safe.
 *
 * Read out of the files as TEXT, the same way tests/sales/test.mjs reads the
 * stage CHECK constraint out of 0009. Importing src/lib/data.js would pull in
 * the browser's Supabase client; the seed cannot be imported at all. */

const SQL = src("supabase/migrations/0018_lead_tags.sql");
const seedBlock = /insert into public\.admin_lead_tags \(([^)]*)\) values([\s\S]*?)on conflict \(slug\) do nothing/.exec(SQL);
ok("the seed statement is where this test expects it in 0018", Boolean(seedBlock));
eq("...and its columns are the ones parsed below",
  seedBlock[1].split(",").map((s) => s.trim()),
  ["slug", "label", "color", "tag_group", "auto_rule", "sort"]);

const seedRows = [...seedBlock[2].matchAll(
  /\(\s*'([a-z0-9-]+)'\s*,\s*'([^']*)'\s*,\s*'([a-z]+)'\s*,\s*'([a-z]+)'\s*,\s*'([^']*)'\s*,\s*(\d+)\s*\)/g,
)].map((m) => ({ slug: m[1], label: m[2], color: m[3], tag_group: m[4], sort: Number(m[6]) }));
/* Counted against the raw number of `('...` row openers, so a row this regex
 * cannot read is a FAILURE rather than a row silently missing from the compare.
 * A parser that skips what it does not understand agrees with anything. */
eq("every row of the seed was actually parsed",
  seedRows.length, (seedBlock[2].match(/\n\s*\('/g) || []).length);

const DATA = src("src/lib/data.js");
const previewBlock = /leadTags: \[([\s\S]*?)\n {2}\],/.exec(DATA);
ok("previewStore.leadTags is where this test expects it in src/lib/data.js", Boolean(previewBlock));
const previewRows = [...previewBlock[1].matchAll(
  /\{\s*id:\s*"([^"]+)",\s*slug:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*color:\s*"([^"]+)",\s*tag_group:\s*"([^"]+)",\s*sort:\s*(\d+),\s*active:\s*(true|false)\s*\}/g,
)].map((m) => ({ id: m[1], slug: m[2], label: m[3], color: m[4], tag_group: m[5], sort: Number(m[6]), active: m[7] === "true" }));
eq("every row of the preview store was actually parsed",
  previewRows.length, (previewBlock[1].match(/\{ id: /g) || []).length);

/* THE THREE-WAY COMPARE. Order included: the seed's order, the rules' order and
 * the preview store's order are the order the filter menu is built in, and a
 * reordered copy is a menu that reads differently in preview from live. */
eq("the SQL seed's slugs are EXACTLY TAG_SLUGS, in the same order",
  seedRows.map((r) => r.slug), TAG_SLUGS);
eq("previewStore.leadTags' slugs are EXACTLY TAG_SLUGS, in the same order",
  previewRows.map((r) => r.slug), TAG_SLUGS);
ok("every slug in the TAG map is reachable through TAG_SLUGS",
  Object.values(TAG).every((s) => TAG_SLUGS.includes(s)) && TAG_SLUGS.length === Object.keys(TAG).length);

for (const seed of seedRows) {
  const prev = previewRows.find((r) => r.slug === seed.slug);
  eq(`"${seed.slug}" — the label, colour, group and sort agree between the SQL seed and the preview store`,
    prev && { label: prev.label, color: prev.color, tag_group: prev.tag_group, sort: prev.sort },
    { label: seed.label, color: seed.color, tag_group: seed.tag_group, sort: seed.sort });
}
ok("every seeded tag is active in the preview store, so the rules can reach all of them",
  previewRows.every((r) => r.active === true));
eq("no two tags share a sort, so the filter menu has one fixed order",
  new Set(seedRows.map((r) => r.sort)).size, seedRows.length);
/* The score band label and ROE.SKIP_SCORE_AT_OR_ABOVE are the same number
 * written twice, once as code and once as words on a chip. 0018's own comment
 * says so; this is the assertion behind the comment. */
ok(`the 'scored-90-plus' chip says ${ROE.SKIP_SCORE_AT_OR_ABOVE}, the number the rule actually uses`,
  seedRows.find((r) => r.slug === TAG.SCORED_90_PLUS).label.includes(String(ROE.SKIP_SCORE_AT_OR_ABOVE)));
ok(`the 'quiet' chip says ${QUIET_AFTER_DAYS} days and the 'cold' chip says ${ROE.COLD_REOPEN_DAYS}`,
  seedRows.find((r) => r.slug === TAG.QUIET).label.includes(String(QUIET_AFTER_DAYS))
  && seedRows.find((r) => r.slug === TAG.COLD).label.includes(String(ROE.COLD_REOPEN_DAYS)));
/* An exclusive group naming a slug the vocabulary does not hold is a group that
 * can never be enforced, and nothing would say so. */
for (const [group, slugs] of Object.entries(EXCLUSIVE_TAG_GROUPS)) {
  ok(`every slug in the exclusive "${group}" group is a real tag`, slugs.every((s) => TAG_SLUGS.includes(s)));
  ok(`...and every one of them is filed under a single tag_group in the seed`,
    new Set(slugs.map((s) => seedRows.find((r) => r.slug === s)?.tag_group)).size === 1);
}
/* 'tag' has to be an allowed activity type or setLeadTag's timeline line fails
 * on every single write. Asserted here as well as in sql.sh because a check
 * constraint is cheap to read as text and expensive to stand a Postgres up for. */
const actCheck = /admin_lead_activity_type_check[\s\S]*?check \(type in \(([\s\S]*?)\)\)/.exec(SQL);
ok("0018 re-declares the activity type constraint", Boolean(actCheck));
const actTypes = [...actCheck[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
ok("'tag' is a thing that can happen to a lead", actTypes.includes("tag"));
/* THE FAILURE THIS GUARDS, VERBATIM FROM 0018's OWN HEADER: a past migration
 * lost 'email' from this check by re-adding it without re-listing every value,
 * and a button broke for days. Every value 0015 allowed must still be here. */
for (const t of ["call", "email", "text", "linkedin", "note", "status_change", "assigned",
  "claim", "unclaim", "reopen", "score", "proposal", "import", "cadence", "open",
  "converted", "client_link"]) {
  ok(`...and '${t}' is still allowed, so adding 'tag' broke nothing`, actTypes.includes(t));
}

/* ================================================================== */
console.log("\nA HEAD COUNT NOBODY FILLED IN IS NOT A ONE-PERSON FIRM");
/* ================================================================== */
/* Number(null) is 0 and Number("") is 0, so the obvious version of this
 * function files every firm the sheet left blank as a solo operator — and solo
 * is the band a rep pitches differently, so it is not a harmless default. */
eq("null is not a solo firm", sizeBandTag(null), null);
eq("an empty cell is not a solo firm", sizeBandTag(""), null);
eq("a whitespace-only cell is not a solo firm", sizeBandTag("   "), null);
eq("undefined is not a solo firm", sizeBandTag(undefined), null);
eq("a head count of zero is not a solo firm — it is not a head count", sizeBandTag(0), null);
eq("a negative head count is not a solo firm", sizeBandTag(-1), null);
eq("text is not a solo firm", sizeBandTag("abc"), null);
eq("one person is solo", sizeBandTag(1), TAG.SIZE_SOLO);
eq("two is the bottom of small", sizeBandTag(2), TAG.SIZE_SMALL);
eq("ten is the top of small", sizeBandTag(10), TAG.SIZE_SMALL);
eq("eleven is the bottom of mid", sizeBandTag(11), TAG.SIZE_MID);
eq("fifty is the top of mid", sizeBandTag(50), TAG.SIZE_MID);
eq("fifty-one is large", sizeBandTag(51), TAG.SIZE_LARGE);
eq("a number as a string is read", sizeBandTag("7"), TAG.SIZE_SMALL);

/* ================================================================== */
console.log("\nA SCORE NOBODY RAN IS 'UNSCANNED', AND ZERO IS A REAL SCORE");
/* ================================================================== */
eq("no score is unscanned, not a band", scoreBandTag(null), TAG.UNSCANNED);
eq("an empty cell is unscanned, not a score of zero", scoreBandTag(""), TAG.UNSCANNED);
eq("150 is not a score, so it is unscanned rather than 90+", scoreBandTag(150), TAG.UNSCANNED);
eq("-5 is not a score, so it is unscanned rather than the widest gap", scoreBandTag(-5), TAG.UNSCANNED);
eq("text is unscanned", scoreBandTag("high"), TAG.UNSCANNED);
eq("ZERO IS A REAL SCORE and lands in the bottom band", scoreBandTag(0), TAG.SCORED_UNDER_60);
eq("59 is the top of under-60", scoreBandTag(59), TAG.SCORED_UNDER_60);
eq("60 is the bottom of the 60s", scoreBandTag(60), TAG.SCORED_60S);
eq("79 is the top of the 60s band", scoreBandTag(79), TAG.SCORED_60S);
eq("80 is the bottom of the 80s", scoreBandTag(80), TAG.SCORED_80S);
eq("89 is the top of the 80s", scoreBandTag(89), TAG.SCORED_80S);
eq("100 is 90-plus", scoreBandTag(100), TAG.SCORED_90_PLUS);
/* The boundary is READ FROM THE CONSTANT, not typed in. If the skip threshold
 * ever moves, this assertion moves with it instead of quietly pinning 90. */
eq(`the top band starts at ROE.SKIP_SCORE_AT_OR_ABOVE (${ROE.SKIP_SCORE_AT_OR_ABOVE}), not at a typed-in 90`,
  scoreBandTag(ROE.SKIP_SCORE_AT_OR_ABOVE), TAG.SCORED_90_PLUS);
eq("...and one below it is not the top band",
  scoreBandTag(ROE.SKIP_SCORE_AT_OR_ABOVE - 1), TAG.SCORED_80S);
eq("a numeric string is read", scoreBandTag("93"), TAG.SCORED_90_PLUS);

/* ================================================================== */
console.log("\nTHE AUTOMATIC RULES READ THE CLOCK THEY ARE HANDED");
/* ================================================================== */
const state = (lead, opts = {}) => autoTagState(lead, { now: NOW, ...opts });
const wants = (lead, opts) => [...state(lead, opts).want.keys()].sort();
const owns = (lead, opts) => [...state(lead, opts).owns].sort();

/* THE ONE THAT MATTERS MOST: same lead, two clocks, two answers. A rule that
 * read `new Date()` inside itself would give the same answer for both, and
 * three date bugs shipped in this repo in one day from exactly that. */
const AGING = {
  id: "a", stage: "contacted", owner_id: "u1",
  claimed_at: "2026-08-01T12:00:00Z", claim_contacted_at: "2026-08-01T13:00:00Z",
  last_touch_at: "2026-08-01T13:00:00Z",
};
ok("eight days after the last touch the lead is quiet, not cold",
  wants(AGING, { now: "2026-08-09T15:00:00Z" }).includes(TAG.QUIET));
ok("twenty days after it, the SAME lead is cold",
  wants(AGING, { now: "2026-08-21T15:00:00Z" }).includes(TAG.COLD));
ok("...and it is not both at once", (() => {
  const w = wants(AGING, { now: "2026-08-21T15:00:00Z" });
  return !w.includes(TAG.QUIET);
})());
/* The days are counted in America/Chicago through Intl, so the answer cannot
 * depend on where the machine running the sweep happens to be. run.sh runs the
 * whole file in five zones; this asserts it inside one process too. */
ok("the answer does not change with the machine's timezone", (() => {
  const before = process.env.TZ;
  const readIn = (tz) => { process.env.TZ = tz; return JSON.stringify(wants(AGING, { now: "2026-08-09T15:00:00Z" })); };
  const a = readIn("Pacific/Auckland");
  const b = readIn("America/Los_Angeles");
  const c = readIn("UTC");
  process.env.TZ = before;
  return a === b && b === c;
})());

console.log("  -- the website");
eq("no website anywhere means no-website", wants({ id: "a", stage: "new" }).includes(TAG.NO_WEBSITE), true);
eq("...and never has-website at the same time", wants({ id: "a", stage: "new" }).includes(TAG.HAS_WEBSITE), false);
ok("a website on the firm means has-website",
  wants({ id: "a", stage: "new" }, { company: { domain: "x.com" } }).includes(TAG.HAS_WEBSITE));
ok("a website on the PERSON counts too, because a hand-added contact has no firm row",
  wants({ id: "a", stage: "new", domain: "x.com" }).includes(TAG.HAS_WEBSITE));
ok("a whitespace-only domain is not a website",
  wants({ id: "a", stage: "new", domain: "   " }).includes(TAG.NO_WEBSITE));
ok("the website group is always OWNED, so the wrong one gets taken off",
  EXCLUSIVE_TAG_GROUPS.website.every((s) => owns({ id: "a", stage: "new" }).includes(s)));

console.log("  -- the head count");
/* THE RULES OWN NOTHING THEY CANNOT ANSWER. With no head count they say nothing
 * about size and leave alone whatever a person set by hand — removing somebody's
 * size tag because the sheet has a blank cell would be the rules destroying
 * better information than they have. */
const noHeads = state({ id: "a", stage: "new" }, { company: { domain: "x.com" } });
ok("a null head count means the rules own NO size tag at all",
  EXCLUSIVE_TAG_GROUPS.size.every((s) => !noHeads.owns.has(s)),
  [...noHeads.owns].join(", "));
ok("...and want none either", EXCLUSIVE_TAG_GROUPS.size.every((s) => !noHeads.want.has(s)));
const heads = state({ id: "a", stage: "new" }, { company: { employees: 5 } });
ok("a head count that reads owns the whole size group, so the wrong band comes off",
  EXCLUSIVE_TAG_GROUPS.size.every((s) => heads.owns.has(s)));
eq("...and wants exactly one band", [...heads.want.keys()].filter((s) => EXCLUSIVE_TAG_GROUPS.size.includes(s)), [TAG.SIZE_SMALL]);
ok("the reason on the line quotes the head count it read", heads.want.get(TAG.SIZE_SMALL).includes("5"));

console.log("  -- the score");
ok("an unscored firm is owned and wanted as unscanned",
  state({ id: "a", stage: "new" }).owns.has(TAG.UNSCANNED) && wants({ id: "a", stage: "new" }).includes(TAG.UNSCANNED));
eq("a scored firm wants exactly one band",
  [...state({ id: "a", stage: "new" }, { company: { site_score: 72 } }).want.keys()].filter((s) => EXCLUSIVE_TAG_GROUPS.score.includes(s)),
  [TAG.SCORED_60S]);
ok("the whole score group is always owned",
  EXCLUSIVE_TAG_GROUPS.score.every((s) => owns({ id: "a", stage: "new" }).includes(s)));
ok("the reason says there is no score rather than printing a zero",
  /no website score/i.test(state({ id: "a", stage: "new" }).want.get(TAG.UNSCANNED)));

console.log("  -- has anybody spoken to them");
ok("nothing logged and no first-contact date is never-touched",
  wants({ id: "a", stage: "new" }).includes(TAG.NEVER_TOUCHED));
ok("A LOGGED TOUCH clears it", !wants({ id: "a", stage: "new" }, { touchCount: 1 }).includes(TAG.NEVER_TOUCHED));
/* Both halves, because they answer different questions: touchCount is what we
 * can READ, first_contact_at is also written by the import from what the sheet
 * TOLD us. Either one means this is not an untouched lead. */
ok("A FIRST-CONTACT DATE FROM THE SHEET clears it too, with no touch rows at all",
  !wants({ id: "a", stage: "new", first_contact_at: days(30) }).includes(TAG.NEVER_TOUCHED));
ok("an unreadable touch count is not treated as a touch",
  wants({ id: "a", stage: "new" }, { touchCount: "banana" }).includes(TAG.NEVER_TOUCHED));
ok("never-touched is always owned, so it comes off the moment somebody calls",
  owns({ id: "a", stage: "new" }, { touchCount: 4 }).includes(TAG.NEVER_TOUCHED));

console.log("  -- replied, bounced, imported");
ok("a reply on file is hot", wants({ id: "a", stage: "new", first_reply_at: days(1) }).includes(TAG.HOT));
ok("no reply is not hot", !wants({ id: "a", stage: "new" }).includes(TAG.HOT));
ok("hot is always owned, so it is removable when the column is cleared", owns({ id: "a", stage: "new" }).includes(TAG.HOT));
ok("a bounce on file is bounced", wants({ id: "a", stage: "new", bounced_at: days(1) }).includes(TAG.BOUNCED));
ok("bounced is always owned", owns({ id: "a", stage: "new" }).includes(TAG.BOUNCED));
for (const s of ["sheet", "import", "csv"]) {
  ok(`source "${s}" is an import`, wants({ id: "a", stage: "new", source: s }).includes(TAG.IMPORTED));
}
ok("a hand-typed lead is not imported", !wants({ id: "a", stage: "new", source: "manual" }).includes(TAG.IMPORTED));
/* Only owned when it IS an import. Owning it always would strip `imported` off
 * any lead somebody had tagged that way on purpose. */
ok("'imported' is NOT owned on a lead that did not come from an import",
  !owns({ id: "a", stage: "new", source: "manual" }).includes(TAG.IMPORTED));

console.log("  -- the claim clock");
const CLOCK = { id: "a", stage: "contacted", owner_id: "u1", claimed_at: days(40), claim_contacted_at: days(39) };
ok(`quiet fires at exactly QUIET_AFTER_DAYS (${QUIET_AFTER_DAYS})`,
  wants({ ...CLOCK, last_touch_at: days(QUIET_AFTER_DAYS) }).includes(TAG.QUIET));
ok("...and not the day before",
  !wants({ ...CLOCK, last_touch_at: days(QUIET_AFTER_DAYS - 1) }).includes(TAG.QUIET));
ok(`cold fires at exactly ROE.COLD_REOPEN_DAYS (${ROE.COLD_REOPEN_DAYS}), the same day the sweep hands the firm back`,
  wants({ ...CLOCK, last_touch_at: days(ROE.COLD_REOPEN_DAYS) }).includes(TAG.COLD));
ok("...and quiet is not also on at that point",
  !wants({ ...CLOCK, last_touch_at: days(ROE.COLD_REOPEN_DAYS) }).includes(TAG.QUIET));
ok("an unreadable last-touch date tags neither quiet nor cold — a guess here hands somebody's firm back",
  (() => {
    const w = wants({ id: "a", stage: "contacted", owner_id: "u1", claimed_at: "banana", claim_contacted_at: "banana" });
    return !w.includes(TAG.QUIET) && !w.includes(TAG.COLD);
  })());
ok("a claim past its first-contact window is claim-expiring",
  wants({ id: "a", stage: "new", owner_id: "u1", claimed_at: days(20) }).includes(TAG.CLAIM_EXPIRING));
ok("a claim inside the warning window is claim-expiring too",
  wants({ id: "a", stage: "new", owner_id: "u1", claimed_at: days(2) }).includes(TAG.CLAIM_EXPIRING));
ok("a claim made this morning is not",
  !wants({ id: "a", stage: "new", owner_id: "u1", claimed_at: days(0.2) }).includes(TAG.CLAIM_EXPIRING));

/* THE HALF THAT TAKES THEM OFF AGAIN. All three are owned unconditionally, so
 * closing a lead or handing it back removes them — but none is WANTED, because
 * nothing has gone quiet if nobody holds it and a won deal is not going cold.
 * Owning without wanting is exactly how a rule takes a tag off. */
for (const [what, lead] of [
  ["a lead nobody has claimed", { id: "a", stage: "new", owner_id: null, last_touch_at: days(40) }],
  ["a won lead", { id: "a", stage: "won", owner_id: "u1", claimed_at: days(60), last_touch_at: days(40) }],
  ["a lost lead", { id: "a", stage: "lost", owner_id: "u1", claimed_at: days(60), last_touch_at: days(40) }],
  ["a lead parked as Skip", { id: "a", stage: "skip_90", owner_id: "u1", claimed_at: days(60), last_touch_at: days(40) }],
]) {
  const st = state(lead);
  ok(`${what} OWNS quiet, cold and claim-expiring, so they get taken off`,
    [TAG.QUIET, TAG.COLD, TAG.CLAIM_EXPIRING].every((s) => st.owns.has(s)));
  ok(`...and wants none of them`,
    [TAG.QUIET, TAG.COLD, TAG.CLAIM_EXPIRING].every((s) => !st.want.has(s)));
}

console.log("  -- the finished states");
ok("won is tagged won", wants({ id: "a", stage: "won" }).includes(TAG.WON));
ok("lost is tagged lost", wants({ id: "a", stage: "lost" }).includes(TAG.LOST));
ok("skip_90 is tagged skip-90", wants({ id: "a", stage: "skip_90" }).includes(TAG.SKIP_90));
ok("a live lead carries none of the three",
  [TAG.WON, TAG.LOST, TAG.SKIP_90].every((s) => !wants({ id: "a", stage: "contacted", owner_id: "u1" }).includes(s)));
ok("all three are always owned, so re-opening a lead clears them",
  [TAG.WON, TAG.LOST, TAG.SKIP_90].every((s) => owns({ id: "a", stage: "new" }).includes(s)));
/* Every reason is a sentence a rep reads on the dated line. An empty one makes
 * the history unreadable, which is the whole thing the log exists for. */
ok("every wanted tag carries a reason in plain words", (() => {
  const st = state({ id: "a", stage: "contacted", owner_id: "u1", claimed_at: days(40), claim_contacted_at: days(39), last_touch_at: days(9), source: "sheet", first_reply_at: days(3), bounced_at: days(2) },
    { company: { domain: "x.com", employees: 12, site_score: 41 }, touchCount: 2 });
  return [...st.want.values()].every((why) => typeof why === "string" && why.trim().length > 10);
})());
ok("every tag the rules want is one they also own — a rule cannot add what it cannot take off", (() => {
  const st = state({ id: "a", stage: "won", owner_id: "u1", source: "csv", first_reply_at: days(3) },
    { company: { domain: "x.com", employees: 60, site_score: 95 } });
  return [...st.want.keys()].every((s) => st.owns.has(s));
})());
ok("every tag the rules touch is in the vocabulary", (() => {
  const st = state({ id: "a", stage: "lost", owner_id: "u1", source: "sheet", bounced_at: days(1) },
    { company: { employees: 1, site_score: 0 } });
  return [...st.owns].every((s) => TAG_SLUGS.includes(s));
})());
ok("now may be given as a Date or a number, not only a string",
  JSON.stringify(wants(AGING, { now: new Date("2026-08-09T15:00:00Z") })) === JSON.stringify(wants(AGING, { now: "2026-08-09T15:00:00Z" }))
  && JSON.stringify(wants(AGING, { now: Date.parse("2026-08-09T15:00:00Z") })) === JSON.stringify(wants(AGING, { now: "2026-08-09T15:00:00Z" })));

/* ================================================================== */
console.log("\nAN AUTOMATIC TAG A PERSON TOOK OFF BY HAND IS NEVER PUT BACK");
/* ================================================================== */
/* The rule that makes automatic tags bearable, and it is not a flag anybody has
 * to remember to set — it falls out of the event log. Built here by hand so the
 * mechanism is proved rather than assumed. */
const VOCAB = [
  { id: "t-quiet", slug: TAG.QUIET, label: "Gone quiet (7d)", color: "yellow", tag_group: "state", sort: 51, active: true },
  { id: "t-cold", slug: TAG.COLD, label: "Cold (14d)", color: "red", tag_group: "state", sort: 52, active: true },
  { id: "t-hot", slug: TAG.HOT, label: "Replied", color: "green", tag_group: "state", sort: 50, active: true },
  { id: "t-nowebsite", slug: TAG.NO_WEBSITE, label: "No website", color: "red", tag_group: "website", sort: 10, active: true },
  { id: "t-haswebsite", slug: TAG.HAS_WEBSITE, label: "Has a website", color: "gray", tag_group: "website", sort: 11, active: true },
  { id: "t-unscanned", slug: TAG.UNSCANNED, label: "Not scanned yet", color: "yellow", tag_group: "score", sort: 40, active: true },
  { id: "t-nevertouched", slug: TAG.NEVER_TOUCHED, label: "Never touched", color: "yellow", tag_group: "source", sort: 30, active: true },
  { id: "t-off", slug: "switched-off", label: "Switched off", color: "gray", tag_group: "state", sort: 99, active: false },
];
const { byId: IDX_ID, bySlug: IDX_SLUG } = tagIndex(VOCAB);
eq("a deactivated tag stays readable by id", Boolean(IDX_ID.get("t-off")), true);
eq("...and is not offered to the rules", IDX_SLUG.has("switched-off"), false);
eq("a row with no id is skipped rather than keyed on undefined", tagIndex([{ slug: "x" }]).byId.size, 0);

const QUIET_LEAD = { id: "L", stage: "contacted", owner_id: "u1", claimed_at: days(40), claim_contacted_at: days(39), last_touch_at: days(9) };
const plan = (events) => autoTagPlan(QUIET_LEAD, { now: NOW, events, tagsBySlug: IDX_SLUG, tagsById: IDX_ID });

eq("with no history at all, the rules want to ADD quiet",
  plan([]).add.map((a) => a.slug).includes(TAG.QUIET), true);
/* THE RULE. Newest event for `quiet` is a removal by a person → left alone. */
const HAND_OFF = [
  { id: "e1", lead_id: "L", tag_id: "t-quiet", action: "added", at: days(10), by: null, source: "auto", why: "7 days with no update." },
  { id: "e2", lead_id: "L", tag_id: "t-quiet", action: "removed", at: days(2), by: "u1", source: "person", why: "removed by hand — she replied" },
];
eq("a tag a PERSON removed is not put back, even though the rule still applies",
  plan(HAND_OFF).add.map((a) => a.slug).includes(TAG.QUIET), false);
eq("...and removedByHand() is what says so", removedByHand(HAND_OFF, "t-quiet"), true);
/* THE MIRROR. A removal by the SYSTEM is not a decision, so the rule may act
 * again — otherwise a lead that went quiet, replied, and went quiet again would
 * never be flagged a second time. */
const AUTO_OFF = [
  { id: "e1", lead_id: "L", tag_id: "t-quiet", action: "added", at: days(20), by: null, source: "auto", why: "7 days with no update." },
  { id: "e2", lead_id: "L", tag_id: "t-quiet", action: "removed", at: days(12), by: null, source: "auto", why: "the rule that added it no longer applies" },
];
eq("a tag the SYSTEM removed IS put back when the rule applies again",
  plan(AUTO_OFF).add.map((a) => a.slug).includes(TAG.QUIET), true);
eq("...and removedByHand() says it was not a person", removedByHand(AUTO_OFF, "t-quiet"), false);
eq("an IMPORT removal is not a hand removal either", removedByHand([
  { id: "e1", lead_id: "L", tag_id: "t-quiet", action: "removed", at: days(1), by: null, source: "import" },
], "t-quiet"), false);
/* An ADD by a person is not a removal, and must not be mistaken for one. */
eq("a tag a person ADDED is not treated as removed by hand", removedByHand([
  { id: "e1", lead_id: "L", tag_id: "t-quiet", action: "added", at: days(1), by: "u1", source: "person" },
], "t-quiet"), false);
/* AND THE ONE THAT MAKES IT A LOG RATHER THAN A FLAG: a person took it off,
 * then somebody put it back on by hand. The newest event wins. */
eq("a hand removal followed by a hand ADD lets the rules act again", removedByHand([
  { id: "e1", lead_id: "L", tag_id: "t-quiet", action: "removed", at: days(5), by: "u1", source: "person" },
  { id: "e2", lead_id: "L", tag_id: "t-quiet", action: "added", at: days(4), by: "u1", source: "person" },
], "t-quiet"), false);
eq("a tag with no events at all was not removed by hand", removedByHand([], "t-quiet"), false);

console.log("  -- taking a tag off");
/* Owned, on the lead, and no longer wanted → removed, with a reason. */
const WARM = { id: "L", stage: "contacted", owner_id: "u1", claimed_at: days(40), claim_contacted_at: days(39), last_touch_at: days(1) };
const ONQUIET = [{ id: "e1", lead_id: "L", tag_id: "t-quiet", action: "added", at: days(10), by: null, source: "auto", why: "7 days." }];
const warmPlan = autoTagPlan(WARM, { now: NOW, events: ONQUIET, tagsBySlug: IDX_SLUG, tagsById: IDX_ID });
eq("a lead that has been touched again has quiet TAKEN OFF", warmPlan.remove.map((r) => r.slug), [TAG.QUIET]);
ok("...with a reason on the line, so the history reads", warmPlan.remove[0].why.length > 10);
eq("a tag that is not on the lead is not 'removed' again",
  autoTagPlan(WARM, { now: NOW, events: [], tagsBySlug: IDX_SLUG, tagsById: IDX_ID }).remove.length, 0);
/* A tag the rules do not own is never touched, however it got there. `hot` here
 * IS owned; `switched-off` is not owned by any rule. */
const HANDTAG = [{ id: "e1", lead_id: "L", tag_id: "t-off", action: "added", at: days(3), by: "u1", source: "person", why: "by hand" }];
eq("a tag no rule owns is left exactly where it is",
  autoTagPlan(WARM, { now: NOW, events: HANDTAG, tagsBySlug: IDX_SLUG, tagsById: IDX_ID }).remove.length, 0);
eq("a tag on the lead that is already wanted is not added twice",
  autoTagPlan(QUIET_LEAD, { now: NOW, events: ONQUIET, tagsBySlug: IDX_SLUG, tagsById: IDX_ID }).add.map((a) => a.slug).includes(TAG.QUIET), false);

console.log("  -- a slug the vocabulary does not hold");
/* Skipped and counted, never guessed at: writing an event needs a real tag id,
 * and inventing one breaks the foreign key at best and points at the wrong tag
 * at worst. */
const THIN = new Map([[TAG.QUIET, VOCAB[0]]]);
const thinPlan = autoTagPlan(QUIET_LEAD, { now: NOW, events: [], tagsBySlug: THIN, tagsById: IDX_ID });
ok("a slug with no row in the vocabulary is reported in `unknown`",
  thinPlan.unknown.includes(TAG.NO_WEBSITE) && thinPlan.unknown.includes(TAG.UNSCANNED), JSON.stringify(thinPlan.unknown));
ok("...and is NOT guessed at — nothing is planned for it",
  thinPlan.add.every((a) => THIN.has(a.slug)));
eq("...and every unknown slug is reported once, not once per rule",
  thinPlan.unknown.length, new Set(thinPlan.unknown).size);
eq("with the whole vocabulary loaded, nothing is unknown",
  autoTagPlan(QUIET_LEAD, { now: NOW, events: [], tagsBySlug: IDX_SLUG, tagsById: IDX_ID }).unknown, []);
eq("with NO vocabulary at all, nothing is written and everything is reported",
  (() => { const p = autoTagPlan(QUIET_LEAD, { now: NOW, events: [] }); return [p.add.length, p.remove.length, p.unknown.length > 0]; })(),
  [0, 0, true]);
ok("every planned add carries the tag id the write needs",
  autoTagPlan(QUIET_LEAD, { now: NOW, events: [], tagsBySlug: IDX_SLUG, tagsById: IDX_ID }).add.every((a) => a.tag_id && a.slug && a.why));

/* ================================================================== */
console.log("\nREPLAYING THE LOG — AND TIES ARE ORDINARY, NOT RARE");
/* ================================================================== */
const SAME = days(3);
/* An import writes several events in ONE statement and Postgres gives them all
 * the same now(), so two events on one tag with an identical `at` is the
 * ordinary case. Without a tie-break, "which tag won" flips between page loads
 * and nobody can reproduce it. The tie-break is the id, and it must agree with
 * `order by at desc, id desc` in the admin_lead_tags_now view (0018). */
const TIE = [
  { id: "e-aaa", lead_id: "L", tag_id: "t-quiet", action: "added", at: SAME, by: null, source: "import" },
  { id: "e-zzz", lead_id: "L", tag_id: "t-quiet", action: "removed", at: SAME, by: "u1", source: "person" },
];
eq("with an identical timestamp, the HIGHER id wins — the same rule the SQL view uses",
  latestPerTag(TIE).get("t-quiet").id, "e-zzz");
eq("...and reading the same rows in the other order gives the same answer",
  latestPerTag([...TIE].reverse()).get("t-quiet").id, "e-zzz");
eq("...so currentTags agrees both ways round", [
  currentTags(TIE, IDX_ID).length, currentTags([...TIE].reverse(), IDX_ID).length,
], [0, 0]);
eq("a later timestamp beats a higher id — time first, id only as the tie-break",
  latestPerTag([
    { id: "e-zzz", lead_id: "L", tag_id: "t-quiet", action: "removed", at: days(9), source: "person" },
    { id: "e-aaa", lead_id: "L", tag_id: "t-quiet", action: "added", at: days(1), source: "auto" },
  ]).get("t-quiet").id, "e-aaa");

const HISTORY = [
  { id: "h1", lead_id: "L", tag_id: "t-nevertouched", action: "added", at: days(9), by: null, source: "import", why: "On import." },
  { id: "h2", lead_id: "L", tag_id: "t-quiet", action: "added", at: days(4), by: null, source: "auto", why: "7 days with no update." },
  { id: "h3", lead_id: "L", tag_id: "t-quiet", action: "removed", at: days(2), by: "u1", source: "person", why: "removed by hand — she replied" },
  { id: "h4", lead_id: "L", tag_id: "t-hot", action: "added", at: days(1), by: "u1", source: "person", why: null },
];
eq("a tag whose newest event is a removal is NOT on the lead", [...currentSlugs(HISTORY, IDX_ID)].sort(), [TAG.HOT, TAG.NEVER_TOUCHED].sort());
eq("removals are still IN the log — that is how the rules know", latestPerTag(HISTORY).size, 3);
eq("the chips come back in the vocabulary's own sort order, so two rows never disagree",
  currentTags(HISTORY, IDX_ID).map((t) => t.slug), [TAG.NEVER_TOUCHED, TAG.HOT]);
eq("a chip carries the label a person reads, not the slug",
  currentTags(HISTORY, IDX_ID).map((t) => t.label), ["Never touched", "Replied"]);
/* An event pointing at a tag nobody kept in the vocabulary is still a record of
 * something that happened, so it is shown rather than dropped. */
const ORPHAN = [{ id: "o1", lead_id: "L", tag_id: "t-vanished", action: "added", at: days(1), source: "person" }];
eq("an event pointing at a tag the vocabulary has lost is still shown", currentTags(ORPHAN, IDX_ID).length, 1);
eq("...worded as unknown rather than blank", currentTags(ORPHAN, IDX_ID)[0].label, "unknown tag");
eq("...and it is not counted as a slug, because there is no slug to filter on", currentSlugs(ORPHAN, IDX_ID).size, 0);
eq("...and it sorts last rather than first", currentTags([...ORPHAN, ...HISTORY], IDX_ID).map((t) => t.slug), [TAG.NEVER_TOUCHED, TAG.HOT, null]);
eq("an event with no tag_id is skipped rather than keyed on undefined", latestPerTag([{ id: "x", action: "added", at: days(1) }]).size, 0);
eq("no events means no tags, not a crash", currentTags(undefined, IDX_ID).length, 0);
eq("no vocabulary means the ids still replay", currentTags(HISTORY, undefined).length, 2);

const BY_LEAD = eventsByLead([...HISTORY, { id: "z", lead_id: "M", tag_id: "t-hot", action: "added", at: days(1), source: "auto" }]);
eq("one read of the table serves the whole board", [...BY_LEAD.keys()].sort(), ["L", "M"]);
eq("a row with no lead_id is not filed under undefined", eventsByLead([{ id: "q", tag_id: "t-hot" }]).size, 0);
/* Counted from the UNFILTERED rows by every caller: a filter menu built from
 * what is on screen hides its own options, which was a real shipped bug on the
 * Operations table. */
eq("the counts are counted per lead, across every lead given",
  [...tagCounts(["L", "M"], BY_LEAD, IDX_ID).entries()].sort(), [[TAG.HOT, 2], [TAG.NEVER_TOUCHED, 1]]);
eq("a lead with no events counts nothing rather than throwing", tagCounts(["nobody"], BY_LEAD, IDX_ID).size, 0);

const LINES = tagHistory(HISTORY, IDX_ID, { teamName: (id) => (id === "u1" ? "Larry Pike" : null) });
eq("the history reads newest first", LINES.map((l) => l.id), ["h4", "h3", "h2", "h1"]);
/* Pretending a rule was a person is worse than saying nobody. */
eq("a rule is 'automatic', never a person", LINES.find((l) => l.id === "h2").who, "automatic");
eq("a person is named", LINES.find((l) => l.id === "h3").who, "Larry Pike");
eq("an unknown user id is 'someone' rather than a raw uuid", tagHistory([
  { id: "x", lead_id: "L", tag_id: "t-hot", action: "added", at: days(1), by: "u9", source: "person" },
], IDX_ID, { teamName: () => null })[0].who, "someone");
ok("every line is one sentence, built here so the drawer and anything else read identically",
  LINES.every((l) => l.line && l.line.length > 5));
ok("the reason is on the line when there is one", LINES.find((l) => l.id === "h3").line.includes("she replied"));

/* ================================================================== */
console.log("\nWON AND LOST NEED A REASON SOMEBODY CAN READ BACK");
/* ================================================================== */
const NOTE = "They stopped replying after the third email.";
ok("a good Lost close is accepted", checkCloseReason({ kind: "lost", reason: "no_reply", note: NOTE }).ok);
ok("a good Won close is accepted", checkCloseReason({ kind: "won", reason: "referral", note: NOTE }).ok);
eq("an empty reason is refused", checkCloseReason({ kind: "lost", reason: "", note: NOTE }).ok, false);
eq("a missing reason is refused", checkCloseReason({ kind: "lost", note: NOTE }).ok, false);
eq("a whitespace reason is refused", checkCloseReason({ kind: "lost", reason: "   ", note: NOTE }).ok, false);
ok("...and the refusal says WHY it is being asked for, not just that it is",
  /six months/i.test(checkCloseReason({ kind: "lost", reason: "", note: NOTE }).error));
eq("a reason that is not on the list is refused", checkCloseReason({ kind: "lost", reason: "vibes", note: NOTE }).ok, false);
ok("...and the refusal quotes what was sent", checkCloseReason({ kind: "lost", reason: "vibes", note: NOTE }).error.includes("vibes"));
/* TWO SEPARATE LISTS. "Price" is not a reason somebody said yes, and one shared
 * list would produce a loss breakdown with a Won reason in it. */
eq("a WON reason is refused on a LOST close", checkCloseReason({ kind: "lost", reason: "liked_mockup", note: NOTE }).ok, false);
eq("a LOST reason is refused on a WON close", checkCloseReason({ kind: "won", reason: "price", note: NOTE }).ok, false);
ok("...and the refusal names which list was being checked",
  /Lost reasons/.test(checkCloseReason({ kind: "lost", reason: "liked_mockup", note: NOTE }).error)
  && /Won reasons/.test(checkCloseReason({ kind: "won", reason: "price", note: NOTE }).error));
ok("the two lists really are different sets",
  LOST_REASONS.some(([c]) => !WON_REASONS.some(([w]) => w === c))
  && WON_REASONS.some(([c]) => !LOST_REASONS.some(([l]) => l === c)));
ok("every code on both lists is unique within its own list",
  new Set(LOST_REASONS.map(([c]) => c)).size === LOST_REASONS.length
  && new Set(WON_REASONS.map(([c]) => c)).size === WON_REASONS.length);
ok("every code on both lists prints words a person can read",
  [...LOST_REASONS, ...WON_REASONS].every(([c]) => reasonLabel(c) && reasonLabel(c) !== c));
/* A reason that stops being on the list is still the reason somebody gave, and
 * quietly relabelling it would change what the loss breakdown says about the past. */
eq("a code that has since left the list prints itself rather than 'Other'", reasonLabel("gone_from_the_list"), "gone_from_the_list");
eq("no code prints nothing rather than a made-up label", reasonLabel(null), null);

console.log("  -- the note");
eq("no note at all is refused", checkCloseReason({ kind: "lost", reason: "price" }).ok, false);
eq("an empty note is refused", checkCloseReason({ kind: "lost", reason: "price", note: "" }).ok, false);
/* "n/a" and "-" are the two things a required box gets filled with, and both are
 * worse than no box at all because they look like an answer in a report six
 * months later. */
eq('"n/a" is refused', checkCloseReason({ kind: "lost", reason: "price", note: "n/a" }).ok, false);
eq('"-" is refused', checkCloseReason({ kind: "lost", reason: "price", note: "-" }).ok, false);
eq('"N/A " with padding is refused too', checkCloseReason({ kind: "lost", reason: "price", note: "  N/A  " }).ok, false);
eq(`a note one character under MIN_REASON_NOTE_CHARS (${MIN_REASON_NOTE_CHARS}) is refused`,
  checkCloseReason({ kind: "lost", reason: "price", note: "x".repeat(MIN_REASON_NOTE_CHARS - 1) }).ok, false);
eq("...and one exactly at the limit is accepted",
  checkCloseReason({ kind: "lost", reason: "price", note: "x".repeat(MIN_REASON_NOTE_CHARS) }).ok, true);
ok("the refusal names the number, so a rep is not guessing at how much to type",
  checkCloseReason({ kind: "lost", reason: "price", note: "n/a" }).error.includes(String(MIN_REASON_NOTE_CHARS)));
eq("what comes back is trimmed, so the record does not carry the padding",
  checkCloseReason({ kind: "lost", reason: "  price  ", note: `  ${NOTE}  ` }),
  { ok: true, reason: "price", note: NOTE });
eq("called with nothing at all it refuses rather than throwing", checkCloseReason().ok, false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
