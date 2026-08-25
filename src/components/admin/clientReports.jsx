import { useCallback, useEffect, useState } from "react";
import { Modal, Field, TextArea, TextInput, Select, EmptyState, SourceBadge } from "./shared.jsx";
import { Chip } from "./opsCells.jsx";
import { toast } from "../../lib/toast.js";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { listClientReports, deleteClientReport, generateClientReportPreview } from "../../lib/data.js";
import {
  REPORT_PRESETS, DEFAULT_PRESET, presetById, MAX_INSTRUCTION_CHARS,
  SHAPE_PRESETS, DEFAULT_SHAPE, shapeById, MAX_SHAPE_CHARS,
  reportToMarkdown, provenanceLine,
} from "../../../lib/client-report.js";
import { reportToEmail, reportToText, reportToPlainText } from "../../../lib/report-share.js";

/* GENERATE REPORT — built Aug 21 2026, at Ryder's ask.
 *
 * One button on a client page. It reads everything this console holds about
 * that client — tasks, the weekly log, websites, email, follow-ups, invoices,
 * tickets, the team's own notes — counts it, and writes it up. The box above
 * the button is where you say how deep to go: "the 10-second version", "go
 * really in depth", "write it for the call tomorrow".
 *
 * THREE THINGS THAT ARE NOT NEGOTIABLE, AND WHERE THEY LIVE
 *
 * 1. ONE answer, shaped by what was asked for. Changed Aug 23 2026 — it used to
 *    be two layers, a 30-second version and a full one, and you read the same
 *    ground twice. The shape now comes from the request and from the notes left
 *    on earlier answers; see the SHAPE block in lib/client-report.js.
 * 2. Every report says where it came from and, separately, what our records
 *    CANNOT answer. A gap that is named is a gap; a gap that is quietly skipped
 *    reads as "all clear".
 * 3. A report never hands work to a person. Checked in code — checkReport() in
 *    lib/client-report.js throws the draft away over it — not just asked for in
 *    the prompt.
 *
 * Nothing from the vault is in a report beyond a count. See api/client-report.js.
 */

function whenText(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Turn the markdown-ish body into something readable without pulling in a
 * markdown library. Headings, bullets, paragraphs. Deliberately small: the
 * report is written by us, for us, and the shape is fixed. */
function RichText({ text }) {
  const lines = String(text || "").split("\n");
  const out = [];
  let bullets = [];

  const flush = (key) => {
    if (!bullets.length) return;
    out.push(<ul key={`u${key}`} className="adm-rep-list">{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>);
    bullets = [];
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^\s*#{2,3}\s+/.test(line)) {
      flush(i);
      out.push(<h4 key={i} className="adm-rep-h">{line.replace(/^\s*#+\s+/, "")}</h4>);
      return;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      bullets.push(line.replace(/^\s*[-*•]\s+/, ""));
      return;
    }
    flush(i);
    if (line.trim()) out.push(<p key={i} className="adm-rep-p">{line}</p>);
  });
  flush("end");
  return <>{out}</>;
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

/**
 * The saved reports for one client. Owned by the page that shows the tabs and
 * handed down, so the tab's badge and the panel can never disagree — the same
 * rule the platform login cards and the vault follow.
 */
export function useClientReports(clientId) {
  const [rows, setRows] = useState([]);
  const [state, setState] = useState({ loading: true, error: null, sample: false });

  const load = useCallback(async () => {
    try {
      const r = await listClientReports(clientId);
      setRows(r.rows || []);
      setState({ loading: false, error: r.error || null, sample: Boolean(r.sample) });
    } catch (err) {
      setRows([]);
      setState({ loading: false, error: err?.message || "The saved reports could not be read.", sample: false });
    }
  }, [clientId]);

  useEffect(() => { load(); }, [load]);
  return { rows, ...state, reload: load };
}

export function ClientReportsPanel({ client, reports, autoOpen = false, onAutoOpened }) {
  const { rows, loading, error, sample, reload: load } = reports;
  const state = { loading, error, sample };
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState(null);       // a report row being read
  const live = isConfigured();

  /* The Generate report button at the top of the client page jumps here AND
   * opens the box. The flag is cleared as soon as it is used, so closing the
   * box does not immediately reopen it. */
  useEffect(() => {
    if (!autoOpen) return;
    setAsking(true);
    if (onAutoOpened) onAutoOpened();
  }, [autoOpen, onAutoOpened]);

  const remove = async (row) => {
    if (!window.confirm("Delete this report? The work it describes is untouched — this only removes the write-up.")) return;
    const res = await deleteClientReport(row.id);
    if (!res.ok) { toast.error("Could not delete it", res.error); return; }
    toast.success("Deleted", "");
    if (open?.id === row.id) setOpen(null);
    load();
  };

  return (
    <>
      <div className="card adm-cp-sitesbar">
        <div style={{ minWidth: 0 }}>
          <div className="label" style={{ marginBottom: 4 }}>Reports</div>
          <div style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>
            {state.loading ? "Loading…" : rows.length
              ? `${rows.length} saved · newest ${whenText(rows[0].created_at)}`
              : "Nothing generated yet"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn btn-accent" onClick={() => setAsking(true)}>Generate report</button>
          <SourceBadge mode={state.sample ? "sample" : "live"} />
        </div>
      </div>

      {state.error && <div className="adm-db-warn">The saved reports could not be read: {state.error}</div>}

      {/* An error and "nothing here yet" are two different statements, and
          stacking them said both at once. When the read failed we do not know
          whether there are reports, so we do not claim there are none. */}
      {!state.loading && rows.length === 0 && !state.error ? (
        <EmptyState
          icon="&#128203;"
          title={`No reports for ${client.name} yet`}
          body="Press Generate report and say how deep to go. It reads this client's tasks, weekly log, websites, email, follow-ups, invoices and notes, counts them, and writes one answer in the shape you asked for. Every report is kept, so you can see what we said last month."
          action={<button className="btn btn-accent" onClick={() => setAsking(true)}>Generate the first one</button>}
        />
      ) : (
        <div className="adm-rep-history">
          {rows.map((r) => (
            <div key={r.id} className="card adm-rep-row">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="adm-rep-rowtop">
                  <span className="adm-rep-title">{r.title}</span>
                  <Chip
                    label={r.source === "written" ? "AI-WRITTEN" : "COUNTED"}
                    color={r.source === "written" ? "purple" : "default"}
                    title={r.source === "written"
                      ? "The AI wrote these words from the counted facts — it was shown nothing else."
                      : "Built straight from the counts by plain code. No AI involved."}
                  />
                  {r.preset && <Chip label={(presetById(r.preset).label || "").toUpperCase()} color="blue" />}
                </div>
                <div className="adm-rep-rowsub">
                  {whenText(r.created_at)}
                  {r.created_by_email ? ` · ${r.created_by_email}` : ""}
                  {r.instruction ? ` · asked for: "${r.instruction}"` : ""}
                  {r.shape ? ` · to read as: "${r.shape}"` : ""}
                </div>
                {r.rejected_why && (
                  <div className="adm-rep-rejected">
                    The AI version was thrown away ({r.rejected_why}), so this is the counted one.
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button className="btn btn-sm" onClick={() => setOpen(r)}>Read</button>
                <button className="btn btn-sm" style={{ color: "var(--danger)" }} onClick={() => remove(r)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {asking && (
        <GenerateModal
          client={client} live={live}
          onClose={() => setAsking(false)}
          onDone={(row) => { setAsking(false); load(); setOpen(row); }}
        />
      )}
      {open && <ReportModal report={open} client={client} onClose={() => setOpen(null)} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Ask for one                                                         */
/* ------------------------------------------------------------------ */

function GenerateModal({ client, live, onClose, onDone }) {
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  const [instruction, setInstruction] = useState(presetById(DEFAULT_PRESET).instruction);
  /* The SECOND question, added Aug 24 2026: who it is for and what shape it
   * comes back in. Kept apart from the first box on purpose — "write it as an
   * email" buried three lines into a paragraph about scope reads as a passing
   * remark, and the answer comes back as a report anyway. */
  const [shapePreset, setShapePreset] = useState(DEFAULT_SHAPE);
  const [shape, setShape] = useState(shapeById(DEFAULT_SHAPE).shape);
  const [busy, setBusy] = useState(false);

  /* Pressing a button FILLS THE BOX rather than sending anything. The box is
   * what actually travels, so a person should be able to read and change every
   * word of it before it does — and can type something the buttons never
   * covered. */
  const pick = (p) => {
    setPreset(p.id);
    setInstruction(p.instruction);
  };

  const pickShape = (p) => {
    setShapePreset(p.id);
    setShape(p.shape);
  };

  const go = async () => {
    setBusy(true);
    const res = live
      ? await apiFetch("/api/client-report", { method: "POST", body: { clientId: client.id, instruction, preset, shape, shapePreset } })
      : await generateClientReportPreview(client.id, { instruction, preset, shape, shapePreset });
    setBusy(false);

    if (live) {
      if (!res.ok) { toast.error("Could not write the report", res.error); return; }
      const data = res.data;
      if (data.shapeNotSaved) toast.warn("Saved, minus one thing", data.shapeNote || "");
      if (data.saved === false) toast.warn("Written, but not filed", data.saveError || "");
      else if (data.rejected) toast.warn("Counted version saved", `The AI draft was thrown away — ${data.rejected}.`);
      else toast.success("Report ready", data.source === "written" ? "Worded by the AI from our counts." : "Counted from our own records.");
      onDone(data.report);
      return;
    }

    if (!res.ok) { toast.error("Could not write the report", res.error); return; }
    toast.success("Report ready", "Counted from the sample records.");
    onDone(res.report);
  };

  const over = instruction.length > MAX_INSTRUCTION_CHARS;
  const shapeOver = shape.length > MAX_SHAPE_CHARS;

  return (
    <Modal
      open onClose={onClose}
      kicker={client.name.toUpperCase()}
      title="Generate a report"
      width={640}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={go} disabled={busy || over || shapeOver}>{busy ? "Reading the records…" : "Generate"}</button>
      </>}
    >
      {/* THE EXPLANATIONS ARE GONE FROM THIS BOX. Ryder, Aug 25 2026: "remove
        * the descriptions". Three blocks of standing text — what it reads,
        * what the shape box may not change, what a report will never do —
        * were pushing the two things you actually came here to type below the
        * fold. Text that never changes stops being read after the second
        * time; the rules it described are enforced in code either way
        * (checkReport in lib/client-report.js), and they are written down in
        * CONTEXT-FOR-AI.md §41 for whoever needs them. Do not put them back
        * without asking. */}
      <div className="label" style={{ marginBottom: 6 }}>Start from one of these</div>
      <div className="adm-rep-presets">
        {REPORT_PRESETS.map((p) => (
          <button
            key={p.id} type="button"
            className={`adm-rep-preset${preset === p.id ? " on" : ""}`}
            onClick={() => pick(p)}
          >
            <span className="adm-rep-presetl">{p.label}</span>
            <span className="adm-rep-preseth">{p.hint}</span>
          </button>
        ))}
      </div>

      <Field label="Now say what you want, in your own words">
        <TextArea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          style={{ minHeight: 96 }}
          placeholder="Keep it short. Only what is blocked and what is next."
        />
      </Field>
      <div className={`adm-rep-count${over ? " bad" : ""}`}>
        {instruction.length} / {MAX_INSTRUCTION_CHARS} characters
        {over ? " — too long, trim it" : ""}
      </div>

      <div className="label" style={{ marginTop: 18, marginBottom: 6 }}>And how should it read?</div>
      <div className="adm-rep-presets">
        {SHAPE_PRESETS.map((p) => (
          <button
            key={p.id} type="button"
            className={`adm-rep-preset${shapePreset === p.id ? " on" : ""}`}
            onClick={() => pickShape(p)}
          >
            <span className="adm-rep-presetl">{p.label}</span>
            <span className="adm-rep-preseth">{p.hint}</span>
          </button>
        ))}
      </div>

      <Field label="Who is it for, and what shape do you want back">
        <TextArea
          value={shape}
          onChange={(e) => setShape(e.target.value)}
          style={{ minHeight: 72 }}
          placeholder="For the client. Plain and friendly. No headings."
        />
      </Field>
      <div className={`adm-rep-count${shapeOver ? " bad" : ""}`}>
        {shape.length} / {MAX_SHAPE_CHARS} characters
        {shapeOver ? " — too long, trim it" : ""}
      </div>

    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Read one                                                            */
/* ------------------------------------------------------------------ */

/* ONE RESPONSE, ONE SCROLL — same change as the console generator, same day.
 * The three tabs (30-second / full / what it could not check) are gone: the
 * answer is one document and the gaps are the last part of it. Older rows still
 * carry a separate summary, so it is printed above the body rather than lost. */
function ReportModal({ report, client, onClose }) {
  const [facts, setFacts] = useState(false);
  /* "Send it to them" — Ryder, Aug 24 2026. Three different things, because a
   * client email, a text and an internal paste are three different documents.
   * All three are built from the words already in this report: nothing here
   * writes a new sentence, because a new sentence would not have been through
   * the honesty check the report went through. */
  const [sharing, setSharing] = useState(null);   // null | "email" | "text"

  const markdown = reportToMarkdown(
    {
      title: report.title,
      summary: report.summary,
      body: report.body,
      cannotCheck: report.cannot_check,
    },
    {
      clientName: client.name,
      facts: report.facts || { takenAt: report.counts_at },
      source: report.source,
      instruction: report.instruction,
    }
  );

  const copyAll = async () => {
    /* The shared module, so copying a report also cancels a pending vault
     * clipboard wipe instead of having the report quietly wiped a minute later. */
    const done = await copyToClipboard(markdown);
    if (done.ok) toast.success("Copied", "The whole report is on the clipboard, ready to paste.");
    else toast.error("The copy did not happen", done.why + " Select the text and copy it by hand.");
  };

  /* The same words with the markdown taken off. "Copy all" hands over the
   * markdown, which is right for a file and wrong for an email — pasted into
   * Gmail it shows up as "## Where they stand". */
  const copyPlain = async () => {
    const done = await copyToClipboard(reportToPlainText(report, { clientName: client.name }));
    if (done.ok) toast.success("Copied", "Plain text, ready to paste anywhere.");
    else toast.error("The copy did not happen", `${done.why} Select the text and copy it by hand.`);
  };

  const download = () => {
    const safe = `${client.name}-report-${String(report.created_at || "").slice(0, 10)}`.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safe}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Let the click start before the handle is thrown away.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  return (
    <Modal
      open
      /* While the facts window is open on top, Escape belongs to IT. Both
         windows listen on the document, so one press used to close the facts
         panel and the report underneath it at the same time. */
      onClose={() => { if (!facts) onClose(); }}
      kicker={client.name.toUpperCase()}
      title={report.title}
      width={800}
      footer={<>
        <button className="btn" style={{ marginRight: "auto" }} onClick={() => setFacts(true)}>Check the numbers</button>
        <button className="btn" onClick={copyPlain} title="The whole report as plain text — no # marks. For pasting into an email, a doc, or a message.">Copy to paste</button>
        <button className="btn" onClick={() => setSharing("email")}>Email them →</button>
        <button className="btn" onClick={() => setSharing("text")}>Text them →</button>
        <button className="btn" onClick={download}>Download</button>
        <button className="btn" onClick={copyAll}>Copy all</button>
        <button className="btn btn-accent" onClick={onClose}>Close</button>
      </>}
    >
      <div className="adm-rep-prov">
        {provenanceLine(report.facts || { takenAt: report.counts_at }, report.source)}
        {report.instruction ? <> Asked for: “{report.instruction}”.</> : null}
        {report.shape ? <> Asked to read as: “{report.shape}”.</> : null}
      </div>

      <div className="adm-rep-body">
        {String(report.summary || "").trim() ? <RichText text={report.summary} /> : null}
        <RichText text={report.body} />
        {String(report.cannot_check || "").trim() ? (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--rule)" }}>
            <div className="label" style={{ marginBottom: 6 }}>What these records cannot answer</div>
            <p className="adm-rep-p">
              Nothing above is based on these. Named out loud on purpose — a gap nobody mentions reads
              as “checked, all fine”.
            </p>
            <RichText text={report.cannot_check} />
          </div>
        ) : null}
      </div>

      {sharing && (
        <ShareModal
          kind={sharing} report={report} client={client}
          onClose={() => setSharing(null)}
        />
      )}

      {facts && (
        <Modal open onClose={() => setFacts(false)} kicker="THE FACTS IT WAS WRITTEN FROM" title={`${client.name} — counted records`} width={760}>
          <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 12 }}>
            The exact counts this report was built from, taken at {whenText(report.counts_at)}. Nothing else was used.
            If a claim in the report is not backed by something here, it does not belong in it.
          </p>
          <div className="adm-cp-facts">
            {Object.entries(report.facts?.counts || {}).map(([k, v]) => (
              <div key={k} className="adm-cp-fact">
                <span className="adm-cp-factn">{v}</span>
                <span className="adm-cp-factk">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</span>
              </div>
            ))}
          </div>
          <pre className="adm-cp-raw">{JSON.stringify(report.facts || {}, null, 2)}</pre>
        </Modal>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* SEND IT TO THEM                                                     */
/* ------------------------------------------------------------------ */

/**
 * A draft email or a short text, built from a report that is already saved.
 *
 * THE ONE RULE: every word in here came out of the report. Nothing on this
 * screen writes a new sentence, invents a number, or softens a fact — because
 * the report went through the honesty check and a fresh sentence would not
 * have. The box is editable, so a person can write whatever they like; what
 * they cannot do is get the console to write it for them without that check.
 *
 * NOTHING IS EVER SENT FROM HERE. The Gmail button saves a DRAFT into the
 * mailbox and stops. A person opens Gmail, reads it, and presses send. That is
 * deliberate and it is not a step to remove later: an email to a client going
 * out on one click of a button labelled "email them" is how the wrong thing
 * gets sent to the wrong person.
 */
function ShareModal({ kind, report, client, onClose }) {
  const isEmail = kind === "email";
  const live = isConfigured();
  const todayLabel = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });

  const built = isEmail
    ? reportToEmail(report, {
      clientName: client.name,
      contactName: client.contact_name,
      contactEmail: client.contact_email,
      senderName: "",              // filled in below from the box
      todayLabel,
    })
    : null;

  const [to, setTo] = useState(isEmail ? (client.contact_email || "") : (client.contact_phone || ""));
  const [subject, setSubject] = useState(isEmail ? built.subject : "");
  const [body, setBody] = useState(isEmail
    ? built.body
    : reportToText(report, { clientName: client.name, contactName: client.contact_name }));

  const [mailboxes, setMailboxes] = useState(null);   // null = still asking
  const [mailbox, setMailbox] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);

  /* Which of our mailboxes the draft lands in. Asked for once, when the box
   * opens, and only for an email. */
  useEffect(() => {
    if (!isEmail || !live) { setMailboxes([]); return; }
    let stop = false;
    (async () => {
      const res = await apiFetch("/api/gmail-accounts");
      if (stop) return;
      const list = (res.ok ? res.data.accounts : []) || [];
      setMailboxes(list);
      /* A shared mailbox first — a client email should come from growth@, not
       * from somebody's personal address, unless there is nothing else. */
      const preferred = list.find((m) => m.shared && !m.needs_reconnect)
        || list.find((m) => !m.needs_reconnect)
        || list[0];
      setMailbox(preferred?.email_address || "");
    })();
    return () => { stop = true; };
  }, [isEmail, live]);

  const copy = async () => {
    const text = isEmail ? `${subject}\n\n${body}` : body;
    const done = await copyToClipboard(text);
    if (done.ok) toast.success("Copied", isEmail ? "Subject and message are on the clipboard." : "The message is on the clipboard.");
    else toast.error("The copy did not happen", `${done.why} Select the text and copy it by hand.`);
  };

  const draftInGmail = async () => {
    if (!live) { toast.warn("Preview mode", "Saving a real Gmail draft needs the console's own keys set."); return; }
    if (!mailbox) { toast.error("No mailbox", "Connect a Gmail account on the Inbox page first."); return; }
    if (!to.trim()) { toast.error("Nobody to send it to", "Put an email address in the To box."); return; }
    setBusy(true);
    const res = await apiFetch("/api/gmail-drafts", {
      method: "POST",
      body: { account: mailbox, action: "save", to, subject, body },
    });
    setBusy(false);
    if (!res.ok) { toast.error("The draft was not saved", res.error); return; }
    setSaved(res.data?.draftId || true);
    toast.success("Draft saved in Gmail", `In ${mailbox}. Nothing has been sent — open Gmail, read it, then press send.`);
  };

  /* Handing the text to the Messages app. A plain sms: link, which macOS opens
   * in Messages with the words already in the box. It cannot send on its own —
   * the person still presses send — and it does nothing at all if the number
   * is missing, which is why the button says so instead of failing quietly. */
  const openMessages = () => {
    const number = to.replace(/[^\d+]/g, "");
    if (!number) { toast.warn("No number", "Put a phone number in the box, or just press Copy and paste it yourself."); return; }
    window.location.href = `sms:${number}&body=${encodeURIComponent(body)}`;
  };

  const chosen = (mailboxes || []).find((m) => m.email_address === mailbox);

  return (
    <Modal
      open onClose={onClose}
      kicker={client.name.toUpperCase()}
      title={isEmail ? "Email them this" : "Text them this"}
      width={680}
      footer={<>
        <button className="btn" style={{ marginRight: "auto" }} onClick={onClose}>Cancel</button>
        <button className="btn" onClick={copy}>Copy it</button>
        {isEmail
          ? <button className="btn btn-accent" onClick={draftInGmail} disabled={busy}>{busy ? "Saving…" : "Save as a Gmail draft"}</button>
          : <button className="btn btn-accent" onClick={openMessages}>Open in Messages</button>}
      </>}
    >
      <p className="adm-rep-explain">
        Every word below is lifted straight out of the report — nothing new has been written, so nothing
        here has skipped the check the report went through. Edit it however you like.
        {isEmail
          ? <> <strong>Nothing is sent.</strong> The button saves a draft in Gmail. You open it, read it, and press send yourself.</>
          : <> <strong>Nothing is sent.</strong> Open in Messages fills the message in on your Mac; you press send.</>}
      </p>

      {isEmail && !client.contact_email && (
        <div className="adm-db-warn" style={{ marginBottom: 12 }}>
          This client has no contact email saved, so the To box started empty. Type one in, or add it with
          <strong> Edit</strong> at the top of the client page.
        </div>
      )}
      {!isEmail && !client.contact_phone && (
        <div className="adm-db-warn" style={{ marginBottom: 12 }}>
          This client has no phone number saved. Type one in, or just press <strong>Copy it</strong> and paste
          the message wherever you are texting from.
        </div>
      )}

      {isEmail && (
        <>
          <Field label="Send it from" hint="A shared mailbox is picked when there is one, so a client email comes from the agency rather than one person.">
            {mailboxes === null ? (
              <div style={{ fontSize: 13, color: "var(--ink-dim)" }}>Looking up your mailboxes…</div>
            ) : mailboxes.length === 0 ? (
              <div style={{ fontSize: 13, color: "#92400e" }}>
                No Gmail account is connected, so a draft cannot be saved. Connect one on the Inbox page —
                or press <strong>Copy it</strong> and paste the email wherever you write mail.
              </div>
            ) : (
              <Select
                value={mailbox} onChange={(e) => setMailbox(e.target.value)}
                options={mailboxes.map((m) => [
                  m.email_address,
                  `${m.email_address}${m.shared ? " (shared)" : ""}${m.needs_reconnect ? " — needs reconnecting" : ""}`,
                ])}
              />
            )}
          </Field>
          {chosen?.needs_reconnect && (
            <div className="adm-db-warn" style={{ marginBottom: 12 }}>
              That mailbox needs signing in again before it can save a draft. Inbox page → Reconnect.
            </div>
          )}
        </>
      )}

      <Field label={isEmail ? "To" : "Their number"}>
        <TextInput
          value={to} onChange={(e) => setTo(e.target.value)}
          placeholder={isEmail ? "dana@example.com" : "+1 850 555 0134"}
        />
      </Field>

      {isEmail && (
        <Field label="Subject">
          <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
      )}

      <Field
        label={isEmail ? "The email" : "The message"}
        hint={isEmail
          ? "Sign it with your own name before you send it — the report does not know who is sending."
          : `${body.length} characters. Two or three lines is the point; the full report is what gets sent properly.`}
      >
        <TextArea value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: isEmail ? 220 : 120 }} />
      </Field>

      {isEmail && built?.warnings?.length ? (
        <div className="adm-rep-rules">
          {built.warnings.map((w, i) => <div key={i} style={{ marginBottom: 6 }}>{w}</div>)}
          <div>
            <strong>Read it for anything internal.</strong> The gaps list and our own working notes were left
            out on purpose, but a note somebody pasted into this client&apos;s record could still be quoted in the
            body above.
          </div>
        </div>
      ) : null}

      {saved && (
        <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 10, background: "var(--success-soft)", color: "#006b1a", fontSize: 12.5, lineHeight: 1.55 }}>
          Saved as a draft in {mailbox}. It is sitting in Gmail&apos;s Drafts folder — nothing has gone out.
        </div>
      )}
    </Modal>
  );
}
