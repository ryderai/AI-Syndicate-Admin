/* THE DATE RANGE THE TWO MONEY PAGES SHARE — 24 Sep 2026.
 *
 * Ryder: "make it filtered at the top by month so i know the time period and
 * can even customize it." Finance and AI Cost both open on "This month", both
 * offer the same presets, and both take a custom from/to. Keeping that in one
 * file is what stops the two pages disagreeing about what "last month" means.
 *
 * EVERY DATE HERE IS A PLAIN "YYYY-MM-DD" STRING IN THE TEAM'S CALENDAR
 * (America/Chicago), and ranges are INCLUSIVE of both ends. This repo has
 * shipped the `new Date("2026-09-01")` bug twice — that is midnight UTC, the
 * evening of Aug 31 in Chicago — so nothing in here hands a bare date string
 * to `new Date()`. The one conversion to a real instant is
 * teamMidnightUtcMs(), and it checks its own answer.
 *
 * Pure: no clock of its own. Every function that needs "today" is given it.
 */

import { teamDate } from "./brain-context.js";

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isYmd(s) {
  const m = YMD.exec(String(s || ""));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Calendar arithmetic on a date string. Never touches a timezone. */
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function monthStart(ymd) { return `${ymd.slice(0, 7)}-01`; }

export function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return t.toISOString().slice(0, 7);
}

export function monthEnd(ymd) {
  return addDays(`${addMonths(ymd.slice(0, 7), 1)}-01`, -1);
}

/** The instant a team-calendar day starts, as epoch ms. Chicago is UTC-5 or
 * UTC-6 depending on the season; both are tried and the one that really is
 * midnight on that day wins. */
export function teamMidnightUtcMs(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  for (const off of [5, 6, 4, 7]) {
    const ms = Date.UTC(y, m - 1, d, off, 0, 0);
    if (teamDate(ms) === ymd && teamDate(ms - 1) !== ymd) return ms;
  }
  throw new Error(`could not place ${ymd} on the team calendar`);
}

/** [fromMs, toMs) — the half-open instant window for an inclusive day range. */
export function rangeToInstants({ from, to }) {
  return { fromMs: teamMidnightUtcMs(from), toMs: teamMidnightUtcMs(addDays(to, 1)) };
}

/** Every "YYYY-MM" the range touches, oldest first. */
export function monthsIn({ from, to }) {
  const out = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addMonths(m, 1)) out.push(m);
  return out;
}

/** Every day in the range, oldest first. Capped so a silly range cannot hang a page. */
export function daysIn({ from, to }, cap = 800) {
  const out = [];
  for (let d = from; d <= to && out.length < cap; d = addDays(d, 1)) out.push(d);
  return out;
}

export function dayCount({ from, to }) {
  const a = Date.UTC(...from.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const b = Date.UTC(...to.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((b - a) / 86400000) + 1;
}

/** Days for a short range, months for a long one. A one-month view drawn as a
 * single bar tells you nothing; a year drawn as 365 bars tells you less. */
export function bucketFor(range) {
  return dayCount(range) <= 62 ? "day" : "month";
}

/* The presets, in the order they sit on screen. `earliest` is the first day
 * any money moved (Stripe's first charge), used by "All time". */
export const PRESETS = [
  { id: "last-3", label: "Last 3 months" },
  { id: "last-6", label: "Last 6 months" },
  { id: "ytd", label: "This year" },
  { id: "last-12", label: "Last 12 months" },
  { id: "all", label: "All time" },
];

export function presetRange(id, today, { earliest = null } = {}) {
  const ym = today.slice(0, 7);
  switch (id) {
    case "last-month": {
      const lm = addMonths(ym, -1);
      return { from: `${lm}-01`, to: monthEnd(`${lm}-01`) };
    }
    case "last-3": return { from: `${addMonths(ym, -2)}-01`, to: today };
    case "last-6": return { from: `${addMonths(ym, -5)}-01`, to: today };
    case "ytd": return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "last-12": return { from: `${addMonths(ym, -11)}-01`, to: today };
    case "all": return { from: earliest && earliest < today ? earliest : `${addMonths(ym, -11)}-01`, to: today };
    case "this-month":
    default:
      return { from: `${ym}-01`, to: today };
  }
}

/** The range just before this one, the same number of days long — what a
 * "vs before" figure compares against. For a whole calendar month it is the
 * whole previous month, which is what a person means. */
export function previousRange(range) {
  const { from, to } = range;
  if (from === monthStart(from) && to === monthEnd(from)) {
    const pm = addMonths(from.slice(0, 7), -1);
    return { from: `${pm}-01`, to: monthEnd(`${pm}-01`) };
  }
  /* MONTH TO DATE → THE SAME DAYS OF LAST MONTH. "Sep 1–24" is compared with
   * "Aug 1–24", not with the 24 days just before it (Aug 8–31), which would
   * drop anything billed on the 1st–7th — renewals land on the 1st. Found by
   * the review pass, 24 Sep 2026. */
  if (from === monthStart(from) && to.slice(0, 7) === from.slice(0, 7)) {
    const pm = addMonths(from.slice(0, 7), -1);
    const end = monthEnd(`${pm}-01`);
    const sameDay = `${pm}-${to.slice(8, 10)}`;
    return { from: `${pm}-01`, to: sameDay > end ? end : sameDay };
  }
  const n = dayCount(range);
  return { from: addDays(from, -n), to: addDays(from, -1) };
}

/** A human label: "September 2026", "Jul 1 – Sep 24, 2026", "Sep 3, 2026". */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function rangeLabel({ from, to }) {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  if (from === to) return `${MONTHS[fm - 1]} ${fd}, ${fy}`;
  if (fd === 1 && to === monthEnd(from)) return `${LONG[fm - 1]} ${fy}`;
  if (fy === ty) return `${MONTHS[fm - 1]} ${fd} – ${MONTHS[tm - 1]} ${td}, ${ty}`;
  return `${MONTHS[fm - 1]} ${fd}, ${fy} – ${MONTHS[tm - 1]} ${td}, ${ty}`;
}

export function monthName(ym, { long = false } = {}) {
  const [y, m] = ym.split("-").map(Number);
  return long ? `${LONG[m - 1]} ${y}` : `${MONTHS[m - 1]} ${String(y).slice(2)}`;
}

/** Is a range still running? A range that ends today holds a part day (and
 * maybe a part month), and a figure that compares it with a finished one
 * should say so. */
export function isOpenRange(range, today) {
  return range.to >= today;
}

/** Clean up whatever a URL or a form handed us. Bad input falls back to This
 * month rather than throwing — a typo in a date box must not blank the page. */
export function normalizeRange(input, today) {
  const from = input?.from;
  const to = input?.to;
  if (!isYmd(from) || !isYmd(to)) return presetRange("this-month", today);
  let a = from <= to ? from : to;
  let b = from <= to ? to : from;
  if (b > today) b = today;
  if (a > b) a = b;
  return { from: a, to: b };
}

/* ONE CALENDAR MONTH AS A RANGE — 24 Sep 2026. Ryder: "i want to filter the
 * finance page by month … so i can click back three months to like may or
 * june." The current month runs to today; any earlier month is the whole
 * month. `m:YYYY-MM` is the preset id the pickers use for it. */
export function monthRange(ym, today) {
  const from = `${ym}-01`;
  const end = monthEnd(from);
  return { from, to: end > today ? today : end };
}

/** The months the picker offers: from the first month with data (or twelve
 * back, whichever is later) to this month. Never more than 24. */
export function pickableMonths(today, earliest = null) {
  const last = today.slice(0, 7);
  const floor = addMonths(last, -23);
  let first = addMonths(last, -11);
  if (earliest && isYmd(earliest)) first = earliest.slice(0, 7) < floor ? floor : earliest.slice(0, 7);
  if (first > last) first = last;
  const out = [];
  for (let m = first; m <= last; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** Is this range exactly one month (as monthRange builds it)? Returns the
 * month, or null. */
export function rangeMonth(range, today) {
  if (!range || range.from.slice(8) !== "01") return null;
  const ym = range.from.slice(0, 7);
  const r = monthRange(ym, today);
  return r.to === range.to ? ym : null;
}
