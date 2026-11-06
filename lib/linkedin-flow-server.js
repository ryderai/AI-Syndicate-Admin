/* Server helpers for the LinkedIn Outreach flow: stage moves, one-use links,
 * draft emails, settings. 4 Nov 2026. Used by the api/linkedin-* routes. */
import { canAutoMove, isStage } from "./linkedin-flow.js";
import { newToken, hashToken, adminBaseUrl } from "./linkedin-tokens.js";
import { draftEmail, DEFAULT_JULIE_EMAIL } from "./linkedin-emails.js";
import { matchSignup, mergePatch, onboardingLink } from "./linkedin-v2.js";

const DAY = 864e5;

/** Move an engagement's stage. `manual` = a person chose it (any move);
 * otherwise only the brief's next steps are allowed, and a move that doesn't
 * fit is skipped quietly (e.g. a revision while the client is already Live
 * doesn't drag them back to Building). */
export async function moveStage(admin, id, to, { manual = false } = {}) {
  if (!isStage(to)) return { ok: false, error: "Unknown stage." };
  const { data: e } = await admin.from("linkedin_clients").select("id, flow_stage").eq("id", id).maybeSingle();
  if (!e) return { ok: false, error: "Not found." };
  if (e.flow_stage === to) return { ok: true, unchanged: true };
  if (!manual && !canAutoMove(e.flow_stage, to)) return { ok: true, skipped: `${e.flow_stage} -> ${to}` };
  const { error } = await admin.from("linkedin_clients").update({ flow_stage: to }).eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** A fresh approval link (14 days). Making a new one retires the old. */
export async function approvalLink(admin, id) {
  const token = newToken();
  const { error } = await admin.from("linkedin_clients").update({ approval_token_hash: hashToken(token), approval_token_expires_at: new Date(Date.now() + 14 * DAY).toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
  return `${adminBaseUrl()}/li/approve/?t=${token}`;
}

/** A fresh PIN link (60 days — a client may need it again if LinkedIn asks
 * Julie to verify later). A new one retires the old. */
export async function pinLink(admin, id) {
  const token = newToken();
  const { error } = await admin.from("linkedin_clients").update({ pin_token_hash: hashToken(token), pin_token_expires_at: new Date(Date.now() + 60 * DAY).toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
  return `${adminBaseUrl()}/li/pin/?t=${token}`;
}

/** The engagement a public token belongs to, if it is still valid. */
export async function byToken(admin, kind, token) {
  const col = kind === "pin" ? "pin_token_hash" : "approval_token_hash";
  const exp = kind === "pin" ? "pin_token_expires_at" : "approval_token_expires_at";
  const { data } = await admin.from("linkedin_clients")
    .select("id, company, contact_name, contact_email, flow_stage, answers, booking_at, " + exp)
    .eq(col, hashToken(token)).maybeSingle();
  if (!data || !data[exp] || new Date(data[exp]) < new Date()) return null;
  return data;
}

/** Put a draft email in the outbox. Never sends. */
export async function draftToOutbox(admin, { client, kind, data = {}, to = null, cc = [] }) {
  const mail = draftEmail(kind, { contactName: client.contact_name, company: client.company, ...data });
  if (!mail) return null;
  const { data: row } = await admin.from("linkedin_outbox").insert({
    li_client_id: client.id, kind, to_email: to || client.contact_email || null, cc, subject: mail.subject, body_text: mail.text,
  }).select("id").maybeSingle();
  return row?.id || null;
}

export async function getSettings(admin) {
  const { data } = await admin.from("linkedin_settings").select("key, value");
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]));
}

/* ---------- v2, 6 Nov 2026: sales-page sign-ups ---------- */

const SIGNUP_COLS = "id, status, company, contact_name, contact_email, paid_at, paid_source, stripe_customer_id, stripe_subscription_id, renewal_date, last_invoice_paid_at, merged_into, signup_paid_drafted_at, created_at";

/** Fold paid sales-page sign-ups into the client's onboarding-form row, and
 * draft the "payment received, here's your form" email once per paid
 * sign-up. Runs on every console load of the flow and in the daily run, so
 * a payment is never stranded on the sign-up row. Never sends anything.
 * Returns { merged, drafted }. */
export async function linkSignups(admin) {
  const out = { merged: 0, drafted: 0, already: 0 };
  const { data: signups, error } = await admin.from("linkedin_clients").select(SIGNUP_COLS).eq("status", "signup").not("paid_at", "is", null).limit(200);
  if (error || !signups?.length) return out;
  const { data: forms } = await admin.from("linkedin_clients").select("id, ref, contact_email, paid_at, stripe_subscription_id").eq("status", "submitted").limit(1000);
  const used = new Set();

  /* 1. Stripe sometimes sends invoice.paid before checkout.session.completed,
   * so the webhook may already have marked the client's FORM row paid with
   * this subscription (6 Nov check). Then the sign-up is only a duplicate
   * record of the same payment: mark it merged, move nothing, draft nothing. */
  for (const s of signups) {
    if (!s.stripe_subscription_id) continue;
    /* Only a PAID holder: the webhook can also save a subscription id on an
     * unpaid form ($0 invoice, failed payment) — that one goes through the
     * normal merge in step 2, which moves the payment (6 Nov re-check). */
    const holder = (forms || []).find((f) => f.paid_at && f.stripe_subscription_id === s.stripe_subscription_id);
    if (!holder) continue;
    const { data: done } = await admin.from("linkedin_clients").update({ status: "merged", merged_into: holder.id, stripe_customer_id: null, stripe_subscription_id: null }).eq("id", s.id).eq("status", "signup").select("id");
    if (done?.length) { used.add(s.id); out.already += 1; }
  }

  /* 2. Move a paid sign-up onto its unpaid form row. Email matching only when
   * exactly ONE unpaid form has that email (the webhook's rule: two sent
   * forms with one email = a person decides). */
  const unpaid = (forms || []).filter((f) => !f.paid_at);
  const perEmail = {};
  for (const f of unpaid) { const e = String(f.contact_email || "").toLowerCase(); if (e) perEmail[e] = (perEmail[e] || 0) + 1; }
  for (const f of unpaid) {
    const shared = perEmail[String(f.contact_email || "").toLowerCase()] > 1;
    const s = matchSignup(shared ? { ref: f.ref } : f, signups.filter((x) => !used.has(x.id)));
    if (!s) continue;
    const r = await mergeSignupInto(admin, s, f.id);
    if (r.ok) { used.add(s.id); out.merged += 1; }
  }

  /* 3. Paid sign-ups with no form yet: draft the welcome (with the form link)
   * ONCE, and only while the row is still a plain sign-up. */
  for (const s of signups) {
    if (used.has(s.id) || s.signup_paid_drafted_at) continue;
    const { data: mark } = await admin.from("linkedin_clients").update({ signup_paid_drafted_at: new Date().toISOString() }).eq("id", s.id).eq("status", "signup").is("signup_paid_drafted_at", null).select("id");
    if (!mark?.length) continue;
    await draftToOutbox(admin, { client: s, kind: "signup_paid", data: { formUrl: onboardingLink(s.id) } });
    out.drafted += 1;
  }
  return out;
}

/** Move one paid sign-up's payment onto a form row, all or nothing. The
 * sign-up is claimed first (status signup -> merged), so two runs can't
 * both take it; the form row is written only if it is still unpaid, and if
 * that doesn't land the claim is undone, so a payment is never left on
 * nothing (6 Nov check). Used by linkSignups and the console's "Link". */
export async function mergeSignupInto(admin, s, formId) {
  const p = mergePatch(s);
  const { data: claimed } = await admin.from("linkedin_clients").update({ ...p.signup, merged_into: formId }).eq("id", s.id).eq("status", "signup").select("id");
  if (!claimed?.length) return { ok: false, error: "Already linked." };
  const { data: wrote, error } = await admin.from("linkedin_clients").update(p.form).eq("id", formId).eq("status", "submitted").is("paid_at", null).select("id");
  if (error || !wrote?.length) {
    await admin.from("linkedin_clients").update({ status: "signup", merged_into: null, stripe_customer_id: s.stripe_customer_id || null, stripe_subscription_id: s.stripe_subscription_id || null }).eq("id", s.id);
    return { ok: false, error: error?.message || "That client already shows as paid, or hasn't sent the form." };
  }
  return { ok: true };
}

/** What the "approved — one quick step" email needs, from the settings. One
 * place, so the client page and the console's "approved by email" button
 * draft the same email. */
export function approvedBookData(settings = {}, loginUrl = null) {
  const str = (k) => (typeof settings[k] === "string" && settings[k].trim() ? settings[k].trim() : null);
  return { bookingUrl: str("booking_url"), pinUrl: loginUrl, loginUrl, julieEmail: str("julie_email") || DEFAULT_JULIE_EMAIL, julieWhatsapp: str("julie_whatsapp"), passwordMethod: str("password_method") };
}
