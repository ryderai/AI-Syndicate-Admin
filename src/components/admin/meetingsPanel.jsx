import { useCallback, useEffect, useState } from "react";
import { toast } from "../../lib/toast.js";
import { listMeetings, saveMeetingBatch, updateMeeting, deleteMeeting } from "../../lib/data.js";
import {
  MEETING_KINDS, MEETING_OUTCOMES, DEFAULT_KIND, DEFAULT_OUTCOME,
  makeRow, reRow, rowProblem, kindLabel, outcomeLabel, sourceLabel,
  spellDate, isFuture, wasTimed, toInputText,
} from "../../../lib/meetings.js";

/* EVERY MEETING WITH THIS PERSON, ON THEIR CARD — 12 Sep 2026.
 *
 * Ryder: "i want on each persons card but also in sales i want a button up top
 * that says like multiple meetings".
 *
 * This is the first half. The grid (meetingsGrid.jsx) is for thirty at once;
 * this is for the one you just had, and for correcting the one you got wrong.
 *
 * WHY EDITING AND DELETING ARE HERE AND NOT BEHIND A CONFIRMATION MAZE. A
 * backfilled meeting is somebody's memory of a Tuesday in June. Memories get
 * corrected, and a record you cannot correct in two clicks is a record people
 * stop keeping. The row lock in 0034 is what keeps that safe: only the person
 * who entered it, or an admin, can change it.
 *
 * WHAT IT WILL NOT DO ON ITS OWN: move the stage. A future meeting added here
 * offers a BUTTON that says "make this the booked meeting" — which is the
 * gated path the page owns (onSetBooked), not a write from this file. Rule 1.
 */
export default function MeetingsPanel({
  leadId = null, clientId = null, member, readOnly = false,
  /* Optional. When the page hands this down, a future meeting can be promoted
   * to the lead's booked meeting THROUGH THE PAGE'S GATED PATH. Absent, the
   * button is simply not drawn — this file never writes a stage itself. */
  onSetBooked = null,
  reload = null,
}) {
  const [rows, setRows] = useState(null);   /* null = not read yet. Not []. */
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  /* `nearest`, NOT `past`, ON THIS SCREEN.
   *
   * The grid is for meetings that have already happened, so a bare "december 3"
   * there means LAST December. A person's card is different: the obvious thing
   * to type here is the meeting you have just booked. Without this the UPCOMING
   * badge and "make this the booked meeting" could not be reached by the
   * natural wording at all — the mode existed, three comments said it was in
   * use, and nothing passed it. */
  const dateMode = { prefer: "nearest" };
  const [draft, setDraft] = useState(() => makeRow({}, dateMode));
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    const res = await listMeetings({ leadId, clientId });
    if (!res.ok) { setErr(res.error); setRows([]); return; }
    setErr(null);
    setRows(res.rows);
  }, [leadId, clientId]);

  useEffect(() => { load(); }, [load]);

  async function addOne() {
    /* The draft carries the person from the panel's own context, so the grid's
     * "who did you mean" problem does not exist here — there is only one
     * possible answer and it is the card you are standing on. */
    const withPerson = { ...draft, person: { leadId, clientId, name: "" } };
    const problem = rowProblem(withPerson);
    if (problem) { toast(problem, "error"); return; }
    setBusy(true);
    const res = await saveMeetingBatch({
      rows: [withPerson], userId: member?.user_id, entry: "card", source: "typed",
    });
    setBusy(false);
    if (!res.ok) { toast(res.error || "That did not save.", "error"); return; }
    setDraft(makeRow({}, dateMode));
    setAdding(false);
    await load();
    reload?.();
    /* A SAVE CAN SUCCEED AND STILL HAVE HALF FAILED. saveMeetingBatch answers
     * ok:true with an `error` when the meeting saved but its line on the
     * timeline did not — two different facts. An earlier version read only
     * `ok`, so it toasted "Meeting recorded." in green over a meeting that was
     * going to be invisible in that person's history. */
    if (res.error) { toast(res.error, "error"); return; }
    const future = withPerson.when.ok && isFuture(withPerson.when.iso);
    toast(
      future
        ? "Saved. It is in the future — use “make this the booked meeting” if that is what it is."
        : "Meeting recorded.",
      "success"
    );
  }

  async function saveEdit() {
    if (!editing) return;
    const problem = rowProblem({ ...editing.row, person: { leadId, clientId } });
    if (problem) { toast(problem, "error"); return; }
    setBusy(true);
    const res = await updateMeeting(editing.id, {
      occurred_at: editing.row.when.iso,
      kind: editing.row.kind,
      outcome: editing.row.outcome,
      notes: String(editing.row.note || "").trim() || null,
    });
    setBusy(false);
    if (!res.ok) { toast(res.error || "That did not save.", "error"); return; }
    /* A partial success is reported as one. updateMeeting returns ok:true with
     * an `error` when the meeting saved but its line on the timeline did not —
     * two different facts, and swallowing the second leaves two answers to one
     * question on screen. */
    if (res.error) toast(res.error, "error");
    setEditing(null);
    await load();
    reload?.();
  }

  async function remove(m) {
    setBusy(true);
    const res = await deleteMeeting(m.id);
    setBusy(false);
    if (!res.ok) { toast(res.error || "That could not be removed.", "error"); return; }
    await load();
    reload?.();
    toast("Meeting removed, and the line it put on the timeline with it.", "success");
  }

  /* ---- not read yet ---- */
  if (rows === null) return <div className="adm-mtg-empty">Reading the meetings…</div>;

  return (
    <div>
      {err && (
        <div className="adm-mtg-empty" style={{ marginBottom: 8 }}>
          {/* RULE 4 of person-timeline.js: a source that was not read is NOT a
              source that was empty. They look identical on screen and mean
              opposite things, so this never prints "no meetings". */}
          The meetings could not be read, so this list is not complete: {err}
        </div>
      )}

      {rows.length === 0 && !err && (
        <div className="adm-mtg-empty">
          No meetings recorded with this person yet. That is not the same as no meetings
          having happened — it means nobody has written one down here.
        </div>
      )}

      <div className="adm-mtg-list">
        {rows.map((m) => {
          const badge = sourceLabel(m.source);
          const mine = m.entered_by === member?.user_id;
          const canTouch = !readOnly && mine;
          const future = isFuture(m.occurred_at);

          if (editing?.id === m.id) {
            return (
              <div className="adm-mtg-item" key={m.id}>
                <EditFields row={editing.row} busy={busy} onPatch={(patch) => setEditing((e) => ({ ...e, row: reRow(e.row, patch, dateMode) }))} />
                <div className="adm-mtg-tools" style={{ marginTop: 8, marginBottom: 0 }}>
                  <button className="btn btn-accent" onClick={saveEdit} disabled={busy}>Save the change</button>
                  <button className="btn" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
                </div>
              </div>
            );
          }

          return (
            <div className="adm-mtg-item" key={m.id}>
              <div className="adm-mtg-item-top">
                <span className="adm-mtg-item-when">{spellDate(m.occurred_at, wasTimed(m.occurred_at))}</span>
                <span className="adm-mtg-item-what">
                  {kindLabel(m.kind)} · {outcomeLabel(m.outcome)}
                </span>
                <span className="adm-mtg-badge" title={badge.words}>{badge.badge}</span>
                {future && <span className="adm-mtg-badge" title="This date has not come round yet.">UPCOMING</span>}
                {canTouch && (
                  <span className="adm-mtg-item-acts">
                    {future && onSetBooked && (
                      <button className="adm-mtg-link" disabled={busy} onClick={() => onSetBooked(m)}>
                        make this the booked meeting
                      </button>
                    )}
                    <button
                      className="adm-mtg-link" disabled={busy}
                      onClick={() => setEditing({
                        id: m.id,
                        row: makeRow({
                          whenText: toInputText(m.occurred_at),
                          kind: m.kind, outcome: m.outcome, note: m.notes || "",
                        }, dateMode),
                      })}
                    >
                      edit
                    </button>
                    <button className="adm-mtg-link" disabled={busy} onClick={() => remove(m)}>remove</button>
                  </span>
                )}
              </div>
              {m.notes && <div className="adm-mtg-item-note">{m.notes}</div>}
              {!mine && !readOnly && (
                <div className="adm-mtg-empty" style={{ marginTop: 4 }}>
                  Somebody else recorded this one, so only they or an owner can change it.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!readOnly && (
        adding ? (
          <div className="adm-mtg-item" style={{ marginTop: 10 }}>
            <EditFields row={draft} busy={busy} onPatch={(patch) => setDraft((d) => reRow(d, patch, dateMode))} />
            <div className="adm-mtg-tools" style={{ marginTop: 8, marginBottom: 0 }}>
              <button className="btn btn-accent" onClick={addOne} disabled={busy}>Save the meeting</button>
              <button className="btn" onClick={() => { setAdding(false); setDraft(makeRow({}, dateMode)); }} disabled={busy}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="btn adm-mtg-add" onClick={() => setAdding(true)}>+ Add a meeting</button>
        )
      )}
    </div>
  );
}

/* The date and time fields, shared by adding and editing so the two cannot
 * drift apart — the whole reason lib/touch-log.js is one table and not two. */
function EditFields({ row, busy, onPatch }) {
  return (
    <>
      <div className="adm-mtg-tools" style={{ marginBottom: 6 }}>
        <div style={{ flex: "1 1 150px", minWidth: 0 }}>
          <input
            className="adm-input adm-mtg-in" value={row.whenText} disabled={busy}
            placeholder="6/3, June 3, yesterday…"
            onChange={(e) => onPatch({ whenText: e.target.value })}
          />
          {row.whenText.trim() && (
            row.when.ok
              ? <div className="adm-mtg-resolved">{row.when.label}</div>
              : <div className="adm-mtg-resolved adm-mtg-resolved-bad">{row.when.why}</div>
          )}
        </div>
        <select className="adm-input adm-mtg-in" style={{ flex: "0 1 150px" }} value={row.kind} disabled={busy}
          onChange={(e) => onPatch({ kind: e.target.value })}>
          {MEETING_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <select className="adm-input adm-mtg-in" style={{ flex: "0 1 160px" }} value={row.outcome} disabled={busy}
          onChange={(e) => onPatch({ outcome: e.target.value })}>
          {MEETING_OUTCOMES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>
      <input
        className="adm-input adm-mtg-in" value={row.note} disabled={busy}
        placeholder="What came out of it (optional)"
        onChange={(e) => onPatch({ note: e.target.value })}
      />
    </>
  );
}

/* `wasTimed` and `toInputText` LIVE IN lib/meetings.js NOW, and that move is
 * the fix for a real defect rather than tidying.
 *
 * This file used to decide "did anybody state a time" by testing the stored
 * instant against 12:00 IN THE READER'S OWN BROWSER. Meetings are filed at
 * midday in the TEAM's calendar, so for anybody outside Chicago the test was
 * asking the wrong question: a meeting nobody timed read back as 1pm in New
 * York, printed "Wed 3 June 2026, 1pm" on the card — a time no one had given —
 * and one edit wrote that invented time back as real.
 *
 * The two functions now sit next to the code that files the meeting in the
 * first place, so the reader and the writer cannot disagree about what midday
 * means. */

export { DEFAULT_KIND, DEFAULT_OUTCOME };
