/* THE RULES OF ENGAGEMENT, as code.
 *
 * CJ's outreach sheet has a "Rules of Engagement" tab. It is a complete sales
 * system in writing — claim before you touch, one firm one rep, first contact
 * in three business days, fourteen days cold and it reopens, score the site
 * before you pitch, five touches over two weeks, one text and only to a warm
 * open. A spreadsheet cannot enforce a single one of those, so none of them
 * happen reliably. This file is that tab turned into functions.
 *
 * WHY IT IS PURE
 * No imports, no database, no fetch, no clock of its own — `now` is always
 * passed in. Three callers need the same answers and must never disagree:
 *   · the Sales page, deciding what a rep is shown today,
 *   · api/sales-sweep.js, deciding overnight what has gone cold,
 *   · tests/sales/test.mjs, pinning every rule against a fixed clock.
 * A rule computed twice is a rule that eventually gives two answers, and a rep
 * who is told two different things about the same firm stops believing both.
 *
 * WHAT CHANGED FROM THE SHEET, AND WHY (Ryder, Aug 21 2026)
 * The sheet's rule 2 says a claimed firm is off limits. Ryder's call is that
 * reps do not step on each other, so nothing here LOCKS anybody out. Every
 * claim rule below produces a WARNING a person reads, not a wall. The timers
 * still run and still hand a cold firm back to the floor — that part is about
 * leads going stale, not about trust.
 */

/* ------------------------------------------------------------------ */
/* The numbers from the sheet, in one place                            */
/* ------------------------------------------------------------------ */

export const ROE = {
  /** Claim, then make first contact inside this many BUSINESS days or the
   * claim drops. The sheet says three. */
  FIRST_CONTACT_BUSINESS_DAYS: 3,
  /** No update for this many calendar days and the firm reopens to the floor. */
  COLD_REOPEN_DAYS: 14,
  /** Warn this many days before EITHER of the above actually fires — the same
   * number for both, so changing it moves both timers by the same amount.
   * (It did not, briefly: the cold path used `WARN + 1`, so this constant meant
   * two days on one timer and three on the other.) It must stay BELOW
   * FIRST_CONTACT_BUSINESS_DAYS, or a claim would be warned about the moment it
   * was made. Nothing is ever taken away silently — see the note at the bottom
   * of this file. */
  WARN_DAYS_BEFORE: 2,
  /** Site score at or above this = not a prospect. They are already doing well. */
  SKIP_SCORE_AT_OR_ABOVE: 90,
  /** One text. One. And only after a tracked open. */
  MAX_TEXTS: 1,
};

/** The 5-touch cadence, exactly as the sheet writes it.
 * `day` is days after the claim, not after the previous step. */
export const CADENCE = [
  { n: 1, day: 1, kind: "email", label: "Email #1", hint: "Personalised. Reference their score or a real finding." },
  { n: 2, day: 3, kind: "email", label: "Follow-up", hint: "A NEW angle. Never “just bumping this”." },
  { n: 3, day: 6, kind: "email", label: "Email #3", hint: "Third angle. Still short." },
  { n: 4, day: 9, kind: "call", label: "Call or LinkedIn", hint: "Pick up the phone, or connect on LinkedIn." },
  { n: 5, day: 14, kind: "email", label: "Breakup email", hint: "Last one. Then set the status and move on." },
];

/** The 7 moves every strong cold touch hits, in order. Straight off the sheet. */
export const SEVEN_MOVES = [
  { n: 1, name: "Pattern interrupt", body: "Open with something unexpected. Never “Hope you're doing well.”" },
  { n: 2, name: "Earned compliment + but", body: "One specific true thing about their firm, then the gap." },
  { n: 3, name: "Name the category", body: "They are invisible in AI search. Ask ChatGPT “best <trade> in <city>” and they do not come up. That is GEO." },
  { n: 4, name: "Low-friction promise", body: "One small concrete thing you will show them." },
  { n: 5, name: "Scarcity", body: "One client per market. We only take one firm per territory." },
  { n: 6, name: "Proof of homework", body: "Cite a real finding. Screenshot who showed up INSTEAD of them." },
  { n: 7, name: "Micro-commitment CTA", body: "Ask for a tiny yes, not a 30-minute call." },
];

/* ------------------------------------------------------------------ */
/* Stages                                                              */
/* ------------------------------------------------------------------ */

/** Stages that mean nobody should be chasing this row any more. `skip_90` and
 * `bad_contact` are in here on purpose: they are not failures, but a rep who
 * keeps being nagged about a firm they were told to skip stops reading the
 * nags. The old code used a bare ["won","lost"] in four places — this is the
 * one list now. */
/* `not_a_fit` is here BEFORE migration 0027 creates it, on purpose. Without it,
 * every lead the migration merges comes back as an OPEN stage the moment it
 * runs — back on the cadence, back in My Day, back in every count — and nothing
 * would say why. A closed stage the database cannot hold yet is harmless; an
 * open one it can is not. Found by a checker, 30 Aug 2026. */
export const CLOSED_STAGES = ["won", "lost", "skip_90", "bad_contact", "not_a_fit"];

export function isOpenStage(stage) {
  return !CLOSED_STAGES.includes(stage);
}

/* ------------------------------------------------------------------ */
/* Days, counted the way a person counts them                          */
/* ------------------------------------------------------------------ */

/* Everything below counts days in America/Chicago, not UTC. A touch logged at
 * 8pm Central is 2am UTC the NEXT day, so a UTC count says a rep who called
 * last night has not called for a day.
 *
 * A FIXED OFFSET IS NOT GOOD ENOUGH, and the first version of this file used
 * one. Chicago is UTC-5 in summer and UTC-6 in winter, so a hardcoded -5 makes
 * every 11pm-to-midnight timestamp between early November and early March land
 * on the wrong day: a call logged at 11:30pm on 15 January read as the 16th,
 * which quietly buys a lead an extra day of the fourteen. The test suite could
 * never catch it because its fixed clock is in August. Ask the platform for the
 * real offset instead — Intl knows about daylight saving, and it is built into
 * both the browser and Node. */
export const TZ = "America/Chicago";

const dayParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

/** An ISO timestamp → the local calendar day as a number, so two timestamps on
 * the same local day are the same number no matter the hour or the season. */
export function localDayNumber(iso) {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  // "2026-01-15" in Chicago, whatever the UTC date is. Parsed back as UTC
  // midnight purely to turn it into a day count that can be subtracted.
  const [y, m, d] = dayParts.format(new Date(t)).split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Whole local days between two timestamps. Null if either is unreadable —
 * never 0, and never a number derived from `|| 0`. That trick reads a null
 * date as the year 2000, which then wins every oldest-first sort. */
export function daysBetween(fromIso, toIso) {
  const a = localDayNumber(fromIso);
  const b = localDayNumber(toIso);
  if (a === null || b === null) return null;
  return b - a;
}

/** Business days between two timestamps, counting Mon–Fri only.
 * Day 0 is the claim day itself; a claim made Friday is not late on Monday. */
export function businessDaysBetween(fromIso, toIso) {
  const a = localDayNumber(fromIso);
  const b = localDayNumber(toIso);
  if (a === null || b === null) return null;
  if (b <= a) return 0;
  let count = 0;
  for (let d = a + 1; d <= b; d += 1) {
    // Day number 0 is 1 Jan 1970, a Thursday. +4 puts Sunday at 0.
    const dow = (((d + 4) % 7) + 7) % 7;
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* The claim                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where a claim stands right now.
 *
 * Returns one of:
 *   unclaimed        — nobody's. Anybody can take it.
 *   first_contact    — claimed, no first contact yet, still inside the 3 days.
 *   first_contact_due— claimed, no first contact, the 3 days run out today or
 *                      tomorrow (WARN_DAYS_BEFORE).
 *   claim_expired    — claimed, no first contact, past 3 business days. The
 *                      sweep will hand it back.
 *   working          — claimed and touched, comfortably inside 14 days.
 *   going_cold       — claimed and touched, but the 14 days run out soon.
 *   cold             — claimed and touched, past 14 days. The sweep will hand
 *                      it back.
 *   closed           — a stage nobody should be chasing.
 *
 * `over` is how many days PAST the line it is (negative = days still left), so
 * one number sorts every card on the page.
 */
export function claimState(lead, now) {
  const nowIso = typeof now === "string" ? now : new Date(now).toISOString();

  if (!isOpenStage(lead.stage)) {
    return { state: "closed", over: null, owner: lead.owner_id || null, why: "Nobody is chasing this any more." };
  }
  if (!lead.owner_id) {
    return { state: "unclaimed", over: null, owner: null, why: "Nobody has claimed this yet." };
  }

  const claimedAt = lead.claimed_at || lead.created_at || null;
  /* THE CURRENT CLAIM's first touch, not the relationship's.
   *
   * Reading `first_contact_at` here was wrong in a way that only showed up on
   * a recycled lead: a firm first emailed in July, released in August and
   * re-claimed still had July's date, so the 3-day window read as satisfied
   * forever. Clearing the July date to fix that deleted the real one and took
   * the lead out of the speed-to-first-contact sample. Two columns, two
   * questions — see migration 0009. */
  const firstContact = lead.claim_contacted_at || null;

  if (!firstContact) {
    const used = businessDaysBetween(claimedAt, nowIso);
    if (used === null) {
      // A claim with no readable date cannot be timed. Say so rather than
      // guessing a number and quietly dropping somebody's firm.
      return { state: "working", over: null, owner: lead.owner_id, why: "Claimed, but the claim date could not be read." };
    }
    const left = ROE.FIRST_CONTACT_BUSINESS_DAYS - used;
    if (left <= 0) {
      return {
        state: "claim_expired", over: -left, owner: lead.owner_id,
        why: `Claimed ${used} business days ago with no first contact logged. The claim has run out.`,
      };
    }
    if (left <= ROE.WARN_DAYS_BEFORE) {
      return {
        state: "first_contact_due", over: -left, owner: lead.owner_id,
        why: `First contact is due in ${left} business day${left === 1 ? "" : "s"} or the claim drops.`,
      };
    }
    return {
      state: "first_contact", over: -left, owner: lead.owner_id,
      why: `First contact due within ${left} business days.`,
    };
  }

  /* The cold clock runs from the LATER of the last touch and the claim.
   *
   * Measuring from the last touch alone meant re-claiming a lead somebody
   * worked in June was instantly "52 days with no update": the rep claimed it
   * at 9am and the overnight sweep took it back, every night, forever. A new
   * claim is a new clock, and taking the later of the two says that without
   * having to erase anything. */
  const touched = lead.last_touch_at || lead.last_activity_at || firstContact;
  const since = (claimedAt && touched && claimedAt > touched) ? claimedAt : (touched || claimedAt);
  const quiet = daysBetween(since, nowIso);
  if (quiet === null) {
    return { state: "working", over: null, owner: lead.owner_id, why: "Being worked. The last-touch date could not be read." };
  }
  const left = ROE.COLD_REOPEN_DAYS - quiet;
  if (left <= 0) {
    return {
      state: "cold", over: -left, owner: lead.owner_id,
      why: `${quiet} days with no update. This reopens to the floor.`,
    };
  }
  if (left <= ROE.WARN_DAYS_BEFORE) {
    return {
      state: "going_cold", over: -left, owner: lead.owner_id,
      why: `${quiet} days quiet. It reopens in ${left} day${left === 1 ? "" : "s"} unless you log something.`,
    };
  }
  return { state: "working", over: -left, owner: lead.owner_id, why: `Last touched ${quiet} day${quiet === 1 ? "" : "s"} ago.` };
}

/** Claims the overnight sweep should actually hand back. Deliberately the two
 * hard states only — a warning is not a reason to take somebody's firm. */
export function shouldReopen(lead, now) {
  const s = claimState(lead, now);
  return s.state === "claim_expired" || s.state === "cold";
}

/* ------------------------------------------------------------------ */
/* The cadence                                                         */
/* ------------------------------------------------------------------ */

/**
 * Which touch is owed on this lead right now.
 *
 * The cadence starts at the CLAIM, because that is what the sheet says: claim
 * it, then Day 1 is your first email. A lead with no claim has no cadence —
 * that is not a gap, it is the point. Nobody owes a touch on a firm nobody
 * has taken.
 *
 * `done` is how many steps have been logged, counted from real activity rows
 * rather than a counter somebody could forget to bump.
 */
/** Why a cadence is not running, in the words the screen prints. One place, so
 *  the drawer, My Day and the queue cannot come to say three different things
 *  about the same silent lead. */
export const CADENCE_STOPS = {
  unclaimed: "Nobody has claimed this one, so nothing is owed on it.",
  closed: "This one is finished with. Nothing is owed on it.",
  replied: "They wrote back — the sequence stopped there. Answer them, do not run the next step.",
  bounced: "The address bounced, so nothing more can be sent to it. Find another way in or mark it Not a fit.",
  undated: "The claim date could not be read, so no step can be worked out.",
};

export function cadenceState(lead, now, touchCount) {
  /* `touchCount` is every call/email/text/LinkedIn row on the timeline. The
   * table has no direction column, so an INBOUND email logged by hand counts as
   * a completed step. That is a real limit and it is written down rather than
   * described away: "outbound only" would need a column that does not exist. */
  const off = (stop) => ({ active: false, step: null, done: 0, over: null, finished: false, stop });
  if (!lead.owner_id) return off("unclaimed");
  if (!isOpenStage(lead.stage)) return off("closed");

  /* ---- A REPLY STOPS THE SEQUENCE — 30 Aug 2026 ----
   *
   * Every outreach tool does this and Attio will not let you switch it off.
   * Ours did not, so a lead who answered on Tuesday still had "Email #3 — day 6"
   * owed against them, and the honest name for the message that produces is
   * "just bumping this".
   *
   * BEFORE the touch count, on purpose. Counting steps first would let a lead
   * who replied after two emails still show step 3 as due — the reply has to
   * beat the schedule, not be ranked against it.
   *
   * A CADENCE IS NOT A FOLLOW-UP. Stopping this does not mean stopping work: the
   * lead keeps its claim, keeps its cold clock, and the "and next?" date is what
   * carries it from here. What stops is the pre-written sequence, which is the
   * only thing that was ever automatic about it. */
  if (lead.first_reply_at) return off("replied");
  /* A hard bounce stops it for the same reason with less ambiguity: there is
   * nowhere left to send. See canEmail() below — the sheet's and the drawer's
   * email buttons read it, and so does the Contacted? picker. */
  if (lead.bounced_at) return off("bounced");
  const startedAt = lead.cadence_started_at || lead.claimed_at || lead.created_at || null;
  const age = daysBetween(startedAt, typeof now === "string" ? now : new Date(now).toISOString());
  if (age === null) return off("undated");

  const done = Number.isFinite(touchCount) ? touchCount : 0;
  if (done >= CADENCE.length) {
    return { active: true, step: null, done, over: null, finished: true, stop: null };
  }
  const step = CADENCE[done];
  return {
    active: true,
    stop: null,
    step,
    done,
    /* Above zero = the step is late by that many days. The sheet's schedule is
     * a floor, not a ceiling: doing step 2 on day 4 is fine, skipping it is not. */
    over: age - step.day,
    finished: false,
  };
}

/**
 * WHEN THE NEXT TOUCH IS DUE, as a YYYY-MM-DD date — 2 Sep 2026.
 *
 * Ryder: "when an email is sent and logged, the follow up on day 3 gets a
 * reminder set for on the 3rd day to follow up?"
 *
 * The cadence already knew this — the record has said "Follow-up — day 3 · 3
 * days from now" since it was built — and it was the one number a rep still had
 * to work out and type. Now the box that asks "when do you pick this back up?"
 * opens with that day already chosen, and they can change it.
 *
 * READ FROM THE SAME cadenceState THE SCREEN DRAWS, and given the touch count
 * AFTER the one just logged, because the question is what comes NEXT. A second
 * calculation of "day 3" would be a second answer.
 *
 * NEVER IN THE PAST, and never today: a follow-up owed before the email has
 * landed is a follow-up nobody can do, and a date in the past reads as OVERDUE
 * everywhere. A late cadence rolls forward to tomorrow instead.
 *
 * Returns null when there is nothing to schedule — the cadence is finished, or
 * stopped because they replied — rather than inventing a date to fill the box.
 */
export function nextCadenceDate(lead, touchCountAfter, now = Date.now()) {
  /* `cadenceState(lead, now, touchCount)` — that argument order, not the one
   * that reads more naturally. Getting it wrong returns a stopped cadence and
   * therefore null, which looks exactly like "nothing to schedule". */
  const nowMs = typeof now === "string" ? Date.parse(now) : now;
  const st = cadenceState(lead, nowMs, touchCountAfter);
  if (!st.active || st.finished || !st.step) return null;

  /* THE SAME THREE COLUMNS, IN THE SAME ORDER, AS cadenceState ABOVE —
   * `created_at` included. It was missing here, so a lead with an owner and no
   * claim date got `NaN` and fell through to "now + step.day": the record said
   * "day 3 · 10 days late" while this prefilled a date next week. 2 Sep 2026,
   * found by an adversarial checker. If one of these lists changes, both
   * change. */
  const started = lead?.cadence_started_at || lead?.claimed_at || lead?.created_at || null;
  const base = Date.parse(started || "");
  const due = (Number.isFinite(base) ? base : nowMs) + st.step.day * 86400000;
  const tomorrow = nowMs + 86400000;

  /* LOCAL date parts, never `toISOString().slice(0,10)` — that shifts the day
   * for anybody behind UTC, and this repo has shipped that bug before. */
  const d = new Date(Math.max(due, tomorrow));
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* The two gates                                                       */
/* ------------------------------------------------------------------ */

/**
 * The score gate. "90 or above = NOT a prospect."
 *
 * Returns `known: false` when nobody has run a score, which is the state the
 * sheet was permanently in — its Site Score column does not exist, so the gate
 * has never once been applied. An unknown score is never treated as a pass.
 */
export function scoreGate(score) {
  /* The empty string is checked separately because `Number("")` is 0, not NaN.
   * Without this line an empty score cell reads as a score of ZERO — the
   * widest possible gap — so a firm nobody has scored would be promoted to the
   * top of every rep's queue as the easiest sale on the list. */
  if (score === null || score === undefined || String(score).trim() === "" || !Number.isFinite(Number(score))) {
    return { known: false, skip: false, tone: "unknown", why: "No score yet. Run one before pitching." };
  }
  const n = Number(score);
  /* A score outside 0-100 is not a score. The database refuses one, but this
   * function is also handed numbers straight off a spreadsheet cell, and
   * `scoreGate(150)` reading as "skip" or `scoreGate(-5)` reading as "wide
   * open" are both confident wrong answers about a firm nobody has measured. */
  if (n < 0 || n > 100) {
    return { known: false, skip: false, tone: "unknown", why: `"${score}" is not a score between 0 and 100. Run one.` };
  }
  if (n >= ROE.SKIP_SCORE_AT_OR_ABOVE) {
    return { known: true, skip: true, score: n, tone: "skip", why: `Scores ${n}. At ${ROE.SKIP_SCORE_AT_OR_ABOVE}+ they are already doing well — not a prospect.` };
  }
  if (n >= 75) return { known: true, skip: false, score: n, tone: "thin", why: `Scores ${n}. A real gap, but not a wide one.` };
  if (n >= 50) return { known: true, skip: false, score: n, tone: "good", why: `Scores ${n}. A clear gap to point at.` };
  return { known: true, skip: false, score: n, tone: "wide", why: `Scores ${n}. Wide open — this is the easiest kind of conversation.` };
}

/**
 * The texting gate. "Send only if you KNOW they opened your email. Send ONE."
 *
 * Both halves are checked, and the reason is always in plain words, because a
 * disabled button with no reason reads as a broken button.
 */
/**
 * MAY WE EMAIL THIS CONTACT AT ALL — 30 Aug 2026.
 *
 * The sibling of textGate, and the answer to a column we have been writing and
 * never reading: `bounced_at` has been recorded since migration 0021 and has
 * changed exactly nothing. A dead address stayed in the cadence, stayed in the
 * queue, and got sent to again.
 *
 * A HARD BOUNCE SUPPRESSES UNTIL A PERSON CLEARS IT. That is what Attio does —
 * a hard bounce moves the address onto a list that blocks all future sending
 * until somebody takes it off by hand. Suppression that expires on its own is
 * not suppression; the whole point is that a human has to look.
 *
 * Fails CLOSED on a missing lead, and on a bounce date that cannot be read: an
 * unreadable date is a reason to stop, never a reason to send. That is the
 * opposite of textGate's counter, which fails closed for the same reason.
 *
 * WHAT CLEARS IT: putting a new address on the contact. That is a deliberate
 * decision by a person and it is the only thing that can honestly mean "there
 * is somewhere to send now". Nothing in the console clears `bounced_at` itself.
 */
export function canEmail(lead) {
  if (!lead) return { allowed: false, reason: "There is no contact here to email." };
  if (!lead.email) return { allowed: false, reason: "No email address on this contact." };
  if (lead.bounced_at) {
    const on = sheetDateSafe(lead.bounced_at);
    return {
      allowed: false,
      bounced: true,
      reason: `This address bounced${on ? ` on ${on}` : ""}. Nothing more can be sent to it — find another address, or mark them Not a fit.`,
    };
  }
  return { allowed: true, bounced: false, reason: "" };
}

/** A date for a sentence, or null. Local to this file so the pure rules do not
 *  reach into the sheet's formatting helpers and pick up its 90-day window
 *  wording along the way. */
function sheetDateSafe(v) {
  if (!v) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  return String(v).slice(0, 10);
}

export function textGate(lead) {
  const raw = lead.texts_sent;
  const sent = Number(raw ?? 0);
  /* An unreadable counter fails CLOSED. `NaN >= 1` is false, so the obvious
   * version let a corrupt value unlock unlimited texts — the one failure mode
   * this gate exists to prevent. */
  if (!Number.isFinite(sent) || sent < 0) {
    return { allowed: false, reason: "The text counter on this contact cannot be read, so texting is off until somebody looks at it." };
  }
  if (!lead.phone) return { allowed: false, reason: "No phone number on this contact." };
  /* THE GATE IS "THEY REPLIED", NOT "THEY OPENED" — Aug 27 2026.
   *
   * It read `email_opened_at`, and NOTHING HAS EVER WRITTEN THAT COLUMN. So this
   * function refused every text ever, the button has never once been usable, and
   * nobody knew. Migration 0021 moved the database's own copy of this gate to
   * `first_reply_at` and left this one behind — so for a few hours the rule was
   * live in the database and dead in the browser, which is the divergence this
   * repo has a memory note about. Found by the third review.
   *
   * A reply is a STRONGER signal than an open, not a weaker one: an open can be
   * an image proxy, and a reply is a person typing. See lib/outreach.js for why
   * an open is not measurable at all. */
  if (!lead.first_reply_at) {
    return { allowed: false, reason: "They have not written back yet. Texting somebody who has not replied gets our numbers flagged, so it is one text and only after a reply." };
  }
  if (sent >= ROE.MAX_TEXTS) {
    return { allowed: false, reason: `One text has already gone out${lead.last_text_at ? ` (${String(lead.last_text_at).slice(0, 10)})` : ""}. One is the limit — no sequences.` };
  }
  return { allowed: true, reason: "They opened an email. You get one text." };
}

/* ------------------------------------------------------------------ */
/* One firm, one rep — as a warning                                    */
/* ------------------------------------------------------------------ */

/**
 * Who else at this company is already being worked, and by whom.
 *
 * This is the software version of the sheet's loudest rule, and the version
 * the sheet could never manage: it knew rows, not firms, so four contacts at
 * ACME looked like four separate prospects and one claimed row left three
 * open. Nothing here blocks anybody (Ryder, Aug 21). It tells you, before you
 * send, that Larry is already in this building.
 */
export function companyClaimWarning(lead, siblings, teamName, now, viewerId = null) {
  /* Excluded: this contact, anything closed, anything nobody holds, and
   * anything held by the PERSON READING THE PAGE.
   *
   * Comparing against `lead.owner_id` alone was wrong on the case that matters
   * most: an UNCLAIMED contact has no owner, so a rep looking at a free contact
   * at a firm where they already hold three others was told "Larry is working
   * 3 contacts here" — by name, about themselves. `viewerId` is what makes the
   * warning about somebody else. */
  const mine = viewerId ?? lead.owner_id ?? null;
  const others = (siblings || []).filter(
    (s) => s.id !== lead.id && s.owner_id && s.owner_id !== mine
      && s.owner_id !== lead.owner_id && isOpenStage(s.stage)
  );
  if (!others.length) return null;
  const byOwner = new Map();
  for (const s of others) {
    const cur = byOwner.get(s.owner_id);
    const touched = s.last_touch_at || s.last_activity_at || null;
    if (!cur || (touched && (!cur.touched || touched > cur.touched))) {
      byOwner.set(s.owner_id, { owner_id: s.owner_id, touched, count: (cur?.count || 0) + 1 });
    } else {
      cur.count += 1;
    }
  }
  const list = [...byOwner.values()].map((o) => {
    const quiet = o.touched ? daysBetween(o.touched, typeof now === "string" ? now : new Date(now).toISOString()) : null;
    return {
      owner_id: o.owner_id,
      name: teamName ? teamName(o.owner_id) : "another rep",
      contacts: o.count,
      last_touch: o.touched,
      quiet_days: quiet,
    };
  });
  return {
    reps: list,
    /* Written as one sentence a person can act on, not a data dump. */
    line: list.map((r) =>
      `${r.name} is working ${r.contacts} contact${r.contacts === 1 ? "" : "s"} here` +
      (r.quiet_days === null ? " (nothing logged yet)" : r.quiet_days === 0 ? " — touched today" : ` — last touched ${r.quiet_days}d ago`)
    ).join(". ") + ".",
  };
}

/* ------------------------------------------------------------------ */
/* What a rep is shown, in the order they should work it               */
/* ------------------------------------------------------------------ */

const REASON_RANK = {
  /* A REPLY OUTRANKS EVERYTHING — 30 Aug 2026.
   *
   * It was not on this list at all, which meant the single most valuable thing
   * that can happen to a lead produced no card. A person typed a message to us;
   * nothing else in a rep's day is worth more, and it is also the one that goes
   * stale fastest. It sits above an expired claim on purpose: a claim running
   * out costs us a lead we had not started, and a reply left for three days
   * costs us one we had. */
  replied: 0,
  claim_expired: 1,
  first_contact_due: 2,
  cold: 3,
  going_cold: 4,
  touch_due: 5,
  unclaimed: 6,
};

/**
 * My Day. Every card carries WHY it is there and how late it is, because a
 * queue that will not say why it chose something is a queue people re-sort by
 * hand and then stop using.
 *
 * `touchCounts` maps lead id → how many call/email/text/LinkedIn rows a lead
 * has. See cadenceState for what that count can and cannot tell apart.
 *
 * "THEY REPLIED AND YOU HAVE NOT ANSWERED" IS HERE NOW — 30 Aug 2026, and this
 * block used to say the opposite. It said there was nowhere to read it from,
 * because `admin_lead_activity` has no direction column and nothing marked a
 * thread unanswered on the lead. An earlier draft had the branch and it was
 * pulled rather than left in looking finished.
 *
 * What changed is that `first_reply_at` is finally written: the Contacted? cell
 * has a "They replied" outcome, and the Inbox stamps it when a thread is read.
 * The card is ranked above everything else and disappears once
 * answeredAfterReply() is true.
 */
export function salesQueue(leads, { userId, now, touchCounts = {}, includeUnclaimed = true, scoreOf = () => null }) {
  const cards = [];
  const nowIso = typeof now === "string" ? now : new Date(now).toISOString();
  for (const lead of leads || []) {
    if (!isOpenStage(lead.stage)) continue;
    const mine = lead.owner_id === userId;
    if (!mine && lead.owner_id) continue;            // somebody else's — not in MY day
    if (!lead.owner_id && !includeUnclaimed) continue;

    const claim = claimState(lead, now);
    const gate = scoreGate(scoreOf(lead));

    /* THE 90+ GATE ONLY APPLIES BEFORE A CONVERSATION EXISTS.
     *
     * "90 or above = NOT a prospect" is a rule about who to SPEND A TOUCH ON,
     * not about who to abandon. Applying it to everybody dropped a lead who
     * was at proposal stage — a live deal with a number attached — off the
     * rep's day entirely, because somebody scored the firm's website after the
     * conversation had already started. Found by walking the built page and
     * noticing a lead that should have been there was not.
     *
     * So: a firm scoring 90+ is kept out of the pool and out of the early
     * stages, and left completely alone once a human is talking to a human. */
    /* "BEFORE A CONVERSATION EXISTS" IS A FACT, NOT A STAGE — 30 Aug 2026.
     *
     * This read `["new","researching"].includes(lead.stage)`. Those two stopped
     * being settable the same day (see PICKABLE_STAGES): nobody can move a lead
     * off `new` any more, so a lead being worked for a month would still have
     * counted as "before contact" and a 90+ firm mid-conversation would have
     * dropped out of the rep's day — the exact defect the comment above is
     * about, reintroduced by the stage list shrinking underneath it.
     *
     * `first_contact_at` is the honest test and always was. A trigger writes it
     * from a real logged touch (0009) and nothing can type over it. */
    const beforeContact = !lead.first_contact_at;
    /* THE REPLY IS CHECKED BEFORE THE SCORE GATE.
     *
     * It used to run after, and a checker found what that costs: a firm scoring
     * 92 that writes back, with no outbound touch logged yet, has no
     * first_contact_at — so the gate dropped it and the reply produced no card
     * at all. A person typed us a message and the screen said nothing. A reply
     * outranks everything means everything, including our own opinion of their
     * website. 30 Aug 2026 */
    const waitingOnUs = lead.first_reply_at && !answeredAfterReply(lead);
    if (gate.skip && beforeContact && !waitingOnUs) continue;

    if (!lead.owner_id) {
      cards.push({
        lead, reason: "unclaimed", rank: REASON_RANK.unclaimed, over: -999,
        headline: "Nobody has claimed this",
        detail: gate.known ? gate.why : "No score yet — run one before you pitch.",
        score: gate.known ? gate.score : null,
      });
      continue;
    }

    /* THEY WROTE BACK AND NOBODY HAS ANSWERED YET.
     *
     * Placed above every other card and BEFORE the claim checks, because a lead
     * who replied is not a claim problem — sorting it under "going cold" would
     * describe a person waiting on us as a lead we forgot to poke.
     *
     * "Nobody has answered yet" is the whole condition: a reply with a touch
     * logged after it has been handled, and the lead goes back to the ordinary
     * clocks. That is why this compares the two dates rather than just checking
     * that a reply exists — otherwise every replied lead would sit at the top of
     * the queue for ever. */
    if (lead.first_reply_at && !answeredAfterReply(lead)) {
      const waited = daysBetween(lead.first_reply_at, nowIso);
      cards.push({
        lead, reason: "replied", rank: REASON_RANK.replied,
        /* `over` sorts within the group and every other card uses "days past the
         * line", so a reply's line is the moment it arrived. Null days — an
         * unreadable date — sorts as 0 rather than dropping the card. */
        over: waited === null ? 0 : waited,
        headline: "They replied",
        detail: waited === null || waited <= 0
          ? "Answer them before anything else on this list."
          : `Waiting ${waited} day${waited === 1 ? "" : "s"} for an answer.`,
        score: gate.known ? gate.score : null,
      });
      continue;
    }

    if (claim.state === "claim_expired" || claim.state === "first_contact_due") {
      cards.push({
        lead, reason: claim.state, rank: REASON_RANK[claim.state], over: claim.over,
        headline: claim.state === "claim_expired" ? "Your claim has run out" : "First contact is due",
        detail: claim.why,
        score: gate.known ? gate.score : null,
      });
      continue;
    }

    if (claim.state === "cold" || claim.state === "going_cold") {
      cards.push({
        lead, reason: claim.state, rank: REASON_RANK[claim.state], over: claim.over,
        headline: claim.state === "cold" ? "This has gone cold" : "Going cold",
        detail: claim.why,
        score: gate.known ? gate.score : null,
      });
      continue;
    }

    const cad = cadenceState(lead, now, touchCounts[lead.id] || 0);
    if (cad.active && cad.step && cad.over >= 0) {
      cards.push({
        lead, reason: "touch_due", rank: REASON_RANK.touch_due, over: cad.over,
        headline: `${cad.step.label} is due`,
        detail: cad.step.hint,
        step: cad.step,
        score: gate.known ? gate.score : null,
      });
    }
  }

  return cards.sort((a, b) => (a.rank - b.rank) || (b.over - a.over));
}

/**
 * Has anybody touched this lead SINCE they wrote back?
 *
 * The whole difference between "they are waiting on us" and "we are in a
 * conversation". Without it, a lead that replied in June would sit at the top
 * of a rep's day for ever, and the one card that should mean "drop everything"
 * would become the card everybody learns to scroll past.
 *
 * Compares the reply against the LATER of the two touch stamps, because
 * `last_touch_at` moves only on a real call/email/text/LinkedIn row while
 * `last_activity_at` also moves on a note — and answering somebody by writing a
 * note about it still counts as having dealt with them.
 *
 * An unreadable date on either side returns FALSE, which keeps the card on
 * screen. A visible card about a lead nobody has answered is recoverable; a lead
 * silently dropped out of the queue is not.
 */
export function answeredAfterReply(lead) {
  const replied = Date.parse(lead?.first_reply_at);
  if (!Number.isFinite(replied)) return false;
  const touched = Math.max(
    Date.parse(lead?.last_touch_at) || 0,
    Date.parse(lead?.last_activity_at) || 0,
  );
  if (!touched) return false;
  return touched > replied;
}

/* ------------------------------------------------------------------ */
/* Numbers for the owners                                              */
/* ------------------------------------------------------------------ */

/**
 * Per-rep numbers CJ can act on. Speed-to-first-contact is the one the sheet
 * could never produce and the one that predicts everything else.
 *
 * Every figure here is COUNTED from rows. Nothing is estimated, and a rep with
 * no data gets nulls rather than zeros — "no meetings yet" and "we have not
 * measured" are different sentences and must not print the same.
 */
export function repStats(leads, activity, { userId, now }) {
  const mine = (leads || []).filter((l) => l.owner_id === userId);
  const acts = (activity || []).filter((a) => a.actor === userId);
  const open = mine.filter((l) => isOpenStage(l.stage));

  /* Measured on the CURRENT claim, so a lead somebody else worked last month
   * does not score this rep on a date they had nothing to do with. Falls back
   * to the relationship's first contact for rows that pre-date the split. */
  const speeds = mine
    .map((l) => {
      const contacted = l.claim_contacted_at || l.first_contact_at;
      return l.claimed_at && contacted ? businessDaysBetween(l.claimed_at, contacted) : null;
    })
    .filter((n) => n !== null && n >= 0);

  const claimsHeld = open.filter((l) => l.owner_id === userId);
  const atRisk = claimsHeld.filter((l) => ["claim_expired", "first_contact_due", "cold", "going_cold"].includes(claimState(l, now).state));

  return {
    userId,
    claimed: mine.length,
    open: open.length,
    calls: acts.filter((a) => a.type === "call").length,
    emails: acts.filter((a) => a.type === "email").length,
    texts: acts.filter((a) => a.type === "text").length,
    /* BOTH MEETING STAGES COUNT. This is a cumulative funnel — "got to a
     * meeting or past it" — so leaving meeting_complete out would show a rep
     * with four finished meetings as having had none. Migration 0030. */
    meetings: mine.filter((l) => ["meeting", "meeting_booked", "meeting_complete", "proposal", "won"].includes(l.stage)).length,
    proposals: mine.filter((l) => ["proposal", "won"].includes(l.stage)).length,
    won: mine.filter((l) => l.stage === "won").length,
    lost: mine.filter((l) => l.stage === "lost").length,
    /* null, not 0 — see the note above. */
    speed_days: speeds.length ? Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 10) / 10 : null,
    speed_sample: speeds.length,
    at_risk: atRisk.length,
    /* Close rate over DECIDED leads only. Counting open leads as losses makes
     * every new rep look terrible and every rep who stops working look great. */
    decided: mine.filter((l) => ["won", "lost"].includes(l.stage)).length,
    close_rate: (() => {
      const decided = mine.filter((l) => ["won", "lost"].includes(l.stage)).length;
      if (!decided) return null;
      return Math.round((mine.filter((l) => l.stage === "won").length / decided) * 100);
    })(),
  };
}

/** How much of a list has actually been worked. The question CJ asks first:
 * "did anybody touch the medspa list?" */
/** `scoreOf` is passed in because the score lives on the FIRM, not the person.
 * Reading `l.site_score` off a lead row — a column that does not exist on
 * admin_leads — made the "Site score run" bar read 0 of N, 0%, forever, no
 * matter how many firms had been scored. */
export function listHealth(leadRows, { now, scoreOf = () => null }) {
  const leads = leadRows || [];
  const total = leads.length;
  const claimed = leads.filter((l) => l.owner_id).length;
  const touched = leads.filter((l) => l.first_contact_at).length;
  const scored = leads.filter((l) => {
    const v = scoreOf(l);
    return v !== null && v !== undefined;
  }).length;
  const skipped = leads.filter((l) => l.stage === "skip_90").length;
  const open = leads.filter((l) => isOpenStage(l.stage)).length;
  const stale = leads.filter((l) => shouldReopen(l, now)).length;
  return {
    total, claimed, touched, scored, skipped, open, stale,
    untouched: total - touched,
    claimed_pct: total ? Math.round((claimed / total) * 100) : 0,
    touched_pct: total ? Math.round((touched / total) * 100) : 0,
    scored_pct: total ? Math.round((scored / total) * 100) : 0,
  };
}
/* ------------------------------------------------------------------ */
/* TAGS — the automatic ones                                           */
/* ------------------------------------------------------------------ */

/**
 * Aug 27 2026, Ryder. The Floor shows every lead in the company at once, so a
 * rep needs to be able to say "the medspas in Florida with no website that
 * nobody has touched" without reading 451 rows. Tags are how.
 *
 * WHY THE RULES LIVE IN THIS FILE. Same reason claimState() does: a rule computed
 * twice is a rule that eventually gives two answers, and everything that decides
 * what a lead's state IS has to be in one place.
 *
 * WHO CALLS IT TODAY: the Floor, through the per-lead "Bring the automatic tags
 * up to date" button, and the tests. An earlier version of this line named the
 * import and the overnight sweep as callers — neither is one. That is where these
 * rules belong and it is not where they are yet; see the note at the top of
 * lib/lead-tags.js. Corrected after a review, Aug 27 2026.
 *
 * NOTHING HERE READS A CLOCK. `now` is passed in, exactly like everything above.
 * Three date bugs shipped in this repo in one day from reading the clock inside
 * a rule, and all three were invisible from a Chicago browser at midday.
 *
 * WHAT A RULE RETURNS, AND WHY IT IS TWO SETS RATHER THAN ONE LIST.
 * `autoTagState()` hands back `want` (the tags that should be on, each with the
 * plain-words reason that goes on the dated line) and `owns` (every tag these
 * rules control for this lead). A tag in `owns` but not in `want` is one the
 * rules will TAKE OFF. That split is what lets a rule change its mind — a firm
 * that replies stops being `quiet` — without the rules being able to touch a tag
 * a person put on by hand.
 *
 * WHAT IS DELIBERATELY NOT A TAG: the firm's line of business and its state.
 * Both are real columns on admin_companies that arrive with the sheet, both are
 * their own filter on the Floor, and both are OPEN sets — a new vertical or a
 * new state would need a new row in the tag vocabulary, which only an admin may
 * write (0018). So an import by a rep would silently fail to tag half its rows.
 * A tag is a thing we decided about a lead. A vertical is a field somebody
 * typed. Filtering works the same either way; blending them does not.
 */

/** Every slug these rules know. Must match 0018_lead_tags.sql's seed exactly —
 *  tests/lead-tags reads both and fails if they drift. */
export const TAG = {
  NO_WEBSITE: "no-website",
  HAS_WEBSITE: "has-website",
  SIZE_SOLO: "size-solo",
  SIZE_SMALL: "size-small",
  SIZE_MID: "size-mid",
  SIZE_LARGE: "size-large",
  NEVER_TOUCHED: "never-touched",
  IMPORTED: "imported",
  UNSCANNED: "unscanned",
  SCORED_UNDER_60: "scored-under-60",
  SCORED_60S: "scored-60s",
  SCORED_80S: "scored-80s",
  SCORED_90_PLUS: "scored-90-plus",
  HOT: "hot",
  QUIET: "quiet",
  COLD: "cold",
  CLAIM_EXPIRING: "claim-expiring",
  BOUNCED: "bounced",
  SKIP_90: "skip-90",
  WON: "won",
  LOST: "lost",
};

export const TAG_SLUGS = Object.values(TAG);

/** Groups where exactly one tag may be on at a time. A lead cannot both have a
 *  website and not have one, and it cannot be in two score bands. */
export const EXCLUSIVE_TAG_GROUPS = {
  website: [TAG.NO_WEBSITE, TAG.HAS_WEBSITE],
  size: [TAG.SIZE_SOLO, TAG.SIZE_SMALL, TAG.SIZE_MID, TAG.SIZE_LARGE],
  score: [TAG.UNSCANNED, TAG.SCORED_UNDER_60, TAG.SCORED_60S, TAG.SCORED_80S, TAG.SCORED_90_PLUS],
};

/** Quiet is a warning, cold is the line. Cold is deliberately the SAME number
 *  as the reopen rule (ROE.COLD_REOPEN_DAYS) rather than a second constant, so
 *  a lead cannot be tagged cold on a different day from the one the sweep hands
 *  it back on. */
export const QUIET_AFTER_DAYS = 7;

/**
 * Which size band, from the head count on the firm.
 *
 * NO HEAD COUNT MEANS NO TAG, and that is the whole point of returning null
 * here. `Number(null)` is 0 and `Number("")` is 0, so the obvious version files
 * every firm the sheet has no head count for as a one-person business — which
 * is the band a rep pitches differently, so it is not a harmless default.
 */
export function sizeBandTag(employees) {
  if (employees === null || employees === undefined || String(employees).trim() === "") return null;
  const n = Number(employees);
  if (!Number.isFinite(n) || n < 1) return null;
  if (n <= 1) return TAG.SIZE_SOLO;
  if (n <= 10) return TAG.SIZE_SMALL;
  if (n <= 50) return TAG.SIZE_MID;
  return TAG.SIZE_LARGE;
}

/**
 * Which score band, through scoreGate() so that "what counts as a score" is
 * decided in exactly one place.
 *
 * An unknown score returns `unscanned` rather than null: "nobody has measured
 * this site" is a fact worth filtering on, and it is the tag that tells a rep
 * what to do first.
 */
export function scoreBandTag(score) {
  const g = scoreGate(score);
  if (!g.known) return TAG.UNSCANNED;
  if (g.score >= ROE.SKIP_SCORE_AT_OR_ABOVE) return TAG.SCORED_90_PLUS;
  if (g.score >= 80) return TAG.SCORED_80S;
  if (g.score >= 60) return TAG.SCORED_60S;
  return TAG.SCORED_UNDER_60;
}

/**
 * Every automatic tag for one lead, right now.
 *
 * Returns `{ want: Map<slug, why>, owns: Set<slug> }`. See the note at the top
 * of this section for why it is two sets.
 *
 * `company` is the firm record (the website, the head count and the score all
 * live there, not on the person). `touchCount` is how many call/email/text/
 * LinkedIn rows the lead has, the same number the cadence counts.
 */
export function autoTagState(lead, { company = null, touchCount = 0, now } = {}) {
  /* A MISSING OR UNREADABLE CLOCK REFUSES, IT DOES NOT THROW.
   *
   * `new Date(undefined).toISOString()` raises RangeError, so calling this
   * without `now` crashed rather than saying so — and every other date helper in
   * this file returns null on an unreadable input and explains itself. A rule
   * engine that throws inside a page load takes the whole screen down.
   *
   * With no readable clock the CLOCK-BASED tags are simply not decided: quiet,
   * cold and claim-expiring are left alone rather than guessed at. Everything
   * else here — the website, the size, the score band, replied, bounced and the
   * closed states — needs no clock and is still worked out. Found by an
   * adversarial review, Aug 27 2026. */
  const nowMs = typeof now === "string" ? Date.parse(now) : Number(new Date(now));
  const nowIso = Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null;
  const want = new Map();
  const owns = new Set();
  const own = (slug) => { if (slug) owns.add(slug); };
  const ownAll = (list) => { for (const s of list) own(s); };
  const set = (slug, why) => { if (!slug) return; own(slug); want.set(slug, why); };

  /* ---- the website ---- */
  ownAll(EXCLUSIVE_TAG_GROUPS.website);
  const domain = String(company?.domain || lead?.domain || "").trim();
  set(
    domain ? TAG.HAS_WEBSITE : TAG.NO_WEBSITE,
    domain ? `Website on file: ${domain}.` : "No website on file for this firm, so there is nothing to scan.",
  );

  /* ---- the head count ----
   * The group is only OWNED when the head count can be read. With no number,
   * these rules say nothing about size and leave whatever is there alone —
   * removing a size somebody set by hand because the sheet has a blank cell
   * would be the rules destroying better information than they have. */
  const size = sizeBandTag(company?.employees);
  if (size) {
    ownAll(EXCLUSIVE_TAG_GROUPS.size);
    set(size, `${company.employees} people at this firm, from the sheet.`);
  }

  /* ---- the score ---- */
  ownAll(EXCLUSIVE_TAG_GROUPS.score);
  const gate = scoreGate(company?.site_score);
  set(
    scoreBandTag(company?.site_score),
    gate.known
      ? `The firm's website scores ${gate.score}.`
      : "No website score has been run on this firm yet.",
  );

  /* ---- where it came from ----
   * Only owned when it IS an import. Owning it always would strip `imported`
   * off any lead somebody had tagged that way on purpose. */
  const source = String(lead?.source || "");
  if (["sheet", "import", "csv"].includes(source)) {
    own(TAG.IMPORTED);
    set(TAG.IMPORTED, `Came in from an import (source: ${source}).`);
  }

  /* ---- has anybody spoken to them ----
   * Both halves, because they answer different questions: `touchCount` is what
   * we can READ, `first_contact_at` is also written by the import from what the
   * sheet TOLD us. Either one means this is not an untouched lead. */
  own(TAG.NEVER_TOUCHED);
  const touched = Number(touchCount) > 0 || Boolean(lead?.first_contact_at);
  /* OPEN LEADS ONLY. A deal closed off a referral with nothing logged is
   * literally never touched, and a "Never touched" chip sitting next to "Won"
   * reads as a data error rather than as a fact — and the tag exists to answer
   * "who has nobody started on", which a finished lead is not. It stays OWNED, so
   * closing a lead takes the tag off. Found by a reviewer, Aug 27 2026. */
  if (!touched && isOpenStage(lead?.stage)) {
    set(TAG.NEVER_TOUCHED, "Nothing logged against this person, and no first-contact date on the record.");
  }

  /* ---- did they write back ---- */
  own(TAG.HOT);
  if (lead?.first_reply_at) set(TAG.HOT, "They have replied to us at least once.");

  /* ---- is the address dead ---- */
  own(TAG.BOUNCED);
  if (lead?.bounced_at) {
    set(TAG.BOUNCED, "An email to this address bounced, so it is out of the reply-rate maths.");
  }

  /* ---- the claim clock ----
   * All three are owned unconditionally, so closing a lead or handing it back
   * takes them off. Only computed for an OPEN lead somebody holds: nothing has
   * gone quiet if nobody has claimed it, and a Won lead is not going cold. */
  /* OWNED ONLY WHEN THERE IS A CLOCK TO DECIDE THEM WITH.
   *
   * `ownAll` sat OUTSIDE this guard, which meant the "no readable clock" branch
   * did not leave the three clock tags alone — it took every one of them OFF,
   * with an append-only timeline line reading "the rule that added it no longer
   * applies". Nothing had applied or stopped applying; we simply could not tell
   * the time. The comment above said "left alone rather than guessed at" and the
   * code did the opposite. The RangeError this fix removed was, in that one
   * respect, doing a better job. Found by the third review, Aug 27 2026. */
  if (nowIso) {
    /* OWNED WHENEVER THERE IS A CLOCK, decided only when there is also somebody
     * holding an open lead.
     *
     * The two conditions are NOT the same and putting them together broke a real
     * rule twice over. `ownAll` outside the clock check meant a missing clock
     * STRIPPED these three (with a dated line claiming a rule had stopped
     * applying, which had not happened). `ownAll` inside the full check meant
     * closing a lead or handing it back no longer took them off — a won lead kept
     * a "Gone quiet" chip for ever. Owning them needs only a readable clock;
     * wanting them needs an open lead somebody holds. Third review, Aug 27 2026. */
    ownAll([TAG.QUIET, TAG.COLD, TAG.CLAIM_EXPIRING]);
  }
  if (nowIso && lead?.owner_id && isOpenStage(lead?.stage)) {
    const since = lead.last_touch_at || lead.last_activity_at || lead.claim_contacted_at || lead.claimed_at || null;
    const quiet = daysBetween(since, nowIso);
    /* null, not zero. An unreadable date means we cannot say how long it has
     * been quiet, and tagging it `cold` on a guess hands somebody's firm back. */
    if (quiet !== null) {
      if (quiet >= ROE.COLD_REOPEN_DAYS) {
        set(TAG.COLD, `${quiet} days with no update, and a firm reopens to the floor at ${ROE.COLD_REOPEN_DAYS}.`);
      } else if (quiet >= QUIET_AFTER_DAYS) {
        set(TAG.QUIET, `${quiet} days with no update.`);
      }
    }
    const claim = claimState(lead, nowIso);
    if (["first_contact_due", "claim_expired"].includes(claim.state)) {
      set(TAG.CLAIM_EXPIRING, claim.why);
    }
  }

  /* ---- the finished states ---- */
  ownAll([TAG.SKIP_90, TAG.WON, TAG.LOST]);
  if (lead?.stage === "skip_90") {
    set(TAG.SKIP_90, "Parked as Skip — the firm is already doing well, so it is not a prospect.");
  }
  if (lead?.stage === "won") set(TAG.WON, "Marked Won.");
  if (lead?.stage === "lost") set(TAG.LOST, "Marked Lost.");

  return { want, owns };
}

/* ------------------------------------------------------------------ */
/* WON AND LOST NEED A REASON                                          */
/* ------------------------------------------------------------------ */

/**
 * Aug 27 2026, Ryder. Today no reason is asked for anywhere: `lost_reason` is a
 * real column and exactly ONE button writes it, hard-coded to "No reply after
 * the full cadence." Won records nothing at all. So the most useful sales
 * question there is — why are we losing — has no answer in this database.
 *
 * A DROPDOWN *AND* FREE TEXT, not one or the other. A dropdown can be counted
 * and a paragraph cannot; a paragraph carries the thing that is actually useful
 * and a dropdown never does. Both, or six months from now there are eleven rows
 * saying "no reply" and nothing that says what the emails looked like.
 *
 * TWO SEPARATE LISTS. "Price" is not a reason somebody said yes and "liked the
 * free mockup" is not a reason they said no. One shared list would produce a
 * loss breakdown with a Won reason in it.
 */

export const LOST_REASONS = [
  ["price", "Price"],
  ["no_budget", "No budget"],
  ["went_elsewhere", "Went with someone else"],
  ["no_reply", "No reply at all"],
  ["not_decision_maker", "Not the decision maker"],
  ["bad_timing", "Bad timing"],
  ["not_a_fit", "Not a fit"],
  ["has_agency", "Already has an agency"],
  ["other", "Other"],
];

export const WON_REASONS = [
  ["needed_leads", "They needed leads"],
  ["scared_by_score", "Scared by the score"],
  ["liked_mockup", "Liked the free mockup"],
  ["referral", "Referral"],
  ["other", "Other"],
];

/** The words for a stored reason code, whichever list it came from. An unknown
 *  code prints itself rather than "Other" — a reason that stops being on the
 *  list is still the reason somebody gave, and quietly relabelling it would
 *  change what the loss breakdown says about the past. */
export function reasonLabel(code) {
  const hit = [...LOST_REASONS, ...WON_REASONS].find(([v]) => v === code);
  return hit ? hit[1] : (code ? String(code) : null);
}

/** Long enough to stop "n/a" and "-". Short enough not to refuse a real answer.
 *
 * WAS 15, LOWERED TO 10 ON 2 SEP 2026. Ryder hit it live and read the greyed
 * button as broken. The bar was doing real damage as well as reading badly:
 * "price too high" is 14 characters and "no budget" is 9 — the first is exactly
 * the answer this box exists to collect, and it was being refused.
 *
 * The purpose was never a word count. It was to stop the two things a required
 * box gets filled with, and 10 still stops both. Anything longer is somebody
 * writing a real sentence, and this box cannot tell a thin one from a rich one
 * anyway — the note under checkCloseReason has said so since it was written. */
export const MIN_REASON_NOTE_CHARS = 10;

/**
 * May this close be saved? Returns `{ ok }` or `{ ok:false, error }`.
 *
 * IT REFUSES AN EMPTY REASON AND A NOTE TOO SHORT TO READ BACK. "n/a" and "-"
 * are the two things a required box gets filled with, and both are worse than no
 * box at all because they look like an answer in a report six months later.
 *
 * WHAT IT DOES NOT DO, said plainly rather than claimed away: the only test on
 * the note is its LENGTH. One fifteen-character word passes, and so does "n/a
 * n/a n/a n/a". A stricter rule was considered and dropped — anything that tries
 * to judge whether a sentence means something refuses real notes too, and a box
 * that rejects what somebody actually typed is a box they stop using. The length
 * is the floor, not a guarantee. An earlier version of this comment said "and a
 * one-word note", which was simply untrue.
 */
export function checkCloseReason({ kind, reason, note } = {}) {
  const list = kind === "won" ? WON_REASONS : LOST_REASONS;
  const codes = list.map(([v]) => v);
  const r = String(reason || "").trim();
  if (!r) {
    return { ok: false, error: `Pick a reason. Six months of these is how we find out what is actually going wrong.` };
  }
  if (!codes.includes(r)) {
    return { ok: false, error: `"${r}" is not one of the ${kind === "won" ? "Won" : "Lost"} reasons.` };
  }
  const n = String(note || "").trim();
  if (n.length < MIN_REASON_NOTE_CHARS) {
    return {
      ok: false,
      error: `Write what actually happened — at least ${MIN_REASON_NOTE_CHARS} characters. This is the part somebody reads back later.`,
    };
  }
  return { ok: true, reason: r, note: n };
}

/* ------------------------------------------------------------------ */
/* A PERSONAL AI RULE CARRIES NO FACTS                                 */
/* ------------------------------------------------------------------ */

/**
 * A rep's own AI rules set tone, length, format and sign-off. Never a fact and
 * never a number.
 *
 * THE REASON IS MECHANICAL, NOT STYLISTIC. The honesty gate works by checking
 * every number in a draft against the fact sheet the model was shown, and the
 * personal rules HAVE to be part of that fact sheet or the gate throws away
 * honest answers for using words it was never given. Which means a number typed
 * into a personal rule enters the pool the gate checks against. Type "our
 * clients see a 40% lift" into your own rules and the gate will let the AI write
 * it to a prospect, because as far as the gate can tell, we told it that. One
 * rep's sentence becomes a claim the agency made.
 *
 * SO: NO DIGITS AT ALL, anywhere in a personal rule.
 *
 * That is stricter than "no percentages" and it is deliberate. The alternative
 * — allow a single digit, refuse two in a row — lets "if their score is under 6,
 * name it" through, and a bare 6 in the pool is a number the model may then
 * attach to a firm. Nothing a tone rule needs to say requires a digit: length,
 * tone and subject-line style are fixed settings on the page rather than
 * sentences, and a phone number belongs in a Gmail signature where it is
 * attached to the mailbox that sends the mail, not in a rule that gets copied
 * into every draft.
 */
export const PERSONAL_RULE_MAX_CHARS = 2000;

export function checkPersonalRule(text) {
  const s = String(text ?? "").trim();
  if (!s) return { ok: false, error: "Write the rule first." };
  if (s.length > PERSONAL_RULE_MAX_CHARS) {
    return {
      ok: false,
      error: `That is ${s.length} characters and the limit is ${PERSONAL_RULE_MAX_CHARS}. A rule this long stops being a rule and starts pushing the facts out of the AI's reading.`,
    };
  }
  const digits = s.match(/[0-9]/g);
  if (digits) {
    return {
      ok: false,
      error: "A personal rule cannot contain a number. These rules set how the AI writes — tone, length, sign-off — and anything typed here is treated as something we told it, so a number in here can be repeated to a prospect as a measurement. Length is a setting above, not a sentence; a phone number belongs in your Gmail signature.",
    };
  }
  return { ok: true, text: s };
}


/* ------------------------------------------------------------------ */
/* WHY EVERY TIMER WARNS BEFORE IT FIRES                               */
/* ------------------------------------------------------------------ */
/* The sheet's version of "the claim drops" is silent, so in practice it never
 * happened — nobody was watching, and if they had been, a firm vanishing from
 * under a rep with no notice is how a rep decides the system is against them.
 *
 * So: WARN_DAYS_BEFORE puts the card on My Day before anything is taken, the
 * overnight sweep only acts on the two hard states, and every reopen writes a
 * line on the lead's own timeline saying what happened and why. A rep can
 * always see the firm they lost and re-claim it if they were mid-conversation.
 * Nothing is ever deleted and nothing is ever hidden. */

/* ================================================================== */
/* THE THREE LISTS — the safety net, 30 Aug 2026                       */
/* ================================================================== */

/**
 * Ryder, 30 Aug 2026, after reading how the mature tools handle this: three
 * saved lists instead of a scheduled job that hands leads back on its own.
 *
 * THE REASON THE ROBOT LOST. Not one of HubSpot, Salesforce, Pipedrive, Close or
 * Attio reassigns a lead on a timer. Pipedrive's "rotting" turns a card red and
 * moves nothing; Close's whole answer is three saved searches a human reviews.
 * A lead changing hands overnight is how a rep loses a deal they were mid
 * conversation on, and how nobody trusts the board again. So: show it loudly,
 * let a person click.
 *
 * WHY THREE AND NOT ONE. `stuck` and `quiet` deliberately overlap and neither
 * subsumes the other — that is Pipedrive's rotting clock, which ignores whether
 * a next step is booked, and it looks like a bug until you have both:
 *
 *   no_next   — somebody is on it, nothing is planned. Fails quietly.
 *   quiet     — nothing has happened in 14 days, whatever is planned. A booked
 *               follow-up that keeps getting pushed is invisible to `no_next`.
 *   stuck     — claimed, never once touched, past the first-contact window.
 *               The one an OWNER works, because since 30 Aug a rep cannot see
 *               another rep's lead at all: a stuck lead is now invisible to
 *               everybody except owners, so this list is the only place it
 *               exists.
 *
 * Every one of these is a filter over columns we already keep. No new table, no
 * cron, no stored flag that can go stale — which is the whole reason they can be
 * trusted in a way the derived tags never could be.
 */
export const LEAD_LISTS = {
  no_next: {
    id: "no_next",
    label: "No next step",
    hint: "You are holding these and nothing is planned on them.",
    empty: "Everything you hold has a next step booked.",
    owners: false,
  },
  quiet: {
    id: "quiet",
    label: "Gone quiet",
    hint: `Nothing logged in ${ROE.COLD_REOPEN_DAYS} days, whatever is booked.`,
    empty: "Nothing you hold has gone quiet.",
    owners: false,
  },
  stuck: {
    id: "stuck",
    label: "Claims nobody is working",
    hint: `Claimed, never contacted, past the ${ROE.FIRST_CONTACT_BUSINESS_DAYS}-day window. Take one back to put it on the floor.`,
    empty: "Every claim on the board has been worked.",
    owners: true,
  },
};

export const LEAD_LIST_IDS = Object.keys(LEAD_LISTS);

/**
 * Is this lead on that list, for this person?
 *
 * `userId` narrows the two rep lists to the reader's own leads. `stuck` is NOT
 * narrowed — it is the owner's view of everybody, and narrowing it would make
 * the one list that exists to find other people's abandoned work show only your
 * own.
 *
 * A closed lead is on no list, ever. Nothing is owed on a lead nobody is
 * chasing, and a "gone quiet" card about a deal we lost in June is noise that
 * teaches people to ignore the list.
 */
export function onLeadList(listId, lead, { userId = null, now } = {}) {
  if (!lead || !isOpenStage(lead.stage)) return false;
  const nowIso = typeof now === "string" ? now : new Date(now || Date.now()).toISOString();

  if (listId === "stuck") {
    /* Claimed, and claimState says the first-contact window has run out. Read
     * from claimState rather than counted here, so this list and the Claim
     * column can never disagree about what "expired" means — the exact drift
     * that put a red Cold tag next to a calm working claim. */
    if (!lead.owner_id) return false;
    return claimState(lead, nowIso).state === "claim_expired";
  }

  /* The two rep lists are about leads somebody HOLDS. An unclaimed lead owes
   * nobody anything — that is what the floor is. */
  if (!lead.owner_id) return false;
  if (userId && lead.owner_id !== userId) return false;

  if (listId === "no_next") {
    /* A date in the past does not count as a plan. A follow-up booked for last
     * Tuesday that nobody kept is exactly the lead this list is for, and
     * treating "has a date" as "has a plan" would hide it for ever. */
    const due = Date.parse(lead.next_follow_up_at);
    if (!Number.isFinite(due)) return true;
    return due < Date.parse(nowIso);
  }

  if (listId === "quiet") {
    /* Counted from the same `since` the cold clock uses — the LATER of the claim
     * and the last touch — so re-claiming an old lead does not make it instantly
     * quiet. That is the rule the `cold` tag got wrong. */
    const st = claimState(lead, nowIso);
    return st.state === "cold";
  }

  return false;
}

/** How many leads are on each list. Counted from one set in one pass, so the
 *  number on a button and the list behind it cannot come from different reads. */
export function leadListCounts(leads, { userId = null, now } = {}) {
  const out = {};
  for (const id of LEAD_LIST_IDS) out[id] = 0;
  for (const lead of leads || []) {
    for (const id of LEAD_LIST_IDS) {
      if (onLeadList(id, lead, { userId, now })) out[id] += 1;
    }
  }
  return out;
}
