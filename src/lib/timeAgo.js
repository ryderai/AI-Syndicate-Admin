/* "3d ago" — and, since 30 Aug 2026, "in 3d".
 *
 * WHY THIS IS ITS OWN FILE. It lived in shared.jsx, which node cannot import,
 * so the one function every page uses to say WHEN something happened had no
 * test at all. It was wrong in two ways at once and both were on screen:
 *
 *   1. A FUTURE TIME READ AS THE PAST. The elapsed seconds went negative, the
 *      very first branch was `if (s < 60) return "just now"`, and every
 *      negative number is less than 60 — so a client whose start date is next
 *      month showed "just now" on the Clients page, and one starting tomorrow
 *      showed "1h ago". An onboarding client with a future start date is the
 *      normal case, not an edge case.
 *   2. AN UNPARSEABLE VALUE RENDERED AS "Invalid Date". NaN fails every
 *      comparison, so it fell through to the last line and printed that.
 *
 * The rule now: the past reads "… ago", the future reads "in …", anything
 * inside a minute either way reads "just now", and nothing unreadable is ever
 * printed to a screen.
 */

/** How long ago, or how far ahead. `now` is injectable so the tests are not
 * a race against the clock. */
export function timeAgo(iso, now = Date.now()) {
  if (iso === null || iso === undefined || iso === "") return "—";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return "—";

  const s = Math.round((now - t) / 1000);
  const abs = Math.abs(s);

  // Inside a minute either way is "just now" — nobody wants "in 12s".
  if (abs < 60) return "just now";

  const ahead = s < 0;
  const wrap = (body) => (ahead ? `in ${body}` : `${body} ago`);

  if (abs < 3600) return wrap(`${Math.floor(abs / 60)}m`);
  if (abs < 86400) return wrap(`${Math.floor(abs / 3600)}h`);
  if (abs < 86400 * 30) return wrap(`${Math.floor(abs / 86400)}d`);

  // Beyond a month, the date itself is more use than a count of days.
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
