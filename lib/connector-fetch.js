/* Reading the client's own accounts. SERVER ONLY.
 *
 * Never import this from the browser: it holds refresh tokens in memory and
 * talks to Google with them.
 *
 * WHAT IT DOES
 *   1. Turns a stored refresh token into a one-hour access token.
 *   2. Asks the right Google API for one window of numbers.
 *   3. Returns the SAME normalised shape whichever service answered:
 *        { metrics: {...}, detail: {...}, warnings: [] }
 *      so a snapshot row, a report line and a card on screen never have to
 *      know which service a number came from.
 *
 * WHAT IT NEVER DOES
 *   Write anything. Every call in this file is a GET, or a POST to a
 *   :runReport / :query endpoint that only reads. Nothing here can change a
 *   client's listing, site or analytics.
 *
 * ROUNDING AND HONESTY
 *   Numbers come back exactly as Google gives them, except click rate, which
 *   is recomputed from clicks ÷ times shown rather than trusting the returned
 *   average — Google's own average of averages disagrees with the totals it
 *   prints beside it, and a report that quotes both looks wrong.
 */

import { accessTokenFromRefresh } from "./google-oauth.js";
import { PROVIDER_SCOPES } from "./connectors.js";

/* One place for every host, so a typo is one line and not four. */
const HOSTS = {
  gsc: "https://searchconsole.googleapis.com",
  ga4data: "https://analyticsdata.googleapis.com",
  ga4admin: "https://analyticsadmin.googleapis.com",
  gbpAccounts: "https://mybusinessaccountmanagement.googleapis.com",
  gbpInfo: "https://mybusinessbusinessinformation.googleapis.com",
  gbpPerf: "https://businessprofileperformance.googleapis.com",
};

/* How many rows we ask Search Console for when building the "top searches"
 * and "top pages" lists, and how many of them a report is ever shown.
 * Google's own maximum is 25,000; 250 is OUR choice, and it is plenty when
 * the lists are cut to ten. The totals do NOT come from these rows — see
 * fetchGsc — so a short list cannot make a total read low. */
const GSC_ROW_LIMIT = 250;
const LIST_CAP = 10;

class ApiError extends Error {
  constructor(message, status, provider) {
    super(message);
    this.statusCode = status;
    this.provider = provider;
  }
}

async function googleJson(url, { token, method = "GET", body, provider } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  if (!res.ok) {
    const msg = parsed?.error?.message || `${res.status} from Google`;
    /* 403 on these APIs almost always means one specific thing, and the raw
     * text ("Request had insufficient authentication scopes.") sends people
     * to the wrong place. Say the fix. */
    const friendly = res.status === 403
      ? `${msg} — this usually means the account we connected does not have access to that property, or the API is switched off in the Google Cloud project.`
      : msg;
    throw new ApiError(friendly, res.status, provider);
  }
  return parsed;
}

/** A fresh access token for a connection. Throws with a plain reason. */
export async function tokenFor(refreshToken) {
  if (!refreshToken) throw new ApiError("No sign-in is stored for this connection.", 400);
  try {
    return await accessTokenFromRefresh(refreshToken);
  } catch (err) {
    const raw = String(err?.message || "");
    if (/invalid_grant/i.test(raw)) {
      throw new ApiError("The client's Google sign-in was withdrawn or expired. Press Connect again.", 401);
    }
    throw new ApiError(raw || "Could not renew the Google sign-in.", 401);
  }
}

/* ================================================================== */
/* WHAT AN ACCOUNT CAN SEE — used right after a connect                */
/* ================================================================== */

/** Every Search Console site this sign-in can read. */
export async function listGscSites(token) {
  const body = await googleJson(`${HOSTS.gsc}/webmasters/v3/sites`, { token, provider: "gsc" });
  /* This endpoint is not paged — it returns every site the sign-in can see in
   * one answer — so `more` is always false here. It is still returned, so
   * every caller reads the same shape. */
  const properties = (body.siteEntry || [])
    /* siteUnverifiedUser can see the site listed and gets a 403 on every
     * query. Offering it in the picker would produce a card that can only
     * ever fail, so it is filtered out here rather than explained later. */
    .filter((s) => s.permissionLevel && s.permissionLevel !== "siteUnverifiedUser")
    .map((s) => ({ property: s.siteUrl, label: s.siteUrl.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, ""), permission: s.permissionLevel }));
  return { properties, more: false };
}

/** Every Analytics property this sign-in can read. */
export async function listGa4Properties(token) {
  const out = [];
  let page = "";
  let more = false;
  /* Paged, and bounded. Without following nextPageToken a big agency account
   * showed a complete-looking list that stopped at 200 — and the picker has
   * no way to say "the one you want is not here". `more` is returned so the
   * screen can say so out loud instead. */
  for (let i = 0; i < 10; i += 1) {
    const url = `${HOSTS.ga4admin}/v1beta/accountSummaries?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`;
    const body = await googleJson(url, { token, provider: "ga4" });
    for (const acc of body.accountSummaries || []) {
      for (const p of acc.propertySummaries || []) {
        out.push({
          property: p.property,                       // "properties/123456789"
          label: p.displayName || p.property,
          account: acc.displayName || acc.account || null,
        });
      }
    }
    page = body.nextPageToken || "";
    if (!page) break;
    if (i === 9) more = true;
  }
  return { properties: out, more };
}

/** Every Business Profile location this sign-in can read. */
export async function listGbpLocations(token) {
  /* The accounts list is paged too. It used to ask for one page of 50 and
   * stop, so anybody in more than fifty Business Profile accounts silently
   * lost the rest. */
  const accountRows = [];
  let accPage = "";
  for (let i = 0; i < 5; i += 1) {
    const url = `${HOSTS.gbpAccounts}/v1/accounts?pageSize=50${accPage ? `&pageToken=${encodeURIComponent(accPage)}` : ""}`;
    const body = await googleJson(url, { token, provider: "gbp" });
    accountRows.push(...(body.accounts || []));
    accPage = body.nextPageToken || "";
    if (!accPage) break;
  }
  const out = [];
  let cut = Boolean(accPage);
  for (const acc of accountRows) {
    let page = "";
    /* Paged, and bounded. A management account can hold hundreds of
     * locations; an unbounded loop against somebody else's API is how a
     * function times out at 60 seconds with nothing to show. */
    for (let i = 0; i < 5; i += 1) {
      const url = `${HOSTS.gbpInfo}/v1/${acc.name}/locations?readMask=name,title,storefrontAddress,websiteUri&pageSize=100${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`;
      const body = await googleJson(url, { token, provider: "gbp" });
      for (const loc of body.locations || []) {
        const city = loc.storefrontAddress?.locality;
        out.push({
          /* The performance API wants a bare "locations/123". The information
           * API returns exactly that in `name`, but under an account prefix in
           * some responses — strip anything before it either way. */
          property: String(loc.name || "").replace(/^.*(locations\/\d+)$/, "$1"),
          label: [loc.title, city].filter(Boolean).join(" — ") || loc.name,
          website: loc.websiteUri || null,
          account: acc.name,
        });
      }
      page = body.nextPageToken || "";
      if (!page) break;
      /* The loop bound is real, and hitting it means locations were left out.
       * Say so rather than handing back a list that looks complete. */
      if (i === 4) cut = true;
    }
  }
  return { properties: out, more: cut };
}

/**
 * What one sign-in can see, in one shape whichever service answered:
 *   { properties: [{ property, label, ... }], more: boolean }
 *
 * `more` true means the list was CUT — there are accounts this sign-in can
 * see that are not below. The picker says so out loud, because a list that
 * looks complete and is not sends somebody hunting for a site that is really
 * there.
 */
export async function listProperties(provider, token) {
  if (provider === "gsc") return listGscSites(token);
  if (provider === "ga4") return listGa4Properties(token);
  if (provider === "gbp") return listGbpLocations(token);
  return { properties: [], more: false };
}

/* ================================================================== */
/* THE NUMBERS                                                         */
/* ================================================================== */

function ymd(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return { year: y, month: m, day: d };
}

/** clicks ÷ times shown, worked out here rather than trusting Google's own
 * average — see the note at the top of this file. Zero shown is zero rate,
 * not a divide-by-nothing. */
function rate(clicks, impressions) {
  return impressions > 0 ? clicks / impressions : 0;
}

/* ---- Search Console ---------------------------------------------- */

async function fetchGsc(token, property, start, end) {
  const base = `${HOSTS.gsc}/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const ask = (dimensions, rowLimit) => googleJson(base, {
    token, provider: "gsc", method: "POST",
    body: { startDate: start, endDate: end, dimensions, rowLimit, dataState: "final" },
  });

  /* The totals come from a query with NO dimensions. Adding up a dimensioned
   * query instead undercounts every time, because Google drops rows for rare
   * searches — the totals would silently be lower than the truth. */
  const totals = await ask([], 1);
  const row = (totals.rows || [])[0];

  /* NOTHING CAME BACK AT ALL. That is not a measured zero, and saving it as
   * one puts "0 clicks from Google search" into a report as something we
   * measured. It happens on a property verified this week, on a window with
   * nothing settled yet, and on a site Google has no data for — which is
   * exactly the newly-onboarded client the sentence would hurt most.
   * Business Profile has always done this; Search Console used to not, and a
   * reviewer caught it the same day. */
  if (!row) {
    return {
      metrics: { clicks: null, impressions: null, ctr: null, position: null },
      detail: {},
      warnings: ["Google returned no rows for this window. That usually means the property was verified recently, or Google has no settled data for these dates yet. Nothing has been recorded as a zero."],
    };
  }

  const clicks = Number(row.clicks || 0);
  const impressions = Number(row.impressions || 0);

  const warnings = [];
  let queries = [];
  let pages = [];
  try {
    const q = await ask(["query"], GSC_ROW_LIMIT);
    queries = (q.rows || []).slice(0, LIST_CAP).map((r) => ({
      query: r.keys?.[0] || "", clicks: Number(r.clicks || 0), impressions: Number(r.impressions || 0),
      position: Number(r.position || 0),
    }));
  } catch (err) {
    warnings.push(`The list of top searches did not come back: ${err.message}`);
  }
  try {
    const p = await ask(["page"], GSC_ROW_LIMIT);
    pages = (p.rows || []).slice(0, LIST_CAP).map((r) => ({
      page: String(r.keys?.[0] || "").replace(/^https?:\/\/[^/]+/, "") || "/",
      clicks: Number(r.clicks || 0), impressions: Number(r.impressions || 0),
    }));
  } catch (err) {
    warnings.push(`The list of top pages did not come back: ${err.message}`);
  }

  return {
    metrics: {
      clicks,
      impressions,
      ctr: rate(clicks, impressions),
      position: row.position === undefined ? null : Number(row.position),
    },
    detail: { topQueries: queries, topPages: pages },
    warnings,
  };
}

/* ---- Analytics 4 -------------------------------------------------- */

async function fetchGa4(token, property, start, end) {
  const url = `${HOSTS.ga4data}/v1beta/${property}:runReport`;
  const body = await googleJson(url, {
    token, provider: "ga4", method: "POST",
    body: {
      dateRanges: [{ startDate: start, endDate: end }],
      metrics: [{ name: "totalUsers" }, { name: "sessions" }, { name: "engagedSessions" }],
    },
  });
  const v = (body.rows?.[0]?.metricValues || []).map((x) => Number(x.value || 0));
  const metrics = {
    users: v[0] ?? null, sessions: v[1] ?? null,
    engagedSessions: v[2] ?? null, conversions: null,
  };

  const warnings = [];

  /* "Actions taken" is asked for ON ITS OWN, and its failure is a warning
   * rather than the end of the read.
   *
   * Google renamed this metric: `conversions` was retired in favour of
   * `keyEvents`, and a property that has not migrated still answers to the
   * old name. Asking for the wrong one is a 400 that fails the WHOLE report —
   * which is what happened when it rode along with the three above: every
   * Analytics connection returned nothing at all, visitors included. So it
   * gets its own call, the new name first, the old name as a fallback, and a
   * plain sentence if neither works. */
  for (const name of ["keyEvents", "conversions"]) {
    try {
      const one = await googleJson(url, {
        token, provider: "ga4", method: "POST",
        body: { dateRanges: [{ startDate: start, endDate: end }], metrics: [{ name }] },
      });
      const got = one.rows?.[0]?.metricValues?.[0]?.value;
      metrics.conversions = got === undefined ? null : Number(got);
      break;
    } catch {
      // try the other name; the warning below covers both failing.
    }
  }
  if (metrics.conversions === null) {
    warnings.push("Analytics did not return a number for actions taken, under either name Google uses for it. Everything else on this reading is fine.");
  }
  let channels = [];
  try {
    const ch = await googleJson(url, {
      token, provider: "ga4", method: "POST",
      body: {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: "sessionDefaultChannelGroup" }],
        metrics: [{ name: "sessions" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: LIST_CAP,
      },
    });
    channels = (ch.rows || []).map((r) => ({
      channel: r.dimensionValues?.[0]?.value || "unknown",
      sessions: Number(r.metricValues?.[0]?.value || 0),
    }));
  } catch (err) {
    warnings.push(`The breakdown of where visitors came from did not come back: ${err.message}`);
  }

  return { metrics, detail: { topChannels: channels }, warnings };
}

/* ---- Business Profile --------------------------------------------- */

/* Google returns these as separate daily series. The console adds each one up
 * over the window, and adds the four "impressions" series together into one
 * number — because "how many people saw the listing" is the question, and
 * desktop-maps versus mobile-search is not something a client report should
 * make anybody hold in their head. */
const GBP_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_DIRECTION_REQUESTS",
  "BUSINESS_BOOKINGS",
];

const GBP_TO_OURS = {
  CALL_CLICKS: "callClicks",
  WEBSITE_CLICKS: "websiteClicks",
  BUSINESS_DIRECTION_REQUESTS: "directionRequests",
  BUSINESS_BOOKINGS: "bookings",
};

function sumSeries(series) {
  let total = 0;
  for (const point of series?.timeSeries?.datedValues || []) {
    total += Number(point.value || 0);
  }
  return total;
}

async function fetchGbp(token, property, start, end) {
  const s = ymd(start);
  const e = ymd(end);
  const params = new URLSearchParams();
  for (const m of GBP_METRICS) params.append("dailyMetrics", m);
  /* camelCase the whole way down, which is what this API's own discovery
   * document uses for query parameters. A path that is camel at one level and
   * underscored at the next ("dailyRange.start_date.year") matches no field at
   * all — Google either refuses the request or ignores the range and answers
   * for a window of its own choosing, which would be worse: the numbers would
   * be stamped with OUR dates and cover somebody else's. */
  params.set("dailyRange.startDate.year", String(s.year));
  params.set("dailyRange.startDate.month", String(s.month));
  params.set("dailyRange.startDate.day", String(s.day));
  params.set("dailyRange.endDate.year", String(e.year));
  params.set("dailyRange.endDate.month", String(e.month));
  params.set("dailyRange.endDate.day", String(e.day));

  const url = `${HOSTS.gbpPerf}/v1/${property}:fetchMultiDailyMetricsTimeSeries?${params.toString()}`;
  const body = await googleJson(url, { token, provider: "gbp" });

  /* EVERY METRIC STARTS AS null AND ONLY BECOMES A NUMBER IF GOOGLE ANSWERED
   * FOR IT. Starting them at 0 and adding to them looked tidier and was
   * wrong: Google routinely returns some of these series and omits others, so
   * a listing that got CALL_CLICKS but no impressions series was written down
   * as "0 times the listing was shown" — a number Google never sent. An
   * all-or-nothing check missed it, because something did come back. */
  const metrics = {
    businessImpressions: null, callClicks: null, websiteClicks: null,
    directionRequests: null, bookings: null,
  };
  const add = (key, total) => {
    metrics[key] = (metrics[key] ?? 0) + total;
  };
  const missing = new Set(Object.keys(metrics));

  for (const entry of body.multiDailyMetricTimeSeries || []) {
    for (const one of entry.dailyMetricTimeSeries || []) {
      const total = sumSeries(one);
      const name = one.dailyMetric;
      if (String(name).startsWith("BUSINESS_IMPRESSIONS_")) { add("businessImpressions", total); missing.delete("businessImpressions"); }
      else if (GBP_TO_OURS[name]) { add(GBP_TO_OURS[name], total); missing.delete(GBP_TO_OURS[name]); }
    }
  }

  const warnings = [];
  if (missing.size === Object.keys(metrics).length) {
    warnings.push("Google returned no daily numbers for this listing. That usually means the listing is not verified, or it is too new to have any. Nothing has been recorded as a zero.");
  } else if (missing.size) {
    warnings.push(`Google sent nothing for ${[...missing].join(", ")} on this listing, so ${missing.size === 1 ? "it is" : "they are"} left blank rather than recorded as zero.`);
  }
  return { metrics, detail: {}, warnings };
}

/* ================================================================== */
/* THE ONE ENTRY POINT                                                 */
/* ================================================================== */

/**
 * Read one window out of one property.
 *
 * Throws only when nothing at all could be read. A partial answer — totals
 * fine, a list missing — comes back with a `warnings` array, which the caller
 * saves onto the snapshot so a thin report can say why it is thin.
 */
export async function fetchWindow({ provider, token, property, start, end }) {
  if (!PROVIDER_SCOPES[provider]) {
    throw new ApiError(`${provider} numbers cannot be read automatically yet — type them in instead.`, 400, provider);
  }
  if (!property) throw new ApiError("This connection has no property chosen, so there is nothing to read.", 400, provider);
  if (provider === "gsc") return fetchGsc(token, property, start, end);
  if (provider === "ga4") return fetchGa4(token, property, start, end);
  if (provider === "gbp") return fetchGbp(token, property, start, end);
  throw new ApiError(`Unknown provider "${provider}".`, 400, provider);
}

export { ApiError };
