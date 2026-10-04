/* GET /api/meta-ads?from=YYYY-MM-DD&to=YYYY-MM-DD[&refresh=1]
 *
 * THE META PAGE'S ONE READ — 4 Oct 2026. Owners only (ad spend is money).
 *
 * Three sources, read at the same moment for the same days:
 *   1. META        campaigns, ad sets, ads and their numbers, from the Marketing
 *                  API with a READ-ONLY token (ads_read). This endpoint never
 *                  writes to Meta: it cannot pause, edit or spend anything.
 *   2. OUR PAGES   hs_page_events, hs_lead_sources, hs_heat_sessions and
 *                  hs_heat_clicks — only the visits that came from Meta
 *                  (utm_source = meta / facebook / ig …).
 *   3. STRIPE      new AI Pulse subscriptions in the same days, matched back to
 *                  a Meta lead by email or website where we can.
 * Any one of them can be missing (no token yet, no Stripe key); the page then
 * says which, and the other two still draw.
 *
 * Env:
 *   META_ACCESS_TOKEN    system-user token with ads_read on the ad account
 *   META_AD_ACCOUNT_ID   optional, defaults to act_1691374768590142
 *   META_GRAPH_VERSION   optional, defaults to v23.0
 *
 * The answer is kept for 60 seconds per date range so a page left open does
 * not hammer Meta's rate limit; "Refresh" (refresh=1) skips that.
 */

import { requireMember, getAdminSupabase } from "../lib/supabase-server.js";
import { normalizeRange, rangeToInstants, addDays } from "../lib/money-range.js";
import { teamDate } from "../lib/brain-context.js";
import { getStripe, isStripeConfigured } from "../lib/stripe-server.js";
import { ZONES } from "../lib/heat-map.js";
import {
  DEFAULT_AD_ACCOUNT, DEFAULT_GRAPH_VERSION, META_SOURCES, isTestCode,
  buildTree, sumMetrics, landingStats, verdicts, dailyRows, breakdownRows, normaliseInsight,
  sectionReach, topTargets, isPulseSubscription, matchSales, budgetPace,
} from "../lib/meta-ads.js";

const CACHE_MS = 60_000;

/* utm_source is stored exactly as the link wrote it ("meta", "Meta",
 * "facebook" …), so match each Meta name without regard to case. */
const SOURCE_OR = META_SOURCES.map((x) => `utm_source.ilike.${x}`).join(",");
const cache = new Map();
const PAGE = 1000;

/* ------------------------------------------------------------------ */
/* Meta                                                                 */
/* ------------------------------------------------------------------ */

const AD_FIELDS = [
  "id", "name", "adset_id", "campaign_id", "status", "effective_status", "configured_status",
  "created_time", "issues_info", "ad_review_feedback",
  "creative{id,name,title,body,thumbnail_url,image_url,video_id,object_type,call_to_action_type,url_tags,object_story_spec,asset_feed_spec}",
].join(",");
const ADSET_FIELDS = [
  "id", "name", "campaign_id", "status", "effective_status", "configured_status",
  "optimization_goal", "billing_event", "daily_budget", "lifetime_budget", "budget_remaining",
  "start_time", "end_time", "targeting", "learning_stage_info",
].join(",");
const CAMPAIGN_FIELDS = [
  "id", "name", "objective", "status", "effective_status", "configured_status",
  "daily_budget", "lifetime_budget", "budget_remaining", "start_time", "stop_time", "bid_strategy",
].join(",");
const INSIGHT_FIELDS = [
  "campaign_id", "adset_id", "ad_id", "ad_name",
  "spend", "impressions", "reach", "frequency", "clicks", "inline_link_clicks", "actions",
  "video_play_actions", "video_p25_watched_actions", "video_p50_watched_actions",
  "video_p75_watched_actions", "video_p100_watched_actions", "video_thruplay_watched_actions",
  "video_avg_time_watched_actions",
  "quality_ranking", "engagement_rate_ranking", "conversion_rate_ranking",
].join(",");
const LIGHT_FIELDS = "spend,impressions,reach,clicks,inline_link_clicks,actions";

class MetaError extends Error {
  constructor(message, { code = null, kind = "error" } = {}) {
    super(message);
    this.code = code;
    this.kind = kind;
  }
}

/* One Graph call, following "next" pages. The token goes in a header, never
 * in a URL that could end up in a log. */
async function graphAll(base, path, params, token, maxPages = 20) {
  const u = new URL(`${base}/${path}`);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  let url = u.toString();
  const rows = [];
  let single = null;
  for (let i = 0; i < maxPages && url; i++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const e = j.error || {};
      const code = e.code ?? r.status;
      if (code === 190) throw new MetaError("Meta refused the access token — it has expired or been revoked. Make a new one (SETUP.md → Meta page).", { code, kind: "token" });
      if (code === 200 || code === 10 || (code === 100 && /permission/i.test(e.message || ""))) throw new MetaError(`The token cannot read this ad account (${e.message || "no permission"}). It needs ads_read on ${DEFAULT_AD_ACCOUNT}.`, { code, kind: "permission" });
      if (code === 4 || code === 17 || code === 613 || code === 80004) throw new MetaError("Meta's rate limit for this ad account is full. Wait a few minutes and press Refresh.", { code, kind: "rate" });
      throw new MetaError(`Meta answered with an error: ${e.message || `HTTP ${r.status}`}`, { code });
    }
    if (Array.isArray(j.data)) {
      rows.push(...j.data);
      url = j.paging?.next || null;
    } else {
      single = j;
      url = null;
    }
  }
  return single || rows;
}

async function readMeta(range, token) {
  const version = process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
  const base = `https://graph.facebook.com/${version}`;
  let acct = String(process.env.META_AD_ACCOUNT_ID || DEFAULT_AD_ACCOUNT).trim();
  if (!acct.startsWith("act_")) acct = `act_${acct}`;
  const time_range = { since: range.from, until: range.to };
  const statuses = ["ACTIVE", "PAUSED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES", "ARCHIVED"];
  const filtering = [{ field: "effective_status", operator: "IN", value: statuses }];

  /* The status filter is ONLY sent for ads: CAMPAIGN_PAUSED, PENDING_REVIEW,
   * DISAPPROVED … are ad statuses, and campaigns/ad sets refuse a filter that
   * names them. Campaigns and ad sets come back unfiltered (deleted ones are
   * never returned by these edges anyway). */
  const core = await Promise.all([
    graphAll(base, acct, { fields: "name,currency,timezone_name,account_status,amount_spent,spend_cap,disable_reason" }, token),
    graphAll(base, `${acct}/campaigns`, { fields: CAMPAIGN_FIELDS, limit: "200" }, token),
    graphAll(base, `${acct}/adsets`, { fields: ADSET_FIELDS, limit: "200" }, token),
    graphAll(base, `${acct}/ads`, { fields: AD_FIELDS, limit: "200", filtering }, token),
    graphAll(base, `${acct}/insights`, { level: "ad", fields: INSIGHT_FIELDS, time_range, limit: "500" }, token),
  ]);
  /* The extras are allowed to fail on their own — a breakdown Meta will not
   * answer must not blank the campaigns, ads and spend above it. */
  const extras = await Promise.allSettled([
    graphAll(base, `${acct}/insights`, { level: "account", fields: LIGHT_FIELDS, time_range, time_increment: "1", limit: "500" }, token),
    graphAll(base, `${acct}/insights`, { level: "account", fields: LIGHT_FIELDS, time_range, breakdowns: "publisher_platform,platform_position", limit: "500" }, token),
    graphAll(base, `${acct}/insights`, { level: "account", fields: LIGHT_FIELDS, time_range, breakdowns: "age,gender", limit: "500" }, token),
    graphAll(base, `${acct}/insights`, { level: "account", fields: LIGHT_FIELDS, time_range, breakdowns: "impression_device", limit: "500" }, token),
  ]);
  const [account, campaigns, adsets, ads, insights] = core;
  const val = (r) => (r.status === "fulfilled" && Array.isArray(r.value) ? r.value : []);
  const extraErrors = extras.filter((r) => r.status === "rejected").map((r) => r.reason?.message || String(r.reason));
  return { account, campaigns, adsets, ads, insights, daily: val(extras[0]), placements: val(extras[1]), ages: val(extras[2]), devices: val(extras[3]), extraErrors, version, acct };
}

/* ------------------------------------------------------------------ */
/* Our own rows                                                         */
/* ------------------------------------------------------------------ */

const MAX_ROWS = 50_000;
async function readPaged(q) {
  const rows = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await q().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
  throw new Error(`more than ${MAX_ROWS.toLocaleString("en-US")} rows in this range — pick fewer days`);
}

async function readOurs(admin, fromIso, toIso) {
  const out = { events: [], leadSources: [], heat: [], clicks: [], leads: [], errors: [] };
  try {
    out.events = await readPaged(() => admin.from("hs_page_events")
      .select("page_slug, event, session_id, cta, device, utm_source, utm_campaign, utm_content, created_at")
      .or(SOURCE_OR)
      .gte("created_at", fromIso).lt("created_at", toIso)
      .order("created_at", { ascending: true }));
  } catch (e) { out.errors.push(`page events: ${e.message}`); }
  try {
    out.leadSources = await readPaged(() => admin.from("hs_lead_sources")
      .select("lead_id, page_slug, session_id, utm_source, utm_campaign, utm_content, converted_at, reached_checkout, paid")
      .or(SOURCE_OR)
      .gte("converted_at", fromIso).lt("converted_at", toIso)
      .order("converted_at", { ascending: false }));
  } catch (e) { out.errors.push(`lead sources: ${e.message}`); }
  try {
    out.heat = await readPaged(() => admin.from("hs_heat_sessions")
      .select("view_id, session_id, page_slug, device, max_scroll_pct, active_ms, zones, click_count, utm_source, utm_campaign, first_seen_at")
      .or(SOURCE_OR)
      .gte("first_seen_at", fromIso).lt("first_seen_at", toIso)
      .order("first_seen_at", { ascending: true }).order("view_id", { ascending: true }));
  } catch (e) { out.errors.push(`heat map: ${e.message}`); }
  const viewIds = out.heat.map((h) => h.view_id);
  for (let i = 0; i < viewIds.length; i += 200) {
    const chunk = viewIds.slice(i, i + 200);
    try {
      /* Paged too: one busy chunk of page loads can hold more than the
       * 1,000 rows PostgREST answers with at once. */
      out.clicks.push(...await readPaged(() => admin.from("hs_heat_clicks")
        .select("view_id, session_id, zone, target, kind")
        .in("view_id", chunk)
        .order("id", { ascending: true })));
    } catch (e) { out.errors.push(`heat clicks: ${e.message}`); break; }
  }
  const ids = out.leadSources.map((l) => l.lead_id);
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await admin.from("admin_leads")
      .select("id, name, company, domain, email, phone, created_at")
      .in("id", ids.slice(i, i + 100));
    if (error) { out.errors.push(`leads: ${error.message}`); break; }
    out.leads.push(...(data || []));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Stripe                                                               */
/* ------------------------------------------------------------------ */

async function readSales(fromMs, toMs) {
  if (!isStripeConfigured()) return { ok: false, why: "STRIPE_SECRET_KEY is not set on this console, so sales cannot be read.", subs: [] };
  const stripe = getStripe();
  const subs = [];
  try {
    for await (const s of stripe.subscriptions.list({
      status: "all",
      created: { gte: Math.floor(fromMs / 1000), lt: Math.floor(toMs / 1000) },
      expand: ["data.customer"],
      limit: 100,
    })) {
      if (!isPulseSubscription(s)) continue;
      /* A checkout where the card failed or was abandoned leaves an
       * "incomplete" subscription behind. That is not a sale. */
      if (s.status === "incomplete" || s.status === "incomplete_expired") continue;
      const cust = s.customer && typeof s.customer === "object" ? s.customer : {};
      const price = s.items?.data?.[0]?.price || {};
      subs.push({
        id: s.id,
        created: new Date(s.created * 1000).toISOString(),
        status: s.status,
        email: cust.email || null,
        name: cust.name || null,
        domain: s.metadata?.domain || cust.metadata?.domain || null,
        business: s.metadata?.business || cust.metadata?.business || null,
        amount: (Number(price.unit_amount) || 0) / 100,
        interval: price.recurring?.interval || null,
      });
      if (subs.length >= 500) break;
    }
  } catch (e) {
    return { ok: false, why: `Stripe answered with an error: ${e.message}`, subs };
  }
  return { ok: true, subs };
}

/* ------------------------------------------------------------------ */

function ourDaily(events, leadSources) {
  const by = {};
  const seen = new Set();
  for (const e of events) {
    if (e.event !== "view" || isTestCode(e.utm_campaign)) continue;
    const d = teamDate(Date.parse(e.created_at));
    const k = `${d}|${e.session_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    by[d] = by[d] || { visits: 0, leads: 0 };
    by[d].visits += 1;
  }
  for (const l of leadSources) {
    if (isTestCode(l.utm_campaign)) continue;
    const d = teamDate(Date.parse(l.converted_at));
    by[d] = by[d] || { visits: 0, leads: 0 };
    by[d].leads += 1;
  }
  return by;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req, ["owner"]);
  if (!member) return res.status(401).json({ error: "Owners only." });
  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "The server is missing its database key." });

  const today = teamDate(Date.now());
  const q = req.query || {};
  const range = normalizeRange({ from: q.from, to: q.to }, today);
  /* Meta keeps insights for 37 months; ask for older and the whole Meta block
   * fails. Clamp quietly — nothing ran that long ago anyway. */
  const oldest = addDays(today, -1095);
  if (range.from < oldest) range.from = oldest;
  const key = `${range.from}|${range.to}`;
  const hit = cache.get(key);
  if (hit && q.refresh !== "1" && Date.now() - hit.at < CACHE_MS) {
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({ ...hit.body, cached: true });
  }

  const started = Date.now();
  const w = rangeToInstants(range);
  const fromIso = new Date(w.fromMs).toISOString();
  const toIso = new Date(w.toMs).toISOString();
  const token = String(process.env.META_ACCESS_TOKEN || "").trim();

  const [metaRes, ours, salesRes] = await Promise.all([
    token
      ? readMeta(range, token).then((m) => ({ ok: true, m })).catch((e) => ({ ok: false, error: e.message, kind: e.kind || "error", code: e.code ?? null }))
      : Promise.resolve({ ok: false, kind: "missing", error: "META_ACCESS_TOKEN is not set in Vercel yet, so Meta's own numbers cannot be read. Everything from our landing pages below is still live." }),
    readOurs(admin, fromIso, toIso).catch((e) => ({ events: [], leadSources: [], heat: [], clicks: [], leads: [], errors: [e.message] })),
    readSales(w.fromMs, w.toMs),
  ]);

  /* Test visits stay on the page (in "not matched to an ad") but out of totals. */
  const real = (r) => !isTestCode(r.utm_campaign);
  const leadById = Object.fromEntries((ours.leads || []).map((l) => [l.id, l]));
  const metaLeadRows = ours.leadSources.map((s) => ({ ...s, ...(leadById[s.lead_id] || {}), lead_id: s.lead_id }));
  const matched = matchSales(salesRes.subs || [], metaLeadRows.filter(real));

  const m = metaRes.ok ? metaRes.m : {};
  const tree = buildTree({
    campaigns: m.campaigns || [],
    adsets: m.adsets || [],
    ads: m.ads || [],
    insights: m.insights || [],
    events: ours.events,
    leadSources: ours.leadSources,
    heat: ours.heat,
    sales: matched.filter((s) => s.code),
  });

  const realEvents = ours.events.filter(real);
  const realLeads = ours.leadSources.filter(real);
  const realHeat = ours.heat.filter(real);
  const realViewIds = new Set(realHeat.map((h) => h.view_id));
  const land = landingStats(realEvents, realLeads, realHeat);
  /* Spend comes from EVERY insights row, not only ads the /ads list returned —
   * an ad deleted mid-range still spent money, and the daily chart (account
   * level) counts it, so the total must too. */
  const total = sumMetrics((m.insights || []).map(normaliseInsight));
  const tz = m.account?.timezone_name || null;
  const campaignsWithPace = tree.campaigns.map((c) => ({ ...c, pace: budgetPace({ ...c, nowMs: Date.now() }) }));

  const body = {
    range,
    today,
    readAt: new Date().toISOString(),
    ms: Date.now() - started,
    meta: metaRes.ok
      ? { ok: true, extraErrors: m.extraErrors || [], timezoneMismatch: tz && tz !== "America/Chicago" ? tz : null, account: { id: m.acct, name: m.account?.name || null, currency: m.account?.currency || "USD", timezone: m.account?.timezone_name || null, status: m.account?.account_status ?? null, amountSpentAllTime: m.account?.amount_spent != null ? Number(m.account.amount_spent) / 100 : null, spendCap: m.account?.spend_cap != null && m.account.spend_cap !== "0" ? Number(m.account.spend_cap) / 100 : null }, version: m.version }
      : { ok: false, kind: metaRes.kind, error: metaRes.error },
    total,
    campaigns: campaignsWithPace,
    adsets: tree.adsets,
    ads: tree.ads,
    unmatchedCodes: tree.unmatchedCodes,
    /* The "All ads" line: every ad's code counted once. `landing` below is
     * every Meta visit, including ones no ad's code matches. */
    adsLand: tree.adsLand,
    adsSales: tree.adsSales,
    daily: dailyRows(m.daily || [], ourDaily(ours.events, ours.leadSources)),
    placements: breakdownRows(m.placements || [], ["publisher_platform", "platform_position"]),
    ages: breakdownRows(m.ages || [], ["age", "gender"]),
    devices: breakdownRows(m.devices || [], ["impression_device"]),
    landing: {
      ...land,
      sections: sectionReach(realHeat, ZONES),
      taps: topTargets(ours.clicks.filter((c) => realViewIds.has(c.view_id))),
      byPage: Object.entries(realEvents.reduce((acc, e) => {
        if (e.event === "view") { acc[e.page_slug] = acc[e.page_slug] || new Set(); acc[e.page_slug].add(e.session_id); }
        return acc;
      }, {})).map(([slug, set]) => ({ slug, sessions: set.size })).sort((a, b) => b.sessions - a.sessions),
      errors: ours.errors,
    },
    leads: metaLeadRows.map((l) => ({
      leadId: l.lead_id, name: l.name || null, company: l.company || null, email: l.email || null, phone: l.phone || null,
      domain: l.domain || null, page: l.page_slug, code: l.utm_campaign || null, test: isTestCode(l.utm_campaign),
      at: l.converted_at, reachedCheckout: !!l.reached_checkout, paid: !!l.paid,
    })),
    sales: { ok: salesRes.ok, why: salesRes.why || null, rows: matched },
  };
  body.verdicts = verdicts({ ads: tree.ads, total, land, funnel: land.funnel });

  cache.set(key, { at: Date.now(), body });
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json(body);
}

// Exported for tests.
export const __test = { ourDaily, MetaError };
