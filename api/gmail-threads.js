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
 *
 * And since Aug 27 2026 it records what happened on the outreach: the first time
 * they wrote back (first_reply_at) and whether the address bounced (bounced_at),
 * on the thread and on the person. There is NO open rate and no tracking pixel —
 * the long reason is written above the block that does the counting.
 *
 * Anything that fails after the mail list is built goes into `problems` and the
 * answer is 207. The list is the job; a bookkeeping write that did not stick is
 * worth telling somebody about, not worth an error page.
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

/* IS THIS THE POSTMAN TELLING US THE ADDRESS DOES NOT EXIST?
 *
 * A bounce arrives as an ordinary inbound email, so without this check it counts
 * as the prospect replying — the exact opposite of what happened. Every mail
 * server on earth sends these from one of two local parts, and matching on the
 * LOCAL PART rather than the domain is on purpose: the domain is whichever
 * server gave up (google.com, the client's own host, a relay in between), so a
 * domain list would be a list we had to keep adding to for ever.
 *
 * Deliberately narrow. It catches the hard bounce every mail server sends and
 * nothing else — no guessing from the subject line ("Undelivered Mail Returned
 * to Sender" is also a real thing a human being can type), and no soft-bounce
 * detection, because "their mailbox is full today" is not the same fact as "this
 * address does not exist" and must not be written into the same column. Missing
 * a bounce leaves it counted as nothing at all, which is honest; inventing one
 * would strike a real person off the list. */
const BOUNCE_LOCAL_PARTS = /^(mailer-daemon|postmaster)@/i;

function isBounceSender(fromHeader) {
  return BOUNCE_LOCAL_PARTS.test(stripDisplayName(fromHeader).toLowerCase());
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
 * DOES THIS LEAD EXIST? Returns its id, or null.
 *
 * This file needs the narrower question. What it writes — a first reply, a bounce
 * — is something that HAPPENED in a mailbox the caller has already been granted
 * (resolveMailbox), not an instruction a caller composed. Gating it on the
 * viewer's edit rights loses the observation for good, because each column is a
 * one-shot stamped only while somebody has the page open. See the long note at
 * the write itself.
 *
 * The uuid check still matters: `.eq("id", "not-a-uuid")` raises 22P02 inside a
 * try/catch and gets filed as "bookkeeping failed" while the endpoint answers 200.
 */
async function leadExists(admin, leadId) {
  const id = asUuid(leadId);
  if (!id) return null;
  const { data, error } = await admin
    .from("admin_leads").select("id").eq("id", id).maybeSingle();
  return (error || !data) ? null : data.id;
}

/* THE ROW LOCK IS NOT IN THIS FILE, AND THAT IS DELIBERATE.
 *
 * `leadWeMayWrite()` lives in api/gmail-send.js and api/gmail-drafts.js, where the
 * lead id comes from the REQUEST and has to be checked against the caller. Here
 * both writes are observations — a reply and a bounce that arrived in a mailbox
 * the caller has already been granted — so the question is only "does this lead
 * exist", answered by leadExists() above. A copy of the permission check was
 * written here first and removed: it lost the observation for good, because each
 * column is a one-shot stamped only while somebody has the page open. The long
 * note at the write says the rest. Third review, Aug 27 2026. */

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

      /* WALK EVERY MESSAGE, not just the last one. The metadata call already
       * hands back a From header per message and directionOf() already knows
       * which side each one is; before Aug 27 2026 only the last message's answer
       * was used and the rest were dropped on the floor. Two facts come out of
       * this walk and both are written to the database further down:
       *   firstInboundAt — the OLDEST message that is genuinely from them
       *   bounceAt       — when the postman told us the address does not exist */
      let firstInboundAt = null;
      let bounceAt = null;
      for (const m of msgs) {
        const mFrom = header(m.payload?.headers, "From");
        if (directionOf(mFrom, box.mailbox) !== "in") continue;
        const at = m.internalDate ? Number(m.internalDate) : null;
        if (!at) continue;
        if (isBounceSender(mFrom)) {
          if (bounceAt === null || at < bounceAt) bounceAt = at;
          continue;
        }
        if (firstInboundAt === null || at < firstInboundAt) firstInboundAt = at;
      }

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
        // Not sent to the browser to be drawn — read by the bookkeeping block
        // below. Kept on the thread object so the walk above happens once.
        firstInboundAt,
        bounceAt,
      };
    });

    /* ---- merge in our own bookkeeping ---- */
    let tracked = [];
    if (ids.length) {
      const { data, error } = await admin
        .from("admin_email_threads")
        // first_out_at / first_reply_at / bounced_at (migration 0021) are read so
        // the block further down can tell "already recorded" from "not yet", and
        // only ever fill an empty one.
        .select("id, thread_id, status, client_id, lead_id, assigned_to, priority, notes, last_message_at, status_changed_at, first_out_at, first_reply_at, bounced_at")
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

    /* ---------------- WHAT WENT OUT AND WHAT CAME BACK ----------------
     *
     * directionOf() already worked out, message by message, whether each one is
     * ours or theirs — and until Aug 27 2026 every answer but the last message's
     * was thrown away. That is the whole reply count, computed and binned. This
     * block keeps it.
     *
     * THERE IS NO OPEN RATE HERE AND NO TRACKING PIXEL, ON PURPOSE.
     * Gmail has no recipient-side "they opened it" signal, and neither does
     * anybody else. The only way that number is ever produced is a 1x1 invisible
     * image that phones home when the mail is drawn — and Apple Mail Privacy
     * Protection loads that image for EVERY recipient whether they read the mail
     * or not, while Gmail fetches it through Google's own proxy. So a pixel does
     * not measure opens; it measures which mail app somebody uses. It is not a
     * measurement and it will not be built. Ryder agreed to drop it on Aug 27
     * 2026 — see migration 0021 § 1, which says the same thing in the database.
     * If anybody ever adds one, the number must be labelled "guessed" and must
     * never be added to, averaged with, or shown beside sent / replied / bounced.
     *
     * WHAT IS COUNTED, all of it real: they wrote back, and it bounced.
     *
     * EVERY WRITE BELOW IS BEST-EFFORT AND EVERY FAILURE IS REPORTED. Same
     * pattern as the end of api/sales-score.js: the mail list is the job and it
     * has already succeeded, so a failed bookkeeping write must not turn into an
     * error page — but it must not vanish either. It goes in `problems`, the
     * status code says 207, and the page shows it. The version of this file
     * before Aug 27 discarded the result of every write in it.
     */
    const problems = [];

    for (const t of threads) {
      const row = byThread.get(t.id);
      if (!row) continue;

      /* A BOUNCE IS NOT A REPLY. It comes from mailer-daemon or postmaster, and
       * directionOf() correctly calls it "in" because it is not from our own
       * address — so without this check a dead address would be counted as the
       * prospect writing back, which is exactly backwards. It is checked FIRST
       * for that reason. */
      if (t.bounceAt && !row.bounced_at) {
        const at = new Date(t.bounceAt).toISOString();
        const { error } = await admin
          .from("admin_email_threads")
          .update({ bounced_at: at })
          .eq("id", row.id)
          .is("bounced_at", null);
        if (error) problems.push(`a bounced email was spotted on "${t.subject}" but not recorded (${error.message})`);
        /* AN OBSERVED FACT IS RECORDED WHOEVER HAPPENS TO BE LOOKING.
         *
         * The first version of this fix ran the write through leadWeMayWrite, and
         * that was wrong in a way that cost real data: `first_reply_at` and
         * `bounced_at` are only ever stamped while somebody has the Inbox open,
         * and the `.is(null)` guard makes each one a ONE-SHOT. So gating them on
         * the VIEWER's permissions meant a reply on a lead the viewer may not
         * write was never recorded on that person at all — permanently — and the
         * thread row and the lead then disagreed for ever, with the rep whose lead
         * it is silently short of a reply.
         *
         * The hole the guard was aimed at is real but it is one step earlier: a
         * rep can LINK their own thread to any lead in the company (the Inbox's
         * picker offers all of them), and then a reply lands on somebody else's
         * lead. What survives of that here: the id is validated as a uuid and the
         * lead has to exist, and the write is only ever a FIRST — it cannot
         * overwrite anything. The bounded residual risk is written down rather
         * than traded for lost measurements, and the place to close it properly is
         * the link picker. Third review, Aug 27 2026. */
        const bounceLead = await leadExists(admin, row.lead_id);
        if (row.lead_id && !bounceLead) {
          problems.push("a bounce was recorded on the thread, and not on the person: that thread points at a contact that is not on file");
        }
        if (bounceLead) {
          /* `.is(..., null)` rather than reading the row first: Postgres does the
           * "only if it is still empty" test inside the one statement, so two
           * page loads at the same second cannot overwrite each other. And a
           * bounce, like a first reply, is a FIRST — overwriting it would date it
           * to whenever somebody last opened the page. */
          const { error: le } = await admin
            .from("admin_leads")
            .update({ bounced_at: at })
            .eq("id", bounceLead)
            .is("bounced_at", null);
          if (le) problems.push(`a bounce was recorded on the thread but not on the person (${le.message})`);
        }
        continue;
      }

      /* A REPLY, and both halves of that word have to be true.
       *
       * `firstInboundAt` is the OLDEST message on this thread that is genuinely
       * from them — not the newest. The column is called first_reply_at and it is
       * what time-to-first-reply is measured from; filling it with the newest
       * inbound message would date the first reply to the latest one and make
       * every duration wrong.
       *
       * `first_out_at` HAS TO EXIST FIRST. A reply is an answer to something we
       * sent. Mail that simply arrives — a newsletter, a cold approach to us, a
       * client emailing out of the blue — is inbound, but it is not a reply, and
       * counting it would inflate the one number a rep gets judged on. So the
       * inbound message must also be dated AFTER our first send.
       *
       * The honest cost of that rule, written down so nobody is surprised by it:
       * nothing is back-filled, and `first_out_at` is only ever written by
       * api/gmail-send.js. An email a rep sends from Gmail on their phone has no
       * first_out_at here, so a reply to it is not counted. That is a known gap
       * and it under-counts rather than over-counts, which is the right way round
       * for a number somebody is measured by. */
      const sentAt = row.first_out_at ? Date.parse(row.first_out_at) : null;
      if (!row.first_reply_at && sentAt && t.firstInboundAt && t.firstInboundAt > sentAt) {
        const at = new Date(t.firstInboundAt).toISOString();
        const { error } = await admin
          .from("admin_email_threads")
          .update({ first_reply_at: at })
          .eq("id", row.id)
          .is("first_reply_at", null);
        if (error) problems.push(`a reply on "${t.subject}" was not recorded (${error.message})`);
        /* Same reasoning as the bounce above: an observation, not an instruction. */
        const replyLead = await leadExists(admin, row.lead_id);
        if (row.lead_id && !replyLead) {
          problems.push("a reply was recorded on the thread, and not on the person: that thread points at a contact that is not on file");
        }
        if (replyLead) {
          const { error: le } = await admin
            .from("admin_leads")
            .update({ first_reply_at: at })
            .eq("id", replyLead)
            .is("first_reply_at", null);
          if (le) problems.push(`a reply was recorded on the thread but not on the person (${le.message})`);
        }
      }
    }

    /* THE `user_id` FILTER IS NOT OPTIONAL, and it was missing until Aug 27 2026.
     *
     * admin_gmail_accounts is keyed (user_id, email_address) — migration 0001 —
     * so ONE address can legitimately have several rows: growth@ connected by CJ
     * and shared, and the same address connected privately by Andrew. Filtering
     * on the address alone stamped last_synced_at on every one of them, so
     * "when did this person last sync" read as whoever opened the page most
     * recently. Now it only ever touches the row belonging to the caller.
     *
     * The error is READ. It used to be discarded, so a mailbox whose sync time
     * silently stopped moving looked exactly like a mailbox nobody had opened. */
    const { error: syncErr } = await admin
      .from("admin_gmail_accounts")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("user_id", member.user.id)
      .eq("email_address", box.mailbox);
    if (syncErr) problems.push(`the "last synced" time was not saved (${syncErr.message})`);

    res.setHeader("Cache-Control", "private, no-store");
    /* 207 when the mail came through but a bookkeeping write did not. The list
     * IS correct either way, so this is honest partial success, not a failure —
     * and it never claims to be clean. Same rule as api/sales-score.js. */
    return res.status(problems.length ? 207 : 200).json({
      threads: merged,
      nextPageToken: list.nextPageToken || null,
      mailbox: box.mailbox,
      viaShared: box.viaShared,
      needsReconnect: box.needsReconnect,
      fetchedAt: new Date().toISOString(),
      problems,
    });
  } catch (err) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 502;
    return res.status(status).json({ error: `Gmail: ${err.message}` });
  }
}
