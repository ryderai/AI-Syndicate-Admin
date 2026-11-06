/* LINKEDIN OUTREACH v2 — pure helpers for the sales-page sign-up, the
 * client's login details, WhatsApp links and per-person follow-ups.
 * 6 Nov 2026. No database, no network: everything here is tested in
 * tests/linkedin-v2/test.mjs.
 *
 * WHY each piece exists is in supabase/migrations/0053_linkedin_v2.sql. */

/* CJ's Stripe payment link for the service ($1,000/month), 2 Nov 2026
 * (LinkedIn-Engine-Nov03/PAYMENT-LINK-FIT-v2-2026-11-03.md). An env var can
 * replace it without a code change. */
export const DEFAULT_PAYMENT_LINK = "https://buy.stripe.com/5kQfZi0vF0mH4pJ9Vg5gc00";
export const PRICE_PER_MONTH = 1000;
export const FORM_URL = "https://www.aisyndicate.com/onboarding/linkedin/";

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const isEmail = (s) => EMAIL.test(String(s || "").trim()) && String(s).length <= 254;
/* Control characters out (they break emails and the console), then trim + clip. */
const clip = (s, n) => Array.from(String(s == null ? "" : s)).filter((ch) => { const c = ch.codePointAt(0); return c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127); }).join("").trim().slice(0, n);

/** Check a sales-page sign-up. Returns { ok, value } or { ok:false, errors }.
 * `hp_check` is the hidden honeypot field; people never fill it. */
export function validateSignup(body = {}) {
  const errors = {};
  const v = {
    name: clip(body.name, 120),
    company: clip(body.company, 160),
    email: clip(body.email, 254).toLowerCase(),
    phone: clip(body.phone, 40),
    linkedin_url: clip(body.linkedin_url, 300),
    site: clip(body.site, 300),
    goal: clip(body.goal, 1500),
  };
  if (v.name.length < 2) errors.name = "Please add your name.";
  if (v.company.length < 2) errors.company = "Please add your company.";
  if (!isEmail(v.email)) errors.email = "Please add a working email.";
  if (v.phone && v.phone.replace(/\D/g, "").length < 7) errors.phone = "That phone number looks short.";
  if (v.linkedin_url && !/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\//i.test(v.linkedin_url)) errors.linkedin_url = "Paste the link to your LinkedIn profile (linkedin.com/in/…).";
  if (v.site && !/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(v.site)) errors.site = "That website doesn't look right.";
  /* Honeypot: a hidden box named so browsers don't autofill it (a field
   * called "website" got autofilled — 6 Nov check). */
  const bot = String(body.hp_check || "").trim() !== "";
  return Object.keys(errors).length ? { ok: false, errors, bot } : { ok: true, value: v, bot };
}

/** CJ's payment link, tied to the sign-up row so the Stripe webhook can match
 * the payment without guessing (client_reference_id), with the email filled
 * in. Both are documented Stripe payment-link settings. */
export function checkoutUrl(rowId, email, base = DEFAULT_PAYMENT_LINK) {
  const u = new URL(base);
  u.searchParams.set("client_reference_id", rowId);
  if (email) u.searchParams.set("prefilled_email", email);
  return u.toString();
}

/** The onboarding form link for a sign-up. The ref ties the form back to the
 * paid sign-up (the website stores ?ref= on the form row). */
export const signupRef = (rowId) => `sp-${String(rowId).replace(/-/g, "").slice(0, 12)}`;
export function onboardingLink(rowId) { return `${FORM_URL}?ref=${signupRef(rowId)}`; }

/** Which paid sign-up a sent form belongs to. Ref first (exact); else the
 * email, but only when exactly ONE paid, unmerged sign-up has it — two
 * means a person decides. Returns the sign-up or null. Pure. */
export function matchSignup(form, signups = []) {
  const open = signups.filter((s) => s.status === "signup" && s.paid_at && !s.merged_into);
  if (form.ref) {
    const byRef = open.filter((s) => signupRef(s.id) === String(form.ref).trim().toLowerCase());
    if (byRef.length === 1) return byRef[0];
  }
  const email = String(form.contact_email || "").trim().toLowerCase();
  if (!email) return null;
  const byEmail = open.filter((s) => String(s.contact_email || "").trim().toLowerCase() === email);
  return byEmail.length === 1 ? byEmail[0] : null;
}

/** The fields a merge moves from the paid sign-up onto the form row. The
 * Stripe ids MOVE (cleared on the sign-up) so a renewal can't match both. */
export function mergePatch(signup) {
  return {
    form: {
      paid_at: signup.paid_at, paid_source: signup.paid_source || "stripe_checkout",
      stripe_customer_id: signup.stripe_customer_id || null, stripe_subscription_id: signup.stripe_subscription_id || null,
      renewal_date: signup.renewal_date || null, last_invoice_paid_at: signup.last_invoice_paid_at || null,
    },
    signup: { status: "merged", stripe_customer_id: null, stripe_subscription_id: null },
  };
}

/* ---------- the client's login details ---------- */
export const CODE_METHODS = Object.freeze([
  ["whatsapp", "WhatsApp Julie the code"],
  ["page", "Type the code on this page"],
  ["email", "Forward LinkedIn's code email to Julie"],
]);

/** Digits with an optional leading +, 8-15 digits (E.164). "" if it isn't one. */
export function normalisePhone(s) {
  const raw = String(s || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return "";
  return raw.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

/** wa.me link (WhatsApp's own click-to-chat format) with an optional message. */
export function waLink(phone, text = "") {
  const p = normalisePhone(phone).replace(/^\+/, "");
  if (!p) return "";
  return `https://wa.me/${p}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

/** Check the login details the client sends. Never accepts a password field:
 * if one arrives it is dropped and flagged, so the page can say so. */
export function validateLoginDetails(body = {}) {
  const errors = {};
  const v = {
    login_email: clip(body.login_email, 254).toLowerCase(),
    login_location: clip(body.login_location, 160),
    whatsapp: normalisePhone(body.whatsapp),
    login_times: clip(body.login_times, 500),
    code_method: String(body.code_method || ""),
  };
  if (!isEmail(v.login_email)) errors.login_email = "Add the email you sign in to LinkedIn with.";
  if (v.login_location.length < 2) errors.login_location = "Add the city and state (or country) you usually log in from.";
  if (!CODE_METHODS.some(([k]) => k === v.code_method)) errors.code_method = "Pick how you'll pass Julie the code.";
  if (v.code_method === "whatsapp" && !v.whatsapp) errors.whatsapp = "Add your WhatsApp number with the country code.";
  if (body.whatsapp && !v.whatsapp) errors.whatsapp = "That WhatsApp number doesn't look right. Include the country code, like +1 205 555 0100.";
  if (v.login_times.length < 3) errors.login_times = "Give two or three times that work for a 5-minute login.";
  const passwordOffered = Object.keys(body).some((k) => /pass/i.test(k));
  return Object.keys(errors).length ? { ok: false, errors, passwordOffered } : { ok: true, value: v, passwordOffered };
}

/* ---------- per-person follow-ups ---------- */
const addDays = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

/** When the next message to one prospect is due, from the approved
 * variant's delays (step 1 counts from acceptance, each later step from the
 * one before — the brief). null when nothing is left to send. Pure. */
export function nextStep(prospect, steps = []) {
  if (prospect.status !== "active") return null;
  const next = (prospect.last_step || 0) + 1;
  const s = steps.find((x) => Number(x.step) === next);
  if (!s) return null;
  const from = next === 1 ? prospect.accepted_on : (prospect.last_sent_on || prospect.accepted_on);
  if (!from) return null;
  return { step: next, due: addDays(from, Number(s.delay_days) || 0) };
}

/** Parse "one person per line" from Julie's paste: `Name, https://linkedin…`
 * or just a name. Up to 200 a time; blank lines skipped. Pure. */
export function parseProspectLines(text) {
  return String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200).map((l) => {
    const url = (l.match(/https?:\/\/\S*linkedin\.com\/\S+/i) || [])[0] || null;
    const name = clip(l.replace(url || "", "").replace(/[,;|\t]+\s*$/, "").replace(/^[\s,;|\t-]+/, ""), 200);
    return { name, profile_url: url ? url.replace(/[),.;]+$/, "") : null };
  }).filter((p) => p.name.length >= 1);
}

/** Follow-ups due on or before `today`, one item per person, oldest first. */
export function dueFollowUps(prospects = [], stepsByClient = {}, today) {
  const out = [];
  for (const p of prospects) {
    const n = nextStep(p, stepsByClient[p.li_client_id] || []);
    if (n && n.due <= today) out.push({ ...n, id: p.id, li_client_id: p.li_client_id, name: p.name, profile_url: p.profile_url });
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.step - b.step));
}
