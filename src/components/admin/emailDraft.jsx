import { useEffect, useState } from "react";
import { Modal, Field, TextInput, TextArea, Select } from "./shared.jsx";
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
 * IT SENDS NOW — 2 Sep 2026, and this reverses a rule deliberately.
 *
 * What was here said: "THERE IS NO SEND BUTTON, and there must not be one",
 * for two reasons — the Aug 24 rule about the Gmail button, and that a model
 * wrote the text so a person has to read it before it reaches a prospect with
 * our name on it.
 *
 * Ryder, 2 Sep 2026: "add the send email button so you can easily get a draft,
 * click what email to send from and then send it. emails need to be able to be
 * sent from the crm from the email that is connected."
 *
 * THE REASON THAT MATTERED IS KEPT. The draft still opens in front of a person,
 * still has to be read, and still cannot leave without a deliberate press on a
 * button that names the recipient out loud. What changed is only WHERE the
 * sending happens — "leave the sending somewhere else" was never the safety, it
 * was a way of enforcing the pause. The pause is still here.
 *
 * WHAT SENDING BUYS, and it is not convenience. A copy-and-paste send is a
 * touch the console can only GUESS at: it logs the moment the words were
 * copied, which may be an email never sent, or sent three days later, or edited
 * again in the mail client. A send through this box is the one moment the
 * console can honestly witness — so the touch, its date, the cadence and the
 * follow-up become facts instead of inferences.
 *
 * Copy only stays, for a rep who would rather paste.
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
export function EmailDraftModal({ draft, onClose, onRedraft, onSent, onSend, onNext, mailboxes = [], nextDefault = null }) {
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
  /* WHICH MAILBOX IT GOES FROM. Their own by default; a shared one (growth@)
   * only if the server said they may use it — this list is `/api/gmail-accounts`
   * verbatim, and the server checks again at the door. */
  const [from, setFrom] = useState(() => mailboxes?.[0]?.email_address || "");
  const [sendFailed, setSendFailed] = useState(null);
  /* SENDING IS NOT THE SAME AS BUSY. `busy` also covers redrafting and saving
   * the follow-up, and the accent button read "Sending…" while the model was
   * writing another draft — on the one panel whose whole design is that nothing
   * leaves until you press the button. 2 Sep 2026, second checker. */
  const [sending, setSending] = useState(false);
  /* IT WENT AND THE LOG DID NOT — a state of its own, because the recovery is
   * the opposite of a failed send's. 2 Sep 2026, found by an adversarial
   * checker: this used to reuse `sendFailed`, which prints "your words are
   * still here — fix it and press it again" under a live Send button. The
   * prospect already had the email; the obvious next click sent them a second
   * one. Now the Send button is gone and the only thing left to do is log it by
   * hand. */
  const [sentNotLogged, setSentNotLogged] = useState(null);

  /* A REDRAFT REPLACES WHAT IS ON SCREEN. Without this the panel kept the first
   * draft while the server had written a second, and the rep copied the old one
   * — the two looked identical apart from the sentence they had asked to
   * change. */
  useEffect(() => {
    setSubject(draft.subject || "");
    setBody(draft.body || "");
  }, [draft.subject, draft.body]);

  /* `.ok`, NOT THE OBJECT — 2 Sep 2026, found by an adversarial checker.
   *
   * copyToClipboard returns `{ ok, why }`. `if (result)` is true for EVERY
   * object, including a refusal, so this said "Copied" when nothing had been
   * copied, and copyAndLog below wrote a touch for an email still on screen.
   * The rest of the repo gets this right (vaultParts, clientReports); these two
   * were the odd ones out. The refusal's own reason is now shown, because
   * "could not copy" without it leaves nothing to act on. */
  const copy = async (what, value) => {
    const res = await copyToClipboard(value);
    if (res?.ok) toast.success("Copied", `${what} is on your clipboard.`);
    else toast.error("Could not copy", res?.why || "Select it and copy by hand.");
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
    /* BUSY BEFORE THE FIRST await, not after it. The clipboard write is a real
     * promise, and while it was running both buttons stayed live — so two quick
     * presses, or a press then Send, ran the log twice and wrote two touches for
     * one email. Same checker, same afternoon. */
    setBusy(true);
    const copied = await copyToClipboard(`${subject}\n\n${body}`);
    if (!copied?.ok) {
      setBusy(false);
      toast.error("Could not copy", `${copied?.why || "The browser refused the copy."} Nothing was logged — select the email and copy it by hand.`);
      return;
    }
    /* The EDITED text is what gets logged, not what the model wrote. A rep who
     * rewrote half of it should find their words on the timeline, not the
     * draft's. */
    const ok = await onSent?.({ subject, body });
    setBusy(false);
    if (ok !== false) setStep("next");
  };

  /* SEND IT, FOR REAL.
   *
   * The EDITED text is what goes, not what the model wrote — a rep who rewrote
   * half of it must not send the draft.
   *
   * SEND FIRST, LOG SECOND, and the order is the design. If the send fails
   * nothing is logged, which is recoverable: fix the address and press again.
   * Logging first would write a touch for an email that never left — a wrong
   * number on a screen this console is built on trusting, and nothing later can
   * tell it was wrong. Same reasoning as copyAndLog above, one step further. */
  const send = async () => {
    if (busy || !onSend) return;
    setSendFailed(null);
    setBusy(true);
    setSending(true);
    /* try/finally, like redraft and saveNext. Without it a throw anywhere under
     * onSend left this panel frozen on "Sending…" with every button dead and
     * nothing on screen saying why — after the mail may already have gone. */
    let res;
    try {
      res = await onSend({ from, subject, body });
    } catch (err) {
      res = { ok: false, unknown: true, error: `Something broke while sending (${String(err?.message || err).slice(0, 160)}), so we cannot tell whether it went out.` };
    } finally {
      setBusy(false);
      setSending(false);
    }
    /* NO ANSWER IS NOT A REFUSAL. Treated like a send that went, because the
     * cost of being wrong runs one way: press again on a request that actually
     * delivered and the prospect gets two. */
    if (res?.unknown) {
      setSentNotLogged(res.error || "We cannot tell whether it went out.");
      return;
    }
    if (res?.sentNotLogged) {
      /* THE MAIL LEFT. Nothing about this is recoverable by pressing Send
       * again, so the button that would do it is taken away. */
      setSentNotLogged(res.error || "It was sent, but the touch did not log.");
      return;
    }
    if (!res || res.ok === false) {
      /* On the panel, not only in a toast: the words are still here and the
       * reason has to be readable beside the button that refused. */
      setSendFailed(res?.error || "It did not send. Nothing was logged.");
      return;
    }
    setStep("next");
  };

  /* ITS OWN CALLBACK, not onSent with a flag on it. Logging the email and
   * booking the follow-up are two different acts, and one callback that does
   * both depending on an argument is how the second press logs a second email —
   * the exact mistake the Contacted? picker's note step was built to make
   * impossible. */
  /* THE DAY THE CADENCE ALREADY SAID. Ryder: "the follow up on day 3 gets a
   * reminder set for on the 3rd day." The record has shown "day 3 · 3 days from
   * now" since it was built, and the rep still had to work it out and type it.
   * Prefilled and changeable — a date chosen for somebody is a suggestion, so
   * the presets and the picker sit right under it. */
  useEffect(() => {
    if (step === "next" && next === null && nextDefault) setNext(nextDefault);
  }, [step, next, nextDefault]);

  /* THE MAILBOX LIST ARRIVES AFTER THE PANEL SOMETIMES. The page reads it once
   * on load; open a record fast enough and this mounts with an empty list, so
   * the first useState above picks nothing and the Send button says "Pick a
   * mailbox" over a picker with one entry already chosen. Only fills an EMPTY
   * choice — never moves one the rep made. */
  useEffect(() => {
    if (!from && mailboxes.length) setFrom(mailboxes[0].email_address);
  }, [from, mailboxes]);

  const saveNext = async () => {
    setBusy(true);
    try { await onNext?.(next); } finally { setBusy(false); }
    onClose();
  };

  /* MAY THIS BE SENT, and if not, exactly why. Worked out here so the button,
   * its tooltip and the note under the form cannot disagree about it. */
  const canSend = !onSend
    ? { ok: false, short: "Sending is off", why: "This panel was opened without a send path." }
    : !draft.to
      ? { ok: false, short: "No address", why: "This contact has no email address on the record." }
      : !mailboxes.length
        ? { ok: false, short: "No mailbox connected", why: "Connect a mailbox in Settings → Gmail, then reload. Copy & mark it sent still works." }
        : !from
          ? { ok: false, short: "Pick a mailbox", why: "Choose which address this goes from." }
          : { ok: true };

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
          {/* role="alert" on both — every other warning in this panel has one,
              and these two were colour and bold only, so a screen reader got no
              hint that a send had failed. The button label goes back to "Send
              to …" either way, so there was nothing else to hear. */}
          {sentNotLogged && (
            <div role="alert" style={{ flex: "1 1 100%", fontSize: 12.5, color: "#b42318", fontWeight: 600, marginBottom: 8 }}>
              {sentNotLogged} Treat it as sent to {draft.to} — do not press send again.
              Use <strong>Copy &amp; mark it sent</strong> below to put it on their timeline,
              or check the mailbox&rsquo;s Sent folder first if you want to be sure.
            </div>
          )}
          {sendFailed && !sentNotLogged && (
            <div role="alert" style={{ flex: "1 1 100%", fontSize: 12.5, color: "#b42318", fontWeight: 600, marginBottom: 8 }}>
              {sendFailed} Your words are still here — fix it and press it again.
            </div>
          )}
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn" disabled={busy} onClick={() => copy("The email", `${subject}\n\n${body}`)}>
            Copy only
          </button>
          {/* SECONDARY NOW. It says exactly what it does — not a bare "Copy",
              which would leave the rep to remember to log it, and they will
              not. It stays for anybody who would rather paste. */}
          <button className="btn" disabled={busy || !onSent} onClick={copyAndLog}>
            {busy ? "Working…" : "Copy & mark it sent"}
          </button>
          {/* THE RECIPIENT IS ON THE BUTTON. A send button that says only
              "Send" is a button somebody presses while reading something else;
              this one cannot be pressed without the address passing your eye.
              It is dead, with the reason on screen, when there is no mailbox
              connected or no address to send to — never a failure at the last
              step after the words are gone. */}
          {/* THE SEND BUTTON IS GONE ONCE THE MAIL HAS GONE. Not disabled —
              gone. A greyed-out button invites a second look for the way to
              re-enable it; an absent one says the sending is over. */}
          {!sentNotLogged && (
          <button
            className="btn btn-accent"
            disabled={busy || !canSend.ok}
            title={canSend.ok ? undefined : canSend.why}
            onClick={send}
          >
            {sending ? "Sending…" : canSend.ok ? `Send to ${draft.to}` : canSend.short}
          </button>
          )}
        </>
      )}
    >
      {/* ---- STEP TWO: IT IS LOGGED, ONE THING LEFT ----
          The whole draft form goes away. What is left is the single question
          the rep still has to answer, and nothing to read past to reach it. */}
      {step === "next" && (
        <>
          <div className="adm-sl-warn adm-sl-warn-flat" role="status">
            <strong>Logged as emailed, dated today.</strong> It is on their timeline. When do you
            pick this back up? The cadence's own day is already chosen — change it if you want.
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

      {/* WHO IT COMES FROM. One mailbox and it is a line of text, because a
          dropdown with one option is a decision nobody has. Several and it is a
          picker — which is what Ryder asked for: "click what email to send from
          and then send it." A shared box is marked, because sending as growth@
          and sending as yourself are different acts. */}
      {mailboxes.length > 1 ? (
        <Field label="Send it from" hint="Only the mailboxes you are allowed to send from are listed.">
          <Select
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            options={mailboxes.map((m) => [
              m.email_address,
              `${m.email_address}${m.shared ? " · shared" : ""}${m.display_name ? ` (${m.display_name})` : ""}`,
            ])}
          />
        </Field>
      ) : mailboxes.length === 1 ? (
        <Field label="Send it from">
          <div style={{ fontSize: 14, padding: "8px 0" }}>
            {mailboxes[0].email_address}
            {mailboxes[0].shared ? <span className="adm-sl-faint"> · shared</span> : null}
          </div>
        </Field>
      ) : (
        <div className="adm-sl-warn" role="alert">
          <strong>No mailbox is connected, so this cannot be sent from here.</strong> Connect one in
          Settings → Gmail and reload. Until then, <strong>Copy &amp; mark it sent</strong> does what
          it always did.
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
        <strong>Send</strong> sends it from the mailbox above and logs it as emailed today, then asks
        when you are picking it back up. <strong>Copy &amp; mark it sent</strong> puts it on your
        clipboard and logs it without sending — for when you would rather paste it into your mail.
        Either way, read it first: a model wrote the first version of it.
      </div>
      </>)}
    </Modal>
  );
}
