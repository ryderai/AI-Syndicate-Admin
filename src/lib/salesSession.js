/* THE SALES PAGE STOPS STARTING OVER — 2 Sep 2026.
 *
 * Ryder: "for the sales page, it always resets and loads all the sales again. I
 * don't want it to do that, because someone goes to a different page as they're
 * working on a client, and then they go to a different page, come back — it's
 * gonna reset the whole thing … have it load all those sales the first time,
 * but then don't reload it until they click a button at the top that says
 * reload sales."
 *
 * THERE WERE TWO CAUSES AND THIS FILE IS THE SECOND ONE.
 *
 *   1. A tab switch rebuilt the WHOLE console. Supabase refreshes the token when
 *      a tab comes back to the front; the console read that as "who is this?"
 *      and showed the loading splash instead of the app. Fixed in src/lib/auth.js
 *      — nothing here can help with that, because by the time it happened every
 *      component was already gone.
 *
 *   2. Navigating away and back re-read 11 tables. AdminDashboard swaps pages
 *      on the route, so SalesPage unmounts, and everything it held died with it:
 *      the board, the open record, the search box, three filters and the view.
 *      That is what this module keeps.
 *
 * MODULE STATE, NOT localStorage, AND THE DIFFERENCE MATTERS. It lives as long
 * as the tab does and no longer. A filter kept in localStorage comes back
 * tomorrow morning, when nobody remembers setting it, and the page looks empty
 * for a reason that is invisible — this console has been bitten by a saved
 * preference hiding a feature twice already. Kept for the session, dropped on a
 * real page load, which is exactly "while you are working".
 *
 * NOTHING HERE IS A SOURCE OF TRUTH. It is the last thing the page read, handed
 * back so the page can draw immediately instead of showing a spinner. Every
 * write still reloads, and `Reload sales` reloads on demand.
 */

let cached = null;   // { board, at }  — the last board read from the database
let view = {};       // whatever the page asked us to hold on to

/** The board as it was last read, or null. `at` is when it was read. */
export function readBoardCache() {
  return cached;
}

/** Called after every read, including every reload. */
export function writeBoardCache(board) {
  cached = { board, at: Date.now() };
  return cached;
}

/** Start over from the database. Used by Start over and by signing out. */
export function clearBoardCache() {
  cached = null;
  view = {};
}

/**
 * How long ago the board was read, in words.
 *
 * NOT USED BY THE TOOLBAR ANY MORE. It said "loaded 2 minutes ago", computed
 * during render with nothing ticking and nothing subscribed, so it froze after
 * the first paint — the one number that made the no-reload design safe was the
 * number that lied. The toolbar shows the clock time it was read instead, which
 * cannot go stale. Kept and tested because "how long ago" is the right phrasing
 * anywhere something DOES re-render on a clock.
 */
export function boardAgeLabel(at, nowMs = Date.now()) {
  if (!at) return "not loaded yet";
  const secs = Math.max(0, Math.round((nowMs - at) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** What the page was looking at. Returns {} the first time. */
export function readView(key = "sales") {
  return view[key] || {};
}

/** Merge in what changed. The page calls this whenever one of them moves. */
export function writeView(patch, key = "sales") {
  view[key] = { ...(view[key] || {}), ...patch };
  return view[key];
}
