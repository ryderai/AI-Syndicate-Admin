/* The client timeline — "How they started" turned into the whole story.
 *
 * This suite exists because the four rules in src/lib/clientTimeline.js are all
 * the quiet kind. Nothing breaks if a failed read is counted as zero, or if an
 * event loses its source label, or if "the records begin" starts reporting the
 * newest date — the panel still renders, and every line on it is a lie. So each
 * of those rules is a case below.
 *
 * Run: node tests/client-timeline/test.mjs
 */
import assert from "node:assert/strict";
import {
  buildTimeline, readSection, activitySource, atFromStamp, atFromDay,
  prettyDay, joinWords, SOURCES, SECTION_CAPS, KINDS,
} from "../../src/lib/clientTimeline.js";

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const ok = (rows) => ({ rows, sample: false });
const CLIENT = { id: "c1", name: "Lakeside Law", created_at: "2026-03-02T15:00:00Z", start_date: "2026-03-09" };

/* One of everything, deliberately handed in out of order. */
const FULL = {
  client: CLIENT,
  contacts: ok([
    { id: "l1", name: "Dana Reed", title: "Partner", created_at: "2026-01-10T12:00:00Z", first_contact_at: "2026-01-14T17:30:00Z", became_customer: true, became_customer_at: "2026-03-01T20:00:00Z" },
  ]),
  activityByContact: {
    l1: ok([
      { id: "a1", type: "call", outcome: "no_answer", body: "Rang the main line.", created_at: "2026-01-14T17:30:00Z" },
      { id: "a2", type: "email", outcome: "talked", body: "Sent the one-pager.", created_at: "2026-02-02T14:00:00Z" },
    ]),
  },
  tasks: ok([
    { id: "t1", name: "Set up Search Console", status: "done", created_at: "2026-03-10T13:00:00Z", updated_at: "2026-03-18T16:00:00Z" },
    { id: "t2", name: "Write the service page", status: "todo", created_at: "2026-04-01T13:00:00Z", due_date: "2026-12-31" },
  ]),
  sites: ok([{ id: "s1", label: "Main site", url: "lakeside.example", live: true, created_at: "2026-03-12T10:00:00Z" }]),
  weekly: ok([
    { id: "w1", week_no: 1, target_date: "2026-03-16", week_status: "complete", what_we_did: "Fixed the titles." },
    { id: "w2", week_no: 2, target_date: "2026-03-23", week_status: "not_logged" },
  ]),
  reports: ok([{ id: "r1", title: "Month one", source: "written", created_at: "2026-04-05T09:00:00Z" }]),
  connections: ok([{ id: "n1", label: "Lakeside — Search Console", provider: "gsc", auth_kind: "google", connected_at: "2026-03-11T18:00:00Z" }]),
  vault: ok([{ id: "v1", label: "GoDaddy", kind: "login", created_at: "2026-03-13T11:00:00Z" }]),
};

console.log("\n  CLIENT TIMELINE — one story, oldest first\n");

/* ---------- order ---------- */

t("events come out oldest first, whatever order the rows arrived in", () => {
  const { events } = buildTimeline(FULL);
  const times = events.map((e) => e.at);
  const sorted = [...times].sort((a, b) => a - b);
  assert.deepEqual(times, sorted, "the list must read forward");
  assert.match(events[0].title, /added to the sales list/, "the oldest thing we hold is the lead row, from January");
  assert.match(events.at(-1).title, /Report generated/, "the newest is April's report");
});

t("two events on the same instant come out the same way every time", () => {
  /* Dana's first-contact date and her first logged call are the same
     timestamp on purpose — that is what the real data looks like, because a
     logged call is what sets the date. Without tie-breakers the pair would
     swap places between renders and read as facts changing. */
  const a = buildTimeline(FULL).events.map((e) => e.key).join("|");
  const b = buildTimeline(FULL).events.map((e) => e.key).join("|");
  assert.equal(a, b);
});

t("a date-only column is read on the team's calendar, not London's", () => {
  /* Date.parse("2026-03-09") is midnight in London, which is 6pm on March 8
     in Chicago — the bug that has cost this repo three shipped date errors. */
  const start = buildTimeline(FULL).events.find((e) => e.title === "Start date on file");
  assert.equal(start.ymd, "2026-03-09");
  assert.notEqual(atFromDay("2026-03-09"), Date.parse("2026-03-09"));
});

/* ---------- a failed read is unknown, never zero ---------- */

t("a read that ERRORED is unknown — it does not become an empty section", () => {
  const out = buildTimeline({ ...FULL, tasks: { rows: [], error: "permission denied for table admin_tasks" } });
  const hit = out.unknown.find((u) => u.source === SOURCES.task);
  assert.ok(hit, "the failed task read must be named as unknown");
  assert.match(hit.why, /permission denied/, "and it must carry the reason");
  assert.equal(out.bySource[SOURCES.task], undefined, "no task events were counted from a failed read");
});

t("a section that was never asked for is unknown too, not zero", () => {
  const out = buildTimeline({ client: CLIENT, contacts: ok([]) });
  const names = out.unknown.map((u) => u.source);
  for (const s of [SOURCES.task, SOURCES.site, SOURCES.weekly, SOURCES.report, SOURCES.connection, SOURCES.vault]) {
    assert.ok(names.includes(s), `${s} must be listed as unknown`);
  }
});

t("an EMPTY read is genuinely zero and is NOT reported as unknown", () => {
  /* The other half of the same rule: if we asked and there is nothing, saying
     "unknown" would be just as wrong in the other direction. */
  const out = buildTimeline({ ...FULL, vault: ok([]) });
  assert.equal(out.unknown.length, 0);
  assert.equal(out.bySource[SOURCES.vault], undefined);
  assert.equal(out.sales.state, "linked");
});

t("no sales rows at all is 'none'; a failed sales read is 'unknown'", () => {
  assert.equal(buildTimeline({ ...FULL, contacts: ok([]) }).sales.state, "none");
  assert.equal(buildTimeline({ ...FULL, contacts: { rows: [], error: "boom" } }).sales.state, "unknown");
  assert.equal(buildTimeline({ ...FULL, contacts: { rows: [], error: "boom" } }).sales.count, null,
    "count is null, not 0 — 0 would read as 'nobody was ever at this firm'");
});

t("a contact whose call log was not read is unknown for that person", () => {
  const out = buildTimeline({ ...FULL, activityByContact: {} });
  assert.ok(out.unknown.some((u) => u.source.includes("Dana Reed")), "the person is named, so it is fixable");
});

t("a partial or capped read keeps its rows AND its warning", () => {
  const out = buildTimeline({
    ...FULL,
    contacts: { rows: FULL.contacts.rows, partial: "Read without the firm join, so some contacts may be missing." },
  });
  assert.equal(out.caveats.length, 1);
  assert.match(out.caveats[0].note, /may be missing/);
  assert.ok(out.events.some((e) => e.source === SOURCES.salesContact), "the rows it did get are still shown");
  assert.equal(out.unknown.length, 0, "a short read is not the same as a failed one");
});

/* ---------- records begin ---------- */

t("'our records begin' is the OLDEST event's date, not the newest", () => {
  const out = buildTimeline(FULL);
  assert.equal(out.recordsBegin, out.events[0].ymd);
  assert.equal(out.recordsBegin, "2026-01-10");
});

t("with nothing to show, 'records begin' is null — never today", () => {
  const out = buildTimeline({ client: null, contacts: ok([]) });
  assert.equal(out.recordsBegin, null, "a date here would invent the day our records start");
});

t("an unreadable timestamp does not become 1970 and steal the first line", () => {
  const out = buildTimeline({ ...FULL, client: { ...CLIENT, created_at: "not a date" } });
  assert.equal(out.recordsBegin, "2026-01-10", "the broken date is not the oldest thing we know");
  assert.ok(out.undated.some((u) => u.title.includes("added to the console")));
  assert.equal(atFromStamp("not a date"), null);
  assert.equal(atFromStamp(null), null);
});

/* ---------- every row says where it came from ---------- */

t("every event carries a source, and it is one of the known words", () => {
  const known = new Set(Object.values(SOURCES));
  const out = buildTimeline(FULL);
  assert.ok(out.events.length > 5);
  for (const e of out.events) {
    assert.ok(e.source, `${e.title} has no source`);
    assert.ok(known.has(e.source), `${e.source} is not one of the agreed words`);
    assert.ok(e.ymd, `${e.title} has no date`);
  }
  for (const u of out.undated) assert.ok(u.source && u.why, "an undated row still names its source and why it has no date");
});

t("a call and a weekly write-up never read alike", () => {
  const out = buildTimeline(FULL);
  const call = out.events.find((e) => e.key === "act:a1");
  const week = out.events.find((e) => e.key === "week:w1");
  assert.equal(call.source, SOURCES.salesCall);
  assert.equal(week.source, SOURCES.weekly);
  assert.notEqual(call.source, week.source);
});

t("an activity type nobody has seen before still gets honest words", () => {
  /* admin_lead_activity's check constraint has grown twice already. A new type
     must fall back, not vanish and not be mislabelled as a call. */
  assert.equal(activitySource("call"), SOURCES.salesCall);
  assert.equal(activitySource("wormhole"), SOURCES.salesLog);
  assert.equal(activitySource(undefined), SOURCES.salesLog);
});

/* ---------- nothing is claimed that is not recorded ---------- */

t("a live website is listed as undated, not dated from its last edit", () => {
  const out = buildTimeline(FULL);
  assert.equal(out.events.filter((e) => e.title.includes("is live")).length, 0);
  const live = out.undated.find((u) => u.title.includes("is live"));
  assert.ok(live, "the fact is kept");
  assert.match(live.why, /day it went live/, "and the reason it has no date is said out loud");
});

t("a finished task says its date is the last row change, not the finish", () => {
  const done = buildTimeline(FULL).events.find((e) => e.key === "task:t1:done");
  assert.match(done.detail, /last time the task row changed/);
});

t("a due date is not turned into an event", () => {
  const out = buildTimeline(FULL);
  assert.equal(out.events.filter((e) => e.ymd === "2026-12-31").length, 0,
    "a day something is meant to happen is not a day something happened");
});

t("a week with nothing written in it is not shown as work, but is counted", () => {
  const out = buildTimeline(FULL);
  assert.equal(out.events.filter((e) => e.source === SOURCES.weekly).length, 1);
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0], /nothing written/);
});

t("a lost contact's closed_at is never printed as the day they signed", () => {
  const out = buildTimeline({
    ...FULL,
    contacts: ok([{ id: "l9", name: "Sam Poe", stage: "lost", created_at: "2026-01-05T10:00:00Z", closed_at: "2026-02-01T10:00:00Z", became_customer: false }]),
    activityByContact: { l9: ok([]) },
  });
  assert.equal(out.events.filter((e) => e.source === SOURCES.salesClose).length, 0);
});

t("no secret and no card digits reach the timeline", () => {
  const out = buildTimeline({
    ...FULL,
    vault: ok([{ id: "v9", label: "Chase card", kind: "card", card_last4: "4242", username: "billing@lakeside.example", created_at: "2026-03-13T11:00:00Z" }]),
  });
  const line = JSON.stringify(out.events.find((e) => e.key === "vault:v9"));
  assert.ok(!line.includes("4242"), "no card digits");
  assert.ok(!line.includes("billing@"), "no login name");
});

/* ---------- nothing at all ---------- */

t("no input at all: no crash, no events, no false claim", () => {
  const out = buildTimeline();
  assert.deepEqual(out.events, []);
  assert.deepEqual(out.undated, []);
  assert.equal(out.recordsBegin, null);
  assert.equal(out.sales.state, "unknown");
  assert.ok(out.unknown.length > 0, "with nothing read, everything is unknown");
  assert.deepEqual(out.bySource, {});
});

t("a reader that answers with rows:null is treated as empty, not crashed", () => {
  const out = buildTimeline({ client: CLIENT, contacts: ok(null), tasks: { rows: undefined } });
  assert.ok(out.events.length >= 1, "the client's own dates still show");
  assert.equal(out.sales.state, "none");
});

t("sample data is flagged, so preview numbers are never read as real", () => {
  assert.equal(buildTimeline(FULL).sample, false);
  assert.equal(buildTimeline({ ...FULL, tasks: { rows: [], sample: true } }).sample, true);
});

/* ---------- the small pieces ---------- */

t("readSection tells apart never-asked, failed, and empty", () => {
  assert.equal(readSection(undefined).ok, false);
  assert.equal(readSection({ rows: [], error: "nope" }).ok, false);
  assert.equal(readSection({ rows: [] }).ok, true);
  assert.equal(readSection({ rows: [1], truncated: "only the first 500" }).caveat, "only the first 500");
});

t("prettyDay never prints a wrong day and never throws", () => {
  assert.equal(prettyDay("2026-03-09"), "Mar 9, 2026");
  assert.equal(prettyDay(null), "an unknown date");
  assert.equal(prettyDay("rubbish"), "an unreadable date");
});

/* ---------- a read that hit its row cap (added Aug 26 2026) ----------
 *
 * The one that mattered most. Only listClientContacts reports a short read, so
 * the other seven can hand back a capped list that looks complete, and the
 * panel then names the oldest row it happened to load as the day our records
 * begin. These cases pin the guard that stops it.
 */

t("a read that came back full stops the panel claiming where records begin", () => {
  /* 25 reports is exactly listClientReports' cap, so we cannot tell this from
     a client with 26. The honest answer is that we do not know. */
  const rows = Array.from({ length: SECTION_CAPS.reports }, (_, i) => ({
    id: `r${i}`, title: `Report ${i}`, source: "counted",
    created_at: `2026-04-${String(i + 1).padStart(2, "0")}T09:00:00Z`,
  }));
  const out = buildTimeline({ ...FULL, reports: ok(rows) });
  assert.equal(out.recordsBeginIsFloor, true, "the begin date is only a floor now");
  assert.equal(out.capped.length, 1);
  assert.equal(out.capped[0].source, SOURCES.report);
  assert.equal(out.capped[0].cap, SECTION_CAPS.reports);
  assert.ok(out.recordsBegin, "the date is still given — a list with no stated floor is its own lie");
  assert.ok(out.caveats.some((c) => /all it is allowed to load/.test(c.note)),
    "and the reason is said out loud above the list");
});

t("a capped ACTIVITY read is caught too, and names the person", () => {
  /* The real failure: 250 logged calls, the newest 200 come back, the oldest
     survivor is in April, and January is invisible. */
  const rows = Array.from({ length: SECTION_CAPS.activity }, (_, i) => ({
    id: `a${i}`, type: "call", outcome: "talked", created_at: `2026-04-03T${String(i % 24).padStart(2, "0")}:00:00Z`,
  }));
  const out = buildTimeline({ ...FULL, activityByContact: { l1: ok(rows) } });
  assert.equal(out.recordsBeginIsFloor, true);
  assert.match(out.capped[0].source, /Dana Reed/, "the person is named so it is fixable");
  assert.equal(out.unknown.length, 0, "a capped read is short, not failed");
});

t("a read comfortably under its cap makes no claim about being short", () => {
  const out = buildTimeline(FULL);
  assert.deepEqual(out.capped, []);
  assert.equal(out.recordsBeginIsFloor, false, "this one really does say where our records begin");
});

/* ---------- the eight kinds of record ---------- */

t("kinds counts the eight kinds of record, never the source words", () => {
  /* Nine activity rows of nine types spell out nine source words. They are all
     one table and one kind of record, and the old count said 11. */
  const types = ["call", "email", "text", "linkedin", "note", "status_change", "assigned", "proposal", "converted"];
  const out = buildTimeline({
    ...FULL,
    activityByContact: {
      l1: ok(types.map((type, i) => ({ id: `a${i}`, type, created_at: `2026-02-0${i + 1}T10:00:00Z` }))),
    },
  });
  assert.ok(Object.keys(out.bySource).length > out.kinds.total, "there really are more source words than kinds");
  assert.equal(out.kinds.total, KINDS.length);
  assert.equal(out.kinds.read, 8, "all eight were read");
  assert.equal(out.kinds.read, out.kinds.readLabels.length, "the number and the names agree");
});

t("a kind read fine but empty still counts as read", () => {
  const out = buildTimeline({ ...FULL, vault: ok([]) });
  assert.equal(out.kinds.read, 8, "we read the vault; there was nothing in it");
  assert.ok(out.kinds.readLabels.includes("the vault"));
  assert.equal(out.kinds.failed, 0);
});

t("failed kinds can never outnumber the kinds themselves", () => {
  /* Five contacts, five failed activity reads. That is five lines in the
     unknown list and ONE kind of record we could not read — the panel used to
     print "read from 2 kinds of record, 5 of them could not be read". */
  const people = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `Person ${i}`, created_at: "2026-01-02T10:00:00Z" }));
  const activityByContact = {};
  for (const p of people) activityByContact[p.id] = { rows: [], error: "permission denied" };
  const out = buildTimeline({ ...FULL, contacts: ok(people), activityByContact });
  assert.equal(out.unknown.length, 5, "each person is still named so each is fixable");
  assert.equal(out.kinds.failed, 1, "but the sales log is one kind of record");
  assert.equal(out.kinds.read + out.kinds.failed, out.kinds.total, "the two numbers share one denominator");
  assert.ok(out.kinds.failed <= out.kinds.total);
});

t("every read failing is eight kinds failed and no count of events", () => {
  /* What the panel prints from this is the whole point: not "0 dated things",
     and not "nothing has been written down". */
  const bad = { rows: [], error: "boom" };
  const out = buildTimeline({
    client: null, contacts: bad, activityByContact: {},
    tasks: bad, sites: bad, weekly: bad, reports: bad, connections: bad, vault: bad,
  });
  assert.equal(out.events.length, 0);
  assert.equal(out.recordsBegin, null);
  assert.equal(out.kinds.read, 0);
  assert.equal(out.kinds.failed, 8);
  assert.deepEqual(out.kinds.readLabels, [], "nothing may be named as read");
  assert.equal(out.unknown.length, 8, "the panel gates its sentences on this being above zero");
});

/* ---------- an undated row always says why ---------- */

t("a start date that will not read as a day says so, naming the value", () => {
  const out = buildTimeline({ ...FULL, client: { ...CLIENT, start_date: "garbage" } });
  const row = out.undated.find((u) => u.title === "Start date on file");
  assert.ok(row, "the fact is kept");
  assert.ok(row.why, "and it is not printed bare under a heading that promises a reason");
  assert.match(row.why, /garbage/, "the bad value is quoted back so somebody can fix it");
});

t("a first-contact date that will not read says so, naming the person", () => {
  const out = buildTimeline({
    ...FULL,
    contacts: ok([{ id: "l1", name: "Dana Reed", created_at: "2026-01-10T12:00:00Z", first_contact_at: "sometime in spring" }]),
    activityByContact: { l1: ok([]) },
  });
  const row = out.undated.find((u) => u.title.includes("First contact"));
  assert.ok(row && row.why);
  assert.match(row.why, /Dana Reed/);
  assert.match(row.why, /sometime in spring/);
});

/* ---------- one bad row must not cost the whole tab ---------- */

t("a null row is skipped, not thrown on", () => {
  const out = buildTimeline({ contacts: { rows: [null] } });
  assert.equal(out.sales.state, "none", "the read worked; it just had nothing usable in it");
  assert.equal(out.events.length, 0);
  assert.ok(out.notes.some((n) => /skipped/.test(n)), "and the dropped row is admitted");
});

t("one junk row does not take the good rows with it", () => {
  const out = buildTimeline({
    ...FULL,
    tasks: ok([null, "nonsense", 7, { id: "t1", name: "Real task", status: "todo", created_at: "2026-03-10T13:00:00Z" }]),
  });
  assert.equal(out.events.filter((e) => e.source === SOURCES.task).length, 1, "the real task still shows");
  assert.ok(out.notes.some((n) => /3 rows were skipped/.test(n)));
  assert.equal(out.unknown.length, 0, "a read with a bad row in it is not a failed read");
});

t("a bad row in any section is survivable, not just tasks", () => {
  for (const key of ["contacts", "tasks", "sites", "weekly", "reports", "connections", "vault"]) {
    assert.doesNotThrow(() => buildTimeline({ ...FULL, [key]: ok([null]) }), `${key} threw on a null row`);
  }
  assert.doesNotThrow(() => buildTimeline({ ...FULL, activityByContact: { l1: ok([null]) } }));
});

/* ---------- the small pieces ---------- */

t("joinWords says a list the way a person would", () => {
  assert.equal(joinWords([]), "");
  assert.equal(joinWords(["tasks"]), "tasks");
  assert.equal(joinWords(["tasks", "the vault"]), "tasks and the vault");
  assert.equal(joinWords(["a", "b", "c"]), "a, b and c");
});

t("readSection reports how many rows came back and how many were junk", () => {
  const got = readSection({ rows: [{ id: 1 }, null, { id: 2 }] });
  assert.equal(got.ok, true);
  assert.equal(got.rows.length, 2);
  assert.equal(got.fetched, 3, "the cap check needs what the database handed back");
  assert.equal(got.dropped, 1);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
