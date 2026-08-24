import { useCallback, useEffect, useState } from "react";
import { Modal, Field, TextArea, EmptyState, SourceBadge } from "./shared.jsx";
import { Chip } from "./opsCells.jsx";
import { toast } from "../../lib/toast.js";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { listClientReports, deleteClientReport, generateClientReportPreview } from "../../lib/data.js";
import {
  REPORT_PRESETS, DEFAULT_PRESET, presetById, MAX_INSTRUCTION_CHARS,
  reportToMarkdown, provenanceLine,
} from "../../../lib/client-report.js";

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
  const [busy, setBusy] = useState(false);

  /* Pressing a button FILLS THE BOX rather than sending anything. The box is
   * what actually travels, so a person should be able to read and change every
   * word of it before it does — and can type something the buttons never
   * covered. */
  const pick = (p) => {
    setPreset(p.id);
    setInstruction(p.instruction);
  };

  const go = async () => {
    setBusy(true);
    const res = live
      ? await apiFetch("/api/client-report", { method: "POST", body: { clientId: client.id, instruction, preset } })
      : await generateClientReportPreview(client.id, { instruction, preset });
    setBusy(false);

    if (live) {
      if (!res.ok) { toast.error("Could not write the report", res.error); return; }
      const data = res.data;
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

  return (
    <Modal
      open onClose={onClose}
      kicker={client.name.toUpperCase()}
      title="Generate a report"
      width={640}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={go} disabled={busy || over}>{busy ? "Reading the records…" : "Generate"}</button>
      </>}
    >
      <p className="adm-rep-explain">
        It reads everything this console holds about {client.name} — tasks, the weekly log, websites, email threads,
        follow-ups, invoices, support tickets and the notes the team wrote — counts it, and writes one answer in the
        shape you ask for. Every number in it has to appear in those counts, or the draft is thrown away.
        {" "}It also uses the numbers already read from {client.name}&apos;s own accounts on the Connections tab. It does
        not go and fetch them now: a report quotes a reading taken on a known day, so pressing this button twice
        cannot produce two different reports. Press <strong>Refresh</strong> on the Connections tab first if you
        want today&apos;s numbers.
      </p>

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

      <Field
        label="Now say what you want, in your own words"
        hint="This is what actually gets sent. Change it, add to it, or write your own. Example: “the 10-second version, only what is blocked”."
      >
        <TextArea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          style={{ minHeight: 96 }}
          placeholder="Keep it short. Only what is blocked and what is next."
        />
      </Field>
      <div className={`adm-rep-count${over ? " bad" : ""}`}>
        {instruction.length} / {MAX_INSTRUCTION_CHARS} characters
        {over ? " — too long. Trim it, or the facts get squeezed out of the way." : ""}
      </div>

      <div className="adm-rep-rules">
        <strong>What it will never do:</strong> make up a number that is not in our records, promise a result, or
        write down a job for a person. If a draft does any of those, it is thrown away and you get the plain counted
        version instead — and the page tells you that is what happened.
        <br /><br />
        <strong>What it does carry:</strong> the notes your team wrote about this client, word for word, and the
        client&apos;s own notes field. Nothing from the vault beyond a count. If somebody pasted something private
        into a note, it will be in this report and in anything you forward — worth a look before you send it.
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
        <button className="btn" onClick={download}>Download</button>
        <button className="btn" onClick={copyAll}>Copy all</button>
        <button className="btn btn-accent" onClick={onClose}>Close</button>
      </>}
    >
      <div className="adm-rep-prov">
        {provenanceLine(report.facts || { takenAt: report.counts_at }, report.source)}
        {report.instruction ? <> Asked for: “{report.instruction}”.</> : null}
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
