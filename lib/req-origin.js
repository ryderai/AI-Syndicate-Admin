/* Where is this request actually coming from?
 *
 * WHY THIS FILE EXISTS. Six places used to do:
 *     const proto = req.headers["x-forwarded-proto"] || "https";
 *
 * On Vercel that is right — the proxy always sets the header. On `npm run dev`
 * nothing sets it, so the server decided it was https while the browser was on
 * plain http://localhost:5173. That broke the Gmail connect flow twice over,
 * and both failures pointed away from the real cause:
 *
 *   1. The OAuth state cookie was written with `Secure`. A Secure cookie set
 *      over http is dropped, so the callback saw no cookie and answered
 *      `reason=browser_mismatch` — which reads like a browser problem.
 *   2. The redirect back to the console was built as `https://localhost:5173`,
 *      which Chrome answered with ERR_SSL_PROTOCOL_ERROR.
 *
 * Found Aug 28 2026, after the consent screen itself worked fine.
 *
 * A forwarded header always wins, so production behaviour is unchanged. Only a
 * request that arrives with NO forwarded proto and a localhost host is treated
 * as http. */

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function originFromRequest(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = forwarded ? String(forwarded).split(",")[0].trim()
    : (LOCAL.test(host) ? "http" : "https");
  const secure = proto === "https";
  return { proto, host, origin: `${proto}://${host}`, secure };
}

/** `Secure; ` only when the connection really is https. Everything else about
 * the cookie stays exactly as it was: HttpOnly, SameSite=Lax, scoped Path. */
export function secureFlag(req) {
  return originFromRequest(req).secure ? " Secure;" : "";
}
