/* THE SHEET — CJ's outreach spreadsheet, column for column, as data.
 *
 * A PLAIN .js MODULE ON PURPOSE, for the same reason src/lib/opsSort.js is one:
 * node can import it, so every rule below is covered by tests/sales-sheet
 * instead of only ever being exercised by a browser.
 *
 * Ryder, Aug 25 2026: *"i dont like how the business has a dropdown with the
 * owner below, thats not needed, just make it rows of the people. you can take
 * inspo from the google sheet that there using already."*
 *
 * So the firm stops being a wrapper you open and becomes a column you read.
 * One row per person, in the sheet's own order, and the firm-level warning the
 * grouped view carried ("2 reps working this firm") moves onto the Company
 * cell so that flattening the table does not delete the loudest rule in the
 * Rules of Engagement.
 *
 * WHAT IS DELIBERATELY NOT A COPY OF THE SHEET
 *   "Contacted?" is COUNTED, not typed. In the sheet it is a second dropdown
 *   that says the same thing as "Sales Cycle Status", reps fill one or the
 *   other, and neither can be trusted. Here it is read off real logged touches
 *   and it cannot be edited, so it can never disagree with anything.
 *
 *   "First Contact" and "Last Touch" are read-only for the same reason: a
 *   database trigger writes them from logged calls and emails (migration 0009).
 *   They are what the 3-business-day and 14-day timers count, and a timer you
 *   can type over is a timer that never fires — which is exactly what happened
 *   in the sheet.
 */

import { claimState, cadenceState, scoreGate, isOpenStage } from "../../lib/sales-rules.js";

/* ------------------------------------------------------------------ */
/* The columns, in the sheet's order                                   */
/* ------------------------------------------------------------------ */

/** `where`: which record the value belongs to — that split is the whole reason
 *  the firm is a link and not a copied-down column. */
export const SHEET_COLUMNS = [
  { key: "owner", label: "Sales Owner", width: 158, where: "lead", edit: "person", sortable: true, filterable: true, groupable: true },
  { key: "contacted", label: "Contacted?", width: 124, where: "counted", edit: null, sortable: true, filterable: true, groupable: true },
  { key: "stage", label: "Sales Cycle Status", width: 168, where: "lead", edit: "select", sortable: true, filterable: true, groupable: true },
  { key: "claim", label: "Claim", width: 148, where: "counted", edit: null, sortable: true, filterable: true, groupable: true },
  { key: "first_contact", label: "First Contact", width: 116, where: "counted", edit: null, sortable: true, filterable: false, groupable: false },
  { key: "last_touch", label: "Last Touch", width: 116, where: "counted", edit: null, sortable: true, filterable: false, groupable: false },
  { key: "first_name", label: "First Name", width: 128, where: "lead", edit: "text", sortable: true, filterable: false, groupable: false },
  { key: "last_name", label: "Last Name", width: 134, where: "lead", edit: "text", sortable: true, filterable: false, groupable: false },
  /* The whole name as it was actually given to us. Off by default — the sheet
   * shows two columns, not three — but switchable on, because it is the value
   * every other screen reads (My Day, the drawer header, the client record's
   * contact name) and a person has to be able to correct it without leaving
   * the table. Editing First or Last on a row whose halves were only ever
   * GUESSED deliberately does not touch this, so without a way to edit it the
   * two could disagree for good. */
  { key: "full_name", label: "Full Name", width: 200, where: "lead", edit: "text", sortable: true, filterable: false, groupable: false },
  { key: "title", label: "Title", width: 190, where: "lead", edit: "text", sortable: true, filterable: false, groupable: false },
  { key: "company", label: "Company", width: 200, where: "company", edit: null, sortable: true, filterable: true, groupable: true },
  { key: "email", label: "Email", width: 216, where: "lead", edit: "text", sortable: true, filterable: false, groupable: false },
  { key: "phone", label: "Phone", width: 140, where: "lead", edit: "text", sortable: true, filterable: false, groupable: false },
  { key: "city", label: "City", width: 130, where: "lead", edit: "text", sortable: true, filterable: false, groupable: false },
  { key: "state", label: "State", width: 76, where: "lead", edit: "text", sortable: true, filterable: true, groupable: true },
  { key: "site_score", label: "Site Score", width: 118, where: "company", edit: null, sortable: true, filterable: false, groupable: false },
  { key: "website", label: "Website", width: 188, where: "company", edit: null, sortable: true, filterable: false, groupable: false },
  { key: "list", label: "List", width: 168, where: "lead", edit: "select", sortable: true, filterable: true, groupable: true },
  { key: "touches", label: "Touches", width: 104, where: "counted", edit: null, sortable: true, filterable: false, groupable: false },
  /* Ryder, Aug 26 2026: Next Steps/Notes goes to the FAR RIGHT of the sheet.
   * It is the one wide free-text cell, and sitting 7th it pushed the short
   * columns a rep scans — name, firm, email — off the right of the screen.
   * Last means the notes can be as wide as they like and cost nothing. */
  { key: "next_step", label: "Next Steps/Notes", width: 260, where: "lead", edit: "popout", sortable: true, filterable: false, groupable: false },
];

export const SHEET_COLUMN_KEYS = SHEET_COLUMNS.map((c) => c.key);

/** The columns you always see. The rest are switched on from the ⚙ menu.
 *  Kept short on purpose: the sheet's six human columns plus who the person
 *  is and where they work is what a rep actually reads. */
export const DEFAULT_SHEET_COLUMNS = [
  "owner", "contacted", "stage", "claim", "first_contact", "last_touch",
  "first_name", "last_name", "title", "company", "email", "site_score",
  /* Last here too, or the default view would put the notes back in the middle
   * while SHEET_COLUMNS says they belong at the end. Aug 26 2026. */
  "next_step",
];

export const SORTABLE = new Set(SHEET_COLUMNS.filter((c) => c.sortable).map((c) => c.key));
export const FILTERABLE = new Set(SHEET_COLUMNS.filter((c) => c.filterable).map((c) => c.key));
export const GROUPABLE = new Set(SHEET_COLUMNS.filter((c) => c.groupable).map((c) => c.key));

export function columnLabel(key) {
  return SHEET_COLUMNS.find((c) => c.key === key)?.label || key;
}

/* ------------------------------------------------------------------ */
/* Splitting a name — and why it is only ever a fallback               */
/* ------------------------------------------------------------------ */

/**
 * Best guess at first/last from one written name.
 *
 * ONLY used to fill the two new columns for rows that arrived before they
 * existed. `name` itself is never overwritten by this — it stays the record of
 * what we were actually given, so a wrong guess here is visible and fixable
 * rather than destructive.
 *
 * First word first, everything else last. That is wrong for "Mary Jo Van Der
 * Berg" and there is no rule that is right for every name, so the guess is
 * marked `derived: true` and the cell says so on hover.
 */
export function splitName(full) {
  const s = String(full ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { first: "", last: "", derived: false };
  const i = s.indexOf(" ");
  if (i < 0) return { first: s, last: "", derived: true };
  return { first: s.slice(0, i), last: s.slice(i + 1), derived: true };
}

/** The display name a first/last edit should produce. Empty halves are
 *  dropped rather than leaving a leading or trailing space. */
export function joinName(first, last) {
  return [String(first ?? "").trim(), String(last ?? "").trim()].filter(Boolean).join(" ") || null;
}

/** What to show in First Name / Last Name for one lead.
 *  Real stored columns win; the split is only reached when both are empty. */
export function nameParts(lead) {
  const f = String(lead?.first_name ?? "").trim();
  const l = String(lead?.last_name ?? "").trim();
  if (f || l) return { first: f, last: l, derived: false };
  return splitName(lead?.name);
}

/* ------------------------------------------------------------------ */
/* Contacted? — counted, never typed                                   */
/* ------------------------------------------------------------------ */

/**
 * Has anybody actually spoken to this person, AND CAN WE STILL READ IT?
 *
 * Three answers, not two, because the page cannot see the whole history and
 * saying "No" for something it merely cannot reach would be the table making
 * something up.
 *
 * THE WINDOW IS THE POINT. `getSalesBoard` reads the last 90 days of activity,
 * so `touchCount` is a count within that window and NOT a lifetime total. The
 * first version of this function said "Nothing has ever been logged against
 * this person" from a 90-day count — which was flatly false for anyone worked
 * hard in the spring and quiet since, and disagreed with that same person's own
 * Timeline tab, which reads their whole history with no window at all. Found by
 * a reviewer, not by a test.
 *
 *   yes    — at least one call/email/text/LinkedIn row inside the window.
 *   older  — a first-contact date is on record, but nothing inside the window.
 *            (That date is written either by a logged touch or by the
 *            spreadsheet import; from here the two cannot be told apart, so the
 *            wording covers both and claims neither.)
 *   no     — no first-contact date, and nothing inside the window.
 */
export function contactedState(lead, touchCount = 0, windowDays = 90) {
  const touches = Number.isFinite(Number(touchCount)) ? Number(touchCount) : 0;
  const w = Number.isFinite(Number(windowDays)) && Number(windowDays) > 0 ? Number(windowDays) : null;
  const within = w ? `the last ${w} days` : "the period loaded";

  if (touches > 0) {
    return {
      value: "yes",
      label: `Yes · ${touches} touch${touches === 1 ? "" : "es"}`,
      short: "Yes",
      color: "green",
      why: `${touches} call${touches === 1 ? "" : "s"}, email${touches === 1 ? "" : "s"} or message${touches === 1 ? "" : "s"} logged in ${within}.`,
    };
  }
  if (lead?.first_contact_at) {
    return {
      value: "older",
      label: "Yes, but not lately",
      short: "Yes, older",
      color: "yellow",
      why: `A first-contact date is on this record (${sheetDate(lead.first_contact_at) || "date unreadable"}), but nothing has been logged in ${within}. Open the record to read the whole history.`,
    };
  }
  return {
    value: "no",
    label: "No",
    short: "No",
    color: "default",
    why: `No first-contact date on this record, and nothing logged in ${within}.`,
  };
}

export const CONTACTED_ORDER = ["no", "older", "yes"];

/* ------------------------------------------------------------------ */
/* One row of the table                                                */
/* ------------------------------------------------------------------ */

/**
 * Fold a lead, its firm, its owner and its timers into one flat row.
 *
 * Everything the table sorts, filters, groups and renders comes from here, so
 * a row can never be sorted by one value and painted with another. That is not
 * theoretical: the Operations table shipped with `groupTasks` and `sortValue`
 * reading the same missing phase as two different ranks.
 */
export function sheetRow(lead, { companyById, teamName, touchCounts = {}, listById, now, activityWindowDays = 90 }) {
  const company = lead.company_id ? (companyById?.get(lead.company_id) || null) : null;
  const touches = Number(touchCounts[lead.id] || 0);
  const parts = nameParts(lead);
  return {
    lead,
    company,
    id: lead.id,
    ownerName: lead.owner_id ? (teamName?.(lead.owner_id) || null) : null,
    firstName: parts.first,
    lastName: parts.last,
    nameDerived: parts.derived,
    /* The firm name on the LEAD is the sheet's copied-down text. It is the
     * fallback only — where a firm record exists, it is the one that gets
     * scored and the one that has to be shown, or a rep reads a stale name
     * next to a fresh score. */
    companyName: company?.name || lead.company || null,
    domain: company?.domain || lead.domain || null,
    score: readScore(company?.site_score),
    touches,
    contacted: contactedState(lead, touches, activityWindowDays),
    claim: claimState(lead, now),
    cadence: cadenceState(lead, now, touches),
    listName: lead.list_id ? (listById?.get(lead.list_id)?.name || null) : null,
    gate: scoreGate(company?.site_score),
  };
}

/**
 * A site score, or null.
 *
 * `Number("")` is 0 and `Number(null)` is 0. Either one read as a score makes
 * an unscored firm look like the worst site on the list — the widest gap, the
 * one a rep goes at hardest. Anything not a whole number inside 0–100 is
 * UNKNOWN.
 */
export function readScore(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

export function sheetRows(leads, ctx) {
  return (leads || []).map((l) => sheetRow(l, ctx));
}

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

const STAGE_ORDER = [
  "new", "researching", "contacted", "in_conversation", "follow_up",
  "meeting", "proposal", "won", "lost", "reopened", "skip_90", "bad_contact",
];
/* Worst first: the claim states somebody has to do something about, in the
 * order they have to be done, then the quiet ones. These are exactly the
 * strings claimState() returns in lib/sales-rules.js — a name that is not on
 * that list ranks last rather than silently becoming "blank", which is the
 * bug that made the Operations table sort and group disagree. */
export const CLAIM_ORDER = [
  "claim_expired", "cold", "first_contact_due", "going_cold",
  "first_contact", "working", "unclaimed", "closed",
];

/** The words a person reads for each of those states. */
export const CLAIM_LABELS = {
  claim_expired: "Claim ran out",
  cold: "Gone cold",
  first_contact_due: "First contact due",
  going_cold: "Going cold",
  first_contact: "First contact owed",
  working: "Being worked",
  unclaimed: "On the floor",
  closed: "Finished with",
};

/** Red, amber, or quiet. */
export const CLAIM_COLOR = {
  claim_expired: "red",
  cold: "red",
  first_contact_due: "yellow",
  going_cold: "yellow",
  first_contact: "blue",
  working: "green",
  unclaimed: "default",
  closed: "default",
};

/** One column's value as { blank, v }.
 *
 *  `blank` is its own field and never a magic number — encoding "missing" as
 *  -1 or 99 is what made the Operations table sort and group disagree.
 *  Present-but-unrecognised values rank AFTER the known ones and are not blank,
 *  so a stage from an import that is not on our ladder still sorts somewhere
 *  sensible instead of sinking in both directions.
 */
export function sortValue(row, key) {
  const text = (v) => {
    const x = String(v ?? "").trim().toLowerCase();
    return { blank: x === "", v: x };
  };
  const num = (v) => (v === null || v === undefined
    ? { blank: true, v: 0 }
    : { blank: false, v: Number(v) });
  const ranked = (v, list) => {
    if (v === null || v === undefined || v === "") return { blank: true, v: list.length + 1 };
    const i = list.indexOf(v);
    return { blank: false, v: i === -1 ? list.length : i };
  };
  /* Dates sort as ISO strings, which is the same order as time, and blanks
   * sink. Never `new Date(x)` — a bare YYYY-MM-DD is midnight UTC, which is
   * the evening BEFORE in Chicago, and that trap has already cost this repo
   * three shipped bugs. */
  const date = (v) => text(v);

  switch (key) {
    case "owner": return text(row.ownerName);
    case "contacted": return ranked(row.contacted.value, CONTACTED_ORDER);
    case "stage": return ranked(row.lead.stage, STAGE_ORDER);
    case "claim": return ranked(row.claim.state, CLAIM_ORDER);
    case "first_contact": return date(row.lead.first_contact_at);
    case "last_touch": return date(row.lead.last_touch_at);
    case "next_step": return text(row.lead.next_step);
    case "first_name": return text(row.firstName);
    case "last_name": return text(row.lastName);
    case "full_name": return text(row.lead.name);
    case "title": return text(row.lead.title);
    case "company": return text(row.companyName);
    case "email": return text(row.lead.email);
    case "phone": return text(row.lead.phone);
    case "city": return text(row.lead.city);
    case "state": return text(row.lead.state);
    case "site_score": return num(row.score);
    case "website": return text(row.domain);
    case "list": return text(row.listName);
    case "touches": return num(row.touches);
    default: return null;
  }
}

/** The table's own order when nothing is sorted.
 *
 *  Not "newest first". A sales list read top to bottom should start with the
 *  thing that is late: claims that have run out, then first contact due, then
 *  cold. Inside a state, the one waiting longest is first.
 */
export function defaultOrder(rows) {
  const rank = (r) => {
    const i = CLAIM_ORDER.indexOf(r.claim.state);
    return i === -1 ? CLAIM_ORDER.length : i;
  };
  return [...rows].sort((a, b) => {
    const ar = rank(a);
    const br = rank(b);
    if (ar !== br) return ar - br;
    const ao = a.claim.over;
    const bo = b.claim.over;
    /* `over` is days past the line; null means no clock is running. A row with
     * no clock must not read as 0 days late and jump the queue. */
    const an = ao === null || ao === undefined;
    const bn = bo === null || bo === undefined;
    if (an !== bn) return an ? 1 : -1;
    if (!an && ao !== bo) return bo - ao;
    const ac = String(a.companyName || "");
    const bc = String(b.companyName || "");
    if (ac !== bc) return ac.localeCompare(bc);
    return String(a.lastName || a.firstName || "").localeCompare(String(b.lastName || b.firstName || ""));
  });
}

/** Never mutates. Blanks sink in BOTH directions — a row with no last-touch
 *  date floating to the top of "most recent first" is not information. */
export function sortRowsBy(rows, sort) {
  /* An unknown key must not fall through to the tie-breaker: that silently
   * reorders the whole table while the arrow claims the column is sorted. */
  if (!sort || !sort.key || !SORTABLE.has(sort.key)) return defaultOrder(rows);
  const dir = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    if (!av || !bv) return 0;
    if (av.blank !== bv.blank) return av.blank ? 1 : -1;
    if (av.v === bv.v) {
      const ac = String(a.companyName || "");
      const bc = String(b.companyName || "");
      if (ac !== bc) return ac.localeCompare(bc);
      return String(a.lastName || a.firstName || "").localeCompare(String(b.lastName || b.firstName || ""));
    }
    return (av.v < bv.v ? -1 : 1) * dir;
  });
}

/** Click 1 the useful way, click 2 the other way, click 3 off. */
export function nextSort(cur, key) {
  if (!SORTABLE.has(key)) return cur;
  if (!cur || cur.key !== key) return { key, dir: "asc" };
  if (cur.dir === "asc") return { key, dir: "desc" };
  return null;
}

/* ------------------------------------------------------------------ */
/* Filtering and grouping                                              */
/* ------------------------------------------------------------------ */

/** The value one row carries for a filterable column, as the string the
 *  filter compares. "__none" is a real value here, not an absence: the page
 *  filters on String(x || "__none") and a column holding "" has to travel the
 *  same way or the click sets a filter that matches nothing. */
export function facetValue(row, key) {
  switch (key) {
    case "owner": return String(row.lead.owner_id || "__none");
    case "contacted": return row.contacted.value;
    case "stage": return String(row.lead.stage || "__none");
    case "claim": return String(row.claim.state || "__none");
    case "company": return String(row.lead.company_id || "__none");
    case "state": return String(row.lead.state || "__none");
    case "list": return String(row.lead.list_id || "__none");
    default: return "__none";
  }
}

/** Every value a column holds across the rows given, commonest first and
 *  "none" last, with a count each.
 *
 *  ALWAYS pass the UNFILTERED rows. Built from what is on screen, one filter
 *  shrinks every other column's menu to the values that survived it, and a
 *  value outside the current filter cannot be reached from the header at all.
 */
export function facetValues(rows, key) {
  if (!FILTERABLE.has(key)) return [];
  const counts = new Map();
  for (const r of rows) {
    const v = facetValue(r, key);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => {
    if ((a[0] === "__none") !== (b[0] === "__none")) return a[0] === "__none" ? 1 : -1;
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
}

/**
 * Group the rows, or hand back one unnamed group when grouping is off.
 *
 * FLAT IS THE DEFAULT and that is the point of this whole rebuild. Grouping is
 * something you switch on, look at, and switch off again.
 */
export function groupRows(rows, groupBy, { labelFor }) {
  if (!groupBy || groupBy === "none" || !GROUPABLE.has(groupBy)) {
    return [{ key: "__all", label: null, rows }];
  }
  const map = new Map();
  for (const r of rows) {
    const k = facetValue(r, groupBy);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  const out = [...map.entries()].map(([key, group]) => ({
    key,
    label: labelFor(groupBy, key),
    rows: group,
  }));
  out.sort((a, b) => {
    if ((a.key === "__none") !== (b.key === "__none")) return a.key === "__none" ? 1 : -1;
    return String(a.label || "").localeCompare(String(b.label || ""));
  });
  return out;
}

/**
 * How many firms have more than one rep on them, and which rows those are.
 *
 * The grouped table showed this as a banner on the firm header. Flattened, it
 * has to live on the row or it disappears — and "one firm, one rep" is the
 * loudest rule on the Rules of Engagement tab. Losing it to a layout change
 * would be the rebuild quietly making the system worse.
 *
 * Counted across EVERY lead the page holds, not the filtered rows: filter to
 * your own leads and a firm somebody else is also working stops looking
 * contested, which is precisely the moment you need to be told.
 */
export function contestedCompanies(allLeads) {
  const byCompany = new Map();
  for (const l of allLeads || []) {
    if (!l.company_id || !l.owner_id) continue;
    /* OPEN STAGES ONLY. Without this, a firm where one rep's contact is Lost
     * and another's is live read as "2 reps are working this firm" — and the
     * drawer, which uses companyClaimWarning() in lib/sales-rules.js and DOES
     * filter on open stages, showed no warning at all for the same firm. Two
     * parts of one page giving opposite answers about the same thing is worse
     * than either answer alone. */
    if (!isOpenStage(l.stage)) continue;
    if (!byCompany.has(l.company_id)) byCompany.set(l.company_id, new Set());
    byCompany.get(l.company_id).add(l.owner_id);
  }
  const out = new Map();
  for (const [companyId, owners] of byCompany) {
    if (owners.size > 1) out.set(companyId, [...owners]);
  }
  return out;
}

/** How many people we hold at each firm, so a flat row can still say
 *  "1 of 4 at this firm" without the reader having to group the table. */
export function companyHeadcount(allLeads) {
  const out = new Map();
  for (const l of allLeads || []) {
    if (!l.company_id) continue;
    out.set(l.company_id, (out.get(l.company_id) || 0) + 1);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Dates, the way the sheet writes them                                */
/* ------------------------------------------------------------------ */

/**
 * `8/24/26`, in the team's own day.
 *
 * ALWAYS through `Intl` with an explicit zone, never `new Date(x)` on a bare
 * `YYYY-MM-DD` and never a hardcoded offset. Chicago is UTC-5 in summer and
 * UTC-6 in winter; a fixed -5 puts every 11pm-to-midnight timestamp on the
 * wrong day for half the year, and a test suite with an August clock can never
 * see it. This repo has already shipped that bug three times.
 */
export function sheetDate(iso, tz = "America/Chicago") {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz, month: "numeric", day: "numeric", year: "2-digit",
    }).format(d);
  } catch {
    return null;
  }
}

/** The same instant, written out in full, for the hover text. */
export function sheetDateLong(iso, tz = "America/Chicago") {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    }).format(d);
  } catch {
    return null;
  }
}
