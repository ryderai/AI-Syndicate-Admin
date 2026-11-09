/* /api/start-packets — the TEAM side of start packets. 6 Nov 2026.
 * Console members: owners, admins AND sales reps (Ryder, 7 Nov 2026: "anyone
 * doing sales or getting new clients is able to easily just send" one). A rep
 * sees and works only the packets they made or sent; owners and admins see
 * all. The client side is /api/start-public.
 * The rules live in lib/start-packet.js; read its header first.
 *
 *   GET                         the list (newest first, 200 max)
 *   GET  ?id=<uuid>             one packet + its events (+ a 10-minute PDF link)
 *   POST { action, ... }
 *     save          { id?, ...fields }   create or update. Locked once sent.
 *                                        A change to what was signed clears the signature.
 *     pdf_upload    { id, name }         a one-time upload URL for the agreement PDF
 *     pdf_attached  { id, path, name }   after the browser uploaded it: hash it, attach it
 *     pdf_remove    { id }
 *     sign          { id, updated_at, title?, signature:{kind,data} }   the person sending signs
 *                                        for AI Syndicate (Ryder, 7 Nov 2026: "Why can it not come
 *                                        from the person sending the email?"). Was CJ-only on 6 Nov.
 *     make_link     { id }               a fresh private link (the old one stops working)
 *     mark_sent     { id, via, to }      after the person sent it (Gmail or copied)
 *     check_payment { id }               read-only Stripe check of the packet's customer
 *     resend_copy   { id }               the team copy again
 *     void          { id }
 *
 * NOTHING HERE EMAILS A CLIENT. The person sends the client email themselves
 * (/api/gmail-send from their own mailbox, or copy and paste). */
import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { getStripe } from "../lib/stripe-server.js";
import { newToken, hashToken, adminBaseUrl } from "../lib/linkedin-tokens.js";
import {
  validateDraft, contentFingerprint, checkSignature, LINK_DAYS,
  stageLabel, teamList, teamEmail, clientEmailDraft, checkStripeCard, sha256,
} from "../lib/start-packet.js";
import { sendTeamEmail } from "../lib/start-notify.js";

const BUCKET = "start-packets";
const LOCKED = ["sent", "opened", "returned", "void"];
const LIST_COLS = "id,status,business,contact_name,contact_email,form_kind,proposal,ais_signed_at,sent_at,opened_at,returned_at,created_at,updated_at,created_by_email,sent_by_email,lead_id";

/* Clearing the sender's signature (anything the client sees changed). */
const UNSIGN = { ais_signed_at: null, ais_signer_name: null, ais_signer_title: null, ais_signer_email: null, ais_signature: null, ais_signed_by: null, contract_sha256: null, status: "draft", token_hash: null, token_expires_at: null };
/* The proposal PDF lives inside the proposal JSON (no new column needed). */
const keepPdf = (prop) => ({ pdf_path: prop?.pdf_path || null, pdf_name: prop?.pdf_name || null, pdf_sha256: prop?.pdf_sha256 || null });
const signedUrl = async (admin, path, secs) => {
  if (!path) return null;
  const { data } = await admin.storage.from(BUCKET).createSignedUrl(path, secs);
  return data?.signedUrl || null;
};

export const consoleLink = (id) => `${adminBaseUrl()}/#/dashboard/start?id=${id}`;
export const clientLink = (token) => `${adminBaseUrl()}/start/?t=${token}`;

function ipOf(req) { return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || null; }

async function logEvent(admin, packetId, kind, member, req, detail = {}) {
  await admin.from("start_packet_events").insert({
    packet_id: packetId, kind, by_user: member?.user?.id || null, by_email: member?.membership?.email || null,
    ip: req ? ipOf(req) : null, ua: req ? String(req.headers["user-agent"] || "").slice(0, 300) : null, detail,
  });
}

async function load(admin, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  const { data } = await admin.from("start_packets").select("*").eq("id", id).maybeSingle();
  return data || null;
}

/* What the console may see. Never the token hash. */
function forConsole(p) {
  if (!p) return p;
  const rest = { ...p };
  delete rest.token_hash;
  return { ...rest, stage: stageLabel(p), has_link: Boolean(p.token_hash), link_expires_at: p.token_expires_at };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const member = await requireMember(req, ["owner", "admin", "sales"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  const isRep = member.membership?.role === "sales";
  /* A rep's own packets only. Owners and admins: everything. */
  const mine = (p) => !isRep || p.created_by === member.user.id || p.sent_by === member.user.id;
  const admin = getAdminSupabase();
  const myEmail = String(member.membership?.email || member.user?.email || "").toLowerCase();

  if (req.method === "GET") {
    const id = req.query?.id || new URL(req.url, "http://x").searchParams.get("id");
    if (id) {
      const p = await load(admin, id);
      if (!p || !mine(p)) return res.status(404).json({ error: "No such packet." });
      const { data: events } = await admin.from("start_packet_events").select("kind,at,by_email,ip,detail").eq("packet_id", id).order("at", { ascending: true }).limit(200);
      let pdfUrl = null;
      if (p.contract_pdf_path) {
        const { data } = await admin.storage.from(BUCKET).createSignedUrl(p.contract_pdf_path, 600);
        pdfUrl = data?.signedUrl || null;
      }
      const proposalPdfUrl = await signedUrl(admin, p.proposal?.pdf_path, 600);
      return res.status(200).json({ packet: forConsole(p), events: events || [], pdfUrl, proposalPdfUrl, consoleUrl: consoleLink(p.id) });
    }
    let q = admin.from("start_packets").select(LIST_COLS).order("updated_at", { ascending: false }).limit(200);
    if (isRep) q = q.eq("created_by", member.user.id);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ packets: (data || []).map((p) => ({ ...p, stage: stageLabel(p) })) });
  }

  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed." }); }
  const body = (await readJson(req)) || {};
  const action = String(body.action || "");

  /* ---------- save (create or update) ---------- */
  if (action === "save") {
    const check = validateDraft(body);
    if (!check.ok) return res.status(400).json({ error: "Please fix the highlighted fields.", errors: check.errors });
    const v = check.value;
    if (!body.id) {
      const { data, error } = await admin.from("start_packets").insert({
        ...v, status: "draft", created_by: member.user.id, created_by_email: myEmail,
      }).select("*").single();
      if (error) return res.status(500).json({ error: error.message });
      await logEvent(admin, data.id, "created", member, req);
      return res.status(200).json({ packet: forConsole(data) });
    }
    const p = await load(admin, body.id);
    if (!p || !mine(p)) return res.status(404).json({ error: "No such packet." });
    if (LOCKED.includes(p.status)) return res.status(409).json({ error: "This packet was already sent, so it can't change. Cancel it and make a new one." });
    v.proposal = { ...v.proposal, ...keepPdf(p.proposal) };
    const next = { ...p, ...v };
    const patch = { ...v };
    let cleared = false;
    if (p.ais_signed_at && contentFingerprint(next) !== p.contract_sha256) {
      Object.assign(patch, { ais_signed_at: null, ais_signer_name: null, ais_signer_title: null, ais_signer_email: null, ais_signature: null, ais_signed_by: null, contract_sha256: null, status: "draft", token_hash: null, token_expires_at: null });
      cleared = true;
    }
    const { data, error } = await admin.from("start_packets").update(patch).eq("id", p.id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    await logEvent(admin, p.id, cleared ? "edited_cj_signature_cleared" : "edited", member, req);
    return res.status(200).json({ packet: forConsole(data), cjSignatureCleared: cleared });
  }

  const p = await load(admin, body.id);
  if (!p || !mine(p)) return res.status(404).json({ error: "No such packet." });

  /* ---------- the agreement PDF ---------- */
  /* PDFs: kind "agreement" (default) or "proposal". Dropped or picked in the console. */
  const pdfKind = body.kind === "proposal" ? "proposal" : "agreement";
  if (action === "pdf_upload") {
    if (LOCKED.includes(p.status)) return res.status(409).json({ error: "Already sent — can't change it now." });
    const safe = String(body.name || `${pdfKind}.pdf`).replace(/[^A-Za-z0-9._-]+/g, "-").slice(-80) || `${pdfKind}.pdf`;
    const path = `${p.id}/${pdfKind}-${Date.now()}-${safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`}`;
    const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return res.status(500).json({ error: `Upload not ready: ${error.message}` });
    return res.status(200).json({ path, token: data.token, signedUrl: data.signedUrl });
  }
  if (action === "pdf_attached") {
    if (LOCKED.includes(p.status)) return res.status(409).json({ error: "Already sent — can't change it now." });
    const path = String(body.path || "");
    if (!path.startsWith(`${p.id}/`)) return res.status(400).json({ error: "That file isn't this packet's." });
    const { data: blob, error } = await admin.storage.from(BUCKET).download(path);
    if (error || !blob) return res.status(400).json({ error: "The upload didn't arrive. Try again." });
    const buf = Buffer.from(await blob.arrayBuffer());
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return res.status(400).json({ error: "That file isn't a PDF." });
    const pdfSha = sha256(buf);
    const name = String(body.name || (pdfKind === "proposal" ? "Proposal.pdf" : "Agreement.pdf")).slice(0, 160);
    const patch = pdfKind === "proposal"
      ? { proposal: { ...(p.proposal || {}), pdf_path: path, pdf_name: name, pdf_sha256: pdfSha } }
      : { contract_pdf_path: path, contract_pdf_name: name, contract_pdf_sha256: pdfSha };
    if (p.ais_signed_at) Object.assign(patch, UNSIGN);
    const { data, error: e2 } = await admin.from("start_packets").update(patch).eq("id", p.id).select("*").single();
    if (e2) return res.status(500).json({ error: e2.message });
    await logEvent(admin, p.id, pdfKind === "proposal" ? "proposal_pdf_attached" : "pdf_attached", member, req, { name, sha256: pdfSha, bytes: buf.length });
    return res.status(200).json({ packet: forConsole(data), cjSignatureCleared: Boolean(p.ais_signed_at) });
  }
  if (action === "pdf_remove") {
    if (LOCKED.includes(p.status)) return res.status(409).json({ error: "Already sent — can't change it now." });
    const patch = pdfKind === "proposal"
      ? { proposal: { ...(p.proposal || {}), pdf_path: null, pdf_name: null, pdf_sha256: null } }
      : { contract_pdf_path: null, contract_pdf_name: null, contract_pdf_sha256: null };
    if (p.ais_signed_at) Object.assign(patch, UNSIGN);
    const { data, error } = await admin.from("start_packets").update(patch).eq("id", p.id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    await logEvent(admin, p.id, pdfKind === "proposal" ? "proposal_pdf_removed" : "pdf_removed", member, req);
    return res.status(200).json({ packet: forConsole(data) });
  }

  /* ---------- the sender signs for AI Syndicate ---------- */
  if (action === "sign" || action === "cj_sign") {
    if (LOCKED.includes(p.status)) return res.status(409).json({ error: "Already sent." });
    const check = validateDraft({ ...p, has_pdf: Boolean(p.contract_pdf_path) }, { forSend: true });
    if (!check.ok) return res.status(400).json({ error: "Fill these in before signing.", errors: check.errors });
    const name = String(member.membership?.full_name || myEmail).slice(0, 120);
    const sig = checkSignature(body.signature, name);
    if (!sig.ok) return res.status(400).json({ error: sig.error });
    /* They sign what was on THEIR screen: if anyone saved since they opened it, refuse. */
    const sameVersion = body.updated_at && new Date(body.updated_at).getTime() === new Date(p.updated_at).getTime();
    /* (A save landing in the milliseconds after this check is still caught:
     * the stored fingerprint would no longer match, so make_link and the
     * client's send-back both refuse.) */
    if (!sameVersion) return res.status(409).json({ error: "Someone changed this packet since you opened it. Reload, read it again, then sign." });
    const fp = contentFingerprint(p);
    const { data, error } = await admin.from("start_packets").update({
      ais_signer_name: name, ais_signer_title: String(body.title || "AI Syndicate").slice(0, 120), ais_signer_email: myEmail,
      ais_signature: sig.value, ais_signed_at: new Date().toISOString(), ais_signed_by: member.user.id,
      contract_sha256: fp, status: "ready",
    }).eq("id", p.id).in("status", ["draft", "ready"]).select("*").maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(409).json({ error: "Someone changed this packet just now. Reload, read it again, then sign." });
    await logEvent(admin, p.id, "signed", member, req, { sha256: fp, kind: sig.value.kind });
    return res.status(200).json({ packet: forConsole(data) });
  }
  /* ---------- the private link ---------- */
  if (action === "make_link") {
    if (!p.ais_signed_at || !["ready", "sent", "opened"].includes(p.status)) return res.status(409).json({ error: "Sign it first. Then you can make the link." });
    if (contentFingerprint(p) !== p.contract_sha256) return res.status(409).json({ error: "The packet changed after it was signed. Sign it again." });
    const token = newToken();
    const expires = new Date(Date.now() + LINK_DAYS * 86400000).toISOString();
    const { error } = await admin.from("start_packets").update({ token_hash: hashToken(token), token_expires_at: expires }).eq("id", p.id);
    if (error) return res.status(500).json({ error: error.message });
    await logEvent(admin, p.id, p.token_hash ? "link_replaced" : "link_made", member, req, { expires });
    const link = clientLink(token);
    const draft = clientEmailDraft(p, link, member.membership?.full_name || "");
    return res.status(200).json({ link, expires, draft, replacedOld: Boolean(p.token_hash) });
  }
  if (action === "mark_sent") {
    if (!p.token_hash) return res.status(409).json({ error: "Make the link first." });
    if (!["ready", "sent", "opened"].includes(p.status)) return res.status(409).json({ error: "This packet can't be marked as sent now." });
    const via = body.via === "gmail" ? "gmail" : "copied";
    const patch = { sent_via: via };
    if (p.status === "ready") Object.assign(patch, { status: "sent", sent_at: new Date().toISOString(), sent_by: member.user.id, sent_by_email: myEmail });
    const { data, error } = await admin.from("start_packets").update(patch).eq("id", p.id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    await logEvent(admin, p.id, "sent", member, req, { via, to: String(body.to || p.contact_email || "").slice(0, 200) });
    return res.status(200).json({ packet: forConsole(data) });
  }

  /* ---------- after it comes back ---------- */
  if (action === "check_payment") {
    if (!p.stripe_customer_id) return res.status(400).json({ error: "Add the client's Stripe customer id (cus_…) to check." });
    const check = await checkStripeCard(getStripe(), p.stripe_customer_id);
    const payment_status = { ...(p.payment_status || {}), stripe: { ...check, at: new Date().toISOString() } };
    await admin.from("start_packets").update({ payment_status }).eq("id", p.id);
    await logEvent(admin, p.id, "payment_checked", member, req, check);
    return res.status(200).json({ check });
  }
  if (action === "resend_copy") {
    if (p.status !== "returned") return res.status(409).json({ error: "Not sent back yet." });
    const mail = teamEmail(p, { consoleUrl: consoleLink(p.id), paymentCheck: p.payment_status?.stripe || null });
    const to = teamList([p.sent_by_email, p.created_by_email]);
    const r = await sendTeamEmail({ to, allowed: to, subject: mail.subject, text: mail.text, replyTo: p.client_sig?.email });
    await admin.from("start_packets").update({ team_email: { ...r, at: new Date().toISOString() } }).eq("id", p.id);
    await logEvent(admin, p.id, "team_copy_resent", member, req, { sent: r.sent, reason: r.reason || null });
    return res.status(r.sent ? 200 : 502).json(r.sent ? { ok: true, to: r.to } : { error: `Email didn't send (${r.reason}).` });
  }
  if (action === "void") {
    if (p.status === "returned") return res.status(409).json({ error: "The client already signed. Keep it as the record." });
    const { data, error } = await admin.from("start_packets").update({ status: "void", token_hash: null, token_expires_at: null }).eq("id", p.id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    await logEvent(admin, p.id, "cancelled", member, req);
    return res.status(200).json({ packet: forConsole(data) });
  }

  return res.status(400).json({ error: "Unknown action." });
}
