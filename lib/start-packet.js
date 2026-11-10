/* START PACKET — one link that carries the whole start of a client. 6 Nov 2026.
 *
 * WHY. Andrew, Plaud call 6 Nov 2026 (11:15 AM CT): "Something that Julia can
 * upload a contract, upload the Stripe link ... and upload the onboarding
 * form. ... It's not three different conversations. It's just one email with
 * one conversation." Ryder, same day: "it has to be filled out by one of us
 * and then sent to the client with everything included. And they fill it out
 * and send it back. And then when they send it back, every member of the team
 * gets a copy of that email." Then, 7 Nov 2026: the person SENDING signs for
 * AI Syndicate ("Why can it not come from the person sending the email?") —
 * on 6 Nov it was CJ only.
 *
 * THE SHAPE.
 *   1. A team member fills in a packet in the console: the proposal (what we
 *      do, the price), the agreement (pasted text or a PDF), which question
 *      set, and the Stripe link.
 *   2. The sender signs the agreement for AI Syndicate (their own name).
 *      Any edit to what the client sees after that clears the signature, so
 *      nobody has "signed" words they didn't see.
 *   3. A team member sends the client one email with one private link.
 *      A person presses Send. Nothing in here emails a client by itself.
 *   4. The client reads the proposal, signs, answers the questions, adds a
 *      card in Stripe, and presses "Sign and send back".
 *   5. Every team member gets one email with all of it.
 *
 * This file is PURE: no database, no network. The two routes
 * (api/start-packets.js for the team, api/start-public.js for the client)
 * and the tests (tests/start-packet/test.mjs) all use it. */

import { createHash } from "node:crypto";
import { PLATFORM_STEPS, PARTS, QUESTIONS, FORM_KINDS, GRANT_EMAIL, questionsFor, partsFor, stageLabel } from "./start-questions.js";

export { PLATFORM_STEPS, PARTS, QUESTIONS, FORM_KINDS, GRANT_EMAIL, questionsFor, partsFor, stageLabel };


/* Who gets the team copy when a client sends a packet back. Ryder: "every
 * member of the team gets a copy". START_PACKET_TEAM (comma list) overrides;
 * the person who sent the packet is always added. */
export const DEFAULT_TEAM = ["cj@aisyndicate.com", "andrew@aisyndicate.com", "julia@aisyndicate.com", "ryder@aisyndicate.com"];
export function teamList(extra = []) {
  const env = String(process.env.START_PACKET_TEAM || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const base = env.length ? env : DEFAULT_TEAM;
  const all = [...base, ...extra.map((s) => String(s || "").trim().toLowerCase())].filter((s) => EMAIL_RE.test(s));
  return [...new Set(all)];
}

export const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/i;
export const STATUSES = ["draft", "ready", "sent", "opened", "returned", "void"];
export const LINK_DAYS = 30;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export const sha256 = (data) => createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
const NUL = String.fromCharCode(0);
const clean = (v, max = 2000) => String(v ?? "").split(NUL).join("").trim().slice(0, max);
const cleanLong = (v, max = 60000) => String(v ?? "").split(NUL).join("").replace(/\r\n/g, "\n").trim().slice(0, max);

export function normalUrl(v) {
  const s = clean(v, 600);
  if (!s) return "";
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    return u.toString();
  } catch { return null; }
}

/** The Stripe page the client opens. A Stripe Payment Link (buy.stripe.com)
 * gets our packet id as client_reference_id and the client's email pre-filled
 * (same as the LinkedIn sales page, tested live 6 Nov). Any other https link
 * (a Stripe "add your card" page CJ made) is used as it is. */
export function paymentLinkFor(packet) {
  const raw = packet?.payment_url;
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (/(^|\.)buy\.stripe\.com$/i.test(u.hostname)) {
    u.searchParams.set("client_reference_id", String(packet.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 200));
    if (packet.contact_email && EMAIL_RE.test(packet.contact_email)) u.searchParams.set("prefilled_email", packet.contact_email);
  }
  return u.toString();
}

/** Fill {{business}}-style blanks in the agreement text. Unknown blanks stay
 * as they are so a typo shows instead of vanishing. */
export const BLANKS = ["business", "contact", "package", "price", "term", "start_date", "today"];
export function fillBlanks(text, packet, today = new Date()) {
  const p = packet?.proposal || {};
  const map = {
    business: packet?.business, contact: packet?.contact_name, package: p.package, price: p.price, term: p.term,
    start_date: p.start_date ? prettyDate(p.start_date) : "", today: prettyDate(today),
  };
  return String(text || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => {
    const v = map[k.toLowerCase()];
    return v ? String(v) : m;
  });
}

export function prettyDate(d) {
  const date = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00Z`) : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
}

export function prettyTime(d) {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })} CT`;
}

/* ------------------------------------------------------------------ */
/* The team's draft                                                    */
/* ------------------------------------------------------------------ */

/** Check and tidy what a team member typed. Returns { ok, value, errors }.
 * `forSend` = the stricter check before signing / sending. */
export function validateDraft(body, { forSend = false } = {}) {
  const errors = {};
  const p = body?.proposal || {};
  const value = {
    business: clean(body?.business, 200),
    contact_name: clean(body?.contact_name, 200),
    contact_email: clean(body?.contact_email, 200).toLowerCase(),
    website: body?.website ? normalUrl(body.website) : "",
    lead_id: /^[0-9a-f-]{36}$/i.test(String(body?.lead_id || "")) ? body.lead_id : null,
    form_kind: Object.hasOwn(FORM_KINDS, String(body?.form_kind || "")) ? body.form_kind : "geo",
    proposal: {
      package: clean(p.package, 200),
      price: clean(p.price, 200),
      term: clean(p.term, 400),
      start_date: /^\d{4}-\d{2}-\d{2}$/.test(String(p.start_date || "")) ? p.start_date : "",
      includes: clean(p.includes, 4000),
      notes: clean(p.notes, 4000),
      doc_url: p.doc_url ? normalUrl(p.doc_url) : "",
      /* Onboarding (Ryder, 9 Nov 2026): send the client to one of OUR onboarding
       * forms (the standard GEO form, Ronin's, IFS's…) instead of the questions
       * built into the packet. Empty = the built-in questions. */
      onboarding_url: p.onboarding_url ? normalUrl(p.onboarding_url) : "",
    },
    contract_title: clean(body?.contract_title, 200) || "Agreement",
    contract_text: cleanLong(body?.contract_text),
    payment_url: body?.payment_url ? normalUrl(body.payment_url) : "",
    payment_note: clean(body?.payment_note, 1000),
    stripe_customer_id: clean(body?.stripe_customer_id, 80),
  };
  if (value.website === null) errors.website = "That doesn't look like a web address.";
  if (value.proposal.doc_url === null) errors.doc_url = "That doesn't look like a link.";
  if (value.proposal.onboarding_url === null) errors.onboarding_url = "That doesn't look like a link.";
  if (value.proposal.onboarding_url && !/^https:/i.test(value.proposal.onboarding_url)) errors.onboarding_url = "Use the https link to the form.";
  if (value.payment_url === null) errors.payment_url = "That doesn't look like a link.";
  if (value.payment_url && !/^https:/i.test(value.payment_url)) errors.payment_url = "Use the https Stripe link.";
  if (value.stripe_customer_id && !/^cus_[A-Za-z0-9]{6,60}$/.test(value.stripe_customer_id)) errors.stripe_customer_id = "Stripe customer ids start with cus_.";
  if (!value.business) errors.business = "Add the business name.";
  if (value.contact_email && !EMAIL_RE.test(value.contact_email)) errors.contact_email = "That email doesn't look right.";
  if (forSend) {
    if (!value.contact_name) errors.contact_name = "Add who will sign.";
    if (!value.contact_email) errors.contact_email = errors.contact_email || "Add their email.";
    if (!value.proposal.package) errors.package = "Name the package.";
    if (!value.proposal.price) errors.price = "Add the price.";
    if (!value.contract_text && !body?.has_pdf) errors.contract_text = "Paste the agreement or upload the PDF.";
    if (!value.payment_url) errors.payment_url = "Add the Stripe link.";
  }
  return { ok: Object.keys(errors).length === 0, value, errors };
}

/** What the sender signs: the exact words and numbers the client will see. A change
 * to any of it changes this fingerprint and clears his signature. */
export function contentFingerprint(packet, pdfSha = null) {
  const p = packet?.proposal || {};
  const parts = [
    packet?.business, packet?.contact_name, packet?.contact_email, packet?.website, packet?.form_kind,
    p.package, p.price, p.term, p.start_date, p.includes, p.notes, p.doc_url, p.onboarding_url || "", p.pdf_sha256 || "",
    packet?.contract_title, packet?.contract_text, pdfSha || packet?.contract_pdf_sha256 || "",
    packet?.payment_url, packet?.payment_note,
  ].map((x) => String(x ?? ""));
  return sha256(parts.join("␞"));
}

/* ------------------------------------------------------------------ */
/* Signatures                                                          */
/* ------------------------------------------------------------------ */

export const CONSENT_TEXT = "I have read the proposal and the agreement. I agree to sign electronically, and my electronic signature has the same effect as signing by hand.";

/** A drawn signature is a small PNG data URL; a typed one is just the name.
 * Returns { ok, value:{ kind, data } } or { ok:false, error }. */
export function checkSignature(sig, name) {
  const kind = sig?.kind === "drawn" ? "drawn" : "typed";
  if (kind === "typed") {
    const typed = clean(sig?.data || name, 120);
    if (typed.length < 2) return { ok: false, error: "Type your full name to sign." };
    return { ok: true, value: { kind, data: typed } };
  }
  const data = String(sig?.data || "");
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data)) return { ok: false, error: "Draw your signature in the box." };
  if (data.length > 250000) return { ok: false, error: "That signature is too large. Clear it and sign again." };
  if (data.length < 300) return { ok: false, error: "Draw your signature in the box." };
  return { ok: true, value: { kind, data } };
}

/** The client's whole send-back. Returns { ok, value, errors }. */
export function validateReturn(body, packet) {
  const errors = {};
  const kind = packet?.form_kind || "geo";
  const viaForm = Boolean(packet?.proposal?.onboarding_url);
  /* Onboarding by our form link: the answers go through that form (its own
   * email to the team), so none are checked here — only that they say it's sent. */
  const qs = viaForm ? [] : questionsFor(kind);
  const answers = {};
  const given = body?.answers && typeof body.answers === "object" ? body.answers : {};
  for (const q of qs) {
    let v = given[q.id];
    if (q.type === "checks") {
      const list = Array.isArray(v) ? v : [];
      v = list.map((x) => clean(x, 200)).filter((x) => q.options.includes(x));
      if (v.length) answers[q.id] = v;
    } else if (q.type === "radio") {
      v = clean(v, 200);
      if (v && q.options.includes(v)) answers[q.id] = v;
      else if (v) errors[q.id] = "Pick one of the choices.";
    } else {
      v = clean(v, q.type === "textarea" ? 4000 : 500);
      if (v && q.type === "email" && !EMAIL_RE.test(v)) errors[q.id] = "That email doesn't look right.";
      if (v && q.type === "url" && normalUrl(v) === null) errors[q.id] = "That doesn't look like a link.";
      if (v) answers[q.id] = q.type === "url" ? normalUrl(v) : v;
    }
    if (q.required && !answers[q.id] && !errors[q.id]) errors[q.id] = "This one is needed.";
  }

  const s = body?.signer || {};
  const signer = { name: clean(s.name, 120), title: clean(s.title, 120), email: clean(s.email, 200).toLowerCase() };
  if (signer.name.length < 2) errors.signer_name = "Type your full name.";
  if (!EMAIL_RE.test(signer.email)) errors.signer_email = "Add your email.";
  const sig = checkSignature(body?.signature, signer.name);
  if (!sig.ok) errors.signature = sig.error;
  if (body?.consent !== true) errors.consent = "Tick the box to agree.";

  const payment = { client_says_done: body?.payment_done === true, note: clean(body?.payment_note, 500) };
  if (packet?.payment_url && !payment.client_says_done && !payment.note) {
    errors.payment = "Add your card in Stripe, then tick the box. Paying another way? Say how in the box.";
  }
  const onboarding = viaForm ? { via: "form", url: packet.proposal.onboarding_url, client_says_sent: body?.onboarding_done === true } : { via: "packet" };
  if (viaForm && !onboarding.client_says_sent) errors.onboarding = "Open the onboarding form, send it, then tick the box.";
  if (clean(body?.hp_fax, 50)) return { ok: false, bot: true, errors: { form: "bot" } };
  return { ok: Object.keys(errors).length === 0, value: { answers, signer, signature: sig.ok ? sig.value : null, payment, onboarding }, errors };
}

/* ------------------------------------------------------------------ */
/* What the client page gets                                           */
/* ------------------------------------------------------------------ */

/** The client's view of a packet. Only what they need — no team notes, no
 * Stripe customer id, no ids of our people. */
export function publicView(packet, { pdfUrl = null, proposalPdfUrl = null, now = new Date() } = {}) {
  const returned = packet.status === "returned";
  const prop = { ...(packet.proposal || {}) };
  const onboardingUrl = prop.onboarding_url || "";
  delete prop.pdf_path; delete prop.pdf_sha256; delete prop.onboarding_url;
  return {
    business: packet.business,
    contact_name: packet.contact_name,
    contact_email: packet.contact_email,
    website: packet.website,
    proposal: prop,
    proposal_pdf: proposalPdfUrl ? { url: proposalPdfUrl, name: prop.pdf_name || "Proposal.pdf" } : null,
    onboarding: onboardingUrl ? { url: onboardingUrl } : null,
    contract_title: packet.contract_title || "Agreement",
    contract_text: packet.contract_text ? fillBlanks(packet.contract_text, packet, packet.ais_signed_at ? new Date(packet.ais_signed_at) : now) : "",
    contract_pdf: pdfUrl ? { url: pdfUrl, name: packet.contract_pdf_name || "Agreement.pdf" } : null,
    ais_signature: packet.ais_signed_at ? {
      name: packet.ais_signer_name, title: packet.ais_signer_title || "", kind: packet.ais_signature?.kind || "typed",
      data: packet.ais_signature?.data || packet.ais_signer_name, signed_at: packet.ais_signed_at,
    } : null,
    form_kind: packet.form_kind,
    parts: onboardingUrl ? [] : partsFor(packet.form_kind),
    questions: onboardingUrl ? [] : questionsFor(packet.form_kind),
    platform_steps: PLATFORM_STEPS,
    grant_email: GRANT_EMAIL,
    payment: packet.payment_url ? { url: paymentLinkFor(packet), note: packet.payment_note || "" } : null,
    consent_text: CONSENT_TEXT,
    returned,
    returned_at: returned ? packet.returned_at : null,
    receipt: returned ? receiptFor(packet) : null,
  };
}

/** The client's own copy after sending (shown on the done screen; they can
 * print it). Their answers, their signature, ours, the times. */
export function receiptFor(packet) {
  const sig = packet.client_sig || {};
  return {
    signer: sig.name ? { name: sig.name, title: sig.title || "", email: sig.email, signed_at: sig.signed_at, kind: sig.signature?.kind, data: sig.signature?.data } : null,
    answers: packet.answers || {},
    onboarding: packet.client_sig?.onboarding || null,
    contract_sha256: packet.contract_sha256 || null,
  };
}

/* ------------------------------------------------------------------ */
/* The team's copy                                                     */
/* ------------------------------------------------------------------ */

export function answerText(v) {
  if (Array.isArray(v)) return v.join(", ");
  return String(v ?? "");
}

/** The email every team member gets when a client sends the packet back.
 * Plain text, so it reads the same in every inbox and on a phone. */
export function teamEmail(packet, { consoleUrl = "", paymentCheck = null } = {}) {
  const sig = packet.client_sig || {};
  const p = packet.proposal || {};
  const lines = [];
  const L = (s = "") => lines.push(s);
  L(`${packet.business} signed and sent back their start packet.`);
  L("");
  L("CLIENT");
  L(`- Business: ${packet.business}`);
  if (packet.website) L(`- Website: ${packet.website}`);
  L(`- Contact: ${packet.contact_name || sig.name || "—"} <${packet.contact_email || sig.email || "—"}>`);
  if (sig.email && packet.contact_email && sig.email.toLowerCase() !== packet.contact_email.toLowerCase()) L(`- Signed with a different email: ${sig.email}`);
  L(`- Sent by: ${packet.ais_signer_name || "—"}${packet.sent_by_email ? ` <${packet.sent_by_email}>` : ""}${packet.sent_at ? ` on ${prettyDate(packet.sent_at)}` : ""}`);
  L("");
  L("SIGNED");
  L(`- Client: ${sig.name}${sig.title ? `, ${sig.title}` : ""} <${sig.email}> — ${prettyTime(sig.signed_at)}`);
  L(`- AI Syndicate: ${packet.ais_signer_name || "—"} — ${packet.ais_signed_at ? prettyTime(packet.ais_signed_at) : "—"}`);
  L(`- Agreement: ${packet.contract_title || "Agreement"}${packet.contract_pdf_name ? ` (PDF: ${packet.contract_pdf_name})` : ""}`);
  L(`- Fingerprint (SHA-256) of what was signed: ${packet.contract_sha256 || "—"}`);
  L(`- Signed from IP ${sig.ip || "—"}`);
  L("");
  L("PROPOSAL");
  L(`- Package: ${p.package || "—"}`);
  L(`- Price: ${p.price || "—"}`);
  if (p.term) L(`- Terms: ${p.term}`);
  if (p.start_date) L(`- Start: ${prettyDate(p.start_date)}`);
  const incl = String(p.includes || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (incl.length) L(`- Included: ${incl.join("; ")}`);
  if (p.notes) L(`- Notes to the client: ${String(p.notes).replace(/\n+/g, " / ")}`);
  if (p.pdf_name) L(`- Proposal PDF: ${p.pdf_name}`);
  if (p.doc_url) L(`- Proposal link: ${p.doc_url}`);
  L("");
  L("PAYMENT");
  const pay = packet.payment_status || {};
  L(`- Client says card added in Stripe: ${pay.client_says_done ? "yes" : "no"}`);
  if (pay.note) L(`- Client's note: ${pay.note}`);
  if (paymentCheck) L(`- Stripe check (read-only): ${paymentCheck.text}`);
  else L("- Stripe check: not run (no Stripe customer on this packet). Check Stripe before work starts.");
  L("");
  const ob = packet.client_sig?.onboarding;
  if (packet.proposal?.onboarding_url) {
    L("ONBOARDING");
    L(`- By our onboarding form: ${packet.proposal.onboarding_url}`);
    L(`- Client says they sent it: ${ob?.client_says_sent ? "yes" : "no"}`);
    L("- Their answers come in that form's own email (subject starts with the business name).");
  }
  const answers = packet.answers || {};
  if (!packet.proposal?.onboarding_url) L(`ANSWERS (${FORM_KINDS[packet.form_kind] || "GEO only"})`);
  for (const part of packet.proposal?.onboarding_url ? [] : partsFor(packet.form_kind)) {
    const qs = questionsFor(packet.form_kind).filter((q) => q.part === part.id);
    const got = qs.filter((q) => answers[q.id] && answerText(answers[q.id]));
    L("");
    L(part.title.toUpperCase());
    if (!got.length) { L("- (nothing filled in)"); continue; }
    for (const q of got) L(`- ${q.label}: ${answerText(answers[q.id]).replace(/\n+/g, " / ")}`);
  }
  L("");
  if (consoleUrl) L(`Everything, including both signatures: ${consoleUrl}`);
  L("");
  L("— AI Syndicate console (Start packets)");
  return {
    subject: `Signed + sent back: ${packet.business} start packet`,
    text: lines.join("\n").slice(0, 20000),
  };
}

/** The email a team member sends the client (they can edit it before sending). */
export function clientEmailDraft(packet, link, senderName = "") {
  const first = String(packet.contact_name || "").split(/\s+/)[0] || "there";
  const pay = packet.payment_url ? "add your card in Stripe, " : "";
  const tell = packet.proposal?.onboarding_url ? "fill in our onboarding form" : "answer a few questions about your business";
  return {
    subject: `${packet.business} + AI Syndicate: everything to get started`,
    body: [
      `Hi ${first},`,
      "",
      "Thanks again for choosing AI Syndicate. Everything to get started is in one place:",
      "",
      link,
      "",
      `It takes about 10 minutes. You'll see the proposal, sign the agreement, ${tell}, ${pay}and press "Sign and send back." You can stop and come back to the same link.`,
      "",
      "Any questions, just reply to this email.",
      "",
      "Thanks,",
      senderName || "AI Syndicate",
    ].join("\n"),
  };
}

/** Read-only Stripe check of a customer. `stripe` is the SDK client (restricted
 * key). Never throws; returns { state: 'card'|'none'|'unknown', text }. */
export async function checkStripeCard(stripe, customerId) {
  if (!stripe || !customerId) return { state: "unknown", text: "not checked" };
  try {
    const c = await stripe.customers.retrieve(customerId);
    if (!c || c.deleted) return { state: "unknown", text: `Stripe has no customer ${customerId}` };
    if (c.invoice_settings?.default_payment_method || c.default_source) return { state: "card", text: `card on file for ${c.email || customerId}` };
    try {
      const pms = await stripe.customers.listPaymentMethods(customerId, { limit: 1 });
      if (pms?.data?.length) return { state: "card", text: `card on file for ${c.email || customerId}` };
    } catch { /* key may not read payment methods */ }
    return { state: "none", text: `no card on file yet for ${c.email || customerId}` };
  } catch (err) {
    return { state: "unknown", text: `couldn't check Stripe (${String(err?.message || "error").slice(0, 80)})` };
  }
}
