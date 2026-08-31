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

import { claimState, cadenceState, scoreGate, isOpenStage, daysBetween } from "../../lib/sales-rules.js";
/* Tags are an EVENT LOG, not a column: a lead's tags right now are the result
 * of replaying its add and remove events. That reading lives in one place so the
 * chips on the row, the filter menu, the drawer's dated history and the overnight
 * sweep cannot come to four different answers about one lead. */
import { currentTags } from "../../lib/lead-tags.js";

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
  /* Last Touch became FILTERABLE on Aug 27 2026, on a BAND rather than on its
   * own value — today / within 7 days / over 7 / over 14 / never. A menu of
   * every distinct timestamp is not a filter, and "who has gone quiet" is the
   * question a rep actually asks. See touchBandOf at the bottom of this file. */
  { key: "last_touch", label: "Last Touch", width: 116, where: "counted", edit: null, sortable: true, filterable: true, groupable: true },
  /* TAGS — Aug 27 2026. The one MULTI-VALUED column: a lead carries several, so
   * every filter goes through facetValuesOf() rather than facetValue(), and
   * grouping by it puts a row under each of its tags. Placed here, straight
   * after the claim clock, because that is the order the Floor reads in: whose
   * is it, where is it, how long have we got, what kind of thing is it.
   *
   * It is NOT before index 6 and next_step is still last — tests/sales-sheet
   * pins both of those, and they pin them because CJ's own column order is the
   * thing this table exists to reproduce. */
  { key: "tags", label: "Tags", width: 232, where: "tags", edit: "tags", sortable: true, filterable: true, groupable: true, multi: true },
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
  /* City became filterable on the same day, and for the same reason as State
   * already was: "the medspas in Destin" is a real question and there is no way
   * to ask it from a search box that also matches an email address. */
  { key: "city", label: "City", width: 130, where: "lead", edit: "text", sortable: true, filterable: true, groupable: true },
  { key: "state", label: "State", width: 76, where: "lead", edit: "text", sortable: true, filterable: true, groupable: true },
  /* TWO COLUMNS THAT HAVE ARRIVED WITH EVERY SHEET IMPORT SINCE AUG 25 AND HAVE
   * BEEN DISPLAYED NOWHERE. `employees` and `vertical` are real columns on
   * admin_companies, filled by lib/sales-import.js from the Apollo block, and
   * until today there was no way to see or filter either one. Both filter on a
   * BAND or on the value; neither is editable here, because they belong to the
   * firm and the firm is edited on the firm. */
  { key: "employees", label: "Company size", width: 128, where: "company", edit: null, sortable: true, filterable: true, groupable: true },
  { key: "vertical", label: "Type of business", width: 150, where: "company", edit: null, sortable: true, filterable: true, groupable: true },
  /* The ONE number admin_companies can hold, and the only score that exists
   * until a platform scan address does. Filterable on a band from Aug 27. */
  { key: "site_score", label: "Site Score", width: 118, where: "company", edit: null, sortable: true, filterable: true, groupable: true },
  /* THE THREE SCORES A SCAN RETURNS — AI Access, SEO, and how often the firm
   * gets named when a buyer asks an AI a question. Read from the newest
   * admin_company_reports row for the firm (0019), never from a column, so a
   * re-scan is a new row and last month's number is still on record.
   *
   * NOT filterable and NOT groupable, deliberately: the thing anybody filters on
   * is the band, and `site_score` above already offers exactly that menu.
   * Two menus that mean nearly the same thing is how a person ends up filtering
   * on the wrong one and reading a number that does not match. */
  { key: "scores", label: "Scores", width: 168, where: "report", edit: null, sortable: true, filterable: false, groupable: false },
  /* DRAFT AN EMAIL — Ryder, 31 Aug 2026. An action column, like Scores, not a
   * value: there is nothing stored to sort or filter on, so it is neither
   * sortable nor filterable and saying so here is what stops a header menu
   * offering a menu of nothing.
   *
   * Sits beside Website because that is where a rep's eye already is when they
   * are deciding whether to write — the firm, the site, the email. */
  { key: "draft_email", label: "Draft email", width: 132, where: "action", edit: null, sortable: false, filterable: false, groupable: false },
  { key: "website", label: "Website", width: 188, where: "company", edit: null, sortable: true, filterable: true, groupable: true },
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
 *  is and where they work is what a rep actually reads.
 *
 *  Tags and Scores joined the default set on Aug 27 2026 — they are the two the
 *  Floor is built around, and a column that has to be switched on before the
 *  page makes sense is a column nobody finds. */
export const DEFAULT_SHEET_COLUMNS = [
  "owner", "contacted", "stage", "claim", "first_contact", "last_touch", "tags",
  "first_name", "last_name", "title", "company", "email", "site_score", "scores",
  /* On by default. A button nobody can find is a button nobody uses, and this
   * is the one the whole rebuild points at: the pipeline exists to get a rep to
   * the next message. 31 Aug 2026 */
  "draft_email",
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
export function sheetRow(lead, {
  companyById, teamName, touchCounts = {}, listById, now, activityWindowDays = 90,
  /* ---- added Aug 27 2026, all four with a safe default ----
   * A caller that does not pass them gets a row with no tags, no scan report and
   * no editability, which is exactly what an older caller meant. Defaults rather
   * than required arguments because tests/sales-sheet builds rows with the
   * original context and its 137 assertions must keep passing unchanged. */
  tagsByLead = null, tagsById = null, reportByCompany = null, member = null,
  /* ---- added Aug 30 2026 ----
   * The set of company ids somebody else is already inside, from
   * firmsHeldByOthers(). Null on the owner's page ON PURPOSE: an owner sees
   * every claimed row already, so a chip saying "somebody is working this firm"
   * on nearly every row would be noise carrying no information. Null means the
   * chip is not drawn, which is what every caller before today meant. */
  firmsBusy = null,
}) {
  const company = lead.company_id ? (companyById?.get(lead.company_id) || null) : null;
  const touches = Number(touchCounts[lead.id] || 0);
  const parts = nameParts(lead);
  const nowIso = typeof now === "string" ? now : (now ? new Date(now).toISOString() : null);
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

    /* ---- TAGS, replayed from the event log ----
     * Never a stored list. A lead's tags are the result of replaying its add and
     * remove events, which is also the dated history the drawer prints — see
     * lib/lead-tags.js for why there is no `tags` column and no `current` flag.
     * An empty array when the events have not been read is deliberate and
     * harmless: the filter menu offers "No tags" and the cell draws nothing.
     * Distinguishing "no tags" from "tags not read" is the BOARD's job, not the
     * row's — getSalesBoard carries the read error, the same way it already does
     * for leads and activity. */
    tags: (tagsByLead && tagsById) ? currentTags(tagsByLead.get(lead.id) || [], tagsById) : [],

    /* ---- THE NEWEST SCAN OF THIS FIRM ----
     * The FIRM's, not the person's: four contacts at one dealership share one
     * website, so they share one measurement. Null means no scan has been run —
     * which is a different thing from a scan that came back with nothing, and
     * readCompanyReport keeps every unmeasured half of a report null rather than
     * turning it into a zero. */
    report: (reportByCompany && lead.company_id)
      ? (readCompanyReport(reportByCompany.get(lead.company_id) || null))
      : null,

    /* How long since anybody touched them, as the band the filter bar offers.
     * Computed once here rather than in the filter, so the cell, the filter and
     * the sort cannot land on three different answers for one row at midnight. */
    touchBand: nowIso ? touchBandOf(lead.last_touch_at, nowIso) : "__none",

    /* ---- MAY THE PERSON READING THIS CHANGE IT ----
     * Derived ONCE, here, through the single exported helper. Every control on
     * the row reads `row.editable` and nothing re-derives it inline — see
     * canEditLead at the bottom of this file for the three places this rule has
     * to agree with itself. `member` defaults to null, and canEditLead(x, null)
     * is false: a page that does not know who is looking at it gets a read-only
     * row rather than an editable one. */
    editable: canEditLead(lead, member),
    heldBy: heldByLabel(lead, member, teamName),

    /* ---- IS SOMEBODY ELSE ALREADY IN THIS FIRM ----
     *
     * ANY row at that firm, not only an unclaimed one. The first version tested
     * `!lead.owner_id` on the reasoning that a firm you are in is busy with you
     * — but firmsHeldByOthers has already excluded your own claims, so the set
     * only ever contains firms SOMEBODY ELSE is in. A rep holding one contact at
     * a firm another rep is also working is precisely the person who needs
     * telling, and the old test silenced exactly them.
     *
     * This is also what replaces contestedCompanies on a rep's page: that
     * function needs two owners visible in the same list to fire, and a rep's
     * list can now hold at most one. See the block at the bottom of this file. */
    firmBusy: Boolean(firmsBusy && lead.company_id && firmsBusy.has(lead.company_id)),
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

    /* ---- the four added on Aug 27 2026 ---- */

    /* A ROW WITH NO TAGS IS BLANK, NOT ZERO TAGS. `blank` is its own field for
     * exactly this: encoding "missing" as 0 would put every untagged row in the
     * middle of the order in one direction and at the end in the other, which is
     * the bug that made the Operations table sort and group disagree.
     *
     * Sorted on the FIRST tag's label rather than on how many there are —
     * "sort by tags" means "put the medspas together", not "put the busiest rows
     * first". The list is already in the vocabulary's own order (see
     * currentTags in lib/lead-tags.js), so the first one is stable between two
     * reads of the same rows. */
    case "tags": {
      const first = (row.tags || [])[0];
      return first ? { blank: false, v: String(first.label || first.slug || "").toLowerCase() } : { blank: true, v: "" };
    }

    /* AI Access first, because it is the number this agency sells against, then
     * SEO as the tie-break. A firm with an SEO score and no AI Access score is
     * NOT blank — it has been measured, just not on the thing we lead with — so
     * it sorts after every firm that has both and before every firm with
     * neither. Reached by sorting on -1 only when at least one of the two is a
     * real number. */
    case "scores": {
      const r = row.report;
      if (!r || (r.aiAccess === null && r.seo === null)) return { blank: true, v: 0 };
      const ai = r.aiAccess === null ? 1000 : r.aiAccess;
      const seo = r.seo === null ? 1000 : r.seo;
      return { blank: false, v: ai * 1000 + seo };
    }

    case "employees": return num(readCount(row.company?.employees));
    case "vertical": return text(row.company?.vertical || row.lead.vertical);

    default: return null;
  }
}

/**
 * A head count, or null.
 *
 * The same shape as readScore and for the same reason: `Number("")` is 0 and
 * `Number(null)` is 0, and a firm with no head count sorting as a one-person
 * business is a firm a rep pitches wrongly. Anything that is not a whole number
 * of at least one person is UNKNOWN.
 */
export function readCount(v) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
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
 *  same way or the click sets a filter that matches nothing.
 *
 *  FOUR COLUMNS FILTER ON A BAND RATHER THAN ON THEIR OWN VALUE — Aug 27 2026.
 *  Site Score, Company size, Last Touch and Website hold a number, a number, a
 *  date and a URL, and none of those is a list anybody would pick from: a menu
 *  of 340 distinct head counts is not a filter. So each one's facet value is the
 *  band, and the CELL still prints the real value. The banding functions live at
 *  the bottom of this file next to each other, so the thresholds cannot drift
 *  apart across four call sites.
 *
 *  `tags` is deliberately NOT here — it is the one multi-valued column and it
 *  goes through facetValuesOf(), which every filter caller uses. A single-value
 *  entry for it would work on the rows that carry exactly one tag and quietly
 *  drop the rest.
 */
export function facetValue(row, key) {
  switch (key) {
    case "owner": return String(row.lead.owner_id || "__none");
    case "contacted": return row.contacted.value;
    case "stage": return String(row.lead.stage || "__none");
    case "claim": return String(row.claim.state || "__none");
    case "company": return String(row.lead.company_id || "__none");
    case "city": return String(row.lead.city || "__none");
    case "state": return String(row.lead.state || "__none");
    case "list": return String(row.lead.list_id || "__none");
    /* The firm's line of business, off the FIRM record where one exists — the
     * copied-down text on the lead is the fallback only, for the same reason
     * sheetRow reads the firm's name that way. Two spellings of one vertical is
     * two entries in the menu. */
    case "vertical": return String(row.company?.vertical || row.lead.vertical || "__none");
    case "site_score": return scoreBandOf(row.company?.site_score);
    case "employees": return sizeBandOf(row.company?.employees);
    case "website": return row.domain ? "yes" : "no";
    case "last_touch": return row.touchBand;
    default: return "__none";
  }
}

/** Every value a column holds across the rows given, commonest first and
 *  "none" last, with a count each.
 *
 *  ALWAYS PASS THE UNFILTERED ROWS. Built from what is on screen, one filter
 *  shrinks every other column's menu to the values that survived it, and a
 *  value outside the current filter cannot be reached from the header at all.
 *  That was a real bug in the Operations table.
 *
 *  Multi-valued columns go through facetValuesMulti() at the bottom of this
 *  file. This one is left pointing at facetValue on purpose: a caller that
 *  passes `tags` in here gets the single-value answer, which is wrong, so the
 *  guard below refuses a column marked `multi` rather than answering wrongly.
 */
export function facetValues(rows, key) {
  if (!FILTERABLE.has(key)) return [];
  const col = SHEET_COLUMNS.find((c) => c.key === key);
  if (col?.multi) return facetValuesMulti(rows, key);
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
 *
 * GROUPING BY A MULTI-VALUED COLUMN PUTS A ROW IN EVERY GROUP IT BELONGS TO —
 * Aug 27 2026, when tags arrived. A lead tagged `medspa` and `quiet` appears
 * under both, because the alternative is picking one of its tags to be the real
 * one and there is no honest way to choose.
 *
 * The consequence has to be said out loud rather than left for somebody to
 * notice: the group counts then add up to MORE than the number of rows on
 * screen. So the returned object carries `overlaps: true` and the table prints
 * one line saying a lead with several tags is listed under each of them. A set of
 * counts that quietly does not add up is worse than no counts — a rep adds them
 * up, comes out over, and stops trusting the page.
 */
export function groupRows(rows, groupBy, { labelFor }) {
  if (!groupBy || groupBy === "none" || !GROUPABLE.has(groupBy)) {
    return [{ key: "__all", label: null, rows, overlaps: false }];
  }
  const col = SHEET_COLUMNS.find((c) => c.key === groupBy);
  const multi = Boolean(col?.multi);
  const map = new Map();
  let overlaps = false;
  for (const r of rows) {
    const keys = multi ? facetValuesOf(r, groupBy) : [facetValue(r, groupBy)];
    if (keys.length > 1) overlaps = true;
    for (const k of keys) {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
  }
  const out = [...map.entries()].map(([key, group]) => ({
    key,
    label: labelFor(groupBy, key),
    rows: group,
    overlaps,
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

/* ================================================================== */
/* THE LOCK IS ON THE ROW, NOT ON THE PAGE — Aug 27 2026               */
/* ================================================================== */

/**
 * May this person change this lead?
 *
 * THIS IS THE ONLY EDITABILITY CHECK IN THE CONSOLE. Nothing may re-derive it
 * inline. One function, every caller — the row's accent edge, every button on
 * that row, the drawer's buttons, and openLeadById's read-only decision all read
 * this and nothing else. Four buttons that each worked out for themselves
 * whether they were allowed is how one of them ended up disagreeing with the
 * other three.
 *
 * WHAT REPLACED WHAT, TWICE. Read the two reversals in order or this function
 * makes no sense:
 *
 *   Before Aug 27, `scopeLeads` in SalesPage.jsx handed a rep either the
 *   unclaimed rows or their own, and the LIST was the lock.
 *
 *   Aug 27: the list stopped being narrowed — a rep saw every lead in the
 *   company — because a rep who cannot see another rep's row cannot be stopped
 *   from working the same firm. Somebody else's row rendered greyed and opened
 *   read-only. This function became the whole lock.
 *
 *   30 Aug, Ryder: "the rep doesnt see those leads... that way the reps never
 *   comingle." The list is narrowed again, by visibleToMember at the bottom of
 *   this file, and the firm collision the Aug 27 rule was protecting is carried
 *   by firmsHeldByOthers instead — a mark on the firm, naming nobody.
 *
 * WHERE THAT LEAVES THIS FUNCTION:
 *
 *     visibility: mine, or nobody's, or I am an owner/admin.  (visibleToMember)
 *     editability: exactly the same set.                      (this)
 *
 * The two now agree for every role, which means the greyed row and the read-only
 * drawer are unreachable in practice: a rep is never handed a row they may not
 * edit. THEY ARE KEPT ANYWAY, and deliberately — this function is what api/ and
 * migration 0020 check, a member with no role still fails closed here, and a
 * feature that hands a rep somebody else's row on any future screen must land on
 * a read-only drawer rather than an editable one. An unreachable guard that
 * fails closed is cheap; the same guard missing is the Aug 26 hole.
 *
 * THIS IS THE POLITE HALF OF THE LOCK, NOT THE WORKING HALF. Every file in
 * `api/` runs on the Supabase service key and ignores row-level security
 * completely, and a disabled button is a thing a person sees rather than a thing
 * that stops a request. The same rule therefore lives in three places and all
 * three must agree:
 *   1. RLS, in supabase/migrations/0020_rep_scoping.sql — plus 0021 and 0023,
 *      which put it inside the two `security definer` functions that write past
 *      RLS by design (admin_lead_claim_text and admin_lead_to_client);
 *   2. a JavaScript check wherever a lead is written FROM AN ID THE CALLER CHOSE.
 *      As of Aug 27 2026 that is api/sales-score.js (which scopes the Skip-90
 *      stage change), api/gmail-send.js and api/gmail-drafts.js (both through
 *      `leadWeMayWrite()`), and lib/assistant-tools.js — a library rather than an
 *      endpoint, and named here because api/ai-chat.js writes leads through it.
 *
 *      TWO PLACES DELIBERATELY DO NOT HAVE IT, and both are on record:
 *      api/gmail-threads.js writes a first reply and a bounce, which are things
 *      that HAPPENED in a mailbox the caller was already granted rather than
 *      instructions they composed — gating them on the viewer lost the
 *      observation permanently, because each is a one-shot stamped only while
 *      somebody has the page open. api/lead-scrape.js sets `owner_id` from a
 *      saved source's own `assign_to`, which is an owner's configuration rather
 *      than a rep's request. Neither is a gap by accident.
 *   3. here.
 *
 * THE ONE DELIBERATE EXCEPTION, named so it is not mistaken for a gap:
 * api/sales-score.js writes a `score` timeline row on EVERY contact at a firm
 * regardless of who holds them. That is a dated fact about the firm's website
 * rather than a claim about anybody's conversation, and withholding it would
 * leave two reps at one dealership holding two different pictures of the same
 * site — the exact failure one-scan-per-firm exists to prevent. The reasoning is
 * written out at that write.
 *
 * Trap #6 and trap #8 in CONTEXT-FOR-AI.md §8 are both this mistake, already
 * made twice in this repo before today, and a third and fourth time found today.
 *
 * A MISSING MEMBER IS NOT AN OWNER. It returns false. `member` can be null on
 * exactly one code path (AdminDashboard renders nothing for it) and a fail-open
 * default here would hand the whole floor to a page that does not know who is
 * looking at it.
 */
export function canEditLead(lead, member) {
  if (!lead || !member) return false;
  /* A MEMBER WITH NO ROLE AT ALL IS NOT AN OWNER.
   *
   * This line was missing, and `member.role !== "sales"` was therefore true for
   * `{}` — so a page that had lost track of who was looking at it handed out
   * edit rights on every lead in the company, including another rep's. Not
   * reachable today (AuthGate refuses a member with no membership row) but the
   * comment in AdminDashboard.jsx says in as many words that a member with no
   * role FAILS OPEN in three places and that this is one of them. Found by
   * tests/floor-scoping, Aug 27 2026. */
  if (!member.role) return false;
  /* Every role that is not `sales` may edit anything. Written as "not sales"
   * rather than "owner or admin" on purpose: a role nobody has taught this file
   * about must not silently lose the ability to work, and the roles that exist
   * are constrained where they are decided — admin_users.role in 0001. */
  if (member.role !== "sales") return true;
  return lead.owner_id === member.user_id || lead.owner_id == null;
}

/** Who is holding this row, in the words the marker on it uses. Null when the
 *  reader may edit it — a "held by" marker on your own row is noise. */
export function heldByLabel(lead, member, teamName) {
  if (canEditLead(lead, member)) return null;
  /* NOBODY HOLDS AN UNCLAIMED ROW. Reachable only for a member with no role at
   * all, whom canEditLead refuses everything: without this, an unclaimed lead
   * gave `teamName(null)` → null → "Held by another rep", a lock marker on a
   * free row. Found by an adversarial review, 30 Aug 2026. */
  if (!lead?.owner_id) return null;
  const name = teamName ? (teamName(lead.owner_id) || "another rep") : "another rep";
  return `Held by ${name}`;
}

/* ================================================================== */
/* AVAILABILITY — Mine · Available · All                               */
/* ================================================================== */

/**
 * The three-state switch at the far left of the filter bar.
 *
 * IT IS A FILTER OVER THE PAGE'S SET, NOT A NEW FETCH. That is the whole
 * architecture in one sentence: one read, one row builder, three layouts. A page
 * that fetches its own leads is a page with its own snapshot, and two snapshots
 * of one pipeline is how a tile ends up disagreeing with the list under it.
 *
 * IT SAID "THE FULL BOARD" UNTIL 30 AUG, and that was true then: the page held
 * every lead and this switch was the only thing narrowing it. The page's set is
 * now visibleToMember's — mine or nobody's — and this filters that. So "All" is
 * the union of the other two buttons rather than the whole company.
 *
 * `all` is the default on load. It was `mine`, back when All meant the company;
 * now that All IS a rep's workable book, opening on Mine put a new rep who holds
 * nothing in front of an empty table with every list tab reading 0.
 */
export const AVAILABILITY = ["mine", "available", "all"];

export const AVAILABILITY_LABELS = {
  mine: "Mine",
  available: "Available",
  all: "All",
};

export const AVAILABILITY_HINTS = {
  mine: "The leads you hold.",
  available: "Nobody has claimed these. Press Claim to take one.",
  /* WAS "Every lead in the company. Somebody else's opens read-only." That
   * sentence stopped being true on 30 Aug: a rep no longer holds another rep's
   * rows in the set at all, so "All" is now the union of the other two buttons
   * and the words have to say so. A label that describes a rule the page has
   * dropped is worse than no label. */
  all: "Everything you can work \u2014 the ones you hold and the ones nobody holds.",
};

/** An unknown value falls back to `all` — which is also the default now. A typo
 *  in a stored value should show a rep everything they may work, not hide rows
 *  they hold and make the page look broken. `all` cannot over-show: it is bounded
 *  by visibleToMember before this ever runs. */
export function cleanAvailability(v) {
  return AVAILABILITY.includes(v) ? v : "all";
}

export function availabilityOf(lead, member) {
  if (!lead?.owner_id) return "available";
  return lead.owner_id === member?.user_id ? "mine" : "theirs";
}

/** Narrow a lead list by the switch. `all` returns the same array, not a copy —
 *  the caller never mutates it and a copy of two thousand rows on every
 *  keystroke is a page that feels slow for no reason. */
export function byAvailability(leads, mode, member) {
  const m = cleanAvailability(mode);
  if (m === "all") return leads || [];
  if (m === "mine") return (leads || []).filter((l) => l.owner_id && l.owner_id === member?.user_id);
  return (leads || []).filter((l) => !l.owner_id);
}

/** How many rows each state of the switch would show, counted from the same set
 *  the switch is about to narrow — so the number on the button and the list
 *  under it agree by construction. */
export function availabilityCounts(leads, member) {
  const rows = leads || [];
  return {
    mine: rows.filter((l) => l.owner_id && l.owner_id === member?.user_id).length,
    available: rows.filter((l) => !l.owner_id).length,
    all: rows.length,
  };
}

/* ================================================================== */
/* FILTERS THAT STACK, AND HOLD MORE THAN ONE VALUE                    */
/* ================================================================== */

/**
 * Until today the table held ONE value per column: `{ owner: "<id>" }`. State
 * could be FL or AL, never both, and seven columns could be filtered at all.
 *
 * The shape is now `{ colKey: Set<value> }` — several columns at once, several
 * values each, each one a removable chip. `null`/absent means that column is not
 * filtered.
 *
 * WHY A SET AND NOT AN ARRAY: the only two questions ever asked of it are "is
 * this value on?" and "how many are on?", and an array turns the first into a
 * scan on every row of every render.
 */

/** Every value a row carries for a filterable column.
 *
 *  ONE COLUMN CAN CARRY SEVERAL — that is what tags are. Single-valued columns
 *  return a one-item array, so every caller has one shape to handle. A row with
 *  no tags at all returns ["__none"], which is a real value the filter menu
 *  offers as "No tags": a rep filtering for untagged rows is filtering for
 *  something, and returning an empty array would make that row match nothing
 *  and disappear from every count.
 */
export function facetValuesOf(row, key) {
  if (key === "tags") {
    const slugs = (row?.tags || []).map((t) => t.slug).filter(Boolean);
    return slugs.length ? slugs : ["__none"];
  }
  return [facetValue(row, key)];
}

/**
 * Does this row survive every filter that is on?
 *
 * AND across columns, OR inside one column. "State is FL or AL" and "stage is
 * Contacted" is one question with two clauses, and it is the question a person
 * means when they click two states and one stage. Written out rather than
 * folded into a clever reduce, because getting the two the wrong way round makes
 * the bar quietly show nothing and there is no error to read.
 */
export function matchesFacets(row, facets) {
  if (!facets) return true;
  for (const key of Object.keys(facets)) {
    const want = facets[key];
    if (!want || typeof want.size !== "number" || want.size === 0) continue;
    const have = facetValuesOf(row, key);
    if (!have.some((v) => want.has(v))) return false;
  }
  return true;
}

/** Rows that survive the filters. */
export function applyFacets(rows, facets) {
  const keys = Object.keys(facets || {}).filter((k) => facets[k]?.size);
  if (!keys.length) return rows || [];
  return (rows || []).filter((r) => matchesFacets(r, facets));
}

/** Add or take away one value. Never mutates: React only re-renders when the
 *  object identity changes, and a mutated Set is a filter that applies on the
 *  next unrelated keystroke instead of on the click. */
export function toggleFacetValue(facets, key, value) {
  const next = { ...(facets || {}) };
  const cur = new Set(next[key] || []);
  if (cur.has(value)) cur.delete(value);
  else cur.add(value);
  if (cur.size) next[key] = cur;
  else delete next[key];
  return next;
}

/** Drop one whole column's filter. */
export function clearFacet(facets, key) {
  const next = { ...(facets || {}) };
  delete next[key];
  return next;
}

/** Is anything on? What "Clear all" reads to decide whether to draw itself. */
export function anyFacetOn(facets) {
  return Object.keys(facets || {}).some((k) => facets[k]?.size);
}

/** One chip per value that is on, in a stable order, each carrying what to call
 *  it and what removing it does. Built here rather than in the component so the
 *  chips and the filtering cannot disagree about what is on. */
export function facetChips(facets, { labelFor }) {
  const out = [];
  for (const key of Object.keys(facets || {})) {
    const set = facets[key];
    if (!set?.size) continue;
    for (const value of [...set].sort()) {
      out.push({
        key,
        value,
        column: columnLabel(key),
        label: labelFor ? labelFor(key, value) : String(value),
      });
    }
  }
  return out;
}

/**
 * Every value a MULTI-VALUED column holds across the rows given, commonest
 * first, with a count each.
 *
 * facetValues() above still works and is still what single-valued columns use;
 * this is the version that counts a row once per tag it carries. ALWAYS PASS THE
 * UNFILTERED ROWS, for the reason written on facetValues: a menu built from what
 * is on screen shrinks to the values that survived the current filter, and a
 * value outside it cannot be reached from the header at all. That was a real
 * shipped bug on the Operations table.
 */
export function facetValuesMulti(rows, key) {
  const counts = new Map();
  for (const r of rows || []) {
    for (const v of facetValuesOf(r, key)) {
      counts.set(v, (counts.get(v) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => {
    if ((a[0] === "__none") !== (b[0] === "__none")) return a[0] === "__none" ? 1 : -1;
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
}

/* ================================================================== */
/* THE BANDS THE FILTER BAR OFFERS                                     */
/* ================================================================== */

/**
 * A score band, as a filter value.
 *
 * The same four thresholds as scoreBandTag() in lib/sales-rules.js and the same
 * 90 as ROE.SKIP_SCORE_AT_OR_ABOVE. Two places deciding what "80s" means is one
 * place that eventually stops matching, so this reads the score through
 * readScore() — the one function that decides what counts as a score at all —
 * and nothing here re-implements the "empty string is not zero" rule.
 */
export const SCORE_BANDS = [
  ["__none", "No score yet"],
  ["under60", "Under 60"],
  ["60s", "60 to 79"],
  ["80s", "80 to 89"],
  ["90plus", "90 or above"],
];

export function scoreBandOf(score) {
  const n = readScore(score);
  if (n === null) return "__none";
  if (n >= 90) return "90plus";
  if (n >= 80) return "80s";
  if (n >= 60) return "60s";
  return "under60";
}

/** The head-count bands, matching lib/sales-rules.js sizeBandTag() exactly. */
export const SIZE_BANDS = [
  ["__none", "No head count"],
  ["solo", "Solo (1)"],
  ["small", "Small (2-10)"],
  ["mid", "Mid (11-50)"],
  ["large", "Large (51+)"],
];

export function sizeBandOf(employees) {
  if (employees === null || employees === undefined || String(employees).trim() === "") return "__none";
  const n = Number(employees);
  if (!Number.isFinite(n) || n < 1) return "__none";
  if (n <= 1) return "solo";
  if (n <= 10) return "small";
  if (n <= 50) return "mid";
  return "large";
}

/**
 * How long since the last touch, as a band.
 *
 * `now` is passed in — never read from a clock in here. And the days are counted
 * in the team's own calendar through daysBetween() in lib/sales-rules.js, not
 * from a subtraction of two timestamps: a touch logged at 8pm Central is 2am UTC
 * the next day, so a UTC subtraction says a rep who called last night has not
 * called for a day.
 */
export const TOUCH_BANDS = [
  ["__none", "Never touched"],
  ["today", "Today"],
  ["week", "Within 7 days"],
  ["over7", "Over 7 days"],
  ["over14", "Over 14 days"],
];

export function touchBandOf(iso, now) {
  if (!iso) return "__none";
  const d = daysBetween(iso, typeof now === "string" ? now : new Date(now).toISOString());
  /* An unreadable date is not "never touched" and it is not "today". It reads as
   * unknown, which is what "__none" means on this column's menu — and the cell
   * itself prints the raw value so the bad date is visible rather than hidden
   * behind a band. */
  if (d === null) return "__none";
  if (d <= 0) return "today";
  if (d < 7) return "week";
  if (d < 14) return "over7";
  return "over14";
}

export const WEBSITE_BANDS = [
  ["yes", "Has a website"],
  ["no", "No website"],
];

/* ================================================================== */
/* THE THREE SCORES A SCAN RETURNS                                     */
/* ================================================================== */

/**
 * Read one admin_company_reports row into the shape the Scores cell draws.
 *
 * EVERY FIELD CAN BE NULL AND NULL NEVER BECOMES ZERO. A firm shown as 0 for AI
 * Access reads as the worst site we have ever seen, which is the hardest a rep
 * would ever go in — the single most dangerous wrong number this feature could
 * produce. readScore() is the one place that decides what a score is, so an
 * empty string, a 150 and a null all come back as null here.
 *
 * The prompt simulation is a HITS-OUT-OF-TOTAL, never a percentage: 2 of 10 and
 * 20% are the same number and only one of them says how big the sample was, and
 * 1 of 2 printed as 50% is a claim nobody measured. Both halves or nothing.
 */
export function readCompanyReport(row) {
  if (!row) return null;
  /* BOTH HALVES PRESENT, OR NEITHER — and "present" is checked before the
   * conversion, not after.
   *
   * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a row with a total
   * of 10 and a NULL hits count rendered as "named in 0 of 10 buyer questions" —
   * the exact claim this function's own header says must never be printed. It is
   * reachable: 0019's two CHECKs are independent, and any member may insert a
   * report row straight from the browser. A rep would have read "0 of 10" out
   * loud on a call about a firm nobody had measured. Found by an adversarial
   * review, Aug 27 2026. */
  const present = (v) => v !== null && v !== undefined && String(v).trim() !== "";
  const hits = present(row.prompt_sim_hits) ? Number(row.prompt_sim_hits) : NaN;
  const total = present(row.prompt_sim_total) ? Number(row.prompt_sim_total) : NaN;
  const simOk = Number.isFinite(hits) && Number.isFinite(total) && total > 0 && hits >= 0 && hits <= total;
  return {
    id: row.id,
    aiAccess: readScore(row.ai_access_score),
    seo: readScore(row.seo_score),
    simHits: simOk ? hits : null,
    simTotal: simOk ? total : null,
    findings: Array.isArray(row.findings) ? row.findings : [],
    pitch: row.pitch || null,
    pitchGateReason: row.pitch_gate_reason || null,
    /* The four halves of a measurement, carried together (§42 PART 2 rule 2):
     * the number, what it was measured against, the day it was read, and who
     * read it. Anything short of all four is not a measurement. */
    domain: row.domain || null,
    measuredAt: row.measured_at || null,
    measuredBy: row.measured_by || null,
    kind: row.kind || "baseline",
  };
}

/** The newest report per firm, from a flat list. Newest by `measured_at`, and
 *  ties broken on id so two reads of the same rows cannot disagree about which
 *  one is current. */
export function newestReportByCompany(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r?.company_id) continue;
    const cur = out.get(r.company_id);
    if (!cur) { out.set(r.company_id, r); continue; }
    /* PARSED, NOT COMPARED AS TEXT. Two ISO strings for the same instant can be
     * written differently — a `Z` suffix against a `+00:00` offset, fractional
     * seconds against none — and `"…:00+00:00" < "…:00.000Z"` as text while being
     * the same moment in time. PostgREST returns the offset form and every sample
     * row comes from toISOString(), so a mixed pair is exactly what this sees.
     * An unreadable date loses to a readable one rather than winning by accident.
     * Found by an adversarial review, Aug 27 2026. */
    const ms = (x) => { const t = Date.parse(x?.measured_at); return Number.isNaN(t) ? -Infinity : t; };
    const a = ms(r);
    const b = ms(cur);
    if (a > b || (a === b && String(r.id) > String(cur.id))) out.set(r.company_id, r);
  }
  return out;
}

/* ================================================================== */
/* WHO MAY SEE A LEAD AT ALL — Ryder, 30 Aug 2026                      */
/* ================================================================== */

/**
 * THIS REVERSES THE AUG 27 RULE, ON PURPOSE, AND THE OLD REASONING IS KEPT
 * BELOW SO NOBODY REVERSES IT BACK BY ACCIDENT.
 *
 * Aug 27: a rep saw EVERY lead in the company, and another rep's row opened
 * read-only. The reason written down that day was that a rep who cannot see
 * another rep's row cannot be stopped from working the same firm.
 *
 * Aug 30, Ryder: "on the reps page if something becomes claimed by someone else
 * then it gets removed from the floor and the rep doesnt see those leads, only
 * the claimed rep and the owner/admin see it. that way the reps never comingle."
 *
 * So a sales rep's universe is now exactly two things:
 *   - the leads they hold
 *   - the leads nobody holds
 * An owner or an admin still sees all of them, unchanged.
 *
 * THE FIRM COLLISION IS NOT IGNORED, IT MOVED. The thing the Aug 27 rule was
 * protecting is handled by firmsHeldByOthers() below: an unclaimed row at a firm
 * somebody else is already inside is marked, without naming them and without
 * showing their record. That keeps the protection and drops the comingling.
 *
 * VISIBILITY IS NARROWED IN EXACTLY ONE PLACE — `scopeLeads` in SalesPage.jsx,
 * before any filter runs. Same rule as the Aug 26 lock: a narrowing applied to
 * the set first cannot be widened by a tile, a tab, a dropdown, a search box or
 * the next control somebody adds. Do not re-derive this inline anywhere.
 *
 * WHAT THIS IS NOT: it is not a security boundary. The read policy on
 * admin_leads is still wide (0001, unchanged by 0020), so a rep's browser can
 * still fetch another rep's row by hand. Ryder's call on 30 Aug was screen-only
 * for now. If that changes, the database rule goes in its own migration and this
 * function stays exactly as it is — the screen and the database saying the same
 * thing twice is the point, not a duplication to remove.
 */
export function visibleToMember(leads, member) {
  const all = leads || [];
  /* A KNOWN role that is not `sales` sees everything — written the same way
   * round as canEditLead, so the two cannot drift: a role nobody has taught this
   * file about must not silently lose the ability to work.
   *
   * A member with NO role falls through to the narrow rule rather than the wide
   * one. That is the fail-closed direction here: canEditLead already refuses a
   * roleless member every edit, so the narrow set is the most such a page can
   * honestly offer, and it is never empty in the way returning [] would be. */
  if (member?.role && member.role !== "sales") return all;
  const uid = member?.user_id ?? null;
  return all.filter((l) => !l.owner_id || (uid !== null && l.owner_id === uid));
}

/**
 * The firms somebody OTHER than this member is already inside.
 *
 * Counted from the WHOLE board, before visibleToMember() narrows anything —
 * that is the entire point. Once the narrowing has run, the rows that prove a
 * firm is taken are gone, so this has to be worked out first or it can only ever
 * return an empty set. Passing the narrowed list here is the one way to make
 * this silently useless, so it takes the board's leads by name at the call site.
 *
 * Returns company ids only. No lead ids, no owner ids, no names — a rep is told
 * that a firm is busy, never who is in it, because who is in it is the thing
 * Ryder asked to hide.
 *
 * OPEN STAGES ONLY, and that is not a detail. contestedCompanies filters on
 * isOpenStage with a comment saying exactly why, and companyClaimWarning in
 * lib/sales-rules.js does the same. Without it, a contact another rep marked
 * Lost in March marks that firm busy for ever — and the drawer, which DOES
 * filter, shows no warning on the same firm on the same click. Two parts of one
 * page giving opposite answers about the same thing is worse than either answer
 * alone. Found by an adversarial review the same day this function was written.
 */
export function firmsHeldByOthers(leads, member) {
  const uid = member?.user_id ?? null;
  const out = new Set();
  for (const l of leads || []) {
    if (!l?.company_id || !l.owner_id) continue;
    if (!isOpenStage(l.stage)) continue;
    if (uid !== null && l.owner_id === uid) continue;
    out.add(l.company_id);
  }
  return out;
}

/** The words on that marker, in one place, so the chip on the row and the line
 *  in the drawer cannot come to say two different things. Deliberately says
 *  nothing about who: "somebody" is the whole content. */
export const FIRM_BUSY_LABEL = "Somebody is already working this firm";
export const FIRM_BUSY_WHY =
  "Another person on the team holds a contact at this firm. You can still claim and work this "
  + "person — check with the team first so the firm does not hear from two of us in one week.";
