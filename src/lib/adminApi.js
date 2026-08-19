/* Thin fetch wrapper for the console's /api endpoints.
 * Adds the Supabase bearer token; normalizes errors to { ok, error }. */

import { getAccessToken } from "./auth.js";
import { isConfigured } from "./supabase.js";

export async function apiFetch(path, { method = "GET", body } = {}) {
  if (!isConfigured()) {
    return { ok: false, preview: true, error: "Preview mode — server endpoints need the Supabase keys first." };
  }
  const token = await getAccessToken();
  if (!token) return { ok: false, error: "Not signed in." };
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    return { ok: false, error: err?.name === "TimeoutError" ? "The request timed out." : (err?.message || "Network error.") };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, error: data?.error || `HTTP ${res.status}` };
  return { ok: true, data };
}

/** GET /api/health — cached for the session so badges don't re-fetch per page. */
let healthCache = null;
export async function getHealth(force = false) {
  if (healthCache && !force) return healthCache;
  if (!isConfigured()) {
    healthCache = { preview: true, supabase: false, stripe: false, gmail: false, ai: false, usageIngest: false };
    return healthCache;
  }
  const res = await apiFetch("/api/health");
  healthCache = res.ok ? { preview: false, ...res.data } : { preview: false, supabase: true, stripe: false, gmail: false, ai: false, usageIngest: false, error: res.error };
  return healthCache;
}
