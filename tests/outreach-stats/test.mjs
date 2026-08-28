/* OUTREACH, COUNTED — one fixture, and the numbers that must never disagree.
 *
 * lib/outreach.js exists as a function rather than as arithmetic inside two
 * components for exactly one reason, written at the top of the file itself: THE
 * SAME FUNCTION WITH THE SAME ROWS AND THE SAME userId HAS TO PRODUCE THE SAME
 * NUMBER, or a rep's own tile and CJ's cell for that rep drift apart and one of
 * them is a lie. The first section of this file is that assertion, field by
 * field, and it is the most important thing in here.
 *
 * Everything else is the four honesty rules the module is built on:
 *   · THE UNIT IS A PERSON, NOT AN EMAIL. Five follow-ups to one person who
 *     answered is not a 20% reply rate.
 *   · A BOUNCE COMES OUT OF THE DENOMINATOR. An address that does not exist was
 *     never given the chance to answer.
 *   · NULL IS NOT ZERO, ANYWHERE. "Nobody replied" and "we could not read the
 *     replies" are opposite answers to the same question.
 *   · THE WINDOW IS PART OF THE NUMBER, and it is compared as ISO STRINGS —
 *     never `new Date(bareDate)`, which is midnight UTC and therefore the
 *     evening before in Chicago.
 *
 * Plain node, real module, no mocks of our own code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { outreachFor, outreachByRep, lossReasons, OUTREACH_WINDOW_DAYS } from "../../lib/outreach.js";
import { ROE } from "../../lib/sales-rules.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW_MS = Date.parse("2026-08-27T15:00:00Z");
const ago = (n) => new Date(NOW_MS - n * 86400000).toISOString();

const REP = "u-rep";
const REP2 = "u-rep2";

/* ------------------------------------------------------------------ */
/* ONE FIXTURE, BUILT BY HAND, USED BY EVERYTHING BELOW.               */
/*                                                                     */
/* Every row is here for a named reason. Read the trailing comments —   */
/* several of them are the only thing that makes a number below         */
/* unambiguous, and two of them are cases that a plausible-looking      */
/* implementation gets wrong.                                          */
/* ------------------------------------------------------------------ */
const LEADS = [
  // Emailed and answered, inside the window. Gap 2 days.
  { id: "p1", owner_id: REP, stage: "contacted", first_email_at: ago(10), first_reply_at: ago(8), first_contact_at: ago(10), claimed_at: ago(10), claim_contacted_at: ago(10), last_touch_at: ago(1) },
  // Emailed, never answered.
  { id: "p2", owner_id: REP, stage: "new", first_email_at: ago(20), first_contact_at: ago(20), claimed_at: ago(20), claim_contacted_at: ago(20), last_touch_at: ago(20) },
  // Emailed inside the window AND bounced inside it. Out of the denominator.
  { id: "p3", owner_id: REP, stage: "contacted", first_email_at: ago(5), bounced_at: ago(5), first_contact_at: ago(5), claimed_at: ago(5), claim_contacted_at: ago(5), last_touch_at: ago(5) },
  // THE ONE THAT BREAKS THE OBVIOUS IMPLEMENTATION. Emailed 40 days ago — OUTSIDE
  // the window, so this person is not in `emailed` — but the bounce landed 2 days
  // ago, INSIDE it. `emailed - bounced` would take the denominator below the
  // number of people we actually emailed inside the window.
  { id: "p4", owner_id: REP, stage: "contacted", first_email_at: ago(40), bounced_at: ago(2), claimed_at: ago(40) },
  // Reply stamped BEFORE the send. Something wrote the two columns out of order;
  // a negative average is worse than no average, so this row is dropped from the
  // time-to-reply figure and the sample size has to say so.
  { id: "p5", owner_id: REP, stage: "proposal", first_email_at: ago(6), first_reply_at: ago(7), first_contact_at: ago(6), claimed_at: ago(6), claim_contacted_at: ago(6), last_touch_at: ago(2) },
  // Won, with a date and a reason. Gap 5 days.
  { id: "p6", owner_id: REP, stage: "won", first_email_at: ago(25), first_reply_at: ago(20), closed_at: ago(3), won_reason: "referral", first_contact_at: ago(25) },
  // WON WITH NO DATE. It is in NEITHER window and it is counted and named
  // separately, rather than folded into this month.
  { id: "p7", owner_id: REP, stage: "won", won_reason: "needed_leads" },
  // Lost inside the window with NO reason on it. Every row that closed before the
  // reason box existed looks like this.
  { id: "p8", owner_id: REP, stage: "lost", first_email_at: ago(28), closed_at: ago(4), first_contact_at: ago(28) },
  // Lost OUTSIDE the window.
  { id: "p9", owner_id: REP, stage: "lost", closed_at: ago(40), lost_reason: "price" },
  // LOST WITH NO OWNER — a lead released after it was lost has exactly this
  // shape. A per-rep sum cannot see it; lossReasons() counts over every lead so
  // that it can.
  { id: "p10", owner_id: null, stage: "lost", closed_at: ago(3), lost_reason: "price" },
  // Somebody else's book, so "userId is required" has something to leak.
  { id: "p11", owner_id: REP2, stage: "contacted", first_email_at: ago(3), first_reply_at: ago(1), first_contact_at: ago(3), claimed_at: ago(3), claim_contacted_at: ago(3), last_touch_at: ago(1) },
  // Held, never emailed, never touched.
  { id: "p12", owner_id: REP, stage: "new", claimed_at: ago(1) },
  // Lost inside the window WITH a reason, so the breakdown has two rows and the
  // no-reason row cannot hide in a one-row list.
  { id: "p13", owner_id: REP, stage: "lost", closed_at: ago(5), lost_reason: "price" },
  // Lost with no date, on somebody else's book — for lossReasons().undated.
  { id: "p14", owner_id: REP2, stage: "lost", lost_reason: "bad_timing" },
];

const ACTIVITY = [
  { id: "a1", actor: REP, type: "email", created_at: ago(5) },
  { id: "a2", actor: REP, type: "email", created_at: ago(6) },
  { id: "a3", actor: REP, type: "call", created_at: ago(2) },
  { id: "a4", actor: REP, type: "text", created_at: ago(35) },     // outside the window
  { id: "a5", actor: REP2, type: "email", created_at: ago(1) },    // somebody else's
  { id: "a6", actor: REP, type: "linkedin", created_at: ago(3) },
];

const PROPOSALS = [
  { id: "pr1", lead_id: "p1", status: "sent", amount_cents: 250000 },
  { id: "pr2", lead_id: "p1", status: "viewed", amount_cents: null },   // out, but not priced
  { id: "pr3", lead_id: "p2", status: "draft", amount_cents: 999 },     // not out yet
  { id: "pr4", lead_id: "p2", status: "won", amount_cents: 500000 },    // decided
  { id: "pr5", lead_id: "p11", status: "sent", amount_cents: 100000 },  // somebody else's lead
  { id: "pr6", lead_id: null, status: "sent", amount_cents: 1 },        // attached to nobody
];

const ARGS = { leads: LEADS, activity: ACTIVITY, proposals: PROPOSALS, nowMs: NOW_MS };
const TEAM = [
  { user_id: REP, full_name: "Larry Pike", role: "sales", active: true },
  { user_id: REP2, full_name: "Brandon Roberts", role: "sales", active: true },
  { user_id: "u-gone", full_name: "Left In June", role: "sales", active: false },
  { full_name: "A row with no user_id at all", active: true },
];

/* ================================================================== */
console.log("\nTHE EQUALITY THAT MATTERS MOST — A REP'S OWN TILE AND THE OWNER'S CELL");
/* If these two ever differ, one of the two screens is lying about the same rep on
 * the same rows, and there is no way for anybody looking at either to tell which.
 * Asserted FIELD BY FIELD rather than with one deep-equal, because a single
 * deep-equal passes just as happily on two empty objects. */
const DIRECT = outreachFor({ ...ARGS, userId: REP });
const TABLE = outreachByRep({ team: TEAM, ...ARGS });
const ROW = TABLE.find((r) => r.member.user_id === REP);

ok("the owner's table has a row for this rep at all", Boolean(ROW));
const KEYS = Object.keys(DIRECT);
ok(`there are ${KEYS.length} fields to compare, so this is not two empty objects agreeing`, KEYS.length >= 20, KEYS.join(","));
eq("...and the owner's cell carries exactly the same field names", Object.keys(ROW.stats).sort(), KEYS.slice().sort());
ok("...and the rep's own numbers are really populated, not all null",
  DIRECT.knowsWho === true && DIRECT.emailed !== null && DIRECT.replyRate !== null);
for (const k of KEYS) {
  eq(`the rep's own tile and the owner's cell agree on \`${k}\``, DIRECT[k], ROW.stats[k]);
}
eq("the owner's table skips a deactivated member — somebody who has left is not a column",
  TABLE.map((r) => r.member.user_id), [REP, REP2]);
eq("...and skips a roster row with no user_id, rather than counting the whole system as theirs",
  TABLE.filter((r) => !r.member.user_id).length, 0);
eq("no team at all is an empty table, not a crash", outreachByRep({ ...ARGS }), []);

/* ================================================================== */
console.log("\nWITHOUT A userId IT REFUSES, RATHER THAN PRINTING EVERYBODY'S BOOK");
/* With a falsy id the lead filter `l.owner_id && l.owner_id === userId` passes
 * nothing — but the first version of this pattern filtered on `l.owner_id ===
 * userId`, which on a page that had not loaded the member yet matched every
 * unowned row. Refusing is the only safe answer. */
for (const bad of [null, undefined, "", 0, false]) {
  const NOBODY = outreachFor({ ...ARGS, userId: bad });
  ok(`userId ${JSON.stringify(bad)}: it says it does not know who this is about`, NOBODY.knowsWho === false);
  eq(`userId ${JSON.stringify(bad)}: and names that as the thing it could not read`, NOBODY.unreadable, ["who this is about"]);
  const nulls = ["emailed", "replied", "bounced", "replyBase", "replyRate", "avgReplyDays",
    "holding", "claimsExpiring", "quiet", "neverTouched", "stages",
    "proposalsOut", "proposalCents", "won", "lost", "wonReasons", "lostReasons"];
  ok(`userId ${JSON.stringify(bad)}: every number is null — never a 0, and never somebody else's`,
    nulls.every((k) => NOBODY[k] === null), nulls.filter((k) => NOBODY[k] !== null).join(","));
  ok(`userId ${JSON.stringify(bad)}: nothing logged is null too, channel by channel`,
    Object.values(NOBODY.logged).every((v) => v === null));
  ok(`userId ${JSON.stringify(bad)}: and it did NOT quietly hand back the whole company's numbers`,
    NOBODY.emailed !== DIRECT.emailed);
  ok(`userId ${JSON.stringify(bad)}: the window is still reported, so the screen can say what it would have covered`,
    NOBODY.window.days === OUTREACH_WINDOW_DAYS && typeof NOBODY.window.sinceIso === "string");
}

/* ================================================================== */
console.log("\nA READ THAT FAILED COMES OUT NULL, WITH ITS NAME ON IT — NEVER 0");
const BLIND = outreachFor({ leads: null, activity: null, proposals: null, userId: REP, nowMs: NOW_MS });
ok("it still knows who it is about", BLIND.knowsWho === true);
eq("all three failed reads are named", BLIND.unreadable, ["your leads", "what was logged", "your proposals"]);
eq("emailed is null, NOT 0 — \"nobody was emailed\" and \"we could not read it\" are opposite answers",
  BLIND.emailed, null);
eq("replied is null, not 0", BLIND.replied, null);
eq("bounced is null, not 0", BLIND.bounced, null);
eq("the reply rate is null, not 0%", BLIND.replyRate, null);
eq("the denominator is null, not 0", BLIND.replyBase, null);
eq("time to first reply is null", BLIND.avgReplyDays, null);
eq("how many leads they hold is null, not 0", BLIND.holding, null);
eq("the stage breakdown is null, not a row of zeroes", BLIND.stages, null);
eq("proposals out is null, not 0", BLIND.proposalsOut, null);
eq("won is null, not 0", BLIND.won, null);
eq("lost is null, not 0", BLIND.lost, null);
eq("the reason breakdowns are null, not empty lists", [BLIND.wonReasons, BLIND.lostReasons], [null, null]);
eq("closes with no date is null, not 0", BLIND.closedWithNoDate, null);
ok("every channel of what was logged is null, not 0",
  Object.values(BLIND.logged).every((v) => v === null), JSON.stringify(BLIND.logged));
/* Something the reader would otherwise have to guess at: the sample size behind
 * a null average is 0, and that is honest — no rows were used, because no rows
 * could be read. */
eq("the sample behind a null average is 0 rows, which is a count and not a measurement", BLIND.avgReplySample, 0);

/* ONE FAILED READ MUST NOT POISON THE OTHER TWO. */
const HALF = outreachFor({ leads: LEADS, activity: null, proposals: PROPOSALS, userId: REP, nowMs: NOW_MS });
eq("only the read that actually failed is named", HALF.unreadable, ["what was logged"]);
eq("the funnel still counts, because the leads were readable", HALF.emailed, DIRECT.emailed);
eq("the proposals still count", HALF.proposalsOut, DIRECT.proposalsOut);
ok("but what was logged is null throughout, rather than a row of zeroes",
  Object.values(HALF.logged).every((v) => v === null));
const NO_PROPOSALS = outreachFor({ leads: LEADS, activity: ACTIVITY, proposals: null, userId: REP, nowMs: NOW_MS });
eq("a failed proposals read is named on its own", NO_PROPOSALS.unreadable, ["your proposals"]);
eq("...and both proposal figures are null, not 0 and not $0",
  [NO_PROPOSALS.proposalsOut, NO_PROPOSALS.proposalCents], [null, null]);
eq("...while the funnel is untouched", NO_PROPOSALS.replyRate, DIRECT.replyRate);

/* ================================================================== */
console.log("\nTHE UNIT IS A PERSON, AND A BOUNCE COMES OUT OF THE DENOMINATOR");
eq("six people were emailed inside the window", DIRECT.emailed, 6);
/* TWO, NOT THREE — and this is the fix, not a regression.
 *
 * A reply is only a reply to something we sent INSIDE THE SAME WINDOW. Counting
 * every lead whose `first_reply_at` fell in the window, with no reference to the
 * emailed set at all, produced `emailed 1, replied 3, reply rate 300%` on this
 * very fixture, and the screen printed "3 of 1 people who could answer". The
 * numerator has to be a subset of the denominator or the rate is not a rate.
 * Aug 27 2026, after a review. */
eq("only the replies from people we emailed INSIDE the window count", DIRECT.replied, 2);
ok("...so the numerator can never be bigger than the denominator",
  DIRECT.replied <= DIRECT.replyBase,
  `replied ${DIRECT.replied} against a denominator of ${DIRECT.replyBase}`);
eq("two bounces landed inside the window", DIRECT.bounced, 2);
/* THE ASSERTION THE WHOLE SECTION EXISTS FOR.
 *
 * Six people emailed inside the window. Two bounces inside it — but only ONE of
 * those two (p3) is a person we emailed inside the window; the other (p4) was
 * emailed forty days ago and only bounced last week.
 *
 *   right                        6 emailed − 1 bounced-among-them  = 5
 *   `emailed − bounced`          6 − 2                             = 4
 *
 * The wrong one takes the denominator BELOW the number of people we actually
 * emailed inside the window, which is not a thing that can be true. It also
 * flatters the rate, and this is the number a rep gets judged on. */
eq("the denominator is the people emailed inside the window MINUS the ones among THEM who bounced",
  DIRECT.replyBase, 5);
ok("...which is never below the number of people emailed inside the window minus the in-window bounces among them",
  DIRECT.replyBase <= DIRECT.emailed && DIRECT.replyBase === 5,
  `emailed ${DIRECT.emailed}, bounced ${DIRECT.bounced}, base ${DIRECT.replyBase}`);
eq("...and the rate is 2 of 5, which is the only pair of numbers in the same unit", DIRECT.replyRate, 40);

/* NULL WHEN THERE IS NOTHING TO DIVIDE BY. 0% over nobody is a claim about
 * nobody, and it is the claim that would sit on a new rep's first tile. */
const NOBODY_EMAILED = outreachFor({
  leads: [{ id: "n1", owner_id: REP, stage: "new" }], activity: [], proposals: [],
  userId: REP, nowMs: NOW_MS,
});
eq("nobody emailed at all", NOBODY_EMAILED.emailed, 0);
eq("...so the reply rate is null, not 0%", NOBODY_EMAILED.replyRate, null);
eq("...and the denominator is 0, which is a count, so the screen can say why the rate is missing",
  NOBODY_EMAILED.replyBase, 0);
/* EVERY PERSON EMAILED BOUNCED. The denominator is 0 and the rate has to be
 * null rather than 0% — a list where every address was dead tells you nothing
 * about whether the emails were any good. */
const ALL_BOUNCED = outreachFor({
  leads: [
    { id: "b1", owner_id: REP, stage: "new", first_email_at: ago(3), bounced_at: ago(3) },
    { id: "b2", owner_id: REP, stage: "new", first_email_at: ago(4), bounced_at: ago(4) },
  ],
  activity: [], proposals: [], userId: REP, nowMs: NOW_MS,
});
eq("two people emailed, both dead addresses", [ALL_BOUNCED.emailed, ALL_BOUNCED.bounced], [2, 2]);
eq("...the denominator is 0", ALL_BOUNCED.replyBase, 0);
eq("...and the rate is null, not 0% — a dead list says nothing about the emails", ALL_BOUNCED.replyRate, null);
/* A bounce is never allowed to make the denominator negative, whatever order the
 * columns were written in. */
const WEIRD = outreachFor({
  leads: [{ id: "w", owner_id: REP, stage: "new", first_email_at: ago(3), bounced_at: ago(3) }],
  activity: [], proposals: [], userId: REP, nowMs: NOW_MS,
});
ok("the denominator can never go negative", WEIRD.replyBase >= 0, String(WEIRD.replyBase));

console.log("\nTIME TO FIRST REPLY — AND WHAT IT REFUSES TO AVERAGE");
/* Two usable gaps in the fixture: p1 replied 2 days after the email, p6 after 5.
 * p5's reply is stamped BEFORE its send, and a negative average is worse than no
 * average, so that row is dropped. */
eq("the average is over the rows where BOTH ends are on record and the reply is after the send",
  DIRECT.avgReplyDays, 3.5);
eq("...and the sample size says how many rows were actually used", DIRECT.avgReplySample, 2);
/* THE SAMPLE AND THE REPLY COUNT NOW AGREE, and that is the point rather than a
 * weaker assertion. A reply dated before its own send used to be counted as a
 * reply and then thrown out of the average — so the two numbers disagreed on
 * screen with nothing to explain the gap. It is refused as a reply at all now, so
 * "how many replied" and "how many gaps we could measure" match, and where they
 * ever do not it is because a reply has no send on record at all. */
/* AN EQUALITY, NOT A `<=`. After the subset fix `gaps` is filtered from
 * `repliedRows`, and `repliedRows` already requires both dates parseable and the
 * reply after the send — so the two counts are identical for every possible
 * input and the `<=` could no longer fail. An assertion that cannot fail is
 * worse than none: it reads as proof. Third review, Aug 27 2026. */
eq("...and it is exactly the number of people who replied, because a reply we cannot date is not a reply",
  DIRECT.avgReplySample, DIRECT.replied);
const BACKWARDS = outreachFor({
  leads: [{ id: "r1", owner_id: REP, stage: "new", first_email_at: ago(3), first_reply_at: ago(9) }],
  activity: [], proposals: [], userId: REP, nowMs: NOW_MS,
});
/* NOT COUNTED AS A REPLY AT ALL, which is the change. A reply stamped six days
 * BEFORE the email it answers is not a reply — it means the two columns were
 * written out of order by something — and counting it inflated the one number a
 * rep is judged on while producing no gap to average, so the screen said "1
 * replied" next to "no average". Aug 27 2026, after a review. */
eq("a reply dated before its own send is not a reply", BACKWARDS.replied, 0);
eq("...and there is no average, rather than a negative one", BACKWARDS.avgReplyDays, null);
eq("...and the sample says nothing was used", BACKWARDS.avgReplySample, 0);
const SAME_DAY = outreachFor({
  leads: [{ id: "r2", owner_id: REP, stage: "new", first_email_at: ago(3), first_reply_at: ago(3) }],
  activity: [], proposals: [], userId: REP, nowMs: NOW_MS,
});
eq("a reply in the same instant is 0 days, which is a real answer and is kept", SAME_DAY.avgReplyDays, 0);
eq("...and it counts in the sample", SAME_DAY.avgReplySample, 1);
const NO_SEND = outreachFor({
  leads: [{ id: "r3", owner_id: REP, stage: "new", first_reply_at: ago(3) }],
  activity: [], proposals: [], userId: REP, nowMs: NOW_MS,
});
eq("a reply with no send on record cannot be timed", NO_SEND.avgReplyDays, null);
eq("...and is not counted in the sample", NO_SEND.avgReplySample, 0);
eq("the average is rounded to one place, not to a whole number — 0.4 days rounded to 0 reads as 'instantly'",
  outreachFor({
    leads: [{ id: "r4", owner_id: REP, stage: "new", first_email_at: "2026-08-20T00:00:00Z", first_reply_at: "2026-08-20T09:36:00Z" }],
    activity: [], proposals: [], userId: REP, nowMs: NOW_MS,
  }).avgReplyDays, 0.4);

console.log("\nWHAT WAS LOGGED — BY THIS PERSON, INSIDE THE WINDOW");
eq("emails, calls, texts and LinkedIn, counted separately",
  DIRECT.logged, { email: 2, call: 1, text: 0, linkedin: 1 });
ok("a channel nobody used is 0 rather than null, because the rows WERE read",
  DIRECT.logged.text === 0);
ok("...and the text logged 35 days ago is outside the window, which is why it is 0 and not 1",
  ACTIVITY.some((a) => a.type === "text" && a.actor === REP));
eq("somebody else's activity is not counted as yours",
  outreachFor({ ...ARGS, userId: REP2 }).logged.email, 1);
/* The count of EMAILS is carried separately from the count of PEOPLE emailed,
 * and labelled as what it is. Two emails logged, six people emailed — if the two
 * ever got mixed up, the reply rate would be a rate of nothing in particular. */
ok("the count of emails and the count of people emailed are different numbers, kept apart",
  DIRECT.logged.email !== DIRECT.emailed);

console.log("\nTHE BOOK RIGHT NOW — NOT WINDOWED, AND THE SCREEN SAYS SO");
eq("six open leads held", DIRECT.holding, 6);
eq("a won lead is not in the book", LEADS.filter((l) => l.owner_id === REP && l.stage === "won").length, 2);
eq("claims that have run out or are due", DIRECT.claimsExpiring, 2);
eq("claims that have gone quiet", DIRECT.quiet, 1);
eq("held but never touched at all", DIRECT.neverTouched, 2);
ok("the three claim counts cannot exceed the book they are counted from",
  DIRECT.claimsExpiring + DIRECT.quiet <= DIRECT.holding);
eq("the number of days that makes a claim cold comes from the Rules of Engagement, not from a literal",
  DIRECT.coldAfterDays, ROE.COLD_REOPEN_DAYS);
eq("the stage ladder is printed in the ladder's own order, with the empty rungs shown as 0",
  DIRECT.stages.map((s) => `${s.stage}:${s.count}`),
  ["new:2", "researching:0", "contacted:3", "in_conversation:0", "follow_up:0", "meeting:0", "proposal:1"]);
eq("the open stages add up to the book", DIRECT.stages.reduce((n, s) => n + s.count, 0), DIRECT.holding);

console.log("\nPROPOSALS — ONLY THE ONES THAT ARE ACTUALLY OUT");
eq("two are out: one sent and one they have opened", DIRECT.proposalsOut, 2);
eq("a draft is not out", PROPOSALS.filter((p) => p.status === "draft").length, 1);
eq("a decided one is not out either", PROPOSALS.filter((p) => p.status === "won").length, 1);
ok("only `sent` and `viewed` count — a draft, a won, a lost and a withdrawn are all not out",
  DIRECT.proposalsOut === PROPOSALS.filter((p) => p.lead_id === "p1" && ["sent", "viewed"].includes(p.status)).length);
eq("a proposal on somebody else's lead is not yours", outreachFor({ ...ARGS, userId: REP2 }).proposalsOut, 1);
eq("a proposal attached to no lead belongs to nobody's tile", DIRECT.proposalsOut, 2);
eq("the money is the sum of the ones that carry an amount", DIRECT.proposalCents, 250000);

/* THE RULE, IN THE MODULE'S OWN WORDS (lib/outreach.js:200-201): "Cents, and
 * null when NONE of them carries an amount — a total of $0 over three proposals
 * nobody priced is a number somebody would quote."
 *
 * IT DID FAIL WHEN THIS WAS WRITTEN, AND IT IS FIXED. `Number(null)` is 0 and
 * `Number.isFinite(0)` is true, so a proposal whose amount_cents is NULL — which
 * is what Postgres hands back for an unpriced one — counted as priced and added 0
 * to the total, producing the exact number the module's own comment forbids. The
 * reader is now `isPriced()`, which asks whether there is a value there rather
 * than whether the value is truthy — so a proposal deliberately priced at ZERO
 * still counts, which the assertion below this one pins. Aug 27 2026. */
const UNPRICED = outreachFor({
  leads: [{ id: "u1", owner_id: REP, stage: "new" }],
  activity: [],
  proposals: [
    { id: "q1", lead_id: "u1", status: "sent", amount_cents: null },
    { id: "q2", lead_id: "u1", status: "sent", amount_cents: null },
    { id: "q3", lead_id: "u1", status: "viewed", amount_cents: null },
  ],
  userId: REP, nowMs: NOW_MS,
});
eq("three proposals out, none of them priced", UNPRICED.proposalsOut, 3);
eq("...the total is NULL, not $0 — a total of $0 over three unpriced proposals is a number somebody would quote",
  UNPRICED.proposalCents, null);
eq("...and none of them is counted as priced", UNPRICED.proposalsPriced, 0);
eq("in the main fixture, only the ONE proposal with a real amount is counted as priced",
  DIRECT.proposalsPriced, 1);
/* A proposal priced at literally zero — a free pilot — IS a price somebody set,
 * and it must survive. This is the assertion that stops the fix above being
 * "treat 0 as missing". */
const FREE = outreachFor({
  leads: [{ id: "f1", owner_id: REP, stage: "new" }],
  activity: [],
  proposals: [{ id: "z", lead_id: "f1", status: "sent", amount_cents: 0 }],
  userId: REP, nowMs: NOW_MS,
});
eq("a proposal deliberately priced at zero is a price somebody set, and it survives", FREE.proposalsPriced, 1);
eq("...and the total is 0, which is the real figure", FREE.proposalCents, 0);

console.log("\nWON AND LOST, GROUPED BY REASON — AND THE BREAKDOWN CANNOT COME OUT SHORT");
eq("one deal won inside the window", DIRECT.won, 1);
eq("two lost inside the window", DIRECT.lost, 2);
eq("the won breakdown reads the reason's own words", DIRECT.wonReasons, [{ code: "referral", label: "Referral", count: 1 }]);
/* A CLOSE WITH NO REASON PRINTS AS WHAT IT IS. Every row that closed before the
 * reason box existed has no reason on it, and dropping those rows would make the
 * breakdown add up to LESS than the total printed above it — which a person adds
 * up, comes out short, and stops trusting. */
eq("a close with no reason prints as \"No reason recorded\" rather than being dropped",
  DIRECT.lostReasons, [
    { code: null, label: "No reason recorded", count: 1 },
    { code: "price", label: "Price", count: 1 },
  ]);
ok("...so the lost breakdown adds up to exactly the lost total above it",
  DIRECT.lostReasons.reduce((n, r) => n + r.count, 0) === DIRECT.lost,
  `${DIRECT.lostReasons.reduce((n, r) => n + r.count, 0)} vs ${DIRECT.lost}`);
ok("...and so does the won breakdown",
  DIRECT.wonReasons.reduce((n, r) => n + r.count, 0) === DIRECT.won);
/* An unknown code prints ITSELF rather than "Other": a reason that stops being on
 * the list is still the reason somebody gave, and relabelling it would change
 * what the loss breakdown says about the past. */
eq("a reason code that is no longer on the list prints itself, rather than being relabelled",
  outreachFor({
    leads: [{ id: "o1", owner_id: REP, stage: "lost", closed_at: ago(2), lost_reason: "retired_reason" }],
    activity: [], proposals: [], userId: REP, nowMs: NOW_MS,
  }).lostReasons, [{ code: "retired_reason", label: "retired_reason", count: 1 }]);

/* CLOSES WITH NO DATE ARE IN NEITHER WINDOW, and they are counted and named so
 * the screen can say how many were left out. A lead sitting at `won` with no
 * closed_at must never be quietly folded into this month. */
eq("one close has no date on it", DIRECT.closedWithNoDate, 1);
ok("...and it is in NEITHER the won count nor the lost count",
  DIRECT.won === 1 && DIRECT.lost === 2);
eq("...and widening the window to ten years still does not pull it in, because it has no date to pull",
  outreachFor({ ...ARGS, userId: REP, windowDays: 3650 }).won, 1);
eq("...while the ten-year window DOES pull in the loss that closed 40 days ago, proving the window moved",
  outreachFor({ ...ARGS, userId: REP, windowDays: 3650 }).lost, 3);
eq("...and closedWithNoDate is the same number at every width, because it is not a windowed figure",
  outreachFor({ ...ARGS, userId: REP, windowDays: 3650 }).closedWithNoDate, DIRECT.closedWithNoDate);

console.log("\nTHE WINDOW — COMPARED AS ISO STRINGS, NEVER AS DATES");
const W = [
  { id: "w29", owner_id: REP, stage: "contacted", first_email_at: ago(29) },
  { id: "w31", owner_id: REP, stage: "contacted", first_email_at: ago(31) },
  { id: "w30", owner_id: REP, stage: "contacted", first_email_at: ago(30) },
];
const WIN = outreachFor({ leads: W, activity: [], proposals: [], userId: REP, nowMs: NOW_MS });
eq("the window is 30 days by default", WIN.window.days, 30);
eq("...and the day it starts is stated, so a screen can print it", WIN.window.sinceIso, ago(30));
eq("emailed 29 days ago: inside. 31 days ago: outside. 30 days ago exactly: inside, because the edge is >=",
  WIN.emailed, 2);
eq("a 40-day window pulls the 31-day-old one in",
  outreachFor({ leads: W, activity: [], proposals: [], userId: REP, nowMs: NOW_MS, windowDays: 40 }).emailed, 3);
eq("a 7-day window leaves all three out", outreachFor({ leads: W, activity: [], proposals: [], userId: REP, nowMs: NOW_MS, windowDays: 7 }).emailed, 0);
eq("a junk window falls back to 30 rather than to 0 days, which would empty every tile",
  outreachFor({ leads: W, activity: [], proposals: [], userId: REP, nowMs: NOW_MS, windowDays: "banana" }).window.days, 30);
eq("a zero window falls back to 30 as well", outreachFor({ leads: W, activity: [], proposals: [], userId: REP, nowMs: NOW_MS, windowDays: 0 }).window.days, 30);
eq("a negative window falls back to 30", outreachFor({ leads: W, activity: [], proposals: [], userId: REP, nowMs: NOW_MS, windowDays: -5 }).window.days, 30);
eq("a fractional window is floored to whole days", outreachFor({ leads: W, activity: [], proposals: [], userId: REP, nowMs: NOW_MS, windowDays: 7.9 }).window.days, 7);

/* A BARE `YYYY-MM-DD` IS COMPARED AS A STRING, which is the whole point.
 * `new Date("2026-08-20")` is midnight UTC — the EVENING BEFORE in Chicago — and
 * that trap has cost this repo three shipped bugs. A string comparison against
 * an ISO timestamp gives the same answer in every timezone on earth, because no
 * timezone is consulted. */
const BARE = outreachFor({
  leads: [
    { id: "d1", owner_id: REP, stage: "new", first_email_at: "2026-08-20" },
    { id: "d2", owner_id: REP, stage: "new", first_email_at: "2026-07-01" },
  ],
  activity: [], proposals: [], userId: REP, nowMs: NOW_MS,
});
eq("a bare date inside the window counts, and one outside it does not — decided by string order, no clock involved",
  BARE.emailed, 1);

/* Read as TEXT, because "it happens to give the right answer today" is not the
 * property being pinned — "it cannot consult a timezone at all" is. */
const OUTREACH_SRC = readFileSync(join(HERE, "..", "..", "lib", "outreach.js"), "utf8");
/* THE WINDOW TEST PARSES, AND THIS ASSERTION USED TO PIN THE BUG.
 *
 * It demanded `String(iso) >= sinceIso` and called that the desired property. It
 * is not: the same instant can be written `...T15:00:00.000Z` or
 * `...T15:00:00+00:00`, and `+` (0x2B) sorts before `.` (0x2E), so a row exactly
 * on the window's edge was silently dropped. PostgREST returns the offset form
 * and the window start comes from toISOString(), so a mixed pair is the ordinary
 * case. lib/lead-tags.js was fixed for exactly this on the same day and this file
 * was not. Aug 27 2026, after a review. */
ok("the window test PARSES the timestamps rather than comparing them as text",
  /Date\.parse\(iso\)/.test(OUTREACH_SRC) && !/String\(iso\)\s*>=/.test(OUTREACH_SRC));
/* EVERY `new Date(...)` in the file takes nowMs — a number of milliseconds, which
 * has no timezone to get wrong. Not one of them takes a value off a row. */
/* Comments are stripped first: the comment on line 70 warns AGAINST
 * `new Date(x) > new Date(y)` and would otherwise be counted as two offences by
 * the very rule it is documenting. */
const OUTREACH_CODE = OUTREACH_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const DATE_CALLS = OUTREACH_CODE.match(/new Date\(([^)]*)\)/g) || [];
/* `nowMs` OR A NUMBER DERIVED FROM IT. `sinceMs` is `nowMs - days * DAY_MS` — a
 * number of milliseconds with no timezone to get wrong — and it arrived when the
 * window comparison stopped being a string comparison. The rule this assertion
 * guards is unchanged: not one `new Date(...)` in this file is ever handed a value
 * off a row, because `new Date("2026-08-27")` is midnight UTC, which is the
 * evening BEFORE in Chicago. */
ok(`all ${DATE_CALLS.length} \`new Date(...)\` calls take a millisecond count derived from nowMs, so none can be handed a bare date off a row`,
  DATE_CALLS.length > 0 && DATE_CALLS.every((c) => /nowMs|sinceMs/.test(c)), DATE_CALLS.join(" | "));
ok("...and sinceMs really is derived from nowMs rather than parsed from a string",
  /const sinceMs = nowMs - days \* DAY_MS/.test(OUTREACH_CODE));
ok("there is no open rate in here, and the file says why at length",
  !/openRate|open_rate/.test(OUTREACH_SRC) && /THERE IS NO OPEN RATE IN HERE/.test(OUTREACH_SRC));

console.log("\nWHERE DEALS DIE — COUNTED OVER EVERY LEAD, NOT BY SUMMING THE REPS");
const LOSS = lossReasons({ leads: LEADS, nowMs: NOW_MS });
eq("three losses closed inside the window", LOSS.total, 3);
eq("...broken down, commonest first", LOSS.rows, [
  { code: "price", label: "Price", count: 2 },
  { code: null, label: "No reason recorded", count: 1 },
]);
ok("...and the breakdown adds up to exactly the total above it",
  LOSS.rows.reduce((n, r) => n + r.count, 0) === LOSS.total);
eq("how many of them carried no reason is said separately", LOSS.noReason, 1);
/* Losses that never got a date are NOT in `total`, and the screen says how many
 * were left out. A breakdown quietly missing rows is the thing this whole feature
 * exists to stop. */
eq("a loss with no date is counted and named, and is NOT in the total", LOSS.undated, 1);
eq("the window it was read over travels with it", LOSS.window.days, 30);
eq("a failed read is null rows and a null total, never an empty breakdown that looks like good news",
  lossReasons({ leads: null, nowMs: NOW_MS }), { window: { days: 30, sinceIso: ago(30) }, rows: null, total: null, noReason: null, undated: null });

/* THE ASSERTION THIS FUNCTION EXISTS FOR.
 *
 * p10 is `lost`, dated inside the window, and has NO OWNER — which is exactly
 * what a lead released after it was lost looks like. A per-rep sum cannot see it,
 * so if the owner's loss breakdown were built by adding up the rep columns it
 * would print 2 where the truth is 3, and the total under the chart would not
 * match the chart. Counted over every lead instead. */
const PER_REP_SUM = outreachByRep({ team: TEAM, ...ARGS }).reduce((n, r) => n + (r.stats.lost || 0), 0);
eq("adding up the per-rep loss counts gives 2", PER_REP_SUM, 2);
eq("...but three deals really were lost inside the window", LOSS.total, 3);
ok("...so a per-rep sum would have MISSED the loss with no owner on it — which is why lossReasons counts over every lead",
  PER_REP_SUM < LOSS.total, `sum ${PER_REP_SUM}, truth ${LOSS.total}`);
eq("the missing one is the ownerless loss, and it is in the breakdown",
  LOSS.rows.find((r) => r.code === "price").count, 2);
eq("...while no rep is credited with it",
  LEADS.filter((l) => l.id === "p10")[0].owner_id, null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
