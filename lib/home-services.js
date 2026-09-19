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
  "restaurants",   // 0036 — CJ's restaurants page, 16 Sep 2026. Not a trade; lives at /restaurants/
  "electrical",    // 0037 — sixth trade, so the hub shows two rows of three
  "home-management", // 0038 — second-home / home-watch companies, 17 Sep 2026. Not a trade; lives at /home-management/
];

export const PAGE_LABELS = {
  "home-services": "Home Services (all trades)",
  "lawn-care": "Lawn care",
  "painting": "Painting",
  "pool-cleaning": "Pool cleaning",
  "mobile-detailing": "Mobile detailing",
  "pressure-washing": "Pressure washing",
  "restaurants": "Restaurants",
  "electrical": "Electrical",
  "home-management": "Home management",
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
  "scan_failed",   // 0037 — the free scan could not read the site, or timed out
  "scan_email",    // 0037 — the visitor gave an email to see the score
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
  /* NOT "Paid". 18 Sep 2026: the live dashboard showed this step as
   * "Paid · 1 · 17%" on the Home Services page while the PURCHASES tile and the
   * Paid column beside it both said 0 — three figures on one screen, two of
   * them right.
   *
   * The event is fired by the last button at the checkout, which today says
   * "Save my spot". Card payment is not switched on: nothing is charged, and
   * /api/hs-lead writes paid:false. So the event honestly means "pressed the
   * last button" and the purchase counts honestly mean "money moved" — they
   * were never the same number and the label was the only thing claiming they
   * were. When Stripe is live and the button really takes a card, this label
   * goes back to "Paid" and the two agree on their own. */
  { event: "checkout_paid", label: "Pressed the last button" },
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
export function captureNote({ pageSlug, kind = null, reachedCheckout = false, paid = false, zip = null, bestTime = null, score = null, at = null }) {
  const bits = [];
  bits.push(`Came in from the ${PAGE_LABELS[pageSlug] || pageSlug} landing page`);
  if (kind) bits.push(`asked about: ${kind}`);
  if (score !== null && score !== undefined && score !== "") bits.push(`free GEO Score on the page: ${score}/100`);
  if (paid) bits.push("paid on the page");
  else if (reachedCheckout) bits.push("opened the checkout but did not pay");
  if (bestTime) bits.push(`best time to reach them: ${bestTime}`);
  if (zip) bits.push(`postcode ${zip}`);
  const when = at ? teamDate(at) : teamDate(Date.now());
  return `${bits.join(" · ")} (${when}).`;
}


/* ==================================================================
 * THE LEAD LIST — one row per person the landing pages produced
 * ------------------------------------------------------------------
 * Added 18 Sep 2026 for Ryder's ask: a Leads page under Home Services, and
 * the same people on a rep's own screen so somebody can actually ring them.
 *
 * PURE. Rows in, rows out, `now` passed in. It is used by BOTH screens, which
 * is the whole point of it being a function: the count of hot leads a rep sees
 * and the count on the Home Services page are the same function over the same
 * rows, so neither of them can be the one that is wrong.
 *
 * THE NULL RULE HOLDS HERE TOO. A lead with no score is `score: null`, never 0.
 * Nobody scanned their site; that is not a site that scored nought, and a sales
 * queue sorted worst-first must not put them at the top of it.
 * ================================================================== */

/** What stage of the page's funnel this person stopped at. Each value is a
 * different SALES situation, which is why this is not one "status" column:
 *   paid      money changed hands on the page. Not a lead any more.
 *   checkout  they opened the checkout and stopped. The hottest thing here.
 *   scored    they ran the free scan and saw their number.
 *   captured  they left an email but we have no score for them.
 */
export const HS_LEAD_STAGES = ["paid", "checkout", "scored", "captured"];

export const HS_LEAD_STAGE_LABELS = {
  paid: "Paid on the page",
  checkout: "Opened the checkout, did not pay",
  scored: "Saw their score, did not buy",
  captured: "Left an email, no score",
};

/** How long after somebody scans we still call the lead fresh. Ryder's number,
 * 18 Sep 2026: two weeks. It is exported so the screens can PRINT it — a
 * threshold that only exists inside a comparison is a threshold nobody reading
 * the screen can check. */
export const HS_FRESH_DAYS = 14;

/** A score at or below this is a business with a real problem, which is the
 * conversation a rep wants to be having. Above it, the pitch is different and
 * the lead is not "hot" in the sense this list means. */
export const HS_WEAK_SCORE = 70;

export function hsLeadStage(src = {}) {
  if (src.paid) return "paid";
  if (src.reached_checkout) return "checkout";
  if (src.geo_score !== null && src.geo_score !== undefined) return "scored";
  return "captured";
}

/**
 * Is this someone a rep should ring today?
 *
 * Hot means ALL of: they left an email, they have NOT paid, it has been less
 * than HS_FRESH_DAYS since they came in, and either they opened the checkout
 * or their site scored at or below HS_WEAK_SCORE.
 *
 * IT TAKES NO CLOCK. `row.daysOld` was worked out once, in hsLeadRows, from the
 * single `nowMs` that whole read used. A second clock in here is how one screen
 * calls a lead 14 days old in one column and 15 in the next — and it happens at
 * midnight, to one person, and cannot be reproduced when they report it.
 *
 * The freshness test is deliberate. A person who scanned their site nine weeks
 * ago has forgotten they did it, and a queue that never lets anybody out of it
 * stops being a queue. They stay on the Leads page; they leave the hot list.
 */
export function isHotLead(row = {}) {
  if (row.stage === "paid") return false;
  if (!row.email) return false;
  if (row.daysOld === null || row.daysOld > HS_FRESH_DAYS) return false;
  if (row.stage === "checkout") return true;
  return row.score !== null && row.score <= HS_WEAK_SCORE;
}

/** Why this person is on the hot list, in the words a rep would use on a call.
 * Returns null when they are not on it, so the caller cannot print a reason for
 * somebody who does not have one. */
export function hotReason(row = {}) {
  if (!isHotLead(row)) return null;
  if (row.stage === "checkout") return "Opened the checkout and stopped. They were one button away.";
  return `Their site scored ${row.score} out of 100 on our own scan.`;
}

const dayMs = 86400000;

/**
 * Join the three reads into one row per lead.
 *
 * `sources`  hs_lead_sources — one row per lead, and the only place the page,
 *            the plan, the score and whether they paid are recorded.
 * `leads`    admin_leads — the person. May be missing: a rep can delete a lead,
 *            and a viewer may not be allowed to read every one of them. A row
 *            whose lead cannot be read still appears, marked, rather than
 *            vanishing — a lead that disappears from a count without saying so
 *            is how a funnel starts lying.
 * `events`   hs_page_events — used only to count how much of the page they
 *            actually read before filling the form.
 */
export function hsLeadRows({ sources = [], leads = [], events = [], nowMs = Date.now() } = {}) {
  const byId = new Map();
  for (const l of leads) if (l && l.id) byId.set(l.id, l);

  const eventsBySession = new Map();
  for (const e of events) {
    if (!e || !e.session_id) continue;
    const list = eventsBySession.get(e.session_id) || [];
    list.push(e);
    eventsBySession.set(e.session_id, list);
  }

  return sources.map((s) => {
    const lead = byId.get(s.lead_id) || null;
    const stage = hsLeadStage(s);
    const score = (s.geo_score === null || s.geo_score === undefined) ? null : Number(s.geo_score);
    const convertedMs = s.converted_at ? Date.parse(s.converted_at) : NaN;
    const daysOld = Number.isFinite(convertedMs) ? Math.floor((nowMs - convertedMs) / dayMs) : null;
    const sess = eventsBySession.get(s.session_id) || [];

    const row = {
      leadId: s.lead_id,
      pageSlug: s.page_slug,
      pageLabel: PAGE_LABELS[s.page_slug] || s.page_slug,
      stage,
      stageLabel: HS_LEAD_STAGE_LABELS[stage],
      score,
      scoredAt: s.scored_at || null,
      /* What was MEASURED, which is not always what the lead row says today —
       * a rep can edit `domain`, and nobody can edit this. */
      scannedDomain: s.scanned_domain || null,
      plan: s.plan || null,
      paid: Boolean(s.paid),
      reachedCheckout: Boolean(s.reached_checkout),
      convertedAt: s.converted_at || null,
      firstSeenAt: s.first_seen_at || null,
      daysOld,
      utmSource: s.utm_source || null,
      utmCampaign: s.utm_campaign || null,
      /* null, not 0: no events for this session means we never received them,
       * not that they clicked nothing. */
      eventCount: sess.length || null,
      readable: Boolean(lead),
      name: lead?.name || null,
      company: lead?.company || null,
      email: lead?.email || null,
      phone: lead?.phone || null,
      domain: lead?.domain || null,
      city: lead?.city || null,
      state: lead?.state || null,
      leadStage: lead?.stage || null,
      ownerId: lead?.owner_id || null,
      createdAt: lead?.created_at || null,
    };
    row.hot = isHotLead(row);
    row.hotReason = hotReason(row);
    return row;
  });
}

/** The hot list, in the order a rep should work it: the people who opened the
 * checkout first — they are the warmest thing on the page — then the worst
 * scores, then the newest. */
export function hsHotLeads(rows = []) {
  return rows
    .filter((r) => isHotLead(r))
    .sort((a, b) => {
      if (a.stage !== b.stage) return a.stage === "checkout" ? -1 : 1;
      if (a.score !== b.score) {
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return a.score - b.score;
      }
      return String(b.convertedAt || "").localeCompare(String(a.convertedAt || ""));
    });
}

/** The counts under the Leads page's heading. Every one of them is a count of
 * rows that exist — there is no percentage in here, on purpose. */
export function hsLeadTotals(rows = []) {
  const t = { total: rows.length, hot: 0, paid: 0, checkout: 0, scored: 0, captured: 0, withEmail: 0, withPhone: 0, unreadable: 0 };
  for (const r of rows) {
    t[r.stage] += 1;
    if (isHotLead(r)) t.hot += 1;
    if (r.email) t.withEmail += 1;
    if (r.phone) t.withPhone += 1;
    if (!r.readable) t.unreadable += 1;
  }
  return t;
}
