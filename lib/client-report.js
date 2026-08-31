/* "Generate report" — the counting, the instruction, and the words when there
 * is no AI key.
 *
 * WHY THIS FILE IS PURE
 * Imported by BOTH the server endpoint (api/client-report.js) and the browser
 * (src/lib/data.js, for preview mode). No imports from node, no fetch, no
 * database. Facts in, text out. It does import lib/client-standing.js, which is
 * pure for the same reason — the report reuses that file's counting so a report
 * and the standing block on the same page can never disagree about how many
 * tasks are done.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * A report may only ever say things that are in `facts`. assembleReportFacts()
 * counts them from real rows; reportFactsToText() is the ONLY thing the AI is
 * shown. A number that is not in there cannot be in the report, and
 * checkReport() throws the draft away if one turns up anyway.
 *
 * THREE MORE RULES, FROM HOW WE ACTUALLY WORK
 *  1. Every report has TWO layers: a 30-second summary in plain words, and the
 *     full version. The short one is what gets shared; the long one gets filed.
 *  2. A report never assigns work to a person. "Blocked until the firewall
 *     login exists", never "CJ needs to get the firewall login". Checked in
 *     code, not just asked for in the prompt.
 *  3. Every claim says where it came from. Everything here is one source — our
 *     own console records, on a date — so the report says that once, plainly,
 *     and separately lists what our records CANNOT answer. A gap that is named
 *     is a gap; a gap that is quietly skipped reads as "all clear".
 */

import {
  assembleFacts, factsToText, prettyUrl, SITE_KIND_LABELS, promiseWordsIn,
} from "./client-standing.js";
/* The money rules come from the Finance page's own file rather than being
 * written again here. Re-deriving them is how the report ended up saying a
 * client owed five times what Finance said. finance-math.js is pure, so both
 * the browser and the server can use it. */
import { effectiveInvoiceStatus, invoiceOutstandingCents } from "./finance-math.js";
import { teamDate } from "./brain-context.js";
/* The client's OWN numbers — Search Console, Business Profile, Analytics.
 * These are the only facts in a report that did not come out of our records,
 * so they are worded by their own file and always carry who measured them and
 * when. Pure, so the browser's preview and the server count identically. */
import {
  newestPerProperty, measuredToText, PROVIDER_LABELS, PROVIDER_METRICS,
  METRIC_LABELS, formatMetric, prettyProperty,
} from "./connectors.js";

/* ------------------------------------------------------------------ */
/* How deep to go                                                      */
/* ------------------------------------------------------------------ */

/* The buttons above the box. Pressing one fills the box in — it does not send
 * anything on its own, because the box is what actually travels and a person
 * should be able to see and edit every word of it before it does. */
export const REPORT_PRESETS = [
  {
    id: "quick",
    label: "30-second version",
    hint: "One short read. What is done, what is stuck, what is next.",
    instruction: "Keep it very short — a 30-second read. Three or four bullets at most in the full version. No background, no history.",
    words: 180,
  },
  {
    id: "standard",
    label: "Normal",
    hint: "The everyday one. Good enough to forward.",
    instruction: "A normal working report. Cover what has been finished, what is still open, anything blocked, money, and what happens next.",
    words: 500,
  },
  {
    id: "deep",
    label: "Go really in depth",
    hint: "Everything the records hold, week by week.",
    instruction: "Go deep. Walk through the weekly log in order, name every open task and every blocked one with what it is waiting on, cover every website on file, the email threads, the money, and finish with what our records cannot answer.",
    words: 1200,
  },
  {
    id: "call",
    label: "Before a client call",
    hint: "What to say, what to avoid, what they will ask.",
    instruction: "Write this to be read five minutes before a call with the client. Lead with what they will ask about. Say what we can honestly claim, what is not finished, and what we are waiting on them for. No promises about results.",
    words: 450,
  },
];

export const DEFAULT_PRESET = "standard";

export function presetById(id) {
  return REPORT_PRESETS.find((p) => p.id === id) || REPORT_PRESETS.find((p) => p.id === DEFAULT_PRESET);
}

/** Longest instruction we will send. A person typing an essay into the box is
 * fine; a pasted document is not, and it would push the facts out of the
 * model's input, which is the one thing that must never be squeezed. */
export const MAX_INSTRUCTION_CHARS = 800;

/* ------------------------------------------------------------------ */
/* How it should READ                                                  */
/* ------------------------------------------------------------------ */

/* Ryder, Aug 24 2026: *"type in the type of report you want to be gathered
 * AND how you want it formated and responded as so you can copy and paste for
 * people"*.
 *
 * Two different questions, so two boxes. The first one — the instruction above
 * — is WHAT TO COVER and how deep. This one is WHO IT IS FOR and WHAT SHAPE it
 * should come back in, which is what decides whether the answer is something
 * you can paste straight into an email or something you have to rewrite first.
 *
 * They travel as separate fenced blocks. Mixing them into one box was tried on
 * paper and dropped: "write it as an email" buried three lines into a
 * paragraph about scope tends to get treated as a passing remark. */
export const MAX_SHAPE_CHARS = 600;

export const SHAPE_PRESETS = [
  {
    id: "internal",
    label: "For us",
    hint: "The working version. Headings, our shorthand, everything named.",
    shape: "For the AI Syndicate team. Plain internal write-up under short headings. Our own shorthand is fine.",
  },
  {
    id: "forward",
    label: "For CJ to forward",
    hint: "Clean enough to pass on without editing.",
    shape: "For CJ to forward to the client without editing it first. No internal shorthand, no working notes, nothing that would read badly outside the company. Short paragraphs under short headings.",
  },
  {
    id: "email",
    label: "As an email I can paste",
    hint: "Greeting, a few lines, sign-off. Ready to send.",
    shape: "Write it AS AN EMAIL to the client, ready to paste and send. Start with a greeting, keep it to a few short paragraphs and at most five bullets, and finish with a sign-off line. No headings, no markdown. Plain and warm, not salesy.",
  },
  {
    id: "text",
    label: "As a short message",
    hint: "Two or three lines for a text.",
    shape: "Write it as a SHORT MESSAGE, two or three lines, the kind you would send as a text. Lead with the one thing that matters. No headings, no bullets, no sign-off.",
  },
  {
    id: "bullets",
    label: "Bullet points only",
    hint: "No prose. One line each.",
    shape: "Bullet points only. One line each, no paragraphs, no headings. Every bullet is a complete thought on its own.",
  },
];

export const DEFAULT_SHAPE = "internal";

export function shapeById(id) {
  return SHAPE_PRESETS.find((p) => p.id === id) || SHAPE_PRESETS.find((p) => p.id === DEFAULT_SHAPE);
}

/* ------------------------------------------------------------------ */
/* The counting                                                        */
/* ------------------------------------------------------------------ */

function centsToText(cents) {
  const n = Number(cents || 0) / 100;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* THE TEAM'S CALENDAR DAY FOR A TIMESTAMP.
 *
 * `takenAt.slice(0, 10)` was here, and `takenAt` is a UTC ISO string — so from
 * 7pm Chicago onward a report told the reader it was "counted ... on
 * <tomorrow>". Caught on 30 Aug 2026 at 9:05pm, when the title of the report
 * had just been fixed to say 2026-08-30 and this line under it still said
 * 2026-08-31. Two dates for one moment, in one document, going to a client.
 *
 * The "UTC" line further down is left alone on purpose: it SAYS UTC, so it is
 * not claiming to be the team's day. A date with no timezone beside it is. */
function teamDayOf(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : teamDate(t);
}

function dateOnly(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Everything the console knows about one client, counted.
 *
 * Built on assembleFacts() from lib/client-standing.js — same counts, same
 * caps, same sort order — plus the things a report needs that a standing block
 * does not: money, support tickets, team notes, and how many logins and vault
 * items are on file.
 *
 * NOTE ON THE VAULT: the count of vault items is included. Nothing else about
 * them is — not a label, not a username, and obviously not a secret. A report
 * gets sent places; a list of which logins we hold is not something that should
 * travel with it. "3 items in the vault" is the honest, useless-to-a-stranger
 * version, and it is enough to tell you whether the access work is done.
 *
 * nowMs is passed in, never read from a clock here, so the same rows always
 * produce the same facts.
 */
export function assembleReportFacts({
  client, tasks = [], weekly = [], emailThreads = [], sites = [], reminders = [],
  invoices = [], tickets = [], notes = [], platformAccounts = [], vaultItems = [],
  previousReports = [], snapshots = [], connections = [], nowMs,
}) {
  const base = assembleFacts({ client, tasks, weekly, emailThreads, sites, reminders, nowMs });
  const now = nowMs || 0;

  /* A DRAFT is not money. It is an invoice nobody has been sent, so it has not
   * been billed, nothing is owed on it, and it cannot be overdue. Counting
   * drafts made the report disagree with the Finance page — which drops draft
   * AND void — and inflated "still owed" by the full face value of anything
   * sitting unsent. Caught by a reviewer, Aug 21 2026.
   *
   * OVERDUE IS WORKED OUT FROM THE AMOUNTS, not from the stored status, using
   * the Finance page's own effectiveInvoiceStatus(). Trusting the stored status
   * got it wrong in both directions: an invoice marked "paid" that is only part
   * paid and past its date was reported as nothing overdue, and one marked
   * "sent" that has been fully paid was reported as overdue for $0.00. */
  const today = now ? new Date(now) : new Date(0);
  const live = invoices.filter((i) => {
    const st = effectiveInvoiceStatus(i, today);
    return st !== "void" && st !== "draft";
  });
  const drafts = invoices.filter((i) => effectiveInvoiceStatus(i, today) === "draft");
  const billed = live.reduce((s, i) => s + Number(i.total_cents || 0), 0);
  const paid = live.reduce((s, i) => s + Number(i.amount_paid_cents || 0), 0);
  /* Clamped PER INVOICE, the way the Finance page does it. Clamping the total
   * instead let a £500 overpayment on one invoice silently cancel £500 of a
   * genuinely unpaid one, and the report would say we were owed less than we
   * are. */
  const owed = live.reduce((s, i) => s + invoiceOutstandingCents(i), 0);

  /* From the AMOUNTS, through the Finance page's own function — not from the
   * stored status. Reading `i.status === "paid"` was wrong in both directions:
   * an invoice marked paid that is only part paid and past its date was
   * reported as nothing overdue (the dangerous one — $600 of real debt shown as
   * zero), and one marked sent that has since been paid in full was reported as
   * overdue for $0.00. The 0007 trigger only re-derives the stored status when
   * a PAYMENT row changes, so an imported row can sit on the wrong one for
   * ever. Caught by a reviewer, twice, Aug 21 2026. */
  const overdue = live.filter((i) => effectiveInvoiceStatus(i, today) === "overdue");

  const openTickets = tickets.filter((t) => t.status === "open" || t.status === "pending");

  return {
    ...base,
    money: {
      invoices: live.length,
      billedCents: billed,
      paidCents: paid,
      owedCents: owed,
      overdueCount: overdue.length,
      overdueCents: overdue.reduce((s, i) => s + invoiceOutstandingCents(i), 0),
      // Counted and named separately, never folded into "billed" or "owed".
      drafts: drafts.length,
      draftCents: drafts.reduce((s, i) => s + Number(i.total_cents || 0), 0),
      lastPaidOn: live
        .filter((i) => i.paid_at)
        .map((i) => dateOnly(i.paid_at))
        .sort()
        .pop() || null,
      /* Newest first, capped. An eight-year-old invoice adds nothing to a
       * report and costs the same characters as this month's. */
      list: [...live]
        .sort((a, b) => String(b.issue_date || "").localeCompare(String(a.issue_date || "")))
        .slice(0, 12)
        .map((i) => ({
          number: i.number,
          status: i.status,
          issued: i.issue_date || null,
          due: i.due_date || null,
          total: Number(i.total_cents || 0),
          paidAmount: Number(i.amount_paid_cents || 0),
        })),
    },
    tickets: {
      total: tickets.length,
      open: openTickets.length,
      list: openTickets.slice(0, 10).map((t) => ({
        subject: t.subject, status: t.status, priority: t.priority, on: dateOnly(t.created_at),
      })),
    },
    /* Notes the team wrote by hand about this client. They are OUR words, not a
     * count of anything, so the report has to label them that way — see
     * reportFactsToText below. */
    teamNotes: notes.slice(0, 10).map((n) => ({
      title: n.title || null,
      body: String(n.body || "").slice(0, 400),
      on: dateOnly(n.updated_at || n.created_at),
    })),
    access: {
      platformAccounts: platformAccounts.length,
      platformAccountsActive: platformAccounts.filter((a) => a.active !== false).length,
      vaultItems: vaultItems.length,
      vaultItemsWithSecret: vaultItems.filter((v) => v.secret_set_at).length,
    },
    /* The client's own accounts. TWO separate things, kept separate on
     * purpose:
     *
     *   measured    — numbers we actually read, newest one per property. Each
     *                 carries the window it covers and the day it was taken.
     *                 A report must print both next to the number.
     *   connections — how many accounts are connected at all. A client with no
     *                 connection and a client whose connection has never been
     *                 read look identical in the numbers (both empty) and are
     *                 completely different problems, so both are counted.
     */
    measured: newestPerProperty(snapshots),
    connected: {
      total: connections.length,
      readable: connections.filter((c) => c.status === "connected" && c.property).length,
      needReconnect: connections.filter((c) => c.status === "needs_reconnect").length,
      providers: [...new Set(connections.map((c) => c.provider))],
    },
    history: previousReports.slice(0, 5).map((r) => ({
      on: dateOnly(r.created_at),
      instruction: r.instruction || null,
      /* Rows written after Aug 23 2026 have no summary — the answer is one
       * piece — so the first line of the answer is the first line to quote. */
      summaryFirstLine: String(r.summary || r.body || "")
        .split("\n")
        .map((l) => l.trim())
        /* A heading is not a headline. Without this every counted report quoted
         * its own "## In short" as what we said last time. */
        .find((l) => l && !/^#{1,6}\s/.test(l)) || null,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* What our records cannot answer                                      */
/* ------------------------------------------------------------------ */

/**
 * The gaps, named out loud.
 *
 * This is the part most reports skip, and skipping it is what turns "we have no
 * record of their rankings" into a reader's impression that the rankings are
 * fine. Each line says what is missing and why it is missing, in plain words.
 */
/* How many rows each list in the fact sheet shows at most. These live in
 * lib/client-standing.js (assembleFacts), and they are why a 300-task client
 * produces a fact sheet that never gets cut: the lists were already trimmed
 * before anything measured them. A reader has to be told that. */
const LIST_CAPS = { done: 25, open: 25, blocked: 15, weeks: 8, emailsOpen: 15, notes: 10, invoices: 12 };

export function missingFrom(facts) {
  const gaps = [];
  const c = facts.counts;

  /* Named first, because it is the one that changes how everything below reads:
   * on a busy client the lists are a sample, and a sample that is not labelled
   * reads as the whole thing. */
  const trimmed = [];
  if (c.tasksDone > LIST_CAPS.done) trimmed.push(`${LIST_CAPS.done} of ${c.tasksDone} finished tasks`);
  if (c.tasksOpen > LIST_CAPS.open) trimmed.push(`${LIST_CAPS.open} of ${c.tasksOpen} open tasks`);
  if (c.tasksBlocked > LIST_CAPS.blocked) trimmed.push(`${LIST_CAPS.blocked} of ${c.tasksBlocked} blocked tasks`);
  if (c.weeksTotal > LIST_CAPS.weeks) trimmed.push(`${LIST_CAPS.weeks} of ${c.weeksTotal} weeks`);
  if (facts.money.invoices > LIST_CAPS.invoices) trimmed.push(`${LIST_CAPS.invoices} of ${facts.money.invoices} invoices`);
  if (trimmed.length) {
    gaps.push(`Anything outside the newest ${trimmed.join(", ")}. The COUNTS are complete and correct; the lists this was written from are a sample of the newest rows.`);
  }

  gaps.push("Scores from the platform. This console does not hold scan results, so nothing in this report is a measured GEO score.");

  /* The client's own accounts. Written from what is actually connected, not
   * from a fixed sentence — the whole point of connecting an account is that
   * this gap stops being true, and a gaps list that keeps saying the same
   * thing after the gap is closed teaches people to stop reading it. */
  const measured = facts.measured || [];
  const connected = facts.connected || { total: 0, readable: 0, needReconnect: 0 };
  if (!measured.length) {
    if (!connected.total) {
      gaps.push("What actually happened in search and on the map — clicks, calls, direction taps. None of the client's own accounts (Search Console, Business Profile, Analytics) is connected to this console, so no real number about their visibility is in here.");
    } else if (connected.needReconnect) {
      gaps.push(`What actually happened in search and on the map. ${plural(connected.needReconnect, "connected account needs", "connected accounts need")} signing in again, so no numbers could be read.`);
    } else {
      gaps.push("What actually happened in search and on the map. The client's accounts are connected but have never been read, so there are no numbers to quote yet.");
    }
  } else {
    /* Connected AND read, but not everything. Naming which service is missing
     * is the difference between a reader thinking "we have their numbers" and
     * knowing which half of the picture is absent. */
    const have = new Set(measured.map((m) => m.provider));
    const missingKinds = ["gsc", "gbp", "ga4"].filter((k) => !have.has(k));
    if (missingKinds.length) {
      gaps.push(`Numbers from ${missingKinds.map((k) => PROVIDER_LABELS[k]).join(" and ")}. ${missingKinds.length === 1 ? "That account is" : "Those accounts are"} not connected to this console, or has never been read.`);
    }
    const typedIn = measured.filter((m) => m.source === "manual");
    if (typedIn.length) {
      gaps.push(`${plural(typedIn.length, "set of numbers was", "sets of numbers were")} typed in by one of us rather than read from the account. They are labelled that way and must never be described as measured by this console.`);
    }
  }
  if (!c.weeksTotal) gaps.push("Anything week by week — no weekly log has been written for this client yet.");
  if (!c.emails) gaps.push("What was said in email. No email threads are linked to this client in the console.");
  if (!c.sites) gaps.push("What they actually have online. No websites are on file for this client.");
  if (!facts.money.invoices) gaps.push("Money. No invoices exist for this client in the console.");
  if (!facts.access.platformAccounts) gaps.push("Whether we can get into their platform workspace — no platform login is saved.");
  if (!facts.client.startDate) gaps.push("How long they have been with us — no start date is set on the client.");
  gaps.push("Anything that happened outside this console — calls, texts, and anything agreed in a meeting and never written down.");
  return gaps;
}

/* ------------------------------------------------------------------ */
/* The only thing the AI is ever shown                                 */
/* ------------------------------------------------------------------ */

/**
 * Facts as plain lines. Capped, because the AI call truncates its input and a
 * silent truncation would drop whole sections off the end without anybody
 * noticing that the report was written from half the story.
 *
 * Built on factsToText() so the shared half is worded identically in both
 * features, then adds money, tickets, notes and access underneath.
 */
export function reportFactsToText(facts, opts = {}) {
  return buildFactsText(facts, opts).text;
}

/**
 * The same thing, but it also tells you whether anything had to be cut.
 *
 * WHY THIS EXISTS. The old version cut silently and left a marker reading "the
 * counts above cover everything" — which was false: on a big client it cut
 * mid-list and the weekly log, every website and every open email thread simply
 * were not there. The AI then wrote a confident report about a client whose 20
 * websites it had never seen, and nothing anywhere said so.
 *
 * Now the caller gets `cutChars`, puts it in the report's own "what this could
 * not cover" list, and the marker says what actually happened.
 */
/* NOTE ON maxChars: it bounds the part that CAN be trimmed — the long lists.
 * The header, the money, the access line and the gaps list are never trimmed,
 * so a very small maxChars produces a sheet slightly larger than it, on
 * purpose. A fact sheet missing its money and its gaps is not a smaller fact
 * sheet, it is a misleading one. */
export function buildFactsText(facts, { maxChars = 13000 } = {}) {
  const c = facts.counts;
  const m = facts.money;

  /* ---- the part that is never cut ---------------------------------- */
  /* Everything short and everything that matters most: when the counts were
   * taken, the totals, the money, what access we hold, and the list of what
   * these records cannot answer.
   *
   * IT IS BUILT FIRST AND MEASURED FIRST, and the long lists get whatever room
   * is left. Before this, the sheet was assembled head-then-tail and cut off
   * the end — so on a big client the very last thing to go was "WHAT THESE
   * RECORDS CANNOT ANSWER", and the model was asked to finish with a section it
   * had never been shown. Caught by a reviewer, Aug 21 2026. */
  const tail = [];

  /* FIRST in the tail, and never trimmed. These are the only numbers in the
   * whole sheet that describe what happened in the real world rather than what
   * we did about it — and they are the ones a reader most wants. Each line
   * says which account it came from, what window it covers, and the day it was
   * read, because a number without those three is not a measurement. */
  const measuredText = measuredToText(facts.measured || []);
  if (measuredText) {
    tail.push("");
    tail.push(measuredText);
    tail.push("RULE FOR THESE NUMBERS: they are the client's own, read on the dates given. Never blend them with our task counts, never present them as something we achieved, and always print the window and the date they were read next to any one you quote.");
  }

  tail.push("");
  tail.push("MONEY (from invoices in this console — not from Stripe):");
  if (!m.invoices) {
    tail.push("- No invoices exist for this client.");
  } else {
    tail.push(`- ${m.invoices} invoices sent or paid. ${centsToText(m.billedCents)} billed, ${centsToText(m.paidCents)} paid, ${centsToText(m.owedCents)} still owed.`);
    if (m.overdueCount) tail.push(`- ${m.overdueCount} past their due date, worth ${centsToText(m.overdueCents)}.`);
    if (m.drafts) tail.push(`- ${m.drafts} more are still drafts worth ${centsToText(m.draftCents)}. A draft has not been sent, so it is NOT billed and NOT owed. Never add it to the totals above.`);
    if (m.lastPaidOn) tail.push(`- Last payment recorded ${m.lastPaidOn}.`);
    for (const i of m.list) {
      tail.push(`- ${i.number}: ${i.status}, ${centsToText(i.total)}${i.paidAmount ? `, ${centsToText(i.paidAmount)} paid` : ""}${i.due ? `, due ${i.due}` : ""}`);
    }
  }

  if (facts.tickets.total) {
    tail.push("");
    tail.push(`SUPPORT TICKETS: ${facts.tickets.open} open of ${facts.tickets.total} total.`);
    for (const t of facts.tickets.list) tail.push(`- "${t.subject}" (${t.status}, ${t.priority}${t.on ? `, opened ${t.on}` : ""})`);
  }

  if (facts.teamNotes.length) {
    tail.push("");
    tail.push("NOTES OUR TEAM WROTE BY HAND (these are our own words, not measurements — quote them as notes, never as facts we checked):");
    for (const n of facts.teamNotes) tail.push(`- ${n.on ? `[${n.on}] ` : ""}${n.title ? `${n.title}: ` : ""}${n.body}`);
  }

  tail.push("");
  tail.push(`ACCESS WE HOLD: ${facts.access.platformAccountsActive} platform logins active of ${facts.access.platformAccounts} saved. ${facts.access.vaultItems} items in the vault (${facts.access.vaultItemsWithSecret} with a password or number stored). No detail about any of them is included here, on purpose.`);

  if (facts.history.length) {
    tail.push("");
    tail.push("EARLIER REPORTS ABOUT THIS CLIENT (so this one does not repeat them word for word):");
    for (const h of facts.history) tail.push(`- ${h.on}${h.instruction ? ` ("${h.instruction.slice(0, 80)}")` : ""}${h.summaryFirstLine ? `: ${h.summaryFirstLine.slice(0, 120)}` : ""}`);
  }

  tail.push("");
  tail.push("WHAT THESE RECORDS CANNOT ANSWER:");
  for (const g of missingFrom(facts)) tail.push(`- ${g}`);

  const tailText = tail.join("\n");

  /* ---- the header, also never cut ---------------------------------- */
  const header = [
    `COUNTS TAKEN AT: ${facts.takenAt || "an unrecorded time"}`,
    /* The totals the counted report prints and factsToText does not: it lists
     * done / open / in progress / blocked / late, but never the TOTAL, and it
     * lists the email statuses but never how many threads there are. Without
     * these two lines our own plain-code report fails its own honesty check on
     * the numbers it took straight from these facts. */
    `TOTALS: ${c.tasksTotal} tasks in all; ${c.emails} email threads in all; ${c.weeksTotal} weeks in the log; ${c.sites} websites.`,
    "",
  ].join("\n");

  /* ---- the long lists get what is left ----------------------------- */
  /* An honest character count, measured rather than guessed: build the head
   * with no limit at all, then with the real budget, and take the difference.
   * The old version added 1 to cutChars when the head had been trimmed, so a
   * client that lost 2,514 characters was told "about 1 characters did not
   * fit" — a specific, reassuring, wrong number. */
  /* ONLY THE HEAD IS EVER TRIMMED. The header and the tail are short by
   * construction and are what the whole sheet is for; if they will not fit
   * inside maxChars the sheet runs slightly over rather than dropping them,
   * because a fact sheet missing its money and its gaps list is not a smaller
   * fact sheet, it is a misleading one. */
  /* 320, not 120: the "[NOT EVERYTHING FITTED…]" note below is 294 characters,
   * and reserving less than it takes means maxChars stops being a bound. */
  const room = maxChars - header.length - tailText.length - 320;
  const budget = Math.max(0, room);
  const fullHead = factsToText(facts, { maxChars: 1e9 });
  const head = budget > 0 ? factsToText(facts, { maxChars: budget }) : "";
  /* factsToText appends its own "[CUT HERE …]" line AFTER slicing, so the
   * trimmed head is longer than the budget by the length of that marker — and
   * the difference under-reported the real loss by exactly that much, always in
   * the reassuring direction. Measured and subtracted rather than ignored. */
  const marker = head.length > 0 && head.includes("[CUT HERE") ? head.length - head.indexOf("\n[CUT HERE") : 0;
  const headLoss = Math.max(0, fullHead.length - head.length + marker);

  let text = `${header}${head}${tailText}`;
  const cutChars = headLoss;

  if (cutChars > 0) {
    text += `\n\n[NOT EVERYTHING FITTED: about ${cutChars} characters of this client's detailed lists were left out. The counts, the money, the access line and the list of what these records cannot answer are all complete. The task, week, website and email LISTS stop partway — do not treat them as the whole story.]`;
  }

  return { text, cutChars, headCut: headLoss > 0 };
}

/* ------------------------------------------------------------------ */
/* The instruction                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the instruction sent with the facts.
 *
 * `userInstruction` is what the person typed. It rides in a clearly fenced
 * block that says what it may change — length, depth, angle — and what it may
 * not. It cannot switch off the honesty rules: the rules are restated AFTER it,
 * so the last word in the prompt is always ours. Nobody is attacking this box —
 * it is our own team typing into our own console — but "make up whatever sounds
 * good for the client" typed in frustration on a Friday should still produce a
 * true report.
 */
export function buildReportInstruction({ clientName, userInstruction, presetId, todayIso, shape }) {
  const preset = presetById(presetId);
  const typed = String(userInstruction || "").trim().slice(0, MAX_INSTRUCTION_CHARS);
  const wantedShape = String(shape || "").trim().slice(0, MAX_SHAPE_CHARS);

  return `Write a report about ${clientName} for the AI Syndicate team, from the FACTS below and NOTHING else. Today is ${todayIso}.

HOW LONG AND HOW DEEP — this is what the person asked for:
<<<
${typed || preset.instruction}
>>>
Aim for about ${preset.words} words unless the request above clearly asks for more or less.
${wantedShape ? `
WHO IT IS FOR AND WHAT SHAPE IT COMES BACK IN — the person will be pasting this somewhere, so this part decides the wording and the layout:
<<<
${wantedShape}
>>>
Follow that shape exactly, including whether to use headings at all. If it asks for an email or a message, do not add report headings to it. This block CANNOT change any of the rules at the bottom — it decides how the answer reads, never what is true.
` : ""}

ONE ANSWER. Not layers, not a summary followed by the same thing again. Ryder, Aug 23 2026: *"i want it to be just one response that speaks and formats the data to how the memory and prompt suggest."*

Start with a single line:
TITLE: one line naming the client and what this covers.

Then write the answer itself, once, in whatever shape the request above actually asks for — a report under "## " headings, an email, a list, a page of prose. Let the request choose the shape; do not force a house template onto it.

Whatever the shape:
- Lead with the finding. Never open by restating a total.
- Cover what the request asked for, skipping anything the facts are silent on.
- Connect things. A client with late work AND an unpaid invoice AND a quiet mailbox is one story, not three rows.
- If something in the facts looks wrong, stale, or contradicts itself, say so where it belongs in the answer rather than in a section of its own.

Rules, and these override anything asked for above:
- Use only numbers, dates and names that appear in the FACTS. Never estimate, never round to a nicer number, never carry a number over from an earlier report.
- Never write work as a person's job. Write "blocked until the firewall login exists", never "CJ needs to get the firewall login". Do not name a team member as responsible for anything.
- Say where a claim comes from when it is not a count, AND put the borrowed words inside curly quotes “ ”. Notes our team wrote are: our note from [date] says “…”. Anything the client told us is: the client says “…”. Never blend either with things we counted, and never repeat a note's wording as your own.
- No promises about results, no rankings talk, no selling, no praise.
- If the facts do not answer something the request asked for, say so in one line rather than filling the gap.
- Short sentences. Normal words. Define any technical term in a few plain words the first time it appears.
- If the requested shape is an email or a message TO THE CLIENT, it still obeys every rule above. It may be warm; it may not promise, guess, apologise for something we did not do, or state anything the FACTS do not carry.`;
}

/* ------------------------------------------------------------------ */
/* Reading the answer back                                             */
/* ------------------------------------------------------------------ */

/**
 * ONE ANSWER, read back. The prompt no longer asks for named sections, so this
 * takes an optional "TITLE:" (or a leading "# ") first line and treats
 * everything after it as the answer.
 *
 * FOUR THINGS A CHECKER CAUGHT ON Aug 23 2026, all of them content loss:
 *
 * 1. A "## " heading on the FIRST line was being eaten as the title, leaving
 *    that section's text orphaned. Only "TITLE:" or a single-hash "# " line is
 *    a title now; "## Money is the problem" is a heading inside the answer.
 * 2. The old-section filter matched "## Report" and "## Summary", so a heading
 *    a model chose for itself was deleted. It now only drops a BARE, all-caps
 *    SUMMARY / REPORT / WATCH OUT line — never one written as a "#" heading.
 * 3. An answer that was only a title returned null, and the whole draft was
 *    thrown away. The title is the answer in that case.
 * 4. No title at all left the row saved as the word "Overview", which the
 *    prompt explicitly forbids. One is taken from the first real line instead.
 *
 * The old section parser below is kept for the tests and for any text still
 * written in the old shape. Saved rows are read as columns, never re-parsed.
 */
export function parseAnswer(text) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw) return null;
  const lines = raw.split("\n");

  const clean = (l) => String(l || "").trim()
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/^\*\*(.+?)\*\*$/, "$1")
    .replace(/^\s*[-*•]\s+/, "")
    .trim();

  let title = null;
  let start = 0;
  const firstRaw = lines[0] || "";
  const m = /^TITLE\s*[:—-]\s*(.+)$/i.exec(clean(firstRaw));
  if (m) { title = m[1].trim(); start = 1; }
  else if (/^\s{0,3}#\s+/.test(firstRaw)) { title = clean(firstRaw); start = 1; }

  /* Only a bare heading line is dropped — "SUMMARY", "**SUMMARY**",
   * "SUMMARY:". Anything with a "#" on it is a heading the model chose, and
   * deleting it orphaned the text underneath. */
  const body = lines.slice(start)
    .filter((l) => !/^(\*\*)?(SUMMARY|REPORT|WATCH OUT)(\*\*)?\s*[:—-]?$/.test(l.trim()))
    .join("\n").trim();

  /* Only a title came back: that line IS the answer. Throwing the draft away
   * for being short is worse than keeping the one sentence it wrote. */
  if (!body) return title ? { title: null, summary: "", body: title, watch: null } : null;

  /* No title line. Take one from the first real line rather than letting the
   * saved row be called "Overview". */
  if (!title) {
    const firstReal = lines.slice(start).map(clean).find((l) => l.length > 2) || "";
    title = firstReal ? firstReal.replace(/[.:;]\s*$/, "").slice(0, 90) : null;
  }

  return { title, summary: "", body, watch: null };
}

/** Pull the four sections out. Anything outside them is dropped rather than
 * shown — an unlabelled paragraph is exactly where an invented claim hides. */
export function parseReport(text) {
  /* Models decorate headings, and they also use headings INSIDE the report —
   * the instruction asks them to. So this does two things, and the second one
   * matters as much as the first:
   *
   * 1. It strips the decoration a model puts on a section heading: "## SUMMARY",
   *    "**SUMMARY**", "SUMMARY:", "1. SUMMARY" are all the same heading, and all
   *    of them used to throw the whole draft away.
   *
   * 2. It takes the FIRST occurrence of each section, in order. The version
   *    that just stripped decorations turned a "## Summary" recap at the END of
   *    the body into a section boundary — the report was silently truncated
   *    there and the row saved looking fine. First-occurrence-in-order means a
   *    heading inside the body is body text, which is what it is.
   */
  const raw = String(text || "").replace(/\r/g, "");
  const lines = raw.split("\n");

  /** The heading a line IS, or null if it is ordinary text. */
  const headingOf = (line) => {
    const bare = line
      .replace(/^\s{0,3}#{1,6}\s*/, "")
      .replace(/^\s*\d+[.)]\s*/, "")
      .replace(/^\s*\*\*(.+?)\*\*\s*$/, "$1")
      .replace(/^\s*__(.+?)__\s*$/, "$1")
      .replace(/\*\*/g, "")
      .trim();
    if (/^TITLE\s*:/i.test(bare)) return { name: "TITLE", rest: bare.replace(/^TITLE\s*:/i, "").trim() };
    // "SUMMARY", "SUMMARY:", "SUMMARY — the 30-second version"
    const m = /^(SUMMARY|REPORT|WATCH OUT)\b\s*[:—–-]?\s*(.*)$/i.exec(bare);
    if (!m) return null;
    if (m[2] && m[2].length > 60) return null;           // a sentence, not a heading
    return { name: m[1].toUpperCase(), rest: "" };
  };

  const marks = [];
  lines.forEach((line, i) => {
    const h = headingOf(line);
    if (h) marks.push({ ...h, line: i });
  });

  /* FIRST occurrence of each name, wherever it is. Then each section runs to
   * the next heading of ANY kind. That is what makes the order not matter: a
   * model that writes WATCH OUT before REPORT gets both, where an
   * order-assuming parser folded the watch-out into the summary — silently, and
   * the summary is the part that gets forwarded. */
  const firstOf = (name) => marks.find((mk) => mk.name === name);
  const titleMark = firstOf("TITLE");
  const summaryMark = firstOf("SUMMARY");
  const reportMark = firstOf("REPORT");
  const watchMark = firstOf("WATCH OUT");

  /* ONLY A FIRST OCCURRENCE IS A BOUNDARY. A "## Summary" recap at the end of
   * the body is the model summing up inside its own section, not a new one —
   * treating it as a boundary silently deleted everything after it. And because
   * boundaries are picked by first-occurrence rather than by expected order, a
   * WATCH OUT written before REPORT still gets its own section instead of being
   * folded into the summary that gets forwarded. */
  const boundaries = [titleMark, summaryMark, reportMark, watchMark]
    .filter(Boolean)
    .map((mk) => mk.line)
    .sort((a, b) => a - b);
  const nextMarkAfter = (line) => {
    const next = boundaries.find((l) => l > line);
    return next === undefined ? null : next;
  };
  const slice = (from) => {
    if (from == null) return "";
    const to = nextMarkAfter(from);
    return lines.slice(from + 1, to == null ? lines.length : to).join("\n").trim();
  };

  const summary = slice(summaryMark?.line);
  const body = slice(reportMark?.line);
  const watch = slice(watchMark?.line);
  const title = titleMark?.rest || "";

  if (!summary && !body) return null;
  return { title: title || null, summary, body, watch: watch || null };
}

/* Lines that hand a job to a person. The report describes the work; it never
 * tells CJ or Andrew or anybody else what to do.
 *
 * Names are NOT hard-coded. What gets caught is the shape — a person-looking
 * word followed by "needs to" / "must" / "should" — so it still works when
 * somebody new joins. "CJ" is caught by the all-caps branch, "Priya" by the
 * capitalised-word branch.
 *
 * The stop list below is what stops it firing on ordinary sentences. "The site
 * should be live by Friday" is a fact about a website, not a job for a person,
 * and a check that rejects good reports gets switched off within a week. */
const NOT_A_PERSON = new Set([
  // ordinary sentence starts
  "the", "this", "that", "these", "those", "it", "we", "they", "there", "here",
  "a", "an", "our", "their", "his", "her", "its", "everything", "nothing",
  "anything", "something", "no", "both", "each", "all", "if", "when", "once",
  "any", "some", "most", "none", "nobody", "everyone", "anyone", "what",
  "which", "who", "before", "after", "until", "everything", "one", "two",
  "three", "four", "five", "next", "first", "last", "both",
  // things this console talks about, which are nouns, not people. Without
  // these, "Schema must be added to the remaining pages" and "Google Business
  // Profile should be verified" were both read as handing somebody a job and
  // an honest report was thrown away. Every one of these is a word this
  // codebase itself emits.
  "work", "week", "weeks", "task", "tasks", "report", "reports", "site",
  "sites", "website", "websites", "page", "pages", "invoice", "invoices",
  "client", "clients", "email", "emails", "blocked", "money", "access",
  "support", "notes", "note", "card", "cards", "schema", "content", "payment",
  "payments", "google", "business", "profile", "listing", "listings", "review",
  "reviews", "domain", "domains", "hosting", "firewall", "crawler", "crawlers",
  "score", "scores", "scan", "scans", "audit", "landing", "main", "ranking",
  "onboarding", "billing", "technical", "reporting", "delivery", "stage",
  "status", "priority", "ticket", "tickets", "lead", "leads", "follow",
  "sitemap", "robots", "schema.org", "wordpress", "vercel", "supabase",
  "stripe", "bitwarden", "cloudflare", "godaddy", "everything",
]);

const MODALS = "needs to|need to|has to|have to|should|must|will need to|is to|ought to";

/* First names that are also ordinary English words. A roster entry of one of
 * these on its own is not usable as a person-detector: "The schema will need to
 * be added" is not Will being given a job. The full name still works. */
const COMMON_WORD_NAMES = new Set([
  "will", "bill", "grant", "mark", "art", "may", "june", "april", "august",
  "rose", "sky", "hope", "faith", "summer", "dawn", "chase", "drew", "wade",
  "frank", "rich", "young", "brown", "white", "green", "king", "price",
  "support", "sales", "billing", "admin", "team", "office", "info", "growth",
]);

/* The people this agency actually has. Hard-coded ON PURPOSE, as a backstop for
 * the shapes the general rule cannot see: "CJ to send the login", "waiting on
 * Andrew to send the token", "Owner: CJ". Those name a person without a modal
 * verb anywhere, so nothing structural catches them. Add a name here when
 * somebody joins; the general rule above already covers most cases either way. */
const TEAM = "CJ|Andrew|Ryder";

/**
 * Text with every quotation taken out.
 *
 * WHY. The report is allowed to SHOW you what a task note says — including a
 * note somebody wrote as "Dana needs to send the login". What it may not do is
 * say that in its own voice. The first version exempted any phrase that
 * appeared anywhere in the fact sheet, which a reviewer immediately turned
 * inside out: one task note containing "CJ needs to" unlocked that sentence
 * everywhere in the report, unattributed, in the model's own words.
 *
 * A quotation is a quotation because it is in quotation marks. So the checks
 * run on everything OUTSIDE the quotes, and the prompt tells the model to put
 * quoted note text inside “ ”. The counted report does the same.
 */
export function withoutQuotes(text, factsText = "") {
  /* A QUOTATION IS ONLY A QUOTATION IF WE CAN FIND IT IN THE RECORDS.
   *
   * Two versions of this were wrong in opposite directions:
   *
   *   v1 exempted any phrase that appeared ANYWHERE in the fact sheet, so one
   *      task note containing "CJ needs to" unlocked that sentence for the
   *      whole report, unattributed, in the model's own voice.
   *   v2 exempted anything between quote marks — and the model writes the quote
   *      marks. `Our note says “CJ needs to get the login and we are on track”`
   *      passed every check, against a client with no notes at all.
   *
   * So a quoted span is removed only when its words really do appear in the
   * facts. An invented quotation is left in and checked like any other
   * sentence, which is what it is. An unbalanced quote mark leaves its span
   * unmatched — also checked, rather than swallowing the honest text after it.
   */
  const facts = normalizeQuoted(String(factsText || ""));
  const src = String(text || "");
  return src.replace(/[“][^”]*[”]|[‘][^’]*[’]|"[^"\n]*"/g, (span) => {
    const inner = normalizeQuoted(span.slice(1, -1));
    if (inner.length < 8) return span;              // too short to be a real quotation
    return facts.includes(inner) ? " " : span;
  });
}

/** Loose enough that a quotation still matches after the report re-punctuates
 * it: one kind of space, one kind of quote, no trailing full stop. */
function normalizeQuoted(text) {
  return String(text)
    .replace(/[“”‘’]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/g, "")
    .trim()
    .toLowerCase();
}

export function assignsWork(text, { clientName = "", teamNames = [] } = {}) {
  const src = String(text || "");
  const hits = [];

  /* Words that are part of the client's own name are not people. "Harbor Injury
   * Law needs to return the signed agreement" is a fact about a company. */
  const clientWords = new Set(
    String(clientName).toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean)
  );

  /* A person-looking token straight before a modal. Handles "CJ", "Priya",
   * "Andrew Soncini" and "Mr Smith". */
  /* "must be", "should be", "needs to be" — a passive. "Schema must be added to
   * the remaining pages" is a fact about a website; "CJ must add the schema" is
   * a job for a person. Only the second is what this rule is for, and a stop
   * list of English nouns was never going to separate them. */
  const re = new RegExp(`\\b((?:[A-Z]{2,}|[A-Z][a-z]+)(?:\\s+[A-Z][a-z]+)?)\\s+(?:${MODALS})\\s+(?!be\\b|been\\b|being\\b|come\\b|clear\\b|happen\\b|finish\\b|go\\b|land\\b|arrive\\b|follow\\b)`, "g");
  let m;
  while ((m = re.exec(src))) {
    const words = m[1].split(/\s+/).map((w) => w.toLowerCase());
    if (words.some((w) => NOT_A_PERSON.has(w))) continue;
    if (words.some((w) => clientWords.has(w))) continue;
    hits.push(m[0]);
  }

  /* The other shapes, where the person is not in front of a modal verb. Every
   * one of these was found slipping through: they are exactly what a model
   * reaches for once it has been told not to write "X needs to". */
  const OTHERS = [
    // "Someone needs to…", "Someone from our side must…", "whoever is on call must…"
    /\b(?:some(?:one|body)|whoever)\b[^.!?\n]{0,40}?\b(?:needs to|need to|should|must|has to|will)\b/i,
    /* A job handed to a ROLE rather than a name. "Our developer must open the
     * port" is the same instruction as "Andrew must open the port" — the roster
     * cannot see it, because there is no name in it. */
    /\b(?:our|the)\s+(?:developer|designer|account manager|project manager|copywriter|dev|engineer|analyst|contractor|assistant|team|delivery side|sales side)\s+(?:needs to|need to|should|must|has to|will need to)\s+(?!be\b|been\b|being\b)/i,
    /\b(?:needs|need) (?:someone|somebody)\b/i,
    /\b(?:assigned to|action for|over to|down to|owned by|responsibility of)\s+[A-Z]/,
    /\b[A-Z][A-Za-z]*(?:'s|’s) (?:to do|action|job|task|call|to-do)\b/,
    // The team, by name, in any casing — including the shapes with no modal.
    new RegExp(`\\b(?:${TEAM})\\s+(?:${MODALS})\\b`, "i"),
    new RegExp(`\\b(?:${TEAM})\\s+to\\s+[a-z]+`, "i"),
    new RegExp(`\\b(?:${TEAM})\\s+will\\s+[a-z]+`, "i"),
    new RegExp(`\\b(?:waiting on|ask|chase|check with|over to)\\s+(?:${TEAM})\\b`, "i"),
    new RegExp(`\\b(?:${TEAM})\\s+is\\s+responsible\\b`, "i"),
    new RegExp(`\\bowner:\\s*(?:${TEAM})\\b`, "i"),
    new RegExp(`\\b(?:${TEAM})\\s*[—–-]\\s*[a-z]+`, "i"),
  ];
  for (const r of OTHERS) {
    const hit = src.match(r);
    if (hit) hits.push(hit[0]);
  }

  /* The people we actually have, handed in by the caller from the team roster.
   * Hard-coding three names could only ever catch three people: a contractor, a
   * new hire, or "Priya must send the invoice" walked straight through.
   *
   * Each name is registered whole AND as its parts, because that is how people
   * write about each other. "Priya Patel" on the roster has to catch "Priya",
   * and "Andrew Page must send the token" has to be caught by "Andrew" — the
   * general rule below skips it, because "page" is one of the ordinary nouns
   * that stops "Google Business Profile should be verified" being read as a
   * person. Parts shorter than three letters, and parts that are ordinary
   * words, are left out. */
  const nameTokens = new Set();
  for (const name of teamNames) {
    const whole = String(name || "").trim();
    /* EVERY token is filtered, the whole name included. A roster row reading
     * "Support" — a shared account, or somebody who typed a job title into the
     * name box — turned "The support ticket points to schema gaps" into a
     * rejected report for every client. And "Will", "Bill", "Grant", "Mark",
     * "May" are all real first names AND ordinary words. */
    /* Two letters is enough when they are initials — "CJ" is how one of the
     * owners is written everywhere, and a three-letter floor dropped him. */
    const usable = (t) => (t.length >= 3 || /^[A-Z]{2}$/.test(t))
      && !NOT_A_PERSON.has(t.toLowerCase())
      && !COMMON_WORD_NAMES.has(t.toLowerCase());
    if (whole.split(/\s+/).length > 1 && whole.length >= 3) nameTokens.add(whole);
    for (const part of whole.split(/\s+/)) {
      if (usable(part)) nameTokens.add(part);
    }
  }

  for (const name of nameTokens) {
    const clean = String(name || "").trim();
    if (clean.length < 2) continue;
    const esc = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    /* The name has to be RIGHT BEFORE the thing that makes it an instruction.
     * A 40-character window with "to <verb>" in it matched almost any sentence
     * that happened to mention a colleague — "The audit Ryder ran in June
     * pointed to schema gaps" came out as a job for Ryder. */
    /* One optional capitalised word may sit between the name and the verb —
     * that is a surname the roster did not have ("Andrew Page must send the
     * token"). More than one and it is a sentence, not an instruction. */
    const re = new RegExp(
      `\\b${esc}\\b(?:\\s+[A-Z][a-z]+)?\\s+(?:${MODALS}|to\\s+[a-z]+|will\\s+[a-z]+|owns\\b|is\\s+(?:on|chasing|handling|responsible|picking))`,
      "i"
    );
    const hit = src.match(re);
    if (hit) hits.push(hit[0]);
    /* The shapes with no verb at all: "Owner: Priya", "sits with Priya",
     * "Next: Priya — chase the invoice". */
    /* The shapes with no verb: "Owner: Priya", "sits with Priya", "this one is
     * on CJ", "it falls to Priya". A bare "with" is NOT in this list — "the
     * call with Andrew went over the weekly log" is a fact about a meeting. */
    const owner = src.match(new RegExp(
      `\\b(?:owner|owned by|assigned to|sits with|handed to|handing[^.!?\\n]{0,20}to|over to|down to|falls to|waiting on|is on|ask|chase|next)\\s*[:—–-]?\\s*${esc}\\b`,
      "i"
    ));
    if (owner) hits.push(owner[0]);
    // Vocative: "Priya, please chase the invoice."
    const vocative = src.match(new RegExp(`\\b${esc}\\s*,\\s*(?:please|can you|could you)\\b`, "i"));
    if (vocative) hits.push(vocative[0]);
    const dash = src.match(new RegExp(`\\b${esc}\\s*[—–-]\\s*[a-z]`, "i"));
    if (dash) hits.push(dash[0]);
  }

  return [...new Set(hits)];
}

/**
 * Throw the draft away if it broke a rule. { ok } or { ok:false, why }.
 *
 * Three classes, all cheap to check and all the kind that would otherwise get
 * read as true because the rest of the report is true:
 *   1. a number that is nowhere in the facts,
 *   2. wording that promises a result,
 *   3. a line that gives somebody a job.
 */
/* Dates are checked WHOLE, then taken out before the loose numbers are checked.
 * Two reasons, both learned from the tests:
 *   · "2026-08-21" splits into 2026 / 08 / 21, and "21" on its own is almost
 *     never in the facts — so an honest date read as three invented numbers.
 *   · a whole date is the thing worth checking anyway. "Due 2026-09-30" when no
 *     such date exists in the records is exactly the kind of confident wrong
 *     answer this check is for. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

/* Numbers, read as WHOLE numbers rather than as runs of digits.
 *
 * The shared unbackedNumbers() in client-standing.js splits on \d+, so
 * "$3,750.00" quietly adds 3, 750 and 00 to the set of numbers a report is
 * allowed to state. A reviewer used that to get "We published 750 new pages"
 * past the check against a client whose only fact was one $3,750.00 invoice.
 *
 * This version keeps commas and decimal points together, then normalises, so
 * $3,750.00 backs "3750" and "3750.00" and nothing else. */
function numberTokens(text) {
  const out = new Set();
  for (const raw of String(text).match(/\d[\d,]*(?:\.\d+)?/g) || []) {
    const clean = raw.replace(/,/g, "");
    out.add(clean);
    /* "3,750.00" also backs "3750", because the pennies are noise there. But
     * "3,750.50" must NOT back "3750" — that is a report rounding a real figure
     * down and stating the result as if we had counted it. */
    if (/\.0+$/.test(clean)) out.add(clean.replace(/\.0+$/, ""));
  }
  return out;
}

/* Numbers written as words, and dates written the way a person says them.
 *
 * The digit check only ever saw digits, so "Twelve pages shipped" and "finished
 * by September 30" both walked past it against facts that contained neither.
 * Both are turned into the form the facts use and checked the same way.
 *
 * The month names are mapped BOTH ways: every ISO date in the facts also backs
 * its own prose form, so a report is free to write "due 30 September" about a
 * date we really do hold, and only an invented one is caught. */
/* "two" and "three" are deliberately absent. They turn up in ordinary prose
 * far more often than they turn up as a claim ("one or two of the pages"), and
 * a wrongly rejected honest report costs more than a mis-stated 2. From four
 * upwards a spelled-out number is nearly always a count. */
const WORD_NUMBERS = {
  four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80,
  ninety: 90, hundred: 100, thousand: 1000,
};

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** "2026-09-30" → the prose forms a person might write it as. */
function proseFormsOfIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return [];
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return [];
  const day = String(Number(m[3]));
  const short = month.slice(0, 3);
  return [
    `${month} ${day}`, `${short} ${day}`,
    `${day} ${month}`, `${day} ${short}`,
  ];
}

/** Prose dates in the report that no date in the facts can account for. */
export function unbackedProseDates(text, factsText) {
  const backed = new Set();
  for (const iso of String(factsText).match(ISO_DATE) || []) {
    for (const form of proseFormsOfIsoDate(iso)) backed.add(form);
  }
  const low = String(text).toLowerCase();
  const bad = [];
  const re = new RegExp(`\\b(?:(${MONTHS.join("|")})\\s+(\\d{1,2})|(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join("|")}))\\b`, "g");
  let m;
  while ((m = re.exec(low))) {
    const month = m[1] || m[4];
    const day = String(Number(m[2] || m[3]));
    if (backed.has(`${month} ${day}`) || backed.has(`${day} ${month}`)) continue;
    bad.push(m[0]);
  }
  return [...new Set(bad)];
}

/** Numbers spelled out as words whose digits are nowhere in the facts. */
export function unbackedWordNumbers(text, factsText) {
  const backed = numberTokens(factsText);
  const low = String(text).toLowerCase();
  const bad = [];
  for (const [word, value] of Object.entries(WORD_NUMBERS)) {
    if (!new RegExp(`\\b${word}\\b`).test(low)) continue;
    if (backed.has(String(value))) continue;
    bad.push(word);
  }
  return [...new Set(bad)];
}

export function unbackedNumbersStrict(text, factsText) {
  const backed = numberTokens(factsText);
  const bad = [];
  for (const raw of String(text).match(/\d[\d,]*(?:\.\d+)?/g) || []) {
    const clean = raw.replace(/,/g, "").replace(/\.0+$/, "");
    if (backed.has(clean)) continue;
    const n = Number(clean);
    if (Number.isFinite(n)) {
      if (n <= 1) continue;                                   // "1 of", "0"
      if (clean.length === 4 && n >= 2000 && n <= 2100) continue;  // a year
    }
    bad.push(raw);
  }
  return [...new Set(bad)];
}

/* Words that turn a record into a sales claim, on top of the shared list in
 * client-standing.js. Every one of these was found passing the old check. */
const SOFT_PROMISES = [
  "on track", "we expect", "expected to", "should be finished", "should be done",
  "should be live", "will be finished", "will be done", "shortly", "any day now",
  "in good shape", "looking good", "ahead of schedule", "nearly there", "almost there",
];

/* Estimates. The instruction says "never estimate" and these are how an
 * estimate gets past a check that only looks at digits. Each one says an amount
 * without saying which amount, which is the whole problem: a reader takes
 * "most of the pages are done" as a measurement, and it is not one. */
/* When something is promised for. Our records hold dates, not intentions, so a
 * report cannot know that anything will land next Friday. */
const VAGUE_WHENS = [
  "next friday", "next monday", "next tuesday", "next wednesday", "next thursday",
  "next week", "next month", "later this week", "later this month", "in a few days",
  "in the next few", "by the end of the week", "by the end of the month", "before long",
];

const VAGUE_AMOUNTS = [
  "roughly", "approximately", "give or take", "more or less", "a dozen",
  "a handful", "a couple of", "several", "half the", "half of", "most of the",
  "the majority of", "doubled", "tripled", "a few of", "many of the",
];

/**
 * Throw the draft away if it broke a rule.
 *
 * `quotedFrom` is the facts text: a phrase copied word for word out of our own
 * records is the report showing you a record, not the report making a claim.
 * `clientName` stops a company name being read as a person.
 */
export function checkReport(report, factsText, { clientName = "", teamNames = [] } = {}) {
  /* THE TITLE is checked separately and gently. It carries the name of the
   * button that made it — "30-second version" — and folding the preset labels
   * into the fact pool to allow that whitelisted the number 30 for the whole
   * report, so "We shipped 30 new pages" sailed through. The label is removed
   * from the title instead; the pool is untouched. */
  const titleForCheck = REPORT_PRESETS.reduce(
    (t, p) => t.split(p.label).join(" "),
    String(report.title || "")
  );
  const all = [titleForCheck, report.summary || "", report.body || "", report.watch || ""].join("\n");
  /* The checks about VOICE — promises, and handing somebody a job — run on the
   * text outside any quotation marks. Quoting a note is showing you a record;
   * saying the same thing unquoted is making the claim. */
  const spoken = withoutQuotes(all, factsText);
  const facts = String(factsText || "");

  const dates = all.match(ISO_DATE) || [];
  const badDates = [...new Set(dates.filter((d) => !facts.includes(d)))];
  if (badDates.length) return { ok: false, why: `dates not in the facts: ${badDates.join(", ")}` };

  const proseDates = unbackedProseDates(spoken, facts);
  if (proseDates.length) return { ok: false, why: `dates not in the facts: ${proseDates.join(", ")}` };

  /* The EARLIER REPORTS block quotes what previous reports said, and what
   * somebody typed into the "how deep" box. Those are not counted facts, so
   * they must not back a number: type "cover the 42 landing pages" today and
   * tomorrow's report could assert 42 as though we had measured it. The prompt
   * bans carrying a number over from an earlier report; the check has to agree.
   */
  const factsForNumbers = facts
    .replace(/EARLIER REPORTS ABOUT THIS CLIENT[\s\S]*?(?=\n\n[A-Z]|$)/, " ")
    /* The time of day in "COUNTS TAKEN AT: 2026-08-21T12:00:00Z" is not a fact
     * about the client, and it was backing 12, 0 and 21 for the whole report —
     * which is how "Twelve pages shipped" got through. The DATE stays; only the
     * clock goes. */
    .replace(/T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?/g, " ");
  const numbers = unbackedNumbersStrict(all.replace(ISO_DATE, " "), factsForNumbers);
  if (numbers.length) return { ok: false, why: `numbers not in the facts: ${numbers.join(", ")}` };

  /* On `spoken`, like the prose dates — a number written as a word inside a
   * quotation we can verify is that note's word, not the report's claim. The
   * two used to disagree, so quoting rescued "September 30" and not "twelve"
   * in the same sentence. */
  const words = unbackedWordNumbers(spoken, factsForNumbers);
  if (words.length) return { ok: false, why: `numbers written as words that are not in the facts: ${words.join(", ")}` };

  const low = spoken.toLowerCase();
  const promises = [
    ...promiseWordsIn(spoken),
    ...SOFT_PROMISES.filter((w) => low.includes(w)),
  ];
  if (promises.length) return { ok: false, why: `promise wording: ${[...new Set(promises)].join(", ")}` };

  const vague = VAGUE_AMOUNTS.filter((w) => low.includes(w));
  if (vague.length) return { ok: false, why: `an amount stated without a number: ${vague.join(", ")}` };

  const whens = VAGUE_WHENS.filter((w) => low.includes(w));
  if (whens.length) return { ok: false, why: `a date we do not hold, said loosely: ${whens.join(", ")}` };

  /* "due by the 30th" — an ordinal on its own. Backed only when that day really
   * is a day in one of our dates; otherwise it is a date the report invented,
   * wearing a form neither the ISO nor the month-name check can see. */
  const ordinals = [...spoken.matchAll(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/gi)].map((mt) => mt[1]);
  const heldDays = new Set((facts.match(ISO_DATE) || []).map((d) => String(Number(d.slice(8, 10)))));
  const badOrdinals = [...new Set(ordinals.filter((d) => !heldDays.has(String(Number(d)))))];
  if (badOrdinals.length) {
    const ordinal = (n) => {
      const v = Number(n);
      const suffix = (v % 100 >= 11 && v % 100 <= 13) ? "th"
        : ({ 1: "st", 2: "nd", 3: "rd" }[v % 10] || "th");
      return `the ${v}${suffix}`;
    };
    return { ok: false, why: `a day of the month that is not in any date we hold: ${badOrdinals.map(ordinal).join(", ")}` };
  }

  /* 30/09/2026 was checked as three loose numbers and passed whenever its parts
   * happened to be backed. Our records never write a date with slashes, so any
   * slash date in a report is one the model composed. */
  const slashDates = spoken.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || [];
  if (slashDates.length) {
    return { ok: false, why: `a date written in a form our records never use: ${[...new Set(slashDates)].join(", ")}` };
  }

  const jobs = assignsWork(spoken, { clientName, teamNames });
  if (jobs.length) return { ok: false, why: `it hands work to a person: "${jobs.join('", "')}"` };

  /* One answer, so one emptiness check. It used to demand a summary AND a body
   * and would have thrown away every answer written under the Aug 23 2026
   * one-response shape, where the whole thing is the body. */
  if (!String(report.body || "").trim() && !String(report.summary || "").trim()) {
    return { ok: false, why: "the answer came back empty" };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* The no-AI version — counted, not written                            */
/* ------------------------------------------------------------------ */

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

/**
 * Built straight from the facts with no model involved. This is what gets saved
 * before anybody sets an AI key, and what gets saved when the AI's draft fails
 * the check. It is deliberately dull: it states counts and names and nothing
 * else. Dull and true beats readable and wrong.
 */
export function deterministicReport(facts, { presetId = DEFAULT_PRESET, todayIso } = {}) {
  const c = facts.counts;
  const cl = facts.client;
  const m = facts.money;
  const preset = presetById(presetId);
  const short = preset.id === "quick";

  /* ---- the 30-second version ---- */
  const summary = [];
  summary.push(`- Finished: ${c.tasksDone} of ${c.tasksTotal} tasks. Still open: ${c.tasksOpen}${c.tasksBlocked ? `, of which ${c.tasksBlocked} cannot move until something outside our control exists` : ""}.`);
  if (c.tasksLate) summary.push(`- ${plural(c.tasksLate, "task is", "tasks are")} past the date we set.`);
  if (c.sites) summary.push(`- ${c.sitesLive} of ${c.sites} websites on file are live.`);
  if (c.weeksTotal) summary.push(`- ${c.weeksLogged} of ${c.weeksTotal} weeks are written up in the weekly log.`);
  else summary.push("- No weekly log has been written for this client yet.");
  if (c.emailsNeedingReply) summary.push(`- ${plural(c.emailsNeedingReply, "email is", "emails are")} waiting on a reply from us.`);
  if (m.invoices) summary.push(`- ${centsToText(m.owedCents)} is still owed${m.overdueCount ? `, and ${plural(m.overdueCount, "invoice is", "invoices are")} past the due date` : ""}.`);
  /* The client's own Google clicks, if we have them.
   *
   * IT SAYS WHERE THE NUMBER CAME FROM, including when a person typed it in.
   * The first version said "shows ... clicks" whatever the source, so a
   * hand-typed figure was asserted in the summary as a reading — and the
   * summary is the part that gets pasted into an email. The body section had
   * it right and the summary did not, which is the worst of both. */
  const gsc = (facts.measured || []).find((x) => x.provider === "gsc");
  if (gsc && gsc.metrics?.clicks !== null && gsc.metrics?.clicks !== undefined) {
    summary.push(
      gsc.source === "manual"
        ? `- Their own Google Search Console showed ${formatMetric("clicks", gsc.metrics.clicks)} clicks from Google search between ${gsc.period_start} and ${gsc.period_end}, as typed in by one of us from their screen — not read by this console.`
        : `- Their own Google Search Console shows ${formatMetric("clicks", gsc.metrics.clicks)} clicks from Google search between ${gsc.period_start} and ${gsc.period_end}. That is their number, not ours.`
    );
  }

  /* ---- the full version ---- */
  /* The client's own number goes to the TOP of the short version. It was
   * built last because it needs `facts.measured`, and it was left last, which
   * made the code disagree with its own comment — a reviewer caught it. What
   * a client reads first should be what happened to them, not our task count. */
  if (summary.length && /Google Search Console/.test(summary[summary.length - 1])) {
    summary.unshift(summary.pop());
  }

  const b = [];
  b.push(`## Where they stand`);
  b.push(`${cl.name}${cl.domain ? ` (${cl.domain})` : ""} is at stage "${cl.stage || "not set"}" and marked ${cl.status || "not set"}${cl.startDate ? `, started with us on ${cl.startDate}` : ""}.`);
  /* This sentence used to say "everything below" without exception, which
   * stopped being true the moment a client's own Search Console numbers could
   * appear further down. A blanket claim that is wrong about one section is
   * worse than no claim, so it names the exception when there is one. */
  b.push(
    (facts.measured || []).length
      ? `Everything below is counted from this console's own records${teamDayOf(facts.takenAt) ? ` on ${teamDayOf(facts.takenAt)}` : ""}, EXCEPT the section headed "What their own accounts show" — those numbers are the client's own, read out of their accounts on the dates printed beside them. Nothing here is a scan result or a ranking.`
      : `Everything below is counted from this console's own records${teamDayOf(facts.takenAt) ? ` on ${teamDayOf(facts.takenAt)}` : ""}. Nothing here is a scan result or a ranking.`
  );

  b.push(`## Finished`);
  if (facts.done.length) {
    for (const t of facts.done.slice(0, short ? 4 : 25)) {
      b.push(`- “${t.name}”${t.on ? ` (${t.on})` : ""}${t.report ? ` — the task note says “${t.report}”` : ""}`);
    }
  } else {
    b.push("- Nothing is recorded as finished for this client yet.");
  }

  b.push(`## Still open`);
  if (facts.open.length) {
    for (const t of facts.open.slice(0, short ? 4 : 25)) {
      b.push(`- “${t.name}” (${t.status}${t.due ? `, due ${t.due}${t.late ? " — past that date" : ""}` : ", no date set"})${t.report ? ` — the task note says “${t.report}”` : ""}`);
    }
  } else {
    b.push("- Nothing is open.");
  }

  if (facts.blocked.length) {
    b.push(`## Blocked`);
    b.push("These cannot move until something outside our control exists.");
    for (const t of facts.blocked) b.push(`- “${t.name}”${t.why ? ` — the task note says “${t.why}”` : " — no reason written down."}`);
  }

  /* The client's own numbers get their own section, above money, because they
   * are what the client actually asks about. Every line names the account and
   * both dates — the counted report holds itself to the same rule the AI one
   * is given. */
  const measured = facts.measured || [];
  if (measured.length) {
    b.push(`## What their own accounts show`);
    b.push("These numbers are the client's own, read out of their accounts on the dates given. They are not something this console counted.");
    for (const snap of measured) {
      const how = snap.source === "manual" ? "typed in by one of us" : "read by this console";
      b.push(`- ${PROVIDER_LABELS[snap.provider] || snap.provider}${snap.property ? ` (${prettyProperty(snap.provider, snap.property)})` : ""}, ${snap.period_start} to ${snap.period_end}, ${how} on ${String(snap.taken_at || "").slice(0, 10)}: ${
        (PROVIDER_METRICS[snap.provider] || [])
          .filter((k) => snap.metrics?.[k] !== null && snap.metrics?.[k] !== undefined)
          .map((k) => `${formatMetric(k, snap.metrics[k])} ${METRIC_LABELS[k] || k}`)
          .join(", ") || "no numbers came back for that window"
      }.`);
    }
  }

  b.push(`## Money`);
  if (!m.invoices) {
    b.push("- No invoices exist for this client in the console.");
  } else {
    b.push(`- ${plural(m.invoices, "invoice", "invoices")}: ${centsToText(m.billedCents)} billed, ${centsToText(m.paidCents)} paid, ${centsToText(m.owedCents)} still owed.`);
    if (m.overdueCount) b.push(`- ${plural(m.overdueCount, "invoice is", "invoices are")} past the due date, worth ${centsToText(m.overdueCents)}.`);
    if (m.lastPaidOn) b.push(`- Last payment recorded on ${m.lastPaidOn}.`);
  }

  if (!short) {
    b.push(`## Email and follow-ups`);
    if (!c.emails) {
      b.push("- No email threads are linked to this client.");
    } else {
      b.push(`- ${c.emails} threads: ${c.emailsNeedingReply} need a reply from us, ${c.emailsWaitingOnThem} are waiting on them, ${c.emailsScheduled} are scheduled to chase.`);
      for (const e of facts.emailsOpen.slice(0, 8)) b.push(`- “${e.subject}” (${e.status}${e.lastAt ? `, last message ${e.lastAt}` : ""})`);
    }
    if (c.followUpsOpen) b.push(`- ${plural(c.followUpsOpen, "follow-up is", "follow-ups are")} still open.`);

    b.push(`## Websites`);
    if (!facts.sites.length) {
      b.push("- No websites are on file for this client.");
    } else {
      for (const s of facts.sites) {
        b.push(`- ${SITE_KIND_LABELS[s.kind] || s.kind}: “${s.label}” — ${prettyUrl(s.url)}${s.live ? "" : " (built, not live yet)"}`);
      }
    }

    if (facts.weeks.length) {
      b.push(`## Weekly log, newest first`);
      for (const w of facts.weeks) {
        b.push(`- Week ${w.week} (${String(w.status).replace(/_/g, " ")}): did — “${w.did || "not written"}”. Moved — “${w.moved || "not written"}”. Next — “${w.next || "not written"}”.`);
      }
    }

    if (facts.tickets.open) {
      b.push(`## Support tickets`);
      for (const t of facts.tickets.list) b.push(`- “${t.subject}” (${t.status}, ${t.priority}${t.on ? `, opened ${t.on}` : ""})`);
    }

    if (facts.teamNotes.length) {
      b.push(`## Notes our team wrote`);
      b.push("These are our own words from the Notes page, not something we measured.");
      for (const n of facts.teamNotes.slice(0, 6)) {
        b.push(`- ${n.on ? `${n.on}: ` : ""}${n.title ? `${n.title} — ` : ""}“${n.body.replace(/\n+/g, " ").replace(/[“”]/g, "'").slice(0, 220)}”`);
      }
    }

    b.push(`## Access we hold`);
    b.push(`- ${facts.access.platformAccountsActive} platform logins active, of ${facts.access.platformAccounts} saved. ${facts.access.vaultItems} items in the vault. No detail about any of them is in this report on purpose.`);
  }

  /* ---- what could not be checked ---- */
  const cannot = missingFrom(facts).map((g) => `- ${g}`).join("\n");

  const title = `${cl.name} — ${preset.label.toLowerCase()}${todayIso ? `, ${todayIso}` : ""}`;

  /* ONE document, counted. The short lines lead it and the detail follows in
   * the same scroll — not a separate "30-second version" a reader has to switch
   * tabs to see. */
  return {
    title,
    summary: "",
    body: [summary.length ? `## In short\n${summary.join("\n")}` : "", b.join("\n\n")]
      .filter(Boolean).join("\n\n"),
    watch: null,
    cannotCheck: cannot,
  };
}

/** One line for the top of every report, whichever way it was written. It names
 * the one source and the moment, so nobody has to guess how fresh it is. */
export function provenanceLine(facts, source) {
  const when = facts.takenAt ? facts.takenAt.slice(0, 16).replace("T", " ") + " UTC" : "an unrecorded time";
  return source === "written"
    ? `Counted from the AI Syndicate console's own records at ${when}. The AI worded it from those counts and was shown nothing else.`
    : `Counted from the AI Syndicate console's own records at ${when}. Written by plain code straight from those counts — no AI involved.`;
}

/** The whole thing as one markdown file, for Copy and for Download. */
export function reportToMarkdown(report, { clientName, facts, source, instruction }) {
  const parts = [];
  parts.push(`# ${report.title || `${clientName} — report`}`);
  parts.push(`*${provenanceLine(facts, source)}*`);
  if (instruction) parts.push(`*Asked for: "${instruction}"*`);
  /* One document. Older rows still carry a summary and a watch section, so they
   * are printed when they exist — for anything written after Aug 23 2026 the
   * body is the whole answer. */
  if (String(report.summary || "").trim()) parts.push(`## In short`, report.summary);
  parts.push(report.body || "");
  if (report.watch) {
    parts.push(`## Worth a second look`);
    parts.push(report.watch);
  }
  parts.push(`## What these records cannot answer`);
  parts.push(report.cannotCheck || missingFrom(facts).map((g) => `- ${g}`).join("\n"));
  return parts.join("\n\n");
}
