/* Server helpers for the LinkedIn Outreach flow: stage moves, one-use links,
 * draft emails, settings. 4 Nov 2026. Used by the api/linkedin-* routes. */
import { canAutoMove, isStage } from "./linkedin-flow.js";
import { newToken, hashToken, adminBaseUrl } from "./linkedin-tokens.js";
import { draftEmail } from "./linkedin-emails.js";

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
