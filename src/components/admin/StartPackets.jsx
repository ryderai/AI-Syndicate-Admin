import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/adminApi.js";
import { getSupabase } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { SectionHeader, EmptyState, Field, TextInput, TextArea, timeAgo } from "./shared.jsx";
import { questionsFor, partsFor, FORM_KINDS, stageLabel, standardFormLink } from "../../../lib/start-questions.js";

/* START PACKETS — one link that carries the whole start of a client. 6 Nov 2026.
 *
 * Andrew (call, 6 Nov): Julia uploads the contract, the Stripe link and the
 * onboarding form, and the client gets "one email with one conversation".
 * Ryder (6 Nov): one of us fills it in and sends it (7 Nov: the sender signs
 * for AI Syndicate — it was CJ only on 6 Nov), the client
 * fills it in and sends it back, and every team member gets a copy.
 *
 * Flow on this page:  Fill in → sign → Make the link + send → (client) →
 * Signed + sent back. The server rules: api/start-packets.js and
 * lib/start-packet.js. The client's page: public/start/index.html. */

const EMPTY = {
  business: "", contact_name: "", contact_email: "", website: "", form_kind: "geo",
  proposal: { package: "", price: "", term: "", start_date: "", includes: "", notes: "", doc_url: "", onboarding_url: "" },
  contract_title: "Agreement", contract_text: "", payment_url: "", payment_note: "", stripe_customer_id: "",
};

const TONE = {
  draft: { c: "#92400e", bg: "#fffbeb" }, ready: { c: "#3730a3", bg: "#eef2ff" }, sent: { c: "#1d4ed8", bg: "#eff6ff" },
  opened: { c: "#6d28d9", bg: "#f5f3ff" }, returned: { c: "#006b1a", bg: "var(--success-soft, #e8f7ee)" }, void: { c: "#475569", bg: "#eef2f6" },
};
function Pill({ status }) {
  const t = TONE[status] || TONE.draft;
  return <span style={{ display: "inline-flex", padding: "3px 10px", borderRadius: 99, fontSize: 12, fontWeight: 700, color: t.c, background: t.bg, whiteSpace: "nowrap" }}>{stageLabel({ status })}</span>;
}
const fmt = (d) => (d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

function SigPad({ onChange }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return undefined;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const r = cv.getBoundingClientRect();
    cv.width = Math.round(r.width * ratio); cv.height = Math.round(r.height * ratio);
    const ctx = cv.getContext("2d"); ctx.scale(ratio, ratio);
    Object.assign(ctx, { lineWidth: 2.4, lineCap: "round", lineJoin: "round", strokeStyle: "#13205a" });
    let drawing = false; let last = null; let inked = 0;
    const pt = (e) => { const b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
    cv.onpointerdown = (e) => { e.preventDefault(); drawing = true; last = pt(e); try { cv.setPointerCapture(e.pointerId); } catch { /* old browser */ } };
    cv.onpointermove = (e) => { if (!drawing) return; const p = pt(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); inked += Math.abs(p.x - last.x) + Math.abs(p.y - last.y); last = p; };
    cv.onpointerup = () => { if (!drawing) return; drawing = false; if (inked > 20) onChange(cv.toDataURL("image/png")); };
    return () => { cv.onpointerdown = cv.onpointermove = cv.onpointerup = null; };
  }, [onChange]);
  return <canvas ref={ref} aria-label="Draw your signature" style={{ width: "100%", height: 130, border: "1px dashed var(--ink-faint)", borderRadius: 12, background: "#fff", touchAction: "none", display: "block" }} />;
}

/* Drop a PDF here, or click to choose one (Ryder, 9 Nov 2026: "allow a PDF
 * to be dropped into"). Shows the file once it's attached. */
function DropZone({ what, fileName, fileUrl, busy, disabled, onFile, onRemove }) {
  const [over, setOver] = useState(false);
  if (fileName) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid var(--rule)", borderRadius: 12, padding: "12px 14px", background: "#fafbfc" }}>
        <span aria-hidden="true" style={{ fontSize: 18 }}>📄</span>
        {fileUrl ? <a href={fileUrl} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 600 }}>{fileName}</a> : <span style={{ fontWeight: 600 }}>{fileName}</span>}
        {!disabled && onRemove && <button type="button" className="btn btn-sm" disabled={busy} onClick={onRemove}>Remove</button>}
      </div>
    );
  }
  return (
    <label
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) onFile(e.dataTransfer?.files?.[0]); }}
      style={{ display: "block", border: `2px dashed ${over ? "var(--accent)" : "var(--ink-faint, #9eb1c7)"}`, borderRadius: 12, padding: "18px 14px", textAlign: "center", cursor: disabled ? "not-allowed" : "pointer", background: over ? "var(--accent-soft)" : "#fafbfc", transition: "background .15s" }}>
      <div style={{ fontWeight: 700, fontSize: 14.5 }}>{busy ? "Uploading…" : `Drop the ${what} PDF here`}</div>
      <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 2 }}>or click to choose a file · PDF, up to 10 MB</div>
      <input type="file" accept="application/pdf" hidden disabled={disabled || busy} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
    </label>
  );
}

function SigShow({ sig, name }) {
  if (sig?.kind === "drawn" && /^data:image\/png/.test(sig.data || "")) return <img src={sig.data} alt={`Signature of ${name}`} style={{ maxHeight: 60, maxWidth: 240 }} />;
  return <span style={{ font: "italic 600 26px/1.1 'Snell Roundhand','Segoe Script','Brush Script MT',cursive", color: "#1b2a6b" }}>{sig?.data || name}</span>;
}

export default function StartPackets({ member, query = "" }) {
  const urlId = new URLSearchParams(String(query).replace(/^\?/, "")).get("id");
  const [list, setList] = useState(null);
  const [openId, setOpenId] = useState(urlId || null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const r = await apiFetch("/api/start-packets");
    if (!r.ok) { toast.error("Couldn't load start packets", r.error); setList([]); return; }
    setList(r.data.packets || []);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (urlId) setOpenId(urlId); }, [urlId]);

  const open = (id) => { setCreating(false); setOpenId(id); window.history.replaceState(null, "", `#/dashboard/start${id ? `?id=${id}` : ""}`); };

  if (creating || openId) {
    return <PacketEditor key={openId || "new"} id={openId} member={member}
      onBack={() => { open(null); load(); }} onCreated={(id) => { setCreating(false); open(id); load(); }} />;
  }

  return (
    <div style={{ maxWidth: 1100 }}>
      <SectionHeader kicker="DELIVERY" title="Start packets"
        subtitle="One link for a new client: the proposal, the agreement, the onboarding questions and the Stripe link. You sign and send, they sign and send it back, and the whole team gets a copy."
        right={<button className="btn btn-accent" onClick={() => setCreating(true)}>New start packet</button>} />
      <ol style={{ display: "flex", flexWrap: "wrap", gap: 8, listStyle: "none", padding: 0, margin: "8px 0 18px" }}>
        {["Fill it in", "Sign it", "Send the link", "Client signs + answers + pays", "Team gets a copy"].map((s, i) => (
          <li key={s} style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-1, #fafbfc)", border: "1px solid var(--rule)", borderRadius: 99, padding: "6px 12px 6px 6px", fontSize: 13, fontWeight: 600 }}>
            <span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent-deep)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>{i + 1}</span>{s}
          </li>
        ))}
      </ol>
      {list === null ? <div className="card" style={{ padding: 24 }}>Loading…</div>
        : !list.length ? <EmptyState icon="✍" title="No start packets yet" body="Make one for the next client who says yes. It replaces the separate agreement email, Stripe email and onboarding form." action={<button className="btn btn-accent" onClick={() => setCreating(true)}>New start packet</button>} />
          : (
            <div className="card" style={{ padding: 0, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
                <thead><tr style={{ textAlign: "left", fontSize: 12, color: "var(--ink-dim)" }}>
                  <th style={{ padding: "12px 16px" }}>Client</th><th>Package</th><th>Where it is</th><th style={{ paddingRight: 16 }}>Updated</th>
                </tr></thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.id} onClick={() => open(p.id)} style={{ borderTop: "1px solid var(--rule)", cursor: "pointer" }}>
                      <td style={{ padding: "12px 16px" }}><button className="linklike" style={{ all: "unset", cursor: "pointer", fontWeight: 700 }} onClick={(e) => { e.stopPropagation(); open(p.id); }}>{p.business}</button><div style={{ fontSize: 12, color: "var(--ink-dim)" }}>{p.contact_name}{p.contact_email ? ` · ${p.contact_email}` : ""}</div></td>
                      <td style={{ fontSize: 14 }}>{p.proposal?.package || "—"}<div style={{ fontSize: 12, color: "var(--ink-dim)" }}>{p.proposal?.price}</div></td>
                      <td><Pill status={p.status} /></td>
                      <td style={{ fontSize: 13, color: "var(--ink-dim)", paddingRight: 16 }}>{timeAgo ? timeAgo(p.updated_at) : fmt(p.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
    </div>
  );
}

function PacketEditor({ id, member, onBack, onCreated }) {
  const [p, setP] = useState(id ? null : { ...EMPTY, status: "draft" });
  const [events, setEvents] = useState([]);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [proposalPdfUrl, setProposalPdfUrl] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState("");
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const r = await apiFetch(`/api/start-packets?id=${id}`);
    if (!r.ok) { toast.error("Couldn't open it", r.error); onBack(); return; }
    setP({ ...EMPTY, ...r.data.packet, proposal: { ...EMPTY.proposal, ...(r.data.packet.proposal || {}) } });
    setEvents(r.data.events || []); setPdfUrl(r.data.pdfUrl || null); setProposalPdfUrl(r.data.proposalPdfUrl || null); setDirty(false);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  if (!p) return <div><div className="card" style={{ padding: 24 }}>Loading…</div></div>;
  const locked = ["sent", "opened", "returned", "void"].includes(p.status);
  const set = (k, v) => { setP((x) => ({ ...x, [k]: v })); setDirty(true); };
  const setProp = (k, v) => { setP((x) => ({ ...x, proposal: { ...x.proposal, [k]: v } })); setDirty(true); };

  const call = async (action, extra = {}, label = "") => {
    setBusy(action);
    const r = await apiFetch("/api/start-packets", { method: "POST", body: { action, id: p.id, ...extra } });
    setBusy("");
    if (!r.ok) { toast.error(label || "That didn't work", r.error); return null; }
    return r.data;
  };

  const save = async () => {
    setBusy("save");
    const r = await apiFetch("/api/start-packets", { method: "POST", body: { action: "save", ...p, id: p.id || undefined } });
    setBusy("");
    if (!r.ok) { setErrors(r.status === 400 ? (r.data?.errors || {}) : {}); toast.error("Not saved", r.error); return false; }
    setErrors({}); setDirty(false);
    if (!p.id) { toast.success("Saved", "Now sign it, then send it."); onCreated(r.data.packet.id); return true; }
    toast.success("Saved", r.data.cjSignatureCleared ? "You changed what was signed, so the signature was cleared. Sign it again." : "");
    await load(); return true;
  };

  /* kind: "agreement" or "proposal". A new packet is saved first so the file has a home. */
  const uploadPdf = async (file, kind = "agreement") => {
    if (!file) return;
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
    if (!isPdf) { toast.error("PDF only", `Save the ${kind} as a PDF first.`); return; }
    if (file.size > 10 * 1024 * 1024) { toast.error("Too big", "Keep the PDF under 10 MB."); return; }
    let pid = p.id;
    if (!pid || dirty) {
      setBusy("save");
      const r = await apiFetch("/api/start-packets", { method: "POST", body: { action: "save", ...p, id: p.id || undefined } });
      setBusy("");
      if (!r.ok) { setErrors(r.status === 400 ? (r.data?.errors || {}) : {}); toast.error("Save it first", r.error); return; }
      pid = r.data.packet.id; setDirty(false);
    }
    setBusy(`pdf-${kind}`);
    const post = (action, extra) => apiFetch("/api/start-packets", { method: "POST", body: { action, id: pid, kind, ...extra } });
    const u = await post("pdf_upload", { name: file.name });
    if (!u.ok) { setBusy(""); toast.error("Upload not ready", u.error); return; }
    const { error } = await getSupabase().storage.from("start-packets").uploadToSignedUrl(u.data.path, u.data.token, file, { contentType: "application/pdf" });
    if (error) { setBusy(""); toast.error("Upload failed", error.message); return; }
    const done = await post("pdf_attached", { path: u.data.path, name: file.name });
    setBusy("");
    if (!done.ok) { toast.error("Couldn't attach it", done.error); return; }
    toast.success(kind === "proposal" ? "Proposal PDF attached" : "Agreement PDF attached", done.data.cjSignatureCleared ? "The signature was cleared — sign it again." : "");
    if (!p.id) onCreated(pid); else load();
  };
  const removePdf = async (kind) => { if (await call("pdf_remove", { kind })) load(); };

  const err = (k) => errors[k] ? <div style={{ color: "var(--danger)", fontSize: 12.5, fontWeight: 600, marginTop: -8, marginBottom: 10 }}>{errors[k]}</div> : null;

  return (
    <div style={{ maxWidth: 1000 }}>
      <button className="btn btn-sm" onClick={onBack} style={{ marginBottom: 12 }}>← All start packets</button>
      <SectionHeader kicker="START PACKET" title={p.business || "New start packet"} subtitle={p.id ? stageLabel(p) : "Fill it in, then save. You sign it next."} right={p.id ? <Pill status={p.status} /> : null} />

      {p.status === "returned" && <Returned p={p} pdfUrl={pdfUrl} call={call} reload={load} />}

      <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="card" style={{ padding: 20, marginBottom: 14 }}>
          <h3 style={{ margin: "0 0 12px", fontFamily: "var(--display)" }}>1 · The client</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "0 16px" }}>
            <Field label="Business name *"><TextInput value={p.business} onChange={(e) => set("business", e.target.value)} /></Field>
            <Field label="Website"><TextInput value={p.website || ""} onChange={(e) => set("website", e.target.value)} placeholder="example.com" /></Field>
            <Field label="Client's name (the person who signs) *"><TextInput value={p.contact_name || ""} onChange={(e) => set("contact_name", e.target.value)} placeholder="Their name, not yours" /></Field>
            <Field label="Client's email *"><TextInput type="email" value={p.contact_email || ""} onChange={(e) => set("contact_email", e.target.value)} placeholder="Where the packet email goes" /></Field>
          </div>
          {err("business")}{err("contact_name")}{err("contact_email")}{err("website")}
        </div>

        <div className="card" style={{ padding: 20, marginBottom: 14 }}>
          <h3 style={{ margin: "0 0 12px", fontFamily: "var(--display)" }}>2 · The proposal</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "0 16px" }}>
            <Field label="Package *"><TextInput value={p.proposal.package} onChange={(e) => setProp("package", e.target.value)} placeholder="GEO Strategic Partnership" /></Field>
            <Field label="Price *"><TextInput value={p.proposal.price} onChange={(e) => setProp("price", e.target.value)} placeholder="$1,000 / month" /></Field>
            <Field label="Terms"><TextInput value={p.proposal.term} onChange={(e) => setProp("term", e.target.value)} placeholder="3 months, then $99 / month" /></Field>
            <Field label="Start date"><TextInput type="date" value={p.proposal.start_date} onChange={(e) => setProp("start_date", e.target.value)} /></Field>
          </div>
          {err("package")}{err("price")}
          <Field label="What's included" hint="One per line."><TextArea value={p.proposal.includes} onChange={(e) => setProp("includes", e.target.value)} /></Field>
          <Field label="Notes for the client"><TextArea value={p.proposal.notes} onChange={(e) => setProp("notes", e.target.value)} style={{ minHeight: 70 }} /></Field>
          <div className="label" style={{ marginBottom: 6 }}>The full proposal (optional)</div>
          <DropZone what="proposal" fileName={p.proposal.pdf_name} fileUrl={proposalPdfUrl} busy={busy === "pdf-proposal"} disabled={locked} onFile={(f) => uploadPdf(f, "proposal")} onRemove={() => removePdf("proposal")} />
          <div style={{ height: 12 }} />
          <Field label="Or a link to it" hint="A deck or page they can open. Optional."><TextInput value={p.proposal.doc_url} onChange={(e) => setProp("doc_url", e.target.value)} placeholder="https://…" /></Field>
          {err("doc_url")}
        </div>

        <div className="card" style={{ padding: 20, marginBottom: 14 }}>
          <h3 style={{ margin: "0 0 12px", fontFamily: "var(--display)" }}>3 · The agreement</h3>
          <Field label="Title"><TextInput value={p.contract_title || ""} onChange={(e) => set("contract_title", e.target.value)} /></Field>
          <Field label="Paste the agreement" hint="Blank lines between paragraphs. A line starting with # is a heading. These fill in by themselves: {{business}} {{contact}} {{package}} {{price}} {{term}} {{start_date}} {{today}}">
            <TextArea value={p.contract_text || ""} onChange={(e) => set("contract_text", e.target.value)} style={{ minHeight: 220, fontFamily: "var(--body)" }} />
          </Field>
          {err("contract_text")}
          <div className="label" style={{ marginBottom: 6 }}>Or drop the agreement PDF</div>
          <DropZone what="agreement" fileName={p.contract_pdf_name} fileUrl={pdfUrl} busy={busy === "pdf-agreement"} disabled={locked} onFile={(f) => uploadPdf(f, "agreement")} onRemove={() => removePdf("agreement")} />
        </div>

        <div className="card" style={{ padding: 20, marginBottom: 14 }}>
          <h3 style={{ margin: "0 0 4px", fontFamily: "var(--display)" }}>4 · Onboarding</h3>
          <p style={{ margin: "0 0 12px", fontSize: 13.5, color: "var(--ink-2)" }}>How they tell us about their business and give us access.</p>
          <div role="radiogroup" aria-label="How they onboard" style={{ display: "grid", gap: 8, marginBottom: 12 }}>
            {[["form", "Send them our onboarding form", "They fill in our form (the one we built 4 Nov). It emails their answers to the team."],
              ["packet", "Ask the questions inside this packet", "Their answers save here in the CRM and come in the team email."]].map(([k, title, sub]) => {
              const on = k === "form" ? Boolean(p.proposal.onboarding_url) : !p.proposal.onboarding_url;
              return (
                <label key={k} style={{ display: "flex", gap: 10, alignItems: "flex-start", border: `1px solid ${on ? "var(--accent)" : "var(--rule)"}`, background: on ? "var(--accent-soft)" : "#fff", borderRadius: 12, padding: "10px 12px", cursor: "pointer" }}>
                  <input type="radio" name="sp-onboarding" checked={on} onChange={() => setProp("onboarding_url", k === "form" ? (p.proposal.onboarding_url || standardFormLink(p.business, p.website)) : "")} style={{ marginTop: 3 }} />
                  <span><b style={{ fontSize: 14 }}>{title}</b><br /><span style={{ fontSize: 12.5, color: "#46607f" }}>{sub}</span></span>
                </label>
              );
            })}
          </div>
          {p.proposal.onboarding_url ? (
            <>
              <Field label="Onboarding form link" hint="Filled in with our standard GEO form, made out to this client. For a client with their own branded form (like Ronin or IFS), paste that link instead.">
                <TextInput value={p.proposal.onboarding_url} onChange={(e) => setProp("onboarding_url", e.target.value)} />
              </Field>
              {err("onboarding_url")}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: -4 }}>
                <button type="button" className="btn btn-sm" onClick={() => setProp("onboarding_url", standardFormLink(p.business, p.website))}>Use our standard GEO form</button>
                <a className="btn btn-sm" href={p.proposal.onboarding_url} target="_blank" rel="noopener noreferrer">Open the form</a>
              </div>
            </>
          ) : (
            <>
              <div className="label" id="sp-kind" style={{ marginBottom: 6 }}>Which questions?</div>
              <div role="group" aria-labelledby="sp-kind" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                {Object.entries(FORM_KINDS).map(([k, label]) => (
                  <button key={k} type="button" className={`btn btn-sm ${p.form_kind === k ? "btn-primary" : ""}`} aria-pressed={p.form_kind === k} onClick={() => set("form_kind", k)}>{label}</button>
                ))}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>{questionsFor(p.form_kind).length} questions, the same as our onboarding form{p.form_kind === "website_geo" ? " plus the new-website ones" : ""}. Name, email, business and website are filled in for them.</div>
            </>
          )}
        </div>

        <div className="card" style={{ padding: 20, marginBottom: 14 }}>
          <h3 style={{ margin: "0 0 12px", fontFamily: "var(--display)" }}>5 · Payment</h3>
          <Field label="Stripe link *" hint="The payment link or the &quot;add your card&quot; link from Stripe. A buy.stripe.com link gets this packet's id and their email added for you.">
            <TextInput value={p.payment_url || ""} onChange={(e) => set("payment_url", e.target.value)} placeholder="https://buy.stripe.com/…" />
          </Field>
          {err("payment_url")}
          <Field label="What their card will be charged, in words" hint="Shown above the button. Example: $500 on the 23rd of each month for 3 months, then $99 a month.">
            <TextInput value={p.payment_note || ""} onChange={(e) => set("payment_note", e.target.value)} />
          </Field>
          <Field label="Stripe customer id (optional)" hint="cus_… from the customer's page in Stripe. With it, the page can see when their card is saved (read-only).">
            <TextInput value={p.stripe_customer_id || ""} onChange={(e) => set("stripe_customer_id", e.target.value)} placeholder="cus_…" />
          </Field>
          {err("stripe_customer_id")}
        </div>
      </fieldset>

      {!locked && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", margin: "6px 0 18px", flexWrap: "wrap" }}>
          <button className="btn btn-accent" disabled={!!busy} onClick={save}>{busy === "save" ? "Saving…" : p.id ? "Save changes" : "Save"}</button>
          {dirty && p.id && <span style={{ fontSize: 13, color: "var(--ink-dim)" }}>Unsaved changes{p.ais_signed_at ? " — saving a change clears the signature" : ""}</span>}
        </div>
      )}

      {p.id && !locked && <SignPanel p={p} member={member} dirty={dirty} call={call} reload={load} />}
      {p.id && p.ais_signed_at && ["ready", "sent", "opened"].includes(p.status) && <SendPanel p={p} member={member} dirty={dirty} call={call} reload={load} />}
      {p.id && p.status !== "void" && p.status !== "returned" && (
        <div style={{ margin: "18px 0" }}>
          <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={async () => { if (window.confirm("Cancel this packet? Its link stops working.") && await call("void")) load(); }}>Cancel this packet</button>
        </div>
      )}
      {events.length > 0 && <Timeline events={events} />}
    </div>
  );
}

function SignPanel({ p, member, dirty, call, reload }) {
  const [kind, setKind] = useState("typed");
  const [drawn, setDrawn] = useState("");
  const [title, setTitle] = useState("AI Syndicate");
  const onDraw = useCallback((d) => setDrawn(d), []);
  if (p.ais_signed_at) {
    return (
      <div className="card" style={{ padding: 20, marginBottom: 14, background: "var(--success-soft, #e8f7ee)" }}>
        <h3 style={{ margin: "0 0 8px", fontFamily: "var(--display)" }}>6 · Signed for AI Syndicate</h3>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <SigShow sig={p.ais_signature} name={p.ais_signer_name} />
          <div style={{ fontSize: 14 }}><b>{p.ais_signer_name}</b>, {p.ais_signer_title} · {fmt(p.ais_signed_at)}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: 20, marginBottom: 14, borderColor: "var(--accent)" }}>
      <h3 style={{ margin: "0 0 8px", fontFamily: "var(--display)" }}>6 · Sign for AI Syndicate</h3>
      <p style={{ margin: "0 0 12px", fontSize: 14, color: "var(--ink-2)" }}>Read sections 2–5 above. Your signature goes on exactly this version. If anyone changes it later, it's cleared and you sign again.</p>
      <Field label="Your title"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button type="button" className={`btn btn-sm ${kind === "typed" ? "btn-primary" : ""}`} aria-pressed={kind === "typed"} onClick={() => setKind("typed")}>Type my name</button>
        <button type="button" className={`btn btn-sm ${kind === "drawn" ? "btn-primary" : ""}`} aria-pressed={kind === "drawn"} onClick={() => setKind("drawn")}>Draw</button>
      </div>
      {kind === "drawn" ? <SigPad onChange={onDraw} /> : <div style={{ padding: "8px 12px", border: "1px solid var(--rule)", borderRadius: 12, background: "#fff" }}><SigShow sig={{ kind: "typed" }} name={member?.full_name || member?.membership?.full_name || "Your name"} /></div>}
      <div style={{ marginTop: 12 }}>
        <button className="btn btn-accent" disabled={dirty || (kind === "drawn" && !drawn)} onClick={async () => {
          const r = await call("sign", { title, updated_at: p.updated_at, signature: kind === "drawn" ? { kind, data: drawn } : { kind: "typed", data: "" } }, "Couldn't sign");
          if (r) { toast.success("Signed", "Now make the link and send it."); reload(); }
        }}>Sign for AI Syndicate</button>
        {dirty && <span style={{ marginLeft: 10, fontSize: 13, color: "var(--ink-dim)" }}>Save first.</span>}
      </div>
    </div>
  );
}

function SendPanel({ p, member, dirty, call, reload }) {
  const [link, setLink] = useState("");
  const [draft, setDraft] = useState(null);
  const [boxes, setBoxes] = useState(null);
  const [box, setBox] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => { (async () => {
    const r = await apiFetch("/api/gmail-accounts");
    const list = r.ok ? (r.data.mailboxes || r.data.accounts || []).filter((m) => m.mine !== false && !m.needs_reconnect) : [];
    const me = String(member?.email || member?.membership?.email || "").toLowerCase();
    setBoxes(list); setBox((list.find((m) => String(m.email_address).toLowerCase() === me) || list[0])?.email_address || "");
  })(); }, []);

  const make = async () => {
    if (p.has_link && !window.confirm("Make a new link? The link you sent before stops working.")) return;
    const r = await call("make_link", {}, "Couldn't make the link");
    if (r) { setLink(r.link); setDraft(r.draft); }
  };
  const sendGmail = async () => {
    setSending(true);
    const r = await apiFetch("/api/gmail-send", { method: "POST", body: { account: box, to: p.contact_email, subject: draft.subject, body: draft.body, ...(p.lead_id ? { leadId: p.lead_id } : {}) } });
    setSending(false);
    if (!r.ok) { toast.error("Not sent", r.error); return; }
    await call("mark_sent", { via: "gmail", to: p.contact_email });
    toast.success("Sent", `From ${box} to ${p.contact_email}.`); setLink(""); setDraft(null); reload();
  };
  const copied = async () => {
    await copyToClipboard(`${draft.subject}\n\n${draft.body}`);
    toast.info("Email copied", "Paste it into your email, send it, then press \"I sent it\".");
  };

  return (
    <div className="card" style={{ padding: 20, marginBottom: 14, borderColor: "var(--accent)" }}>
      <h3 style={{ margin: "0 0 8px", fontFamily: "var(--display)" }}>7 · Email it to {p.contact_name || "the client"}</h3>
      {!draft && p.status === "ready" && <p style={{ margin: "0 0 12px", fontSize: 14, color: "var(--ink-dim)" }}>This button makes {p.contact_name ? `${p.contact_name}'s` : "their"} private link and writes the email. Nothing is sent yet — you read the email, then press Send.</p>}
      {p.status !== "ready" && <p style={{ margin: "0 0 10px", fontSize: 14 }}>Sent {fmt(p.sent_at)}{p.sent_by_email ? ` by ${p.sent_by_email}` : ""}{p.opened_at ? ` · opened ${fmt(p.opened_at)}` : " · not opened yet"}.</p>}
      {!draft ? (
        <button className="btn btn-accent" disabled={dirty} onClick={make}>{p.has_link ? "Make a new link + email" : "Make the link + write the email"}</button>
      ) : (
        <>
          <div style={{ marginBottom: 14 }}>
            <label className="label" htmlFor="sp-link" style={{ display: "block", marginBottom: 6 }}>Their private link (works for 30 days)</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><TextInput id="sp-link" readOnly value={link} onFocus={(e) => e.target.select()} style={{ flex: "1 1 260px" }} /><button className="btn btn-sm" onClick={() => { copyToClipboard(link); toast.success("Link copied"); }}>Copy</button><a className="btn btn-sm" href={`${link}&preview=1`} target="_blank" rel="noopener noreferrer">Preview</a></div>
          </div>
          <Field label="Subject"><TextInput value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></Field>
          <Field label="Email"><TextArea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} style={{ minHeight: 220 }} /></Field>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            {boxes && boxes.length > 0 && (
              <>
                <select className="adm-input" value={box} onChange={(e) => setBox(e.target.value)} style={{ width: "auto" }} aria-label="Send from">
                  {boxes.map((b) => <option key={b.email_address} value={b.email_address}>{b.email_address}</option>)}
                </select>
                <button className="btn btn-accent" disabled={sending || !box} onClick={sendGmail}>{sending ? "Sending…" : `Send the email to ${p.contact_email}`}</button>
              </>
            )}
            <button className="btn" onClick={copied}>Copy the email</button>
            <button className="btn" onClick={async () => { if (await call("mark_sent", { via: "copied", to: p.contact_email })) { toast.success("Marked as sent"); setDraft(null); reload(); } }}>I sent it</button>
          </div>
          {boxes && !boxes.length && <p style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 8 }}>No Gmail connected for {member?.email || member?.membership?.email || "you"} — copy the email and send it from your own inbox, or connect Gmail on the Inbox page.</p>}
        </>
      )}
    </div>
  );
}

function Returned({ p, pdfUrl, call, reload }) {
  const sig = p.client_sig || {};
  const answers = p.answers || {};
  const pay = p.payment_status || {};
  const [check, setCheck] = useState(pay.stripe || null);
  return (
    <div className="card" style={{ padding: 20, marginBottom: 14, borderColor: "#86d6a3" }}>
      <h3 style={{ margin: "0 0 10px", fontFamily: "var(--display)" }}>Signed and sent back {fmt(p.returned_at)}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
        <div style={{ border: "1px solid var(--rule)", borderRadius: 12, padding: 12 }}>
          <div className="label">Client signature</div>
          <SigShow sig={sig.signature} name={sig.name} />
          <div style={{ fontSize: 13.5, marginTop: 6 }}><b>{sig.name}</b>{sig.title ? `, ${sig.title}` : ""} · {sig.email}<br />{fmt(sig.signed_at)} · IP {sig.ip}</div>
        </div>
        <div style={{ border: "1px solid var(--rule)", borderRadius: 12, padding: 12 }}>
          <div className="label">AI Syndicate signature</div>
          <SigShow sig={p.ais_signature} name={p.ais_signer_name} />
          <div style={{ fontSize: 13.5, marginTop: 6 }}><b>{p.ais_signer_name}</b> · {fmt(p.ais_signed_at)}</div>
        </div>
        <div style={{ border: "1px solid var(--rule)", borderRadius: 12, padding: 12 }}>
          <div className="label">Payment</div>
          <div style={{ fontSize: 14 }}>Client says card added: <b>{pay.client_says_done ? "yes" : "no"}</b></div>
          {pay.note && <div style={{ fontSize: 13.5 }}>Their note: {pay.note}</div>}
          <div style={{ fontSize: 13.5, marginTop: 4 }}>Stripe: {check ? check.text : "not checked"}</div>
          {p.stripe_customer_id && <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={async () => { const r = await call("check_payment"); if (r) setCheck(r.check); }}>Check Stripe now</button>}
        </div>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-dim)", marginTop: 10, overflowWrap: "anywhere" }}>Fingerprint of what both signed (SHA-256): {p.contract_sha256}{pdfUrl ? <> · <a href={pdfUrl} target="_blank" rel="noopener noreferrer">agreement PDF</a></> : null}</div>
      <div style={{ fontSize: 13, marginTop: 8 }}>Team copy: {p.team_email?.sent ? `emailed to ${(p.team_email.to || []).join(", ")}` : `not sent (${p.team_email?.reason || "unknown"})`} <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={async () => { if (await call("resend_copy", {}, "Didn't send")) { toast.success("Team copy sent again"); reload(); } }}>Email the team copy again</button></div>
      {p.proposal?.onboarding_url && (
        <div style={{ border: "1px solid var(--rule)", borderRadius: 12, padding: 12, marginTop: 14 }}>
          <div className="label">Onboarding</div>
          <div style={{ fontSize: 14 }}>By our form · client says they sent it: <b>{sig.onboarding?.client_says_sent ? "yes" : "no"}</b></div>
          <div style={{ fontSize: 13, color: "var(--ink-dim)", overflowWrap: "anywhere" }}>Their answers come in that form's own email to the team. Form: {p.proposal.onboarding_url}</div>
        </div>
      )}
      {!p.proposal?.onboarding_url && <h3 style={{ margin: "18px 0 6px", fontFamily: "var(--display)" }}>Their answers</h3>}
      {partsFor(p.form_kind).map((part) => {
        const qs = questionsFor(p.form_kind).filter((q) => q.part === part.id && answers[q.id] && String(answers[q.id]).length);
        if (!qs.length) return null;
        return (
          <div key={part.id} style={{ marginBottom: 10 }}>
            <div className="label" style={{ marginTop: 8 }}>{part.title}</div>
            <dl style={{ margin: 0 }}>
              {qs.map((q) => (<div key={q.id} style={{ padding: "6px 0", borderTop: "1px solid var(--rule)" }}><dt style={{ fontWeight: 600, fontSize: 13.5 }}>{q.label}</dt><dd style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 14, color: "var(--ink-2)", overflowWrap: "anywhere" }}>{Array.isArray(answers[q.id]) ? answers[q.id].join(", ") : String(answers[q.id])}</dd></div>))}
            </dl>
          </div>
        );
      })}
      <button className="btn btn-sm" onClick={() => window.print()} style={{ marginTop: 8 }}>Print this record</button>
    </div>
  );
}

const EVENT_WORDS = {
  created: "Made", edited: "Edited", edited_cj_signature_cleared: "Edited — signature cleared", signed: "Signed for AI Syndicate", pdf_attached: "Agreement PDF attached", pdf_removed: "Agreement PDF removed", proposal_pdf_attached: "Proposal PDF attached", proposal_pdf_removed: "Proposal PDF removed",
  cj_signed: "CJ signed for AI Syndicate", asked_cj: "CJ emailed to sign", link_made: "Link made", link_replaced: "New link made (old one stopped working)", sent: "Sent to the client",
  opened: "Client opened it", returned: "Client signed and sent it back", team_copy_sent: "Team copy emailed", team_copy_failed: "Team copy FAILED to email", team_copy_resent: "Team copy emailed again",
  payment_checked: "Stripe checked", cancelled: "Cancelled",
};
function Timeline({ events }) {
  return (
    <div className="card" style={{ padding: 20, marginTop: 14 }}>
      <h3 style={{ margin: "0 0 10px", fontFamily: "var(--display)" }}>What happened</h3>
      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {events.map((e, i) => (
          <li key={i} style={{ display: "flex", gap: 12, padding: "6px 0", borderTop: i ? "1px solid var(--rule)" : 0, fontSize: 13.5, flexWrap: "wrap" }}>
            <span style={{ color: "var(--ink-dim)", minWidth: 130 }}>{fmt(e.at)}</span>
            <span style={{ fontWeight: 600 }}>{EVENT_WORDS[e.kind] || e.kind}</span>
            <span style={{ color: "var(--ink-dim)" }}>{e.by_email || (e.ip ? `IP ${e.ip}` : "")}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
