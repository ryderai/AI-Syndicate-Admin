/* Tests for the Home Services landing-page build — 14 Sep 2026.
 *
 * Run with:  bash tests/home-services/run.sh
 *
 * No database, no keys, no network. Everything the page counts with lives in
 * lib/home-services.js and takes data in and gives data back, which is what
 * makes a screen about six pages that do not exist yet testable at all.
 *
 * The clock is fixed where it matters. A test that starts failing at midnight
 * is the kind of bug a suite is meant to catch rather than cause.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PAGE_SLUGS, PAGE_LABELS, HS_EVENTS, DEVICES, FUNNEL_STEPS,
  isPageSlug, isHsEvent, isDevice,
  teamDayStartMs, teamDayEndMs, teamToday, addTeamDays, defaultRange, inRange,
  normaliseEmail, digitsOnly, hostFromWebsite, clean,
  rate, summarise, comparePages, funnelFor, ctaCounts, trafficBy, sortRows, captureNote,
} from "../../lib/home-services.js";
import { allowHit, _resetRateLimit, allowedOrigins, MAX_BODY_BYTES } from "../../lib/hs-http.js";

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed += 1; results.push(`  ok   ${name}`); }
  catch (err) { failed += 1; results.push(`  FAIL ${name}\n       ${err.message}`); }
}

const src = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const MIG = src("supabase/migrations/0035_home_services_pages.sql");
/* Comments out before anything is read from the SQL. A value named in a
 * comment is not a value the constraint allows — the trap tests/db-columns
 * hit on its first run, and this file quotes both lists in its own prose. */
const MIG_CODE = MIG.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
/* 0036 re-states both page_slug constraints with the restaurants page added.
 * The page list is read from the NEWEST migration that states it. */
const MIG36 = src("supabase/migrations/0037_electrical_page_and_scan_events.sql");   // newest statement of the EVENT list
const MIG36_CODE = MIG36.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
/* 0038 re-states both page_slug constraints with the home-management page added.
 * It does NOT touch the event list, so events are still read from 0037 above.
 * When the next migration states either list, point the matching constant here
 * at it — that is the whole job of these two lines. */
const MIG38 = src("supabase/migrations/0038_home_management_page_and_plan.sql");     // newest statement of the PAGE list
const MIG38_CODE = MIG38.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
const slugLists = (code) => [...code.matchAll(/page_slug\s+in\s*\(([^)]*)\)/g)]
  .map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));

/* ================================================================
 * 1. THE TWO COPIES OF EVERY LIST, COMPARED
 *
 * The event names and the page slugs exist twice: once as a check constraint
 * in the migration, once as an array in lib/home-services.js so the endpoint
 * can refuse a bad one with a readable message. CONTEXT §60: "two copies of a
 * rule need a test that compares them, not one that finds each."
 * ================================================================ */

function valuesOf(col) {
  const re = new RegExp(`${col}\\s+text\\s+not null\\s+check\\s*\\([\\s\\S]*?${col}\\s+in\\s*\\(([^)]*)\\)`, "m");
  const m = re.exec(MIG_CODE);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test("the migration's event list was read at all", () => {
  assert.ok((valuesOf("event") || []).length > 5);
});

test("HS_EVENTS matches the newest event constraint (0037) exactly, in both directions", () => {
  const m = /event\s+in\s*\(([^)]*)\)/.exec(MIG36_CODE);
  assert.ok(m, "0037 states no event list");
  const sqlVals = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual([...sqlVals].sort(), [...HS_EVENTS].sort());
});

test("0037's event list is a superset of 0035's — no event was silently dropped", () => {
  const m = /event\s+in\s*\(([^)]*)\)/.exec(MIG36_CODE);
  const now = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  for (const e of valuesOf("event")) assert.ok(now.includes(e), `0037 dropped ${e}`);
});

test("PAGE_SLUGS matches the newest page_slug constraint (0038) on hs_page_events", () => {
  const lists = slugLists(MIG38_CODE);
  assert.ok(lists.length >= 1, "0038 states no page_slug list");
  assert.deepEqual([...lists[0]].sort(), [...PAGE_SLUGS].sort());
});

test("0038 is a superset of 0035 and 0037 — no page was silently dropped", () => {
  const now = slugLists(MIG38_CODE)[0];
  for (const s of valuesOf("page_slug")) assert.ok(now.includes(s), `0038 dropped ${s}`);
  for (const s of slugLists(MIG36_CODE)[0]) assert.ok(now.includes(s), `0038 dropped ${s}`);
});

test("hs_lead_sources allows the same pages as hs_page_events — the two constraints agree (0038)", () => {
  const all = slugLists(MIG38_CODE).map((l) => [...l].sort().join("|"));
  assert.equal(all.length, 2, "expected the slug list to appear on both tables");
  assert.equal(all[0], all[1]);
});

test("the device buckets match, and there is no fourth one", () => {
  const m = /device\s+text\s+check\s*\([\s\S]*?device\s+in\s*\(([^)]*)\)/.exec(MIG_CODE);
  assert.ok(m, "no device constraint found");
  assert.deepEqual([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort(), [...DEVICES].sort());
});

test("every funnel step names an event that really exists", () => {
  for (const s of FUNNEL_STEPS) assert.ok(HS_EVENTS.includes(s.event), s.event);
});

test("every page slug has a plain-English label", () => {
  for (const s of PAGE_SLUGS) assert.ok(PAGE_LABELS[s] && PAGE_LABELS[s] !== s, s);
});

test("the validators agree with their lists", () => {
  assert.equal(isPageSlug("lawn-care"), true);
  assert.equal(isPageSlug("roofing"), false);
  assert.equal(isHsEvent("scan_complete"), true);
  assert.equal(isHsEvent("scan_completed"), false);
  assert.equal(isDevice("mobile"), true);
  assert.equal(isDevice("watch"), false);
  assert.equal(isPageSlug(null), false);
});

/* ================================================================
 * 2. WHAT THE CAPTURE ENDPOINT WRITES IS LEGAL TODAY
 *
 * Read out of the LIVE constraints, not out of the 0001 originals. Both have
 * been replaced more than once — `stage` four times — and a value that was
 * legal in August is not proof of anything in September.
 * ================================================================ */

const MIGDIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations");
/* EVERY migration, comments stripped, in file order — so "the newest
 * constraint" below really is the newest. Reading only 0001 would report the
 * stage list as it was in August, which four later migrations have replaced. */
const ALL_SQL = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(join(MIGDIR, f), "utf8")).join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** The values the NEWEST admin_leads constraint of that name allows.
 *
 * NAMED, not searched for by column. The first version of this looked for any
 * `source in (…)` anywhere in the migrations and found admin_notes' one —
 * typed/chat/import/calendar — and reported that 'inbound' was illegal. Two
 * tables can have a column of the same name, and a guard that does not say
 * which table it is reading is reading whichever one it happens to hit last. */
function leadConstraint(name) {
  const all = [...ALL_SQL.matchAll(
    new RegExp(`add constraint admin_leads_${name}_check[\\s\\S]{0,80}?${name} in \\(([\\s\\S]*?)\\)\\s*\\)`, "g"),
  )];
  const last = all[all.length - 1];
  return last ? [...last[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
}

test("`source: 'inbound'` is still legal on admin_leads", () => {
  const vals = leadConstraint("source");
  assert.ok(vals, "no admin_leads_source_check found");
  assert.ok(vals.includes("inbound"), vals.join(","));
});

test("`stage: 'new'` is still legal on admin_leads, on the NEWEST constraint", () => {
  const vals = leadConstraint("stage");
  assert.ok(vals, "no admin_leads_stage_check found");
  assert.ok(vals.includes("new"), vals.join(","));
  /* The list really is the current one — 'meeting' was made unwritable by
   * 0030, so a reader that had picked up an older constraint would still
   * carry it. */
  assert.equal(vals.includes("meeting"), false, vals.join(","));
  assert.ok(vals.includes("meeting_booked"), vals.join(","));
});

test("admin_lead_activity.actor is still NOT NULL — the reason no timeline row is written", () => {
  assert.match(ALL_SQL, /actor uuid not null references auth\.users/);
});

test("api/hs-lead.js does NOT write to admin_lead_activity", () => {
  const code = src("api/hs-lead.js").replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.equal(/admin_lead_activity/.test(code), false,
    "a timeline row cannot be written honestly from the service role — see CONTEXT §61");
});

/* ================================================================
 * 3. THE DOOR — RLS, grants, and what the browser may do
 * ================================================================ */

test("both tables have row level security switched on", () => {
  assert.match(MIG_CODE, /alter table public\.hs_page_events enable row level security/);
  assert.match(MIG_CODE, /alter table public\.hs_lead_sources enable row level security/);
});

test("the browser gets SELECT and nothing else on either table", () => {
  const grants = [...MIG_CODE.matchAll(/grant ([^;]+) on public\.(hs_\w+) to (\w+)/g)];
  assert.equal(grants.length, 2, grants.map((g) => g[0]).join(" | "));
  for (const g of grants) {
    assert.equal(g[1].trim(), "select", `${g[2]} was granted "${g[1].trim()}"`);
    assert.equal(g[3], "authenticated");
  }
  assert.equal(/grant[^;]*insert[^;]*on public\.hs_/.test(MIG_CODE), false);
  assert.equal(/grant[^;]*update[^;]*on public\.hs_/.test(MIG_CODE), false);
  assert.equal(/to anon/.test(MIG_CODE), false);
});

test("there is no insert or update POLICY on either table either", () => {
  const pols = [...MIG_CODE.matchAll(/create policy "([^"]+)" on public\.(hs_\w+)\s*\n?\s*for (\w+)/g)];
  assert.ok(pols.length >= 4, `only found ${pols.length} policies`);
  for (const p of pols) {
    assert.ok(["select", "delete"].includes(p[3]), `"${p[1]}" is FOR ${p[3]}`);
  }
});

test("reading copies admin_leads' gate — members read, admins delete", () => {
  const sel = [...MIG_CODE.matchAll(/for select using \(([^)]+\))\)/g)].map((m) => m[1]);
  assert.ok(sel.length >= 2);
  for (const s of sel) assert.match(s, /admin_is_member/);
  const del = [...MIG_CODE.matchAll(/for delete using \(([^)]+\))\)/g)].map((m) => m[1]);
  assert.ok(del.length >= 2);
  for (const d of del) assert.match(d, /admin_is_admin/);
});

test("the indexes the page's own reads need exist", () => {
  for (const idx of [
    /hs_page_events \(page_slug, created_at desc\)/,
    /hs_page_events \(session_id\)/,
    /hs_page_events \(event, created_at desc\)/,
    /hs_page_events \(lead_id\) where lead_id is not null/,
  ]) assert.match(MIG_CODE, idx);
});

test("a deleted lead takes its source row with it, but not its events", () => {
  assert.match(MIG_CODE, /lead_id uuid primary key references public\.admin_leads on delete cascade/);
  assert.match(MIG_CODE, /lead_id uuid references public\.admin_leads on delete set null/);
});

/* ================================================================
 * 4. CHICAGO DAYS
 *
 * The whole reason this section exists: `new Date("2026-08-01")` is midnight
 * UTC, which is 7pm on 31 July here. A range built that way loses the last
 * seven hours of every day in it and files an evening's visits under the day
 * before. These check the answer against the real offsets, on both sides of
 * both clock changes.
 * ================================================================ */

const iso = (ms) => new Date(ms).toISOString();

test("a summer day starts at 05:00 UTC (Chicago is UTC-5 in July)", () => {
  assert.equal(iso(teamDayStartMs("2026-08-01")), "2026-08-01T05:00:00.000Z");
});

test("a winter day starts at 06:00 UTC (Chicago is UTC-6 in January)", () => {
  assert.equal(iso(teamDayStartMs("2026-01-15")), "2026-01-15T06:00:00.000Z");
});

test("the day the clocks go forward is 23 hours long, not 24", () => {
  /* 8 Mar 2026, 2am. A start + 86,400,000ms end would be an hour past
   * midnight and would count an hour of the next day into this one. */
  const start = teamDayStartMs("2026-03-08");
  const end = teamDayEndMs("2026-03-08");
  assert.equal(iso(start), "2026-03-08T06:00:00.000Z");
  assert.equal(iso(end), "2026-03-09T05:00:00.000Z");
  assert.equal((end - start) / 3600000, 23);
});

test("the day the clocks go back is 25 hours long", () => {
  const start = teamDayStartMs("2026-11-01");
  const end = teamDayEndMs("2026-11-01");
  assert.equal((end - start) / 3600000, 25);
});

test("an ordinary day is exactly 24 hours", () => {
  assert.equal((teamDayEndMs("2026-09-14") - teamDayStartMs("2026-09-14")) / 3600000, 24);
});

test("teamToday reads an evening in Chicago as TODAY, not tomorrow", () => {
  /* 11pm on 14 Sep in Chicago is 04:00 on 15 Sep in UTC. */
  assert.equal(teamToday(Date.parse("2026-09-15T04:00:00Z")), "2026-09-14");
});

test("addTeamDays walks days, including across a clock change", () => {
  assert.equal(addTeamDays("2026-09-14", 1), "2026-09-15");
  assert.equal(addTeamDays("2026-09-01", -1), "2026-08-31");
  assert.equal(addTeamDays("2026-03-07", 1), "2026-03-08");
  assert.equal(addTeamDays("2026-11-01", 1), "2026-11-02");
});

test("the default range is 30 Chicago days ending today, as strings", () => {
  const r = defaultRange(Date.parse("2026-09-14T18:00:00Z"));
  assert.equal(r.to, "2026-09-14");
  assert.equal(r.from, "2026-08-16");
  assert.equal(typeof r.from, "string");
});

test("a bad day string is NaN, never a silent 1970", () => {
  assert.ok(Number.isNaN(teamDayStartMs("not a date")));
  assert.ok(Number.isNaN(teamDayStartMs("")));
  assert.ok(Number.isNaN(teamDayStartMs(null)));
});

test("inRange includes the whole of the last day", () => {
  const late = { created_at: "2026-09-14T23:59:00-05:00" };
  const next = { created_at: "2026-09-15T00:30:00-05:00" };
  assert.equal(inRange(late, "2026-09-01", "2026-09-14"), true);
  assert.equal(inRange(next, "2026-09-01", "2026-09-14"), false);
});

test("inRange includes the very start of the first day", () => {
  assert.equal(inRange({ created_at: "2026-09-01T00:00:00-05:00" }, "2026-09-01", "2026-09-14"), true);
  assert.equal(inRange({ created_at: "2026-08-31T23:30:00-05:00" }, "2026-09-01", "2026-09-14"), false);
});

/* ================================================================
 * 5. CLEANING WHAT A STRANGER TYPED
 * ================================================================ */

test("an email is lower-cased and trimmed", () => {
  assert.equal(normaliseEmail("  Bob@Acme.COM "), "bob@acme.com");
});

test("something that is not an email is null, not stored", () => {
  for (const v of ["yes please", "bob@acme", "@acme.com", "", null, undefined, "a b@c.com"]) {
    assert.equal(normaliseEmail(v), null, String(v));
  }
});

test("a phone becomes digits, keeping a leading 1", () => {
  assert.equal(digitsOnly("(512) 555-0100 ext 4"), "51255501004");
  assert.equal(digitsOnly("+1 512 555 0100"), "15125550100");
  assert.equal(digitsOnly("call me"), null);
  assert.equal(digitsOnly(null), null);
});

test("a website becomes a bare host", () => {
  assert.equal(hostFromWebsite("https://WWW.Acme.com/quote?a=1"), "acme.com");
  assert.equal(hostFromWebsite("acme.co.uk"), "acme.co.uk");
  assert.equal(hostFromWebsite("no website"), null);
  assert.equal(hostFromWebsite(""), null);
});

test("free text is trimmed, capped and never an empty string", () => {
  assert.equal(clean("  hi  "), "hi");
  assert.equal(clean("   "), null);
  assert.equal(clean("x".repeat(500), 10), "xxxxxxxxxx");
});

/* ================================================================
 * 6. THE HONESTY RULE, AS ARITHMETIC
 *
 * This is the section that matters. Every percentage on the page comes
 * through rate(), and rate() must answer null — not zero — when there is
 * nothing to divide by. "Nobody came" and "everybody who came left" are
 * different facts about a business.
 * ================================================================ */

test("a rate with no denominator is null, NEVER zero", () => {
  assert.equal(rate(0, 0), null);
  assert.equal(rate(5, 0), null);
  assert.equal(rate(0, 10), 0, "zero out of ten IS zero — that one is measured");
  assert.equal(rate(1, 4), 25);
  assert.equal(rate(null, 10), null);
  assert.equal(rate(3, null), null);
});

test("a rate of zero and a rate of nothing are different values", () => {
  assert.notEqual(rate(0, 10), rate(0, 0));
});

/* A small, explicit set of rows. Two visits to the lawn page — one that scans
 * and pays, one that bounces — and one visit to the painting page. */
const EV = [
  { page_slug: "lawn-care", event: "view", session_id: "s1", utm_source: "google", created_at: "2026-09-10T15:00:00Z" },
  { page_slug: "lawn-care", event: "scroll_50", session_id: "s1", created_at: "2026-09-10T15:01:00Z" },
  { page_slug: "lawn-care", event: "scroll_50", session_id: "s1", created_at: "2026-09-10T15:02:00Z" },
  { page_slug: "lawn-care", event: "scan_start", session_id: "s1", created_at: "2026-09-10T15:03:00Z" },
  { page_slug: "lawn-care", event: "scan_complete", session_id: "s1", created_at: "2026-09-10T15:05:00Z" },
  { page_slug: "lawn-care", event: "checkout_open", session_id: "s1", created_at: "2026-09-10T15:06:00Z" },
  { page_slug: "lawn-care", event: "checkout_paid", session_id: "s1", created_at: "2026-09-10T15:07:00Z" },
  { page_slug: "lawn-care", event: "cta_click", cta: "hero-primary", session_id: "s1", created_at: "2026-09-10T15:00:30Z" },
  { page_slug: "lawn-care", event: "view", session_id: "s2", utm_source: null, created_at: "2026-09-11T15:00:00Z" },
  { page_slug: "lawn-care", event: "cta_click", cta: null, session_id: "s2", created_at: "2026-09-11T15:00:10Z" },
  { page_slug: "painting", event: "view", session_id: "s3", utm_source: "google", created_at: "2026-09-12T15:00:00Z" },
  { page_slug: "painting", event: "scan_start", session_id: "s3", created_at: "2026-09-12T15:01:00Z" },
];
const LS = [
  { lead_id: "L1", page_slug: "lawn-care", session_id: "s1", reached_checkout: true, paid: true, converted_at: "2026-09-10T15:06:30Z" },
];

test("summarise counts rows, not guesses", () => {
  const s = summarise(EV, LS);
  assert.equal(s.views, 3);
  assert.equal(s.sessions, 3);
  assert.equal(s.scanStarts, 2);
  assert.equal(s.scansDone, 1);
  assert.equal(s.checkoutOpens, 1);
  assert.equal(s.leads, 1);
  assert.equal(s.purchases, 1);
});

test("the two derived rates are leads and purchases over UNIQUE visits", () => {
  const s = summarise(EV, LS);
  assert.equal(Math.round(s.leadRate), 33);
  assert.equal(Math.round(s.buyRate), 33);
});

test("with no rows at all, every rate is null and every count is zero", () => {
  const s = summarise([], []);
  assert.equal(s.views, 0);
  assert.equal(s.leadRate, null);
  assert.equal(s.buyRate, null);
});

test("captureNote carries the quick GEO Score the visitor saw, and only a real one", () => {
  assert.match(captureNote({ pageSlug: "electrical", kind: "free_check", score: 42 }), /free GEO Score on the page: 42\/100/);
  assert.doesNotMatch(captureNote({ pageSlug: "electrical", kind: "free_check", score: null }), /GEO Score/);
  assert.doesNotMatch(captureNote({ pageSlug: "electrical", kind: "free_check" }), /GEO Score/);
});

/* Two regressions found on the live console, 16 Sep 2026, pinned by reading source. */
test("listHsLeadSources orders on lead_id — the table has no id column", () => {
  const data = src("src/lib/data.js");
  const fn = data.slice(data.indexOf("export async function listHsLeadSources"), data.indexOf("export async function listLeadsByIds"));
  assert.match(fn, /idColumn:\s*"lead_id"/);
  assert.match(src("lib/paging.js"), /idColumn = "id"/);
});

test("hs-lead reads the utm tags under the names the page sends (utm_source, …)", () => {
  const api = src("api/hs-lead.js");
  assert.match(api, /rawUtm\.utm_source/);
  assert.match(api, /rawUtm\.utm_campaign/);
});

test("comparePages returns every page in PAGE_SLUGS, even ones nobody has visited", () => {
  const rows = comparePages(EV, LS);
  assert.equal(rows.length, PAGE_SLUGS.length);   // 8 since 0037 added electrical
  const pool = rows.find((r) => r.slug === "pool-cleaning");
  assert.equal(pool.visits, 0);
  assert.equal(pool.leadPct, null, "a page with no visits has no conversion rate — not 0%");
});

test("one page's numbers are its own", () => {
  const rows = comparePages(EV, LS);
  const lawn = rows.find((r) => r.slug === "lawn-care");
  const paint = rows.find((r) => r.slug === "painting");
  assert.equal(lawn.visits, 2);
  assert.equal(lawn.sessions, 2);
  assert.equal(lawn.leads, 1);
  assert.equal(lawn.purchases, 1);
  assert.equal(lawn.leadPct, 50);
  assert.equal(lawn.paidPct, 50);
  assert.equal(paint.visits, 1);
  assert.equal(paint.scanStartPct, 100);
  assert.equal(paint.leadPct, 0, "one visitor, no lead, IS zero — that is measured");
  assert.equal(paint.purchases, 0);
});

test("the funnel counts VISITS, so one person scrolling twice is not 200%", () => {
  const f = funnelFor(EV, "lawn-care");
  const step = (e) => f.find((x) => x.event === e);
  assert.equal(step("view").sessions, 2);
  assert.equal(step("scroll_50").sessions, 1, "s1 fired scroll_50 twice; that is one visit");
  assert.ok(step("scroll_50").ofTop <= 100);
});

test("the funnel's drop-off is a share of the step before it", () => {
  const f = funnelFor(EV, "lawn-care");
  assert.equal(f[0].drop, null, "nothing comes before the first step");
  assert.equal(f[1].drop, 50, "2 landed, 1 read half");
  assert.equal(f[2].drop, 0, "the one who read half also started the scan");
});

test("a funnel for a page nobody visited is all nulls, not all zeroes", () => {
  const f = funnelFor(EV, "pool-cleaning");
  assert.equal(f[0].sessions, 0);
  assert.equal(f[0].ofTop, null);
  for (const s of f.slice(1)) assert.equal(s.drop, null);
});

test("button clicks are grouped, and an unnamed one is kept and labelled", () => {
  const c = ctaCounts(EV);
  assert.equal(c.length, 2);
  const hero = c.find((x) => x.cta === "hero-primary");
  const unnamed = c.find((x) => x.cta === "(not named by the page)");
  assert.equal(hero.clicks, 1);
  assert.equal(hero.sessions, 1);
  assert.ok(unnamed, "a click with no cta name is kept, not dropped — a button we forgot to name is news");
});

test("traffic counts views only, and untagged traffic is 'direct / none'", () => {
  const t = trafficBy(EV, "utm_source");
  const google = t.find((x) => x.key === "google");
  const direct = t.find((x) => x.key === "direct / none");
  assert.equal(google.views, 2);
  assert.equal(direct.views, 1);
  assert.equal(t.reduce((a, x) => a + x.views, 0), 3, "every view is in exactly one bucket");
});

test("sorting puts 'not measured' last in BOTH directions", () => {
  const rows = [{ x: 5 }, { x: null }, { x: 1 }];
  assert.deepEqual(sortRows(rows, "x", "desc").map((r) => r.x), [5, 1, null]);
  assert.deepEqual(sortRows(rows, "x", "asc").map((r) => r.x), [1, 5, null]);
});

test("sorting by name is alphabetical, not numeric", () => {
  const rows = [{ label: "Painting" }, { label: "Lawn care" }];
  assert.deepEqual(sortRows(rows, "label", "asc").map((r) => r.label), ["Lawn care", "Painting"]);
});

test("the capture note names the page, what they did and the postcode", () => {
  const n = captureNote({
    pageSlug: "lawn-care", kind: "weekly mowing", reachedCheckout: true, paid: false,
    zip: "78704", bestTime: "mornings", at: Date.parse("2026-09-14T18:00:00Z"),
  });
  assert.match(n, /Lawn care/);
  assert.match(n, /weekly mowing/);
  assert.match(n, /opened the checkout but did not pay/);
  assert.match(n, /78704/, "admin_leads has no zip column, so the note is where it lives");
  assert.match(n, /2026-09-14/);
});

test("a paid capture says paid, not 'opened the checkout'", () => {
  const n = captureNote({ pageSlug: "painting", paid: true, reachedCheckout: true });
  assert.match(n, /paid on the page/);
  assert.equal(/did not pay/.test(n), false);
});

/* ================================================================
 * 7. THE PUBLIC DOOR
 * ================================================================ */

test("with HS_ALLOWED_ORIGINS unset, nobody is allowed", () => {
  const before = process.env.HS_ALLOWED_ORIGINS;
  delete process.env.HS_ALLOWED_ORIGINS;
  assert.deepEqual(allowedOrigins(), []);
  if (before !== undefined) process.env.HS_ALLOWED_ORIGINS = before;
});

test("the origin list is split, trimmed and stripped of trailing slashes", () => {
  const before = process.env.HS_ALLOWED_ORIGINS;
  process.env.HS_ALLOWED_ORIGINS = " https://a.com/ , https://b.com ,, ";
  assert.deepEqual(allowedOrigins(), ["https://a.com", "https://b.com"]);
  if (before === undefined) delete process.env.HS_ALLOWED_ORIGINS;
  else process.env.HS_ALLOWED_ORIGINS = before;
});

test("the rate limiter lets the limit through and then stops", () => {
  _resetRateLimit();
  let allowed = 0;
  for (let i = 0; i < 20; i += 1) if (allowHit("sess-a", 6, 60000, 1_000_000)) allowed += 1;
  assert.equal(allowed, 6);
});

test("the window really is a window — the next minute is allowed again", () => {
  _resetRateLimit();
  for (let i = 0; i < 6; i += 1) allowHit("sess-b", 6, 60000, 1_000_000);
  assert.equal(allowHit("sess-b", 6, 60000, 1_000_000), false);
  assert.equal(allowHit("sess-b", 6, 60000, 1_000_000 + 60_001), true);
});

test("two visitors do not share a bucket", () => {
  _resetRateLimit();
  for (let i = 0; i < 6; i += 1) allowHit("sess-c", 6, 60000, 1_000_000);
  assert.equal(allowHit("sess-c", 6, 60000, 1_000_000), false);
  assert.equal(allowHit("sess-d", 6, 60000, 1_000_000), true);
});

test("the body cap is small — a beacon is a few hundred bytes", () => {
  assert.ok(MAX_BODY_BYTES <= 16 * 1024 && MAX_BODY_BYTES >= 1024, String(MAX_BODY_BYTES));
});

test("neither public endpoint requires a console member — and nothing else drops that gate", () => {
  for (const f of ["api/hs-event.js", "api/hs-lead.js"]) {
    const code = src(f).replace(/\/\*[\s\S]*?\*\//g, " ");
    assert.equal(/requireMember/.test(code), false, `${f} cannot require a member — nobody is signed in`);
    assert.match(code, /applyCors/, `${f} must go through the origin allow-list instead`);
  }
});

test("the tracking beacon never answers 500 at a visitor", () => {
  const code = src("api/hs-event.js").replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.equal(/status\(500\)/.test(code), false);
  assert.match(code, /status\(204\)/);
});

test("a lost lead is NOT swallowed — that one does report failure", () => {
  const code = src("api/hs-lead.js").replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.match(code, /status\(500\)/);
  assert.match(code, /status\(503\)/);
});

test("the page never prints a bare zero where a rate could be null", () => {
  const page = src("src/components/admin/HomeServices.jsx");
  assert.match(page, /leadRate === null \? null/);
  assert.match(page, /buyRate === null \? null/);
  assert.match(page, /no events recorded yet/i);
});

test("the two new badges exist and say MEASURED and DERIVED", () => {
  const parts = src("src/components/admin/financeParts.jsx");
  assert.match(parts, /counted: \{ label: "MEASURED"/);
  assert.match(parts, /derived: \{ label: "DERIVED"/);
});

test("the page is wired into the sidebar and the router", () => {
  assert.match(src("src/components/admin/Sidebar.jsx"), /\["home-services", "Home Services"\]/);
  assert.match(src("src/components/AdminDashboard.jsx"), /case "home-services": return <HomeServices \/>/);
});

test("the page never hands a day string to new Date()", () => {
  const page = src("src/components/admin/HomeServices.jsx").replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.equal(/new Date\(\s*(from|to|range)/.test(page), false);
});

console.log(results.join("\n"));
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
