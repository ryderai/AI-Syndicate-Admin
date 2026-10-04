/* End-to-end test of api/meta-ads.js — 4 Oct 2026.
 *
 * The real handler runs. Only the network is replaced: global fetch answers
 * for Supabase (auth + PostgREST) and for graph.facebook.com with fixtures
 * shaped like the real answers of 3 Oct 2026. Nothing leaves this machine.
 *
 *   node tests/meta-ads/handler.mjs [path-to-write-the-response.json]
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
delete process.env.STRIPE_SECRET_KEY;

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}\n  ${e.stack || e.message}`); }
}

/* ---------------- fixtures ---------------- */
const ROLE = { value: "owner" };
const T0 = Date.parse("2026-10-03T15:30:00Z");
const ADS = [
  ["c1", "C1 · Carousel · question hook", 17.03, 964, 45, 41, 57],
  ["v4", "V4 · Caite talking · lawn care", 10.78, 500, 33, 28, 30],
  ["c2", "C2 · Carousel · money hook", 4.36, 328, 11, 9, 15],
  ["v3", "V3 · Can AI read your site · blank-page hook", 0.40, 17, 0, 0, 4],
  ["v2", "V2 · Catch what AI gets wrong · accuracy hook", 0.15, 4, 0, 0, 4],
  ["c3", "C3 · Carousel · 9pm scene", 0.11, 6, 0, 0, 7],
  ["v1", "V1 · What does AI say about you · question hook", 0, 1, 0, 0, 0],
];
const graph = {
  account: { id: "act_1691374768590142", name: "AI Syndicate", currency: "USD", timezone_name: "America/Chicago", account_status: 1, amount_spent: "3283", spend_cap: "50000" },
  campaigns: [{ id: "120249552016910599", name: "HS-Launch-Oct26", objective: "OUTCOME_TRAFFIC", effective_status: "ACTIVE", status: "ACTIVE", lifetime_budget: "49000", budget_remaining: "45717", start_time: "2026-10-03T09:58:00-0500", stop_time: "2026-10-16T23:59:00-0500" }],
  adsets: [{ id: "120249552016900599", name: "HS-Launch-Oct26 · Owners US", campaign_id: "120249552016910599", effective_status: "ACTIVE", status: "ACTIVE", optimization_goal: "LANDING_PAGE_VIEWS", billing_event: "IMPRESSIONS", targeting: { geo_locations: { countries: ["US"] }, age_min: 25, age_max: 65, flexible_spec: [{ behaviors: [{ name: "Small business owners" }, { name: "Business page admins" }] }] } }],
  ads: ADS.map(([id, name]) => ({
    id, name, adset_id: "120249552016900599", campaign_id: "120249552016910599", effective_status: "ACTIVE", status: "ACTIVE",
    created_time: id === "v4" ? "2026-10-03T18:40:00-0500" : "2026-10-02T22:00:00-0500",
    creative: {
      id: `cr-${id}`, title: "Is AI recommending your business?",
      body: id === "v4" ? "Lawn care owners: open ChatGPT and ask, \"Who's the best lawn care company near me?\"\n\nDid it say your name?" : "Is AI recommending your business? Or someone else's?",
      url_tags: `utm_source=meta&utm_medium=paid&utm_campaign=hs-launch-oct26-${id}`,
      video_id: id.startsWith("v") ? "1" : undefined,
      object_story_spec: id.startsWith("c")
        ? { link_data: { link: "https://www.aisyndicate.com/home-services/lawn-care/", child_attachments: [{ name: "Is it you?" }, { name: "They call one." }, { name: "Meet Caite" }] } }
        : { video_data: { call_to_action: { type: "LEARN_MORE", value: { link: id === "v4" ? "https://www.aisyndicate.com/home-services/lawn-care/" : "https://www.aisyndicate.com/home-services/" } } } },
    },
  })),
  insights: ADS.filter(([, , spend]) => spend > 0).map(([id, , spend, imp, lc, lpv]) => ({
    ad_id: id, adset_id: "120249552016900599", campaign_id: "120249552016910599",
    spend: String(spend), impressions: String(imp), reach: String(Math.round(imp * 0.92)), frequency: "1.08",
    clicks: String(lc + 2), inline_link_clicks: String(lc),
    actions: [{ action_type: "link_click", value: String(lc) }, { action_type: "landing_page_view", value: String(lpv) }, ...(id.startsWith("v") ? [{ action_type: "video_view", value: String(Math.round(imp * 0.4)) }] : [])],
    ...(id.startsWith("v") ? { video_thruplay_watched_actions: [{ action_type: "video_view", value: String(Math.round(imp * 0.08)) }], video_p25_watched_actions: [{ action_type: "video_view", value: String(Math.round(imp * 0.2)) }], video_p50_watched_actions: [{ action_type: "video_view", value: String(Math.round(imp * 0.1)) }], video_p75_watched_actions: [{ action_type: "video_view", value: String(Math.round(imp * 0.06)) }], video_p100_watched_actions: [{ action_type: "video_view", value: String(Math.round(imp * 0.04)) }], video_avg_time_watched_actions: [{ action_type: "video_view", value: "6" }] } : {}),
    quality_ranking: "UNKNOWN",
    date_start: "2026-10-03", date_stop: "2026-10-04",
  })),
  daily: [
    { date_start: "2026-10-03", spend: "29.95", impressions: "1640", inline_link_clicks: "80", actions: [{ action_type: "landing_page_view", value: "70" }] },
    { date_start: "2026-10-04", spend: "2.88", impressions: "180", inline_link_clicks: "9", actions: [{ action_type: "landing_page_view", value: "8" }] },
  ],
  placements: [
    { publisher_platform: "instagram", platform_position: "instagram_reels", spend: "14.10", impressions: "800", inline_link_clicks: "44" },
    { publisher_platform: "facebook", platform_position: "feed", spend: "12.40", impressions: "700", inline_link_clicks: "33" },
    { publisher_platform: "instagram", platform_position: "instagram_stories", spend: "6.33", impressions: "320", inline_link_clicks: "12" },
  ],
  ages: [
    { age: "45-54", gender: "male", spend: "9.10", impressions: "480", inline_link_clicks: "25" },
    { age: "35-44", gender: "male", spend: "8.00", impressions: "430", inline_link_clicks: "22" },
    { age: "55-64", gender: "male", spend: "6.20", impressions: "390", inline_link_clicks: "18" },
    { age: "35-44", gender: "female", spend: "4.50", impressions: "260", inline_link_clicks: "12" },
  ],
  devices: [
    { impression_device: "iphone", spend: "21.00", impressions: "1150", inline_link_clicks: "60" },
    { impression_device: "android_smartphone", spend: "10.80", impressions: "610", inline_link_clicks: "27" },
    { impression_device: "desktop", spend: "1.03", impressions: "60", inline_link_clicks: "2" },
  ],
};

/* Our own rows: visitors per ad as the admin counted them on 3 Oct. */
const events = [];
const heat = [];
let k = 0;
for (const [id, , , , , , visitors] of ADS) {
  for (let i = 0; i < visitors; i++) {
    const sid = `s-${id}-${i}`;
    const at = new Date(T0 + (k++) * 240000).toISOString();
    const base = { page_slug: id === "v2" || id === "v3" ? "home-services" : "lawn-care", session_id: sid, cta: null, device: i % 9 === 0 ? "desktop" : "mobile", utm_source: "meta", utm_campaign: `hs-launch-oct26-${id}`, utm_content: null, created_at: at };
    events.push({ ...base, event: "view" });
    if (i % 10 === 0) events.push({ ...base, event: "scroll_50" });
    if (i % 3 === 0) events.push({ ...base, event: "scan_start" });
    if (id === "c1" && i === 4) { events.push({ ...base, event: "scan_email" }, { ...base, event: "scan_complete" }); }
    if (id === "c1" && i === 7) events.push({ ...base, event: "cta_click", cta: "calc-open" });
    heat.push({ view_id: `v-${sid}`, session_id: sid, page_slug: base.page_slug, device: base.device, max_scroll_pct: i % 10 === 0 ? 70 : (i % 3 === 0 ? 30 : 15), active_ms: i % 3 === 0 ? 24000 : 6000, zones: { hero: { r: 1, ms: 6000 }, calculator: { r: i % 3 === 0 ? 1 : 0, ms: 2000 }, offer: { r: i % 10 === 0 ? 1 : 0, ms: 5000 }, faq: { r: i % 20 === 0 ? 1 : 0, ms: 1000 } }, click_count: i % 3 === 0 ? 2 : 0, utm_source: "meta", utm_campaign: base.utm_campaign, first_seen_at: at });
  }
}
/* Ryder's own funnel check, which must be shown but never counted. */
events.push({ page_slug: "lawn-care", event: "view", session_id: "s-test", device: "desktop", utm_source: "meta", utm_campaign: "hs-launch-oct26-test", created_at: new Date(T0).toISOString() });
events.push({ page_slug: "lawn-care", event: "checkout_open", session_id: "s-test", device: "desktop", utm_source: "meta", utm_campaign: "hs-launch-oct26-test", created_at: new Date(T0).toISOString() });
const leadSources = [{ lead_id: "11111111-1111-1111-1111-111111111111", page_slug: "lawn-care", session_id: "s-test", utm_source: "meta", utm_campaign: "hs-launch-oct26-test", utm_content: null, converted_at: new Date(T0 + 60000).toISOString(), reached_checkout: true, paid: false }];
const leads = [{ id: "11111111-1111-1111-1111-111111111111", name: "Ryder Test", company: "TEST Funnel Check Oct3", domain: null, email: "ryder+funneltest1003@aisyndicate.com", phone: "2055550100", created_at: new Date(T0).toISOString() }];
const clicks = heat.filter((h) => h.click_count).flatMap((h) => [{ view_id: h.view_id, session_id: h.session_id, zone: "scan-form", target: "field:biz", kind: "field" }, { view_id: h.view_id, session_id: h.session_id, zone: "scan-form", target: "field:site", kind: "field" }]);

/* ---------------- the network ---------------- */
const seen = { graphUrls: [], graphAuth: [], restUrls: [] };
let graphMode = "ok";
const tables = { hs_page_events: events, hs_lead_sources: leadSources, hs_heat_sessions: heat, hs_heat_clicks: clicks, admin_leads: leads };

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.host === "graph.facebook.com") {
    seen.graphUrls.push(url.toString());
    seen.graphAuth.push(headers.get("authorization"));
    if (graphMode === "expired") return json({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } }, 400);
    const p = url.pathname.replace(/^\/v[\d.]+\//, "");
    const bd = url.searchParams.get("breakdowns");
    if (p === "act_1691374768590142") return json(graph.account);
    if (p.endsWith("/campaigns")) return json({ data: graph.campaigns });
    if (p.endsWith("/adsets")) return json({ data: graph.adsets });
    if (p.endsWith("/ads")) return json({ data: graph.ads });
    if (p.endsWith("/insights")) {
      if (url.searchParams.get("level") === "ad") return json({ data: [...graph.insights, ...(graph.deletedAdSpend ? [graph.deletedAdSpend] : [])] });
      if (url.searchParams.get("time_increment")) return json({ data: graph.daily });
      if (bd === "publisher_platform,platform_position") return json({ data: graph.placements });
      if (bd === "age,gender") return json({ data: graph.ages });
      if (bd === "impression_device") return json({ data: graph.devices });
    }
    return json({ error: { message: `unexpected ${p}`, code: 100 } }, 400);
  }
  if (url.host === "stub.supabase.co") {
    if (url.pathname === "/auth/v1/user") return json({ id: "u1", aud: "authenticated", email: "ryder@aisyndicate.com" });
    seen.restUrls.push(url.toString());
    const table = url.pathname.replace("/rest/v1/", "");
    if (table === "admin_users") {
      const row = { user_id: "u1", email: "ryder@aisyndicate.com", full_name: "Ryder", role: ROLE.value, active: true };
      return (headers.get("accept") || "").includes("vnd.pgrst.object") ? json(row) : json([row]);
    }
    let rows = tables[table];
    if (!rows) return json({ message: `no table ${table}` }, 404);
    /* honour the in() filters and the paging the endpoint uses */
    for (const [key, val] of url.searchParams) {
      const m = /^in\.\((.*)\)$/.exec(val);
      if (m && key !== "select") {
        const want = m[1].split(",").map((s) => s.replace(/^"|"$/g, ""));
        rows = rows.filter((r) => want.includes(String(r[key])));
      }
    }
    const range = headers.get("range");
    if (range) {
      const [a, b] = range.split("-").map(Number);
      rows = rows.slice(a, b + 1);
    }
    return json(rows);
  }
  throw new Error(`unexpected fetch ${url}`);
};

/* ---------------- run ---------------- */
const { default: handler } = await import("../../api/meta-ads.js");
function call(query) {
  return new Promise((resolve) => {
    const res = {
      code: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, body: b }); },
    };
    handler({ method: "GET", headers: { authorization: "Bearer user-token" }, query }, res);
  });
}

await test("no token: the page still answers, says why, and our own numbers are there", async () => {
  delete process.env.META_ACCESS_TOKEN;
  const r = await call({ from: "2026-10-03", to: "2026-10-03", refresh: "1" });
  assert.equal(r.code, 200);
  assert.equal(r.body.meta.ok, false);
  assert.equal(r.body.meta.kind, "missing");
  assert.ok(r.body.landing.sessions > 100);
});

await test("an admin who is not an owner is refused", async () => {
  ROLE.value = "admin";
  const r = await call({ from: "2026-10-03", to: "2026-10-03", refresh: "1" });
  ROLE.value = "owner";
  assert.equal(r.code, 401);
});

await test("an expired token is named as expired", async () => {
  process.env.META_ACCESS_TOKEN = "EAAB-test-token";
  graphMode = "expired";
  const r = await call({ from: "2026-10-03", to: "2026-10-03", refresh: "1" });
  graphMode = "ok";
  assert.equal(r.body.meta.ok, false);
  assert.equal(r.body.meta.kind, "token");
  assert.match(r.body.meta.error, /expired/);
});

let full;
await test("with a token: the whole page comes back, joined", async () => {
  process.env.META_ACCESS_TOKEN = "EAAB-test-token";
  seen.graphUrls.length = 0;
  const r = await call({ from: "2026-10-03", to: "2026-10-04", refresh: "1" });
  full = r.body;
  assert.equal(r.code, 200);
  assert.equal(full.meta.ok, true);
  assert.equal(full.campaigns.length, 1);
  assert.equal(full.ads.length, 7);
  assert.equal(full.total.spend.toFixed(2), "32.83");
  assert.equal(full.total.linkClicks, 89);
  const c1 = full.ads.find((a) => a.id === "c1");
  assert.equal(c1.code, "hs-launch-oct26-c1");
  assert.equal(c1.land.sessions, 57);
  assert.equal(full.landing.sessions, 117, "the test visit is left out of the totals");
  assert.ok(full.unmatchedCodes.some((u) => u.code === "hs-launch-oct26-test" && u.test));
  assert.equal(full.campaigns[0].lifetimeBudget, 490);
  assert.ok(full.campaigns[0].pace);
  assert.equal(full.sales.ok, false, "no Stripe key in this test");
  assert.ok(full.verdicts.length > 0);
});

await test("spend from an ad that is no longer in the ads list still counts in the total", async () => {
  graph.deletedAdSpend = { ad_id: "gone", adset_id: "120249552016900599", campaign_id: "120249552016910599", spend: "1.00", impressions: "10", inline_link_clicks: "0", actions: [] };
  const r = await call({ from: "2026-10-03", to: "2026-10-04", refresh: "1" });
  delete graph.deletedAdSpend;
  assert.equal(r.body.total.spend.toFixed(2), "33.83");
  assert.equal(r.body.ads.length, 7);
});

await test("the source filter is case-blind and includes Meta's own tags", async () => {
  const before = seen.restUrls.length;
  await call({ from: "2026-10-03", to: "2026-10-04", refresh: "1" });
  const ev = seen.restUrls.slice(before).find((u) => u.includes("/hs_page_events"));
  assert.ok(ev && /utm_source\.ilike\.meta/.test(decodeURIComponent(ev)) && /utm_source\.ilike\.an\b/.test(decodeURIComponent(ev)), ev);
});

await test("the token travels in a header, never in a URL", async () => {
  assert.ok(seen.graphUrls.length >= 9);
  for (const u of seen.graphUrls) assert.ok(!u.includes("EAAB"), u);
  for (const a of seen.graphAuth) assert.equal(a, "Bearer EAAB-test-token");
});

await test("the 60-second memory answers a second read without calling Meta", async () => {
  seen.graphUrls.length = 0;
  const r = await call({ from: "2026-10-03", to: "2026-10-04" });
  assert.equal(r.body.cached, true);
  assert.equal(seen.graphUrls.length, 0);
});

await test("Refresh skips the memory", async () => {
  seen.graphUrls.length = 0;
  const r = await call({ from: "2026-10-03", to: "2026-10-04", refresh: "1" });
  assert.ok(!r.body.cached);
  assert.ok(seen.graphUrls.length >= 9);
});

if (process.argv[2] && full) writeFileSync(process.argv[2], JSON.stringify(full, null, 1));
console.log(`meta-ads handler: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
