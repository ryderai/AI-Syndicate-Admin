/* Tests for the Meta page — 4 Oct 2026.
 * Run with:  bash tests/meta-ads/run.sh
 * No network, no keys. Fixtures are shaped like the real Graph API answers and
 * like the real hs_page_events rows of 3 Oct 2026. */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  rate, costPer, actionValue, ACTIONS, normaliseInsight, sumMetrics, adCode, adPath,
  adFunnel, biggestDrop, landingStats, heatStats, sectionReach, topTargets, buildTree,
  verdicts, isPulseSubscription, matchSales, dailyRows, breakdownRows, budgetPace,
  isTestCode, isMetaSource, statusWord, AD_FUNNEL,
} from "../../lib/meta-ads.js";
import { ZONES } from "../../lib/heat-map.js";
import { HS_EVENTS } from "../../lib/home-services.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`✗ ${name}\n  ${e.message}`); }
}

/* ---------- fixtures ---------- */
const insightC1 = {
  ad_id: "c1", adset_id: "s1", campaign_id: "k1",
  spend: "17.03", impressions: "964", reach: "903", frequency: "1.07", clicks: "53", inline_link_clicks: "45",
  actions: [
    { action_type: "link_click", value: "45" },
    { action_type: "landing_page_view", value: "41" },
    { action_type: "omni_landing_page_view", value: "41" },
    { action_type: "offsite_conversion.fb_pixel_lead", value: "2" },
    { action_type: "lead", value: "2" },
  ],
  quality_ranking: "UNKNOWN",
};
const insightV4 = {
  ad_id: "v4", adset_id: "s1", campaign_id: "k1",
  spend: "10.78", impressions: "500", reach: "431", frequency: "1.16", clicks: "34", inline_link_clicks: "33",
  actions: [{ action_type: "landing_page_view", value: "28" }, { action_type: "video_view", value: "210" }],
  video_thruplay_watched_actions: [{ action_type: "video_view", value: "40" }],
  video_p25_watched_actions: [{ action_type: "video_view", value: "120" }],
};
const ads = [
  { id: "c1", name: "C1 · Carousel · question hook", adset_id: "s1", campaign_id: "k1", effective_status: "ACTIVE", created_time: "2026-10-02T22:00:00-0500",
    creative: { url_tags: "utm_source=meta&utm_medium=paid&utm_campaign=hs-launch-oct26-c1", object_story_spec: { link_data: { link: "https://www.aisyndicate.com/home-services/lawn-care/", child_attachments: [{ link: "https://www.aisyndicate.com/home-services/lawn-care/" }, { link: "x" }] } } } },
  { id: "v4", name: "V4 · Caite talking · lawn care", adset_id: "s1", campaign_id: "k1", effective_status: "ACTIVE", created_time: "2026-10-03T18:40:00-0500",
    creative: { video_id: "9", object_story_spec: { video_data: { call_to_action: { value: { link: "https://www.aisyndicate.com/home-services/lawn-care/?utm_campaign=hs-launch-oct26-v4" } } } } } },
  { id: "v1", name: "V1 · What does AI say", adset_id: "s1", campaign_id: "k1", effective_status: "ACTIVE", created_time: "2026-10-02T22:00:00-0500",
    url_tags: "utm_campaign=hs-launch-oct26-v1", creative: {} },
];
const sess = (n, code, evs, slug = "lawn-care") => evs.map((ev) => ({ page_slug: slug, event: ev, session_id: `${code}-${n}`, utm_source: "meta", utm_campaign: code, device: "mobile", created_at: "2026-10-03T16:00:00Z" }));
const events = [];
for (let i = 0; i < 50; i++) events.push(...sess(i, "hs-launch-oct26-c1", ["view"]));
for (let i = 0; i < 20; i++) events.push(...sess(i, "hs-launch-oct26-c1", ["scan_start"]));
for (let i = 0; i < 5; i++) events.push(...sess(i, "hs-launch-oct26-c1", ["scroll_50", "scroll_50"]));
for (let i = 0; i < 2; i++) events.push(...sess(i, "hs-launch-oct26-c1", ["scan_email", "scan_complete"]));
for (let i = 0; i < 30; i++) events.push(...sess(i, "hs-launch-oct26-v4", ["view"]));
events.push(...sess(0, "hs-launch-oct26-test", ["view", "checkout_open"]));
const leadSources = [
  { lead_id: "L1", page_slug: "lawn-care", utm_source: "meta", utm_campaign: "hs-launch-oct26-c1", converted_at: "2026-10-03T16:05:00Z", reached_checkout: false, paid: false },
  { lead_id: "L2", page_slug: "lawn-care", utm_source: "meta", utm_campaign: "hs-launch-oct26-c1", converted_at: "2026-10-03T16:06:00Z", reached_checkout: true, paid: false },
];

/* ---------- basic maths ---------- */
test("rate: empty bottom is null, zero top is 0", () => {
  assert.equal(rate(0, 0), null);
  assert.equal(rate(0, 10), 0);
  assert.equal(rate(5, 10), 50);
});
test("costPer: nothing to divide by is null, not $0", () => {
  assert.equal(costPer(12, 0), null);
  assert.equal(costPer(12, 4), 3);
});
test("actionValue takes the FIRST alias present, never the sum (a lead reported twice is one lead)", () => {
  assert.equal(actionValue(insightC1.actions, ACTIONS.leads), 2);
  assert.equal(actionValue(insightC1.actions, ACTIONS.landingViews), 41);
  assert.equal(actionValue([], ACTIONS.leads), null);
});

/* ---------- normalising ---------- */
test("normaliseInsight: real-shaped row", () => {
  const n = normaliseInsight(insightC1);
  assert.equal(n.spend, 17.03);
  assert.equal(n.linkClicks, 45);
  assert.equal(n.landingViews, 41);
  assert.equal(n.metaLeads, 2);
  assert.equal(n.qualityRanking, null, "UNKNOWN is not a ranking");
  assert.equal(n.ctrLink.toFixed(2), "4.67");
  assert.equal(n.costPerLanding.toFixed(2), "0.42");
  assert.equal(n.loadRate.toFixed(1), "91.1");
});
test("normaliseInsight: video numbers", () => {
  const n = normaliseInsight(insightV4);
  assert.equal(n.videoViews3s, 210);
  assert.equal(n.thruplays, 40);
  assert.equal(n.hookRate, 42);
  assert.equal(n.holdRate.toFixed(1), "19.0");
});
test("sumMetrics adds counts but never adds reach (two ads' audiences overlap)", () => {
  const s = sumMetrics([normaliseInsight(insightC1), normaliseInsight(insightV4)]);
  assert.equal(s.spend.toFixed(2), "27.81");
  assert.equal(s.linkClicks, 78);
  assert.equal(s.reach, null);
  assert.equal(s.metaLeads, 2);
});
test("sumMetrics: a field nobody reported stays null", () => {
  const s = sumMetrics([normaliseInsight(insightV4)]);
  assert.equal(s.metaLeads, null);
});

/* ---------- the join between Meta and our pages ---------- */
test("adCode reads the creative's URL parameters box", () => assert.equal(adCode(ads[0]), "hs-launch-oct26-c1"));
test("adCode falls back to the link itself", () => assert.equal(adCode(ads[1]), "hs-launch-oct26-v4"));
test("adCode reads the ad's own url_tags", () => assert.equal(adCode(ads[2]), "hs-launch-oct26-v1"));
test("adPath", () => assert.equal(adPath(ads[0]), "/home-services/lawn-care/"));
test("isTestCode / isMetaSource", () => {
  assert.equal(isTestCode("hs-launch-oct26-test"), true);
  assert.equal(isTestCode("hs-launch-oct26-c1"), false);
  assert.equal(isTestCode("contest"), false);
  assert.equal(isMetaSource("Meta"), true);
  assert.equal(isMetaSource("google"), false);
});

/* ---------- the funnel ---------- */
test("every funnel step is a real event name the pages are allowed to send", () => {
  for (const s of AD_FUNNEL) assert.ok(HS_EVENTS.includes(s.event), s.event);
});
test("adFunnel counts VISITS, not events (scroll_50 twice is one visit)", () => {
  const f = adFunnel(events.filter((e) => e.utm_campaign === "hs-launch-oct26-c1"));
  const at = (ev) => f.find((s) => s.event === ev);
  assert.equal(at("view").sessions, 50);
  assert.equal(at("scroll_50").sessions, 5);
  assert.equal(at("scan_start").sessions, 20);
  assert.equal(at("scan_email").sessions, 2);
});
test("adFunnel never prints a negative loss after a skippable step", () => {
  const f = adFunnel(events.filter((e) => e.utm_campaign === "hs-launch-oct26-c1"));
  const tap = f.find((s) => s.event === "scan_start");
  assert.equal(tap.lost, 60, "compared with Landed (50→20), not with the skippable Read-half step");
  for (const s of f) assert.ok(s.lost === null || s.lost >= 0, `${s.event} lost ${s.lost}`);
});
test("biggestDrop finds the leak by SHARE lost, not by heads (the form, not the top of the page)", () => {
  const f = adFunnel(events.filter((e) => e.utm_campaign === "hs-launch-oct26-c1"));
  const d = biggestDrop(f);
  assert.equal(d.from, "Tapped into the free-scan form");
  assert.equal(d.pct, 90);
});
test("biggestDrop ignores steps that started with too few people", () => {
  const f = adFunnel(events.filter((e) => e.utm_campaign === "hs-launch-oct26-c1"));
  const d = biggestDrop(f, 25);
  assert.equal(d.from, "Landed on the page");
});
test("landingStats", () => {
  const l = landingStats(events.filter((e) => e.utm_campaign === "hs-launch-oct26-c1"), leadSources);
  assert.equal(l.sessions, 50);
  assert.equal(l.tappedForm, 20);
  assert.equal(l.gaveEmail, 2);
  assert.equal(l.leads, 2);
  assert.equal(l.leadRate, 4);
  assert.equal(l.emailFromTap, 10);
  assert.equal(l.devices.mobile, 50);
});

/* ---------- heat ---------- */
const heat = [
  { view_id: "a", session_id: "a", max_scroll_pct: 20, active_ms: 4000, zones: { hero: { r: 1, ms: 4000 }, offer: { r: 0 } }, utm_campaign: "hs-launch-oct26-c1" },
  { view_id: "b", session_id: "b", max_scroll_pct: 80, active_ms: 60000, zones: { hero: { r: 1, ms: 9000 }, offer: { r: 1, ms: 20000 } }, utm_campaign: "hs-launch-oct26-c1" },
];
test("heatStats", () => {
  const h = heatStats(heat);
  assert.equal(h.heatViews, 2);
  assert.equal(h.medianScroll, 50);
  assert.equal(h.bounced10s, 50);
  assert.deepEqual(heatStats([]).medianScroll, null);
});
test("sectionReach uses the heat map's own ladder", () => {
  const s = sectionReach(heat, ZONES);
  const hero = s.find((z) => z.key === "hero");
  const offer = s.find((z) => z.key === "offer");
  assert.equal(hero.pct, 100);
  assert.equal(offer.pct, 50);
  assert.ok(!s.find((z) => z.key === "footer"), "footer is not a verdict zone");
});
test("topTargets ranks by people, not raw clicks", () => {
  const t = topTargets([
    { session_id: "a", target: "box-scan", zone: "hero" }, { session_id: "a", target: "box-scan" }, { session_id: "a", target: "box-scan" },
    { session_id: "b", target: "field:email" }, { session_id: "c", target: "field:email" },
  ]);
  assert.equal(t[0].target, "field:email");
  assert.equal(t[0].sessions, 2);
});

/* ---------- the tree ---------- */
const campaigns = [{ id: "k1", name: "HS-Launch-Oct26", effective_status: "ACTIVE", lifetime_budget: "49000", budget_remaining: "45717", start_time: "2026-10-03T09:58:00-0500", stop_time: "2026-10-16T23:59:00-0500" }];
const adsets = [{ id: "s1", name: "Owners US", campaign_id: "k1", effective_status: "ACTIVE", optimization_goal: "LANDING_PAGE_VIEWS", targeting: { geo_locations: { countries: ["US"] }, age_min: 25, age_max: 65, flexible_spec: [{ behaviors: [{ name: "Small business owners" }] }] } }];
const tree = buildTree({ campaigns, adsets, ads, insights: [insightC1, insightV4], events, leadSources, heat, sales: [{ code: "hs-launch-oct26-c1" }] });
test("buildTree: ads carry Meta numbers AND our numbers", () => {
  const c1 = tree.ads.find((a) => a.id === "c1");
  assert.equal(c1.meta.spend, 17.03);
  assert.equal(c1.land.sessions, 50);
  assert.equal(c1.land.leads, 2);
  assert.equal(c1.sales, 1);
  assert.equal(c1.costs.perLead.toFixed(3), "8.515");
});
test("buildTree: an ad with no insight row is all zeroes, not missing", () => {
  const v1 = tree.ads.find((a) => a.id === "v1");
  assert.equal(v1.meta.spend, 0);
  assert.equal(v1.land.sessions, 0);
  assert.equal(v1.costs.perLead, null);
});
test("buildTree: roll-ups add up", () => {
  const k = tree.campaigns[0];
  assert.equal(k.meta.spend.toFixed(2), "27.81");
  assert.equal(k.land.sessions, 80);
  assert.equal(k.land.leads, 2);
  assert.equal(k.lifetimeBudget, 490);
  assert.equal(tree.adsets[0].targeting.interests[0], "Small business owners");
});
test("buildTree: test traffic is kept apart, never merged into an ad", () => {
  assert.equal(tree.unmatchedCodes.length, 1);
  assert.equal(tree.unmatchedCodes[0].test, true);
});


test("two ads sharing one tracking code: each is flagged, and totals count the code ONCE", () => {
  const twin = { ...ads[0], id: "c1b", name: "C1 · copy" };
  const t2 = buildTree({ campaigns, adsets, ads: [ads[0], twin], insights: [insightC1], events, leadSources, heat });
  const a = t2.ads.find((x) => x.id === "c1");
  const b = t2.ads.find((x) => x.id === "c1b");
  assert.equal(a.sharedCode, true);
  assert.equal(b.sharedCode, true);
  assert.equal(a.land.sessions, 50);
  assert.equal(t2.adsets[0].land.sessions, 50, "not 100");
  assert.equal(t2.campaigns[0].land.leads, 2, "not 4");
  assert.equal(t2.adsLand.sessions, 50);
});
test("adsLand leaves out visits no ad's code matches", () => {
  assert.equal(tree.adsLand.sessions, 80);
  assert.equal(tree.adsSales, 1);
});
test("visitors = visits that LANDED, same as the funnel's first step", () => {
  const l = landingStats([{ event: "scan_start", session_id: "x" }, { event: "view", session_id: "y" }], []);
  assert.equal(l.sessions, 1);
  assert.equal(l.funnel[0].sessions, 1);
});
test("Meta's own source tags count, in any case", () => {
  assert.equal(isMetaSource("an"), true);
  assert.equal(isMetaSource("MSG"), true);
});

/* ---------- verdicts ---------- */
test("verdicts name the cheapest ad and the leak, and do not judge on too little data", () => {
  const land = landingStats(events.filter((e) => !isTestCode(e.utm_campaign)), leadSources, heat);
  const v = verdicts({ ads: tree.ads, total: sumMetrics(tree.ads.map((a) => a.meta)), land, funnel: land.funnel, nowMs: Date.parse("2026-10-04T05:00:00Z") });
  const titles = v.map((x) => x.title).join(" | ");
  assert.match(titles, /Cheapest visits: V4/);
  assert.match(titles, /Cheapest leads: C1/);
  assert.match(titles, /People start the form and stop/);
  assert.match(titles, /Biggest leak: tapped into the free-scan form/);
  assert.ok(!/people scroll past it/.test(titles), "no low-CTR verdict: CTRs are healthy");
  assert.equal(v[0].tone, "bad", "problems sort first");
});
test("verdicts: a stuck ad is named", () => {
  const v = verdicts({ ads: tree.ads, total: sumMetrics(tree.ads.map((a) => a.meta)), land: null, funnel: [], nowMs: Date.parse("2026-10-04T05:00:00Z") });
  assert.ok(v.some((x) => /V1 .* nothing delivered/.test(x.title)));
});
test("verdicts: too few visitors says 'too early', not 'failing'", () => {
  const land = landingStats(events.slice(0, 5), []);
  const v = verdicts({ ads: [], land, funnel: land.funnel });
  assert.ok(v.some((x) => /Too early/.test(x.title)));
  assert.ok(!v.some((x) => /0 leads/.test(x.title)));
});

/* ---------- sales ---------- */
test("isPulseSubscription: $99/mo and $990/yr only", () => {
  assert.equal(isPulseSubscription({ items: { data: [{ price: { unit_amount: 9900, recurring: { interval: "month" } } }] } }), true);
  assert.equal(isPulseSubscription({ items: { data: [{ price: { unit_amount: 99000, recurring: { interval: "year" } } }] } }), true);
  assert.equal(isPulseSubscription({ items: { data: [{ price: { unit_amount: 9900, recurring: null } }] } }), false);
  assert.equal(isPulseSubscription({ items: { data: [{ price: { unit_amount: 49900, recurring: { interval: "month" } } }] } }), false);
});
test("matchSales: by email first, then website; unmatched stays counted", () => {
  const m = matchSales(
    [{ id: "s1", email: "BOB@x.com" }, { id: "s2", domain: "www.lawnpros.com" }, { id: "s3", email: "nobody@y.com" }],
    [{ lead_id: "L1", email: "bob@x.com", utm_campaign: "hs-launch-oct26-c1" }, { lead_id: "L2", domain: "lawnpros.com", utm_campaign: "hs-launch-oct26-v4" }],
  );
  assert.equal(m[0].code, "hs-launch-oct26-c1");
  assert.equal(m[0].matchedBy, "email");
  assert.equal(m[1].code, "hs-launch-oct26-v4");
  assert.equal(m[1].matchedBy, "website");
  assert.equal(m[2].code, null);
  assert.equal(m.length, 3);
});

/* ---------- days, breakdowns, budget ---------- */
test("dailyRows lays our visits beside Meta's spend", () => {
  const d = dailyRows([{ date_start: "2026-10-03", spend: "32.83", impressions: "1820", inline_link_clicks: "89", actions: [] }], { "2026-10-03": { visits: 117, leads: 0 }, "2026-10-04": { visits: 3, leads: 1 } });
  assert.equal(d.length, 2);
  assert.equal(d[0].spend, 32.83);
  assert.equal(d[0].visits, 117);
  assert.equal(d[1].spend, 0);
});
test("breakdownRows sorts by spend and labels in words", () => {
  const b = breakdownRows([{ publisher_platform: "facebook", platform_position: "feed", spend: "3" }, { publisher_platform: "instagram", platform_position: "instagram_reels", spend: "9" }], ["publisher_platform", "platform_position"]);
  assert.equal(b[0].label, "instagram · instagram reels");
});
test("budgetPace", () => {
  const p = budgetPace({ lifetimeBudget: 490, budgetLeft: 457.17, start: "2026-10-03T09:58:00-05:00", end: "2026-10-16T23:59:00-05:00", nowMs: Date.parse("2026-10-04T05:00:00Z") });
  assert.equal(p.spent.toFixed(2), "32.83");
  assert.ok(p.timePct > 3 && p.timePct < 6);
  assert.ok(p.perDayLeft > 33 && p.perDayLeft < 36);
  assert.equal(budgetPace({ lifetimeBudget: null }), null);
});
test("statusWord", () => {
  assert.equal(statusWord("ACTIVE").label, "Running");
  assert.equal(statusWord("DISAPPROVED").tone, "bad");
});

/* ---------- the column guard ---------- */
/* Every column the endpoint selects must exist in the migrations. The repo has
 * shipped code against invented column names before (CONTEXT §21). */
test("api/meta-ads.js selects only columns that exist", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..");
  const sql = readdirSync(join(root, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(root, "supabase", "migrations", f), "utf8")).join("\n");
  const api = readFileSync(join(root, "api", "meta-ads.js"), "utf8");
  const re = /from\("([a-z_]+)"\)\s*\.select\("([^"]+)"\)/g;
  let m;
  let checked = 0;
  while ((m = re.exec(api))) {
    const [, table, cols] = m;
    const create = sql.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`, "i"));
    assert.ok(create, `no CREATE TABLE for ${table}`);
    const alters = [...sql.matchAll(new RegExp(`alter table (?:if exists )?public\\.${table}[\\s\\S]*?;`, "gi"))].map((x) => x[0]).join("\n");
    const body = `${create[1]}\n${alters}`;
    for (const c of cols.split(",").map((x) => x.trim())) {
      assert.ok(new RegExp(`(^|[\\s(,])${c}\\s`, "m").test(body) || new RegExp(`add column (if not exists )?${c}\\b`, "i").test(body), `${table}.${c} is not a column`);
      checked++;
    }
  }
  assert.ok(checked >= 30, `only ${checked} columns checked — the pattern stopped matching`);
});

console.log(`meta-ads: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
