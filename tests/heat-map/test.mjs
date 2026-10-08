/* Tests for the landing-page heat map — 30 Sep 2026.
 *
 *   bash tests/heat-map/run.sh
 *
 * No database, no network. The maths is in lib/heat-map.js; the endpoint is
 * called with a fake request. The real-Postgres half is sql.sh. */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ZONES, ZONE_KEYS, isZone, cleanHeatPost, rollupFromRows, sectionRows, heatSummary,
  placeCells, targetLabel, orderedZones, MIN_VIEWS, GRID,
} from "../../lib/heat-map.js";
import { PAGE_SLUGS } from "../../lib/home-services.js";
import { _resetRateLimit } from "../../lib/hs-http.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let passed = 0, failed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); passed += 1; out.push(`  ok   ${name}`); }
  catch (e) { failed += 1; out.push(`  FAIL ${name}\n       ${e.message}`); }
}

const MIG = readFileSync(join(ROOT, "supabase/migrations/0046_landing_heat_map.sql"), "utf8")
  .replace(/--[^\n]*/g, " ");

/* ---------- the two copies of the vocabularies ---------- */

await test("both heat tables allow exactly PAGE_SLUGS", () => {
  const lists = [...MIG.matchAll(/page_slug text not null check \(page_slug in \(([\s\S]*?)\)\)/g)]
    .map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  assert.equal(lists.length, 2, "expected two page_slug checks");
  /* 0047 (7 Oct 2026) re-states both lists with free-ai-score added. 0046 must
   * still be a subset, and the newest statement must equal PAGE_SLUGS. */
  for (const l of lists) for (const s of l) assert.ok(PAGE_SLUGS.includes(s), `0046 has ${s}, PAGE_SLUGS does not`);
  const M47 = readFileSync(join(ROOT, "supabase/migrations/0047_free_ai_score_page.sql"), "utf8").replace(/--[^\n]*/g, " ");
  const heat47 = [...M47.matchAll(/alter table public\.hs_heat_(?:sessions|clicks)\s+add constraint \w+ check \(page_slug in \(([\s\S]*?)\)\)/g)]
    .map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  assert.equal(heat47.length, 2, "0047 should re-state both heat tables");
  for (const l of heat47) assert.deepEqual([...l].sort(), [...PAGE_SLUGS].sort());
});

/* The page's copy. Both places it can live are checked when present: the
 * landing source and the website repo it is copied into. */
const siteCopies = [
  join(ROOT, "..", "Home-Services-LP", "assets", "site.js"),
  process.env.LP_SITE_JS,
].filter((p) => p && existsSync(p));
await test(`site.js ZONES match lib/heat-map.js ZONES (${siteCopies.length} cop${siteCopies.length === 1 ? "y" : "ies"} found)`, () => {
  if (!siteCopies.length) { console.log("       (no site.js found next to this repo — skipped, not passed)"); return; }
  for (const p of siteCopies) {
    const s = readFileSync(p, "utf8");
    const block = /var ZONES = \[([\s\S]*?)\];/.exec(s);
    assert.ok(block, `${p} has no ZONES list`);
    const keys = [...block[1].matchAll(/\['([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual(keys, ZONE_KEYS, p);
  }
});

await test("site.js sends nothing for the snapshot script, a frame, GPC, or the checkout", () => {
  if (!siteCopies.length) return;
  const s = readFileSync(siteCopies[0], "utf8");
  assert.match(s, /NO_TRACK = qs\.has\('ais_heat_snapshot'\)/);
  assert.match(s, /function track\(event, extra\) \{\n\s+extra = extra \|\| \{\};\n\s+if \(NO_TRACK\) return;/);
  assert.match(s, /globalPrivacyControl === true\) return/);
  assert.match(s, /window\.top !== window\.self\) return/);
  assert.match(s, /section\.co'\)\) return/);
  // never the value of a field
  assert.doesNotMatch(s.slice(s.indexOf("9. HEAT"), s.indexOf("8. THE AI CHAT")), /\.value\b/);
});

await test("every zone has a label; nested zones name a real parent", () => {
  for (const z of ZONES) {
    assert.ok(z.label);
    if (z.parent) assert.ok(isZone(z.parent));
  }
});

/* ---------- cleaning a POST ---------- */

const good = () => ({
  page_slug: "lawn-care", view_id: "v-abc123def", session_id: "s1", seq: 2,
  device: "mobile", vw: 390, vh: 844, doc_h: 8000, max_scroll: 55, active_ms: 12000,
  zones: { hero: [1, 5000], offer: [0, 0], bogus: [1, 99], faq: [0, 800] },
  clicks: [[1, "offer", 500, 930, "price-buy", "link", 0, 0, 30000]],
  age_ms: 45000,
});

await test("a good body becomes a clean row", () => {
  const c = cleanHeatPost(good());
  assert.equal(c.ok, true);
  assert.equal(c.row.page_slug, "lawn-care");
  assert.deepEqual(c.row.zones.hero, { r: 1, ms: 5000 });
  assert.ok(!("bogus" in c.row.zones), "unknown zone dropped");
  assert.deepEqual(c.row.zones.faq, { r: 1, ms: 800 }, "time on screen implies reached");
  assert.equal(c.row.clicks.length, 1);
  assert.equal(c.row.clicks[0].target, "price-buy");
  assert.equal(c.row.clicks[0].cid, 1);
  assert.equal(c.row.age_ms, 45000);
});

await test("refuses an unknown page, a missing view id, a bad seq", () => {
  assert.equal(cleanHeatPost({ ...good(), page_slug: "nope" }).ok, false);
  assert.equal(cleanHeatPost({ ...good(), view_id: "" }).ok, false);
  assert.equal(cleanHeatPost({ ...good(), view_id: "bad id!" }).ok, false);
  assert.equal(cleanHeatPost({ ...good(), session_id: "" }).ok, false);
  assert.equal(cleanHeatPost({ ...good(), seq: 0 }).ok, false);
  assert.equal(cleanHeatPost({ ...good(), seq: "x" }).ok, false);
});

await test("clamps numbers and drops junk clicks", () => {
  const c = cleanHeatPost({ ...good(), max_scroll: 180, active_ms: -5, clicks: [
    [1, "offer", 1400, -20, "x", "link", 0, 0, 1], [2, "nowhere", 1, 1], [3, "hero", "a", 5], [4, "hero", 10, 10, null, "weird"],
    [4, "hero", 10, 10, null, "link"], [null, "hero", 1, 1],
  ] });
  assert.equal(c.row.max_scroll_pct, 100);
  assert.equal(c.row.active_ms, 0);
  assert.equal(c.row.clicks.length, 2, "bad zone, bad x, repeated cid and missing cid are all dropped");
  assert.deepEqual([c.row.clicks[0].x_pm, c.row.clicks[0].y_pm], [1000, 0]);
  assert.equal(c.row.clicks[1].kind, "other");
});

await test("never stores an email or a phone number in a label — and keeps the rest of the label", () => {
  const c = cleanHeatPost({ ...good(), clicks: [
    [1, "hero", 1, 1, "Email me@x.com", "link"], [2, "hero", 1, 1, "Call 205-212-0491", "link"],
    [3, "hero", 1, 1, "$200/mo or $2,000/yr", "link"], [4, "hero", 1, 1, "Top 3 in 2026", "link"],
    [5, "hero", 1, 1, "a\u0000b", "link"], [6, "footer", 1, 1, "support@aisyndicate.com", "link"],
  ] });
  const t = c.row.clicks.map((k) => k.target);
  assert.deepEqual(t, ["Email [email]", "Call [phone]", "$200/mo or $2,000/yr", "Top 3 in 2026", "a b", "[email]"]);
});

await test("a session id must look like one the page makes", () => {
  assert.equal(cleanHeatPost({ ...good(), session_id: "abc 123" }).ok, false);
  assert.equal(cleanHeatPost({ ...good(), session_id: "nostore-lx9k2abc" }).ok, true);
});

await test("at most 40 clicks per send", () => {
  const clicks = Array.from({ length: 90 }, (_, i) => [i + 1, "hero", 5, 5, "a", "link"]);
  assert.equal(cleanHeatPost({ ...good(), clicks }).row.clicks.length, 40);
});

/* ---------- the rollup ---------- */

const T = Date.parse("2026-09-15T15:00:00Z");
const view = (i, over = {}) => ({
  view_id: `v-${i}`, session_id: `s-${i}`, page_slug: "lawn-care", device: i % 2 ? "mobile" : "desktop",
  max_scroll_pct: (i * 10) % 101, active_ms: 1000 * i, utm_source: i % 3 ? "facebook" : null, utm_content: null,
  zones: { hero: { r: 1, ms: 1000 }, offer: { r: i % 2, ms: i % 2 ? 4000 : 0 } },
  first_seen_at: new Date(T + i * 60000).toISOString(), ...over,
});

await test("rollup counts views, reach, scroll, clicks and grid cells", () => {
  const views = [view(1), view(2), view(3), view(4)];
  const clicks = [
    { view_id: "v-1", zone: "offer", x_pm: 1000, y_pm: 1000, target: "price-buy", kind: "link", dead: false, rage: false },
    { view_id: "v-1", zone: "offer", x_pm: 990, y_pm: 980, target: "price-buy", kind: "link", dead: false, rage: false },
    { view_id: "v-2", zone: "hero", x_pm: 10, y_pm: 10, target: null, kind: "text", dead: true, rage: true },
    { view_id: "v-other", zone: "hero", x_pm: 10, y_pm: 10, target: null, kind: "text", dead: true, rage: false },
  ];
  const r = rollupFromRows(views, clicks, ["s-1"], { slug: "lawn-care" });
  assert.equal(r.views, 4);
  assert.equal(r.lead_views, 1);
  assert.deepEqual(r.zones.find((z) => z.zone === "offer"), { zone: "offer", reached: 2, ms_total: 8000 });
  assert.equal(r.clicks.total, 3, "a click from a view outside the filter is not counted");
  assert.equal(r.clicks.dead, 1);
  const cell = r.grid.find((g) => g.zone === "offer");
  assert.deepEqual([cell.xb, cell.yb, cell.n], [GRID - 1, GRID - 1, 2], "x=1000 lands in the last cell, not past it");
  assert.equal(r.targets[0].target, "price-buy");
  assert.deepEqual(r.zclicks.find((z) => z.zone === "hero"), { zone: "hero", n: 1, dead: 1, dead_views: 1, by_leads: 0 });
  assert.equal(r.targets[0].by_leads, 2);
  assert.equal(r.median_active_ms, 2500);
  assert.equal(r.scroll.length, 10);
});

await test("filters: device, who, source, date", () => {
  const views = [view(1), view(2), view(3), view(4), view(5, { page_slug: "painting" })];
  const f = { slug: "lawn-care" };
  assert.equal(rollupFromRows(views, [], [], { ...f, device: "mobile" }).views, 2);
  assert.equal(rollupFromRows(views, [], ["s-1", "s-2"], { ...f, who: "leads" }).views, 2);
  assert.equal(rollupFromRows(views, [], ["s-1", "s-2"], { ...f, who: "not" }).views, 2);
  assert.equal(rollupFromRows(views, [], [], { ...f, source: "facebook" }).views, 3);
  assert.equal(rollupFromRows(views, [], [], { ...f, fromMs: T + 2 * 60000, toMs: T + 4 * 60000 }).views, 2, "from is inclusive, to is exclusive");
  const opts = rollupFromRows(views, [], [], { ...f, device: "mobile" }).options;
  assert.equal(opts.devices.reduce((s, d) => s + d.n, 0), 4, "the menus count every device, not just the one picked");
});

await test("an empty rollup is blanks, not zeros", () => {
  const s = heatSummary(rollupFromRows([], [], [], { slug: "lawn-care" }));
  assert.equal(s.views, 0);
  assert.equal(s.medianSecs, null);
  assert.equal(s.bottomPct, null);
  assert.ok(s.scrollCurve.every((c) => c.pct === null));
});

/* ---------- the section table and its verdicts ---------- */

const LAYOUT = { w: 1000, h: 5000, zones: {
  header: { top: 0, left: 0, width: 1000, height: 80 },
  hero: { top: 100, left: 0, width: 1000, height: 1000 },
  "scan-form": { top: 800, left: 0, width: 1000, height: 300 },
  calculator: { top: 1200, left: 0, width: 1000, height: 400 },
  offer: { top: 1700, left: 0, width: 1000, height: 1000 },
  faq: { top: 2800, left: 0, width: 1000, height: 600 },
  footer: { top: 3500, left: 0, width: 1000, height: 80 },
} };

function fakeRollup(views, zones, grid, targets = []) {
  const total = grid.reduce((s, g) => s + g.n, 0);
  const zclicks = grid.map((g) => ({ zone: g.zone, n: g.n, dead: g.dead || 0, dead_views: g.dead || 0, by_leads: g.by_leads || 0 }));
  return { views, sessions: views, lead_views: 0, median_active_ms: 1, scroll: Array(10).fill(0), zones, clicks: { total, dead: 0, rage: 0 }, zclicks, grid, targets, options: {} };
}

await test("under MIN_VIEWS every verdict says too few", () => {
  const rows = sectionRows(fakeRollup(MIN_VIEWS - 1, [], []), LAYOUT);
  assert.ok(rows.every((r) => r.verdicts[0].id === "few"));
});

await test("only sections the picture has are listed, in page order", () => {
  const rows = sectionRows(fakeRollup(100, [], []), LAYOUT);
  assert.deepEqual(rows.map((r) => r.key), ["header", "hero", "scan-form", "calculator", "offer", "faq", "footer"]);
  assert.deepEqual(orderedZones({ zones: { faq: { top: 10 }, hero: { top: 900 } } }).slice(0, 2).map((z) => z.key), ["faq", "hero"], "measured positions win");
});

await test("verdicts: leave, move up, cut, dead, keep", () => {
  const zones = [
    { zone: "header", reached: 100, ms_total: 100000 },
    { zone: "hero", reached: 100, ms_total: 900000 },
    { zone: "scan-form", reached: 90, ms_total: 50000 },
    { zone: "calculator", reached: 80, ms_total: 80000 },   // 1 s each, no clicks → cut
    { zone: "offer", reached: 40, ms_total: 400000 },       // big drop before it; lots of clicks → move up
    { zone: "faq", reached: 35, ms_total: 350000 },
    { zone: "footer", reached: 30, ms_total: 1000 },
  ];
  const grid = [
    { zone: "offer", xb: 20, yb: 36, n: 50, dead: 0 },
    { zone: "scan-form", xb: 20, yb: 36, n: 40, dead: 0 },
    { zone: "faq", xb: 20, yb: 5, n: 10, dead: 8 },          // 8 dead of 35 reached → dead
  ];
  const rows = sectionRows(fakeRollup(100, zones, grid), LAYOUT);
  const by = Object.fromEntries(rows.map((r) => [r.key, r.verdicts.map((v) => v.id)]));
  assert.ok(by.calculator.includes("leave"), `calculator should be the biggest drop (80 → 40): ${by.calculator}`);
  assert.ok(by.calculator.includes("cut"), `calculator: 1 s, no clicks: ${by.calculator}`);
  assert.ok(by.offer.includes("up"), `offer: 40% reach, 50% of clicks: ${by.offer}`);
  assert.ok(by.faq.includes("dead"), `faq: ${by.faq}`);
  assert.deepEqual(by.hero, ["keep"]);
  assert.deepEqual(by.footer, [], "the footer never gets a verdict");
  assert.deepEqual(by.header, [], "nor the top bar");
  assert.ok(!by["scan-form"].includes("cut"), "a form is never 'cut' for being quick");
  assert.equal(rows.find((r) => r.key === "hero").dropAfter, 20);
  assert.equal(rows.find((r) => r.key === "scan-form").dropAfter, null, "nested blocks are not on the ladder");
});

await test("only the three worst do-nothing sections keep the flag", () => {
  const keys = ["hero", "calculator", "offer", "faq", "scan-form"];
  const zones = keys.map((k) => ({ zone: k, reached: 100, ms_total: 1e6 }));
  const grid = keys.map((k, i) => ({ zone: k, xb: 1, yb: 1, n: 20 + i, dead: 20 + i }));
  const rows = sectionRows(fakeRollup(100, zones, grid), LAYOUT);
  assert.equal(rows.filter((r) => r.verdicts.some((v) => v.id === "dead")).length, 3);
});

/* ---------- placing clicks on the picture ---------- */

await test("'Move it up' needs real clicks, not three", () => {
  const zones = [{ zone: "hero", reached: 30, ms_total: 1e5 }, { zone: "faq", reached: 10, ms_total: 1e5 }];
  const tiny = sectionRows(fakeRollup(30, zones, [{ zone: "faq", xb: 1, yb: 1, n: 1, by_leads: 1 }, { zone: "hero", xb: 1, yb: 1, n: 2 }]), LAYOUT);
  assert.ok(!tiny.find((r) => r.key === "faq").verdicts.some((v) => v.id === "up"), "1 click out of 3 is not a reason to move a section");
  const real = sectionRows(fakeRollup(30, zones, [{ zone: "faq", xb: 1, yb: 1, n: 12 }, { zone: "hero", xb: 1, yb: 1, n: 20 }]), LAYOUT);
  assert.ok(real.find((r) => r.key === "faq").verdicts.some((v) => v.id === "up"));
});

await test("popup clicks do not shrink the page's shares", () => {
  const zones = [{ zone: "hero", reached: 100, ms_total: 1e6 }];
  const rows = sectionRows(fakeRollup(100, zones, [{ zone: "hero", xb: 1, yb: 1, n: 10 }, { zone: "calc-popup", xb: 1, yb: 1, n: 90 }]), { ...LAYOUT, zones: { ...LAYOUT.zones } });
  assert.equal(rows.find((r) => r.key === "hero").clickShare, 100);
});

await test("a cell lands at its share of its section's box", () => {
  const { cells, skipped } = placeCells([{ zone: "offer", xb: 0, yb: 0, n: 3 }, { zone: "calc-popup", xb: 1, yb: 1, n: 2 }], LAYOUT);
  assert.equal(skipped, 2, "a popup is not in the picture");
  assert.equal(cells.length, 1);
  assert.equal(cells[0].x, 12.5);
  assert.equal(cells[0].y, 1700 + 12.5);
});

await test("target labels read as words", () => {
  assert.equal(targetLabel({ target: "field:email", kind: "field" }), "Typing box: email");
  assert.equal(targetLabel({ target: null, kind: "text" }), "Plain text (not a link)");
});

/* ---------- the endpoint ---------- */

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: null, ended: false };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.ended = true; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}
process.env.HS_ALLOWED_ORIGINS = "https://www.aisyndicate.com";
delete process.env.SUPABASE_URL; delete process.env.VITE_SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
const { default: handler } = await import("../../api/hs-heat.js");
console.error = () => {};   // the endpoint logs "Supabase is not configured" on every call here; that is expected

await test("endpoint: a text/plain body from our origin is accepted (204)", async () => {
  _resetRateLimit();
  const res = fakeRes();
  await handler({ method: "POST", headers: { origin: "https://www.aisyndicate.com", "content-type": "text/plain" }, body: JSON.stringify(good()) }, res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "https://www.aisyndicate.com");
});

await test("endpoint: another origin is refused (403) with no allow header", async () => {
  const res = fakeRes();
  await handler({ method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify(good()) }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

await test("endpoint: no Origin header at all is refused (403) — a script, not a browser", async () => {
  const res = fakeRes();
  await handler({ method: "POST", headers: {}, body: JSON.stringify(good()) }, res);
  assert.equal(res.statusCode, 403);
});

await test("endpoint: many made-up page loads from one address hit the address limit", async () => {
  _resetRateLimit();
  let last, n = 0;
  for (let i = 0; i < 260; i += 1) {
    last = fakeRes();
    await handler({ method: "POST", headers: { origin: "https://www.aisyndicate.com", "x-forwarded-for": "9.9.9.9" }, body: JSON.stringify({ ...good(), view_id: `v-fake${i}xx` }) }, last);
    if (last.statusCode === 204) n += 1;
  }
  assert.equal(n, 240);
  assert.equal(last.statusCode, 429);
  _resetRateLimit();
});

await test("endpoint: junk is 400, a big body is 400, GET is 405", async () => {
  let res = fakeRes();
  await handler({ method: "POST", headers: { origin: "https://www.aisyndicate.com" }, body: JSON.stringify({ ...good(), page_slug: "x" }) }, res);
  assert.equal(res.statusCode, 400);
  res = fakeRes();
  await handler({ method: "POST", headers: { origin: "https://www.aisyndicate.com" }, body: "x".repeat(13 * 1024) }, res);
  assert.equal(res.statusCode, 400);
  res = fakeRes();
  await handler({ method: "GET", headers: { origin: "https://www.aisyndicate.com" } }, res);
  assert.equal(res.statusCode, 405);
});

await test("endpoint: the 31st send in a minute from one page load is 429", async () => {
  _resetRateLimit();
  let last;
  for (let i = 0; i < 31; i += 1) {
    last = fakeRes();
    await handler({ method: "POST", headers: { origin: "https://www.aisyndicate.com" }, body: JSON.stringify({ ...good(), seq: i + 1 }) }, last);
  }
  assert.equal(last.statusCode, 429);
});

console.log(out.join("\n"));
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
