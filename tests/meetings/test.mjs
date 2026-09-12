/* Tests for recording meetings — lib/meetings.js and migration 0034.
 *
 * Run with:  bash tests/meetings/run.sh
 *
 * RUN IN FIVE TIMEZONES, and that is not thoroughness for its own sake. The
 * entire job of this file is turning what somebody typed into a DAY, and this
 * project has already shipped a date bug that booked every cost paid on the 1st
 * into the month before (CONTEXT-FOR-AI.md §18). A date parser that is only
 * ever tested in one timezone is a date parser that has not been tested.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  MEETING_KINDS, MEETING_OUTCOMES, DEFAULT_KIND, DEFAULT_OUTCOME, UNTIMED_HOUR,
  TEAM_TZ, teamFields, teamDay, teamInstant,
  parseWhen, parsePaste, makeRow, reRow, rowIsBlank, rowProblem, batchSummary,
  searchablePeople, matchPerson, rowToMeeting, meetingBody, isFuture,
  kindLabel, outcomeLabel, sourceLabel, spellDate, wasTimed, toInputText,
} from "../../lib/meetings.js";

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed += 1; results.push(`  ok   ${name}`); }
  catch (err) { failed += 1; results.push(`  FAIL ${name}\n       ${err.message}`); }
}

/* The day the bench is standing on for every relative test below.
 *
 * A FIXED UTC INSTANT, not `new Date(2026, 8, 12, …)`. A local-fields date is a
 * DIFFERENT MOMENT in each of the five timezones this file runs in, and in some
 * of them it is not even the same day in the team's calendar — so the tests
 * would be asserting against a different "today" per run while looking
 * identical. 17:00Z is midday in Chicago on 12 September, in both halves of the
 * year, which is the day every expectation below is written against.
 *
 * A Saturday, deliberately: "last tuesday" from a Saturday is four days back,
 * which is a different answer from the one a lazy implementation gives. */
const TODAY = new Date(Date.UTC(2026, 8, 12, 17, 0, 0));

/* ================================================================== */
/* WHAT THE DATABASE WILL ACTUALLY ACCEPT                              */
/* ================================================================== */
/* Read out of the migration, never out of a fixture. A test whose fixture
 * agrees with the code proves only that the code agrees with itself — this repo
 * shipped exactly that mistake once, when three files wrote column names the
 * tables did not have and every fixture had invented the same wrong names. */
function migrations() {
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
}
const SQL = migrations();

/* THE `admin_meetings` BLOCK ALONE, not the whole pile of migrations.
 *
 * The first version of this helper searched every migration concatenated and
 * matched on `kind text not null default '…'`. `admin_brain_memory` also has a
 * column called `kind`, earlier in the file order, so the check read ANOTHER
 * TABLE'S list and reported that the database would refuse "discovery" — a
 * red test over correct code, which is the same family of mistake as a green
 * test over broken code and just as expensive to chase. Scope first, match
 * second. */
function meetingsTable() {
  const m = SQL.match(/create table if not exists public\.admin_meetings \(([\s\S]*?)\n\);/);
  if (!m) throw new Error("the admin_meetings table is not in any migration");
  return m[1];
}
const MEETINGS_DDL = meetingsTable();

function checkValues(column) {
  const m = MEETINGS_DDL.match(new RegExp(`check \\(${column} in \\(([^)]*)\\)`));
  if (!m) throw new Error(`no check constraint on admin_meetings.${column}`);
  return new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
}

test("every meeting kind on screen is a value the database accepts", () => {
  const allowed = checkValues("kind");
  for (const k of MEETING_KINDS) {
    assert.ok(allowed.has(k.id), `the database will refuse kind "${k.id}"`);
  }
});

test("every outcome on screen is a value the database accepts", () => {
  const allowed = checkValues("outcome");
  for (const o of MEETING_OUTCOMES) {
    assert.ok(allowed.has(o.id), `the database will refuse outcome "${o.id}"`);
  }
});

test("the table really is the one being read", () => {
  /* Cheap proof that the scoping above is doing something: admin_meetings has
   * an occurred_at and admin_brain_memory does not. If this ever fails, the
   * block regex has drifted and the two checks above are reading the wrong
   * table again — silently passing, which is worse than what they did first. */
  assert.match(MEETINGS_DDL, /occurred_at timestamptz not null/);
  assert.match(MEETINGS_DDL, /entered_by uuid not null/);
  assert.doesNotMatch(MEETINGS_DDL, /admin_brain_memory/);
});

test("the defaults are in their own lists", () => {
  assert.ok(MEETING_KINDS.some((k) => k.id === DEFAULT_KIND));
  assert.ok(MEETING_OUTCOMES.some((o) => o.id === DEFAULT_OUTCOME));
});

test("'meeting' is a lead-activity type the database accepts", () => {
  /* The LAST admin_lead_activity_type_check across every migration in order —
   * the constraint is dropped and re-added four times, so any single file gives
   * the wrong answer. Same reading the stage-move test has to do. */
  let last = null;
  for (const m of SQL.matchAll(/admin_lead_activity_type_check[\s\S]{0,400}?check \(type in \(([\s\S]*?)\)\)/g)) last = m[1];
  assert.ok(last, "no admin_lead_activity_type_check found");
  const allowed = new Set([...last.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
  assert.ok(allowed.has("meeting"), "the mirrored timeline row would be refused");
});

test("a meeting counts as contact in the touch trigger", () => {
  /* The LAST definition of admin_lead_activity_touch. If 'meeting' is not in
   * its list, a firm we sat down with on Tuesday prints "no contact in 12d". */
  const defs = [...SQL.matchAll(/create or replace function public\.admin_lead_activity_touch[\s\S]*?\$\$;/g)];
  const body = defs[defs.length - 1][0];
  assert.match(body, /new\.type in \([^)]*'meeting'[^)]*\)/, "a meeting does not count as a touch");
  /* And the three columns still behave the way a backfill needs. */
  assert.match(body, /last_touch_at = greatest/, "greatest() is what stops a June backfill warming a cold lead");
  assert.match(body, /first_contact_at = least/, "least() is what lets a backfill correct first contact earlier");
});

test("0034 never writes stage, meeting_at or next_follow_up_at", () => {
  const file = readFileSync(new URL("../../supabase/migrations/0034_meetings.sql", import.meta.url), "utf8");
  /* Strip the comments first — the file TALKS about all three at length, and
   * the point is that it never UPDATES them. */
  const code = file.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /update public\.admin_leads[\s\S]{0,400}?set[\s\S]{0,200}?meeting_at/, "0034 writes meeting_at");
  assert.doesNotMatch(code, /next_follow_up_at/, "0034 touches next_follow_up_at");
  assert.doesNotMatch(code, /update public\.admin_leads[\s\S]{0,200}?set stage/, "0034 writes a stage");
});

/* ================================================================== */
/* DATES — the part that has to be right                               */
/* ================================================================== */

test("every written form resolves to the same day", () => {
  const forms = ["6/3", "6/3/26", "6/3/2026", "6-3-2026", "june 3", "jun 3", "3 june", "3rd of june", "2026-06-03", "June 3 2026"];
  for (const f of forms) {
    const r = parseWhen(f, { today: TODAY });
    assert.ok(r.ok, `"${f}" did not parse`);
    assert.equal(r.day, "2026-06-03", `"${f}" gave ${r.day}`);
  }
});

test("a date with no year means the most recent one that has BEEN", () => {
  /* Standing in September. "december 3" cannot be this December — she is
   * entering meetings she has already had, and this one has not happened. */
  assert.equal(parseWhen("december 3", { today: TODAY }).day, "2025-12-03");
  assert.equal(parseWhen("june 3", { today: TODAY }).day, "2026-06-03");
  /* Today itself counts as "has been". */
  assert.equal(parseWhen("september 12", { today: TODAY }).day, "2026-09-12");
});

test("prefer:nearest flips it, for the card where a future booking is normal", () => {
  const r = parseWhen("december 3", { today: TODAY, prefer: "nearest" });
  assert.equal(r.day, "2026-12-03");
});

test("relative dates", () => {
  assert.equal(parseWhen("today", { today: TODAY }).day, "2026-09-12");
  assert.equal(parseWhen("yesterday", { today: TODAY }).day, "2026-09-11");
  assert.equal(parseWhen("3 days ago", { today: TODAY }).day, "2026-09-09");
  assert.equal(parseWhen("2 weeks ago", { today: TODAY }).day, "2026-08-29");
  assert.equal(parseWhen("1 month ago", { today: TODAY }).day, "2026-08-12");
});

test("last tuesday from a Saturday is four days back, not eleven", () => {
  assert.equal(parseWhen("last tuesday", { today: TODAY }).day, "2026-09-08");
  /* A bare weekday means the same thing here — this screen is for meetings
   * that have happened, so "tuesday" cannot mean a Tuesday yet to come. */
  assert.equal(parseWhen("tuesday", { today: TODAY }).day, "2026-09-08");
});

test("a weekday that is TODAY means a week ago, not today", () => {
  /* TODAY is a Saturday. "saturday" with nothing else said is the last one,
   * which is seven days back — not the one you are standing in. */
  assert.equal(parseWhen("saturday", { today: TODAY }).day, "2026-09-05");
});

test("a month that is genuinely ambiguous is read month-first, and says so when it is not", () => {
  assert.equal(parseWhen("6/3", { today: TODAY }).day, "2026-06-03");
  const swapped = parseWhen("13/6", { today: TODAY });
  assert.equal(swapped.day, "2026-06-13");
  assert.ok(swapped.swapped, "the screen has to be able to say it read this one day-first");
});

test("A DATE PARSER THAT IGNORES WORDS IT DOES NOT KNOW IS A NAME-EATER", () => {
  /* The regression that was caught on the bench before this shipped.
   *
   * "April Reynolds June 15" parsed as 15 June and threw away "Reynolds", so
   * the paste box filed the meeting against a person called "April". A parser
   * that ignores what it does not understand reads a date out of almost any
   * sentence, and the row it produces looks completely normal. */
  assert.equal(parseWhen("April Reynolds June 15", { today: TODAY }).ok, false);
  assert.equal(parseWhen("Dave June 3", { today: TODAY }).ok, false);
  assert.equal(parseWhen("Reynolds June 15", { today: TODAY }).ok, false);
  /* …without breaking the joining words people actually type. */
  assert.equal(parseWhen("3rd of june", { today: TODAY }).day, "2026-06-03");
});

test("an unreadable date fails with a sentence a person can act on", () => {
  const r = parseWhen("sometime in the spring", { today: TODAY });
  assert.equal(r.ok, false);
  assert.match(r.why, /6\/3|June 3/, "the refusal has to show what WOULD work");
  assert.equal(parseWhen("", { today: TODAY }).why, "Put a date in.");
});

test("a date that does not exist is refused, never rolled over", () => {
  /* `new Date(2026, 1, 31)` is silently 3 March. A parser that rolls over turns
   * a typo into a wrong answer that looks right. */
  assert.equal(parseWhen("2026-02-31", { today: TODAY }).ok, false);
  assert.equal(parseWhen("june 31", { today: TODAY }).ok, false);
  assert.equal(parseWhen("13/45", { today: TODAY }).ok, false);
});

test("29 February finds the last leap year", () => {
  assert.equal(parseWhen("feb 29", { today: TODAY }).day, "2024-02-29");
});

test("a meeting nobody timed is filed at midday IN THE TEAM'S CALENDAR", () => {
  /* Midnight is within hours of the date boundary in every timezone, so
   * anything downstream that slices an ISO string — and something always does —
   * reads the day before. Midday has twelve hours of clearance both ways.
   *
   * CHECKED IN THE TEAM'S CALENDAR, NOT THE MACHINE'S. That distinction is the
   * whole fix: an earlier version stored noon in whatever zone the browser
   * happened to be in, while the assistant stored noon in Chicago, so the two
   * writers disagreed and a card printed invented times to anybody east or west
   * of the office. */
  const r = parseWhen("6/3", { today: TODAY });
  const f = teamFields(r.iso);
  assert.equal(f.hour, UNTIMED_HOUR);
  assert.equal(f.minute, 0);
  assert.equal(r.timed, false);
  assert.equal(wasTimed(r.iso), false, "a midday meeting must read back as untimed");
  assert.equal(teamDay(r.iso), "2026-06-03");
});

test("a stated time is kept, and marked as stated", () => {
  const r = parseWhen("june 3 3:30pm", { today: TODAY });
  assert.equal(r.timed, true);
  const f = teamFields(r.iso);
  assert.equal(f.hour, 15);
  assert.equal(f.minute, 30);
  assert.equal(wasTimed(r.iso), true);
  assert.match(r.label, /3:30pm/);
  /* And it survives a round trip through the edit box. */
  assert.match(toInputText(r.iso), /2026-06-03 3:30pm/);
  assert.equal(parseWhen(toInputText(r.iso), { today: TODAY }).iso, r.iso);
});

test("an untimed meeting round-trips through the edit box without gaining a time", () => {
  const r = parseWhen("6/3", { today: TODAY });
  assert.equal(toInputText(r.iso), "2026-06-03");
  assert.equal(parseWhen(toInputText(r.iso), { today: TODAY }).iso, r.iso);
});

test("the team calendar here is the same one the rest of the console uses", () => {
  /* A DELIBERATE COPY, checked rather than trusted. lib/meetings.js has no
   * imports so the bench can attack it alone; the price of that is this test.
   * The same arrangement assistant-tools.js has with its local stage list. */
  const other = readFileSync(new URL("../../lib/brain-context.js", import.meta.url), "utf8");
  const m = other.match(/export const TEAM_TZ = "([^"]+)"/);
  assert.ok(m, "brain-context.js no longer exports TEAM_TZ");
  assert.equal(TEAM_TZ, m[1], "the two copies of the team timezone have drifted");
});

test("BOTH WRITERS PUT AN UNTIMED MEETING ON THE SAME INSTANT", () => {
  /* The defect this whole change exists to close: the grid built the instant in
   * the browser, the assistant built it on a UTC server, and they disagreed —
   * so a meeting dictated from New York printed a time nobody had given.
   *
   * THIS READS THE ASSISTANT'S SOURCE. An earlier version of this test
   * reimplemented the conversion inline and compared lib/meetings.js to that
   * hand-copy — so it would have stayed green through exactly the change it was
   * written to catch. A test that agrees with a copy of the code proves the
   * code agrees with itself, which is the mistake this repo already has a note
   * about. */
  const src = readFileSync(new URL("../../lib/assistant-tools.js", import.meta.url), "utf8");

  /* 1. It must get the conversion from this file rather than owning one. */
  assert.match(src, /import \{[^}]*teamInstant[^}]*\} from "\.\/meetings\.js"/,
    "assistant-tools.js no longer imports teamInstant from lib/meetings.js");
  assert.doesNotMatch(src, /function tzOffsetMs/,
    "assistant-tools.js has grown its own timezone maths again");

  /* 2. Its wrapper must default to the same hour this file files untimed
   *    meetings at, and must pass the fields straight through. */
  const wrapper = src.match(/function teamInstantFromDay\([\s\S]*?\n}/);
  assert.ok(wrapper, "teamInstantFromDay is gone from assistant-tools.js");
  assert.match(wrapper[0], /UNTIMED_HOUR/,
    "the assistant no longer defaults an untimed meeting to UNTIMED_HOUR");
  assert.match(wrapper[0], /teamInstant\(/, "the wrapper stopped calling teamInstant");

  /* 3. And the tool must actually hand it midday when no time was given. */
  assert.match(src, /teamInstantFromDay\(day, time \|\| "12:00"\)/,
    "log_meeting no longer files an untimed meeting at midday");
  assert.equal(UNTIMED_HOUR, 12, "UNTIMED_HOUR and the assistant's \"12:00\" have drifted");

  /* 4. Finally the value itself, through this file's own function, which is the
   *    one the assistant now calls. */
  const grid = parseWhen("6/3", { today: TODAY }).iso;
  const server = teamInstant(2026, 5, 3, UNTIMED_HOUR, 0).toISOString();
  assert.equal(server, grid, "the grid and the assistant disagree about when midday is");
});

test("a local time that does not exist is refused, not moved", () => {
  /* 2:30am on 8 March 2026 does not happen in the team's timezone — the clocks
   * go forward through it. The two-pass offset resolved it to 1:30am rather
   * than failing, so a stated time quietly became a different time. The same
   * silent shift this file refuses to make for 29 February, an hour instead of
   * a day. */
  assert.equal(parseWhen("3/8/2026 2:30am", { today: TODAY }).ok, false);
  /* The other direction is NOT affected: 1:30am on 1 November happens twice and
   * both are real, so it must still be accepted. */
  assert.equal(parseWhen("11/1/2026 1:30am", { today: TODAY }).ok, true);
  /* And midday, which is what almost everything here uses, is never near it. */
  assert.equal(parseWhen("3/8/2026", { today: TODAY }).ok, true);
});

test("the card's date box reads a bare month-day as the NEXT one", () => {
  /* The grid and the card want opposite defaults, and for a while three
   * comments said the card used `nearest` while nothing passed it — so booking
   * a future meeting from a card was unreachable by the obvious wording. */
  assert.equal(parseWhen("december 3", { today: TODAY, prefer: "nearest" }).day, "2026-12-03");
  assert.equal(makeRow({ whenText: "december 3" }, { today: TODAY, prefer: "nearest" }).when.day, "2026-12-03");
  assert.equal(reRow(makeRow({}, { today: TODAY }), { whenText: "december 3" }, { today: TODAY, prefer: "nearest" }).when.day, "2026-12-03");
  /* And the panel is the thing that passes it. */
  const panel = readFileSync(new URL("../../src/components/admin/meetingsPanel.jsx", import.meta.url), "utf8");
  assert.match(panel, /prefer: "nearest"/, "the person's card stopped asking for nearest-date reading");
});

test("A NUMERIC DATE SPLIT BY ITS OWN COMMA IS ALSO PUT BACK TOGETHER", () => {
  /* The first fix only rejoined the month-NAME form. "12/3, 2026" — the form
   * the grid's own help text teaches, and the one a spreadsheet column
   * produces — still resolved to December 2025 with the year filed as a note,
   * under a green test that only checked "December 3, 2026". */
  for (const line of ["Dave, 12/3, 2026, went well", "Dave, 12-3, 2026", "Dave\t12/3\t2026\twent well"]) {
    const r = parsePaste(line, { today: TODAY })[0];
    assert.equal(r.when.day, "2026-12-03", `"${line}" resolved to ${r.when.day}`);
    assert.doesNotMatch(r.note, /2026/, `"${line}" put the year in the note`);
  }
});

/* ================================================================== */
/* THE PASTE BOX                                                       */
/* ================================================================== */

test("a spreadsheet paste, header row and all", () => {
  const rows = parsePaste([
    "Who\tDate\tType\tHow it went\tNote",
    "Dave Mullen\t6/3\tFirst meeting\tWent well\twants pricing",
    "Sarah Lin\t6/10\tFollow-up\tBooked the next one\t",
  ].join("\n"), { today: TODAY });
  assert.equal(rows.length, 2, "the header row became a meeting");
  assert.equal(rows[0].who, "Dave Mullen");
  assert.equal(rows[0].when.day, "2026-06-03");
  assert.equal(rows[0].kind, "discovery");
  assert.equal(rows[0].outcome, "went_well");
  assert.equal(rows[0].note, "wants pricing");
  assert.equal(rows[1].outcome, "booked_next");
});

test("commas, dashes and a bare list all work", () => {
  const rows = parsePaste([
    "Sarah Lin, 6/10, Follow-up, Booked the next one",
    "Mike Torres - june 12 - they did not show",
    "April Reynolds June 15",
    "Jordan Webb",
  ].join("\n"), { today: TODAY });
  assert.equal(rows.length, 4);
  assert.equal(rows[1].outcome, "no_show");
  /* The name is kept WHOLE. This is the April Reynolds regression, checked at
   * the level it actually bit. */
  assert.equal(rows[2].who, "April Reynolds");
  assert.equal(rows[2].when.day, "2026-06-15");
  /* A row with no date is kept and marked, never dropped. */
  assert.equal(rows[3].who, "Jordan Webb");
  assert.equal(rows[3].when.ok, false);
});

test("a cell the parser could not place lands in the note, never in the bin", () => {
  const rows = parsePaste("Dave Mullen, 6/3, they want the deck and a price", { today: TODAY });
  assert.match(rows[0].note, /deck/);
});

test("the FIRST readable date wins, so a note containing one cannot steal the slot", () => {
  const rows = parsePaste("Dave Mullen, 6/3, said to call back on 7/9", { today: TODAY });
  assert.equal(rows[0].when.day, "2026-06-03");
  assert.match(rows[0].note, /7\/9/);
});

/* ================================================================== */
/* FINDING THE PERSON                                                  */
/* ================================================================== */

const LEADS = [
  { id: "l1", name: "Dave Mullen", company: "Crest Dental", email: "dave@crest.com", stage: "new" },
  { id: "l2", name: "Dave Nunez", company: "Halo Roofing", email: "dave@halo.com", stage: "new" },
  { id: "l3", name: "Sarah Lin", company: "Lin Realty", email: "sarah@linrealty.com", stage: "follow_up" },
];
const CLIENTS = [{ id: "c1", name: "Harbor Injury Law", contact_name: "J. Alvarez", contact_email: "j@harbor.com" }];
const PEOPLE = searchablePeople(LEADS, CLIENTS);

test("leads and clients are searched together", () => {
  assert.equal(PEOPLE.length, 4);
  assert.ok(PEOPLE.some((p) => p.kindOf === "client" && p.clientId === "c1"));
  assert.ok(PEOPLE.some((p) => p.kindOf === "lead" && p.leadId === "l1"));
});

test("A SHARED FIRST NAME IS NEVER ENOUGH TO PICK SOMEBODY", () => {
  /* The rule this project learned on matchOwner, 31 Aug 2026. Two Daves must
   * show two Daves. A meeting filed against the wrong one looks completely
   * normal for ever afterwards. */
  const m = matchPerson("dave", PEOPLE);
  assert.equal(m.confident, false);
  assert.equal(m.candidates.length, 2);
});

test("an exact full name or an exact email picks itself", () => {
  assert.equal(matchPerson("Dave Mullen", PEOPLE).confident, true);
  assert.equal(matchPerson("dave@halo.com", PEOPLE).confident, true);
});

test("a firm name alone never picks itself, even when it is unique", () => {
  /* One firm can hold several contacts, and which PERSON was at the meeting is
   * the whole question. A unique firm is a good candidate, not an answer. */
  const m = matchPerson("Crest Dental", PEOPLE);
  assert.equal(m.confident, false);
  assert.equal(m.candidates[0].leadId, "l1");
});

test("two words find somebody across their name and their firm", () => {
  const m = matchPerson("dave crest", PEOPLE);
  assert.equal(m.candidates[0].leadId, "l1");
});

test("nobody matching is an empty list, never a wrong guess", () => {
  assert.deepEqual(matchPerson("zzz nobody", PEOPLE).candidates, []);
});

/* ================================================================== */
/* THE ROWS, AND WHAT IS SAFE TO SAVE                                  */
/* ================================================================== */

const person = (id) => ({ leadId: id, clientId: null, name: "x" });

test("a blank row is not an error, it is just not a row", () => {
  const r = makeRow({}, { today: TODAY });
  assert.equal(rowIsBlank(r), true);
  assert.equal(rowProblem(r), null);
  assert.equal(batchSummary([r, makeRow({}, { today: TODAY })], { today: TODAY }).total, 0);
});

test("retyping the name unpicks the person", () => {
  /* A row that says "Dave" and is attached to Sarah because Sarah was picked
   * before the name was retyped is the worst kind of wrong: it looks normal. */
  let r = makeRow({ who: "Dave Mullen", whenText: "6/3" }, { today: TODAY });
  r = reRow(r, { person: person("l1") }, { today: TODAY });
  assert.ok(r.person);
  r = reRow(r, { who: "Sarah Lin" }, { today: TODAY });
  assert.equal(r.person, null);
});

test("one problem at a time, in the order a person fixes them", () => {
  let r = makeRow({ who: "Dave" }, { today: TODAY });
  assert.match(rowProblem(r), /Pick who/);
  r = reRow(r, { person: person("l1") }, { today: TODAY });
  assert.match(rowProblem(r), /date/);
  r = reRow(r, { whenText: "not a date" }, { today: TODAY });
  assert.match(rowProblem(r), /not a date/);
  r = reRow(r, { whenText: "6/3" }, { today: TODAY });
  assert.equal(rowProblem(r), null);
});

test("A ROW THAT ALREADY HAS A PERSON DOES NOT ALSO NEED A TYPED NAME", () => {
  /* THE SHAPE THE PER-PERSON PANEL BUILDS, which had never been tested.
   *
   * On a lead's card there is no "who" box — the card you are standing on is
   * the answer — so every row it builds has a person and an empty `who`. The
   * first version of rowProblem asked for `who` first, so adding a meeting from
   * a card and editing an existing one BOTH failed on every click, with a red
   * toast naming a field that was not on the screen. The whole per-person half
   * of the feature was dead and 42 green tests said nothing, because they only
   * ever built rows the way the GRID does. */
  const panelRow = { ...makeRow({ whenText: "yesterday" }, { today: TODAY }), person: person("l1") };
  assert.equal(rowIsBlank(panelRow), false, "a row with a person attached is never blank");
  assert.equal(rowProblem(panelRow), null);
  assert.equal(batchSummary([panelRow], { today: TODAY }).canSave, true);

  /* And with no person and no name it still asks the right question. */
  assert.match(rowProblem(makeRow({ whenText: "yesterday" }, { today: TODAY })), /Who was this meeting with/);
  /* With a name typed but nobody chosen, it asks the other one. */
  assert.match(rowProblem(makeRow({ who: "Dave", whenText: "yesterday" }, { today: TODAY })), /Pick who/);
});

test("PICKING SOMEBODY FROM THE MENU DOES NOT IMMEDIATELY UNPICK THEM", () => {
  /* The dropdown sets the person AND rewrites `who` to their full name, in one
   * patch. reRow used to clear the person on any `who` change — including the
   * change arriving in the same patch — so every pick undid itself: the box
   * filled in, no tick appeared, and the row stayed unsaveable. Clicking the
   * identical name a second time appeared to work, purely because `who` no
   * longer differed.
   *
   * The test that was meant to cover this called reRow twice, once per key,
   * which is the one shape the screen never produces. */
  let r = makeRow({ who: "dave", whenText: "6/3" }, { today: TODAY });
  r = reRow(r, { person: person("l1"), newLead: null, who: "Dave Mullen" }, { today: TODAY });
  assert.ok(r.person, "the person was thrown away by the patch that set it");
  assert.equal(r.who, "Dave Mullen");
  assert.equal(rowProblem(r), null);

  /* Retyping afterwards STILL unpicks — the protection that mattered is intact. */
  assert.equal(reRow(r, { who: "Sarah" }, { today: TODAY }).person, null);
});

test("A DATE SPLIT BY ITS OWN COMMA IS PUT BACK TOGETHER", () => {
  /* "December 3, 2026" out of a spreadsheet was cut on the comma. "December 3"
   * won the date slot, resolved with no year to the most recent December —
   * 2025 — and the year the person typed fell into the note. Wrong in both
   * directions, from a paste the screen's own placeholder invites. */
  const a = parsePaste("Dave Mullen, December 3, 2026, went well", { today: TODAY })[0];
  assert.equal(a.when.day, "2026-12-03");
  assert.doesNotMatch(a.note, /2026/, "the stated year ended up in the note");

  const b = parsePaste("Sarah Lin, March 5, 2025, demo", { today: TODAY })[0];
  assert.equal(b.when.day, "2025-03-05");

  /* A bare year that is NOT part of a date is left where it is. */
  const c = parsePaste("Bob, 6/3, called 2026 times", { today: TODAY })[0];
  assert.equal(c.when.day, "2026-06-03");
  assert.match(c.note, /2026/);
});

test("an impossible time is refused, not quietly reinterpreted", () => {
  /* `Number(h) % 12` ran BEFORE the range check, so the check could never fire:
   * "13pm" became 1pm. A typo in a time is small; a typo silently accepted as a
   * different time is the kind of wrong nobody goes back and checks. */
  assert.equal(parseWhen("june 3 13pm", { today: TODAY }).ok, false);
  assert.equal(parseWhen("june 3 0am", { today: TODAY }).ok, false);
  assert.equal(parseWhen("june 3 12pm", { today: TODAY }).ok, true);
  assert.equal(parseWhen("june 3 25:00", { today: TODAY }).ok, false);
});

test("NOTHING SAVES WHILE ANY ROW IS BROKEN", () => {
  /* Rule 4. Half a backlog with no way to tell which half is worse than an
   * afternoon of typing, because the half that failed is the hardest half to
   * remember. */
  const good = reRow(makeRow({ who: "Dave Mullen", whenText: "6/3" }, { today: TODAY }), { person: person("l1") }, { today: TODAY });
  const bad = makeRow({ who: "Mystery Person", whenText: "6/4" }, { today: TODAY });
  const s = batchSummary([good, bad], { today: TODAY });
  assert.equal(s.canSave, false);
  assert.equal(s.total, 2);
  assert.equal(s.problems.length, 1);
  assert.match(s.headline, /1 of 2/);
});

test("the check screen counts what it is about to do", () => {
  const rows = [
    reRow(makeRow({ who: "a", whenText: "6/3" }, { today: TODAY }), { person: person("l1") }, { today: TODAY }),
    reRow(makeRow({ who: "b", whenText: "tomorrow" }, { today: TODAY }), { person: person("l2") }, { today: TODAY }),
    reRow(makeRow({ who: "c", whenText: "6/5 2pm" }, { today: TODAY }), { newLead: { name: "c", firm: "" } }, { today: TODAY }),
  ];
  const s = batchSummary(rows, { today: TODAY });
  assert.equal(s.canSave, true);
  assert.equal(s.total, 3);
  assert.equal(s.matched, 2);
  assert.equal(s.toCreate, 1);
  assert.equal(s.future, 1, "a future date has to be counted so the screen can warn");
  assert.equal(s.untimed, 2, "how many were filed at midday has to be sayable out loud");
  assert.match(s.headline, /3 meetings ready/);
});

test("WHAT GETS WRITTEN CARRIES NO STAGE AND NO PIPELINE DATE", () => {
  /* Rule 1, checked at the only place it can be checked without a database.
   * If a future version of rowToMeeting starts returning a stage, that is the
   * bug, and this is the test that says so. */
  const r = reRow(makeRow({ who: "Dave Mullen", whenText: "6/3", note: "  spaced  " }, { today: TODAY }), { person: person("l1") }, { today: TODAY });
  const out = rowToMeeting(r, { enteredBy: "u1", batchId: "b1" });
  assert.deepEqual(Object.keys(out).sort(), [
    "batch_id", "client_id", "entered_by", "kind", "lead_id", "notes", "occurred_at", "outcome", "source",
  ]);
  assert.equal(out.lead_id, "l1");
  assert.equal(out.source, "typed");
  assert.equal(out.notes, "spaced", "the note is trimmed");
  for (const banned of ["stage", "meeting_at", "next_follow_up_at", "first_contact_at"]) {
    assert.ok(!(banned in out), `rowToMeeting emits ${banned}`);
  }
});

test("an empty note is null, not an empty string", () => {
  const r = reRow(makeRow({ who: "x", whenText: "6/3" }, { today: TODAY }), { person: person("l1") }, { today: TODAY });
  assert.equal(rowToMeeting(r, { enteredBy: "u1" }).notes, null);
});

test("the timeline line has a fixed, machine-readable first line", () => {
  /* Anything reading these rows keys off the first line, so a note must not be
   * able to change its shape. The convention lib/touch-log.js set for touches. */
  const r = makeRow({ kind: "demo", outcome: "went_well", note: "they want a proposal" }, { today: TODAY });
  const body = meetingBody(r);
  assert.equal(body.split("\n")[0], "Meeting · Walkthrough · Went well.");
  assert.match(body, /they want a proposal$/);
  assert.equal(meetingBody(makeRow({ kind: "demo", outcome: "went_well" }, { today: TODAY })), "Meeting · Walkthrough · Went well.");
});

test("typed is CLAIMED and calendar is MEASURED, and they never blend", () => {
  assert.equal(sourceLabel("typed").badge, "CLAIMED");
  assert.equal(sourceLabel("chat").badge, "CLAIMED");
  assert.equal(sourceLabel("import").badge, "CLAIMED");
  assert.equal(sourceLabel("calendar").badge, "MEASURED");
  /* An unknown source is CLAIMED, never MEASURED. The safe direction: calling
   * a guess a measurement is the expensive mistake, not the other way round. */
  assert.equal(sourceLabel("who knows").badge, "CLAIMED");
});

test("labels exist for every value, so nothing prints a raw database word", () => {
  for (const k of MEETING_KINDS) assert.equal(kindLabel(k.id), k.label);
  for (const o of MEETING_OUTCOMES) assert.equal(outcomeLabel(o.id), o.label);
});

/* ================================================================== */

console.log("\nRECORDING MEETINGS\n");
console.log(`  timezone under test: ${process.env.TZ || "(the machine's own)"}\n`);
console.log(results.join("\n"));
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
