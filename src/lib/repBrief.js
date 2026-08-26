/* THE REP'S WORK PAGE — the pure half.
 *
 * Aug 26 2026. CJ is giving the sales reps their own logins, so Work becomes a
 * rep's landing page: Ryder asked for "an overall work page that is like an
 * overview of everything plus ai reports and everything so you can effectively
 * convert leads". Two things go on it — a box you type a question into, and the
 * rep's own numbers underneath. This file is everything both of those need that
 * is not React and not a database, so it can be tested without a browser.
 *
 * WHY IT IS NOT INSIDE repBrief.jsx. A .jsx file cannot be imported by node, so
 * logic that lives there has no tests. Three date bugs and a preview leak have
 * shipped in this repo already, all of them in code nothing could run on its
 * own. So: the panel draws, this counts.
 *
 * WHY IT IS NOT INSIDE data.js either. Same reason — data.js reads
 * import.meta.env through supabase.js, which is a Vite thing and throws the
 * moment node touches it.
 *
 * TWO RULES THIS FILE EXISTS TO HOLD:
 *   1. Every claim and cold decision comes from lib/sales-rules.js. Nothing here
 *      re-derives "going cold" or "the claim has run out". If this page counted
 *      those itself, it and the Sales page would be telling a rep two different
 *      things about the same firm inside a week.
 *   2. A count nobody could read is null, never 0. "No leads going cold" and "I
 *      could not read your leads" are opposite answers, and printing them the
 *      same way is how a broken read looks like good news.
 */

import { claimState, isOpenStage, ROE } from "../../lib/sales-rules.js";
import {
  assembleRepFacts, deterministicRepReport, cleanInstruction, MAX_INSTRUCTION_CHARS,
} from "../../lib/rep-report.js";
import { teamDayStartOf, teamDayEndOf } from "./teamDay.js";
import { teamDate } from "../../lib/brain-context.js";

/* Re-exported so the box, the endpoint and the tests all read the cap from the
 * one place that owns it. A second copy of a cap is a second cap. */
export { MAX_INSTRUCTION_CHARS };

/* ------------------------------------------------------------------ */
/* The box                                                             */
/* ------------------------------------------------------------------ */

/* Starting points. A preset only FILLS THE BOX — the box is what travels, and
 * what a rep types over the top of it is the real question. Same rule the
 * Overview's generator follows, for the same reason: a button that sends
 * something different from what is on screen is a button nobody trusts.
 *
 * Ryder, Aug 26 2026, on what the AI part should be: "just a prompt text that
 * you fill in to ask ai to give a report and then you type what you want". So
 * these are four openings, not four report types. */
export const REP_PRESETS = [
  {
    id: "week",
    label: "My week",
    hint: "What moved, what did not",
    instruction: "Give me a rundown of my week. What moved, what did not, and what I should pick up first on Monday.",
  },
  {
    id: "cold",
    label: "Going cold",
    hint: "And what to say to each",
    instruction: "Which of my leads is going cold or about to lose its claim, and what do I say to each one? Write me the opening line.",
  },
  {
    id: "next",
    label: "What next",
    hint: "In order, with the reason",
    instruction: "What should I do next, in order, and why that order? Put the thing I am about to lose at the top.",
  },
  {
    id: "call",
    label: "Before a call",
    hint: "Type the firm's name",
    instruction: "Everything the records hold on ",
  },
];

/**
 * The one gate on what gets sent. Empty is refused HERE, before any reader and
 * before any /api call — an empty box is a mis-click, and answering it burns a
 * model call to tell somebody nothing. Over-long is capped rather than refused,
 * because a rep who pasted too much still asked a real question.
 */
export function checkInstruction(v) {
  const raw = String(v ?? "").trim();
  const instruction = cleanInstruction(v);
  if (!instruction) {
    return { ok: false, error: "Type what you want to know first.", instruction: "" };
  }
  return { ok: true, instruction, capped: raw.length > MAX_INSTRUCTION_CHARS };
}

/* ------------------------------------------------------------------ */
/* The preview answer                                                  */
/* ------------------------------------------------------------------ */

/**
 * The snapshot the counted answer is built from, shaped exactly like
 * loadSystemContext's so lib/rep-report.js's own functions run over it
 * unchanged. Preview mode then gets its answer from the SAME code the endpoint
 * uses, minus the model — which is the whole point: what Ryder sees today is
 * what a rep gets tomorrow.
 *
 * WHAT IS DELIBERATELY MISSING. No clients, no tasks, no tickets, no email, no
 * invoices, no brain, no notes, no vault. Those keys are not set to empty
 * arrays for tidiness — they are absent because a rep's scope in
 * lib/brain-context.js does not fetch them, and a row that is never in here
 * cannot end up in a saved answer somebody forwards.
 *
 * `reminders` is filtered to the person asking a SECOND time, on top of the
 * filter the reader already applied. Yesterday listNotes and listReminders
 * ignored the person in preview while the live query filtered, and a rep was
 * shown the owner's private notes. Two gates cost nothing and the loose one is
 * always the preview one.
 */
export function repSnapshotFromRows({
  userId, leads, activity, reminders, companies, lists, proposals, sources, team,
  errors = {}, nowMs = Date.now(),
} = {}) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    role: "sales",
    userId: userId || null,
    generatedAt: new Date(nowMs).toISOString(),
    errors,
    leads: arr(leads),
    leadActivity: arr(activity),
    reminders: arr(reminders).filter((r) => userId && r.owner_id === userId),
    companies: arr(companies),
    leadLists: arr(lists),
    proposals: arr(proposals),
    leadSources: arr(sources),
    team: arr(team),
  };
}

/** The day the counted answer is dated with: the TEAM's calendar day.
 *
 * `new Date(nowMs).toISOString().slice(0,10)` was here, and between 7pm and
 * midnight Central that is already tomorrow in London — so the counted answer was
 * titled with tomorrow's date every evening. All day maths in this repo goes
 * through teamDay.js / teamDate for exactly this reason; three date bugs shipped
 * in one day from raw date maths. Exported so the test can pin an instant to a
 * day. Aug 26 2026. */
export function answerDay(nowMs = Date.now()) {
  return teamDate(nowMs);
}

/* WHY THE COUNTED ANSWER HAPPENS — three different things, one flag.
 *
 * `counted_only: true` is set for three reasons that are not the same story:
 *   1. NOTHING WAS SENT. No AI key, or preview mode. No draft ever existed.
 *   2. NOTHING CAME BACK. The model was asked and errored. No draft either.
 *   3. A DRAFT FAILED THE CHECKS. Words came back, did not pass, thrown away.
 *
 * The panel said "the written draft was thrown away" for all three, so in preview
 * mode — the default path, the one that gets demoed — it read "a draft was thrown
 * away" and then explained that nothing was ever sent to an AI. A sentence that
 * contradicts itself in its second half is worse than no sentence.
 *
 * So the shape: a `counted_cause` of "not_sent" | "no_draft" | "draft_failed",
 * carried beside `gate_reason`. Preview sets it outright. The live endpoint does
 * not send it yet (api/rep-report.js belongs to somebody else today), so
 * countedOnlyCause falls back to reading the reason sentence the endpoint already
 * carries, and prefers the field the moment it appears. Aug 26 2026.
 */
export const COUNTED_CAUSES = ["not_sent", "no_draft", "draft_failed"];

/**
 * Which of the three happened, and the words for it.
 *
 * Every branch still says NO AI WROTE THIS, first and in bold — that is the part
 * a reader must not be able to miss, and it is true in all three. What changes is
 * the half after it, so a reader is never told a draft was thrown away when none
 * was ever written.
 *
 * The fallback for an unrecognised reason is "draft_failed" because the endpoint
 * only sets a reason it does not recognise in one place: the gate's own verdict
 * on a draft it read. "Nothing sent" and "nothing came back" are both fixed
 * sentences, so they are the ones that can be matched. A missing reason is a
 * fourth case and it says so rather than guessing.
 */
export function countedOnlyCause(report) {
  const raw = String(report?.gate_reason || "").trim();
  const field = COUNTED_CAUSES.includes(report?.counted_cause) ? report.counted_cause : null;
  const tail = " What you are reading is the counted version — arithmetic on your own rows, with"
    + " the names behind it. It is all true and none of it is written well.";

  if (!raw && !field) {
    return {
      kind: "unrecorded",
      lead: "Nothing recorded whether a draft was written and rejected or never written at all,"
        + " which is itself worth telling somebody." + tail,
      short: "No AI wrote it, and no reason was recorded.",
      reason: null,
    };
  }

  const notSent = /preview mode|anthropic_api_key|no ai key|nothing was sent|nothing could be written/i.test(raw);
  const noDraft = /did not answer|no response|timed out/i.test(raw);
  const kind = field || (notSent ? "not_sent" : (noDraft ? "no_draft" : "draft_failed"));

  if (kind === "not_sent") {
    return {
      kind,
      lead: "No draft was ever written, because nothing was sent to an AI." + tail,
      short: "Nothing was sent to an AI — the reason is on screen.",
      reason: raw || null,
    };
  }
  if (kind === "no_draft") {
    return {
      kind,
      lead: "The AI was asked and nothing usable came back, so there is no draft." + tail,
      short: "The AI did not answer — the reason is on screen.",
      reason: raw || null,
    };
  }
  return {
    kind: "draft_failed",
    lead: "A draft was written, it failed the checks, and it was thrown away." + tail,
    short: "The draft failed the checks and was thrown away — the reason is on screen.",
    reason: raw || null,
  };
}

/**
 * The counted answer, in the EXACT shape POST /api/rep-report hands back, so a
 * component written against the endpoint needs no second code path for preview.
 *
 * `counted_only` is true and `saved` is false because both are simply true here:
 * no model was called and nothing was written to a table. Saying so is the
 * honest version, and it also means the two warnings the panel must print get
 * exercised every time somebody clicks the button in preview mode — which is
 * how they get noticed if the wording is wrong.
 */
export function buildRepPreviewAnswer({ instruction, snap, nowMs = Date.now() } = {}) {
  const gate = checkInstruction(instruction);
  if (!gate.ok) return { ok: false, error: gate.error };

  const facts = assembleRepFacts(snap, { nowMs });
  const todayIso = answerDay(nowMs);
  /* The team's calendar day, not UTC's. `toISOString().slice(0,10)` was here and
   * it titled the answer with TOMORROW's date every evening after 7pm Central,
   * because that is already the next day in London. All day maths in this repo
   * goes through teamDay.js / teamDate for exactly that reason — three date bugs
  /* NOT "no database key" — that was the first wording and it named the wrong
   * missing thing, which would have sent somebody to check the Supabase keys.
   * Preview mode has no AI key and no database; the reason the words are
   * counted rather than written is the AI one. Aug 26 2026. */
  const why = "this is preview mode, so nothing was sent to an AI — there is no AI key here and no live rows to read";
  const report = deterministicRepReport(facts, { todayIso, why });

  return {
    ok: true,
    sample: true,
    report: {
      /* null, not a made-up id. An id is what a saved row has, and nothing was
       * saved — a fake one would make the panel think it could link to it. */
      id: null,
      instruction: gate.instruction,
      summary: report.summary || "",
      body: report.body || "",
      facts: {
        counts: facts.counts,
        cannotAnswer: facts.cannotAnswer,
        unreadable: facts.unreadable,
        takenAt: facts.takenAt,
      },
      counted_only: true,
      /* Said outright rather than left to be read out of the sentence: in preview
       * nothing was sent, so no draft ever existed. */
      counted_cause: "not_sent",
      gate_reason: why,
      saved: false,
      generated_at: new Date(nowMs).toISOString(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* The rep's numbers                                                   */
/* ------------------------------------------------------------------ */

/* One row per state claimState can return for a lead somebody owns, so the
 * buckets add up to the rep's open total. A set of buckets that quietly loses
 * two states is worse than no buckets: a rep adds them up, comes out short, and
 * stops believing the page.
 *
 * `hard` marks the two the overnight sweep actually acts on. Everything else is
 * a warning, and nothing here takes a firm away — see the note at the bottom of
 * lib/sales-rules.js. */
export const CLAIM_BUCKETS = [
  { key: "working", label: "Being worked", hard: false, why: "touched recently, nothing due" },
  { key: "first_contact", label: "Waiting on a first contact", hard: false, why: `inside the ${ROE.FIRST_CONTACT_BUSINESS_DAYS} business days` },
  { key: "first_contact_due", label: "First contact due", hard: false, why: "the claim drops in a day or two" },
  { key: "claim_expired", label: "Claim already run out", hard: true, why: "claimed, never contacted, past the line" },
  { key: "going_cold", label: "Going quiet", hard: false, why: `the ${ROE.COLD_REOPEN_DAYS}-day line is close` },
  { key: "cold", label: `Past the ${ROE.COLD_REOPEN_DAYS}-day line`, hard: true, why: "due back on the floor" },
];

/* Why somebody is owed a touch today, in the four shapes the reason can take.
 * The counts come from the rows getMyWork already put in `contactable`, so they
 * add up to the number on the "People to contact" tile above them by
 * construction. Counting the same people a second way is how a page ends up
 * with a header saying 3 above a list of four. */
/* NOT "you set". `admin_reminders` has both an `owner_id` and a `created_by`, and
 * lib/assistant-tools.js lets an owner set a follow-up FOR a rep. The rows here
 * are filtered on owner_id — who it is FOR — so CJ setting "call Summit today"
 * for Andrew was making Andrew's page say Andrew set it. Aug 26 2026. */
export const OWED_REASONS = [
  { key: "followup_late", label: "Follow-up on you is late" },
  { key: "followup_today", label: "Follow-up on you is due today" },
  { key: "never_contacted", label: "Never contacted" },
  { key: "gone_quiet", label: "No contact for a while" },
];

/** Which of the four a contactable row is. Read off the fields getMyWork
 * computed — `follow_ms`, `last_touch` — and never off the display string it
 * also wrote, because a reason people can re-word is not something to branch on.
 *
 * The day boundary comes from teamDay.js, not from the browser. A raw local
 * midnight makes the same follow-up read "late" to somebody in New York at
 * 00:30 and "due today" in Los Angeles at 22:00, on the same row. */
export function whyOwed(row, nowMs = Date.now()) {
  const today = teamDate(nowMs);
  const startOfToday = teamDayStartOf(today);
  const endOfToday = teamDayEndOf(today);
  const follow = row?.follow_ms ?? null;
  if (follow !== null && !Number.isNaN(follow)) {
    if (follow < startOfToday) return "followup_late";
    if (follow <= endOfToday) return "followup_today";
  }
  if (!row?.last_touch) return "never_contacted";
  return "gone_quiet";
}

/** `name (company)` — the same label lib/rep-report.js writes, so a firm reads
 * the same way in the answer box and in the numbers under it. */
function leadLabel(l) {
  if (l?.name && l?.company) return `${l.name} (${l.company})`;
  return l?.name || l?.company || "an unnamed lead";
}

/* Worst first: `over` is how many days PAST the line a lead is, and negative is
 * days still left, so one descending sort ranks every card. A null date is last
 * — unknown is not urgent, and it is not calm either, which is why the row still
 * carries claimState's own words about it. */
function worstFirst(a, b) {
  const av = a.over === null || a.over === undefined ? -Infinity : a.over;
  const bv = b.over === null || b.over === undefined ? -Infinity : b.over;
  return bv - av;
}

/**
 * Everything the rep's numbers section prints.
 *
 * `leads`, `contactable` and `reminders` are the rows, or **null** when that
 * read failed. Null in means null out and the name of the read in `unreadable`
 * — never a zero. The caller in data.js is what turns a failed read into a
 * null; nothing here invents one.
 *
 * `contactable` is the list getMyWork already built, on purpose: this section
 * explains that list rather than recounting it.
 */
export function buildRepOverview({
  userId, leads, contactable, reminders, nowMs = Date.now(),
} = {}) {
  const unreadable = [];

  /* NO USER ID, NO NUMBERS. getMyWork's `mine()` filter passes every row in the
   * system when the user id is falsy, so a missing id does not mean "none of
   * them" — it means "all of them", which on this page would print another
   * rep's pipeline as yours. Refuse instead. */
  if (!userId) {
    return {
      knowsWho: false,
      owned: null, floor: null, buckets: null, atRisk: null, quiet: null,
      neverContacted: null, owed: null, owedWhy: null, stages: null, remindersOpen: null,
      unreadable: ["who you are signed in as"],
    };
  }

  const nowIso = new Date(nowMs).toISOString();
  const haveLeads = Array.isArray(leads);
  const haveOwed = Array.isArray(contactable);
  const haveRem = Array.isArray(reminders);
  if (!haveLeads) unreadable.push("your leads");
  if (!haveOwed) unreadable.push("who is owed a touch");
  if (!haveRem) unreadable.push("your reminders");

  /* "Mine" is the owner_id on the row matching the person asking. A lead with no
   * owner is on the floor and belongs to nobody — a third state, counted
   * separately, because a rep who reads "12 leads" and finds four are somebody
   * else's stops trusting the number. */
  const open = haveLeads ? leads.filter((l) => isOpenStage(l.stage)) : [];
  const mine = haveLeads ? open.filter((l) => l.owner_id && l.owner_id === userId) : null;
  const states = mine
    ? mine.map((l) => ({ lead: l, at: claimState(l, nowIso) }))
    : null;

  const inStates = (names) => (states ? states.filter((x) => names.includes(x.at.state)) : null);
  const rowsOf = (names) => {
    const got = inStates(names);
    if (!got) return null;
    return got
      .map((x) => ({
        id: x.lead.id,
        label: leadLabel(x.lead),
        stage: x.lead.stage,
        state: x.at.state,
        /* claimState's own sentence, word for word. Re-writing it here is how
         * this page and the Sales page end up explaining the same lead two
         * different ways. */
        why: x.at.why,
        over: x.at.over,
      }))
      .sort(worstFirst);
  };

  const buckets = states
    ? CLAIM_BUCKETS.map((b) => ({
      ...b,
      count: states.filter((x) => x.at.state === b.key).length,
    }))
    : null;

  /* Stage breakdown of the rep's OWN open pipeline. Only stages that are
   * actually there — an empty row for every stage the ladder has turns twelve
   * zeroes into the loudest thing on the page. */
  const stages = mine
    ? Object.entries(mine.reduce((acc, l) => {
      const k = l.stage || "unknown";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}))
      .map(([stage, count]) => ({ stage, count }))
      .sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage))
    : null;

  const owedWhy = haveOwed
    ? (() => {
      const tally = {};
      for (const row of contactable) {
        const k = whyOwed(row, nowMs);
        tally[k] = (tally[k] || 0) + 1;
      }
      return OWED_REASONS
        .map((r) => ({ ...r, count: tally[r.key] || 0 }))
        .filter((r) => r.count > 0);
    })()
    : null;

  return {
    knowsWho: true,
    owned: mine ? mine.length : null,
    floor: haveLeads ? open.filter((l) => !l.owner_id).length : null,
    buckets,
    /* THE TWO MISSING-FIRST-CONTACT STATES, and the panel above them is titled
     * with exactly that rather than "at risk".
     *
     * SalesPage.jsx counts its "Claims at risk" tile as claim_expired + cold.
     * This is claim_expired + first_contact_due. Both are defensible and they are
     * different numbers, so a rep reading both pages in one afternoon saw two
     * answers to what looked like one question.
     *
     * RENAMED RATHER THAN RECOUNTED. Counting cold here would put every cold firm
     * in this list AND in the "Gone quiet" list beside it, which is the same firm
     * printed twice under two headings — and the pair only splits cleanly the way
     * it is: no first contact on the left, touched but gone quiet on the right.
     * So neither panel here claims the phrase "at risk", and each says what it
     * holds. Aug 26 2026. */
    atRisk: rowsOf(["claim_expired", "first_contact_due"]),
    quiet: rowsOf(["cold", "going_cold"]),
    neverContacted: mine ? mine.filter((l) => !l.claim_contacted_at).length : null,
    owed: haveOwed ? contactable.length : null,
    owedWhy,
    stages,
    /* The follow-ups that are ON this rep — owner_id is who the follow-up is for,
     * not who typed it, so this is not "reminders you set yourself". Filtered
     * again on the way out: the reader
     * already filtered by owner, and this filters a second time for the same
     * reason repSnapshotFromRows does: the reader decides what is FETCHED, this
     * decides what is COUNTED, and a caller who hands over a fuller list — a
     * test, a reused object, a future page — still cannot count one person's
     * follow-ups as another person's. */
    remindersOpen: haveRem
      ? reminders.filter((r) => r.owner_id === userId && !r.done_at).length
      : null,
    unreadable,
  };
}

/* ------------------------------------------------------------------ */
/* Rules are not figures                                               */
/* ------------------------------------------------------------------ */

/* `facts.counts` carries the house rules alongside the counts, because the
 * counted answer needs them to write "past the 14-day line" without stating a
 * number nothing backs. The panel then printed the whole object under "The
 * figures this was written from", so a rep read COLD AFTER DAYS 14 as something
 * measured about their pipeline. These four are settings, and one of them is a
 * read limit, so they get their own block and a sentence each. Aug 26 2026.
 *
 * A key that is not here is a figure. New counts therefore show up as figures,
 * which is the safe way round: a real count in the rules block would be hidden
 * from the check, and a rule in the figures block is only untidy. */
export const RULE_SENTENCES = {
  coldAfterDays: (v) => `A claim is due back on the floor after ${v} days with nothing logged on it.`,
  firstContactBusinessDays: (v) => `A new claim has ${v} business days to get its first contact logged.`,
  skipScoreAtOrAbove: (v) => `A firm scoring ${v} or above on its website is not a prospect, by house rule.`,
  activityWindowDays: (v) => `Only the last ${v} days of logged touches were read, so anything older is not in the count.`,
};

/**
 * The counts object split in two: what was counted about this rep, and the rules
 * and limits it was counted against. Order is preserved inside each half so the
 * grid does not reshuffle between two answers.
 */
export function splitCountedFigures(counts) {
  const src = counts && typeof counts === "object" ? counts : {};
  const figures = [];
  const rules = [];
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (RULE_SENTENCES[k]) rules.push({ key: k, value: v, sentence: RULE_SENTENCES[k](v) });
    else figures.push({ key: k, value: v });
  }
  return { figures, rules };
}

/** Do the claim buckets still add up to the rep's open total? Exported because
 * the test asserts it and the panel prints nothing that contradicts it — if a
 * state is ever added to claimState and not to CLAIM_BUCKETS, this is what
 * notices. */
export function bucketsAddUp(overview) {
  if (!overview?.buckets || overview.owned === null) return true;
  const sum = overview.buckets.reduce((a, b) => a + b.count, 0);
  return sum === overview.owned;
}
