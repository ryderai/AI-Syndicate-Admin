/* /api/linkedin-pin — the client types LinkedIn's verification PIN; Julie
 * sees it in the console. PUBLIC: a private token in the link is the key
 * (valid 60 days; a new link retires the old).
 * 4 Nov 2026.
 *
 * WHY. CJ, by phone (4 Nov 2026): when Julie logs in to a client's
 * LinkedIn, LinkedIn sends a verification PIN to the account owner, and CJ
 * has to be the go-between to get it. Now the owner opens the PIN link (in
 * the "approved + book your slot" email), types the code, and it shows on
 * Julie's screen at once. No call, no CJ.
 *
 *   GET  ?t=<token>          { company } — is the link good?
 *   POST { t, code }         stores the code for 15 minutes
 *
 * GUARDS. Only once copy is approved (stages approved onward). Digits only,
 * 4-8 long. At most 6 codes per 15 minutes per client. A code lives 15
 * minutes and expired codes are deleted on every visit. We never ask for,
 * take or store a PASSWORD — only the one-time code. */
const PIN_STAGES = ["approved", "access_scheduled", "live", "report_due", "renewed"];
import { getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { looksLikeToken } from "../lib/linkedin-tokens.js";
import { byToken } from "../lib/linkedin-flow-server.js";

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
  if (req.method === "GET") return res.status(200).json({ company: client.company });
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed." }); }

  const code = String(body?.code || "").replace(/\s+/g, "");
  if (!/^[0-9]{4,8}$/.test(code)) return res.status(400).json({ error: "Please enter just the digits of the code." });
  const since = new Date(Date.now() - 15 * 60000).toISOString();
  const { count } = await admin.from("linkedin_pins").select("id", { count: "exact", head: true }).eq("li_client_id", client.id).gte("created_at", since);
  if ((count || 0) >= 6) return res.status(429).json({ error: "That's a lot of codes in a few minutes. Please wait a little and try again." });
  const { error } = await admin.from("linkedin_pins").insert({ li_client_id: client.id, code });
  if (error) return res.status(500).json({ error: "We couldn't save that. Please try again." });
  return res.status(200).json({ ok: true });
}
