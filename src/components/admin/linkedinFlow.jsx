import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../lib/adminApi.js";
import { toast } from "../../lib/toast.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { FLOW_STAGES, stageLabel, sendSchedule } from "../../../lib/linkedin-flow.js";
import { waLink, CODE_METHODS } from "../../../lib/linkedin-v2.js";

/* LINKEDIN OUTREACH — the flow on the console (Builds 1-5 + the PIN page).
 * 4 Nov 2026. CJ's "LinkedIn Outreach — Build Brief for Ryder".
 *
 *   <OutreachOverview />   top of the LinkedIn page: Late / Due today, Julie's
 *                          queue, live PINs, emails waiting to be sent
 *   <OutreachTab client /> the "Outreach" tab on one client: stage + dates,
 *                          the Sequence (generate, review, send to client,
 *                          approve, request changes), access + PIN, replies,
 *                          reports, emails
 *
 * NOTHING ON THIS SCREEN SENDS AN EMAIL. Drafts wait in the outbox: copy the
 * text into Gmail, send it yourself, then press "Mark sent". */

const box = { padding: 16, display: "grid", gap: 10, alignContent: "start" };
const h = { fontFamily: "var(--display)", fontSize: 16, fontWeight: 700, margin: 0, color: "var(--ink)" };
const dim = { fontSize: 12, color: "var(--ink-dim)" };
const fmt = (d) => (d ? new Date(d).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

function useFlow(pollMs = 0) {
  const [state, setState] = useState({ loading: true });
  const load = useCallback(async () => {
    const r = await apiFetch("/api/linkedin-flow");
    setState(r.ok ? { loading: false, ...r.data } : { loading: false, error: r.error, preview: r.preview });
  }, []);
  useEffect(() => {
    load();
    if (!pollMs) return undefined;
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);
  return [state, load];
}

async function act(path, method, body, ok) {
  const r = await apiFetch(path, { method, body });
  if (!r.ok) { toast(r.error || "That didn't work.", "error"); return null; }
  if (ok) toast(ok, "success");
  return r.data;
}

function Outbox({ rows, reload, canMark }) {
  if (!rows.length) return <div style={dim}>No emails waiting.</div>;
  return rows.map((m) => (
    <div key={m.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, display: "grid", gap: 6 }}>
      {/* A note for whoever sends it (e.g. "no activity logged"). It sits
        * outside the email: "Copy subject" and "Copy text" never pick it up,
        * so it can't reach the client (4 Nov check — it used to ride in the
        * subject line). */}
      {m.internal_note && <div role="note" style={{ background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a", borderRadius: 8, padding: "6px 10px", fontSize: 13 }}><b>Check before sending (not in the email):</b> {m.internal_note}</div>}
      <div style={{ fontWeight: 700 }}>{m.subject}</div>
      <div style={dim}>To {m.to_email || "(no email on file)"}{m.cc?.length ? ` · cc ${m.cc.join(", ")}` : ""} · {m.kind.replace(/_/g, " ")}</div>
      <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", fontSize: 13, background: "var(--bg-2)", padding: 10, borderRadius: 8 }}>{m.body_text}</pre>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => { copyToClipboard(`${m.body_text}`); toast("Email text copied — paste it into Gmail.", "success"); }}>Copy text</button>
        <button className="btn" onClick={() => { copyToClipboard(m.subject); toast("Subject copied.", "success"); }}>Copy subject</button>
        {canMark && <button className="btn" onClick={async () => { if (await act("/api/linkedin-flow", "PATCH", { action: "outbox_done", outboxId: m.id, status: "sent" }, "Marked sent.")) reload(); }}>Mark sent</button>}
        {canMark && <button className="btn" onClick={async () => { if (await act("/api/linkedin-flow", "PATCH", { action: "outbox_done", outboxId: m.id, status: "skipped" }, "Skipped.")) reload(); }}>Skip</button>}
      </div>
    </div>
  ));
}

function Pins({ pins, reload }) {
  if (!pins?.length) return null;
  return pins.map((p) => (
    <div key={p.id} role="status" style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, borderRadius: 10, background: "var(--success-soft)", flexWrap: "wrap" }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 28, fontWeight: 800, letterSpacing: "0.2em" }}>{p.code}</span>
      <span style={dim}>sent {fmt(p.created_at)} · expires {fmt(p.expires_at)}{p.seen_at ? " · used" : ""}</span>
      <button className="btn" onClick={() => { copyToClipboard(p.code); act("/api/linkedin-flow", "PATCH", { action: "pin_seen", pinId: p.id }).then(reload); }}>Copy code</button>
    </div>
  ));
}

function Settings({ settings, reload }) {
  const [booking, setBooking] = useState(typeof settings?.booking_url === "string" ? settings.booking_url : "");
  const [conn, setConn] = useState(settings?.daily_caps?.connections ?? 20);
  const [inm, setInm] = useState(settings?.daily_caps?.inmails ?? 10);
  const [cc, setCc] = useState(Array.isArray(settings?.report_cc) ? settings.report_cc.join(", ") : "");
  const [julie, setJulie] = useState(typeof settings?.julie_email === "string" && settings.julie_email ? settings.julie_email : "porcallajulieann01@gmail.com");
  /* v2, 6 Nov 2026 (Julie's and CJ's asks). */
  const [julieWa, setJulieWa] = useState(typeof settings?.julie_whatsapp === "string" ? settings.julie_whatsapp : "");
  const [pwMethod, setPwMethod] = useState(typeof settings?.password_method === "string" ? settings.password_method : "");
  const [codeMail, setCodeMail] = useState(settings?.code_alert_email !== false);
  const [notify, setNotify] = useState(Array.isArray(settings?.signup_notify) ? settings.signup_notify.join(", ") : "cj@aisyndicate.com, ryder@aisyndicate.com");
  const save = async () => {
    const a = await act("/api/linkedin-flow", "PATCH", { action: "settings", key: "booking_url", value: booking.trim() || null });
    const b = await act("/api/linkedin-flow", "PATCH", { action: "settings", key: "daily_caps", value: { connections: Number(conn) || 0, inmails: Number(inm) || 0 } });
    const c = await act("/api/linkedin-flow", "PATCH", { action: "settings", key: "report_cc", value: cc.split(",").map((x) => x.trim()).filter(Boolean) });
    const d = await act("/api/linkedin-flow", "PATCH", { action: "settings", key: "julie_email", value: julie.trim() || null });
    const e = await act("/api/linkedin-flow", "PATCH", { action: "settings", key: "julie_whatsapp", value: julieWa.trim() || null });
    const f = await act("/api/linkedin-flow", "PATCH", { action: "settings", key: "password_method", value: pwMethod.trim() || null });
    const g = await act("/api/linkedin-flow", "PATCH", { action: "settings", key: "code_alert_email", value: !!codeMail });
    const k = await act("/api/linkedin-flow", "PATCH", { action: "settings", key: "signup_notify", value: notify.split(",").map((x) => x.trim()).filter(Boolean) });
    if (a && b && c && d && e && f && g && k) { toast("LinkedIn settings saved.", "success"); reload(); }
  };
  return (
    <details className="card" style={{ padding: 16 }}>
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>LinkedIn Outreach settings (owner)</summary>
      <div style={{ display: "grid", gap: 8, marginTop: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <label style={dim}>Julie's booking link (optional — leave blank to agree times by message)<input className="adm-input" value={booking} onChange={(e) => setBooking(e.target.value)} placeholder="https://calendar.app.google/…" /></label>
        <label style={dim}>Connection requests per account per day<input className="adm-input" type="number" min="0" value={conn} onChange={(e) => setConn(e.target.value)} /></label>
        <label style={dim}>InMails per account per day<input className="adm-input" type="number" min="0" value={inm} onChange={(e) => setInm(e.target.value)} /></label>
        <label style={dim}>Copy reports and lead alerts to<input className="adm-input" value={cc} onChange={(e) => setCc(e.target.value)} /></label>
        <label style={dim}>Julie's email (clients forward LinkedIn codes here)<input className="adm-input" type="email" value={julie} onChange={(e) => setJulie(e.target.value)} /></label>
        <label style={dim}>Julie's WhatsApp (with country code — shows a "Message Julie" button to clients)<input className="adm-input" type="tel" value={julieWa} onChange={(e) => setJulieWa(e.target.value)} placeholder="+63 …" /></label>
        <label style={dim}>New sales-page sign-ups email<input className="adm-input" value={notify} onChange={(e) => setNotify(e.target.value)} /></label>
        <label style={{ ...dim, gridColumn: "1 / -1" }}>How clients share their password (shown on their login page and in the email — never typed into our system)<textarea className="adm-input" rows={2} value={pwMethod} onChange={(e) => setPwMethod(e.target.value)} /></label>
        <label style={{ ...dim, display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={codeMail} onChange={(e) => setCodeMail(e.target.checked)} /> Email Julie each code the moment a client types it</label>
      </div>
      <button className="btn" style={{ marginTop: 10 }} onClick={save}>Save settings</button>
    </details>
  );
}

export function OutreachOverview({ member }) {
  const [s, reload] = useFlow(30000);
  const isAdmin = ["owner", "admin"].includes(member?.role || member?.membership?.role);
  if (s.loading) return null;
  if (s.error) return s.preview ? null : <div className="card" style={{ padding: 16, fontSize: 13, color: "#b42318" }}>LinkedIn flow: {s.error}. If a table is missing, migrations 0051 and 0052 haven't been run yet.</div>;
  const pins = (s.engagements || []).flatMap((e) => (e.pins || []).map((p) => ({ ...p, company: e.company })));
  const caps = s.settings?.daily_caps;
  return (
    <>
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
      <div className="card" style={box}>
        <h3 style={h}>Late / due today</h3>
        {(s.late || []).length ? s.late.map((x, i) => (
          <div key={i} style={{ fontSize: 13 }}><b style={{ color: x.level === "late" ? "#b42318" : "#92400e" }}>{x.level === "late" ? "LATE" : "TODAY"}</b> · {x.company}: {x.what}</div>
        )) : <div style={dim}>Nothing late or due today.</div>}
      </div>
      <div className="card" style={box}>
        <h3 style={h}>Julie's queue</h3>
        {caps && <div style={dim}>Daily limit per account: {caps.connections} connection requests, {caps.inmails} InMails.</div>}
        {(s.queue || []).length ? s.queue.map((x, i) => <div key={i} style={{ fontSize: 13 }}>{x.company}: {x.what}</div>) : <div style={dim}>Queue is clear.</div>}
        {pins.length > 0 && <><h3 style={{ ...h, fontSize: 14 }}>Login codes (live)</h3><Pins pins={pins} reload={reload} /></>}
      </div>
      <div className="card" style={box}>
        <h3 style={h}>Emails waiting ({(s.outbox || []).length})</h3>
        <div style={dim}>Drafts only — copy into Gmail, send, then mark sent.</div>
        <Outbox rows={(s.outbox || []).slice(0, 3)} reload={reload} canMark={isAdmin} />
      </div>
    </div>
    <Signups rows={s.signups || []} engagements={s.engagements || []} reload={reload} isAdmin={isAdmin} />
    {member?.role === "owner" && <Settings settings={s.settings} reload={reload} />}
    </>
  );
}

/* v2, 6 Nov 2026: people who signed up on the LinkedIn Outreach page
 * (/linkedin-outreach/). CJ, text 5 Nov: "I'll reach out and get them
 * started" — so the card hands him the onboarding form link per person. A
 * paid sign-up folds into its form row by itself once the form is sent
 * (same email, or the form link's ref); "Link to a client" does it by hand. */
function Signups({ rows, engagements, reload, isAdmin }) {
  const [pick, setPick] = useState({});
  if (!rows.length) return null;
  const unpaidForms = engagements.filter((e) => !e.paid_at);
  return (
    <div className="card" style={box}>
      <h3 style={h}>Sales-page sign-ups ({rows.filter((r) => r.status === "signup").length})</h3>
      <div style={dim}>From the LinkedIn Outreach page. Paid ones get a welcome draft (with the form link) in Emails waiting.</div>
      {rows.map((r) => (
        <div key={r.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 8, display: "grid", gap: 4 }}>
          <div style={{ fontSize: 13 }}>
            <b>{r.company}</b> · {r.contact_name} · {r.contact_email}{r.phone ? ` · ${r.phone}` : ""}
            {" · "}{r.status === "merged" ? <b style={{ color: "var(--ink-dim)" }}>linked to their form</b> : r.paid_at ? <b style={{ color: "#0f7a3a" }}>PAID {fmt(r.paid_at)}</b> : <span style={{ color: "#92400e" }}>went to checkout {fmt(r.checkout_started_at)}, not paid yet</span>}
          </div>
          {r.goal && <div style={dim}>Goal: {r.goal}</div>}
          {r.status === "signup" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn" onClick={() => { copyToClipboard(r.formUrl); toast("Onboarding form link copied.", "success"); }}>Copy their onboarding form link</button>
              {isAdmin && r.paid_at && unpaidForms.length > 0 && (
                <>
                  <select className="adm-input" style={{ width: 220 }} value={pick[r.id] || ""} onChange={(ev) => setPick({ ...pick, [r.id]: ev.target.value })}>
                    <option value="">Link the payment to…</option>
                    {unpaidForms.map((e) => <option key={e.id} value={e.id}>{e.company} ({e.contact_email})</option>)}
                  </select>
                  <button className="btn" disabled={!pick[r.id]} onClick={async () => { if (await act("/api/linkedin-flow", "PATCH", { action: "link_signup", id: pick[r.id], signupId: r.id }, "Payment linked — that client now shows paid.")) reload(); }}>Link</button>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Issue({ list }) {
  return list.map((i, k) => <div key={k} style={{ fontSize: 12, color: i.level === "block" ? "#b42318" : "#92400e" }}>{i.level === "block" ? "Problem" : "Check"}: {i.message}</div>);
}

function VersionView({ v }) {
  const c = v?.content;
  if (!c || !Array.isArray(c.variants)) return <div style={dim}>No usable copy in this version.</div>;
  const issues = v.issues || [];
  const at = (where) => issues.filter((i) => i.where === where);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        {c.variants.filter(Boolean).map((vr) => (
          <div key={vr.name} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, outline: v.chosen_variant === vr.name ? "2px solid var(--accent, #5b3df5)" : "none" }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>{vr.name}{v.chosen_variant === vr.name ? " · chosen" : ""}</div>
            {[["Connection note", vr.connection_note, `${vr.name} · Connection note`], ...(vr.steps || []).map((s) => [`Message ${s.step} · +${s.delay_days} d`, s.body, `${vr.name} · Message ${s.step}`]), ["InMail", `${vr.inmail?.subject || ""}\n${vr.inmail?.body || ""}`, `${vr.name} · InMail`]].map(([label, text, where]) => (
              <div key={label} style={{ borderTop: "1px solid var(--line)", padding: "8px 0" }}>
                <div style={dim}>{label}</div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{text}</div>
                <Issue list={at(where)} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <b>Target lists</b>
        {(c.target_lists || []).map((l, i) => <div key={i} style={{ fontSize: 13 }}><b>{i + 1}. {l.title}</b> — {(l.geography || []).join(", ")} · {(l.industries || []).join(", ")} · {(l.job_titles || []).length} titles</div>)}
        <Issue list={issues.filter((i) => String(i.where || "").startsWith("Target list"))} />
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <b>Reply templates</b>
        {Object.entries(c.reply_templates || {}).map(([k, t]) => <div key={k} style={{ fontSize: 13 }}><b>{k.replace("_", " ")}:</b> {t}</div>)}
      </div>
      {c.notes_for_reviewer && <div style={{ fontSize: 13, background: "#fffbeb", color: "#92400e", padding: 10, borderRadius: 8, whiteSpace: "pre-wrap" }}><b>Notes for the reviewer:</b>{"\n"}{c.notes_for_reviewer}</div>}
    </div>
  );
}

export function OutreachTab({ client, member }) {
  const isAdmin = ["owner", "admin"].includes(member?.role || member?.membership?.role);
  const [flow, reloadFlow] = useFlow(15000);
  const [replies, setReplies] = useState([]);
  const loadReplies = useCallback(async () => {
    const r = await apiFetch(`/api/linkedin-replies?liClientId=${client.id}`);
    if (r.ok) setReplies(r.data.replies || []);
  }, [client.id]);
  useEffect(() => { loadReplies(); }, [loadReplies]);
  const [versions, setVersions] = useState({ loading: true, rows: [] });
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [reply, setReply] = useState({ name: "", prospectUrl: "", inbox: "Sales Nav", message: "" });
  const [booking, setBooking] = useState("");
  const loadVersions = useCallback(async () => {
    const r = await apiFetch(`/api/linkedin-messages?liClientId=${client.id}`);
    setVersions(r.ok ? { loading: false, rows: r.data.versions } : { loading: false, rows: [], error: r.error });
  }, [client.id]);
  useEffect(() => { loadVersions(); }, [loadVersions]);
  const e = (flow.engagements || []).find((x) => x.id === client.id) || {};
  /* The client approves or asks for changes on their own page, not here. The
   * flow polls every 15 s, so when the stage moves, reload the copy too —
   * the 4 Nov test showed "client review" on screen after the client had
   * already approved. */
  useEffect(() => { if (e.flow_stage) loadVersions(); }, [e.flow_stage, loadVersions]);
  const v = versions.rows[0];
  const refresh = () => { loadVersions(); reloadFlow(); loadReplies(); };
  const run = async (label, fn) => { setBusy(label); try { await fn(); } finally { setBusy(""); refresh(); } };
  const blocking = (v?.issues || []).filter((i) => i.level === "block").length;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card" style={box}>
        <h3 style={h}>Stage</h3>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {FLOW_STAGES.filter(([id]) => !["paused", "churned"].includes(id) || id === e.flow_stage).map(([id, label]) => (
            <span key={id} style={{ fontSize: 11, fontWeight: 800, padding: "3px 9px", borderRadius: 99, background: id === e.flow_stage ? "var(--accent, #5b3df5)" : "var(--bg-3)", color: id === e.flow_stage ? "#fff" : "var(--ink-dim)" }}>{label}</span>
          ))}
        </div>
        <div style={{ ...dim, display: "flex", gap: 14, flexWrap: "wrap" }}>
          <span>Paid: {fmt(e.paid_at)}{e.paid_source ? ` (${e.paid_source.replace("_", " ")})` : ""}</span>
          <span>Copy due: {fmt(e.build_due_at)}</span>
          <span>Login slot: {fmt(e.booking_at)}</span>
          <span>Launch: {e.launch_date || "—"}</span>
          <span>Mid-month: {e.midmonth_due || "—"}</span>
          <span>Day-30 report: {e.report_due || "—"}</span>
          <span>Renews: {e.renewal_date || "—"}</span>
        </div>
        {isAdmin && (
          <label style={{ ...dim, display: "flex", gap: 8, alignItems: "center" }}>Move to
            <select className="adm-input" style={{ width: 190 }} value={e.flow_stage || ""} onChange={(ev) => run("stage", () => act("/api/linkedin-flow", "PATCH", { id: client.id, action: "move_stage", to: ev.target.value }, `Moved to ${stageLabel(ev.target.value)}.`))}>
              {FLOW_STAGES.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
            </select>
          </label>
        )}
        {e.messages_last_error && <div style={{ fontSize: 13, color: "#b42318" }}>Last automatic run failed ({e.messages_attempts} attempt{e.messages_attempts === 1 ? "" : "s"}): {e.messages_last_error}</div>}
      </div>

      <div className="card" style={box}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <h3 style={h}>Messages, lists and reply templates</h3>
          {v && <span style={dim}>Version {v.version} · {v.status.replace("_", " ")} · {v.source}{blocking ? ` · ${blocking} problem(s)` : ""}{v.datedStopped ? " · dated messages past their date" : ""}</span>}
        </div>
        {versions.error && <div style={{ fontSize: 13, color: "#b42318" }}>{versions.error}</div>}
        {!e.paid_at && <div style={dim}>Copy is written after the first month is paid (Stripe), or after an owner marks the client paid.</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {isAdmin && member?.role === "owner" && !e.paid_at && <button className="btn" disabled={!!busy} onClick={() => run("paid", () => act("/api/linkedin-messages", "PATCH", { liClientId: client.id, action: "mark_paid" }, "Marked paid."))}>Mark paid (paid another way)</button>}
          {isAdmin && e.paid_at && <button className="btn" disabled={!!busy} onClick={() => run("gen", () => act("/api/linkedin-messages", "POST", { liClientId: client.id }, "New version written."))}>{busy === "gen" ? "Writing… (up to 2 min)" : v ? "Write a fresh version" : "Write the copy now"}</button>}
          {v?.status === "draft" && <button className="btn" disabled={!!busy || blocking > 0} onClick={() => run("send", async () => { const d = await act("/api/linkedin-messages", "PATCH", { id: v.id, action: "to_client" }, "Ready for the client — the email is in the outbox."); if (d?.link) copyToClipboard(d.link); })}>Reviewed — send to client</button>}
          {isAdmin && ["draft", "client_review"].includes(v?.status) && v.content?.variants?.map((x) => <button key={x.name} className="btn" disabled={!!busy} onClick={() => run("var", () => act("/api/linkedin-messages", "PATCH", { id: v.id, action: "choose_variant", variant: x.name }, `${x.name} chosen.`))}>Client picked {x.name}</button>)}
          {isAdmin && v?.status === "client_review" && <button className="btn" disabled={!!busy || !v.chosen_variant} onClick={() => run("appr", () => act("/api/linkedin-messages", "PATCH", { id: v.id, action: "approve" }, "Approved — the booking email is in the outbox."))}>Client approved (by email)</button>}
          {isAdmin && v?.status === "client_review" && <button className="btn" disabled={!!busy} onClick={() => run("link", async () => { const d = await act("/api/linkedin-flow", "PATCH", { id: client.id, action: "approval_link" }, "New approval link copied."); if (d?.url) copyToClipboard(d.url); })}>Copy a new approval link</button>}
          {isAdmin && v?.status === "approved" && <button className="btn" disabled={!!busy} onClick={() => run("lists", () => act("/api/linkedin-flow", "PATCH", { id: client.id, action: "save_lists", versionId: v.id }, "Lists added to the Searches tab."))}>Add the 3 lists to Searches</button>}
        </div>
        {v?.feedback && v.status === "client_review" && (
          <div style={{ fontSize: 13, background: "#eef2ff", color: "#3730a3", padding: 10, borderRadius: 8, display: "grid", gap: 8 }}>
            <div><b>The client asked for changes:</b> {v.feedback}</div>
            <div style={dim}>The morning run writes the revision; or write it now.</div>
            {isAdmin && <button className="btn" style={{ justifySelf: "start" }} disabled={!!busy} onClick={() => run("rev", () => act("/api/linkedin-messages", "POST", { liClientId: client.id, reviseFrom: v.id, feedback: v.feedback }, "Revised version written."))}>{busy === "rev" ? "Revising… (up to 2 min)" : "Write the revision now"}</button>}
          </div>
        )}
        {v?.status === "approved" && (
          <div style={dim}>Sending rhythm ({v.chosen_variant}): {sendSchedule(v.content, v.chosen_variant).map((x) => `Message ${x.step} on day ${x.dayAfterAccept} after they accept`).join(" · ")}</div>
        )}
        {isAdmin && v && ["client_review", "draft"].includes(v.status) && !v.feedback && (
          <div style={{ display: "grid", gap: 6 }}>
            <textarea className="adm-input" rows={2} placeholder="Client's requested changes (pasted from their email) — writes a revised version" value={feedback} onChange={(ev) => setFeedback(ev.target.value)} />
            <button className="btn" style={{ justifySelf: "start" }} disabled={!!busy || feedback.trim().length < 3} onClick={() => run("rev", async () => { if (await act("/api/linkedin-messages", "POST", { liClientId: client.id, reviseFrom: v.id, feedback }, "Revised version written.")) setFeedback(""); })}>{busy === "rev" ? "Revising… (up to 2 min)" : "Write a revised version"}</button>
          </div>
        )}
        {versions.loading ? <div style={dim}>Loading…</div> : v ? <VersionView v={v} /> : <div style={dim}>No copy yet.</div>}
      </div>

      <div className="card" style={box}>
        <h3 style={h}>Login access</h3>
        <div style={dim}>After approving, the client fills in their login page: LinkedIn email, the city they log in from (for the VPN), good times and how they'll pass the code. Codes typed there show here within 30 seconds and are emailed to Julie. The password goes straight to Julie through the sharing tool — it's never typed into or stored in the console.</div>
        <LoginDetails e={e} client={client} reload={reloadFlow} />
        <Pins pins={e.pins} reload={reloadFlow} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {isAdmin && <button className="btn" onClick={async () => { const d = await act("/api/linkedin-flow", "PATCH", { id: client.id, action: "pin_link" }, "Login page link copied — send it to the client. (The old link stops working.)"); if (d?.url) copyToClipboard(d.url); }}>Copy a new login page link</button>}
          <label style={{ ...dim, display: "grid", gap: 2 }}>Login slot (your computer's time)
            <input className="adm-input" type="datetime-local" style={{ width: 220 }} value={booking} onChange={(ev) => setBooking(ev.target.value)} />
          </label>
          <button className="btn" disabled={!booking} onClick={() => run("book", () => act("/api/linkedin-flow", "PATCH", { id: client.id, action: "booked", at: new Date(booking).toISOString() }, "Login slot saved."))}>Save login slot</button>
          <button className="btn" disabled={!!busy || ["live", "report_due", "renewed"].includes(e.flow_stage)} onClick={() => run("live", () => act("/api/linkedin-flow", "PATCH", { id: client.id, action: "live" }, "Live — launch date set, report dates set, 'you're live' email drafted."))}>Julie is logged in → Live</button>
        </div>
        {isAdmin && (
          <label style={{ ...dim, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>Launch date (sets the report dates)
            <input key={e.launch_date || "none"} className="adm-input" type="date" style={{ width: 170 }} defaultValue={e.launch_date || ""} onBlur={(ev) => { if (ev.target.value && ev.target.value !== e.launch_date) run("launch", () => act("/api/linkedin-flow", "PATCH", { id: client.id, action: "set_launch", date: ev.target.value }, "Launch date saved — report dates follow.")); }} />
          </label>
        )}
      </div>

      <Prospects clientId={client.id} live={["live", "report_due", "renewed", "access_scheduled", "approved"].includes(e.flow_stage)} onChange={reloadFlow} />

      <div className="card" style={box}>
        <h3 style={h}>Log a reply (Claude sorts it)</h3>
        <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <input className="adm-input" placeholder="Prospect name" value={reply.name} onChange={(ev) => setReply({ ...reply, name: ev.target.value })} />
          <input className="adm-input" placeholder="Their LinkedIn URL (optional)" value={reply.prospectUrl} onChange={(ev) => setReply({ ...reply, prospectUrl: ev.target.value })} />
          <select className="adm-input" value={reply.inbox} onChange={(ev) => setReply({ ...reply, inbox: ev.target.value })}><option>Sales Nav</option><option>Main</option></select>
        </div>
        <textarea className="adm-input" rows={3} placeholder="Paste their reply" value={reply.message} onChange={(ev) => setReply({ ...reply, message: ev.target.value })} />
        <button className="btn" style={{ justifySelf: "start" }} disabled={!!busy || !reply.message.trim()} onClick={() => run("reply", async () => {
          const d = await act("/api/linkedin-replies", "POST", { liClientId: client.id, ...reply });
          if (d?.reply) { toast(d.duplicate ? "Already logged — that reply is below." : `${d.reply.classification} (${Math.round((d.reply.confidence || 0) * 100)}%)${d.reply.needs_review ? " — check it in Replies below" : d.outboxId ? " — lead alert drafted" : ""}`, "success"); setReply({ name: "", prospectUrl: "", inbox: reply.inbox, message: "" }); }
        })}>{busy === "reply" ? "Sorting…" : "Sort this reply"}</button>
      </div>

      <div className="card" style={box}>
        <h3 style={h}>Replies</h3>
        {!replies.length && <div style={dim}>No replies logged yet.</div>}
        {replies.slice(0, 15).map((r) => (
          <div key={r.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 8, display: "grid", gap: 4 }}>
            <div style={{ fontSize: 13 }}><b>{r.name || "(no name)"}</b> · {r.day} · {r.inbox}{r.needs_review ? <b style={{ color: "#b42318" }}> · needs your check</b> : ""}{r.client_notified_at ? " · alert drafted" : ""}</div>
            <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>"{r.message}"</div>
            {r.summary && <div style={dim}>{r.summary}{r.confidence != null ? ` (${Math.round(r.confidence * 100)}% sure)` : ""}</div>}
            <label style={{ ...dim, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>Classification
              <select className="adm-input" style={{ width: 170 }} value={r.classification || ""} onChange={(ev) => run("ovr", () => act("/api/linkedin-replies", "PATCH", { id: r.id, classification: ev.target.value }, "Updated."))}>
                {!r.classification && <option value="">—</option>}
                {["Interested", "Question", "Not now", "Not interested", "Referral", "Out of office", "Wrong person"].map((c) => <option key={c}>{c}</option>)}
              </select>
              {r.needs_review && r.classification && <button className="btn" onClick={() => run("ovr", () => act("/api/linkedin-replies", "PATCH", { id: r.id, classification: r.classification }, "Confirmed."))}>Looks right</button>}
            </label>
          </div>
        ))}
      </div>

      {isAdmin && (
        <div className="card" style={box}>
          <h3 style={h}>Reports</h3>
          <div style={dim}>Mid-month (launch + 14 d) and day-30 (launch + 29 d) reports are written each morning from the daily log and the sorted replies, and land in the outbox with CJ cc'd.</div>
          <button className="btn" style={{ justifySelf: "start" }} disabled={!!busy || !e.launch_date} onClick={() => run("rep", async () => { const d = await act("/api/linkedin-reports", "POST", { liClientId: client.id }); if (d) toast(d.written ? `${d.written} report(s) written — see the outbox.` : "No report is due yet.", "success"); })}>Write any due report now</button>
        </div>
      )}

      <div className="card" style={box}>
        <h3 style={h}>Emails for this client</h3>
        <Outbox rows={(flow.outbox || []).filter((m) => m.li_client_id === client.id)} reload={reloadFlow} canMark={isAdmin} />
      </div>
    </div>
  );
}

/* v2, 6 Nov 2026: what the client filled in on their login page, for Julie.
 * Julie's email, 5 Nov: "I need his password and email for LinkedIn. Also
 * the location so I can set my vpn". The password is NOT here: only whether
 * Julie has it (she presses the button). */
function LoginDetails({ e, client, reload }) {
  if (!["approved", "access_scheduled", "live", "report_due", "renewed"].includes(e.flow_stage)) return null;
  const copy = (v, what) => { copyToClipboard(v); toast(`${what} copied.`, "success"); };
  if (!e.login_details_at) return <div style={{ fontSize: 13, color: "#92400e" }}>Waiting on the client's login details. Send them the login page link (below) if they haven't got it.</div>;
  const method = (CODE_METHODS.find(([k]) => k === e.code_method) || ["", "—"])[1];
  const wa = waLink(e.whatsapp, `Hi ${String(client.contact_name || "").split(" ")[0] || "there"}, it's Julie from AI Syndicate. I'm about to log in to your LinkedIn — please send me the code LinkedIn gives you.`);
  return (
    <div style={{ display: "grid", gap: 8, background: "var(--bg-2)", borderRadius: 10, padding: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px", fontSize: 13 }}>
        <span style={dim}>LinkedIn email</span><span><b>{e.login_email}</b> <button className="btn" style={{ padding: "2px 8px", minHeight: 0 }} onClick={() => copy(e.login_email, "Email")}>Copy</button></span>
        <span style={dim}>VPN location</span><span><b>{e.login_location}</b></span>
        <span style={dim}>Good times</span><span>{e.login_times}</span>
        <span style={dim}>Code by</span><span>{method}{e.whatsapp ? ` · ${e.whatsapp}` : ""}</span>
        <span style={dim}>Password</span><span>{e.password_received_at ? <b style={{ color: "#0f7a3a" }}>Julie has it ({fmt(e.password_received_at)})</b> : <b style={{ color: "#92400e" }}>not received yet</b>}</span>
        <span style={dim}>Sent in</span><span>{fmt(e.login_details_at)}</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {wa && <a className="btn" href={wa} target="_blank" rel="noopener noreferrer">WhatsApp the client</a>}
        {!e.password_received_at
          ? <button className="btn" onClick={async () => { if (await act("/api/linkedin-flow", "PATCH", { id: client.id, action: "password_received" }, "Noted — Julie has the password (it isn't stored here).")) reload(); }}>Password received</button>
          : <button className="btn" onClick={async () => { if (await act("/api/linkedin-flow", "PATCH", { id: client.id, action: "password_received", undo: true }, "Cleared.")) reload(); }}>Undo "password received"</button>}
      </div>
    </div>
  );
}

/* v2, 6 Nov 2026: one row per person who accepted, so Julie sees who is due
 * which message today (the brief's Build 5 queue). She still sends by hand. */
function Prospects({ clientId, live, onChange }) {
  const [st, setSt] = useState({ loading: true, prospects: [] });
  const [lines, setLines] = useState("");
  const [accepted, setAccepted] = useState("");
  const [show, setShow] = useState("due");
  const load = useCallback(async () => {
    const r = await apiFetch(`/api/linkedin-prospects?liClientId=${clientId}`);
    setSt(r.ok ? { loading: false, ...r.data } : { loading: false, prospects: [], error: r.error });
  }, [clientId]);
  useEffect(() => { load(); }, [load]);
  if (!live && !st.prospects.length) return null;
  const today = st.today;
  const rows = st.prospects.filter((p) => show === "all" ? true : show === "due" ? p.next && p.next.due <= today : p.status === "active");
  const due = st.prospects.filter((p) => p.next && p.next.due <= today).length;
  const doAct = async (id, action, ok) => { if (await act("/api/linkedin-prospects", "PATCH", { id, action }, ok)) { load(); onChange?.(); } };
  return (
    <div className="card" style={box}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <h3 style={h}>Prospects and follow-ups</h3>
        <span style={dim}>{st.prospects.length} people · {due} due today{st.variant ? ` · timing from ${st.variant}` : ""}</span>
        <select className="adm-input" style={{ width: 150, marginLeft: "auto" }} value={show} onChange={(ev) => setShow(ev.target.value)}>
          <option value="due">Due today</option><option value="active">Still in the run</option><option value="all">Everyone</option>
        </select>
      </div>
      {st.error && <div style={{ fontSize: 13, color: "#b42318" }}>{st.error}{/relation|does not exist/i.test(st.error) ? " — migration 0053 hasn't been run yet." : ""}</div>}
      {!st.loading && !st.hasSequence && <div style={dim}>The follow-up timing comes from the approved messages. Once a version is approved, due dates show here.</div>}
      {rows.length === 0 && !st.loading && <div style={dim}>{show === "due" ? "Nobody is due today." : "No prospects yet. Paste the people who accepted below."}</div>}
      {rows.slice(0, 60).map((p) => (
        <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--line)", paddingTop: 6, fontSize: 13 }}>
          <span style={{ minWidth: 160 }}><b>{p.profile_url ? <a href={p.profile_url} target="_blank" rel="noopener noreferrer">{p.name}</a> : p.name}</b></span>
          <span style={dim}>accepted {p.accepted_on} · sent {p.last_step}/4{p.status !== "active" ? ` · ${p.status}` : ""}</span>
          {p.next && <span style={{ fontWeight: 700, color: p.next.due < today ? "#b42318" : p.next.due === today ? "#92400e" : "var(--ink-dim)" }}>Message {p.next.step} {p.next.due <= today ? (p.next.due < today ? `overdue (${p.next.due})` : "due today") : `on ${p.next.due}`}</span>}
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {p.status === "active" && p.last_step < 4 && <button className="btn" onClick={() => doAct(p.id, "sent", `Message ${p.last_step + 1} marked sent.`)}>Sent message {p.last_step + 1}</button>}
            {p.status === "active" && <button className="btn" onClick={() => doAct(p.id, "replied", "Marked replied — log the reply below so it's sorted.")}>Replied</button>}
            <button className="btn" title="Undo the last change" onClick={() => doAct(p.id, "undo", "Undone.")}>Undo</button>
          </span>
        </div>
      ))}
      <details>
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 700 }}>Add people who accepted</summary>
        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
          <textarea className="adm-input" rows={4} placeholder={"One person per line. A profile link is optional:\nJane Smith, https://www.linkedin.com/in/janesmith\nTom Lee"} value={lines} onChange={(ev) => setLines(ev.target.value)} />
          <label style={{ ...dim, display: "flex", gap: 8, alignItems: "center" }}>Accepted on (blank = today)<input className="adm-input" type="date" style={{ width: 170 }} value={accepted} onChange={(ev) => setAccepted(ev.target.value)} /></label>
          <button className="btn" style={{ justifySelf: "start" }} disabled={!lines.trim()} onClick={async () => {
            const d = await act("/api/linkedin-prospects", "POST", { liClientId: clientId, lines, acceptedOn: accepted || undefined });
            if (d) { toast(`${d.added} added${d.skipped ? `, ${d.skipped} already there` : ""}.`, "success"); setLines(""); load(); onChange?.(); }
          }}>Add</button>
        </div>
      </details>
    </div>
  );
}
