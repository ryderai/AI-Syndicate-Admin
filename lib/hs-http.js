/* THE DOOR THE LANDING PAGES KNOCK ON. 14 Sep 2026.
 *
 * /api/hs-event and /api/hs-lead are the only two endpoints in this console
 * that a stranger may call. Everything else behind /api requires a bearer
 * token and an active admin_users row. These two cannot: they are called by a
 * marketing page on another domain, by somebody who has never signed in to
 * anything, and the page holds no key of any kind.
 *
 * So the rules that replace "are you a member" all live here, in one file, so
 * both endpoints cannot enforce them differently:
 *
 *   1. AN ALLOW-LIST, NOT A WILDCARD. `Access-Control-Allow-Origin: *` on a
 *      write endpoint means any page on the internet can post rows into our
 *      database. HS_ALLOWED_ORIGINS names the landing-page origins. If it is
 *      not set, every cross-origin call is refused — the endpoint is OFF until
 *      somebody deliberately turns it on, rather than open until somebody
 *      remembers to close it.
 *
 *   2. A SIZE CAP READ BEFORE THE BODY. A POST with a 40MB body costs money
 *      and time whether or not we like its contents, so the cap is checked
 *      against Content-Length first and enforced again while reading, in case
 *      the header lied.
 *
 *   3. A RATE LIMIT PER SESSION. Best-effort and said so out loud: this
 *      process is one serverless instance of several, so a visitor spread
 *      across instances gets a higher real ceiling than the number below. It
 *      stops a stuck loop in our own page hammering the table, which is the
 *      failure that has actually happened to people; it is not a defence
 *      against somebody who is trying. A table-based limit would be, and is
 *      noted in CONTEXT §61 as the thing to build if this is ever abused.
 *
 *   4. THE VISITOR NEVER SEES A 500. A tracking beacon that throws breaks
 *      nothing the visitor came for, so both endpoints swallow their own
 *      failures, log them, and answer anyway. The console shows the gap.
 */

/** The origins allowed to call these two endpoints.
 * Unset or blank means NOBODY — see rule 1. */
export function allowedOrigins() {
  return String(process.env.HS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Answer the CORS part of the request.
 *
 * Returns { ok, origin, preflight }. When ok is false the caller must stop:
 * the response has already been ended with a 403 and no header naming an
 * origin we do not trust.
 *
 * A request with NO Origin header at all (curl, a server-to-server call, our
 * own health check) is allowed through — there is no browser to protect and
 * no cross-site request to forge. It simply gets no allow header back. */
export function applyCors(req, res) {
  const origin = String(req.headers?.origin || "").replace(/\/+$/, "");
  const list = allowedOrigins();
  const preflight = req.method === "OPTIONS";

  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");

  if (!origin) {
    if (preflight) { res.status(204).end(); return { ok: false, origin: null, preflight }; }
    return { ok: true, origin: null, preflight };
  }

  if (!list.includes(origin)) {
    /* Deliberately NO Access-Control-Allow-Origin header here. Saying 403 in
     * the body while still handing out the header would let the page read the
     * refusal — and, more to the point, an allow header for an origin we do
     * not trust is the mistake this whole file exists to avoid. */
    res.status(403).json({ ok: false, error: "This origin is not allowed to post here." });
    return { ok: false, origin, preflight };
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (preflight) { res.status(204).end(); return { ok: false, origin, preflight }; }
  return { ok: true, origin, preflight };
}

export const MAX_BODY_BYTES = 8 * 1024;

/** Read the JSON body, never more than `max` bytes of it.
 *
 * Returns { ok, body } or { ok:false, error }. It does NOT throw: a visitor
 * sending nonsense is an ordinary event on a public endpoint, not an
 * exception.
 *
 * Vercel may have parsed the body already, in which case there is nothing to
 * cap — the platform's own limit applied — and it is returned as it is. */
export async function readCappedJson(req, max = MAX_BODY_BYTES) {
  if (req?.body && typeof req.body === "object") return { ok: true, body: req.body };

  const declared = Number(req?.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > max) {
    return { ok: false, error: "That body is too big." };
  }

  if (typeof req?.body === "string") {
    if (Buffer.byteLength(req.body) > max) return { ok: false, error: "That body is too big." };
    try { return { ok: true, body: JSON.parse(req.body) }; }
    catch { return { ok: false, error: "That body is not JSON." }; }
  }

  let bytes = 0;
  const parts = [];
  try {
    for await (const chunk of req) {
      const buf = Buffer.from(chunk);
      bytes += buf.length;
      /* Checked INSIDE the loop, not after it. Checking afterwards means the
       * whole 40MB has already arrived and been held in memory, which is the
       * cost the cap exists to avoid. */
      if (bytes > max) return { ok: false, error: "That body is too big." };
      parts.push(buf);
    }
  } catch {
    return { ok: false, error: "The body could not be read." };
  }
  const raw = Buffer.concat(parts).toString("utf8");
  if (!raw) return { ok: true, body: {} };
  try { return { ok: true, body: JSON.parse(raw) }; }
  catch { return { ok: false, error: "That body is not JSON." }; }
}

/* ------------------------------------------------------------------ */
/* The rate limit                                                      */
/* ------------------------------------------------------------------ */

/* One bucket per key, in this process's memory. See rule 3 above for exactly
 * what that is and is not worth. Capped at 5,000 keys so a flood cannot turn
 * the limiter itself into the memory leak. */
const buckets = new Map();
const MAX_KEYS = 5000;

/** True when this key may proceed. `limit` hits per `windowMs`. */
export function allowHit(key, limit, windowMs, nowMs = Date.now()) {
  const k = String(key || "-");
  const cutoff = nowMs - windowMs;

  if (buckets.size > MAX_KEYS) {
    /* Drop everything that has already expired; if that is not enough, drop
     * the lot. Forgetting is the safe direction for a best-effort limiter —
     * it lets real visitors through, it never wrongly blocks one. */
    for (const [bk, hits] of buckets) {
      const live = hits.filter((t) => t > cutoff);
      if (live.length) buckets.set(bk, live); else buckets.delete(bk);
    }
    if (buckets.size > MAX_KEYS) buckets.clear();
  }

  const hits = (buckets.get(k) || []).filter((t) => t > cutoff);
  if (hits.length >= limit) { buckets.set(k, hits); return false; }
  hits.push(nowMs);
  buckets.set(k, hits);
  return true;
}

/** Test-only. Nothing in the app should call this. */
export function _resetRateLimit() { buckets.clear(); }
