/* /api/linkedin-build-due — the hourly run that writes copy for newly paid
 * LinkedIn clients. 3 Nov 2026.
 *
 * CJ's brief, Build 1: copy is "stored as a draft in the console within
 * minutes of payment", triggered when the form is submitted AND the first
 * month is paid. The Stripe webhook (api/linkedin-stripe-webhook.js) only
 * marks the engagement paid and answers Stripe at once — a model call takes
 * 20-40 seconds, longer than a webhook should hold Stripe. This run finds
 * every engagement that is submitted + paid + has no Sequence version yet,
 * and writes one — one client per run, so a run fits its time limit.
 *
 * SCHEDULE. vercel.json runs this once a day (8:41 AM CT), which works on
 * every Vercel plan and keeps the client's 48-hour promise. The brief wants
 * "within minutes": on a Pro plan change the schedule to hourly
 * ("17 * * * *") — a Hobby plan refuses to deploy an hourly cron (3 Nov
 * check). A person can always press Generate in between.
 *
 * AUTHORISED BY CRON_SECRET, NEVER BY A SESSION (same rule as
 * api/sales-sweep.js). Sends nothing to anyone. Every model call is metered. */

import { getAdminSupabase } from "../lib/supabase-server.js";
import { draft, isAiConfigured, AI_MODEL } from "../lib/ai.js";
import { recordAiUsage } from "../lib/ai-usage.js";
import { ENGAGEMENT_COLUMNS, MAX_AUTO_ATTEMPTS, claim, release, runEngine, saveVersion, saveRevision, loadEngagement } from "../lib/linkedin-engine-server.js";
import { moveStage } from "../lib/linkedin-flow-server.js";

/* As many clients as fit: a new one is STARTED only while under 70 s have
 * passed, because one client can take up to ~230 s (two model calls of up to
 * 110 s + the website lookup) and the function's limit is 300 s. A typical
 * client is one call of 30-60 s, so a daily run clears several (3 Nov fourth
 * check: one per day let a second same-day client wait 24 h). A client that
 * fails 3 runs in a row is skipped (messages_attempts). */
const START_BUDGET_MS = 70000;
const MAX_PER_RUN = 5;

export default async function handler(req, res) {
  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "Waiting on the Supabase keys." });
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers?.authorization || "") !== `Bearer ${secret}`) return res.status(401).json({ error: "Not authorized." });
  if (!isAiConfigured()) return res.status(503).json({ error: "Waiting on ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY." });

  const { data: paid, error } = await admin
    .from("linkedin_clients")
    .select(ENGAGEMENT_COLUMNS)
    .eq("status", "submitted")
    .not("paid_at", "is", null)
    .lt("messages_attempts", MAX_AUTO_ATTEMPTS)
    .order("messages_attempts", { ascending: true })
    .order("paid_at", { ascending: true })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });

  const ids = (paid || []).map((c) => c.id);
  const { data: have } = ids.length
    ? await admin.from("linkedin_sequence_versions").select("li_client_id").in("li_client_id", ids)
    : { data: [] };
  const done = new Set((have || []).map((r) => r.li_client_id));
  const firsts = (paid || []).filter((c) => !done.has(c.id)).map((client) => ({ client, from: null }));

  /* Revisions the client asked for on the approval page (Build 4): a
   * version under client review with feedback and no newer version yet. */
  const { data: asked } = await admin.from("linkedin_sequence_versions").select("id, li_client_id, version, content, feedback").eq("status", "client_review").not("feedback", "is", null).limit(20);
  const revisions = [];
  for (const v of asked || []) {
    const { data: newer } = await admin.from("linkedin_sequence_versions").select("id").eq("li_client_id", v.li_client_id).gt("version", v.version).limit(1);
    if (newer?.length) continue;
    const client = await loadEngagement(admin, v.li_client_id).catch(() => null);
    if (client && (client.messages_attempts || 0) < MAX_AUTO_ATTEMPTS) revisions.push({ client, from: v });
  }
  /* Client feedback first: a client is waiting on it. */
  const due = [...revisions, ...firsts].slice(0, MAX_PER_RUN);

  const out = [];
  const startedAt = Date.now();
  for (const { client, from } of due) {
    if (Date.now() - startedAt > START_BUDGET_MS) { out.push({ id: client.id, result: "next_run" }); continue; }
    if (!(await claim(admin, client.id))) { out.push({ id: client.id, result: "busy" }); continue; }
    const calls = [];
    const draftFn = async (args) => { const r = await draft({ ...args, brainRows: [], personalRows: [] }); calls.push(r); return r; };
    const meter = (call, status, errorCode) => recordAiUsage(admin, {
      model: call?.model || AI_MODEL, usage: call?.usage || null, requestId: call?.requestId || null, latencyMs: call?.latencyMs || null,
      status, errorCode, feature: "outreach_draft", surface: "cron", clientId: client.client_id || null, userId: null,
      entity: { kind: "linkedin_client", id: client.id }, meta: { kind: "linkedin_sequence", ...(call ? {} : { tokensUnknown: true }) },
    });
    try {
      const result = await runEngine({ client, draftFn, current: from?.content || null, feedback: from?.feedback || "" });
      for (const c of calls) await meter(c, "ok");
      const saved = from
        ? await saveRevision(admin, { client, from, feedback: from.feedback, result })
        : await saveVersion(admin, { client, result, source: "claude" });
      await release(admin, client.id, { ok: true });
      await moveStage(admin, client.id, "building");
      out.push({ id: client.id, result: from ? "revised" : "written", version: saved.version, clean: result.clean });
    } catch (err) {
      for (const c of calls) await meter(c, "ok");
      if (!calls.length || err?.statusCode !== 500) await meter(null, "failed", String(err?.message || "unknown").slice(0, 120));
      await release(admin, client.id, { ok: false, error: err?.message });
      out.push({ id: client.id, result: "failed", error: String(err?.message || "unknown").slice(0, 200) });
    }
  }
  return res.status(200).json({ checked: (paid || []).length, revisionsAsked: revisions.length, written: out.filter((o) => ["written", "revised"].includes(o.result)).length, out });
}
