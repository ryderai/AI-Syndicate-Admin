/* Sorting the Operations table by clicking a column title.
 *
 * A PLAIN .js MODULE ON PURPOSE. It used to live inside opsTable.jsx, where node
 * cannot import it, so the whole thing shipped with no test — and a checker
 * found three real bugs in it the same hour. Pure functions, no React, so
 * tests/ops can run them directly.
 *
 * Ryder, Aug 23 2026: *"i wanted to be able to just click the row and it would
 * sort the tasks in that row, for every click it gives it a new sorting list."*
 * Three states per column: the useful direction, the other one, off.
 */

/** The order statuses are worth, worst-to-best for reading a work list. */
export const STATUS_ORDER = ["todo", "in_progress", "blocked", "done"];
/** high first, because "sort by priority" means "show me the important ones". */
export const PRIORITY_ORDER = ["high", "medium", "low"];

export const SORTABLE = new Set([
  "name", "status", "client", "assignee", "priority",
  "category", "phase", "report", "description", "due",
]);

/**
 * What one column's value is worth, as { blank, v }.
 *
 * `blank` is its own field, not a magic number. The first version encoded
 * "missing" as 9 / 99 / -1 and then tested for those, and it was already wrong:
 * `admin_tasks.phase` has no check constraint, so a phase outside the five in
 * the UI list (an import, different casing, "Month 4") came back as indexOf -1,
 * counted as blank, and sank to the bottom in both directions — while
 * groupTasks used the same -1 as a rank and floated it to the top. Sort and
 * group disagreed about the same row.
 *
 * Unknown-but-present values now sort AFTER the known ones and are not blank.
 */
export function sortValue(t, key, { clientName, memberName, phases = [] } = {}) {
  const text = (v) => {
    const x = String(v ?? "").trim().toLowerCase();
    return { blank: x === "", v: x };
  };
  const ranked = (v, list) => {
    if (v === null || v === undefined || v === "") return { blank: true, v: list.length + 1 };
    const i = list.indexOf(v);
    return { blank: false, v: i === -1 ? list.length : i };
  };

  switch (key) {
    case "name": return text(t.name);
    case "status": return ranked(t.status, STATUS_ORDER);
    case "client": return text(clientName ? clientName(t.client_id) : t.client_id);
    case "assignee": return text(memberName ? memberName(t.assigned_to) : t.assigned_to);
    case "priority": return ranked(t.priority, PRIORITY_ORDER);
    case "category": return text(t.category);
    case "phase": return ranked(t.phase, phases);
    case "report": return text(t.latest_report);
    case "description": return text(t.description);
    case "due": return text(t.due_date);
    default: return null;                        // not a sortable column
  }
}

/** The table's own order when nothing is sorted: soonest due, then priority,
 *  then newest. Same as the Notion view it replaced. */
export function defaultOrder(rows) {
  const rank = (p) => {
    const i = PRIORITY_ORDER.indexOf(p);
    return i === -1 ? PRIORITY_ORDER.length : i;
  };
  return [...rows].sort((a, b) => {
    const ad = a.due_date || "9999-12-31";
    const bd = b.due_date || "9999-12-31";
    if (ad !== bd) return ad < bd ? -1 : 1;
    const ap = rank(a.priority);
    const bp = rank(b.priority);
    if (ap !== bp) return ap - bp;
    return (b.created_at || "").localeCompare(a.created_at || "");
  });
}

/**
 * Sort a group's rows. Never mutates. Blanks sink in BOTH directions — a task
 * with no due date floating to the top of a "soonest first" list is not
 * information.
 */
export function sortRowsBy(rows, sort, helpers = {}) {
  /* An unknown key must not quietly fall through to the tie-breaker: that
   * silently reordered the whole table by due date while the arrow claimed the
   * column had been sorted. */
  if (!sort || !sort.key || !SORTABLE.has(sort.key)) return defaultOrder(rows);
  const dir = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, sort.key, helpers);
    const bv = sortValue(b, sort.key, helpers);
    if (!av || !bv) return 0;
    if (av.blank !== bv.blank) return av.blank ? 1 : -1;
    if (av.v === bv.v) {
      const ad = a.due_date || "9999-12-31";
      const bd = b.due_date || "9999-12-31";
      if (ad !== bd) return ad < bd ? -1 : 1;
      return String(a.name || "").localeCompare(String(b.name || ""));
    }
    return (av.v < bv.v ? -1 : 1) * dir;
  });
}

/** Click 1 the useful way, click 2 the other way, click 3 off. */
export function nextSort(cur, key) {
  if (!SORTABLE.has(key)) return cur;
  if (!cur || cur.key !== key) return { key, dir: "asc" };
  if (cur.dir === "asc") return { key, dir: "desc" };
  return null;
}
