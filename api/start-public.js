/* /api/start-public — the CLIENT side of a start packet. PUBLIC (no login).
 * 6 Nov 2026. The page is public/start/index.html, opened from the private
 * link a team member sent: /start/?t=<code>.
 *
 *   GET  ?t=<code>                       the packet as the client sees it
 *                                        (first open is logged, once)
 *   POST { t, action: "payment_check" }  read-only "is a card saved yet?"
 *                                        (only when the packet has a Stripe customer)
 *   POST { t, action: "submit", signer, signature, consent, answers,
 *          payment_done, payment_note }  sign + send back. Once only.
 *
 * On submit, every team member gets one email with all of it
 * (lib/start-packet.js teamEmail). The CLIENT gets no email from here: their
 * copy is the done screen, which they can print or save as a PDF.
 *
 * DOOR RULES: the code is 32 random bytes and only its sha256 is stored;
 * links expire after 30 days; same-origin only; per-IP rate limits; a
 * honeypot; a body cap. */
import { getAdminSupabase } from "../lib/supabase-server.js";
import { getStripe } from "../lib/stripe-server.js";
import { readCappedJson, allowHit } from "../lib/hs-http.js";
import { originFromRequest } from "../lib/req-origin.js";
import { hashToken, looksLikeToken, adminBaseUrl } from "../lib/linkedin-tokens.js";
import { publicView, validateReturn, contentFingerprint, teamList, teamEmail, checkStripeCard, CONSENT_TEXT } from "../lib/start-packet.js";
import { sendTeamEmail } from "../lib/start-notify.js";

const BUCKET = "start-packets";
const OPEN_STATES = ["ready", "sent", "opened"];
const MAX_BODY = 600 * 1024;

const ipOf = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "-";

/** Same-origin only: the page is served by this console. */
function sameOrigin(req) {
  const self = originFromRequest(req).origin;
  const origin = String(req.headers.origin || "").replace(/\/+$/, "");
  if (origin) {
    if (origin === self) return true;
    try { return new URL(origin).host === String(req.headers.host || ""); } catch { return false; }
  }
  return String(req.headers["sec-fetch-site"] || "same-origin") === "same-origin";
}

async function findByToken(admin, t) {
  if (!looksLikeToken(t)) return null;
  const { data } = await admin.from("start_packets").select("*").eq("token_hash", hashToken(t)).maybeSingle();
  return data || null;
}

/* A 1-hour link to a private PDF (agreement or proposal), or null. */
async function pdfLinks(admin, p) {
  const one = async (path) => {
    if (!path) return null;
    const { data } = await admin.storage.from(BUCKET).createSignedUrl(path, 3600);
    return data?.signedUrl || null;
  };
  return { pdfUrl: await one(p.contract_pdf_path), proposalPdfUrl: await one(p.proposal?.pdf_path) };
}

function gone(p) {
  if (!p) return "This link doesn't work. Ask the person who sent it for a new one.";
  if (p.status === "void") return "This packet was cancelled. Ask the person who sent it for a new one.";
  if (p.token_expires_at && new Date(p.token_expires_at) < new Date()) return "This link has expired. Ask the person who sent it for a new one.";
  if (p.status === "draft") return "This packet isn't ready yet.";
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (!sameOrigin(req)) return res.status(403).json({ error: "Open this from your link." });
  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "This page is down for a minute. Please try again shortly." });
  const ip = ipOf(req);
  const ua = String(req.headers["user-agent"] || "").slice(0, 300);

  if (req.method === "GET") {
    if (!allowHit(`start-get:${ip}`, 60, 10 * 60000)) return res.status(429).json({ error: "Too many tries. Please wait a few minutes." });
    const t = req.query?.t || new URL(req.url, "http://x").searchParams.get("t");
    const p = await findByToken(admin, t);
    const why = gone(p);
    if (why) return res.status(p ? 410 : 404).json({ error: why });
    /* ?preview=1 = a team member checking the page from the console: shown,
     * but not counted as the client opening it. */
    const preview = (req.query?.preview || new URL(req.url, "http://x").searchParams.get("preview")) === "1";
    if (!preview && !p.opened_at && OPEN_STATES.includes(p.status)) {
      const now = new Date().toISOString();
      await admin.from("start_packets").update({ opened_at: now, status: "opened" }).eq("id", p.id).in("status", ["ready", "sent"]);
      await admin.from("start_packet_events").insert({ packet_id: p.id, kind: "opened", ip, ua });
      p.opened_at = now; p.status = "opened";
    }
    return res.status(200).json({ packet: publicView(p, await pdfLinks(admin, p)) });
  }

  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed." }); }
  const read = await readCappedJson(req, MAX_BODY);
  if (!read.ok) return res.status(400).json({ error: read.error });
  const body = read.body || {};
  const p = await findByToken(admin, body.t);
  const why = gone(p);
  if (why) return res.status(p ? 410 : 404).json({ error: why });

  if (body.action === "payment_check") {
    if (!allowHit(`start-pay:${ip}`, 30, 10 * 60000)) return res.status(429).json({ error: "Too many checks. Wait a minute." });
    if (!p.stripe_customer_id) return res.status(200).json({ state: "unknown" });
    const check = await checkStripeCard(getStripe(), p.stripe_customer_id);
    return res.status(200).json({ state: check.state });
  }

  if (body.action !== "submit") return res.status(400).json({ error: "Unknown action." });
  if (!allowHit(`start-submit:${ip}`, 10, 10 * 60000)) return res.status(429).json({ error: "Too many tries. Please wait a few minutes." });
  if (p.status === "returned") return res.status(409).json({ error: "This packet was already signed and sent back.", packet: publicView(p, await pdfLinks(admin, p)) });
  if (!OPEN_STATES.includes(p.status)) return res.status(409).json({ error: "This packet can't be signed right now." });
  /* What the client is about to sign must still be exactly what CJ signed. */
  if (!p.ais_signed_at || contentFingerprint(p) !== p.contract_sha256) return res.status(409).json({ error: "This packet changed since it was sent. Ask for a new link." });

  const check = validateReturn(body, p);
  if (check.bot) return res.status(400).json({ error: "Something went wrong. Please reply to the email you got and we'll sort it out." });
  if (!check.ok) return res.status(400).json({ error: "A few things need a look.", errors: check.errors });
  const v = check.value;

  const now = new Date().toISOString();
  const stripeCheck = p.stripe_customer_id ? { ...(await checkStripeCard(getStripe(), p.stripe_customer_id)), at: now } : null;
  const client_sig = { ...v.signer, signature: v.signature, consent: CONSENT_TEXT, contract_sha256: p.contract_sha256, onboarding: v.onboarding, ip, ua, signed_at: now };
  const payment_status = { ...v.payment, ...(stripeCheck ? { stripe: stripeCheck } : {}) };

  /* Once only: the update only lands while the packet is still open, so two
   * taps (or two tabs) can't both sign it. */
  const { data: saved, error } = await admin.from("start_packets")
    .update({ status: "returned", returned_at: now, client_sig, answers: v.answers, payment_status, token_expires_at: new Date(Date.now() + 30 * 86400000).toISOString() })
    .eq("id", p.id).in("status", OPEN_STATES).eq("contract_sha256", p.contract_sha256).select("*").maybeSingle();
  if (error) return res.status(500).json({ error: "Couldn't save. Please try again." });
  if (!saved) return res.status(409).json({ error: "This packet was already sent back, or it changed. Reload the page." });
  await admin.from("start_packet_events").insert({ packet_id: p.id, kind: "returned", ip, ua, detail: { sha256: p.contract_sha256, signer: v.signer.email } });

  const mail = teamEmail(saved, { consoleUrl: `${adminBaseUrl()}/#/dashboard/start?id=${p.id}`, paymentCheck: stripeCheck });
  const to = teamList([saved.sent_by_email, saved.created_by_email]);
  const r = await sendTeamEmail({ to, allowed: to, subject: mail.subject, text: mail.text, replyTo: v.signer.email });
  await admin.from("start_packets").update({ team_email: { ...r, at: new Date().toISOString() } }).eq("id", p.id);
  await admin.from("start_packet_events").insert({ packet_id: p.id, kind: r.sent ? "team_copy_sent" : "team_copy_failed", detail: { to: r.to, reason: r.reason || null } });

  return res.status(200).json({ ok: true, packet: publicView(saved, await pdfLinks(admin, saved)) });
}
