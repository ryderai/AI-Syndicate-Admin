/* BRINGING NOTION OVER — the rules half.
 *
 * Two databases move into this console: 🏢 Clients and 📋 Operations. The
 * clients path already existed (ImportClientsModal, §11). Tasks had no path at
 * all — that gap is written down in project memory as "the thing the real
 * Notion rows need to come over".
 *
 * Everything decided here is decided in ONE place so a test can reach it,
 * which is the same reason src/lib/people.js and src/lib/pageForAddress.js
 * exist. Nothing in this file talks to a database or to React.
 *
 * THE FIVE RULES, and why each one is the way it is:
 *
 *  1. A TASK IS MATCHED BY (client, name). Notion page ids are not stored on
 *     admin_tasks, so the only stable key across a re-paste is the client it
 *     belongs to plus its title. Pasting the same export twice must not
 *     produce 216 tasks.
 *
 *  2. A CLIENT IS NEVER INVENTED. If the Client column names somebody who is
 *     not in admin_clients, that row is REFUSED and named on screen. A task
 *     silently landing with client_id null is a task nobody ever sees again —
 *     the same failure as the vanished task in the Aug 30 dry run.
 *
 *  3. AN EMPTY CELL NEVER BLANKS A VALUE. Notion's export leaves Phase, Due
 *     Date and Category empty on plenty of rows. Same rule as mergeLead in
 *     lib/sales-import.js, for the same reason.
 *
 *  4. DONE NEVER REOPENS. Work moves forward in the console after the merge;
 *     re-pasting a stale export must not drag a finished task back to To Do.
 *     Every other status change is allowed through, because Notion is the
 *     source of truth on the day of the merge.
 *
 *  5. A SECOND ASSIGNEE IS RECORDED, NEVER DROPPED. admin_tasks.assigned_to
 *     holds ONE person. Notion allows several. The first named person owns the
 *     row and the others are written into the description, because a name that
 *     is silently dropped is a person who thinks the work is theirs.
 */

/* Notion's own option words → this console's stored values. The left-hand side
 * is copied out of data source f9655de0-c309-4335-bd74-75b71bdb5089 character
 * for character, emoji included. If Notion adds an option, it lands in
 * `problems` rather than being guessed at. */
import { canDoDeliveryWork } from "../src/lib/people.js";

export const NOTION_STATUS = { "To Do": "todo", "In Progress": "in_progress", "Done": "done" };
export const NOTION_PRIORITY = { "🔴 High": "high", "🟡 Medium": "medium", "🟢 Low": "low" };

/* Category and Phase already match word for word (TASK_CATEGORIES /
 * TASK_PHASES in src/lib/data.js), which is the whole point of §11 rule 1.
 * They are still checked against the list rather than trusted. */
export const CATEGORIES = ["Access", "Business Intel", "Legal/Compliance", "Client Comms", "Billing", "Technical", "Content", "Reporting"];
export const PHASES = ["Onboarding", "Month 1", "Month 2", "Month 3", "Ongoing"];
export const STATUSES = ["todo", "in_progress", "done", "blocked"];
export const PRIORITIES = ["high", "medium", "low"];

const blankish = (v) => v === null || v === undefined || String(v).trim() === "";

/* RULE 6 — WHAT A RE-PASTE MAY NOT OVERWRITE.
 * `description` is the standing brief somebody types in the console. The
 * export carries only a link back to the Notion page in that field, so letting
 * a second paste win would replace a person's brief with a URL. It is filled
 * when empty and never touched again. `latest_report` is NOT on this list on
 * purpose: it is the current status, Notion is where it is written today, and
 * every change to it is now listed on the check screen before anything runs. */
export const FILL_ONLY = new Set(["description"]);

/** Names are compared with case, punctuation and runs of space flattened, so
 * "Dahler Group (30A)" and "dahler group (30a)" are one client. Deliberately
 * NOT the same as companyKey in sales-import.js — that one strips every
 * non-alphanumeric, which would fold "Week 1" and "Week1" together on a task
 * title where the space is meaningful. */
export function nameKey(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A due date is a plain YYYY-MM-DD. Notion hands back either that or a full
 * timestamp; a timestamp put straight into a `date` column is read in UTC and
 * can land a day early — the exact bug found in the Aug 30 dry run. So the
 * date part is taken as written and the clock is thrown away, never converted. */
export function dueDate(v) {
  if (blankish(v)) return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * One Notion row → one admin_tasks patch, plus anything that could not be
 * carried over. Never throws: a bad row comes back with `row: null` and a
 * reason, because one malformed row must not stop the other 107.
 *
 * @param raw     {client, name, status, priority, category, phase, due, report, description, assignees[]}
 * @param clients [{id, name}]   from admin_clients
 * @param team    [{user_id, email, active}]  from admin_users
 */
export function mapTask(raw, clients, team) {
  const problems = [];
  const name = String(raw?.name ?? "").trim();
  if (!name) return { row: null, problems: ["A row has no task name, so there is nothing to create."] };

  const wantClient = String(raw?.client ?? "").trim();
  if (!wantClient) return { row: null, problems: [`"${name}" names no client. Every task belongs to a client.`] };
  /* EQUALITY, and a refusal when two clients answer to it. Every other matcher
   * in this console refuses rather than picks (matchOwner, groupOwnerNames,
   * personLabel); a `.find()` here would put 36 tasks on whichever duplicate
   * happened to sort first. */
  const hits = (clients || []).filter((c) => nameKey(c.name) === nameKey(wantClient));
  if (!hits.length) {
    return { row: null, problems: [`"${name}" is for "${wantClient}", and there is no client by that name in the console. Add the client first, then paste again.`] };
  }
  if (hits.length > 1) {
    return { row: null, problems: [`"${name}" is for "${wantClient}", and there is more than one client by that name here. Merge or rename them first — nothing is guessed.`] };
  }
  const client = hits[0];

  const row = { client_id: client.id, name: name.slice(0, 400) };

  if (!blankish(raw?.status)) {
    const typed = String(raw.status).trim();
    const s = NOTION_STATUS[typed] || (STATUSES.includes(typed) ? typed : null);
    if (s) row.status = s;
    else problems.push(`"${name}": status "${raw.status}" is not one this console has, so it was left alone.`);
  }
  if (!blankish(raw?.priority)) {
    const typedP = String(raw.priority).trim();
    const p = NOTION_PRIORITY[typedP] || (PRIORITIES.includes(typedP) ? typedP : null);
    if (p) row.priority = p;
    else problems.push(`"${name}": priority "${raw.priority}" is not one this console has, so it was left alone.`);
  }
  if (!blankish(raw?.category)) {
    if (CATEGORIES.includes(String(raw.category).trim())) row.category = String(raw.category).trim();
    else problems.push(`"${name}": category "${raw.category}" is not on the list, so it was left blank.`);
  }
  if (!blankish(raw?.phase)) {
    if (PHASES.includes(String(raw.phase).trim())) row.phase = String(raw.phase).trim();
    else problems.push(`"${name}": phase "${raw.phase}" is not on the list, so it was left blank.`);
  }

  const due = dueDate(raw?.due);
  if (due) row.due_date = due;
  else if (!blankish(raw?.due)) problems.push(`"${name}": due date "${raw.due}" could not be read as a date, so it was left blank.`);

  if (!blankish(raw?.report)) row.latest_report = String(raw.report).slice(0, 20000);

  /* WHO OWNS IT. Matched on email, never on a display name — two members are
   * called "Ryder Schilling" (Aug 30 dry run), and a name match put a task on
   * the wrong one where nothing on screen looked wrong. */
  const emails = (Array.isArray(raw?.assignees) ? raw.assignees : [])
    .map((a) => String(a?.email ?? a ?? "").trim().toLowerCase()).filter(Boolean);
  const matched = [];
  const unmatched = [];
  for (const e of emails) {
    const m = (team || []).find((t) => String(t.email || "").toLowerCase() === e);
    if (!m) { unmatched.push({ email: e, why: "has no account here" }); continue; }
    /* THE SAME RULE EVERY PICKER USES. A sales rep's console has four pages and
     * Operations is not one of them, so a task handed to a rep is a task nobody
     * can open — src/lib/people.js says it at length. An import must not be the
     * one door left open; restricting one control is not restricting the act. */
    if (!canDoDeliveryWork(m)) {
      unmatched.push({ email: e, why: m.active === false ? "is deactivated" : `is a ${m.role || "sales"} account, and delivery work is not on their console` });
      continue;
    }
    matched.push({ email: e, user_id: m.user_id });
  }
  /* EVERYBODY, not just the first. Until migration 0028 this console held one
   * person per task, so the import put the first name on the row and wrote the
   * rest into the brief — a name demoted to prose. Now the whole list goes on
   * the task and `assigned_to` follows from its first entry. 31 Aug 2026. */
  if (matched.length) {
    row.assignees = matched.map((m) => m.user_id);
    row.assigned_to = matched[0].user_id;
  }
  for (const u of unmatched) {
    problems.push(`"${name}": ${u.email} is assigned in Notion but ${u.why}, so they are not on this task.`);
  }

  /* Only the people who could NOT be put on the task go in the brief now.
   * A second assignee who HAS an account is on the row itself, so repeating
   * them in the text would read as a third person. */
  const extras = unmatched.map((u) => u.email);
  const descParts = [];
  if (!blankish(raw?.description)) descParts.push(String(raw.description));
  if (extras.length) descParts.push(`Also assigned in Notion: ${extras.join(", ")}.`);
  if (descParts.length) row.description = descParts.join("\n\n").slice(0, 20000);

  return { row, problems, clientName: client.name };
}

/**
 * The whole paste → exactly what will happen, before anything happens.
 * Returns creates, updates, unchanged rows, and every refusal by name.
 *
 * `existing` is every admin_tasks row already in the console.
 */
export function planTaskImport(list, { clients, team, existing }) {
  const out = { create: [], update: [], unchanged: [], problems: [], duplicatesInPaste: [] };
  if (!Array.isArray(list)) { out.problems.push("That is not a JSON list. It should start with [."); return out; }

  const byKey = new Map();
  for (const t of existing || []) byKey.set(`${t.client_id}::${nameKey(t.name)}`, t);

  const seen = new Set();
  for (const raw of list) {
    const { row, problems, clientName } = mapTask(raw, clients, team);
    out.problems.push(...(problems || []));
    if (!row) continue;

    const key = `${row.client_id}::${nameKey(row.name)}`;
    if (seen.has(key)) {
      out.duplicatesInPaste.push(`${clientName} — "${row.name}" appears more than once in this paste. Only the first was used.`);
      continue;
    }
    seen.add(key);

    const found = byKey.get(key);
    if (!found) { out.create.push({ row, clientName }); continue; }

    /* RULES 3, 4 and 6 live here. */
    const patch = { id: found.id };
    const changes = [];
    for (const [k, v] of Object.entries(row)) {
      if (k === "client_id" || k === "name") continue;
      /* Arrays never compare equal with ===, so `assignees` would look changed
       * on every single re-paste and rewrite 107 rows for nothing. Compared as
       * a list, in order, because order is who the primary is. */
      if (k === "assignees") {
        const before = Array.isArray(found.assignees) ? found.assignees : (found.assigned_to ? [found.assigned_to] : []);
        if (before.length === v.length && before.every((x, i) => x === v[i])) continue;
        patch[k] = v;
        changes.push({ field: k, from: before.length ? `${before.length} person(s)` : null, to: `${v.length} person(s)` });
        continue;
      }
      /* Rule 3. mapTask never puts a blank in `row`, so an empty Notion cell
       * arrives as an ABSENT key rather than an empty one and can never reach
       * here — this line is the second lock on the same door, and the test for
       * rule 3 is on mapTask, where the rule actually acts. */
      if (blankish(v)) continue;
      if (k === "status" && found.status === "done" && v !== "done") continue; // rule 4
      if (FILL_ONLY.has(k) && !blankish(found[k])) continue;                   // rule 6
      if (found[k] === v) continue;
      patch[k] = v;
      changes.push({ field: k, from: found[k] ?? null, to: v });
    }
    if (changes.length) out.update.push({ patch, clientName, name: row.name, changes });
    else out.unchanged.push({ clientName, name: row.name });
  }
  return out;
}

/** One line a person can read, for the screen and for the activity log. */
export function planSummary(plan) {
  const bits = [];
  bits.push(`${plan.create.length} new`);
  bits.push(`${plan.update.length} updated`);
  bits.push(`${plan.unchanged.length} already right`);
  if (plan.problems.length) bits.push(`${plan.problems.length} refused`);
  return bits.join(" · ");
}
