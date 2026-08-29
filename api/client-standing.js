/* POST /api/client-standing — write (or re-write) "where this client stands".
 *
 * Auth: owner/admin. Body: { clientId }
 *
 * HOW IT STAYS HONEST
 *   1. Every fact is COUNTED here, server-side, from real rows: tasks, the
 *      weekly log, email threads, follow-ups, websites.
 *   2. Those facts, and only those facts, are what the AI is shown. It never
 *      touches the database and never sees anything it could quote from
 *      somewhere else.
 *   3. The facts are saved next to the text, so the write-up can always be
 *      checked against the same numbers it was written from.
 *   4. With no ANTHROPIC_API_KEY the endpoint still works and returns a counted
 *      version (source "counted"). No key, no excuse for an empty page.
 *
 * It never invents a task owner. The instruction forbids naming people, because
 * a report that assigns work to CJ or Andrew is not ours to write.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { draft, isAiConfigured, AI_MODEL } from "../lib/ai.js";
import { recordAiUsage } from "../lib/ai-usage.js";
import {
  assembleFacts, factsToText, deterministicStanding, parseStanding, checkStanding, STANDING_INSTRUCTION,
} from "../lib/client-standing.js";


export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  if (!["owner", "admin"].includes(member.membership.role)) {
    return res.status(403).json({ error: "Client pages are for owners and admins." });
  }

  const body = await readJson(req);
  const clientId = String(body?.clientId || "").trim();
  if (!clientId) return res.status(400).json({ error: "Missing clientId." });

  const admin = getAdminSupabase();

  const { data: client, error: clientErr } = await admin
    .from("admin_clients").select("*").eq("id", clientId).maybeSingle();
  if (clientErr) return res.status(500).json({ error: clientErr.message });
  if (!client) return res.status(404).json({ error: "That client does not exist." });

  const [tasks, weekly, sites] = await Promise.all([
    admin.from("admin_tasks").select("*").eq("client_id", clientId).limit(400),
    admin.from("admin_weekly_log").select("*").eq("client_id", clientId).limit(60),
    admin.from("admin_client_sites").select("*").eq("client_id", clientId).order("sort", { ascending: true }).limit(60),
  ]);

  const readFail = [tasks, weekly, sites].find((r) => r.error);
  if (readFail) return res.status(500).json({ error: `Could not read this client's records: ${readFail.error.message}` });

  // Emails, then the follow-ups that hang off them. Two steps because a
  // reminder points at an email row, not at a client.
  const { data: emailThreads } = await admin
    .from("admin_email_threads").select("*").eq("client_id", clientId).limit(200);
  const emailRowIds = (emailThreads || []).map((e) => e.id);
  let reminders = [];
  if (emailRowIds.length) {
    const { data } = await admin
      .from("admin_reminders").select("id, due_at, done_at, link_id")
      .eq("link_type", "email").in("link_id", emailRowIds).is("done_at", null).limit(100);
    reminders = data || [];
  }

  const facts = assembleFacts({
    client,
    tasks: tasks.data || [],
    weekly: weekly.data || [],
    emailThreads: emailThreads || [],
    sites: sites.data || [],
    reminders,
    nowMs: Date.now(),
  });

  let standing = null;
  let source = "counted";
  let usage = null;

  let rejected = null;

  if (isAiConfigured()) {
    /* Hoisted out of the try so the log below runs on EVERY path — accepted,
     * rejected, and thrown. Before this build a call was logged only when its
     * answer was used, so every rejected draft was money we spent and never
     * counted, and there was no way to know how much. */
    let aiResult = null;
    let aiStatus = "ok";
    let aiError = null;
    try {
      const brain = await admin
        .from("admin_brain").select("kind, title, body").eq("enabled", true)
        .order("created_at", { ascending: true }).limit(60);
      const factsText = factsToText(facts);
      const result = await draft({
        kind: "client_standing",
        context: `${STANDING_INSTRUCTION}\n\nFACTS:\n${factsText}`,
        brainRows: brain.data || [],
      });
      aiResult = result;
      const parsed = parseStanding(result.text);
      /* Shape is not enough. checkStanding() throws the answer away if it
       * contains a number that is not in the facts, or promise wording. A
       * rejected draft is logged with its reason so a pattern of them is
       * visible, and the counted version ships instead — the page is never
       * left empty and never shows an unbacked claim. */
      const verdict = parsed ? checkStanding(parsed, factsText) : { ok: false, why: "did not come back in the required shape" };
      if (parsed && verdict.ok) {
        standing = parsed;
        source = "written";
        usage = result.usage;
      } else {
        aiStatus = "rejected";
        rejected = verdict.why;
        await admin.from("admin_activity_log").insert({
          actor: member.user.id,
          kind: "client_standing_rejected",
          title: `AI summary rejected for ${client.name}`,
          body: `${verdict.why} — the counted version was used instead.`,
        });
      }
    } catch (err) {
      // AI down, out of credit, timed out — the counted version still ships.
      aiStatus = "failed";
      aiError = String(err?.message || "unknown").slice(0, 120);
    }

    /* One log, every path. recordAiUsage never throws — see lib/ai-usage.js. */
    await recordAiUsage(admin, {
      model: aiResult?.model || AI_MODEL,
      usage: aiResult?.usage,
      requestId: aiResult?.requestId,
      latencyMs: aiResult?.latencyMs,
      status: aiStatus,
      errorCode: aiError,
      feature: "client_standing",
      surface: "client_detail",
      clientId,
      userId: member.user.id,
      entity: { kind: "client", id: clientId },
      meta: {
        ...(rejected ? { rejected } : {}),
      },
    });
  }

  if (!standing) standing = deterministicStanding(facts);

  const at = new Date().toISOString();
  const { error: saveErr } = await admin.from("admin_clients").update({
    standing_summary: JSON.stringify(standing),
    standing_facts: facts,
    standing_at: at,
    standing_by: member.user.id,
    standing_source: source,
  }).eq("id", clientId);
  if (saveErr) {
    // Show it anyway — a failed save is not a reason to withhold the answer.
    return res.status(200).json({ standing, facts, source, at, saved: false, saveError: saveErr.message, usage, rejected });
  }

  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json({ standing, facts, source, at, saved: true, usage, rejected });
}
