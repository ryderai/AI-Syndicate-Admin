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
export const CLOSED_STAGES = ["won", "lost", "skip_90", "bad_contact"];

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
export function cadenceState(lead, now, touchCount) {
  /* `touchCount` is every call/email/text/LinkedIn row on the timeline. The
   * table has no direction column, so an INBOUND email logged by hand counts as
   * a completed step. That is a real limit and it is written down rather than
   * described away: "outbound only" would need a column that does not exist. */
  if (!lead.owner_id || !isOpenStage(lead.stage)) {
    return { active: false, step: null, done: 0, over: null, finished: false };
  }
  const startedAt = lead.cadence_started_at || lead.claimed_at || lead.created_at || null;
  const age = daysBetween(startedAt, typeof now === "string" ? now : new Date(now).toISOString());
  if (age === null) return { active: false, step: null, done: 0, over: null, finished: false };

  const done = Number.isFinite(touchCount) ? touchCount : 0;
  if (done >= CADENCE.length) {
    return { active: true, step: null, done, over: null, finished: true };
  }
  const step = CADENCE[done];
  return {
    active: true,
    step,
    done,
    /* Above zero = the step is late by that many days. The sheet's schedule is
     * a floor, not a ceiling: doing step 2 on day 4 is fine, skipping it is not. */
    over: age - step.day,
    finished: false,
  };
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
  if (!lead.email_opened_at) {
    return { allowed: false, reason: "They have not opened an email yet. Texting a cold contact gets our numbers flagged." };
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
 * NOT HERE YET, and deliberately not pretended: "they replied and you have not
 * answered" would be the most important card on this page, and there is nowhere
 * to read it from. `admin_lead_activity` has no direction, and the shared inbox
 * links a thread to a lead but nothing marks that thread as unanswered ON the
 * lead. An earlier draft had the branch, ranked top, with a heading and a test —
 * a code path no user could ever reach, which reads to the next person as a
 * feature that exists. It was taken out rather than left in looking finished.
 */
export function salesQueue(leads, { userId, now, touchCounts = {}, includeUnclaimed = true, scoreOf = () => null }) {
  const cards = [];
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
    const beforeContact = ["new", "researching"].includes(lead.stage);
    if (gate.skip && beforeContact) continue;

    if (!lead.owner_id) {
      cards.push({
        lead, reason: "unclaimed", rank: REASON_RANK.unclaimed, over: -999,
        headline: "Nobody has claimed this",
        detail: gate.known ? gate.why : "No score yet — run one before you pitch.",
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
    meetings: mine.filter((l) => ["meeting", "proposal", "won"].includes(l.stage)).length,
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
