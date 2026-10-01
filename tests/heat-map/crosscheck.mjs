/* THE TWO COPIES OF THE COUNTING MUST AGREE.  30 Sep 2026.
 *
 * Called by sql.sh with a live Postgres (PGHOST, PGUSER set). Makes 400 random
 * page loads and their clicks, writes them into the real tables, then asks
 * hs_heat_rollup() and rollupFromRows() the same questions and fails on any
 * difference. Rows are written with a fixed seed so a failure repeats. */

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { rollupFromRows, ZONE_KEYS } from "../../lib/heat-map.js";

const OWNER = process.argv[2];
const psql = (sql, asOwner = false) => execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-tAq", "-c",
  asOwner ? `set local role authenticated; set local request.jwt.claim.sub = '${OWNER}'; ${sql}` : sql], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();

let s = 7;
const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
const pick = (a) => a[Math.floor(r() * a.length)];
const q = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);

const T0 = Date.parse("2026-09-01T05:00:00Z");
const views = [], clicks = [], leadSessions = [];
for (let i = 0; i < 400; i += 1) {
  const slug = i % 5 === 0 ? "painting" : "lawn-care";
  const session = `s${Math.floor(i / 2)}`;           // two page loads share a session sometimes
  const zones = {};
  for (const k of ZONE_KEYS) if (r() < 0.6) zones[k] = { r: r() < 0.8 ? 1 : 0, ms: Math.floor(r() * 20000) };
  const v = {
    view_id: `v-${i}xyz`, session_id: session, page_slug: slug,
    device: pick(["mobile", "desktop", "tablet", null]),
    max_scroll_pct: Math.floor(r() * 101), active_ms: Math.floor(r() * 90000),
    utm_source: pick(["facebook", "google", null, ""]), utm_content: pick(["ad-a", "ad-b", null]),
    zones, first_seen_at: new Date(T0 + Math.floor(r() * 30 * 86400000)).toISOString(),
  };
  views.push(v);
  const n = Math.floor(r() * 6);
  for (let j = 0; j < n; j += 1) {
    clicks.push({ view_id: v.view_id, cid: j + 1, zone: pick(ZONE_KEYS), x_pm: Math.floor(r() * 1001), y_pm: Math.floor(r() * 1001),
      target: pick(["price-buy", "box-scan", null, "field:email", "What is AI Pulse?"]), kind: pick(["link", "button", "field", "text", "image", "other"]),
      dead: r() < 0.2, rage: r() < 0.05 });
  }
}
const leadsLawn = [...new Set(views.filter((v) => v.page_slug === "lawn-care" && r() < 0.15).map((v) => v.session_id))];
leadSessions.push(...leadsLawn);

/* Write them. Straight INSERTs as the superuser, so first_seen_at can be set. */
const sql = [];
for (const v of views) {
  sql.push(`insert into public.hs_heat_sessions (view_id, session_id, page_slug, device, max_scroll_pct, active_ms, zones, utm_source, utm_content, first_seen_at) values (${q(v.view_id)}, ${q(v.session_id)}, ${q(v.page_slug)}, ${q(v.device)}, ${v.max_scroll_pct}, ${v.active_ms}, ${q(JSON.stringify(v.zones))}::jsonb, ${q(v.utm_source)}, ${q(v.utm_content)}, ${q(v.first_seen_at)});`);
}
for (const c of clicks) {
  const v = views.find((x) => x.view_id === c.view_id);
  sql.push(`insert into public.hs_heat_clicks (view_id, cid, session_id, page_slug, zone, x_pm, y_pm, target, kind, dead, rage) values (${q(c.view_id)}, ${c.cid}, ${q(v.session_id)}, ${q(v.page_slug)}, ${q(c.zone)}, ${c.x_pm}, ${c.y_pm}, ${q(c.target)}, ${q(c.kind)}, ${c.dead}, ${c.rage});`);
}
for (const sid of leadsLawn) {
  sql.push(`with l as (insert into public.admin_leads default values returning id) insert into public.hs_lead_sources (lead_id, page_slug, session_id) select id, 'lawn-care', ${q(sid)} from l;`);
}
execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q"], { input: sql.join("\n"), encoding: "utf8" });

/* Compare. JSON numbers from Postgres: counts are bigint → numbers; the median
 * is a double; timestamps are strings in Postgres's own format → compared as
 * instants. */
const norm = (o) => ({
  ...o,
  first_at: o.first_at ? Date.parse(o.first_at) : null,
  last_at: o.last_at ? Date.parse(o.last_at) : null,
});
const CASES = [
  {},
  { device: "mobile" },
  { device: "tablet", who: "leads" },
  { who: "leads" },
  { who: "not" },
  { source: "facebook" },
  { content: "ad-b", device: "desktop" },
  { fromMs: Date.parse("2026-09-10T05:00:00Z"), toMs: Date.parse("2026-09-20T05:00:00Z") },
  { fromMs: Date.parse("2026-12-01T06:00:00Z"), toMs: Date.parse("2026-12-02T06:00:00Z") },   // empty
];
let n = 0;
for (const slug of ["lawn-care", "painting"]) {
  for (const c of CASES) {
    const f = { slug, fromMs: null, toMs: null, device: null, source: null, content: null, who: "all", ...c };
    const js = rollupFromRows(views, clicks, slug === "lawn-care" ? leadSessions : [], f);
    const arg = (v) => (v == null ? "null" : `'${v}'`);
    const ts = (ms) => (ms == null ? "null" : `'${new Date(ms).toISOString()}'::timestamptz`);
    const pg = JSON.parse(psql(`select public.hs_heat_rollup(${arg(slug)}, ${ts(f.fromMs)}, ${ts(f.toMs)}, ${arg(f.device)}, ${arg(f.source)}, ${arg(f.content)}, ${arg(f.who)});`, true));
    assert.deepEqual(norm(pg), norm(js), `${slug} ${JSON.stringify(c)}`);
    n += 1;
  }
}
console.log(`  ok   hs_heat_rollup and rollupFromRows agree on ${n} questions over ${views.length} page loads and ${clicks.length} clicks`);
