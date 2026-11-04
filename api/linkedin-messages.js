/* /api/linkedin-messages — LinkedIn Outreach messaging engine (Build 1).
 * 3 Nov 2026. CJ's "LinkedIn Outreach — Build Brief for Ryder" (3 Nov 2026).
 *
 *   GET   ?liClientId=<uuid>
 *         every Sequence version for one engagement, newest first, each with
 *         `stale` (its first named date has come)
 *   POST  { liClientId }                              write version 1 (or a fresh one)
 *   POST  { liClientId, reviseFrom: <id>, feedback }  the revision loop: the
 *         feedback is saved on that version, a full revised JSON becomes the
 *         next version, the old one retires
 *   PATCH { id, action: "to_client" }                 Julie's review done: draft -> client_review
 *   PATCH { id, action: "choose_variant", variant }   "Value-led" | "Direct"
 *   PATCH { id, action: "approve" }                   client_review -> approved (until Build 4's
 *                                                     page exists, a person records the client's yes)
 *   PATCH { id, action: "retire" }
 *   PATCH { liClientId, action: "mark_paid" }         owner only: the first month was paid
 *                                                     outside the payment link (e.g. an invoice)
 *
 * WHO. Owners + admins for everything; the 'linkedin' role (Julie, 0050 —
 * not live yet) for GET and to_client only, because her copy review is the
 * one step the brief gives her. Nothing here sends anything to anyone.
 *
 * PAID FIRST. The brief: "Do not generate on form submission alone". A POST
 * for an unpaid engagement is refused (409) — the owner's way past it is
 * mark_paid, which is recorded.
 *
 * Every model call (1 or 2 per run) is recorded through recordAiUsage,
 * success or failure (scripts/check-ai-usage.mjs). Needs migration 0051. */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { draft, isAiConfigured, AI_MODEL } from "../lib/ai.js";
import { recordAiUsage } from "../lib/ai-usage.js";
import { VARIANT_NAMES } from "../lib/linkedin-messages.js";
import { loadEngagement, claim, release, runEngine, saveVersion, saveRevision } from "../lib/linkedin-engine-server.js";
import { moveStage, approvalLink, pinLink, draftToOutbox, getSettings } from "../lib/linkedin-flow-server.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const member = await requireMember(req, ["owner", "admin", "linkedin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  const role = member.membership.role;
  const isAdmin = role === "owner" || role === "admin";
  const admin = getAdminSupabase();

  if (req.method === "GET") {
    const id = String(req.query?.liClientId || "");
    if (!UUID.test(id)) return res.status(400).json({ error: "liClientId is required." });
    const { data, error } = await admin
      .from("linkedin_sequence_versions")
      .select("id, li_client_id, version, source, status, content, prompt_version, model, issues, risk, expires_on, first_dated_on, retried, from_version_id, feedback, made_from_feedback, chosen_variant, reviewed_at, approved_at, approved_via, review_note, created_at")
      .eq("li_client_id", id)
      .order("version", { ascending: false })
      .limit(30);
    if (error) return res.status(500).json({ error: error.message });
    /* `stale` = the whole version is out of date; `datedStopped` = its dated
     * messages should no longer be sent (the lists and templates still can). */
    return res.status(200).json({ versions: (data || []).map((r) => ({ ...r, stale: Boolean(r.expires_on && r.expires_on <= today()), datedStopped: Boolean(r.first_dated_on && r.first_dated_on <= today()) })) });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    const action = String(body?.action || "");

    if (action === "mark_paid") {
      if (role !== "owner") return res.status(403).json({ error: "Only an owner can mark a client paid." });
      const liClientId = String(body?.liClientId || "");
      if (!UUID.test(liClientId)) return res.status(400).json({ error: "liClientId is required." });
      const { data, error } = await admin.from("linkedin_clients")
        .update({ paid_at: new Date().toISOString(), paid_source: "manual", paid_marked_by: member.user.id })
        .eq("id", liClientId).is("paid_at", null).select("id, paid_at, paid_source").maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ client: data || null, note: data ? "Marked paid." : "Already paid — nothing changed." });
    }

    const id = String(body?.id || "");
    if (!UUID.test(id)) return res.status(400).json({ error: "id is required." });
    const { data: row, error } = await admin.from("linkedin_sequence_versions").select("id, status, issues, content, expires_on, first_dated_on, chosen_variant").eq("id", id).maybeSingle();
    if (error || !row) return res.status(404).json({ error: "Version not found." });
    if (!isAdmin && action !== "to_client") return res.status(403).json({ error: "Only an owner or admin can do that." });

    let patch;
    if (action === "to_client") {
      /* The same rules the database trigger enforces, checked here first so
       * the screen gets a plain sentence instead of a database error. */
      const blocking = (row.issues || []).filter((i) => i?.level === "block").length;
      if (row.status !== "draft") return res.status(409).json({ error: `Only a draft goes to the client (this one is ${row.status}).` });
      if (!row.content || blocking) return res.status(409).json({ error: `This version has ${blocking || 1} blocking problem(s). Fix or re-run it first.` });
      if ((row.first_dated_on || row.expires_on) && (row.first_dated_on || row.expires_on) <= today()) return res.status(409).json({ error: `Some messages name a date from ${row.first_dated_on || row.expires_on} on, which has come. Re-run it.` });
      patch = { status: "client_review", reviewed_by: member.user.id, reviewed_at: new Date().toISOString(), review_note: clean(body?.note) };
    } else if (action === "choose_variant") {
      const variant = String(body?.variant || "");
      if (!VARIANT_NAMES.includes(variant)) return res.status(400).json({ error: `variant must be ${VARIANT_NAMES.join(" or ")}.` });
      if (!["draft", "client_review"].includes(row.status)) return res.status(409).json({ error: `Can't change the variant on a ${row.status} version.` });
      patch = { chosen_variant: variant };
    } else if (action === "approve") {
      if (row.status !== "client_review") return res.status(409).json({ error: `Only a version the client is reviewing can be approved (this one is ${row.status}).` });
      if (!row.chosen_variant) return res.status(409).json({ error: "Pick the variant the client chose first." });
      if ((row.first_dated_on || row.expires_on) && (row.first_dated_on || row.expires_on) <= today()) return res.status(409).json({ error: `Some messages name a date from ${row.first_dated_on || row.expires_on} on, which has come. Re-run it.` });
      patch = { status: "approved", approved_at: new Date().toISOString(), approved_via: "console", approved_by: member.user.id, review_note: clean(body?.note) };
    } else if (action === "retire") {
      patch = { status: "retired", review_note: clean(body?.note) };
    } else {
      return res.status(400).json({ error: "Unknown action." });
    }
    const { data: saved, error: e2 } = await admin.from("linkedin_sequence_versions").update(patch).eq("id", id).select("*").maybeSingle();
    if (e2) return res.status(409).json({ error: e2.message });

    /* The flow (0052): the stage follows the copy, and the client's emails
     * are DRAFTED in the outbox — never sent from here. */
    const { data: client } = await admin.from("linkedin_clients").select("id, company, contact_name, contact_email").eq("id", saved.li_client_id).maybeSingle();
    let link = null;
    let flowNote = null;
    /* Guarded: the copy's status change above has already been saved, so a
     * flow step that fails (e.g. migration 0052 not run yet) must not turn
     * that into an error the person would retry. */
    try {
    if (client && action === "to_client") {
      await moveStage(admin, client.id, "in_review");
      link = await approvalLink(admin, client.id);
      const first = saved.version === 1 || !saved.from_version_id;
      await draftToOutbox(admin, { client, kind: first ? "resources_ready" : "revised_ready", data: { approvalUrl: link } });
    }
    if (client && action === "approve") {
      await admin.from("linkedin_clients").update({ approval_token_hash: null, approval_token_expires_at: null }).eq("id", client.id);
      await moveStage(admin, client.id, "approved");
      const settings = await getSettings(admin);
      link = await pinLink(admin, client.id);
      await draftToOutbox(admin, { client, kind: "approved_book", data: { bookingUrl: typeof settings.booking_url === "string" ? settings.booking_url : null, pinUrl: link } });
    }
    } catch (err) {
      flowNote = `Saved, but the next flow step didn't run: ${String(err?.message || err).slice(0, 160)}`;
    }
    return res.status(200).json({ version: saved, link, flowNote });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, PATCH");
    return res.status(405).json({ error: "Method not allowed." });
  }
  if (!isAdmin) return res.status(403).json({ error: "Only an owner or admin can write a sequence." });
  if (!isAiConfigured()) return res.status(503).json({ error: "Writing copy is waiting on ANTHROPIC_API_KEY — SETUP.md § AI." });

  const body = await readJson(req);
  const liClientId = String(body?.liClientId || "");
  if (!UUID.test(liClientId)) return res.status(400).json({ error: "liClientId is required." });
  const client = await loadEngagement(admin, liClientId).catch(() => null);
  if (!client) return res.status(404).json({ error: "LinkedIn client not found." });
  if (client.status !== "submitted") return res.status(409).json({ error: "This client hasn't sent the onboarding form yet." });
  if (!client.paid_at) return res.status(409).json({ error: "Not paid yet. The brief: copy is written after the first month is paid. An owner can mark it paid if they paid another way." });

  /* The revision loop. The feedback is written on the version it is about
   * (once — the trigger refuses a second write), then a full revised JSON
   * is made from the original inputs + that version's JSON + the feedback. */
  let current = null; let from = null; const feedback = clean(body?.feedback, 4000);
  if (body?.reviseFrom) {
    if (!UUID.test(String(body.reviseFrom))) return res.status(400).json({ error: "reviseFrom must be a version id." });
    if (!feedback) return res.status(400).json({ error: "A revision needs the client's feedback text." });
    ({ data: from } = await admin.from("linkedin_sequence_versions").select("id, li_client_id, content, status, feedback").eq("id", body.reviseFrom).maybeSingle());
    if (!from || from.li_client_id !== client.id || !from.content) return res.status(404).json({ error: "That version isn't this client's, or has no usable copy." });
    current = from.content;
  }

  if (!(await claim(admin, client.id))) return res.status(429).json({ error: "A sequence is already being written for this client. Wait a minute and refresh." });

  const calls = [];
  const draftFn = async (args) => { const r = await draft({ ...args, brainRows: [], personalRows: [] }); calls.push(r); return r; };
  const meter = (call, status, errorCode) => recordAiUsage(admin, {
    model: call?.model || AI_MODEL,
    usage: call?.usage || null,
    requestId: call?.requestId || null,
    latencyMs: call?.latencyMs || null,
    status,
    errorCode,
    feature: "outreach_draft",
    surface: "api",
    clientId: client.client_id || null,
    userId: member.user?.id || null,
    entity: { kind: "linkedin_client", id: client.id },
    meta: { kind: current ? "linkedin_sequence_revision" : "linkedin_sequence", ...(call ? {} : { tokensUnknown: true }) },
  });

  let outcome = { ok: false, error: "unknown" };
  try {
    let result;
    try {
      result = await runEngine({ client, draftFn, current, feedback });
    } catch (err) {
      for (const c of calls) await meter(c, "ok");
      await meter(null, "failed", String(err?.message || "unknown").slice(0, 120));
      outcome = { ok: false, error: err?.message };
      return res.status(Number.isInteger(err?.statusCode) ? err.statusCode : 500).json({ error: err?.message || "Writing the sequence failed." });
    }
    for (const c of calls) await meter(c, "ok");
    const saved = from
      ? await saveRevision(admin, { client, from, feedback, result, createdBy: member.user.id })
      : await saveVersion(admin, { client, result, source: "claude", createdBy: member.user.id });
    outcome = { ok: true };
    await moveStage(admin, client.id, "building").catch(() => null);
    return res.status(200).json({ version: saved, siteTextUsed: result.siteTextUsed });
  } catch (err) {
    outcome = { ok: false, error: err?.message };
    return res.status(Number.isInteger(err?.statusCode) ? err.statusCode : 500).json({ error: err?.message || "Saving failed." });
  } finally {
    await release(admin, client.id, outcome);
  }
}

function clean(v, max = 2000) {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
}
