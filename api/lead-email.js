/* POST /api/lead-email — draft the next email to ONE lead.
 *
 * Ryder, 31 Aug 2026: "add a row for email that drafts up an email based on
 * stage, notes, timeline and everything else thats known about the client."
 *
 * Auth: any active console member, and the lead must be one they may WORK —
 * admin_can_work_lead, the same rule migration 0020 enforces and the same one
 * canEditLead draws on screen. Body: { leadId, angle? }
 *
 * IT DRAFTS. IT NEVER SENDS. There is no send path in this file and there must
 * not be one: it returns a subject and a body to a person who reads, edits and
 * sends them. The console has had that rule written down since Aug 24 about the
 * Gmail button — "never turn the draft button into a send button" — and this is
 * the same rule about a new door.
 *
 * HOW IT STAYS HONEST, the same five steps as /api/console-report and
 * /api/rep-report, because that shape was already right:
 *   1. Every fact is read HERE, server-side, from the lead, its firm, its
 *      timeline, its tags, its proposals and the newest scan of its site.
 *   2. That fact sheet, rendered, is the ONLY thing the model is shown. No
 *      tools, no database, no other lead.
 *   3. The facts are returned next to the draft, so a rep can see what it was
 *      written from before they send it.
 *   4. With no ANTHROPIC_API_KEY it still answers — with a skeleton whose every
 *      line is read off the record.
 *   5. A draft that states a number, date or score not in the facts, promises a
 *      result, or opens with a line that gets emails deleted is THROWN AWAY,
 *      not edited. One path.
 *
 * A BOUNCED ADDRESS IS REFUSED before anything is written. canEmail() is the
 * rule; drafting to a dead inbox is work nobody can use, and it is the fastest
 * way to make a rep stop trusting the button.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { converse, isAiConfigured, AGENT_MODEL } from "../lib/ai-agent.js";
import { recordAiUsage } from "../lib/ai-usage.js";
/* ---- A NOTE FOR THE NEXT PERSON WHO ADDS AN EXPORT TO A lib/ FILE ----
 *
 * `canEmail` was added to lib/sales-rules.js the same evening as this route.
 * The dev server had already loaded that module, and Node's ESM loader caches a
 * module by URL for the life of the process — so this import threw
 * "does not provide an export named 'canEmail'" on every request, and the dev
 * API plugin turned that into a bare 500 with the reason only in the terminal.
 *
 * The vite plugin cache-busts the api/ file on its mtime and nothing else, so
 * editing THIS file does not reload its dependencies. The remedy is restarting
 * `npm run dev`. Nothing here is wrong; it just cannot be seen until then.
 *
 * It cost a debugging round. The way it was found is worth repeating: a probe
 * route that imported each dependency and printed its export list, which named
 * the stale one in a single request. */
import { canEmail } from "../lib/sales-rules.js";
import { currentTags, tagIndex } from "../lib/lead-tags.js";
import {
  assembleEmailFacts, withTimelineText, emailFactsText, emailJobFor,
  buildEmailInstruction, parseEmailDraft, checkEmailDraft,
  deterministicEmailDraft, cleanAngle, MAX_EMAIL_WORDS,
} from "../lib/lead-email.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }
  res.setHeader("Cache-Control", "private, no-store");

  try {
    return await route(req, res);
  } catch (err) {
    /* THIS ROUTE REPORTS ITS OWN FAILURE, and the try starts at the TOP.
     *
     * It started below the auth and body reads at first, and the first real
     * crash happened above it — so the handler still fell through to the dev
     * plugin's catch-all, which says only "the reason is in the terminal", and
     * on Vercel says nothing at all. A catch that does not cover the whole
     * route is a catch that reports the failures you already understand.
     *
     * The message is safe to return: these are our own table and column names,
     * the same class of string every other endpoint here hands back on a failed
     * read. No token, no row, no key. */
    return res.status(500).json({
      ok: false,
      error: `The draft could not be written: ${String(err?.message || err).slice(0, 200)}`,
    });
  }
}

async function route(req, res) {
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ ok: false, error: "Not authorized." });

  const body = await readJson(req);
  const leadId = String(body?.leadId || "").trim();
  if (!UUID.test(leadId)) return res.status(400).json({ ok: false, error: "That is not a contact id." });
  const angle = cleanAngle(body?.angle);

  const admin = getAdminSupabase();
  if (!admin) return res.status(500).json({ ok: false, error: "The server is not connected to the database." });

  const role = member.membership?.role || "sales";
  const userId = member.membership?.user_id || null;

  return run({ res, admin, member, role, userId, leadId, angle });
}

async function run({ res, admin, member, role, userId, leadId, angle }) {
  /* ---- the lead, and whether this person may work it ---- */
  const { data: lead, error: leadErr } = await admin
    .from("admin_leads").select("*").eq("id", leadId).maybeSingle();
  if (leadErr) return res.status(500).json({ ok: false, error: `Could not read that contact: ${leadErr.message}` });
  if (!lead) return res.status(404).json({ ok: false, error: "That contact does not exist." });

  /* THE ROW LOCK, SERVER-SIDE. This runs on the service key, which ignores
   * row-level security, so 0020 cannot help here — the check has to be made.
   * Same rule canEditLead draws: a rep may work their own lead or an unclaimed
   * one, and anybody who is not a rep may work anything. */
  const mayWork = role !== "sales" || lead.owner_id === userId || lead.owner_id == null;
  if (!mayWork) {
    return res.status(403).json({ ok: false, error: "Somebody else holds this contact, so it is not yours to write to." });
  }

  /* ---- the bounce gate, before any work is done ---- */
  const send = canEmail(lead);
  if (!send.allowed) {
    return res.status(400).json({ ok: false, error: send.reason, bounced: Boolean(send.bounced) });
  }

  /* ---- AND THE REPLY GATE — 2 Sep 2026 ----
   *
   * What this endpoint writes is OUTREACH: the next step of a five-touch
   * sequence, worked out from a stage and a timeline. Once somebody has
   * written back, the rules say that sequence stops (cadenceState's
   * `stop: "replied"`), and the drawer has said so in words for weeks — the
   * pre-written email is the exact thing that must not go out to them.
   *
   * It was said only on screens until today. Both screens now refuse it, and
   * so does this, because a rule enforced in the browser alone is a rule that
   * holds until somebody opens a second tab. `canEmail` is not the place for
   * it: the Contacted? picker reads that same function to log a reply a rep
   * typed themselves, which stays allowed. */
  if (lead.first_reply_at) {
    return res.status(400).json({
      ok: false, replied: true,
      error: "They have already written back. Write your reply yourself — the pre-written outreach email is not the right thing to send somebody who replied.",
    });
  }

  /* ---- everything known about them ---- */
  const [companyRes, actRes, tagRes, tagStateRes, propRes, reportRes] = await Promise.all([
    lead.company_id
      ? admin.from("admin_companies").select("*").eq("id", lead.company_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("admin_lead_activity").select("*").eq("lead_id", leadId)
      .order("created_at", { ascending: false }).limit(40),
    admin.from("admin_lead_tags").select("*").eq("active", true),
    /* ORDERED BY `at`, NOT `created_at` — that column does not exist on this
       table. 0018 named it `at` on purpose ("for this table they are the same
       thing and one name is less to get wrong") and ordering by the wrong name
       is a 500 from PostgREST, not an empty list. This whole route returned 500
       until it was corrected. */
    admin.from("admin_lead_tag_events").select("*").eq("lead_id", leadId)
      .order("at", { ascending: false }).limit(200),
    admin.from("admin_proposals").select("*").eq("lead_id", leadId)
      .order("created_at", { ascending: false }).limit(10),
    lead.company_id
      ? admin.from("admin_company_reports").select("*").eq("company_id", lead.company_id)
        .order("created_at", { ascending: false }).limit(1)
      : Promise.resolve({ data: [] }),
  ]);

  /* A READ THAT FAILED IS NOT A LEAD WITH NOTHING ON IT. The two arrive as the
   * same empty array, and an email written as though a prospect had never been
   * contacted — when in fact the timeline could not be read — is the worst
   * shape this can take. Named, and carried back to the screen. */
  const missing = [];
  if (actRes?.error) missing.push("the timeline");
  if (propRes?.error) missing.push("their proposals");
  if (tagStateRes?.error) missing.push("their tags");
  if (companyRes?.error) missing.push("the firm record");
  if (reportRes?.error) missing.push("the newest scan");

  const { data: team } = await admin.from("admin_users").select("user_id, full_name, email").eq("active", true);
  const nameOf = (id) => (team || []).find((t) => t.user_id === id)?.full_name || null;
  const me = (team || []).find((t) => t.user_id === userId) || member.membership || null;

  const { byId: tagsById } = tagIndex(tagRes?.data || []);
  const tags = currentTags(tagStateRes?.data || [], tagsById);

  const nowMs = Date.now();
  let facts = assembleEmailFacts(lead, {
    company: companyRes?.data || null,
    activity: actRes?.data || [],
    tags,
    proposals: propRes?.data || [],
    report: (reportRes?.data || [])[0] || null,
    teamName: nameOf,
    me,
    nowMs,
  });
  facts = withTimelineText(facts, actRes?.data || [], leadId);
  const factsText = emailFactsText(facts);
  const job = emailJobFor(lead);

  /* ---- write it ---- */
  let draft = null;
  let counted = false;
  let why = null;
  let aiResult = null; let aiErr = null; let aiStatus = "ok"; let aiError = null;

  if (isAiConfigured()) {
    try {
      aiResult = await converse({
        system: [
          "You write short sales emails for AI Syndicate, an agency that helps businesses get found and quoted by AI search engines.",
          "You are given a fact sheet about ONE person and nothing else. Everything you write must be supported by it.",
          "",
          factsText,
        ].join("\n"),
        messages: [{ role: "user", content: buildEmailInstruction({ job, angle }) }],
        maxTokens: 900,
      });
      const parsed = parseEmailDraft(aiResult?.text);
      const verdict = checkEmailDraft(parsed, factsText, { words: MAX_EMAIL_WORDS });
      if (verdict.ok) {
        draft = parsed;
      } else {
        aiStatus = "rejected";
        why = verdict.why;
      }
    } catch (err) {
      aiStatus = "failed";
      aiErr = err;
      aiError = String(err?.message || "unknown").slice(0, 120);
      why = `the AI did not answer: ${err?.message || "unknown error"}`;
    }

    await recordAiUsage(admin, {
      model: AGENT_MODEL,
      usage: aiResult?.usage ?? aiErr?.partialUsage,
      requestId: aiResult?.requestId ?? aiErr?.partialRequestId,
      latencyMs: aiResult?.latencyMs ?? aiErr?.latencyMs,
      status: aiStatus,
      errorCode: aiError,
      feature: "lead_email",
      surface: "sales",
      userId,
      meta: { role, job: job.id, ...(why ? { rejected: why } : {}) },
    });
  } else {
    why = "there is no ANTHROPIC_API_KEY set, so nothing could be written";
  }

  if (!draft) {
    draft = deterministicEmailDraft(facts, { why });
    counted = true;
  }

  return res.status(200).json({
    ok: true,
    subject: draft.subject,
    body: draft.body,
    /* Said out loud rather than shipped quietly. A skeleton and a written draft
     * look similar and are not the same thing, and a rep who cannot tell them
     * apart will send the skeleton. */
    counted,
    why: counted ? why : null,
    job: { id: job.id, label: job.label, ask: job.ask },
    to: facts.person.email,
    facts: factsText,
    /* What could not be read, by name. See the note above the `missing` list. */
    missing,
  });
}
