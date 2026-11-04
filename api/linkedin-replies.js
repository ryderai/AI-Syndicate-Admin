/* /api/linkedin-replies — Julie logs a prospect's reply; Claude sorts it
 * (Build 2). 4 Nov 2026.
 *
 *   POST  { liClientId, name, prospectUrl?, inbox: "Main"|"Sales Nav", message, day? }
 *         -> classified, saved on the Responses tab (linkedin_responses). A lead with
 *            confidence >= 0.6 gets a "lead alert" email DRAFTED for the client (and CJ cc'd
 *            for Interested) — never sent; it waits in the outbox for a person.
 *   PATCH { id, classification, note? }   Julie's override (the brief: "Julie reviews and can
 *         override the classification before the notification fires")
 *
 * WHO: owners, admins, and the 'linkedin' role (Julie). Every model call is
 * recorded through recordAiUsage, success or failure. */
import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { draft, isAiConfigured, AI_MODEL } from "../lib/ai.js";
import { recordAiUsage } from "../lib/ai-usage.js";
import { createHash } from "node:crypto";
import { classify, override, checkSuggested } from "../lib/linkedin-replies.js";
import { chicagoDate } from "../lib/linkedin-flow.js";
import { draftToOutbox, getSettings } from "../lib/linkedin-flow-server.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function alertIfLead(admin, client, row, notify) {
  if (!notify || row.needs_review || row.client_notified_at) return null;
  const settings = await getSettings(admin);
  const cc = notify === "client+cj" && Array.isArray(settings.report_cc) ? settings.report_cc : [];
  /* A suggested reply that fails the checker is left out of the client's
   * email rather than sent with a made-up number in it. */
  const suggestedOk = !checkSuggested(row.suggested_reply, client.answers || {}).some((i) => i.level === "block");
  const id = await draftToOutbox(admin, { client, kind: "lead_alert", cc, data: { prospect: row.name, classification: row.classification, inbox: row.inbox, message: row.message, suggested: suggestedOk ? row.suggested_reply : null, threadUrl: row.prospect_url, referredName: row.referred_name } });
  /* "client_notified_at" = the alert was DRAFTED; the outbox row shows when a person sent it. */
  if (id) await admin.from("linkedin_responses").update({ client_notified_at: new Date().toISOString(), alert_outbox_id: id }).eq("id", row.id);
  return id;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const member = await requireMember(req, ["owner", "admin", "linkedin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  const admin = getAdminSupabase();
  /* GET ?liClientId — this client's recent replies, for the review list. */
  if (req.method === "GET") {
    const id = String(req.query?.liClientId || "");
    if (!UUID.test(id)) return res.status(400).json({ error: "liClientId is required." });
    const { data, error } = await admin.from("linkedin_responses").select("id, day, name, inbox, message, classification, confidence, suggested_reply, summary, reply_status, needs_review, reactivation_date, client_notified_at").eq("li_client_id", id).order("created_at", { ascending: false }).limit(50);
    return error ? res.status(500).json({ error: error.message }) : res.status(200).json({ replies: data || [] });
  }
  const body = await readJson(req);

  if (req.method === "PATCH") {
    const id = String(body?.id || "");
    if (!UUID.test(id)) return res.status(400).json({ error: "id is required." });
    const { data: before } = await admin.from("linkedin_responses").select("reactivation_date, alert_outbox_id").eq("id", id).maybeSingle();
    const o = override(String(body?.classification || ""), chicagoDate(), before?.reactivation_date || null);
    if (!o) return res.status(400).json({ error: "Unknown classification." });
    /* Moved off "lead": withdraw an alert that is still only a draft. */
    if (!o.notify && before?.alert_outbox_id) await admin.from("linkedin_outbox").update({ status: "skipped", done_at: new Date().toISOString(), done_by: member.user.id }).eq("id", before.alert_outbox_id).eq("status", "draft");
    const { data: row, error } = await admin.from("linkedin_responses")
      .update({ classification: o.classification, reply_status: o.reply_status, status: o.reply_status, reactivation_date: o.reactivation_date, needs_review: false, override_note: body?.note ? String(body.note).slice(0, 500) : null })
      .eq("id", id).select("*").maybeSingle();
    if (error || !row) return res.status(404).json({ error: error?.message || "Reply not found." });
    const { data: client } = await admin.from("linkedin_clients").select("id, company, contact_name, contact_email, answers").eq("id", row.li_client_id).maybeSingle();
    const outboxId = client ? await alertIfLead(admin, client, row, o.notify) : null;
    return res.status(200).json({ reply: row, outboxId });
  }

  if (req.method !== "POST") { res.setHeader("Allow", "POST, PATCH"); return res.status(405).json({ error: "Method not allowed." }); }
  if (!isAiConfigured()) return res.status(503).json({ error: "Sorting replies is waiting on ANTHROPIC_API_KEY." });
  const liClientId = String(body?.liClientId || "");
  const message = String(body?.message || "").trim().slice(0, 4000);
  if (!UUID.test(liClientId) || !message) return res.status(400).json({ error: "liClientId and the reply text are required." });
  const { data: client } = await admin.from("linkedin_clients").select("id, company, contact_name, contact_email, answers, client_id").eq("id", liClientId).maybeSingle();
  if (!client) return res.status(404).json({ error: "LinkedIn client not found." });

  /* The same reply pasted twice is one row and one alert (and one bill). */
  const messageHash = createHash("sha256").update(`${String(body?.name || "").trim().toLowerCase()}|${message}`).digest("hex");
  const { data: dup } = await admin.from("linkedin_responses").select("*").eq("li_client_id", client.id).eq("message_hash", messageHash).limit(1).maybeSingle();
  if (dup) return res.status(200).json({ reply: dup, duplicate: true });

  /* What the prospect was sent: the approved version's chosen variant. */
  const { data: v } = await admin.from("linkedin_sequence_versions").select("content, chosen_variant").eq("li_client_id", client.id).eq("status", "approved").maybeSingle();
  const variant = (v?.content?.variants || []).find((x) => x.name === v?.chosen_variant) || v?.content?.variants?.[0];
  const sequenceText = variant ? [variant.connection_note, ...variant.steps.map((s) => s.body)].join("\n---\n") : "";

  const calls = [];
  const draftFn = async (args) => { const r = await draft({ ...args, brainRows: [], personalRows: [] }); calls.push(r); return r; };
  const meter = (call, status, errorCode) => recordAiUsage(admin, {
    model: call?.model || AI_MODEL, usage: call?.usage || null, requestId: call?.requestId || null, latencyMs: call?.latencyMs || null,
    status, errorCode, feature: "outreach_draft", surface: "api", clientId: client.client_id || null, userId: member.user?.id || null,
    entity: { kind: "linkedin_client", id: client.id }, meta: { kind: "linkedin_reply", ...(call ? {} : { tokensUnknown: true }) },
  });
  const today = chicagoDate();
  let result;
  try {
    result = await classify({ answers: client.answers || {}, sequenceText, reply: message, prospect: body?.name, today, draftFn });
  } catch (err) {
    for (const c of calls) await meter(c, "ok");
    await meter(null, "failed", String(err?.message || "unknown").slice(0, 120));
    return res.status(Number.isInteger(err?.statusCode) ? err.statusCode : 500).json({ error: err?.message || "Sorting the reply failed." });
  }
  for (const c of calls) await meter(c, "ok");

  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.day || "")) ? body.day : today;
  const { data: row, error } = await admin.from("linkedin_responses").insert({
    li_client_id: client.id, day, name: String(body?.name || "").slice(0, 200) || null, prospect_url: String(body?.prospectUrl || "").slice(0, 500) || null,
    inbox: body?.inbox === "Sales Nav" ? "Sales Nav" : "Main", message,
    classification: result.classification, confidence: result.confidence, suggested_reply: result.suggested_reply || null, summary: result.summary || null,
    referred_name: result.referred_name, reply_status: result.reply_status, status: result.reply_status, reactivation_date: result.reactivation_date,
    needs_review: result.needs_review, classified_at: new Date().toISOString(), created_by: member.user.id, message_hash: messageHash,
  }).select("*").maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  const outboxId = await alertIfLead(admin, client, row, result.notify);
  return res.status(200).json({ reply: row, outboxId, issues: result.issues });
}
