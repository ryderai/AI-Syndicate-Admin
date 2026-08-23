import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import {
  SourceBadge, EmptyState, timeAgo, useHealth, useNow, TextInput,
} from "./shared.jsx";
import { Chip, clientColor } from "./opsCells.jsx";
import {
  StatusCell, StatusChip, LinkCell, PersonPick, PriorityCell, ReminderCell,
  ThreadView, ComposeModal,
} from "./inboxParts.jsx";
import {
  listClients, listLeads, listTeam, listReminders, upsertReminder, deleteReminder,
  listEmailThreads, upsertEmailThread, sampleMailThreads, sampleThreadMessages,
  sampleAppendMessage, sampleMarkRead, suggestLinkForEmail,
  EMAIL_STATUS_LABELS,
} from "../../lib/data.js";
import { useScreenContext } from "../../lib/screenContext.js";

/* INBOX — the team mailbox.
 *
 * What it is: growth@aisyndicate.com (or anyone's own Gmail) worked inside the
 * console, with the things Gmail cannot do bolted on — a status per email, the
 * client it belongs to, who owns it, and a dated follow-up.
 *
 * THE ONE IMPORTANT IDEA
 * Gmail owns the mail. We own the bookkeeping. Those are two different reads:
 *
 *   gmailThreads  what is in the mailbox right now (or the sample mailbox)
 *   rows          our admin_email_threads records — status, client, owner
 *
 * The page merges them into ONE array (`merged`) and every count, every tab and
 * every row comes out of that array. That is deliberate: computing a count from
 * one list and the rows from another is how you end up with a tab that says
 * "3 need a reply" above a list of four. Same rule as getMyWork() on the Work
 * page and the group counts in Operations.
 *
 * Order matters when loading. /api/gmail-threads is called FIRST because that
 * endpoint does the one piece of bookkeeping a browser must not be trusted with
 * — flipping a thread back to "Needs reply" when a new message lands — and it
 * writes that to the database. Reading our rows afterwards therefore picks the
 * flip up. Reading them the other way round would show a stale status until the
 * next refresh.
 *
 * A thread that has been finished is ARCHIVED in Gmail, so it is not in the
 * inbox listing any more. Those come from `rows` alone, using the cached
 * subject/sender we saved when we still had them. That is what makes the Done
 * and Waiting views work at all.
 */

const PREVIEW_MAILBOX = "growth@aisyndicate.com";

/* Statuses that a view groups together. `match` is the only definition of what
 * a view means — the counts and the list both run through it. */
const VIEWS = [
  { id: "needs", label: "Needs reply", match: (t) => t.status === "new" || t.status === "needs_reply" },
  { id: "waiting", label: "Waiting on them", match: (t) => t.status === "waiting" },
  { id: "scheduled", label: "Scheduled", match: (t) => t.status === "scheduled" },
  { id: "done", label: "Done", match: (t) => t.status === "done" },
  { id: "ignored", label: "No reply needed", match: (t) => t.status === "ignored" },
  { id: "all", label: "Everything", match: () => true },
];

/** Our fields for a thread, defaulted for a thread nobody has touched yet. */
function ours(row) {
  return {
    rowId: row?.id || null,
    status: row?.status || "new",
    clientId: row?.client_id || null,
    leadId: row?.lead_id || null,
    assignedTo: row?.assigned_to || null,
    priority: row?.priority || "normal",
    threadNotes: row?.notes || null,
  };
}

/** A thread we track but Gmail did not hand back (archived, or on a later page),
 * rebuilt from the cached copy so it can still be listed and opened. */
function fromRow(row) {
  return {
    id: row.thread_id,
    subject: row.subject || "(no subject)",
    from: row.from_name ? `${row.from_name} <${row.from_email || ""}>` : (row.from_email || "(unknown sender)"),
    fromEmail: row.from_email || "",
    date: row.last_message_at ? Date.parse(row.last_message_at) : null,
    snippet: row.snippet || "",
    messageCount: row.message_count || 1,
    unread: false,
    starred: false,
    inInbox: false,
    lastDirection: row.last_direction || "in",
    fromCacheOnly: true,
    ...ours(row),
  };
}

function senderName(from) {
  const name = String(from || "").replace(/<.*>/, "").replace(/"/g, "").trim();
  return name || String(from || "").trim() || "(unknown sender)";
}

/** 9am local on the chosen day — a reminder at midnight reads as the day before. */
function dueAtFromDate(dateStr) {
  return new Date(`${dateStr}T09:00:00`).toISOString();
}

export default function Inbox({ member }) {
  const health = useHealth();
  const now = useNow();
  const configured = isConfigured();
  const gmailReady = Boolean(configured && health?.gmail);
  const userId = member?.user_id || null;
  const isAdminRole = ["owner", "admin"].includes(member?.role);

  const [mailboxes, setMailboxes] = useState(null); // null = still checking
  const [mailbox, setMailbox] = useState(null);
  const [gmailThreads, setGmailThreads] = useState(null); // null = loading
  const [rows, setRows] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [clients, setClients] = useState([]);
  const [leads, setLeads] = useState([]);
  const [team, setTeam] = useState([]);

  const [view, setView] = useState("needs");
  const [q, setQ] = useState("");
  const [filterClient, setFilterClient] = useState("");
  const [filterPerson, setFilterPerson] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);

  const [openId, setOpenId] = useState(null);
  const [messages, setMessages] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);

  /* Subjects and senders only — never the body of anyone's mail. The
   * assistant reads the thread's own row from the database if it needs more,
   * under the same role rules as every other page. */
  useScreenContext(() => ({
    page: "Inbox",
    label: mailbox ? `${mailbox} · "${view}" view` : "no mailbox connected",
    record: openId
      ? { type: "email thread", id: openId, label: rows.find((r) => r.id === openId)?.subject || "a thread" }
      : null,
    visible: rows.slice(0, 15).map((r) => `${r.status}: ${r.subject || "no subject"}`),
  }), [mailbox, view, openId, rows]);

  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [listError, setListError] = useState(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [pageToken, setPageToken] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  /* ---------------- reference data ---------------- */
  const loadRefs = useCallback(async () => {
    const [c, l, t, r] = await Promise.all([
      listClients(), listLeads(), listTeam(), listReminders(userId),
    ]);
    setClients(c.rows || []);
    setLeads(l.rows || []);
    setTeam((t.rows || []).filter((m) => m.active !== false));
    setReminders((r.rows || []).filter((x) => x.link_type === "email"));
  }, [userId]);

  useEffect(() => { loadRefs(); }, [loadRefs]);

  /* ---------------- mailboxes ---------------- */
  const loadMailboxes = useCallback(async () => {
    if (!gmailReady) {
      setMailboxes([{ email_address: PREVIEW_MAILBOX, shared: true, mine: true, needs_reconnect: false, sample: true }]);
      setMailbox(PREVIEW_MAILBOX);
      return;
    }
    const res = await apiFetch("/api/gmail-accounts");
    if (!res.ok) { setMailboxes([]); toast.error("Could not check the mailboxes", res.error); return; }
    const list = res.data.mailboxes || res.data.accounts || [];
    setMailboxes(list);
    setMailbox((cur) => (cur && list.some((m) => m.email_address === cur) ? cur : (list[0]?.email_address || null)));
  }, [gmailReady]);

  useEffect(() => { if (health) loadMailboxes(); }, [health, loadMailboxes]);

  /* ---------------- the two reads ---------------- */
  const loadRows = useCallback(async (box) => {
    if (!box) return;
    const res = await listEmailThreads({ mailbox: box });
    // A failed read is shown, never swallowed: a list with every status missing
    // looks exactly like "nothing is tracked", which would be a lie.
    if (res.error) { setListError(`Statuses could not be read: ${res.error}`); return; }
    setRows(res.rows || []);
  }, []);

  const loadThreads = useCallback(async (box, { search } = {}) => {
    if (!box) return;
    setListError(null);
    setGmailThreads(null);
    setPageToken(null);
    if (!gmailReady) {
      setGmailThreads(sampleMailThreads({ q: search }));
      await loadRows(box);
      return;
    }
    const params = new URLSearchParams({ account: box });
    if (search?.trim()) params.set("q", search.trim());
    const res = await apiFetch(`/api/gmail-threads?${params.toString()}`);
    if (!res.ok) {
      setGmailThreads([]);
      setListError(res.error);
      // The Done and Waiting views still work off our own rows, so keep going.
      await loadRows(box);
      return;
    }
    setGmailThreads(res.data.threads || []);
    setPageToken(res.data.nextPageToken || null);
    setNeedsReconnect(Boolean(res.data.needsReconnect));
    await loadRows(box);
  }, [gmailReady, loadRows]);

  useEffect(() => { if (mailbox) loadThreads(mailbox, { search: "" }); }, [mailbox, loadThreads]);

  useEffect(() => {
    const onRefresh = () => { if (mailbox) loadThreads(mailbox, { search: q }); };
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [mailbox, q, loadThreads]);

  const loadMore = async () => {
    if (!pageToken || !mailbox) return;
    setLoadingMore(true);
    const params = new URLSearchParams({ account: mailbox, pageToken });
    if (q.trim()) params.set("q", q.trim());
    const res = await apiFetch(`/api/gmail-threads?${params.toString()}`);
    setLoadingMore(false);
    if (!res.ok) { toast.error("Could not load more", res.error); return; }
    setGmailThreads((cur) => [...(cur || []), ...(res.data.threads || [])]);
    setPageToken(res.data.nextPageToken || null);
    await loadRows(mailbox);
  };

  /* Handle the ?gmail=connected bounce-back from the OAuth callback. */
  useEffect(() => {
    const hash = window.location.hash;
    const qIndex = hash.indexOf("?");
    if (qIndex === -1) return;
    const params = new URLSearchParams(hash.slice(qIndex + 1));
    const g = params.get("gmail");
    if (!g) return;
    if (g === "connected") toast.success("Mailbox connected", params.get("account") || "");
    else toast.error("Connecting failed", params.get("reason") || "unknown reason");
    window.history.replaceState({}, "", `${window.location.pathname}${hash.slice(0, qIndex)}`);
    loadMailboxes();
  }, [loadMailboxes]);

  /* ---------------- one array, everything comes out of it ---------------- */
  const merged = useMemo(() => {
    const byThread = new Map(rows.map((r) => [r.thread_id, r]));
    const base = (gmailThreads || []).map((t) => ({ ...t, ...ours(byThread.get(t.id)) }));
    const seen = new Set(base.map((t) => t.id));
    const archived = rows.filter((r) => !seen.has(r.thread_id)).map(fromRow);
    return [...base, ...archived].sort((a, b) => (b.date || 0) - (a.date || 0));
  }, [gmailThreads, rows]);

  /* Client / owner / unread filters are applied BEFORE the tab counts are
   * worked out, so a count can never describe a different set of rows than the
   * one on screen. */
  const filtered = useMemo(() => merged.filter((t) => {
    if (filterClient && t.clientId !== filterClient) return false;
    if (filterPerson === "me" && t.assignedTo !== userId) return false;
    if (filterPerson === "nobody" && t.assignedTo) return false;
    if (filterPerson && !["me", "nobody"].includes(filterPerson) && t.assignedTo !== filterPerson) return false;
    if (unreadOnly && !t.unread) return false;
    return true;
  }), [merged, filterClient, filterPerson, unreadOnly, userId]);

  const counts = useMemo(() => {
    const out = {};
    for (const v of VIEWS) out[v.id] = filtered.filter(v.match).length;
    return out;
  }, [filtered]);

  const activeView = VIEWS.find((v) => v.id === view) || VIEWS[0];
  const shown = useMemo(() => filtered.filter(activeView.match), [filtered, activeView]);

  const openThread = useMemo(() => merged.find((t) => t.id === openId) || null, [merged, openId]);

  const people = useMemo(
    () => team.map((m) => ({ value: m.user_id, label: m.full_name || m.email })),
    [team]
  );

  const remindersByRow = useMemo(() => {
    const map = new Map();
    for (const r of reminders) if (r.link_id && !r.done_at) map.set(r.link_id, r);
    return map;
  }, [reminders]);

  /* Follow-ups that are due now or overdue, newest first. Only mine — a
   * reminder belongs to one person, same rule as the Work page. */
  const dueFollowUps = useMemo(() => reminders
    .filter((r) => !r.done_at && now > 0 && Date.parse(r.due_at) <= now)
    .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at)),
  [reminders, now]);

  const mailboxRow = mailboxes?.find((m) => m.email_address === mailbox) || null;

  /** future / due / late for one reminder, measured against the ticking clock
   * this page owns. Cells never read the clock themselves. */
  const dueStateOf = (rem) => {
    if (!rem?.due_at || !now) return "future";
    const at = Date.parse(rem.due_at);
    if (at > now) return "future";
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    return at >= startOfToday.getTime() ? "due" : "late";
  };

  /* ---------------- writes ---------------- */

  /** Patch our row for a thread. Optimistic, and on failure it puts back ONLY
   * the fields it changed, never the whole list — someone else's edit landing
   * in between must not be undone by our failure. */
  const patchThread = useCallback(async (thread, patch) => {
    if (!mailbox) return null;
    const before = rows;
    const existing = rows.find((r) => r.thread_id === thread.id);
    if (existing) {
      setRows((cur) => cur.map((r) => (r.thread_id === thread.id ? { ...r, ...patch } : r)));
    } else {
      setRows((cur) => [...cur, {
        id: `tmp-${thread.id}`, mailbox, thread_id: thread.id, status: "new", priority: "normal",
        client_id: null, lead_id: null, assigned_to: null, notes: null,
        subject: thread.subject, from_name: senderName(thread.from), from_email: thread.fromEmail,
        snippet: thread.snippet, last_message_at: thread.date ? new Date(thread.date).toISOString() : null,
        message_count: thread.messageCount || 1, last_direction: thread.lastDirection || "in",
        ...patch,
      }]);
    }

    const res = await upsertEmailThread({
      mailbox,
      threadId: thread.id,
      patch,
      cache: {
        subject: thread.subject,
        fromName: senderName(thread.from),
        fromEmail: thread.fromEmail,
        snippet: thread.snippet,
        lastMessageAt: thread.date ? new Date(thread.date).toISOString() : null,
        messageCount: thread.messageCount,
        lastDirection: thread.lastDirection,
      },
      userId,
    });
    if (!res.ok) {
      setRows(before);
      toast.error("That did not save", res.error);
      return null;
    }
    setRows((cur) => {
      const without = cur.filter((r) => r.thread_id !== thread.id);
      return [...without, res.row];
    });
    return res.row;
  }, [mailbox, rows, userId]);

  /** Tell Gmail about it too. Never fatal: our own record is already saved, and
   * a label that did not stick is worth a warning, not a lost status. */
  const tellGmail = useCallback(async (body) => {
    if (!gmailReady || !mailbox) return;
    const res = await apiFetch("/api/gmail-modify", { method: "POST", body: { account: mailbox, ...body } });
    if (!res.ok) {
      if (res.status === 409) { setNeedsReconnect(true); toast.warn("Saved here, not in Gmail", res.error); }
      else toast.warn("Saved here, but Gmail did not update", res.error);
    }
  }, [gmailReady, mailbox]);

  /* THE ONE PLACE that decides what a status does to Gmail. Anything that wants
   * to change Gmail goes through a status, so the two can never disagree — the
   * first version had a separate "Archive in Gmail" button that moved the mail
   * and left our status untouched, which left finished threads sitting in Needs
   * reply forever. Statuses that mean "off my plate" archive; everything else
   * puts the thread back in the inbox. */
  const OUT_OF_INBOX = ["done", "ignored"];

  const gmailEffectOfStatus = (from, to) => {
    const wasOut = OUT_OF_INBOX.includes(from);
    const isOut = OUT_OF_INBOX.includes(to);
    if (isOut && !wasOut) return { done: to === "done" ? true : undefined, archive: true, markRead: true };
    if (!isOut && wasOut) return { done: from === "done" ? false : undefined, unarchive: true };
    return null;
  };

  const setStatus = async (thread, status) => {
    const from = thread.status;
    const row = await patchThread(thread, { status });
    if (!row) return;
    const effect = gmailEffectOfStatus(from, status);
    if (effect) await tellGmail({ threadId: thread.id, ...effect });
    toast.success(
      EMAIL_STATUS_LABELS[status],
      status === "done" ? "Archived in Gmail and labelled AIS/Done."
        : status === "ignored" ? "Archived in Gmail. A new message will not reopen it."
          : effect?.unarchive ? "Back in the Gmail inbox." : ""
    );
  };

  const setClient = async (thread, clientId) => {
    const row = await patchThread(thread, { client_id: clientId });
    if (!row) return;
    const name = clients.find((c) => c.id === clientId)?.name || null;
    await tellGmail({ threadId: thread.id, clientLabel: clientId ? name : null });
  };

  /* A lead link gets no Gmail label. Client labels exist so a client's whole
   * history is findable in Gmail by one search; leads move in and out too fast
   * for that to be worth a label each. */
  const setLead = (thread, leadId) => patchThread(thread, { lead_id: leadId });

  const setAssignee = (thread, id) => patchThread(thread, { assigned_to: id });
  const setPriority = (thread, p) => patchThread(thread, { priority: p });
  const setNotes = (thread, notes) => patchThread(thread, { notes });

  const setReminderFor = async (thread, dateStr) => {
    // A reminder points at our row, so the row has to exist first.
    const row = thread.rowId && !String(thread.rowId).startsWith("tmp-")
      ? rows.find((r) => r.thread_id === thread.id)
      : await patchThread(thread, {});
    const rowId = row?.id;
    if (!rowId) { toast.error("Could not save the follow-up", "The email record did not save."); return; }

    const existing = remindersByRow.get(rowId);
    const res = await upsertReminder({
      ...(existing ? { id: existing.id } : {}),
      owner_id: userId,
      created_by: userId,
      body: `Follow up on the email: ${thread.subject}`,
      due_at: dueAtFromDate(dateStr),
      link_type: "email",
      link_id: rowId,
    });
    if (!res.ok) { toast.error("Could not save the follow-up", res.error); return; }

    // Picking a date is the same act as saying "answered for now, chase it
    // later" — so the status follows, unless it is already finished.
    if (!["done", "ignored", "scheduled"].includes(thread.status)) {
      await patchThread(thread, { status: "scheduled" });
    }
    await loadRefs();
    toast.success("Follow-up set", `${new Date(dueAtFromDate(dateStr)).toLocaleDateString()} - it is on your Work page too.`);
  };

  const clearReminderFor = async (thread) => {
    const rowId = thread.rowId;
    const existing = rowId ? remindersByRow.get(rowId) : null;
    if (!existing) return;
    const res = await deleteReminder(existing.id);
    if (!res.ok) { toast.error("Could not clear it", res.error); return; }
    await loadRefs();
  };

  const finishReminder = async (rem) => {
    const res = await upsertReminder({ id: rem.id, done_at: new Date().toISOString() });
    if (!res.ok) { toast.error("Could not tick that off", res.error); return; }
    await loadRefs();
  };

  /* ---------------- opening a thread ---------------- */
  const open = async (thread) => {
    setOpenId(thread.id);
    setMessages(null);
    setThreadLoading(true);
    if (!gmailReady) {
      sampleMarkRead(thread.id);
      setGmailThreads((cur) => (cur || []).map((t) => (t.id === thread.id ? { ...t, unread: false } : t)));
      setMessages(sampleThreadMessages(thread.id));
      setThreadLoading(false);
      return;
    }
    const res = await apiFetch(`/api/gmail-thread?account=${encodeURIComponent(mailbox)}&id=${encodeURIComponent(thread.id)}&markRead=1`);
    setThreadLoading(false);
    if (!res.ok) { toast.error("Could not open the thread", res.error); setMessages([]); return; }
    setMessages(res.data.messages || []);
    setGmailThreads((cur) => (cur || []).map((t) => (t.id === thread.id ? { ...t, unread: false } : t)));
  };

  /* ---------------- AI drafting ---------------- */
  const aiReply = async (msgs) => {
    setDrafting(true);
    const thread = openThread;
    const client = clients.find((c) => c.id === thread?.clientId);
    const context = [
      client ? `This email is with our client ${client.name}${client.domain ? ` (${client.domain})` : ""}.` : null,
      thread?.threadNotes ? `Notes the team left on this thread: ${thread.threadNotes}` : null,
      (msgs || []).slice(-6).map((m) => `From: ${m.from}\n${m.body}`).join("\n\n---\n\n"),
    ].filter(Boolean).join("\n\n");
    const res = await apiFetch("/api/ai-draft", { method: "POST", body: { kind: "email_reply", context } });
    setDrafting(false);
    if (res.ok) return res.data.text;
    if (res.preview || res.status === 503) {
      return "PREVIEW - with the AI key set, a reply written in the house style (and grounded in the AI Brain) appears here for you to edit before sending.";
    }
    toast.error("The draft failed", res.error);
    return null;
  };

  const aiCompose = async (instruction, client) => {
    if (!instruction?.trim()) { toast.warn("Say what the email should do first", "One sentence is enough."); return null; }
    const context = client
      ? `${instruction}\n\nThis is for our client ${client.name}${client.domain ? ` (${client.domain})` : ""}.`
      : instruction;
    const res = await apiFetch("/api/ai-draft", { method: "POST", body: { kind: "email_new", context } });
    if (res.ok) return res.data.text;
    if (res.preview || res.status === 503) {
      return "Subject: Preview draft\n\nPREVIEW - with the AI key set, a full email written from your one-line instruction appears here.";
    }
    toast.error("The draft failed", res.error);
    return null;
  };

  /* ---------------- sending ---------------- */
  const sendReply = async ({ to, cc, subject, body, inReplyTo, references, draftId }) => {
    const thread = openThread;
    if (!thread) return;
    if (!to?.length) { toast.warn("No recipient", "This thread has no address to reply to."); return; }
    setSending(true);

    if (!gmailReady) {
      sampleAppendMessage(thread.id, { from: mailbox, fromEmail: mailbox, to: to.join(", "), body });
      await patchThread(thread, { status: "waiting" });
      setMessages(sampleThreadMessages(thread.id));
      setGmailThreads(sampleMailThreads({ q }));
      setSending(false);
      setOpenId(null);
      toast.info("Preview mode", "Nothing really went out. Live, this sends and moves the thread to Waiting on them.");
      return;
    }

    const res = draftId
      ? await apiFetch("/api/gmail-drafts", { method: "POST", body: {
          account: mailbox, action: "send", draftId, threadId: thread.id, to, cc, subject, body, inReplyTo, references,
        } })
      : await apiFetch("/api/gmail-send", { method: "POST", body: {
          account: mailbox, to, cc, subject, body, threadId: thread.id, inReplyTo, references,
          clientId: thread.clientId, leadId: thread.leadId,
        } });
    setSending(false);
    if (!res.ok) { toast.error("The send failed", res.error); return; }
    toast.success("Sent", `To ${to.join(", ")} - the thread is now Waiting on them.`);
    setOpenId(null);
    await loadThreads(mailbox, { search: q });
  };

  const saveDraft = async ({ to, cc, subject, body, draftId }) => {
    setSavingDraft(true);
    if (!gmailReady) {
      setSavingDraft(false);
      toast.info("Preview mode", "Live, this saves a real Gmail draft you can finish on your phone.");
      return null;
    }
    const res = await apiFetch("/api/gmail-drafts", { method: "POST", body: {
      account: mailbox, action: "save", draftId, threadId: openThread?.id, to, cc, subject, body,
    } });
    setSavingDraft(false);
    if (!res.ok) { toast.error("The draft did not save", res.error); return null; }
    toast.success("Draft saved in Gmail", "It is in Gmail on your phone too.");
    return res.data.draftId;
  };

  const sendNew = async ({ to, cc, subject, body, clientId, draftId }) => {
    if (!to?.trim()) { toast.warn("Who is it going to?"); return false; }
    if (!body?.trim()) { toast.warn("The email is empty"); return false; }
    if (!gmailReady) {
      toast.info("Preview mode", "Nothing really went out. Connect a mailbox to send for real.");
      return true;
    }
    const res = draftId
      ? await apiFetch("/api/gmail-drafts", { method: "POST", body: { account: mailbox, action: "send", draftId, to, cc, subject, body } })
      : await apiFetch("/api/gmail-send", { method: "POST", body: { account: mailbox, to, cc, subject, body, clientId } });
    if (!res.ok) { toast.error("The send failed", res.error); return false; }
    toast.success("Sent", `To ${to}`);
    await loadThreads(mailbox, { search: q });
    return true;
  };

  const composeSaveDraft = async ({ to, cc, subject, body, draftId }) => {
    if (!gmailReady) { toast.info("Preview mode", "Live, this saves a real Gmail draft."); return null; }
    const res = await apiFetch("/api/gmail-drafts", { method: "POST", body: {
      account: mailbox, action: "save", draftId, to, cc, subject, body,
    } });
    if (!res.ok) { toast.error("The draft did not save", res.error); return null; }
    toast.success("Draft saved in Gmail");
    return res.data.draftId;
  };

  /* ---------------- mailbox admin ---------------- */
  const connect = async () => {
    const res = await apiFetch("/api/gmail-auth-start");
    if (!res.ok) { toast.error("Could not start the Google connect", res.error); return; }
    window.location.href = res.data.authUrl;
  };

  const disconnect = async () => {
    if (!mailbox) return;
    if (!window.confirm(`Disconnect ${mailbox}? Statuses and client links stay, and reconnecting brings the mail back.`)) return;
    const res = await apiFetch(`/api/gmail-accounts?account=${encodeURIComponent(mailbox)}`, { method: "DELETE" });
    if (!res.ok) { toast.error("Could not disconnect", res.error); return; }
    toast.success("Disconnected", mailbox);
    setMailbox(null);
    loadMailboxes();
  };

  const setShared = async (shared) => {
    const res = await apiFetch("/api/gmail-accounts", { method: "PATCH", body: { account: mailbox, shared } });
    if (!res.ok) { toast.error("Could not change that", res.error); return; }
    toast.success(shared ? "Shared with the team" : "Back to private",
      shared ? "Every owner and admin can now read and reply from it." : "Only you can see it now.");
    loadMailboxes();
  };

  /* ---------------- render ---------------- */
  const leadNameFor = (leadId) => {
    const l = leads.find((x) => x.id === leadId);
    return l ? (l.company || l.name || l.email) : null;
  };

  /* No guess is offered once someone has linked it by hand. */
  const suggestionFor = (thread) => (thread && !thread.clientId && !thread.leadId
    ? suggestLinkForEmail(thread.fromEmail, clients, leads)
    : null);

  return (
    <>
      {needsReconnect && (
        <div className="adm-inbox-warn">
          <strong>This mailbox needs reconnecting once.</strong> It was connected before the console could label
          and archive mail. Disconnect it and connect it again - Google will ask for the extra permission.
          Reading and sending still work in the meantime.
        </div>
      )}

      {/* ---- mailbox bar ---- */}
      <div className="card adm-inbox-bar">
        {mailboxes === null ? (
          <span className="adm-inbox-opthelp">Checking mailboxes...</span>
        ) : mailboxes.length ? (
          <>
            <select className="adm-input" style={{ width: 262 }} value={mailbox || ""} onChange={(e) => setMailbox(e.target.value)}>
              {mailboxes.map((m) => (
                <option key={m.email_address} value={m.email_address}>
                  {m.email_address}{m.shared ? " (team)" : ""}
                </option>
              ))}
            </select>
            {gmailReady && <button className="btn" onClick={connect}>Connect another</button>}
            {gmailReady && mailboxRow?.mine && (
              <button className="btn btn-ghost" style={{ color: "var(--danger)" }} onClick={disconnect}>Disconnect</button>
            )}
            {mailboxRow?.mine && isAdminRole && (
              <label className="adm-inbox-check" title="Shared means every owner and admin can read this mailbox and reply from it. Nobody ever sees the password or the token.">
                <input
                  type="checkbox"
                  checked={Boolean(mailboxRow.shared)}
                  disabled={!gmailReady}
                  onChange={(e) => setShared(e.target.checked)}
                />
                Shared with the team
              </label>
            )}
            {mailboxRow && !mailboxRow.mine && (
              <Chip label="Team mailbox" color="blue" title="Someone else connected this and shared it with the team." />
            )}
          </>
        ) : (
          <button className="btn btn-accent" onClick={connect}>Connect a mailbox</button>
        )}

        <div style={{ flex: "1 1 220px" }}>
          <TextInput
            placeholder={gmailReady ? "Search the mailbox (Gmail search works: from:, subject:, newer_than:7d)" : "Search the sample mail"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") loadThreads(mailbox, { search: q }); }}
          />
        </div>
        <button className="btn" onClick={() => loadThreads(mailbox, { search: q })}>Search</button>
        <button className="btn btn-accent" onClick={() => setComposeOpen(true)} disabled={!mailbox}>Compose</button>
        <SourceBadge mode={gmailReady ? "live" : configured ? "waiting" : "sample"} />
      </div>

      {/* ---- follow-ups that are due ---- */}
      {dueFollowUps.length > 0 && (
        <div className="card adm-inbox-due">
          <div className="label" style={{ marginBottom: 8 }}>Follow-ups due ({dueFollowUps.length})</div>
          {dueFollowUps.map((r) => {
            const row = rows.find((x) => x.id === r.link_id);
            const thread = row ? merged.find((t) => t.id === row.thread_id) : null;
            return (
              <div key={r.id} className="adm-inbox-duerow">
                <span className="adm-inbox-duedate">{new Date(r.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                <button className="adm-inbox-duelink" onClick={() => thread && open(thread)} disabled={!thread}>
                  {row?.subject || r.body}
                </button>
                {row?.client_id && clients.find((c) => c.id === row.client_id) && (
                  <Chip label={clients.find((c) => c.id === row.client_id).name} color={clientColor(clients.find((c) => c.id === row.client_id).name)} />
                )}
                <button className="btn btn-sm" onClick={() => finishReminder(r)}>Done</button>
              </div>
            );
          })}
        </div>
      )}

      {/* ---- views ---- */}
      <div className="adm-inbox-tabs" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v.id} role="tab" aria-selected={view === v.id}
            className={`adm-inbox-tab${view === v.id ? " on" : ""}`}
            onClick={() => setView(v.id)}
          >
            {v.label}<span className="adm-inbox-tabn">{counts[v.id]}</span>
          </button>
        ))}
      </div>

      {/* ---- filters ---- */}
      <div className="card adm-inbox-filters">
        <select className="adm-input" style={{ width: 210 }} value={filterClient} onChange={(e) => setFilterClient(e.target.value)}>
          <option value="">Every client</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="adm-input" style={{ width: 190 }} value={filterPerson} onChange={(e) => setFilterPerson(e.target.value)}>
          <option value="">Anyone</option>
          <option value="me">Mine</option>
          <option value="nobody">Nobody owns it</option>
          {people.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <label className="adm-inbox-check">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          Unread only
        </label>
        <span className="adm-inbox-opthelp" style={{ marginLeft: "auto" }}>
          {shown.length} of {merged.length} {merged.length === 1 ? "thread" : "threads"}
          {view !== "all" ? ` in ${activeView.label}` : ""}
        </span>
      </div>

      {listError && (
        <div className="adm-inbox-warn">
          <strong>Gmail did not answer.</strong> {listError} Statuses below still come from our own records.
        </div>
      )}

      {/* ---- the list ---- */}
      {gmailThreads === null ? (
        <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--ink-dim)", fontSize: 13.5 }}>Loading the mail...</div>
      ) : !mailbox ? (
        <EmptyState
          icon="✉" title="No mailbox connected yet"
          body="One person connects growth@aisyndicate.com and switches Shared on. Google asks you to approve it on its own screen, and the console only ever asks to read, send, label and archive - never to delete."
          action={gmailReady ? <button className="btn btn-accent" onClick={connect}>Connect a mailbox</button> : null}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon="✉"
          title={`Nothing in ${activeView.label}`}
          body={view === "needs"
            ? "Nothing is waiting on us in this mailbox. Check Waiting on them to see what other people owe us."
            : "Try another view, clear the filters, or search the whole mailbox."}
        />
      ) : (
        <>
          <div className="card adm-inbox-list">
            <div className="adm-inbox-head">
              <span>From</span><span>Subject</span><span>Status</span><span>About</span><span>Owner</span><span>Follow up</span><span>Last</span>
            </div>
            {shown.map((t) => {
              const rem = t.rowId ? remindersByRow.get(t.rowId) : null;
              const client = clients.find((c) => c.id === t.clientId) || null;
              return (
                <div key={t.id} className={`adm-inbox-row${t.unread ? " unread" : ""}`}>
                  <button className="adm-inbox-cellbtn" onClick={() => open(t)} title={t.from}>
                    <span className="adm-inbox-sender">{senderName(t.from)}</span>
                    <span className="adm-inbox-meta">
                      {t.messageCount > 1 ? `${t.messageCount} messages` : "1 message"}
                      {t.fromCacheOnly ? " - archived" : ""}
                    </span>
                  </button>
                  <button className="adm-inbox-cellbtn" onClick={() => open(t)} title={t.subject}>
                    <span className="adm-inbox-subject">{t.subject}</span>
                    <span className="adm-inbox-snippet">{t.snippet}</span>
                  </button>
                  <div className="adm-inbox-cell"><StatusCell value={t.status} onChange={(s) => setStatus(t, s)} /></div>
                  <div className="adm-inbox-cell">
                    <LinkCell
                      clientId={t.clientId} leadId={t.leadId} clients={clients}
                      leadName={leadNameFor(t.leadId)} suggestion={suggestionFor(t)}
                      onPick={(id) => setClient(t, id)} onPickLead={(id) => setLead(t, id)}
                    />
                  </div>
                  <div className="adm-inbox-cell"><PersonPick value={t.assignedTo} options={people} onChange={(id) => setAssignee(t, id)} /></div>
                  <div className="adm-inbox-cell">
                    <ReminderCell
                      compact reminder={rem} dueState={dueStateOf(rem)}
                      onSet={(d) => setReminderFor(t, d)} onClear={() => clearReminderFor(t)}
                    />
                  </div>
                  <div className="adm-inbox-time">{timeAgo(t.date)}</div>
                  {client && <div className="adm-inbox-rowedge" style={{ background: `var(--accent-2)` }} aria-hidden="true" />}
                </div>
              );
            })}
          </div>
          {pageToken && (
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <button className="btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading..." : "Load older mail"}
              </button>
            </div>
          )}
        </>
      )}

      {openThread && (
        <ThreadView
          thread={openThread}
          mailbox={mailbox}
          messages={messages}
          loading={threadLoading}
          live={gmailReady}
          sending={sending}
          drafting={drafting}
          savingDraft={savingDraft}
          clients={clients}
          people={people}
          suggestion={suggestionFor(openThread)}
          reminder={openThread.rowId ? remindersByRow.get(openThread.rowId) : null}
          reminderDueState={dueStateOf(openThread.rowId ? remindersByRow.get(openThread.rowId) : null)}
          onClose={() => { setOpenId(null); setMessages(null); }}
          onStatus={(s) => setStatus(openThread, s)}
          onClient={(id) => setClient(openThread, id)}
          onLead={(id) => setLead(openThread, id)}
          leadName={leadNameFor(openThread.leadId)}
          onAssign={(id) => setAssignee(openThread, id)}
          onPriority={(p) => setPriority(openThread, p)}
          onNotes={(n) => setNotes(openThread, n)}
          onReminderSet={(d) => setReminderFor(openThread, d)}
          onReminderClear={() => clearReminderFor(openThread)}
          onSend={sendReply}
          onSaveDraft={saveDraft}
          onAiDraft={aiReply}
          onMarkUnread={async () => { await tellGmail({ threadId: openThread.id, markUnread: true }); toast.success("Marked unread in Gmail"); }}
        />
      )}

      {composeOpen && (
        <ComposeModal
          mailbox={mailbox}
          live={gmailReady}
          clients={clients}
          onClose={() => setComposeOpen(false)}
          onSend={sendNew}
          onSaveDraft={composeSaveDraft}
          onAiDraft={aiCompose}
        />
      )}
    </>
  );
}
