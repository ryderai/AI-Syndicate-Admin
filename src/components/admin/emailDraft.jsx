import { useEffect, useState } from "react";
import { Modal, Field, TextInput, TextArea } from "./shared.jsx";
import { copyToClipboard } from "../../lib/clipboard.js";
import { toast } from "../../lib/toast.js";
/* The same four presets and the same floor the Contacted? picker uses. One
 * copy, so the two panels cannot come to offer different dates. */
import { NextStepRow } from "./touchPicker.jsx";

/* THE DRAFT, IN FRONT OF A PERSON — Ryder, 31 Aug 2026.
 *
 * `/api/lead-email` writes it from the lead's stage, notes, timeline, tags,
 * proposals and the newest scan of their site. This is where a rep reads it,
 * changes it, and takes it.
 *
 * THERE IS NO SEND BUTTON, and there must not be one. Two reasons, and the
 * second is the one that matters:
 *   - the console has had the rule written down since Aug 24 about the Gmail
 *     button: never turn a draft button into a send button;
 *   - a model wrote this. A person has to read it before it goes to a prospect
 *     with our name on it, and the surest way to make sure they do is to leave
 *     the sending somewhere else.
 * Copy takes it to their mail client, which is where they were going to write
 * it anyway.
 *
 * WHAT THE FACTS PANEL IS FOR. Everything the model was shown, verbatim, behind
 * a disclosure. A rep about to send a claim to a stranger should be able to see
 * in one click where it came from — and when the draft is the counted skeleton
 * rather than a written one, that panel is how they tell.
 */
/* ---- SENDING IT, AND WHAT THE CONSOLE CAN HONESTLY KNOW ----
 *
 * Ryder, 31 Aug 2026: "when i send a draft that was made for me … it marks them
 * as contacted by email with the date and notes, then the rep just clicks the
 * follow up date."
 *
 * THE CONSOLE CANNOT WATCH A MAIL CLIENT. Nothing here sends, so nothing here
 * can observe a send. The nearest honest moment is the one where the rep takes
 * the words away to send them — the copy.
 *
 * So the primary button says exactly what it does: it copies AND logs the
 * email. A plain "Copy only" sits beside it for grabbing the text without
 * claiming anything happened. The rep chooses, and neither label is a guess
 * dressed up as a fact — which matters, because a touch that was never sent is
 * a wrong number on a screen this whole console is built on trusting.
 *
 * The log goes through logTouch, the SAME path the Contacted? cell uses, so the
 * claim, the database trigger's date stamps, the cadence and the timeline line
 * behave identically whichever control was pressed. Then the date row appears
 * in this same panel — one more click and the rep is done.
 */
export function EmailDraftModal({ draft, onClose, onRedraft, onSent, onNext }) {
  const [subject, setSubject] = useState(draft.subject || "");
  const [body, setBody] = useState(draft.body || "");
  const [angle, setAngle] = useState("");
  const [showFacts, setShowFacts] = useState(false);
  const [busy, setBusy] = useState(false);
  /* "draft" while they are reading it · "next" once it is logged and the only
   * thing left is the follow-up date. One variable, because two booleans would
   * allow a fourth state that means nothing. */
  const [step, setStep] = useState("draft");
  const [next, setNext] = useState(null);

  /* A REDRAFT REPLACES WHAT IS ON SCREEN. Without this the panel kept the first
   * draft while the server had written a second, and the rep copied the old one
   * — the two looked identical apart from the sentence they had asked to
   * change. */
  useEffect(() => {
    setSubject(draft.subject || "");
    setBody(draft.body || "");
  }, [draft.subject, draft.body]);

  const copy = async (what, value) => {
    const ok = await copyToClipboard(value);
    if (ok) toast.success("Copied", `${what} is on your clipboard.`);
    else toast.error("Could not copy", "Select it and copy by hand.");
  };

  const redraft = async () => {
    if (!onRedraft || busy) return;
    setBusy(true);
    try { await onRedraft(angle.trim() || null); } finally { setBusy(false); }
  };

  /* COPY FIRST, THEN LOG. If the clipboard refuses — a permission, a private
   * window — the rep has not got the email, so nothing should claim they sent
   * it. Failing this way round is recoverable; the other way round writes a
   * touch for an email that never left the screen. */
  const copyAndLog = async () => {
    if (busy) return;
    const copied = await copyToClipboard(`${subject}\n\n${body}`);
    if (!copied) {
      toast.error("Could not copy", "Nothing was logged. Select the email and copy it by hand.");
      return;
    }
    setBusy(true);
    /* The EDITED text is what gets logged, not what the model wrote. A rep who
     * rewrote half of it should find their words on the timeline, not the
     * draft's. */
    const ok = await onSent?.({ subject, body });
    setBusy(false);
    if (ok !== false) setStep("next");
  };

  /* ITS OWN CALLBACK, not onSent with a flag on it. Logging the email and
   * booking the follow-up are two different acts, and one callback that does
   * both depending on an argument is how the second press logs a second email —
   * the exact mistake the Contacted? picker's note step was built to make
   * impossible. */
  const saveNext = async () => {
    setBusy(true);
    try { await onNext?.(next); } finally { setBusy(false); }
    onClose();
  };

  const words = body.split(/\s+/).filter(Boolean).length;

  return (
    <Modal
      open onClose={onClose} kicker="SALES"
      title={`Email to ${draft.to || "this contact"}`}
      width={680}
      footer={step === "next" ? (
        <>
          <button className="btn" onClick={onClose}>Not yet</button>
          <button className="btn btn-accent" disabled={busy} onClick={saveNext}>
            {busy ? "Saving…" : next ? "Book it" : "Nothing planned"}
          </button>
        </>
      ) : (
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn" disabled={busy} onClick={() => copy("The email", `${subject}\n\n${body}`)}>
            Copy only
          </button>
          {/* THE PRIMARY ACTION SAYS EXACTLY WHAT IT DOES. Not "Send" — nothing
              here sends — and not a bare "Copy", which would leave the rep to
              remember to log it and they will not. */}
          <button className="btn btn-accent" disabled={busy || !onSent} onClick={copyAndLog}>
            {busy ? "Logging…" : "Copy & mark it sent"}
          </button>
        </>
      )}
    >
      {/* ---- STEP TWO: IT IS LOGGED, ONE THING LEFT ----
          The whole draft form goes away. What is left is the single question
          the rep still has to answer, and nothing to read past to reach it. */}
      {step === "next" && (
        <>
          <div className="adm-sl-warn adm-sl-warn-flat" role="status">
            <strong>Logged as emailed, dated today.</strong> The email is on their timeline and it is
            on your clipboard. When do you pick this back up?
          </div>
          <NextStepRow value={next} onChange={setNext} disabled={busy} />
          <div className="adm-sl-emailfoot">
            Skip it and they land on your <strong>No next step</strong> list instead — nothing is lost.
          </div>
        </>
      )}

      {step === "draft" && (<>
      {/* WHAT KIND OF EMAIL THIS IS, said out loud. The stage decided it, and a
          rep who disagrees with the job should change the stage rather than
          fight the draft. */}
      <div className="adm-sl-warn adm-sl-warn-flat" role="status">
        <strong>{draft.job?.label || "Email"}.</strong> {draft.job?.ask}
      </div>

      {/* THE SKELETON SAYS IT IS A SKELETON. A written draft and a counted one
          look alike at a glance, and a rep who cannot tell them apart will send
          the skeleton with its square brackets still in it. */}
      {draft.counted && (
        <div className="adm-sl-warn" role="alert">
          {/* The reason string does not end in a full stop, so it ran straight
              into the next sentence: "...nothing could be written What is below".
              One added period, and the sentence reads. */}
          <strong>Nothing was written for you.</strong> {draft.why || "The AI did not answer"}. What is below is
          a skeleton built from the record — the parts in square brackets are yours to fill in.
        </div>
      )}

      {/* A READ THAT FAILED IS NOT A LEAD WITH NOTHING ON IT. */}
      {draft.missing?.length > 0 && (
        <div className="adm-sl-warn" role="alert">
          <strong>Some of their record did not load.</strong> {draft.missing.join(", ")} could not be read, so this
          was written from an incomplete picture. Worth a look at the record before you send it.
        </div>
      )}

      <Field label="Subject">
        {/* autoFocus rather than a ref: TextInput is a plain function component
            and does not forward one, so a ref here would be silently null. */}
        <TextInput autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>

      <Field
        label="The email"
        hint={`${words} word${words === 1 ? "" : "s"}. Short is the point — read it before you send it.`}
      >
        <TextArea rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>

      <Field label="Want a different angle?" hint="Say what to change and it writes another one. Your edits above are replaced.">
        <div className="adm-sl-grid2">
          <TextInput
            value={angle}
            placeholder="shorter · lead with the meeting · mention their new office"
            onChange={(e) => setAngle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); redraft(); } }}
          />
          <button className="btn" disabled={busy || !onRedraft} onClick={redraft}>
            {busy ? "Writing…" : "Write another"}
          </button>
        </div>
      </Field>

      <button type="button" className="adm-cp-back" onClick={() => setShowFacts((v) => !v)}>
        {showFacts ? "▾" : "▸"} What it was written from
      </button>
      {showFacts && (
        <pre className="adm-sl-facts">{draft.facts}</pre>
      )}

      <div className="adm-sl-emailfoot">
        Nothing is sent from here. <strong>Copy &amp; mark it sent</strong> puts it on your clipboard and logs it
        as emailed today — paste it into your mail, read it once more, then send.
      </div>
      </>)}
    </Modal>
  );
}
