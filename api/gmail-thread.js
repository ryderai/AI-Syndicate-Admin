/* GET /api/gmail-thread?account=<email>&id=<threadId>&markRead=1
 *
 * Auth: member, for a mailbox they may work (own or shared — resolveMailbox).
 * Returns the whole thread with decoded text bodies (plain text preferred,
 * HTML stripped as a fallback) plus our own bookkeeping row for it.
 *
 * markRead=1 clears Gmail's unread flag, because opening a thread here is the
 * same act as opening it in Gmail. It is a parameter rather than automatic so
 * that a background refresh can never mark someone's mail read behind them.
 */

import { requireMember, getAdminSupabase } from "../lib/supabase-server.js";
import { accessTokenFromRefresh, gmailFetch } from "../lib/google-oauth.js";
import { resolveMailbox, directionOf, stripDisplayName } from "../lib/gmail-mailbox.js";

function header(headers, name) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function decodeB64Url(data) {
  try { return Buffer.from(data, "base64url").toString("utf8"); } catch { return ""; }
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeB64Url(payload.body.data);
  if (payload.mimeType === "text/html" && payload.body?.data) return stripHtml(decodeB64Url(payload.body.data));
  for (const part of payload.parts || []) {
    const found = extractBody(part);
    if (found) return found;
  }
  return "";
}

/** Attachment names only. The console does not download attachments in v1, but
 * "3 files attached" is the difference between a reply that makes sense and one
 * that does not. */
function attachmentsOf(payload, acc = []) {
  if (!payload) return acc;
  if (payload.filename && payload.body?.attachmentId) {
    acc.push({ filename: payload.filename, mimeType: payload.mimeType, size: payload.body.size || 0 });
  }
  for (const part of payload.parts || []) attachmentsOf(part, acc);
  return acc;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const account = Array.isArray(req.query?.account) ? req.query.account[0] : req.query?.account;
  const id = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  const markRead = String(req.query?.markRead || "") === "1";
  if (!id) return res.status(400).json({ error: "Missing id." });

  const box = await resolveMailbox(member, account);
  if (box.error) return res.status(box.status).json({ error: box.error });

  try {
    const token = await accessTokenFromRefresh(box.refreshToken);
    const t = await gmailFetch(token, `/threads/${encodeURIComponent(id)}?format=full`);
    const messages = (t.messages || []).map((m) => {
      const from = header(m.payload?.headers, "From");
      return {
        id: m.id,
        from,
        fromEmail: stripDisplayName(from),
        to: header(m.payload?.headers, "To"),
        cc: header(m.payload?.headers, "Cc"),
        replyTo: header(m.payload?.headers, "Reply-To"),
        subject: header(m.payload?.headers, "Subject"),
        date: m.internalDate ? Number(m.internalDate) : null,
        messageIdHeader: header(m.payload?.headers, "Message-ID"),
        references: header(m.payload?.headers, "References"),
        sentByHeader: header(m.payload?.headers, "X-AIS-Sent-By"),
        labelIds: m.labelIds || [],
        direction: directionOf(from, box.mailbox),
        attachments: attachmentsOf(m.payload),
        body: extractBody(m.payload).slice(0, 20000),
      };
    });

    if (markRead && messages.some((m) => m.labelIds.includes("UNREAD"))) {
      // Best effort. A thread that will not mark read is not a reason to refuse
      // to show it, and an old read-only connection cannot do this at all.
      try {
        await gmailFetch(token, `/threads/${encodeURIComponent(id)}/modify`, {
          method: "POST",
          body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
        });
      } catch { /* ignore: reported by needsReconnect instead */ }
    }

    const { data: row } = await getAdminSupabase()
      .from("admin_email_threads")
      .select("id, status, client_id, lead_id, assigned_to, priority, notes, status_changed_at")
      .eq("mailbox", box.mailbox)
      .eq("thread_id", id)
      .maybeSingle();

    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({
      id: t.id,
      messages,
      mailbox: box.mailbox,
      viaShared: box.viaShared,
      needsReconnect: box.needsReconnect,
      tracked: row || null,
    });
  } catch (err) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 502;
    return res.status(status).json({ error: `Gmail: ${err.message}` });
  }
}
