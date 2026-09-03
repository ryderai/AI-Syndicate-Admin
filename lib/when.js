/* A DATE AND A TIME, AS TWO HALVES THAT CANNOT BE HALF-ANSWERED — 2 Sep 2026.
 *
 * Ryder: "it wasnt adding because i didnt put in am or pm."
 *
 * WHAT WENT WRONG, exactly. Both places that ask for a date used
 * `<input type="datetime-local">`. That control has five sub-fields, and until
 * every one of them is filled it reports its value as the EMPTY STRING — so a
 * field reading `10/25/2026, 01:00 --` on screen answers, to the code, as
 * nothing at all. The form refused with "when are you picking this back up?"
 * while the date was plainly there, and nothing said the missing piece was
 * AM/PM. A control that looks complete and answers empty is a trap, and the fix
 * is not a better error message — it is a control that cannot be half-filled.
 *
 * Everything here is pure. No React, no DOM: the component is
 * src/components/admin/whenPicker.jsx and these are the rules it follows.
 */

export const STEP_MINUTES = 30;
export const FIRST_HOUR = 6;    /* earlier than anybody books, late enough to keep the list short */
export const LAST_HOUR = 20;

/** 540 → "9:00 AM". AM/PM in words, so there is nothing to type and nothing to forget. */
export function clockLabel(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n < 0 || n > 24 * 60) return "";
  const h24 = Math.floor(n / 60) % 24;
  const m = n % 60;
  const ampm = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Every time on the grid, as minutes past midnight. */
export function timeSlots() {
  const out = [];
  for (let m = FIRST_HOUR * 60; m <= LAST_HOUR * 60; m += STEP_MINUTES) out.push(m);
  return out;
}

/** An ISO string → { date: "YYYY-MM-DD", minutes } in LOCAL time, or nulls. */
export function splitWhen(iso) {
  if (!iso) return { date: "", minutes: null };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", minutes: null };
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    minutes: d.getHours() * 60 + d.getMinutes(),
  };
}

/**
 * The two halves → an ISO string, or NULL while either half is missing.
 *
 * Null is the whole point: a caller can trust it to mean "not answered yet"
 * rather than having to know that an empty string from a datetime input might
 * mean "half typed".
 */
export function joinWhen(date, minutes) {
  if (!date || minutes === null || minutes === undefined || minutes === "") return null;
  const parts = String(date).split("-").map(Number);
  const [y, mo, d] = parts;
  if (parts.length !== 3 || !y || !mo || !d) return null;
  const n = Number(minutes);
  if (!Number.isFinite(n)) return null;
  const out = new Date(y, mo - 1, d, Math.floor(n / 60), n % 60, 0, 0);
  return Number.isNaN(out.getTime()) ? null : out.toISOString();
}

/**
 * Which half is missing, in words, or null when the answer is complete.
 *
 * "Pick a date" and "Pick a time" are different sentences, and the entire
 * reason this file exists is that the person could not tell which one they were
 * being asked for.
 */
export function whenProblem(date, minutes) {
  const noTime = minutes === null || minutes === undefined || minutes === "";
  if (!date && noTime) return "Pick a date and a time.";
  if (!date) return "Pick a date.";
  if (noTime) return "Pick a time.";
  return null;
}

/** A sensible starting point: `9:00 AM` on the given day, or the nearest half hour. */
export function defaultMinutes({ past = false, now = new Date() } = {}) {
  if (!past) return 9 * 60;
  const m = now.getHours() * 60 + now.getMinutes();
  return Math.max(FIRST_HOUR * 60, Math.floor(m / STEP_MINUTES) * STEP_MINUTES);
}

/** "YYYY-MM-DD" for a Date, in LOCAL time — never toISOString().slice(0,10). */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
