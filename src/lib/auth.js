/* Browser auth for the admin console.
 *
 * Same shared-singleton pattern as the platform's lib/auth.js (one
 * getSession stream shared by every useAuth caller), trimmed to what the
 * console needs, plus the piece the platform doesn't have: the MEMBERSHIP
 * check. Being signed in is not enough here — the user must also have an
 * active row in admin_users. Customers of the platform who sign in at the
 * admin URL authenticate fine and then hit "not authorized".
 *
 * When Supabase env vars are missing the console runs in PREVIEW mode:
 * no auth, sample data everywhere, big labels saying so. */

import { useEffect, useState } from "react";
import { getSupabase, isConfigured } from "./supabase.js";

const sharedAuth = {
  state: { user: null, loading: isConfigured(), membership: undefined },
  listeners: new Set(),
  initialized: false,
};

function emit() {
  for (const l of sharedAuth.listeners) l();
}

function setAuthState(patch) {
  sharedAuth.state = { ...sharedAuth.state, ...patch };
  emit();
}

async function loadMembership(user) {
  const supabase = getSupabase();
  if (!supabase || !user) {
    setAuthState({ membership: null });
    return;
  }
  const { data, error } = await supabase
    .from("admin_users")
    .select("user_id, email, full_name, role, active")
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle();
  setAuthState({ membership: error ? null : data || null });
}

function initSharedAuth() {
  if (sharedAuth.initialized) return;
  const supabase = getSupabase();
  if (!supabase) {
    sharedAuth.initialized = true;
    setAuthState({ loading: false, membership: null });
    return;
  }
  sharedAuth.initialized = true;
  const fallback = setTimeout(() => {
    if (sharedAuth.state.loading) setAuthState({ loading: false });
  }, 4000);
  supabase.auth.onAuthStateChange((_event, session) => {
    clearTimeout(fallback);
    const u = session?.user ?? null;
    setAuthState({ user: u, loading: false, membership: u ? undefined : null });
    if (u) loadMembership(u);
  });
}

/** { user, loading, configured, membership }
 * membership: undefined = still checking, null = not on the roster,
 * object = { role, email, full_name, ... } */
export function useAuth() {
  const configured = isConfigured();
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    initSharedAuth();
    const listener = () => forceUpdate((n) => n + 1);
    sharedAuth.listeners.add(listener);
    return () => { sharedAuth.listeners.delete(listener); };
  }, []);
  return { ...sharedAuth.state, configured };
}

export async function signInWithPassword({ email, password }) {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, error: "Sign-in isn't wired up yet (Supabase keys missing)." };
  const { error } = await supabase.auth.signInWithPassword({
    email: String(email || "").trim(),
    password: String(password || ""),
  });
  if (error) {
    if (/invalid login credentials/i.test(error.message)) {
      return { ok: false, error: "Wrong email or password." };
    }
    if (/email not confirmed/i.test(error.message)) {
      return { ok: false, error: "Confirm your email first — check your inbox." };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function requestPasswordReset(email) {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, error: "Not configured." };
  // Bare origin, no hash route — with the implicit flow Supabase appends the
  // recovery token to the URL hash, and a pre-existing #/route breaks the
  // parse. App.jsx sees type=recovery in the hash and routes to the
  // set-password screen itself.
  const { error } = await supabase.auth.resetPasswordForEmail(String(email || "").trim(), {
    redirectTo: `${window.location.origin}/`,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function updatePassword(newPassword) {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, error: "Not configured." };
  const { error } = await supabase.auth.updateUser({ password: String(newPassword || "") });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function signOut() {
  const supabase = getSupabase();
  if (!supabase) return { ok: true };
  const { error } = await supabase.auth.signOut();
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function getAccessToken() {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || null;
}
