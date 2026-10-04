/* ==================================================================
 * META ADS — the maths behind the Meta page.  4 Oct 2026
 *
 * Ryder, 4 Oct 2026: "build a page on the admin called META that tracks
 * everything on these ads in a dashboard that i can click refresh to get
 * updated numbers … every campaign, set and ad … whats working, whats not …
 * a section to be the landing page and to show me where people are dropping
 * off … so that i can view, monitor and adjust to optimize and get more sales."
 *
 * Pure functions only — no network, no database. api/meta-ads.js fetches, this
 * file shapes, and tests/meta-ads checks it without any keys.
 *
 * THREE KINDS OF NUMBER ON THE PAGE, and every one carries its badge:
 *   meta      Meta's own reporting (spend, views, clicks, its pixel events).
 *             Meta estimates some of these and revises them for a few days.
 *   counted   rows OUR landing pages wrote (visits, form taps, emails, leads).
 *   derived   one of the above divided by another (CTR, cost per lead …).
 * Meta's "Leads" and ours are DIFFERENT numbers on purpose: Meta's comes from
 * its pixel and can be modelled; ours is a row in admin_leads. The page shows
 * both, side by side, labelled.
 *
 * NOTHING IS ZERO THAT IS REALLY "NO DATA". rate() returns null on an empty
 * bottom, same rule as lib/home-services.js.
 * ================================================================== */

export const DEFAULT_AD_ACCOUNT = "act_1691374768590142";
export const DEFAULT_GRAPH_VERSION = "v23.0";

/* A visit counts as "from Meta" when its utm_source is one of these. The ads
 * all carry utm_source=meta; the others are what Meta's own auto-tagging or a
 * hand-typed link might use. */
/* "an" and "msg" are what Meta's own {{site_source_name}} tag writes for the
 * Audience Network and Messenger. Matched without regard to case — nothing
 * lowercases utm_source when a page writes it (4 Oct 2026 review). */
export const META_SOURCES = ["meta", "facebook", "fb", "ig", "instagram", "an", "msg"];
export const isMetaSource = (v) => META_SOURCES.includes(String(v ?? "").trim().toLowerCase());

/* A tracking code with "test" in it is one of ours checking the funnel — it is
 * shown, but kept out of every total. (Ryder's 3 Oct check used
 * utm_campaign=hs-launch-oct26-test.) */
export const isTestCode = (code) => /(^|[-_])test($|[-_])/i.test(String(code ?? ""));

export function rate(top, bottom) {
  const t = Number(top);
  const b = Number(bottom);
  if (!Number.isFinite(t) || !Number.isFinite(b) || b <= 0) return null;
  return (t / b) * 100;
}

/* Money per thing. Null when there is nothing to divide by — "$12 spent, 0
 * leads" is not "$0 per lead" and it is not "infinite"; it is "no leads yet". */
export function costPer(spend, count) {
  const s = Number(spend);
  const c = Number(count);
  if (!Number.isFinite(s) || !Number.isFinite(c) || c <= 0) return null;
  return s / c;
}

const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const numOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/* ------------------------------------------------------------------ */
/* Meta's "actions" lists                                              */
/* ------------------------------------------------------------------ */

/* Meta reports most results as a list: [{ action_type, value }]. The same
 * thing can appear under two names (the pixel's "offsite_conversion.fb_pixel_lead"
 * and the merged "lead"), so each result names every alias and we take the
 * FIRST one present — never the sum, which would count one lead twice. */
export const ACTIONS = {
  linkClicks: ["link_click"],
  landingViews: ["landing_page_view", "omni_landing_page_view"],
  leads: ["offsite_conversion.fb_pixel_lead", "lead", "omni_lead"],
  checkouts: ["offsite_conversion.fb_pixel_initiate_checkout", "initiate_checkout", "omni_initiated_checkout"],
  purchases: ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"],
  scans: ["offsite_conversion.fb_pixel_custom.ScanCompleted", "offsite_conversion.custom.ScanCompleted"],
  videoViews3s: ["video_view"],
  engagements: ["post_engagement"],
  reactions: ["post_reaction"],
  comments: ["comment"],
  shares: ["post"],
  saves: ["onsite_conversion.post_save"],
};

export function actionValue(list, aliases) {
  if (!Array.isArray(list)) return null;
  for (const a of aliases) {
    const hit = list.find((x) => x && x.action_type === a);
    if (hit) return num(hit.value);
  }
  return null;
}

/* Video lists are [{ action_type: "video_view", value }] — one entry. */
const videoVal = (list) => (Array.isArray(list) && list.length ? num(list[0].value) : null);

/* One insights row from Meta → the flat numbers the page uses. */
export function normaliseInsight(row = {}) {
  const a = row.actions;
  const impressions = num(row.impressions);
  const linkClicks = row.inline_link_clicks != null ? num(row.inline_link_clicks) : actionValue(a, ACTIONS.linkClicks);
  const out = {
    adId: row.ad_id || null,
    adsetId: row.adset_id || null,
    campaignId: row.campaign_id || null,
    spend: num(row.spend),
    impressions,
    reach: numOrNull(row.reach),
    frequency: numOrNull(row.frequency),
    clicksAll: num(row.clicks),
    linkClicks: linkClicks ?? 0,
    landingViews: actionValue(a, ACTIONS.landingViews) ?? 0,
    metaLeads: actionValue(a, ACTIONS.leads),
    metaCheckouts: actionValue(a, ACTIONS.checkouts),
    metaPurchases: actionValue(a, ACTIONS.purchases),
    metaScans: actionValue(a, ACTIONS.scans),
    videoViews3s: actionValue(a, ACTIONS.videoViews3s),
    engagements: actionValue(a, ACTIONS.engagements),
    reactions: actionValue(a, ACTIONS.reactions),
    comments: actionValue(a, ACTIONS.comments),
    shares: actionValue(a, ACTIONS.shares),
    saves: actionValue(a, ACTIONS.saves),
    videoPlays: videoVal(row.video_play_actions),
    videoP25: videoVal(row.video_p25_watched_actions),
    videoP50: videoVal(row.video_p50_watched_actions),
    videoP75: videoVal(row.video_p75_watched_actions),
    videoP100: videoVal(row.video_p100_watched_actions),
    thruplays: videoVal(row.video_thruplay_watched_actions),
    videoAvgSec: videoVal(row.video_avg_time_watched_actions),
    qualityRanking: rankingOrNull(row.quality_ranking),
    engagementRanking: rankingOrNull(row.engagement_rate_ranking),
    conversionRanking: rankingOrNull(row.conversion_rate_ranking),
    dateStart: row.date_start || null,
    dateStop: row.date_stop || null,
  };
  return withRates(out);
}

/* Meta returns "UNKNOWN" until an ad has ~500 impressions. That is not a
 * ranking; it is "not enough data yet", and the page should say so. */
function rankingOrNull(v) {
  const s = String(v ?? "").trim();
  if (!s || s === "UNKNOWN") return null;
  return s;
}

export const RANKING_WORDS = {
  ABOVE_AVERAGE: "Above average",
  AVERAGE: "Average",
  BELOW_AVERAGE_35: "Below average (bottom 35%)",
  BELOW_AVERAGE_20: "Below average (bottom 20%)",
  BELOW_AVERAGE_10: "Below average (bottom 10%)",
};

/* Rates worked out from the counts — never taken from Meta's own ctr/cpc
 * fields, so a total row and an ad row are calculated the same way. */
export function withRates(m) {
  return {
    ...m,
    ctrLink: rate(m.linkClicks, m.impressions),
    ctrAll: rate(m.clicksAll, m.impressions),
    cpm: m.impressions > 0 ? (m.spend / m.impressions) * 1000 : null,
    cpcLink: costPer(m.spend, m.linkClicks),
    costPerLanding: costPer(m.spend, m.landingViews),
    loadRate: rate(m.landingViews, m.linkClicks),
    hookRate: m.videoViews3s == null ? null : rate(m.videoViews3s, m.impressions),
    holdRate: m.thruplays == null || m.videoViews3s == null ? null : rate(m.thruplays, m.videoViews3s),
  };
}

const SUM_FIELDS = [
  "spend", "impressions", "clicksAll", "linkClicks", "landingViews",
  "metaLeads", "metaCheckouts", "metaPurchases", "metaScans",
  "videoViews3s", "engagements", "reactions", "comments", "shares", "saves",
  "videoPlays", "videoP25", "videoP50", "videoP75", "videoP100", "thruplays",
];

/* Adds rows. A field that every row has as null stays null (nothing measured);
 * reach and frequency are NOT summed — two ads' reach overlaps, so the sum
 * would overstate how many different people saw anything. */
export function sumMetrics(rows = []) {
  const out = {};
  for (const f of SUM_FIELDS) {
    let any = false;
    let s = 0;
    for (const r of rows) {
      if (r && r[f] != null) { any = true; s += num(r[f]); }
    }
    out[f] = any ? s : (f === "spend" || f === "impressions" || f === "clicksAll" || f === "linkClicks" || f === "landingViews" ? 0 : null);
  }
  out.reach = null;
  out.frequency = null;
  return withRates(out);
}

/* ------------------------------------------------------------------ */
/* Which tracking code an ad sends people with                          */
/* ------------------------------------------------------------------ */

function paramFrom(str, key) {
  const s = String(str ?? "");
  const m = s.match(new RegExp(`(?:^|[?&#])${key}=([^&#]*)`, "i"));
  if (!m) return null;
  try { return decodeURIComponent(m[1].replace(/\+/g, " ")).trim() || null; } catch { return m[1].trim() || null; }
}

/* The ad's own link, wherever Meta keeps it on this kind of creative. */
export function adLink(creative = {}) {
  const c = creative || {};
  const oss = c.object_story_spec || {};
  const ld = oss.link_data || {};
  const vd = oss.video_data || {};
  const fromChild = Array.isArray(ld.child_attachments) ? ld.child_attachments.find((x) => x && x.link)?.link : null;
  const afs = c.asset_feed_spec || {};
  const fromFeed = Array.isArray(afs.link_urls) ? afs.link_urls.find((x) => x && x.website_url)?.website_url : null;
  return ld.link || vd.call_to_action?.value?.link || fromChild || fromFeed || c.link_url || null;
}

/* The utm_campaign an ad sends — from its "URL parameters" box first (that is
 * where every HS-Launch ad keeps it), else from the link itself. This is the
 * join between Meta's ads and our own page events. */
export function adCode(ad = {}) {
  const c = ad.creative || {};
  return paramFrom(ad.url_tags, "utm_campaign")
    || paramFrom(c.url_tags, "utm_campaign")
    || paramFrom(adLink(c), "utm_campaign")
    || null;
}

/* Which of our landing pages the ad points at, as a path. */
export function adPath(ad = {}) {
  const link = adLink(ad.creative || {});
  if (!link) return null;
  try { return new URL(link).pathname; } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Delivery status, in words                                           */
/* ------------------------------------------------------------------ */

export const STATUS_WORDS = {
  ACTIVE: { label: "Running", tone: "good" },
  PAUSED: { label: "Paused", tone: "dim" },
  CAMPAIGN_PAUSED: { label: "Campaign paused", tone: "dim" },
  ADSET_PAUSED: { label: "Ad set paused", tone: "dim" },
  PENDING_REVIEW: { label: "In review", tone: "warn" },
  IN_PROCESS: { label: "Processing", tone: "warn" },
  PREAPPROVED: { label: "Approved, starting", tone: "warn" },
  DISAPPROVED: { label: "Rejected by Meta", tone: "bad" },
  WITH_ISSUES: { label: "Has a problem", tone: "bad" },
  PENDING_BILLING_INFO: { label: "Billing problem", tone: "bad" },
  DELETED: { label: "Deleted", tone: "dim" },
  ARCHIVED: { label: "Archived", tone: "dim" },
};
export function statusWord(s) {
  return STATUS_WORDS[String(s ?? "").toUpperCase()] || { label: String(s || "Unknown").replace(/_/g, " ").toLowerCase(), tone: "dim" };
}

/* Meta budgets come back in cents, as strings. */
export const cents = (v) => (v == null || v === "" ? null : num(v) / 100);

/* ------------------------------------------------------------------ */
/* Our own landing-page rows, grouped by the ad that sent them          */
/* ------------------------------------------------------------------ */

/* The steps a visitor from an ad walks, in order. These are OUR events
 * (hs_page_events), counted in VISITS — one visit that fires an event twice is
 * one visit.
 *
 * "scan_start" is fired the moment somebody TAPS any box in the free-scan form
 * (Home-Services-LP/assets/site.js, the focus listener), not when a scan runs —
 * so it is labelled for what it is. The scan only runs once business name,
 * website AND email are filled in and the button is pressed: that is
 * "scan_email". */
export const AD_FUNNEL = [
  { event: "view", label: "Landed on the page", short: "Landed" },
  { event: "scroll_50", label: "Scrolled halfway down", short: "Read half", skippable: true },
  { event: "scan_start", label: "Tapped into the free-scan form", short: "Tapped form" },
  { event: "scan_email", label: "Gave their email and pressed Scan", short: "Gave email" },
  { event: "scan_complete", label: "Saw their score", short: "Saw score" },
  { event: "checkout_open", label: "Opened the checkout", short: "Checkout" },
  { event: "checkout_paid", label: "Pressed Pay (sent to Stripe)", short: "Pressed pay" },
];

export function sessionsWith(events, name) {
  return new Set((events || []).filter((e) => e && e.event === name).map((e) => e.session_id).filter(Boolean));
}

/* The funnel for a set of events. `ofTop` is share of everyone who landed;
 * `keptFromPrev` is share of the step before that made it to this one. A step
 * that people can SKIP (scrolling halfway — the form is at the top) can be
 * smaller than the next step, so "lost" there is never shown as a negative:
 * it says the step is skippable instead. */
export function adFunnel(events = []) {
  const top = sessionsWith(events, "view").size;
  let prevN = null;
  let prevLabel = null;
  let prevSkippable = false;
  return AD_FUNNEL.map((step, i) => {
    const n = sessionsWith(events, step.event).size;
    let lost = null;
    let note = null;
    if (i > 0 && prevN !== null && prevN > 0) {
      if (n <= prevN) lost = rate(prevN - n, prevN);
      else note = prevSkippable ? "more than the step before — that step can be skipped" : "more than the step before";
    }
    const row = { ...step, sessions: n, ofTop: i === 0 ? (top > 0 ? 100 : null) : rate(n, top), lost, note, prevSessions: i === 0 ? null : prevN, prevLabel: i === 0 ? null : prevLabel };
    /* A skippable step is compared from, but never compared TO from the next
     * real step — the next step is compared with the last non-skippable one. */
    if (!step.skippable) { prevN = n; prevLabel = step.label; prevSkippable = false; } else { prevSkippable = true; }
    return row;
  });
}

/* The worst single step in a funnel: the highest SHARE lost, ignoring
 * skippable steps and steps that started with too few people to mean anything.
 * Share, not head count — the first step always loses the most heads (most
 * people never touch anything), so ranking by heads would always point at the
 * top of the page and never at the form that actually turns people away. */
export function biggestDrop(funnel = [], minPeople = 10) {
  let best = null;
  let prev = null;
  for (const s of funnel) {
    if (s.skippable) continue;
    if (prev && prev.sessions >= minPeople && s.sessions <= prev.sessions) {
      const lost = prev.sessions - s.sessions;
      const pct = rate(lost, prev.sessions);
      if (!best || pct > best.pct) best = { from: prev.label, to: s.label, lostPeople: lost, pct, fromN: prev.sessions, toN: s.sessions };
    }
    prev = s;
  }
  return best;
}

/* Everything we counted for one tracking code (one ad), or for all of them. */
export function landingStats(events = [], leadSources = [], heat = []) {
  const views = (events || []).filter((e) => e && e.event === "view").length;
  /* A visitor is a visit that LANDED (has a view event) — the same number as
   * the funnel's first step and the daily chart, so the three always agree. */
  const sessions = sessionsWith(events, "view").size;
  const funnel = adFunnel(events);
  const at = (ev) => sessionsWith(events, ev).size;
  const leads = (leadSources || []).length;
  const checkouts = (leadSources || []).filter((l) => l && l.reached_checkout === true).length;
  const devices = {};
  for (const e of events || []) {
    if (!e || e.event !== "view") continue;
    const d = e.device || "unknown";
    devices[d] = (devices[d] || 0) + 1;
  }
  const h = heatStats(heat);
  return {
    views,
    sessions,
    readHalf: at("scroll_50"),
    tappedForm: at("scan_start"),
    gaveEmail: at("scan_email"),
    scansDone: at("scan_complete"),
    scansFailed: at("scan_failed"),
    checkoutOpens: at("checkout_open"),
    pressedPay: at("checkout_paid"),
    calcOpens: new Set((events || []).filter((e) => e && e.event === "cta_click" && /^calc/.test(String(e.cta || ""))).map((e) => e.session_id).filter(Boolean)).size,
    leads,
    leadCheckouts: checkouts,
    devices,
    funnel,
    leadRate: rate(leads, sessions),
    formTapRate: rate(at("scan_start"), sessions),
    emailFromTap: rate(at("scan_email"), at("scan_start")),
    ...h,
  };
}

/* What the heat-map rows (hs_heat_sessions, 0046) say about how people read. */
export function heatStats(heat = []) {
  const rows = (heat || []).filter(Boolean);
  if (!rows.length) return { heatViews: 0, medianScroll: null, medianActiveSec: null, bounced10s: null };
  const sorted = (arr) => arr.slice().sort((a, b) => a - b);
  const median = (arr) => {
    if (!arr.length) return null;
    const s = sorted(arr);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const scrolls = rows.map((r) => num(r.max_scroll_pct));
  const actives = rows.map((r) => num(r.active_ms) / 1000);
  return {
    heatViews: rows.length,
    medianScroll: median(scrolls),
    medianActiveSec: median(actives),
    /* Left inside 10 seconds of real activity, and never went past the top screen. */
    bounced10s: rate(rows.filter((r) => num(r.active_ms) < 10000 && num(r.max_scroll_pct) < 35).length, rows.length),
  };
}

/* Share of page loads that reached each section of the page, top to bottom.
 * `zoneList` is lib/heat-map.js ZONES (passed in so this file stays free of
 * the heat map's own imports). Only the top-level ladder is returned. */
export function sectionReach(heat = [], zoneList = []) {
  const rows = (heat || []).filter(Boolean);
  const ladder = zoneList.filter((z) => z.top && !z.noVerdict);
  return ladder.map((z) => {
    const reached = rows.filter((r) => r.zones && r.zones[z.key] && Number(r.zones[z.key].r) === 1);
    const secs = reached.map((r) => num(r.zones[z.key].ms) / 1000);
    return {
      key: z.key,
      label: z.label,
      reached: reached.length,
      pct: rate(reached.length, rows.length),
      avgSec: secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : null,
    };
  /* "Pick your trade" only exists on the hub page; on a trade page nobody can
   * reach it, and a 0% for it would read as a section everyone skips. */
  }).filter((z) => rows.length > 0 && (z.reached > 0 || z.key !== "trades"));
}

/* What people tapped, most first. `clicks` are hs_heat_clicks rows. */
export function topTargets(clicks = [], limit = 12) {
  const by = new Map();
  for (const c of clicks || []) {
    if (!c) continue;
    const key = c.target || `(${c.kind || "other"} in ${c.zone || "?"})`;
    const cur = by.get(key) || { target: key, zone: c.zone || null, clicks: 0, sessions: new Set() };
    cur.clicks += 1;
    if (c.session_id) cur.sessions.add(c.session_id);
    by.set(key, cur);
  }
  return [...by.values()]
    .map((x) => ({ target: x.target, zone: x.zone, clicks: x.clicks, sessions: x.sessions.size }))
    .sort((a, b) => b.sessions - a.sessions || b.clicks - a.clicks)
    .slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Putting it together                                                 */
/* ------------------------------------------------------------------ */

/* Builds campaign → ad set → ad, each level carrying Meta's numbers and our
 * own landing numbers, and the cost of each of our steps.
 *
 * inputs:
 *   campaigns, adsets, ads   Meta's objects (as the Graph API returns them)
 *   insights                 Meta's ad-level insights rows
 *   events, leadSources, heat  OUR rows, already cut to visits from Meta
 *   sales                    matched Stripe sales [{ code, ... }]
 */
export function buildTree({ campaigns = [], adsets = [], ads = [], insights = [], events = [], leadSources = [], heat = [], sales = [] } = {}) {
  const ins = new Map();
  for (const r of insights || []) {
    const n = normaliseInsight(r);
    if (n.adId) ins.set(n.adId, n);
  }
  const groupBy = (rows, key) => {
    const m = new Map();
    for (const r of rows || []) {
      const k = key(r) || "";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const evByCode = groupBy(events, (e) => String(e.utm_campaign || "").toLowerCase());
  const lsByCode = groupBy(leadSources, (l) => String(l.utm_campaign || "").toLowerCase());
  const hByCode = groupBy(heat, (h) => String(h.utm_campaign || "").toLowerCase());
  const salesByCode = groupBy(sales, (s) => String(s.code || "").toLowerCase());

  const usedCodes = new Set();
  /* A tracking code two ads share (Ads Manager's "Duplicate" copies the URL
   * parameters) cannot tell their visitors apart. Each such ad shows the
   * shared numbers with a flag, and every total above it counts the code
   * ONCE — never once per ad. */
  const codeUse = new Map();
  for (const ad of ads || []) {
    const k = String(adCode(ad) || "").toLowerCase();
    if (k) codeUse.set(k, (codeUse.get(k) || 0) + 1);
  }
  const landFor = (codes) => {
    const list = [...codes].filter(Boolean);
    if (!list.length) return null;
    const pick = (map) => list.flatMap((k) => map.get(k) || []);
    return landingStats(pick(evByCode), pick(lsByCode), pick(hByCode));
  };
  const salesFor = (codes) => [...codes].reduce((n, k) => n + (salesByCode.get(k) || []).length, 0);
  const adRows = (ads || []).map((ad) => {
    const code = adCode(ad);
    const key = String(code || "").toLowerCase();
    if (key) usedCodes.add(key);
    const m = ins.get(ad.id) || withRates({ ...emptyMetrics(), adId: ad.id });
    const land = key ? landFor([key]) : null;
    const adSales = key ? salesFor([key]) : 0;
    return {
      level: "ad",
      id: ad.id,
      name: ad.name,
      adsetId: ad.adset_id,
      campaignId: ad.campaign_id,
      status: ad.effective_status || ad.status,
      configuredStatus: ad.configured_status || ad.status,
      createdTime: ad.created_time || null,
      code,
      codeKey: key || null,
      sharedCode: key ? codeUse.get(key) > 1 : false,
      path: adPath(ad),
      creative: shapeCreative(ad.creative),
      issues: shapeIssues(ad),
      meta: m,
      land,
      sales: adSales,
      costs: costsFor(m.spend, land, adSales),
    };
  });

  const adsetRows = (adsets || []).map((s) => {
    const kids = adRows.filter((a) => a.adsetId === s.id);
    const codes = new Set(kids.map((a) => a.codeKey).filter(Boolean));
    return rollUp("adset", s, kids, codes, landFor, salesFor, {
      campaignId: s.campaign_id,
      optimization: s.optimization_goal || null,
      billing: s.billing_event || null,
      dailyBudget: cents(s.daily_budget),
      lifetimeBudget: cents(s.lifetime_budget),
      budgetLeft: cents(s.budget_remaining),
      start: s.start_time || null,
      end: s.end_time || null,
      targeting: shapeTargeting(s.targeting),
      learning: s.learning_stage_info?.status || null,
    });
  });

  const campaignRows = (campaigns || []).map((c) => {
    const kids = adsetRows.filter((s) => s.campaignId === c.id);
    const codes = new Set(kids.flatMap((x) => x.codes));
    return rollUp("campaign", c, kids, codes, landFor, salesFor, {
      objective: c.objective || null,
      dailyBudget: cents(c.daily_budget),
      lifetimeBudget: cents(c.lifetime_budget),
      budgetLeft: cents(c.budget_remaining),
      start: c.start_time || null,
      end: c.stop_time || null,
      bidStrategy: c.bid_strategy || null,
    });
  });

  /* Visits that came from Meta with a code no ad carries (an old link, a test,
   * a hand-shared URL). Shown on their own line, never merged into an ad. */
  const unmatchedCodes = [...new Set([...evByCode.keys(), ...lsByCode.keys()])]
    .filter((k) => !usedCodes.has(k))
    .map((k) => ({
      code: k || "(no utm_campaign)",
      test: isTestCode(k),
      land: landingStats(evByCode.get(k) || [], lsByCode.get(k) || [], hByCode.get(k) || []),
    }))
    .sort((a, b) => b.land.sessions - a.land.sessions);

  /* Every ad together, each code counted once — the "All ads" line. Visits
   * that no ad's code matches are NOT in here; they are in unmatchedCodes. */
  const adsLand = landFor(usedCodes) || landingStats([], [], []);
  const adsSales = salesFor(usedCodes);
  return { campaigns: campaignRows, adsets: adsetRows, ads: adRows, unmatchedCodes, adsLand, adsSales };
}

function emptyMetrics() {
  return {
    spend: 0, impressions: 0, reach: null, frequency: null, clicksAll: 0, linkClicks: 0, landingViews: 0,
    metaLeads: null, metaCheckouts: null, metaPurchases: null, metaScans: null,
    videoViews3s: null, engagements: null, reactions: null, comments: null, shares: null, saves: null,
    videoPlays: null, videoP25: null, videoP50: null, videoP75: null, videoP100: null, thruplays: null, videoAvgSec: null,
    qualityRanking: null, engagementRanking: null, conversionRanking: null,
  };
}

/* What each of OUR steps cost, for this ad's spend. */
export function costsFor(spend, land, sales = 0) {
  if (!land) return { perVisit: null, perEmail: null, perLead: null, perCheckout: null, perSale: costPer(spend, sales) };
  return {
    perVisit: costPer(spend, land.sessions),
    perEmail: costPer(spend, land.gaveEmail),
    perLead: costPer(spend, land.leads),
    perCheckout: costPer(spend, land.checkoutOpens),
    perSale: costPer(spend, sales),
  };
}

/* A campaign's or ad set's own landing numbers are worked out again from the
 * set of codes under it — not by adding its children — so a code two ads share
 * is counted once. */
function rollUp(level, obj, kids, codes, landFor, salesFor, extra) {
  const m = sumMetrics(kids.map((k) => k.meta));
  const land = landFor(codes);
  const sales = salesFor(codes);
  return {
    codes: [...codes],
    level,
    id: obj.id,
    name: obj.name,
    status: obj.effective_status || obj.status,
    configuredStatus: obj.configured_status || obj.status,
    ...extra,
    children: kids.map((k) => k.id),
    meta: m,
    land,
    sales,
    costs: costsFor(m.spend, land, sales),
  };
}

function shapeCreative(c = {}) {
  if (!c) return null;
  return {
    id: c.id || null,
    name: c.name || null,
    title: c.title || c.object_story_spec?.link_data?.name || c.object_story_spec?.video_data?.title || null,
    body: c.body || c.object_story_spec?.link_data?.message || c.object_story_spec?.video_data?.message || null,
    description: c.object_story_spec?.link_data?.description || c.object_story_spec?.video_data?.link_description || null,
    thumbnail: c.thumbnail_url || c.image_url || null,
    type: c.object_type || null,
    isVideo: !!(c.video_id || c.object_story_spec?.video_data),
    isCarousel: Array.isArray(c.object_story_spec?.link_data?.child_attachments) && c.object_story_spec.link_data.child_attachments.length > 1,
    cards: (c.object_story_spec?.link_data?.child_attachments || []).map((x) => ({ name: x.name || null, description: x.description || null, picture: x.picture || null })),
    cta: c.call_to_action_type || c.object_story_spec?.link_data?.call_to_action?.type || c.object_story_spec?.video_data?.call_to_action?.type || null,
    link: adLink(c),
  };
}

function shapeIssues(ad = {}) {
  const out = [];
  for (const i of ad.issues_info || []) {
    out.push({ kind: "issue", text: i.error_summary || i.error_message || "Meta flagged a problem", detail: i.error_message || null });
  }
  const fb = ad.ad_review_feedback;
  if (fb && typeof fb === "object") {
    for (const [group, items] of Object.entries(fb)) {
      if (items && typeof items === "object") {
        for (const [k, v] of Object.entries(items)) out.push({ kind: "review", text: `${k.replace(/_/g, " ")}`, detail: typeof v === "string" ? v : null, group });
      }
    }
  }
  return out;
}

function shapeTargeting(t = {}) {
  if (!t) return null;
  const geo = t.geo_locations || {};
  const places = [
    ...(geo.countries || []),
    ...((geo.regions || []).map((r) => r.name)),
    ...((geo.cities || []).map((c) => c.name)),
  ];
  const interests = [];
  for (const spec of t.flexible_spec || []) {
    for (const k of ["interests", "behaviors", "work_positions", "industries", "life_events"]) {
      for (const x of spec[k] || []) interests.push(x.name);
    }
  }
  return {
    places,
    ageMin: t.age_min ?? null,
    ageMax: t.age_max ?? null,
    genders: t.genders || null,
    interests,
    platforms: t.publisher_platforms || null,
    positions: [...(t.facebook_positions || []), ...(t.instagram_positions || [])],
    advantageAudience: t.targeting_automation?.advantage_audience === 1,
  };
}

/* ------------------------------------------------------------------ */
/* What is working and what is not — plain sentences                    */
/* ------------------------------------------------------------------ */

/* THE THRESHOLDS ARE OUR OWN RULES OF THUMB, not Meta's and not a benchmark
 * from anywhere. They are written here, in one place, so they can be argued
 * with and changed. Nothing below says "good" or "bad" about an ad with too
 * little data under it — it says "too early" instead. */
export const RULES = {
  minImpressionsToJudge: 1000,   // below this, CTR is noise
  minClicksToJudge: 20,          // below this, cost per visit is noise
  minVisitsToJudgeForm: 25,      // below this, a 0-lead result is not yet a verdict
  lowCtrPct: 1.0,                // link CTR under this with enough views = weak hook
  goodCtrPct: 2.5,
  lowLoadRatePct: 60,            // under this share of clicks reach the page = slow page / accidental taps
  highFrequency: 2.5,            // same people seeing it this many times = tired audience
  starvedSpendShare: 3,          // an "on" ad getting under 3% of spend is being starved by Meta
  stuckHours: 12,                // on, created this long ago, and still nothing delivered
};

/* Returns [{ tone: "good"|"bad"|"warn"|"info", title, body, adId? }] —
 * the "What's working / what's not" list at the top of the page. */
export function verdicts({ ads = [], total = null, land = null, funnel = [], nowMs = Date.now() } = {}) {
  const out = [];
  const live = ads.filter((a) => ["ACTIVE", "IN_PROCESS", "PENDING_REVIEW", "PREAPPROVED", "WITH_ISSUES", "DISAPPROVED"].includes(String(a.status)));
  const spendAll = num(total?.spend);
  const fmt$ = (v) => (v == null ? "—" : `$${v.toFixed(2)}`);
  const fmtPct = (v) => (v == null ? "—" : `${v.toFixed(1)}%`);

  for (const a of ads) {
    if (a.status === "DISAPPROVED") out.push({ tone: "bad", adId: a.id, title: `${a.name} was rejected by Meta`, body: a.issues[0]?.text ? `Meta says: ${a.issues[0].text}.` : "Open it in Ads Manager to see why." });
    else if (a.status === "WITH_ISSUES" || a.issues.some((i) => i.kind === "issue")) out.push({ tone: "bad", adId: a.id, title: `${a.name} has a problem`, body: a.issues[0]?.text || "Meta flagged an issue on this ad." });
  }

  /* Best ad on cost per visit, among ads with enough clicks to mean anything. */
  const judged = ads.filter((a) => a.meta.linkClicks >= RULES.minClicksToJudge && a.meta.spend > 0);
  if (judged.length >= 2) {
    const byVisit = judged.slice().sort((x, y) => (x.meta.costPerLanding ?? 1e9) - (y.meta.costPerLanding ?? 1e9));
    const best = byVisit[0];
    out.push({ tone: "good", adId: best.id, title: `Cheapest visits: ${best.name}`, body: `${fmt$(best.meta.costPerLanding)} per landing-page view, ${fmtPct(best.meta.ctrLink)} of people who see it click. Meta's numbers.` });
    const worst = byVisit[byVisit.length - 1];
    if (worst.id !== best.id && worst.meta.costPerLanding != null && best.meta.costPerLanding != null && worst.meta.costPerLanding > best.meta.costPerLanding * 1.5) {
      out.push({ tone: "warn", adId: worst.id, title: `Most expensive visits: ${worst.name}`, body: `${fmt$(worst.meta.costPerLanding)} per landing-page view — more than 1.5× the best ad.` });
    }
  }

  /* Leads: the result that matters. */
  const withLeads = ads.filter((a) => a.land && a.land.leads > 0);
  if (withLeads.length) {
    const best = withLeads.slice().sort((x, y) => (x.costs.perLead ?? 1e9) - (y.costs.perLead ?? 1e9))[0];
    out.push({ tone: "good", adId: best.id, title: `Cheapest leads: ${best.name}`, body: `${best.land.leads} lead${best.land.leads === 1 ? "" : "s"} at ${fmt$(best.costs.perLead)} each (our own count of emails, not Meta's).` });
  }

  for (const a of ads) {
    const m = a.meta;
    if (m.impressions >= RULES.minImpressionsToJudge && m.ctrLink != null && m.ctrLink < RULES.lowCtrPct) {
      out.push({ tone: "bad", adId: a.id, title: `${a.name}: people scroll past it`, body: `Only ${fmtPct(m.ctrLink)} of ${m.impressions.toLocaleString("en-US")} views clicked. The first second of the picture or video is not stopping people.` });
    }
    if (m.linkClicks >= RULES.minClicksToJudge && m.loadRate != null && m.loadRate < RULES.lowLoadRatePct) {
      out.push({ tone: "warn", adId: a.id, title: `${a.name}: clicks that never see the page`, body: `${m.linkClicks} clicks but only ${m.landingViews} page loads (${fmtPct(m.loadRate)}). Either the page is slow on phones, or the taps were accidental.` });
    }
    if (m.frequency != null && m.frequency >= RULES.highFrequency) {
      out.push({ tone: "warn", adId: a.id, title: `${a.name}: the same people keep seeing it`, body: `Each person has seen it ${m.frequency.toFixed(1)} times on average. Results usually fall from here — a fresh version helps.` });
    }
    if (a.meta.qualityRanking && /^BELOW/.test(a.meta.qualityRanking)) {
      out.push({ tone: "warn", adId: a.id, title: `${a.name}: Meta rates its quality low`, body: `${RANKING_WORDS[a.meta.qualityRanking] || a.meta.qualityRanking} compared with ads chasing the same people.` });
    }
  }

  /* Starved: switched on, but Meta gives it almost nothing. */
  if (spendAll > 5 && live.length > 2) {
    const starved = live.filter((a) => a.status === "ACTIVE" && rate(a.meta.spend, spendAll) < RULES.starvedSpendShare);
    if (starved.length) {
      out.push({ tone: "info", title: `${starved.length} ad${starved.length === 1 ? " is" : "s are"} on but getting almost no money`, body: `${starved.map((a) => a.name.split("·")[0].trim()).join(", ")} — under ${RULES.starvedSpendShare}% of spend each. Meta has picked other ads. That is normal; it is not a fault. If they stay starved after day 3, turning them off changes nothing — they are not spending.` });
    }
  }
  const stuck = ads.filter((a) => a.status === "ACTIVE" && a.meta.impressions === 0 && a.createdTime && nowMs - Date.parse(a.createdTime) > RULES.stuckHours * 3600e3);
  for (const a of stuck) out.push({ tone: "warn", adId: a.id, title: `${a.name}: switched on, nothing delivered`, body: `On for more than ${RULES.stuckHours} hours with no views in this date range. Open it in Ads Manager and check the delivery column.` });

  /* The landing page. */
  if (land && land.sessions >= RULES.minVisitsToJudgeForm) {
    if (land.leads === 0) {
      out.push({ tone: "bad", title: `${land.sessions} people from the ads, 0 leads`, body: `The ads are bringing people. The page is not turning them into leads yet — see "Where people drop off" below.` });
    }
    const drop = biggestDrop(funnel);
    if (drop && drop.pct != null && drop.pct >= 50) {
      out.push({ tone: "bad", title: `Biggest leak: ${drop.from.toLowerCase()} → ${drop.to.toLowerCase()}`, body: `${drop.fromN} reached "${drop.from}", only ${drop.toN} got to "${drop.to}" — ${drop.pct.toFixed(0)}% lost at this one step.` });
    }
    if (land.tappedForm >= 10 && land.emailFromTap != null && land.emailFromTap < 20) {
      out.push({ tone: "bad", title: "People start the form and stop", body: `${land.tappedForm} tapped into the free-scan form; ${land.gaveEmail} filled it in. The form asks for business name, website AND email before it shows anything.` });
    }
    if (land.scansFailed > 0) {
      out.push({ tone: "warn", title: `${land.scansFailed} scan${land.scansFailed === 1 ? "" : "s"} failed`, body: "The free scan could not read their site or timed out. Each of these is a person who did everything right and got an error." });
    }
  } else if (land && land.sessions > 0) {
    out.push({ tone: "info", title: "Too early to judge the page", body: `${land.sessions} visits from the ads so far. The page verdicts start at ${RULES.minVisitsToJudgeForm}.` });
  }

  const order = { bad: 0, warn: 1, good: 2, info: 3 };
  return out.sort((x, y) => order[x.tone] - order[y.tone]);
}

/* ------------------------------------------------------------------ */
/* Sales — Stripe, matched back to an ad where we can                   */
/* ------------------------------------------------------------------ */

/* AI Pulse is $99 a month or $990 a year (CJ, 25 Sep 2026). A subscription is
 * counted as an AI Pulse sale when one of its prices is either amount on a
 * recurring plan. */
export const PULSE_AMOUNTS_CENTS = [9900, 99000];

export function isPulseSubscription(sub = {}) {
  const items = sub?.items?.data || [];
  return items.some((it) => {
    const p = it?.price || {};
    return p.recurring && PULSE_AMOUNTS_CENTS.includes(Number(p.unit_amount));
  });
}

/* Stripe does not know which ad a buyer came from — the checkout does not
 * carry the tracking code. So a sale is matched to an ad through the LEAD:
 * same email, or same website, as a lead that came in from that ad. A sale
 * that matches nothing is still counted, under "not matched". */
export function matchSales(subs = [], metaLeads = []) {
  const byEmail = new Map();
  const byDomain = new Map();
  for (const l of metaLeads || []) {
    if (l.email) byEmail.set(String(l.email).toLowerCase(), l);
    if (l.domain) byDomain.set(String(l.domain).toLowerCase().replace(/^www\./, ""), l);
  }
  return (subs || []).map((s) => {
    const email = String(s.email || "").toLowerCase() || null;
    const domain = String(s.domain || "").toLowerCase().replace(/^www\./, "") || null;
    const lead = (email && byEmail.get(email)) || (domain && byDomain.get(domain)) || null;
    return { ...s, code: lead?.utm_campaign || null, leadId: lead?.lead_id || null, matchedBy: lead ? (email && byEmail.get(email) ? "email" : "website") : null };
  });
}

/* ------------------------------------------------------------------ */
/* Days                                                                 */
/* ------------------------------------------------------------------ */

/* Meta's daily rows → the page's chart rows, with our own leads per day laid
 * beside them. `ourDaily` is { "YYYY-MM-DD": { visits, leads } }. */
export function dailyRows(metaDaily = [], ourDaily = {}) {
  const days = new Map();
  for (const r of metaDaily || []) {
    const n = normaliseInsight(r);
    const d = n.dateStart;
    if (!d) continue;
    days.set(d, { day: d, spend: n.spend, impressions: n.impressions, linkClicks: n.linkClicks, landingViews: n.landingViews });
  }
  for (const [d, v] of Object.entries(ourDaily || {})) {
    const cur = days.get(d) || { day: d, spend: 0, impressions: 0, linkClicks: 0, landingViews: 0 };
    days.set(d, { ...cur, visits: v.visits || 0, leads: v.leads || 0 });
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((r) => ({ visits: 0, leads: 0, ...r }));
}

/* Breakdown rows (placement, age, gender …) → sorted, with rates. */
export function breakdownRows(rows = [], keyFields = []) {
  return (rows || []).map((r) => {
    const n = normaliseInsight(r);
    const label = keyFields.map((k) => String(r[k] ?? "").replace(/_/g, " ")).filter(Boolean).join(" · ") || "unknown";
    return { label, ...n };
  }).sort((a, b) => b.spend - a.spend);
}

/* Budget pace for a lifetime budget: how much of the money is gone versus how
 * much of the time is gone. Null when the campaign has no lifetime budget or
 * no end date. */
export function budgetPace({ lifetimeBudget, budgetLeft, start, end, nowMs = Date.now() }) {
  if (!lifetimeBudget || !start || !end) return null;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  const spent = budgetLeft == null ? null : lifetimeBudget - budgetLeft;
  const timePct = Math.max(0, Math.min(100, ((nowMs - s) / (e - s)) * 100));
  const daysLeft = Math.max(0, (e - nowMs) / 86400e3);
  return {
    spent,
    spentPct: spent == null ? null : rate(spent, lifetimeBudget),
    timePct,
    daysLeft,
    perDayLeft: budgetLeft == null || daysLeft <= 0 ? null : budgetLeft / daysLeft,
  };
}
