/* Gmail drafts — "edit an email and come back to it later".
 *
 * GET    /api/gmail-drafts?account=<email>            list the drafts
 * POST   /api/gmail-drafts                            save / update / send one
 * DELETE /api/gmail-drafts?account=<email>&draftId=   throw one away
 *
 * Auth: member, for a mailbox they may work (own or shared).
 *
 * A draft saved here is a REAL Gmail draft, not a copy in our database. That is
 * the whole point: half-written replies show up in Gmail on a phone, and a draft
 * finished on a phone shows up here. One place, not two.
 *
 * Body for POST:
 *   { account, action: "save" | "send", draftId?, threadId?,
 *     to, cc?, subject, body, inReplyTo?, references? }
 *   action "save" with a draftId updates that draft; without one it creates it.
 *   action "send" sends the draft (creating or updating it first), so what goes
 *   out is exactly what was on screen.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { accessTokenFromRefresh, gmailFetch } from "../lib/google-oauth.js";
import {
  resolveMailbox, parseRecipients, sanitizeHeader, buildRaw,
} from "../lib/gmail-mailbox.js";

function header(headers, name) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

export default async function handler(req, res) {
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const account = req.method === "POST"
    ? undefined // read from the body below
    : (Array.isArray(req.query?.account) ? req.query.account[0] : req.query?.account);

  if (req.method === "GET") {
    const box = await resolveMailbox(member, account);
    if (box.error) return res.status(box.status).json({ error: box.error });
    try {
      const token = await accessTokenFromRefresh(box.refreshToken);
      const list = await gmailFetch(token, "/drafts?maxResults=25");
      const drafts = [];
      for (const d of list.drafts || []) {
        const full = await gmailFetch(token, `/drafts/${encodeURIComponent(d.id)}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`);
        drafts.push({
          id: d.id,
          threadId: full.message?.threadId || null,
          to: header(full.message?.payload?.headers, "To"),
          subject: header(full.message?.payload?.headers, "Subject"),
          snippet: full.message?.snippet || "",
          date: full.message?.internalDate ? Number(full.message.internalDate) : null,
        });
      }
      res.setHeader("Cache-Control", "private, no-store");
      return res.status(200).json({ drafts, mailbox: box.mailbox });
    } catch (err) {
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 502;
      return res.status(status).json({ error: `Gmail: ${err.message}` });
    }
  }

  if (req.method === "DELETE") {
    const draftId = Array.isArray(req.query?.draftId) ? req.query.draftId[0] : req.query?.draftId;
    if (!draftId) return res.status(400).json({ error: "Missing draftId." });
    const box = await resolveMailbox(member, account);
    if (box.error) return res.status(box.status).json({ error: box.error });
    try {
      const token = await accessTokenFromRefresh(box.refreshToken);
      await gmailFetch(token, `/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
      return res.status(200).json({ ok: true });
    } catch (err) {
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 502;
      return res.status(status).json({ error: `Gmail: ${err.message}` });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed." });
  }

  /* ---- POST: save or send ---- */
  const body = await readJson(req);
  const box = await resolveMailbox(member, body?.account);
  if (box.error) return res.status(box.status).json({ error: box.error });
  if (box.needsReconnect) {
    return res.status(409).json({
      needsReconnect: true,
      error: "This mailbox was connected before drafts were supported. Disconnect it and connect it again once — Google will ask for the extra permission.",
    });
  }

  const action = body?.action === "send" ? "send" : "save";
  const draftId = body?.draftId ? String(body.draftId) : null;
  const threadId = body?.threadId ? String(body.threadId) : null;
  const subject = sanitizeHeader(body?.subject);
  const text = String(body?.body || "");

  // A draft may have no recipient yet — that is normal for a half-written email.
  // A send may not.
  const to = parseRecipients(body?.to, { allowEmpty: action === "save" });
  if (to.error) return res.status(400).json({ error: `To: ${to.error}` });
  const cc = parseRecipients(body?.cc, { allowEmpty: true });
  if (cc.error) return res.status(400).json({ error: `Cc: ${cc.error}` });
  if (action === "send" && !text.trim()) return res.status(400).json({ error: "The message body is empty." });

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
    const message = threadId ? { raw, threadId } : { raw };

    const saved = draftId
      ? await gmailFetch(token, `/drafts/${encodeURIComponent(draftId)}`, {
          method: "PUT",
          body: JSON.stringify({ id: draftId, message }),
        })
      : await gmailFetch(token, "/drafts", {
          method: "POST",
          body: JSON.stringify({ message }),
        });

    if (action === "save") {
      return res.status(200).json({
        ok: true, action: "save", draftId: saved.id, threadId: saved.message?.threadId || threadId,
      });
    }

    const sent = await gmailFetch(token, "/drafts/send", {
      method: "POST",
      body: JSON.stringify({ id: saved.id }),
    });

    // Same bookkeeping as a direct send: the thread is now waiting on them.
    const admin = getAdminSupabase();
    const now = new Date().toISOString();
    const finalThread = sent.threadId || threadId;
    if (finalThread) {
      const { data: existing } = await admin
        .from("admin_email_threads")
        .select("id")
        .eq("mailbox", box.mailbox)
        .eq("thread_id", finalThread)
        .maybeSingle();
      const common = {
        status: "waiting", status_changed_at: now, status_changed_by: member.user.id,
        last_message_at: now, last_direction: "out",
      };
      if (existing) await admin.from("admin_email_threads").update(common).eq("id", existing.id);
      else await admin.from("admin_email_threads").insert({
        mailbox: box.mailbox, thread_id: finalThread, ...common,
        subject: subject || "(no subject)", from_email: to.list[0] || null,
        snippet: text.slice(0, 200), message_count: 1,
      });
    }
    await admin.from("admin_activity_log").insert({
      actor: member.user.id,
      kind: "email_sent",
      title: `Email sent from ${box.mailbox} to ${to.list.join(", ")}`,
      body: subject || null,
    });

    return res.status(200).json({ ok: true, action: "send", id: sent.id, threadId: sent.threadId });
  } catch (err) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 502;
    return res.status(status).json({ error: `Gmail: ${err.message}` });
  }
}
