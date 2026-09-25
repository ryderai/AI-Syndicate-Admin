/* THE AI REVENUE CALCULATOR — everything the console and the endpoint share.
 * 24 Sep 2026. Pure: data in, data out, no Supabase, no DOM, so it is tested
 * in tests/calculator without a database.
 *
 *   cleanRun(body)   what a page may write into calc_runs, cleaned
 *   leadNote(run)    the line that goes on the admin_leads row
 *   summarise(rows)  the numbers on the Calculator page
 *
 * The calculator itself (its maths) lives on the website, in
 * ai-syndicate-live/public/ai-revenue-calculator/calc-math.js. This file never
 * re-computes a result. It stores and counts what the page showed.
 */

import { clean, hostFromWebsite } from "./home-services.js";

/* Same keys, same order as calc-math.js INDUSTRIES and the 0040 check
 * constraint. tests/calculator compares all three. */
export const CALC_INDUSTRIES = ["other", "realestate", "law", "roofing", "hvac", "remodel", "homeserv", "health", "finance", "b2b"];
export const CALC_INDUSTRY_LABELS = {
  other: "Other / not listed",
  realestate: "Real estate",
  law: "Law firm",
  roofing: "Roofing",
  hvac: "HVAC, plumbing, electrical",
  remodel: "Remodeling / building",
  homeserv: "Other home services",
  health: "Med spa, dental, clinic",
  finance: "Financial / insurance",
  b2b: "B2B service / agency",
};
export const CALC_DEVICES = ["mobile", "tablet", "desktop"];

/* The value written to admin_leads.vertical — the Sales page's own words
 * (0009: "realtor / lawyer / medspa / dealership…"), not our internal keys. */
export const CALC_VERTICAL = {
  other: "other", realestate: "realtor", law: "lawyer", roofing: "roofing", hvac: "hvac",
  remodel: "remodeling", homeserv: "home-services", health: "medspa", finance: "financial", b2b: "b2b",
};

/* The calculator never shows more than 25% of a business's year (CAP_SHARE in
 * calc-math.js). A posted result above that did not come from the page, so its
 * result fields are dropped rather than let one forged row move the averages.
 * The small margin is for the page's own rounding. */
export const MAX_LIFT = 0.25;

/** A number inside [lo, hi], or null. Never a guessed zero. */
function numIn(v, lo, hi) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return null;
  return n;
}
function intIn(v, lo, hi) {
  const n = numIn(v, lo, hi);
  return n === null ? null : Math.round(n);
}
/** Optional money/count fields: 0 on the page means "not typed". */
function optional(v, hi) {
  const n = numIn(v, 0, hi);
  return n === null || n === 0 ? null : n;
}

/** Only the path, only our own calculator pages — and, since 24 Sep 2026, the
 * landing pages that open the calculator in a popup (/home-services/ and its
 * trade pages, /home-management/). Anything else is refused. */
export function cleanPath(v) {
  const p = String(v || "").split(/[?#]/)[0].trim();
  if (/^\/ai-revenue-calculator\/([a-z0-9-]+\/)?$/.test(p)) return p;
  if (/^\/home-services\/([a-z0-9-]+\/)?$/.test(p) && p !== "/home-services/checkout/") return p;
  if (p === "/home-management/") return p;
  return null;
}

/** Everything a page may write into one calc_runs row, cleaned. Returns
 * { ok, row } or { ok:false, error }. A field that fails its check is
 * dropped to null rather than refusing the row: a stats beacon is never why
 * a visitor sees an error. The run_key, page and industry are required. */
export function cleanRun(b = {}) {
  const runKey = clean(b.run_key, 80);
  if (!runKey || !/^[A-Za-z0-9_-]{8,80}$/.test(runKey)) return { ok: false, error: "Missing run key." };
  const pagePath = cleanPath(b.page_path);
  if (!pagePath) return { ok: false, error: "Unknown page." };
  const industry = CALC_INDUSTRIES.includes(b.industry) ? b.industry : null;
  if (!industry) return { ok: false, error: "Unknown business type." };
  const i = b.inputs && typeof b.inputs === "object" ? b.inputs : {};
  const r = b.result && typeof b.result === "object" ? b.result : {};
  const u = b.utm && typeof b.utm === "object" ? b.utm : {};
  const scanned = hostFromWebsite(b.scanned_domain);
  const row = {
    run_key: runKey,
    session_id: clean(b.session_id, 120) || null,
    page_path: pagePath,
    industry,
    leads_per_month: numIn(i.leads, 0, 100000),
    close_rate: numIn(i.close, 0, 100),
    client_value: numIn(i.sale, 0, 1e9),
    ai_share: numIn(i.aiShare, 0, 100),
    ai_score: intIn(i.score, 0, 100),
    score_measured: b.score_measured === true && Boolean(scanned),
    scanned_domain: b.score_measured === true ? (scanned || null) : null,
    target_score: intIn(i.target, 0, 100),
    yearly_revenue: optional(i.revenue, 1e11),
    clients_per_year: optional(i.clients, 1e7),
    margin: numIn(i.margin, 0, 100),
    repeat_buys: numIn(i.repeat, 0, 100),
    ad_spend: optional(i.spend, 1e9),
    edited: b.edited === true,
    added_revenue: numIn(r.addedRevenue, 0, 1e12),
    added_revenue_year_one: numIn(r.yearOneRevenue, 0, 1e12),
    added_profit: numIn(r.addedProfit, 0, 1e12),
    lifetime_revenue: numIn(r.lifetimeRevenue, 0, 1e13),
    extra_leads_year: numIn(r.extraLeadsYr, 0, 1e8),
    extra_clients_year: numIn(r.extraClientsYr, 0, 1e8),
    capped: r.capped === true,
    warnings: intIn(r.warnings, 0, 20) ?? 0,
    plan_key: ["launch", "managed"].includes(r.plan) ? r.plan : null,
    referrer_host: hostFromWebsite(b.referrer_host) || null,
    utm_source: clean(u.utm_source ?? u.source, 200) || null,
    utm_medium: clean(u.utm_medium ?? u.medium, 200) || null,
    utm_campaign: clean(u.utm_campaign ?? u.campaign, 200) || null,
    device: CALC_DEVICES.includes(b.device) ? b.device : null,
  };
  const base = baseRevenue(row);
  if (row.added_revenue !== null && (!base || row.added_revenue > base * MAX_LIFT * 1.01 + 1)) {
    row.added_revenue = null; row.added_revenue_year_one = null; row.added_profit = null;
    row.lifetime_revenue = null; row.extra_leads_year = null; row.extra_clients_year = null;
  }
  return { ok: true, row };
}

const usd = (n) => (Number.isFinite(Number(n)) ? `$${Math.round(Number(n)).toLocaleString("en-US")}` : "—");

/** The line written on the lead, so a rep sees the numbers without opening
 * another page. Plain words, what they typed and what they were shown. */
export function leadNote(row, dateIso = new Date().toISOString()) {
  const day = String(dateIso).slice(0, 10);
  const parts = [
    `${day} · AI Revenue Calculator (${row.page_path})`,
    `${CALC_INDUSTRY_LABELS[row.industry] || row.industry}`,
    `shown +${usd(row.added_revenue)}/yr (${usd(row.added_revenue_year_one)} year one, ${usd(row.added_profit)} profit)`,
    `inputs: ${row.leads_per_month ?? "?"} leads/mo, ${row.close_rate ?? "?"}% close, ${usd(row.client_value)} per client, ${row.ai_share ?? "?"}% ask AI`,
    `AI score ${row.ai_score ?? "?"}${row.score_measured ? ` (measured on ${row.scanned_domain})` : " (their guess)"}`,
  ];
  if (row.yearly_revenue) parts.push(`yearly revenue typed: ${usd(row.yearly_revenue)}`);
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ */
/* the numbers on the page                                             */
/* ------------------------------------------------------------------ */

/** A stored number, or NaN for a blank. Number(null) is 0, which would count
 * a missing value as $0 in every median below. */
export const val = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
export function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** What the business's year adds up to: the revenue they typed, or else
 * leads × 12 × close × value (the same fallback calc-math.js caps against). */
export function baseRevenue(r) {
  if (val(r.yearly_revenue) > 0) return val(r.yearly_revenue);
  const implied = val(r.leads_per_month) * 12 * (val(r.close_rate) / 100) * val(r.client_value);
  return Number.isFinite(implied) && implied > 0 ? implied : null;
}
/** Added revenue as a share of that year, 0–1, or null. */
export function upliftShare(r) {
  const base = baseRevenue(r);
  const add = val(r.added_revenue);
  if (!base || !Number.isFinite(add)) return null;
  return Math.min(MAX_LIFT, Math.max(0, add / base));
}

function group(rows, key, labelOf) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] ?? "—";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].map(([k, rs]) => {
    const real = rs.filter((r) => r.edited);
    return {
      key: k,
      label: labelOf ? labelOf(k) : k,
      runs: rs.length,
      edited: real.length,
      leads: rs.filter((r) => r.lead_id).length,
      medianAdded: median(real.map((r) => val(r.added_revenue))),
      meanUplift: mean(real.map(upliftShare).map(val)),
      meanScore: mean(rs.map((r) => (r.ai_score === null || r.ai_score === undefined ? NaN : Number(r.ai_score)))),
    };
  }).sort((a, b) => b.runs - a.runs);
}

/** Every number on the Calculator page, from calc_runs rows.
 *
 * THE AVERAGES USE EDITED ROWS ONLY. A row still on the starting guesses is
 * our own numbers echoed back; averaging those would report our defaults as
 * if businesses had typed them. Counts (runs, leads) use every row. */
export function summarise(rows = []) {
  const all = rows.filter(Boolean);
  const real = all.filter((r) => r.edited);
  const leads = all.filter((r) => r.lead_id);
  const measured = all.filter((r) => r.score_measured && r.ai_score !== null && r.ai_score !== undefined);
  return {
    runs: all.length,
    edited: real.length,
    leads: leads.length,
    people: new Set(leads.map((r) => r.lead_id)).size,
    leadRate: all.length ? leads.length / all.length : null,
    medianAdded: median(real.map((r) => val(r.added_revenue))),
    meanAdded: mean(real.map((r) => val(r.added_revenue))),
    medianYearOne: median(real.map((r) => val(r.added_revenue_year_one))),
    medianProfit: median(real.map((r) => val(r.added_profit))),
    meanUplift: mean(real.map(upliftShare).map(val)),
    medianUplift: median(real.map(upliftShare).map(val)),
    medianLeads: median(real.map((r) => val(r.leads_per_month))),
    medianClientValue: median(real.map((r) => val(r.client_value))),
    measuredCount: measured.length,
    meanMeasuredScore: mean(measured.map((r) => Number(r.ai_score))),
    typedRevenue: real.filter((r) => Number(r.yearly_revenue) > 0).length,
    cappedCount: all.filter((r) => r.capped).length,
    byIndustry: group(all, "industry", (k) => CALC_INDUSTRY_LABELS[k] || k),
    byPage: group(all, "page_path"),
    bySource: group(all.map((r) => ({ ...r, src: r.utm_source || r.referrer_host || "direct" })), "src"),
  };
}
