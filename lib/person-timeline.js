/* ONE TIMELINE PER PERSON, FOR LIFE.
 *
 * Pure functions, no imports, no database — the same reason lib/sales-rules.js
 * and lib/sales-import.js are pure. Everything below is pinned by
 * tests/sales-sheet, and the browser hands it rows it has already fetched.
 *
 * Ryder, Aug 25 2026: *"have everything connected and context saved to all
 * people in our system from the time there created as a lead all the way to a
 * paying client and beyond."*
 *
 * WHAT WAS WRONG BEFORE
 * A lead's timeline stopped at the sale. The calls, the emails, the proposal
 * and the day it closed lived on the Sales page; everything after — the tasks
 * we did, the weekly logs, the reports we sent, the invoices, the support
 * tickets — lived on the Clients page, behind a link nothing wrote. Two
 * histories of the same relationship, neither of which was the whole thing.
 * Three months in, "what have we actually done for these people" needed two
 * screens and a good memory.
 *
 * So this merges every source into ONE list, marks where the chase ended and
 * the client work began, and makes every single line say where it was read
 * from.
 *
 * THE FIVE RULES
 *
 * 1. NOTHING IS INVENTED. A row with no readable date is dropped and counted,
 *    never dated "now" so it has somewhere to sit. A timeline that quietly
 *    files an undated thing under today is worse than one that admits it could
 *    not place it.
 * 2. EVERY LINE CARRIES ITS SOURCE. `source` is the table it came out of and
 *    `sourceLabel` is that in words. This is the same rule the rest of the
 *    console runs on: a number is a number plus where it was read.
 * 3. MEASURED, QUOTED AND CLAIMED NEVER BLEND. Every event is one of three
 *    kinds — `logged` (somebody on our team recorded it), `system` (the
 *    software did it) or `theirs` (it came from the other side). They are
 *    marked, never merged.
 * 4. AN EMPTY SOURCE IS NOT A ZERO. A source that was not fetched is reported
 *    as "not counted", never as "nothing happened". They look identical on
 *    screen and mean opposite things.
 * 5. THE CAP SAYS SO. If more rows exist than are shown, the reader is told,
 *    with the number.
 */

/** The most rows one timeline will render. Above this the oldest are cut and
 *  the reader is told how many. */
export const TIMELINE_CAP = 400;

/* ------------------------------------------------------------------ */
/* How each kind of thing is described                                 */
/* ------------------------------------------------------------------ */

/** icon, plain-words heading, and who did it. Kept in one table so a new kind
 *  of event cannot be added without deciding how it reads. */
export const EVENT_KINDS = {
  created: { icon: "◍", head: "Added to the pipeline", by: "system" },
  call: { icon: "☏", head: "Call", by: "logged" },
  email: { icon: "✉", head: "Email", by: "logged" },
  text: { icon: "✆", head: "Text", by: "logged" },
  linkedin: { icon: "in", head: "LinkedIn", by: "logged" },
  note: { icon: "✎", head: "Note", by: "logged" },
  status_change: { icon: "→", head: "Status moved", by: "logged" },
  assigned: { icon: "◎", head: "Assigned", by: "logged" },
  claim: { icon: "◉", head: "Claimed", by: "logged" },
  unclaim: { icon: "○", head: "Unclaimed", by: "logged" },
  reopen: { icon: "↺", head: "Back on the floor", by: "system" },
  score: { icon: "◈", head: "Site score run", by: "system" },
  proposal: { icon: "$", head: "Proposal", by: "logged" },
  import: { icon: "⇥", head: "Imported", by: "system" },
  cadence: { icon: "⋯", head: "Cadence", by: "system" },
  open: { icon: "◐", head: "They opened an email", by: "theirs" },
  converted: { icon: "★", head: "Became a paying client", by: "system" },
  client_link: { icon: "★", head: "Their firm became a client", by: "system" },

  /* After the sale. These do not come from admin_lead_activity at all. */
  proposal_row: { icon: "$", head: "Proposal", by: "logged" },
  /* Separate kind, because WHO DID IT is different. A proposal being opened is
   * something THEY did; filing it under the same kind as "we sent it" made the
   * line read "someone" — i.e. one of us — on a thing none of us did. */
  proposal_viewed: { icon: "◐", head: "Proposal", by: "theirs" },
  task: { icon: "✓", head: "Work done", by: "logged" },
  weekly: { icon: "▤", head: "Weekly log", by: "logged" },
  report: { icon: "▦", head: "Report", by: "logged" },
  invoice: { icon: "▣", head: "Invoice", by: "logged" },
  payment: { icon: "▣", head: "Payment", by: "theirs" },
  ticket: { icon: "!", head: "Support ticket", by: "theirs" },
};

export const SOURCE_LABELS = {
  admin_lead_activity: "the sales timeline",
  admin_leads: "the contact record",
  admin_proposals: "proposals",
  admin_tasks: "the work list",
  admin_weekly_log: "the weekly log",
  admin_client_reports: "reports",
  admin_invoices: "invoices",
  admin_tickets: "support tickets",
};

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/**
 * A readable instant, or null. Nothing else is accepted.
 *
 * A bare `YYYY-MM-DD` is deliberately widened to midday UTC rather than handed
 * to `new Date()` as-is. `new Date("2026-08-01")` is midnight UTC, which is
 * the EVENING OF JULY 31 in Chicago — that exact line has produced three
 * shipped bugs in this repo, including every cost paid on the 1st being booked
 * to the month before. Midday cannot fall out of its own day in any zone the
 * team works in.
 */
export function readWhen(v, { dayStamp = false } = {}) {
  if (!v) return null;
  const s = String(v);
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  /* `dayStamp` is for columns that hold a DAY dressed up as a timestamp.
   * `admin_invoices.paid_at` is built as `last_paid::timestamptz` (0007), so a
   * payment recorded on Aug 1 is stored as 2026-08-01T00:00:00Z — midnight UTC,
   * which is the EVENING OF JULY 31 in Chicago. The timeline printed it a day
   * early, and a payment made on the day a deal closed landed on the wrong side
   * of the "became a client" line. Exactly midnight UTC is treated as the day
   * itself and moved to midday, the same as a bare date. A real payment
   * timestamped to that exact second moves by twelve hours and no further,
   * which is a far smaller error than a whole day in the wrong direction. */
  if (dayStamp && d.getTime() % 86400000 === 0) {
    return new Date(d.getTime() + 43200000).toISOString();
  }
  return d.toISOString();
}

/* ------------------------------------------------------------------ */
/* Building one event                                                  */
/* ------------------------------------------------------------------ */

function event({ id, at, kind, title, detail, who, source, amountCents }) {
  const k = EVENT_KINDS[kind] || { icon: "•", head: kind, by: "system" };
  return {
    id, at, kind,
    icon: k.icon,
    /* The heading is the KIND's word, not free text. Free-text headings are
     * how a timeline ends up with five different words for a phone call. */
    head: k.head,
    by: k.by,
    title: title || null,
    detail: detail || null,
    who: who || null,
    source,
    sourceLabel: SOURCE_LABELS[source] || source,
    amountCents: Number.isFinite(amountCents) ? amountCents : null,
  };
}

/* ------------------------------------------------------------------ */
/* The merge                                                           */
/* ------------------------------------------------------------------ */

/**
 * Everything that has ever happened to one person and their firm, newest
 * first.
 *
 * Every source is OPTIONAL, and the difference between "you did not give me
 * this" and "there is none of it" is kept and reported. Pass `null` for a
 * source that was not fetched and `[]` for one that was fetched and came back
 * empty — they are not the same fact and this function refuses to treat them
 * as one.
 *
 * Returns { events, counts, dropped, truncated, notCounted, becameClientAt }.
 */
export function buildPersonTimeline({
  lead,
  activity = null,
  proposals = null,
  tasks = null,
  weekly = null,
  reports = null,
  invoices = null,
  tickets = null,
  /* Sources the caller read but could only read PART of — a whole-table read
   * that hit its own row limit, for instance. Reported next to the ones that
   * were not read at all, because "we saw some of it" and "there is none of it"
   * are as different as "we could not look" and "there is none". */
  incomplete = [],
} = {}, {
  teamName = () => null,
  cap = TIMELINE_CAP,
} = {}) {
  const events = [];
  const counts = {};
  let dropped = 0;
  const notCounted = [];
  const partial = (incomplete || []).filter(Boolean);

  /* `raw` is the date value as it was stored, BEFORE readWhen tried it. The
   * two ways an event can have no date are not the same fact and must not be
   * counted as one:
   *   raw empty      → the thing never happened (a proposal nobody opened has
   *                    no viewed_at). Skipped silently. Counting it as a
   *                    dropped entry made the screen say "2 entries had no
   *                    readable date" about one bad date and one non-event.
   *   raw unreadable → something IS stored and we cannot place it. Counted and
   *                    reported, never quietly filed under today.
   */
  const push = (e, raw) => {
    if (!e.at) {
      if (raw !== null && raw !== undefined && String(raw).trim() !== "") dropped += 1;
      return;
    }
    events.push(e);
    counts[e.kind] = (counts[e.kind] || 0) + 1;
  };

  /* ---- the day the record began ---- */
  if (lead) {
    push(event({
      id: `created:${lead.id}`,
      at: readWhen(lead.created_at),
      kind: "created",
      title: sourceWords(lead.source),
      detail: lead.imported_owner_name
        ? `The spreadsheet's Sales Owner column said "${lead.imported_owner_name}".`
        : null,
      source: "admin_leads",
    }), lead.created_at);
  }

  /* ---- the chase ---- */
  if (activity === null) notCounted.push(SOURCE_LABELS.admin_lead_activity);
  else {
    for (const a of activity) {
      push(event({
        id: `a:${a.id}`,
        at: readWhen(a.created_at),
        kind: a.type,
        title: a.outcome ? outcomeWords(a.outcome) : null,
        detail: a.body || null,
        who: teamName(a.actor),
        source: "admin_lead_activity",
      }), a.created_at);
    }
  }

  /* ---- what was proposed ----
   * The proposal ROW, not the note about it. A note says a proposal went out;
   * the row says for how much and what came back, and those are the two things
   * the sheet had nowhere to put. */
  if (proposals === null) notCounted.push(SOURCE_LABELS.admin_proposals);
  else {
    for (const p of proposals) {
      /* Each proposal contributes up to three moments, and only the ones that
       * actually have a date. A proposal marked won with no decision date does
       * not get a made-up one. */
      push(event({
        id: `p:${p.id}:sent`, at: readWhen(p.sent_at), kind: "proposal_row",
        title: `${p.title || "Proposal"} sent`,
        detail: p.package ? `${p.package}${p.term ? ` · ${p.term}` : ""}` : null,
        amountCents: p.amount_cents, source: "admin_proposals",
      }), p.sent_at);
      push(event({
        id: `p:${p.id}:viewed`, at: readWhen(p.viewed_at), kind: "proposal_viewed",
        title: `${p.title || "Proposal"} opened by them`,
        source: "admin_proposals",
      }), p.viewed_at);
      push(event({
        id: `p:${p.id}:decided`, at: readWhen(p.decided_at), kind: "proposal_row",
        title: `${p.title || "Proposal"} — ${p.status}`,
        detail: p.lost_reason || null,
        amountCents: p.amount_cents, source: "admin_proposals",
      }), p.decided_at);
    }
  }

  /* ---- and beyond: the work we actually did for them ---- */
  if (tasks === null) notCounted.push(SOURCE_LABELS.admin_tasks);
  else {
    for (const t of tasks) {
      /* Only finished work goes on the history. A to-do is a plan, and a
       * timeline of plans is not a record of anything. */
      if (t.status !== "done") continue;
      /* HONEST LIMIT: `admin_tasks` has no finished-on column. `updated_at` is
       * the closest thing we hold, and it moves every time anybody edits the
       * task — so a job done in June whose note is corrected in August jumps to
       * August, and can cross the "became a client" line. Said on the line
       * rather than left for somebody to discover. */
      const dated = t.updated_at || t.due_date || t.created_at;
      push(event({
        id: `t:${t.id}`, at: readWhen(dated),
        kind: "task", title: t.name,
        detail: [t.latest_report || null, t.updated_at ? "Dated by when this task was last edited — we do not record a finished-on date." : null]
          .filter(Boolean).join(" "),
        who: teamName(t.assigned_to),
        source: "admin_tasks",
      }), dated);
    }
  }

  if (weekly === null) notCounted.push(SOURCE_LABELS.admin_weekly_log);
  else {
    for (const w of weekly) {
      push(event({
        id: `w:${w.id}`, at: readWhen(w.target_date || w.created_at),
        kind: "weekly", title: `Week ${w.week_no}`,
        detail: [w.what_we_did, w.what_moved].filter(Boolean).join(" — ") || null,
        source: "admin_weekly_log",
      }), w.target_date || w.created_at);
    }
  }

  if (reports === null) notCounted.push(SOURCE_LABELS.admin_client_reports);
  else {
    for (const r of reports) {
      push(event({
        id: `r:${r.id}`, at: readWhen(r.created_at),
        kind: "report", title: r.title || "Client report",
        who: teamName(r.created_by),
        source: "admin_client_reports",
      }), r.created_at);
    }
  }

  if (invoices === null) notCounted.push(SOURCE_LABELS.admin_invoices);
  else {
    for (const inv of invoices) {
      push(event({
        id: `i:${inv.id}:sent`, at: readWhen(inv.sent_at, { dayStamp: true }), kind: "invoice",
        title: `Invoice ${inv.number || ""}`.trim(),
        amountCents: inv.total_cents, source: "admin_invoices",
      }), inv.sent_at);
      push(event({
        id: `i:${inv.id}:paid`, at: readWhen(inv.paid_at, { dayStamp: true }), kind: "payment",
        title: `Paid — invoice ${inv.number || ""}`.trim(),
        /* `amount_paid_cents` is the real column name (0007). The first version
         * read `paid_cents`, which does not exist — it read as undefined and
         * fell through to the invoice TOTAL, which happens to be right today
         * only because the trigger sets paid_at on full payment alone. Reading
         * a column that is not there is a landmine, not a fallback. */
        amountCents: inv.amount_paid_cents ?? null, source: "admin_invoices",
      }), inv.paid_at);
    }
  }

  if (tickets === null) notCounted.push(SOURCE_LABELS.admin_tickets);
  else {
    for (const t of tickets) {
      push(event({
        id: `k:${t.id}`, at: readWhen(t.created_at), kind: "ticket",
        title: t.subject || "Ticket", detail: t.status ? `Now ${t.status}.` : null,
        source: "admin_tickets",
      }), t.created_at);
    }
  }

  /* Newest first. `id` breaks a tie so the order is stable between renders —
   * two rows written in the same millisecond swapping places on every refresh
   * looks like the data is changing when it is not. */
  events.sort((a, b) => (a.at === b.at ? String(a.id).localeCompare(String(b.id)) : (a.at < b.at ? 1 : -1)));

  const becameClientAt = readWhen(lead?.became_customer_at)
    || (lead?.became_customer ? readWhen(lead?.closed_at) : null);

  /* The line between the chase and the client work. Anything at or after the
   * moment they started paying is client-era. Where we hold no date for that
   * moment, NOTHING is marked — a guessed line is worse than no line. */
  for (const e of events) {
    e.era = becameClientAt ? (e.at >= becameClientAt ? "client" : "chase") : "chase";
  }

  const total = events.length;
  const shown = total > cap ? events.slice(0, cap) : events;

  return {
    events: shown,
    counts,
    total,
    dropped,
    truncated: total > cap
      ? `${total - cap} older entries are not shown. This timeline holds ${total}.`
      : null,
    notCounted,
    /* A source can never be BOTH "not read at all" and "read only in part" —
     * printing both sentences about one source would contradict itself. Not
     * reachable from today's caller; removed here so it stays that way. */
    partial: partial.filter((x) => !notCounted.includes(x)),
    becameClientAt,
  };
}

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */

function sourceWords(source) {
  switch (source) {
    case "sheet": return "From the outreach spreadsheet";
    case "import": return "From an imported file";
    case "csv": return "From a CSV";
    case "scraper": return "From a saved search";
    case "platform": return "From the platform";
    case "referral": return "A referral";
    case "inbound": return "They came to us";
    case "manual": return "Added by hand";
    default: return source ? `Source: ${source}` : null;
  }
}

function outcomeWords(outcome) {
  switch (outcome) {
    case "talked": return "Talked to them";
    case "voicemail": return "Left a voicemail";
    case "no_answer": return "No answer";
    case "booked": return "Booked a meeting";
    case "not_interested": return "Not interested";
    case "bad_number": return "Bad number";
    default: return outcome || null;
  }
}

/**
 * One plain-words sentence about what this timeline is, for the top of it.
 * Says what it counted AND what it could not, because those read identically
 * on screen and mean opposite things.
 */
export function timelineSummary(t) {
  const bits = [];
  if (t.total === 0) bits.push("Nothing has been logged against this person yet.");
  else bits.push(`${t.total} thing${t.total === 1 ? "" : "s"} on record.`);
  /* Only claim a star when one will actually be drawn, and describe what is
   * really on either side of it. The old wording promised "everything above it
   * is the work" even when the star sat at the very top with nothing above it,
   * and promised a star at all when every entry was client-era and none was
   * drawn. */
  /* Only when there is actually something in the list. With no events at all,
   * every branch below describes what is on a screen that is empty — the third
   * one claimed "everything shown here happened after the deal closed" about
   * nothing at all. Reachable: an unreadable created_at and no other source. */
  if (t.becameClientAt && t.events.length > 0) {
    const chase = t.events.filter((e) => e.era === "chase").length;
    const after = t.events.length - chase;
    if (chase > 0 && after > 0) {
      bits.push(`The star marks the day they became a paying client: ${after} ${after === 1 ? "entry" : "entries"} since, ${chase} from the chase before it.`);
    } else if (chase > 0) {
      bits.push("They are a paying client. Nothing has been logged since the day the deal closed, so everything here is the chase.");
    } else {
      bits.push("They are a paying client, and everything shown here happened after the deal closed.");
    }
  }
  if (t.dropped > 0) bits.push(`${t.dropped} entr${t.dropped === 1 ? "y" : "ies"} had no readable date and could not be placed, so ${t.dropped === 1 ? "it is" : "they are"} not shown.`);
  if (t.notCounted.length) bits.push(`Not counted here: ${t.notCounted.join(", ")}.`);
  if (t.partial?.length) bits.push(`Only partly read, so older entries may be missing: ${t.partial.join(", ")}.`);
  return bits.join(" ");
}
