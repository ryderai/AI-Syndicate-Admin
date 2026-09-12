import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./shared.jsx";
import { toast } from "../../lib/toast.js";
import { saveMeetingBatch, undoMeetingBatch, listClients } from "../../lib/data.js";
import {
  MEETING_KINDS, MEETING_OUTCOMES, DEFAULT_KIND, DEFAULT_OUTCOME,
  makeRow, reRow, rowIsBlank, rowProblem, batchSummary, parsePaste,
  searchablePeople, matchPerson, isFuture, sourceLabel,
} from "../../../lib/meetings.js";

/* ADDING A MONTH OF MEETINGS IN NINETY SECONDS — 12 Sep 2026.
 *
 * Julia Craig, VP of Sales, in the group DM: "how do i add in the meetings ive
 * already had without having to manually add each one lol".
 *
 * THE SHAPE OF THE ANSWER. A grid, not a form. A form asks one question at a
 * time and makes you close it and open it again for the next meeting; that is
 * the thing she is complaining about. A grid puts thirty of them on one screen
 * with one Save at the bottom.
 *
 * THE FOUR THINGS THIS SCREEN REFUSES TO DO, each of which it would be easy to
 * do and each of which would cost more than it saved:
 *
 * 1. IT NEVER SAVES PART OF A BATCH. Rule 4 in lib/meetings.js. Half a backlog
 *    with no way to tell which half is worse than an afternoon of typing,
 *    because the half that failed is the half that was hardest to remember.
 *
 * 2. IT NEVER GUESSES WHICH PERSON YOU MEANT. One exact match on a full name or
 *    an email picks itself; anything else is a list you choose from. This
 *    project already learned that on matchOwner (31 Aug): a shared first name is
 *    not enough to hand somebody a pipeline. A meeting filed against the wrong
 *    Dave looks completely normal for ever.
 *
 * 3. IT NEVER RESOLVES A DATE SILENTLY. Whatever the parser decides is printed
 *    back underneath the cell, in full, with the year, before anything is saved.
 *    A parser that guesses quietly is a trap; one that guesses out loud is a
 *    convenience.
 *
 * 4. IT NEVER MOVES THE PIPELINE. No stage, no meeting_at, no
 *    next_follow_up_at. See the long note at the top of migration 0034.
 */

const BLANK_ROWS = 5;

export default function MeetingsGridModal({ member, leads = [], clients = null, onClose, reload }) {
  const today = useMemo(() => new Date(), []);

  /* CLIENTS ARE FETCHED HERE RATHER THAN PASSED IN, unless the caller already
   * has them. The Sales page does not load clients — it has never needed them —
   * and a meeting with somebody who signed three months ago is exactly the kind
   * of thing waiting in a backlog. Making the Sales page load its whole client
   * list for a button most people press once would be the wrong trade; loading
   * it when the panel opens costs nothing anybody notices. */
  const [fetchedClients, setFetchedClients] = useState([]);
  useEffect(() => {
    if (clients) return undefined;
    let alive = true;
    listClients().then((res) => {
      /* An empty list is not the same as a failed fetch, and neither one is
       * worth stopping the person for: leads alone still make the grid work.
       * Rule 4 of person-timeline.js in a smaller place — a source that was not
       * fetched is not a source that was empty, so nothing here counts clients. */
      /* CHECKED ON `rows`, NOT ON `ok`. listClients() does not return an `ok`
       * flag in preview mode — it answers { rows, sample } — so testing `ok`
       * here would silently load no clients every time somebody clicks through
       * the console without a database, which is precisely when a missing list
       * is hardest to notice. */
      if (alive && Array.isArray(res?.rows)) setFetchedClients(res.rows);
    });
    return () => { alive = false; };
  }, [clients]);

  const people = useMemo(
    () => searchablePeople(leads, clients || fetchedClients),
    [leads, clients, fetchedClients]
  );

  const [rows, setRows] = useState(() => Array.from({ length: BLANK_ROWS }, () => makeRow({}, { today })));
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const summary = useMemo(() => batchSummary(rows, { today }), [rows, today]);

  function patchRow(rowId, patch) {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? reRow(r, patch, { today }) : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, makeRow({}, { today })]);
  }

  function dropRow(rowId) {
    setRows((prev) => {
      const next = prev.filter((r) => r.rowId !== rowId);
      return next.length ? next : [makeRow({}, { today })];
    });
  }

  /* PASTED ROWS ARE ADDED, NOT SUBSTITUTED. Somebody who has typed four rows by
   * hand and then pastes twenty more should end up with twenty-four. Replacing
   * would silently bin the four, and the four were the slow ones. */
  function readPaste() {
    const parsed = parsePaste(pasteText, { today });
    if (!parsed.length) { toast("Nothing in that paste could be read as a row.", "error"); return; }
    setRows((prev) => {
      const kept = prev.filter((r) => !rowIsBlank(r));
      /* Match each pasted row against the people we know, the moment it lands,
       * so the only rows left needing attention are the genuinely ambiguous
       * ones. Only an exact, single match auto-fills — rule 2 above. */
      const filled = parsed.map((r) => {
        const m = matchPerson(r.who, people);
        return m.confident ? { ...r, person: m.candidates[0] } : r;
      });
      return [...kept, ...filled, makeRow({}, { today })];
    });
    setPasteText("");
    setPasteOpen(false);
    const auto = parsed.length;
    toast(`${auto} ${auto === 1 ? "row" : "rows"} read in. Check the highlighted ones.`, "success");
  }

  async function save() {
    if (!summary.canSave) return;
    setBusy(true);
    const res = await saveMeetingBatch({
      rows: rows.filter((r) => !rowIsBlank(r)),
      userId: member?.user_id,
      entry: "grid",
      source: "typed",
    });
    setBusy(false);
    if (!res.ok) {
      toast(res.error || "That did not save.", "error");
      /* The batch id comes back even on a failure, so a run that died halfway
       * is still undoable rather than being left for somebody to unpick by
       * hand. Nothing is claimed as saved. */
      setResult(res.batchId ? { ...res, partial: true } : null);
      setChecking(false);
      return;
    }
    setResult(res);
    setChecking(false);
    reload?.();
  }

  async function undo() {
    if (!result?.batchId) return;
    setBusy(true);
    const res = await undoMeetingBatch(result.batchId);
    setBusy(false);
    if (!res.ok) { toast(res.error || "That could not be put back.", "error"); return; }
    /* THE NUMBER THAT CAME BACK, NEVER THE NUMBER WE EXPECTED.
     *
     * The first version short-circuited on `result.partial`, so a failed run
     * that had removed nothing announced "Put back. 0 meetings removed." in
     * green. A success message over a zero is the worst possible reading of a
     * count. And a batch that removes fewer than it wrote is a real thing —
     * somebody may have deleted one by hand first — so that case gets its own
     * sentence rather than being folded into the happy one. */
    const expected = result.partial ? null : result.written;
    toast(
      res.removed === 0
        ? "Nothing was left to remove — those meetings were already gone."
        : expected === null || res.removed === expected
          ? `Put back. ${res.removed} ${res.removed === 1 ? "meeting" : "meetings"} removed, and their lines on the timeline with them.`
          : `Put back ${res.removed} of ${expected} — the rest had already been removed.`,
      res.removed === 0 ? "info" : "success"
    );
    setResult(null);
    setRows(Array.from({ length: BLANK_ROWS }, () => makeRow({}, { today })));
    reload?.();
  }

  /* ---------------- the saved screen ---------------- */
  if (result && !result.partial) {
    return (
      <Modal
        open onClose={onClose} kicker="SALES" title="Saved" width={720}
        footer={<>
          <button className="btn" onClick={undo} disabled={busy}>Put these back</button>
          <button className="btn btn-accent" onClick={onClose} disabled={busy}>Done</button>
        </>}
      >
        <div className="adm-mtg-done">
          <div className="adm-mtg-done-n">{result.written}</div>
          <div>
            <strong>{result.written === 1 ? "meeting" : "meetings"} recorded.</strong>
            {result.createdLeads
              ? <> {result.createdLeads} new {result.createdLeads === 1 ? "person was" : "people were"} added to the pipeline at <em>New</em>, unassigned.</>
              : null}
          </div>
        </div>
        {/* THE TIMELINE SENTENCE IS CONDITIONAL, because that half can fail on
            its own. saveMeetingBatch answers ok:true with an `error` when the
            meetings saved and their lines did not; printing "and on their
            timeline, dated to the day it happened" over that is the screen
            asserting the exact thing that just went wrong. */}
        {result.error ? (
          <p className="adm-mtg-note adm-mtg-warnline">
            <strong>One thing did not work.</strong> {result.error} The meetings themselves are
            saved and are on each person&apos;s card — it is their lines in the history that are
            missing. Worth telling Andrew.
          </p>
        ) : (
          <p className="adm-mtg-note">
            Each one is on that person&apos;s card and on their timeline, dated to the day it
            happened.
          </p>
        )}
        <p className="adm-mtg-note">
          Nobody&apos;s pipeline stage moved and no follow-up dates changed — recording history
          does not move anybody along.
        </p>
        <p className="adm-mtg-note">
          These are marked <strong>CLAIMED</strong>: somebody typed them from memory. That is not
          the same as something the software measured, and the badge on each one says so.
        </p>
        <p className="adm-mtg-note adm-mtg-quiet">
          Changed your mind? <strong>Put these back</strong> removes all {result.written} in one go,
          and the timeline lines with them.
        </p>
      </Modal>
    );
  }

  /* ---------------- the check screen ---------------- */
  if (checking) {
    return (
      <Modal
        open onClose={busy ? undefined : () => setChecking(false)} kicker="SALES"
        title="Before this saves" width={720}
        footer={<>
          <button className="btn" onClick={() => setChecking(false)} disabled={busy}>Back</button>
          <button className="btn btn-accent" onClick={save} disabled={busy}>
            {busy ? "Saving…" : `Save ${summary.total} ${summary.total === 1 ? "meeting" : "meetings"}`}
          </button>
        </>}
      >
        <ul className="adm-mtg-check">
          <li><strong>{summary.total}</strong> {summary.total === 1 ? "meeting" : "meetings"} will be recorded.</li>
          <li><strong>{summary.matched}</strong> attach to somebody already in the system.</li>
          {summary.toCreate > 0 && (
            <li>
              <strong>{summary.toCreate}</strong> will also add a new person to the pipeline, at
              <em> New</em>, belonging to nobody. You can claim them afterwards.
            </li>
          )}
          {summary.untimed > 0 && (
            <li>
              <strong>{summary.untimed}</strong> had no time of day on them, so they are filed at
              midday. The date is what matters here; midday is just somewhere safe to put the clock.
            </li>
          )}
          {summary.future > 0 && (
            <li className="adm-mtg-warn">
              <strong>{summary.future}</strong> {summary.future === 1 ? "is" : "are"} in the future.
              That is allowed, but this screen is for meetings that have already happened — worth a
              look before you save.
            </li>
          )}
          <li className="adm-mtg-quiet">Nobody&apos;s stage moves. No follow-up dates change.</li>
          <li className="adm-mtg-quiet">All of it can be put back in one click straight afterwards.</li>
        </ul>
      </Modal>
    );
  }

  /* ---------------- the grid ---------------- */
  return (
    <Modal
      open onClose={busy ? undefined : onClose} kicker="SALES"
      title="Add meetings you have already had" width={1080}
      footer={<>
        <span className={`adm-mtg-headline${summary.problems.length ? " adm-mtg-headline-bad" : ""}`}>
          {summary.headline}
        </span>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          className="btn btn-accent" disabled={!summary.canSave || busy}
          onClick={() => setChecking(true)}
        >
          Save all
        </button>
      </>}
    >
      {result?.partial && (
        /* WHAT THIS SAYS IS WHAT THE SAVE ACTUALLY REPORTED.
         *
         * It used to print "Nothing was saved." over every failure. Two of the
         * three failure paths have already written something by the time they
         * fail — the new people are created before the meetings, and on some
         * paths the meetings are written before their timeline lines — so the
         * message was flatly untrue exactly when being told the truth mattered
         * most. The error sentence from the save now carries the whole story,
         * because only the save knows how far it got. */
        <div className="adm-mtg-bad">
          <strong>That did not finish.</strong> {result.error}
          {result.createdLeads > 0 && (
            <> {result.createdLeads} new {result.createdLeads === 1 ? "person is" : "people are"} now
            in the pipeline at <em>New</em>, unowned — they stay there whatever you do next.</>
          )}
          {" "}
          <button className="adm-mtg-link" onClick={undo} disabled={busy}>
            Remove whatever meetings did get written
          </button>
        </div>
      )}

      <div className="adm-mtg-lead">
        One line per meeting. Type the person&apos;s name and it finds them; type the date any way
        you like — <code>6/3</code>, <code>June 3</code>, <code>last tuesday</code> — and it shows
        you the date it worked out before anything is saved.
        <strong> Dates are read month first</strong>, so 6/3 is the 3rd of June.
      </div>

      <div className="adm-mtg-tools">
        <button className="btn" onClick={() => setPasteOpen((v) => !v)} disabled={busy}>
          {pasteOpen ? "Hide the paste box" : "Paste a list instead"}
        </button>
        <span className="adm-mtg-quiet">or just start typing below</span>
      </div>

      {pasteOpen && (
        <div className="adm-mtg-paste">
          <textarea
            className="adm-input" style={{ minHeight: 110 }}
            placeholder={"Paste from a spreadsheet, or one meeting per line:\nDave Mullen, 6/3, first meeting, went well\nSarah Lin - June 10 - follow-up\nMike Torres june 12"}
            value={pasteText} onChange={(e) => setPasteText(e.target.value)}
          />
          <div className="adm-mtg-tools">
            <button className="btn btn-accent" onClick={readPaste} disabled={!pasteText.trim()}>
              Read these rows
            </button>
            <span className="adm-mtg-quiet">
              Nothing saves from here — the rows land in the grid for you to check first.
            </span>
          </div>
        </div>
      )}

      <div className="adm-mtg-grid" role="table">
        <div className="adm-mtg-head" role="row">
          <div role="columnheader">Who was it with</div>
          <div role="columnheader">When</div>
          <div role="columnheader">What kind</div>
          <div role="columnheader">How it went</div>
          <div role="columnheader">Note</div>
          <div role="columnheader" aria-label="Remove" />
        </div>
        {rows.map((row, i) => (
          <GridRow
            key={row.rowId}
            row={row} people={people} today={today} busy={busy}
            isLast={i === rows.length - 1}
            onPatch={(patch) => patchRow(row.rowId, patch)}
            onDrop={() => dropRow(row.rowId)}
            onNeedRow={addRow}
          />
        ))}
      </div>

      <button className="btn adm-mtg-add" onClick={addRow} disabled={busy}>+ another line</button>

      {summary.problems.length > 0 && (
        <div className="adm-mtg-problems">
          <strong>{summary.headline}</strong>
          <ul>
            {summary.problems.slice(0, 6).map((p) => (
              <li key={p.rowId}>{p.who ? <em>{p.who}</em> : "A row"} — {p.problem}</li>
            ))}
            {summary.problems.length > 6 && <li className="adm-mtg-quiet">…and {summary.problems.length - 6} more.</li>}
          </ul>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* One line                                                            */
/* ------------------------------------------------------------------ */

function GridRow({ row, people, today, busy, isLast, onPatch, onDrop, onNeedRow }) {
  const problem = rowProblem(row);
  const future = row.when?.ok && isFuture(row.when.iso, today);

  return (
    <div className={`adm-mtg-row${problem ? " adm-mtg-row-bad" : ""}`} role="row">
      <WhoCell row={row} people={people} busy={busy} onPatch={onPatch} />

      <div className="adm-mtg-cell" role="cell">
        <input
          className="adm-input adm-mtg-in" value={row.whenText} disabled={busy}
          placeholder="6/3 or June 3"
          onChange={(e) => onPatch({ whenText: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter" && isLast) onNeedRow(); }}
        />
        {/* RULE 3: WHATEVER IT DECIDED, PRINTED BACK, WITH THE YEAR. The single
            most likely way this screen goes wrong is a date landing in the
            wrong year, and a label that hides the year cannot show that. */}
        {row.whenText.trim() && (
          row.when.ok
            ? <div className={`adm-mtg-resolved${future ? " adm-mtg-resolved-future" : ""}`}>
                {row.when.label}
                {row.when.swapped && <span className="adm-mtg-flag"> · read day-first</span>}
                {future && <span className="adm-mtg-flag"> · that is in the future</span>}
              </div>
            : <div className="adm-mtg-resolved adm-mtg-resolved-bad">{row.when.why}</div>
        )}
      </div>

      <div className="adm-mtg-cell" role="cell">
        <select
          className="adm-input adm-mtg-in" value={row.kind} disabled={busy}
          onChange={(e) => onPatch({ kind: e.target.value })}
        >
          {MEETING_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
      </div>

      <div className="adm-mtg-cell" role="cell">
        <select
          className="adm-input adm-mtg-in" value={row.outcome} disabled={busy}
          onChange={(e) => onPatch({ outcome: e.target.value })}
        >
          {MEETING_OUTCOMES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>

      <div className="adm-mtg-cell" role="cell">
        <input
          className="adm-input adm-mtg-in" value={row.note} disabled={busy}
          placeholder="optional"
          onChange={(e) => onPatch({ note: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter" && isLast) onNeedRow(); }}
        />
      </div>

      <div className="adm-mtg-cell" role="cell">
        <button className="adm-mtg-x" onClick={onDrop} disabled={busy} aria-label="Remove this line">×</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Who — the one cell that is allowed to be difficult                  */
/* ------------------------------------------------------------------ */

function WhoCell({ row, people, busy, onPatch }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const match = useMemo(
    () => (row.who.trim().length >= 2 ? matchPerson(row.who, people) : { candidates: [], confident: false }),
    [row.who, people]
  );

  /* Close on a click anywhere else. Registered on mousedown so it fires before
   * the click lands on whatever was pressed, which is what stops the list
   * closing and the underlying control firing in the same gesture. */
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function pick(p) {
    onPatch({ person: p, newLead: null, who: p.name });
    setOpen(false);
  }

  function addNew() {
    const typed = row.who.trim();
    /* "Dave Mullen at Crest Dental" and "Dave Mullen, Crest Dental" both split
     * into a person and a firm. Anything else becomes the name and the firm is
     * left empty, rather than us inventing one. */
    const m = typed.match(/^(.*?)\s*(?:,|\bat\b)\s*(.+)$/i);
    onPatch({
      person: null,
      newLead: { name: (m ? m[1] : typed).trim(), firm: m ? m[2].trim() : "", email: "" },
    });
    setOpen(false);
  }

  const chosen = row.person || row.newLead;

  return (
    <div className="adm-mtg-cell adm-mtg-who" role="cell" ref={boxRef}>
      <input
        className="adm-input adm-mtg-in" value={row.who} disabled={busy}
        placeholder="name or firm"
        onChange={(e) => { onPatch({ who: e.target.value }); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />

      {chosen && !open && (
        <div className={`adm-mtg-chosen${row.newLead ? " adm-mtg-chosen-new" : ""}`}>
          {row.person
            ? <>✓ {row.person.firm ? `${row.person.firm} · ` : ""}{row.person.kindOf === "client" ? "client" : "in the pipeline"}</>
            : <>+ new person{row.newLead.firm ? ` at ${row.newLead.firm}` : ""} — added when you save</>}
        </div>
      )}

      {open && row.who.trim().length >= 2 && (
        <div className="adm-mtg-menu">
          {match.candidates.map((p) => (
            <button key={p.key} className="adm-mtg-opt" onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
              <span className="adm-mtg-opt-name">{p.name}</span>
              {/* THE FIRM IS ALWAYS SHOWN, never only on a tie. Two Daves at two
                  firms is the normal case in a 3,000-lead pipeline, and a list
                  of four identical-looking names is not a choice anybody can
                  make. */}
              <span className="adm-mtg-opt-firm">
                {p.firm || "no firm on record"}
                {p.email ? ` · ${p.email}` : ""}
                {p.kindOf === "client" ? " · client" : ""}
              </span>
            </button>
          ))}
          {match.candidates.length === 0 && (
            <div className="adm-mtg-opt-none">Nobody here matches that.</div>
          )}
          <button className="adm-mtg-opt adm-mtg-opt-new" onMouseDown={(e) => { e.preventDefault(); addNew(); }}>
            <span className="adm-mtg-opt-name">+ Add “{row.who.trim()}” as a new person</span>
            <span className="adm-mtg-opt-firm">
              Goes into the pipeline at New, belonging to nobody, when you save.
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/* Re-exported so the person card can show the same badge wording without
 * reaching into lib/ twice. */
export { sourceLabel, DEFAULT_KIND, DEFAULT_OUTCOME };
