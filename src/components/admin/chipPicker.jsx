import { useEffect, useRef, useState } from "react";
import { Chip, Popover } from "./opsCells.jsx";
import { needsReason, offersNote, NOTE_MAX } from "../../../lib/stage-move.js";

/* ONE CLICK MOVES A LEAD. THE NOTE IS OPTIONAL AND COMES AFTER.
 *
 * Ryder, 30 Aug 2026: "on the tages, wgen you click it you get a set of premade
 * tags and then when you click a tag you can add a optional note. i dont want
 * to be able to add tags, i want everything simple, one click movement through
 * the pipeline … we have friggin 3000+ leads, we need to be able to do this at
 * scale."
 *
 * THE ORDER MATTERS AND IS THE WHOLE DESIGN. The move is written the instant a
 * chip is clicked — not when the note is saved, not when the panel closes. A
 * rep working three hundred rows clicks a chip and moves on; the lead is
 * already where they put it. The note box that appears afterwards is a second,
 * entirely skippable thing, and walking away from it loses nothing.
 *
 * Asking for the note FIRST would mean every move costs a click, a decision
 * about whether to type, and a second click. At three thousand leads that is
 * the difference between a tool and a chore.
 *
 * THERE IS NO "NEW TAG" BOX, on purpose. A free-text status column is what the
 * Google sheet had, and it is why nothing in it could be counted.
 *
 * WON AND LOST DO NOT COME THROUGH HERE. They open the reason box that has
 * existed since Aug 27 — that box IS the note, and asking twice for the same
 * sentence teaches people to close both.
 */
export function ChipPicker({
  value,
  options,
  current,            /* what to draw when closed: a node, or null for the chip */
  placeholder = "—",
  label = "Choose",
  disabled = false,
  disabledWhy = null,
  /* onPick(value) must return a promise that settles when the write is done.
   * Its resolved value being `false` means the write was refused, and the note
   * step is then skipped — a note about a move that did not happen is worse
   * than no note. */
  onPick,
  /* Optional. Without it the panel just closes after a pick. */
  onNote = null,
  /* Which picks get the note step. Defaults to the pipeline rule. */
  noteFor = offersNote,
  reasonFor = needsReason,
  /* Wide enough for the longest stage name and its explanation side by side. */
  width = 320,
}) {
  const [anchor, setAnchor] = useState(null);
  /* null = the list. Otherwise the value we just wrote, and the note box. */
  const [noted, setNoted] = useState(null);
  const [busy, setBusy] = useState(false);

  const open = (e) => {
    e.stopPropagation();
    if (disabled) return;
    setNoted(null);
    setAnchor(e.currentTarget.getBoundingClientRect());
  };

  const pick = async (next) => {
    if (busy || next === value) { setAnchor(null); return; }
    const wantsNote = Boolean(onNote) && noteFor(value, next);
    const wantsReason = reasonFor(value, next);
    setBusy(true);
    let ok = true;
    try { ok = (await onPick(next)) !== false; } finally { setBusy(false); }
    /* A refused write, or a pick that hands off to the reason box, closes the
     * panel. Neither one has a note to add. */
    if (!ok || wantsReason || !wantsNote) { setAnchor(null); return; }
    setNoted(next);
  };

  const opt = options.find((o) => o.value === value) || null;

  return (
    <>
      <button
        type="button"
        className={`adm-cp-btn${disabled ? " off" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={Boolean(anchor)}
        disabled={disabled}
        title={disabled
          ? (disabledWhy || "You can read this, not change it.")
          : `${label} — one click moves it. A note afterwards is optional.`}
        onClick={open}
      >
        {current !== undefined && current !== null
          ? current
          : opt
            ? <Chip label={opt.label} color={opt.color || "default"} />
            : <span className="adm-db-empty">{placeholder}</span>}
        {disabled ? null : <span className="adm-cp-caret" aria-hidden="true">▾</span>}
      </button>

      {anchor && (
        <Popover anchor={anchor} width={width} onClose={() => setAnchor(null)}>
          {/* THE PANEL STOPS ITS OWN CLICKS.
           *
           * The whole sheet row is a click target now, and a React event
           * bubbles through the REACT tree rather than the DOM one — so a click
           * on an option inside this panel arrived at the <tr> underneath it and
           * opened the client card on top of the menu. Picking a stage opened
           * the record every single time. Found by clicking it, not by a test;
           * there is now a test for it in tests/stage-move. */}
          <div onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          {noted === null ? (
            <div className="adm-cp-panel" role="listbox" aria-label={label}>
              <div className="adm-cp-head">{label}</div>
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={`adm-cp-opt${o.value === value ? " on" : ""}`}
                  disabled={busy}
                  onClick={() => pick(o.value)}
                >
                  <Chip label={o.label} color={o.color || "default"} />
                  {o.help ? <span className="adm-cp-help">{o.help}</span> : null}
                  {o.value === value ? <span className="adm-cp-tick" aria-hidden="true">✓</span> : null}
                </button>
              ))}
              {/* SAID OUT LOUD, because a menu with no "new…" in it looks broken
                  until somebody tells you it is deliberate. */}
              <div className="adm-cp-foot">
                This list is fixed. Everything the pipeline can count is already on it.
              </div>
            </div>
          ) : (
            <NoteStep
              moved={options.find((o) => o.value === noted) || null}
              busy={busy}
              onSave={async (text) => {
                setBusy(true);
                try { await onNote(noted, text); } finally { setBusy(false); }
                setAnchor(null);
              }}
              onSkip={() => setAnchor(null)}
            />
          )}
          </div>
        </Popover>
      )}
    </>
  );
}

/* The second step. It never blocks anything: the move is already saved by the
 * time this is on screen, and the panel says so in those words — otherwise a
 * rep who clicks away wonders whether they lost the move as well as the note. */
function NoteStep({ moved, busy, onSave, onSkip }) {
  const [text, setText] = useState("");
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const save = () => { if (text.trim()) onSave(text); else onSkip(); };

  return (
    <div className="adm-cp-panel">
      <div className="adm-cp-done">
        <strong>Moved to {moved?.label || "the new stage"}.</strong> That is saved.
      </div>
      <textarea
        ref={ref}
        className="adm-cp-note"
        rows={3}
        maxLength={NOTE_MAX}
        placeholder="Add a note? Optional — it goes on their timeline."
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          /* Enter saves, because this is a one-line thought typed between
             calls. Shift+Enter is the way to write two. Escape skips. */
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
          if (e.key === "Escape") { e.preventDefault(); onSkip(); }
        }}
      />
      <div className="adm-cp-actions">
        <button type="button" className="btn btn-sm" onClick={onSkip} disabled={busy}>
          No note
        </button>
        <button
          type="button" className="btn btn-sm btn-accent"
          onClick={save} disabled={busy || !text.trim()}
        >
          {busy ? "Saving…" : "Save note"}
        </button>
      </div>
    </div>
  );
}
