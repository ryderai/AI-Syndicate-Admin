import { useCallback, useEffect, useState } from "react";
import { listBrain, upsertBrain, deleteBrain, logActivity } from "../../lib/data.js";
import { apiFetch } from "../../lib/adminApi.js";
import { toast } from "../../lib/toast.js";
import {
  SourceBadge, Modal, Field, TextInput, TextArea, Select, EmptyState, Explainer,
} from "./shared.jsx";

/* AI Brain — the editable knowledge base every AI draft is grounded in.
 * Edit a rule here and the next email/ticket/outreach draft follows it.
 * The test chat on the right proves it immediately. */

const KIND_META = {
  voice: { label: "Voice", icon: "🎙", blurb: "How the AI writes — tone, style, formatting rules." },
  rule: { label: "Rules", icon: "⚖️", blurb: "Hard lines the AI must never cross." },
  fact: { label: "Facts", icon: "📌", blurb: "True things about the business the AI can state." },
  snippet: { label: "Snippets", icon: "✂️", blurb: "Reusable blocks — pricing lines, booking links, bios." },
};

export default function Brain({ member }) {
  const [brain, setBrain] = useState({ rows: [], sample: true });
  const [editItem, setEditItem] = useState(null); // null | {} | row
  const [chat, setChat] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);

  const load = useCallback(async () => {
    const b = await listBrain();
    setBrain(b);
  }, []);

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  const toggle = async (row) => {
    const res = await upsertBrain({ id: row.id, enabled: !row.enabled });
    if (!res.ok) { toast.error("Couldn't toggle", res.error); return; }
    toast.success(row.enabled ? "Turned off" : "Turned on", `"${row.title}" ${row.enabled ? "no longer" : "now"} shapes AI drafts.`);
    load();
  };

  const ask = async () => {
    const q = chatInput.trim();
    if (!q) return;
    setChat((c) => [...c, { role: "user", text: q }]);
    setChatInput("");
    setChatBusy(true);
    const res = await apiFetch("/api/ai-draft", {
      method: "POST",
      body: { kind: "chat", context: q, history: chat.slice(-8) },
    });
    setChatBusy(false);
    if (!res.ok) {
      setChat((c) => [...c, { role: "assistant", text: res.preview
        ? "PREVIEW — with the AI key set, I answer here using exactly the Brain entries on the left. Edit an entry and ask again to see the change."
        : `Couldn't answer: ${res.error}` }]);
      return;
    }
    setChat((c) => [...c, { role: "assistant", text: res.data.text }]);
  };

  const grouped = Object.keys(KIND_META).map((k) => ({
    kind: k, ...KIND_META[k],
    items: brain.rows.filter((r) => r.kind === k),
  }));

  return (
    <>
      <Explainer
        icon="🧠"
        kicker="THE TEAM'S AI MEMORY"
        title="Edit here, and every AI draft changes"
        body="Emails, ticket replies, and outreach drafts are all written against these entries. Add a rule ('never promise a timeline'), a fact ('we support 12 AI engines'), or a voice note — then prove it in the test chat."
      />

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
        <SourceBadge mode={brain.sample ? "sample" : "live"} />
        <button className="btn btn-accent" onClick={() => setEditItem({})}>+ Add entry</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(280px, 2fr)", gap: 16, alignItems: "start" }} className="adm-ops-grid">
        {/* Entries */}
        <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
          {brain.rows.length === 0 ? (
            <EmptyState icon="🧠" title="The Brain is empty" body="Start with three entries: how we write, what we never say, and what the business does. Every draft gets smarter from there."
              action={<button className="btn btn-accent" onClick={() => setEditItem({})}>+ Add the first entry</button>} />
          ) : grouped.filter((g) => g.items.length).map((g) => (
            <div key={g.kind} className="card" style={{ padding: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span aria-hidden="true">{g.icon}</span>
                <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 15, color: "var(--ink)" }}>{g.label}</span>
                <span style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>· {g.blurb}</span>
              </div>
              {g.items.map((row) => (
                <div key={row.id} style={{ padding: "12px 0", borderTop: "1px solid var(--rule)", opacity: row.enabled ? 1 : 0.5 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{row.title}</div>
                      <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55, marginTop: 3, whiteSpace: "pre-wrap" }}>{row.body}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button className="btn btn-ghost" style={{ padding: "5px 9px", fontSize: 12 }} onClick={() => toggle(row)} title={row.enabled ? "Turn off (kept, just not used)" : "Turn on"}>
                        {row.enabled ? "On ✓" : "Off"}
                      </button>
                      <button className="btn btn-ghost" style={{ padding: "5px 9px", fontSize: 12 }} onClick={() => setEditItem(row)}>Edit</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Test chat */}
        <div className="card" style={{ padding: 0, overflow: "hidden", position: "sticky", top: 12 }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--rule)", background: "linear-gradient(135deg, #faf5ff, white)" }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>Test the Brain</div>
            <div style={{ fontSize: 11.5, color: "var(--ink-dim)", marginTop: 2 }}>Ask anything — the answer uses the entries on the left.</div>
          </div>
          <div style={{ padding: 14, minHeight: 180, maxHeight: 360, overflowY: "auto" }}>
            {chat.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--ink-faint)", lineHeight: 1.6 }}>
                Try: "Draft one sentence for a lead who asked what we do" — then edit a Brain entry and ask again.
              </div>
            ) : chat.map((m, i) => (
              <div key={i} className={`adm-msg ${m.role === "assistant" ? "agent" : ""}`} style={{ padding: "10px 12px", marginBottom: 8 }}>
                <div style={{ fontSize: 10, fontFamily: "var(--mono)", fontWeight: 800, letterSpacing: "0.08em", color: "var(--ink-dim)", marginBottom: 4 }}>
                  {m.role === "assistant" ? "AI" : "YOU"}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{m.text}</div>
              </div>
            ))}
            {chatBusy && <div style={{ fontSize: 12, color: "var(--ink-faint)" }}>Thinking…</div>}
          </div>
          <div style={{ padding: 12, borderTop: "1px solid var(--rule)", display: "flex", gap: 8 }}>
            <TextInput
              placeholder="Ask the AI…"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
            />
            <button className="btn btn-accent" onClick={ask} disabled={chatBusy}>Ask</button>
          </div>
        </div>
      </div>

      {editItem !== null && (
        <BrainModal member={member} row={editItem.id ? editItem : null} onClose={() => setEditItem(null)} reload={load} />
      )}
    </>
  );
}

function BrainModal({ member, row, onClose, reload }) {
  const [f, setF] = useState({ kind: row?.kind || "fact", title: row?.title || "", body: row?.body || "" });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.title.trim()) { toast.warn("Give it a short title"); return; }
    if (!f.body.trim()) { toast.warn("Write the content — that's what the AI reads"); return; }
    setBusy(true);
    const patch = { kind: f.kind, title: f.title.trim(), body: f.body.trim(), updated_by: member.user_id };
    if (row?.id) patch.id = row.id;
    const res = await upsertBrain(patch);
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't save", res.error); return; }
    await logActivity({ actor: member.user_id, kind: "brain_edit", title: `${row ? "Edited" : "Added"} Brain entry: ${f.title}` });
    toast.success(row ? "Entry updated" : "Entry added", "Every new AI draft now uses it.");
    onClose(); reload();
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${row.title}"? Drafts will stop using it immediately.`)) return;
    const res = await deleteBrain(row.id);
    if (!res.ok) { toast.error("Couldn't delete", res.error); return; }
    toast.success("Entry deleted");
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker="AI BRAIN" title={row ? "Edit entry" : "Add an entry"} width={560}
      footer={<>
        {row && <button className="btn" style={{ marginRight: "auto", color: "var(--danger)" }} onClick={remove}>Delete</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save entry"}</button>
      </>}>
      <Field label="Type">
        <Select value={f.kind} onChange={set("kind")} options={Object.entries(KIND_META).map(([k, m]) => [k, `${m.icon} ${m.label} — ${m.blurb}`])} />
      </Field>
      <Field label="Title" hint="Short — it's the label, not the content.">
        <TextInput value={f.title} onChange={set("title")} placeholder="Never promise rankings" />
      </Field>
      <Field label="Content" hint="Written to the AI directly. Plain language works best.">
        <TextArea value={f.body} onChange={set("body")} style={{ minHeight: 140 }} placeholder="We never guarantee a score, a ranking, or a timeline in writing…" />
      </Field>
    </Modal>
  );
}
