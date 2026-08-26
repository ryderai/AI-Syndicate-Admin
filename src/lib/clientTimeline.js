import { TEAM_TZ, teamDate } from "../../lib/brain-context.js";
import { teamDayStartOf, DAY } from "./teamDay.js";

/* THE CLIENT'S WHOLE STORY, IN ORDER — the merging half of it.
 *
 * Added Aug 26 2026. Ryder asked for the client page's "How they started" tab
 * to stop being a list of sales contacts and become "a timeline of the client
 * from creation to now, with everything we have done, with dates."
 *
 * Everything here is a plain function. Rows go in, a sorted list of events
 * comes out. No React, no fetching. That is on purpose: the panel that shows
 * this cannot be tested, and the rules below are exactly the kind that break
 * quietly, so the rules live where a test can reach them
 * (tests/client-timeline/test.mjs).
 *
 * THE FOUR RULES THIS FILE EXISTS TO HOLD
 *
 * 1. EVERY EVENT SAYS WHICH RECORD IT CAME FROM. A logged phone call and a
 *    week of work written up are not the same kind of fact. Each event carries
 *    a `source` in plain words ("sales call", "weekly log", "task") and the
 *    panel never prints one without it.
 *
 * 2. A READ THAT FAILED IS UNKNOWN, NOT ZERO. A section we could not read and
 *    a section with nothing in it look identical once they are both counted as
 *    0, and they mean opposite things. A failed read never lands in `events`;
 *    it lands in `unknown`, with the reason.
 *
 * 3. NOT WRITTEN DOWN IS NOT THE SAME AS DID NOT HAPPEN. `recordsBegin` is the
 *    date of the oldest event we actually hold, and the panel prints it at the
 *    top. Work done for an old client before this console existed is in no row
 *    this code can read, so a short timeline must never be read as a quiet
 *    week.
 *
 * 4. A DATE WE DO NOT HAVE IS NOT GUESSED. Anything real but undated goes in
 *    `undated` with the reason it has no date. It is never given a nearby
 *    timestamp to make the list look complete.
 *
 * WHY THE ACTIVITY LOG IS NOT IN HERE
 * `listActivity()` reads admin_activity_log, which is the obvious place to look
 * for "everything we have done". It is not used, and must not be: that table
 * ties to a client only through its free-text `body`, so the only way to pick
 * out one client's rows is to search that sentence for their name. A client
 * called "Shiner" would collect every row that happens to mention Shiner,
 * including another firm's. Putting one client's work on another client's page
 * is worse than leaving a true gap, so the gap is left and named.
 */

/* Only these words are ever printed as a source. Keeping the list here, rather
 * than writing the strings at each call, is what stops two spellings of the
 * same source drifting apart on one screen. */
export const SOURCES = {
  client: "client record",
  salesContact: "sales contact",
  salesCall: "sales call",
  salesEmail: "sales email",
  salesText: "sales text",
  salesLinkedin: "sales LinkedIn message",
  salesNote: "sales note",
  salesStage: "sales stage change",
  salesOwner: "sales owner change",
  salesProposal: "sales proposal",
  salesClose: "sales close",
  salesLog: "sales log",
  task: "task",
  site: "website",
  weekly: "weekly log",
  report: "report",
  connection: "connected account",
  vault: "vault item",
};

/* HOW MANY ROWS EACH READ IS ALLOWED, AND WHY THOSE NUMBERS SIT HERE.
 *
 * Added Aug 26 2026. Every reader in data.js puts a `.limit()` on its query,
 * and only ONE of the eight this panel uses ever says so. listLeadActivity
 * stops at 200 rows ordered NEWEST FIRST, listClientReports at 25, listTasks
 * at 500 — and each of them answers exactly like a read that saw everything.
 *
 * That silence is what made the top line of the panel false. A contact with
 * 250 logged calls since January: the read hands back the newest 200, the
 * oldest of those is Apr 3, and the panel announced "our records begin on
 * Apr 3" while fifty January calls sat unread in the table.
 *
 * So until those readers report their own caps, the numbers live here and we
 * check them ourselves: a section that comes back holding as many rows as it
 * was allowed MIGHT have been cut short, and we cannot tell which. This is a
 * guard, not the fix. The fix is `partial`/`truncated` on those readers, and
 * then these numbers can go.
 */
export const SECTION_CAPS = {
  contacts: null,     // listClientContacts is an RPC with no limit at all.
  activity: 200,      // listLeadActivity, ordered newest first.
  tasks: 500,         // listTasks
  sites: 300,         // listClientSites
  weekly: null,       // listWeekly puts no limit on the query.
  reports: 25,        // listClientReports, default limit, newest first.
  connections: 400,   // listClientConnections
  vault: 500,         // listVaultItems
};

/* THE EIGHT KINDS OF RECORD THIS PANEL READS.
 *
 * Added Aug 26 2026. The panel used to count the distinct SOURCE WORDS in the
 * events and print that as the number of kinds of record. One table,
 * admin_lead_activity, spells out twelve different source words on its own, so
 * nine activity rows read as "11 kinds of record" above a list naming eight.
 * It undercounted too: a kind we read fine that happens to be empty spells out
 * no word at all, so it vanished from the number while still being named.
 *
 * A kind of record is one of these eight, counted once. Every one of them is
 * either read or not read, nothing in between, so any two numbers about them
 * are about the same eight things and neither can outgrow the list itself.
 */
export const KINDS = [
  ["client", "the client row"],
  ["sales", "the sales log"],
  ["tasks", "tasks"],
  ["sites", "websites"],
  ["weekly", "the weekly log"],
  ["reports", "reports"],
  ["connections", "connected accounts"],
  ["vault", "the vault"],
];

/** "a, b and c" — a list the way a person says it out loud. Aug 26 2026. */
export function joinWords(list) {
  const parts = (list || []).map((x) => String(x || "")).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/* One activity row's `type` to the words we print for it. admin_lead_activity
 * allows sixteen types and more can be added by a migration without touching
 * this file, so anything unrecognised falls back to the honest catch-all
 * "sales log" instead of being dropped or guessed at. */
const ACTIVITY_SOURCE = {
  call: SOURCES.salesCall,
  email: SOURCES.salesEmail,
  text: SOURCES.salesText,
  linkedin: SOURCES.salesLinkedin,
  note: SOURCES.salesNote,
  status_change: SOURCES.salesStage,
  assigned: SOURCES.salesOwner,
  claim: SOURCES.salesOwner,
  unclaim: SOURCES.salesOwner,
  proposal: SOURCES.salesProposal,
  converted: SOURCES.salesClose,
  client_link: SOURCES.salesClose,
};

/** The source words for one activity row. Never blank. */
export function activitySource(type) {
  return ACTIVITY_SOURCE[type] || SOURCES.salesLog;
}

/** Epoch ms for a timestamptz string, or null. Null — never 0, and never
 *  today — because 0 is 1970 and would sort above the client's own creation,
 *  which is how a broken date turns into "the oldest thing we know". */
export function atFromStamp(v) {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** Epoch ms for a `date` column (start_date, due_date, target_date).
 *
 *  These have no time and no zone. `Date.parse("2026-08-01")` is midnight in
 *  LONDON, which is the evening of July 31 in Chicago — the bug that has cost
 *  this repo three shipped date errors. teamDayStartOf gives midnight on the
 *  team's own calendar day, which is the day a person typing that date meant. */
export function atFromDay(v) {
  if (!v) return null;
  const ymd = String(v).slice(0, 10);
  const ms = teamDayStartOf(ymd);
  return Number.isNaN(ms) ? null : ms;
}

/** `Aug 12, 2026` for a team-calendar day, matching the rest of the console.
 *  Formatted from the MIDDLE of the day: midnight is one tick away from
 *  belonging to the day before. */
export function prettyDay(ymd) {
  if (!ymd) return "an unknown date";
  const start = teamDayStartOf(ymd);
  if (Number.isNaN(start)) return "an unreadable date";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TEAM_TZ, month: "short", day: "numeric", year: "numeric",
    }).format(new Date(start + DAY / 2));
  } catch { return "an unreadable date"; }
}

/* ------------------------------------------------------------------ */
/* READING A SECTION SAFELY                                            */
/* ------------------------------------------------------------------ */

/** What one data.js reader gave us, judged.
 *
 * Every reader in data.js answers the same shape: `{ rows, error, partial,
 * truncated, sample }`. Three different things can come back and only one of
 * them means "nothing happened":
 *
 *   res is missing        → we never asked. Unknown.
 *   res.error is set      → we asked and failed. Unknown.
 *   res.rows is empty     → we asked and there is nothing. Zero, and true.
 *
 * The first two must not become 0 anywhere downstream, so `ok` is false for
 * both and `rows` is left empty for the caller to skip.
 */
export function readSection(res) {
  if (!res) return { ok: false, rows: [], fetched: 0, dropped: 0, why: "Nothing came back from this read at all, so what is there is unknown.", caveat: null, sample: false };
  if (res.error) return { ok: false, rows: [], fetched: 0, dropped: 0, why: res.error, caveat: null, sample: !!res.sample };
  /* `partial` and `truncated` mean the read WORKED but did not bring everything.
     Those rows are real and get shown; the caveat is carried alongside so the
     panel can say the list may be short. Dropping the caveat would turn a
     known-incomplete list into a confident one. */
  const caveat = res.partial || res.truncated || null;
  /* ONE BAD ROW MUST NOT COST THE WHOLE TAB. Aug 26 2026: a single null in a
     rows array threw on the first `row.id`, the panel caught it and drew
     nothing, and hundreds of good rows were lost to one junk one. Anything
     that is not an object is skipped here and counted, so it is dropped out
     loud instead of quietly. `fetched` is the count BEFORE skipping, because
     that is the number the database actually handed back, and so the number a
     row cap is about. */
  const raw = Array.isArray(res.rows) ? res.rows : [];
  const rows = raw.filter((r) => r && typeof r === "object");
  return { ok: true, rows, fetched: raw.length, dropped: raw.length - rows.length, why: null, caveat, sample: !!res.sample };
}

/* ------------------------------------------------------------------ */
/* THE BUILDER                                                         */
/* ------------------------------------------------------------------ */

const WEEK_STATUS_WORDS = {
  not_logged: "not written up",
  in_progress: "part written",
  complete: "written up",
  complete_late: "written up late",
};

/** Cut a person's own words down for one line, without pretending it is whole. */
function snippet(text, max = 120) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function push(out, undated, { key, at, source, title, detail = null, why = null }) {
  if (at === null) {
    /* Real, and we know it happened, but nothing on the row says when. It goes
       in its own pile rather than being sorted anywhere at all. */
    undated.push({ key, source, title, detail, why });
    return;
  }
  out.push({ key, at, ymd: teamDate(at), source, title, detail });
}

/**
 * Merge every record we hold about one client into one story.
 *
 * Everything is passed in already fetched, as the exact `{ rows, error, ... }`
 * objects the data.js readers return. Any of them may be left out; a section
 * that is not passed is reported as unknown rather than as empty.
 *
 * @returns {{
 *   events: Array, undated: Array, unknown: Array, caveats: Array,
 *   notes: Array, recordsBegin: string|null, sample: boolean, bySource: Object
 * }}
 */
/* "A api key" read like a typo, so the article follows the word. Aug 26 2026.
 * Only the five vowels are checked on purpose: the vault kinds are a short,
 * known list, and a cleverer rule would only be wrong in a stranger way. */
function aOrAn(word) {
  const w = String(word || "").trim();
  if (!w) return "";
  return `${/^[aeiou]/i.test(w) ? "An" : "A"} ${w}`;
}

export function buildTimeline({
  client = null,
  contacts,
  activityByContact = {},
  tasks,
  sites,
  weekly,
  reports,
  connections,
  vault,
} = {}) {
  const events = [];
  const undated = [];
  const unknown = [];
  const caveats = [];
  const notes = [];
  const capped = [];
  /* Which of the eight KINDS above we managed to read. Read or not read, and
     an empty read still counts as read — that is the whole point of it. */
  const kindOk = {};
  let sample = false;
  let droppedRows = 0;

  const take = (res, label, cap = null) => {
    const got = readSection(res);
    if (got.sample) sample = true;
    droppedRows += got.dropped;
    if (!got.ok) { unknown.push({ source: label, why: got.why }); return got; }
    if (got.caveat) caveats.push({ source: label, note: got.caveat });
    /* It came back holding every row it was allowed. It might have been cut
       short and nothing in the answer can tell us, so it is treated as short.
       See SECTION_CAPS at the top for why we have to guess this at all. */
    if (cap && got.fetched >= cap) {
      capped.push({ source: label, cap });
      caveats.push({ source: label, note: `This read stopped at ${cap} rows, which is all it is allowed to load, so there may be more it never saw — most likely the oldest ones.` });
    }
    return got;
  };

  /* --- the client record itself --- */
  kindOk.client = !!client;
  if (!client) {
    unknown.push({ source: SOURCES.client, why: "The client record was not handed to the timeline, so the day they were added is not known." });
  } else {
    push(events, undated, {
      key: `client:${client.id}:created`,
      at: atFromStamp(client.created_at),
      source: SOURCES.client,
      title: `${client.name || "This client"} was added to the console`,
      /* NOT "became a client". This is the day the ROW was made. On a client
         we took on before the console existed, the row was typed in long
         afterwards, and the two dates are years apart. */
      detail: "The day the client record was created here.",
      why: "admin_clients has no created_at on this row.",
    });
    if (client.start_date) {
      push(events, undated, {
        key: `client:${client.id}:start`,
        at: atFromDay(client.start_date),
        source: SOURCES.client,
        title: "Start date on file",
        detail: "Typed in by hand as the day work began.",
        /* We only reach this `why` when the value would not read as a day, so
           it names the value. Aug 26 2026: without it this row appeared with no
           reason at all, under a heading that promises one. The field is typed
           by hand, so quoting it back is how somebody knows what to fix. */
        why: `the start date on the client row reads "${snippet(client.start_date, 40) || "nothing"}", which is not a day we can read.`,
      });
    }
  }

  /* --- sales: the people at the firm, and what was logged against them --- */
  const gotContacts = take(contacts, SOURCES.salesContact, SECTION_CAPS.contacts);
  /* The sales log is ONE kind of record however many people are at the firm.
     Five contacts whose logs failed to read is five lines in the unknown list
     and still one kind we could not fully read. Counting it per contact is how
     the panel came to print "5 of 2 kinds could not be read". */
  let salesLogOk = gotContacts.ok;
  for (const c of gotContacts.rows) {
    const who = c.name || "an unnamed contact";
    push(events, undated, {
      key: `lead:${c.id}:created`,
      at: atFromStamp(c.created_at),
      source: SOURCES.salesContact,
      title: `${who} was added to the sales list`,
      detail: c.title ? `${c.title}.` : null,
      why: "admin_leads has no created_at on this row.",
    });
    if (c.first_contact_at) {
      push(events, undated, {
        key: `lead:${c.id}:first`,
        at: atFromStamp(c.first_contact_at),
        source: SOURCES.salesContact,
        /* "first contact", not "first spoken to". A logged email or LinkedIn
           message sets this date as well as a call does. */
        title: `First contact with ${who}`,
        detail: null,
        /* Same fix, same day. The row is real — a date was set — but the value
           will not read as a moment, so we say which value and stop there
           rather than showing a bare line under "we cannot say when". */
        why: `the first-contact date on ${who} reads "${snippet(c.first_contact_at, 40) || "nothing"}", which is not a date and time we can read.`,
      });
    }
    /* became_customer_at, and only it. `closed_at` is set when a deal ends
       either way — a lost deal has one too — so using it as a fallback would
       print a lost contact as the day this firm signed. */
    if (c.became_customer && c.became_customer_at) {
      push(events, undated, {
        key: `lead:${c.id}:won`,
        at: atFromStamp(c.became_customer_at),
        source: SOURCES.salesClose,
        title: `${who}'s deal was marked Won`,
        detail: "This is the flag that joins the sales record to this client.",
      });
    }

    /* Calls and emails are per-contact: listLeadActivity takes one lead id, so
       the panel reads one result per person and hands them in keyed by id.
       A contact with no entry in the map was NOT read — that is unknown for
       that person, not an empty history. */
    const got = take(activityByContact[c.id], `${SOURCES.salesLog} for ${who}`, SECTION_CAPS.activity);
    if (!got.ok) salesLogOk = false;
    for (const a of got.rows) {
      push(events, undated, {
        key: `act:${a.id}`,
        at: atFromStamp(a.created_at),
        source: activitySource(a.type),
        title: `${who} — ${a.outcome ? String(a.outcome).replace(/_/g, " ") : "logged"}`,
        detail: snippet(a.body),
        why: "admin_lead_activity has no created_at on this row.",
      });
    }
  }

  kindOk.sales = salesLogOk;

  /* --- tasks --- */
  const gotTasks = take(tasks, SOURCES.task, SECTION_CAPS.tasks);
  kindOk.tasks = gotTasks.ok;
  for (const t of gotTasks.rows) {
    push(events, undated, {
      key: `task:${t.id}:created`,
      at: atFromStamp(t.created_at),
      source: SOURCES.task,
      title: `Task added: ${t.name || "unnamed task"}`,
      detail: snippet(t.latest_report),
      why: "admin_tasks has no created_at on this row.",
    });
    if (t.status === "done") {
      /* THERE IS NO `completed_at` COLUMN. The only date we have for a finished
         task is `updated_at`, which moves on any edit — renaming a done task
         moves it. So the row is shown, and the words say what the date actually
         is, rather than claiming it is the day the work was finished. */
      push(events, undated, {
        key: `task:${t.id}:done`,
        at: atFromStamp(t.updated_at),
        source: SOURCES.task,
        title: `Task finished: ${t.name || "unnamed task"}`,
        detail: "Dated from the last time the task row changed — nothing records the moment it was finished.",
        why: "the task is marked done but nothing on the row says when.",
      });
    }
    /* A due date is NOT added as an event. A day something is meant to happen
       is not a day something happened, and a timeline of work done cannot hold
       both without one reading as the other. Due dates stay on the Tasks tab. */
  }

  /* --- websites --- */
  const gotSites = take(sites, SOURCES.site, SECTION_CAPS.sites);
  kindOk.sites = gotSites.ok;
  for (const s of gotSites.rows) {
    push(events, undated, {
      key: `site:${s.id}:added`,
      at: atFromStamp(s.created_at),
      source: SOURCES.site,
      title: `Website added: ${s.label || s.url || "unnamed site"}`,
      detail: s.url || null,
      why: "admin_client_sites has no created_at on this row.",
    });
    if (s.live) {
      /* `live` is a true/false box with no date beside it. We know it is live
         now and we do not know the day it went live — `updated_at` is the last
         edit of any kind, which would date a note tidied up last week as a
         launch. So it is listed as undated instead of dated wrongly. */
      undated.push({
        key: `site:${s.id}:live`,
        source: SOURCES.site,
        title: `${s.label || s.url || "A website"} is live`,
        detail: s.url || null,
        why: "nothing on the website row records the day it went live.",
      });
    }
  }

  /* --- the weekly log --- */
  const gotWeekly = take(weekly, SOURCES.weekly, SECTION_CAPS.weekly);
  kindOk.weekly = gotWeekly.ok;
  let notLoggedWeeks = 0;
  for (const w of gotWeekly.rows) {
    /* A week row exists as soon as the week is planned, before anyone writes
       anything in it. Showing a `not_logged` week as an event would put a line
       reading like finished work on a week nobody has touched. Those are
       counted and named underneath instead. */
    if (w.week_status === "not_logged") { notLoggedWeeks += 1; continue; }
    push(events, undated, {
      key: `week:${w.id}`,
      /* target_date is the week this entry is ABOUT, which is the date a person
         reading the story wants. created_at is only when it got typed. */
      at: atFromDay(w.target_date) ?? atFromStamp(w.created_at),
      source: SOURCES.weekly,
      title: `Week ${w.week_no ?? "?"} — ${WEEK_STATUS_WORDS[w.week_status] || "status unknown"}`,
      detail: snippet(w.what_we_did) || snippet(w.what_moved),
      why: "the weekly entry has neither a target date nor a created date.",
    });
  }
  if (notLoggedWeeks > 0) {
    notes.push(`${notLoggedWeeks} ${notLoggedWeeks === 1 ? "week is" : "weeks are"} on the weekly log with nothing written in ${notLoggedWeeks === 1 ? "it" : "them"} yet, so ${notLoggedWeeks === 1 ? "it is" : "they are"} not in the story above.`);
  }

  /* --- reports we generated --- */
  const gotReports = take(reports, SOURCES.report, SECTION_CAPS.reports);
  kindOk.reports = gotReports.ok;
  for (const r of gotReports.rows) {
    push(events, undated, {
      key: `report:${r.id}`,
      at: atFromStamp(r.created_at),
      source: SOURCES.report,
      title: `Report generated: ${r.title || "Client report"}`,
      /* `source` on the row is 'written' or 'counted', and which one it is
         decides whether the numbers in it were checked. Worth one word here. */
      detail: r.source === "written" ? "Worded by the AI from our own counts." : "Counted by plain code from our own records.",
      why: "admin_client_reports has no created_at on this row.",
    });
  }

  /* --- their own accounts we were given access to --- */
  const gotConn = take(connections, SOURCES.connection, SECTION_CAPS.connections);
  kindOk.connections = gotConn.ok;
  for (const c of gotConn.rows) {
    push(events, undated, {
      key: `conn:${c.id}`,
      /* connected_at is the day access was actually granted. created_at only
         says when somebody made the row, which for a hand-typed manual
         connection can be months later. */
      at: atFromStamp(c.connected_at) ?? atFromStamp(c.created_at),
      source: SOURCES.connection,
      title: `Account connected: ${c.label || c.provider || "unnamed account"}`,
      detail: c.auth_kind === "google"
        ? "We hold a sign-in and can read it ourselves."
        : "Noted by hand — nobody has signed in to it, so the numbers are typed in.",
      why: "the connection row has no connected date and no created date.",
    });
  }

  /* --- vault items --- */
  const gotVault = take(vault, SOURCES.vault, SECTION_CAPS.vault);
  kindOk.vault = gotVault.ok;
  for (const v of gotVault.rows) {
    push(events, undated, {
      key: `vault:${v.id}`,
      at: atFromStamp(v.created_at),
      source: SOURCES.vault,
      /* The label and the kind, and nothing else. No username, no card digits,
         no secret — a timeline is a thing people screen-share. */
      title: `Vault item added: ${v.label || "unnamed item"}`,
      detail: v.kind ? `${aOrAn(String(v.kind).replace(/_/g, " "))}.` : null,
      why: "admin_vault_items has no created_at on this row.",
    });
  }

  /* Oldest first: it is a story, so it reads forward. The tie-breakers are
     there so two events on the same millisecond come out in the same order
     every render — a list that reshuffles on refresh reads as changing facts. */
  events.sort((a, b) =>
    a.at - b.at ||
    a.source.localeCompare(b.source) ||
    a.title.localeCompare(b.title) ||
    a.key.localeCompare(b.key));

  const bySource = {};
  for (const e of events) bySource[e.source] = (bySource[e.source] || 0) + 1;

  /* Rows we skipped because they were not records at all. Said out loud: a row
     silently dropped is the same shape of lie as a failed read counted as 0. */
  if (droppedRows > 0) {
    notes.push(`${droppedRows} ${droppedRows === 1 ? "row was" : "rows were"} skipped because ${droppedRows === 1 ? "it did" : "they did"} not come back as a record we can read at all.`);
  }

  const kindsRead = KINDS.filter(([k]) => kindOk[k]).map(([, label]) => label);
  const kindsFailed = KINDS.filter(([k]) => !kindOk[k]).map(([, label]) => label);

  return {
    events,
    undated,
    unknown,
    caveats,
    notes,
    /* The oldest thing we hold, and nothing more than that. Not "the day we
       started working with them" — see rule 3 at the top. */
    recordsBegin: events.length ? events[0].ymd : null,
    /* Every read that came back full, and the cap it stopped at. When there is
       one, the oldest event we hold is only the oldest one we LOADED, so the
       panel says where the LIST begins instead of where our records begin. */
    capped,
    recordsBeginIsFloor: capped.length > 0,
    /* The eight kinds of record, counted once each. `read + failed` is always
       `total`, so the panel can never print more failures than there are
       kinds. Labels come out too, so it names the ones it actually read. */
    kinds: {
      total: KINDS.length,
      read: kindsRead.length,
      failed: kindsFailed.length,
      readLabels: kindsRead,
      failedLabels: kindsFailed,
    },
    sample,
    bySource,
    /* Told apart on purpose: no sales rows at all, versus a sales read that
       failed. The panel words those two completely differently. */
    sales: gotContacts.ok
      ? { state: gotContacts.rows.length ? "linked" : "none", count: gotContacts.rows.length }
      : { state: "unknown", count: null },
  };
}
