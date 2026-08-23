/* Tests for the Overview snapshot's date maths — Aug 22 2026.
 *
 * Run with:  bash tests/overview/run.sh
 *
 * No database, no keys, no network, no browser.
 *
 * These exist because the first version of the Overview page got this wrong in
 * three separate ways at once, and every one of them was invisible in a Chicago
 * browser at midday:
 *
 *   1. `Date.parse(ymd + "T00:00:00Z")` was used as "midnight Central". It is
 *      midnight in London, so the team's day ended at 6:59pm and an 8pm
 *      reminder was pushed to tomorrow.
 *   2. Task piles came from getMyWork(), which buckets on the BROWSER's clock,
 *      while the label on the row beside them was computed on the team's clock.
 *      A New York browser at 00:30 showed a task in the red "Late" pile with a
 *      pill next to it reading "TODAY".
 *   3. Notes were sorted with urgency 1 as the most urgent. It is 3.
 *
 * The run.sh script runs this file five times, once per timezone, because a
 * date test that only runs in one zone is how all three shipped.
 */

import assert from "node:assert/strict";
import {
  DAY, zoneOffsetMs, teamDayStartOf, teamDayEndOf, teamDateAfter, teamDatePlus,
  dueLabel, taskBucket, parsedOr0,
} from "../../src/lib/teamDay.js";
import { teamDate } from "../../lib/brain-context.js";
import { salesQueue, isOpenStage } from "../../lib/sales-rules.js";

let passed = 0;
let failed = 0;
const TZ = process.env.TZ || "(system)";

function t(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

/** What a wall clock in a given zone reads at an instant — for readable tests. */
function wall(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(ms));
}

console.log(`\n=== Overview date maths · TZ=${TZ} ===`);

/* ---------------- the zone offset ---------------- */

t("zoneOffsetMs is -5h during central daylight time", () => {
  assert.equal(zoneOffsetMs(Date.parse("2026-08-22T18:00:00Z")), -5 * 3600000);
});

t("zoneOffsetMs is -6h during central standard time", () => {
  assert.equal(zoneOffsetMs(Date.parse("2026-01-15T18:00:00Z")), -6 * 3600000);
});

/* ---------------- day boundaries ---------------- */

t("teamDayStartOf is real midnight in Chicago, in summer", () => {
  assert.equal(wall(teamDayStartOf("2026-08-22"), "America/Chicago"), "2026-08-22, 00:00");
});

t("teamDayStartOf is real midnight in Chicago, in winter", () => {
  assert.equal(wall(teamDayStartOf("2026-01-15"), "America/Chicago"), "2026-01-15, 00:00");
});

t("teamDayStartOf survives the spring-forward day", () => {
  // 2026-03-08 is the US spring-forward. 2am never happens; midnight does.
  assert.equal(wall(teamDayStartOf("2026-03-08"), "America/Chicago"), "2026-03-08, 00:00");
});

t("teamDayStartOf survives the fall-back day", () => {
  assert.equal(wall(teamDayStartOf("2026-11-01"), "America/Chicago"), "2026-11-01, 00:00");
});

t("teamDayEndOf is 23:59 Chicago on BOTH clock-change days", () => {
  // Round one fixed the zone but kept `start + 24h - 1`. Two days a year are
  // not 24h long, so the fall-back day ended at 22:59 — filing an 11pm
  // reminder under "coming up" while its own label read "today" — and the
  // spring-forward day ended at 00:59 the NEXT morning.
  for (const d of ["2026-03-08", "2026-11-01", "2024-03-10", "2030-11-03",
                   "2026-03-07", "2026-11-02", "2026-06-15", "2026-12-31"]) {
    assert.equal(wall(teamDayEndOf(d), "America/Chicago"), `${d}, 23:59`, d);
  }
});

t("every day of 2026 ends at 23:59 Chicago", () => {
  const bad = [];
  for (let i = 0; i < 365; i++) {
    const ymd = teamDate(teamDayStartOf("2026-01-01") + i * DAY + DAY / 2);
    if (wall(teamDayEndOf(ymd), "America/Chicago") !== `${ymd}, 23:59`) bad.push(ymd);
  }
  assert.equal(bad.length, 0, `${bad.length} bad days, first ${bad[0]}`);
});

t("teamDateAfter steps one calendar day, including over both switches", () => {
  assert.equal(teamDateAfter("2026-03-07"), "2026-03-08");
  assert.equal(teamDateAfter("2026-03-08"), "2026-03-09");
  assert.equal(teamDateAfter("2026-10-31"), "2026-11-01");
  assert.equal(teamDateAfter("2026-11-01"), "2026-11-02");
  assert.equal(teamDateAfter("2026-12-31"), "2027-01-01");
  assert.equal(teamDateAfter("2028-02-28"), "2028-02-29");
  assert.equal(teamDateAfter("rubbish"), null);
});

t("a reminder at 11pm on the fall-back night counts as due TODAY", () => {
  // The exact row that broke: Sun Nov 1 2026, 23:30 Central.
  const now = Date.parse("2026-11-02T05:30:00Z");
  assert.equal(wall(now, "America/Chicago"), "2026-11-01, 23:30");
  const dueAt = Date.parse("2026-11-02T04:45:00Z");           // 22:45 Central, same night
  assert.equal(wall(dueAt, "America/Chicago"), "2026-11-01, 22:45");
  assert.ok(dueAt <= teamDayEndOf(teamDate(now)), "22:45 tonight must be inside tonight");
  assert.equal(dueLabel(teamDayEndOf(teamDate(dueAt)), now), "today");
});

t("a reminder at 00:30 the morning after spring-forward is NOT due yet", () => {
  const now = Date.parse("2026-03-08T23:00:00Z");             // 17:00 Central, Mar 8
  const dueAt = Date.parse("2026-03-09T06:30:00Z");           // 01:30 Central, Mar 9
  assert.equal(wall(dueAt, "America/Chicago"), "2026-03-09, 01:30");
  assert.ok(dueAt > teamDayEndOf(teamDate(now)), "tomorrow morning is not today");
  assert.equal(dueLabel(teamDayEndOf(teamDate(dueAt)), now), "tomorrow");
});

t("a far-off date due on the spring-forward day prints its own date", () => {
  const now = Date.parse("2026-02-20T18:00:00Z");
  assert.equal(dueLabel(teamDayEndOf("2026-03-08"), now), "Mar 8");   // not "Mar 9"
  assert.equal(dueLabel(teamDayEndOf("2026-11-01"), now), "Nov 1");
});

t("the old flat +24h end-of-day, for the record", () => {
  // round one's bug: UTC midnight + 24h ended the day at 18:59 Central
  const utcish = Date.parse("2026-08-22T00:00:00Z") + DAY - 1;
  assert.equal(wall(utcish, "America/Chicago"), "2026-08-22, 18:59");
  assert.ok(teamDayEndOf("2026-08-22") > utcish);
  // round two's bug: right midnight, flat 24h, wrong on the switch days
  const flat = teamDayStartOf("2026-11-01") + DAY - 1;
  assert.equal(wall(flat, "America/Chicago"), "2026-11-01, 22:59");
  assert.ok(teamDayEndOf("2026-11-01") > flat);
});

t("a day is exactly 24h except on the two switch days", () => {
  assert.equal(teamDayStartOf("2026-08-23") - teamDayStartOf("2026-08-22"), DAY);
  assert.equal(teamDayStartOf("2026-03-09") - teamDayStartOf("2026-03-08"), DAY - 3600000);
  assert.equal(teamDayStartOf("2026-11-02") - teamDayStartOf("2026-11-01"), DAY + 3600000);
});

t("teamDayStartOf(bad) is NaN, not a date in 1970", () => {
  assert.ok(Number.isNaN(teamDayStartOf("not-a-date")));
  assert.ok(Number.isNaN(teamDayEndOf("")));
});

/* ---------------- the 8pm reminder, which is the whole point ---------------- */

t("a reminder set for 8pm Central counts as due TODAY", () => {
  const now = Date.parse("2026-08-22T22:00:00Z");       // 5pm Chicago, Aug 22
  const dueAt = Date.parse("2026-08-23T01:00:00Z");     // 8pm Chicago, Aug 22
  const endToday = teamDayEndOf(teamDate(now));
  assert.equal(wall(dueAt, "America/Chicago"), "2026-08-22, 20:00");
  assert.ok(dueAt <= endToday, "8pm today must be inside today");
  assert.equal(dueLabel(teamDayEndOf(teamDate(dueAt)), now), "today");
});

t("a reminder set for 8pm YESTERDAY is late, and says so", () => {
  const now = Date.parse("2026-08-22T22:00:00Z");       // 5pm Chicago, Aug 22
  const dueAt = Date.parse("2026-08-22T01:00:00Z");     // 8pm Chicago, Aug 21
  assert.ok(dueAt < teamDayStartOf(teamDate(now)), "yesterday 8pm is before today starts");
  assert.equal(dueLabel(teamDayEndOf(teamDate(dueAt)), now), "1 day late");
});

/* ---------------- labels agree with buckets, in every zone ---------------- */

const CASES = [
  // now (UTC),                     due date,       bucket,    label
  ["2026-08-22T17:00:00Z", "2026-08-22", "today", "today"],       // noon Chicago
  ["2026-08-23T04:30:00Z", "2026-08-22", "today", "today"],       // 11:30pm Chicago — midnight in New York
  ["2026-08-23T04:30:00Z", "2026-08-23", "week", "tomorrow"],
  ["2026-08-23T05:00:00Z", "2026-08-22", "overdue", "1 day late"], // midnight Chicago, 10pm in LA
  ["2026-08-22T17:00:00Z", "2026-08-21", "overdue", "1 day late"],
  ["2026-08-22T17:00:00Z", "2026-08-18", "overdue", "4 days late"],
  ["2026-08-22T17:00:00Z", "2026-08-23", "week", "tomorrow"],
  ["2026-08-22T17:00:00Z", "2026-08-26", "week", "in 4 days"],
  ["2026-08-22T17:00:00Z", "2026-08-28", "week", "in 6 days"],
  ["2026-08-22T17:00:00Z", "2026-08-29", "later", "Aug 29"],
  ["2026-03-07T18:00:00Z", "2026-03-09", "week", "in 2 days"],     // across spring-forward
  ["2026-10-31T18:00:00Z", "2026-11-02", "week", "in 2 days"],     // across fall-back
];

for (const [nowIso, due, bucket, label] of CASES) {
  const now = Date.parse(nowIso);
  t(`due ${due} at ${nowIso} → bucket "${bucket}", label "${label}"`, () => {
    assert.equal(taskBucket({ due_date: due, status: "todo" }, now), bucket, "bucket");
    assert.equal(dueLabel(teamDayEndOf(due), now), label, "label");
  });
}

t("a reminder is never in one bucket while its own label says the other", () => {
  // The task path compares date strings and was always safe. The reminder path
  // compares an absolute instant against the end of the team day, which is
  // where both date bugs actually bit. Sweep every 20 minutes across both
  // clock changes and a normal week.
  const bad = [];
  for (const from of ["2026-03-05T00:00:00Z", "2026-10-29T00:00:00Z", "2026-08-10T00:00:00Z"]) {
    for (let step = 0; step < 6 * 24 * 3; step++) {
      const now = Date.parse(from) + step * 1200000;
      const endToday = teamDayEndOf(teamDate(now));
      const startToday = teamDayStartOf(teamDate(now));
      for (let off = -2.5; off <= 2.5; off += 0.25) {
        const at = now + off * DAY;
        const due = at <= endToday;
        const late = at < startToday;
        const label = dueLabel(teamDayEndOf(teamDate(at)), now);
        const ok =
          (late && /late/.test(label)) ||
          (due && !late && label === "today") ||
          (!due && !/late|^today$/.test(label));
        if (!ok) {
          bad.push(`now=${new Date(now).toISOString()} at=${new Date(at).toISOString()} due=${due} late=${late} label="${label}"`);
        }
      }
    }
  }
  assert.equal(bad.length, 0, `${bad.length} contradictions, first: ${bad[0]}`);
});

t("the task label never contradicts its bucket, across both clock changes", () => {
  // The exact failure the reviewer proved: a red "Late" tile with a "TODAY"
  // pill on the row inside it. Brute-force every half hour instead of trusting
  // a handful of examples.
  const bad = [];
  const starts = ["2026-08-10T00:00:00Z", "2026-03-04T00:00:00Z", "2026-10-28T00:00:00Z"];
  for (let h = 0; h < 24 * 12 * 2 * starts.length; h++) {
    const now = Date.parse(starts[h % starts.length]) + Math.floor(h / starts.length) * 1800000;
    for (let d = -3; d <= 8; d++) {
      const due = teamDatePlus(now, d);
      const bucket = taskBucket({ due_date: due, status: "todo" }, now);
      const label = dueLabel(teamDayEndOf(due), now);
      const agree =
        (bucket === "overdue" && /late/.test(label)) ||
        (bucket === "today" && label === "today") ||
        (bucket === "week" && (label === "tomorrow" || /^in [1-6] days$/.test(label))) ||
        (bucket === "later" && !/late|^today$/.test(label));
      if (!agree) bad.push(`${new Date(now).toISOString()} due=${due} bucket=${bucket} label="${label}"`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} contradictions, first: ${bad[0]}`);
});

t("teamDatePlus(0) is the team's today, and +6 is six days on", () => {
  const now = Date.parse("2026-08-22T17:00:00Z");
  assert.equal(teamDatePlus(now, 0), "2026-08-22");
  assert.equal(teamDatePlus(now, 6), "2026-08-28");
  // and across the spring-forward, where a naive +6*DAY lands at 23:00 the day before
  assert.equal(teamDatePlus(Date.parse("2026-03-05T18:00:00Z"), 6), "2026-03-11");
});

/* ---------------- buckets ---------------- */

t("a blocked task is blocked, whatever its date says", () => {
  const now = Date.parse("2026-08-22T17:00:00Z");
  assert.equal(taskBucket({ due_date: "2026-01-01", status: "blocked" }, now), "blocked");
  assert.equal(taskBucket({ due_date: null, status: "blocked" }, now), "blocked");
});

t("a task with no date is nodate, not overdue", () => {
  const now = Date.parse("2026-08-22T17:00:00Z");
  assert.equal(taskBucket({ due_date: null, status: "todo" }, now), "nodate");
  assert.equal(taskBucket({ status: "todo" }, now), "nodate");
});

t("a full timestamp in due_date is read as its date", () => {
  const now = Date.parse("2026-08-22T17:00:00Z");
  assert.equal(taskBucket({ due_date: "2026-08-22T00:00:00+00:00", status: "todo" }, now), "today");
});

/* ---------------- the small stuff that bit us ---------------- */

t("dueLabel of nothing is 'no date', never 'Invalid Date'", () => {
  const now = Date.parse("2026-08-22T17:00:00Z");
  for (const v of [null, undefined, NaN, teamDayEndOf("rubbish")]) {
    assert.equal(dueLabel(v, now), "no date");
  }
});

t("parsedOr0 of null is 0, not the year 2000", () => {
  assert.equal(parsedOr0(null), 0);
  assert.equal(parsedOr0(undefined), 0);
  assert.equal(parsedOr0(""), 0);
  assert.equal(parsedOr0("rubbish"), 0);
  assert.equal(parsedOr0("2026-08-22T00:00:00Z"), Date.parse("2026-08-22T00:00:00Z"));
  // the actual old bug: Date.parse(0) is "0" is the year 2000
  assert.ok(Date.parse(0) > 946000000000, "sanity: Date.parse(0) really is the year 2000");
});

t("sorting notes urgency-descending puts 3 first", () => {
  const notes = [
    { id: "a", urgency: 1, generated_at: "2026-08-22T10:00:00Z" },
    { id: "b", urgency: 3, generated_at: "2026-08-20T10:00:00Z" },
    { id: "c", urgency: 2, generated_at: "2026-08-22T11:00:00Z" },
    { id: "d", urgency: 3, generated_at: "2026-08-22T09:00:00Z" },
    { id: "e", urgency: null, generated_at: null },
  ];
  const sorted = notes.slice().sort((a, b) =>
    (b.urgency || 0) - (a.urgency || 0)
    || parsedOr0(b.generated_at) - parsedOr0(a.generated_at));
  assert.deepEqual(sorted.map((n) => n.id), ["d", "b", "c", "a", "e"]);
});

/* ---------------- the non-date fixes, as plain assertions ---------------- */

t("an unreadable reminder date sorts LAST, so it cannot become START HERE", () => {
  const rows = [
    { id: "broken", atMs: null },
    { id: "sixLate", atMs: Date.parse("2026-08-16T14:00:00Z") },
    { id: "today", atMs: Date.parse("2026-08-22T14:00:00Z") },
  ];
  const byDue = (a, b) =>
    (a.atMs ?? Number.MAX_SAFE_INTEGER) - (b.atMs ?? Number.MAX_SAFE_INTEGER);
  const sorted = rows.slice().sort(byDue);
  assert.deepEqual(sorted.map((r) => r.id), ["sixLate", "today", "broken"]);
  assert.equal(sorted.find((r) => r.atMs !== null).id, "sixLate", "the headline picks a dated one");
});

t("all three written_by values get their own label", () => {
  const label = (v) => v === "counted" ? "COUNTED"
    : v === "person" ? "WRITTEN BY A PERSON"
      : v === "ai_written" ? "AI-WRITTEN" : "SOURCE UNKNOWN";
  assert.equal(label("counted"), "COUNTED");
  assert.equal(label("ai_written"), "AI-WRITTEN");
  assert.equal(label("person"), "WRITTEN BY A PERSON");
  assert.equal(label(null), "SOURCE UNKNOWN");
});

t("a client with no open tasks is only chased if it is an ACTIVE client", () => {
  const clients = [
    { id: "a", status: "active" }, { id: "b", status: "prospect" },
    { id: "c", status: "holding" }, { id: "d", status: "closed" },
  ];
  const active = clients.filter((c) => (c.status || "active") === "active");
  assert.deepEqual(active.map((c) => c.id), ["a"]);
});

/* ---------------- agreement with the Sales page ---------------- */

t("the owed count uses the Sales page's own rules and its own expression", () => {
  // Overview must not answer "who owes a contact" differently from My Day.
  // Same function, same filter — this pins the filter.
  const now = "2026-08-22T17:00:00Z";
  const me = "u-ryder";
  const leads = [
    // claimed 6 business days ago, never contacted -> claim_expired, over >= 0
    { id: "expired", stage: "contacted", owner_id: me, claimed_at: "2026-08-12T09:00:00Z" },
    // claimed, contacted, silent 20 days -> cold, over >= 0
    { id: "cold", stage: "follow_up", owner_id: me, claimed_at: "2026-07-01T09:00:00Z",
      claim_contacted_at: "2026-07-02T09:00:00Z", last_touch_at: "2026-08-02T09:00:00Z" },
    // claimed yesterday, contacted today -> working, nothing owed
    { id: "fresh", stage: "contacted", owner_id: me, claimed_at: "2026-08-21T09:00:00Z",
      claim_contacted_at: "2026-08-22T09:00:00Z", last_touch_at: "2026-08-22T09:00:00Z" },
    // nobody's -> unclaimed, must NOT count as owed by me
    { id: "floor", stage: "new", owner_id: null, created_at: "2026-08-01T09:00:00Z" },
    // somebody else's -> not my day at all
    { id: "theirs", stage: "contacted", owner_id: "u-cj", claimed_at: "2026-08-01T09:00:00Z" },
    // a closed stage -> never chased. skip_90 and bad_contact are closed too.
    { id: "won", stage: "won", owner_id: me, claimed_at: "2026-08-01T09:00:00Z" },
    { id: "skipped", stage: "skip_90", owner_id: me, claimed_at: "2026-08-01T09:00:00Z" },
    { id: "bad", stage: "bad_contact", owner_id: me, claimed_at: "2026-08-01T09:00:00Z" },
  ];
  const queue = salesQueue(leads, { userId: me, now, touchCounts: {}, includeUnclaimed: true, scoreOf: () => null });
  const owed = queue.filter((c) => c.over !== null && c.over >= 0 && c.reason !== "unclaimed");
  const ids = owed.map((c) => c.lead.id);

  assert.ok(ids.includes("expired"), "an expired claim is owed");
  assert.ok(ids.includes("cold"), "a cold firm is owed");
  assert.ok(!ids.includes("floor"), "unclaimed is not owed BY ME");
  assert.ok(!ids.includes("theirs"), "somebody else's lead is not in my day");
  for (const closed of ["won", "skipped", "bad"]) {
    assert.ok(!ids.includes(closed), `${closed} is a closed stage and must never be chased`);
  }
  // the expired claim outranks the cold one
  assert.equal(ids[0], "expired", `ranked wrong: ${ids.join(",")}`);
  // and the queue still reports the unclaimed row separately
  assert.equal(queue.filter((c) => c.reason === "unclaimed").length, 1);
});

t("isOpenStage covers all twelve stages the way 0009 declares them", () => {
  const all = ["new", "researching", "contacted", "in_conversation", "follow_up",
               "meeting", "proposal", "won", "lost", "skip_90", "bad_contact", "reopened"];
  const closed = all.filter((s) => !isOpenStage(s));
  assert.deepEqual(closed, ["won", "lost", "skip_90", "bad_contact"]);
  // the pipeline expression Overview uses
  const open = all.filter((s) => s !== "new" && isOpenStage(s));
  assert.deepEqual(open, ["researching", "contacted", "in_conversation", "follow_up",
                          "meeting", "proposal", "reopened"]);
});

t("touch counting matches what cadenceState documents", () => {
  // "every call / email / text / LinkedIn row on the timeline". A note is not
  // a touch, and neither are the bookkeeping types the pages write.
  const TOUCH_TYPES = ["call", "email", "text", "linkedin"];
  const rows = [
    { lead_id: "a", type: "call" }, { lead_id: "a", type: "email" },
    { lead_id: "a", type: "note" }, { lead_id: "a", type: "status_change" },
    { lead_id: "b", type: "linkedin" }, { lead_id: "b", type: "import" },
    { lead_id: "c", type: "text" },
  ];
  const counts = {};
  for (const r of rows) {
    if (!TOUCH_TYPES.includes(r.type)) continue;
    counts[r.lead_id] = (counts[r.lead_id] || 0) + 1;
  }
  assert.deepEqual(counts, { a: 2, b: 1, c: 1 });
});

console.log(`\n  ${passed} passed, ${failed} failed  (TZ=${TZ})`);
if (failed) process.exit(1);
