/* THE LANDING-PAGE HEAT MAP — the counting, in one pure file.  30 Sep 2026.
 *
 * CJ's ask (iMessage, 30 Sep 2026): "a heat map tracker on that landing page
 * … where people drop off, if we need to move stuff up or down and what we can
 * delete." This file is the whole answer to that sentence, as maths.
 *
 * WHAT THE LANDING PAGE SENDS (assets/site.js, section 9, "HEAT"):
 *   one row per PAGE LOAD (a "view"), updated as the visitor reads:
 *     how long each section was on screen, whether they got to it, how far
 *     down the page they got, how long the tab was actually in use;
 *   and one row per CLICK: which section, where inside that section (as a
 *     share of its width and height, so a phone click and a laptop click land
 *     on the same picture), what was clicked, and whether it did anything.
 *
 * NOTHING HERE NAMES A PERSON BY ITSELF. Same rule as migration 0035: no
 * cookie, no IP, no user agent, and never a single character anybody typed —
 * a click on a form field is stored as "field:email", not as what was in it.
 * BUT: session_id is the same visit id hs_lead_sources keeps beside a lead.
 * So once a visitor fills in a form, their clicks CAN be matched to their
 * lead row — that join is what the "People who became leads" filter is. Say
 * so wherever this data is described; do not write "anonymous".
 *
 * THE HONESTY RULE, same as every page in this console:
 *   MEASURED  a count of rows.
 *   DERIVED   a formula over counts. Every % and every "Move it up" below.
 *   null      we cannot work it out. Never a zero standing in for "unknown".
 *
 * TWO COPIES OF THE COUNTING, ON PURPOSE, AND A TEST THAT MAKES THEM AGREE.
 * The live console asks Postgres (hs_heat_rollup in migration 0046) because a
 * month of clicks is more rows than PostgREST will hand back in one reply
 * (the 1,000-row cap — CONTEXT §63). The preview mode and the tests use
 * rollupFromRows() below. tests/heat-map/sql.sh loads the same random rows
 * into a real Postgres and fails if the two answers differ by one count.
 */

import { PAGE_SLUGS, DEVICES } from "./home-services.js";

/* ------------------------------------------------------------------ */
/* The sections                                                        */
/* ------------------------------------------------------------------ */

/* ⭐ SECOND COPY of the ZONES list in Home-Services-LP/assets/site.js. The page
 * sends these keys; the endpoint refuses any other. tests/heat-map compares the
 * two lists and fails if they drift.
 *
 *   top      — a top-level block of the page. These, in this order, are the
 *              "how far down did they get" ladder.
 *   parent   — a block that sits INSIDE another one (the chat picture and the
 *              scan form are inside the top box). Counted on its own, never
 *              part of the ladder, drawn indented.
 *   only     — only exists for some visitors (the scan result appears after a
 *              scan; the calculator popup after a click), so "only 12% got
 *              here" would be a lie about the page. No drop-off verdict. */
export const ZONES = [
  { key: "header",      label: "Top bar",                         top: true, noVerdict: true },
  { key: "hero",        label: "Top box (headline, chat, scan)",  top: true },
  { key: "chat",        label: "AI chat picture",                 parent: "hero" },
  { key: "scan-form",   label: "Free scan form",                  parent: "hero", form: true },
  { key: "scan-result", label: "Scan result",                     only: "Shows only after someone runs a scan" },
  { key: "calculator",  label: "Revenue calculator card",         top: true },
  { key: "offer",       label: "What you get + price",            top: true },
  { key: "guarantee",   label: "60-day guarantee",                top: true },
  { key: "trades",      label: "Pick your trade (hub only)",      top: true },
  { key: "proof",       label: "Customer results",                top: true },
  { key: "dashboard",   label: "Dashboard picture",               top: true },
  { key: "faq",         label: "Questions (FAQ)",                 top: true },
  { key: "footer",      label: "Footer",                          top: true, noVerdict: true },
  { key: "calc-popup",  label: "Calculator popup",                only: "Shows only after someone opens the calculator", form: true },
];
export const ZONE_KEYS = ZONES.map((z) => z.key);
export const ZONE_BY_KEY = Object.fromEntries(ZONES.map((z) => [z.key, z]));
export const isZone = (v) => ZONE_KEYS.includes(String(v ?? ""));

export const CLICK_KINDS = ["link", "button", "field", "text", "image", "other"];

/* Fewer page loads than this and every verdict says "too few visits to say".
 * 30 is not magic. It is the point below which one person's odd visit moves a
 * percentage by more than 3 points, which is bigger than most of the gaps the
 * verdicts are reading. Printed on the screen, so nobody has to trust it blind. */
export const MIN_VIEWS = 30;

/* Clicks are stored as a share of their section, in thousandths (0–1000), and
 * counted in a 40 × 40 grid per section. 25 = 1000 / 40. */
export const GRID = 40;
export const CELL = 1000 / GRID;

/* ------------------------------------------------------------------ */
/* Cleaning what the page sends (used by /api/hs-heat)                 */
/* ------------------------------------------------------------------ */

const MAX_CLICKS_PER_POST = 40;

/* Text that reaches the database: control characters out (Postgres jsonb
 * refuses \u0000, which would lose the whole send), and anything shaped like
 * an email address or a phone number replaced. The page only ever sends its
 * own words, never visitor input — this is the second line, for a page that
 * one day does not behave. */
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/gi;
const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
export function safeText(v, max = 80) {
  // eslint-disable-next-line no-control-regex
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[phone]").slice(0, max);
}
const int = (v, lo, hi) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
};

/** Turn a landing page's POST body into the row the database will take, or
 * refuse it with a reason. Pure: no clock, no network.
 *
 * Returns { ok:true, row } or { ok:false, error }. */
export function cleanHeatPost(b = {}) {
  const page_slug = String(b.page_slug ?? "");
  if (!PAGE_SLUGS.includes(page_slug)) return { ok: false, error: "Unknown page." };
  const view_id = safeText(b.view_id, 40);
  const session_id = safeText(b.session_id, 120);
  if (!view_id || !/^[a-z0-9-]{6,40}$/i.test(view_id)) return { ok: false, error: "A view id is required." };
  if (!session_id || !/^[a-z0-9-]{2,120}$/i.test(session_id)) return { ok: false, error: "A session id is required." };
  const seqRaw = Number(b.seq);
  if (!Number.isInteger(seqRaw) || seqRaw < 1 || seqRaw > 1_000_000) return { ok: false, error: "A sequence number is required." };
  const seq = seqRaw;

  /* Sections: only names we know, only the two numbers we expect. An unknown
   * name is dropped, not refused — a page one release ahead of this console
   * must still be able to report the sections we DO know. */
  const zones = {};
  const zin = b.zones && typeof b.zones === "object" ? b.zones : {};
  for (const [k, v] of Object.entries(zin)) {
    if (!isZone(k)) continue;
    const arr = Array.isArray(v) ? v : [v?.r, v?.ms];
    const ms = int(arr[1], 0, 3_600_000) ?? 0;
    const r = arr[0] ? 1 : 0;
    /* Looked at for any time at all means it was reached. The page keeps
     * these two in step; this makes sure a hand-built body cannot say
     * "never reached, looked at for a minute". */
    zones[k] = { r: r || ms > 0 ? 1 : 0, ms };
  }

  const clicks = [];
  const cin = Array.isArray(b.clicks) ? b.clicks.slice(0, MAX_CLICKS_PER_POST) : [];
  const seen = new Set();
  for (const c of cin) {
    /* [cid, zone, x, y, target, kind, dead, rage, t]. cid is the click's own
     * number inside this page load: the page resends a click until the
     * server confirms it, and the database stores each (view, cid) once. */
    const a = Array.isArray(c) ? c : [c?.cid, c?.zone, c?.x, c?.y, c?.target, c?.kind, c?.dead, c?.rage, c?.t];
    const cid = int(a[0], 1, 100_000);
    if (!cid || seen.has(cid)) continue;
    const zone = String(a[1] ?? "");
    if (!isZone(zone)) continue;
    const x = int(a[2], 0, 1000);
    const y = int(a[3], 0, 1000);
    if (x === null || y === null) continue;
    seen.add(cid);
    const kind = CLICK_KINDS.includes(String(a[5])) ? String(a[5]) : "other";
    clicks.push({
      cid, zone, x_pm: x, y_pm: y, target: safeText(a[4], 80), kind,
      dead: !!a[6], rage: !!a[7],
      t_ms: int(a[8], 0, 86_400_000),
    });
  }

  return {
    ok: true,
    row: {
      view_id, session_id, page_slug, seq,
      /* How long ago the page loaded, by the page's own stopwatch — not its
       * clock, which can be wrong. The database subtracts it from now(). */
      age_ms: int(b.age_ms, 0, 86_400_000) ?? 0,
      path: safeText(b.path, 300),
      device: DEVICES.includes(String(b.device)) ? String(b.device) : null,
      viewport_w: int(b.vw, 0, 10000),
      viewport_h: int(b.vh, 0, 10000),
      doc_h: int(b.doc_h, 0, 200000),
      max_scroll_pct: int(b.max_scroll, 0, 100) ?? 0,
      active_ms: int(b.active_ms, 0, 86_400_000) ?? 0,
      zones,
      clicks,
      utm_source: safeText(b.utm_source, 120),
      utm_medium: safeText(b.utm_medium, 120),
      utm_campaign: safeText(b.utm_campaign, 120),
      utm_content: safeText(b.utm_content, 120),
    },
  };
}

/* ------------------------------------------------------------------ */
/* The rollup — JS twin of hs_heat_rollup() in migration 0046          */
/* ------------------------------------------------------------------ */

const cmpC = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpNullFirst = (a, b) => (a == null ? (b == null ? 0 : -1) : b == null ? 1 : cmpC(a, b));

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length / 2;
  /* percentile_cont(0.5): the mean of the two middle values when even. */
  return s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2;
};

/** Filters every view (page load) the same way the SQL does.
 * `leadSessions` is a Set of session ids that became a lead on this page. */
function keepView(v, f, leadSessions) {
  if (v.page_slug !== f.slug) return false;
  const t = Date.parse(v.first_seen_at);
  if (f.fromMs != null && t < f.fromMs) return false;
  if (f.toMs != null && t >= f.toMs) return false;
  if (f.device && v.device !== f.device) return false;
  if (f.source && (v.utm_source || "") !== f.source) return false;
  if (f.content && (v.utm_content || "") !== f.content) return false;
  const lead = leadSessions.has(v.session_id);
  if (f.who === "leads" && !lead) return false;
  if (f.who === "not" && lead) return false;
  return true;
}

/** The same numbers hs_heat_rollup returns, from plain rows.
 *
 * views   hs_heat_sessions rows
 * clicks  hs_heat_clicks rows (view_id joins them to a view)
 * leadSessionIds  session ids in hs_lead_sources for this page
 * f       { slug, fromMs, toMs, device, source, content, who }
 */
export function rollupFromRows(views = [], clicks = [], leadSessionIds = [], f = {}) {
  const leadSet = new Set(leadSessionIds);
  const inDate = views.filter((v) => keepView(v, { ...f, device: null, source: null, content: null, who: "all" }, leadSet));
  const kept = views.filter((v) => keepView(v, f, leadSet));
  const keptIds = new Map(kept.map((v) => [v.view_id, v]));

  const zones = {};
  for (const v of kept) {
    for (const [k, z] of Object.entries(v.zones || {})) {
      const o = (zones[k] ||= { zone: k, reached: 0, ms_total: 0 });
      if (Number(z.r) === 1) o.reached += 1;
      o.ms_total += Number(z.ms) || 0;
    }
  }

  const scroll = [];
  for (let p = 10; p <= 100; p += 10) scroll.push(kept.filter((v) => (v.max_scroll_pct || 0) >= p).length);

  const grid = {};
  const targets = {};
  const zc = {};
  let total = 0, dead = 0, rage = 0;
  for (const c of clicks) {
    const v = keptIds.get(c.view_id);
    if (!v) continue;
    total += 1;
    if (c.dead) dead += 1;
    if (c.rage) rage += 1;
    const xb = Math.min(GRID - 1, Math.floor(c.x_pm / CELL));
    const yb = Math.min(GRID - 1, Math.floor(c.y_pm / CELL));
    const gk = `${c.zone}|${xb}|${yb}`;
    (grid[gk] ||= { zone: c.zone, xb, yb, n: 0, dead: 0 }).n += 1;
    if (c.dead) grid[gk].dead += 1;
    const tk = `${c.zone}|${c.target ?? ""}|${c.kind}`;
    const t = (targets[tk] ||= { zone: c.zone, target: c.target ?? null, kind: c.kind, n: 0, dead: 0, rage: 0, by_leads: 0 });
    t.n += 1;
    if (c.dead) t.dead += 1;
    if (c.rage) t.rage += 1;
    if (leadSet.has(v.session_id)) t.by_leads += 1;
    const z = (zc[c.zone] ||= { zone: c.zone, n: 0, dead: 0, deadViews: new Set(), by_leads: 0 });
    z.n += 1;
    if (c.dead) { z.dead += 1; z.deadViews.add(c.view_id); }
    if (leadSet.has(v.session_id)) z.by_leads += 1;
  }

  const countBy = (key) => {
    const m = {};
    for (const v of inDate) { const val = v[key] || ""; if (val) m[val] = (m[val] || 0) + 1; }
    return Object.entries(m).map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || (a.value < b.value ? -1 : 1));
  };

  const firsts = kept.map((v) => v.first_seen_at).sort();
  return {
    views: kept.length,
    sessions: new Set(kept.map((v) => v.session_id)).size,
    lead_views: kept.filter((v) => leadSet.has(v.session_id)).length,
    median_active_ms: median(kept.map((v) => v.active_ms || 0)),
    scroll,
    zones: Object.values(zones).sort((a, b) => (a.zone < b.zone ? -1 : 1)),
    clicks: { total, dead, rage },
    /* Per section, complete (targets below is capped at 200 rows). dead_views
     * is how many separate visits tapped something dead there — people, not
     * taps, so one person tapping five times counts once. */
    zclicks: Object.values(zc).map((z) => ({ zone: z.zone, n: z.n, dead: z.dead, dead_views: z.deadViews.size, by_leads: z.by_leads }))
      .sort((a, b) => cmpC(a.zone, b.zone)),
    grid: Object.values(grid).sort((a, b) => (a.zone < b.zone ? -1 : a.zone > b.zone ? 1 : a.xb - b.xb || a.yb - b.yb)),
    /* Same order as the SQL: most clicked first, then zone, target (none
     * first) and kind — compared by character code, which is what Postgres's
     * `collate "C"` does. localeCompare disagreed with it on capital letters. */
    targets: Object.values(targets).sort((a, b) => b.n - a.n || cmpC(a.zone, b.zone) || cmpNullFirst(a.target, b.target) || cmpC(a.kind, b.kind)).slice(0, 200),
    options: {
      devices: countBy("device"),
      sources: countBy("utm_source"),
      contents: countBy("utm_content"),
    },
    first_at: firsts[0] || null,
    last_at: firsts[firsts.length - 1] || null,
  };
}

/* ------------------------------------------------------------------ */
/* What the screen shows — derived from a rollup                       */
/* ------------------------------------------------------------------ */

const pct = (n, d) => (d > 0 ? (100 * n) / d : null);

/** Sections in the order they sit on the page. The picture's measured
 * positions win when we have them (a page can move a block); otherwise the
 * ZONES order, which is the template's order. */
export function orderedZones(layout) {
  const tops = layout?.zones || {};
  const idx = Object.fromEntries(ZONE_KEYS.map((k, i) => [k, i]));
  /* Measured sections first, by where they sit; then any we have no position
   * for, in the template's order. (Mixing the two in one comparison is not a
   * consistent sort — found by the tests on the first run.) */
  const has = (z) => tops[z.key]?.top != null;
  const measured = ZONES.filter(has).sort((a, b) => tops[a.key].top - tops[b.key].top || idx[a.key] - idx[b.key]);
  return [...measured, ...ZONES.filter((z) => !has(z))];
}

/** One row per section, with its numbers and what we think about it.
 *
 * `present` is the set of section keys this page actually has — a key the
 * page does not have (the hub's trade grid, on a trade page) is left out
 * rather than shown as a section nobody reached. It comes from the picture's
 * layout when there is one, otherwise from the sections the rollup saw. */
export function sectionRows(rollup, layout) {
  const views = rollup?.views || 0;
  const byZone = Object.fromEntries((rollup?.zones || []).map((z) => [z.zone, z]));
  const present = new Set(layout?.zones ? Object.keys(layout.zones) : Object.keys(byZone));
  for (const k of Object.keys(byZone)) present.add(k);

  const zc = Object.fromEntries((rollup?.zclicks || []).map((z) => [z.zone, z]));
  /* Shares are of the clicks ON THE PAGE ITSELF. The calculator popup and the
   * scan result only exist for some visitors, and a slider dragged twenty
   * times in the popup would otherwise shrink every other section's share. */
  let pageClicks = 0, pageLeadClicks = 0;
  for (const z of rollup?.zclicks || []) {
    if (ZONE_BY_KEY[z.zone]?.only) continue;
    pageClicks += z.n;
    pageLeadClicks += z.by_leads;
  }
  const rows = orderedZones(layout).filter((z) => present.has(z.key)).map((z) => {
    const m = byZone[z.key] || { reached: 0, ms_total: 0 };
    const c = zc[z.key] || { n: 0, dead: 0, dead_views: 0, by_leads: 0 };
    return {
      key: z.key, label: z.label, top: !!z.top, parent: z.parent || null, only: z.only || null, form: !!z.form,
      reached: m.reached,
      reachPct: z.only ? null : pct(m.reached, views),
      /* Seconds per person who got there, not per visit: a section half the
       * visitors never reached should not look boring because of them. */
      secs: m.reached > 0 ? m.ms_total / m.reached / 1000 : null,
      clicks: c.n,
      clickShare: z.only ? null : pct(c.n, pageClicks),
      dead: c.dead,
      deadViews: c.dead_views,
      leadClicks: c.by_leads,
      leadClickShare: z.only ? null : pct(c.by_leads, pageLeadClicks),
      dropAfter: null,
      verdicts: [],
    };
  });

  /* THE LADDER. Only top-level blocks, in page order. dropAfter is how many
   * points of visits were lost between this block and the next one. */
  const ladder = rows.filter((r) => r.top);
  for (let i = 0; i < ladder.length - 1; i += 1) {
    const a = ladder[i].reachPct, b = ladder[i + 1].reachPct;
    ladder[i].dropAfter = a != null && b != null ? Math.max(0, a - b) : null;
  }

  applyVerdicts(rows, views);
  return rows;
}

/* THE VERDICTS. Each one is a plain rule over the numbers in its own row, and
 * each carries the sentence that says which numbers tripped it — the screen
 * prints that sentence, so a verdict is never an unexplained opinion.
 * These are suggestions for CJ and Ryder to look at, not instructions. */
export const MIN_ZONE_CLICKS = 10;
export const RULES = {
  moveUp: `Fewer than 60% of visits get this far down, but it has at least ${MIN_ZONE_CLICKS} clicks and at least 15% of the page's clicks.`,
  leave: "The biggest fall in how far down people get happens right after this block, and it is at least 15 points. (It measures depth, not the moment they closed the tab.)",
  cut: "At least 30% of visits get this far, people spend under 3 seconds on it, and it gets under 2% of the page's clicks. Never said of a form, the top bar or the footer.",
  dead: "At least 5 separate visits tapped words or a picture here that do nothing, and that is at least 1 in 10 of the visits that got here. Only the 3 worst sections are listed.",
};

function applyVerdicts(rows, views) {
  if (views < MIN_VIEWS) {
    for (const r of rows) r.verdicts = [{ id: "few", label: "Too few visits to say", why: `Verdicts start at ${MIN_VIEWS} visits. This view has ${views}.` }];
    return;
  }
  const f1 = (x) => (x == null ? "—" : `${Math.round(x)}%`);
  const biggest = rows.filter((r) => r.top && r.dropAfter != null && !ZONE_BY_KEY[r.key]?.noVerdict)
    .reduce((m, r) => (m && m.dropAfter >= r.dropAfter ? m : r), null);

  for (const r of rows) {
    if (ZONE_BY_KEY[r.key]?.noVerdict) continue;
    const v = [];
    /* Lead clicks are NOT a trigger. Most clicks "by leads" happen after the
     * person has already become a lead (the scan asks for an email first), so
     * they say where leads go next, not what made them leads. Shown in the
     * table, never used to move a section. */
    if (r.reachPct != null && r.reachPct < 60 && r.clicks >= MIN_ZONE_CLICKS && (r.clickShare ?? 0) >= 15) {
      v.push({ id: "up", label: "Move it up", why: `Only ${f1(r.reachPct)} of visits get this far down, but it has ${r.clicks.toLocaleString("en-US")} clicks — ${f1(r.clickShare)} of the page's.` });
    }
    if (biggest && biggest.key === r.key && r.dropAfter >= 15) {
      v.push({ id: "leave", label: "Biggest drop-off", why: `${Math.round(r.dropAfter)} points fewer visits get past this block to the next one — the biggest fall on the page.` });
    }
    if (!r.form && r.reachPct != null && r.reachPct >= 30 && r.secs != null && r.secs < 3 && (r.clickShare ?? 0) < 2) {
      v.push({ id: "cut", label: "Cut or shorten", why: `${f1(r.reachPct)} of visits get this far, they spend ${r.secs.toFixed(1)} seconds on it, and it gets ${f1(r.clickShare)} of the page's clicks.` });
    }
    const base = r.reached;
    if (r.deadViews >= 5 && base > 0 && r.deadViews >= 0.1 * base) {
      v.push({ id: "dead", label: "Fix: taps that do nothing", why: `${r.deadViews.toLocaleString("en-US")} visits (${f1(100 * r.deadViews / base)} of those who got here) tapped words or a picture here that is not a link. People expect it to do something.` });
    }
    r.verdicts = v;
  }
  /* Only the three worst do-nothing sections keep the flag, so the list stays
   * about the page's real problems and not every picture on it. */
  const deadRows = rows.filter((r) => r.verdicts.some((v) => v.id === "dead")).sort((a, b) => b.deadViews / b.reached - a.deadViews / a.reached);
  for (const r of deadRows.slice(3)) r.verdicts = r.verdicts.filter((v) => v.id !== "dead");
  for (const r of rows) {
    if (ZONE_BY_KEY[r.key]?.noVerdict) continue;
    if (!r.verdicts.length) r.verdicts = [{ id: "keep", label: "Keep", why: "Nothing in its numbers trips a rule." }];
  }
}

/** The headline figures. */
export function heatSummary(rollup) {
  const views = rollup?.views || 0;
  const scroll = rollup?.scroll || [];
  return {
    views,
    sessions: rollup?.sessions || 0,
    leadViews: rollup?.lead_views || 0,
    medianSecs: rollup?.median_active_ms != null && views > 0 ? rollup.median_active_ms / 1000 : null,
    bottomPct: pct(scroll[8] ?? 0, views),   // 90%+ of the page, the "got to the end" line
    halfPct: pct(scroll[4] ?? 0, views),
    clicks: rollup?.clicks?.total || 0,
    dead: rollup?.clicks?.dead || 0,
    rage: rollup?.clicks?.rage || 0,
    scrollCurve: scroll.map((n, i) => ({ depth: (i + 1) * 10, n, pct: pct(n, views) })),
  };
}

/** Where on the picture each grid cell lands, in the picture's own pixels.
 * A cell's position is a share of its section, so it is placed by that
 * section's measured box on the picture. A section the picture does not have
 * (the popup, a scan result) is not drawn — its clicks are still in the
 * tables. */
export function placeCells(grid = [], layout) {
  const out = [];
  let skipped = 0;
  for (const g of grid) {
    const box = layout?.zones?.[g.zone];
    if (!box || !box.width || !box.height) { skipped += g.n; continue; }
    out.push({
      x: box.left + ((g.xb + 0.5) * CELL / 1000) * box.width,
      y: box.top + ((g.yb + 0.5) * CELL / 1000) * box.height,
      n: g.n, dead: g.dead || 0, zone: g.zone,
    });
  }
  return { cells: out, skipped };
}

/** Plain words for a click target, for the table. */
export function targetLabel(t) {
  if (!t?.target) return t?.kind === "text" ? "Plain text (not a link)" : t?.kind === "image" ? "A picture (not a link)" : "Empty space";
  const s = String(t.target);
  if (s.startsWith("field:")) return `Typing box: ${s.slice(6)}`;
  return s;
}
