/* PROOF OF CONSENT — 25 Sep 2026. The table is migration 0045.
 *
 * A page that asks for a phone number shows a consent line and posts
 *   consent: { version, text, at }
 * with the lead. This file keeps the CANONICAL wording for every version the
 * pages have ever shown, cleans what arrived, and writes one append-only row.
 *
 * WHY THE WORDING LIVES HERE TOO. The row is evidence of what the person saw.
 * If the console stored whatever text a post carried, anybody could post
 * "agreed to everything". So the stored text is always OURS for that version,
 * and `text_matches` records whether the page sent the same words. A post
 * with an unknown version is not stored as consent at all.
 *
 * Add a new version here BEFORE a page ships new wording, never edit an old
 * one: old rows point at it.
 */

import { clean } from "./home-services.js";

export const CONSENT_TEXTS = {
  /* the landing-page calculator popup (Home-Services-LP/assets/calc-popup.js) */
  "2026-09-24": 'By tapping "Show my number" you agree AI Syndicate may call, text or email you about your results and our services. Message and data rates may apply. Reply STOP to any text to stop them.',
  /* the calculator page's profit-report form (ai-syndicate-live/public/ai-revenue-calculator/calc.js) */
  "2026-09-25-calc": 'By tapping "Show my profit report" you agree AI Syndicate may call, text or email you about your results and our services. Message and data rates may apply. Reply STOP to any text to stop them.',
};

const norm = (s) => String(s || "").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

/** The consent part of a post, cleaned, or null when there is nothing we can
 * honestly store (no version, or a version we never showed). */
export function cleanConsent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const version = clean(raw.version, 40);
  const text = CONSENT_TEXTS[version];
  if (!version || !text) return null;
  const at = new Date(String(raw.at || ""));
  return {
    version,
    text,
    textMatches: norm(raw.text) === norm(text),
    capturedAt: Number.isNaN(at.getTime()) ? null : at.toISOString(),
  };
}

/** The line a rep reads on the lead. */
export function consentNote(c, where, dateIso = new Date().toISOString()) {
  if (!c) return "";
  return `${String(dateIso).slice(0, 10)} · Agreed to calls, texts and email (consent ${c.version}${c.textMatches ? "" : ", wording differed from ours"}) on ${where}.`;
}

function requestIp(req) {
  const fwd = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return clean(fwd || req?.headers?.["x-real-ip"] || "", 64) || null;
}

/** Write the row. Returns true when it landed. Never throws. */
export async function recordConsent(admin, req, leadId, c, { source, pagePath = null, pageSlug = null } = {}) {
  if (!admin || !leadId || !c) return false;
  try {
    /* Written INLINE, no spread: tests/calculator/columns.mjs reads this literal. */
    const { error } = await admin.from("admin_lead_consents").insert({
      lead_id: leadId,
      consent_version: c.version,
      consent_text: c.text,
      text_matches: c.textMatches,
      channels: ["call", "text", "email"],
      source,
      page_path: pagePath,
      page_slug: pageSlug,
      captured_at: c.capturedAt,
      ip: requestIp(req),
      user_agent: clean(req?.headers?.["user-agent"], 300) || null,
    });
    if (error) { console.error("[consent] insert failed", error.message); return false; }
    return true;
  } catch (err) {
    console.error("[consent] threw", err?.message || err);
    return false;
  }
}
