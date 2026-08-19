/* Browser Supabase client.
 *
 * Reads VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY at build time.
 * If those env vars aren't set, isConfigured() returns false and the
 * app falls back to localStorage-only mode (no auth, no DB persist).
 * This lets us ship Phase 2 incrementally — the deployed app keeps
 * working even before the user wires up Supabase.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

let client = null;

/* SIGN-IN SWITCH.
 *
 * Set VITE_NO_SIGNIN=true in .env.local and the console opens with no login.
 *
 * It switches off the whole live data layer, not just the login screen, and
 * that is on purpose. Every read in data.js and every /api call in
 * adminApi.js is authorised by the signed-in user's token — with nobody
 * signed in, a "live" console would be a wall of permission errors. So this
 * drops the app back to the sample store, which is honest: every card says
 * SAMPLE and a banner across the top says sign-in is off.
 *
 * Turn it off (delete the line, or set it to false) the moment there is real
 * data worth protecting. Restart `npm run dev` after changing it — Vite reads
 * env at boot, so editing the file alone does nothing.
 */
export function signInDisabled() {
  return String(import.meta.env.VITE_NO_SIGNIN || "").toLowerCase() === "true";
}

export function isConfigured() {
  if (signInDisabled()) return false;
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/* No-op lock for gotrue-js. Default implementation uses navigator.locks /
 * a JS-level lock that can deadlock when multiple auth calls race
 * (signInWithPassword + auto-refresh-timer + mfa.getAuthenticatorAssuranceLevel
 * all contend, the "loser" aborts with `Lock was stolen`, and sign-in fails
 * with HTTP 400 on /token). Since we only have one Supabase client instance
 * and gotrue's request handlers are themselves atomic, the lock buys us
 * nothing — just bypass it. */
const noopLock = async (_name, _acquireTimeout, fn) => fn();

export function getSupabase() {
  if (!isConfigured()) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // Implicit flow puts tokens in the URL hash and the client picks
        // them up directly. PKCE breaks the email-link verification flow
        // because the client requires a code_verifier in the same browser
        // session that initiated the signup.
        flowType: "implicit",
        lock: noopLock,
      },
    });
  }
  return client;
}
