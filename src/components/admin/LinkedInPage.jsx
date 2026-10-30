import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listLiClients, updateLiClient, addLiClient, fileLink, listTracker, addTrackerRow, updateTrackerRow, deleteTrackerRow,
  FORM_URL, today,
} from "../../lib/linkedinData.js";
import { listTeam } from "../../lib/data.js";
import { answerSections, readinessFlags, weeklyTotals, rates, STAGES } from "../../../lib/linkedin-questions.js";
import { toast } from "../../lib/toast.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { MetricCard, SourceBadge, Modal, Field, TextInput, EmptyState, timeAgo } from "./shared.jsx";
import { useScreenContext } from "../../lib/screenContext.js";

/* LINKEDIN — the LinkedIn Outreach clients. 30 Oct 2026.
 *
 * CJ, 29 Oct 2026: LinkedIn Outreach is now one of our services; Netwrks sends
 * the clients and Julie (VA) launches the campaigns. Their sign-up was a Google
 * Form and each client's work lived in its own five-tab Google Sheet. Both now
 * live here:
 *
 *   - the form is aisyndicate.com/onboarding/linkedin/ — every answer lands in
 *     linkedin_clients the moment it is typed (drafts show here too);
 *   - the sheet's tabs are the tabs on a client: Answers (its "General Info"),
 *     Daily activity, Searches, Message copy and Responses.
 *
 * Tables + who can see them: supabase/migrations/0048_linkedin_clients.sql.
 * Question labels: lib/linkedin-questions.js (a copy of the website's list). */

const STAGE_TONE = {
  new: { c: "#3730a3", bg: "#eef2ff" },
  setting_up: { c: "#92400e", bg: "#fffbeb" },
  live: { c: "#006b1a", bg: "var(--success-soft)" },
  paused: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
  ended: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
};
const stageLabel = (s) => (STAGES.find(([id]) => id === s) || [s, s])[1];

function Pill({ tone, children }) {
  return (
    <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 99, fontSize: 10, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em", color: tone.c, background: tone.bg, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

export default function LinkedInPage({ member, query = "" }) {
  const [clients, setClients] = useState({ rows: [], sample: true, loading: true });
  const [team, setTeam] = useState([]);
  const urlId = new URLSearchParams(String(query).replace(/^\?/, "")).get("id");
  const [openId, setOpenId] = useState(urlId || null);
  const [addOpen, setAddOpen] = useState(false);

  const reload = useCallback(async () => {
    const r = await listLiClients();
    setClients({ ...r, loading: false });
  }, []);
  useEffect(() => { reload(); listTeam().then((t) => setTeam((t.rows || []).filter((p) => p.active !== false))); }, [reload]);
  useEffect(() => { if (urlId) setOpenId(urlId); }, [urlId]);

  const open = clients.rows.find((c) => c.id === openId) || null;
  useScreenContext(() => ({
    page: "LinkedIn",
    record: open ? { type: "linkedin_client", id: open.id, label: open.company || open.contact_name } : null,
  }), [open?.id]);

  const counts = useMemo(() => ({
    live: clients.rows.filter((c) => c.stage === "live").length,
    setting: clients.rows.filter((c) => c.status === "submitted" && ["new", "setting_up"].includes(c.stage)).length,
    drafts: clients.rows.filter((c) => c.status === "draft").length,
  }), [clients.rows]);

  const copyFormLink = async () => {
    const link = `${FORM_URL}?ref=netwrks`;
    const r = await copyToClipboard(link);
    toast(r.ok ? "Form link copied. Send it to the new client." : `Copy this link: ${link}`, r.ok ? "success" : "info");
  };

  if (open) {
    return <ClientDetail client={open} team={team} sample={clients.sample} member={member}
      onBack={() => { setOpenId(null); if (urlId) window.location.hash = "/dashboard/linkedin"; }}
      onChanged={(row) => setClients((s) => ({ ...s, rows: s.rows.map((c) => (c.id === row.id ? { ...c, ...row } : c)) }))} />;
  }

  const mode = clients.error ? "error" : clients.sample ? "sample" : "live";
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
        <MetricCard label="Campaigns live" value={counts.live} badge={<SourceBadge mode={mode} hint={clients.error} />} hint="stage = Live" />
        <MetricCard label="To set up" value={counts.setting} hint="form sent, not live yet" />
        <MetricCard label="Forms in progress" value={counts.drafts} hint="client is still filling it in" />
      </div>

      <div className="card" style={{ padding: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
          New client? Send them the form. Their answers show up here as they type.
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn" onClick={copyFormLink}>Copy form link</button>
          <a className="btn" href={FORM_URL} target="_blank" rel="noopener noreferrer">Open the form ↗</a>
          <button className="btn btn-accent" onClick={() => setAddOpen(true)}>+ Add client by hand</button>
        </div>
      </div>

      {clients.error && <div className="card" style={{ padding: 16, color: "#b42318", fontSize: 13 }}>Couldn't read the LinkedIn clients: {clients.error}. If it says the table doesn't exist, migration 0048 hasn't been run yet.</div>}

      {!clients.loading && clients.rows.length === 0 && !clients.error ? (
        <EmptyState icon="in" title="No LinkedIn clients yet"
          body="Copy the form link above and send it to the first client. Their answers appear here while they fill it in, and the team gets an email when they press Send."
          action={<button className="btn btn-accent" onClick={copyFormLink}>Copy form link</button>} />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="adm-table">
            <thead><tr><th>Client</th><th>Contact</th><th>Stage</th><th>Form</th><th>Check before launch</th></tr></thead>
            <tbody>
              {clients.rows.map((c) => {
                const flags = readinessFlags(c.answers);
                return (
                  <tr key={c.id} className="adm-row-click" tabIndex={0} onClick={() => setOpenId(c.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(c.id); }}>
                    <td>
                      <div style={{ fontWeight: 600, color: "var(--ink)" }}>{c.company || "(no company yet)"}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-faint)", fontFamily: "var(--mono)", letterSpacing: "0.04em" }}>{(c.ref || c.source || "").toUpperCase()}</div>
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      <div>{c.contact_name || "—"}</div>
                      <div style={{ color: "var(--ink-dim)", fontSize: 11.5 }}>{c.contact_email || ""}</div>
                    </td>
                    <td><Pill tone={STAGE_TONE[c.stage] || STAGE_TONE.new}>{stageLabel(c.stage).toUpperCase()}</Pill></td>
                    <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                      {c.status === "submitted"
                        ? <>Sent <span style={{ color: "var(--ink-dim)" }}>{timeAgo(c.submitted_at)}</span>
                          {c.source === "website" && !c.team_emailed_at && <div style={{ color: "#b42318", fontWeight: 600 }}>Team email didn't go out</div>}</>
                        : <>Filling in <span style={{ color: "var(--ink-dim)" }}>· saved {timeAgo(c.last_saved_at)}</span></>}
                    </td>
                    <td style={{ fontSize: 12, color: flags.length ? "#b42318" : "var(--ink-dim)" }}>{flags.length ? flags.join(" · ") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AddClient open={addOpen} onClose={() => setAddOpen(false)} onAdded={(row) => { setClients((s) => ({ ...s, rows: [row, ...s.rows] })); setOpenId(row.id); }} />
    </>
  );
}

function AddClient({ open, onClose, onAdded }) {
  const [f, setF] = useState({ company: "", contact_name: "", contact_email: "" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!f.company.trim()) { toast("Add the company name.", "error"); return; }
    setBusy(true);
    const r = await addLiClient({ company: f.company.trim(), contact_name: f.contact_name.trim(), contact_email: f.contact_email.trim().toLowerCase() });
    setBusy(false);
    if (!r.ok) { toast(`Couldn't add: ${r.error}`, "error"); return; }
    setF({ company: "", contact_name: "", contact_email: "" });
    onClose(); onAdded(r.row);
  };
  return (
    <Modal open={open} onClose={onClose} kicker="LinkedIn" title="Add a client by hand"
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-accent" disabled={busy} onClick={save}>{busy ? "Adding…" : "Add client"}</button></>}>
      <p style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: 12 }}>For a client who won't fill in the form. You can still send them the form link later.</p>
      <Field label="Company"><TextInput value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} autoFocus /></Field>
      <Field label="Contact name"><TextInput value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} /></Field>
      <Field label="Contact email"><TextInput type="email" value={f.contact_email} onChange={(e) => setF({ ...f, contact_email: e.target.value })} /></Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* One client                                                          */
/* ------------------------------------------------------------------ */

const TABS = [
  ["answers", "Answers"], ["daily", "Daily activity"], ["searches", "Searches"], ["sequences", "Message copy"], ["responses", "Responses"],
];

function ClientDetail({ client, team, sample, onBack, onChanged }) {
  const [tab, setTab] = useState("answers");
  const [notes, setNotes] = useState(client.notes || "");
  useEffect(() => { setNotes(client.notes || ""); }, [client.id, client.notes]);
  const flags = readinessFlags(client.answers);

  const patch = async (p, label) => {
    const r = await updateLiClient(client.id, p);
    if (!r.ok) { toast(`Couldn't save ${label}: ${r.error}`, "error"); return; }
    onChanged({ id: client.id, ...p });
    toast(`${label[0].toUpperCase()}${label.slice(1)} saved.`, "success");
  };

  return (
    <>
      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <button className="btn" onClick={onBack} aria-label="Back to all LinkedIn clients">← All clients</button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <h3 style={{ fontFamily: "var(--display)", fontSize: 20, fontWeight: 700, color: "var(--ink)", margin: 0 }}>{client.company || "(no company yet)"}</h3>
              <SourceBadge mode={sample ? "sample" : "live"} />
              {client.status === "draft" && <Pill tone={{ c: "#92400e", bg: "#fffbeb" }}>STILL FILLING IN</Pill>}
            </div>
            <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 4 }}>
              {[client.contact_name, client.contact_email, client.answers?.contact_phone].filter(Boolean).join(" · ") || "—"}
              {client.linkedin_url && <> · <a href={client.linkedin_url} target="_blank" rel="noopener noreferrer">LinkedIn profile ↗</a></>}
            </div>
          </div>
          <label style={{ display: "grid", gap: 4, fontSize: 11, fontWeight: 700, color: "var(--ink-dim)" }}>
            STAGE
            <select className="adm-input" style={{ width: 150 }} value={client.stage} onChange={(e) => patch({ stage: e.target.value }, "stage")}>
              {STAGES.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 11, fontWeight: 700, color: "var(--ink-dim)" }}>
            RUN BY
            <select className="adm-input" style={{ width: 170 }} value={client.owner_id || ""} onChange={(e) => patch({ owner_id: e.target.value || null }, "owner")}>
              <option value="">Nobody yet</option>
              {team.map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name || p.email}</option>)}
            </select>
          </label>
        </div>
        {flags.length > 0 && (
          <p style={{ margin: "12px 0 0", padding: "8px 12px", borderRadius: 8, background: "#fef3f2", color: "#b42318", fontSize: 13, fontWeight: 600 }}>
            Check before launch: {flags.join(" · ")}
          </p>
        )}
        <label style={{ display: "block", marginTop: 12, fontSize: 11, fontWeight: 700, color: "var(--ink-dim)" }}>
          NOTES
          <textarea className="adm-input" rows={2} style={{ marginTop: 4, width: "100%", resize: "vertical" }} value={notes}
            placeholder="Anything the team should know about this client"
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => { if (notes !== (client.notes || "")) patch({ notes }, "notes"); }} />
        </label>
      </div>

      <div className="adm-sh-tabs" role="tablist" aria-label="Client tabs">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === "answers" ? <Answers client={client} sample={sample} /> : <Tracker kind={tab} liId={client.id} />}
    </>
  );
}

function Answers({ client, sample }) {
  const sections = answerSections(client.answers, client.files);
  const openFile = async (f) => {
    const r = await fileLink(f.path);
    if (r.ok) window.open(r.url, "_blank", "noopener");
    else toast(sample ? "Files open on the live console only." : `Couldn't open the file: ${r.error}`, "error");
  };
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {client.status === "draft" && (
        <div className="card" style={{ padding: 14, fontSize: 13, color: "var(--ink-2)" }}>
          The client hasn't pressed Send yet. These are their answers so far (saved {timeAgo(client.last_saved_at)}).
        </div>
      )}
      {sections.map((s) => (
        <div key={s.id} className="card" style={{ padding: 18 }}>
          <div className="label" style={{ marginBottom: 10 }}>{s.title}</div>
          <dl style={{ margin: 0, display: "grid", gap: 10 }}>
            {s.rows.map((r) => (
              <div key={r.key} style={{ display: "grid", gridTemplateColumns: "minmax(0, 220px) minmax(0, 1fr)", gap: 12, borderTop: "1px solid var(--rule)", paddingTop: 10 }}>
                <dt style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-dim)" }}>{r.label}</dt>
                <dd style={{ margin: 0, fontSize: 13.5, color: "var(--ink)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {r.files
                    ? (r.files.length ? r.files.map((f) => <div key={f.path}><button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => openFile(f)}>{f.name} ↗</button></div>) : <span style={{ color: "var(--ink-faint)" }}>—</span>)
                    : (r.value || <span style={{ color: "var(--ink-faint)" }}>—</span>)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The four tracker tabs: one table component, four column lists       */
/* ------------------------------------------------------------------ */

const COLS = {
  daily: [
    ["day", "Date", "date", 140], ["connections_sent", "Connections sent", "num", 110], ["accepted", "Accepted", "num", 90],
    ["replies", "Replies", "num", 80], ["inmails", "InMails", "num", 80], ["leads", "Leads", "num", 70], ["lead_names", "Lead names", "text", 220],
  ],
  searches: [
    ["last_activity", "Last activity", "date", 140], ["status", "Status", "text", 110], ["campaign_title", "Campaign", "text", 180],
    ["search_url", "Sales Nav search", "url", 200], ["current_page", "Page", "num", 70], ["results", "Results", "num", 90],
    ["job_titles", "Job titles", "text", 180], ["geography", "Geography", "text", 140], ["industry", "Industry", "text", 140],
  ],
  sequences: [
    ["day", "Date", "date", 140], ["status", "Status", "text", 120], ["sequence_url", "Link to the sequence", "url", 260], ["notes", "Notes", "text", 300],
  ],
  responses: [
    ["day", "Date", "date", 140], ["name", "Name", "text", 150], ["inbox", "Inbox", "text", 130], ["message", "Message", "long", 300],
    ["classification", "Classification", "text", 140], ["reactivation_date", "Reactivate on", "date", 140], ["status", "Status", "text", 110],
  ],
};
const BLURB = {
  daily: "One row per day. Weekly totals and rates are worked out from these rows.",
  searches: "Each Sales Navigator search the campaign runs from.",
  sequences: "The message sequences in use, with a link to each.",
  responses: "Replies worth acting on, and when to follow up.",
};

function Tracker({ kind, liId }) {
  const [rows, setRows] = useState({ rows: [], loading: true });
  const cols = COLS[kind];
  const load = useCallback(async () => { const r = await listTracker(kind, liId); setRows({ ...r, loading: false }); }, [kind, liId]);
  useEffect(() => { setRows({ rows: [], loading: true }); load(); }, [load]);

  const add = async () => {
    const base = { li_client_id: liId };
    if (kind === "daily") {
      /* One row per day (unique in the database). Say so, instead of a failed insert. */
      if (rows.rows.some((r) => r.day === today())) { toast("Today already has a row. Edit it, or change its date first.", "info"); return; }
      Object.assign(base, { day: today(), connections_sent: 0, accepted: 0, replies: 0, inmails: 0, leads: 0 });
    }
    else if (kind === "searches") base.last_activity = today();
    else base.day = today();
    const r = await addTrackerRow(kind, base);
    if (!r.ok) { toast(r.error, "error"); return; }
    setRows((s) => ({ ...s, rows: [r.row, ...s.rows] }));
  };
  const save = async (row, key, raw, type) => {
    let v = raw;
    if (type === "num") v = raw === "" ? (kind === "daily" ? 0 : null) : Math.max(0, Math.round(Number(raw)));
    if (type === "num" && Number.isNaN(v)) { toast("Numbers only.", "error"); return; }
    if ((type === "date" || type === "text" || type === "url" || type === "long") && raw === "") v = type === "date" && key === "day" && kind === "daily" ? row.day : null;
    if (v === row[key] || (v === null && (row[key] === null || row[key] === undefined))) return;
    const r = await updateTrackerRow(kind, row.id, { [key]: v });
    if (!r.ok) { toast(`Not saved: ${/duplicate key/i.test(r.error) ? "that day already has a row" : r.error}`, "error"); load(); return; }
    setRows((s) => ({ ...s, rows: s.rows.map((x) => (x.id === row.id ? { ...x, [key]: v } : x)) }));
  };
  const remove = async (row) => {
    const r = await deleteTrackerRow(kind, row.id);
    if (!r.ok) { toast(r.error, "error"); return; }
    setRows((s) => ({ ...s, rows: s.rows.filter((x) => x.id !== row.id) }));
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {kind === "daily" && <WeeklyTotals rows={rows.rows} />}
      <div className="card" style={{ padding: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "var(--ink-2)" }}>{BLURB[kind]}</span>
        <button className="btn btn-accent" style={{ marginLeft: "auto" }} onClick={add}>+ Add row</button>
      </div>
      {rows.error && <div className="card" style={{ padding: 14, color: "#b42318", fontSize: 13 }}>Couldn't read this tab: {rows.error}</div>}
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table className="adm-table" style={{ minWidth: cols.reduce((n, c) => n + c[3], 60) }}>
          <thead><tr>{cols.map(([k, l]) => <th key={k}>{l}</th>)}<th aria-label="Delete" /></tr></thead>
          <tbody>
            {rows.rows.length === 0 && !rows.loading && (
              <tr><td colSpan={cols.length + 1} style={{ color: "var(--ink-dim)", fontSize: 13, padding: 18 }}>Nothing here yet. Press + Add row.</td></tr>
            )}
            {rows.rows.map((row) => (
              <tr key={row.id}>
                {cols.map(([k, l, type, w]) => (
                  <td key={k} style={{ minWidth: w, padding: 6 }}>
                    <Cell value={row[k]} type={type} label={l} onSave={(raw) => save(row, k, raw, type)} />
                  </td>
                ))}
                <td style={{ padding: 6 }}><DeleteButton onConfirm={() => remove(row)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({ value, type, label, onSave }) {
  const shown = value === null || value === undefined ? "" : String(value);
  const [v, setV] = useState(shown);
  useEffect(() => { setV(shown); }, [shown]);
  const common = {
    className: "adm-input", "aria-label": label, value: v,
    onChange: (e) => setV(e.target.value),
    onBlur: () => { if (v !== shown) onSave(v.trim()); },
    style: { width: "100%", fontSize: 13 },
  };
  if (type === "long") return <textarea rows={2} {...common} style={{ ...common.style, resize: "vertical" }} />;
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <input {...common} type={type === "date" ? "date" : type === "num" ? "number" : type === "url" ? "url" : "text"}
        min={type === "num" ? 0 : undefined} inputMode={type === "num" ? "numeric" : undefined}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
      {type === "url" && /^https?:\/\//i.test(shown) && <a href={shown} target="_blank" rel="noopener noreferrer" aria-label={`Open ${label}`} style={{ fontSize: 13 }}>↗</a>}
    </div>
  );
}

function DeleteButton({ onConfirm }) {
  const [sure, setSure] = useState(false);
  useEffect(() => { if (!sure) return undefined; const t = setTimeout(() => setSure(false), 4000); return () => clearTimeout(t); }, [sure]);
  return (
    <button type="button" className="btn" style={{ padding: "4px 10px", fontSize: 12, color: sure ? "#b42318" : "var(--ink-dim)" }}
      onClick={() => (sure ? onConfirm() : setSure(true))}>{sure ? "Sure?" : "Delete"}</button>
  );
}

function WeeklyTotals({ rows }) {
  const weeks = weeklyTotals(rows).slice(0, 8);
  if (!weeks.length) return null;
  const fmtWeek = (w) => { const [y, m, d] = w.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { month: "short", day: "numeric" }); };
  return (
    <div className="card" style={{ padding: 0, overflowX: "auto" }}>
      <table className="adm-table">
        <thead><tr><th>Week of</th><th>Days logged</th><th>Connections sent</th><th>Accepted</th><th>Replies</th><th>InMails</th><th>Leads</th><th>Accept rate</th><th>Reply rate</th></tr></thead>
        <tbody>
          {weeks.map((t) => {
            const r = rates(t);
            return (
              <tr key={t.week}>
                <td style={{ fontWeight: 600 }}>{fmtWeek(t.week)}</td><td>{t.days}</td><td>{t.connections_sent}</td><td>{t.accepted}</td>
                <td>{t.replies}</td><td>{t.inmails}</td><td style={{ fontWeight: 700 }}>{t.leads}</td>
                <td>{r.acceptRate === null ? "—" : `${r.acceptRate}%`}</td><td>{r.replyRate === null ? "—" : `${r.replyRate}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
