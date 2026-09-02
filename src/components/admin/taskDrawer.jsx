import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  TASK_STATUS_FLOW, TASK_STATUS_LABELS, TASK_CATEGORIES, TASK_PHASES,
  TASK_PRIORITIES, TASK_PRIORITY_LABELS,
} from "../../lib/data.js";
import { deliveryPeopleOptions, personLabel } from "../../lib/people.js";
import { assigneesOf } from "../../../lib/task-assignees.js";
import TaskUpdates from "./taskUpdates.jsx";
import { Avatar } from "./opsCells.jsx";

/* THE TASK, OPEN — a side panel, 31 Aug 2026.
 *
 * Ryder: "when i click a row i want it to open a sidebar with the actual to do
 * item and all the info and edit the text and all that there."
 *
 * This is the Notion page for a task. Everything about the row is here and
 * everything here is editable, including the long brief that a table cell can
 * only ever show a corner of.
 *
 * THREE RULES IT KEEPS:
 *
 * 1. IT OWNS NO DATA. Every change goes out through the page's own `onPatch`,
 *    the same path the inline cells use — optimistic write, undo only the
 *    fields it touched, merge the row that comes back. A panel that kept its
 *    own copy would drift from the table behind it within one edit, which is
 *    the rule §11 already sets for the cells.
 *
 * 2. TYPING IS NOT SAVING. Text fields hold their own keystrokes and commit on
 *    blur. Saving per keystroke is a write per character and a cursor that
 *    jumps when the row comes back; saving never is a panel that eats work.
 *    The draft is dropped whenever a different task is opened.
 *
 * 3. IT NEVER STEALS THE ROW'S CONTROLS. The chips in the table still work
 *    where they are. This is the long way in, not the only way.
 */
export default function TaskDrawer({ task, clients, team, member, onPatch, onDelete, onClose, onOpenClient, onLine }) {
  const [draft, setDraft] = useState({ name: "", latest_report: "", description: "" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const panelRef = useRef(null);

  /* Rule 2: a new task means a new draft. Keyed on the id, so re-rendering
   * because the row updated underneath does NOT wipe what is being typed. */
  /* eslint-disable react-hooks/exhaustive-deps --
   * KEYED ON THE ID ON PURPOSE. Adding name/latest_report/description to the
   * deps would re-seed the draft every time the row comes back from the
   * database — including the row returned by the save that is happening while
   * somebody is still typing in the next field. That wipes their work. The
   * draft is seeded once per task and committed on blur; rule 2 above. */
  useEffect(() => {
    setDraft({
      name: task?.name || "",
      latest_report: task?.latest_report || "",
      description: task?.description || "",
    });
    setConfirmDelete(false);
  }, [task?.id]);
  /* eslint-enable react-hooks/exhaustive-deps */

  /* Escape closes. Attached in capture so a popover inside the panel gets it
   * first and only its own layer closes — the same ordering the cell popovers
   * already rely on. */
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!task) return null;

  const client = clients.find((c) => c.id === task.client_id) || null;
  const people = deliveryPeopleOptions(team, task.assigned_to);
  const ids = assigneesOf(task);
  const labelOf = (id) => {
    const m = (team || []).find((x) => x.user_id === id);
    return m ? personLabel(m, team) : "Someone";
  };

  const commit = (field) => () => {
    const next = String(draft[field] ?? "").trim();
    const now = String(task[field] ?? "").trim();
    if (next === now) return;
    if (field === "name" && !next) { setDraft((d) => ({ ...d, name: task.name })); return; }
    onPatch(task, { [field]: next || null });
  };

  const toggle = (id) => onPatch(task, {
    assignees: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
  });

  /* RENDERED AT document.body, NOT WHERE IT IS WRITTEN — 2 Sep 2026.
   *
   * Measured, after Ryder said the top bar was covering the panel: this panel is
   * `position: fixed; inset: 0`, and it came out at top **-214px** with height
   * 1114px instead of filling the window, sitting UNDER a header whose z-index
   * is 20 while its own is 61.
   *
   * One cause for both. `.dash-content` fades the page in with
   * `animation: … both`, so the last keyframe stays applied for ever — and that
   * keyframe's `transform: translateY(0)` is still a transform. A transformed
   * ancestor becomes the containing block for `position: fixed` (so "the
   * window" became "this div") AND a stacking context (so z-index 61 could
   * never rise past a sibling at 20).
   *
   * The animation no longer leaves a transform behind, which fixes it there
   * too. This portal is the belt: an overlay that lives on `document.body`
   * cannot be trapped by anything a page does to its own wrapper, now or in six
   * months. Every future overlay should be written this way. */
  return createPortal(
    <>
      <div className="adm-drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="adm-drawer" ref={panelRef} role="dialog" aria-label={task.name || "Task"}>
        <header className="adm-drawer-head">
          <div className="adm-drawer-kicker">
            {client ? (
              <button type="button" className="adm-db-link" onClick={() => onOpenClient?.(client.id)}>
                {client.name} ↗
              </button>
            ) : <span className="adm-db-empty">No client</span>}
          </div>
          <button type="button" className="adm-drawer-x" onClick={onClose} aria-label="Close">×</button>
        </header>

        <textarea
          className="adm-drawer-title"
          value={draft.name}
          rows={Math.min(4, Math.max(1, Math.ceil((draft.name || "").length / 38)))}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          onBlur={commit("name")}
          placeholder="Untitled task"
          aria-label="Task name"
        />

        <div className="adm-drawer-grid">
          {/* STATUS IS FOUR BUTTONS, NOT A DROPDOWN. Ryder, 2 Sep 2026:
              "allows easy editing of it and tagging it as to do, in progress,
              blocked, or done." A select hides three of the four answers behind
              a click and gives no sense of where the work stands; every state
              is on screen here and the one it is in is filled in. Same four
              values as the database check constraint in 0001, read from
              TASK_STATUSES so a fifth state can never appear in one place and
              not the other. */}
          <div className="adm-drawer-f adm-drawer-f-wide">
            <span>Status</span>
            <div className="adm-status-chips" role="group" aria-label="Status">
              {TASK_STATUS_FLOW.map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`adm-status-chip s-${v}${task.status === v ? " on" : ""}`}
                  aria-pressed={task.status === v}
                  onClick={() => { if (task.status !== v) onPatch(task, { status: v }); }}
                >{TASK_STATUS_LABELS[v] || v}</button>
              ))}
            </div>
          </div>
          <label className="adm-drawer-f">
            <span>Priority</span>
            <select className="adm-input" value={task.priority} onChange={(e) => onPatch(task, { priority: e.target.value })}>
              {TASK_PRIORITIES.map((v) => <option key={v} value={v}>{TASK_PRIORITY_LABELS[v] || v}</option>)}
            </select>
          </label>
          <label className="adm-drawer-f">
            <span>Due date</span>
            {/* Uncontrolled and committed whole. A `type="date"` input reports ""
                on every keystroke until the date is complete, and saving that
                empties the field somebody is typing into. Same rule as §11.5. */}
            <input
              type="date" className="adm-input" defaultValue={task.due_date || ""} key={`due-${task.id}-${task.due_date || ""}`}
              onChange={(e) => { if (!e.target.value || e.target.value.length === 10) onPatch(task, { due_date: e.target.value || null }); }}
            />
          </label>
          <label className="adm-drawer-f">
            <span>Client</span>
            <select className="adm-input" value={task.client_id || ""} onChange={(e) => onPatch(task, { client_id: e.target.value || null })}>
              <option value="">No client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="adm-drawer-f">
            <span>Category</span>
            <select className="adm-input" value={task.category || ""} onChange={(e) => onPatch(task, { category: e.target.value || null })}>
              <option value="">Empty</option>
              {TASK_CATEGORIES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="adm-drawer-f">
            <span>Phase</span>
            <select className="adm-input" value={task.phase || ""} onChange={(e) => onPatch(task, { phase: e.target.value || null })}>
              <option value="">Empty</option>
              {TASK_PHASES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
        </div>

        <div className="adm-drawer-sec">
          <div className="adm-drawer-lab">
            Who is on it
            {ids.length > 1 ? <span className="adm-drawer-hint"> · {labelOf(ids[0])} is the primary</span> : null}
          </div>
          <div className="adm-drawer-people">
            {people.length ? people.map((o) => {
              const on = ids.includes(o.value);
              const isPrimary = on && ids[0] === o.value;
              return (
                <span key={o.value} className={`adm-drawer-person${on ? " on" : ""}`}>
                  <button type="button" onClick={() => toggle(o.value)} title={on ? "Take them off" : "Put them on"}>
                    <Avatar name={o.label} />{o.label}{isPrimary && ids.length > 1 ? " · primary" : ""}
                  </button>
                  {on && !isPrimary ? (
                    <button type="button" className="adm-drawer-primary" title="Make primary"
                      onClick={() => onPatch(task, { assignees: [o.value, ...ids.filter((x) => x !== o.value)] })}>
                      make primary
                    </button>
                  ) : null}
                </span>
              );
            }) : <span className="adm-db-empty">Nobody here can be given delivery work.</span>}
          </div>
          {!ids.length ? <div className="adm-drawer-hint">Nobody is on this task.</div> : null}
        </div>

        <TaskUpdates
          task={task} team={team} member={member}
          onPatch={onPatch} onLine={onLine}
          fallbackDraft={draft.latest_report}
          onFallbackChange={(v) => setDraft((d) => ({ ...d, latest_report: v }))}
          onFallbackCommit={commit("latest_report")}
        />

        <div className="adm-drawer-sec">
          <div className="adm-drawer-lab">The brief <span className="adm-drawer-hint">· what the work is, and what done means</span></div>
          <textarea
            className="adm-input adm-drawer-ta adm-drawer-brief" rows={14} placeholder="Add the brief…"
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            onBlur={commit("description")}
          />
        </div>

        <footer className="adm-drawer-foot">
          {!confirmDelete ? (
            <button type="button" className="btn btn-sm" onClick={() => setConfirmDelete(true)}>Delete this task</button>
          ) : (
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12 }}>Delete it for good?</span>
              <button type="button" className="btn btn-sm" onClick={() => setConfirmDelete(false)}>Keep it</button>
              <button type="button" className="btn btn-sm adm-drawer-danger" onClick={() => onDelete(task)}>Delete</button>
            </span>
          )}
          <span className="adm-drawer-hint">Everything here saves as you go.</span>
        </footer>
      </aside>
    </>,
    document.body,
  );
}
