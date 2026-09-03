import { useState } from "react";
import { LEAD_STAGE_LABELS, STAGE_REQUIRES } from "../../lib/data.js";
/* `TextInput` is still used for the proposal amount. Dropping it from this
 * import while swapping the date field for WhenPicker crashed the box at render
 * with "TextInput is not defined" — and BOTH a clean build and a clean lint
 * allowed it, because base eslint's `no-undef` does not see a JSX component
 * reference. tests/jsx-imports exists because of this. */
import { Modal, Field, TextInput, TextArea } from "./shared.jsx";
import WhenPicker from "./whenPicker.jsx";
import { joinWhen, splitWhen, whenProblem, defaultMinutes, localDate } from "../../../lib/when.js";

/* WHAT THE STAGE IS WAITING FOR — 2 Sep 2026.
 *
 * Ryder, about the edit sidebar: "you cant click the stage and change it
 * because it requires the notes about it, but it should have the popup for that
 * as well, no button should ever be clicked and then it not actually work and
 * move the client." And about the board: "when I drag a client from like one
 * stage to another it doesnt allow the move because it requires the info about
 * the move, but make the popup come up when you drag it so that it doesnt deny
 * the move and it gets all the info."
 *
 * Before this, three stages had a requirement and all three were enforced by
 * REFUSING: a toast that named the missing field and pointed at a different
 * screen. The note in the old code argued that booking a date on the rep's
 * behalf would be the console inventing a fact — which is true — and then
 * concluded "so refuse", which does not follow. Asking is the third option.
 *
 * FOUR RULES:
 *
 * 1. IT COLLECTS EXACTLY WHAT IS MISSING, and nothing else. A box that asks
 *    for six fields to move a card is a box people stop dragging cards into.
 *
 * 2. IT NEVER SAVES A DATE THAT CONTRADICTS THE STAGE. A booked meeting in the
 *    past is not booked; a completed meeting in the future has not happened.
 *    The button is dead, with the reason on screen, rather than accepting it
 *    and letting `stageRequirementMet` refuse the write afterwards.
 *
 * 3. NOTHING TYPED IS LOST ON A FAILED SAVE. The error appears and the values
 *    stay. `onSave` returns { ok, error } and this box only closes on ok.
 *
 * 4. IT CARRIES THE NOTE IT WAS HANDED. A drag writes a sentence of its own
 *    ("Follow up → Meeting booked"); that arrives as `note` and is what the
 *    field starts with, so the drag's own line is not thrown away.
 */

/**
 * A sensible starting point, so the common case is one click and Save.
 *
 * A full ISO string, never a half-answer. This used to build a
 * `datetime-local` value, and that control reports EMPTY until all five of its
 * sub-fields are filled — which is how a date plainly on screen read as no date
 * at all, and the form refused without ever saying AM/PM was the missing piece.
 * See lib/when.js.
 */
function defaultWhen(need) {
  const past = need?.when === "past" || need?.when === "any";
  const d = new Date();
  /* A meeting being marked complete almost always happened today or yesterday,
   * so it starts today. A prefilled FUTURE date under "when did it happen" is a
   * wrong answer somebody presses Save on. */
  if (!past) d.setDate(d.getDate() + 1);
  return joinWhen(localDate(d), defaultMinutes({ past }));
}

export default function StageNeedModal({ lead, stage, note = null, onClose, onSave }) {
  const need = STAGE_REQUIRES[stage];
  const [when, setWhen] = useState(() => defaultWhen(need));
  /* The two halves, so the box can say WHICH one is missing. `when` is null
   * until both are set; see the note in lib/when.js. */
  const [parts, setParts] = useState(() => splitWhen(defaultWhen(need)));
  const [amount, setAmount] = useState("");
  const [body, setBody] = useState(note || "");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  /* Read ONCE, at open, rather than during every render — a clock read while
   * rendering makes the same props draw two different screens. The strict
   * check runs again inside save(), where reading the clock is honest, so a box
   * left open until the date has passed still cannot save it. */
  const [openedAt] = useState(() => Date.now());

  if (!need) return null;
  const label = LEAD_STAGE_LABELS[stage] || stage;
  const who = lead?.name || lead?.company || "this lead";

  /* Rule 2. Say WHY the button is dead, next to the button. */
  let problem = null;
  if (need.kind === "date") {
    const at = Date.parse(when);
    /* WHICH HALF IS MISSING, not "that is not a date". */
    if (!when || !Number.isFinite(at)) problem = whenProblem(parts.date, parts.minutes);
    else if (need.when === "future" && at <= openedAt) {
      problem = `${label} means it has not happened yet, so the date has to be in the future.`;
    } else if (need.when === "past" && at > openedAt) {
      /* THE OTHER DIRECTION, added after a checker read the header of this file
       * out loud: it promised "a completed meeting in the future has not
       * happened. The button is dead" and there was no such branch, so a
       * meeting could be marked complete for next March. */
      problem = `${label} means it has already happened, so the date cannot be in the future.`;
    }
  } else if (need.kind === "proposal") {
    const n = Number(amount);
    if (!amount.trim()) problem = "Put the amount of the proposal in.";
    else if (!Number.isFinite(n) || n <= 0) problem = "The amount has to be a number above zero.";
  }

  const save = async () => {
    if (problem || busy) return;
    /* Checked again against the clock right now, not against the clock when
     * this box opened. A rep can leave it sitting on screen. */
    if (need.kind === "date" && need.when === "future" && Date.parse(when) <= Date.now()) {
      setFailed("That time has passed while this was open. Pick a new one.");
      return;
    }
    if (need.kind === "date" && need.when === "past" && Date.parse(when) > Date.now()) {
      setFailed("That is in the future, so the meeting has not happened yet.");
      return;
    }
    setBusy(true);
    setFailed(null);
    const res = await onSave({
      when: need.kind === "date" ? when : null,
      amount: need.kind === "proposal" ? amount.trim() : null,
      note: body.trim() || null,
    });
    setBusy(false);
    /* Rule 3. On a failure the words stay on screen. */
    if (res && res.ok === false) setFailed(res.error || "That did not save.");
  };

  return (
    <Modal
      open
      onClose={onClose}
      kicker={`MOVING TO ${label.toUpperCase()}`}
      title={need.ask}
      width={520}
      footer={<>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={Boolean(problem) || busy}>
          {busy ? "Saving…" : `Move to ${label}`}
        </button>
      </>}
    >
      <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)", marginBottom: 14 }}>
        {need.why}
      </div>

      {need.kind === "date" && (
        <Field
          label={need.ask}
          hint={need.when === "past"
            ? "The date it actually happened — in the past. This is what every meeting number is counted from."
            : need.when === "any"
              ? "Any date, past or future."
              : "In the future. This is what the reminder and the meeting count are read from."}
        >
          <WhenPicker
            value={when}
            onChange={(iso, halves) => { setWhen(iso || ""); setParts(halves); }}
            minDate={need.when === "future" ? localDate() : undefined}
            maxDate={need.when === "past" ? localDate() : undefined}
          />
        </Field>
      )}

      {need.kind === "proposal" && (
        <Field label="How much is the proposal for?" hint="Dollars. This is what makes the pipeline add up to a number.">
          <TextInput
            type="text" inputMode="decimal" placeholder="4500"
            value={amount} onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
      )}

      <Field label="Anything worth writing down?" hint="Optional. It goes on this person's timeline with the move.">
        <TextArea rows={3} value={body} onChange={(e) => setBody(e.target.value)}
          placeholder={`${who} → ${label}`} />
      </Field>

      {problem && (
        <div style={{ fontSize: 12, color: "#b42318", marginTop: -4 }}>{problem}</div>
      )}
      {failed && (
        <div style={{ fontSize: 12.5, color: "#b42318", marginTop: 10, fontWeight: 600 }}>
          {failed} Nothing has been lost — fix it and press the button again.
        </div>
      )}
    </Modal>
  );
}
