/* POST /api/usage-ingest — the token/cost feed from the platform backend.
 *
 * This is the documented hand-off point for Andrew: the platform (or any
 * job) POSTs usage events here and they appear on the Overview page.
 *
 *   POST https://<admin-domain>/api/usage-ingest
 *   Header: x-ingest-key: <USAGE_INGEST_KEY env value>
 *   Body: { "events": [ {
 *            "ts": "2026-08-15T12:00:00Z",
 *            "source": "caite",              // where in the platform
 *            "provider": "anthropic",
 *            "model": "claude-sonnet-4-6",
 *            "request_id": "req_abc123",     // the PROVIDER's id, off their headers
 *            "event_key": "caite:req_abc123",// ours. Send the same key twice, get one row.
 *            "input_tokens": 1200, "output_tokens": 480,
 *            "cache_write_tokens": 0, "cache_read_tokens": 0,
 *            "feature": "audit", "surface": "api",
 *            "client_id": "<uuid>",          // the UUID. Never a name.
 *            "latency_ms": 900, "status": "ok",
 *            "meta": {}
 *          } ] }
 *
 * Max 500 events per call.
 *
 * V2 - Aug 28 2026. THREE THINGS CHANGED, AND THE OLD BODY SHAPE STILL WORKS:
 *
 * 1. IDEMPOTENCY IS NO LONGER THE CALLER'S PROBLEM. This file's own comment
 *    used to say "send once", and one retry double-counted, silently. Send an
 *    `event_key` and a repeat is dropped. Without a key the old behaviour
 *    stands - every call inserts - so nothing already posting here breaks.
 *
 * 2. COST IS WORKED OUT HERE, from the dated price book, unless the caller
 *    sends one. A caller's `cost_usd` was whatever price THEY had hardcoded;
 *    ours comes from ai_model_prices and records which row it used. An unknown
 *    model is written UNPRICED - tokens kept, cost null - never as zero.
 *
 * 3. ATTRIBUTION. client_id, feature, surface and user_id ride along, so
 *    platform spend lands in the same groupings as the console's own. */

import { createHash, timingSafeEqual } from "node:crypto";
import { getAdminSupabase, isServerConfigured, readJson } from "../lib/supabase-server.js";
import { loadPrices } from "../lib/ai-usage.js";
import {
  priceCall, normalizeUsage, FEATURES, SURFACES, MICROS_PER_DOLLAR,
} from "../lib/ai-cost.js";

const isUuid = (v) =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const uuidOrNull = (v) => (isUuid(v) ? v : null);
const oneOf = (v, list, fallback) => {
  const t = String(v ?? "").trim().toLowerCase();
  return list.includes(t) ? t : fallback;
};

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

  const admin = getAdminSupabase();
  const prices = await loadPrices(admin);

  const rows = [];
  const skipped = [];
  let unpricedCount = 0;

  for (const e of events) {
    const u = normalizeUsage(e);
    /* One absurd row must not reject the whole batch. normalizeUsage already
     * clamps at zero, so this catches a caller sending something that is not a
     * number at all rather than a negative count. */
    if (!Number.isFinite(Number(e?.input_tokens ?? 0)) || !Number.isFinite(Number(e?.output_tokens ?? 0))) {
      skipped.push("token count is not a number");
      continue;
    }

    const atMs = e?.ts && !Number.isNaN(Date.parse(e.ts)) ? Date.parse(e.ts) : Date.now();
    const provider = String(e?.provider || "anthropic").slice(0, 40).toLowerCase();
    const model = e?.model ? String(e.model).slice(0, 120) : null;

    const priced = priceCall({ prices, provider, model, usage: e, atMs });

    /* A caller-supplied cost is still honoured, because the platform may know
     * something we do not — a negotiated rate, a batch discount. It is stored
     * with price_id null and a note saying where it came from, so it can never
     * be mistaken for a figure we worked out ourselves. */
    const sentDollars = e?.cost_usd === undefined || e?.cost_usd === null ? null : Number(e.cost_usd);
    const callerCost = Number.isFinite(sentDollars) && sentDollars >= 0 && sentDollars <= 100000
      ? Math.round(sentDollars * MICROS_PER_DOLLAR)
      : null;

    const costMicros = callerCost !== null ? callerCost : priced.costMicros;
    if (costMicros === null) unpricedCount += 1;

    rows.push({
      ts: new Date(atMs).toISOString(),
      source: String(e?.source || "platform").slice(0, 60),
      provider,
      model,
      request_id: e?.request_id ? String(e.request_id).slice(0, 200) : null,
      event_key: e?.event_key ? String(e.event_key).slice(0, 200) : null,

      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_write_tokens: u.cache_write_tokens,
      cache_write_1h_tokens: u.cache_write_1h_tokens,
      cache_read_tokens: u.cache_read_tokens,

      cost_micros: costMicros,
      price_id: callerCost !== null ? null : priced.priceId,
      cost_usd: costMicros === null ? null : costMicros / MICROS_PER_DOLLAR,

      client_id: uuidOrNull(e?.client_id),
      user_id: uuidOrNull(e?.user_id),
      feature: oneOf(e?.feature, FEATURES, "other"),
      surface: oneOf(e?.surface, SURFACES, "api"),
      entity_kind: e?.entity_kind ? String(e.entity_kind).slice(0, 40) : null,
      entity_id: uuidOrNull(e?.entity_id),

      /* What happened to the CALL. Not whether we could price it — that is
       * cost_micros IS NULL, and conflating the two loses the failure. */
      status: oneOf(e?.status, ["ok", "failed", "rejected", "capped"], "ok"),
      error_code: e?.error_code ? String(e.error_code).slice(0, 120) : null,
      latency_ms: Number.isFinite(Number(e?.latency_ms)) ? Math.max(0, Math.round(Number(e.latency_ms))) : null,
      billable: e?.billable !== false,

      meta: {
        ...(e?.meta && typeof e.meta === "object" ? e.meta : {}),
        ...(callerCost !== null ? { costFrom: "caller" } : {}),
        ...(costMicros === null ? { unpricedReason: "no price row for this model on this day" } : {}),
      },
    });
  }
  if (!rows.length) return res.status(400).json({ error: "No valid events in body.", skipped });

  /* upsert on the dedupe key rather than a plain insert, so a retried batch
   * settles instead of failing whole. Rows with no key are unaffected — the
   * unique index is partial. ignoreDuplicates keeps the FIRST version of an
   * event: a retry is a retry, not a correction. */
  const { error, count } = await admin
    .from("admin_usage_events")
    .upsert(rows, { onConflict: "event_key", ignoreDuplicates: true, count: "exact" });
  if (error) return res.status(500).json({ error: `insert failed: ${error.message}` });

  return res.status(200).json({
    ok: true,
    received: rows.length,
    inserted: typeof count === "number" ? count : rows.length,
    /* Said out loud. A silent unpriced row is how a total quietly goes missing. */
    unpriced: unpricedCount,
    skipped,
  });
}
