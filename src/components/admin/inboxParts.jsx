import { useEffect, useMemo, useRef, useState } from "react";
import { Chip, Popover, Avatar, clientColor, todayISO } from "./opsCells.jsx";
import { Modal, Field, TextInput, TextArea, timeAgo } from "./shared.jsx";
import {
  EMAIL_STATUSES, EMAIL_STATUS_LABELS, EMAIL_STATUS_HELP,
  EMAIL_PRIORITIES, EMAIL_PRIORITY_LABELS,
} from "../../lib/data.js";

/* The pieces of the team inbox: the inline cells on a row, the thread view, and
 * the compose window.
 *
 * Same rule as the Operations table (opsCells.jsx): a cell never owns the value.
 * It shows what the page hands it and reports a change upward, so one failed
 * save can put the old value back everywhere at once.
 */

export const EMAIL_STATUS_COLOR = {
  new: "purple",
  needs_reply: "red",
  waiting: "yellow",
  scheduled: "blue",
  done: "green",
  ignored: "gray",
};

export const EMAIL_PRIORITY_COLOR = { high: "red", normal: "default", low: "gray" };

export function StatusChip({ status }) {
  return <Chip label={EMAIL_STATUS_LABELS[status] || status} color={EMAIL_STATUS_COLOR[status] || "default"} title={EMAIL_STATUS_HELP[status]} />;
}

/** Status picker. Unlike a plain select it shows what each status MEANS, so two
 * people cannot quietly use the same word for different things. */
export function StatusCell({ value, onChange, width = 268 }) {
  const [anchor, setAnchor] = useState(null);
  const v = value || "new";
  return (
    <>
      <button
        type="button" className="adm-db-btn" aria-haspopup="listbox"
        aria-label={`Status: ${EMAIL_STATUS_LABELS[v]} - click to change`}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        <StatusChip status={v} />
      </button>
      {anchor && (
        <Popover anchor={anchor} width={width} onClose={() => setAnchor(null)}>
          <div className="adm-db-pop-list" role="listbox">
            {EMAIL_STATUSES.map((s) => (
              <button
                key={s} type="button" role="option" aria-selected={s === v}
                className={`adm-db-pop-item stacked${s === v ? " on" : ""}`}
                onClick={() => { setAnchor(null); if (s !== v) onChange(s); }}
              >
                <span className="adm-inbox-optrow">
                  <Chip label={EMAIL_STATUS_LABELS[s]} color={EMAIL_STATUS_COLOR[s]} />
                  {s === v ? <span className="adm-db-check">OK</span> : null}
                </span>
                <span className="adm-inbox-opthelp">{EMAIL_STATUS_HELP[s]}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** Who this email is about: a client, or a lead we have not signed yet.
 *
 * The guess is OFFERED, never applied — see suggestLinkForEmail in data.js.
 * A guess that points at a LEAD is offered too: mail from someone we are still
 * selling to is exactly the mail that needs to be findable later. An earlier
 * version showed "Link Chen Dental Studio?" on the row but only had clients in
 * the menu, so the offer could not be accepted. Both are here now.
 */
export function LinkCell({ clientId, leadId, clients, leadName, suggestion, onPick, onPickLead }) {
  const [anchor, setAnchor] = useState(null);
  const current = clients.find((c) => c.id === clientId) || null;
  const offerable = suggestion && (
    (suggestion.kind === "client" && suggestion.id !== clientId) ||
    (suggestion.kind === "lead" && suggestion.id !== leadId)
  );
  const chip = current
    ? <Chip label={current.name} color={clientColor(current.name)} />
    : leadId
      ? <Chip label={`Lead: ${leadName || "unnamed"}`} color="orange" title="A lead, not a signed client yet." />
      : offerable
        ? <span className="adm-inbox-suggest">Link {suggestion.kind === "lead" ? "lead " : ""}{suggestion.name}?</span>
        : <span className="adm-db-empty">Nobody</span>;
  return (
    <>
      <button
        type="button" className="adm-db-btn" aria-haspopup="listbox"
        aria-label={current ? `Client: ${current.name} - click to change` : "Nothing linked - click to link a client or a lead"}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        {chip}
      </button>
      {anchor && (
        <Popover anchor={anchor} width={252} onClose={() => setAnchor(null)}>
          <div className="adm-db-pop-list" role="listbox">
            {offerable ? (
              <button
                type="button" className="adm-db-pop-item stacked"
                onClick={() => {
                  setAnchor(null);
                  if (suggestion.kind === "lead") onPickLead(suggestion.id);
                  else onPick(suggestion.id);
                }}
              >
                <span className="adm-inbox-optrow">
                  <Chip
                    label={suggestion.kind === "lead" ? `Lead: ${suggestion.name}` : suggestion.name}
                    color={suggestion.kind === "lead" ? "orange" : clientColor(suggestion.name)}
                  />
                  <span className="adm-db-check">Suggested</span>
                </span>
                <span className="adm-inbox-opthelp">{suggestion.why}</span>
              </button>
            ) : null}
            {clients.map((c) => (
              <button
                key={c.id} type="button" role="option" aria-selected={c.id === clientId}
                className={`adm-db-pop-item${c.id === clientId ? " on" : ""}`}
                onClick={() => { setAnchor(null); if (c.id !== clientId) onPick(c.id); }}
              >
                <Chip label={c.name} color={clientColor(c.name)} />
                {c.id === clientId ? <span className="adm-db-check">OK</span> : null}
              </button>
            ))}
            {clientId || leadId ? (
              <button
                type="button" className="adm-db-pop-item plain"
                onClick={() => { setAnchor(null); if (clientId) onPick(null); if (leadId) onPickLead(null); }}
              >
                Unlink
              </button>
            ) : null}
          </div>
        </Popover>
      )}
    </>
  );
}

export function PriorityCell({ value, onChange }) {
  const [anchor, setAnchor] = useState(null);
  const v = value || "normal";
  return (
    <>
      <button type="button" className="adm-db-btn" onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        aria-label={`Priority ${EMAIL_PRIORITY_LABELS[v]} - click to change`}>
        <Chip label={EMAIL_PRIORITY_LABELS[v]} color={EMAIL_PRIORITY_COLOR[v]} />
      </button>
      {anchor && (
        <Popover anchor={anchor} width={180} onClose={() => setAnchor(null)}>
          <div className="adm-db-pop-list" role="listbox">
            {EMAIL_PRIORITIES.map((s) => (
              <button key={s} type="button" role="option" aria-selected={s === v}
                className={`adm-db-pop-item${s === v ? " on" : ""}`}
                onClick={() => { setAnchor(null); if (s !== v) onChange(s); }}>
                <Chip label={EMAIL_PRIORITY_LABELS[s]} color={EMAIL_PRIORITY_COLOR[s]} />
                {s === v ? <span className="adm-db-check">OK</span> : null}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

export function PersonPick({ value, options, onChange }) {
  const [anchor, setAnchor] = useState(null);
  const opt = options.find((o) => o.value === value) || null;
  return (
    <>
      <button type="button" className="adm-db-btn" onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        aria-label={opt ? `Owned by ${opt.label} - click to change` : "Nobody owns this - click to assign"}>
        {opt
          ? <span className="adm-db-person"><Avatar name={opt.label} />{opt.label}</span>
          : <span className="adm-db-empty">Nobody</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div className="adm-db-pop-list" role="listbox">
            {options.map((o) => (
              <button key={String(o.value)} type="button" role="option" aria-selected={o.value === value}
                className={`adm-db-pop-item${o.value === value ? " on" : ""}`}
                onClick={() => { setAnchor(null); if (o.value !== value) onChange(o.value); }}>
                <span className="adm-db-person"><Avatar name={o.label} />{o.label}</span>
                {o.value === value ? <span className="adm-db-check">OK</span> : null}
              </button>
            ))}
            {value ? (
              <button type="button" className="adm-db-pop-item plain" onClick={() => { setAnchor(null); onChange(null); }}>
                Nobody
              </button>
            ) : null}
          </div>
        </Popover>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Reminder                                                            */
/* ------------------------------------------------------------------ */

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function nextMonday() {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** "Chase this on Thursday" as a real dated row. Picking a date also moves the
 * thread to Scheduled — the page does that, and the menu says so out loud. */
/* dueState is worked out by the page (which owns the clock) and handed in:
 *   "future"  still to come
 *   "due"     the time has passed but it is still today
 *   "late"    the day has been and gone
 * A follow-up set for today used to read "late" the moment 9am passed, which is
 * not what anyone means by late. */
export function ReminderCell({ reminder, dueState = "future", onSet, onClear, compact }) {
  const [anchor, setAnchor] = useState(null);
  const due = reminder?.due_at ? new Date(reminder.due_at) : null;
  const overdue = dueState === "due" || dueState === "late";
  return (
    <>
      <button
        type="button" className={`adm-db-btn mono${overdue ? " overdue" : ""}`}
        aria-label={due ? `Follow up ${due.toLocaleDateString()} - click to change` : "No follow-up date - click to set one"}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        {due
          ? `${due.toLocaleDateString("en-US", { month: "short", day: "numeric" })}${dueState === "due" ? " due" : dueState === "late" ? " late" : ""}`
          : <span className="adm-db-empty">{compact ? "-" : "No date"}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} width={236} onClose={() => setAnchor(null)}>
          <div className="adm-db-pop-pad">
            <div className="adm-inbox-opthelp" style={{ marginBottom: 8 }}>
              A date here becomes a real reminder on your Work page, and moves this email to Scheduled.
            </div>
            <input
              type="date" className="adm-input" defaultValue={due ? due.toISOString().slice(0, 10) : ""} autoFocus
              onChange={(e) => {
                /* Uncontrolled, and only a whole date commits: a date input reports
                 * "" on every keystroke until it is complete, and saving that wipes
                 * the field under the person typing it. */
                const v = e.target.value;
                if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
                setAnchor(null);
                onSet(v);
              }}
            />
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              <button className="btn btn-sm" onClick={() => { setAnchor(null); onSet(todayISO()); }}>Today</button>
              <button className="btn btn-sm" onClick={() => { setAnchor(null); onSet(addDays(1)); }}>Tomorrow</button>
              <button className="btn btn-sm" onClick={() => { setAnchor(null); onSet(addDays(3)); }}>In 3 days</button>
              <button className="btn btn-sm" onClick={() => { setAnchor(null); onSet(nextMonday()); }}>Monday</button>
              {reminder ? <button className="btn btn-sm" onClick={() => { setAnchor(null); onClear(); }}>Clear</button> : null}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Thread view                                                         */
/* ------------------------------------------------------------------ */

/** Everyone on the thread except us — what "Reply all" means in practice. */
function replyAudience(messages, mailbox) {
  const last = messages[messages.length - 1];
  if (!last) return { to: [], cc: [] };
  const me = String(mailbox || "").toLowerCase();
  const split = (v) => String(v || "").split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
  const addr = (v) => (v.match(/<([^<>]+)>/)?.[1] || v).trim().toLowerCase();
  const primary = last.direction === "out"
    ? split(last.to).map(addr)
    : [addr(last.replyTo || last.from)];
  const others = [...split(last.to), ...split(last.cc)]
    .map(addr)
    .filter((a) => a && a !== me && !primary.includes(a));
  return { to: [...new Set(primary.filter((a) => a && a !== me))], cc: [...new Set(others)] };
}

export function ThreadView({
  thread, mailbox, messages, loading, live, sending, drafting, savingDraft,
  clients, people, suggestion, reminder, reminderDueState, leadName,
  onClose, onStatus, onClient, onLead, onAssign, onPriority, onNotes, onReminderSet, onReminderClear,
  onSend, onSaveDraft, onAiDraft, onMarkUnread,
}) {
  const [reply, setReply] = useState("");
  const [replyAll, setReplyAll] = useState(false);
  const [draftId, setDraftId] = useState(null);
  const msgsRef = useRef(null);

  const audience = useMemo(() => replyAudience(messages || [], mailbox), [messages, mailbox]);
  const to = audience.to;
  const cc = replyAll ? audience.cc : [];

  /* Jump to the newest message by scrolling the message box ITSELF. An earlier
   * version called scrollIntoView on a marker at the bottom, which also scrolled
   * the whole modal — so the thread opened with the status strip pushed off the
   * top and the reply box off the bottom. Setting scrollTop touches one element
   * and nothing above it. */
  useEffect(() => {
    const el = msgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const last = messages?.[messages.length - 1];
  const subject = thread.subject || last?.subject || "(no subject)";

  const doAi = async () => {
    const text = await onAiDraft(messages || []);
    if (text) setReply(text);
  };

  return (
    <Modal
      open onClose={onClose} width={860}
      kicker={`${mailbox} - ${thread.messageCount || messages?.length || 1} message${(thread.messageCount || 1) === 1 ? "" : "s"}`}
      title={subject}
      footer={<>
        <button className="btn" onClick={doAi} disabled={drafting || !messages?.length}>
          {drafting ? "Drafting..." : "Draft with AI"}
        </button>
        <button className="btn" onClick={() => onSaveDraft({ to, cc, subject, body: reply, draftId }).then((id) => { if (id) setDraftId(id); })} disabled={savingDraft || !reply.trim()}>
          {savingDraft ? "Saving..." : "Save draft"}
        </button>
        <button
          className="btn btn-accent"
          onClick={() => onSend({ to, cc, subject, body: reply, inReplyTo: last?.messageIdHeader, references: last?.references, draftId })}
          disabled={sending || !reply.trim()}
        >
          {sending ? "Sending..." : replyAll && cc.length ? `Reply all (${to.length + cc.length})` : "Send reply"}
        </button>
      </>}
    >
      {/* ---- the bookkeeping strip ---- */}
      <div className="adm-inbox-strip">
        <div><span className="label">Status</span><StatusCell value={thread.status} onChange={onStatus} /></div>
        <div><span className="label">About</span>
          <LinkCell
            clientId={thread.clientId} leadId={thread.leadId} clients={clients} leadName={leadName}
            suggestion={suggestion} onPick={onClient} onPickLead={onLead}
          />
        </div>
        <div><span className="label">Owner</span><PersonPick value={thread.assignedTo} options={people} onChange={onAssign} /></div>
        <div><span className="label">Priority</span><PriorityCell value={thread.priority} onChange={onPriority} /></div>
        <div><span className="label">Follow up</span>
          <ReminderCell reminder={reminder} dueState={reminderDueState} onSet={onReminderSet} onClear={onReminderClear} />
        </div>
      </div>

      <div className="adm-inbox-actions">
        <button className="btn btn-sm" onClick={onMarkUnread} disabled={!live}>Mark unread in Gmail</button>
        <span className="adm-inbox-opthelp">
          {live
            ? "To get it out of the Gmail inbox, set the status to Done or No reply needed — archiving is what those two do."
            : "Gmail actions need a connected mailbox."}
        </span>
      </div>

      <Field label="Notes on this email (the team sees these)">
        <TextArea
          defaultValue={thread.threadNotes || ""}
          placeholder="Why it is waiting, what was promised, what to say next."
          style={{ minHeight: 60 }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (thread.threadNotes || "")) onNotes(v || null);
          }}
        />
      </Field>

      {loading ? (
        <div style={{ padding: 20, textAlign: "center", color: "var(--ink-dim)", fontSize: 13 }}>Opening the thread...</div>
      ) : !messages?.length ? (
        <div style={{ padding: 20, textAlign: "center", color: "var(--ink-dim)", fontSize: 13 }}>No messages came back for this thread.</div>
      ) : (
        <div className="adm-inbox-msgs" ref={msgsRef}>
          {messages.map((m) => (
            <div key={m.id} className={`adm-msg ${m.direction === "out" ? "agent" : ""}`}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>{m.from}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)" }}>{timeAgo(m.date)}</span>
              </div>
              {m.sentByHeader && (
                <div className="adm-inbox-opthelp" style={{ marginBottom: 6 }}>Sent from this shared mailbox by {m.sentByHeader}</div>
              )}
              <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{m.body}</div>
              {m.attachments?.length ? (
                <div className="adm-inbox-att">
                  {m.attachments.map((a) => <span key={a.filename} className="adm-inbox-attchip">{a.filename}</span>)}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="adm-inbox-replyhead">
        <span className="label" style={{ marginBottom: 0 }}>Your reply</span>
        <span className="adm-inbox-opthelp">
          To {to.join(", ") || "nobody yet"}{cc.length ? ` - cc ${cc.join(", ")}` : ""}
        </span>
        {audience.cc.length ? (
          <label className="adm-inbox-check">
            <input type="checkbox" checked={replyAll} onChange={(e) => setReplyAll(e.target.checked)} />
            Reply to everyone ({audience.cc.length} more)
          </label>
        ) : null}
      </div>
      <TextArea
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        style={{ minHeight: 130 }}
        placeholder="Write it yourself, or click Draft with AI - nothing leaves until you press Send."
      />
      {draftId && <div className="adm-inbox-opthelp" style={{ marginTop: 6 }}>Saved as a Gmail draft. It is in Gmail on your phone too.</div>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Compose                                                             */
/* ------------------------------------------------------------------ */

export function ComposeModal({ mailbox, live, clients, onClose, onSend, onSaveDraft, onAiDraft }) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [instruction, setInstruction] = useState("");
  const [clientId, setClientId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftId, setDraftId] = useState(null);

  const client = clients.find((c) => c.id === clientId) || null;

  const ai = async () => {
    setDrafting(true);
    const text = await onAiDraft(instruction, client);
    setDrafting(false);
    if (!text) return;
    const m = text.match(/^Subject:\s*(.+)\n+([\s\S]*)$/);
    if (m) { setSubject(m[1].trim()); setBody(m[2].trim()); }
    else setBody(text);
  };

  return (
    <Modal
      open onClose={onClose} width={680} kicker={`FROM ${String(mailbox || "").toUpperCase()}`} title="New email"
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={saving || !body.trim()} onClick={async () => {
          setSaving(true);
          const id = await onSaveDraft({ to, cc, subject, body, draftId, clientId });
          setSaving(false);
          if (id) setDraftId(id);
        }}>{saving ? "Saving..." : "Save draft"}</button>
        <button className="btn btn-accent" disabled={busy} onClick={async () => {
          setBusy(true);
          const ok = await onSend({ to, cc, subject, body, clientId, draftId });
          setBusy(false);
          if (ok) onClose();
        }}>{busy ? "Sending..." : "Send"}</button>
      </>}
    >
      <div className="adm-inbox-aibox">
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", marginBottom: 6 }}>Let the AI write the first draft</div>
        <div style={{ display: "flex", gap: 8 }}>
          <TextInput
            placeholder={'e.g. "Follow up with Dana about the Thursday call, friendly, 3 sentences"'}
            value={instruction} onChange={(e) => setInstruction(e.target.value)}
          />
          <button className="btn" onClick={ai} disabled={drafting || !instruction.trim()}>{drafting ? "..." : "Draft"}</button>
        </div>
      </div>
      <Field label="To" hint="One address, or several separated by commas.">
        <TextInput type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@company.com" />
      </Field>
      <Field label="Cc (optional)">
        <TextInput value={cc} onChange={(e) => setCc(e.target.value)} placeholder="someone-else@company.com" />
      </Field>
      <Field label="Subject"><TextInput value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label="Which client is this about? (optional)" hint="Links the thread and labels it in Gmail once it sends.">
        <select className="adm-input" value={clientId || ""} onChange={(e) => setClientId(e.target.value || null)}>
          <option value="">Not about a client</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Message"><TextArea value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 170 }} /></Field>
      {draftId && <div className="adm-inbox-opthelp">Saved as a Gmail draft.</div>}
      {!live && <div className="adm-inbox-opthelp">Preview mode: nothing is really sent.</div>}
      <div style={{ marginTop: 4 }}>
        <span className="label" style={{ marginBottom: 0 }}>Sending as</span>
        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>{mailbox}{client ? ` - about ${client.name}` : ""}</div>
      </div>
    </Modal>
  );
}
