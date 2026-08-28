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
      // Gmail's own id for the message we just sent. Discarded here until
      // Aug 27 2026 — see the note above recordSend for what that cost.
      messageId: sent.id || null,
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
 * Aug 27 2026, found by an adversarial review. This endpoint took `leadId`
 * straight from the request body and wrote `admin_leads.first_email_at` with it,
 * on the service key, which ignores row-level security completely. So a rep could
 * POST any lead id — including one another rep holds — and stamp
 * `first_email_at` on it. The `.is(null)` guard makes that ONE-SHOT AND
 * PERMANENT: there is no screen anywhere that can correct it. It then moves the
 * other rep's reply-rate denominator, strips their `never-touched` tag and starts
 * their cadence clock.
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

/* Bookkeeping after a send. Deliberately never throws: the email HAS gone out,
 * and telling someone the send failed because a status write failed would make
 * them send it twice. Failures land in the activity log instead.
 *
 * `messageId` is Gmail's own id for the message we just sent. It came back from
 * messages.send and was thrown away here until Aug 27 2026, which cost two
 * things: there was no way to tell OUR send apart from any other message on the
 * thread, and the outreach numbers have to be measured against our first send.
 *
 * THE RULE FOR EVERY "FIRST" COLUMN BELOW: only ever FILL AN EMPTY ONE. Never
 * overwrite. "First" is the entire point of the column — first_out_at is what
 * time-to-first-reply is counted from, so re-stamping it on a follow-up would
 * make every duration wrong, and a lead's first_email_at would drift forward for
 * ever until it said we had only just started talking to somebody we had been
 * chasing for a month. */
async function recordSend({ member, mailbox, threadId, messageId, to, subject, text, clientId, leadId }) {
  const admin = getAdminSupabase();
  const now = new Date().toISOString();
  let leadForFirstEmail = leadId || null;
  try {
    if (threadId) {
      const { data: existing } = await admin
        .from("admin_email_threads")
        .select("id, client_id, lead_id, first_out_at, gmail_message_id")
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
        // Fill only. See the rule above this function.
        if (messageId && !existing.gmail_message_id) patch.gmail_message_id = messageId;
        if (!existing.first_out_at) patch.first_out_at = now;
        await admin.from("admin_email_threads").update(patch).eq("id", existing.id);
        /* The lead this send belongs to may be one somebody linked on the thread
         * earlier rather than one the browser passed in. Prefer what was passed,
         * fall back to what is on the row — otherwise a reply to a thread that is
         * already linked to a person would write the send onto nobody. */
        leadForFirstEmail = leadId || existing.lead_id || null;
      } else {
        await admin.from("admin_email_threads").insert({
          mailbox,
          thread_id: threadId,
          ...common,
          client_id: clientId,
          lead_id: leadId,
          gmail_message_id: messageId || null,
          // A brand new thread row means this is the first thing we sent on it.
          first_out_at: now,
          subject: subject || "(no subject)",
          from_email: stripDisplayName(to[0] || ""),
          from_name: null,
          snippet: text.slice(0, 200),
          message_count: 1,
        });
      }
    }

    /* THE PERSON, not the thread. A lead can have several threads over months,
     * and "when did we first email this person" is a question about the person —
     * migration 0021 § 3 says why both exist.
     *
     * `.is("first_email_at", null)` does the "only if it is still empty" test
     * inside the one statement rather than reading the row first, so two sends in
     * the same second cannot overwrite each other and there is no read to get
     * out of date in between. */
    /* CHECKED BEFORE IT IS WRITTEN. See leadWeMayWrite above for the hole this
     * closes. A refusal is recorded rather than swallowed: the mail went, and
     * whoever reads the log later needs to know the send was not counted against
     * anybody. */
    const writableLead = await leadWeMayWrite(admin, member, leadForFirstEmail);
    if (leadForFirstEmail && !writableLead) {
      await admin.from("admin_activity_log").insert({
        actor: member.user.id,
        kind: "email_send_lead_refused",
        title: "Email sent, but not recorded against a contact",
        body: `The contact id on the request is not one this person may write (${String(leadForFirstEmail).slice(0, 64)}). The email went out; nothing was written on any lead.`,
      }).catch(() => {});
    }
    if (writableLead) {
      await admin
        .from("admin_leads")
        .update({ first_email_at: now })
        .eq("id", writableLead)
        .is("first_email_at", null);

      /* AND THE TOUCH ITSELF, on the person's own timeline.
       *
       * This was missing, and it made one of the Overview's own tiles a
       * permanent zero: "Emails you sent" counts `admin_lead_activity` rows of
       * type 'email', and nothing on the send path had ever written one. So
       * "People emailed" moved and "Emails you sent" did not, on the same screen,
       * with no explanation. The build spec asks for exactly this — "on send: log
       * the touch, count the email" — and it is also what resets the 14-day cold
       * clock and advances the 5-touch cadence, through the trigger in migration
       * 0009. A send that does not log a touch is a send the timers never see.
       *
       * `actor` is the real person, which is what 0001's activity policy demands
       * of a browser write and what makes the rep numbers countable. */
      const { error: touchErr } = await admin.from("admin_lead_activity").insert({
        lead_id: writableLead,
        actor: member.membership?.user_id || member.user.id,
        type: "email",
        body: `Sent from ${mailbox}${subject ? `: ${subject}` : ""}`,
      });
      if (touchErr) {
        await admin.from("admin_activity_log").insert({
          actor: member.user.id,
          kind: "email_send_touch_failed",
          title: "Email sent, touch not logged",
          body: touchErr.message.slice(0, 400),
        }).catch(() => {});
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
