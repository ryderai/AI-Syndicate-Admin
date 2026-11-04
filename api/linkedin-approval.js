/* /api/linkedin-approval — the CLIENT's approval page (Build 4). PUBLIC: no
 * login; a one-use token in the link is the key. 4 Nov 2026.
 *
 * CJ's brief: "A tokenized link per engagement (no login required, token
 * expires on approval). It renders the two sequence variants side by side
 * ... the target list specs ... and the four reply templates. Two buttons:
 * Approve and Request changes (a text box). Variant choice is a radio."
 *
 *   GET  ?t=<token>                              the version the client is reviewing
 *   POST { t, action: "approve", variant }       -> Approved; token retired; a PIN link is made and the
 *                                                   "approved + book your slot" email is DRAFTED (never sent)
 *   POST { t, action: "changes", feedback }      -> feedback saved on the version, stage back to Building;
 *                                                   the revision is written by the next run of
 *                                                   api/linkedin-build-due.js (a model call takes too long
 *                                                   for a page to wait on). Emails drafted, never sent.
 *
 * What the page may show: the copy, lists and templates — never the client's
 * form answers, our checker's notes, or anything about other clients. */
import { getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { looksLikeToken } from "../lib/linkedin-tokens.js";
import { byToken, moveStage, pinLink, draftToOutbox, getSettings } from "../lib/linkedin-flow-server.js";
import { VARIANT_NAMES } from "../lib/linkedin-messages.js";

const today = () => new Date().toISOString().slice(0, 10);

/* The version the client should see: the one sent to them (client_review)
 * if there is one — a newer draft the team is still working on must not hide
 * it (3 Nov check) — else the newest draft, which means "a revision is coming". */
async function reviewing(admin, clientId) {
  const { data } = await admin.from("linkedin_sequence_versions")
    .select("id, version, status, content, feedback, first_dated_on, chosen_variant")
    .eq("li_client_id", clientId).in("status", ["client_review", "draft"]).order("version", { ascending: false }).limit(5);
  return (data || []).find((r) => r.status === "client_review") || (data || [])[0] || null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "Not available right now." });

  const body = req.method === "POST" ? await readJson(req) : null;
  const token = String(req.method === "GET" ? req.query?.t || "" : body?.t || "");
  if (!looksLikeToken(token)) return res.status(404).json({ error: "This link isn't valid." });
  const client = await byToken(admin, "approval", token);
  if (!client) return res.status(404).json({ error: "This link has expired or was already used. Reply to our email and we'll send a new one." });

  const v = await reviewing(admin, client.id);

  if (req.method === "GET") {
    if (!v || v.status !== "client_review") {
      return res.status(200).json({ company: client.company, state: v?.feedback || v?.status === "draft" ? "revising" : "nothing" });
    }
    const c = v.content || {};
    return res.status(200).json({
      company: client.company,
      contactName: client.contact_name,
      state: v.feedback ? "revising" : "review",
      version: v.version,
      variants: (c.variants || []).map((x) => ({ name: x.name, connection_note: x.connection_note, steps: x.steps, inmail: x.inmail })),
      target_lists: (c.target_lists || []).map((l) => ({ title: l.title, job_titles: l.job_titles, industries: l.industries, headcount: l.headcount, geography: l.geography, keywords: l.keywords, exclusions: l.exclusions })),
      reply_templates: c.reply_templates || {},
      datedFrom: v.first_dated_on || null,
    });
  }

  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed." }); }
  if (!v || v.status !== "client_review") return res.status(409).json({ error: "There's nothing waiting for your review right now." });
  if (v.feedback) return res.status(409).json({ error: "Thanks — your changes are already with us. A revised version is on its way." });

  if (body?.action === "approve") {
    const variant = String(body?.variant || "");
    if (!VARIANT_NAMES.includes(variant)) return res.status(400).json({ error: "Please pick one of the two versions." });
    if (v.first_dated_on && v.first_dated_on <= today()) return res.status(409).json({ error: "Some of these messages mention a date that has now passed, so we'll send you an updated version." });
    /* chosen_variant first, then approval: the database refuses an approval
     * without a chosen variant, and approves only from client_review. The
     * approval is conditional on still being under review and SAYS whether
     * it changed a row, so a double click approves (and drafts) once. */
    let { error } = await admin.from("linkedin_sequence_versions").update({ chosen_variant: variant }).eq("id", v.id).eq("status", "client_review");
    let changed = [];
    if (!error) ({ data: changed, error } = await admin.from("linkedin_sequence_versions").update({ status: "approved", approved_via: "client_page", approved_at: new Date().toISOString() }).eq("id", v.id).eq("status", "client_review").select("id"));
    if (error) return res.status(409).json({ error: "We couldn't record that. Please reply to our email instead." });
    if (!changed?.length) return res.status(200).json({ ok: true, state: "approved", already: true });
    await admin.from("linkedin_clients").update({ approval_token_hash: null, approval_token_expires_at: null }).eq("id", client.id);
    await moveStage(admin, client.id, "approved");
    const settings = await getSettings(admin);
    const bookingUrl = typeof settings.booking_url === "string" ? settings.booking_url : null;
    const url = await pinLink(admin, client.id);
    await draftToOutbox(admin, { client, kind: "approved_book", data: { bookingUrl, pinUrl: url } });
    /* The brief: "The confirmation screen embeds Julie's booking link". The
     * PIN page link is shown too — this person holds the approval link, so
     * they are the owner the PIN page is for. */
    return res.status(200).json({ ok: true, state: "approved", bookingUrl, pinUrl: url });
  }

  if (body?.action === "changes") {
    const feedback = String(body?.feedback || "").trim().slice(0, 4000);
    if (feedback.length < 3) return res.status(400).json({ error: "Please tell us what to change." });
    const { data: saved, error } = await admin.from("linkedin_sequence_versions").update({ feedback }).eq("id", v.id).is("feedback", null).select("id");
    if (error) return res.status(409).json({ error: "We couldn't record that. Please reply to our email instead." });
    if (!saved?.length) return res.status(409).json({ error: "Your earlier changes are already with us. If you have more, reply to our email." });
    await moveStage(admin, client.id, "building");
    await draftToOutbox(admin, { client, kind: "revision_coming" });
    return res.status(200).json({ ok: true, state: "revising" });
  }
  return res.status(400).json({ error: "Unknown action." });
}
