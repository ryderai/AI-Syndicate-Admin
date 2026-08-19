/* POST /api/platform-sso — open the customer platform already signed in.
 *
 * What it does, in plain words: the console and the platform sit on the same
 * Supabase project, but they are two different websites, so a login on one is
 * not a login on the other. This endpoint asks Supabase (using the server-only
 * service key) for a one-time sign-in link for a platform account and hands
 * that link back to the browser, which opens it in a new tab.
 *
 * Body: { accountId } — the id of a row in admin_platform_accounts.
 * With no accountId it falls back to PLATFORM_ACCOUNT_EMAIL, and to nothing
 * else. That is the whole list of addresses this endpoint can ever reach:
 * saved cards, plus one address set in the server environment.
 *
 * ⚠ THE ONE RULE THAT MATTERS: an email is NEVER taken from the browser.
 * A sign-in link is a real credential for whoever owns that address, so the
 * only addresses this endpoint will mint one for are the rows an owner or
 * admin already saved in admin_platform_accounts, plus PLATFORM_ACCOUNT_EMAIL.
 * Accept an email from the request body and this endpoint becomes "log me in
 * as anyone on the platform", including a customer who never gave us their
 * account.
 *
 * It used to fall back to the signed-in member's own admin_users email. That
 * was removed Aug 18 2026: an admin can edit their own admin_users row, so
 * that fallback was "type any address into your own profile, POST an empty
 * body, become them". A roster field is not a permission.
 *
 * Where the tab lands: the bare platform origin, with the sign-in token in the
 * URL hash. The platform's own App.jsx already expects that — its comment reads
 * "After auth callback Supabase strips the hash route and leaves the user at
 * '/'. Forward them to where they belong" — so it forwards to /#/dashboard by
 * itself. If that account has two-factor turned on, it forwards to /#/signin
 * for the code instead; the link still did its job.
 *
 * Auth: owner/admin only. A sales rep must not be able to become another
 * account on the customer product.
 *
 * Safety notes:
 *  - The link is a one-time credential. It is never logged and never stored.
 *  - Minted fresh per click; Supabase expires it on its own schedule.
 *  - redirectTo is forced to a bare origin. A redirect that already contains
 *    "/#/route" breaks Supabase's implicit-flow token parsing, because the
 *    token is appended after the existing hash (trap #3 in CONTEXT-FOR-AI).
 */

import { requireMember, getAdminSupabase, isServerConfigured, readJson } from "../lib/supabase-server.js";
import { normalizeEmail } from "../lib/platform-accounts.js";

const DEFAULT_PLATFORM_URL = "https://aisyndicate.com";

/** Vercel hands back an array when a query parameter repeats; the local dev
 * middleware does the same. Always read the last value. */
function oneParam(value) {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

/** The platform origin: scheme + host only, no path, no hash, no "www.".
 *
 * new URL() does NOT throw on "javascript:" or "data:" — it returns an object
 * whose .origin is the literal string "null" — so the scheme is checked by
 * hand. www is stripped because the session only lives on the bare host
 * (the www host is a separate origin and dumps you at sign-in). */
export function platformOrigin() {
  const raw = (process.env.PLATFORM_URL || DEFAULT_PLATFORM_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return DEFAULT_PLATFORM_URL;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return DEFAULT_PLATFORM_URL;
  if (!parsed.hostname) return DEFAULT_PLATFORM_URL;
  const host = parsed.hostname.replace(/^www\./i, "");
  const port = parsed.port ? ":" + parsed.port : "";
  return `${parsed.protocol}//${host}${port}`;
}

/** Which platform account we sign in as when no card was picked. The server
 * environment only — never anything the caller can edit. Empty string means
 * "there is no fallback", and the endpoint says so instead of guessing. */
export function platformAccountEmail() {
  return (process.env.PLATFORM_ACCOUNT_EMAIL || "").trim();
}

/** Postgres raises "invalid input syntax for type uuid" on a junk id, which
 * would surface as a 500 with a raw database message in a toast. Check the
 * shape here and answer the plain-words 404 instead. */
function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** A card was clicked: look the row up by id and use ITS email.
 * Returns { email, label, account } or { error, status }. */
async function accountFromCard(admin, accountId) {
  const { data, error } = await admin
    .from("admin_platform_accounts")
    .select("id, client_id, label, email, site, active")
    .eq("id", accountId)
    .maybeSingle();

  if (error) return { status: 500, error: "Could not read the saved accounts: " + error.message };
  if (!data) return { status: 404, error: "That account is not on the saved list any more. Refresh the page." };
  if (data.active === false) {
    return { status: 409, error: `"${data.label}" is switched off. Turn it back on to sign in with it.` };
  }
  const email = normalizeEmail(data.email);
  if (!email) return { status: 409, error: `"${data.label}" has no login email saved.` };
  return { email, account: data };
}

export default async function handler(req, res) {
  const isDiag = req.method === "GET" && oneParam(req.query?.diag) === "1";

  if (req.method !== "POST" && !isDiag) {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!isServerConfigured()) {
    // The gate itself can't run, so say so plainly rather than 401-ing.
    return res.status(503).json({
      configured: false,
      error: "The Supabase server key is missing, so no sign-in link can be made.",
    });
  }

  // Owner/admin for everything, the diagnostic included. The diagnostic
  // reports how many accounts this console can become and whether sign-in is
  // armed; a sales rep has no business counting them.
  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  res.setHeader("Cache-Control", "private, no-store");

  const supabase = getAdminSupabase();

  if (isDiag) {
    // Config booleans and a count. Never a key, never a link, never an address.
    const { count } = await supabase
      .from("admin_platform_accounts")
      .select("id", { count: "exact", head: true })
      .eq("active", true);
    return res.status(200).json({
      serverConfigured: true,
      platformUrl: platformOrigin(),
      accountConfigured: Boolean((process.env.PLATFORM_ACCOUNT_EMAIL || "").trim()),
      savedAccounts: count ?? 0,
      role: member.membership.role,
    });
  }

  const body = await readJson(req);
  const accountId = String(body?.accountId || "").trim();

  let email = "";
  let card = null;
  let shared = false;

  if (accountId) {
    if (!looksLikeUuid(accountId)) {
      return res.status(404).json({ configured: true, error: "That account is not on the saved list. Refresh the page." });
    }
    const picked = await accountFromCard(supabase, accountId);
    if (picked.error) return res.status(picked.status).json({ configured: true, error: picked.error });
    email = picked.email;
    card = picked.account;
    shared = true; // a saved card is by definition an account we all share
  } else {
    email = normalizeEmail(platformAccountEmail());
    shared = Boolean(email);
    if (!email) {
      return res.status(400).json({
        configured: true,
        error: "No account was picked, and no PLATFORM_ACCOUNT_EMAIL is set on the server. Add the account as a card on the Our-platform page and press the button on the card.",
      });
    }
  }

  const origin = platformOrigin();

  let data, error;
  try {
    ({ data, error } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo: origin },
    }));
  } catch (err) {
    error = err;
  }

  if (error) {
    const raw = String(error?.message || "");
    // Supabase says "User not found" when the address has no platform login.
    const friendly = /not found|no user/i.test(raw)
      ? `There is no platform account for ${email}. Sign that address up on the platform first, then try again.`
      : "Supabase would not make a sign-in link. " + raw;
    return res.status(502).json({ configured: true, error: friendly });
  }

  const url = data?.properties?.action_link;
  if (!url) {
    return res.status(502).json({ configured: true, error: "Supabase returned no sign-in link." });
  }

  // Stamp the card. NOTE WHAT THIS RECORDS: a link was MADE, by this person,
  // at this time. Nobody here can see whether the browser then used it — the
  // link is spent on Supabase's side, not ours — so the card and the toast
  // both say "sign-in link made", never "signed in". Best effort on purpose:
  // a failed stamp must not cost a working sign-in.
  if (card?.id) {
    await supabase
      .from("admin_platform_accounts")
      .update({ last_opened_at: new Date().toISOString(), last_opened_by: member.user.id })
      .eq("id", card.id);
  }

  return res.status(200).json({
    configured: true,
    url,
    account: email,
    label: card?.label || null,
    accountId: card?.id || null,
    site: card?.site || null,
    shared,
    platform: origin,
  });
}
