/* THE HOME SERVICES LANDING PAGES — the counting, in one pure file.
 * 14 Sep 2026.
 *
 * Nothing in here touches a database, a network or a clock it was not handed.
 * That is the point: the endpoint that writes the rows, the page that reads
 * them and the tests all count with the SAME functions, so the three can never
 * disagree about what "a scan that completed" means. Every other build in this
 * console that split its maths into a lib/ file did it for this reason
 * (lib/finance-math.js, lib/ai-cost.js, lib/sales-rules.js) and every one that
 * did not eventually had two answers on one screen.
 *
 * THE HONESTY RULE, inherited from the Finance page and not negotiable here:
 *
 *   MEASURED  a count of rows that exist.
 *   DERIVED   a formula over measured counts. Still honest, still not a
 *             measurement, and it says so on screen.
 *   null      we cannot work it out. Every rate function below returns null
 *             rather than 0 when its denominator is 0, because "nobody
 *             visited" and "everybody who visited bounced" are different
 *             facts and a 0% on screen only tells you one of them.
 *
 * DAYS ARE COUNTED IN CHICAGO. The team is in Chicago and so is every other
 * date in this console (lib/sales-rules.js has the long note). A range picked
 * as "1 Aug to 14 Sep" means those calendar days HERE — `new Date("2026-08-01")`
 * is midnight UTC, which is 7pm on 31 July in Chicago, and using it would file
 * an evening's visits under the wrong day and lose the last seven hours of the
 * range entirely.
 */

import { TEAM_TZ, teamDate } from "./brain-context.js";

/* ------------------------------------------------------------------ */
/* The vocabulary                                                      */
/* ------------------------------------------------------------------ */

/* The overarching page first, then the trades. This order is the order the
 * comparison table opens in, and `home-services` is first because every other
 * row on that table is being read AGAINST it. */
export const PAGE_SLUGS = [
  "home-services",
  "lawn-care",
  "painting",
  "pool-cleaning",
  "mobile-detailing",
  "pressure-washing",
];

export const PAGE_LABELS = {
  "home-services": "Home Services (all trades)",
  "lawn-care": "Lawn care",
  "painting": "Painting",
  "pool-cleaning": "Pool cleaning",
  "mobile-detailing": "Mobile detailing",
  "pressure-washing": "Pressure washing",
};

/* ⭐ THIS LIST IS A SECOND COPY of the check constraint in
 * supabase/migrations/0035_home_services_pages.sql. It exists so a bad event
 * name is refused by /api/hs-event with a reason, instead of reaching Postgres
 * and coming back as an error the visitor's browser cannot show anyone.
 *
 * A NAME ADDED TO THE MIGRATION MUST BE ADDED HERE IN THE SAME CHANGE.
 * tests/home-services reads the constraint out of the .sql file and compares
 * it to this array, so the two cannot drift silently — the trap this repo has
 * hit three times (CONTEXT §60: "two copies of a rule need a test that
 * compares them"). */
export const HS_EVENTS = [
  "view",
  "scroll_50",
  "scan_start",
  "scan_step2",
  "scan_complete",
  "checkout_open",
  "checkout_contact",
  "checkout_paid",
  "call_open",
  "call_booked",
  "exit_shown",
  "exit_captured",
  "cta_click",
];

export const DEVICES = ["mobile", "tablet", "desktop"];

/* The funnel, in the order a visitor walks it. Each step names the event that
 * marks it and says in plain words what the visitor did, because "scroll_50"
 * means nothing to anyone reading the page for the first time. */
export const FUNNEL_STEPS = [
  { event: "view", label: "Landed on the page" },
  { event: "scroll_50", label: "Read half of it" },
  { event: "scan_start", label: "Started the scan" },
  { event: "scan_complete", label: "Finished the scan" },
  { event: "checkout_open", label: "Opened the checkout" },
  { event: "checkout_paid", label: "Paid" },
];

export const isPageSlug = (v) => PAGE_SLUGS.includes(String(v ?? ""));
export const isHsEvent = (v) => HS_EVENTS.includes(String(v ?? ""));
export const isDevice = (v) => DEVICES.includes(String(v ?? ""));

/* ------------------------------------------------------------------ */
/* The team's calendar                                                 */
/* ------------------------------------------------------------------ */

/** That instant's wall clock in Chicago, as "YYYY-MM-DDTHH:MM:SS". */
function wallClock(ms) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TEAM_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  /* Intl gives "24" for midnight in some runtimes. "24:00:00" parses as the
   * next day, which would move a midnight event a whole day. */
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}`;
}

/** How far Chicago's wall clock is from UTC at that instant, in ms.
 * Negative — Chicago is behind. -5h in summer, -6h in winter. */
function offsetMs(ms) {
  return Date.parse(`${wallClock(ms)}Z`) - ms;
}

/** Midnight at the START of that Chicago calendar day, as epoch ms.
 *
 * Takes a plain "YYYY-MM-DD" STRING and never hands it to `new Date()`.
 * Solved rather than guessed: the answer is
 *   ms = (that day read as UTC) - (the zone's offset AT that ms)
 * and the offset depends on the answer, so it is applied twice. The second
 * pass only changes anything on the two days a year the clocks move, and on
 * those two days the first pass is an hour out. */
export function teamDayStartMs(dayStr) {
  const s = String(dayStr ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const asUtc = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(asUtc)) return NaN;
  let ms = asUtc - offsetMs(asUtc);
  const again = asUtc - offsetMs(ms);
  if (again !== ms) ms = again;
  return ms;
}

/** The instant the day AFTER that one begins — the exclusive end of a range.
 *
 * Deliberately not "start + 24 hours". Two days a year that is wrong by an
 * hour, and on the shorter one it would drop the last hour of the day. */
export function teamDayEndMs(dayStr) {
  return teamDayStartMs(addTeamDays(dayStr, 1));
}

/** Today, in Chicago, as "YYYY-MM-DD". */
export function teamToday(nowMs = Date.now()) {
  return teamDate(nowMs);
}

/** n days after (or before) that Chicago calendar day, as a string.
 * Stepping through noon, not midnight, so a clock change cannot land the
 * arithmetic on an hour that does not exist. */
export function addTeamDays(dayStr, n) {
  const start = teamDayStartMs(dayStr);
  if (Number.isNaN(start)) return dayStr;
  return teamDate(start + (n * 86400000) + 43200000);
}

/** The default range the page opens on: the last 30 Chicago days, today
 * included. Returned as two plain strings, never as Dates. */
export function defaultRange(nowMs = Date.now()) {
  const to = teamToday(nowMs);
  return { from: addTeamDays(to, -29), to };
}

/** Is this row inside the range? `from` and `to` are day strings; `to` is
 * INCLUSIVE, because a person who picks "to 14 Sep" means all of the 14th. */
export function inRange(row, from, to) {
  const t = Date.parse(row?.created_at ?? row?.converted_at ?? "");
  if (Number.isNaN(t)) return false;
  const a = teamDayStartMs(from);
  const b = teamDayEndMs(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return t >= a && t < b;
}

/* ------------------------------------------------------------------ */
/* Cleaning what a stranger typed                                      */
/* ------------------------------------------------------------------ */

/** Lower-cased and trimmed, or null. The dedupe in /api/hs-lead matches on
 * this, and `Bob@Acme.com ` and `bob@acme.com` are one person. */
export function normaliseEmail(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s || s.length > 254) return null;
  /* Deliberately loose. This is not a deliverability check — it is a guard
   * against storing "yes please" in the email column. */
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Digits only. "(512) 555-0100 ext 4" becomes "51255501004", which is what
 * every other phone in this console looks like, and a US number typed with a
 * leading 1 keeps it rather than being cleverly trimmed. */
export function digitsOnly(v) {
  const d = String(v ?? "").replace(/\D+/g, "");
  return d ? d.slice(0, 20) : null;
}

/** The bare host of whatever they typed in the website box.
 * "https://WWW.Acme.com/quote" -> "acme.com". Null when it is not a website. */
export function hostFromWebsite(v) {
  let s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#]/)[0];
  if (!s || !s.includes(".") || /\s/.test(s)) return null;
  return s.slice(0, 200);
}

/** Free text, trimmed and capped. Null for nothing. Everything a stranger
 * types goes through this before it is stored. */
export function clean(v, max = 200) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return s.slice(0, max);
}

/* ------------------------------------------------------------------ */
/* The counting                                                        */
/* ------------------------------------------------------------------ */

/** A rate, as a percentage — or null when there is nothing to divide by.
 * NEVER zero for an empty denominator. That is the whole honesty rule in one
 * function, and everything on the page that shows a % comes through it. */
export function rate(top, bottom) {
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  if (bottom <= 0) return null;
  return (top / bottom) * 100;
}

const uniq = (rows, key) => new Set(rows.map((r) => r?.[key]).filter(Boolean)).size;

/** Everything the tiles at the top of the page show, for one set of event
 * rows and the lead rows that belong to them. Every field is a COUNT of rows
 * that exist, except the two named `...Rate`, which are DERIVED. */
export function summarise(events = [], leadSources = []) {
  const ev = Array.isArray(events) ? events : [];
  const ls = Array.isArray(leadSources) ? leadSources : [];
  const of = (name) => ev.filter((r) => r?.event === name);

  const views = of("view").length;
  const sessions = uniq(ev, "session_id");
  const scanStarts = of("scan_start").length;
  const scansDone = of("scan_complete").length;
  const checkoutOpens = of("checkout_open").length;
  const leads = ls.length;
  const purchases = ls.filter((r) => r?.paid === true).length;

  return {
    /* MEASURED */
    views,
    sessions,
    scanStarts,
    scansDone,
    checkoutOpens,
    leads,
    purchases,
    reachedCheckout: ls.filter((r) => r?.reached_checkout === true).length,
    events: ev.length,
    /* DERIVED — null when there were no sessions to divide by */
    leadRate: rate(leads, sessions),
    buyRate: rate(purchases, sessions),
  };
}

/** One row per page, for the comparison table. Pages with no rows at all are
 * still returned, with zero counts and null rates: a trade page that has never
 * been visited is a fact worth seeing, and leaving it out of the table looks
 * exactly like a page that does not exist. */
export function comparePages(events = [], leadSources = [], slugs = PAGE_SLUGS) {
  return slugs.map((slug) => {
    const ev = (events || []).filter((r) => r?.page_slug === slug);
    const ls = (leadSources || []).filter((r) => r?.page_slug === slug);
    const s = summarise(ev, ls);
    return {
      slug,
      label: PAGE_LABELS[slug] || slug,
      visits: s.views,
      sessions: s.sessions,
      scanStarts: s.scanStarts,
      scansDone: s.scansDone,
      checkoutOpens: s.checkoutOpens,
      leads: s.leads,
      purchases: s.purchases,
      scanStartPct: rate(s.scanStarts, s.sessions),
      scanCompletePct: rate(s.scansDone, s.sessions),
      leadPct: s.leadRate,
      checkoutOpenPct: rate(s.checkoutOpens, s.sessions),
      paidPct: s.buyRate,
    };
  });
}

/** The funnel for one page: each step, how many sessions reached it, and how
 * many were lost getting there.
 *
 * COUNTED IN SESSIONS, NOT EVENTS, and that is not a detail. One visitor who
 * scrolls past the halfway mark, scrolls back up and does it again fires
 * `scroll_50` twice; counting events would show 200% of visitors reading half
 * the page. A funnel step is "did this visit get here", which is a set.
 *
 * `drop` is the share of the PREVIOUS step lost at this one, and it is null on
 * the first step (nothing came before it) and null wherever the previous step
 * was zero (you cannot lose a share of nothing). */
export function funnelFor(events = [], slug = null) {
  const ev = (events || []).filter((r) => !slug || r?.page_slug === slug);
  const sessionsAt = (name) =>
    new Set(ev.filter((r) => r?.event === name).map((r) => r?.session_id).filter(Boolean)).size;

  let prev = null;
  return FUNNEL_STEPS.map((step, i) => {
    const n = sessionsAt(step.event);
    const row = {
      event: step.event,
      label: step.label,
      sessions: n,
      /* Share of the people who landed at all. Null when nobody landed. */
      ofTop: null,
      /* Share of the step before this one that did NOT continue. */
      drop: null,
      keptFromPrev: rate(n, prev),
    };
    row.drop = (i === 0 || prev === null || prev <= 0) ? null : rate(prev - n, prev);
    prev = n;
    return row;
  }).map((row, i, all) => ({
    ...row,
    ofTop: i === 0 ? (all[0].sessions > 0 ? 100 : null) : rate(row.sessions, all[0].sessions),
  }));
}

/** Which buttons actually get pressed. Only `cta_click` rows count, and a
 * click with no `cta` on it is kept under its own honest label rather than
 * being dropped — a button we forgot to name is news. */
export function ctaCounts(events = []) {
  const map = new Map();
  for (const r of events || []) {
    if (r?.event !== "cta_click") continue;
    const key = clean(r?.cta, 80) || "(not named by the page)";
    const cur = map.get(key) || { cta: key, clicks: 0, sessions: new Set() };
    cur.clicks += 1;
    if (r?.session_id) cur.sessions.add(r.session_id);
    map.set(key, cur);
  }
  return [...map.values()]
    .map((r) => ({ cta: r.cta, clicks: r.clicks, sessions: r.sessions.size }))
    .sort((a, b) => b.clicks - a.clicks || a.cta.localeCompare(b.cta));
}

/** Traffic grouped by one utm field. A visit that arrived with no utm at all
 * is counted as "direct / none" — it is most of the traffic on a new page and
 * silently dropping it would make every source total wrong. */
export function trafficBy(events = [], field = "utm_source") {
  const map = new Map();
  for (const r of events || []) {
    if (r?.event !== "view") continue;
    const key = clean(r?.[field], 80) || "direct / none";
    const cur = map.get(key) || { key, views: 0, sessions: new Set() };
    cur.views += 1;
    if (r?.session_id) cur.sessions.add(r.session_id);
    map.set(key, cur);
  }
  return [...map.values()]
    .map((r) => ({ key: r.key, views: r.views, sessions: r.sessions.size }))
    .sort((a, b) => b.sessions - a.sessions || b.views - a.views || a.key.localeCompare(b.key));
}

/** Sort a list of rows by one field, descending or ascending, putting nulls
 * LAST either way.
 *
 * Nulls last in both directions is deliberate. A null here means "not
 * measured", and sorting ascending would otherwise fill the top of the table
 * with the pages we know nothing about — which reads as "these are the worst"
 * and is the opposite of what the blank means. */
export function sortRows(rows, key, dir = "desc") {
  const out = [...(rows || [])];
  out.sort((a, b) => {
    const av = a?.[key];
    const bv = b?.[key];
    const an = av === null || av === undefined || (typeof av === "number" && Number.isNaN(av));
    const bn = bv === null || bv === undefined || (typeof bv === "number" && Number.isNaN(bv));
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (typeof av === "string" || typeof bv === "string") {
      const c = String(av).localeCompare(String(bv));
      return dir === "asc" ? c : -c;
    }
    return dir === "asc" ? av - bv : bv - av;
  });
  return out;
}

/** The notes line written onto a lead captured by one of these pages. Plain
 * English, and it names every fact it is built from — including the postcode,
 * which admin_leads has no column for (see migration 0035's closing note). */
export function captureNote({ pageSlug, kind = null, reachedCheckout = false, paid = false, zip = null, bestTime = null, at = null }) {
  const bits = [];
  bits.push(`Came in from the ${PAGE_LABELS[pageSlug] || pageSlug} landing page`);
  if (kind) bits.push(`asked about: ${kind}`);
  if (paid) bits.push("paid on the page");
  else if (reachedCheckout) bits.push("opened the checkout but did not pay");
  if (bestTime) bits.push(`best time to reach them: ${bestTime}`);
  if (zip) bits.push(`postcode ${zip}`);
  const when = at ? teamDate(at) : teamDate(Date.now());
  return `${bits.join(" · ")} (${when}).`;
}
