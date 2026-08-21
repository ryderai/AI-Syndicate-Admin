/* GET /api/gmail-callback — OAuth redirect target. Verifies state, exchanges
 * the code, stores the refresh token, bounces back to the Inbox page. */

import { getAdminSupabase, isServerConfigured } from "../lib/supabase-server.js";
import { exchangeCodeForTokens, hasGoogleClientCredentials, emailFromIdToken } from "../lib/google-oauth.js";

function callbackUrlFromRequest(req) {
  if (process.env.GMAIL_REDIRECT_URI) return process.env.GMAIL_REDIRECT_URI;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/api/gmail-callback`;
}

function inboxUrl(req, params) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const qs = new URLSearchParams(params).toString();
  // Land ON the Inbox page. Since Aug 19 2026 the page id is part of the
  // address, and only the Inbox reads ?gmail= — a bare "#/dashboard" now
  // means Overview, where the message would never be shown.
  return `${proto}://${host}/#/dashboard/inbox${qs ? `?${qs}` : ""}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed.");
  }
  const code = Array.isArray(req.query?.code) ? req.query.code[0] : req.query?.code;
  const state = Array.isArray(req.query?.state) ? req.query.state[0] : req.query?.state;
  const googleError = Array.isArray(req.query?.error) ? req.query.error[0] : req.query?.error;

  if (googleError) return res.redirect(302, inboxUrl(req, { gmail: "error", reason: googleError }));
  if (!code || !state) return res.redirect(302, inboxUrl(req, { gmail: "error", reason: "missing_params" }));
  if (!hasGoogleClientCredentials() || !isServerConfigured()) {
    return res.redirect(302, inboxUrl(req, { gmail: "error", reason: "server_not_configured" }));
  }

  // The browser completing the flow must be the browser that started it —
  // the cookie set by gmail-auth-start has to match the state param.
  const cookies = String(req.headers.cookie || "");
  const cookieState = /(?:^|;\s*)ais_gmail_oauth=([^;]+)/.exec(cookies)?.[1];
  res.setHeader("Set-Cookie", "ais_gmail_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/gmail-callback; Max-Age=0");
  if (!cookieState || cookieState !== state) {
    return res.redirect(302, inboxUrl(req, { gmail: "error", reason: "browser_mismatch" }));
  }

  const admin = getAdminSupabase();
  const { data: stateRow, error: selErr } = await admin
    .from("admin_oauth_states")
    .select("user_id, created_at")
    .eq("state", state)
    .eq("purpose", "gmail")
    .maybeSingle();
  if (selErr || !stateRow) return res.redirect(302, inboxUrl(req, { gmail: "error", reason: "invalid_state" }));
  if (Date.now() - new Date(stateRow.created_at).getTime() > 10 * 60 * 1000) {
    await admin.from("admin_oauth_states").delete().eq("state", state);
    return res.redirect(302, inboxUrl(req, { gmail: "error", reason: "state_expired" }));
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({ code, redirectUri: callbackUrlFromRequest(req) });
  } catch (err) {
    await admin.from("admin_oauth_states").delete().eq("state", state);
    return res.redirect(302, inboxUrl(req, {
      gmail: "error",
      reason: encodeURIComponent(err?.message || "exchange_failed").slice(0, 120),
    }));
  }

  const emailAddress = emailFromIdToken(tokens.idToken) || "unknown";
  const { error: upsertErr } = await admin.from("admin_gmail_accounts").upsert({
    user_id: stateRow.user_id,
    email_address: emailAddress,
    refresh_token: tokens.refreshToken,
    scope: tokens.scope,
    connected_at: new Date().toISOString(),
  }, { onConflict: "user_id,email_address" });

  await admin.from("admin_oauth_states").delete().eq("state", state);

  if (upsertErr) return res.redirect(302, inboxUrl(req, { gmail: "error", reason: "store_failed" }));
  return res.redirect(302, inboxUrl(req, { gmail: "connected", account: emailAddress }));
}
