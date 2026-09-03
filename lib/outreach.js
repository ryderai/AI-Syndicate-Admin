/* OUTREACH, COUNTED — sent, replied, reply rate, and no open rate anywhere.
 *
 * PURE. `now` is passed in, the rows are passed in, nothing here reads a clock,
 * a database or the network. It is imported by the rep's own Overview and by the
 * owner's rep-numbers table, and that is the whole reason it exists as a
 * function rather than as arithmetic inside two components: THE SAME FUNCTION
 * WITH THE SAME ROWS AND THE SAME userId HAS TO PRODUCE THE SAME NUMBER, or a
 * rep's tile and CJ's cell for that rep drift apart and one of them is a lie.
 * tests/outreach-stats asserts exactly that from one fixture.
 *
 * ============================================================
 * THERE IS NO OPEN RATE IN HERE, AND THERE IS NOT GOING TO BE
 * ============================================================
 * Gmail cannot tell anybody whether a person opened an email. There is no
 * recipient-side open signal in the Gmail API and there is not one in anybody
 * else's. The only way an "open rate" is ever produced is a tracking pixel — a
 * 1x1 invisible image that phones home when the mail is displayed — and Apple
 * Mail Privacy Protection loads that pixel for everybody whether they read the
 * mail or not, while Gmail proxies images through its own servers. So a
 * pixel-based open rate is somewhere between inflated and meaningless. The
 * "under 3% open rate" figure that gets quoted around this is measured with that
 * same broken pixel.
 *
 * Ryder agreed to drop it on Aug 27 2026. If anybody ever adds one, it is
 * labelled GUESSED and never mixed with the numbers below.
 *
 * ============================================================
 * WHY THE UNIT IS A PERSON, NOT AN EMAIL
 * ============================================================
 * "Reply rate" needs a numerator and a denominator in the same unit. Emails sent
 * over people who replied is not a rate, it is two facts divided by each other:
 * a rep who sends five follow-ups to one person would score 20% for a
 * conversation that actually worked.
 *
 * So: of the PEOPLE we emailed, how many wrote back. `emailed`, `replied` and
 * `bounced` are all counts of leads, and the screen says "people emailed" rather
 * than "emails sent" so the number cannot be misread. The count of emails is
 * carried separately, in `logged.email`, labelled as what it is.
 *
 * This is also what makes the owner's table possible at all. Threads are keyed
 * on a mailbox, and `admin_gmail_accounts` is readable only by the person who
 * connected it (0001) — so nothing in the browser can say which mailbox belongs
 * to which rep. The lead columns can, because a lead has an owner.
 *
 * ============================================================
 * A BOUNCE COMES OUT OF THE DENOMINATOR
 * ============================================================
 * An address that does not exist was never given the chance to answer. Leaving
 * bounces in makes a clean list look like a bad one, and this is the number a
 * rep would be judged on.
 *
 * ============================================================
 * NULL IS NOT ZERO, ANYWHERE IN HERE
 * ============================================================
 * A read that failed comes in as null and goes out as null, with its name in
 * `unreadable`. "Nobody replied" and "we could not read the replies" are
 * opposite answers to the same question. `replyRate` is null when there is
 * nothing to divide by — 0% over nobody is a claim about nobody.
 */

import { isOpenStage, claimState, reasonLabel, ROE } from "./sales-rules.js";

/** The window every tile on the Overview covers, unless a caller says otherwise.
 *  30 days because that is the shortest window a cold-outreach reply rate means
 *  anything over, and it sits inside the 90 days getSalesBoard actually reads. */
export const OUTREACH_WINDOW_DAYS = 30;

const DAY_MS = 86400000;

/** A timestamp inside the window, or false.
 *
 *  PARSED, NOT COMPARED AS TEXT. The first version compared the two ISO strings
 *  and said in a comment that this was safe. It is not: the same instant can be
 *  written `2026-07-28T15:00:00.000Z` or `2026-07-28T15:00:00+00:00`, and `+`
 *  (0x2B) sorts before `.` (0x2E), so a row exactly on the window's edge was
 *  silently dropped. PostgREST returns the offset form and `sinceIso` comes from
 *  toISOString(), so a mixed pair is the ordinary case rather than an odd one.
 *  lib/lead-tags.js was fixed for exactly this on the same day and this file was
 *  not. Found by two adversarial reviews, Aug 27 2026.
 *
 *  A BARE `YYYY-MM-DD` IS STILL WRONG HERE, and nothing feeds one in: every
 *  column this reads is a `timestamptz`. Date.parse on a bare date is midnight
 *  UTC, which is the evening BEFORE in Chicago — the trap that has cost this repo
 *  three shipped bugs.
 *
 *  An unreadable date is NOT in the window. It is not a zero and it is not
 *  "today": it is a value nobody can place, and counting it would put a made-up
 *  row into a measured number. */
function inWindow(iso, sinceMs) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= sinceMs;
}

function msOf(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Round to one place, or null. Never `Math.round(x)` on a rate — 0.4 replies
 *  per person rounds to 0, which reads as "nobody replies". */
function oneDp(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/**
 * Everything the Overview tiles and the owner's rep-numbers row need, for ONE
 * person, counted from rows somebody else already read.
 *
 * `leads`, `activity` and `proposals` are arrays, or null when that read failed.
 * `userId` is required: with a falsy id the lead filter passes every row in the
 * system, which on a rep's page prints somebody else's book as theirs. It
 * refuses instead — same rule as buildRepOverview in src/lib/repBrief.js.
 */
export function outreachFor({
  leads = null, activity = null, proposals = null,
  userId = null, nowMs = Date.now(), windowDays = OUTREACH_WINDOW_DAYS,
} = {}) {
  const days = Number.isFinite(Number(windowDays)) && Number(windowDays) > 0
    ? Math.floor(Number(windowDays))
    : OUTREACH_WINDOW_DAYS;
  const nowIso = new Date(nowMs).toISOString();
  const sinceMs = nowMs - days * DAY_MS;
  const sinceIso = new Date(sinceMs).toISOString();
  const window = { days, sinceIso, nowIso };

  if (!userId) {
    return {
      knowsWho: false,
      window,
      unreadable: ["who this is about"],
      emailed: null, replied: null, bounced: null, replyBase: null,
      replyRate: null, bouncedAmongEmailed: null, avgReplyDays: null, avgReplySample: 0,
      logged: { email: null, call: null, text: null, linkedin: null },
      holding: null, claimsExpiring: null, quiet: null, neverTouched: null,
      stages: null, proposalsOut: null, proposalCents: null,
      won: null, lost: null, wonReasons: null, lostReasons: null,
    };
  }

  const unreadable = [];
  const haveLeads = Array.isArray(leads);
  const haveActivity = Array.isArray(activity);
  const haveProposals = Array.isArray(proposals);
  if (!haveLeads) unreadable.push("your leads");
  if (!haveActivity) unreadable.push("what was logged");
  if (!haveProposals) unreadable.push("your proposals");

  /* MINE means the owner_id on the row equals this person. A lead with no owner
   * is on the floor and belongs to nobody — a third state, never folded in. */
  const mine = haveLeads ? leads.filter((l) => l.owner_id && l.owner_id === userId) : null;
  const open = mine ? mine.filter((l) => isOpenStage(l.stage)) : null;

  /* ---- the funnel, per person, inside the window ---- */
  const emailedRows = mine ? mine.filter((l) => inWindow(l.first_email_at, sinceMs)) : null;
  const bouncedRows = mine ? mine.filter((l) => inWindow(l.bounced_at, sinceMs)) : null;
  /* A REPLY IS ONLY A REPLY TO SOMETHING WE SENT, AND ONLY IF WE SENT IT INSIDE
   * THE SAME WINDOW.
   *
   * The first version counted any lead whose `first_reply_at` fell in the window,
   * with no reference to `emailed` at all. So two people emailed 40 days ago who
   * answered this week, plus one emailed inside the window, produced
   * `emailed 1, replied 3, reply rate 300%` — and the screen printed "3 of 1
   * people who could answer". This file's own header says the whole point is that
   * a rate needs a numerator and a denominator in the same unit; it had neither
   * the same unit nor the same set. Found by an adversarial review, Aug 27 2026.
   *
   * A reply dated BEFORE its own send is dropped too. It means the two columns
   * were written out of order by something, and a reply that arrived before the
   * email is not a measurement of anything. */
  const repliedRows = emailedRows
    ? emailedRows.filter((l) => {
      if (!inWindow(l.first_reply_at, sinceMs)) return false;
      const sent = Date.parse(l.first_email_at);
      const back = Date.parse(l.first_reply_at);
      return Number.isFinite(sent) && Number.isFinite(back) && back >= sent;
    })
    : null;

  /* The denominator is the people we emailed MINUS the ones whose address was
   * dead. Counted from the emailed set rather than from the bounced set, so a
   * bounce on a lead we emailed before the window cannot pull the denominator
   * below the number of people we actually emailed inside it. */
  /* IN-WINDOW BOUNCES AMONG THE PEOPLE EMAILED IN THE WINDOW. Both halves of that
   * sentence matter, and one was missing: this counted ANY bounce on an emailed
   * lead, whenever it happened, while the `bounced` tile counts bounces inside the
   * window over every lead. Two different sets, printed side by side as if one
   * came out of the other — "0 of 2 people who could answer; 1 address bounced and
   * came out of that bottom half" over a denominator of 2. Found by the third
   * review, Aug 27 2026. */
  const bouncedAmongEmailed = emailedRows
    ? emailedRows.filter((l) => inWindow(l.bounced_at, sinceMs)).length
    : null;
  const replyBase = emailedRows ? Math.max(0, emailedRows.length - bouncedAmongEmailed) : null;
  const replied = repliedRows ? repliedRows.length : null;
  const replyRate = (replyBase && replied !== null) ? oneDp((replied / replyBase) * 100) : null;

  /* Time to first reply, in days, over the leads where BOTH ends are on record
   * and the reply is not before the send. A negative gap means the two columns
   * were written out of order by something, and a negative average is worse than
   * no average — so those rows are dropped and the sample size says so. */
  const gaps = [];
  for (const l of repliedRows || []) {
    const a = msOf(l.first_email_at);
    const b = msOf(l.first_reply_at);
    if (a === null || b === null || b < a) continue;
    gaps.push((b - a) / DAY_MS);
  }
  const avgReplyDays = gaps.length ? oneDp(gaps.reduce((x, y) => x + y, 0) / gaps.length) : null;

  /* ---- what was logged, by this person, inside the window ---- */
  const acts = haveActivity
    ? activity.filter((a) => a.actor === userId && inWindow(a.created_at, sinceMs))
    : null;
  const countType = (t) => (acts ? acts.filter((a) => a.type === t).length : null);
  const logged = {
    email: countType("email"),
    call: countType("call"),
    text: countType("text"),
    linkedin: countType("linkedin"),
  };

  /* ---- the book right now. NOT windowed, and the screen says so: "how many
   * leads you hold" is a fact about this moment, not about the last 30 days. */
  const states = open ? open.map((l) => claimState(l, nowIso).state) : null;
  const countState = (names) => (states ? states.filter((s) => names.includes(s)).length : null);
  const holding = open ? open.length : null;
  const claimsExpiring = countState(["first_contact_due", "claim_expired"]);
  const quiet = countState(["going_cold", "cold"]);
  const neverTouched = open ? open.filter((l) => !l.first_contact_at).length : null;

  /* ---- pipeline by stage, open only, in the ladder's own order ---- */
  /* A stage missing from this list is not drawn at all — not blank, absent — so
   * both halves of the Meeting split have to be here (migration 0030). */
  const STAGE_ORDER = [
    "new", "researching", "contacted", "in_conversation", "follow_up",
    "meeting_booked", "meeting_complete", "proposal",
    /* `reopened` and the pre-0030 `meeting` were BOTH missing, so the rows
     * holding them were counted in the header and drawn in none of the rungs —
     * the breakdown did not add up to its own total. Found by a checker on
     * 2 Sep 2026, after the comment above was written saying exactly this. */
    "reopened", "meeting",
  ];
  const stages = open
    ? STAGE_ORDER.map((stage) => ({ stage, count: open.filter((l) => l.stage === stage).length }))
    : null;

  /* ---- proposals: this person's leads, sent and not yet decided ---- */
  const myIds = mine ? new Set(mine.map((l) => l.id)) : null;
  const outProposals = (haveProposals && myIds)
    ? proposals.filter((p) => p.lead_id && myIds.has(p.lead_id) && ["sent", "viewed"].includes(p.status))
    : null;
  const proposalsOut = outProposals ? outProposals.length : null;
  /* Cents, and null when NONE of them carries an amount — a total of $0 over
   * three proposals nobody priced is a number somebody would quote. */
  /* `Number(null)` is 0 and `Number.isFinite(0)` is true, so the obvious version
   * counted an UNPRICED proposal as priced and added zero to the total —
   * producing exactly the "$0 over three proposals nobody priced" that the note
   * above says must never happen. Supabase returns null for an empty
   * amount_cents, so this was the ordinary case rather than an edge one. It only
   * missed when the key was absent entirely, which is why the preview store
   * never caught it. Found by tests/outreach-stats, Aug 27 2026.
   *
   * A proposal deliberately priced at 0 IS priced and still counts — that is why
   * the check is "is there a number here", not "is the number truthy". */
  const isPriced = (p) => p?.amount_cents !== null && p?.amount_cents !== undefined
    && p.amount_cents !== "" && Number.isFinite(Number(p.amount_cents));
  const priced = outProposals ? outProposals.filter(isPriced) : null;
  const proposalCents = (priced && priced.length)
    ? priced.reduce((a, p) => a + Number(p.amount_cents), 0)
    : null;

  /* ---- won and lost inside the window, with the reasons grouped ----
   * Dated from `closed_at`, which markLeadWon and markLeadLost both stamp. A
   * lead at stage won with no closed_at is counted in `undated` and said out
   * loud rather than folded into this month. */
  const closedIn = (stage) => (mine
    ? mine.filter((l) => l.stage === stage && inWindow(l.closed_at, sinceMs))
    : null);
  const wonRows = closedIn("won");
  const lostRows = closedIn("lost");
  const undatedClosed = mine
    ? mine.filter((l) => ["won", "lost"].includes(l.stage) && !l.closed_at).length
    : null;

  const group = (rows, key) => {
    if (!rows) return null;
    const counts = new Map();
    for (const l of rows) {
      const code = l[key] || null;
      counts.set(code, (counts.get(code) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([code, count]) => ({
        code,
        /* A close with no reason on it is real — every row that closed before
         * the reason box existed is one — and it prints as what it is rather
         * than being dropped, which would make the breakdown add up to less
         * than the total above it. */
        label: code ? reasonLabel(code) : "No reason recorded",
        count,
      }))
      .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
  };

  return {
    knowsWho: true,
    window,
    unreadable,

    emailed: emailedRows ? emailedRows.length : null,
    replied,
    bounced: bouncedRows ? bouncedRows.length : null,
    replyBase,
    replyRate,
    /* EXPOSED, because a screen that says a number "came out of the bottom half"
     * has to be able to print THAT number rather than the wider bounce count. */
    bouncedAmongEmailed,
    avgReplyDays,
    avgReplySample: gaps.length,

    logged,

    holding,
    claimsExpiring,
    quiet,
    neverTouched,
    coldAfterDays: ROE.COLD_REOPEN_DAYS,

    stages,

    proposalsOut,
    proposalCents,
    proposalsPriced: priced ? priced.length : null,

    won: wonRows ? wonRows.length : null,
    lost: lostRows ? lostRows.length : null,
    wonReasons: group(wonRows, "won_reason"),
    lostReasons: group(lostRows, "lost_reason"),
    closedWithNoDate: undatedClosed,
  };
}

/**
 * The same numbers for every active rep, side by side, for the owner's table.
 *
 * It calls outreachFor once per person with the SAME rows, so a cell here and a
 * tile on that rep's own Overview are the same arithmetic on the same snapshot.
 * There is no second query and no stored total anywhere in this file.
 */
export function outreachByRep({
  team = [], leads = null, activity = null, proposals = null,
  nowMs = Date.now(), windowDays = OUTREACH_WINDOW_DAYS,
} = {}) {
  return (team || [])
    .filter((t) => t && t.user_id && t.active !== false)
    .map((t) => ({
      member: t,
      stats: outreachFor({ leads, activity, proposals, userId: t.user_id, nowMs, windowDays }),
    }));
}

/**
 * Where deals die, across everybody — the owner's version.
 *
 * Not `outreachByRep` summed: a loss with no owner on the row would be missed by
 * a per-rep sum, and a lead released after it was lost has exactly that shape.
 * Counted over every lead instead, which is also what makes the total match the
 * number above it.
 */
export function lossReasons({ leads = null, nowMs = Date.now(), windowDays = OUTREACH_WINDOW_DAYS } = {}) {
  const days = Number.isFinite(Number(windowDays)) && Number(windowDays) > 0
    ? Math.floor(Number(windowDays))
    : OUTREACH_WINDOW_DAYS;
  const sinceMs = nowMs - days * DAY_MS;
  const sinceIso = new Date(sinceMs).toISOString();
  if (!Array.isArray(leads)) {
    return { window: { days, sinceIso }, rows: null, total: null, noReason: null, undated: null };
  }
  const lost = leads.filter((l) => l.stage === "lost" && inWindow(l.closed_at, sinceMs));
  const counts = new Map();
  for (const l of lost) {
    const code = l.lost_reason || null;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const rows = [...counts.entries()]
    .map(([code, count]) => ({ code, label: code ? reasonLabel(code) : "No reason recorded", count }))
    .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
  return {
    window: { days, sinceIso },
    rows,
    total: lost.length,
    noReason: lost.filter((l) => !l.lost_reason).length,
    /* Losses that never got a date. They are NOT in `total` above, and the
     * screen says how many were left out — a breakdown quietly missing rows is
     * the thing this whole feature exists to stop. */
    undated: leads.filter((l) => l.stage === "lost" && !l.closed_at).length,
  };
}
