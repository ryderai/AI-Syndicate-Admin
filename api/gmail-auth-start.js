/* GET /api/gmail-auth-start — begin connecting a Gmail account.
 * Auth: any active member. Same state-row flow as the platform's GSC connect. */

import { randomBytes } from "node:crypto";
import { requireMember, getAdminSupabase } from "../lib/supabase-server.js";
import { buildAuthorizeUrl, hasGoogleClientCredentials } from "../lib/google-oauth.js";

function callbackUrlFromRequest(req) {
  if (process.env.GMAIL_REDIRECT_URI) return process.env.GMAIL_REDIRECT_URI;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/api/gmail-callback`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  if (!hasGoogleClientCredentials()) {
    return res.status(503).json({
      configured: false,
      error: "Gmail isn't configured yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET — SETUP.md § Gmail walks through it click by click.",
    });
  }
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const state = randomBytes(24).toString("hex");
  const admin = getAdminSupabase();
  const { error } = await admin
    .from("admin_oauth_states")
    .insert({ state, user_id: member.user.id, purpose: "gmail" });
  if (error) return res.status(500).json({ error: `Could not persist OAuth state: ${error.message}` });

  const redirectUri = callbackUrlFromRequest(req);
  // Bind the flow to THIS browser too: the callback checks this cookie
  // against the state param, so a consent link forwarded to someone else
  // can't attach their mailbox to the initiator's account.
  res.setHeader("Set-Cookie",
    `ais_gmail_oauth=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/gmail-callback; Max-Age=600`);
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json({ authUrl: buildAuthorizeUrl({ redirectUri, state }), redirectUri });
}
