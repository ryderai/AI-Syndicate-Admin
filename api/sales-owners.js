/* GET  /api/sales-owners  — who the sheet says owns rows, and who exists here.
 * POST /api/sales-owners  — make the missing accounts, then hand the rows back.
 *
 * Auth: owner/admin only. Nothing here sends an email — the Team page invite is still the only thing that does. See lib/sales-owners.js
 * for every rule and why each one is the way it is.
 *
 * WHY A SERVER ROUTE AND NOT THE BROWSER: making an account is an
 * auth.admin call, which needs the service key. The claim half could run in
 * the browser under RLS, but it is done here so that an account and the rows
 * that depend on it are decided in one place, by one caller, with one report.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { fetchPaged } from "../lib/paging.js";
import { groupOwnerNames, planAccounts, planClaims, isPlaceholderEmail } from "../lib/sales-owners.js";

const LEAD_COLS = "id, owner_id, imported_owner_name";

async function readTeam(admin) {
  const { data, error } = await admin
    .from("admin_users").select("user_id, email, full_name, role, active");
  if (error) throw new Error(`Could not read the team: ${error.message}`);
  return data || [];
}

async function readLeads(admin) {
  const out = await fetchPaged(() => admin.from("admin_leads").select(LEAD_COLS), { order: "created_at", ascending: false });
  if (out.error && !out.rows.length) throw new Error(`Could not read the leads: ${out.error}`);
  return out;
}

/** Distinct Sales Owner spellings, counted off the real rows rather than
 * trusted from a spreadsheet — the sheet is the past, these rows are now. */
function ownerCounts(leads) {
  const m = new Map();
  for (const l of leads) {
    const n = String(l.imported_owner_name ?? "").trim();
    if (!n) continue;
    m.set(n, (m.get(n) || 0) + 1);
  }
  return [...m.entries()].map(([name, rows]) => ({ name, rows })).sort((a, b) => b.rows - a.rows);
}

export default async function handler(req, res) {
  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const admin = getAdminSupabase();
  if (!admin) return res.status(500).json({ error: "The server has no database keys." });

  let team, leadsRead;
  try {
    [team, leadsRead] = await Promise.all([readTeam(admin), readLeads(admin)]);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
  const leads = leadsRead.rows;
  const counts = ownerCounts(leads);
  const { groups, ambiguous } = groupOwnerNames(counts);

  if (req.method === "GET") {
    const preview = planAccounts(groups, team, {});
    const claims = planClaims(leads, team);
    return res.status(200).json({
      ok: true,
      leadsRead: leads.length,
      truncated: leadsRead.truncated || null,
      spellings: counts,
      groups,
      ambiguousNames: ambiguous,
      wouldCreate: preview.create,
      alreadyHaveAnAccount: preview.already,
      claimableRightNow: claims.claim.length,
      unresolved: claims.unresolved,
      skipped: claims.skipped,
      team: team.map((t) => ({ user_id: t.user_id, email: t.email, full_name: t.full_name, role: t.role, active: t.active })),
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = await readJson(req);
  const emails = body?.emails && typeof body.emails === "object" ? body.emails : {};
  const dryRun = body?.dryRun !== false;                     // you must ask for the real run

  const plan = planAccounts(groups, team, emails);

  if (dryRun) {
    const claims = planClaims(leads, team);
    return res.status(200).json({
      ok: true, dryRun: true,
      willCreate: plan.create, alreadyHaveAnAccount: plan.already,
      claimableBeforeCreating: claims.claim.length, unresolved: claims.unresolved,
    });
  }

  /* ---- the real run ------------------------------------------------- */
  const made = [];
  const failed = [];

  for (const person of plan.create) {
    try {
      /* A quiet account. No message leaves the building.
       * email_confirm true so the row is not left half-made waiting on a
       * confirmation click that will never come; there is no password, so
       * nobody can sign in as them until a real address and a real invite
       * replace this. */
      const { data, error } = await admin.auth.admin.createUser({
        email: person.email,
        email_confirm: true,
        user_metadata: {
          full_name: person.fullName,
          created_by: "sales-owners merge",
          placeholder: person.placeholder,
        },
      });
      if (error) throw new Error(error.message);
      const userId = data?.user?.id;
      if (!userId) throw new Error("No account id came back.");

      const { error: rosterErr } = await admin.from("admin_users").upsert({
        user_id: userId, email: person.email, full_name: person.fullName,
        role: "sales", active: true,
      });
      if (rosterErr) throw new Error(rosterErr.message);
      made.push({ ...person, user_id: userId });
    } catch (e) {
      failed.push({ ...person, why: String(e.message || e) });
    }
  }

  /* Re-read the roster rather than assuming it now says what we asked for —
   * an upsert that failed silently would otherwise claim rows for nobody. */
  let freshTeam;
  try { freshTeam = await readTeam(admin); }
  catch (e) { return res.status(500).json({ error: String(e.message || e), created: made, failed }); }

  const claims = planClaims(leads, freshTeam);

  /* Write the claims in batches, and only where owner_id IS STILL NULL.
   * Between reading and writing a rep can claim a row on the floor; the
   * `.is("owner_id", null)` on every update is what stops this handing their
   * row to somebody else. */
  let claimed = 0;
  const claimErrors = [];
  const byUser = new Map();
  for (const c of claims.claim) {
    if (!byUser.has(c.user_id)) byUser.set(c.user_id, []);
    byUser.get(c.user_id).push(c.id);
  }
  for (const [userId, ids] of byUser) {
    for (let i = 0; i < ids.length; i += 200) {
      const slice = ids.slice(i, i + 200);
      const { data, error } = await admin
        .from("admin_leads")
        .update({ owner_id: userId, claimed_at: new Date().toISOString() })
        .in("id", slice)
        .is("owner_id", null)
        .select("id");
      if (error) { claimErrors.push(error.message); continue; }
      claimed += (data || []).length;
    }
  }

  return res.status(200).json({
    ok: true,
    dryRun: false,
    created: made,
    failed,
    placeholdersMade: made.filter((m) => isPlaceholderEmail(m.email)).length,
    leadsClaimed: claimed,
    leadsPlanned: claims.claim.length,
    unresolved: claims.unresolved,
    skipped: claims.skipped,
    claimErrors,
  });
}
