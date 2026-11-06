/* POST /api/linkedin-signup — the LinkedIn Outreach sales page's form.
 * PUBLIC (no login). 6 Nov 2026.
 *
 * WHY. CJ, text 5 Nov 2026: "could we make a page for our LinkedIn marketing
 * service? ... they can see what the product is, what the price is, and what
 * it does. They can fill out a form, a stripe customer profile and pay, I'll
 * reach out and get them started".
 *
 *   Body: { name, company, email, phone?, linkedin_url?, site?, goal?, hp_check (honeypot) }
 *   Returns: { ok, checkoutUrl } — CJ's Stripe payment link with
 *   client_reference_id = the new row, so the existing Stripe webhook
 *   (api/linkedin-stripe-webhook.js) marks THIS row paid with no guessing.
 *
 * WHAT IT WRITES. One linkedin_clients row, status 'signup', source
 * 'sales_page' (the same person again within a day reuses their row). When
 * they later send the onboarding form, lib/linkedin-flow-server.js
 * linkSignups() moves the payment onto the form row. It sends ONE internal
 * email to the team (setting signup_notify) and nothing to the visitor:
 * Stripe sends the receipt, and the welcome email is a draft for CJ.
 *
 * DOOR RULES (same as the landing pages, lib/hs-http.js): the console's own
 * origin or an allow-listed one (HS_ALLOWED_ORIGINS), a body cap, a per-IP
 * rate limit, a honeypot. */
import { getAdminSupabase } from "../lib/supabase-server.js";
import { applyCors, readCappedJson, allowHit } from "../lib/hs-http.js";
import { originFromRequest } from "../lib/req-origin.js";
import { validateSignup, checkoutUrl, DEFAULT_PAYMENT_LINK } from "../lib/linkedin-v2.js";
import { getSettings } from "../lib/linkedin-flow-server.js";
import { adminBaseUrl } from "../lib/linkedin-tokens.js";
import { sendInternalEmail, signupEmail } from "../lib/linkedin-notify.js";

const TEAM = ["cj@aisyndicate.com", "ryder@aisyndicate.com", "andrew@aisyndicate.com", "julia@aisyndicate.com"];

export default async function handler(req, res) {
  /* The page is served from this console, so its own origin is always
   * allowed; other origins (aisyndicate.com, if the page moves there) only
   * when HS_ALLOWED_ORIGINS names them. */
  const self = originFromRequest(req).origin;
  const origin = String(req.headers?.origin || "").replace(/\/+$/, "");
  if (origin && origin === self) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.status(204).end();
  } else {
    const cors = applyCors(req, res);
    if (!cors.ok) return undefined;
  }
  if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); return res.status(405).json({ error: "Method not allowed." }); }

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "-";
  if (!allowHit(`li-signup:${ip}`, 8, 10 * 60000)) return res.status(429).json({ error: "Too many tries. Please wait a few minutes." });

  const read = await readCappedJson(req);
  if (!read.ok) return res.status(400).json({ error: read.error });
  const check = validateSignup(read.body || {});
  const payLink = process.env.LINKEDIN_PAYMENT_LINK || DEFAULT_PAYMENT_LINK;
  /* A bot (honeypot filled) gets no row and no link. A real person whose
   * browser filled the hidden box sees a plain error with CJ's email. */
  if (check.bot) return res.status(400).json({ error: "Something went wrong. Please email cj@aisyndicate.com and we'll get you set up." });
  if (!check.ok) return res.status(400).json({ error: "Please fix the highlighted fields.", errors: check.errors });

  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "Sign-up is down for a minute. Please try again shortly." });
  const v = check.value;

  /* ALWAYS a new row (6 Nov check): reusing "the same email's" row let a
   * stranger who typed someone else's email get that person's row id back
   * and overwrite it. An unpaid duplicate is harmless; it just sits there. */
  const answers = { contact_name: v.name, contact_email: v.email, contact_phone: v.phone || null, company: v.company, website: v.site || null, linkedin_url: v.linkedin_url || null, goals: v.goal || null };
  const now = new Date().toISOString();
  const { data: row, error } = await admin.from("linkedin_clients").insert({
    status: "signup", source: "sales_page", ref: "sales-page", company: v.company, contact_name: v.name, contact_email: v.email,
    linkedin_url: v.linkedin_url || null, answers, checkout_started_at: now, last_saved_at: now,
  }).select("id").maybeSingle();
  if (error || !row) { console.error("linkedin-signup insert:", error?.message); return res.status(500).json({ error: "We couldn't save that. Please try again." }); }
  const id = row.id;
  /* One team email per sign-up, but never more than 20 an hour in total, so
   * a flood of fake sign-ups can't flood CJ's inbox. Failures are logged;
   * the visitor still goes on to pay. */
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const { count } = await admin.from("linkedin_clients").select("id", { count: "exact", head: true }).eq("source", "sales_page").gte("created_at", hourAgo);
  if ((count || 0) <= 20) {
    const settings = await getSettings(admin);
    const to = Array.isArray(settings.signup_notify) ? settings.signup_notify : ["cj@aisyndicate.com", "ryder@aisyndicate.com"];
    await sendInternalEmail({ to, allowed: TEAM, ...signupEmail({ name: v.name, company: v.company, email: v.email, phone: v.phone, goal: v.goal, consoleUrl: `${adminBaseUrl()}/#/dashboard/linkedin` }) });
  }
  return res.status(200).json({ ok: true, checkoutUrl: checkoutUrl(id, v.email, payLink) });
}
