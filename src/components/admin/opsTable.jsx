import { useMemo, useState } from "react";
import {
  TASK_STATUSES, TASK_STATUS_LABELS, TASK_CATEGORIES, TASK_PHASES,
  TASK_PRIORITIES, TASK_PRIORITY_LABELS,
} from "../../lib/data.js";
/* The sort itself lives in a plain .js module so it can be tested — see
 * src/lib/opsSort.js and tests/ops. */
import { STATUS_ORDER, sortRowsBy, nextSort } from "../../lib/opsSort.js";
import { personLabel } from "../../lib/people.js";
import {
  Chip, SelectCell, PersonCell, TextCell, PopoutCell, DateCell, Avatar, todayISO, Popover,
  STATUS_COLOR, PRIORITY_COLOR, PRIORITY_ICON, CATEGORY_COLOR, PHASE_COLOR, clientColor,
} from "./opsCells.jsx";

/* The Operations database — the same shape as the Notion table it replaces:
 * one row per task, grouped, every cell editable where it sits.
 *
 * Grouping and sorting are computed HERE and nowhere else, so a group header
 * count can never disagree with the rows under it. */

const PRI_RANK = { high: 0, medium: 1, low: 2 };

export const GROUP_OPTIONS = [
  ["client", "Client"], ["status", "Status"], ["assignee", "Assigned to"],
  ["due", "Due date"], ["category", "Category"], ["phase", "Phase"],
  ["priority", "Priority"], ["none", "No grouping"],
];

const GROUP_KEYS = new Set(GROUP_OPTIONS.map(([v]) => v));
/** Group-by comes out of localStorage, so it has to be checked before use — an
 *  unknown value used to render a table with a header and no rows at all. */
export function isGroupBy(v) { return GROUP_KEYS.has(v); }

export const COLUMNS = [
  { key: "name", label: "Task", width: 340, locked: true },
  { key: "status", label: "Status", width: 132 },
  { key: "client", label: "Client", width: 180 },
  { key: "assignee", label: "Assigned to", width: 158 },
  { key: "priority", label: "Priority", width: 116 },
  { key: "category", label: "Category", width: 152 },
  { key: "phase", label: "Phase", width: 118 },
  { key: "report", label: "Latest report", width: 280 },
  /* The standing brief, added Aug 23 2026. Not the same field as Latest report:
   * that one is this week's status and gets overwritten; this is what the work
   * IS. Needs migration 0012. */
  { key: "description", label: "Description", width: 340 },
  /* Due date sits LAST. Ryder, Aug 23 2026. The sort still puts the soonest
   * due first — where the column sits and how the rows order are unrelated. */
  { key: "due", label: "Due date", width: 124 },
];

export const DEFAULT_COLUMNS = COLUMNS.map((c) => c.key);

export function plusDaysISO(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function isOverdue(t) {
  return !!t.due_date && t.status !== "done" && t.due_date < todayISO();
}

export function dueBucket(t) {
  /* `preset` is what a task typed into this group should start with. Without it,
   * a task added under "Due today" would have no date at all — and the This-week
   * view would hide the row the moment it was created. */
  const today = todayISO();
  if (!t.due_date) return { key: "none", label: "No date", color: "default", rank: 4, preset: { due_date: null } };
  if (t.due_date < today) return { key: "late", label: "Late", color: "red", rank: 0, preset: { due_date: today } };
  if (t.due_date === today) return { key: "today", label: "Due today", color: "orange", rank: 1, preset: { due_date: today } };
  if (t.due_date <= plusDaysISO(7)) return { key: "week", label: "Next 7 days", color: "yellow", rank: 2, preset: { due_date: plusDaysISO(7) } };
  return { key: "later", label: "Later", color: "default", rank: 3, preset: { due_date: plusDaysISO(14) } };
}

/** Newest-first is useless for work you have to do: soonest due first, then
 *  priority, then newest. Same order as the Notion view. */
export function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const ad = a.due_date || "9999-12-31";
    const bd = b.due_date || "9999-12-31";
    if (ad !== bd) return ad < bd ? -1 : 1;
    const ap = PRI_RANK[a.priority] ?? 3;
    const bp = PRI_RANK[b.priority] ?? 3;
    if (ap !== bp) return ap - bp;
    return (b.created_at || "").localeCompare(a.created_at || "");
  });
}

export function groupTasks(tasks, groupBy, { clientName, memberName }) {
  if (groupBy === "none" || !GROUP_KEYS.has(groupBy)) {
    return [{ key: "all", label: "All tasks", color: "default", rows: tasks, preset: {}, rank: 0 }];
  }
  const map = new Map();
  const add = (key, label, color, rank, preset, t) => {
    const k = String(key);
    if (!map.has(k)) map.set(k, { key: k, label, color, rank, preset, rows: [] });
    map.get(k).rows.push(t);
  };

  for (const t of tasks) {
    if (groupBy === "client") {
      const n = t.client_id ? clientName(t.client_id) : null;
      add(t.client_id || "__none", n || "No client", n ? clientColor(n) : "default",
        n ? 0 : 1, { client_id: t.client_id || null }, t);
    } else if (groupBy === "status") {
      add(t.status, TASK_STATUS_LABELS[t.status] || t.status, STATUS_COLOR[t.status],
        STATUS_ORDER.indexOf(t.status), { status: t.status }, t);
    } else if (groupBy === "assignee") {
      const n = t.assigned_to ? memberName(t.assigned_to) : null;
      add(t.assigned_to || "__none", n || "Unassigned", n ? "blue" : "default",
        n ? 0 : 1, { assigned_to: t.assigned_to || null }, t);
    } else if (groupBy === "due") {
      const b = dueBucket(t);
      add(b.key, b.label, b.color, b.rank, b.preset, t);
    } else if (groupBy === "category") {
      const v = t.category || null;
      add(v || "__none", v || "No category", v ? (CATEGORY_COLOR[v] || "default") : "default",
        v ? TASK_CATEGORIES.indexOf(v) : 99, { category: v }, t);
    } else if (groupBy === "phase") {
      const v = t.phase || null;
      add(v || "__none", v || "No phase", v ? (PHASE_COLOR[v] || "default") : "default",
        v ? TASK_PHASES.indexOf(v) : 99, { phase: v }, t);
    } else if (groupBy === "priority") {
      add(t.priority, `${PRIORITY_ICON[t.priority] || ""} ${TASK_PRIORITY_LABELS[t.priority] || t.priority}`.trim(),
        PRIORITY_COLOR[t.priority], PRI_RANK[t.priority] ?? 9, { priority: t.priority }, t);
    }
  }

  return [...map.values()].sort((a, b) => (a.rank - b.rank) || a.label.localeCompare(b.label));
}

/* ------------------------------------------------------------------ */

export default function TaskDatabase({
  tasks, groupBy, columns = DEFAULT_COLUMNS, clients, team,
  onPatch, onCreate, onOpen, onOpenClient, lockedClientId = null,
  /* Click-to-filter. Both optional: the client page passes neither, and the
   * table then behaves exactly as it did before. */
  onFacet = null, onGroupBy = null, facetValue = () => undefined,
  /* Every task the page holds, BEFORE filtering. The header menus are built
   * from this and not from `tasks`: built from the filtered rows, filtering to
   * Category = Access left the Phase menu offering only the phases inside
   * Access, so Month 1 could not be reached from the header at all. */
  allTasks = null,
}) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [draftGroup, setDraftGroup] = useState(null);
  /* Which column the titles are sorting by, and which way. Not saved: a sort is
   * something you do for a minute, unlike grouping and columns. */
  const [sort, setSort] = useState(null);

  const clientName = (id) => clients.find((c) => c.id === id)?.name || null;
  const memberName = (id) => {
    const m = team.find((x) => x.user_id === id);
    return m ? personLabel(m, team) : null;
  };

  const clientOptions = useMemo(
    () => clients.map((c) => ({ value: c.id, label: c.name, color: clientColor(c.name) })),
    [clients],
  );
  const personOptions = useMemo(
    () => team.filter((m) => m.active !== false)
      // Two teammates with the same name must not draw two identical rows.
      .map((m, _i, list) => ({ value: m.user_id, label: personLabel(m, list) })),
    [team],
  );
  /* Deactivating someone does not un-own their tasks. If the owner is no longer
   * in the pickable list, show them anyway, marked — rendering the cell as
   * "Unassigned" would be the table lying about who has it. */
  const personOptionsFor = (t) => {
    if (!t.assigned_to || personOptions.some((o) => o.value === t.assigned_to)) return personOptions;
    return [...personOptions, { value: t.assigned_to, label: `${memberName(t.assigned_to) || "Former member"} · inactive` }];
  };
  const statusOptions = TASK_STATUSES.map((s) => ({ value: s, label: TASK_STATUS_LABELS[s], color: STATUS_COLOR[s] }));
  const priorityOptions = TASK_PRIORITIES.map((p) => ({ value: p, label: `${PRIORITY_ICON[p]} ${TASK_PRIORITY_LABELS[p]}`, color: PRIORITY_COLOR[p] }));
  const categoryOptions = TASK_CATEGORIES.map((c) => ({ value: c, label: c, color: CATEGORY_COLOR[c] }));
  const phaseOptions = TASK_PHASES.map((p) => ({ value: p, label: p, color: PHASE_COLOR[p] }));

  const groups = useMemo(
    () => groupTasks(tasks, groupBy, { clientName, memberName }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, groupBy, clients, team],
  );

  const visible = COLUMNS.filter((c) => c.locked || columns.includes(c.key));
  const span = visible.length + 1;

  const toggle = (key) => setCollapsed((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  /* One descriptor per cell, handed to the cell's own menu. `column` is the
   * word a person sees ("Group the table by Client"), so it comes from COLUMNS
   * rather than from the field name. */
  const colLabel = (key) => COLUMNS.find((c) => c.key === key)?.label || key;

  /* The words a person reads for one stored value. "__none" is spelled out
   * rather than shown as a blank row in the menu. */
  const labelForValue = (key, v) => {
    if (v === "__none" || v === null || v === undefined || v === "") {
      return key === "client" ? "No client"
        : key === "assignee" ? "Unassigned" : `No ${colLabel(key).toLowerCase()}`;
    }
    if (key === "client") return clientName(v) || "Unknown client";
    if (key === "assignee") return memberName(v) || "Former member";
    if (key === "status") return TASK_STATUS_LABELS[v] || v;
    if (key === "priority") return `${PRIORITY_ICON[v] || ""} ${TASK_PRIORITY_LABELS[v] || v}`.trim();
    return String(v);
  };
  const filterFor = (key, value, label) => {
    if (!onFacet && !onGroupBy) return null;
    return {
      label,
      column: colLabel(key),
      /* `|| "__none"`, not `?? "__none"`: the page's own filter compares
       * String(field || "__none"), so a field holding "" has to travel as
       * "__none" here too or the click sets a filter that matches nothing. */
      active: facetValue(key) === (value || "__none"),
      onOnly: onFacet && key !== "due" ? () => onFacet(key, value || "__none") : null,
      onGroup: onGroupBy ? () => onGroupBy(key) : null,
    };
  };

  const cell = (t, key) => {
    switch (key) {
      case "name":
        return (
          <TextCell
            value={t.name} required strong strike={t.status === "done"}
            placeholder="Untitled" onChange={(v) => onPatch(t, { name: v })}
          />
        );
      case "status":
        return <SelectCell label="Status" value={t.status} options={statusOptions} clearable={false} onChange={(v) => onPatch(t, { status: v })} filter={filterFor("status", t.status, TASK_STATUS_LABELS[t.status] || t.status)} />;
      case "client":
        return <SelectCell label="Client" value={t.client_id} options={clientOptions} placeholder="No client" onChange={(v) => onPatch(t, { client_id: v })} filter={filterFor("client", t.client_id, clientName(t.client_id) || "tasks with no client")} />;
      case "assignee":
        return <PersonCell value={t.assigned_to} options={personOptionsFor(t)} onChange={(v) => onPatch(t, { assigned_to: v })} filter={filterFor("assignee", t.assigned_to, memberName(t.assigned_to) || "unassigned tasks")} />;
      case "priority":
        return <SelectCell label="Priority" value={t.priority} options={priorityOptions} clearable={false} onChange={(v) => onPatch(t, { priority: v })} filter={filterFor("priority", t.priority, TASK_PRIORITY_LABELS[t.priority] || t.priority)} />;
      case "due":
        return <DateCell value={t.due_date} overdue={isOverdue(t)} onChange={(v) => onPatch(t, { due_date: v })} filter={filterFor("due", t.due_date, t.due_date || "no date")} />;
      case "category":
        return <SelectCell label="Category" value={t.category} options={categoryOptions} onChange={(v) => onPatch(t, { category: v })} filter={filterFor("category", t.category, t.category || "tasks with no category")} />;
      case "phase":
        return <SelectCell label="Phase" value={t.phase} options={phaseOptions} onChange={(v) => onPatch(t, { phase: v })} filter={filterFor("phase", t.phase, t.phase || "tasks with no phase")} />;
      case "report":
        return <TextCell value={t.latest_report} multiline placeholder="Empty" onChange={(v) => onPatch(t, { latest_report: v })} />;
      case "description":
        /* Pops out instead of editing in the cell: a brief is longer than a row
         * is tall, and the cell shows three lines of it at most. */
        return (
          <PopoutCell
            value={t.description} placeholder="Add the brief…"
            title={`Description — ${t.name}`}
            hint="What this work is, why we are doing it, what finished looks like, and any link or login it needs."
            onChange={(v) => onPatch(t, { description: v })}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="adm-db">
      <div className="adm-db-scroll">
        <table className="adm-db-table">
          <colgroup>
            {visible.map((c) => <col key={c.key} style={{ width: c.width }} />)}
            <col style={{ width: 46 }} />
          </colgroup>
          <thead>
            <tr>
              {visible.map((c) => (
                <th
                  key={c.key}
                  /* Said out loud for a screen reader: the arrow and the dot are
                   * both aria-hidden, so without this the sort state was
                   * invisible to anyone not looking at the pixels. */
                  aria-sort={sort && sort.key === c.key
                    ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <ColumnHead
                    col={c}
                    tasks={allTasks || tasks}
                    groupBy={groupBy}
                    sort={sort}
                    onSort={() => setSort((cur) => nextSort(cur, c.key))}
                    onClearSort={() => setSort(null)}
                    activeValue={facetValue(c.key)}
                    /* The two-arg labeller straight through — wrapping it in a
                     * one-arg arrow made every client read "Unknown client". */
                    valueLabel={labelForValue}
                    onFacet={onFacet}
                    onGroupBy={onGroupBy}
                  />
                </th>
              ))}
              <th><span className="adm-db-sr">Open</span></th>
            </tr>
          </thead>

          {groups.map((g) => {
            /* Namespaced by grouping mode: "No client" and "Unassigned" both used
             * the key __none, so collapsing one collapsed the other. */
            const gkey = `${groupBy}:${g.key}`;
            const shut = collapsed.has(gkey);
            const openCount = g.rows.filter((r) => r.status !== "done").length;
            return (
              <tbody key={g.key}>
                <tr className="adm-db-group">
                  <td colSpan={span}>
                    <button
                      type="button" className="adm-db-arrow" onClick={() => toggle(gkey)}
                      aria-expanded={!shut} aria-label={`${shut ? "Show" : "Hide"} ${g.label}`}
                    >
                      {shut ? "▸" : "▾"}
                    </button>
                    <Chip label={g.label} color={g.color} />
                    <span className="adm-db-count">{g.rows.length}</span>
                    {openCount ? <span className="adm-db-sub">{openCount} still open</span> : <span className="adm-db-sub done">all done</span>}
                    {onFacet && groupBy !== "none" && groupBy !== "due" ? (
                      /* The label has to follow the state. When the filter is
                       * already on this value the click REMOVES it, and a button
                       * still reading "Only this" was telling the opposite of
                       * what it did. */
                      <button
                        type="button" className="adm-db-link"
                        onClick={() => onFacet(groupBy, g.key)}
                        title={String(facetValue(groupBy)) === String(g.key)
                          ? "Stop filtering to this" : `Show only ${g.label}`}
                      >{String(facetValue(groupBy)) === String(g.key) ? "✓ Only this" : "Only this"}</button>
                    ) : null}
                    {groupBy === "client" && clientName(g.key) && onOpenClient ? (
                      <button type="button" className="adm-db-link" onClick={() => onOpenClient(g.key)}>Open client ↗</button>
                    ) : null}
                  </td>
                </tr>

                {!shut && sortRowsBy(g.rows, sort, { clientName, memberName, phases: TASK_PHASES }).map((t) => (
                  <tr key={t.id} className={t.status === "done" ? "adm-db-row is-done" : "adm-db-row"}>
                    {visible.map((c) => <td key={c.key} className="adm-db-cell">{cell(t, c.key)}</td>)}
                    <td className="adm-db-cell">
                      <button type="button" className="adm-db-open" title="Open the task" onClick={() => onOpen(t)}>⤢</button>
                    </td>
                  </tr>
                ))}

                {!shut && (draftGroup === gkey ? (
                  <DraftRow
                    span={span}
                    onCancel={() => setDraftGroup(null)}
                    onSubmit={(name) => onCreate({ ...g.preset, ...(lockedClientId ? { client_id: lockedClientId } : {}), name })}
                  />
                ) : (
                  <tr className="adm-db-newrow">
                    <td colSpan={span}>
                      <button type="button" className="adm-db-new" onClick={() => setDraftGroup(gkey)}>+ New task</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** A column header you can click.
 *
 * Ryder, Aug 23 2026: *"i want the title at the top of the row to be clickable
 * to filter it."* So the header is the control: one click gives you "group the
 * table by this" and every value this column holds across ALL tasks — commonest
 * first, "none" last — each with how many tasks have it. Clicking a value
 * filters to it; clicking the one already on clears it.
 *
 * The list comes from every task, not from the rows currently on screen. Built
 * from the visible rows, one filter shrank every other column's menu to the
 * values that survived it, and a value outside the current filter could not be
 * reached from the header at all.
 *
 * Every title sorts, including Task, Latest report and Description. Only the
 * ▾ menu is limited: the text columns have no list of values worth offering, so
 * they get a title that sorts and no caret.
 */
const FILTERABLE = new Set(["status", "client", "assignee", "priority", "category", "phase"]);
const GROUPABLE = new Set(["status", "client", "assignee", "priority", "category", "phase", "due"]);

function ColumnHead({ col, tasks, groupBy, sort, onSort, onClearSort, activeValue, valueLabel, onFacet, onGroupBy }) {
  const [anchor, setAnchor] = useState(null);
  const canFilter = Boolean(onFacet) && FILTERABLE.has(col.key);
  const canGroup = Boolean(onGroupBy) && GROUPABLE.has(col.key);
  const sorted = sort && sort.key === col.key ? sort.dir : null;

  const field = col.key === "client" ? "client_id" : col.key === "assignee" ? "assigned_to" : col.key;

  /* Counted from every task, not from the rows on screen: built from the visible
   * rows, one filter shrank every other column's menu to the values that
   * survived it, and a value outside the current filter could not be reached
   * from a header at all. */
  const values = useMemo(() => {
    if (!canFilter) return [];
    const counts = new Map();
    for (const t of tasks) {
      const v = String(t[field] || "__none");
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => {
      if ((a[0] === "__none") !== (b[0] === "__none")) return a[0] === "__none" ? 1 : -1;
      return b[1] - a[1];
    });
  }, [tasks, canFilter, field]);

  /* THE TITLE SORTS. The caret beside it opens filter-and-group. Two separate
   * buttons on purpose: one click on the word has to do one predictable thing,
   * and Ryder asked for that thing to be the sort. */
  return (
    <span className="adm-db-thwrap">
      <button
        type="button"
        className={`adm-db-th${sorted ? " sorted" : ""}${activeValue !== undefined ? " on" : ""}`}
        onClick={onSort}
        title={sorted === "asc" ? `Sorted by ${col.label} — click for the other way`
          : sorted === "desc" ? `Sorted by ${col.label}, reversed — click to stop sorting`
            : `Sort by ${col.label}`}
      >
        {col.label}
        {activeValue !== undefined ? <span className="adm-db-th-dot" aria-hidden="true">●</span> : null}
        <span className="adm-db-th-arrow" aria-hidden="true">
          {sorted === "asc" ? "↑" : sorted === "desc" ? "↓" : ""}
        </span>
      </button>
      {(canFilter || canGroup) && (
        <button
          type="button"
          className={`adm-db-thmenu${groupBy === col.key || activeValue !== undefined ? " on" : ""}`}
          aria-haspopup="menu"
          aria-label={`${col.label}: filter or group`}
          title={`${col.label} — filter or group`}
          onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        >▾</button>
      )}
      {anchor && (
        <Popover anchor={anchor} width={252} onClose={() => setAnchor(null)}>
          <div className="adm-db-pop-filter">
            {canGroup ? (
              <button
                type="button"
                className={`adm-db-pop-item plain${groupBy === col.key ? " on" : ""}`}
                onClick={() => { setAnchor(null); onGroupBy(col.key); }}
              >
                {groupBy === col.key ? `✓ Grouped by ${col.label}` : `Group the table by ${col.label}`}
              </button>
            ) : null}
            {activeValue !== undefined ? (
              <button
                type="button" className="adm-db-pop-item plain"
                onClick={() => { setAnchor(null); onFacet(col.key, activeValue); }}
              >Clear this filter</button>
            ) : null}
            {sorted ? (
              <button
                type="button" className="adm-db-pop-item plain"
                /* setSort(null), not two toggles. Two blind toggles cannot
                 * drive a three-state cycle: from the reversed state they
                 * landed back on the first one, so the button that says "stop"
                 * re-sorted the table instead. */
                onClick={() => { setAnchor(null); onClearSort(); }}
              >Stop sorting by {col.label}</button>
            ) : null}
          </div>
          {canFilter && (
            <div className="adm-db-pop-list" role="menu">
              {values.length === 0 ? (
                <div className="adm-db-pop-none">No rows to filter.</div>
              ) : values.map(([v, n]) => (
                <button
                  key={v} type="button" role="menuitem"
                  className={`adm-db-pop-item${String(activeValue) === v ? " on" : ""}`}
                  onClick={() => { setAnchor(null); onFacet(col.key, v); }}
                >
                  <span>{valueLabel(col.key, v === "__none" ? "__none" : v)}</span>
                  <span className="adm-db-count">{n}</span>
                </button>
              ))}
            </div>
          )}
        </Popover>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */

/** Type a name, press Enter, the task exists. Stays open for the next one. */
function DraftRow({ span, onSubmit, onCancel }) {
  const [text, setText] = useState("");
  const send = () => {
    const v = text.trim();
    if (!v) { onCancel(); return; }
    onSubmit(v);
    setText("");
  };
  return (
    <tr className="adm-db-newrow">
      <td colSpan={span}>
        <input
          className="adm-db-edit draft" autoFocus value={text} placeholder="Task name, then Enter (Escape to stop)"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => { if (text.trim()) send(); else onCancel(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); send(); }
            else if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
          }}
        />
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */

/** Board view: a column per status, drag a card to move it. */
export function TaskBoard({ tasks, clients, team, onPatch, onOpen }) {
  const [over, setOver] = useState(null);
  const clientName = (id) => clients.find((c) => c.id === id)?.name || null;
  const memberName = (id) => {
    const m = team.find((x) => x.user_id === id);
    return m ? personLabel(m, team) : null;
  };

  const drop = (status) => (e) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData("text/plain");
    const t = tasks.find((x) => x.id === id);
    if (t && t.status !== status) onPatch(t, { status });
  };

  return (
    <div className="adm-board">
      {STATUS_ORDER.map((status) => {
        const rows = sortRows(tasks.filter((t) => t.status === status));
        return (
          <div
            key={status}
            className={`adm-board-col${over === status ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(status); }}
            onDragLeave={() => setOver((cur) => (cur === status ? null : cur))}
            onDrop={drop(status)}
          >
            <div className="adm-board-head">
              <Chip label={TASK_STATUS_LABELS[status]} color={STATUS_COLOR[status]} />
              <span className="adm-db-count">{rows.length}</span>
            </div>
            {rows.map((t) => {
              const cn = clientName(t.client_id);
              const mn = memberName(t.assigned_to);
              return (
                <div
                  key={t.id} className="adm-board-card" draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)}
                  onClick={() => onOpen(t)}
                  role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") onOpen(t); }}
                >
                  <div className="adm-board-title">{t.name}</div>
                  <div className="adm-board-meta">
                    {cn ? <Chip label={cn} color={clientColor(cn)} /> : null}
                    <Chip label={`${PRIORITY_ICON[t.priority] || ""} ${TASK_PRIORITY_LABELS[t.priority] || ""}`.trim()} color={PRIORITY_COLOR[t.priority]} />
                  </div>
                  <div className="adm-board-foot">
                    <span className={isOverdue(t) ? "adm-db-late" : "adm-db-quiet"}>
                      {t.due_date ? `${t.due_date}${isOverdue(t) ? " ⚠" : ""}` : "no date"}
                    </span>
                    {mn ? <span className="adm-db-person sm"><Avatar name={mn} size={18} />{mn.split(" ")[0]}</span> : <span className="adm-db-quiet">unassigned</span>}
                  </div>
                </div>
              );
            })}
            {rows.length === 0 ? <div className="adm-board-empty">Drop a task here</div> : null}
          </div>
        );
      })}
    </div>
  );
}
