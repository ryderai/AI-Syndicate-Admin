/* GET /api/connect-callback — where Google sends the person back after they
 * approve a client connection. Verifies, stores the sign-in scrambled, then
 * bounces to that client's page.
 *
 * THE ORDER MATTERS AND IS DELIBERATE:
 *   1. Check the browser cookie against the state. Same browser, or stop.
 *   2. Read the state row for WHICH CLIENT and WHICH SERVICE. Never the URL.
 *   3. Swap the code for a refresh token.
 *   4. Make (or find) the connection row FIRST, so the token can be tied to
 *      that row's id — the scrambling mixes the id in, so a blob copied onto
 *      another row in the SQL editor fails loudly instead of quietly opening
 *      the wrong client's account.
 *   5. Scramble, save, and only then say connected.
 *
 * A failure at any step lands back on the client page with a plain reason in
 * the address, never a blank screen.
 */

import { getAdminSupabase, isServerConfigured } from "../lib/supabase-server.js";
import { exchangeCodeForTokens, hasGoogleClientCredentials, emailFromIdToken } from "../lib/google-oauth.js";
import { encryptSecret, isVaultConfigured } from "../lib/vault-crypto.js";
import { PROVIDER_LABELS, isGoogleProvider } from "../lib/connectors.js";
import { originFromRequest, secureFlag } from "../lib/req-origin.js";

function callbackUrlFromRequest(req) {
  if (process.env.CONNECT_REDIRECT_URI) return process.env.CONNECT_REDIRECT_URI;
  const { proto, host } = originFromRequest(req);
  return `${proto}://${host}/api/connect-callback`;
}

function backTo(req, params) {
  const { proto, host } = originFromRequest(req);
  const qs = new URLSearchParams(params).toString();
  // Straight onto the Clients page, with the client already open.
  return `${proto}://${host}/#/dashboard/clients${qs ? `?${qs}` : ""}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed.");
  }

  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const code = one(req.query?.code);
  const state = one(req.query?.state);
  const googleError = one(req.query?.error);

  // Cleared no matter how this ends — a one-time cookie that survives its one
  // use is not one-time.
  res.setHeader("Set-Cookie", `ais_connect_oauth=; HttpOnly;${secureFlag(req)} SameSite=Lax; Path=/api/connect-callback; Max-Age=0`);

  /* A one-time state row is deleted on EVERY way out, not only the ones that
   * got far enough to have loaded it. An abandoned or refused sign-in used to
   * leave its row behind for ever, and nothing sweeps that table. */
  const dropState = async () => {
    if (!state || !isServerConfigured()) return;
    try { await getAdminSupabase().from("admin_oauth_states").delete().eq("state", state); }
    catch { /* the redirect matters more than the tidy-up */ }
  };

  if (googleError) { await dropState(); return res.redirect(302, backTo(req, { connect: "error", reason: googleError })); }
  if (!code || !state) return res.redirect(302, backTo(req, { connect: "error", reason: "missing_params" }));
  if (!hasGoogleClientCredentials() || !isServerConfigured()) {
    return res.redirect(302, backTo(req, { connect: "error", reason: "server_not_configured" }));
  }
  if (!isVaultConfigured()) {
    return res.redirect(302, backTo(req, { connect: "error", reason: "no_vault_key" }));
  }

  const cookies = String(req.headers.cookie || "");
  const cookieState = /(?:^|;\s*)ais_connect_oauth=([^;]+)/.exec(cookies)?.[1];
  if (!cookieState || cookieState !== state) {
    await dropState();
    return res.redirect(302, backTo(req, { connect: "error", reason: "browser_mismatch" }));
  }

  const admin = getAdminSupabase();

  const { data: stateRow, error: selErr } = await admin
    .from("admin_oauth_states")
    .select("user_id, purpose, payload, created_at")
    .eq("state", state)
    .maybeSingle();
  if (selErr || !stateRow) return res.redirect(302, backTo(req, { connect: "error", reason: "invalid_state" }));

  const done = async () => { await admin.from("admin_oauth_states").delete().eq("state", state); };

  if (!String(stateRow.purpose || "").startsWith("connect:")) {
    await done();
    return res.redirect(302, backTo(req, { connect: "error", reason: "wrong_purpose" }));
  }
  if (Date.now() - new Date(stateRow.created_at).getTime() > 10 * 60 * 1000) {
    await done();
    return res.redirect(302, backTo(req, { connect: "error", reason: "state_expired" }));
  }

  const clientId = stateRow.payload?.clientId;
  const provider = stateRow.payload?.provider;
  const connectionId = stateRow.payload?.connectionId || null;
  if (!clientId || !isGoogleProvider(provider)) {
    await done();
    return res.redirect(302, backTo(req, { connect: "error", reason: "state_incomplete" }));
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({ code, redirectUri: callbackUrlFromRequest(req) });
  } catch (err) {
    await done();
    return res.redirect(302, backTo(req, {
      id: clientId, connect: "error",
      reason: String(err?.message || "exchange_failed").slice(0, 140),
    }));
  }

  const accountEmail = emailFromIdToken(tokens.idToken) || null;

  /* THE ROW THIS SIGN-IN BELONGS TO, in order of preference:
   *
   *   1. the card the person actually pressed the button on. "Connect again"
   *      on a card whose sign-in expired MUST land back on that card — the
   *      first version could only match a card with no property chosen, and a
   *      card that has ever been used always has one, so every repair attempt
   *      made a second empty card and left the broken one broken. Worse, the
   *      new card could never be pointed at the same property either: that is
   *      the one thing the "already reading that one" check refuses.
   *   2. a card for this provider that nobody has chosen a property on yet.
   *   3. a brand new one.
   *
   * The id in (1) came out of the state row in the database, not the address
   * bar, and connect-start checked it belongs to this client before writing
   * it there.
   */
  let row = null;
  if (connectionId) {
    const { data: named } = await admin
      .from("admin_client_connections")
      .select("id, property, label")
      .eq("id", connectionId)
      .eq("client_id", clientId)
      .eq("provider", provider)
      .maybeSingle();
    row = named || null;
  }
  if (!row) {
    const { data: existing } = await admin
      .from("admin_client_connections")
      .select("id, property, label")
      .eq("client_id", clientId)
      .eq("provider", provider)
      .is("property", null)
      .maybeSingle();
    row = existing || null;
  }
  if (!row) {
    const { data: made, error: insErr } = await admin
      .from("admin_client_connections")
      .insert({
        client_id: clientId,
        provider,
        auth_kind: "google",
        label: PROVIDER_LABELS[provider] || provider,
        account_email: accountEmail,
        /* NOT "connected" yet. The sign-in is not stored until the update
         * below succeeds, and a green CONNECTED badge over a card with no
         * sign-in behind it is a lie that only shows up on the next refresh.
         * If anything after this point fails, the card correctly reads as
         * one nobody has signed in to. */
        status: "manual",
        connected_by: stateRow.user_id,
        added_by: stateRow.user_id,
      })
      .select("id")
      .maybeSingle();
    if (insErr || !made) {
      await done();
      return res.redirect(302, backTo(req, { id: clientId, connect: "error", reason: "could_not_save" }));
    }
    row = made;
  }

  const sealed = encryptSecret({ refresh_token: tokens.refreshToken }, row.id);
  if (!sealed.ok) {
    await done();
    return res.redirect(302, backTo(req, { id: clientId, connect: "error", reason: String(sealed.why).slice(0, 140) }));
  }

  /* The sign-in goes into its OWN table, which no signed-in browser has any
   * permission on at all (migration 0013). It is written FIRST: only once it
   * is safely stored does the card say connected. */
  const { error: secretErr } = await admin
    .from("admin_connection_secrets")
    .upsert({
      connection_id: row.id,
      refresh_token_enc: sealed.blob,
      updated_at: new Date().toISOString(),
      updated_by: stateRow.user_id,
    }, { onConflict: "connection_id" });
  if (secretErr) {
    await done();
    return res.redirect(302, backTo(req, { id: clientId, connect: "error", reason: "could_not_store" }));
  }

  const { error: upErr } = await admin
    .from("admin_client_connections")
    .update({
      auth_kind: "google",
      account_email: accountEmail,
      scope: tokens.scope || null,
      status: "connected",
      last_error: null,
      connected_at: new Date().toISOString(),
      connected_by: stateRow.user_id,
    })
    .eq("id", row.id);

  await done();

  if (upErr) return res.redirect(302, backTo(req, { id: clientId, connect: "error", reason: "could_not_store" }));

  return res.redirect(302, backTo(req, {
    id: clientId, connect: "ok", provider, conn: row.id,
    ...(accountEmail ? { account: accountEmail } : {}),
  }));
}
