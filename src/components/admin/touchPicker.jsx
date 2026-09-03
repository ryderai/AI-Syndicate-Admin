import { useEffect, useRef, useState } from "react";
import { Chip, Popover } from "./opsCells.jsx";
import { NOTE_MAX } from "../../../lib/stage-move.js";
/* THE TEAM'S CALENDAR, not the browser's. Every day-counting rule in
 * lib/sales-rules.js runs in America/Chicago and has a long note about why. A
 * rep on a laptop set to UTC picking "Tomorrow" at 8pm Central was booking two
 * days out, and the follow-up lists count in Chicago — so the date they picked
 * and the date the list checked were different days. Found by a checker. */
import { teamDatePlus } from "../../lib/teamDay.js";
import { TOUCH_CHANNELS, outcomesFor } from "../../../lib/touch-log.js";

/* TWO CLICKS ON THE CONTACTED? CELL, AND THE TOUCH IS LOGGED.
 *
 * Ryder, 30 Aug 2026: "when you click contacted i want a popup with the
 * available options that you went through and the questions required very
 * simply so its a couple clicks and all the data is there. similar to sales
 * cycle status."
 *
 * The sibling of ChipPicker, and deliberately not a merge with it. ChipPicker
 * moves a lead between stages: ONE list, and the value it shows is the value it
 * sets. This does neither. The cell it hangs off is DERIVED — contactedState in
 * src/lib/salesSheet.js counts touches — so there is nothing to "set", and the
 * question needs two levels because a call can go six ways and an email cannot
 * go any of them. Forcing one component to do both would put a `mode` flag
 * through every branch of it; the shared half is the panel CSS, which both use.
 *
 * THE SHAPE, and each step earns its place:
 *
 *   step 1  what you did      Called · Emailed · LinkedIn · Texted
 *   step 2  how it went       the list for THAT channel, and it writes on click
 *   step 3  an optional note  the write is already done; this is skippable
 *
 * THE WRITE HAPPENS ON THE SECOND CLICK, not when the note is saved and not
 * when the panel closes. Same rule as the stage chip, for the same reason: a rep
 * working three hundred rows clicks twice and moves on. Asking for the note
 * first would put a decision between them and the next row.
 *
 * There is no free-text channel and no free-text outcome. A column anything can
 * be typed into is a column nothing can count — the outreach sheet all over
 * again.
 */
export function TouchPicker({
  current,                 /* what the closed cell draws — the Contacted? chip */
  disabled = false,
  disabledWhy = null,
  /* Which channels cannot be used right now, as { [channelId]: "why" }. The one
   * that matters is `text`: the one-text gate (textGate in lib/sales-rules.js)
   * refuses it until they have replied, and refuses it for good afterwards. A
   * disabled row with its reason on it is honest; hiding the row makes a rule
   * nobody can see, and then nobody learns it. */
  blocked = {},
  /* onPick(channelId, outcomeId) must resolve when the write is done. Resolving
   * `false` means it was refused, and the note step is skipped — a note about a
   * touch that did not happen is worse than no note. */
  onPick,
  /* onDone({ next, note }) — the THIRD step, on a touch that is already
   * written. `next` is a YYYY-MM-DD string or null; `note` is text or null.
   *
   * It is deliberately NOT handed the channel and outcome. ChipPicker's note
   * step re-calls its own onPick with the same stage, which is harmless because
   * setting a stage twice is setting it once. Logging a touch twice is TWO
   * TOUCHES — two timeline rows, two entries in the rep's count, and a cadence
   * advanced twice. A callback that cannot re-log is the only shape that makes
   * that mistake impossible rather than merely unlikely.
   *
   * Optional; without it the panel closes after the pick. */
  onDone = null,
  width = 300,
}) {
  const [anchor, setAnchor] = useState(null);
  /* null = choose a channel · a channel id = choose an outcome ·
   * { channel, outcome } = the note step. Three states in one variable, because
   * two booleans would allow a fourth that means nothing. */
  const [step, setStep] = useState(null);
  const [busy, setBusy] = useState(false);
  /* Same protection the stage chip's note box got on 2 Sep 2026: while there
   * are unsaved words in the "and next?" box, a scroll, a resize or a click
   * elsewhere does not throw them away. See Popover in opsCells.jsx. */
  const hold = useRef(false);

  const open = (e) => {
    e.stopPropagation();
    if (disabled) return;
    setStep(null);
    setAnchor(e.currentTarget.getBoundingClientRect());
  };

  const close = () => { setAnchor(null); setStep(null); };

  const pickOutcome = async (channel, outcome) => {
    if (busy) return;
    setBusy(true);
    let ok = true;
    try { ok = (await onPick(channel, outcome)) !== false; } finally { setBusy(false); }
    if (!ok || !onDone) { close(); return; }
    setStep({ channel, outcome });
  };

  return (
    <>
      <button
        type="button"
        className={`adm-cp-btn${disabled ? " off" : ""}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        disabled={disabled}
        title={disabled
          ? (disabledWhy || "You can read this, not change it.")
          : "Log a call, an email, a message or a reply. Two clicks."}
        onClick={open}
      >
        {current}
        {disabled ? null : <span className="adm-cp-caret" aria-hidden="true">▾</span>}
      </button>

      {anchor && (
        <Popover anchor={anchor} width={width} holdRef={hold} onClose={close}>
          {/* THE PANEL STOPS ITS OWN CLICKS. A React event bubbles through the
              REACT tree, not the DOM one, so a click in here reached the <tr>
              underneath and opened the record on top of the menu. That was a
              real bug on the stage chip; it is the same tree here. */}
          <div onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
            {step === null && (
              <div className="adm-cp-panel" role="menu" aria-label="What did you do">
                <div className="adm-cp-head">What did you do</div>
                {TOUCH_CHANNELS.map((c) => {
                  const why = blocked[c.id] || null;
                  return (
                    <button
                      key={c.id}
                      type="button" role="menuitem"
                      className={`adm-cp-opt${why ? " off" : ""}`}
                      disabled={Boolean(why) || busy}
                      title={why || undefined}
                      onClick={() => setStep(c.id)}
                    >
                      <Chip label={c.label} color="default" />
                      <span className="adm-cp-help">{why || c.why}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {typeof step === "string" && (
              <div className="adm-cp-panel" role="menu" aria-label="How did it go">
                {/* BACK, not just close. Picking the wrong channel is the most
                    likely mis-click in the whole flow, and making somebody
                    re-open the menu for it is the difference between two clicks
                    and four. */}
                <button type="button" className="adm-cp-back" onClick={() => setStep(null)} disabled={busy}>
                  ‹ {TOUCH_CHANNELS.find((c) => c.id === step)?.label}
                </button>
                <div className="adm-cp-head">How did it go</div>
                {outcomesFor(step).map((o) => (
                  <button
                    key={o.id}
                    type="button" role="menuitem"
                    className="adm-cp-opt"
                    disabled={busy}
                    onClick={() => pickOutcome(step, o.id)}
                  >
                    <Chip label={o.label} color={o.inbound ? "green" : "default"} />
                    <span className="adm-cp-help">{o.why}</span>
                  </button>
                ))}
              </div>
            )}

            {step && typeof step === "object" && (
              <TouchNext
                holdRef={hold}
                busy={busy}
                onSave={async (payload) => {
                  setBusy(true);
                  try { await onDone(payload); } finally { setBusy(false); }
                  close();
                }}
                onSkip={close}
              />
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

/* ---- STEP THREE: "AND NEXT?" ----
 *
 * The one question a rep actually has to answer, and the reason the whole
 * pipeline can be counted afterwards. Salesforce's free-text `NextStep` field is
 * famous for going stale; HubSpot derives Next Activity Date from a real
 * scheduled task and makes it read-only. This is that, at the moment the rep is
 * already looking at the record — which is the only moment they know the answer.
 *
 * IT NEVER BLOCKS. The touch is on the timeline before this is on screen and the
 * panel says so in those words, so walking away costs nothing. That is
 * deliberate and it is Close's instinct: a half-recorded call still beats an
 * unrecorded one. Skipping is caught by the "No next step" list rather than by a
 * dialog nobody can escape.
 *
 * THE DATE IS THE FIRST FIELD AND THE NOTE IS SECOND, because the date is the
 * one with consequences. Four presets and a picker: a rep working three hundred
 * rows should never open a calendar to say "Thursday".
 */
export function dayString(offsetDays) {
  return teamDatePlus(Date.now(), offsetDays);
}

export const NEXT_PRESETS = [
  ["Tomorrow", 1],
  ["In 3 days", 3],
  ["Next week", 7],
  ["In 2 weeks", 14],
];

/** THE DATE ROW, SHARED. Two panels ask "and next?" now — this one and the
 *  email drafter — and a second copy of the presets is a second copy that stops
 *  matching. Exported so both read the same four options and the same floor.
 *
 *  TOMORROW IS THE FLOOR, not today: a date stamped 9am and chosen at 3pm is
 *  already overdue, so it would land on the "No next step" list the moment it
 *  was set — a control that files its own answer as a failure. If the next step
 *  is today, it is now, not a booking. */
export function NextStepRow({ value, onChange, disabled = false }) {
  return (
    <div className="adm-cp-when" role="group" aria-label="When to pick this back up">
      {NEXT_PRESETS.map(([label, days]) => {
        const v = dayString(days);
        return (
          <button
            key={label} type="button"
            className={`adm-cp-when-b${value === v ? " on" : ""}`}
            aria-pressed={value === v}
            disabled={disabled}
            onClick={() => onChange(value === v ? null : v)}
          >
            {label}
          </button>
        );
      })}
      <input
        type="date" className="adm-cp-when-d" value={value || ""} disabled={disabled}
        min={dayString(1)} aria-label="Or pick a date"
        onChange={(e) => onChange(e.target.value || null)}
      />
    </div>
  );
}

function TouchNext({ busy, onSave, onSkip, holdRef }) {
  const [next, setNext] = useState(null);
  const [text, setText] = useState("");
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  /* A date picked but not saved is worth protecting too, not just typed words. */
  useEffect(() => {
    if (holdRef) holdRef.current = Boolean(text.trim() || next);
    return () => { if (holdRef) holdRef.current = false; };
  }, [text, next, holdRef]);

  const save = () => onSave({ next: next || null, note: text.trim() || null });

  return (
    <div className="adm-cp-panel">
      <div className="adm-cp-done">
        <strong>Logged.</strong> That is on their timeline already. When do you pick this back up?
      </div>

      <NextStepRow value={next} onChange={setNext} disabled={busy} />

      <textarea
        ref={ref}
        className="adm-cp-note"
        rows={2}
        maxLength={NOTE_MAX}
        placeholder="Anything worth remembering? Optional."
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          /* Enter saves whatever is filled in, including nothing. Escape walks
             away — and both are safe, because the touch is already written. */
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
          if (e.key === "Escape") { e.preventDefault(); onSkip(); }
        }}
      />

      <div className="adm-cp-actions">
        <button type="button" className="btn btn-sm" onClick={onSkip} disabled={busy}>
          Nothing planned
        </button>
        <button
          type="button" className="btn btn-sm btn-accent"
          onClick={save} disabled={busy || (!next && !text.trim())}
        >
          {busy ? "Saving…" : next ? "Save" : "Save note"}
        </button>
      </div>
    </div>
  );
}
