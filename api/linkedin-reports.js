/* /api/linkedin-reports — the mid-month and day-30 reports (Build 5). 4 Nov 2026.
 *
 *   GET  (cron, Bearer CRON_SECRET)    writes every report that is due today or late
 *   POST { liClientId } (owner/admin)  writes any report due for one client now
 *
 * The numbers are SUMS of Julie's daily rows and the classified replies for
 * the period — never typed, never estimated. Claude adds one summary line
 * (and, on day 30, two recommendations) from those numbers only. The report
 * email is DRAFTED in the outbox with CJ cc'd; it is never sent from here —
 * the brief's auto-send at 5 pm is an open question for CJ, and until he
 * answers, a person sends. The stage moves to Report due when the day-30
 * report is written. Every model call is metered. */
import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { draft, isAiConfigured, AI_MODEL } from "../lib/ai.js";
import { recordAiUsage } from "../lib/ai-usage.js";
import { reportsDue, periodTotals, classificationCounts, buildReportPrompt, parseReportLines, reportEmail } from "../lib/linkedin-reports.js";
import { chicagoDate } from "../lib/linkedin-flow.js";
import { getSettings, moveStage } from "../lib/linkedin-flow-server.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "Waiting on the Supabase keys." });
  let member = null; let only = null;
  if (req.method === "GET") {
    const secret = process.env.CRON_SECRET;
    if (!secret || (req.headers?.authorization || "") !== `Bearer ${secret}`) return res.status(401).json({ error: "Not authorized." });
  } else if (req.method === "POST") {
    member = await requireMember(req, ["owner", "admin"]);
    if (!member) return res.status(401).json({ error: "Not authorized." });
    only = String((await readJson(req))?.liClientId || "");
    if (!UUID.test(only)) return res.status(400).json({ error: "liClientId is required." });
  } else { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed." }); }

  const today = chicagoDate();
  await admin.from("linkedin_pins").delete().lt("expires_at", new Date().toISOString());   // daily sweep of expired login codes (4 Nov check)
  let q = admin.from("linkedin_clients").select("id, company, contact_name, contact_email, client_id, flow_stage, launch_date, period_start, midmonth_due, report_due, payment_failed_at").not("launch_date", "is", null);
  if (only) q = q.eq("id", only);
  const { data: engs, error } = await q.limit(200);
  if (error) return res.status(500).json({ error: error.message });
  const settings = await getSettings(admin);
  const cc = Array.isArray(settings.report_cc) ? settings.report_cc : [];
  const out = [];

  for (const e of engs || []) {
    /* The brief: "→ Paused if the invoice fails after 3 days." */
    if (e.payment_failed_at && Date.now() - new Date(e.payment_failed_at).getTime() > 3 * 864e5 && !["paused", "churned"].includes(e.flow_stage)) {
      await moveStage(admin, e.id, "paused");
      out.push({ id: e.id, kind: "paused", saved: true });
      continue;
    }
    if (["paused", "churned"].includes(e.flow_stage)) continue;
    const { data: have } = await admin.from("linkedin_reports").select("kind").eq("li_client_id", e.id).eq("period_start", e.period_start || e.launch_date);
    for (const due of reportsDue(e, today, (have || []).map((h) => h.kind))) {
      const [{ data: daily }, { data: replies }, { data: lists }] = await Promise.all([
        admin.from("linkedin_daily_activity").select("day, connections_sent, accepted, replies, inmails").eq("li_client_id", e.id).gte("day", due.start).lte("day", due.end),
        admin.from("linkedin_responses").select("day, name, classification, reply_status").eq("li_client_id", e.id).gte("day", due.start).lte("day", due.end),
        admin.from("linkedin_searches").select("campaign_title").eq("li_client_id", e.id),
      ]);
      const { totals, leadNames } = periodTotals(daily || [], replies || [], due.start, due.end);
      let lines = { summary: "", recommendations: [] };
      if (isAiConfigured() && totals.days_logged > 0) {
        const p = buildReportPrompt(due.kind, { company: e.company, totals, counts: classificationCounts(replies || [], due.start, due.end), lists: lists || [] });
        try {
          const r = await draft({ kind: "linkedin_report", system: p.system, context: p.context, temperature: 0.3, maxTokens: 400, brainRows: [], personalRows: [] });
          await recordAiUsage(admin, { model: r.model || AI_MODEL, usage: r.usage, requestId: r.requestId, latencyMs: r.latencyMs, status: "ok", feature: "client_report", surface: member ? "api" : "cron", clientId: e.client_id || null, userId: member?.user?.id || null, entity: { kind: "linkedin_client", id: e.id }, meta: { kind: `linkedin_${due.kind}` } });
          lines = parseReportLines(r.text, due.kind);
        } catch (err) {
          await recordAiUsage(admin, { model: AI_MODEL, usage: null, status: "failed", errorCode: String(err?.message || "unknown").slice(0, 120), feature: "client_report", surface: member ? "api" : "cron", clientId: e.client_id || null, entity: { kind: "linkedin_client", id: e.id }, meta: { kind: `linkedin_${due.kind}`, tokensUnknown: true } });
        }
      }
      const internalNote = totals.days_logged === 0 ? "No activity was logged for this period, so every total is zero. Check the daily log before sending." : null;
      /* The report row FIRST: its unique key (client, kind, period) is the
       * lock, so two runs can't both draft the email (3 Nov check). */
      const { data: rep, error: e2 } = await admin.from("linkedin_reports").insert({ li_client_id: e.id, kind: due.kind, period_start: due.start, period_end: due.end, numbers: totals, lead_names: leadNames, summary: lines.summary, recommendations: lines.recommendations, internal_note: internalNote }).select("id").maybeSingle();
      if (e2) { out.push({ id: e.id, kind: due.kind, saved: false, error: e2.code === "23505" ? "already written" : e2.message }); continue; }
      const mail = reportEmail(due.kind, { contactName: e.contact_name, company: e.company, start: due.start, end: due.end, totals, leadNames, summary: lines.summary, recommendations: lines.recommendations });
      const { data: ob } = await admin.from("linkedin_outbox").insert({ li_client_id: e.id, kind: `report_${due.kind}`, to_email: e.contact_email, cc, subject: mail.subject, body_text: mail.text, internal_note: internalNote }).select("id").maybeSingle();
      if (ob?.id) await admin.from("linkedin_reports").update({ outbox_id: ob.id }).eq("id", rep.id);
      if (due.kind === "day30") await moveStage(admin, e.id, "report_due");
      out.push({ id: e.id, kind: due.kind, saved: true, internalNote });
    }
  }
  return res.status(200).json({ today, written: out.length, out });
}
