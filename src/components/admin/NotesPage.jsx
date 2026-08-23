import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listAiNotes, setNoteStatus, linkNote, listClients, listTeam,
  upsertTask, upsertReminder, logActivity,
  NOTE_CATEGORIES, NOTE_CATEGORY_LABELS, NOTE_CATEGORY_HELP,
} from "../../lib/data.js";
import { apiFetch } from "../../lib/adminApi.js";
import { toast } from "../../lib/toast.js";
import { useScreenContext } from "../../lib/screenContext.js";
import {
  MetricCard, SourceBadge, Modal, Field, TextInput, Select,
  EmptyState, timeAgo,
} from "./shared.jsx";

/* Notes — written by the system, from the system.
 *
 * WHAT MAKES A NOTE HERE DIFFERENT FROM A NOTE ANYWHERE ELSE
 * Nobody typed it. Every note was produced by counting real rows: leads nobody
 * has called, tasks past their date, email somebody is waiting on, clients with
 * a silent week. So the page answers a question a person cannot answer by
 * looking — "what have I stopped noticing?"
 *
 * THE BADGE ON EVERY NOTE IS THE POINT
 *   COUNTED    — every word came from counting rows. No AI touched it.
 *   AI-WRITTEN — an AI reworded the counted facts. It was not allowed to add
 *                a number, and the endpoint checks that it did not.
 * Same rule as the client page and every report we send: measured, quoted and
 * claimed never get blended.
 *
 * EVIDENCE
 * Each note names the exact rows behind it. A note with nothing behind it is
 * never created — see lib/notes-engine.js, which refuses to make one.
 *
 * NOTHING IS DELETED
 * Marking a note done or dismissed sets a status. A re-run marks what is no
 * longer true as "superseded" rather than removing it. Old notes are history.
 */

const CAT_TONE = {
  follow_up: { c: "#92400e", bg: "#fffbeb", icon: "↩" },
  attention: { c: "var(--danger)", bg: "#fef2f2", icon: "!" },
  in_circulation: { c: "#0369a1", bg: "#e0f2fe", icon: "→" },
  win: { c: "#006b1a", bg: "var(--success-soft, #eafce9)", icon: "★" },
};

const TABLE_LABELS = {
  admin_leads: "lead",
  admin_tasks: "task",
  admin_clients: "client",
  admin_email_threads: "email",
  admin_reminders: "follow-up",
  admin_tickets: "ticket",
  admin_client_sites: "site",
  admin_lead_activity: "activity",
  admin_lead_sources: "lead source",
  chat: "a chat",
};

export default function NotesPage({ member }) {
  const [notes, setNotes] = useState({ rows: [], sample: true });
  const [clients, setClients] = useState([]);
  const [team, setTeam] = useState([]);
  const [tab, setTab] = useState("all");
  const [showHistory, setShowHistory] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [taskFrom, setTaskFrom] = useState(null);
  const [remindFrom, setRemindFrom] = useState(null);

  const load = useCallback(async () => {
    const statuses = showHistory ? ["open", "done", "dismissed", "superseded"] : ["open"];
    const [n, c, t] = await Promise.all([listAiNotes({ statuses }), listClients(), listTeam()]);
    setNotes(n);
    setClients(c.rows);
    setTeam(t.rows);
  }, [showHistory]);

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  const open = useMemo(() => notes.rows.filter((n) => n.status === "open"), [notes]);

  useScreenContext(() => ({
    page: "Notes",
    label: `${open.length} open note${open.length === 1 ? "" : "s"}`,
    visible: open.slice(0, 20).map((n) => `${n.category}: ${n.title}`),
  }), [open]);

  const counts = useMemo(() => {
    const by = { follow_up: 0, attention: 0, in_circulation: 0, win: 0 };
    for (const n of open) by[n.category] = (by[n.category] || 0) + 1;
    return by;
  }, [open]);

  const shown = useMemo(() => {
    let rows = notes.rows;
    if (!showHistory) rows = rows.filter((n) => n.status === "open");
    if (tab !== "all") rows = rows.filter((n) => n.category === tab);
    return rows;
  }, [notes, tab, showHistory]);

  const generate = async () => {
    setGenerating(true);
    const res = await apiFetch("/api/notes-generate", { method: "POST", body: { rewrite: true } });
    setGenerating(false);
    if (!res.ok) {
      if (res.preview) {
        toast.info("Preview mode", "The notes below are samples. With the keys set, this button reads every record and writes the real ones.");
        return;
      }
      toast.error("Could not write the notes", res.error);
      return;
    }
    setLastRun(res.data);
    const { created, updated, superseded, total, aiUsed, aiError } = res.data;
    toast.success(
      `${total} note${total === 1 ? "" : "s"} — ${created} new`,
      `${updated} updated, ${superseded} no longer true.${aiUsed ? " Wording by AI, numbers counted." : " All counted, no AI."}`
    );
    if (aiError) toast.warn("The rewrite did not run", aiError);
    await load();
  };

  const decide = async (note, status) => {
    const res = await setNoteStatus(note.id, status, member.user_id);
    if (!res.ok) { toast.error("Could not save that", res.error); return; }
    toast.success(status === "done" ? "Marked done" : "Dismissed",
      status === "done" ? "It stays on the record." : "Kept on the record, off the live list.");
    load();
  };

  const clientName = (id) => clients.find((c) => c.id === id)?.name || null;

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
        <MetricCard label="Needs a follow-up" value={counts.follow_up} badge={<SourceBadge mode={notes.sample ? "sample" : "live"} />} hint="somebody is owed a reply" />
        <MetricCard label="Needs attention" value={counts.attention} hint="stopped moving, or going wrong" />
        <MetricCard label="In circulation" value={counts.in_circulation} hint="moving right now" />
        <MetricCard label="Wins" value={counts.win} hint="worth saying out loud" />
      </div>

      <div className="card" style={{ padding: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div className="adm-tabs" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {[["all", "All"], ...NOTE_CATEGORIES.map((c) => [c, NOTE_CATEGORY_LABELS[c]])].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              title={NOTE_CATEGORY_HELP[id] || "Everything, most urgent first"}
              style={{
                padding: "6px 12px", borderRadius: 8, cursor: "pointer",
                border: "1px solid " + (tab === id ? "var(--ink)" : "var(--rule)"),
                background: tab === id ? "var(--ink)" : "white",
                color: tab === id ? "white" : "var(--ink-2)",
                fontSize: 12.5, fontWeight: 600, fontFamily: "var(--body)",
              }}
            >
              {label}{id !== "all" && counts[id] ? ` · ${counts[id]}` : ""}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <button className={`btn ${showHistory ? "btn-accent" : ""}`} onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "✓ Showing history" : "Show history"}
          </button>
          <button className="btn btn-accent" onClick={generate} disabled={generating}>
            {generating ? "Reading the records…" : "Write today's notes"}
          </button>
        </div>
      </div>

      {lastRun && (
        <div className="card" style={{ padding: "10px 16px", fontSize: 12.5, color: "var(--ink-2)", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 800, letterSpacing: "0.1em", color: "var(--ink-dim)" }}>LAST RUN</span>
          <span>{lastRun.created} new · {lastRun.updated} updated · {lastRun.superseded} no longer true</span>
          <span style={{ color: "var(--ink-faint)" }}>
            {lastRun.aiUsed ? "Wording by AI. Every number was counted first and checked after." : "Counted only — no AI wording."}
          </span>
          {lastRun.problems?.length ? (
            <span style={{ color: "var(--danger)" }}>{lastRun.problems.length} note(s) could not be saved: {lastRun.problems[0]}</span>
          ) : null}
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon="📝"
          title={open.length === 0 && !showHistory ? "No notes yet" : "Nothing in this group"}
          body={open.length === 0 && !showHistory
            ? "Click \"Write today's notes\" and the system will read every client, task, lead, email and follow-up, then write down what it found."
            : "Try another group, or turn history on to see notes that have been handled."}
          action={open.length === 0 && !showHistory
            ? <button className="btn btn-accent" onClick={generate} disabled={generating}>Write today's notes</button>
            : null}
        />
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {shown.map((n) => {
            const tone = CAT_TONE[n.category] || CAT_TONE.attention;
            const isOpen = n.status === "open";
            return (
              <div key={n.id} className="card" style={{ padding: 16, opacity: isOpen ? 1 : 0.62 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0,
                    padding: "3px 9px", borderRadius: 99, background: tone.bg, color: tone.c,
                    fontSize: 10, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em",
                  }}>
                    {tone.icon} {NOTE_CATEGORY_LABELS[n.category]?.toUpperCase() || n.category.toUpperCase()}
                  </span>

                  {n.urgency === 3 && (
                    <span style={{ padding: "3px 9px", borderRadius: 99, background: "var(--danger)", color: "white", fontSize: 10, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em" }}>
                      TODAY
                    </span>
                  )}

                  {/* The honesty badge. Never hidden, never abbreviated away. */}
                  <span
                    title={n.written_by === "counted"
                      ? "Every word here came from counting rows. No AI wrote any of it."
                      : n.written_by === "ai_written"
                        ? "An AI reworded facts that were counted first. It was not allowed to add a number, and the numbers were checked afterwards."
                        : "A person wrote this note."}
                    style={{
                      padding: "3px 9px", borderRadius: 99, fontSize: 10, fontWeight: 800,
                      fontFamily: "var(--mono)", letterSpacing: "0.06em",
                      background: n.written_by === "counted" ? "var(--bg-3, #eef2f7)" : "var(--accent-soft)",
                      color: n.written_by === "counted" ? "var(--ink-dim)" : "var(--accent-deep)",
                    }}
                  >
                    {n.written_by === "counted" ? "COUNTED" : n.written_by === "ai_written" ? "AI-WRITTEN" : "BY A PERSON"}
                  </span>

                  {!isOpen && (
                    <span style={{ padding: "3px 9px", borderRadius: 99, background: "var(--bg-3, #eef2f7)", color: "var(--ink-dim)", fontSize: 10, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em" }}>
                      {n.status === "superseded" ? "NO LONGER TRUE" : n.status.toUpperCase()}
                    </span>
                  )}

                  <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-faint)" }}>
                    {timeAgo(n.generated_at).toUpperCase()}
                  </span>
                </div>

                <div style={{ fontFamily: "var(--display)", fontSize: 16, fontWeight: 700, color: "var(--ink)", marginTop: 10 }}>
                  {n.title}
                </div>
                {n.client_id && clientName(n.client_id) && (
                  <div style={{ fontSize: 12, color: "var(--ink-dim)", marginTop: 2 }}>{clientName(n.client_id)}</div>
                )}
                <div style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6, marginTop: 6 }}>{n.body}</div>

                {/* Evidence. The reason you can trust the line above it. */}
                <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.1em", color: "var(--ink-faint)" }}>
                    BUILT FROM
                  </span>
                  {(n.evidence || []).length === 0 ? (
                    <span style={{ fontSize: 11.5, color: "var(--danger)" }}>nothing on record — treat this note as unsupported</span>
                  ) : (
                    <>
                      {(n.evidence || []).slice(0, 6).map((e, i) => (
                        <span key={i} style={{ padding: "2px 8px", borderRadius: 6, background: "var(--bg-2)", border: "1px solid var(--rule)", fontSize: 11, color: "var(--ink-2)" }}>
                          <span style={{ color: "var(--ink-faint)" }}>{TABLE_LABELS[e.table] || e.table}:</span> {e.label}
                        </span>
                      ))}
                      {(n.evidence || []).length > 6 && (
                        <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>+{n.evidence.length - 6} more</span>
                      )}
                    </>
                  )}
                </div>

                {isOpen && (
                  <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => decide(n, "done")}>Done</button>
                    <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => decide(n, "dismissed")}>Not a thing</button>
                    {n.linked_task_id ? (
                      <span style={{ fontSize: 11.5, color: "#006b1a", alignSelf: "center" }}>✓ turned into a task</span>
                    ) : (
                      <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => setTaskFrom(n)}>Make it a task</button>
                    )}
                    {n.linked_reminder_id ? (
                      <span style={{ fontSize: 11.5, color: "#006b1a", alignSelf: "center" }}>✓ follow-up set</span>
                    ) : (
                      <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => setRemindFrom(n)}>Remind me</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {taskFrom && (
        <MakeTaskModal note={taskFrom} member={member} clients={clients} team={team}
          onClose={() => setTaskFrom(null)} reload={load} />
      )}
      {remindFrom && (
        <MakeReminderModal note={remindFrom} member={member}
          onClose={() => setRemindFrom(null)} reload={load} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

function isoDaysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

function MakeTaskModal({ note, member, clients, team, onClose, reload }) {
  const [f, setF] = useState({
    title: note.title,
    client_id: note.client_id || "",
    assigned_to: note.owner_id || member.user_id,
    due_date: isoDaysFromNow(2),
    priority: note.urgency === 3 ? "high" : "medium",
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.title.trim()) { toast.warn("Give the task a title"); return; }
    setBusy(true);
    const res = await upsertTask({
      name: f.title.trim(),               // admin_tasks.name

      client_id: f.client_id || null,
      assigned_to: f.assigned_to || null,
      due_date: f.due_date || null,
      priority: f.priority,
      status: "todo",
      // The note travels with the task, so whoever picks it up in Operations
      // can see what it came from without coming back here. The column is
      // `latest_report` — it is what the Operations table already shows.
      latest_report: `From a note on ${new Date(note.generated_at).toISOString().slice(0, 10)}: ${note.body}`,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Could not add the task", res.error); return; }
    await linkNote(note.id, { linked_task_id: res.row?.id || null });
    await logActivity({ actor: member.user_id, kind: "task_from_note", title: `Task from a note: ${f.title.trim()}` });
    toast.success("Task added", "It is on the Operations page.");
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker="FROM A NOTE" title="Make it a task" width={560}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Add the task"}</button>
      </>}>
      <Field label="What needs doing"><TextInput value={f.title} onChange={set("title")} /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
        <Field label="Client">
          <Select value={f.client_id} onChange={set("client_id")}
            options={[["", "No client"], ...clients.map((c) => [c.id, c.name])]} />
        </Field>
        <Field label="Who does it">
          <Select value={f.assigned_to} onChange={set("assigned_to")}
            options={[["", "Nobody yet"], ...team.filter((t) => t.active).map((t) => [t.user_id, t.full_name || t.email])]} />
        </Field>
        <Field label="Due">
          {/* Uncontrolled on purpose — a date input reports "" on every
              keystroke until the date is whole, and saving that empties the
              field the person is typing into. Same trap as Operations. */}
          <input className="adm-input" type="date" defaultValue={f.due_date}
            onChange={(e) => { if (e.target.value) setF((s) => ({ ...s, due_date: e.target.value })); }} />
        </Field>
        <Field label="Priority">
          <Select value={f.priority} onChange={set("priority")}
            options={[["high", "High"], ["medium", "Medium"], ["low", "Low"]]} />
        </Field>
      </div>
    </Modal>
  );
}

function MakeReminderModal({ note, member, onClose, reload }) {
  const [title, setTitle] = useState(note.title);
  const [due, setDue] = useState(isoDaysFromNow(1));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!title.trim()) { toast.warn("Say what to come back to"); return; }
    setBusy(true);
    const res = await upsertReminder({
      owner_id: member.user_id,
      created_by: member.user_id,
      body: title.trim(),                 // admin_reminders.body
      // 14:00Z is 9am Central — the team's morning, not 4am.
      due_at: `${due}T14:00:00Z`,
      link_type: "note",
      link_id: note.id,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Could not set it", res.error); return; }
    await linkNote(note.id, { linked_reminder_id: res.row?.id || null });
    toast.success("Follow-up set", "It shows on your Work page.");
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker="FROM A NOTE" title="Remind me" width={480}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Set the follow-up"}</button>
      </>}>
      <Field label="Come back to"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="When" hint="It appears on your Work page that morning.">
        <input className="adm-input" type="date" defaultValue={due}
          onChange={(e) => { if (e.target.value) setDue(e.target.value); }} />
      </Field>
    </Modal>
  );
}
