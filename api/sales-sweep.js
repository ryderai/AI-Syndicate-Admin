/* GET /api/sales-sweep — the overnight job that makes the claim timers real.
 *
 * WHAT IT DOES, IN ORDER
 *   1. WARNS. Anything about to run out gets a dated reminder on the rep's
 *      Work page, so nothing is ever taken away without notice.
 *   2. REOPENS. Claims that have actually run out — no first contact after
 *      three business days, or fourteen days with nothing logged — go back to
 *      the floor, with a line on the lead's own timeline saying what happened.
 *
 * WHY THE WARNING COMES FIRST AND WHY IT MATTERS
 * The sheet's version of "the claim drops" is a sentence in a rules tab. It
 * has never happened once, because nothing was counting. Turning it on with no
 * warning would be worse than leaving it off: a rep who loses a firm silently,
 * mid-conversation, decides the system is against them and goes back to the
 * spreadsheet. So a claim spends its last two days as a card on My Day and a
 * reminder on the Work page before anything moves, and a reopened lead keeps
 * every note, call and email it ever had — a rep who was mid-conversation can
 * re-claim it in one click and lose nothing.
 *
 * AUTHORISED BY CRON_SECRET, NEVER BY A SESSION
 * There is no person behind this. With no secret set the scheduled path is
 * CLOSED, not open — same rule as api/lead-scrape.js. A cron endpoint that
 * runs for anybody who finds the URL can empty a sales floor.
 *
 * EVERY DECISION IS MADE BY lib/sales-rules.js, which the Sales page also
 * uses. If this file counted days its own way, a rep would open the page at
 * 9am and see a firm the sweep took at 3am — and neither screen would be
 * wrong, which is the worst kind of bug to explain.
 */

import { getAdminSupabase } from "../lib/supabase-server.js";
import { claimState, shouldReopen, ROE, TZ } from "../lib/sales-rules.js";

/* How many leads one run will touch. A cap, not a page size: the run is
 * ordered oldest-claim-first, so the most overdue are always handled and the
 * remainder are REPORTED rather than silently skipped. A job that quietly does
 * half the work looks exactly like a job that did all of it. */
const CAP = 500;

/** Tomorrow, 9am Central, expressed in UTC.
 *
 * A hardcoded `T14:00:00Z` is 9am Central in summer and 8am in winter, because
 * Chicago moves and UTC does not. One hour is not much on a reminder, but a
 * comment that says 9am while the code says something else is how the next
 * person gets the next one wrong. Ask Intl for the real offset. */
function tomorrowMorning() {
  const day = new Date(Date.now() + 86400000);
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(day);
  // Which UTC hour is 9am local on that date: try 14:00Z and check.
  for (const hour of [14, 15]) {
    const guess = new Date(`${local}T${String(hour).padStart(2, "0")}:00:00Z`);
    const h = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }).format(guess);
    if (Number(h) === 9) return guess.toISOString();
  }
  return `${local}T14:00:00Z`;
}

export default async function handler(req, res) {
  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "Waiting on the Supabase keys." });

  const secret = process.env.CRON_SECRET;
  const given = req.headers?.authorization || "";
  if (!secret || given !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Not authorized." });
  }

  const now = new Date().toISOString();

  /* Only claimed, still-open leads can be at risk. The stage list is spelled
   * out rather than "not won and not lost", because skip_90 and bad_contact
   * are finished with too and nagging about them is how a warning stops being
   * read. */
  const { data: leads, error } = await admin
    .from("admin_leads")
    .select("id, name, company, stage, owner_id, claimed_at, claim_contacted_at, first_contact_at, last_touch_at, last_activity_at, created_at, company_id")
    .not("owner_id", "is", null)
    /* HAND-WRITTEN OPEN-STAGE LIST, and a stage missing from it is a stage the
       nightly sweep never reclaims. Both halves of the Meeting split are here
       (0030), and `meeting` stays for any row a backup restores. */
    .in("stage", ["new", "researching", "contacted", "in_conversation", "follow_up", "meeting", "meeting_booked", "meeting_complete", "proposal", "reopened"])
    .order("claimed_at", { ascending: true, nullsFirst: true })
    .limit(CAP + 1);
  if (error) return res.status(500).json({ error: error.message });

  const rows = (leads || []).slice(0, CAP);
  const overflow = (leads || []).length > CAP;

  const warned = [];
  const reopened = [];
  const problems = [];
  const heldBack = [];

  for (const lead of rows) {
    const state = claimState(lead, now);
    const who = lead.name || lead.company || "a contact";

    if (shouldReopen(lead, now)) {
      /* NOTHING IS TAKEN THAT WAS NOT WARNED ABOUT FIRST.
       *
       * The header of this file promises a claim spends its last days as a
       * warning before anything moves. Without this check that was only true
       * for leads the sweep happened to see in time — and it was catastrophic
       * on day one: every pre-existing lead in the pipeline was stamped with an
       * old claim date by migration 0009's backfill, so the FIRST run would
       * have unassigned the entire sales floor overnight, from a job with
       * nobody watching.
       *
       * So a release requires evidence that this rep was told: an open
       * reminder pointing at this lead. No warning on file means warn now and
       * take it next time. */
      const { data: warning, error: warnErr } = await admin.from("admin_reminders")
        .select("id").eq("link_type", "lead").eq("link_id", lead.id)
        .eq("owner_id", lead.owner_id).limit(1);
      if (warnErr) { problems.push(`${who}: could not check for a warning (${warnErr.message})`); continue; }
      if (!warning?.length) {
        const { error: firstErr } = await admin.from("admin_reminders").insert({
          owner_id: lead.owner_id,
          body: `${who}: ${state.why} Log something on it or it goes back to the floor.`,
          due_at: tomorrowMorning(),
          link_type: "lead", link_id: lead.id, created_by: lead.owner_id,
        });
        if (firstErr) problems.push(`${who}: first warning failed (${firstErr.message})`);
        else heldBack.push({ id: lead.id, who, reason: state.state });
        continue;
      }
      const why = state.state === "claim_expired"
        ? `Claim released automatically: no first contact within ${ROE.FIRST_CONTACT_BUSINESS_DAYS} business days of claiming. ${state.why} Everything logged on this contact is kept — re-claim it if you were mid-conversation.`
        : `Back on the floor automatically: ${state.why} Everything logged is kept — re-claim it if you were mid-conversation.`;

      /* `stage` is deliberately untouched. Writing stage:"reopened" here lost
       * the pipeline position of anything at meeting or proposal — a live deal
       * with a real proposal row against it — and nothing recorded what it had
       * been. Whose it is and how far it got are two different facts, and only
       * the first is this job's to change. */
      /* `first_contact_at` and `last_touch_at` are history and are NOT cleared.
       * Only `claim_contacted_at` — the current claim's three-day window —
       * goes, so the next person to claim it starts clean without the record
       * losing the date it was actually first contacted. */
      const { error: upErr } = await admin.from("admin_leads").update({
        owner_id: null, claimed_at: null, cadence_started_at: null,
        claim_contacted_at: null,
      }).eq("id", lead.id);
      if (upErr) { problems.push(`${who}: ${upErr.message}`); continue; }

      /* The timeline line is written AFTER the update and its error is read.
       * A "logged it" helper that never checks its own result is how a change
       * ends up with no record of who made it — the failure mode is silence,
       * which is the worst kind. */
      const { error: logErr } = await admin.from("admin_lead_activity").insert({
        lead_id: lead.id, actor: lead.owner_id, type: "reopen", body: why,
      });
      if (logErr) problems.push(`${who}: released, but the timeline note failed (${logErr.message})`);

      /* And a reminder for the person who lost it, so they find out from their
       * own Work page rather than by noticing a gap. */
      const { error: remErr } = await admin.from("admin_reminders").insert({
        owner_id: lead.owner_id,
        body: `${who} went back to the floor — ${state.state === "claim_expired" ? "no first contact was logged in time" : `${ROE.COLD_REOPEN_DAYS} days with nothing logged`}. Re-claim it if you were still working it.`,
        due_at: tomorrowMorning(),
        link_type: "lead", link_id: lead.id, created_by: lead.owner_id,
      });
      if (remErr) problems.push(`${who}: released, but the reminder failed (${remErr.message})`);

      reopened.push({ id: lead.id, who, reason: state.state });
      continue;
    }

    if (state.state === "first_contact_due" || state.state === "going_cold") {
      /* One warning per lead per day. Without this check a nightly run stacks
       * a new reminder every night for a fortnight and the Work page becomes
       * a wall of the same sentence, which is how people learn to ignore it. */
      const since = new Date(Date.now() - 20 * 3600000).toISOString();
      const { data: recent, error: recentErr } = await admin.from("admin_reminders")
        .select("id").eq("link_type", "lead").eq("link_id", lead.id)
        .eq("owner_id", lead.owner_id).is("done_at", null)
        .gte("created_at", since).limit(1);
      if (recentErr) { problems.push(`${who}: could not check for a recent warning (${recentErr.message})`); continue; }
      if (recent?.length) continue;

      const { error: remErr } = await admin.from("admin_reminders").insert({
        owner_id: lead.owner_id,
        body: `${who}: ${state.why}`,
        due_at: tomorrowMorning(),
        link_type: "lead", link_id: lead.id, created_by: lead.owner_id,
      });
      if (remErr) { problems.push(`${who}: warning failed (${remErr.message})`); continue; }
      warned.push({ id: lead.id, who, reason: state.state });
    }
  }

  res.setHeader("Cache-Control", "private, no-store");
  /* A run that hit problems answers 207, not 200, and ok:false. A cron monitor
   * reads the status code, and a job that releases leads without leaving a
   * timeline note or telling the rep is exactly the kind of half-success that
   * must not look like a success. */
  return res.status(problems.length ? 207 : 200).json({
    ok: problems.length === 0,
    checked: rows.length,
    warned: warned.length,
    reopened: reopened.length,
    held_back: heldBack.length,
    problems,
    /* Named out loud rather than swallowed. A cap that is not reported reads as
     * "we checked everything". */
    truncated: overflow ? `More than ${CAP} claimed leads exist; only the ${CAP} with the oldest claims were checked this run.` : null,
    detail: { warned, reopened, heldBack },
  });
}
