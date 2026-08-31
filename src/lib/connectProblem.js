/* WHY THE MAILBOX DID NOT CONNECT, IN WORDS A PERSON CAN ACT ON.
 *
 * Two different walls stop a mailbox connecting, and until 31 Aug 2026 both of
 * them ended with the same screen — "Connect your work email" — and no reason.
 *
 *   1. Google refuses BEFORE our code runs. The console's Google app has its
 *      Audience set to Internal, so Google only lets an @aisyndicate.com
 *      Workspace account grant it anything. A personal Gmail gets
 *      "Access blocked ... can only be used within its organization,
 *      Error 403: org_internal" on Google's own page, and **the browser is
 *      never sent back to us** — so no code here can ever report it. The only
 *      cure is to say which address to use BEFORE the button is pressed, which
 *      is what COMPANY_ADDRESS_NOTE below is for.
 *
 *   2. Google DOES send the browser back, carrying `?gmail=error&reason=...`.
 *      Those are the ones this file translates. The raw reason was shown as-is,
 *      so a rep read "browser_mismatch" or "invalid_state" and had nothing to
 *      do about it.
 *
 * Anything not in the table is passed through rather than swallowed: an unknown
 * reason is still better than a friendly sentence that is wrong.
 */

/** The wall that never reaches our code. Shown on the connect screen itself.
 *
 * KEEP THIS IN STEP WITH THE GOOGLE CLOUD SETTING. If the Audience is ever
 * changed from Internal to External, this sentence becomes false and has to
 * change in the same commit — Google Auth Platform -> Audience. */
export const COMPANY_ADDRESS_NOTE =
  "Use your @aisyndicate.com address. Google refuses a personal Gmail here before it ever reaches us.";

const REASONS = {
  access_denied:
    "You (or Google) stopped the sign-in before it finished. Nothing was connected. If you picked a personal Gmail, use your @aisyndicate.com address instead.",
  org_internal:
    "Google blocked it: this console only accepts @aisyndicate.com addresses. Start again and pick your company address.",
  browser_mismatch:
    "The sign-in finished in a different browser or tab than the one that started it. Start again in this tab, and don't forward the Google link to anybody.",
  invalid_state:
    "That sign-in link had already been used. Press Continue with Google again for a fresh one.",
  state_expired:
    "The sign-in took longer than ten minutes, so it timed out. Press Continue with Google again.",
  missing_params:
    "Google sent us back without the code we need. Press Continue with Google again.",
  server_not_configured:
    "The console's own Google keys are not set on the server, so nothing can connect yet.",
  store_failed:
    "Google said yes, but we could not save the connection. Nothing is connected — try again, and if it repeats it is a database problem, not a Google one.",
};

/** Plain words for a `reason` from the OAuth callback.
 * Returns the raw reason for anything unknown, never an empty string —
 * "Connecting failed" with a blank line under it is not a message. */
export function explainConnectFailure(reason) {
  const key = String(reason || "").trim();
  if (!key) return "Google did not say why. Press Continue with Google to try again.";
  if (REASONS[key]) return REASONS[key];
  /* Google's own token-exchange failures arrive as a whole sentence, already
   * readable, url-encoded by the callback. Decoding a string with a stray %
   * throws, so it is guarded. */
  let decoded = key;
  try { decoded = decodeURIComponent(key); } catch { /* keep the raw value */ }
  return decoded;
}
