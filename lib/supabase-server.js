/* Server-side Supabase admin client for the ADMIN console.
 *
 * Same pattern as the platform's lib/supabase-server.js, plus the
 * admin_users membership check every /api route runs before doing anything.
 * Never import this from the browser.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let adminClient = null;

export function isServerConfigured() {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

/** Service-role client — bypasses RLS. Reuse across requests. */
export function getAdminSupabase() {
  if (!isServerConfigured()) return null;
  if (!adminClient) {
    adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return adminClient;
}

/** Read the user from the Authorization: Bearer header. Null if invalid. */
export async function getUserFromRequest(req) {
  if (!isServerConfigured()) return null;
  const auth = req.headers?.authorization || req.headers?.Authorization;
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return null;
  const admin = getAdminSupabase();
  if (!admin) return null;
  const { data, error } = await admin.auth.getUser(match[1].trim());
  if (error || !data?.user) return null;
  return data.user;
}

/** The console gate: user must exist AND be an active admin_users row.
 * Returns { user, membership } or null. Pass roles to restrict further,
 * e.g. requireMember(req, ["owner","admin"]). */
export async function requireMember(req, roles = null) {
  const user = await getUserFromRequest(req);
  if (!user) return null;
  const admin = getAdminSupabase();
  const { data, error } = await admin
    .from("admin_users")
    .select("user_id, email, full_name, role, active")
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle();
  if (error || !data) return null;
  if (roles && !roles.includes(data.role)) return null;
  return { user, membership: data };
}

export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
