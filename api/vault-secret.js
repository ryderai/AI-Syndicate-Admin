/* POST /api/vault-secret — the only door between a vault secret and a person.
 *
 * Body: { action, itemId, ... }
 *
 *   { action: "reveal", itemId, fields: ["password"] }
 *       → unscrambles those fields and returns them. Writes a log row.
 *   { action: "copy",   itemId, fields: ["password"] }
 *       → the same work, logged as a copy. "Looked at it" and "put it on the
 *         clipboard" are different events and the log says which.
 *   { action: "save",   itemId, secrets: { password: "..." } }
 *       → scrambles and stores them. Writes a log row. Never returns the value.
 *   { action: "clear",  itemId }
 *       → wipes the scrambled blob, leaves the item. Writes a log row.
 *   { action: "delete", itemId }
 *       → removes the item entirely. Writes the log row FIRST; if the log
 *         cannot be written, nothing is deleted.
 *   { action: "generate", length, symbols, digits }
 *       → a strong password made with real randomness. Touches no item, saves
 *         nothing, logs nothing (there is nothing yet to log).
 *
 * WHY THIS IS THE ONLY DOOR
 * The browser can read admin_vault_items directly through Supabase, because
 * row-level security lets owners and admins read it. What the browser CANNOT do
 * is make sense of secret_cipher — that needs VAULT_KEY, which only the server
 * has — and it cannot write that column either, because a trigger in migration
 * 0008 rejects the write. So every path to a real password goes through here,
 * where the role is checked and the reading is written down.
 *
 * Auth: owner or admin. Sales gets a flat no, on every action, including
 * generate — a page they cannot see has no button they can press.
 *
 * WHAT IS NEVER DONE HERE
 *  · A secret is never logged, never put in an error message, and never sent to
 *    the AI. Grep this file: the only place a plaintext appears in a response
 *    is the reveal action, which is the whole point of it.
 *  · No GET. A GET can be triggered by a link, an image tag, or a prefetch;
 *    reading a password must take a deliberate POST.
 *  · No caching. Cache-Control is private, no-store on every answer.
 */

import { requireMember, getAdminSupabase, isServerConfigured, readJson } from "../lib/supabase-server.js";
import { encryptSecret, decryptSecret, isVaultConfigured, readVaultKey, serverRandomInts } from "../lib/vault-crypto.js";
import {
  SECRET_FIELDS, ALL_SECRET_FIELDS, checkSecret, buildPassword, cardBrand, lastFour,
} from "../lib/vault.js";

/* How many reveals one person may do in an hour. Not a security wall — an
 * owner can legitimately open ten items in a row — but "every secret we hold,
 * one after another, in ninety seconds" is not normal use and should stop and
 * be visible. Counted from the log in the database, not from memory: this runs
 * as separate short-lived functions, so an in-memory counter would reset itself
 * constantly and quietly enforce nothing. */
/* Reveal AND copy count towards it, and reveal-then-copy is the normal
 * two-press flow on one field — so at 120 an owner doing ordinary work hit the
 * wall at about 60 items. Doubled to keep the same real ceiling. */
const REVEALS_PER_HOUR = 240;

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Write the log row. Best effort for reveal? NO — deliberately not.
 * If the log cannot be written, the reveal does not happen. An unlogged read of
 * a password is exactly the thing the log exists to prevent, so a broken log
 * fails the action instead of silently allowing it. */
async function writeLog(admin, { item, member, action, fields }) {
  const { error } = await admin.from("admin_vault_reveals").insert({
    item_id: item?.id || null,
    item_label: item?.label || "(unnamed item)",
    client_id: item?.client_id || null,
    actor: member.user.id,
    actor_email: member.membership.email,
    action,
    fields: fields || [],
  });
  return error ? error.message : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!isServerConfigured()) {
    return res.status(503).json({
      configured: false,
      error: "The Supabase server key is missing, so the vault cannot be opened.",
    });
  }

  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  res.setHeader("Cache-Control", "private, no-store");

  const body = await readJson(req);
  const action = String(body?.action || "").trim();

  /* ---------------------------------------------------------------- */
  /* generate — no item involved                                       */
  /* ---------------------------------------------------------------- */
  if (action === "generate") {
    const password = buildPassword({
      length: Number(body?.length) || 20,
      symbols: body?.symbols !== false,
      digits: body?.digits !== false,
      randomInts: serverRandomInts,
    });
    return res.status(200).json({ password });
  }

  if (!["reveal", "copy", "save", "clear", "delete"].includes(action)) {
    return res.status(400).json({ error: "Unknown action." });
  }

  /* ONLY the actions that scramble or unscramble need the key. Clearing a
   * secret and deleting an item do neither, and gating them behind the key
   * meant that a console with no VAULT_KEY yet — the exact state the Vault page
   * is designed to walk somebody out of — could add items and then never remove
   * them, with an error message about encryption on an operation that does
   * none. Caught by a reviewer, Aug 21 2026. */
  if (["reveal", "copy", "save"].includes(action)) {
    const key = readVaultKey();
    if (!key.ok) {
      return res.status(503).json({ configured: false, error: key.why });
    }
  }

  const itemId = String(body?.itemId || "").trim();
  if (!looksLikeUuid(itemId)) {
    return res.status(404).json({ error: "That item is not in the vault any more. Refresh the page." });
  }

  const admin = getAdminSupabase();
  const { data: item, error: readErr } = await admin
    .from("admin_vault_items")
    .select("id, client_id, kind, label, secret_cipher, secret_fields, card_last4, card_brand")
    .eq("id", itemId)
    .maybeSingle();

  if (readErr) return res.status(500).json({ error: "Could not read that item: " + readErr.message });
  if (!item) return res.status(404).json({ error: "That item is not in the vault any more. Refresh the page." });

  /* ---------------------------------------------------------------- */
  /* reveal, and copy                                                  */
  /* ---------------------------------------------------------------- */
  /* They do the same work and are logged as DIFFERENT things, because they are
   * different things. "Somebody looked at it on screen" and "somebody put it on
   * the clipboard" is exactly the distinction that matters when a password
   * turns up somewhere it should not be. The browser says which one it is
   * doing, and the browser asks again for a copy even when the value is already
   * on screen — one press, one line in the log. */
  if (action === "reveal" || action === "copy") {
    const asked = Array.isArray(body?.fields) ? body.fields.map(String) : [];
    const allowed = SECRET_FIELDS[item.kind] || [];
    const fields = asked.filter((f) => allowed.includes(f) && ALL_SECRET_FIELDS.includes(f));
    if (!fields.length) {
      return res.status(400).json({ error: "Say which part you want to see." });
    }
    if (!item.secret_cipher) {
      return res.status(409).json({ error: "Nothing is saved against this item yet." });
    }

    // The hourly ceiling, counted in the database.
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count, error: countErr } = await admin
      .from("admin_vault_reveals")
      .select("id", { count: "exact", head: true })
      .eq("actor", member.user.id)
      .in("action", ["reveal", "copy"])
      .gte("created_at", since);
    if (countErr) {
      return res.status(500).json({ error: "The reveal log could not be checked, so nothing was opened: " + countErr.message });
    }
    if ((count ?? 0) >= REVEALS_PER_HOUR) {
      return res.status(429).json({
        error: `That is ${count} times a secret has been opened or copied in the last hour, which is more than this console allows. Wait an hour, or ask another owner to look. Every one of those is in the log.`,
      });
    }

    const out = decryptSecret(item.secret_cipher, item.id);
    if (!out.ok) return res.status(500).json({ error: out.why });

    // Log BEFORE handing anything back. A reveal that could not be recorded
    // does not happen.
    const logErr = await writeLog(admin, { item, member, action, fields });
    if (logErr) {
      return res.status(500).json({
        error: "The reveal could not be written to the log, so nothing was opened. Nobody reads a secret off the record. (" + logErr + ")",
      });
    }

    const values = {};
    for (const f of fields) {
      if (out.payload && Object.prototype.hasOwnProperty.call(out.payload, f)) values[f] = out.payload[f];
    }
    const missing = fields.filter((f) => !(f in values));
    return res.status(200).json({ values, missing, at: new Date().toISOString() });
  }

  /* ---------------------------------------------------------------- */
  /* save                                                              */
  /* ---------------------------------------------------------------- */
  if (action === "save") {
    const incoming = body?.secrets && typeof body.secrets === "object" ? body.secrets : null;
    if (!incoming) return res.status(400).json({ error: "There is nothing to save." });

    // Start from whatever is already stored, so saving a new security code does
    // not wipe the card number that was saved last week.
    let existing = {};
    if (item.secret_cipher) {
      const prev = decryptSecret(item.secret_cipher, item.id);
      if (!prev.ok) {
        return res.status(409).json({
          error: "What is already saved against this item cannot be read, so it will not be written over. " + prev.why,
        });
      }
      existing = prev.payload || {};
    }

    const allowed = SECRET_FIELDS[item.kind] || [];
    const next = { ...existing };
    const touched = [];

    for (const [field, value] of Object.entries(incoming)) {
      if (!allowed.includes(field)) {
        return res.status(400).json({ error: `A ${item.kind} has no "${field}" to save.` });
      }
      // An empty value means "take this one out", not "save an empty string".
      if (value === null || String(value).trim() === "") {
        delete next[field];
        touched.push(field);
        continue;
      }
      const verdict = checkSecret(item.kind, field, value);
      if (!verdict.ok) return res.status(400).json({ error: verdict.why });
      next[field] = String(value);
      touched.push(field);
    }

    const fields = Object.keys(next).sort();
    const now = new Date().toISOString();

    // Everything was cleared out one field at a time — treat it as a clear, so
    // the row never carries a blob with an empty object in it.
    if (!fields.length) {
      const { data: wiped, error: wipeErr } = await admin
        .from("admin_vault_items")
        .update({ secret_cipher: null, secret_fields: [], secret_set_at: null, secret_by: null })
        .eq("id", item.id)
        .select("id");
      if (wipeErr) return res.status(500).json({ error: "Could not save that: " + wipeErr.message });
      if (!wiped?.length) return res.status(409).json({ error: "Nothing was saved — that item is gone. Refresh the page." });
      /* Same warning as the other two write paths. This one used to throw the
       * result away, so emptying every box destroyed a secret and printed a
       * plain green "Saved" even when the log line failed — in a feature whose
       * whole point is that destruction is on the record. */
      const wipeLogErr = await writeLog(admin, { item, member, action: "clear", fields: touched });
      return res.status(200).json({
        saved: true, fields: [], at: now,
        logWarning: wipeLogErr ? "The secret was cleared, but the log row was not written: " + wipeLogErr : null,
      });
    }

    const enc = encryptSecret(next, item.id);
    if (!enc.ok) return res.status(500).json({ error: enc.why });

    const patch = {
      secret_cipher: enc.blob,
      secret_fields: fields,
      secret_set_at: now,
      secret_by: member.user.id,
    };

    /* Keep the readable half honest about the secret half. If a card number was
     * just saved, the brand and the last 4 are derived from THAT number here on
     * the server — not from whatever was typed into the two boxes. Otherwise a
     * list could read "Visa ···· 4242" over a Mastercard, which is the kind of
     * quiet wrongness that gets a payment declined at the worst moment. */
    if (item.kind === "card" && next.number) {
      const l4 = lastFour(next.number);
      const brand = cardBrand(next.number);
      if (l4) patch.card_last4 = l4;
      /* Written even when it comes back null. `if (brand)` left the OLD brand
       * standing when the number is a store card nothing recognises — so a card
       * saved after "Visa" had been typed by hand rendered as
       * "•••• •••• •••• 3434 Visa" over a number that is not a Visa. An empty
       * brand says "we do not know", which is true; a wrong brand does not. */
      patch.card_brand = brand;
    }

    const { data: saved, error: saveErr } = await admin
      .from("admin_vault_items")
      .update(patch)
      .eq("id", item.id)
      .select("id, card_last4, card_brand");
    if (saveErr) return res.status(500).json({ error: "Could not save that: " + saveErr.message });
    /* PostgREST answers a write that matched no rows with no error at all. Count
     * the rows that came back before saying it saved — the trap written up in
     * CONTEXT-FOR-AI §17 that made "Removed" appear over a row still on screen. */
    if (!saved?.length) {
      return res.status(409).json({ error: "Nothing was saved — that item is gone. Refresh the page." });
    }

    const logErr = await writeLog(admin, { item, member, action: "save", fields: touched });

    return res.status(200).json({
      saved: true,
      fields,
      at: now,
      card: saved[0]?.card_last4 ? { last4: saved[0].card_last4, brand: saved[0].card_brand } : null,
      // Say it plainly rather than hiding it: the secret IS saved, the record of
      // the save is what failed.
      logWarning: logErr ? "The secret was saved, but the log row was not written: " + logErr : null,
    });
  }

  /* ---------------------------------------------------------------- */
  /* delete the whole item                                             */
  /* ---------------------------------------------------------------- */
  /* Deleting used to go straight from the browser to Supabase, which meant the
   * ciphertext was destroyed with NO line in the log at all. The confirm box
   * said "the record of who opened it stays" — true, and beside the point:
   * there was no record that the item had been deleted. It comes through here
   * now so the deletion is written down first. */
  if (action === "delete") {
    const logErr = await writeLog(admin, {
      item, member, action: "delete", fields: item.secret_fields || [],
    });
    if (logErr) {
      return res.status(500).json({
        error: "The deletion could not be written to the log, so nothing was deleted. Nothing leaves the vault off the record. (" + logErr + ")",
      });
    }
    const { data: gone, error: delErr } = await admin
      .from("admin_vault_items").delete().eq("id", item.id).select("id");

    /* Log-before-delete is the right order — nothing leaves the vault off the
     * record — but it means a delete that then FAILS leaves a line saying it
     * happened, and the log has no update or delete policy for anybody, so that
     * line is permanent. A second line is written saying the delete did not go
     * through, so the record reads true either way. */
    if (delErr || !gone?.length) {
      await writeLog(admin, {
        item, member, action: "delete_failed", fields: item.secret_fields || [],
      });
      if (delErr) return res.status(500).json({ error: "Could not remove it: " + delErr.message });
      return res.status(409).json({ error: "Nothing was removed — that item is already gone. Refresh the page." });
    }
    return res.status(200).json({ deleted: true });
  }

  /* ---------------------------------------------------------------- */
  /* clear                                                             */
  /* ---------------------------------------------------------------- */
  const { data: cleared, error: clearErr } = await admin
    .from("admin_vault_items")
    .update({ secret_cipher: null, secret_fields: [], secret_set_at: null, secret_by: null })
    .eq("id", item.id)
    .select("id");
  if (clearErr) return res.status(500).json({ error: "Could not clear that: " + clearErr.message });
  if (!cleared?.length) return res.status(409).json({ error: "Nothing changed — that item is gone. Refresh the page." });

  const logErr = await writeLog(admin, { item, member, action: "clear", fields: item.secret_fields || [] });
  return res.status(200).json({
    cleared: true,
    logWarning: logErr ? "The secret was cleared, but the log row was not written: " + logErr : null,
  });
}

/* Exported for the tests. isVaultConfigured is re-exported so /api/health and
 * the test file read the same function rather than two copies of the idea. */
export { isVaultConfigured };
