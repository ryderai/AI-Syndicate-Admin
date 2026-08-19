/* POST /api/invite — add a teammate to the console.
 * Auth: owner/admin. Body: { email, fullName?, role: "admin"|"sales"|"owner" }
 *
 * Two cases:
 *   1. The email already has an auth.users account (e.g. they're a platform
 *      user, or they signed in once) → we upsert their admin_users row
 *      directly. They can sign in right now.
 *   2. New email → Supabase sends an invite email; when they accept and set
 *      a password, the pre-created admin_users row is waiting for them. */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const body = await readJson(req);
  const email = String(body?.email || "").trim().toLowerCase();
  const fullName = String(body?.fullName || "").trim() || null;
  const role = ["owner", "admin", "sales"].includes(body?.role) ? body.role : "sales";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "That email doesn't look right." });
  }
  // Only owners can mint other owners.
  if (role === "owner" && member.membership.role !== "owner") {
    return res.status(403).json({ error: "Only an owner can add another owner." });
  }

  const admin = getAdminSupabase();

  // Does this email already have an auth account? The shared project holds
  // every platform customer, so page through ALL users (up to 20k) — a
  // first-page-only check misses accounts and breaks the invite.
  let existingUser = null;
  try {
    for (let pageNo = 1; pageNo <= 20 && !existingUser; pageNo++) {
      const { data, error } = await admin.auth.admin.listUsers({ page: pageNo, perPage: 1000 });
      if (error) break;
      const users = data?.users || [];
      existingUser = users.find((u) => (u.email || "").toLowerCase() === email) || null;
      if (users.length < 1000) break;
    }
  } catch { /* fall through to invite */ }

  let userId = existingUser?.id || null;

  // If they already have a ROSTER row, this endpoint must not silently
  // rewrite their role — that's the Team page's job (RLS protects owners).
  if (userId) {
    const { data: existingRow } = await admin
      .from("admin_users").select("user_id, role").eq("user_id", userId).maybeSingle();
    if (existingRow) {
      return res.status(409).json({
        error: `${email} is already on the roster (${existingRow.role}). Change their role or reactivate them from the Team page instead.`,
      });
    }
  }

  if (!userId) {
    // Bare origin only — with the implicit flow Supabase appends the invite
    // token to the URL hash, and a pre-existing #/route breaks the parse
    // (same trap the platform's auth.js documents). App.jsx sees type=invite
    // in the hash and routes to the set-password screen.
    const redirectTo = process.env.ADMIN_BASE_URL
      ? `${process.env.ADMIN_BASE_URL.replace(/\/+$/, "")}/`
      : undefined;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: fullName ? { full_name: fullName } : undefined,
      redirectTo,
    });
    if (error) {
      if (/already.*registered/i.test(error.message)) {
        return res.status(409).json({
          error: `${email} already has an account but wasn't found in the user list. Ask them to sign in at the admin URL once, then add them from the Team page.`,
        });
      }
      return res.status(500).json({ error: `Invite failed: ${error.message}` });
    }
    userId = data?.user?.id || null;
  }
  if (!userId) return res.status(500).json({ error: "Could not create or find that user." });

  const { error: upsertErr } = await admin.from("admin_users").upsert({
    user_id: userId,
    email,
    full_name: fullName,
    role,
    active: true,
  });
  if (upsertErr) return res.status(500).json({ error: `Roster update failed: ${upsertErr.message}` });

  await admin.from("admin_invites").insert({
    email, role, invited_by: member.user.id,
    status: existingUser ? "accepted" : "sent",
  });

  return res.status(200).json({
    ok: true,
    existing: Boolean(existingUser),
    message: existingUser
      ? `${email} already had an account — access granted, they can sign in now.`
      : `Invite email sent to ${email}.`,
  });
}
