import { TEAM_TZ, teamDate } from "../../lib/brain-context.js";

/* Team-calendar date maths.
 *
 * Why this file exists: `Date.parse("2026-08-22T00:00:00Z")` is midnight in
 * LONDON, not in Chicago. Used as "start of today" it makes the team's day end
 * at 6:59pm Central, so a reminder set for 8pm reads as tomorrow's problem and
 * a task due today reads as late. And using the BROWSER's local midnight
 * instead is worse: the same task then reads "late" to someone in New York at
 * 00:30 and "due today" to someone in Los Angeles at 22:00, on the same rows.
 *
 * Everything the console shows about lateness goes through these functions, so
 * one calendar — the team's, America/Chicago — drives every number and no two
 * parts of a page can contradict each other.
 *
 * Kept out of the component on purpose: it is pure, and it has tests
 * (tests/team-day.test.mjs) that a JSX file could not be given.
 */

export const DAY = 86400000;

/** How far ahead of UTC the team's clock reads at this instant, in ms. */
export function zoneOffsetMs(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TEAM_TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  const asIfUtc = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  return asIfUtc - ms;
}

/** Real epoch ms of midnight, team time, on the calendar day `ymd`. */
export function teamDayStartOf(ymd) {
  const guess = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(guess)) return NaN;
  // Two passes: the first offset is read at the wrong instant on the two DST
  // switch days a year; the second lands on the right side of the change.
  const once = guess - zoneOffsetMs(guess);
  return guess - zoneOffsetMs(once);
}

/** The team's calendar date one day after `ymd`. */
export function teamDateAfter(ymd) {
  const start = teamDayStartOf(ymd);
  if (Number.isNaN(start)) return null;
  // +36h, so the answer is the middle of the next day whether that day is 23,
  // 24 or 25 hours long.
  return teamDate(start + DAY + DAY / 2);
}

/** The last millisecond of the team day `ymd`.
 *
 * Not `start + 24h - 1`. Two days a year are not 24 hours long, and that flat
 * addition put the end of 2026-11-01 at 22:59:59 — so a reminder set for 11pm
 * that night was filed under "coming up" while its own label read "today" —
 * and the end of 2026-03-08 at 00:59:59 the NEXT morning, which also made
 * anything due that day print tomorrow's date. Walking to the next midnight
 * is right on all 365. */
export function teamDayEndOf(ymd) {
  const next = teamDateAfter(ymd);
  if (!next) return NaN;
  const nextStart = teamDayStartOf(next);
  return Number.isNaN(nextStart) ? NaN : nextStart - 1;
}

/** The team's calendar date `n` days from the team's today. */
export function teamDatePlus(nowMs, n) {
  // +12h of slack, so a daylight-saving shift can never move the answer a day.
  return teamDate(teamDayStartOf(teamDate(nowMs)) + n * DAY + DAY / 2);
}

/** Plain-words due label. `endMs` is the end of the day the thing is due. */
export function dueLabel(endMs, nowMs) {
  if (endMs === null || endMs === undefined || Number.isNaN(endMs)) return "no date";
  const days = Math.round((endMs - teamDayEndOf(teamDate(nowMs))) / DAY);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "1 day late";
  if (days < 0) return `${Math.abs(days)} days late`;
  if (days <= 6) return `in ${days} days`;
  // Formatted from the middle of that day, not its last millisecond: a
  // boundary is one tick away from belonging to the neighbouring date.
  return new Date(endMs - DAY / 2).toLocaleDateString("en-US", { timeZone: TEAM_TZ, month: "short", day: "numeric" });
}

/** Which pile a task belongs in. Mirrors getMyWork()'s names exactly. */
export function taskBucket(task, nowMs) {
  if (task.status === "blocked") return "blocked";
  if (!task.due_date) return "nodate";
  const ymd = String(task.due_date).slice(0, 10);
  const today = teamDate(nowMs);
  if (ymd < today) return "overdue";
  if (ymd === today) return "today";
  return ymd <= teamDatePlus(nowMs, 6) ? "week" : "later";
}

/** Date.parse that returns 0, not the year 2000, for a null or a bad value. */
export function parsedOr0(v) {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}
