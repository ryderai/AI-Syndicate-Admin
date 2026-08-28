/* The rep's Work-page answer box — the pure half.
 *
 * Aug 26 2026. CJ is about to give the sales reps their own logins, so each rep
 * gets a box on their Work page: they type what they want ("give me a rundown of
 * my week", "which of my leads is about to go cold and what do I say") and the
 * AI answers it. This file is everything that decision needs and no database, no
 * network and no React, so it can be tested on its own.
 *
 * IT IS THE REP-SCOPED SIBLING OF lib/console-report.js, on purpose, and it
 * borrows that file's checkers rather than growing its own. Two copies of an
 * honesty rule is one copy that quietly stops matching — the same reason
 * console-report.js borrows from client-report.js instead of re-implementing.
 *
 * WHY A SEPARATE FILE AND A SEPARATE TABLE AT ALL.
 * /api/console-report is closed to reps (`requireMember(req, ["owner","admin"])`)
 * and its comment says why: one of those rows can summarise every client, lead
 * and invoice in one place. The rows were written FROM AN OWNER-SCOPED SNAPSHOT,
 * so a rep who could read one would walk straight around the role scoping in
 * lib/brain-context.js. Opening that endpoint to reps would undo the scoping;
 * writing a rep-scoped one next to it does not. A rep never reads
 * admin_console_reports.
 *
 * WHAT A REP MAY SEE is decided in ONE place — SCOPE_BY_ROLE in
 * lib/brain-context.js — and it is: leads, lead activity, lead sources, THEIR
 * OWN follow-ups, the team roster, the firms, the lists and the proposals. No
 * clients, no email, no tickets, no money, no Brain. Nothing outside that list
 * is even fetched, and a row that is never read cannot leak.
 *
 * THE VAULT IS NEVER IN SCOPE. loadSystemContext has no vault read in it at all
 * — not gated, absent — so no label, username or secret can reach a saved rep
 * answer that gets forwarded. Checked Aug 26 2026 against lib/brain-context.js.
 *
 * A REP'S OWN FOLLOW-UPS ONLY. loadSystemContext already filters
 * admin_reminders by owner_id when the role is sales (an adversarial review
 * added that on Aug 20 2026, after a rep's context block was found carrying
 * every owner's follow-up text). assembleRepFacts filters again on the way out,
 * for the same reason renderContext does: the load-time query decides what is
 * FETCHED, this decides what is COUNTED, and a caller who hands over a fuller
 * snapshot — a test, a reused cached object, a future endpoint — still cannot
 * spill one person's follow-ups into another person's answer.
 */

import {
  parseConsoleReport, checkConsoleReport, tokensForWords,
} from "./console-report.js";
import { withoutQuotes } from "./client-report.js";
import { relDays, renderContext } from "./brain-context.js";
import { isOpenStage, claimState, ROE } from "./sales-rules.js";
/* The same function the rep's own Overview tile calls. Not a second count: a fact
 * sheet that disagreed with the number printed six inches above the box would be
 * worse than one that said nothing at all. */
import { outreachFor } from "./outreach.js";

/* Re-exported so the endpoint asks this file for everything and never has to
 * reach past it into the owner-facing one. */
export { tokensForWords };

/** Longest question we will send. Shorter than the Overview's 1,500 because
 * this is a question typed between calls, not a request for a whole document —
 * and the cap is what stops somebody pasting a lead list into the box and
 * having it read back as if it were a record we hold. */
export const MAX_INSTRUCTION_CHARS = 700;

/** Trimmed and capped, the one way. The endpoint and the tests both call this
 * so neither can cap it differently from the other. */
export function cleanInstruction(v) {
  return String(v ?? "").trim().slice(0, MAX_INSTRUCTION_CHARS);
}

/** Words to aim for, read from what the person typed rather than from a button,
 * because there are no buttons here — the box is the whole interface. */
export function wordsForRep(instruction) {
  const typed = String(instruction || "").toLowerCase();
  if (/\b(one|1)\s+(paragraph|line)\b|\bvery short\b|\bone-liner\b/.test(typed)) return 120;
  if (/\bshort\b|\bbrief\b|\bquick\b/.test(typed)) return 200;
  if (/\blong\b|\bdetailed\b|\bin full\b|\beverything\b|\bdeep\b/.test(typed)) return 900;
  return 400;
}

/* ------------------------------------------------------------------ */
/* The counted facts                                                   */
/*                                                                     */
/* The fact SHEET the AI reads is renderContext(snap) — already         */
/* prompt-shaped, already role-gated. This is the numeric companion:    */
/* the figures the counted fallback needs and the ones saved on the row */
/* so an answer can be audited against them months later.              */
/* ------------------------------------------------------------------ */

/* How a lead is named, in one place. The counted version and the fact sheet
 * both print it, and a rep who reads two different names for one firm cannot
 * tell whether they are two firms. */
function leadLabel(l) {
  return l?.name && l?.company ? `${l.name} (${l.company})`
    : l?.name || l?.company || "an unnamed lead";
}

export function assembleRepFacts(snap, { nowMs = Date.now() } = {}) {
  const rows = (k) => (Array.isArray(snap?.[k]) ? snap[k] : []);
  const me = snap?.userId || null;
  const nowIso = new Date(nowMs).toISOString();

  const allLeads = rows("leads");
  const openLeads = allLeads.filter((l) => isOpenStage(l.stage));
  /* "Mine" means the owner_id on the row equals the person asking. A lead with
   * no owner is on the floor and belongs to nobody, which is a third state and
   * counted separately — a rep who reads "12 leads" and finds 4 of them are
   * somebody else's stops trusting the number. */
  const mine = openLeads.filter((l) => l.owner_id && l.owner_id === me);
  const floor = openLeads.filter((l) => !l.owner_id);

  /* claimState is the same function the Sales page draws the cards with, so
   * "going cold" here and "going cold" on the page can never drift apart. */
  const states = mine.map((l) => ({ lead: l, at: claimState(l, nowIso) }));
  const inState = (name) => states.filter((x) => x.at.state === name);

  const label = leadLabel;

  /* A rep's own follow-ups and nobody else's — the second gate described at the
   * top of this file.
   *
   * NO ID MEANS NOTHING, NEVER EVERYTHING. Aug 26 2026: this read `!me ||
   * r.owner_id === me`, so a snapshot with no userId on it matched every row
   * and handed back one person's follow-up text — including one marked private
   * — inside another person's answer. That is the exact leak the header comment
   * says this filter exists to stop, inverted by the fallback. requireMember
   * gives the endpoint a real id today, so nothing shipped; the filter still
   * has to be right, because the reason it is here is the caller who hands over
   * a fuller snapshot than the role allows. */
  const myReminders = me ? rows("reminders").filter((r) => r.owner_id === me) : [];

  const companies = rows("companies");
  const scored = companies.filter((c) => c.site_score !== null && c.site_score !== undefined);

  const counts = {
    /* The two rules, carried as numbers so the counted version can say "past
     * the 14-day line" without stating a figure nothing backs. */
    coldAfterDays: ROE.COLD_REOPEN_DAYS,
    firstContactBusinessDays: ROE.FIRST_CONTACT_BUSINESS_DAYS,

    /* One count per state claimState can return, so the totals add up to
     * myLeadsOpen. A set of counts that quietly loses two states is worse than
     * no counts: a rep adds them up, comes out short, and stops trusting the
     * page. */
    myLeadsOpen: mine.length,
    myLeadsWorking: inState("working").length,
    myLeadsAwaitingFirstContact: inState("first_contact").length + inState("first_contact_due").length,
    myLeadsFirstContactDueSoon: inState("first_contact_due").length,
    myLeadsGoingCold: inState("going_cold").length,
    myLeadsCold: inState("cold").length,
    myLeadsClaimExpired: inState("claim_expired").length,
    myLeadsNeverContacted: mine.filter((l) => !l.claim_contacted_at).length,
    leadsOnTheFloor: floor.length,

    /* Won and lost among the rows read, MINE only. The snapshot's lead read is
     * capped, so this is "in the rows read" and the counted version says so
     * rather than presenting it as a career total. */
    myWonInRowsRead: allLeads.filter((l) => l.stage === "won" && l.owner_id === me).length,
    myLostInRowsRead: allLeads.filter((l) => l.stage === "lost" && l.owner_id === me).length,

    /* The activity read only goes back three weeks (CAPS.leadActivity in
     * brain-context.js), so the window is carried as a number rather than
     * written into a sentence — a rep must not read this as a career total. */
    activityWindowDays: 21,
    myTouchesInWindow: rows("leadActivity").filter((a) => a.actor === me).length,
    myFollowUpsOpen: myReminders.length,

    firms: companies.length,
    firmsScored: scored.length,
    firmsAtOrAboveSkipScore: scored.filter((c) => Number(c.site_score) >= ROE.SKIP_SCORE_AT_OR_ABOVE).length,
    skipScoreAtOrAbove: ROE.SKIP_SCORE_AT_OR_ABOVE,
    lists: rows("leadLists").length,
    proposalsOpen: rows("proposals").filter((p) => !p.decided_at).length,
  };

  /* Named rows, not just totals. "3 going cold" is the input; "Summit Roofing,
   * 2 days left" is the thing a rep can act on. Every name here is also in the
   * fact sheet, so the strict number check still passes over the counted
   * version. */
  const highlights = {
    goingCold: inState("going_cold").slice(0, 8)
      .map((x) => ({ lead: label(x.lead), why: x.at.why })),
    cold: inState("cold").slice(0, 8)
      .map((x) => ({ lead: label(x.lead), why: x.at.why })),
    claimExpired: inState("claim_expired").slice(0, 8)
      .map((x) => ({ lead: label(x.lead), why: x.at.why })),
    firstContactDue: inState("first_contact_due").slice(0, 8)
      .map((x) => ({ lead: label(x.lead), why: x.at.why })),
    neverContacted: mine.filter((l) => !l.claim_contacted_at).slice(0, 8).map(label),
    onTheFloor: floor.slice(0, 8).map(label),
    myFollowUps: myReminders.slice(0, 8)
      .map((r) => ({ what: String(r.body || "").slice(0, 120), due: relDays(r.due_at, nowMs) })),
  };

  const unreadable = Object.keys(snap?.errors || {});

  return {
    takenAt: snap?.generatedAt || new Date(nowMs).toISOString(),
    role: snap?.role || null,
    counts,
    highlights,
    /* Named, never implied. A section that could not be read must not be
     * summarised as empty — "no leads going cold" and "I could not read the
     * leads" are opposite answers to the same question. */
    unreadable,
    cannotAnswer: [
      "Money. Invoices, payments and what anything cost are not in a rep's records at all, so nothing here can say what a deal is worth beyond the amount written on a proposal.",
      "Our paying clients. Their work, their weekly logs and their reports are not in a rep's records — a firm marked ALREADY A CLIENT is the only trace of one.",
      "Anybody else's follow-ups. Only your own are in here.",
      "Anything from the AI Syndicate platform. There are no scan results and no citation history in here — the only platform number anywhere is the 0-100 website score on a firm, and only where one has been run.",
      "Anything nobody wrote down. A call that was never logged did not happen as far as these rows go.",
    "The three scan scores on a firm — AI Access, ordinary search, and how often an AI names them. Only the single 0-100 website score is in these records.",
    "The tags on a lead. None of them are in here.",
      ...(unreadable.length
        ? [`These reads failed and are UNKNOWN, not empty: ${unreadable.join(", ")}.`]
        : []),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* The fact sheet                                                      */
/* ------------------------------------------------------------------ */

/**
 * The two house rules that decide most of a rep's day, as text.
 *
 * WHY THIS EXISTS AT ALL. The gate only lets through a number that appears in
 * the fact sheet, and renderContext prints leads and firms — it does not print
 * the rules those leads are judged by. So an honest sentence like "quiet for
 * eleven days, and a firm drops back to the floor at fourteen" was being thrown
 * away for inventing the number fourteen, which is written in
 * lib/sales-rules.js and is as real a fact as any row.
 *
 * These three numbers are now in the pool, which does mean 14, 3 and 90 are
 * allowed anywhere in an answer. That is the same trade the client report makes
 * with its preset labels, and it is worth it: the alternative is a checker that
 * refuses the most useful sentence a rep can be told.
 */
export function renderRepRules() {
  return `# THE HOUSE RULES THESE ROWS ARE JUDGED BY
- A claim drops if no first contact is logged inside ${ROE.FIRST_CONTACT_BUSINESS_DAYS} business days.
- A firm with no update for ${ROE.COLD_REOPEN_DAYS} calendar days reopens to the floor.
- A website score of ${ROE.SKIP_SCORE_AT_OR_ABOVE} or above means the firm is not a prospect.
- One text message per lead, and only after a tracked open.`;
}

/* The state names, in words a rep would use. Every key here is a state
 * claimState can return for a lead somebody holds; the two it returns for a
 * lead nobody holds or nobody is chasing (unclaimed, closed) cannot appear
 * below, because only this rep's OPEN leads are printed. */
const CLAIM_STATE_WORDS = {
  first_contact: "claimed, first contact not logged yet",
  first_contact_due: "first contact due now or the claim drops",
  claim_expired: "the claim has already run out",
  working: "being worked",
  going_cold: "going quiet",
  cold: "past the reopen line",
};

const plural = (n, word) => `${n} ${word}${Math.abs(n) === 1 ? "" : "s"}`;

/**
 * Where each of this rep's own leads stands on the claim clock, as text.
 *
 * WHY THIS EXISTS. Aug 26 2026. renderContext prints a lead's stage, owner,
 * last touch, city, source and note, and says NOTHING about the claim — not
 * when it was made, not how much of the first-contact window is gone, not how
 * many days are left. So the box shipped with a preset asking "which of my
 * leads is about to lose its claim" over records that did not state it, and the
 * most useful true sentence a rep can be handed — "Summit Roofing was claimed 2
 * business days ago with no first contact logged; the claim drops after 3" —
 * was thrown away by the gate for inventing the number 2. It was not invented.
 * It was computed and then never shown to anybody.
 *
 * The gate checks the draft against THIS SAME STRING, so putting the days used
 * and the days left in here is what makes that sentence writable at all.
 *
 * Every state and every threshold comes from claimState and ROE, never from
 * arithmetic of our own: `over` is how many days PAST the line a lead is, so
 * days left is `-over` and days used is the rule minus what is left. One
 * function decides this on the Sales page, in the counts above and in this
 * block, which is why the page and the answer cannot say different things about
 * the same firm.
 *
 * The claimState `why` string is deliberately NOT reprinted here. It words the
 * same day count differently per state, and two phrasings of one number in one
 * line is how a reader ends up thinking there are two numbers.
 *
 * REP SCOPE, LIKE EVERYTHING ELSE IN THIS FILE: this rep's own open leads and
 * nobody else's. It is about leads, not people — no line here says who did or
 * did not do anything.
 */
export function renderRepClaims(snap, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const me = snap?.userId || null;
  const leads = Array.isArray(snap?.leads) ? snap.leads : [];
  const mine = me ? leads.filter((l) => isOpenStage(l.stage) && l.owner_id === me) : [];

  const lines = [];
  for (const lead of mine) {
    const at = claimState(lead, nowIso);
    const words = CLAIM_STATE_WORDS[at.state] || at.state;
    let detail;
    if (at.over === null) {
      /* A claim with no readable date cannot be timed, and claimState says so
       * rather than guessing. Repeat that here instead of printing a number. */
      detail = "The claim date could not be read, so nothing here can say how long it has been held.";
    } else if (at.state === "first_contact" || at.state === "first_contact_due" || at.state === "claim_expired") {
      const left = -at.over;
      const used = ROE.FIRST_CONTACT_BUSINESS_DAYS - left;
      detail = left > 0
        ? `Claimed ${plural(used, "business day")} ago with no first contact logged. ${plural(left, "business day")} left, because the claim drops after ${ROE.FIRST_CONTACT_BUSINESS_DAYS}.`
        : `Claimed ${plural(used, "business day")} ago with no first contact logged, which is past the ${ROE.FIRST_CONTACT_BUSINESS_DAYS}-business-day line by ${plural(at.over, "day")}. The overnight sweep will hand it back.`;
    } else {
      const left = -at.over;
      const quiet = ROE.COLD_REOPEN_DAYS - left;
      detail = left > 0
        ? `First contact is logged. ${plural(quiet, "day")} with no update, ${plural(left, "day")} left, because a firm reopens to the floor after ${ROE.COLD_REOPEN_DAYS}.`
        : `First contact is logged, but ${plural(quiet, "day")} with no update, which is past the ${ROE.COLD_REOPEN_DAYS}-day line by ${plural(at.over, "day")}. This reopens to the floor.`;
    }
    lines.push(`- ${leadLabel(lead)} — ${words}. ${detail}`);
  }

  const head = "## WHERE YOUR OWN CLAIMS STAND (the clock in the house rules above, per lead)";
  if (!lines.length) {
    return `${head}\nnone — no open lead in these rows is claimed by the person asking.`;
  }
  /* Capped like every other block in the fact sheet, and it says when it was
   * cut. A list that quietly stops is read as the whole list. */
  const CAP = 60;
  const tail = lines.length > CAP
    ? `\n(AT LEAST ${lines.length - CAP} more of your claims were not shown. Say so rather than answering as if this were all of them.)`
    : "";
  return `${head}\n${lines.slice(0, CAP).join("\n")}${tail}`;
}

/**
 * The whole fact sheet the AI reads — and the exact same string the gate checks
 * the draft against. One function so those two can never drift: a number the
 * model was shown but the checker was not would get an honest answer thrown
 * away, and a number the checker was shown but the model was not is a number
 * nobody can use.
 */
/**
 * THE REP'S OWN AI RULES, RENDERED — and they go into the fact sheet, not only
 * into the instruction. Aug 27 2026, migration 0022.
 *
 * WHY THEY HAVE TO BE IN THE FACT SHEET. The gate checks a draft against THIS
 * STRING: any number in the answer that is not in here throws the whole answer
 * away. So a rule the model was shown but the checker was not is a rule that
 * silently kills honest answers — the exact failure this file's own comment on
 * renderRepClaims describes, where a true sentence was thrown away for
 * "inventing" a number that had been computed and never shown to anybody. One
 * function builds the string the model reads and the string the gate reads,
 * which is the only shape where those two cannot drift.
 *
 * AND THE CONSEQUENCE, STATED: whatever is in these rows enters the pool the
 * gate checks against. That is exactly why a personal rule may not contain a
 * number — checkPersonalRule in lib/sales-rules.js refuses any digit at the
 * moment of saving. If that check is ever loosened, this is the line that turns
 * one rep's typo into a figure the AI is allowed to write to a prospect.
 *
 * They are printed as WORDING, under a heading that says so, so the model cannot
 * read them as records. And the block says the house rules win, which is the
 * same shape the feedback loop uses (§32/§33: correction above, constraint below,
 * and the constraint saying it wins).
 */
export function renderPersonalRules(rows) {
  const lines = (rows || [])
    .filter((r) => r && r.enabled !== false && String(r.body || "").trim())
    .map((r) => {
      const head = r.setting_key ? String(r.setting_key).replace(/_/g, " ") : (r.title || r.kind || "rule");
      return `- ${head}: ${String(r.body).trim()}`;
    });
  const head = "## HOW THIS PERSON WRITES (their own settings — wording only, never facts)";
  if (!lines.length) {
    return `${head}\nnone set. Use the house rules above.`;
  }
  return `${head}\n${lines.join("\n")}\n(These change HOW an answer is written, never what is true. Every rule above them wins. They carry no facts and no numbers.)`;
}

/**
 * THE REP'S OWN OUTREACH NUMBERS, IN THE FACT SHEET.
 *
 * WHY THIS HAD TO EXIST. The gate checks a draft against this string and throws
 * away any answer containing a number that is not in it. renderContext prints
 * leads, firms and activity — it prints nothing about who was emailed, who wrote
 * back, or how long they took. So a rep could read "Reply rate 12.8%" on a tile,
 * type "why is my reply rate low?" into the box six inches above it, and get the
 * counted fallback — because every honest sentence the model could write about
 * that number was killed for inventing it. The number was on the same screen.
 *
 * It is the same failure renderRepClaims was written to fix, one feature later:
 * a figure that is computed, shown to a person, and never shown to the checker.
 *
 * THE SAME FUNCTION AS THE TILE, ON DIFFERENT ROWS — and that difference has to
 * be said, because the first version of this comment claimed the two "cannot
 * disagree" and that is false.
 *
 * The arithmetic is identical: outreachFor() in lib/outreach.js, one function, no
 * second count. What differs is what it is handed. The tile reads getFloorBoard(),
 * which loads the newest 2,000 leads and 90 days of activity. This reads
 * loadSystemContext(), which caps leads at CAPS.leads, EXCLUDES closed leads from
 * its main query with only a small recently-updated backstop, and reads
 * CAPS.leadActivity rows of activity over 21 days — company-wide, not per person.
 * So on a busy floor the counts here can be lower than the tile's, and the won and
 * lost figures in particular are counted over a set that deliberately leaves most
 * closed leads out.
 *
 * That is why the block below prints the caps and says the numbers are counted
 * over what was read. A number the model is told is a fact has to carry the shape
 * of the read behind it, or the model states it as the whole truth — which is the
 * failure this whole file is built around.
 *
 * EVERY NUMBER CARRIES ITS WINDOW, and a null prints as "not measured" rather
 * than as a zero. "Nobody replied" and "we have not measured" are opposite
 * answers, and the whole point of putting this in the pool is that the model can
 * then say which.
 */
export function renderRepOutreach(snap, nowMs = Date.now()) {
  const me = snap?.userId || null;
  const head = "## YOUR OWN OUTREACH, COUNTED";
  if (!me) {
    return `${head}\nnone — these records do not say who is asking, so nothing about one person's outreach can be counted.`;
  }
  /* A FAILED READ COMES THROUGH AS AN EMPTY ARRAY, NOT AS NULL, so this has to
   * ask `snap.errors` rather than looking at the arrays.
   *
   * readTable() in lib/brain-context.js turns every failure into `rows: []` and
   * records the reason in `snap.errors`. `Array.isArray([])` is true, so the whole
   * null-is-not-zero path in lib/outreach.js was unreachable from here and a
   * totally failed read printed a confident block of zeros under a heading saying
   * COUNTED. Found by the third review, Aug 27 2026. */
  const failed = Object.keys(snap?.errors || {});
  const readFailed = (key) => failed.includes(key);
  const o = outreachFor({
    leads: (Array.isArray(snap?.leads) && !readFailed("leads")) ? snap.leads : null,
    activity: (Array.isArray(snap?.leadActivity) && !readFailed("leadActivity")) ? snap.leadActivity : null,
    proposals: (Array.isArray(snap?.proposals) && !readFailed("proposals")) ? snap.proposals : null,
    userId: me,
    nowMs,
  });
  const n = (v, unit = "") => (v === null || v === undefined ? "not measured" : `${v}${unit}`);
  const lines = [
    `- Window: the last ${o.window.days} days, counted from the rows loaded on ${o.window.nowIso.slice(0, 10)}.`,
    `- People you emailed in that window: ${n(o.emailed)}. Of those, ${n(o.replied)} wrote back.`,
    /* THREE REASONS A RATE IS MISSING, and they are three different sentences.
     * "We could not read it", "nobody was emailed" and "everybody bounced" are not
     * the same answer, and printing one for all three is the mistake this file
     * exists to stop. */
    `- Reply rate: ${o.replyRate !== null ? `${o.replyRate}%`
      : o.emailed === null ? "not measured — the read failed, so this is unknown rather than zero"
        : o.emailed === 0 ? "not measured — nobody was emailed in this window"
          : "not measured — every address emailed in this window bounced, so nobody could answer"}`
      /* `bouncedAmongEmailed`, NOT `bounced`. They are different sets — `bounced`
       * counts every bounce in the window across all this rep's leads, and only
       * the ones among the people emailed IN the window come out of the
       * denominator. Printing the wider number next to the denominator described a
       * subtraction that had not happened, in a sentence the honesty gate then let
       * the model repeat. Found by the third review. */
      + ` (${n(o.replied)} of ${n(o.replyBase)} people who could answer; of the people emailed in this window, ${n(o.bouncedAmongEmailed)} address${o.bouncedAmongEmailed === 1 ? "" : "es"} bounced and came out of that bottom half).`,
    `- Bounces in this window across all your leads, however long ago they were emailed: ${n(o.bounced)}.`,
    `- Average days from your email to their reply: ${n(o.avgReplyDays)}`
      + (o.avgReplySample ? `, over ${o.avgReplySample} of them.` : ", over none of them — there is nothing to average."),
    `- Logged by you in the window: ${n(o.logged.email)} emails, ${n(o.logged.call)} calls, ${n(o.logged.text)} texts, ${n(o.logged.linkedin)} LinkedIn touches.`,
    `- Right now, not in the window: ${n(o.holding)} leads held, ${n(o.claimsExpiring)} claims running out, ${n(o.quiet)} gone quiet, ${n(o.neverTouched)} never touched.`,
    `- Proposals of yours out and undecided: ${n(o.proposalsOut)}`
      + (o.proposalCents !== null && o.proposalCents !== undefined
        ? `, worth $${Math.round(o.proposalCents / 100)} in total across the ${o.proposalsPriced} that carry an amount.`
        : ", and none of them carries an amount, so there is no total."),
    `- Closed in the window: ${n(o.won)} won, ${n(o.lost)} lost.`
      + (o.closedWithNoDate ? ` A further ${o.closedWithNoDate} of your closed leads have no date on the close, so they are in no window at all.` : ""),
  ];
  const reasons = [
    (o.wonReasons || []).length ? `- Why they said yes: ${o.wonReasons.map((r) => `${r.label} ${r.count}`).join(", ")}.` : null,
    (o.lostReasons || []).length ? `- Why we lost: ${o.lostReasons.map((r) => `${r.label} ${r.count}`).join(", ")}.` : null,
  ].filter(Boolean);
  const unread = (o.unreadable || []).length
    ? `\n(These could not be read and are UNKNOWN, not empty: ${o.unreadable.join(", ")}. Every number above that depends on them is missing rather than zero.)`
    : "";
  /* THE SHAPE OF THE READ, printed with the numbers it produced. The lead read
   * here leaves most CLOSED leads out by design, so the won and lost figures above
   * are not a month's total — they are what was in the rows that were loaded. Said
   * rather than left for the model to assume. */
  const caveat = "\n(Counted over the rows this snapshot loaded, not over the whole database."
    + " Closed leads are mostly left out of that read, so treat the won and lost figures as"
    + " \"in the rows read\" and say so if you use them. The rep's own Overview page reads a"
    + " wider set and may show larger numbers; neither is wrong.)";
  return `${head}\n${[...lines, ...reasons].join("\n")}${unread}${caveat}`;
}

/**
 * WHAT IS SHOWN ON THE SCREEN AND IS NOT IN THIS FACT SHEET.
 *
 * Named rather than left out. The gate refuses any number the sheet does not
 * hold, so an absent figure is not a gap the model can talk around — it is a
 * whole answer thrown away. Telling the model in words which numbers it has NOT
 * been given is what lets it say "that is not in my records" instead, which is a
 * useful answer where silence is not.
 *
 * Both of these are real gaps and both are on the Floor a rep is looking at:
 *   * the three scan scores — AI Access, ordinary search, and how often an AI
 *     names the firm — live in admin_company_reports (migration 0019), and
 *     lib/brain-context.js does not read that table for anybody yet. The one
 *     platform number in here is still admin_companies.site_score, which
 *     renderContext prints as "score N".
 *   * the tags. admin_lead_tag_events is not in any role's scope either.
 * Both are worth adding to loadSystemContext, and neither was done today rather
 * than half-done in a shared file two other sessions are editing.
 */
export function renderRepMissing() {
  return `## ON THE SCREEN, BUT NOT IN THESE RECORDS
- The three scan scores on a firm (AI Access, ordinary search, and how often an AI names them). Only the single website score is in here, printed as "score N" where one has been run. If somebody asks about the other two, say they are not in your records — do not answer from the one number that is.
- The tags on a lead. None of them are in here, so nothing above can be filtered or counted by tag.`;
}

export function repFactsText(snap, nowMs = Date.now(), personalRows = []) {
  /* The claim block sits between the rules and the rendered snapshot, because
   * it is the rules applied to this rep's own rows and it is the thing most
   * questions are actually about. The person's own wording rules sit LAST, after
   * the records, because they are the least authoritative thing in the string —
   * and the block says so in words. */
  return [
    renderRepRules(),
    renderRepClaims(snap, nowMs),
    renderRepOutreach(snap, nowMs),
    renderContext(snap, nowMs),
    renderRepMissing(),
    renderPersonalRules(personalRows),
  ].join("\n\n");
}

/* ------------------------------------------------------------------ */
/* What the AI is told                                                 */
/* ------------------------------------------------------------------ */

/* The shape. Same reasoning as the Overview's: a count is the input, not the
 * answer, and the rep can already see the tiles on the page above the box. The
 * difference is the FIRST PARAGRAPH, which is asked for as the 30-second answer
 * because the response contract carries a `summary` and the UI shows it on its
 * own. It is not a second version of the answer — see summaryFrom below. */
const SHAPE = `Write ONE answer.

Start with a single line:
TITLE: one line naming the actual finding. Not "Your week".

Then a first paragraph that is the 30-second answer — if the rep read only that, what do they most need to know. Then the rest, in whatever shape the question asks for: prose, a ranked list, an email, "## " headings.

Whatever shape it takes:
- ANSWER, do not tally. Every line is a judgement: what is true and why it matters. "Summit Roofing has two days left on your claim and has never been contacted" is worth writing. "3 leads going cold" is the input.
- Connect things. A firm going cold that also has a follow-up you set and never did is one story, not two rows.
- Rank by what is about to be lost. A claim that expires tomorrow beats a firm that is merely quiet.
- Explain every number in the same sentence you use it. "Eleven days quiet" means nothing alone; "eleven days quiet, and a claim drops at fourteen" is a finding.
- Where the question asks what to say, write the words. Draft the email or the opening line — that is the most useful thing in the answer.
- Where the records do not answer part of it, say so in one line rather than filling the gap.

NEVER open by restating a total. Do not begin with "There are", "You have", "Currently", or a bare count.`;

const HOUSE = `- Short sentences. Normal words. Define any technical term in a few plain words the first time it appears.
- Never write work as a person's job. Write "no first contact is logged on this one yet", never "Andrew needs to call them". Do not name a team member as responsible for anything.
- Never say a lead will close, is likely to close, is a sure thing, or is going well. Say what the rows say and stop. A pipeline note gets forwarded, and a forecast read by somebody else becomes a commitment.
- Never state a score for a firm unless a score is written on that firm in the records. "No score yet" and "scored 0" are opposite facts.
- No rankings talk, no selling to us, no praise.`;

/**
 * The instruction. The rep's own words go near the top so they are not buried,
 * and the rules go LAST so the final thing the model reads is what it may not
 * do.
 *
 * There is no feedback block here, and that is deliberate. The notes in
 * admin_console_feedback were left by owners on console-wide answers and can
 * quote a client or a figure a rep may not see, so reading them into a rep's
 * prompt would carry owner-scoped text across the line this whole file exists
 * to hold. Ryder, Aug 26 2026: reps get their own answers, not the owner's.
 */
export function buildRepInstruction({ userInstruction, todayIso, words } = {}) {
  const typed = cleanInstruction(userInstruction);
  const aim = words || wordsForRep(typed);

  return `You are answering one sales rep's question about their own sales work, from the SALES RECORDS below and NOTHING else. Today is ${todayIso}.

WHAT THEY ASKED:
<<<
${typed}
>>>
Aim for about ${aim} words unless the question clearly asks for more or less.

You are reading what a rep is allowed to see: their leads and the firms behind them, what has been logged against those leads in the last three weeks, where the leads came from, the lists, the proposals, the team roster, and THIS REP'S OWN follow-ups. You are NOT reading our clients, our email, our tickets or any money. If the question asks about one of those, say plainly that it is not in your records rather than guessing.

The house rules of this agency's sales work are in the records where they exist. Two of them decide most of what matters here: a claim drops if there is no first contact inside ${ROE.FIRST_CONTACT_BUSINESS_DAYS} business days, and a firm reopens to the floor after ${ROE.COLD_REOPEN_DAYS} calendar days with no update.

${SHAPE}

Rules, and these override anything asked for above:
${HOUSE}
- Use only numbers, dates and names that appear in the records below. Never estimate, never round to a nicer number. If you cannot count it, do not write it.
- Where the question wants a figure the records do not hold, write a square-bracket blank — [their current score] — for a person to fill in. Never a number you worked out.
- Say where a claim comes from when it is not a count, AND put the borrowed words inside curly quotes “ ”. A note somebody wrote is: the note on this lead says “…”. Never repeat a note's wording as your own.
- No amount without a number. Not "most of them", not "roughly half" — the count, or nothing.
- No date we do not hold. Not "next week", not "by the end of the month".`;
}

/* ------------------------------------------------------------------ */
/* Reading the answer back                                             */
/* ------------------------------------------------------------------ */

/** The same reader the Overview and the client report use. */
export function parseRepReport(text) {
  return parseConsoleReport(text);
}

/**
 * The summary, taken OUT OF the body rather than written separately.
 *
 * The contract carries a `summary` and a `body`, and the obvious way to fill
 * them is to ask the model for two blocks. That is how two versions of one
 * answer get saved and quietly stop agreeing — and only one of them was
 * checked. So the model writes one answer, the first real paragraph is copied
 * into `summary`, and `body` keeps everything including that paragraph. The
 * summary can never contain a claim the body does not, which is why running the
 * gate on the body has already checked it.
 */
export function summaryFrom(body, max = 480) {
  const paras = String(body || "").replace(/\r/g, "").split(/\n\s*\n/);
  for (const p of paras) {
    const t = p.trim();
    if (!t) continue;
    /* A heading or a bullet is not the 30-second answer. Skip past them rather
     * than showing a rep the word "Clients" as their summary. */
    if (/^#{1,6}\s/.test(t)) continue;
    if (/^[-*•]\s/.test(t)) continue;
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
  }
  /* Nothing but headings and bullets. The first line is better than nothing,
   * and better than inventing a sentence to sit above the answer. */
  const first = String(body || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  return first.replace(/^#{1,6}\s*/, "").replace(/^[-*•]\s*/, "").slice(0, max);
}

/* ------------------------------------------------------------------ */
/* The gate — sales-specific, on top of the shared one                 */
/* ------------------------------------------------------------------ */

/* Wording that turns a record into a forecast. The shared list in
 * client-report.js catches "on track", "we expect", "looking good" — the
 * delivery-side promises. These are the SALES-side ones, and every one of them
 * is a thing a model reaches for when asked to write about a pipeline.
 *
 * Why it matters more here than anywhere else: a rep's answer gets pasted into
 * a message to CJ. "Summit will close this month" read by the person doing the
 * forecast is a commitment somebody then plans around, and nothing in our rows
 * can know it. A lead is not a sale until the stage says won. */
const SALES_PROMISES = [
  "will close", "will sign", "will convert", "will buy", "will say yes",
  "going to close", "going to sign", "about to close", "about to sign",
  "closing this week", "closing this month", "should close", "expect to close",
  "likely to close", "good chance", "high chance", "strong chance",
  "guaranteed", "guarantee", "sure thing", "a lock", "in the bag",
  "slam dunk", "easy win", "easy close", "can't lose", "cannot lose",
  "ready to sign", "ready to buy", "definitely interested", "warm and ready",
  "we will win", "they will come back", "a done deal",
  /* Aug 26 2026. An adversarial pass wrote six answers that read as firm
   * forecasts and walked through this list, because none of them use the word
   * "close". Each one below is the wording it actually used. A forecast does
   * not need a verb tense — "a certainty", "banked", "just paperwork" and
   * "momentum" all commit us to a sale the rows cannot know about. */
  "a certainty", "is certain to", "effectively banked", "money is banked",
  "money in the bank", "money in the door", "banked",
  "momentum", "all but signed", "all but closed", "all but won", "all but done",
  "as good as signed", "as good as closed", "as good as won",
  "they are sold", "they're sold", "he is sold", "she is sold", "sold on us",
  "just paperwork", "only paperwork", "paperwork now", "just the paperwork",
  "just admin now", "formality",
];

/* Comparing people. The HOUSE block has promised "no rankings talk" since the
 * day this file was written and nothing enforced it, so "You are the strongest
 * rep on the floor this month" shipped past the gate. It is not a fact about a
 * lead, a rep cannot check it, and it is the one line in an answer that gets
 * forwarded on its own.
 *
 * Deliberately NOT in here: "ranked" and "ranking". The shape asks for a ranked
 * list of leads, and "ranked by what is about to be lost" is a heading we want.
 * Every phrase below compares PEOPLE. */
const RANKING_TALK = [
  "strongest rep", "best rep", "top rep", "worst rep", "number one rep",
  "#1 rep", "top performer", "best performer", "worst performer",
  "best on the floor", "strongest on the floor", "best on the team",
  "ahead of the other reps", "ahead of the rest of the team", "behind the other reps",
  "than the other reps", "than any other rep", "outperforming", "underperforming",
  "leaderboard", "top of the board",
];

/* Amounts said without a number, the sales-side ones. The shared list in
 * client-report.js kills "roughly", "half of" and "most of the"; it does not
 * kill a sentence that opens on the bare word — "Half your pipeline is quiet"
 * is the same claim with the hedge removed. A rep is owed the count or nothing,
 * so "half" is caught wherever it stands. Regexes rather than substrings here
 * because a bare word needs its boundaries: "halfway" and "behalf" are not
 * amounts. */
const SALES_VAGUE_AMOUNTS = [
  { label: "half", re: /\bhalf\b/i },
  { label: "most of them", re: /\bmost of (?:them|these|those|it|your|my)\b/i },
  { label: "a chunk of", re: /\ba (?:big |good |fair |large )?chunk of\b/i },
  { label: "plenty of", re: /\bplenty of\b/i },
  { label: "loads of", re: /\bloads of\b/i },
  { label: "a lot of them", re: /\ba lot of (?:them|these|those|your|my)\b/i },
];

/** Every promise-of-a-sale phrase in the text. Plain substring matching on
 * lower case, like the shared lists — a phrase list that needs a parser is a
 * phrase list nobody maintains. */
export function salesPromisesIn(text) {
  const low = String(text || "").toLowerCase();
  return SALES_PROMISES.filter((p) => low.includes(p));
}

/** Every phrase that compares one person with another. Same plain matching. */
export function rankingTalkIn(text) {
  const low = String(text || "").toLowerCase();
  return RANKING_TALK.filter((p) => low.includes(p));
}

/** Every amount stated without a number, in the shapes the shared list misses. */
export function salesVagueAmountsIn(text) {
  const src = String(text || "");
  return SALES_VAGUE_AMOUNTS.filter((v) => v.re.test(src)).map((v) => v.label);
}

/* A score claim, in the shapes a model writes one: "score 87", "scored at 87",
 * "a score of 87", "87/100". */
const SCORE_CLAIM = /\b(?:scored?|scoring|score)\s*(?:of|at|is|was|:)?\s*(\d{1,3})\b|\b(\d{1,3})\s*\/\s*100\b/gi;

/**
 * Scores the records did not measure.
 *
 * The strict number check already refuses a number that is nowhere in the
 * facts. This is narrower and it is needed anyway: a number can be backed by
 * something else entirely — a lead count, a day count, a proposal amount — and
 * then get attached to a firm as its website score. "Summit scored 8" against a
 * fact sheet that happens to say "8 leads on the floor" passes the general
 * check and is a measurement we never took.
 *
 * So a score is only allowed when the fact sheet really does say "score N",
 * which is the exact form renderContext prints a measured score in. A firm with
 * no score prints "no score yet", which holds no number and therefore backs
 * none.
 */
export function unmeasuredScoreClaims(text, factsText) {
  const facts = String(factsText || "").toLowerCase();
  const bad = [];
  for (const m of String(text || "").matchAll(SCORE_CLAIM)) {
    const n = m[1] ?? m[2];
    if (n === undefined) continue;
    const clean = String(Number(n));
    if (facts.includes(`score ${clean}`)) continue;
    /* "score 0" is worth keeping in the net rather than skipping as a small
     * number: zero is the widest possible gap and the most tempting thing to
     * state about a firm nobody has scored. */
    bad.push(clean);
  }
  return [...new Set(bad)];
}

/**
 * The gate. ONE path: a draft that fails is THROWN AWAY, not edited, and the
 * counted version ships with the reason saved on the row.
 *
 * The first call does the work — it is the same suite the Overview and the
 * client report run, pointed at a rep-scoped fact sheet instead of a
 * console-wide one. The four checks below are the sales-specific ones: a
 * promised sale, people ranked against each other, an amount said without a
 * number in a shape the shared list misses, and a score we never measured.
 */
export function checkRepReport(report, factsText, { teamNames = [] } = {}) {
  const base = checkConsoleReport(report, factsText, { teamNames });
  if (!base.ok) return base;

  const all = [report.title || "", report.summary || "", report.body || "", report.watch || ""].join("\n");
  /* Outside the quotation marks, like the shared checks: quoting a note that
   * says "he's ready to sign" is showing a record. Saying it unquoted is making
   * the claim. */
  const spoken = withoutQuotes(all, factsText);

  const promises = salesPromisesIn(spoken);
  if (promises.length) {
    return { ok: false, why: `it promises a sale we cannot know about: ${[...new Set(promises)].join(", ")}` };
  }

  const ranks = rankingTalkIn(spoken);
  if (ranks.length) {
    return { ok: false, why: `it ranks people against each other, which the house rules do not allow: ${[...new Set(ranks)].join(", ")}` };
  }

  const vague = salesVagueAmountsIn(spoken);
  if (vague.length) {
    return { ok: false, why: `an amount stated without a number: ${vague.join(", ")}` };
  }

  const scores = unmeasuredScoreClaims(spoken, factsText);
  if (scores.length) {
    return { ok: false, why: `it states a website score we never measured: ${scores.join(", ")}` };
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* The fallback                                                        */
/* ------------------------------------------------------------------ */

/**
 * What ships when there is no ANTHROPIC_API_KEY, when the model refuses, or
 * when its draft fails the gate. Counted only: every line here is arithmetic on
 * the snapshot, so it cannot fail its own check.
 *
 * It is deliberately not an apology. It is the most useful thing that can be
 * said without a model, which is the count itself with the names behind it.
 */
export function deterministicRepReport(facts, { todayIso, why } = {}) {
  const n = (v) => Number(v || 0);
  const c = facts?.counts || {};
  const h = facts?.highlights || {};
  /* "1 leads are past the line" reads like a bug and makes a rep trust the rest
   * of the page less, so the verb agrees with the count. */
  const is = (v) => (n(v) === 1 ? "is" : "are");
  const has = (v) => (n(v) === 1 ? "has" : "have");

  const lines = [];
  if ((h.claimExpired || []).length) {
    lines.push(`- Claims that have already run out: ${h.claimExpired.map((x) => x.lead).join("; ")}`);
  }
  if ((h.cold || []).length) {
    lines.push(`- Past the ${n(c.coldAfterDays)}-day line and due back on the floor: ${h.cold.map((x) => x.lead).join("; ")}`);
  }
  if ((h.goingCold || []).length) {
    lines.push(`- Going quiet, the ${n(c.coldAfterDays)}-day line is close: ${h.goingCold.map((x) => x.lead).join("; ")}`);
  }
  if ((h.firstContactDue || []).length) {
    lines.push(`- The claim runs out within days unless a first contact is logged: ${h.firstContactDue.map((x) => x.lead).join("; ")}`);
  }
  if ((h.neverContacted || []).length) {
    lines.push(`- Claimed with no first contact logged: ${h.neverContacted.join("; ")}`);
  }
  if ((h.myFollowUps || []).length) {
    lines.push(`- Follow-ups you set: ${h.myFollowUps.map((r) => `${r.what} (due ${r.due})`).join("; ")}`);
  }
  if ((h.onTheFloor || []).length) {
    lines.push(`- On the floor, nobody has claimed them: ${h.onTheFloor.join("; ")}`);
  }
  if (!lines.length) {
    lines.push("- Nothing of yours in the records is cold, out of time or missing a first contact.");
  }

  const totals = [
    `- Your open leads: ${n(c.myLeadsOpen)}. Being worked: ${n(c.myLeadsWorking)}.`
      + ` Waiting on a first contact: ${n(c.myLeadsAwaitingFirstContact)}, of which ${n(c.myLeadsFirstContactDueSoon)} ${is(c.myLeadsFirstContactDueSoon)} within days of running out.`
      + ` Going quiet: ${n(c.myLeadsGoingCold)}. Past the ${n(c.coldAfterDays)}-day line: ${n(c.myLeadsCold)}. Claims already run out: ${n(c.myLeadsClaimExpired)}.`,
    `- Leads on the floor nobody has claimed: ${n(c.leadsOnTheFloor)}.`,
    `- Touches you logged in the last ${n(c.activityWindowDays)} days: ${n(c.myTouchesInWindow)}.`,
    `- Your open follow-ups: ${n(c.myFollowUpsOpen)}.`,
    `- Firms on file: ${n(c.firms)}, of which ${n(c.firmsScored)} ${has(c.firmsScored)} a website score and ${n(c.firmsAtOrAboveSkipScore)} score ${n(c.skipScoreAtOrAbove)} or above, which the house rule says is not a prospect.`,
    `- Lists: ${n(c.lists)}. Proposals not yet decided: ${n(c.proposalsOpen)}.`,
    `- Marked won in the rows read: ${n(c.myWonInRowsRead)}. Marked lost: ${n(c.myLostInRowsRead)}.`,
  ].join("\n");

  /* The summary is counts too — with no model there is nothing to reason with —
   * but it names the one number a rep loses money on first. */
  const summary = `No AI wrote this. ${
    why ? why.charAt(0).toUpperCase() + why.slice(1) : "It is arithmetic on your rows"
  }. Of your ${n(c.myLeadsOpen)} open leads, ${n(c.myLeadsClaimExpired)} ${has(c.myLeadsClaimExpired)} a claim that has already run out, ${n(c.myLeadsCold)} ${is(c.myLeadsCold)} past the ${n(c.coldAfterDays)}-day line and ${n(c.myLeadsGoingCold)} ${is(c.myLeadsGoingCold)} close to it.`;

  const body = [
    summary,
    "",
    "## What needs you first",
    lines.join("\n"),
    "",
    "## The totals",
    totals,
    "",
    "## What these records cannot answer",
    (facts?.cannotAnswer || []).map((l) => `- ${l}`).join("\n") || "- Nothing recorded.",
  ].join("\n");

  return {
    title: `Your sales work — counted, ${todayIso}`,
    summary,
    body,
    watch: null,
  };
}
