/* Tests for the parts of the Aug 20 2026 build that are pure logic:
 * the context engine's rendering and role scoping, the notes engine, and
 * the lead intake rules.
 *
 * Run with:  bash tests/brain/run.sh
 *
 * No database, no network, no AI key. Everything here is a function that
 * takes data and returns data, which is why those three files were written
 * that way in the first place.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  renderContext, renderFocus, scopeFor, canSee, daysSince, relDays,
  parseWhen, fetchCap, CAPS,
} from "../../lib/brain-context.js";
import { computeNotes, THRESHOLDS } from "../../lib/notes-engine.js";
import {
  dedupeKey, dedupeWithin, splitAgainstExisting, toLeadRow, guessColumn,
  cleanPhone, cleanDomain, cleanEmail, assignRoundRobin, normalizeApollo, normalizePlatform,
} from "../../lib/lead-intake.js";
import { parseRewrite, rewriteIsFaithful, numbersIn } from "../../api/notes-generate.js";
import { parseDelimited, sniffDelimiter, colToIndex, parseXlsx } from "../../src/lib/sheet.js";

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    results.push(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    results.push(`  FAIL ${name}\n       ${err.message}`);
  }
}

/* A fixed clock. Every date below is expressed against it, so these tests do
 * not start failing at midnight — which is exactly the kind of bug a test
 * suite is supposed to catch rather than cause. */
const NOW = Date.parse("2026-08-20T12:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const ahead = (d) => new Date(NOW + d * 86400000).toISOString();

const SNAP = {
  role: "owner",
  userId: "u-ryder",
  errors: {},
  team: [
    { user_id: "u-ryder", full_name: "Ryder S", email: "ryder@x.com", role: "owner", active: true },
    { user_id: "u-rep", full_name: "Casey R", email: "casey@x.com", role: "sales", active: true },
  ],
  clients: [
    { id: "c1", name: "Harbor Injury Law", status: "active", stage: "Week 3", vertical: "legal", notes: null },
    { id: "c2", name: "Lakeside Realty", status: "active", stage: "Ongoing", vertical: "real estate", notes: null },
  ],
  /* These field names are the REAL ones from supabase/migrations. They are not
   * a detail: an earlier version of this fixture invented `title` for a task
   * and `summary` for a weekly log, so the tests agreed with a bug instead of
   * catching it — every task reached the AI with no name on it and every
   * weekly log read as blank. The check at the end of this file now reads the
   * migrations and refuses any invented column. */
  tasks: [
    { id: "t1", name: "Ship the schema", client_id: "c1", assigned_to: "u-ryder", status: "todo", due_date: ago(6).slice(0, 10), priority: "high", latest_report: null },
    { id: "t2", name: "Second office address", client_id: "c1", assigned_to: null, status: "blocked", due_date: ago(2).slice(0, 10), priority: "medium", latest_report: null },
    { id: "t3", name: "Week 4 report", client_id: "c2", assigned_to: "u-ryder", status: "todo", due_date: ahead(3).slice(0, 10), priority: "medium", latest_report: null },
  ],
  weekly: [
    { id: "w1", client_id: "c1", week_no: 3, week_status: "complete", what_we_did: "Authority site into legal review", what_moved: null, whats_next: null, created_at: ago(2) },
    // c2 has nothing at all — that is the silent-client case.
  ],
  leads: [
    { id: "l1", name: "Sarah Chen", company: "Chen Dental", stage: "contacted", owner_id: "u-rep", last_activity_at: ago(9), created_at: ago(20), source: "csv", email: "s@chen.com" },
    { id: "l2", name: null, company: "Summit Roofing", stage: "new", owner_id: null, last_activity_at: null, created_at: ago(11), source: "scraper" },
    { id: "l3", name: "Won One", company: null, stage: "won", owner_id: "u-rep", last_activity_at: ago(2), created_at: ago(30), updated_at: ago(2), source: "manual" },
    { id: "l4", name: "Fresh Lead", company: null, stage: "contacted", owner_id: "u-rep", last_activity_at: ago(1), created_at: ago(3), source: "manual" },
  ],
  leadActivity: [
    { id: "a1", lead_id: "l4", actor: "u-rep", type: "call", outcome: "talked", body: "Wants a quote", created_at: ago(1) },
    { id: "a2", lead_id: "l1", actor: "u-rep", type: "email", outcome: "no_answer", body: null, created_at: ago(9) },
  ],
  leadSources: [
    { id: "s1", label: "Destin med spas", kind: "scraper", provider: "platform", auto_daily: true, last_run_at: ago(1), last_run_error: "Waiting on PLATFORM_LEADGEN_URL" },
  ],
  tickets: [
    { id: "k1", subject: "Login loop", status: "open", priority: "urgent", requester_email: "a@b.com", assigned_to: null, updated_at: ago(5) },
  ],
  emails: [
    { id: "e1", subject: "Audit question", status: "needs_reply", from_name: "Dana W", from_email: "d@x.com", client_id: "c2", assigned_to: "u-ryder", priority: "high", last_message_at: ago(4), notes: null },
    { id: "e2", subject: "Lease dates", status: "waiting", from_name: "J A", from_email: "j@x.com", client_id: "c1", assigned_to: null, priority: "normal", last_message_at: ago(8), notes: null },
  ],
  reminders: [
    { id: "r1", owner_id: "u-ryder", body: "Chase the lease dates", due_at: ago(3) },
    { id: "r2", owner_id: "u-ryder", body: "Send the invoice", due_at: ahead(2) },
  ],
  sites: [
    { id: "cs1", client_id: "c1", label: "Florida Injury Guide", live: false, created_at: ago(20), notes: "In legal review" },
    { id: "cs2", client_id: "c2", label: "Main site", live: true, created_at: ago(90), notes: null },
  ],
  brain: [{ id: "b1", kind: "rule", title: "Never promise rankings", body: "We never guarantee a score or a ranking." }],
  memory: [
    { id: "m1", kind: "preference", subject: "Harbor Injury Law", body: "Legal review first, allow a week.", weight: 5, confirmed: true, client_id: "c1" },
    { id: "m2", kind: "fact", subject: "Lakeside", body: "Dana is the decision maker.", weight: 3, confirmed: false, client_id: "c2" },
  ],
  notes: [],
};

/* ================================================================== */
/* 1. Role scoping — the security boundary                             */
/* ================================================================== */

test("a sales rep's scope has leads but not clients, email, tickets or money", () => {
  const s = scopeFor("sales");
  assert.ok(s.includes("leads"), "reps need leads");
  for (const forbidden of ["clients", "emails", "tickets", "money", "brain", "memory", "notes", "tasks", "weekly", "sites"]) {
    assert.ok(!s.includes(forbidden), `a rep must not see ${forbidden}`);
  }
});

test("an unknown role falls back to the narrowest scope, not the widest", () => {
  assert.deepEqual(scopeFor("marketing-intern"), scopeFor("sales"));
  assert.deepEqual(scopeFor(undefined), scopeFor("sales"));
  assert.deepEqual(scopeFor(null), scopeFor("sales"));
});

test("owner and admin see the same things", () => {
  assert.deepEqual(scopeFor("owner"), scopeFor("admin"));
});

test("canSee agrees with scopeFor", () => {
  assert.equal(canSee("sales", "clients"), false);
  assert.equal(canSee("sales", "leads"), true);
  assert.equal(canSee("owner", "clients"), true);
});

test("a rep's rendered context contains no client, email or ticket data", () => {
  /* The renderer is handed a FULL snapshot on purpose: this proves the role
   * gate in the RENDERER holds even if a caller loads more than it should.
   * userId is the rep's, not the owner's — the follow-ups in the fixture all
   * belong to the owner, so anything of theirs that appears is a leak. */
  const text = renderContext({ ...SNAP, role: "sales", userId: "u-rep" }, NOW);
  assert.ok(!text.includes("Harbor Injury Law"), "client name leaked to a rep");
  assert.ok(!text.includes("Audit question"), "email subject leaked to a rep");
  assert.ok(!text.includes("Login loop"), "ticket leaked to a rep");
  assert.ok(!text.includes("Ship the schema"), "task leaked to a rep");
  assert.ok(!text.includes("Chase the lease dates"), "another person's follow-up leaked to a rep");
  assert.ok(text.includes("Sarah Chen"), "a rep must still see leads");
});

/* ================================================================== */
/* 2. Rendering — honesty                                              */
/* ================================================================== */

test("an unreadable table is reported, not silently rendered as empty", () => {
  const text = renderContext({ ...SNAP, errors: { tickets: "permission denied" } }, NOW);
  assert.ok(text.includes("COULD NOT BE READ"));
  assert.ok(text.includes("tickets: permission denied"));
  assert.ok(text.includes("opposite answers"), "the AI has to be told why this matters");
});

test("an unconfirmed memory is labelled unconfirmed in the prompt", () => {
  const text = renderContext(SNAP, NOW);
  assert.ok(/UNCONFIRMED.*Lakeside/.test(text), "memory m2 should carry the UNCONFIRMED label");
  assert.ok(/confirmed.*Harbor Injury Law/.test(text));
});

test("standing rules are stated as outranking learned memories", () => {
  const text = renderContext(SNAP, NOW);
  assert.ok(text.indexOf("STANDING RULES") < text.indexOf("REMEMBERED"), "rules must come first");
  assert.ok(text.includes("they outrank everything else"));
});

test("a late task is marked LATE with the number of days, and names the task", () => {
  const text = renderContext(SNAP, NOW);
  assert.ok(text.includes("LATE by 6d"), "the six-day-late task should say so");
  assert.ok(text.includes("Ship the schema"), "the AI must be told WHICH task");
});

test("the weekly log reaches the AI with its actual words in it", () => {
  const text = renderContext(SNAP, NOW);
  assert.ok(text.includes("Authority site into legal review"));
  assert.ok(!/week 3.*\(blank\)/.test(text), "a full log must never render as blank");
});

test("a rep's own follow-ups are the only ones loaded for them", () => {
  // The load-time filter is checked by reading the source, because the fetch
  // is where it has to happen — filtering after the read would still have put
  // the rows in memory alongside a prompt builder.
  const src = readFileSync(new URL("../../lib/brain-context.js", import.meta.url), "utf8");
  assert.ok(/role === "sales"[\s\S]{0,120}eq\("owner_id", userId\)/.test(src),
    "loadSystemContext must filter reminders to the rep who asked");
});

test("the AI is warned when a list was cut short", () => {
  // fetchCap is what makes the warning reachable at all: fetch cap+1, print
  // cap. Without it lines.length can never exceed cap and the notice is dead
  // code, so the AI is told it saw everything, every time.
  const many = { ...SNAP, tasks: Array.from({ length: CAPS.tasks + 1 }, (_, i) => ({
    id: `x${i}`, name: `Task ${i}`, client_id: "c1", assigned_to: null,
    status: "todo", due_date: ago(1).slice(0, 10), priority: "low",
  })) };
  const text = renderContext(many, NOW);
  assert.ok(text.includes("were not shown"), "a truncated list must say so");
  assert.equal(fetchCap(10), 11);
});

test("a due date is judged by the team's calendar day, not UTC's", () => {
  // 00:30 UTC on the 21st is 7:30pm on the 20th in Chicago. A task due on the
  // 20th is due TODAY, not one day late.
  const evening = Date.parse("2026-08-21T00:30:00Z");
  assert.equal(daysSince("2026-08-20", evening), 0, "still today for the team");
  assert.equal(daysSince("2026-08-19", evening), 1);
  assert.equal(daysSince("2026-08-21", evening), -1);
});

test("a missing date is unknown, never the year 2000", () => {
  assert.ok(Number.isNaN(parseWhen(null)));
  assert.ok(Number.isNaN(parseWhen("")));
  assert.ok(Number.isNaN(parseWhen(undefined)));
  // Date.parse(x || 0) parses the string "0" as 2000-01-01, which is how a
  // null date won every oldest-first sort in the file.
  assert.equal(Date.parse(null || 0), Date.parse("2000-01-01T00:00:00Z"));
});

test("a lead who already signed is never chased", () => {
  const signed = { ...SNAP, leads: [{ ...SNAP.leads[0], became_customer: true }] };
  const notes2 = computeNotes(signed, NOW);
  assert.equal(notes2.filter((n) => n.fingerprint.startsWith("lead-cold")).length, 0);
});

test("a lead in a stage nobody wrote a rule for still goes stale", () => {
  // The Work page uses `?? 7`. Skipping unknown stages here made a lead
  // overdue on one screen and invisible on the other.
  const odd = { ...SNAP, leads: [{ id: "lz", name: "Odd One", stage: "nurture", owner_id: "u-rep", last_activity_at: ago(30), created_at: ago(40) }] };
  const notes2 = computeNotes(odd, NOW);
  assert.equal(notes2.filter((n) => n.fingerprint.startsWith("lead-cold")).length, 1);
});

test("an unclaimed pile with no dates on it does not claim to know the oldest", () => {
  const undated = { ...SNAP, leads: Array.from({ length: 6 }, (_, i) => ({
    id: `u${i}`, company: `Co ${i}`, stage: "new", owner_id: null, created_at: null, last_activity_at: null,
  })) };
  const n = computeNotes(undated, NOW).find((x) => x.fingerprint === "leads-unclaimed");
  assert.ok(n);
  assert.ok(n.body.includes("None of them has a date on it"));
  assert.ok(!n.body.includes("unknown"), "never write 'The oldest arrived unknown'");
});

test("a lead that has never been touched says so rather than showing a blank", () => {
  const text = renderContext(SNAP, NOW);
  assert.ok(text.includes("never touched"));
});

test("the focus block says plainly what 'this one' means", () => {
  const text = renderFocus(SNAP, { page: "Leads", record: { type: "lead", id: "l1", label: "Sarah Chen" } });
  assert.ok(text.includes("Sarah Chen"));
  assert.ok(text.includes('"this one"'));
});

test("the focus block is empty when no page published anything", () => {
  assert.equal(renderFocus(SNAP, null), "");
});

test("relative dates read the way a person would say them", () => {
  assert.equal(relDays(ago(0), NOW), "today");
  assert.equal(relDays(ago(1), NOW), "1 day ago");
  assert.equal(relDays(ago(5), NOW), "5 days ago");
  assert.equal(relDays(ahead(2), NOW), "in 2 days");
  assert.equal(relDays(null, NOW), "unknown");
  assert.equal(daysSince("not a date", NOW), null);
});

/* ================================================================== */
/* 3. The notes engine                                                 */
/* ================================================================== */

const NOTES = computeNotes(SNAP, NOW);
const byFp = (prefix) => NOTES.filter((n) => n.fingerprint.startsWith(prefix));

test("every note carries evidence — a note with none is never created", () => {
  assert.ok(NOTES.length > 0, "the fixture should produce notes");
  for (const n of NOTES) {
    assert.ok(Array.isArray(n.evidence) && n.evidence.length > 0, `"${n.title}" has no evidence`);
    for (const e of n.evidence) {
      assert.ok(e.table && e.label, "evidence must name a table and a label");
    }
  }
});

test("every generated note is marked COUNTED, never AI-written", () => {
  for (const n of NOTES) assert.equal(n.written_by, "counted");
});

test("a cold lead becomes a follow-up note against the rep who owns it", () => {
  const n = byFp("lead-cold")[0];
  assert.ok(n, "expected a cold-lead note");
  assert.equal(n.owner_id, "u-rep");
  assert.equal(n.category, "follow_up");
  assert.equal(n.urgency, 3, "9 days cold is a today-level note");
  assert.ok(n.body.includes("Sarah Chen"));
  assert.ok(!n.evidence.some((e) => e.id === "l4"), "a lead touched yesterday is not cold");
});

test("a won lead is never chased", () => {
  for (const n of byFp("lead-cold")) {
    assert.ok(!n.evidence.some((e) => e.id === "l3"), "a won lead appeared in a chase note");
  }
});

test("late tasks are grouped per client, not into one pile", () => {
  const late = byFp("tasks-late");
  assert.equal(late.length, 1, "both late tasks belong to c1, so one note");
  assert.equal(late[0].client_id, "c1");
  assert.ok(late[0].title.includes("Harbor Injury Law"));
  // Six days late is urgent but not today-level; the engine's line is at
  // seven. Written as an explicit check so moving that line is a decision.
  assert.equal(late[0].urgency, 2, "six days late is below the seven-day line");
});

test("a client with nothing in the weekly log is caught", () => {
  const n = byFp("weekly-log-silent")[0];
  assert.ok(n, "expected a silent-client note");
  assert.ok(n.body.includes("Lakeside Realty"));
  assert.ok(!n.body.includes("Harbor Injury Law"), "Harbor logged 2 days ago");
});

test("a failing lead source is urgent, and says why it matters", () => {
  const n = byFp("lead-source-failing")[0];
  assert.ok(n);
  assert.equal(n.urgency, 3);
  assert.ok(n.body.includes("looks calm rather than empty"));
});

test("wins are raised too", () => {
  const n = byFp("leads-won")[0];
  assert.ok(n, "a lead won 2 days ago should be a win note");
  assert.equal(n.category, "win");
});

test("fingerprints hold steady when only the counts change", () => {
  const more = {
    ...SNAP,
    tasks: [...SNAP.tasks, { id: "t9", title: "Another late one", client_id: "c1", status: "todo", due_date: ago(1).slice(0, 10), assigned_to: null, priority: "low" }],
  };
  const before = byFp("tasks-late")[0].fingerprint;
  const after = computeNotes(more, NOW).filter((n) => n.fingerprint.startsWith("tasks-late"))[0].fingerprint;
  assert.equal(before, after, "the same problem with a bigger number must be the same note");
});

test("an empty system produces no notes at all", () => {
  const empty = { role: "owner", userId: "u", errors: {}, team: [], clients: [], tasks: [], weekly: [], leads: [], leadActivity: [], leadSources: [], tickets: [], emails: [], reminders: [], sites: [], brain: [], memory: [], notes: [] };
  assert.deepEqual(computeNotes(empty, NOW), []);
});

test("notes come back most urgent first", () => {
  for (let i = 1; i < NOTES.length; i += 1) {
    assert.ok(NOTES[i - 1].urgency >= NOTES[i].urgency, "urgency must not go up as you read down");
  }
});

test("the staleness numbers match the Work page's", () => {
  /* These two lists disagreeing is how one screen says a lead is fine while
   * another says it is overdue.
   *
   * REPINNED 2 Sep 2026, and made stronger. It compared this list against a
   * HAND-COPIED LITERAL, so when the Meeting stage was split and both copies
   * were updated, the test failed against its own third copy — three lists to
   * keep in step instead of two. It now reads the Work page's own map out of
   * src/lib/data.js and compares the two directly, which is the rule the
   * comment always claimed to enforce. */
  const src = readFileSync(new URL("../../src/lib/data.js", import.meta.url), "utf8");
  const block = /const STALE_AFTER_DAYS = \{([\s\S]*?)\};/.exec(src);
  assert.ok(block, "could not find STALE_AFTER_DAYS in src/lib/data.js");
  const theirs = Object.fromEntries(
    [...block[1].matchAll(/([a-z_]+):\s*([0-9.]+)/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(THRESHOLDS.leadStale, theirs);
  /* And both halves of the 0030 split have to be in it, or a meeting drops out
   * of the call queue's ranking entirely. */
  for (const s of ["meeting_booked", "meeting_complete"]) {
    assert.ok(theirs[s] !== undefined, `${s} has no staleness limit`);
  }
});

/* ================================================================== */
/* 4. The AI rewrite guard                                             */
/* ================================================================== */

test("a rewrite that changes a number is rejected", () => {
  const counted = { title: "3 leads owed a contact", body: "The coldest is 9 days old." };
  const good = { title: "3 leads need a call", body: "The coldest has waited 9 days." };
  const bad = { title: "4 leads need a call", body: "The coldest has waited 9 days." };
  assert.equal(rewriteIsFaithful(counted, good), true);
  assert.equal(rewriteIsFaithful(counted, bad), false);
});

test("a rewrite that adds a number it was never given is rejected", () => {
  const counted = { title: "Tasks are late", body: "Two of them." };
  const bad = { title: "Tasks are late", body: "Two of them, 5 days over." };
  assert.equal(rewriteIsFaithful(counted, bad), false);
});

test("numbers are compared as a set, so reordering a sentence is allowed", () => {
  assert.deepEqual(numbersIn("9 days, 3 leads"), numbersIn("3 leads, 9 days"));
});

test("a partial rewrite is thrown away whole, never merged", () => {
  const text = "T: One\nB: First body\n---\nnot a note at all";
  assert.equal(parseRewrite(text, 2), null, "2 expected, 1 parsed → drop it all");
});

test("a well-formed rewrite parses back into the right count", () => {
  const text = "T: One\nB: First body.\n---\nT: Two\nB: Second body.";
  const out = parseRewrite(text, 2);
  assert.equal(out.length, 2);
  assert.equal(out[1].title, "Two");
});

/* ================================================================== */
/* 5. Lead intake                                                      */
/* ================================================================== */

test("the dedupe key prefers email, then phone, then domain, then company+city", () => {
  assert.equal(dedupeKey({ email: "A@B.com", phone: "555", domain: "x.com" }), "e:a@b.com");
  assert.equal(dedupeKey({ phone: "+1 (850) 555-0100", domain: "x.com" }), "p:8505550100");
  assert.equal(dedupeKey({ domain: "HTTPS://WWW.X.com/about?q=1" }), "d:x.com");
  assert.equal(dedupeKey({ company: "Chen  Dental!", city: "Destin" }), "c:chendental:destin");
});

test("a row with nothing solid gets no key, and no-key never matches no-key", () => {
  assert.equal(dedupeKey({ name: "Bob" }), null);
  const { kept, dupes } = dedupeWithin([{ name: "Bob" }, { name: "Bob" }]);
  assert.equal(kept.length, 2, "two unmatched rows must both survive");
  assert.equal(dupes.length, 0);
});

test("the same lead twice in one file is caught, and the first is kept", () => {
  const { kept, dupes } = dedupeWithin([
    { name: "A", email: "same@x.com" },
    { name: "B", email: "SAME@X.com" },
    { name: "C", email: "other@x.com" },
  ]);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].name, "A");
  assert.equal(dupes[0].matchesIndex, 0);
});

test("rows already in the pipeline are split out, not silently added", () => {
  const existing = new Set(["e:known@x.com"]);
  const { fresh, already } = splitAgainstExisting(
    [{ email: "known@x.com" }, { email: "new@x.com" }], existing);
  assert.equal(fresh.length, 1);
  assert.equal(already.length, 1);
});

test("a short phone number is not a phone number", () => {
  assert.equal(cleanPhone("555-0100"), null);
  assert.equal(cleanPhone("(850) 555-0100 ext 4"), "8505550100", "an extension must not change the number");
  assert.equal(cleanPhone("18505550100"), "8505550100", "a leading country code is dropped");
  assert.equal(cleanPhone("+1 850 555 0100"), "8505550100");
});

test("a bad email is dropped rather than saved as a bad email", () => {
  assert.equal(cleanEmail("not an email"), null);
  assert.equal(cleanEmail("a@b"), null);
  assert.equal(cleanEmail(" Sarah@Chen.com "), "sarah@chen.com");
});

test("a domain with no dot is not a domain", () => {
  assert.equal(cleanDomain("localhost"), null);
  assert.equal(cleanDomain("chendental.com/team"), "chendental.com");
});

test("a row with no name, company or email is unusable and is dropped", () => {
  assert.equal(toLeadRow({ city: "Destin", phone: "8505550100" }), null);
  assert.ok(toLeadRow({ company: "Chen Dental" }));
});

test("the phone is stored as written, so a rep can read it back", () => {
  const row = toLeadRow({ company: "X", phone: "(850) 555-0100" });
  assert.equal(row.phone, "(850) 555-0100");
});

test("real spreadsheet column names are recognised", () => {
  assert.equal(guessColumn("Business Name"), "company");
  assert.equal(guessColumn("Work Phone"), "phone");
  assert.equal(guessColumn("E-Mail"), "email");
  assert.equal(guessColumn("Web Site"), "domain");
  assert.equal(guessColumn("Industry"), "vertical");
  assert.equal(guessColumn("Squrfle"), "");
  assert.equal(guessColumn(""), "");
});

test("round-robin hands leads out evenly and picks up where it left off", () => {
  assert.deepEqual(assignRoundRobin([1, 2, 3, 4], ["a", "b"]), ["a", "b", "a", "b"]);
  assert.deepEqual(assignRoundRobin([1, 2], ["a", "b"], 1), ["b", "a"]);
  assert.deepEqual(assignRoundRobin([1, 2], []), [null, null], "no reps means unclaimed, not a crash");
});

test("provider answers become lead rows without inventing fields", () => {
  const a = normalizeApollo({ first_name: "Sarah", last_name: "Chen", email: "s@chen.com", title: "Owner", organization: { name: "Chen Dental", primary_domain: "chendental.com", city: "Destin", state: "FL", industry: "dentistry" } });
  assert.equal(a.name, "Sarah Chen");
  assert.equal(a.company, "Chen Dental");
  assert.ok(a.notes.includes("Owner"));
  const p = normalizePlatform({ business_name: "Summit Roofing", website: "summit.com", locality: "Destin" });
  assert.equal(p.company, "Summit Roofing");
  assert.equal(p.city, "Destin");
  assert.equal(p.email, null, "a missing field stays missing");
});

/* ================================================================== */
/* 6. Reading a spreadsheet                                            */
/* ================================================================== */

test("quoted commas and newlines inside a cell survive", () => {
  const rows = parseDelimited('name,notes\n"Chen, Sarah","said ""yes""\nnext week"');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], "Chen, Sarah");
  assert.equal(rows[1][1], 'said "yes"\nnext week');
});

test("the separator is worked out, not assumed", () => {
  assert.equal(sniffDelimiter("a\tb\tc"), "\t");
  assert.equal(sniffDelimiter("a;b;c"), ";");
  assert.equal(sniffDelimiter("a,b,c"), ",");
  assert.equal(sniffDelimiter("just one column"), ",");
});

test("a separator inside quotes does not count when sniffing", () => {
  assert.equal(sniffDelimiter('"Chen, Sarah"\tChen Dental'), "\t");
});

test("trailing blank lines are dropped", () => {
  assert.equal(parseDelimited("a,b\n1,2\n\n\n").length, 2);
});

test("spreadsheet column letters convert past Z", () => {
  assert.equal(colToIndex("A1"), 0);
  assert.equal(colToIndex("Z9"), 25);
  assert.equal(colToIndex("AA1"), 26);
  assert.equal(colToIndex("BC7"), 54);
});

/* ================================================================== */
/* 7. A real .xlsx, read end to end                                    */
/* ================================================================== */
/* The fixture is a genuine Excel file written by Excel's own format, with
 * the four things that break naive readers: a shared-string table, an empty
 * column in the MIDDLE (Excel omits empty cells entirely, which shifts every
 * later column left if the reader does not fill the gaps), a fully blank row,
 * and a cell containing a quoted comma. Two tabs, so the "which tab did you
 * read" path is exercised too. */

const fixture = new URL("./fixtures/leads-sample.xlsx", import.meta.url);

if (typeof DecompressionStream !== "function") {
  results.push("  skip xlsx tests — this runtime has no DecompressionStream");
} else {
  const buf = readFileSync(fixture);
  const sheet = await parseXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  test("a real .xlsx is read without a library", () => {
    assert.equal(sheet.rows.length, 6, "header + 5 data rows");
    assert.equal(sheet.sheetCount, 2);
    assert.equal(sheet.sheetName, "Leads Aug");
  });

  test("an empty column in the middle does not shift the columns after it", () => {
    // Column D is blank in every row. If the gap-filling is removed, "E-Mail"
    // lands in D and every header after it moves one place left.
    assert.equal(sheet.rows[0][3], "", "column D is the empty one");
    assert.equal(sheet.rows[0][4], "E-Mail");
    assert.equal(sheet.rows[1][4], "sarah@chendental.com");
    assert.equal(sheet.rows[1][7], "FL", "the state must still be in column H");
  });

  test("a cell with a quoted comma survives the shared-string table", () => {
    assert.equal(sheet.rows[1][8], 'Said "call back, comma, ok"');
  });

  test("real Excel headers map themselves", () => {
    const mapping = sheet.rows[0].map(guessColumn);
    assert.deepEqual(mapping, ["company", "name", "phone", "", "email", "domain", "city", "state", "notes"]);
  });

  test("the whole import path turns that file into three real leads", () => {
    const mapping = sheet.rows[0].map(guessColumn);
    const leads = [];
    for (const r of sheet.rows.slice(1)) {
      const raw = {};
      mapping.forEach((f, i) => { if (f && String(r[i] ?? "").trim()) raw[f] = String(r[i]).trim(); });
      const l = toLeadRow(raw, { source: "sheet" });
      if (l) leads.push(l);
    }
    assert.equal(leads.length, 4, "the blank row is dropped");
    const { kept, dupes } = dedupeWithin(leads);
    assert.equal(dupes.length, 1, "the same dentist twice, once in capitals, is one duplicate");
    assert.equal(kept.length, 3);
    assert.equal(dedupeKey(kept[0]), "e:sarah@chendental.com");
    assert.equal(dedupeKey(kept[1]), "p:8505550199");
    assert.equal(dedupeKey(kept[2]), "c:obriensonsllc:destin", "a lead with no contact still gets in");
  });
}

/* ================================================================== */
/* 8. THE SCHEMA IS READ FROM THE MIGRATIONS, NOT REMEMBERED           */
/* ================================================================== */
/* The most expensive bug in this build was not a hard one. Three files wrote
 * `title` to a table whose column is `name`, `title` to one whose column is
 * `body`, and read a `summary` that has never existed. The result: an AI that
 * saw a task list with no task names in it, a "remind me" button that could
 * never save, and a weekly log that always read as blank — all of it stated
 * with complete confidence.
 *
 * The tests did not catch it because the FIXTURES had invented the same names.
 * A test that agrees with the code is not a test. So these read the actual
 * CREATE TABLE statements out of supabase/migrations and check every column
 * the code touches against them. Add a column reference anywhere and this is
 * what tells you whether it exists. */

const migrations = ["0001_admin_init", "0002_work_page", "0003_inbox", "0004_client_page",
  "0005_platform_accounts", "0006_brain_notes_leads"]
  .map((f) => readFileSync(new URL(`../../supabase/migrations/${f}.sql`, import.meta.url), "utf8"))
  .join("\n");

/** Column names declared for a table, from its create-table block plus any
 * later `alter table ... add column`. */
function columnsOf(table) {
  const cols = new Set();
  const block = new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(migrations);
  if (block) {
    for (const line of block[1].split("\n")) {
      const m = /^\s{2}([a-z_]+)\s+(uuid|text|int|bigint|boolean|timestamptz|date|jsonb|numeric|uuid\[\])/.exec(line);
      if (m) cols.add(m[1]);
    }
  }
  const alters = migrations.matchAll(
    new RegExp(`alter table public\\.${table}\\s+add column if not exists ([a-z_]+)`, "g"));
  for (const a of alters) cols.add(a[1]);
  return cols;
}

/* Every column the new code reads or writes, by table. Keep this list honest:
 * it is the thing standing between a typo and an AI that confidently reports
 * nothing. */
const COLUMNS_USED = {
  admin_tasks: ["id", "client_id", "name", "status", "category", "priority", "phase",
    "assigned_to", "due_date", "latest_report", "created_at", "updated_at"],
  admin_reminders: ["id", "owner_id", "body", "due_at", "done_at", "link_type", "link_id", "created_by"],
  admin_weekly_log: ["id", "client_id", "week_no", "week_status", "what_we_did", "what_moved", "whats_next", "created_at"],
  admin_leads: ["id", "name", "company", "domain", "email", "phone", "city", "state", "vertical",
    "source", "stage", "owner_id", "score", "notes", "became_customer", "created_at", "updated_at",
    "last_activity_at", "source_id", "raw", "dedupe_key", "last_import_at"],
  admin_lead_activity: ["id", "lead_id", "actor", "type", "outcome", "body", "created_at"],
  admin_clients: ["id", "name", "domain", "status", "stage", "vertical", "notes"],
  admin_email_threads: ["id", "mailbox", "thread_id", "status", "client_id", "assigned_to",
    "priority", "subject", "from_name", "from_email", "last_message_at", "notes",
    "status_changed_at", "status_changed_by"],
  admin_tickets: ["id", "subject", "status", "priority", "requester_name", "requester_email",
    "assigned_to", "updated_at"],
  admin_client_sites: ["id", "client_id", "label", "live", "notes", "created_at"],
  admin_brain: ["id", "kind", "title", "body", "enabled", "created_at"],
  admin_brain_memory: ["id", "kind", "subject", "body", "origin", "origin_ref", "client_id",
    "lead_id", "weight", "confirmed", "confirmed_by", "last_used_at", "use_count", "active",
    "created_by", "created_at", "updated_at"],
  admin_ai_notes: ["id", "category", "title", "body", "evidence", "written_by", "client_id",
    "lead_id", "owner_id", "urgency", "status", "status_changed_at", "status_changed_by",
    "fingerprint", "linked_task_id", "linked_reminder_id", "generated_at", "updated_at"],
  admin_lead_sources: ["id", "label", "kind", "query", "provider", "auto_daily", "daily_cap",
    "assign_to", "last_run_at", "last_run_found", "last_run_new", "last_run_error", "active", "created_by"],
  admin_assistant_log: ["id", "actor", "tool", "args", "result", "ok", "target_table", "target_id", "screen"],
  admin_usage_events: ["id", "ts", "source", "model", "input_tokens", "output_tokens", "cost_usd", "meta"],
  admin_users: ["user_id", "email", "full_name", "role", "active"],
};

for (const [table, used] of Object.entries(COLUMNS_USED)) {
  test(`every column the code uses on ${table} exists in the migrations`, () => {
    const declared = columnsOf(table);
    assert.ok(declared.size > 0, `could not read the columns of ${table} out of the migrations`);
    const missing = used.filter((c) => !declared.has(c));
    assert.deepEqual(missing, [], `${table} has no column(s): ${missing.join(", ")}`);
  });
}

test("no file writes a column name the tables do not have", () => {
  /* The specific three that were wrong, checked by name so a revert is loud.
   * `title` is a real column on admin_brain and admin_ai_notes, so this looks
   * for it only where it would be wrong. */
  const files = ["lib/brain-context.js", "lib/notes-engine.js", "lib/assistant-tools.js",
    "api/notes-generate.js", "src/components/admin/NotesPage.jsx"]
    .map((f) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8")).join("\n");
  /* Narrow on purpose. `title` IS a real column on admin_brain and
   * admin_ai_notes, and `r.title` is a perfectly good read of a brain row — so
   * a blunt search for "title" reports the innocent along with the guilty and
   * gets switched off. These look only where the name would be wrong. */
  assert.ok(!/\bt\.title\b/.test(files), "admin_tasks has `name`, not `title`");
  assert.ok(!/\bw\.summary\b/.test(files), "admin_weekly_log has what_we_did / what_moved / whats_next");
  assert.ok(!/admin_tasks[\s\S]{0,200}?\btitle\.ilike\b/.test(files), "task search must filter on `name`");
  assert.ok(!/from\("admin_reminders"\)[\s\S]{0,200}?\btitle:/.test(files),
    "an admin_reminders write must set `body`, not `title`");
  assert.ok(!/upsertReminder\(\{[\s\S]{0,300}?\btitle:/.test(files),
    "upsertReminder writes admin_reminders — the column is `body`");
  assert.ok(!/upsertTask\(\{[\s\S]{0,300}?\btitle:/.test(files),
    "upsertTask writes admin_tasks — the column is `name`");
  assert.ok(/from\("admin_reminders"\)[\s\S]{0,400}?\bbody:/.test(files),
    "the assistant's create_reminder must actually write body");
});

test("a reminder is allowed to point at a note", () => {
  // The "Remind me" button on a note sets link_type = 'note'. The original
  // constraint listed client/lead/task/ticket only, so it failed every time.
  assert.ok(/link_type in \('client','lead','task','ticket','note'\)/.test(migrations));
});

/* ================================================================== */

console.log(results.join("\n"));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
