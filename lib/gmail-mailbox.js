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
 * The browser cannot select either token column at all (the column grants in
 * 0001, 0003 and 0021 all leave them out). Since Aug 27 2026 it is stored
 * scrambled — see the long note above refreshTokenFor() for how the move from
 * the plaintext column happens and why it happens on read.
 */

import { getAdminSupabase } from "./supabase-server.js";
import { gmailFetch, accountNeedsReconnect } from "./google-oauth.js";
import { encryptSecret, decryptSecret } from "./vault-crypto.js";

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

/* ------------------------------------------------------------------ */
/* The refresh token                                                   */
/* ------------------------------------------------------------------ */

/* WHY THE TOKEN IS SCRAMBLED, AND WHY THE MOVE HAPPENS HERE.
 *
 * `admin_gmail_accounts.refresh_token` held, in clear, the one string that grants
 * read-and-send access to a person's mailbox. No browser could ever read it —
 * migrations 0001 and 0003 grant select on a column list that leaves it out —
 * so this was never urgent. What changed on Aug 27 2026 is the row count: it
 * goes from one shared inbox to one per sales rep, and lib/vault-crypto.js
 * already does AES-256-GCM for the client connections.
 *
 * SQL cannot do the encrypting, because the key lives in VAULT_KEY on the
 * server. So migration 0021 § 1 made room (added `refresh_token_enc`, dropped
 * the `not null` off the plaintext column) and the actual move happens HERE, on
 * the first server-side read of each row: encrypt, write the blob, null the
 * plaintext. One row, once, and then never again.
 *
 * WITH NO VAULT_KEY THE PLAINTEXT KEEPS BEING USED, and that is the deliberate
 * choice. Refusing to open a mailbox because a key is missing would take
 * everybody's email away over a setting nobody had noticed; leaving a token in
 * clear for another week is a far smaller harm. It says so in the log every
 * time, which is how somebody finds out.
 *
 * THE `itemId` IS THE EMAIL ADDRESS, matching how admin_connection_secrets ties
 * a blob to its connection id in migration 0013. A blob copied by hand onto a
 * different mailbox's row fails to unscramble rather than quietly opening
 * somebody else's mail. One limitation, written down rather than hidden: this
 * table's primary key is (user_id, email_address), so two people who both
 * connected the SAME address get blobs that would interchange. They are tokens
 * for the same mailbox either way, so nothing is opened that was not already
 * open — but if that ever stops being true, the itemId is the thing to widen.
 */
async function refreshTokenFor(row, { encColumnMissing = false } = {}) {
  const address = row.email_address;

  /* THE COLUMN IS NOT THERE, SO THERE IS NOTHING TO MOVE THE TOKEN INTO.
   *
   * resolveMailbox learns this from its own failed select and passes it down.
   * Without it this function walked straight into the encrypt-and-store branch on
   * EVERY request — one wasted round-trip per send, per draft list, per thread
   * list — and logged "could not save the scrambled token … it stays in plain
   * text for now", which blames the vault key for a missing migration. Third
   * review, Aug 27 2026. */
  if (encColumnMissing) {
    if (row.refresh_token) return { token: row.refresh_token };
    return {
      status: 409,
      error: `${address} has no saved Google sign-in any more. Disconnect it on the Comms page and connect it again.`,
    };
  }

  if (row.refresh_token_enc) {
    const out = decryptSecret(row.refresh_token_enc, address);
    if (out.ok && out.payload?.refresh_token) return { token: out.payload.refresh_token };
    /* A blob that will not unscramble with a plaintext still sitting beside it
     * means the encrypting write half-happened. Use the plaintext — the mailbox
     * keeps working — and say so loudly. */
    if (row.refresh_token) {
      console.warn(`[gmail] ${address}: the scrambled token would not open (${out.why}) — using the plain one that is still on the row.`);
      return { token: row.refresh_token };
    }
    return { status: 500, error: `The saved sign-in for ${address} could not be read. ${out.why}` };
  }

  if (!row.refresh_token) {
    return {
      status: 409,
      error: `${address} has no saved Google sign-in any more. Disconnect it on the Comms page and connect it again.`,
    };
  }

  const sealed = encryptSecret({ refresh_token: row.refresh_token }, address);
  if (!sealed.ok) {
    console.warn(`[gmail] ${address}: leaving the refresh token in plain text — ${sealed.why}`);
    return { token: row.refresh_token };
  }

  /* THE PLAINTEXT IS ONLY CLEARED IN THE SAME STATEMENT THAT SAVES THE BLOB.
   * Two statements would leave a window where a crash in between loses the token
   * altogether and the mailbox has to be reconnected. Filtered on BOTH halves of
   * the primary key: this table can hold several rows for one address, and
   * filtering on the address alone would wipe a teammate's separate connection.
   *
   * If the write fails, the token this call returns is still good — the row is
   * simply left as it was and the next read tries again. */
  const { error } = await getAdminSupabase()
    .from("admin_gmail_accounts")
    .update({ refresh_token_enc: sealed.blob, refresh_token: null })
    .eq("user_id", row.user_id)
    .eq("email_address", address);
  if (error) console.warn(`[gmail] ${address}: could not save the scrambled token (${error.message}) — it stays in plain text for now.`);

  return { token: row.refresh_token };
}

/** May this member use this mailbox? Returns the refresh token if so. */
export async function resolveMailbox(member, address) {
  if (!address) return { status: 400, error: "Missing account." };
  const admin = getAdminSupabase();
  /* ---- IT ASKS FOR THE ENCRYPTED COLUMN, AND SURVIVES A DATABASE THAT HAS NOT
   * ---- HEARD OF IT YET.
   *
   * `refresh_token_enc` arrives with migration 0021, and the stated state of this
   * project is that 0007 to 0023 have never been run. Naming a column that does
   * not exist makes PostgREST answer 42703, which this function turned into a 500
   * — so shipping this file before that migration would have killed every send,
   * every draft and every thread list with an error nobody could read, on a
   * feature that works today. 0021's own note says "existing Gmail connections
   * keep working", and that was only true AFTER it had been run.
   *
   * So: ask for it, and if the column is missing, ask again without it and carry
   * on with the plaintext. Losing a mailbox because a migration is late would be
   * far worse than leaving a token in clear for another week — which is the same
   * judgement refreshTokenFor makes about a missing VAULT_KEY. Found by an
   * adversarial review, Aug 27 2026. */
  const WITH_ENC = "user_id, email_address, refresh_token, refresh_token_enc, scope, shared, display_name";
  const WITHOUT_ENC = "user_id, email_address, refresh_token, scope, shared, display_name";
  let { data, error } = await admin
    .from("admin_gmail_accounts").select(WITH_ENC).eq("email_address", address).limit(10);
  /* AND IT REMEMBERS WHAT IT LEARNED. The first version retried and threw the
   * answer away, so refreshTokenFor then tried to WRITE `refresh_token_enc` on
   * every single request against a column it already knew did not exist — a wasted
   * round-trip per send, per draft list, per thread list, and a log line blaming
   * the vault key for something else entirely. Third review, Aug 27 2026. */
  let encColumnMissing = false;
  if (error && /refresh_token_enc/.test(error.message || "")) {
    encColumnMissing = true;
    console.warn("[gmail-mailbox] admin_gmail_accounts has no refresh_token_enc column — migration 0021 has not been run. Using the plaintext token and NOT trying to encrypt it.");
    ({ data, error } = await admin
      .from("admin_gmail_accounts").select(WITHOUT_ENC).eq("email_address", address).limit(10));
  }
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

  /* The permission question is answered FIRST and the token is fetched second.
   * Decrypting — and, on the first read, re-writing — a row somebody is not
   * allowed to use would be work done on their behalf before we had decided they
   * were allowed to be here. */
  const tok = await refreshTokenFor(row, { encColumnMissing });
  if (tok.error) return { status: tok.status, error: tok.error };

  return {
    mailbox: row.email_address,
    displayName: row.display_name || null,
    refreshToken: tok.token,
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
