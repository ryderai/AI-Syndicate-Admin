/* THE ONE PLACE AI SPEND IS RECORDED.  Aug 28 2026
 *
 * Before this file, seven API routes each did their own arithmetic and their
 * own insert, with the price written out seven times as
 * `const COST = { input: 3.0, output: 15.0 }` — Claude Sonnet's rate, applied
 * to whatever model actually ran. Seven copies is seven chances to drift, and
 * they had already drifted from the truth in five ways at once: no cached
 * tokens, no failed calls, the client stored as a NAME, no dedupe, and a
 * swallowed write error.
 *
 * Everything now goes through recordAiUsage(). The maths is not in here — it is
 * in lib/ai-cost.js, which is pure and tested in five timezones.
 *
 * THREE RULES THIS FILE KEEPS:
 *
 * 1. THE COST IS FROZEN AT WRITE. The price row used is stored as `price_id`.
 *    Changing a price tomorrow must not move last month's total.
 *
 * 2. AN UNKNOWN MODEL IS UNPRICED, NOT FREE. The tokens are written, the cost
 *    is null, the status says 'unpriced', and the page prints "not priced yet".
 *    A wrong number that looks right is worse than a gap that says it is a gap.
 *
 * 3. A FAILED WRITE IS REPORTED, NOT SWALLOWED. A guard whose failure mode is
 *    silence is not a guard (CONTEXT-FOR-AI.md §22). It still never throws —
 *    bookkeeping must not be able to cost somebody their answer — but the miss
 *    lands in admin_activity_log and Overview says so out loud.
 *
 * NOTE ON THE OLD CALL SITES: three of the seven used to `await` the insert and
 * never read the result. supabase-js does NOT throw on a database error, it
 * resolves with { error }, so those three swallowed failures just as completely
 * as the four fire-and-forget ones — and because they sat inside the AI call's
 * own try/catch, a genuine throw was reported to the person as "the AI did not
 * answer". Both shapes are gone.
 */

import {
  priceCall, normalizeUsage, num,
  FEATURES, SURFACES, MICROS_PER_DOLLAR,
} from "./ai-cost.js";

/* ------------------------------------------------------------------ */
/* The price book, cached in memory                                    */
/* ------------------------------------------------------------------ */
/* A database round-trip per AI call would put the bookkeeping in the critical
 * path of every answer. The book changes about as often as a provider changes
 * its prices, so it is read once and re-read on a timer. */

const PRICE_TTL_MS = 5 * 60 * 1000;
let priceCache = { rows: [], at: 0, failedAt: 0 };

/** True when the last attempt to read the price book failed and we are running
 *  on a stale copy. Read by the health endpoint; a cache that has quietly
 *  stopped refreshing prices every call at last month's rates. */
export function priceCacheIsStale() {
  return Boolean(priceCache.failedAt && priceCache.failedAt > priceCache.at);
}

/** Throw the cached price book away. Called after a price is edited. */
export function invalidatePriceCache() {
  priceCache = { rows: [], at: 0, failedAt: 0 };
}

/** For tests: hand the module a price book without a database. */
export function primePriceCache(rows) {
  priceCache = { rows: Array.isArray(rows) ? rows : [], at: Date.now(), failedAt: 0 };
}

export async function loadPrices(admin) {
  const now = Date.now();
  if (priceCache.at && now - priceCache.at < PRICE_TTL_MS) return priceCache.rows;
  try {
    const { data, error } = await admin
      .from("ai_model_prices")
      .select("id, provider, model, effective_from, effective_to, input_per_mtok, output_per_mtok, cache_write_per_mtok, cache_write_1h_per_mtok, cache_read_per_mtok, currency");
    if (error) throw new Error(error.message);
    priceCache = { rows: data || [], at: now, failedAt: 0 };
    return priceCache.rows;
  } catch {
    /* A price book we could not read is NOT an empty price book. Returning []
     * would price every call in the outage as UNPRICED, which reads on screen
     * as "we don't know what this cost" and is technically true but throws away
     * a perfectly good cached answer. Keep the stale rows; only fall back to
     * empty when there has never been a successful read. */
    priceCache.failedAt = now;
    return priceCache.rows;
  }
}

/* ------------------------------------------------------------------ */
/* Tidying what the caller passed                                      */
/* ------------------------------------------------------------------ */

const clean = (v, max = 120) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** A value from a fixed list, or the list's fallback. Never the raw string:
 *  free text is how one grouping becomes three. */
const oneOf = (v, list, fallback) => {
  const s = String(v ?? "").trim().toLowerCase();
  return list.includes(s) ? s : fallback;
};

const isUuid = (v) =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** A uuid or null. A non-uuid string here would make the insert fail and take
 *  the whole row with it, so it is dropped — and the caller is told which value
 *  was dropped, in `meta`, because spend silently moving to Internal with no
 *  trace is worse than a row that says what it lost. An earlier version of this
 *  comment promised that and the code did not do it. */
const uuidOrNull = (v) => (isUuid(v) ? v : null);
const droppedIds = (pairs) => {
  const out = {};
  for (const [k, v] of pairs) if (v && !isUuid(v)) out[k] = String(v).slice(0, 80);
  return Object.keys(out).length ? { droppedIds: out } : {};
};

/* ------------------------------------------------------------------ */
/* Reporting a miss                                                    */
/* ------------------------------------------------------------------ */

async function reportMiss(admin, why, detail) {
  try {
    await admin.from("admin_activity_log").insert({
      actor: "system",
      kind: "usage_write_failed",
      title: "An AI usage event could not be saved",
      body: `${why}${detail ? ` — ${detail}` : ""}`,
    });
  } catch {
    /* Nothing left to do. The console's Overview reads the activity log for
     * this exact line; if the log itself is unreachable the whole database is,
     * and the person is already seeing that somewhere louder. */
  }
}

/* ------------------------------------------------------------------ */
/* The logger                                                          */
/* ------------------------------------------------------------------ */

/**
 * Record one AI call.
 *
 * @param admin        the service-key supabase client
 * @param provider     'anthropic' | 'openai' | 'google' | 'perplexity'
 * @param model        the exact model id
 * @param usage        the provider's own usage object, whole, cache fields included
 * @param requestId    the provider's request id, off the RESPONSE HEADERS
 * @param status       'ok' | 'failed' | 'rejected' | 'capped'  (never 'unpriced' —
 *                     that is decided here, by whether a price was found)
 * @param errorCode    short machine-ish reason when status is not ok
 * @param latencyMs    how long the call took
 * @param feature      what it was doing — one of FEATURES
 * @param surface      which page it came from — one of SURFACES
 * @param clientId     the client's UUID. NOT their name.
 * @param userId       who asked. Null for a cron or a system job.
 * @param entity       { kind, id } — the exact lead / task / ticket / email
 * @param eventKey     dedupe key. A retry with the same key writes nothing.
 * @param billable     false for anything we are not actually charged for
 * @param meta         anything else worth keeping; free-form, never grouped on
 *
 * @returns { saved, costMicros, unpriced, reason }  — and NEVER throws.
 */
export async function recordAiUsage(admin, opts) {
  /* Destructuring with `= {}` only defaults on undefined, so recordAiUsage(a, null)
   * threw a TypeError BEFORE the try block — making the never-throws guarantee
   * false in exactly the case a caller is most likely to hit by accident. */
  return recordAiUsageInner(admin, opts || {});
}

async function recordAiUsageInner(admin, {
  provider = "anthropic",
  model,
  usage,
  requestId = null,
  status = "ok",
  errorCode = null,
  latencyMs = null,
  feature = "other",
  surface = "unknown",
  clientId = null,
  userId = null,
  entity = null,
  eventKey = null,
  billable = true,
  meta = {},
  at = null,
} = {}) {
  try {
    const prices = await loadPrices(admin);
    const atMs = typeof at === "number" ? at : Date.now();

    /* THE DEDUPE KEY DEFAULTS TO THE PROVIDER'S OWN REQUEST ID.
     * Not one of the seven call sites passed a key, so `event_key` was always
     * null and the unique index never applied to anything the console itself
     * wrote — the retry protection existed only for Andrew's feed. Vercel
     * retrying a timed-out function, or somebody double-clicking Generate,
     * wrote the cost twice. The provider's request id is unique per billed
     * request, which is exactly the thing that must not be counted twice. */
    const key = eventKey || (requestId ? `${feature}:${requestId}` : null);
    const priced = priceCall({ prices, provider, model, usage, atMs });
    const u = priced.usage;

    /* `status` says what happened to the CALL and nothing else. Whether we
     * could price it is `cost_micros IS NULL`. Those were one column once, and
     * a failed call to an unknown model came out labelled 'unpriced' with the
     * failure lost. */
    const finalStatus = oneOf(status, ["ok", "failed", "rejected", "capped", "legacy"], "ok");

    const row = {
      ts: new Date(atMs).toISOString(),
      // `source` is the old column and Overview still groups on it. Kept.
      source: "admin",
      provider: clean(provider, 40)?.toLowerCase() || "anthropic",
      model: clean(model, 120),
      request_id: clean(requestId, 200),
      event_key: clean(key, 200),

      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_write_tokens: u.cache_write_tokens,
      cache_write_1h_tokens: u.cache_write_1h_tokens,
      cache_read_tokens: u.cache_read_tokens,

      cost_micros: priced.costMicros,
      price_id: priced.priceId,
      // The old dollars column, kept in step so anything still reading it —
      // Overview and Finance both do — keeps working. Null stays null: an
      // unpriced call must not read as $0 through the old column either.
      cost_usd: priced.costMicros === null ? null : priced.costMicros / MICROS_PER_DOLLAR,

      client_id: uuidOrNull(clientId),
      user_id: uuidOrNull(userId),
      feature: oneOf(feature, FEATURES, "other"),
      surface: oneOf(surface, SURFACES, "unknown"),
      entity_kind: clean(entity?.kind, 40),
      entity_id: uuidOrNull(entity?.id),

      status: finalStatus,
      error_code: clean(errorCode, 120),
      latency_ms: Number.isFinite(Number(latencyMs)) ? Math.max(0, Math.round(Number(latencyMs))) : null,
      billable: billable !== false,

      meta: {
        ...(meta && typeof meta === "object" ? meta : {}),
        /* A call that threw never reported its token counts. Said on the row,
         * because cost_micros is null for it and "null" alone does not say
         * whether the model was unknown or the call simply died. */
        ...(usage === null || usage === undefined ? { tokensUnknown: true } : {}),
        ...droppedIds([["clientId", clientId], ["userId", userId], ["entityId", entity?.id]]),
        ...(priced.savingMicros ? { cacheSavingMicros: priced.savingMicros } : {}),
        // Say WHY it could not be priced, on the row, so nobody has to guess
        // three weeks later which of the two reasons it was.
        ...(priced.unpriced
          ? { unpricedReason: priced.price ? "no cache rate for the cached tokens in this call" : "no price row for this model on this day" }
          : {}),
      },
    };

    const { error } = await admin.from("admin_usage_events").insert(row);

    if (error) {
      /* A duplicate event_key is the dedupe working, not a fault. Postgres
       * unique-violation is 23505. Anything else is a real miss and gets said
       * out loud. */
      if (error.code === "23505") {
        return { saved: false, costMicros: priced.costMicros, unpriced: priced.unpriced, reason: "duplicate" };
      }
      await reportMiss(admin, error.message, `${row.feature} on ${row.surface}, ${num(u.input_tokens) + num(u.output_tokens)} tokens`);
      return { saved: false, costMicros: priced.costMicros, unpriced: priced.unpriced, reason: error.message };
    }

    return { saved: true, costMicros: priced.costMicros, unpriced: priced.unpriced, reason: null };
  } catch (err) {
    /* THIS FUNCTION NEVER THROWS. A caller wraps its AI call in a try/catch
     * whose catch says "the AI did not answer"; letting a bookkeeping fault
     * reach it would report a database problem as a product problem, which is
     * exactly the bug this build removed from three of the old call sites. */
    await reportMiss(admin, err?.message || "unknown error", "recordAiUsage threw");
    return { saved: false, costMicros: null, unpriced: true, reason: err?.message || "unknown error" };
  }
}

/**
 * How many usage writes we are known to have LOST in the last day.
 * Overview prints this; a hole in the books that nobody is told about is the
 * same as no books at all.
 */
export async function recentUsageMisses(admin, sinceMs = Date.now() - 86400000) {
  try {
    const { data, error } = await admin
      .from("admin_activity_log")
      .select("id, created_at, body")
      .eq("kind", "usage_write_failed")
      .gte("created_at", new Date(sinceMs).toISOString())
      .order("created_at", { ascending: false })
      .limit(51);
    if (error) return { count: 0, rows: [], unreadable: error.message };
    const rows = data || [];
    // 51 asked for, 50 shown: fetching one more than we print is how a
    // truncation warning gets to be true rather than decorative.
    return { count: rows.length, rows: rows.slice(0, 50), more: rows.length > 50, unreadable: null };
  } catch (err) {
    return { count: 0, rows: [], unreadable: err?.message || "unknown error" };
  }
}

export { normalizeUsage };
