/* POST /api/hs-heat — what a visitor looked at and clicked on a landing page.
 * 30 Sep 2026. The heat map's only way in.
 *
 * Same door as /api/hs-event, same rules (lib/hs-http.js): an origin
 * allow-list, a body cap, a per-visit rate limit, and the visitor never sees a
 * failure. Read that file's header before changing anything here.
 *
 *   POST https://<admin-domain>/api/hs-heat
 *   Content-Type: text/plain   ← on purpose: a "simple" request, so the
 *                                browser sends no preflight, and
 *                                navigator.sendBeacon can carry it while the
 *                                tab is closing
 *   Body (JSON text): {
 *     "page_slug": "lawn-care", "view_id": "v-…", "session_id": "…", "seq": 3, "age_ms": 41200,
 *     "path": "/home-services/lawn-care/", "device": "mobile",
 *     "vw": 390, "vh": 844, "doc_h": 6120, "max_scroll": 64, "active_ms": 41000,
 *     "zones": { "hero": [1, 9100], "offer": [1, 12040], "faq": [0, 0] },
 *     "clicks": [ [7, "offer", 512, 880, "price-buy", "link", 0, 0, 38000] ],
 *     "utm_source": "facebook", "utm_content": "ask-chatgpt-photo"
 *   }
 *
 * The page sends RUNNING TOTALS plus up to 40 clicks the server has not yet
 * confirmed, each with its own number (cid). The page resends a click until a
 * send carrying it comes back 204; the database keeps the newest totals and
 * stores each (view, cid) once — see hs_heat_ingest() in migration 0046.
 *
 * Answers 204 whatever the database does. 400 / 403 / 429 are the only
 * refusals, and each means the caller must change something, not retry.
 */

import { getAdminSupabase, isServerConfigured } from "../lib/supabase-server.js";
import { applyCors, readCappedJson, allowHit } from "../lib/hs-http.js";
import { cleanHeatPost } from "../lib/heat-map.js";

/* A page sends every ~15 s, plus once when hidden. 30 a minute from one page
 * load is a stuck loop, not a person. */
const PER_VIEW_LIMIT = 30;
/* One office on one Wi-Fi can have a dozen people on the page at once, each
 * sending every 15 s: ~50 a minute. 240 leaves room for that. */
const PER_IP_LIMIT = 240;
const WINDOW_MS = 60_000;
/* 40 clicks × ~90 bytes plus fourteen sections is under 5 KB. 12 KB leaves
 * room without letting a stranger post a novel. */
const MAX_BYTES = 12 * 1024;

export default async function handler(req, res) {
  const cors = applyCors(req, res);
  if (!cors.ok) return undefined;
  /* Unlike /api/hs-event, no Origin means no. Every browser sends Origin on
   * a cross-site POST and on sendBeacon; a request without one is a script,
   * and a script has no heat to report. (A script can fake the header — the
   * limits below are what slow that down.) */
  if (!cors.origin) return res.status(403).json({ ok: false, error: "Browsers only." });

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const read = await readCappedJson(req, MAX_BYTES);
  if (!read.ok) return res.status(400).json({ ok: false, error: read.error });

  const c = cleanHeatPost(read.body || {});
  if (!c.ok) return res.status(400).json({ ok: false, error: c.error });

  if (!allowHit(`heat:${c.row.view_id}`, PER_VIEW_LIMIT, WINDOW_MS)) {
    return res.status(429).json({ ok: false, error: "Too many sends from that page load." });
  }
  /* A second limit, per caller address, because view_id is chosen by the
   * caller: a script inventing a new id per request walks straight past the
   * one above. The address is read here and never stored. Best effort, like
   * every limit in lib/hs-http.js — it slows a flood, it cannot stop a
   * determined one. */
  const ip = String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "-").split(",")[0].trim();
  if (!allowHit(`heatip:${ip}`, PER_IP_LIMIT, WINDOW_MS)) {
    return res.status(429).json({ ok: false, error: "Too many sends." });
  }

  try {
    if (!isServerConfigured()) {
      console.error("[hs-heat] dropped: Supabase is not configured on this deployment");
      return res.status(204).end();
    }
    const { error } = await getAdminSupabase().rpc("hs_heat_ingest", { p: c.row });
    if (error) console.error("[hs-heat] ingest failed", error.message);
  } catch (err) {
    console.error("[hs-heat] threw", err?.message || err);
  }
  return res.status(204).end();
}
