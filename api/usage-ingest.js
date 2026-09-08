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

/* Providers that have no tokens at all, ever. Their spend is real and is
 * priced per call, not per token.
 *
 * ⭐ THIS IS A SECOND COPY OF THE PLATFORM'S TOKENLESS_PROVIDERS, exported
 * from its lib/ai-meter.js. The two repos cannot import from each other, so
 * the copies are kept in step by hand — and on 8 Sep 2026 they were not.
 * `searchapi` and `zernio` were added to the platform's meter and missed here,
 * with two consequences, neither of which showed up as an error anywhere:
 *
 *  1. Every one of their calls got `meta.tokensUnknown`, which the AI Cost
 *     page renders in its "N calls reported no token counts" banner — the
 *     METERING-IS-BROKEN banner. A vendor that has no tokens by its nature was
 *     being reported as a failed measurement.
 *  2. `priceableFromTokens` stayed false, so `priced.costMicros` was
 *     discarded — meaning adding a per-call price row for either of them would
 *     have changed nothing on screen. That is verbatim the hole the comment
 *     further down says was already closed once for SerpApi.
 *
 * A NAME ADDED TO THE PLATFORM'S SET MUST BE ADDED HERE IN THE SAME CHANGE.
 * There is no guard for that yet — this repo has no scripts/ directory — and
 * porting the platform's lint guards here is the open item that would end it. */
/* Exported ONLY so tests/platform-usage/e2e.mjs can compare it against the
 * platform's set. Nothing else should read it. */
export const ADMIN_TOKENLESS_PROVIDERS = new Set([
  "serpapi", "serper", "searchapi", "firecrawl", "higgsfield", "zernio", "platform-audit",
]);
const TOKENLESS_PROVIDERS = ADMIN_TOKENLESS_PROVIDERS;

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

    /* THREE OUTCOMES, NOT TWO. Changed 6 Sep 2026.
     *
     * This block used to have two: a number, or the whole event thrown away.
     * That is wrong for the case the platform meter now sends constantly —
     * a call that really happened, really cost money, and has NO token count
     * to report. A SerpApi search has no tokens at all. A streamed answer has
     * no usage object at this point. A provider occasionally returns 200 with
     * no `usage` key.
     *
     * Dropping those events loses the call entirely, which is the exact thing
     * this endpoint exists to prevent — and it loses them SILENTLY, filed
     * under a `skipped` count nobody reads. The AI Local sweep alone makes
     * roughly 1,300 SerpApi calls per weekly edition; every one of them would
     * have vanished here.
     *
     * So:
     *   a number      -> the number
     *   null/absent   -> NULL, meaning "this call happened and we could not
     *                    see its size". Storable since 0032, which dropped
     *                    the not-null and the `default 0` on these columns.
     *   anything else -> still skipped. Junk is junk.
     *
     * The distinction is the whole point: NULL and 0 must never be the same
     * value, because 0 means the call was free. */
    const tokenField = (v) => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined; // undefined = junk
    };
    const inTok = tokenField(e?.input_tokens);
    const outTok = tokenField(e?.output_tokens);
    if (inTok === undefined || outTok === undefined) {
      skipped.push("token count is not a number");
      continue;
    }
    /* EITHER half missing means we cannot price it. Not both.
     *
     * The first version asked for BOTH to be null. With
     * {input_tokens: null, output_tokens: 500} it priced the row from tokens,
     * and normalizeUsage resolves a null input to 0 — so a call with 20,000
     * input tokens was costed as if it had none. Measured against the real
     * price book: 7,500 micros where the truth was 67,500. A nine-fold
     * understatement, stored as a confident non-null cost with nothing
     * flagging it. Half a measurement is not a measurement. */
    const unmeasured = inTok === null || outTok === null;


    const atMs = e?.ts && !Number.isNaN(Date.parse(e.ts)) ? Date.parse(e.ts) : Date.now();
    const provider = String(e?.provider || "anthropic").slice(0, 40).toLowerCase();
    const model = e?.model ? String(e.model).slice(0, 120) : null;

    /* A PROVIDER WITH NO TOKENS AT ALL IS NOT THE SAME AS A MISSING READING.
     *
     * SerpApi, Serper, Firecrawl and Higgsfield have no tokens by their
     * nature — the meter sends explicit nulls for them on purpose. Treating
     * that as "unmeasured" made them permanently unpriceable: the code below
     * discarded priced.costMicros before it was ever consulted, so adding a
     * per-call price row for them would have changed nothing, which is the
     * opposite of what lib/ai-meter.js promises. ~1,300 SerpApi calls per AI
     * Local edition sat in that hole.
     *
     * So: a token-less provider is still priced, from whatever price row
     * exists for it (none today — which shows on screen as "not priced yet",
     * honestly). A call from a TOKEN provider that came back with half a
     * reading stays unpriced, because half a measurement is not one. */
    /* Declared AFTER `provider` above, and that is not cosmetic: reading a
     * `const` before its declaration is a temporal dead zone error, which
     * throws at RUN time and is invisible to a build, a lint and every unit
     * test that does not call this handler. The first version of this block
     * sat above `provider` and 500'd the endpoint. The end-to-end test caught
     * it; nothing else did. */
    const tokenless = TOKENLESS_PROVIDERS.has(provider);
    const priceableFromTokens = !unmeasured || tokenless;

    const priced = priceCall({ prices, provider, model, usage: e, atMs });

    /* A caller-supplied cost is still honoured, because the platform may know
     * something we do not — a negotiated rate, a batch discount. It is stored
     * with price_id null and a note saying where it came from, so it can never
     * be mistaken for a figure we worked out ourselves. */
    const sentDollars = e?.cost_usd === undefined || e?.cost_usd === null ? null : Number(e.cost_usd);
    const callerCost = Number.isFinite(sentDollars) && sentDollars >= 0 && sentDollars <= 100000
      ? Math.round(sentDollars * MICROS_PER_DOLLAR)
      : null;

    const costMicros = callerCost !== null ? callerCost : (priceableFromTokens ? priced.costMicros : null);
    if (costMicros === null) unpricedCount += 1;

    rows.push({
      ts: new Date(atMs).toISOString(),
      source: String(e?.source || "platform").slice(0, 60),
      provider,
      model,
      request_id: e?.request_id ? String(e.request_id).slice(0, 200) : null,
      event_key: e?.event_key ? String(e.event_key).slice(0, 200) : null,

      /* When the caller sent a real number, normalizeUsage's cleaned-up value
       * is used exactly as before. When it sent nothing, NULL goes in — see
       * the three-outcome note above. */
      input_tokens: inTok === null ? null : u.input_tokens,
      output_tokens: outTok === null ? null : u.output_tokens,
      /* Keyed off their OWN fields, like input and output above. Forcing all
       * three to null whenever input or output was missing threw away cache
       * counts the caller had actually sent — measured data, discarded, in a
       * file whose whole rule is that measured beats guessed. */
      cache_write_tokens: e?.cache_write_tokens == null ? null : u.cache_write_tokens,
      cache_write_1h_tokens: e?.cache_write_1h_tokens == null ? null : u.cache_write_1h_tokens,
      cache_read_tokens: e?.cache_read_tokens == null ? null : u.cache_read_tokens,

      cost_micros: costMicros,
      price_id: callerCost !== null ? null : priced.priceId,
      cost_usd: costMicros === null ? null : costMicros / MICROS_PER_DOLLAR,

      client_id: uuidOrNull(e?.client_id),
      user_id: uuidOrNull(e?.user_id),

      /* The platform's own two fields (0032). workspace_id is stored raw and
       * is NEVER copied into client_id: they are ids from two different
       * databases, and joining them would draw a per-client cost chart out of
       * a link that does not exist. A person maps it, on a screen. */
      workspace_id: uuidOrNull(e?.workspace_id),
      platform_feature: e?.platform_feature ? String(e.platform_feature).slice(0, 120) : null,
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
        /* The AI Cost page already counts calls whose tokens are unknown, and
         * it reads meta.tokensUnknown — a key only lib/ai-usage.js was
         * setting. Without this line every unmeasured platform call (~1,300
         * SerpApi searches per AI Local edition) landed as "0 tokens" and was
         * counted by nothing at all, which is the exact failure 0032 exists
         * to end. */
        ...(unmeasured && !tokenless ? { tokensUnknown: true } : {}),
        ...(tokenless ? { tokenless: true } : {}),
        ...(costMicros === null
          ? { unpricedReason: tokenless
              ? "this provider charges per call, and no price row exists for it yet"
              : unmeasured
                ? "the call reported no token count, so it cannot be priced from tokens"
                : "no price row for this model on this day" }
          : {}),
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

  /* REGISTER EVERY WORKSPACE WE HAVE JUST SEEN SPEND MONEY.
   *
   * The console cannot know which client a platform workspace belongs to —
   * the two ids live in different databases and nothing links them. What it
   * CAN do is refuse to let a spending workspace be invisible: every one that
   * appears here gets a row, unmapped, and the Unmapped-spend screen lists
   * them biggest-spender-first so the gap is a short job somebody can finish
   * rather than an absence nobody notices.
   *
   * Two statements, not one upsert, and deliberately so: a PostgREST upsert
   * replaces the whole row, which would wipe the client_id a person had
   * already chosen every time that workspace made another call. Insert the
   * new ones, then touch last_seen_at on all of them.
   *
   * Bookkeeping failures here are logged and swallowed. The events are
   * already safely in; refusing the whole batch over the mapping table would
   * turn a small problem into a lost hour of spend. */
  const seenWorkspaces = [...new Set(rows.map((r) => r.workspace_id).filter(Boolean))];
  let workspacesRegistered = 0;
  if (seenWorkspaces.length) {
    try {
      const nowIso = new Date().toISOString();
      const { count: added } = await admin
        .from("admin_platform_workspaces")
        .upsert(
          seenWorkspaces.map((workspace_id) => ({ workspace_id, first_seen_at: nowIso, last_seen_at: nowIso })),
          { onConflict: "workspace_id", ignoreDuplicates: true, count: "exact" },
        );
      /* null, not 0. Saying "no new workspaces" when the database simply did
       * not count them is the opposite of the news this field carries. */
      workspacesRegistered = typeof added === "number" ? added : null;
      await admin
        .from("admin_platform_workspaces")
        .update({ last_seen_at: nowIso })
        .in("workspace_id", seenWorkspaces);
    } catch (err) {
      console.error("[usage-ingest] workspace registry failed", err?.message || err);
    }
  }

  return res.status(200).json({
    ok: true,
    received: rows.length,
    /* Reported only when the database actually said. The old fallback to
     * rows.length reported a fully-duplicate retry as a full insert — the one
     * case idempotency exists to make visible. null means "it did not say",
     * which is a different sentence from a number. */
    inserted: typeof count === "number" ? count : null,
    /* Said out loud. A silent unpriced row is how a total quietly goes missing. */
    unpriced: unpricedCount,
    /* Said out loud so a new workspace showing up is news, not a surprise
     * three weeks later. */
    workspaces_seen: seenWorkspaces.length,
    workspaces_new: workspacesRegistered,
    skipped,
  });
}
