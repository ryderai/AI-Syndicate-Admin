/* POST /api/connect-start — begin connecting ONE client account.
 *
 * Auth: owner/admin. Body: { clientId, provider }
 *
 * Same shape as /api/gmail-auth-start, with two differences that matter:
 *
 *   1. The permissions asked for depend on the provider (Search Console,
 *      Business Profile or Analytics), and come from lib/connectors.js so the
 *      picker, the request and the tests all read one list.
 *
 *   2. WHICH CLIENT this is for is remembered in the database, not in the
 *      address bar. If it rode in the URL, anybody could change one character
 *      on the way back and attach a client's Google account to a different
 *      client's record — quietly, and for ever.
 */

import { randomBytes } from "node:crypto";
import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { buildAuthorizeUrl, hasGoogleClientCredentials } from "../lib/google-oauth.js";
import { isVaultConfigured } from "../lib/vault-crypto.js";
import { isGoogleProvider, scopesFor, PROVIDER_LABELS } from "../lib/connectors.js";

function callbackUrlFromRequest(req) {
  if (process.env.CONNECT_REDIRECT_URI) return process.env.CONNECT_REDIRECT_URI;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/api/connect-callback`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const body = await readJson(req);
  const clientId = String(body?.clientId || "").trim();
  const provider = String(body?.provider || "").trim();
  /* WHICH CARD is being reconnected, when the person pressed "Connect again"
   * on one that already exists. Without it the callback could only ever look
   * for a card with no property chosen — and a card that has been USED always
   * has one — so every reconnect made a SECOND, empty card and left the
   * broken one broken for ever. Caught by a reviewer the same day. */
  const connectionId = String(body?.connectionId || "").trim() || null;

  if (!clientId) return res.status(400).json({ error: "Missing clientId." });
  if (!isGoogleProvider(provider)) {
    return res.status(400).json({
      error: `${PROVIDER_LABELS[provider] || provider} cannot be connected with a Google sign-in. Add it as a typed-in account instead.`,
    });
  }
  /* The card has to belong to THIS client. Taking the id from the browser and
   * trusting it would let a mistyped or tampered request attach one client's
   * Google account to another client's record — the exact thing the payload
   * below exists to prevent. */
  if (connectionId) {
    const { data: card } = await getAdminSupabase()
      .from("admin_client_connections")
      .select("id, client_id, provider")
      .eq("id", connectionId)
      .maybeSingle();
    if (!card || card.client_id !== clientId || card.provider !== provider) {
      return res.status(400).json({ error: "That connection does not belong to this client. Refresh the page and try again." });
    }
  }

  if (!hasGoogleClientCredentials()) {
    return res.status(503).json({
      configured: false,
      error: "Google sign-in isn't set up yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Vercel — SETUP.md § Migration 0013 walks through it click by click.",
    });
  }
  /* Refused BEFORE the person signs in, not after. Without VAULT_KEY the
   * refresh token cannot be scrambled, and the only choices at the far end
   * would be to store it in plain text or to throw away a sign-in the person
   * has already granted. Both are worse than a clear no now. */
  if (!isVaultConfigured()) {
    return res.status(503).json({
      configured: false,
      error: "VAULT_KEY isn't set, so a client's sign-in could not be stored safely. Set it in Vercel and redeploy before connecting anything.",
    });
  }

  const admin = getAdminSupabase();

  // The client has to exist, and the name is what the far end shows.
  const { data: client, error: clientErr } = await admin
    .from("admin_clients").select("id, name").eq("id", clientId).maybeSingle();
  if (clientErr) return res.status(500).json({ error: clientErr.message });
  if (!client) return res.status(404).json({ error: "That client does not exist." });

  const state = randomBytes(24).toString("hex");
  const { error } = await admin.from("admin_oauth_states").insert({
    state,
    user_id: member.user.id,
    purpose: `connect:${provider}`,
    payload: { clientId, provider, connectionId },
  });
  if (error) return res.status(500).json({ error: `Could not start the sign-in: ${error.message}` });

  const redirectUri = callbackUrlFromRequest(req);
  // Bind the flow to THIS browser: the callback checks this cookie against
  // the state, so a consent link forwarded to someone else cannot attach
  // their account to our client's record.
  res.setHeader("Set-Cookie",
    `ais_connect_oauth=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/connect-callback; Max-Age=600`);
  res.setHeader("Cache-Control", "private, no-store");

  return res.status(200).json({
    authUrl: buildAuthorizeUrl({ redirectUri, state, scopes: scopesFor(provider) }),
    redirectUri,
    clientName: client.name,
    provider,
  });
}
