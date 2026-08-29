import { useCallback, useEffect, useMemo, useState } from "react";
import { listTickets, upsertTicket, listTicketMessages, addTicketMessage, listTeam, logActivity, TICKET_STATUSES } from "../../lib/data.js";
import { apiFetch } from "../../lib/adminApi.js";
import { toast } from "../../lib/toast.js";
import {
  MetricCard, SourceBadge, Modal, Field, TextInput, TextArea, Select, EmptyState, timeAgo,
} from "./shared.jsx";
import { useScreenContext } from "../../lib/screenContext.js";

/* Tickets — the internal support desk. Tickets come in by hand today and by
 * email/platform hook later (source field is already there). Replies can be
 * AI-drafted from the Brain; a human always clicks send. */

const STATUS_TONE = {
  open: { c: "#991b1b", bg: "#fef2f2" },
  pending: { c: "#92400e", bg: "#fffbeb" },
  solved: { c: "#006b1a", bg: "var(--success-soft)" },
  closed: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
};
const PRIORITY_TONE = { urgent: "#df1b41", high: "#ff9f43", normal: "#6366f1", low: "#9eb1c7" };

/* The words for each choice in the filter, in one place, so the dropdown and
 * the empty state can never disagree about what is on screen. Aug 26 2026. */
const FILTER_LABELS = { all: "All tickets", openish: "Open + pending" };
function filterLabel(f) {
  return FILTER_LABELS[f] || f[0].toUpperCase() + f.slice(1);
}

export default function Tickets({ member }) {
  const [tickets, setTickets] = useState({ rows: [], sample: true });
  const [loadedAt, setLoadedAt] = useState(0);
  const [team, setTeam] = useState([]);
  /* Aug 26 2026 — Ryder wants the page to open on every ticket, not just the
   * live ones, so the history is there without changing the filter first. */
  const [statusFilter, setStatusFilter] = useState("all");
  const [openTicket, setOpenTicket] = useState(null);

  useScreenContext(() => ({
    page: "Tickets",
    record: openTicket ? { type: "ticket", id: openTicket.id, label: openTicket.subject } : null,
    visible: (tickets.rows || []).slice(0, 15).map((t) => `${t.status}: ${t.subject}`),
  }), [openTicket, tickets.rows]);
  const [newOpen, setNewOpen] = useState(false);

  const load = useCallback(async () => {
    const [t, tm] = await Promise.all([listTickets(), listTeam()]);
    setTickets(t);
    setLoadedAt(Date.now());
    setTeam(tm.rows);
  }, []);

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  const rows = useMemo(() => {
    if (statusFilter === "all") return tickets.rows;
    if (statusFilter === "openish") return tickets.rows.filter((t) => ["open", "pending"].includes(t.status));
    return tickets.rows.filter((t) => t.status === statusFilter);
  }, [tickets, statusFilter]);

  const counts = {
    open: tickets.rows.filter((t) => t.status === "open").length,
    pending: tickets.rows.filter((t) => t.status === "pending").length,
    solved7: tickets.rows.filter((t) => t.status === "solved" && Date.parse(t.updated_at) > loadedAt - 7 * 86400e3).length,
  };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
        <MetricCard label="Open" value={counts.open} badge={<SourceBadge mode={tickets.sample ? "sample" : "live"} />} hint="needs a first reply" />
        <MetricCard label="Pending" value={counts.pending} hint="waiting on the customer" />
        <MetricCard label="Solved · 7 days" value={counts.solved7} hint="closed out this week" />
      </div>

      <div className="card" style={{ padding: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {/* The order of these options is deliberately unchanged, so nobody has to
          * hunt for the one they always pick. "All tickets" is second in the list
          * but it is the default, and that is fine: the select is controlled by
          * statusFilter, so whatever the default is shows as chosen on the first
          * paint. Aug 26 2026 for Ryder. */}
        <select className="adm-input" style={{ width: 180 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="openish">Open + pending</option>
          <option value="all">All tickets</option>
          {TICKET_STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
        {/* The three cards above always count the whole pile, whatever the filter
          * says. This line is the one that tracks the filter, so the numbers up
          * there never look like they are lying about the table below. */}
        <span style={{ fontSize: 12, color: "var(--ink-dim)" }}>
          {rows.length} of {tickets.rows.length} {tickets.rows.length === 1 ? "ticket" : "tickets"}
          {statusFilter === "all" ? "" : ` · ${filterLabel(statusFilter)}`}
        </span>
        <div style={{ marginLeft: "auto" }}>
          <button className="btn btn-accent" onClick={() => setNewOpen(true)}>+ New ticket</button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon="🎫"
          title={tickets.rows.length === 0 ? "No tickets yet" : "Nothing in this view"}
          /* The old line here said "switch the filter to All tickets", which is a
             lie now that All tickets is what the page opens on. Say which filter
             is actually in force instead. Aug 26 2026, Ryder's ask. */
          /* There is no arm here for the All tickets filter, and there cannot be
             one: on "all", rows IS tickets.rows, so an empty rows means an empty
             pile and the first arm already covers it. Aug 26 2026 — the arm that
             used to sit here said "this should not happen" and never once ran, so
             it was a safety net that caught nothing. */
          body={tickets.rows.length === 0
            ? "Log the first one when a customer emails or messages with a problem. Later, the platform and the inbox can open tickets here automatically — the plumbing is already in place."
            : `Nothing is sitting in "${filterLabel(statusFilter)}" right now. Switch the filter to All tickets to see the ${tickets.rows.length} we do have.`}
          action={tickets.rows.length === 0 && <button className="btn btn-accent" onClick={() => setNewOpen(true)}>+ New ticket</button>}
        />
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="adm-table">
            <thead><tr><th></th><th>Ticket</th><th>Requester</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="adm-row-click" onClick={() => setOpenTicket(t)}>
                  <td style={{ width: 20 }}>
                    <span title={`${t.priority} priority`} style={{ display: "inline-block", width: 8, height: 8, borderRadius: 99, background: PRIORITY_TONE[t.priority] }} />
                  </td>
                  <td>
                    <div style={{ fontWeight: 600, color: "var(--ink)" }}>{t.subject}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-faint)", fontFamily: "var(--mono)", letterSpacing: "0.04em" }}>{(t.source || "manual").toUpperCase()}</div>
                  </td>
                  <td style={{ fontSize: 12.5 }}>
                    <div>{t.requester_name || "—"}</div>
                    <div style={{ color: "var(--ink-dim)", fontSize: 11.5 }}>{t.requester_email || ""}</div>
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 99, fontSize: 10, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em", color: STATUS_TONE[t.status].c, background: STATUS_TONE[t.status].bg }}>
                      {t.status.toUpperCase()}
                    </span>
                  </td>
                  <td style={{ whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 11 }}>{timeAgo(t.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openTicket && (
        <TicketModal
          ticket={tickets.rows.find((t) => t.id === openTicket.id) || openTicket}
          member={member}
          team={team}
          onClose={() => setOpenTicket(null)}
          reload={load}
        />
      )}
      {newOpen && <NewTicketModal member={member} onClose={() => setNewOpen(false)} reload={load} />}
    </>
  );
}

/* ------------------------------------------------------------------ */

function TicketModal({ ticket, member, onClose, reload }) {
  const [messages, setMessages] = useState(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);

  const loadMessages = useCallback(async () => {
    const m = await listTicketMessages(ticket.id);
    setMessages(m.rows);
  }, [ticket.id]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  const setStatus = async (status) => {
    const res = await upsertTicket({ id: ticket.id, status });
    if (!res.ok) { toast.error("Couldn't update status", res.error); return; }
    toast.success("Status updated", status);
    reload();
  };

  const aiDraft = async () => {
    if (!messages?.length) return;
    setDrafting(true);
    const context = `Ticket: ${ticket.subject}\nFrom: ${ticket.requester_name || "customer"} (${ticket.requester_email || "no email"})\n\n` +
      messages.map((m) => `[${m.author_kind}] ${m.body}`).join("\n\n");
    /* A ticket has no client_id column, so there is no client to send and none
     * is invented — this draft lands on Internal, honestly. The page it came
     * from is known, and that is worth sending. */
    const res = await apiFetch("/api/ai-draft", { method: "POST", body: {
      kind: "ticket_reply", context,
      surface: "tickets", entityKind: "ticket", entityId: ticket?.id || null,
    } });
    setDrafting(false);
    if (!res.ok) {
      if (res.preview) setReply("PREVIEW — with the AI key set, a support reply drafted from the ticket history and the Brain's rules appears here.");
      else toast.error("Draft failed", res.error);
      return;
    }
    setReply(res.data.text);
    toast.success("Draft ready", "Edit it, then post. Nothing is sent automatically.");
  };

  const post = async () => {
    if (!reply.trim()) { toast.warn("Write or draft the reply first"); return; }
    setBusy(true);
    const res = await addTicketMessage({ ticketId: ticket.id, authorKind: "agent", author: member.user_id, body: reply.trim() });
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't post", res.error); return; }
    await upsertTicket({ id: ticket.id, status: "pending" });
    await logActivity({ actor: member.user_id, kind: "ticket_reply", title: `Replied on ticket: ${ticket.subject}` });
    toast.success("Reply posted", "Ticket moved to Pending. Email it to the customer from the Inbox if they came in by email.");
    setReply("");
    loadMessages();
    reload();
  };

  return (
    <Modal open onClose={onClose} kicker={`TICKET · ${(ticket.source || "manual").toUpperCase()}`} title={ticket.subject} width={680}
      footer={<>
        <Select style={{ width: 130, marginRight: "auto" }} value={ticket.status} onChange={(e) => setStatus(e.target.value)}
          options={TICKET_STATUSES.map((s) => [s, s[0].toUpperCase() + s.slice(1)])} />
        <button className="btn" onClick={aiDraft} disabled={drafting || !messages}>{drafting ? "Drafting…" : "✨ Draft with AI"}</button>
        <button className="btn btn-accent" onClick={post} disabled={busy}>{busy ? "Posting…" : "Post reply"}</button>
      </>}>
      <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginBottom: 12 }}>
        {ticket.requester_name || "Unknown requester"}{ticket.requester_email ? ` · ${ticket.requester_email}` : ""} · opened {timeAgo(ticket.created_at)}
      </div>
      {!messages ? (
        <div style={{ padding: 16, textAlign: "center", color: "var(--ink-dim)", fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ maxHeight: 300, overflowY: "auto", marginBottom: 14 }}>
          {messages.map((m) => (
            <div key={m.id} className={`adm-msg ${m.author_kind === "agent" ? "agent" : m.author_kind === "ai_draft" ? "ai" : ""}`}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em", color: "var(--ink-dim)" }}>
                  {m.author_kind === "agent" ? "TEAM" : m.author_kind === "ai_draft" ? "AI DRAFT" : "CUSTOMER"}
                </span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)" }}>{timeAgo(m.created_at)}</span>
              </div>
              <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{m.body}</div>
            </div>
          ))}
        </div>
      )}
      <Field label="Reply">
        <TextArea value={reply} onChange={(e) => setReply(e.target.value)} style={{ minHeight: 110 }} placeholder="Type the reply, or click Draft with AI — you always review before it posts." />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function NewTicketModal({ member, onClose, reload }) {
  const [f, setF] = useState({ subject: "", requester_name: "", requester_email: "", priority: "normal", body: "" });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.subject.trim()) { toast.warn("Give the ticket a subject"); return; }
    if (!f.body.trim()) { toast.warn("Describe the problem in the first message"); return; }
    if (f.requester_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.requester_email)) { toast.warn("That email doesn't look right"); return; }
    setBusy(true);
    const res = await upsertTicket({
      subject: f.subject.trim(),
      requester_name: f.requester_name.trim() || null,
      requester_email: f.requester_email.trim() || null,
      priority: f.priority, status: "open", source: "manual",
    });
    if (res.ok) {
      await addTicketMessage({ ticketId: res.row.id, authorKind: "requester", author: null, body: f.body.trim() });
      await logActivity({ actor: member.user_id, kind: "ticket_opened", title: `Ticket opened: ${f.subject}` });
    }
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't create", res.error); return; }
    toast.success("Ticket created", f.subject);
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker="SUPPORT" title="New ticket" width={560}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Creating…" : "Create ticket"}</button>
      </>}>
      <Field label="Subject"><TextInput value={f.subject} onChange={set("subject")} placeholder="Audit stuck at 'measuring'" /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 130px", gap: "0 12px" }}>
        <Field label="Customer name"><TextInput value={f.requester_name} onChange={set("requester_name")} /></Field>
        <Field label="Customer email"><TextInput type="email" value={f.requester_email} onChange={set("requester_email")} /></Field>
        <Field label="Priority"><Select value={f.priority} onChange={set("priority")} options={[["urgent", "Urgent"], ["high", "High"], ["normal", "Normal"], ["low", "Low"]]} /></Field>
      </div>
      <Field label="What they reported"><TextArea value={f.body} onChange={set("body")} style={{ minHeight: 110 }} /></Field>
    </Modal>
  );
}
