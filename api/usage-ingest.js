/* POST /api/usage-ingest — the token/cost feed from the platform backend.
 *
 * This is the documented hand-off point for Andrew: the platform (or any
 * job) POSTs usage events here and they appear on the Overview page.
 *
 *   POST https://<admin-domain>/api/usage-ingest
 *   Header: x-ingest-key: <USAGE_INGEST_KEY env value>
 *   Body: { "events": [ { "ts": "2026-08-15T12:00:00Z", "source": "caite",
 *            "model": "claude-sonnet-4-6", "input_tokens": 1200,
 *            "output_tokens": 480, "cost_usd": 0.0125, "meta": {} } ] }
 *
 * Max 500 events per call. Idempotency is the caller's problem (send once). */

import { createHash, timingSafeEqual } from "node:crypto";
import { getAdminSupabase, isServerConfigured, readJson } from "../lib/supabase-server.js";

function keysMatch(sent, expected) {
  if (!sent || !expected) return false;
  // Compare SHA-256 digests in constant time — string !== leaks timing.
  const a = createHash("sha256").update(String(sent)).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const key = process.env.USAGE_INGEST_KEY;
  if (!key) return res.status(503).json({ error: "Usage ingest is not configured (USAGE_INGEST_KEY missing)." });
  if (!keysMatch(req.headers["x-ingest-key"], key)) return res.status(401).json({ error: "Bad ingest key." });
  if (!isServerConfigured()) return res.status(503).json({ error: "Supabase is not configured." });

  const body = await readJson(req);
  const events = Array.isArray(body?.events) ? body.events.slice(0, 500) : [];
  if (!events.length) return res.status(400).json({ error: "Body must be { events: [...] } with at least one event." });

  const rows = [];
  for (const e of events) {
    const inputTokens = Number(e?.input_tokens) || 0;
    const outputTokens = Number(e?.output_tokens) || 0;
    const cost = Number(e?.cost_usd) || 0;
    // Skip negatives and anything that would overflow numeric(12,6) — one
    // absurd row must not reject the whole batch.
    if (inputTokens < 0 || outputTokens < 0 || cost < 0 || cost > 100000) continue;
    rows.push({
      ts: e?.ts && !Number.isNaN(Date.parse(e.ts)) ? new Date(e.ts).toISOString() : new Date().toISOString(),
      source: String(e?.source || "platform").slice(0, 60),
      model: e?.model ? String(e.model).slice(0, 120) : null,
      input_tokens: Math.round(inputTokens),
      output_tokens: Math.round(outputTokens),
      cost_usd: cost,
      meta: e?.meta && typeof e.meta === "object" ? e.meta : {},
    });
  }
  if (!rows.length) return res.status(400).json({ error: "No valid events in body." });

  const admin = getAdminSupabase();
  const { error } = await admin.from("admin_usage_events").insert(rows);
  if (error) return res.status(500).json({ error: `insert failed: ${error.message}` });

  return res.status(200).json({ ok: true, inserted: rows.length });
}
