/* A TASK KEEPS ITS UPDATES — the rules half.
 *
 * Migration 0029 added `admin_task_updates` and kept `admin_tasks.latest_report`
 * as THE NEWEST UPDATE, written by a trigger. That shape exists so the ~10
 * places that read `latest_report` — the Operations table, the board card, the
 * Work page row, the client page, the AI Brain's context, the assistant's
 * tools, every report generator — keep working untouched. See the migration's
 * own header for why the column was not replaced.
 *
 * Everything below is pure. No database, no React.
 *
 * THE RULES:
 *
 *  1. THE ONE LINE IS THE NEWEST UPDATE. Never a second fact kept beside the
 *     history. Two places holding "where does this stand" is two places to be
 *     wrong, which is the rule 0028 already had to learn about who owns a task.
 *
 *  2. AN UPDATE IS A RECORD OF WHAT SOMEBODY SAID. It carries who and when, and
 *     only its author (or an admin) may change it. A history anyone can rewrite
 *     is worse than no history, because a report is built on it.
 *
 *  3. A CARRIED-OVER ROW SAYS SO. The 0029 backfill turned each existing
 *     `latest_report` into an update dated to the task's `updated_at`, because
 *     that is the only date that ever existed for it. The screen must say that
 *     rather than show it as if somebody posted it then. A timestamp captured
 *     at a different moment than the write it describes is a lie the screen
 *     would repeat.
 *
 *  4. NEWEST FIRST, AND TIES BREAK THE SAME WAY EVERYWHERE. Two updates can
 *     share a second — an import, or a fast double-post. The trigger orders by
 *     `created_at desc, id desc`; so does this file. If they disagreed, the
 *     screen's top row and the task's one line would be different sentences.
 *
 *  5. AN EMPTY UPDATE IS NOT AN UPDATE. Posting whitespace would overwrite the
 *     line every screen shows with nothing, and there would be no way back to
 *     the sentence it replaced.
 */

/* Long enough for a real paragraph of progress; short enough that a brief does
 * not get pasted in here. The brief is `description` and has its own box. */
export const MAX_UPDATE = 2000;

/** The text of an update, or null if there is nothing in it. Rule 5. */
export function cleanUpdateBody(body) {
  const s = String(body ?? "").trim();
  if (!s) return null;
  return s.length > MAX_UPDATE ? s.slice(0, MAX_UPDATE) : s;
}

/** Is this postable at all? Used to keep the button dead rather than fail late. */
export function canPost(body) {
  return cleanUpdateBody(body) !== null;
}

/** Newest first, ties broken by id — the same order the 0029 trigger uses. Rule 4. */
export function sortUpdates(rows) {
  return [...(rows || [])].sort((a, b) => {
    const t = String(b?.created_at || "").localeCompare(String(a?.created_at || ""));
    return t !== 0 ? t : String(b?.id || "").localeCompare(String(a?.id || ""));
  });
}

/** The newest update on a task, or null. */
export function newestUpdate(rows) {
  return sortUpdates(rows)[0] || null;
}

/** What `latest_report` should be for this set of updates. Rule 1. */
export function latestLineFrom(rows) {
  const n = newestUpdate(rows);
  return n ? n.body : null;
}

/**
 * Does the task's one line agree with its own history?
 *
 * Answers "yes" when there are no updates at all — a task whose line was typed
 * straight into the field before 0029 ran, or by the importer, is not in
 * disagreement with anything. Only a task that HAS updates can contradict them.
 */
export function lineAgrees(task, rows) {
  const list = rows || [];
  if (!list.length) return true;
  const want = latestLineFrom(list);
  const have = task?.latest_report ?? null;
  return String(want ?? "") === String(have ?? "");
}

/** Rule 2. An admin may tidy the history; nobody else touches another person's words. */
export function canEditUpdate(row, userId, role) {
  if (!row || !userId) return false;
  if (row.author && row.author === userId) return true;
  return role === "owner" || role === "admin";
}

/**
 * Who wrote it, in words. `labelFor` turns a user id into a name; a row with no
 * author is not "Unknown" — it is a row that predates anyone typing it, and
 * saying so is the honest version. Rule 3.
 */
export function updateAuthorLabel(row, labelFor) {
  if (!row) return "";
  if (!row.author) return row.carried_over ? "carried over" : "someone";
  const name = labelFor ? labelFor(row.author) : null;
  return name || "someone";
}

/**
 * The date line under an update. A carried-over row is labelled as the task's
 * own last-changed date, never as a posting time. Rule 3.
 */
export function updateStamp(row, now = Date.now()) {
  if (!row) return "";
  const ms = Date.parse(row.created_at || "");
  if (Number.isNaN(ms)) return row.carried_over ? "date unknown" : "just now";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString("en-US", sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return row.carried_over ? `${date} · the task's own last-changed date` : `${date}, ${time}`;
}

/**
 * The console is deployed before its migration is run, every time. Postgres
 * answers a missing table with 42P01, and PostgREST with a schema-cache miss —
 * both are the same thing to a person: the updates table is not there yet.
 *
 * Matching the table name as well as the code keeps this from swallowing an
 * unrelated missing table and telling somebody to run the wrong migration.
 */
export function isMissingUpdatesTable(error) {
  const s = String(error || "");
  if (!/admin_task_updates/.test(s)) return false;
  return /42P01|does not exist|Could not find the table|schema cache/i.test(s);
}
