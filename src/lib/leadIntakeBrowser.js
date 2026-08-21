/* The browser's door to the lead-intake rules.
 *
 * WHY A RE-EXPORT AND NOT A COPY
 * This repo keeps server code in /lib and browser code in /src/lib, and that
 * split is worth keeping — it is what stops a server secret being bundled into
 * a page by accident. But the intake rules are the one thing that MUST be
 * identical on both sides: the browser decides "12 of these are already in the
 * pipeline" before an import saves, and the scraper decides the same thing on
 * the server. Two copies of that logic means the two answers drift, and the
 * day they drift is the day a rep phones somebody twice.
 *
 * So there is one file, /lib/lead-intake.js, and this is the browser's
 * doorway to it. That file is pure: no database, no network, no process.env,
 * nothing server-only. Check that it stays that way before adding to it —
 * this import is what would drag anything you add into the browser bundle.
 *
 * (The third copy is the SQL function admin_lead_dedupe_key in migration 0006,
 * which cannot import JavaScript. tests/brain/sql-crosscheck.sh runs the same
 * cases through a real Postgres and diffs the two answers.)
 */

export {
  cleanEmail, cleanPhone, cleanDomain, cleanText, cleanState,
  dedupeKey, dedupeWithin, splitAgainstExisting,
  guessColumn, toLeadRow, assignRoundRobin,
  LEAD_FIELDS,
} from "../../lib/lead-intake.js";
