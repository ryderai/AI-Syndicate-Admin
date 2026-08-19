/* POST /api/gmail-send — send a new email or a reply from a mailbox the caller
 * may work (their own, or a shared team mailbox like growth@).
 *
 * Body: { account, to, cc?, subject, body, threadId?, inReplyTo?, references?,
 *         clientId?, leadId? }
 *   to / cc  — a string or an array. Every address is validated on its own, so
 *              a comma-joined blob can never fan an email out by accident.
 *   threadId — set on a reply, together with inReplyTo (the Message-ID header of
 *              the message being answered) so Gmail threads it properly.
 *
 * After a successful send this endpoint does the bookkeeping itself rather than
 * trusting the browser to do it: the thread is marked "Waiting on them", the
 * cached fields are refreshed, and a line goes into the activity log naming the
 * person who sent it. Close the laptop mid-send and the record is still right.
 *
 * A send from a SHARED mailbox also carries an X-AIS-Sent-By header, so months
 * later it is still possible to tell who actually wrote a reply from growth@.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { accessTokenFromRefresh, gmailFetch } from "../lib/google-oauth.js";
import {
  resolveMailbox, parseRecipients, sanitizeHeader, buildRaw, stripDisplayName,
} from "../lib/gmail-mailbox.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const body = await readJson(req);
  const box = await resolveMailbox(member, body?.account);
  if (box.error) return res.status(box.status).json({ error: box.error });

  const to = parseRecipients(body?.to);
  if (to.error) return res.status(400).json({ error: `To: ${to.error}` });
  const cc = parseRecipients(body?.cc, { allowEmpty: true });
  if (cc.error) return res.status(400).json({ error: `Cc: ${cc.error}` });

  const subject = sanitizeHeader(body?.subject);
  const text = String(body?.body || "").trim();
  const threadId = body?.threadId ? String(body.threadId) : null;
  if (!text) return res.status(400).json({ error: "The message body is empty." });

  const raw = buildRaw({
    from: box.mailbox,
    fromName: box.displayName,
    to: to.list,
    cc: cc.list,
    subject,
    text,
    inReplyTo: body?.inReplyTo,
    references: body?.references,
    sentBy: box.viaShared ? member.membership.email : null,
  });

  try {
    const token = await accessTokenFromRefresh(box.refreshToken);
    const sent = await gmailFetch(token, "/messages/send", {
      method: "POST",
      body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
    });

    await recordSend({
      member,
      mailbox: box.mailbox,
      threadId: sent.threadId || threadId,
      to: to.list,
      subject,
      text,
      clientId: body?.clientId || null,
      leadId: body?.leadId || null,
    });

    return res.status(200).json({ ok: true, id: sent.id, threadId: sent.threadId });
  } catch (err) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 502;
    return res.status(status).json({ error: `Gmail: ${err.message}` });
  }
}

/* Bookkeeping after a send. Deliberately never throws: the email HAS gone out,
 * and telling someone the send failed because a status write failed would make
 * them send it twice. Failures land in the activity log instead. */
async function recordSend({ member, mailbox, threadId, to, subject, text, clientId, leadId }) {
  const admin = getAdminSupabase();
  const now = new Date().toISOString();
  try {
    if (threadId) {
      const { data: existing } = await admin
        .from("admin_email_threads")
        .select("id, client_id, lead_id")
        .eq("mailbox", mailbox)
        .eq("thread_id", threadId)
        .maybeSingle();

      const common = {
        status: "waiting",
        status_changed_at: now,
        status_changed_by: member.user.id,
        last_message_at: now,
        last_direction: "out",
      };
      if (existing) {
        const patch = { ...common };
        // Only fill a link in, never overwrite one someone chose by hand.
        if (clientId && !existing.client_id) patch.client_id = clientId;
        if (leadId && !existing.lead_id) patch.lead_id = leadId;
        await admin.from("admin_email_threads").update(patch).eq("id", existing.id);
      } else {
        await admin.from("admin_email_threads").insert({
          mailbox,
          thread_id: threadId,
          ...common,
          client_id: clientId,
          lead_id: leadId,
          subject: subject || "(no subject)",
          from_email: stripDisplayName(to[0] || ""),
          from_name: null,
          snippet: text.slice(0, 200),
          message_count: 1,
        });
      }
    }
    await admin.from("admin_activity_log").insert({
      actor: member.user.id,
      kind: "email_sent",
      title: `Email sent from ${mailbox} to ${to.join(", ")}`,
      body: subject || null,
    });
  } catch (err) {
    await admin.from("admin_activity_log").insert({
      actor: member.user.id,
      kind: "email_send_bookkeeping_failed",
      title: `Email sent, status not saved (${mailbox})`,
      body: String(err?.message || err).slice(0, 400),
    }).catch(() => {});
  }
}
