import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listMemory, upsertMemory, deleteMemory, listClients, logActivity,
  MEMORY_KINDS, MEMORY_KIND_LABELS,
} from "../../lib/data.js";
import { toast } from "../../lib/toast.js";
import { Modal, Field, TextInput, TextArea, Select, timeAgo } from "./shared.jsx";

/* What the AI has remembered — visible, editable, and deletable.
 *
 * WHY THIS SCREEN HAS TO EXIST
 * An assistant that remembers things is only trustworthy if you can read what
 * it remembered and take it back. Memory you cannot see is memory you cannot
 * correct, and a wrong fact that keeps being repeated with confidence does
 * more damage than no memory at all.
 *
 * TWO KINDS OF THING, KEPT APART ON PURPOSE
 *   Rules (the cards above this block) — a person wrote them. Read on every
 *   single AI call. Small and curated.
 *   Memories (here) — the assistant learned them while working. Can grow into
 *   hundreds. Only the ones that fit the question get read.
 * If they were one list, a mistake the AI remembered on Tuesday would outrank
 * a rule Ryder typed on Monday. They are separate for exactly that reason.
 *
 * CONFIRMED vs UNCONFIRMED is not decoration. An unconfirmed memory is
 * labelled as unconfirmed inside the prompt too, and the assistant is told to
 * say so when it leans on one.
 */

const KIND_TONE = {
  fact: "#0369a1", preference: "#6d28d9", event: "#92400e",
  person: "var(--accent-deep)", decision: "#006b1a", gotcha: "var(--danger)",
};

export default function BrainMemory({ member }) {
  const [mem, setMem] = useState({ rows: [], sample: true });
  const [clients, setClients] = useState([]);
  const [q, setQ] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    const [m, c] = await Promise.all([listMemory({ includeRetired: showRetired }), listClients()]);
    setMem(m);
    setClients(c.rows);
  }, [showRetired]);

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return mem.rows;
    return mem.rows.filter((m) => `${m.subject} ${m.body} ${m.kind}`.toLowerCase().includes(needle));
  }, [mem, q]);

  const unconfirmed = mem.rows.filter((m) => m.active && !m.confirmed).length;
  const clientName = (id) => clients.find((c) => c.id === id)?.name || null;

  const setConfirmed = async (row, confirmed) => {
    const res = await upsertMemory({ id: row.id, confirmed, confirmed_by: confirmed ? member.user_id : null });
    if (!res.ok) { toast.error("Could not save that", res.error); return; }
    toast.success(confirmed ? "Confirmed" : "Back to unconfirmed",
      confirmed ? "The AI will state this plainly now." : "The AI will flag it as unconfirmed again.");
    load();
  };

  const retire = async (row) => {
    const res = await upsertMemory({ id: row.id, active: !row.active });
    if (!res.ok) { toast.error("Could not save that", res.error); return; }
    toast.success(row.active ? "Retired" : "Back in use",
      row.active ? "Kept on the record, no longer fed to the AI." : "The AI can use it again.");
    load();
  };

  const forget = async (row) => {
    if (!window.confirm(`Delete "${row.subject}" for good? Retiring it keeps the record; deleting does not.`)) return;
    const res = await deleteMemory(row.id);
    if (!res.ok) { toast.error("Could not delete it", res.error); return; }
    await logActivity({ actor: member.user_id, kind: "memory_deleted", title: `Deleted a memory: ${row.subject}` });
    toast.success("Deleted");
    load();
  };

  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: "var(--display)", fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>
            What it has remembered
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 3, lineHeight: 1.55 }}>
            Picked up while working, not typed by anyone. Weaker than the rules above — if a memory
            contradicts a rule, the rule wins. {unconfirmed > 0 && (
              <strong style={{ color: "#92400e" }}>{unconfirmed} have not been checked by a person yet.</strong>
            )}
          </div>
        </div>
        <button className="btn" onClick={() => setEditing({})}>+ Add one myself</button>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ flex: "1 1 200px" }}>
          <TextInput placeholder="Search what it knows…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className={`btn ${showRetired ? "btn-accent" : ""}`} onClick={() => setShowRetired((v) => !v)}>
          {showRetired ? "✓ Showing retired" : "Show retired"}
        </button>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: "18px 0", fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.6 }}>
          {mem.rows.length === 0
            ? "Nothing remembered yet. Talk to the assistant and tell it something worth keeping — \"Harbor Injury Law runs everything past their legal team first\" — and it will land here where you can check it."
            : "Nothing matches that search."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 0 }}>
          {rows.map((m) => (
            <div key={m.id} style={{ padding: "12px 0", borderTop: "1px solid var(--rule)", opacity: m.active ? 1 : 0.55 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.08em", color: KIND_TONE[m.kind] || "var(--ink-dim)", paddingTop: 2 }}>
                  {(MEMORY_KIND_LABELS[m.kind] || m.kind).toUpperCase()}
                </span>
                <span style={{
                  fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.08em", paddingTop: 2,
                  color: m.confirmed ? "#006b1a" : "#92400e",
                }} title={m.confirmed
                  ? "A person has read this and said it is right."
                  : "Nobody has checked this. The AI is told it is unconfirmed and is asked to say so when it uses it."}>
                  {m.confirmed ? "CONFIRMED" : "UNCONFIRMED"}
                </span>
                {!m.active && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.08em", color: "var(--ink-faint)", paddingTop: 2 }}>RETIRED</span>
                )}
                <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)" }}>
                  {m.last_used_at ? `USED ${timeAgo(m.last_used_at).toUpperCase()}` : "NEVER USED"} · WEIGHT {m.weight}
                </span>
              </div>

              <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", marginTop: 4 }}>
                {m.subject}
                {m.client_id && clientName(m.client_id) && (
                  <span style={{ fontWeight: 400, color: "var(--ink-dim)", fontSize: 12 }}> · {clientName(m.client_id)}</span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55, marginTop: 2 }}>{m.body}</div>

              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                <button className="btn btn-ghost" style={{ padding: "4px 9px", fontSize: 11.5 }} onClick={() => setConfirmed(m, !m.confirmed)}>
                  {m.confirmed ? "Un-confirm" : "This is right"}
                </button>
                <button className="btn btn-ghost" style={{ padding: "4px 9px", fontSize: 11.5 }} onClick={() => setEditing(m)}>Edit</button>
                <button className="btn btn-ghost" style={{ padding: "4px 9px", fontSize: 11.5 }} onClick={() => retire(m)}>
                  {m.active ? "Retire" : "Use it again"}
                </button>
                <button className="btn btn-ghost" style={{ padding: "4px 9px", fontSize: 11.5, color: "var(--danger)" }} onClick={() => forget(m)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 14, lineHeight: 1.5 }}>
        Retiring keeps the row and stops the AI using it — that is the everyday action, because a memory
        that turned out wrong is worth being able to read later. Deleting removes it for good.
        Passwords and card numbers are never stored here; the assistant is told not to, and the Brain is
        closed to the sales role in the database.
      </p>

      {editing !== null && (
        <MemoryModal member={member} clients={clients} row={editing.id ? editing : null}
          onClose={() => setEditing(null)} reload={load} />
      )}
    </div>
  );
}

function MemoryModal({ member, clients, row, onClose, reload }) {
  const [f, setF] = useState({
    kind: row?.kind || "fact",
    subject: row?.subject || "",
    body: row?.body || "",
    weight: row?.weight ?? 3,
    client_id: row?.client_id || "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.subject.trim()) { toast.warn("What is it about?"); return; }
    if (!f.body.trim()) { toast.warn("Write the memory itself — that is what the AI reads"); return; }
    setBusy(true);
    const patch = {
      kind: f.kind,
      subject: f.subject.trim(),
      body: f.body.trim(),
      weight: Math.min(Math.max(parseInt(f.weight, 10) || 3, 1), 5),
      client_id: f.client_id || null,
    };
    if (row?.id) patch.id = row.id;
    else {
      // Typed by a person, so it starts confirmed — the person IS the check.
      patch.origin = "person";
      patch.confirmed = true;
      patch.confirmed_by = member.user_id;
      patch.created_by = member.user_id;
    }
    const res = await upsertMemory(patch);
    setBusy(false);
    if (!res.ok) { toast.error("Could not save it", res.error); return; }
    if (res.duplicate) { toast.info("Already remembered", "That exact memory is already stored."); onClose(); reload(); return; }
    toast.success(row ? "Memory updated" : "Remembered", "The assistant uses it from the next question on.");
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker="AI MEMORY" title={row ? "Edit a memory" : "Add a memory"} width={560}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
        <Field label="What kind">
          <Select value={f.kind} onChange={set("kind")} options={MEMORY_KINDS.map((k) => [k, MEMORY_KIND_LABELS[k]])} />
        </Field>
        <Field label="About which client" hint="Optional.">
          <Select value={f.client_id} onChange={set("client_id")}
            options={[["", "Not about one client"], ...clients.map((c) => [c.id, c.name])]} />
        </Field>
      </div>
      <Field label="What it is about" hint="A client, a tool, a person. This is what gets matched against a question.">
        <TextInput value={f.subject} onChange={set("subject")} placeholder="Harbor Injury Law" />
      </Field>
      <Field label="The memory" hint="One or two sentences, plain words. Written to the AI directly.">
        <TextArea value={f.body} onChange={set("body")} style={{ minHeight: 110 }}
          placeholder="Everything the firm publishes goes through their legal review first. Allow a week." />
      </Field>
      <Field label="How much it matters" hint="5 means it would be a real problem to forget.">
        <Select value={String(f.weight)} onChange={set("weight")}
          options={[["1", "1 — nice to know"], ["2", "2"], ["3", "3 — normal"], ["4", "4"], ["5", "5 — must not be forgotten"]]} />
      </Field>
    </Modal>
  );
}
