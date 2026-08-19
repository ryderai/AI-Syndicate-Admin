/* GET /api/gmail-threads?account=<email>&q=<search>&max=<n>&pageToken=<t>
 *
 * Auth: any active member, for a mailbox they may work (own, or shared when
 * owner/admin — resolveMailbox decides, not this file).
 *
 * Returns the thread list Gmail has, merged with OUR bookkeeping row for each
 * thread (status, client, assignee, priority) so the page can filter and colour
 * a row without a second round trip.
 *
 * It also does the one piece of bookkeeping that must not depend on a browser
 * being open: if a tracked thread has a NEW inbound message since we last saw
 * it, its status flips back to "Needs reply". Statuses that a person set to
 * "No reply needed" are left alone on purpose — that is what ignoring means.
 */

import { requireMember, getAdminSupabase } from "../lib/supabase-server.js";
import { accessTokenFromRefresh, gmailFetch } from "../lib/google-oauth.js";
import { resolveMailbox, directionOf, stripDisplayName } from "../lib/gmail-mailbox.js";

function header(headers, name) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

/** Gmail has no batch endpoint we can use here, so metadata is fetched a few at
 * a time. Sequential was ~25 round trips in a row; six at a time is roughly
 * four times quicker and stays well inside Gmail's rate limit. */
async function inChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

const REOPEN_FROM = ["waiting", "scheduled", "done"];

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const account = Array.isArray(req.query?.account) ? req.query.account[0] : req.query?.account;
  const q = Array.isArray(req.query?.q) ? req.query.q[0] : req.query?.q;
  const pageToken = Array.isArray(req.query?.pageToken) ? req.query.pageToken[0] : req.query?.pageToken;
  const max = Math.min(Math.max(Number(req.query?.max) || 25, 1), 50);

  const box = await resolveMailbox(member, account);
  if (box.error) return res.status(box.status).json({ error: box.error });

  const admin = getAdminSupabase();

  try {
    const token = await accessTokenFromRefresh(box.refreshToken);
    /* Gmail's threads.list with no query returns ALL MAIL — archived threads
     * included. That made a finished thread come back in the list forever with
     * its old status still counted. The default list is now the INBOX, which is
     * what the page claims to show. A search from the box replaces it on
     * purpose: searching should reach everything, including archived mail. */
    const params = new URLSearchParams({ maxResults: String(max) });
    params.set("q", q && q.trim() ? q.trim() : "in:inbox");
    if (pageToken) params.set("pageToken", pageToken);
    const list = await gmailFetch(token, `/threads?${params.toString()}`);
    const ids = (list.threads || []).map((t) => t.id);

    const threads = await inChunks(ids, 6, async (id) => {
      const t = await gmailFetch(
        token,
        `/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`
      );
      const msgs = t.messages || [];
      const last = msgs[msgs.length - 1];
      const first = msgs[0];
      const fromHeader = header(last?.payload?.headers, "From");
      const labelIds = [...new Set(msgs.flatMap((m) => m.labelIds || []))];
      return {
        id: t.id,
        // The subject people recognise is the one the thread started with;
        // Gmail keeps re-writing it with "Re:" on the last message.
        subject: header(first?.payload?.headers, "Subject") || header(last?.payload?.headers, "Subject") || "(no subject)",
        from: fromHeader,
        fromEmail: stripDisplayName(fromHeader),
        to: header(last?.payload?.headers, "To"),
        date: last?.internalDate ? Number(last.internalDate) : null,
        snippet: last?.snippet || "",
        messageCount: msgs.length,
        unread: msgs.some((m) => (m.labelIds || []).includes("UNREAD")),
        starred: msgs.some((m) => (m.labelIds || []).includes("STARRED")),
        inInbox: labelIds.includes("INBOX"),
        labelIds,
        lastDirection: directionOf(fromHeader, box.mailbox),
      };
    });

    /* ---- merge in our own bookkeeping ---- */
    let tracked = [];
    if (ids.length) {
      const { data, error } = await admin
        .from("admin_email_threads")
        .select("id, thread_id, status, client_id, lead_id, assigned_to, priority, notes, last_message_at, status_changed_at")
        .eq("mailbox", box.mailbox)
        .in("thread_id", ids);
      // A failed read is reported, never swallowed — a list that silently loses
      // every status reads as "nothing is tracked", which is a lie.
      if (error) {
        return res.status(500).json({ error: `Statuses could not be read: ${error.message}` });
      }
      tracked = data || [];
    }
    const byThread = new Map(tracked.map((r) => [r.thread_id, r]));

    /* ---- reopen threads that got a new inbound message ---- */
    const reopen = [];
    for (const t of threads) {
      const row = byThread.get(t.id);
      if (!row || !t.date) continue;
      const seen = row.last_message_at ? Date.parse(row.last_message_at) : 0;
      const isNewer = t.date > seen;
      if (isNewer && t.lastDirection === "in" && REOPEN_FROM.includes(row.status)) {
        row.status = "needs_reply";
        row.reopened = true;
        reopen.push({ id: row.id, status: "needs_reply", last_message_at: new Date(t.date).toISOString() });
      } else if (isNewer) {
        reopen.push({ id: row.id, last_message_at: new Date(t.date).toISOString() });
      }
    }
    if (reopen.length) {
      // These are separate statements, not one transaction: if the function dies
      // half way, some rows are flipped and some are not. That is survivable —
      // the next list load re-computes the same flips from the same comparison
      // and finishes the job. It matters that this runs SERVER-side at all, not
      // that it is atomic.
      await Promise.all(reopen.map((r) => {
        const patch = { last_message_at: r.last_message_at };
        if (r.status) { patch.status = r.status; patch.status_changed_at = new Date().toISOString(); }
        return admin.from("admin_email_threads").update(patch).eq("id", r.id);
      }));
    }

    const merged = threads.map((t) => {
      const row = byThread.get(t.id);
      return {
        ...t,
        rowId: row?.id || null,
        status: row?.status || "new",
        clientId: row?.client_id || null,
        leadId: row?.lead_id || null,
        assignedTo: row?.assigned_to || null,
        priority: row?.priority || "normal",
        threadNotes: row?.notes || null,
        reopened: Boolean(row?.reopened),
      };
    });

    await admin
      .from("admin_gmail_accounts")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("email_address", box.mailbox);

    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({
      threads: merged,
      nextPageToken: list.nextPageToken || null,
      mailbox: box.mailbox,
      viaShared: box.viaShared,
      needsReconnect: box.needsReconnect,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 502;
    return res.status(status).json({ error: `Gmail: ${err.message}` });
  }
}
