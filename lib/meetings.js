/* MEETINGS — THE RULES, WITH NO SCREEN ATTACHED.
 *
 * Julia Craig, VP of Sales, 11 Sep 2026: "how do i add in the meetings ive
 * already had without having to manually add each one lol".
 *
 * Everything here is PURE. No React, no database, no import, and — the one that
 * matters most in this file — NO HIDDEN CLOCK. Every function that needs to
 * know what day it is takes `today` as an argument. tests/meetings attacks it
 * directly, in five timezones, and it can only do that because nothing here
 * reads the machine's clock on its own.
 *
 * ================================================================
 * THE DATE TRAP, WRITTEN OUT ONCE SO NOBODY WALKS INTO IT AGAIN
 * ================================================================
 *
 * `new Date("2026-06-03")` IS MIDNIGHT UTC. In Chicago that is the EVENING OF
 * 2 JUNE. This project has already shipped that bug once — the Finance page
 * booked every cost paid on the 1st into the month before, and every invoice
 * went overdue a day early (CONTEXT-FOR-AI.md §18). It would be worse here:
 * this screen exists to enter dates and nothing else, so a parser that shifts
 * them by a day corrupts the one thing it was built for.
 *
 * TWO RULES FOLLOW, AND EVERY FUNCTION BELOW KEEPS THEM.
 *
 *   1. A `YYYY-MM-DD` STRING IS NEVER HANDED TO `new Date()`. Dates are built
 *      field by field — `new Date(y, m - 1, d, ...)` — which is local time by
 *      definition. Splitting a string into numbers is not cleverness, it is the
 *      only way to be right.
 *
 *   2. A MEETING WITH NO TIME IS FILED AT NOON, NOT MIDNIGHT. Midnight local is
 *      within a few hours of the date boundary in every timezone on earth, so
 *      anything downstream that slices an ISO string — and something always
 *      does — can read the day before. Noon has twelve hours of clearance in
 *      both directions and there is no timezone where it lands on another day.
 *      A meeting nobody timed is not "at midnight"; it is "that day", and noon
 *      is how you store "that day" without lying about it.
 *
 * ================================================================
 * THE FIVE RULES OF A BACKFILLED MEETING
 * ================================================================
 *
 * 1. IT NEVER MOVES THE PIPELINE. Not the stage, not `meeting_at`, not
 *    `next_follow_up_at`. See the long note at the top of migration 0034. A
 *    future meeting CAN become the booked one, but only because somebody
 *    pressed the button that says so.
 * 2. IT IS CLAIMED, NOT MEASURED. Nobody witnessed it but the person typing.
 *    `source` carries that and `sourceLabel()` says it in words.
 * 3. IT CAN CORRECT "FIRST CONTACT" EARLIER, NEVER LATER. Handled in the
 *    database by 0009's `least()`, fed by 0034. Nothing here has to do it.
 * 4. NOTHING SAVES UNTIL EVERY ROW HAS A PERSON. A part-saved batch leaves half
 *    a backlog and no way to tell which half.
 * 5. A BATCH IS UNDOABLE. An entry screen built for speed needs an eraser built
 *    for speed, or the first mis-paste costs more than the typing did.
 */

/* ------------------------------------------------------------------ */
/* The vocabulary                                                      */
/* ------------------------------------------------------------------ */

/** What kind of meeting. Matches the check constraint in 0034 — a value that is
 *  not in both places is a save that fails with a database error nobody on the
 *  screen can act on. */
export const MEETING_KINDS = [
  { id: "discovery", label: "First meeting", why: "The first proper sit-down." },
  { id: "demo", label: "Walkthrough", why: "Showed them what we do." },
  { id: "follow_up", label: "Follow-up", why: "A second or third conversation." },
  { id: "proposal", label: "Proposal", why: "Put numbers in front of them." },
  { id: "check_in", label: "Check-in", why: "A client catch-up, after they signed." },
  { id: "other", label: "Something else", why: "Anything that is none of the above." },
];

/** How it went. `happened` is FIRST and is the default on purpose.
 *
 *  A default of "went well" would manufacture thirty good meetings out of one
 *  paste, and those thirty would then be counted on a scoreboard. "It happened"
 *  is the only thing that is certainly true about a meeting somebody is
 *  half-remembering three months later. */
export const MEETING_OUTCOMES = [
  { id: "happened", label: "It happened", why: "No strong result either way." },
  { id: "went_well", label: "Went well", why: "Real interest, worth chasing." },
  { id: "booked_next", label: "Booked the next one", why: "There is another date." },
  { id: "no_show", label: "They did not show", why: "Nobody turned up." },
  { id: "rescheduled", label: "Moved it", why: "Pushed to another day." },
  { id: "they_passed", label: "They passed", why: "A no, at the meeting." },
];

export const DEFAULT_KIND = "discovery";
export const DEFAULT_OUTCOME = "happened";

const KIND_IDS = new Set(MEETING_KINDS.map((k) => k.id));
const OUTCOME_IDS = new Set(MEETING_OUTCOMES.map((o) => o.id));

export function kindLabel(id) {
  return MEETING_KINDS.find((k) => k.id === id)?.label || "Meeting";
}
export function outcomeLabel(id) {
  return MEETING_OUTCOMES.find((o) => o.id === id)?.label || "It happened";
}

/** Measured or claimed, in words, for the badge that goes beside every meeting.
 *
 *  Rule 2 of person-timeline.js and the rule the whole Finance page runs on: a
 *  fact is the fact plus where it was read from. A meeting somebody typed from
 *  memory and a meeting read out of a calendar are not the same kind of thing
 *  and must never be counted together without saying which is which. */
export function sourceLabel(source) {
  switch (source) {
    case "calendar": return { badge: "MEASURED", words: "Read from a connected calendar." };
    case "chat": return { badge: "CLAIMED", words: "Told to the assistant and approved on screen." };
    case "import": return { badge: "CLAIMED", words: "Came in with a batch of rows." };
    default: return { badge: "CLAIMED", words: "Typed in from memory." };
  }
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

const MONTHS = [
  ["january", "jan"], ["february", "feb"], ["march", "mar"], ["april", "apr"],
  ["may"], ["june", "jun"], ["july", "jul"], ["august", "aug"],
  ["september", "sep", "sept"], ["october", "oct"], ["november", "nov"], ["december", "dec"],
];

const WEEKDAYS = [
  ["sunday", "sun"], ["monday", "mon"], ["tuesday", "tue", "tues"], ["wednesday", "wed"],
  ["thursday", "thu", "thur", "thurs"], ["friday", "fri"], ["saturday", "sat"],
];

function monthFromWord(word) {
  const w = String(word || "").toLowerCase().replace(/\./g, "");
  for (let i = 0; i < MONTHS.length; i++) if (MONTHS[i].includes(w)) return i;
  return -1;
}

function weekdayFromWord(word) {
  const w = String(word || "").toLowerCase().replace(/\./g, "");
  for (let i = 0; i < WEEKDAYS.length; i++) if (WEEKDAYS[i].includes(w)) return i;
  return -1;
}

/** The hour a meeting with no stated time is filed at. Read the date trap note
 *  at the top of this file before changing it. */
export const UNTIMED_HOUR = 12;

/**
 * THE TEAM'S OWN CALENDAR — and every date in this file is built in it.
 *
 * A COPY OF lib/brain-context.js's TEAM_TZ, on purpose, because this file has
 * no imports and that is what lets the test suite attack it on its own.
 * tests/meetings reads BOTH out of their source and fails if they drift — the
 * same arrangement assistant-tools.js has with its local copy of the stage list,
 * for the same reason.
 *
 * WHY A TIMEZONE AT ALL, when the first version simply used the browser's.
 *
 * Because two different things write meetings. The grid runs in somebody's
 * browser; the assistant runs on a server in UTC and has no browser to ask. The
 * first version had the grid file an untimed meeting at noon BROWSER-LOCAL and
 * the assistant at noon CHICAGO, and a comment in assistant-tools claiming the
 * two "land on the same instant". They do not, for anybody outside Chicago —
 * and the consequences were not abstract:
 *
 *   Julia dictates "I met Dave on June 3" from New York. It is stored as noon
 *   Chicago. Her own card reads the instant back in New York time, sees 1pm,
 *   decides somebody must have stated a time, and prints "Wed 3 June 2026, 1pm"
 *   — a time nobody gave. Edit anything about that meeting and the invented
 *   time is written back as real.
 *
 * A meeting's DATE is a fact about the team's day, not about where the person
 * recording it happens to be sitting. So one calendar decides it, both writers
 * use it, and both readers read it back in it. That is the same conclusion this
 * project already reached for task due dates (migration 0006's third trap:
 * "days must be counted in the team's calendar, not UTC").
 */
export const TEAM_TZ = "America/Chicago";

/** How far the team's clock is from UTC at a given instant, in ms. */
function tzOffsetMs(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  /* `hour` comes back as "24" at midnight in some engines with hour12:false.
   * Left unhandled that is a whole day of error, once a day, every day. */
  return Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second) - ms;
}

/**
 * Year/month/day/hour/minute in the team's calendar → a real instant.
 *
 * TWO PASSES, and the second one is not belt and braces. The offset has to be
 * measured at the instant actually being stored, not at the UTC guess it
 * started from: on the two days a year the clocks change those are different
 * offsets, and one pass is an hour out. An hour is harmless at midday and is
 * not harmless at 00:30.
 */
export function teamInstant(y, monthIndex, day, hour = UNTIMED_HOUR, minute = 0) {
  if (!Number.isFinite(y) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) return null;
  if (monthIndex < 0 || monthIndex > 11) return null;
  if (day < 1 || day > daysInMonth(y, monthIndex)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const naive = Date.UTC(y, monthIndex, day, hour, minute, 0, 0);
  if (Number.isNaN(naive)) return null;
  const first = naive - tzOffsetMs(naive);
  const t = naive - tzOffsetMs(first);
  if (Number.isNaN(t)) return null;
  const out = new Date(t);

  /* READ IT BACK, AND REFUSE IF IT IS NOT WHAT WAS ASKED FOR.
   *
   * On the morning the clocks go forward there is no 2:30am in this timezone —
   * the hour does not exist. The two-pass offset above happily RESOLVES that
   * into 1:30am rather than failing, so "3/8/2026 2:30am" quietly became a
   * different time. An hour is smaller than the day this file's leap-year path
   * refuses to shift, but it is the same silent move, and this was the one
   * function here with no check on its own output.
   *
   * The fall-back morning is not affected: 1:30am happens twice and both are
   * real, so the round trip matches and one of them is chosen. */
  const back = teamFields(out);
  if (!back || back.year !== y || back.monthIndex !== monthIndex || back.day !== day
      || back.hour !== hour || back.minute !== minute) {
    return null;
  }
  return out;
}

/** An instant → its fields in the team's calendar. */
export function teamFields(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TZ, hour12: false, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return {
    year: +p.year, monthIndex: +p.month - 1, day: +p.day,
    hour: (+p.hour) % 24, minute: +p.minute, weekday: p.weekday,
  };
}

/** "YYYY-MM-DD" for an instant, in the TEAM'S calendar.
 *  Never `toISOString().slice(0,10)` — that is the same UTC shift in a
 *  different coat, and it is what migration 0034's opening note is about. */
export function teamDay(when) {
  const f = teamFields(when);
  if (!f) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${f.year}-${p(f.monthIndex + 1)}-${p(f.day)}`;
}

/* The old name, kept so nothing that imported it breaks. It never did mean
 * "the browser's day" after this change, so it is the same function. */
export const localDay = teamDay;

/** Days in a month. Day 0 of the NEXT month is the last day of this one — the
 *  standard trick, and it handles February in a leap year without a table.
 *  Computed in UTC so it cannot be shifted by the machine's own zone. */
function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Midday TODAY, in the team's calendar. The anchor every relative date is
 *  measured from. */
function anchor(today) {
  const t = today instanceof Date ? today : new Date(today || Date.now());
  const f = teamFields(t);
  return teamInstant(f.year, f.monthIndex, f.day, UNTIMED_HOUR, 0);
}

/** N days from an instant, keeping its time of day, in the team's calendar. */
function addDays(d, n) {
  const f = teamFields(d);
  /* Through UTC arithmetic on the DATE FIELDS, then back through teamInstant —
   * so a span that crosses a daylight-saving change still lands on the calendar
   * day asked for, rather than 23 or 25 hours later. */
  const moved = new Date(Date.UTC(f.year, f.monthIndex, f.day + n));
  return teamInstant(moved.getUTCFullYear(), moved.getUTCMonth(), moved.getUTCDate(), f.hour, f.minute);
}

function withTime(d, hour, minute) {
  const f = teamFields(d);
  return teamInstant(f.year, f.monthIndex, f.day, hour, minute);
}

/** The team-calendar weekday index (0 = Sunday) for an instant. */
function weekdayOf(d) {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const f = teamFields(d);
  return names.indexOf(f.weekday);
}

/** Pull an optional time off the end of a string: "3pm", "3:30 pm", "15:30".
 *  Returns { minutes, rest } — `minutes` null when there was no time. */
function takeTime(text) {
  const s = String(text || "");
  const m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    /* THE HOUR IS RANGE-CHECKED BEFORE THE CLOCK MATHS, not after.
     *
     * It used to do `Number(m[1]) % 12` first and then test `h > 23`, which can
     * never be true after a modulo — dead code guarding nothing. So "13pm"
     * quietly became 1pm and "0am" became midnight. A typo in a time is a small
     * thing; a typo silently accepted as a different time is the kind of wrong
     * nobody goes back and checks. */
    const raw12 = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (raw12 < 1 || raw12 > 12 || min > 59) return { minutes: null, rest: s };
    let h = raw12 % 12;
    if (/pm/i.test(m[3])) h += 12;
    return { minutes: h * 60 + min, rest: (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim() };
  }
  /* 24-hour, but ONLY with a colon. A bare "1530" is far more likely to be part
   * of a date or a phone number than a time, and guessing here would move a
   * meeting by hours without anybody being asked. */
  const m2 = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m2) {
    const h = Number(m2[1]); const min = Number(m2[2]);
    if (h > 23 || min > 59) return { minutes: null, rest: s };
    return { minutes: h * 60 + min, rest: (s.slice(0, m2.index) + s.slice(m2.index + m2[0].length)).trim() };
  }
  return { minutes: null, rest: s };
}

/**
 * WHICH YEAR, when the person did not say one.
 *
 * `prefer: "past"` — the most recent time that day happened, up to and
 * including today. This is the default and it is right for the job the screen
 * exists to do: Julia is entering meetings she HAS ALREADY HAD. Typing
 * "december 3" in September means last December, because next December has not
 * happened and she cannot have met anybody in it.
 *
 * `prefer: "nearest"` — whichever of this year or next is closer. Used by the
 * "add a meeting" line on a person's card (meetingsPanel.jsx passes it to
 * makeRow and reRow), where booking something in the future is a normal thing
 * to type. It was documented as being in use for a while before anything
 * actually passed it, which made the panel's whole future-dated flow — the
 * UPCOMING badge and "make this the booked meeting" — unreachable by the
 * obvious wording: typing "december 3" in September resolved to LAST December.
 *
 * EITHER WAY THE RESOLVED DATE IS SHOWN BACK ON SCREEN, in full, with the year.
 * A parser that guesses silently is the danger; a parser that guesses out loud
 * is a convenience. That is why every return value here carries `label`.
 */
function pickYear(monthIndex, day, today, prefer) {
  const base = anchor(today);
  const base_f = teamFields(base);
  const thisYear = teamInstant(base_f.year, monthIndex, day);
  if (prefer === "nearest") {
    if (thisYear) {
      const next = teamInstant(base_f.year + 1, monthIndex, day);
      const prev = teamInstant(base_f.year - 1, monthIndex, day);
      const options = [prev, thisYear, next].filter(Boolean);
      let best = options[0];
      for (const o of options) {
        if (Math.abs(o - base) < Math.abs(best - base)) best = o;
      }
      return best;
    }
    return null;
  }
  /* past */
  if (thisYear && thisYear <= base) return thisYear;
  for (let back = 1; back <= 4; back++) {
    const earlier = teamInstant(base_f.year - back, monthIndex, day);
    if (earlier && earlier <= base) return earlier;
  }
  /* 29 February with no year, and no leap year in the last four. Refuse rather
   * than move it to the 28th: shifting somebody's date by a day is exactly the
   * failure this file is written to prevent. */
  return null;
}

/**
 * TEXT IN, A REAL DATE OUT — or an honest refusal.
 *
 * Accepts, in the order it tries them:
 *   today · yesterday · tomorrow
 *   "3 days ago", "2 weeks ago"
 *   "last tuesday", "this monday", bare "friday"
 *   2026-06-03
 *   6/3, 6/3/26, 6/3/2026, 6-3-2026        (month first — see the note below)
 *   june 3, jun 3 2026, 3 june
 * Any of the above with a time stuck on: "june 3 3pm", "6/3 at 14:30".
 *
 * MONTH FIRST, ALWAYS, AND IT SAYS SO ON SCREEN. 6/3 is June 3rd here. Every
 * person using this console is in the United States and writes dates that way,
 * and a parser that tries to be clever about 6/3 versus 3/6 is a parser that is
 * silently wrong twelve times a year. The one concession: when the FIRST number
 * cannot be a month but the second can — 13/6 — it is read the other way round
 * and `swapped` comes back true so the screen can say so out loud.
 *
 * @returns {{ ok, iso, day, label, timed, swapped, why }}
 *   iso    a full ISO instant, ready for occurred_at. Null when ok is false.
 *   day    "YYYY-MM-DD", local.
 *   label  the resolved date in words, WITH the year, for showing back.
 *   timed  did the person actually state a time, or is this a noon default.
 *   why    when ok is false, what to fix, in a sentence a person can act on.
 */
export function parseWhen(text, { today = new Date(), prefer = "past" } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return fail("");

  const { minutes, rest } = takeTime(raw);
  const hour = minutes === null ? UNTIMED_HOUR : Math.floor(minutes / 60);
  const min = minutes === null ? 0 : minutes % 60;
  const timed = minutes !== null;

  const s = rest.toLowerCase().replace(/\bat\b/g, " ").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!s) {
    /* A time and nothing else — "3pm". That is a meeting today, at 3pm. */
    const base = anchor(today);
    const bf = teamFields(base);
    const d = teamInstant(bf.year, bf.monthIndex, bf.day, hour, min);
    return d ? done(d, timed, false) : fail(raw);
  }

  const base = anchor(today);

  /* ---- today / yesterday / tomorrow ---- */
  if (s === "today") return done(withTime(base, hour, min), timed, false);
  if (s === "yesterday") return done(withTime(addDays(base, -1), hour, min), timed, false);
  if (s === "tomorrow") return done(withTime(addDays(base, 1), hour, min), timed, false);

  /* ---- "N days/weeks/months ago" ---- */
  const ago = s.match(/^(\d{1,3})\s+(day|days|week|weeks|month|months)\s+ago$/);
  if (ago) {
    const n = Number(ago[1]);
    const unit = ago[2];
    let d;
    if (unit.startsWith("day")) d = addDays(base, -n);
    else if (unit.startsWith("week")) d = addDays(base, -n * 7);
    else {
      /* Months, by field, clamped to the length of the target month so that
       * "1 month ago" from 31 March is 28 February and not 3 March. */
      const bf = teamFields(base);
      const target = bf.monthIndex - n;
      const y = bf.year + Math.floor(target / 12);
      const mi = ((target % 12) + 12) % 12;
      d = teamInstant(y, mi, Math.min(bf.day, daysInMonth(y, mi)), bf.hour, bf.minute);
    }
    return d ? done(withTime(d, hour, min), timed, false) : fail(raw);
  }

  /* ---- last tuesday / this monday / bare friday ----
   *
   * "last tuesday" and a bare "tuesday" both mean the most recent one that has
   * already been, because this screen is for meetings that have happened. A
   * bare weekday meaning "the one coming up" is a reasonable reading in a diary
   * app; in a backfill screen it would file a meeting on a day in the future
   * that nobody has had yet. `prefer: "nearest"` flips it for the card. */
  const wd = s.match(/^(?:(last|this|next)\s+)?([a-z]+)$/);
  if (wd) {
    const idx = weekdayFromWord(wd[2]);
    if (idx >= 0) {
      const word = wd[1] || "";
      let d;
      if (word === "next" || (prefer === "nearest" && word !== "last")) {
        const ahead = (idx - weekdayOf(base) + 7) % 7 || 7;
        d = addDays(base, ahead);
      } else {
        const back = (weekdayOf(base) - idx + 7) % 7 || 7;
        d = addDays(base, -back);
      }
      return done(withTime(d, hour, min), timed, false);
    }
  }

  /* ---- 2026-06-03 ---- */
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const d = teamInstant(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), hour, min);
    return d ? done(d, timed, false) : fail(raw);
  }

  /* ---- 6/3 · 6/3/26 · 6-3-2026 ---- */
  const slash = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/);
  if (slash) {
    let a = Number(slash[1]); let b = Number(slash[2]);
    let swapped = false;
    if (a > 12 && b <= 12) { const t = a; a = b; b = t; swapped = true; }
    const monthIndex = a - 1;
    const day = b;
    if (monthIndex < 0 || monthIndex > 11) return fail(raw);
    if (slash[3]) {
      let y = Number(slash[3]);
      /* A two-digit year is this century. "26" is 2026, not 1926 — nobody is
       * backfilling meetings from before the company existed. */
      if (y < 100) y += 2000;
      const d = teamInstant(y, monthIndex, day, hour, min);
      return d ? done(d, timed, swapped) : fail(raw);
    }
    const picked = pickYear(monthIndex, day, today, prefer);
    return picked ? done(withTime(picked, hour, min), timed, swapped) : fail(raw);
  }

  /* ---- june 3 · jun 3 2026 · 3 june ----
   *
   * EVERY WORD HAS TO BE USED. This branch originally ignored words it did not
   * recognise, and that was a real bug caught on the bench before it shipped:
   * "April Reynolds June 15" parsed happily as 15 June, THREW AWAY "Reynolds",
   * and the paste box filed the meeting against a person called "April". A
   * date parser that ignores what it does not understand will read a date out
   * of almost any sentence, which is how a name ends up truncated and a row
   * ends up attached to the wrong person while looking completely normal.
   *
   * So an unrecognised word means this is not a date. The only words allowed to
   * be present without carrying meaning are the joining ones people actually
   * type: "the 3rd of june". */
  const STOPWORDS = ["of", "the", "on"];
  const words = s.split(" ").filter(Boolean);
  if (words.length >= 1) {
    let monthIndex = -1; let day = null; let year = null; let unknown = 0;
    for (const w of words) {
      const bare = w.replace(/(st|nd|rd|th)$/, "");
      const mi = monthFromWord(bare);
      if (mi >= 0 && monthIndex < 0) { monthIndex = mi; continue; }
      const n = Number(bare);
      if (!Number.isFinite(n) || bare === "") {
        if (!STOPWORDS.includes(w)) unknown += 1;
        continue;
      }
      if (n >= 1000) year = n;
      else if (day === null) day = n;
      else unknown += 1;   /* a third number nothing can place */
    }
    if (monthIndex >= 0 && day !== null && unknown === 0) {
      if (year !== null) {
        const d = teamInstant(year, monthIndex, day, hour, min);
        return d ? done(d, timed, false) : fail(raw);
      }
      const picked = pickYear(monthIndex, day, today, prefer);
      return picked ? done(withTime(picked, hour, min), timed, false) : fail(raw);
    }
  }

  return fail(raw);

  function fail(txt) {
    return {
      ok: false, iso: null, day: "", label: "", timed: false, swapped: false,
      why: txt
        ? `"${txt}" is not a date this can read. Try 6/3, June 3, or 2026-06-03.`
        : "Put a date in.",
    };
  }
  function done(d, wasTimed, swapped) {
    return {
      ok: true,
      iso: d.toISOString(),
      day: localDay(d),
      label: spellDate(d, wasTimed),
      timed: wasTimed,
      swapped,
      why: null,
    };
  }
}

/** "Wed 3 June 2026" — or with the time when one was actually given.
 *
 *  THE YEAR IS ALWAYS PRINTED, even for this year. The single most likely way
 *  this screen goes wrong is a date landing in the wrong year, and a label that
 *  hides the year cannot show that happening. */
export function spellDate(d, timed = false) {
  /* IN THE TEAM'S CALENDAR, like everything else here. Reading it back in the
   * reader's own zone is what made a meeting typed in Chicago show as a
   * different day, and sometimes a different date, to somebody in New York. */
  const f = teamFields(d);
  if (!f) return "";
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const base = `${f.weekday} ${f.day} ${months[f.monthIndex]} ${f.year}`;
  if (!timed) return base;
  const ampm = f.hour < 12 ? "am" : "pm";
  const h12 = f.hour % 12 === 0 ? 12 : f.hour % 12;
  return `${base}, ${h12}${f.minute ? `:${String(f.minute).padStart(2, "0")}` : ""}${ampm}`;
}

/**
 * Did anybody actually state a time for this meeting, or is it the default?
 *
 * READ BACK FROM THE STORED INSTANT, because the answer is not stored anywhere
 * else — and read in the TEAM'S calendar, which is the only reason it can be
 * trusted. An untimed meeting is filed at exactly midday team time by both
 * writers, so a meeting sitting on 12:00 is one nobody timed, for every reader
 * everywhere. The version of this that read the browser's clock told anybody
 * outside Chicago that every backfilled meeting had a time on it.
 *
 * THE HONEST LIMIT, stated rather than hidden: a meeting that genuinely was at
 * noon is indistinguishable from one nobody timed, and prints without a time.
 * That is the better of the two mistakes — showing "12:00" on forty rows nobody
 * chose a time for reads as data somebody entered.
 */
export function wasTimed(when) {
  const f = teamFields(when);
  if (!f) return false;
  return !(f.hour === UNTIMED_HOUR && f.minute === 0);
}

/** An existing meeting, back into text the date box can read and a person can
 *  recognise. Team calendar, both halves. */
export function toInputText(when) {
  const f = teamFields(when);
  if (!f) return "";
  const p = (n) => String(n).padStart(2, "0");
  const day = `${f.year}-${p(f.monthIndex + 1)}-${p(f.day)}`;
  if (!wasTimed(when)) return day;
  const h12 = f.hour % 12 === 0 ? 12 : f.hour % 12;
  return `${day} ${h12}:${p(f.minute)}${f.hour < 12 ? "am" : "pm"}`;
}

/** Is this date in the future, measured from `today`? Used only to decide
 *  whether to OFFER the "make this the booked meeting" button — never to refuse
 *  a row. Somebody entering next week's meeting from the card is doing a normal
 *  thing. */
export function isFuture(iso, today = new Date()) {
  if (!iso) return false;
  return new Date(iso).getTime() > anchor(today).getTime();
}

/* ------------------------------------------------------------------ */
/* Finding the person                                                  */
/* ------------------------------------------------------------------ */

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9@. ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * ONE SEARCHABLE LIST OUT OF LEADS AND CLIENTS.
 *
 * Both, in one box, because Julia does not think of the person she met in May
 * as "a lead" or "a client" — she thinks of them as Dave. Which table they are
 * in is our problem, not hers.
 *
 * @param leads   rows from admin_leads
 * @param clients rows from admin_clients
 */
export function searchablePeople(leads = [], clients = []) {
  const out = [];
  for (const l of leads || []) {
    if (!l?.id) continue;
    out.push({
      key: `lead:${l.id}`, leadId: l.id, clientId: null,
      name: l.name || l.company || "Unnamed", firm: l.company || "",
      email: l.email || "", kindOf: "lead",
      stage: l.stage || null, ownerId: l.owner_id || null,
    });
  }
  for (const c of clients || []) {
    if (!c?.id) continue;
    out.push({
      key: `client:${c.id}`, leadId: null, clientId: c.id,
      name: c.contact_name || c.name || "Unnamed", firm: c.name || "",
      email: c.contact_email || "", kindOf: "client",
      stage: c.stage || null, ownerId: null,
    });
  }
  return out;
}

/**
 * WHO DID THEY MEAN.
 *
 * Ranked, never auto-decided above one candidate. The rule this project already
 * learned the hard way on `matchOwner` (Aug 31, the Notion merge): A SHARED
 * FIRST NAME IS NOT ENOUGH TO HAND SOMEBODY A PIPELINE. The same applies here
 * with less at stake but the same shape — "Dave" matching four Daves must show
 * four Daves, not pick one.
 *
 * `confident` is true only when there is exactly one candidate at the top score
 * AND that score came from an exact email or an exact full name. Everything
 * else is a list the person picks from.
 */
export function matchPerson(query, people, { limit = 6 } = {}) {
  const q = norm(query);
  if (!q) return { candidates: [], confident: false };

  const scored = [];
  for (const p of people || []) {
    const name = norm(p.name);
    const firm = norm(p.firm);
    const email = norm(p.email);
    let score = 0; let exact = false;

    if (email && email === q) { score = 100; exact = true; }
    else if (name && name === q) { score = 90; exact = true; }
    else if (firm && firm === q) { score = 70; }
    else if (email && email.includes(q)) score = 55;
    else if (name.startsWith(q)) score = 50;
    else if (firm.startsWith(q)) score = 40;
    else if (name.includes(q)) score = 30;
    else if (firm.includes(q)) score = 20;
    else {
      /* Every word in the query appearing somewhere in the name or firm —
       * "dave crest" finding "Dave Mullen" at "Crest Dental". */
      const parts = q.split(" ").filter(Boolean);
      if (parts.length > 1 && parts.every((w) => name.includes(w) || firm.includes(w))) score = 35;
    }
    if (score > 0) scored.push({ ...p, score, exact });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = scored.slice(0, limit);
  const best = top[0];
  const tied = best ? scored.filter((s) => s.score === best.score).length : 0;
  return {
    candidates: top,
    confident: Boolean(best && best.exact && tied === 1),
  };
}

/* ------------------------------------------------------------------ */
/* The paste box                                                       */
/* ------------------------------------------------------------------ */

/** Header words we recognise, so a paste straight out of a spreadsheet with a
 *  header row does not turn its own header into a meeting. */
const HEADER_WORDS = ["who", "name", "person", "contact", "date", "when", "type", "kind",
  "outcome", "how it went", "result", "note", "notes", "meeting"];

function looksLikeHeader(cells) {
  const hits = cells.filter((c) => HEADER_WORDS.includes(norm(c))).length;
  return hits >= 2;
}

/**
 * PASTE IN, ROWS OUT.
 *
 * Handles what people actually paste:
 *   * tab-separated, straight out of Excel or Sheets
 *   * comma-separated
 *   * "Dave Mullen - June 3 - first meeting - went well"
 *   * "Dave Mullen, 6/3, went well"
 *   * a bare list of names with no dates at all
 *
 * IT NEVER GUESSES A COLUMN ORDER FROM ONE ROW. The order is fixed — who, when,
 * then whatever is left — and anything it could not place lands in the note
 * rather than being thrown away. A parser that silently drops a cell is a
 * parser that loses somebody's meeting.
 *
 * Every row comes back with `ok: false` on the parts it could not read, and the
 * screen paints those rows for the person to fix. NOTHING IS SAVED FROM HERE —
 * this function only reads text.
 */
export function parsePaste(text, { today = new Date() } = {}) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  let skippedHeader = false;

  for (const line of lines) {
    let cells;
    if (line.includes("\t")) cells = line.split("\t");
    else if (line.includes(" - ")) cells = line.split(" - ");
    else if (line.includes(",")) cells = line.split(",");
    else if (line.includes("|")) cells = line.split("|");
    else cells = [line];
    cells = cells.map((c) => c.trim());
    cells = rejoinSplitYear(cells, today);

    if (!skippedHeader && looksLikeHeader(cells)) { skippedHeader = true; continue; }

    const who = cells[0] || "";
    let whenText = "";
    const leftovers = [];

    /* The date is whichever remaining cell parses as one. Looking rather than
     * assuming position two, because "Dave, went well, 6/3" is a thing people
     * paste and losing the date out of it would be worse than a moment's work.
     * FIRST match wins, so a note that happens to contain a date cannot steal
     * the slot from a real date column earlier in the row. */
    for (let i = 1; i < cells.length; i++) {
      const cell = cells[i];
      if (!whenText && cell && parseWhen(cell, { today }).ok) { whenText = cell; continue; }
      if (cell) leftovers.push(cell);
    }

    /* Nothing in its own cell parsed. Try the tail of the first cell —
     * "Dave Mullen June 3" as one blob, which is what a plain list looks like. */
    let whoText = who;
    if (!whenText && cells.length === 1) {
      const found = sniffTrailingDate(who, today);
      if (found) { whenText = found.dateText; whoText = found.rest; }
    }

    const kindGuess = guessFromWords(leftovers, MEETING_KINDS);
    const outcomeGuess = guessFromWords(leftovers, MEETING_OUTCOMES);
    const used = new Set([kindGuess?.usedCell, outcomeGuess?.usedCell].filter((v) => v !== undefined));
    const note = leftovers.filter((_, i) => !used.has(i)).join(" · ");

    rows.push(makeRow({
      who: whoText,
      whenText,
      kind: kindGuess?.id || DEFAULT_KIND,
      outcome: outcomeGuess?.id || DEFAULT_OUTCOME,
      note,
    }, { today }));
  }

  return rows;
}

/**
 * PUT "December 3, 2026" BACK TOGETHER AFTER THE COMMA SPLIT.
 *
 * This is the single worst thing the paste box did, and it did it silently.
 *
 * A spreadsheet column formatted as a long date produces `December 3, 2026`,
 * and the splitter above cuts on commas — so the row arrived as
 * ["Dave Mullen", "December 3", "2026", …]. "December 3" parses fine on its
 * own, wins the date slot, and resolves with NO YEAR, which means the most
 * recent December — 2025. The year the person actually typed then fell through
 * into the note. Standing in September 2026 the results were:
 *
 *     "Dave Mullen, December 3, 2026, went well"  →  3 December 2025, note "2026"
 *     "Sarah Lin, March 5, 2025, demo"            →  5 March 2026,    note "2025"
 *
 * Wrong in both directions, from a paste the placeholder text invites. The
 * resolved date WAS printed back on screen, which is the file's third rule —
 * but a reader who typed the year has no reason to re-check the year, so the
 * one safeguard was pointing the wrong way.
 *
 * So: a cell that is nothing but a four-digit year is glued back onto the
 * previous cell, but ONLY when the previous cell is a date that is missing one
 * and the join actually parses. A bare "2026" in a note column is left alone.
 */
function rejoinSplitYear(cells, today) {
  if (cells.length < 2) return cells;
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const next = cells[i + 1];
    if (next && /^(19|20)\d{2}$/.test(next) && cell && !/(19|20)\d{2}/.test(cell) && parseWhen(cell, { today }).ok) {
      /* THREE JOINS, NOT ONE, because the date forms do not agree on a
       * separator and the first version only fixed the one it was looking at.
       *
       * "December 3, 2026" rejoins with a SPACE. "12/3, 2026" — the form the
       * grid's own help text teaches, and the form a spreadsheet column
       * produces — has to rejoin with the SLASH, because the numeric branch's
       * regex is anchored and can never match a space-separated year. So that
       * one still resolved to December 2025 with "2026" filed as the note,
       * while a test asserting only the month-name form went green over it.
       *
       * The joined string has to PARSE for the join to happen, so a bare year
       * sitting in a note column is still left exactly where it is. */
      const joined = [`${cell} ${next}`, `${cell}/${next}`, `${cell}-${next}`]
        .find((candidate) => parseWhen(candidate, { today }).ok);
      if (joined) { out.push(joined); i += 1; continue; }
    }
    out.push(cell);
  }
  return out;
}

/** "Dave Mullen June 3" → { rest: "Dave Mullen", dateText: "June 3" }.
 *  Walks backwards from the end taking one word at a time, so the LONGEST
 *  readable date at the end wins and a name containing a month word ("April
 *  Reynolds") is not eaten from the front. */
function sniffTrailingDate(text, today) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  for (let take = Math.min(5, words.length - 1); take >= 1; take--) {
    const tail = words.slice(words.length - take).join(" ");
    if (parseWhen(tail, { today }).ok) {
      return { dateText: tail, rest: words.slice(0, words.length - take).join(" ") };
    }
  }
  return null;
}

/** Does any leftover cell obviously name a kind or an outcome? Matched on the
 *  label and on the id, both, because "follow up" and "follow_up" are the same
 *  thought. Returns which cell it used so that cell does not ALSO become part
 *  of the note. */
function guessFromWords(cells, vocab) {
  for (let i = 0; i < cells.length; i++) {
    const c = norm(cells[i]);
    if (!c) continue;
    for (const v of vocab) {
      if (c === norm(v.label) || c === norm(v.id) || c === v.id.replace(/_/g, " ")) {
        return { id: v.id, usedCell: i };
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* A row, and whether it is safe to save                               */
/* ------------------------------------------------------------------ */

let rowSeq = 0;

/** One row of the grid. `person` is null until somebody or something matches
 *  it; `newLead` is set when the person chose "add them as a new lead". */
export function makeRow(partial = {}, { today = new Date(), prefer = "past" } = {}) {
  rowSeq += 1;
  const when = parseWhen(partial.whenText || "", { today, prefer });
  return {
    rowId: partial.rowId || `r${rowSeq}`,
    who: partial.who || "",
    whenText: partial.whenText || "",
    when,
    kind: KIND_IDS.has(partial.kind) ? partial.kind : DEFAULT_KIND,
    outcome: OUTCOME_IDS.has(partial.outcome) ? partial.outcome : DEFAULT_OUTCOME,
    note: partial.note || "",
    person: partial.person || null,
    newLead: partial.newLead || null,
  };
}

/** Re-read a row after an edit. Pure: returns a new row, never mutates. */
export function reRow(row, patch, { today = new Date(), prefer = "past" } = {}) {
  const next = { ...row, ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, "whenText")) {
    next.when = parseWhen(next.whenText, { today, prefer });
  }
  /* CHANGING THE NAME UNPICKS THE PERSON — unless the same patch is picking one.
   *
   * A row that reads "Dave" while attached to Sarah, because Sarah was chosen
   * before the name was retyped, is the worst kind of wrong: it looks
   * completely normal. So retyping clears the attachment.
   *
   * BUT THE FIRST VERSION CLEARED IT UNCONDITIONALLY, and choosing somebody
   * from the dropdown sets BOTH keys at once — the person, and `who` rewritten
   * to their full name. So every pick immediately undid itself: you typed
   * "dave", clicked "Dave Mullen", the box filled in, and the row stayed
   * unsaveable with no tick and no explanation. Clicking the identical name a
   * second time appeared to work, purely because `who` no longer changed.
   *
   * The test that was supposed to cover this called reRow twice, once per key,
   * which is the one shape the screen never uses. */
  const picking = Object.prototype.hasOwnProperty.call(patch, "person")
    || Object.prototype.hasOwnProperty.call(patch, "newLead");
  if (!picking && Object.prototype.hasOwnProperty.call(patch, "who") && patch.who !== row.who) {
    next.person = null;
    next.newLead = null;
  }
  return next;
}

/** Is this row blank? A grid starts with empty rows and ends with the ones
 *  nobody filled in; those are not errors, they are just not rows. */
export function rowIsBlank(row) {
  /* A row that has been attached to somebody is never blank, whatever is typed
   * in it. On a person's card the row starts with a person and no text at all,
   * and treating that as blank would make it silently un-saveable in a
   * different way from the bug above. */
  if (row.person || row.newLead) return false;
  return !String(row.who || "").trim()
    && !String(row.whenText || "").trim()
    && !String(row.note || "").trim();
}

/**
 * What is wrong with this row, in words, or null. One problem at a time, in the
 * order a person would fix them.
 *
 * THE PERSON IS CHECKED FIRST, AND `who` ONLY MATTERS WHEN THERE IS NO PERSON.
 *
 * The first version asked for `who` before looking at `person`, and that made
 * the whole per-person panel impossible to use. On a lead's card there IS no
 * "who" box — the card you are standing on is the answer — so every row it
 * built had a person and an empty `who`, and this function answered "Who was
 * this meeting with?" to a question nobody had been asked. Adding a meeting
 * from a card and editing an existing one BOTH failed on every single click,
 * with a red toast naming a field that was not on the screen.
 *
 * `who` is the typed text, which is a way of FINDING the person. It is not the
 * fact. Once the person is known the text has no job left, so it cannot be
 * what blocks a save. Caught by an adversarial review, not by the tests — the
 * suite exercised this file in isolation and never built a row the way the
 * panel does.
 */
export function rowProblem(row) {
  if (rowIsBlank(row)) return null;
  if (!row.person && !row.newLead) {
    return String(row.who || "").trim()
      ? "Pick who this was with, or add them as a new lead."
      : "Who was this meeting with?";
  }
  if (!String(row.whenText || "").trim()) return "Put a date in.";
  if (!row.when?.ok) return row.when?.why || "That date cannot be read.";
  return null;
}

/**
 * THE CHECK SCREEN — what is about to happen, before anything happens.
 *
 * Rule 4: nothing saves until every row has a person. A part-saved batch leaves
 * half a backlog and no way to tell which half, and the half that failed is
 * exactly the half that was hardest to type.
 *
 * Returns counts AND the rows that block the save, so the screen can jump
 * straight to them rather than making somebody hunt.
 */
export function batchSummary(rows, { today = new Date() } = {}) {
  const live = (rows || []).filter((r) => !rowIsBlank(r));
  const problems = [];
  let matched = 0; let toCreate = 0; let future = 0; let undated = 0;

  for (const r of live) {
    const p = rowProblem(r);
    if (p) { problems.push({ rowId: r.rowId, who: r.who, problem: p }); continue; }
    if (r.newLead) toCreate += 1; else matched += 1;
    if (isFuture(r.when.iso, today)) future += 1;
    if (!r.when.timed) undated += 1;
  }

  return {
    total: live.length,
    matched,
    toCreate,
    future,
    /* How many had no time on them and were filed at midday. Said out loud
     * because a meeting showing "12:00" that nobody put there looks like data
     * somebody invented, and it is easier to explain once than forty times. */
    untimed: undated,
    problems,
    canSave: live.length > 0 && problems.length === 0,
    /* The sentence the button sits under. Written here, not in the component,
     * so the test can read it. */
    headline: live.length === 0
      ? "Nothing to save yet."
      : problems.length
        ? `${problems.length} of ${live.length} ${problems.length === 1 ? "row needs" : "rows need"} fixing before anything saves.`
        : `${live.length} ${live.length === 1 ? "meeting" : "meetings"} ready${toCreate ? `, ${toCreate} of them adding a new person` : ""}.`,
  };
}

/**
 * A ROW → THE THING THAT GETS WRITTEN.
 *
 * Pure, so the test can check the shape without a database. The caller supplies
 * `enteredBy` and `batchId`; everything else comes off the row.
 *
 * NOTE WHAT IS NOT IN HERE: no `stage`, no `meeting_at`, no
 * `next_follow_up_at`. Rule 1, and migration 0034's longest note. If a future
 * version of this function starts returning a stage, that is the bug.
 */
export function rowToMeeting(row, { enteredBy, batchId = null, source = "typed" }) {
  return {
    lead_id: row.person?.leadId || null,
    client_id: row.person?.clientId || null,
    occurred_at: row.when.iso,
    kind: row.kind,
    outcome: row.outcome,
    notes: String(row.note || "").trim() || null,
    source,
    entered_by: enteredBy,
    batch_id: batchId,
  };
}

/**
 * THE LINE THAT GOES ON THE TIMELINE, for the mirrored activity row.
 *
 * The first line is machine-readable and identical every time, the same
 * convention lib/touch-log.js set for touches: anything reading these rows keys
 * off the first line, and a note must not be able to change its shape.
 */
export function meetingBody(row) {
  const head = `Meeting · ${kindLabel(row.kind)} · ${outcomeLabel(row.outcome)}.`;
  const note = String(row.note || "").trim();
  return note ? `${head}\n\n${note}` : head;
}
