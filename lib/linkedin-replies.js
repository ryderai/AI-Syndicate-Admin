/* LINKEDIN OUTREACH — the reply classifier (Build 2). 4 Nov 2026.
 *
 * CJ's brief: "Every prospect reply Julie logs is classified by Claude and,
 * when it's a lead, pushed to the client with a drafted response the same
 * day." Julie pastes the reply; one small call returns the classification,
 * a confidence, a suggested reply written as the client, a reactivation date
 * for Not now / Out of office, and a one-line summary. Under 0.6 confidence
 * it waits for Julie. Pure except classify(), which takes the model call. */
import { riskReview, checkOutput, firstName, MERGE_FIELDS } from "./linkedin-messages.js";

export const CLASSES = Object.freeze(["Interested", "Question", "Not now", "Not interested", "Referral", "Out of office", "Wrong person"]);
/* The brief's table "Actions by classification". */
export const ACTIONS = Object.freeze({
  "Interested": { status: "lead", notify: "client+cj" },
  "Question": { status: "lead", notify: "client" },
  "Referral": { status: "lead", notify: "client" },
  "Not now": { status: "nurture", notify: null },
  "Out of office": { status: "nurture", notify: null },
  "Not interested": { status: "closed", notify: null },
  "Wrong person": { status: "closed", notify: null },
});
export const REVIEW_BELOW = 0.6;
export const PROMPT_VERSION = "li-reply-2026-11-04.1";

const asText = (v) => (v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v));

export function buildSystem(answers = {}) {
  const risk = riskReview(answers);
  return [
    "You sort replies to LinkedIn outreach for one business and draft the business owner's answer.",
    `Classify the reply as exactly one of: ${CLASSES.join(", ")}.`,
    "confidence: 0 to 1, how sure you are.",
    `suggested_reply: written in first person as the business owner (${firstName(answers) || "the owner"}), max 400 characters, ends with a clear next step. Never mention an agency, AI, or a third party. Use only facts from the business description; never invent numbers, clients or results. No links. Only these merge tokens if any: ${MERGE_FIELDS.join(", ")}.`,
    risk.review ? "This business is regulated: never state terms, returns, amounts, percentages or guarantees; offer to share information on request or on a call." : "",
    "reactivation_date: an ISO date (YYYY-MM-DD) ONLY for Not now and Out of office — the date in the reply if it gives one, else 30 days from today. Otherwise null.",
    "summary: one line.",
    "referred_name: the name of the person they referred you to, if any, else null.",
    'Return JSON only: {"classification":"","confidence":0,"suggested_reply":"","reactivation_date":null,"summary":"","referred_name":null}',
  ].filter(Boolean).join("\n");
}

export function buildUserMessage({ answers = {}, sequenceText = "", reply = "", prospect = "", today = "" }) {
  return [
    `Today: ${today}`,
    `The business:\n${asText(answers.about_business) || "(not given)"}`,
    `What the prospect was sent:\n${sequenceText || "(not known)"}`,
    `The prospect: ${prospect || "(name not given)"}`,
    `Their reply:\n${reply}`,
  ].join("\n\n");
}

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Model text -> a checked classification. Never throws. Pure. */
export function parseClassification(raw, { answers = {}, today }) {
  const text = String(raw || "").replace(/```(?:json)?/gi, "");
  const a = text.indexOf("{"); const b = text.lastIndexOf("}");
  let o = null;
  try { o = a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null; } catch { o = null; }
  if (!o) return { ok: false, error: "The answer was not JSON." };
  const classification = CLASSES.find((c) => c.toLowerCase() === asText(o.classification).trim().toLowerCase()) || null;
  let confidence = Number(o.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));
  let reactivation = /^\d{4}-\d{2}-\d{2}$/.test(asText(o.reactivation_date)) ? o.reactivation_date : null;
  if (["Not now", "Out of office"].includes(classification) && !reactivation) reactivation = addDays(today, 30);
  if (!["Not now", "Out of office"].includes(classification)) reactivation = null;
  const suggested = asText(o.suggested_reply).trim();

  const issues = checkSuggested(suggested, answers);
  const blocked = issues.filter((i) => i.level === "block");
  const needsReview = !classification || confidence < REVIEW_BELOW || blocked.length > 0;
  return {
    ok: Boolean(classification),
    error: classification ? null : "Unknown classification.",
    classification,
    confidence: Math.round(confidence * 100) / 100,
    suggested_reply: suggested,
    reactivation_date: reactivation,
    summary: asText(o.summary).trim().slice(0, 300),
    referred_name: asText(o.referred_name).trim() || null,
    reply_status: classification ? ACTIONS[classification].status : null,
    notify: classification ? ACTIONS[classification].notify : null,
    needs_review: needsReview,
    issues,
  };
}

/** The suggested reply through the same checker as the sequence (as a reply
 * template): length, no made-up numbers, no links, risk words. Pure. */
export function checkSuggested(suggested, answers = {}) {
  if (!String(suggested || "").trim()) return [];
  const shell = { variants: [], target_lists: [], reply_templates: { interested: suggested }, notes_for_reviewer: "" };
  return checkOutput(shell, answers, riskReview(answers)).filter((i) => i.where === "Reply template · interested");
}

/** One call (temperature 0.2), one retry if the JSON doesn't parse. */
export async function classify({ answers, sequenceText, reply, prospect, today, draftFn }) {
  const system = buildSystem(answers);
  const context = buildUserMessage({ answers, sequenceText, reply, prospect, today });
  const calls = [];
  const ask = async (ctx) => {
    const r = await draftFn({ kind: "linkedin_reply", system, temperature: 0.2, context: ctx, maxTokens: 800, maxInputChars: 12000 });
    calls.push(r);
    return r.text;
  };
  let parsed = parseClassification(await ask(context), { answers, today });
  if (!parsed.ok) parsed = parseClassification(await ask(`${context}\n\nReturn ONLY the JSON object in the exact shape given.`), { answers, today });
  return { ...parsed, calls, promptVersion: PROMPT_VERSION };
}

/** What changes when Julie overrides a classification. A reactivation date
 * already on the reply (e.g. from an out-of-office message) is kept. Pure. */
export function override(classification, today, existingDate = null) {
  if (!CLASSES.includes(classification)) return null;
  const nurture = ["Not now", "Out of office"].includes(classification);
  return {
    classification,
    reply_status: ACTIONS[classification].status,
    notify: ACTIONS[classification].notify,
    reactivation_date: nurture ? (existingDate || addDays(today, 30)) : null,
    needs_review: false,
  };
}
