/* WHAT GOES WITH A CLIENT, AND WHAT SURVIVES IT.
 *
 * Until 31 Aug 2026 a client could not be removed from this console at all.
 * The Aug 30 dry run left a fake client on the list and there was no way to
 * take it off — that gap is written down twice in project memory.
 *
 * A delete here is not one row. Ten tables carry `on delete cascade` on
 * `client_id`, so their rows go when the client goes. Seven more carry
 * `on delete set null` — those rows SURVIVE and simply stop pointing at
 * anybody. The difference matters most for `admin_leads`: the lead this client
 * came from stays on the sales sheet, it just stops being linked.
 *
 * These lists exist so the screen can say what will actually happen, in words,
 * before anybody presses anything. A delete button that only says "are you
 * sure?" is a button people press without knowing what it does.
 *
 * `tests/client-delete` reads the migrations and fails if a new table gains a
 * client_id and is not named here — otherwise this list quietly goes stale and
 * the screen starts lying by omission.
 */

/** Rows that are DELETED with the client. Table name, then plain words. */
export const CLIENT_DELETE_CASCADES = [
  ["admin_tasks", "every task for this client"],
  ["admin_weekly_log", "the 8-week log"],
  ["admin_client_sites", "their websites"],
  ["admin_platform_accounts", "their platform logins"],
  ["admin_client_reports", "every report generated for them"],
  ["admin_client_connections", "their Google and analytics connections"],
  ["admin_connection_snapshots", "the readings taken from those connections"],
  ["admin_vault_items", "anything in the Vault filed under them"],
  ["admin_ai_notes", "AI notes about them"],
  ["admin_brain_memory", "what the AI Brain remembers about them"],
];

/** Rows that SURVIVE, with the link cleared. */
export const CLIENT_DELETE_KEEPS = [
  ["admin_leads", "the lead they came from stays on the sales sheet, unlinked"],
  ["admin_email_threads", "emails stay in the inbox, unlinked"],
  ["admin_invoices", "invoices stay in Finance, unlinked"],
  ["admin_expenses", "expenses stay in Finance, unlinked"],
  ["admin_usage_events", "AI cost history stays, unlinked"],
  ["admin_vault_reveals", "the record of who revealed a secret stays, unlinked"],
  ["admin_companies", "the firm on the sales sheet stays, unlinked"],
];

/**
 * THE GATE. Typing the name is not ceremony — it is the difference between
 * deleting the client you meant and the one that happened to be open.
 *
 * Case and outside spacing are forgiven because "ZZ TEST — Dry Run Realty" is
 * a name somebody retypes, not one they can paste from the row they are about
 * to destroy. Nothing else is: a near miss is a no.
 */
export function confirmsDelete(typed, clientName) {
  const a = String(typed ?? "").trim().toLowerCase();
  const b = String(clientName ?? "").trim().toLowerCase();
  if (!b) return false;
  return a === b;
}

/** One sentence a person can read before pressing, with the real task count. */
export function deleteWarning(clientName, taskCount) {
  const tasks = taskCount === null || taskCount === undefined
    ? "Its tasks"
    : `Its ${taskCount} task${taskCount === 1 ? "" : "s"}`;
  return `${tasks} go with ${clientName}, and so does everything else filed under it. This cannot be undone.`;
}
