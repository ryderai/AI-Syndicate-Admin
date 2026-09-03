import { useCallback, useEffect, useState } from "react";
import { listTaskUpdates, addTaskUpdate, editTaskUpdate, deleteTaskUpdate } from "../../lib/data.js";
import {
  MAX_UPDATE, canPost, canEditUpdate, sortUpdates, lineAgrees,
  updateAuthorLabel, updateStamp, latestLineFrom,
} from "../../../lib/task-updates.js";
import { personLabel } from "../../lib/people.js";
import { toast } from "../../lib/toast.js";

/* THE UPDATES ON A TASK — 2 Sep 2026.
 *
 * Ryder: "adding reports and all that needs to be seamless through here so that
 * the operations and all work all fit together seamlessly. we can't have any
 * gaps or missing info."
 *
 * Before this, a task had ONE line — `latest_report` — and typing this week's
 * threw last week's away. Every weekly report and every recap to CJ was then
 * rebuilt from memory. Migration 0029 keeps every update with its date and its
 * author, and a trigger makes the task's one line the newest of them.
 *
 * FOUR RULES:
 *
 * 1. IT NEVER WRITES `latest_report` WHEN THE TABLE IS THERE. The trigger does
 *    that. Two writers is two places for the task's one line to be wrong.
 *
 * 2. NOTHING TYPED IS LOST WHEN THE MIGRATION HAS NOT BEEN RUN. The console
 *    ships ahead of its migration every time. A missing table is not an error
 *    here — the update is saved onto the task's own line instead, and the panel
 *    says which migration turns the history on.
 *
 * 3. THE ROW BEHIND THE PANEL IS TOLD. `onLine` merges the new sentence into
 *    the page's own copy of the task, with no second database write, so the
 *    Operations table and the Work page row are right the moment the panel
 *    posts — and still right if the panel is closed without a reload.
 *
 * 4. A LINE THAT WAS NEVER AN UPDATE SAYS SO. A task whose line was typed
 *    straight into the field — by the importer, the assistant, or a console
 *    older than 0029 — shows it labelled, with one button to keep it as the
 *    first update. That is the only way the history is complete rather than
 *    starting at whenever somebody first opened this panel.
 */
export default function TaskUpdates({
  task, team, member, onPatch, onLine,
  fallbackDraft, onFallbackChange, onFallbackCommit,
}) {
  const [rows, setRows] = useState(null);       // null = still reading
  const [missing, setMissing] = useState(false); // 0029 not run on this database
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);  // { id, body }
  const [confirmId, setConfirmId] = useState(null);

  const taskId = task?.id || null;
  const me = member?.user_id || null;
  const role = member?.role || null;

  const load = useCallback(async () => {
    if (!taskId) return;
    const res = await listTaskUpdates(taskId);
    setMissing(!!res.missing);
    setRows(sortUpdates(res.rows || []));
    if (res.error) toast.error("The updates didn't load", res.error);
  }, [taskId]);

  /* A different task is a different history and a different draft. Keyed on the
   * id for the same reason the panel's own draft is: a row coming back from the
   * database mid-type must not wipe what is being written. */
  useEffect(() => {
    setRows(null); setMissing(false); setDraft(""); setEditing(null); setConfirmId(null);
    load();
  }, [taskId, load]);

  const labelFor = (id) => {
    const m = (team || []).find((x) => x.user_id === id);
    return m ? personLabel(m, team) : null;
  };

  /* Rule 3. The trigger has already written the task's line in the database;
   * this only makes the page's own copy agree without asking for it again. */
  const tellTheRow = (line) => {
    if (onLine) onLine(task, line);
  };

  async function post(text) {
    const body = String(text ?? "").trim();
    if (!canPost(body) || busy) return;
    /* The database requires an update to carry the name of whoever wrote it —
     * an unsigned entry is not a record of anything. Without a member loaded
     * the insert would come back as a raw permission error, which reads like a
     * bug; say the true thing instead. */
    if (!me) {
      toast.warn("Not signed in as anybody yet",
        "An update has to carry a name. Reload the page and post it again — nothing you typed is lost.");
      return;
    }
    setBusy(true);
    const res = await addTaskUpdate({ taskId, author: me, body });
    setBusy(false);

    if (res.missing) {
      /* Rule 2. Keep the words. The person wrote a real update; losing it
       * because a migration has not been run would be the console's fault and
       * their loss.
       *
       * The fallback box below is seeded with what they just typed BEFORE the
       * switch, or it would open showing the task's previous line and blur
       * would write that back over the new one. */
      setMissing(true);
      onFallbackChange(body);
      const saved = await onPatch(task, { latest_report: body });
      if (saved && saved.ok === false) {
        /* onPatch has already said what went wrong. Do not follow a red toast
           with an amber one claiming it was saved. */
        return;
      }
      setDraft("");
      toast.warn("Saved as the task's one line — not as history",
        "This database has no updates table yet. Run supabase/migrations/0029_task_updates.sql and the dated history starts working.");
      return;
    }
    if (!res.ok) { toast.error("The update didn't save", res.error); return; }

    const row = res.row || { id: `local-${Date.now()}`, task_id: taskId, author: me, body, carried_over: false, created_at: new Date().toISOString() };
    const next = sortUpdates([row, ...(rows || [])]);
    setRows(next);
    setDraft("");
    tellTheRow(latestLineFrom(next));
    toast.success("Update posted", "It is now the line every screen shows.");
  }

  async function saveEdit() {
    const body = String(editing?.body ?? "").trim();
    if (!canPost(body) || busy) return;
    setBusy(true);
    const res = await editTaskUpdate(editing.id, body);
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't change that", res.error); return; }
    /* Merge the row the database handed back, so the "edited" mark comes from
     * the write itself rather than from this side assuming it happened. */
    const next = sortUpdates((rows || []).map((r) => (r.id === editing.id ? { ...r, ...(res.row || {}), body } : r)));
    setRows(next);
    setEditing(null);
    tellTheRow(latestLineFrom(next));
  }

  async function remove(row) {
    setBusy(true);
    const res = await deleteTaskUpdate(row.id);
    setBusy(false);
    setConfirmId(null);
    if (!res.ok) { toast.error("Couldn't remove that", res.error); return; }
    const next = (rows || []).filter((r) => r.id !== row.id);
    setRows(next);
    /* Removing the newest one puts the one BEFORE it back on the task — that is
     * what the trigger does, so it is what the screen must show. */
    tellTheRow(latestLineFrom(next));
    toast.info("Update removed", "The task's line is now the one before it.");
  }

  /* ---------------- the migration is not run yet ---------------- */
  if (missing) {
    return (
      <div className="adm-tp-sec">
        <div className="adm-tp-lab">
          Where it stands <span className="adm-tp-hint">· the one line every screen shows</span>
        </div>
        <textarea
          className="adm-input adm-tp-ta" rows={3} placeholder="12 of 26 pages done."
          value={fallbackDraft}
          onChange={(e) => onFallbackChange(e.target.value)}
          onBlur={onFallbackCommit}
          maxLength={MAX_UPDATE}
        />
        <div className="adm-tp-note">
          <strong>The dated history is off on this database.</strong> Run
          {" "}<code>supabase/migrations/0029_task_updates.sql</code> in Supabase and every update
          keeps its date and its author from then on. Until then this one line is all a task can
          hold, and typing a new one replaces the old one.
        </div>
      </div>
    );
  }

  /* ---------------- normal ---------------- */
  const list = rows || [];
  const newestId = list.length ? list[0].id : null;

  /* Rule 4, both halves.
   *
   * The task's one line can come from somewhere that is not an update, and
   * still does: the Operations table's own report cell, the task edit modal,
   * the Notion importer, a note turned into a task line, the assistant. Those
   * writers are not going away, so this panel must be able to say "the line on
   * the row is not one of these" rather than quietly claiming the newest update
   * is what everybody else is reading. A screen that asserts something it has
   * not checked is the defect; the check is `lineAgrees`.
   *
   * Either way the fix is the same one button: keep that line as an update, and
   * the history is whole again. */
  const line = String(task.latest_report || "").trim();
  const agrees = lineAgrees(task, list);
  const strayLine = !agrees && line ? line : null;
  const orphanLine = !list.length && line ? line : null;

  return (
    <div className="adm-tp-sec">
      <div className="adm-tp-lab">
        Updates
        <span className="adm-tp-hint">
          {agrees
            ? " · what has been reported on this, newest first. The top one is the line the Operations table and the Work page show."
            : " · what has been reported on this, newest first. The line on the row was set somewhere else — it is shown below."}
        </span>
      </div>

      <div className="adm-upd-new">
        <textarea
          className="adm-input adm-tp-ta" rows={3}
          placeholder="What moved? e.g. 12 of 26 listing pages have schema now, the rest go up Thursday."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") post(draft); }}
          maxLength={MAX_UPDATE}
          aria-label="Write an update"
        />
        <div className="adm-upd-newfoot">
          <span className="adm-tp-hint">
            {draft.length > MAX_UPDATE - 200 ? `${MAX_UPDATE - draft.length} characters left` : "⌘/Ctrl + Enter posts it"}
          </span>
          <button
            type="button" className="btn btn-sm btn-primary"
            disabled={!canPost(draft) || busy}
            onClick={() => post(draft)}
          >Post update</button>
        </div>
      </div>

      {strayLine && !orphanLine && (
        <div className="adm-upd-orphan">
          <div className="adm-upd-orphan-lab">
            The line on the row is not one of these updates
          </div>
          <div className="adm-upd-body">{strayLine}</div>
          <div className="adm-upd-foot">
            <span className="adm-tp-hint">
              Somewhere other than this panel set it — the report cell in the Operations table,
              the task edit box, the Notion import, or the assistant. Until it is kept below, the
              history and the row are telling two different stories.
            </span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => post(strayLine)}>
              Keep it as an update
            </button>
          </div>
        </div>
      )}

      {orphanLine && (
        <div className="adm-upd-orphan">
          <div className="adm-upd-orphan-lab">
            This task already has a line, and nobody posted it as an update
          </div>
          <div className="adm-upd-body">{orphanLine}</div>
          <div className="adm-upd-foot">
            <span className="adm-tp-hint">
              It was typed straight onto the task — by the importer, the assistant, or a console
              older than this panel — so there is no date or author for it.
            </span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => post(orphanLine)}>
              Keep it as the first update
            </button>
          </div>
        </div>
      )}

      {rows === null ? (
        <div className="adm-tp-hint">Reading the updates…</div>
      ) : !list.length && !orphanLine ? (
        <div className="adm-tp-hint">Nothing reported yet. The first update you post becomes the line on the row.</div>
      ) : (
        <ol className="adm-upd-list">
          {list.map((r) => {
            const mine = canEditUpdate(r, me, role);
            const isEditing = editing?.id === r.id;
            return (
              <li key={r.id} className={`adm-upd${r.id === newestId ? " newest" : ""}`}>
                <div className="adm-upd-head">
                  <span className="adm-upd-who">{updateAuthorLabel(r, labelFor)}</span>
                  <span className="adm-upd-when">{updateStamp(r)}</span>
                  {r.id === newestId && agrees && <span className="adm-upd-tag">on the row</span>}
                  {r.carried_over && <span className="adm-upd-tag carried">carried over</span>}
                  {r.edited_at && <span className="adm-upd-tag carried" title={`Changed ${updateStamp({ created_at: r.edited_at })}`}>edited</span>}
                </div>

                {isEditing ? (
                  <>
                    <textarea
                      className="adm-input adm-tp-ta" rows={3} value={editing.body}
                      onChange={(e) => setEditing((x) => ({ ...x, body: e.target.value }))}
                      maxLength={MAX_UPDATE} aria-label="Edit this update"
                    />
                    <div className="adm-upd-foot">
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                      <button type="button" className="btn btn-sm btn-primary" disabled={!canPost(editing.body) || busy} onClick={saveEdit}>Save</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="adm-upd-body">{r.body}</div>
                    {mine && (
                      <div className="adm-upd-foot">
                        {confirmId === r.id ? (
                          <>
                            <span className="adm-tp-hint">Remove this update?</span>
                            <button type="button" className="btn btn-sm" onClick={() => setConfirmId(null)}>Keep it</button>
                            <button type="button" className="btn btn-sm adm-tp-danger" disabled={busy} onClick={() => remove(r)}>Remove</button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="adm-upd-act" onClick={() => setEditing({ id: r.id, body: r.body })}>Edit</button>
                            <button type="button" className="adm-upd-act" onClick={() => setConfirmId(r.id)}>Remove</button>
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
