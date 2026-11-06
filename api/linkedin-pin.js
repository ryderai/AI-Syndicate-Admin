/* /api/linkedin-pin — the client's private LOGIN PAGE: their login details,
 * then LinkedIn's verification code. PUBLIC: a private token in the link is
 * the key (valid 60 days; a new link retires the old).
 * 4 Nov 2026; v2 6 Nov 2026.
 *
 * WHY. CJ, by phone (4 Nov 2026): when Julie logs in to a client's
 * LinkedIn, LinkedIn sends a verification code to the owner, and CJ had to
 * be the go-between. v2 adds what Julie asked for by email on 5 Nov ("I need
 * his password and email for LinkedIn. Also the location so I can set my
 * vpn"; WhatsApp "is usually more efficient" for codes) and CJ's ask that a
 * code "will send via email to you immediately".
 *
 *   GET  ?t=<token>                         { company, details, julie: { whatsapp, email }, passwordMethod }
 *   POST { t, action: "details", ... }      saves login email, location, WhatsApp, times, code method
 *   POST { t, code }                        stores the code for 15 minutes, emails it to Julie
 *
 * GUARDS. Only once copy is approved (stages approved onward). Digits only,
 * 4-8 long. At most 6 codes per 15 minutes per client. A code lives 15
 * minutes and expired codes are deleted on every visit. We never ask for,
 * take or store a PASSWORD: a field that looks like one is dropped, and the
 * page tells the client to use the sharing tool instead. */
const PIN_STAGES = ["approved", "access_scheduled", "live", "report_due", "renewed"];
import { getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { looksLikeToken } from "../lib/linkedin-tokens.js";
import { byToken, getSettings } from "../lib/linkedin-flow-server.js";
import { DEFAULT_JULIE_EMAIL } from "../lib/linkedin-emails.js";
import { validateLoginDetails } from "../lib/linkedin-v2.js";
import { sendInternalEmail, codeEmail } from "../lib/linkedin-notify.js";

const DETAIL_COLS = "login_email, login_location, whatsapp, login_times, code_method, login_details_at, password_received_at";
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const alertAllowed = () => [DEFAULT_JULIE_EMAIL, "cj@aisyndicate.com", "ryder@aisyndicate.com", ...String(process.env.LINKEDIN_ALERT_ALLOWED || "").split(",")].map((x) => x.trim()).filter(Boolean);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "Not available right now." });
  const body = req.method === "POST" ? await readJson(req) : null;
  const token = String(req.method === "GET" ? req.query?.t || "" : body?.t || "");
  if (!looksLikeToken(token)) return res.status(404).json({ error: "This link isn't valid." });
  const client = await byToken(admin, "pin", token);
  if (!client) return res.status(404).json({ error: "This link has expired. Reply to our email and we'll send a new one." });

  await admin.from("linkedin_pins").delete().lt("expires_at", new Date().toISOString());   // expired codes go at once
  if (!PIN_STAGES.includes(client.flow_stage)) return res.status(409).json({ error: "This page opens once your messages are approved." });
  const settings = await getSettings(admin);
  const julieEmail = str(settings.julie_email) || DEFAULT_JULIE_EMAIL;

  if (req.method === "GET") {
    const { data: d } = await admin.from("linkedin_clients").select(DETAIL_COLS).eq("id", client.id).maybeSingle();
    return res.status(200).json({
      company: client.company,
      details: d ? { login_email: d.login_email, login_location: d.login_location, whatsapp: d.whatsapp, login_times: d.login_times, code_method: d.code_method, saved_at: d.login_details_at, password_received: !!d.password_received_at } : null,
      julie: { whatsapp: str(settings.julie_whatsapp), email: julieEmail },
      passwordMethod: str(settings.password_method),
      bookingUrl: str(settings.booking_url),
    });
  }
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed." }); }

  if (body?.action === "details") {
    const check = validateLoginDetails(body);
    if (!check.ok) return res.status(400).json({ error: "Please fix the highlighted fields.", errors: check.errors, passwordOffered: check.passwordOffered });
    const { error } = await admin.from("linkedin_clients").update({ ...check.value, whatsapp: check.value.whatsapp || null, login_details_at: new Date().toISOString() }).eq("id", client.id);
    if (error) return res.status(500).json({ error: "We couldn't save that. Please try again." });
    return res.status(200).json({ ok: true, passwordOffered: check.passwordOffered });
  }

  const code = String(body?.code || "").replace(/\s+/g, "");
  if (!/^[0-9]{4,8}$/.test(code)) return res.status(400).json({ error: "Please enter just the digits of the code." });
  const since = new Date(Date.now() - 15 * 60000).toISOString();
  const { count } = await admin.from("linkedin_pins").select("id", { count: "exact", head: true }).eq("li_client_id", client.id).gte("created_at", since);
  if ((count || 0) >= 6) return res.status(429).json({ error: "That's a lot of codes in a few minutes. Please wait a little and try again." });
  const { data: pin, error } = await admin.from("linkedin_pins").insert({ li_client_id: client.id, code }).select("id").maybeSingle();
  if (error) return res.status(500).json({ error: "We couldn't save that. Please try again." });

  /* Email Julie the code now (setting code_alert_email, on by default). Only
   * Julie's address is allowed as a recipient. A failed email doesn't fail
   * the page: the code is already on the console. */
  let emailed = false;
  if (settings.code_alert_email !== false) {
    const { data: d } = await admin.from("linkedin_clients").select("login_email").eq("id", client.id).maybeSingle();
    const mail = codeEmail({ company: client.company || "A client", code, loginEmail: d?.login_email });
    /* The allow-list is FIXED, never the setting itself (6 Nov check): a
     * typo or a client's address in julie_email must not receive a code.
     * A new address for Julie goes in LINKEDIN_ALERT_ALLOWED (Vercel). */
    const r = await sendInternalEmail({ to: julieEmail, allowed: alertAllowed(), ...mail });
    emailed = r.sent;
    if (emailed && pin?.id) await admin.from("linkedin_pins").update({ emailed_at: new Date().toISOString() }).eq("id", pin.id);
  }
  return res.status(200).json({ ok: true, emailed });
}
