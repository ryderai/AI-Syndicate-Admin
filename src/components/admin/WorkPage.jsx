import { useCallback, useEffect, useState } from "react";
import {
  SectionHeader, SourceBadge, EmptyState, Modal, Field,
  TextInput, TextArea, Select, timeAgo,
} from "./shared.jsx";
import {
  getMyWork, upsertTask, upsertNote, deleteNote, listNotes,
  upsertReminder, deleteReminder, upsertLead, addLeadActivity,
  TASK_STATUS_LABELS, LEAD_STAGE_LABELS,
} from "../../lib/data.js";
import { toast } from "../../lib/toast.js";

/* WORK — the page you open to get through the day.
 *
 * Everything here is scoped to one person: the tasks assigned to them, the
 * leads they own that are owed a contact, their tickets, their reminders and
 * their notes. Nothing on this page is a summary of the agency; Overview does
 * that. The rule for what earns a place here is "I can act on this now".
 *
 * All the bucketing lives in getMyWork() in data.js so the counts in the
 * header and the rows below can never disagree. */

const BUCKETS = [
  { key: "overdue", label: "Late", tone: "#b42318", bg: "#fef3f2" },
  { key: "today", label: "Due today", tone: "#b54708", bg: "#fffaeb" },
  { key: "week", label: "This week", tone: "var(--accent-deep)", bg: "var(--accent-soft)" },
  { key: "nodate", label: "No date set", tone: "var(--ink-dim)", bg: "var(--bg-3)" },
  { key: "later", label: "Later", tone: "var(--ink-dim)", bg: "var(--bg-3)" },
  { key: "blocked", label: "Blocked", tone: "#6941c6", bg: "#f4f3ff" },
];

/* One tab per section. The count is what is waiting behind the tab: open
 * tasks, people owed a contact, open reminders, notes written, open tickets. */
const TABS = [
  { id: "tasks", label: "Operations", count: (w) => w.tasks.length },
  { id: "contact", label: "People to contact", count: (w) => w.contactable.length },
  { id: "reminders", label: "Reminders", count: (w) => w.reminders.filter((r) => !r.done_at).length },
  { id: "notes", label: "Notes", count: (w, notes) => notes.length },
  { id: "tickets", label: "Tickets", count: (w) => w.tickets.length },
];

/** A date input wants YYYY-MM-DD in local time — toISOString() would shift it. */
function todayInputValue(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dueLabel(ms) {
  if (ms === null || Number.isNaN(ms)) return "no date";
  const endOfToday = new Date().setHours(23, 59, 59, 999);
  const days = Math.round((ms - endOfToday) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "1 day late";
  if (days < 0) return `${Math.abs(days)} days late`;
  if (days <= 6) return `in ${days} days`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function Pill({ children, tone, bg }) {
  return (
    <span style={{
      padding: "2px 8px", borderRadius: 4, background: bg, color: tone,
      fontSize: 9.5, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em",
      whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

/* ------------------------------------------------------------------ */
/* The four counters at the top                                        */
/* ------------------------------------------------------------------ */
function Scoreboard({ counts, onJump, activeTab }) {
  const tiles = [
    { key: "late", label: "Late", value: counts.overdue, hint: "past their due date", tone: "#b42318", target: "tasks" },
    { key: "today", label: "Due today", value: counts.today, hint: "finish these", tone: "#b54708", target: "tasks" },
    { key: "contact", label: "People to contact", value: counts.contact, hint: "owed a call or an email", tone: "var(--accent-deep)", target: "contact" },
    { key: "rem", label: "Reminders due", value: counts.remindersDue, hint: "today or earlier", tone: "#6941c6", target: "reminders" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
      {tiles.map((t) => (
        <button
          key={t.key}
          className="card"
          onClick={() => onJump(t.target)}
          title={`Show ${t.label.toLowerCase()}`}
          style={{
            padding: 15, textAlign: "left", cursor: "pointer", display: "block", width: "100%",
            border: activeTab === t.target ? "1px solid var(--accent-deep)" : "1px solid var(--rule)",
          }}
        >
          <div className="label">{t.label}</div>
          <div style={{
            fontFamily: "var(--display)", fontSize: 30, fontWeight: 700, lineHeight: 1.05,
            marginTop: 6, color: t.value > 0 ? t.tone : "var(--ink-dim)",
          }}>{t.value}</div>
          <div style={{ fontSize: 11.5, color: "var(--ink-dim)", marginTop: 4 }}>{t.hint}</div>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function WorkPage({ member }) {
  const userId = member?.user_id || null;
  const [tab, setTab] = useState("tasks");
  const [work, setWork] = useState(null);
  const [notes, setNotes] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState({ title: "", body: "" });
  const [remOpen, setRemOpen] = useState(false);
  const [remDraft, setRemDraft] = useState({ body: "", due: todayInputValue(1) });
  const [contactOpen, setContactOpen] = useState(null);
  const [contactDraft, setContactDraft] = useState({ type: "call", outcome: "talked", body: "", next: "", stage: "" });

  const load = useCallback(async () => {
    const [w, n] = await Promise.all([getMyWork(userId), listNotes(userId)]);
    setWork(w);
    setNotes(n.rows);
    if (w.error) toast.error("Some of this page didn't load", w.error);
  }, [userId]);

  useEffect(() => { load(); }, [load]);
  /* The Tickets tab only exists while you have tickets. Solve your last one
   * while standing on it and the tab vanishes — without this you would be
   * looking at a blank page. */
  useEffect(() => {
    if (tab === "tickets" && work && work.tickets.length === 0) setTab("tasks");
  }, [tab, work]);

  useEffect(() => {
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  /* The counters at the top double as tab switches — clicking "People to
   * contact" should take you to the people, not scroll you past four other
   * sections to reach them. */
  const goTab = (id) => {
    setTab(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /* ---------------- tasks ---------------- */
  async function setTaskStatus(task, status) {
    setBusyId(task.id);
    const res = await upsertTask({ id: task.id, status });
    setBusyId(null);
    if (!res.ok) return toast.error("Couldn't save that", res.error);
    toast.success(status === "done" ? "Done — nice" : `Moved to ${TASK_STATUS_LABELS[status]}`, task.name);
    load();
  }

  /* ---------------- notes ---------------- */
  async function saveNote() {
    const body = noteDraft.body.trim();
    if (!body) return toast.warn("Write something first", "A note needs at least a line of text.");
    const patch = { title: noteDraft.title.trim() || null, body };
    if (noteDraft.id) patch.id = noteDraft.id;
    else if (userId) patch.author_id = userId;
    const res = await upsertNote(patch);
    if (!res.ok) return toast.error("Note didn't save", res.error);
    setNoteOpen(false);
    setNoteDraft({ title: "", body: "" });
    toast.success(noteDraft.id ? "Note updated" : "Note saved");
    load();
  }

  async function togglePin(note) {
    const res = await upsertNote({ id: note.id, pinned: !note.pinned });
    if (!res.ok) return toast.error("Couldn't change that", res.error);
    load();
  }

  async function removeNote(note) {
    const res = await deleteNote(note.id);
    if (!res.ok) return toast.error("Couldn't delete that", res.error);
    toast.info("Note deleted");
    load();
  }

  /* ---------------- reminders ---------------- */
  async function saveReminder() {
    const body = remDraft.body.trim();
    if (!body) return toast.warn("What's the reminder?", "Write the thing you want to be reminded about.");
    if (!remDraft.due) return toast.warn("Pick a date", "A reminder with no date never shows up.");
    const patch = { body, due_at: new Date(remDraft.due + "T09:00:00").toISOString() };
    if (remDraft.id) patch.id = remDraft.id;
    else if (userId) { patch.owner_id = userId; patch.created_by = userId; }
    const res = await upsertReminder(patch);
    if (!res.ok) return toast.error("Reminder didn't save", res.error);
    setRemOpen(false);
    setRemDraft({ body: "", due: todayInputValue(1) });
    toast.success("Reminder set", new Date(patch.due_at).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }));
    load();
  }

  async function tickReminder(r) {
    const res = await upsertReminder({ id: r.id, done_at: new Date().toISOString() });
    if (!res.ok) return toast.error("Couldn't tick that off", res.error);
    toast.success("Ticked off", r.body);
    load();
  }

  async function pushReminder(r, days) {
    const base = Math.max(Date.parse(r.due_at), Date.now());
    const res = await upsertReminder({ id: r.id, due_at: new Date(base + days * 86400000).toISOString() });
    if (!res.ok) return toast.error("Couldn't move that", res.error);
    toast.info(`Pushed ${days} day${days > 1 ? "s" : ""}`);
    load();
  }

  async function removeReminder(r) {
    const res = await deleteReminder(r.id);
    if (!res.ok) return toast.error("Couldn't delete that", res.error);
    toast.info("Reminder deleted");
    load();
  }

  /* ---------------- logging a contact ---------------- */
  function openContact(lead) {
    setContactDraft({ type: "call", outcome: "talked", body: "", next: todayInputValue(3), stage: lead.stage });
    setContactOpen(lead);
  }

  async function saveContact() {
    const lead = contactOpen;
    if (!lead) return;
    const act = await addLeadActivity({
      leadId: lead.id, actor: userId, type: contactDraft.type,
      outcome: contactDraft.outcome || null, body: contactDraft.body.trim() || null,
    });
    if (!act.ok) return toast.error("Couldn't log that", act.error);

    const patch = { id: lead.id };
    if (contactDraft.next) patch.next_follow_up_at = new Date(contactDraft.next + "T09:00:00").toISOString();
    else patch.next_follow_up_at = null;
    if (contactDraft.stage && contactDraft.stage !== lead.stage) patch.stage = contactDraft.stage;
    const up = await upsertLead(patch);
    if (!up.ok) return toast.error("Logged it, but the follow-up date didn't save", up.error);

    setContactOpen(null);
    toast.success("Logged", contactDraft.next
      ? `Next follow-up ${new Date(patch.next_follow_up_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
      : "No follow-up date set — it'll come back as stale.");
    load();
  }

  /* ---------------- render ---------------- */
  if (!work || !notes) {
    return <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--ink-dim)" }}>Loading your work…</div>;
  }

  const mode = work.sample ? "sample" : "live";
  const tasksByBucket = BUCKETS
    .map((b) => ({ ...b, rows: work.tasks.filter((t) => t.bucket === b.key) }))
    .filter((b) => b.rows.length);

  const openReminders = work.reminders.filter((r) => !r.done_at);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <SourceBadge
          mode={mode}
          hint={mode === "live" ? "Your real tasks, leads and reminders" : "Sample data — this page goes live with the database key"}
        />
        {work.counts.blocked > 0 && (
          <span style={{ fontSize: 12, color: "var(--ink-dim)" }}>
            {work.counts.blocked} blocked — waiting on something else, listed at the bottom
          </span>
        )}
      </div>

      <Scoreboard counts={work.counts} onJump={goTab} activeTab={tab} />

      {/* Tabs — each section is its own page. Counts live on the tab so you can
       * see what is waiting behind it without opening it. */}
      <div className="aia-tabs" role="tablist" aria-label="Your work" style={{ marginTop: 4 }}>
        {TABS.filter((t) => t.id !== "tickets" || work.tickets.length > 0).map((t) => {
          const count = t.count(work, notes);
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              role="tab"
              aria-selected={tab === t.id}
              className={`aia-tab ${tab === t.id ? "active" : ""}`}
            >
              <span className="aia-tab-dot" aria-hidden="true" />
              {t.label}
              {count > 0 ? <span className="aia-tab-badge">{count}</span> : null}
            </button>
          );
        })}
        {tab === "notes" && (
          <button
            className="aia-tab"
            style={{ marginLeft: "auto", color: "var(--accent-deep)" }}
            onClick={() => { setNoteDraft({ title: "", body: "" }); setNoteOpen(true); }}
          >
            + New note
          </button>
        )}
        {tab === "reminders" && (
          <button
            className="aia-tab"
            style={{ marginLeft: "auto", color: "var(--accent-deep)" }}
            onClick={() => { setRemDraft({ body: "", due: todayInputValue(1) }); setRemOpen(true); }}
          >
            + New reminder
          </button>
        )}
      </div>

      {/* ---------------- OPERATIONS ---------------- */}
      {tab === "tasks" && (<div id="work-tasks">
        <SectionHeader
          kicker="Operations"
          title="Assigned to you"
          subtitle="Every open task with your name on it, soonest first. Tick it off here — it updates the client's Operations page too."
        />
        {tasksByBucket.length === 0 ? (
          <EmptyState
            icon="✓"
            title="No open tasks assigned to you"
            body="When a task on the Operations page is assigned to you, it lands here with its due date."
          />
        ) : (
          tasksByBucket.map((b) => (
            <div key={b.key} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <Pill tone={b.tone} bg={b.bg}>{b.label.toUpperCase()}</Pill>
                <span style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>{b.rows.length}</span>
              </div>
              <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                {b.rows.map((t, i) => (
                  <div
                    key={t.id}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "13px 16px",
                      borderTop: i ? "1px solid var(--line)" : "none", flexWrap: "wrap",
                    }}
                  >
                    <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{t.name}</div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-dim)", marginTop: 3, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {t.client_name && <span>{t.client_name}</span>}
                        <span>·</span>
                        <span>{dueLabel(t.due_ms)}</span>
                        {t.priority === "high" && <><span>·</span><span style={{ color: "#b42318", fontWeight: 700 }}>high</span></>}
                        {t.category && <><span>·</span><span>{t.category}</span></>}
                      </div>
                      {t.latest_report && (
                        <div style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 4, fontStyle: "italic" }}>{t.latest_report}</div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {t.status !== "in_progress" && (
                        <button className="btn btn-sm" disabled={busyId === t.id} onClick={() => setTaskStatus(t, "in_progress")}>Start</button>
                      )}
                      {t.status !== "blocked" && (
                        <button className="btn btn-sm" disabled={busyId === t.id} onClick={() => setTaskStatus(t, "blocked")}>Blocked</button>
                      )}
                      <button className="btn btn-sm btn-primary" disabled={busyId === t.id} onClick={() => setTaskStatus(t, "done")}>Done</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>)}

      {/* ---------------- PEOPLE TO CONTACT ---------------- */}
      {tab === "contact" && (<div id="work-contact">
        <SectionHeader
          kicker="Sales"
          title="People who need contacting"
          subtitle="Leads you own with a follow-up due, or that have gone quiet. Each row says why it's here."
          right={<span style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>{work.contactable.length} waiting</span>}
        />
        {work.contactable.length === 0 ? (
          <EmptyState
            icon="☎"
            title="Nobody is waiting on you"
            body="Every lead you own has been contacted recently and none has a follow-up due. New ones show up here the day they land."
          />
        ) : (
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            {work.contactable.map((l, i) => (
              <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderTop: i ? "1px solid var(--line)" : "none", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{l.name || l.company || "Unnamed lead"}</span>
                    <Pill tone={l.urgency === 0 ? "#b42318" : l.urgency === 1 ? "#b54708" : "var(--ink-dim)"}
                          bg={l.urgency === 0 ? "#fef3f2" : l.urgency === 1 ? "#fffaeb" : "var(--bg-3)"}>
                      {l.reason.toUpperCase()}
                    </Pill>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-dim)", marginTop: 3, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {l.company && l.name && <><span>{l.company}</span><span>·</span></>}
                    <span>{LEAD_STAGE_LABELS[l.stage] || l.stage}</span>
                    {l.phone && <><span>·</span><span>{l.phone}</span></>}
                    {l.email && <><span>·</span><span>{l.email}</span></>}
                    {l.last_touch && <><span>·</span><span>last touched {timeAgo(l.last_touch)}</span></>}
                  </div>
                  {l.follow_up_note && (
                    <div style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 4, fontStyle: "italic" }}>{l.follow_up_note}</div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {l.phone && <a className="btn btn-sm" style={{ textDecoration: "none" }} href={`tel:${l.phone.replace(/[^\d+]/g, "")}`}>Call</a>}
                  {l.email && <a className="btn btn-sm" style={{ textDecoration: "none" }} href={`mailto:${l.email}`}>Email</a>}
                  <button className="btn btn-sm btn-primary" onClick={() => openContact(l)}>Log it</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>)}

      {/* ---------------- REMINDERS ---------------- */}
      {tab === "reminders" && (<div id="work-reminders">
        <SectionHeader
          kicker="Follow-ups"
          title="Reminders"
          subtitle="Things you told yourself to do. Anything dated today or earlier counts against the number at the top."
        />
        {openReminders.length === 0 ? (
          <EmptyState
            icon="⏰"
            title="No open reminders"
            body="Set one for anything you'd otherwise keep in your head."
            action={<button className="btn btn-primary" onClick={() => setRemOpen(true)}>+ New reminder</button>}
          />
        ) : (
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            {openReminders.map((r, i) => {
              const ms = Date.parse(r.due_at);
              const late = ms < new Date().setHours(0, 0, 0, 0);
              const dueToday = !late && ms <= new Date().setHours(23, 59, 59, 999);
              return (
                <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: i ? "1px solid var(--line)" : "none", flexWrap: "wrap" }}>
                  <button
                    onClick={() => tickReminder(r)}
                    title="Tick off"
                    style={{
                      width: 20, height: 20, flex: "0 0 auto", borderRadius: 5, cursor: "pointer",
                      border: "1.5px solid var(--rule)", background: "white",
                    }}
                  />
                  <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, color: "var(--ink)" }}>{r.body}</div>
                    <div style={{ fontSize: 11.5, marginTop: 3, color: late ? "#b42318" : dueToday ? "#b54708" : "var(--ink-dim)", fontWeight: late || dueToday ? 700 : 400 }}>
                      {dueLabel(ms)}
                      {" · "}
                      {new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button className="btn btn-sm" onClick={() => pushReminder(r, 1)}>+1 day</button>
                    <button className="btn btn-sm" onClick={() => pushReminder(r, 7)}>+1 week</button>
                    <button className="btn btn-sm" onClick={() => removeReminder(r)}>Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>)}

      {/* ---------------- TICKETS ---------------- */}
      {tab === "tickets" && (
        <div id="work-tickets">
          <SectionHeader kicker="Support" title="Tickets on you" subtitle="Open tickets assigned to you. The full desk is on the Tickets page." />
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            {work.tickets.map((t, i) => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: i ? "1px solid var(--line)" : "none", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{t.subject}</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-dim)", marginTop: 3 }}>
                    {t.requester_name || t.requester_email || "unknown"} · {t.status} · {t.priority} · opened {timeAgo(t.created_at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- NOTES ---------------- */}
      {tab === "notes" && (<div id="work-notes">
        <SectionHeader
          kicker="Notepad"
          title="Your notes"
          subtitle="Private to you — nobody else on the team can read these, not even an owner. Write anything you'd otherwise lose."
        />
        {notes.length === 0 ? (
          <EmptyState
            icon="✎"
            title="Nothing written down yet"
            body="Logins go in Bitwarden, not here. This is for the rest of it — what broke, what someone said, what to check tomorrow."
            action={<button className="btn btn-primary" onClick={() => setNoteOpen(true)}>+ New note</button>}
          />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
            {notes.map((n) => (
              <div key={n.id} className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", minWidth: 0 }}>
                    {n.title || <span style={{ color: "var(--ink-dim)", fontWeight: 400 }}>Untitled</span>}
                  </div>
                  <button
                    onClick={() => togglePin(n)}
                    title={n.pinned ? "Unpin" : "Pin to the top"}
                    style={{ border: 0, background: "none", cursor: "pointer", fontSize: 13, color: n.pinned ? "var(--accent-deep)" : "var(--ink-dim)", flex: "0 0 auto" }}
                  >
                    {n.pinned ? "★" : "☆"}
                  </button>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.6, whiteSpace: "pre-wrap", flex: 1 }}>{n.body}</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
                  <span style={{ fontSize: 10.5, color: "var(--ink-dim)", fontFamily: "var(--mono)" }}>{timeAgo(n.updated_at || n.created_at)}</span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-sm" onClick={() => { setNoteDraft({ id: n.id, title: n.title || "", body: n.body }); setNoteOpen(true); }}>Edit</button>
                    <button className="btn btn-sm" onClick={() => removeNote(n)}>Delete</button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>)}

      {/* ---------------- MODALS ---------------- */}
      <Modal
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        kicker="Notepad"
        title={noteDraft.id ? "Edit note" : "New note"}
        footer={<>
          <button className="btn" onClick={() => setNoteOpen(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveNote}>Save note</button>
        </>}
      >
        <Field label="Title" hint="Optional — leave it blank for a quick scribble.">
          <TextInput value={noteDraft.title} onChange={(e) => setNoteDraft({ ...noteDraft, title: e.target.value })} placeholder="What this is about" />
        </Field>
        <Field label="Note" hint="Never put a password in here. Bitwarden link only.">
          <TextArea rows={8} value={noteDraft.body} onChange={(e) => setNoteDraft({ ...noteDraft, body: e.target.value })} placeholder="Write it down before you forget it." />
        </Field>
      </Modal>

      <Modal
        open={remOpen}
        onClose={() => setRemOpen(false)}
        kicker="Follow-ups"
        title="New reminder"
        footer={<>
          <button className="btn" onClick={() => setRemOpen(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveReminder}>Set reminder</button>
        </>}
      >
        <Field label="Remind me to">
          <TextInput value={remDraft.body} onChange={(e) => setRemDraft({ ...remDraft, body: e.target.value })} placeholder="Chase Summit Roofing on the proposal" />
        </Field>
        <Field label="When" hint="It appears on this page that morning, and counts as late the day after.">
          <TextInput type="date" value={remDraft.due} min={todayInputValue(0)} onChange={(e) => setRemDraft({ ...remDraft, due: e.target.value })} />
        </Field>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: -6 }}>
          {[["Tomorrow", 1], ["In 3 days", 3], ["Next week", 7], ["In 2 weeks", 14]].map(([label, d]) => (
            <button key={label} className="btn btn-sm" onClick={() => setRemDraft({ ...remDraft, due: todayInputValue(d) })}>{label}</button>
          ))}
        </div>
      </Modal>

      <Modal
        open={Boolean(contactOpen)}
        onClose={() => setContactOpen(null)}
        kicker="Sales"
        title={contactOpen ? `Log a contact — ${contactOpen.name || contactOpen.company}` : "Log a contact"}
        footer={<>
          <button className="btn" onClick={() => setContactOpen(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveContact}>Save</button>
        </>}
      >
        <Field label="What happened">
          <Select
            value={contactDraft.type}
            onChange={(e) => setContactDraft({ ...contactDraft, type: e.target.value })}
            options={[["call", "Call"], ["email", "Email"], ["text", "Text"], ["note", "Just a note"]]}
          />
        </Field>
        <Field label="How it went">
          <Select
            value={contactDraft.outcome}
            onChange={(e) => setContactDraft({ ...contactDraft, outcome: e.target.value })}
            options={[["talked", "Talked to them"], ["voicemail", "Left a voicemail"], ["no_answer", "No answer"], ["booked", "Booked a meeting"], ["not_interested", "Not interested"]]}
          />
        </Field>
        <Field label="Notes" hint="One or two lines. This shows on the lead's history.">
          <TextArea rows={3} value={contactDraft.body} onChange={(e) => setContactDraft({ ...contactDraft, body: e.target.value })} placeholder="What they said, what they need next." />
        </Field>
        <Field label="Move them to" hint="Leave it as it is if nothing changed.">
          <Select
            value={contactDraft.stage}
            onChange={(e) => setContactDraft({ ...contactDraft, stage: e.target.value })}
            options={Object.entries(LEAD_STAGE_LABELS)}
          />
        </Field>
        <Field label="Next follow-up" hint="Clear the date and they'll come back here once they go quiet.">
          <TextInput type="date" value={contactDraft.next} onChange={(e) => setContactDraft({ ...contactDraft, next: e.target.value })} />
        </Field>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: -6 }}>
          {[["Tomorrow", 1], ["In 3 days", 3], ["Next week", 7], ["No date", null]].map(([label, d]) => (
            <button key={label} className="btn btn-sm" onClick={() => setContactDraft({ ...contactDraft, next: d === null ? "" : todayInputValue(d) })}>{label}</button>
          ))}
        </div>
      </Modal>
    </>
  );
}
