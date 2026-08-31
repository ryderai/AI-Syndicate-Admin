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
import { groupOwnerNames, planAccounts, planClaims, projectedTeam, isPlaceholderEmail } from "../lib/sales-owners.js";

const LEAD_COLS = "id, owner_id, imported_owner_name, first_contact_at";

async function readTeam(admin) {
  const { data, error } = await admin
    .from("admin_users").select("user_id, email, full_name, role, active");
  if (error) throw new Error(`Could not read the team: ${error.message}`);
  return data || [];
}

async function readLeads(admin) {
  const out = await fetchPaged(() => admin.from("admin_leads").select(LEAD_COLS), { order: "created_at", ascending: false });
  if (out.error && !out.rows.length) throw new Error(`Could not read the leads: ${out.error}`);
  /* A read that died on page 3 hands back 2,000 real rows and an error. Those
   * rows are true, so they are kept — but planning a claim off a fragment while
   * the screen says nothing is how you find out afterwards. fetchPaged returns
   * `partial` for exactly this, and it used to be dropped on the floor. */
  if (out.error) {
    out.truncated = `Only ${out.rows.length.toLocaleString()} lead rows could be read before the database stopped answering (${out.error}). Everything below counts those rows only — do not treat it as the whole pipeline.`;
  }
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

/** Does this address already have an auth account? Paged, because the shared
 * project holds every platform customer and a first-page-only check misses
 * them — api/invite.js learned this the same way. Without it, a run that died
 * between createUser and the roster upsert could never be retried: the second
 * attempt regenerates the same placeholder address and createUser refuses it
 * for ever. */
async function findAuthUser(admin, email) {
  const want = String(email || "").toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return null;
    const users = data?.users || [];
    const hit = users.find((u) => (u.email || "").toLowerCase() === want);
    if (hit) return hit;
    if (users.length < 1000) return null;
  }
  return null;
}

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    /* AGAINST THE ROSTER AS IT WILL BE, not as it is. Counting against today's
     * roster made the screen say "1 row" immediately above a button that was
     * about to move three thousand. */
    const claims = planClaims(leads, projectedTeam(team, preview.create));
    return res.status(200).json({
      ok: true,
      leadsRead: leads.length,
      truncated: leadsRead.truncated || null,
      spellings: counts,
      groups,
      ambiguousNames: ambiguous,
      wouldCreate: preview.create,
      alreadyHaveAnAccount: preview.already,
      needsAPerson: preview.needsAPerson,
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
    const claims = planClaims(leads, projectedTeam(team, plan.create));
    return res.status(200).json({
      ok: true, dryRun: true,
      willCreate: plan.create, alreadyHaveAnAccount: plan.already,
      needsAPerson: plan.needsAPerson,
      claimableOnceTheyExist: claims.claim.length, unresolved: claims.unresolved,
    });
  }

  const badEmail = plan.create.find((c) => !EMAIL_OK.test(c.email));
  if (badEmail) {
    return res.status(400).json({ error: `"${badEmail.email}" does not look like an email address. Fix it and try again — nothing was created.` });
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
      let userId = null;
      const existing = await findAuthUser(admin, person.email);
      if (existing) {
        /* Either a previous run of this endpoint died between the two writes,
         * or somebody typed in an address that already has an account. Either
         * way the account is REUSED — making a second one is impossible and
         * refusing would strand this person for ever. */
        userId = existing.id;
      } else {
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
        userId = data?.user?.id || null;
      }
      if (!userId) throw new Error("No account id came back.");

      const { error: rosterErr } = await admin.from("admin_users").upsert({
        user_id: userId, email: person.email, full_name: person.fullName,
        role: "sales", active: true,
      });
      if (rosterErr) throw new Error(rosterErr.message);
      made.push({ ...person, user_id: userId, reusedExistingAccount: Boolean(existing) });
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
  const nowIso = new Date().toISOString();

  /* Write the claims in batches, and only where owner_id IS STILL NULL.
   * Between reading and writing a rep can claim a row on the floor; the
   * `.is("owner_id", null)` on every update is what stops this handing their
   * row to somebody else. */
  let claimed = 0;
  const claimErrors = [];
  const writtenIds = [];

  /* THE CLAIM DATE IS NOT TODAY.
   *
   * `claimed_at` starts the 3-day first-contact clock and `cadence_started_at`
   * starts the 5-touch cadence, and src/lib/data.js says in as many words that
   * setting one without the other gives a lead a cadence that began at the
   * epoch. Stamping both with NOW would also restart the 3-day clock on every
   * row at once, and api/sales-sweep.js would warn on the lot of them three
   * business days later.
   *
   * lib/sales-import.js already answered this: the sheet has no Date Claimed
   * column, so the first contact date is the best evidence there is, and only
   * where there is none does the claim get stamped at merge time. Two code
   * paths writing two different claim dates for the same rows is worse than
   * either date, so this uses that one.
   *
   * Rows are grouped by (owner, claim date) so each update still writes one
   * value to many rows. */
  const buckets = new Map();
  for (const c of claims.claim) {
    const at = c.firstContactAt || nowIso;
    const k = `${c.user_id}::${at}`;
    if (!buckets.has(k)) buckets.set(k, { user_id: c.user_id, at, ids: [] });
    buckets.get(k).ids.push(c.id);
  }
  for (const { user_id: userId, at, ids } of buckets.values()) {
    for (let i = 0; i < ids.length; i += 200) {
      const slice = ids.slice(i, i + 200);
      const { data, error } = await admin
        .from("admin_leads")
        .update({ owner_id: userId, claimed_at: at, cadence_started_at: at })
        .in("id", slice)
        .is("owner_id", null)
        .select("id");
      if (error) { claimErrors.push(error.message); continue; }
      claimed += (data || []).length;
      for (const r of data || []) writtenIds.push({ id: r.id, user_id: userId });
    }
  }

  /* A ROW THAT CHANGES HANDS LEAVES A LINE. Every other claim path in this
   * console writes one — claimLead, the importer, the sweep — and thousands of
   * leads quietly changing owner with nothing on any timeline is the kind of
   * thing that is impossible to explain a week later. Written only for rows the
   * database actually accepted, never for the ones it refused.
   *
   * type is 'assigned', which 0001's check constraint allows, and actor is the
   * person who pressed the button — not the rep receiving the row. */
  const activityErrors = [];
  for (let i = 0; i < writtenIds.length; i += 200) {
    const slice = writtenIds.slice(i, i + 200).map((w) => ({
      lead_id: w.id, actor: member.user.id, type: "assigned",
      body: "Handed back to the rep whose name was in the sheet's Sales Owner column, when their account was created on 31 Aug 2026. Nobody was emailed.",
    }));
    const { error } = await admin.from("admin_lead_activity").insert(slice);
    if (error) activityErrors.push(error.message);
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
    activityErrors,
  });
}
