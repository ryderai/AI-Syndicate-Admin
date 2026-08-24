/* Google OAuth for the Gmail inbox — same flow shape as the platform's
 * lib/gsc.js (state row → consent → callback → refresh token stored).
 *
 * Env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
 *
 * Scopes: modify + send.
 *   gmail.modify covers reading, marking read, archiving and labelling. It is
 *   the widest scope that CANNOT permanently delete a message or empty the
 *   bin — that is gmail.full / mail.google.com, which we never ask for. So the
 *   worst a bug or a bad actor with this token can do is move mail out of the
 *   inbox, and the mail is still in All Mail.
 *   Ryder chose this on Aug 18 2026 so a status set in the console shows up in
 *   Gmail too (mark read, archive on Done, AIS/Client/... labels). Anyone who
 *   connected a mailbox before that date is on the old read-only scope and has
 *   to reconnect once — accountNeedsReconnect() below is what spots them. */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GMAIL_SCOPE_LIST = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
];

export const GMAIL_SCOPES = GMAIL_SCOPE_LIST.join(" ");

/** True when a stored connection predates the modify scope, so labelling and
 * archiving would fail with a 403 until the person reconnects. Checked against
 * the scope string Google returned at connect time — not guessed from a date. */
export function accountNeedsReconnect(scope) {
  return !String(scope || "").includes("https://www.googleapis.com/auth/gmail.modify");
}

export function hasGoogleClientCredentials() {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

/* `scopes` was added Aug 24 2026 for the client connections (Search Console,
 * Business Profile, Analytics), which use this same flow with different
 * permissions. It DEFAULTS to the Gmail scopes, so every existing caller
 * behaves exactly as before.
 *
 * include_granted_scopes is deliberately NOT set. Google would then hand back
 * one token carrying every permission the account had ever granted us — so a
 * token stored for one client's Search Console would also open that person's
 * mailbox. Each connection holds the narrowest token that does its job. */
export function buildAuthorizeUrl({ redirectUri, state, scopes }) {
  const scope = Array.isArray(scopes) ? scopes.join(" ") : (scopes || GMAIL_SCOPES);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens({ code, redirectUri }) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error_description || body?.error || `token exchange failed (${res.status})`);
  if (!body.refresh_token) throw new Error("Google did not return a refresh token. Remove the app's prior access at myaccount.google.com/permissions and connect again.");
  return {
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    scope: body.scope,
    idToken: body.id_token,
  };
}

export async function accessTokenFromRefresh(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error_description || body?.error || `refresh failed (${res.status})`);
  return body.access_token;
}

/** Decode the email address out of an id_token without verification —
 * fine here because the token came straight from Google's token endpoint
 * over TLS in the same request. */
export function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return payload.email || null;
  } catch {
    return null;
  }
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export async function gmailFetch(accessToken, path, init = {}) {
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `Gmail API ${res.status}`;
    const err = new Error(msg);
    err.statusCode = res.status;
    throw err;
  }
  return body;
}
