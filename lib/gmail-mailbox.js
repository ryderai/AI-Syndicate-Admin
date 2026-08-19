/* Shared-mailbox rules + message building for the team inbox.
 *
 * WHY THIS FILE EXISTS
 * A mailbox like growth@aisyndicate.com belongs to the agency, not to whoever
 * happened to click Connect. Before Aug 18 2026 every Gmail endpoint looked up
 * the connection with .eq("user_id", me), so only the connector could read it.
 * Every endpoint now asks resolveMailbox() instead, and the answer is the same
 * everywhere: you get a mailbox if you connected it, or if it is marked shared
 * AND you are an owner/admin. Sales never gets a shared mailbox.
 *
 * The refresh token is only ever read here, server-side, with the service role.
 * The browser cannot select that column at all (column grants in 0001/0003).
 */

import { getAdminSupabase } from "./supabase-server.js";
import { gmailFetch, accountNeedsReconnect } from "./google-oauth.js";

const ADMIN_ROLES = ["owner", "admin"];

/** Every mailbox this member may work: their own, plus shared ones if admin. */
export async function listMailboxesFor(member) {
  const admin = getAdminSupabase();
  const isAdminRole = ADMIN_ROLES.includes(member.membership.role);
  let q = admin
    .from("admin_gmail_accounts")
    .select("user_id, email_address, scope, connected_at, shared, display_name, last_synced_at")
    .order("connected_at", { ascending: true });
  // A sales rep only ever sees their own. Written as two branches rather than
  // one clever filter so the sales case is impossible to read the wrong way.
  q = isAdminRole
    ? q.or(`user_id.eq.${member.user.id},shared.is.true`)
    : q.eq("user_id", member.user.id);

  const { data, error } = await q;
  if (error) return { error: error.message };

  // The same address can be connected privately by one person and shared by
  // another. Show it once, prefer the row that is actually mine, and treat it
  // as shared if ANY row for it is shared.
  const seen = new Map();
  for (const r of data || []) {
    const row = {
      email_address: r.email_address,
      display_name: r.display_name,
      shared: Boolean(r.shared),
      scope: r.scope,
      connected_at: r.connected_at,
      last_synced_at: r.last_synced_at,
      mine: r.user_id === member.user.id,
      needs_reconnect: accountNeedsReconnect(r.scope),
    };
    const prev = seen.get(row.email_address);
    if (!prev) { seen.set(row.email_address, row); continue; }
    seen.set(row.email_address, {
      ...(prev.mine ? prev : row),
      shared: prev.shared || row.shared,
      mine: prev.mine || row.mine,
    });
  }
  return { mailboxes: [...seen.values()] };
}

/** May this member use this mailbox? Returns the refresh token if so. */
export async function resolveMailbox(member, address) {
  if (!address) return { status: 400, error: "Missing account." };
  const admin = getAdminSupabase();
  const { data, error } = await admin
    .from("admin_gmail_accounts")
    .select("user_id, email_address, refresh_token, scope, shared, display_name")
    .eq("email_address", address)
    .limit(10);
  if (error) return { status: 500, error: error.message };

  const rows = data || [];
  if (!rows.length) return { status: 404, error: "That mailbox isn't connected." };

  const mine = rows.find((r) => r.user_id === member.user.id);
  const isAdminRole = ADMIN_ROLES.includes(member.membership.role);
  const shared = isAdminRole ? rows.find((r) => r.shared) : null;
  const row = mine || shared;
  if (!row) {
    return {
      status: 403,
      error: "That mailbox isn't connected for your login, and it isn't shared with the team.",
    };
  }
  return {
    mailbox: row.email_address,
    displayName: row.display_name || null,
    refreshToken: row.refresh_token,
    viaShared: !mine,
    needsReconnect: accountNeedsReconnect(row.scope),
  };
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

/** Gmail rejects control characters and very long label names. Filtered by
 * character code rather than a regex range so no control character has to be
 * written into this source file. */
export function safeLabelName(name) {
  return String(name || "")
    .split("")
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Our one label namespace, so nothing we create can collide with a real one. */
export function clientLabelName(clientName) {
  return `AIS/Client/${safeLabelName(clientName).replace(/\//g, "-")}`;
}
export const DONE_LABEL = "AIS/Done";

/** name -> id for the labels asked for, creating any that do not exist yet. */
export async function ensureLabels(token, names) {
  const wanted = [...new Set((names || []).map(safeLabelName).filter(Boolean))];
  if (!wanted.length) return {};
  const list = await gmailFetch(token, "/labels");
  const byName = new Map((list.labels || []).map((l) => [l.name, l.id]));
  const out = {};
  for (const name of wanted) {
    if (byName.has(name)) { out[name] = byName.get(name); continue; }
    try {
      const made = await gmailFetch(token, "/labels", {
        method: "POST",
        body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
      });
      out[name] = made.id;
      byName.set(name, made.id);
    } catch (err) {
      // Two people marking Done in the same second both try to create the
      // label; the loser gets a 409. Re-read and take the winner's id.
      if (err?.statusCode === 409 || /exist/i.test(err?.message || "")) {
        const again = await gmailFetch(token, "/labels");
        const found = (again.labels || []).find((l) => l.name === name);
        if (found) { out[name] = found.id; continue; }
      }
      throw err;
    }
  }
  return out;
}

/** Every AIS/Client/... label id in the mailbox. Used to take the old client
 * label off a thread when it is re-linked to a different client. */
export async function clientLabelIds(token) {
  const list = await gmailFetch(token, "/labels");
  return (list.labels || [])
    .filter((l) => typeof l.name === "string" && l.name.startsWith("AIS/Client/"))
    .map((l) => l.id);
}

/* ------------------------------------------------------------------ */
/* Building the message                                                */
/* ------------------------------------------------------------------ */

/** Header-injection guard: a newline in a header is how a Bcc gets smuggled in. */
export function sanitizeHeader(v) {
  return String(v || "").replace(/[\r\n]+/g, " ").trim();
}

/** "Dana W. <dana@x.com>" -> "dana@x.com" */
export function stripDisplayName(v) {
  const m = String(v || "").match(/<([^<>]+)>/);
  return (m ? m[1] : String(v || "")).trim();
}

const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** Takes a string or an array, returns clean addresses or an error.
 * Each address is validated on its own, so a comma-joined blob can never slip
 * through as one "valid" recipient and quietly fan the email out. */
export function parseRecipients(input, { max = 20, allowEmpty = false } = {}) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/[,;]+/);
  const list = raw.map((v) => sanitizeHeader(v)).filter(Boolean).map(stripDisplayName);
  if (!list.length) return allowEmpty ? { list: [] } : { error: "No recipient." };
  if (list.length > max) return { error: `Too many recipients (max ${max}).` };
  const bad = list.filter((a) => !ADDRESS_RE.test(a));
  if (bad.length) return { error: `Not a valid email address: ${bad[0]}` };
  return { list: [...new Set(list.map((a) => a.toLowerCase()))] };
}

/** RFC-2047 encode a header value that may contain non-ASCII (names, subjects). */
function encodeHeaderText(v) {
  const s = sanitizeHeader(v);
  if (!s || /^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** The raw base64url MIME message Gmail wants, for both sends and drafts.
 * sentBy is stamped into a custom header so a reply from a SHARED mailbox can
 * still be traced to the person who actually wrote it. */
export function buildRaw({ from, fromName, to, cc, subject, text, inReplyTo, references, sentBy }) {
  const headers = [
    `From: ${fromName ? `${encodeHeaderText(fromName)} <${from}>` : from}`,
    `To: ${to.join(", ")}`,
  ];
  if (cc?.length) headers.push(`Cc: ${cc.join(", ")}`);
  headers.push(
    `Subject: ${encodeHeaderText(subject) || "(no subject)"}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64"
  );
  if (inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeader(inReplyTo)}`);
  if (references || inReplyTo) headers.push(`References: ${sanitizeHeader(references) || sanitizeHeader(inReplyTo)}`);
  if (sentBy) headers.push(`X-AIS-Sent-By: ${sanitizeHeader(sentBy)}`);
  // Base64 body: a plain 8-bit body with a long non-ASCII line can be mangled
  // in transit, and base64 sidesteps the whole question.
  const body = Buffer.from(String(text || ""), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

/** One place that decides "is the last message theirs or ours" — used for both
 * the status auto-flip and the direction shown on a row. */
export function directionOf(fromHeader, mailbox) {
  const addr = stripDisplayName(fromHeader).toLowerCase();
  return addr && addr === String(mailbox || "").toLowerCase() ? "out" : "in";
}
