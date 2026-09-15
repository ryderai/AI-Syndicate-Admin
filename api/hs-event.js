/* POST /api/hs-event — one tracked thing a visitor did on a landing page.
 *
 * Called by the public Home Services pages. No auth, by necessity: there is
 * nobody signed in on a marketing page and the page holds no key. What
 * replaces auth is in lib/hs-http.js — an origin allow-list, a body cap and a
 * per-session rate limit — and it is worth reading that file's header before
 * changing anything here.
 *
 *   POST https://<admin-domain>/api/hs-event
 *   Origin: one of HS_ALLOWED_ORIGINS
 *   Body: {
 *     "page_slug": "lawn-care",
 *     "event": "scan_start",
 *     "session_id": "hs_9f2c…",      // random, made by the page, per visit
 *     "cta": "hero-primary",          // only when event = "cta_click"
 *     "path": "/lawn-care", "referrer": "https://www.google.com/",
 *     "utm_source": "google", "utm_medium": "cpc", "utm_campaign": "…",
 *     "device": "mobile"
 *   }
 *
 * ANSWERS 204, ALWAYS-ISH. A tracking beacon is not allowed to be the reason a
 * visitor sees something break, so a database that is down, misconfigured or
 * slow comes back as 204 with a line in the server log. The console reads the
 * ROWS, so a hole shows up there as a gap that says so — never as a zero
 * pretending to be a measurement.
 *
 * The two refusals that are NOT swallowed, because they mean the caller must
 * change what it is doing rather than retry:
 *   403  the Origin is not on the allow-list
 *   400  the body is junk, too big, or names an event that does not exist
 */

import { getAdminSupabase, isServerConfigured } from "../lib/supabase-server.js";
import { applyCors, readCappedJson, allowHit } from "../lib/hs-http.js";
import { isHsEvent, isPageSlug, isDevice, clean } from "../lib/home-services.js";

/* 120 events a minute from one visit. A real person firing every event this
 * page knows about, twice, does not reach it; a stuck scroll handler does on
 * its first second. */
const PER_SESSION_LIMIT = 120;
const WINDOW_MS = 60_000;

export default async function handler(req, res) {
  const cors = applyCors(req, res);
  if (!cors.ok) return undefined;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const read = await readCappedJson(req);
  if (!read.ok) return res.status(400).json({ ok: false, error: read.error });
  const b = read.body || {};

  const pageSlug = String(b.page_slug ?? "");
  const event = String(b.event ?? "");
  const sessionId = clean(b.session_id, 120);

  /* Validated against the SAME list the check constraint in migration 0035
   * holds — see the note above HS_EVENTS. Refusing here means a typo in the
   * page's own tracking comes back as a readable 400 during a build, rather
   * than as a row Postgres rejects on a Tuesday with nobody watching. */
  if (!isPageSlug(pageSlug)) return res.status(400).json({ ok: false, error: "Unknown page." });
  if (!isHsEvent(event)) return res.status(400).json({ ok: false, error: "Unknown event." });
  if (!sessionId) return res.status(400).json({ ok: false, error: "A session id is required." });

  if (!allowHit(`ev:${sessionId}`, PER_SESSION_LIMIT, WINDOW_MS)) {
    /* 429 and no row. Not swallowed into a 204: a caller that is over the
     * limit should be able to see that it is, and ours is the only caller. */
    return res.status(429).json({ ok: false, error: "Too many events from that session." });
  }

  try {
    if (!isServerConfigured()) {
      console.error("[hs-event] dropped: Supabase is not configured on this deployment");
      return res.status(204).end();
    }

    /* WRITTEN INLINE, not built into a variable and passed by name.
     * tests/home-services/columns.mjs reads the column names straight out of
     * this call and checks every one against the CREATE TABLE in migration
     * 0035 — and a literal handed over as a variable is a literal that guard
     * cannot see. The repo's older guard (tests/db-columns) says the same
     * thing about the same trap: "an object built up in a variable and passed
     * by name ... is skipped rather than guessed at". Keep it inline. */
    const { error } = await getAdminSupabase().from("hs_page_events").insert({
      page_slug: pageSlug,
      event,
      session_id: sessionId,
      /* Only a cta_click carries a cta. Storing one on a `view` would make the
       * click-through table count buttons nobody pressed. */
      cta: event === "cta_click" ? clean(b.cta, 80) : null,
      path: clean(b.path, 300),
      referrer: clean(b.referrer, 500),
      utm_source: clean(b.utm_source, 120),
      utm_medium: clean(b.utm_medium, 120),
      utm_campaign: clean(b.utm_campaign, 120),
      utm_content: clean(b.utm_content, 120),
      utm_term: clean(b.utm_term, 120),
      device: isDevice(b.device) ? String(b.device) : null,
    });
    if (error) console.error("[hs-event] insert failed", error.message);
  } catch (err) {
    /* Swallowed on purpose — see the header. Logged, so it is findable. */
    console.error("[hs-event] threw", err?.message || err);
  }

  return res.status(204).end();
}
