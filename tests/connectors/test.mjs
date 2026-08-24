/* The client connections, checked. Pure — no database, no keys, no network.
 *
 * WHAT THIS SUITE IS ACTUALLY FOR
 * Every check below exists because the same class of mistake has already been
 * made in this repo once: a list in the code drifting away from the list in
 * the database, a number printed without saying where it came from, and a
 * date worked out in the wrong time zone. See CONTEXT-FOR-AI.md §21/§22.
 */

import { readFileSync } from "node:fs";
import {
  PROVIDERS, PROVIDER_LABELS, PROVIDER_METRICS, METRIC_LABELS, PROVIDER_SCOPES,
  GOOGLE_PROVIDERS, isGoogleProvider, scopesFor, connectionNeedsReconnect,
  normalizeProperty, prettyProperty, windowFor, rangeById, REPORT_LAG_DAYS,
  formatMetric, snapshotToLines, newestPerProperty, measuredToText, canSync,
  STATUSES, SCOPE_IS_READ_ONLY,
} from "../../lib/connectors.js";
import {
  assembleReportFacts, buildFactsText, deterministicReport, missingFrom, checkReport,
} from "../../lib/client-report.js";
import { SCOPE_BY_ROLE_TEST_ONLY } from "./scopes.mjs";
import { windowDays, windowsDisagree } from "../../lib/connectors.js";
import { fetchWindow } from "../../lib/connector-fetch.js";

let passed = 0;
let failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

const SQL = readFileSync(new URL("../../supabase/migrations/0013_client_connections.sql", import.meta.url), "utf8");
/* The same file with every -- comment stripped. Some checks below look for
 * something being ABSENT, and a comment explaining why it is absent would
 * otherwise fail them. */
const SQL_CODE = SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

console.log("\nCLIENT CONNECTIONS\n");

/* ---------------------------------------------------------------- */
console.log("The code's lists and the database's lists are the same list");

{
  const m = /provider text not null\s*\n\s*check \(provider in \(([^)]*)\)\)/.exec(SQL);
  ok("migration 0013 declares the provider list", Boolean(m));
  const fromSql = (m?.[1] || "").split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
  eq("every provider in the code is one the database accepts", [...PROVIDERS].sort(), fromSql.sort());
}

{
  const m = /status text not null default 'manual'\s*\n\s*check \(status in \(([^)]*)\)\)/.exec(SQL);
  ok("migration 0013 declares the status list", Boolean(m));
  const fromSql = (m?.[1] || "").split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
  eq("every status in the code is one the database accepts", [...STATUSES].sort(), fromSql.sort());
}

{
  /* The one that would have cost a whole afternoon: the server names these
   * exact columns when it saves a reading, and it can only name real ones. */
  const api = readFileSync(new URL("../../api/connector.js", import.meta.url), "utf8");
  const conflict = /onConflict: "([^"]+)"/.exec(api)?.[1] || "";
  const idx = /admin_connection_snapshots_one_per_day[\s\S]*?\(([^)]*)\)/.exec(SQL)?.[1] || "";
  const idxCols = idx.split(",").map((s) => s.trim()).filter(Boolean);
  eq("the columns the server saves against are the unique index's own columns",
    conflict.split(","), idxCols);
  ok("that list is plain columns, never an expression",
    idxCols.every((c) => /^[a-z_]+$/.test(c)), idxCols.join("|"));
}

{
  /* Every column the API and the data layer write must exist in the migration.
   * Same trick as tests/brain: a test that agrees with the code is not a test,
   * so this reads the CREATE TABLE statement itself. */
  const block = /create table if not exists public\.admin_connection_snapshots \(([\s\S]*?)\n\);/.exec(SQL)?.[1] || "";
  const cols = new Set([...block.matchAll(/^\s{2}([a-z_]+)\s/gm)].map((m) => m[1]));
  for (const c of ["connection_id", "client_id", "provider", "property", "period_start",
    "period_end", "taken_at", "taken_on", "taken_by", "source", "metrics", "detail", "note"]) {
    ok(`admin_connection_snapshots really has a "${c}" column`, cols.has(c));
  }
}

{
  const block = /create table if not exists public\.admin_client_connections \(([\s\S]*?)\n\);/.exec(SQL)?.[1] || "";
  const cols = new Set([...block.matchAll(/^\s{2}([a-z_]+)\s/gm)].map((m) => m[1]));
  for (const c of ["client_id", "provider", "auth_kind", "label", "account_email", "property",
    "property_label", "scope", "status", "last_synced_at", "last_error",
    "meta", "notes", "active", "sort", "connected_at", "connected_by"]) {
    ok(`admin_client_connections really has a "${c}" column`, cols.has(c));
  }
}

{
  /* THE SECURITY CHECK THAT CAUGHT THE FIRST VERSION.
   *
   * The sign-in was a column on the card, protected by a column-level REVOKE
   * after a table-level GRANT — which does nothing in PostgreSQL. Every
   * signed-in admin browser could read it and overwrite it, while three
   * comments in the codebase said it could not. It now lives in its own
   * table that nobody who signs in has any permission on. */
  ok("the sign-in is NOT a column on the card any more",
    !/refresh_token_enc/.test(/create table if not exists public\.admin_client_connections \(([\s\S]*?)\n\);/.exec(SQL)?.[1] || ""));
  ok("it lives in its own table", /create table if not exists public\.admin_connection_secrets/.test(SQL));
  ok("nothing is granted on that table to a signed-in browser",
    !/grant[^;]*on public\.admin_connection_secrets to authenticated/i.test(SQL));
  ok("anything Supabase granted by default is taken back",
    /revoke all on public\.admin_connection_secrets from authenticated/.test(SQL)
    && /revoke all on public\.admin_connection_secrets from anon/.test(SQL));
  ok("row level security is on it too, with no policies at all",
    /alter table public\.admin_connection_secrets enable row level security/.test(SQL)
    && !/policy[^;]*on public\.admin_connection_secrets/i.test(SQL));
  ok("no column-level revoke is relied on anywhere — it does not work after a table grant",
    !/revoke (select|update) \(/.test(SQL_CODE));
  ok("a reading can never be edited after the fact — no update grant at all",
    !/grant[^;]*update[^;]*on public\.admin_connection_snapshots/i.test(SQL));
  ok("a person typing numbers in is forced to label them typed-in",
    /for insert with check \(public\.admin_is_admin\(\) and source = 'manual'\)/.test(SQL));
  ok("two cards with no property chosen yet do NOT collide",
    /admin_client_connections_one_per_property[\s\S]*?where property is not null and property <> ''/.test(SQL));
  ok("removing a connection is owners only",
    /"owners remove connections"[\s\S]*?for delete using \(public\.admin_is_owner\(\)\)/.test(SQL));
}

/* ---------------------------------------------------------------- */
console.log("\nEvery metric has words to print it in");

for (const p of PROVIDERS) {
  for (const key of PROVIDER_METRICS[p] || []) {
    ok(`"${key}" (${p}) has a plain-words label`, Boolean(METRIC_LABELS[key]), key);
  }
}
ok("every provider has a label", PROVIDERS.every((p) => PROVIDER_LABELS[p]));

/* ---------------------------------------------------------------- */
console.log("\nPermissions");

for (const p of GOOGLE_PROVIDERS) {
  ok(`${p} asks for at least one permission`, (PROVIDER_SCOPES[p] || []).length > 0);
  ok(`${p} also asks who you are, so the account email is known`,
    scopesFor(p).includes("email") && scopesFor(p).includes("openid"));
  ok(`${p} is honest on screen about whether it is read-only`,
    typeof SCOPE_IS_READ_ONLY[p] === "boolean");
}
ok("Search Console asks for read-only and nothing more",
  PROVIDER_SCOPES.gsc.every((s) => s.endsWith(".readonly")) && SCOPE_IS_READ_ONLY.gsc === true);
ok("Analytics asks for read-only and nothing more",
  PROVIDER_SCOPES.ga4.every((s) => s.endsWith(".readonly")) && SCOPE_IS_READ_ONLY.ga4 === true);
ok("Business Profile is NOT claimed to be read-only, because Google has no such permission",
  SCOPE_IS_READ_ONLY.gbp === false);
ok("Bing cannot be signed into from here, so it is not offered a Connect button",
  !isGoogleProvider("bing") && !isGoogleProvider("other"));

ok("a sign-in granted less than we need is spotted",
  connectionNeedsReconnect("gsc", "openid email"));
ok("a sign-in granted exactly what we need is left alone",
  !connectionNeedsReconnect("gsc", `openid email ${PROVIDER_SCOPES.gsc[0]}`));
ok("a provider we do not sign into never asks anybody to reconnect",
  !connectionNeedsReconnect("bing", ""));

{
  /* The one that matters most in this whole file. include_granted_scopes
   * would hand back one token carrying every permission the account ever gave
   * us — a token stored for a client's Search Console would also open a
   * mailbox. It must never appear. */
  const oauth = readFileSync(new URL("../../lib/google-oauth.js", import.meta.url), "utf8");
  ok("the sign-in never asks Google to bundle in previously granted permissions",
    !/include_granted_scopes/.test(oauth.replace(/\/\*[\s\S]*?\*\//g, "")));
}

/* ---------------------------------------------------------------- */
console.log("\nProperties");

eq("an Analytics property id is written the way its API wants it",
  normalizeProperty("ga4", "123456789"), "properties/123456789");
eq("...and typing the prefix in as well does not double it",
  normalizeProperty("ga4", "properties/123456789"), "properties/123456789");
eq("a Business Profile location out of a pasted path is found",
  normalizeProperty("gbp", "accounts/111/locations/222"), "locations/222");
eq("a bare location number is fixed up", normalizeProperty("gbp", "222"), "locations/222");
eq("an empty box stays empty and never becomes the word null",
  normalizeProperty("gsc", "   "), null);
eq("a Search Console domain property is left exactly as Google writes it",
  normalizeProperty("gsc", "sc-domain:example.com"), "sc-domain:example.com");
eq("a property reads as a name on screen, never as a raw id",
  prettyProperty("gsc", "sc-domain:example.com"), "example.com");
eq("a URL property loses its scheme and trailing slash on screen",
  prettyProperty("gsc", "https://example.com/"), "example.com");

/* ---------------------------------------------------------------- */
console.log("\nThe window we ask for");

{
  const NOON = Date.parse("2026-08-24T12:00:00Z");
  const w = windowFor("gsc", "28d", NOON);
  eq("28 days means 28 days, counting both ends", w.days, 28);
  const spanDays = (Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86400000 + 1;
  eq("start to end really is that many days", spanDays, 28);
  ok("Search Console is never asked for the last three days, which have not settled",
    w.end === "2026-08-21", w.end);
  ok("Business Profile is pulled back further still, because it settles later",
    windowFor("gbp", "28d", NOON).end < w.end);
  ok("every provider has a settling lag written down",
    PROVIDERS.every((p) => typeof REPORT_LAG_DAYS[p] === "number"));
}

{
  /* Days must not move when the machine's clock does. The Overview page had
   * exactly this bug in August and it made a task due today read LATE. */
  const NOON = Date.parse("2026-08-24T12:00:00Z");
  const a = windowFor("gsc", "28d", NOON);
  const before = process.env.TZ;
  process.env.TZ = "Pacific/Auckland";
  const b = windowFor("gsc", "28d", NOON);
  process.env.TZ = before;
  eq("the same moment gives the same window whatever the machine's time zone", a, b);
}

eq("an unknown range falls back to the first one, never to nothing",
  rangeById("nonsense").id, "28d");

/* ---------------------------------------------------------------- */
console.log("\nHow a number is printed");

eq("a click rate prints as a percentage", formatMetric("ctr", 0.0226), "2.3%");
eq("an average position prints to one decimal", formatMetric("position", 14.23), "14.2");
eq("a count prints with thousands separators", formatMetric("clicks", 18240), "18,240");
eq("a missing number prints as a dash, NEVER as zero", formatMetric("clicks", null), "—");
eq("...and an undefined one does the same", formatMetric("callClicks", undefined), "—");
eq("a real zero still prints as zero", formatMetric("callClicks", 0), "0");

/* ---------------------------------------------------------------- */
console.log("\nEvery reading says where it came from");

const SNAP_API = {
  id: "s1", connection_id: "c1", client_id: "cl1", provider: "gsc",
  property: "sc-domain:example.com",
  period_start: "2026-07-25", period_end: "2026-08-21",
  taken_at: "2026-08-24T09:00:00Z", source: "api",
  metrics: { clicks: 412, impressions: 18240, ctr: 412 / 18240, position: 14.2 },
  detail: { topQueries: [{ query: "destin realtor", clicks: 61, impressions: 1840 }], topPages: [] },
};
const SNAP_MANUAL = { ...SNAP_API, id: "s2", source: "manual", taken_at: "2026-08-23T09:00:00Z" };

{
  const text = snapshotToLines(SNAP_API).join("\n");
  ok("the window it covers is printed", text.includes("2026-07-25") && text.includes("2026-08-21"));
  ok("the day it was read is printed", text.includes("2026-08-24"));
  ok("it says this console read it", /read straight out of that account/.test(text));
  ok("the numbers are there", text.includes("412") && text.includes("18,240"));
  const manual = snapshotToLines(SNAP_MANUAL).join("\n");
  ok("a typed-in reading says so, in different words", /typed in by one of us/.test(manual));
  ok("and is never described as read by the console", !/read straight out of that account/.test(manual));
}

{
  const odd = { ...SNAP_API, metrics: { clicks: 1, somethingNew: 99 } };
  ok("a number the provider list does not know about is still printed, never silently dropped",
    snapshotToLines(odd).join("\n").includes("99"));
}

{
  const empty = { ...SNAP_API, metrics: {} };
  ok("a reading that came back empty says so instead of printing nothing",
    /No numbers were returned/.test(snapshotToLines(empty).join("\n")));
}

{
  const older = { ...SNAP_API, id: "old", taken_at: "2026-08-01T09:00:00Z", metrics: { clicks: 1 } };
  const list = newestPerProperty([older, SNAP_API]);
  eq("only the newest reading of one property is handed on", list.length, 1);
  eq("...and it is the newest one", list[0].id, "s1");
  const two = newestPerProperty([SNAP_API, { ...SNAP_API, id: "other", property: "sc-domain:two.com" }]);
  eq("two different properties are both kept", two.length, 2);
}

ok("nothing measured means nothing is written, not an empty heading",
  measuredToText([]) === "");
ok("the block warns that these are the client's numbers and not ours",
  /NOT our records/.test(measuredToText([SNAP_API])));

/* ---------------------------------------------------------------- */
console.log("\nWhat can actually be read");

const base = { id: "c1", active: true, auth_kind: "google", property: "sc-domain:x.com", status: "connected" };
ok("a connected connection with a property can be read", canSync(base));
ok("one with no property cannot", !canSync({ ...base, property: null }));
ok("a switched-off one cannot", !canSync({ ...base, active: false }));
ok("a typed-in one cannot", !canSync({ ...base, auth_kind: "manual" }));
ok("one that needs signing in again cannot", !canSync({ ...base, status: "needs_reconnect" }));
ok("one that failed last time CAN be tried again", canSync({ ...base, status: "error" }));
ok("nothing at all cannot", !canSync(null));

/* ---------------------------------------------------------------- */
console.log("\nWhat a report is allowed to say");

const CLIENT = { id: "cl1", name: "Sample Client", domain: "example.com", stage: "Week 3", status: "active", start_date: "2026-07-01" };
const NOW = Date.parse("2026-08-24T12:00:00Z");

function facts({ snapshots = [], connections = [] } = {}) {
  return assembleReportFacts({
    client: CLIENT,
    tasks: [{ id: "t1", client_id: "cl1", name: "Ship the AI files", status: "done", updated_at: "2026-08-01T00:00:00Z" }],
    snapshots, connections, nowMs: NOW,
  });
}

{
  const f = facts();
  const gaps = missingFrom(f).join("\n");
  ok("with nothing connected, the report says nobody's real numbers are in it",
    /None of the client's own accounts/.test(gaps));
  ok("...and the fact sheet has no measured block at all",
    !/MEASURED IN THE CLIENT'S OWN ACCOUNTS/.test(buildFactsText(f).text));
}

{
  const f = facts({ connections: [{ id: "c1", provider: "gsc", property: "sc-domain:example.com", status: "connected" }] });
  const gaps = missingFrom(f).join("\n");
  ok("connected but never read is a DIFFERENT sentence from not connected",
    /connected but have never been read/.test(gaps));
}

{
  const f = facts({ connections: [{ id: "c1", provider: "gsc", property: "x", status: "needs_reconnect" }] });
  ok("a connection that needs signing in again is named as the reason there are no numbers",
    /signing in again/.test(missingFrom(f).join("\n")));
}

{
  const f = facts({
    snapshots: [SNAP_API],
    connections: [{ id: "c1", provider: "gsc", property: "sc-domain:example.com", status: "connected" }],
  });
  const sheet = buildFactsText(f).text;
  ok("the measured block is on the fact sheet", /MEASURED IN THE CLIENT'S OWN ACCOUNTS/.test(sheet));
  ok("it carries the rule about never blending them with our own counts",
    /Never blend them with our task counts/.test(sheet));
  ok("the gaps list now names the accounts that are STILL missing, by name",
    /Google Business Profile/.test(missingFrom(f).join("\n")));
  ok("...and no longer claims nothing is connected",
    !/None of the client's own accounts/.test(missingFrom(f).join("\n")));

  /* The measured block is in the part of the sheet that is never trimmed. A
   * client with 400 tasks must not lose the only real numbers in the report. */
  const tiny = buildFactsText(f, { maxChars: 500 }).text;
  ok("a very small fact sheet still keeps the measured numbers",
    /MEASURED IN THE CLIENT'S OWN ACCOUNTS/.test(tiny));
}

{
  /* With nothing measured, that same line must NOT carry an exception for a
   * section the report does not have. */
  const f = facts();
  const report = deterministicReport(f, { presetId: "standard", todayIso: "2026-08-24" });
  ok("with no measured numbers, no exception is claimed",
    !/EXCEPT the section headed/.test(report.body));
  ok("...and there is no accounts section either",
    !/What their own accounts show/.test(report.body));
}

{
  const f = facts({ snapshots: [SNAP_MANUAL], connections: [{ id: "c1", provider: "gsc", property: "p", status: "manual" }] });
  ok("typed-in numbers are called out in the gaps list as typed in",
    /typed in by one of us rather than read from the account/.test(missingFrom(f).join("\n")));
  /* The summary is the half that gets pasted into an email. It said "shows
   * ... clicks" whatever the source, so a hand-typed figure was asserted
   * there as a reading while the body two screens down said otherwise. */
  const typedReport = deterministicReport(f, { presetId: "standard", todayIso: "2026-08-24" });
  ok("a typed-in number is labelled as typed in IN THE SUMMARY, not only in the body",
    /as typed in by one of us from their screen — not read by this console/.test(typedReport.body));
  ok("...and is never described in the summary as read by this console",
    !/That is their number, not ours/.test(typedReport.body.split("## Where they stand")[0]));
}

{
  /* The whole honesty machine, end to end: the counted report must survive
   * the same check the AI's draft is put through. If a measured number were
   * printed in the report but not on the fact sheet, this fails. */
  const f = facts({
    snapshots: [SNAP_API],
    connections: [{ id: "c1", provider: "gsc", property: "sc-domain:example.com", status: "connected" }],
  });
  const sheet = buildFactsText(f).text;
  const report = deterministicReport(f, { presetId: "standard", todayIso: "2026-08-24" });
  ok("the counted report prints what their own accounts show",
    /What their own accounts show/.test(report.body));
  ok("every one of its numbers is backed by the fact sheet",
    checkReport(report, sheet, { clientName: CLIENT.name, teamNames: [] }).ok,
    JSON.stringify(checkReport(report, sheet, { clientName: CLIENT.name, teamNames: [] }).problems || []));
  ok("the client's own number is the FIRST line of the 30-second version",
    /^## In short\n- Their own Google Search Console/.test(report.body));
  ok("the blanket \"everything below is counted from our own records\" line names the exception",
    /EXCEPT the section headed "What their own accounts show"/.test(report.body));
  ok("the short version leads with the client's own click number",
    /Their own Google Search Console shows/.test(report.body));
  ok("...and says out loud that it is their number and not ours",
    /That is their number, not ours/.test(report.body));
}

/* ---------------------------------------------------------------- */
console.log("\nOne client's numbers never become another's");

{
  /* The key used to be provider+property with no client in it. Two clients
   * each with a typed-in Business Profile card and no property chosen keyed
   * to the same string, so the older one vanished with no trace — including
   * from the assistant's context, where every client's readings are handed in
   * at once. */
  const a = { client_id: "C1", provider: "gbp", property: "", taken_at: "2026-08-24T09:00:00Z", metrics: { callClicks: 5 } };
  const b = { client_id: "C2", provider: "gbp", property: "", taken_at: "2026-08-23T09:00:00Z", metrics: { callClicks: 9 } };
  const kept = newestPerProperty([a, b]);
  eq("both clients survive", kept.length, 2);
  eq("...and each keeps its own number", kept.map((x) => x.metrics.callClicks).sort(), [5, 9]);
}

/* ---------------------------------------------------------------- */
console.log("\nReadings that cover different lengths of time are called out");

const W28 = { period_start: "2026-07-25", period_end: "2026-08-21" };
const W7 = { period_start: "2026-08-15", period_end: "2026-08-21" };
eq("28 days counts both ends", windowDays(W28), 28);
eq("7 days counts both ends", windowDays(W7), 7);
ok("two readings of the same length are fine", !windowsDisagree([W28, { ...W28 }]));
ok("a 7-day reading beside a 28-day one is not", windowsDisagree([W28, W7]));
ok("the fact sheet warns about it in words",
  /do not all cover the same number of days/.test(measuredToText([
    { ...SNAP_API, ...W28 },
    { ...SNAP_API, id: "s9", property: "sc-domain:two.com", ...W7 },
  ])));

/* ---------------------------------------------------------------- */
console.log("\nAn empty answer from Google is never saved as a zero");

/* The Google calls are stubbed. No network, no keys — what is being checked
 * is the SHAPE of what comes back when Google says nothing, because that is
 * the difference between "we have no number" and "nobody called them". */
function fakeGoogle(reply) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(typeof reply === "function" ? reply(String(url)) : reply),
  });
  return () => { globalThis.fetch = real; };
}

{
  const undo = fakeGoogle({ rows: [] });
  const out = await fetchWindow({ provider: "gsc", token: "t", property: "sc-domain:x.com", start: "2026-07-25", end: "2026-08-21" });
  undo();
  eq("Search Console with no rows gives no clicks, not zero clicks", out.metrics.clicks, null);
  eq("...and no impressions either", out.metrics.impressions, null);
  ok("...and says why in plain words", /Nothing has been recorded as a zero/.test(out.warnings.join(" ")));
}

{
  const undo = fakeGoogle({ rows: [{ clicks: 412, impressions: 18240, position: 14.2 }] });
  const out = await fetchWindow({ provider: "gsc", token: "t", property: "sc-domain:x.com", start: "2026-07-25", end: "2026-08-21" });
  undo();
  eq("a real answer still comes through", out.metrics.clicks, 412);
  ok("the click rate is worked out from the totals, not taken from Google",
    Math.abs(out.metrics.ctr - 412 / 18240) < 1e-12);
}

{
  const undo = fakeGoogle({ multiDailyMetricTimeSeries: [] });
  const out = await fetchWindow({ provider: "gbp", token: "t", property: "locations/1", start: "2026-07-22", end: "2026-08-19" });
  undo();
  eq("a listing Google says nothing about has no call number", out.metrics.callClicks, null);
  ok("...and says why", /not verified|no daily numbers/.test(out.warnings.join(" ")));
}

{
  const undo = fakeGoogle({
    multiDailyMetricTimeSeries: [{
      dailyMetricTimeSeries: [{ dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ value: 4 }, { value: 3 }] } }],
    }],
  });
  const out = await fetchWindow({ provider: "gbp", token: "t", property: "locations/1", start: "2026-07-22", end: "2026-08-19" });
  undo();
  eq("the series Google DID send is added up", out.metrics.callClicks, 7);
  eq("the ones it did not send stay blank, never zero", out.metrics.businessImpressions, null);
  ok("...and the card is told which ones were missing", /Google sent nothing for/.test(out.warnings.join(" ")));
}

{
  const urls = [];
  const undo = fakeGoogle((url) => { urls.push(url); return { multiDailyMetricTimeSeries: [] }; });
  await fetchWindow({ provider: "gbp", token: "t", property: "locations/1", start: "2026-07-22", end: "2026-08-19" });
  undo();
  const url = urls[0] || "";
  ok("the Business Profile date range is asked for in one naming style all the way down",
    url.includes("dailyRange.startDate.year=2026") && url.includes("dailyRange.endDate.day=19"), url.slice(0, 160));
  ok("...and never the half-and-half version that matches no field at all",
    !/start_date|end_date/.test(url));
}

{
  /* Google retired `conversions` in favour of `keyEvents`. Asking for the
   * retired one alongside the three metrics that matter failed the WHOLE
   * read, so every Analytics connection returned nothing at all — visitors
   * included. It is asked for on its own now, new name first. */
  const bodies = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || "{}");
    bodies.push(body);
    const asked = (body.metrics || []).map((m) => m.name);
    if (asked.includes("conversions")) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "Field conversions is not a valid metric" } }) };
    if (asked.includes("keyEvents")) return { ok: true, status: 200, text: async () => JSON.stringify({ rows: [{ metricValues: [{ value: "12" }] }] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ rows: [{ metricValues: [{ value: "900" }, { value: "1100" }, { value: "700" }] }] }) };
  };
  const out = await fetchWindow({ provider: "ga4", token: "t", property: "properties/1", start: "2026-08-01", end: "2026-08-21" });
  globalThis.fetch = real;
  eq("visitors come back", out.metrics.users, 900);
  eq("actions taken use the name Google uses now", out.metrics.conversions, 12);
  ok("the retired name never rides along with the metrics that matter",
    !(bodies[0].metrics || []).some((m) => m.name === "conversions" || m.name === "keyEvents"));
}

/* ---------------------------------------------------------------- */
console.log("\nWho may see any of it");

ok("a sales rep's AI cannot see a client's connected accounts at all",
  !SCOPE_BY_ROLE_TEST_ONLY.sales.includes("measured"));
ok("an owner's can", SCOPE_BY_ROLE_TEST_ONLY.owner.includes("measured"));
ok("an admin's can", SCOPE_BY_ROLE_TEST_ONLY.admin.includes("measured"));

/* ---------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
