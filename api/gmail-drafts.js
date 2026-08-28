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

/* ------------------------------------------------------------------ */
/* THE ROW LOCK, IN JAVASCRIPT, BECAUSE RLS CANNOT HELP HERE           */
/* ------------------------------------------------------------------ */

/**
 * A uuid, or null. `.eq("id", "not-a-uuid")` raises 22P02 inside the try/catch
 * below and gets filed as "bookkeeping failed" while the endpoint answers 200 —
 * so a junk id was a silent no-op with a misleading log line.
 */
function asUuid(v) {
  const s = String(v || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : null;
}

/**
 * MAY THIS PERSON WRITE THIS LEAD? Returns the lead id if so, otherwise null.
 *
 * Aug 27 2026, found by an adversarial review. This is the OTHER send path — the
 * Inbox uses it whenever a Gmail draft already exists, which is the ordinary case
 * for a rep who writes, reads it back and then presses Send. It writes
 * `admin_leads.first_email_at` from a thread row's `lead_id`, on the service key,
 * which ignores row-level security completely. `.is(null)` makes that one-shot
 * and permanent: no screen can correct it.
 *
 * This is the same rule as migration 0020 and the same rule as canEditLead() on
 * the page. Three copies, and this is the one that stops a request rather than a
 * click: an owner or admin may write any lead; a rep may write one they hold or
 * one nobody holds.
 *
 * A lead id that does not exist, or one belonging to somebody else, comes back as
 * null and the caller records nothing against a person — the mail still goes,
 * because the mail is not the part that was wrong.
 */
async function leadWeMayWrite(admin, member, leadId) {
  const id = asUuid(leadId);
  if (!id) return null;
  const isAdminRole = ["owner", "admin"].includes(member.membership?.role);
  const { data, error } = await admin
    .from("admin_leads").select("id, owner_id").eq("id", id).maybeSingle();
  if (error || !data) return null;
  if (isAdminRole) return data.id;
  const me = member.membership?.user_id || member.user.id;
  return (data.owner_id === me || data.owner_id === null) ? data.id : null;
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

    /* Same bookkeeping as a direct send: the thread is now waiting on them.
     *
     * THIS IS THE SECOND SEND PATH AND IT WAS NOT COUNTING ANYTHING — Aug 27
     * 2026. Inbox.jsx sends through here, not through /api/gmail-send, whenever a
     * Gmail draft already exists, which is the ordinary case for a rep who
     * writes, reads it back and then presses Send. So the message id and
     * `first_out_at` were being recorded on one of the two paths, and a reply on
     * a thread sent through this one could never be counted — the reply detection
     * in api/gmail-threads.js needs `first_out_at` to know a send happened at all.
     * The rep's reply rate would have quietly measured the wrong half of their
     * outreach. Found by a reviewer.
     *
     * ONLY EVER FILL A NULL on a "first" column. `first` is the whole point of
     * the column: overwriting it on the second email makes time-to-reply
     * negative, and there is nowhere else the original moment is kept. */
    const admin = getAdminSupabase();
    const now = new Date().toISOString();
    const finalThread = sent.threadId || threadId;
    let leadForFirstEmail = null;
    if (finalThread) {
      const { data: existing } = await admin
        .from("admin_email_threads")
        .select("id, first_out_at, gmail_message_id, lead_id")
        .eq("mailbox", box.mailbox)
        .eq("thread_id", finalThread)
        .maybeSingle();
      const common = {
        status: "waiting", status_changed_at: now, status_changed_by: member.user.id,
        last_message_at: now, last_direction: "out",
      };
      if (existing) {
        leadForFirstEmail = existing.lead_id || null;
        const patch = { ...common };
        /* The id Gmail hands back from the send. Without it there is no way to
         * tell OUR message apart from any other on the thread, which is what a
         * reply is measured against. */
        if (!existing.gmail_message_id) patch.gmail_message_id = sent.id || null;
        if (!existing.first_out_at) patch.first_out_at = now;
        await admin.from("admin_email_threads").update(patch).eq("id", existing.id);
      } else {
        await admin.from("admin_email_threads").insert({
          mailbox: box.mailbox, thread_id: finalThread, ...common,
          gmail_message_id: sent.id || null,
          first_out_at: now,
          subject: subject || "(no subject)", from_email: to.list[0] || null,
          snippet: text.slice(0, 200), message_count: 1,
        });
      }
    }

    /* AND ON THE PERSON, not only on the thread. A lead can have several threads
     * — a new email months later, a different rep, a forwarded chain — and "when
     * did we first reach this person" is a question about the person. The `.is`
     * predicate makes "only if it is empty" one statement rather than a read and
     * a write that two sends could both win. */
    const writableLead = await leadWeMayWrite(admin, member, leadForFirstEmail);
    if (writableLead) {
      const { error: leadErr } = await admin
        .from("admin_leads")
        .update({ first_email_at: now })
        .eq("id", writableLead)
        .is("first_email_at", null);
      /* Logged, not swallowed, and not fatal: the email HAS gone out, and telling
       * somebody the send failed because a count did not save makes them send it
       * twice. */
      if (leadErr) console.error("[gmail-drafts] first_email_at not recorded:", leadErr.message);

      /* AND THE TOUCH, for the same reason as api/gmail-send.js: "Emails you
       * sent" on the rep's Overview counts admin_lead_activity rows of type
       * 'email', and this path never wrote one — so a rep who always sends from a
       * saved draft had that tile stuck at zero, and the 14-day cold clock and the
       * 5-touch cadence never saw their sends either (the trigger in 0009 runs off
       * this row). Two send paths, one behaviour. */
      const { error: touchErr } = await admin.from("admin_lead_activity").insert({
        lead_id: writableLead,
        actor: member.membership?.user_id || member.user.id,
        type: "email",
        body: `Sent from ${box.mailbox}${subject ? `: ${subject}` : ""}`,
      });
      if (touchErr) console.error("[gmail-drafts] the touch was not logged:", touchErr.message);
    } else if (leadForFirstEmail) {
      console.error("[gmail-drafts] the email went out but was not recorded against a contact: that lead is not one this person may write.");
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
