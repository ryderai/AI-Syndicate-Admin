/* MORE THAN ONE PERSON ON A TASK — the rules half.
 *
 * Migration 0028 added `admin_tasks.assignees uuid[]` and kept `assigned_to` as
 * THE PRIMARY, always equal to `assignees[0]`. That shape exists so the ~30
 * places that read `assigned_to` keep working untouched; see the migration's
 * own header for why a join table was the wrong answer here.
 *
 * Everything below is pure. No database, no React.
 *
 * THE RULES:
 *
 *  1. THE PRIMARY IS THE FIRST NAME, and it is never a separate fact. Storing
 *     "who owns it" twice is storing a disagreement — the Aug 30 dry run lost a
 *     task to exactly that shape.
 *
 *  2. ORDER IS MEANING, so de-duplicating must not sort. `array_agg(distinct)`
 *     in Postgres and `[...new Set()]` in JS behave differently here; the
 *     trigger and this file both keep first-seen order on purpose.
 *
 *  3. NOBODY IS ADDED WHO CANNOT OPEN THE TASK. `canDoDeliveryWork` already
 *     says a sales rep's console has no Operations page. Two ways onto a task
 *     is two doors, not one.
 *
 *  4. WHOEVER ALREADY HOLDS IT STAYS PICKABLE. Filtering an existing assignee
 *     out of the list would make the screen say "Unassigned" while the database
 *     says otherwise — the same rule `deliveryPeopleOptions` already follows.
 *
 *  5. EMPTY MEANS EMPTY ON BOTH. No primary and no list; never one without the
 *     other.
 */

import { canDoDeliveryWork } from "../src/lib/people.js";

/** A hard ceiling, so a bad paste cannot put four hundred ids on one row. */
export const MAX_ASSIGNEES = 10;

/** De-duplicate and drop blanks, KEEPING FIRST-SEEN ORDER. Rule 2. */
export function cleanAssignees(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const id = typeof v === "string" ? v.trim() : v;
    if (!id) continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_ASSIGNEES) break;
  }
  return out;
}

/** Who a task belongs to on a screen with one slot. Rule 1. */
export function primaryOf(assignees) {
  const c = cleanAssignees(assignees);
  return c.length ? c[0] : null;
}

/**
 * The two fields to write, from whatever the screen is holding.
 * Always returns BOTH, so no caller can set one and forget the other — the
 * database trigger is the second lock on the same door, not the only one.
 */
export function assigneePatch(list) {
  const assignees = cleanAssignees(list);
  return { assignees, assigned_to: assignees.length ? assignees[0] : null };
}

/** Everybody on a task, whichever column the row happens to carry.
 *
 * A row read before 0028 ran, or written by a caller that only knows about
 * `assigned_to`, has no array. Falling back to the single field means this
 * function is safe to use everywhere from the first deploy, rather than after
 * a backfill lands. */
export function assigneesOf(task) {
  const arr = cleanAssignees(task?.assignees);
  if (arr.length) return arr;
  return task?.assigned_to ? [task.assigned_to] : [];
}

/** Is this person ON this task — as primary or as anybody else?
 *
 * This is what the Work page must ask. Asking `assigned_to === me` is what
 * makes a second assignee's work invisible to them. */
export function isAssignedTo(task, userId) {
  if (!userId) return false;
  return assigneesOf(task).includes(userId);
}

/** Add somebody, without disturbing who is primary. Rule 1. */
export function addAssignee(list, userId) {
  if (!userId) return cleanAssignees(list);
  return cleanAssignees([...cleanAssignees(list), userId]);
}

/** Take somebody off. If they were primary, the next person becomes primary —
 * the task does not silently fall to Unassigned while somebody is still on it. */
export function removeAssignee(list, userId) {
  return cleanAssignees(list).filter((x) => x !== userId);
}

/** Toggle, which is what a checkbox in a menu does. */
export function toggleAssignee(list, userId) {
  return cleanAssignees(list).includes(userId)
    ? removeAssignee(list, userId)
    : addAssignee(list, userId);
}

/** Make somebody the primary without removing anybody. */
export function makePrimary(list, userId) {
  const c = cleanAssignees(list);
  if (!userId || !c.includes(userId)) return c;
  return [userId, ...c.filter((x) => x !== userId)];
}

/**
 * Who may be PUT on a task: everyone who can do delivery work, plus anybody
 * already on this one so the screen never contradicts the database. Rules 3+4.
 *
 * @param team      admin_users rows
 * @param heldBy    the ids currently on the task
 */
export function assignableTeam(team, heldBy = []) {
  const roster = team || [];
  const held = new Set(cleanAssignees(heldBy));
  return roster.filter((m) => canDoDeliveryWork(m) || held.has(m.user_id));
}

/** "Ryder Schilling" · "Ryder Schilling +1" · "Unassigned" — one slot, honest
 * about the rest. `labelFor` is passed in so this file never has to know how a
 * person's name is drawn (two members share one, see src/lib/people.js). */
export function assigneeLabel(task, labelFor) {
  const ids = assigneesOf(task);
  if (!ids.length) return null;
  const first = labelFor(ids[0]) || "Someone";
  return ids.length === 1 ? first : `${first} +${ids.length - 1}`;
}
