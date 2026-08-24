/* POST /api/connector — everything you can do with a connected client account
 * once the sign-in exists.
 *
 * Auth: owner/admin. Body: { action, ... }
 *
 *   action: "properties"  { connectionId }
 *       What can this sign-in actually see? Returns the sites, properties or
 *       locations to choose from. Nothing is saved.
 *
 *   action: "choose"      { connectionId, property, propertyLabel }
 *       Point this connection at ONE of them. A connection reads one property,
 *       because a report about "the site" has to say which site.
 *
 *   action: "sync"        { connectionId, range }
 *       Read that window's numbers and SAVE them as a snapshot. The snapshot
 *       is what a report quotes — never a live call — so the same report
 *       always shows the same numbers.
 *
 *   action: "syncClient"  { clientId, range }
 *       The same, for every connection on one client that is ready.
 *
 *   action: "disconnect"  { connectionId }
 *       Throw the stored sign-in away. The row and every past snapshot stay:
 *       old reports were written from those numbers and must stay checkable.
 *
 * THE TOKEN NEVER LEAVES THIS FILE. It is unscrambled in memory, used, and
 * dropped. Nothing in any response contains it.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { decryptSecret, isVaultConfigured } from "../lib/vault-crypto.js";
import { tokenFor, listProperties, fetchWindow } from "../lib/connector-fetch.js";
/* The team's own day. A read at 8pm in Chicago is still Aug 24 to everybody
 * here; UTC calls it Aug 25. Getting that wrong put tomorrow's date on
 * tonight's numbers AND let the same window be saved twice in one evening,
 * because the database's "one read per day" rule was counting UTC days. */
import { teamDate } from "../lib/brain-context.js";
import {
  windowFor, rangeById, canSync, connectionNeedsReconnect, normalizeProperty,
  prettyProperty, PROVIDER_LABELS, isGoogleProvider,
} from "../lib/connectors.js";

/* How many connections one press of "Refresh everything" will read. Named,
 * and reported when it bites — a cap that silently drops the last three
 * accounts turns an incomplete refresh into an invisible one. */
const SYNC_FANOUT_CAP = 8;

async function loadConnection(admin, id) {
  const { data, error } = await admin
    .from("admin_client_connections")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "That connection is not there any more. Refresh the page." };
  return { row: data };
}

/** Unscramble the stored sign-in and turn it into a one-hour access token. */
async function accessTokenFor(admin, row) {
  /* Read from admin_connection_secrets, which only the service role can
   * touch. It is a separate table rather than a column on the card for a
   * reason worth remembering: taking a permission away from one COLUMN does
   * not work once the table has been granted, so a column here would have
   * been readable by every signed-in browser. */
  const { data: secret, error } = await admin
    .from("admin_connection_secrets")
    .select("refresh_token_enc")
    .eq("connection_id", row.id)
    .maybeSingle();
  if (error) throw Object.assign(new Error(`Could not read the stored sign-in: ${error.message}`), { statusCode: 500 });
  if (!secret?.refresh_token_enc) {
    throw Object.assign(new Error("Nobody has signed in to this account here yet."), { statusCode: 400 });
  }
  const opened = decryptSecret(secret.refresh_token_enc, row.id);
  if (!opened.ok) throw Object.assign(new Error(opened.why), { statusCode: 400 });
  return tokenFor(opened.payload?.refresh_token);
}

/** Write the failure onto the row so the card can say what went wrong,
 * instead of the person having to press again to find out. */
async function markError(admin, id, message, status = "error") {
  await admin.from("admin_client_connections")
    .update({ status, last_error: String(message || "").slice(0, 400) })
    .eq("id", id);
}

/* ------------------------------------------------------------------ */
/* One connection, one window                                          */
/* ------------------------------------------------------------------ */

async function syncOne(admin, row, rangeId, userId, nowMs) {
  const label = `${PROVIDER_LABELS[row.provider] || row.provider}${row.property ? ` (${prettyProperty(row.provider, row.property)})` : ""}`;

  if (!canSync(row)) {
    const why = row.active === false
      ? "This connection is switched off."
      : row.auth_kind !== "google"
        ? "This one is typed in by hand — there is nothing to read."
        : !row.property
          ? "No property has been chosen yet, so there is nothing to read."
          : "This connection needs signing in again.";
    return { ok: false, connectionId: row.id, label, error: why };
  }
  if (connectionNeedsReconnect(row.provider, row.scope)) {
    await markError(admin, row.id, "The sign-in no longer covers what we need to read. Press Connect again.", "needs_reconnect");
    return { ok: false, connectionId: row.id, label, error: "The sign-in no longer covers what we need. Press Connect again." };
  }

  const win = windowFor(row.provider, rangeId, nowMs);

  let token;
  try {
    token = await accessTokenFor(admin, row);
  } catch (err) {
    const status = err.statusCode === 401 ? "needs_reconnect" : "error";
    await markError(admin, row.id, err.message, status);
    return { ok: false, connectionId: row.id, label, error: err.message };
  }

  let result;
  try {
    result = await fetchWindow({ provider: row.provider, token, property: row.property, start: win.start, end: win.end });
  } catch (err) {
    await markError(admin, row.id, err.message);
    return { ok: false, connectionId: row.id, label, error: err.message };
  }

  const takenAt = new Date(nowMs).toISOString();
  /* The DAY this was read, in the team's own time zone. Not UTC: an 8pm
   * Chicago refresh is still today to everybody who works here. */
  const takenOn = teamDate(nowMs);
  const { data: snap, error: snapErr } = await admin
    .from("admin_connection_snapshots")
    .upsert({
      connection_id: row.id,
      client_id: row.client_id,
      provider: row.provider,
      property: row.property || "",
      period_start: win.start,
      period_end: win.end,
      taken_at: takenAt,
      taken_on: takenOn,
      taken_by: userId,
      source: "api",
      metrics: result.metrics,
      detail: { ...result.detail, ...(result.warnings?.length ? { warnings: result.warnings } : {}) },
    }, {
      /* Matches the unique index in migration 0013: a second read of the same
       * window on the same day replaces the first rather than piling up.
       * A read on another day is a new row — history is never overwritten. */
      onConflict: "client_id,provider,property,period_start,period_end,taken_on",
      ignoreDuplicates: false,
    })
    .select("*")
    .maybeSingle();

  if (snapErr) {
    /* The numbers were read but not saved. Say exactly that: "refreshed" over
     * a snapshot that does not exist is the worst possible answer, because
     * the next report would quote yesterday's numbers as today's. */
    await markError(admin, row.id, `Read the numbers but could not save them: ${snapErr.message}`);
    return { ok: false, connectionId: row.id, label, error: `Read the numbers, but saving them failed: ${snapErr.message}` };
  }

  await admin.from("admin_client_connections").update({
    status: "connected",
    last_synced_at: takenAt,
    last_error: result.warnings?.length ? result.warnings.join(" ") : null,
  }).eq("id", row.id);

  return {
    ok: true, connectionId: row.id, label,
    window: win, snapshot: snap, warnings: result.warnings || [],
  };
}

/* ------------------------------------------------------------------ */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const body = await readJson(req);
  const action = String(body?.action || "").trim();
  const admin = getAdminSupabase();
  const nowMs = Date.now();

  if (!isVaultConfigured() && action !== "disconnect") {
    return res.status(503).json({
      configured: false,
      error: "VAULT_KEY isn't set on the server, so no stored sign-in can be unscrambled. Set it in Vercel and redeploy.",
    });
  }

  /* ---- what can this sign-in see? --------------------------------- */
  if (action === "properties") {
    const { row, error } = await loadConnection(admin, String(body?.connectionId || ""));
    if (error) return res.status(404).json({ error });
    if (!isGoogleProvider(row.provider)) {
      return res.status(400).json({ error: "This one is typed in by hand — there is nothing to look up." });
    }
    let token;
    try { token = await accessTokenFor(admin, row); }
    catch (err) {
      await markError(admin, row.id, err.message, err.statusCode === 401 ? "needs_reconnect" : "error");
      return res.status(400).json({ error: err.message });
    }
    try {
      const found = await listProperties(row.provider, token);
      return res.status(200).json({
        ok: true, provider: row.provider,
        properties: found.properties,
        /* true means the list was CUT. The picker says so rather than letting
         * a shortened list read as everything the account can see. */
        more: Boolean(found.more),
      });
    } catch (err) {
      await markError(admin, row.id, err.message);
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
  }

  /* ---- point it at one property ----------------------------------- */
  if (action === "choose") {
    const { row, error } = await loadConnection(admin, String(body?.connectionId || ""));
    if (error) return res.status(404).json({ error });
    const property = normalizeProperty(row.provider, body?.property);
    if (!property) return res.status(400).json({ error: "Pick which one this connection should read." });

    /* Already pointed somewhere else for this client? Then this press would
     * break the unique index. Say so in words instead of showing a database
     * error about a constraint nobody has heard of. */
    const { data: clash } = await admin
      .from("admin_client_connections")
      .select("id, label")
      .eq("client_id", row.client_id)
      .eq("provider", row.provider)
      .eq("property", property)
      .neq("id", row.id)
      .maybeSingle();
    if (clash) {
      return res.status(409).json({
        error: `This client already has a ${PROVIDER_LABELS[row.provider]} connection reading that one ("${clash.label}"). Pick a different property, or remove the other card first.`,
      });
    }

    const label = String(body?.propertyLabel || "").trim() || prettyProperty(row.provider, property);
    const { error: upErr } = await admin.from("admin_client_connections").update({
      property,
      property_label: label,
      label: `${PROVIDER_LABELS[row.provider]} — ${label}`,
      last_error: null,
      /* A card that already holds a sign-in stays connected; one that does
       * not keeps whatever it was. `status` is the signal now — the token
       * itself is in another table this query never touches. */
      status: row.auth_kind === "google" && row.status === "connected" ? "connected" : row.status,
    }).eq("id", row.id);
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json({ ok: true });
  }

  /* ---- read the numbers ------------------------------------------- */
  if (action === "sync") {
    const { row, error } = await loadConnection(admin, String(body?.connectionId || ""));
    if (error) return res.status(404).json({ error });
    const rangeId = rangeById(String(body?.range || "28d")).id;
    const result = await syncOne(admin, row, rangeId, member.user.id, nowMs);
    return res.status(result.ok ? 200 : 400).json(result);
  }

  if (action === "syncClient") {
    const clientId = String(body?.clientId || "").trim();
    if (!clientId) return res.status(400).json({ error: "Missing clientId." });
    const rangeId = rangeById(String(body?.range || "28d")).id;

    const { data: rows, error: listErr } = await admin
      .from("admin_client_connections")
      .select("*")
      .eq("client_id", clientId)
      .eq("active", true)
      .order("sort", { ascending: true })
      .order("created_at", { ascending: true });
    if (listErr) return res.status(500).json({ error: listErr.message });

    const ready = (rows || []).filter(canSync);
    const attempted = ready.slice(0, SYNC_FANOUT_CAP);
    const results = [];
    /* One at a time, on purpose. Three Google APIs hit at once from one
     * function is how a rate limit turns two good reads into three bad ones. */
    for (const row of attempted) {
      results.push(await syncOne(admin, row, rangeId, member.user.id, nowMs));
    }

    const skipped = (rows || []).length - ready.length;
    const overCap = ready.length - attempted.length;
    return res.status(200).json({
      ok: true,
      results,
      readCount: results.filter((r) => r.ok).length,
      failedCount: results.filter((r) => !r.ok).length,
      skipped,
      /* Never silent. A cap that quietly drops connections turns a partial
       * refresh into one that reads as complete. */
      overCap,
      overCapNote: overCap > 0
        ? `${overCap} more ready connections were not read this time — a single press reads at most ${SYNC_FANOUT_CAP}. Press again.`
        : null,
    });
  }

  /* ---- throw the sign-in away ------------------------------------- */
  if (action === "disconnect") {
    const { row, error } = await loadConnection(admin, String(body?.connectionId || ""));
    if (error) return res.status(404).json({ error });
    /* The stored sign-in is DELETED, not blanked. A row that still exists
     * holding an empty token is a row somebody has to think about later. */
    const { error: secretErr } = await admin
      .from("admin_connection_secrets").delete().eq("connection_id", row.id);
    if (secretErr) return res.status(500).json({ error: `Could not remove the stored sign-in: ${secretErr.message}` });

    const { error: upErr } = await admin.from("admin_client_connections").update({
      scope: null,
      auth_kind: "manual",
      status: "manual",
      last_error: null,
      connected_at: null,
    }).eq("id", row.id);
    if (upErr) return res.status(500).json({ error: upErr.message });
    /* The snapshots stay. Reports written from them have to stay checkable —
     * deleting the measurements would make every past report unprovable. */
    return res.status(200).json({ ok: true, snapshotsKept: true });
  }

  return res.status(400).json({ error: `Unknown action "${action}".` });
}
