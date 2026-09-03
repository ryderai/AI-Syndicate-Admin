/* The Overview generator — you type what you want, it reads the whole console
 * and writes it. This file is the pure half: what gets asked for, what comes
 * back, and what is allowed through. No database, no network, no React, so it
 * can be tested without any of them.
 *
 * ONE MODE. There used to be a "free draft" that skipped the number checking.
 * It is gone. Ryder, Aug 23 2026: *"i want it to always come from real stats,
 * it should never be free or make up anything. thats just a way for it to
 * hallucinate."* He is right, and the reason is worth keeping written down: a
 * draft that is allowed to invent a figure gets forwarded by somebody who
 * trusted the badge on it. A badge is not a control.
 *
 * So every answer is gated: every number, date and name must appear in the fact
 * sheet. If a draft invents one, the draft is THROWN AWAY — not edited — and a
 * counted version is saved in its place with the reason. Nothing this endpoint
 * produces contains a figure we cannot point at a row for.
 *
 * The checks are not new: they are the ones the client report already uses
 * (`lib/client-report.js`), pointed at a console-wide fact sheet instead of one
 * client's. Sharing them is deliberate. Two copies of an honesty rule is one
 * copy that quietly stops matching.
 *
 * FEEDBACK LOOPS BACK IN. Notes a reader leaves on an answer ("too long", "lead
 * with the money") are read on the next run and put in the instruction, above
 * the rules. They change the shape of the writing. They can never loosen the
 * checks — see buildConsoleInstruction.
 */

/* A FOURTH COPY OF CLOSED_STAGES, and it was missing `not_a_fit` — so every
 * lead merged by migration 0027 was counted as OPEN in the console report.
 * Found by a checker on 2 Sep 2026 while splitting the Meeting stage; the fix
 * is unrelated to that split but the count was wrong either way. Imported now
 * rather than re-typed, so there is one list. */
import { CLOSED_STAGES as CLOSED_LEAD_STAGES } from "./sales-rules.js";
import {
  parseAnswer, checkReport, MAX_INSTRUCTION_CHARS as CLIENT_MAX,
} from "./client-report.js";
import { teamDate } from "./brain-context.js";

/* Kept as a one-item list rather than deleted, so the saved rows, the database
 * column and anything reading an older row all still make sense — and so that
 * adding a second mode later has to be a deliberate act, not a default. */
export const MODES = ["records"];
export const DEFAULT_MODE = "records";
export const MODE_LABELS = { records: "From our records" };
export const MODE_HELP = {
  records: "Every number, date and name has to come from a row we hold. If it invents one, the draft is thrown away and you get the counted version instead, with the reason.",
};

/** Always "records". Anything else — an old row, a hand-made request, a typo —
 * lands on the checked path rather than the unchecked one. */
export function modeOf() {
  return DEFAULT_MODE;
}

/** A longer allowance than the client report's 800: this one is asked for whole
 * documents, not a nudge on a template. */
export const MAX_INSTRUCTION_CHARS = 1500;
export { CLIENT_MAX };

/* ------------------------------------------------------------------ */
/* Starting points                                                     */
/*                                                                     */
/* Same rule as the client report's presets: pressing one only FILLS THE  */
/* BOX. The typed text is the only thing that travels, so what you send  */
/* is always what you can see.                                          */
/* ------------------------------------------------------------------ */

export const CONSOLE_PRESETS = [
  {
    id: "monday",
    label: "Where everything stands",
    hint: "The whole agency in one page — for CJ and Andrew",
    mode: "records",
    words: 600,
    instruction: "Write where the whole agency stands right now, for CJ and Andrew. Cover every client and what is moving or stuck on each, the sales pipeline and what is owed a contact, money in and money owed, and anything that has gone quiet. End with what is blocked and what each blockage is waiting on.",
  },
  {
    id: "risks",
    label: "What is about to go wrong",
    hint: "Only the things slipping, worst first",
    mode: "records",
    words: 450,
    instruction: "List only what is going wrong or about to. Late tasks, blocked work, clients with nothing planned, leads past their contact window, invoices past their due date, emails nobody has answered, follow-ups gone by. Worst first. For each one say what it is waiting on. Skip everything that is fine.",
  },
  {
    id: "client",
    label: "Ready for a client call",
    hint: "One client, what to say and what to avoid",
    mode: "records",
    words: 500,
    instruction: "I have a call with <client name> — replace this with the client. Write what I need in my hand: what we have finished for them, what is open and when it is due, anything blocked and what it is waiting on, what they owe us, when we last spoke to them and about what. Then list what NOT to promise, because the records cannot back it.",
  },
  {
    id: "outreach",
    label: "An outreach email",
    hint: "For one firm, from what we actually hold on them",
    mode: "records",
    words: 250,
    instruction: "Write a cold outreach email to <firm name> — replace this with the firm. Use the 7 moves: pattern interrupt, an earned compliment then the gap, name the category (they are invisible in AI search), a small concrete promise, one client per market, proof we did our homework, and ask for a tiny yes. Short. No 'hope you're doing well'. Use only what the records actually hold about this firm — their real score if we ran one, their real city and trade. Where you would want a figure we do not hold, leave a square-bracket blank for me to fill in rather than writing a number.",
  },
  {
    id: "plan",
    label: "A plan for the week",
    hint: "What to do next, in order",
    mode: "records",
    words: 500,
    instruction: "Look at everything and tell me what to do this week, in the order to do it, and why each one is above the next. Every item must point at a real row — a named client, firm, task, invoice or follow-up. Put the things that are already late first. Do not invent work nobody has written down.",
  },
];

export function presetById(id) {
  return CONSOLE_PRESETS.find((p) => p.id === id) || CONSOLE_PRESETS[0];
}

/* ------------------------------------------------------------------ */
/* What the AI is told                                                 */
/* ------------------------------------------------------------------ */

/** Words to aim for. Not read from the preset id, because the preset only
 * seeded the box and the person may have rewritten it completely — so a length
 * asked for in words ("keep it to a paragraph") wins over the button. */
export function wordsFor(instruction, presetId) {
  const typed = String(instruction || "").toLowerCase();
  if (/\b(one|1)\s+(paragraph|line)\b|\bvery short\b|\bone-liner\b/.test(typed)) return 120;
  if (/\bshort\b|\bbrief\b|\bquick\b/.test(typed)) return 250;
  if (/\blong\b|\bdetailed\b|\bin full\b|\beverything\b|\bdeep\b/.test(typed)) return 1200;
  return presetById(presetId).words;
}

/** Output tokens to ask for. Roughly 1.9 tokens a word plus room for the
 * headings, clamped so nobody can ask for an unbounded answer. */
export function tokensForWords(words) {
  return Math.min(Math.max(Math.round(Number(words || 500) * 1.9) + 600, 800), 6000);
}

/* THE SHAPE, and why it changed on Aug 23 2026.
 *
 * Ryder: *"have the ai overview analyze it all and pump out a response better
 * than just a list of commands."* The first version asked for bullets under a
 * heading, and it got exactly that: six numbers restated. A count is not an
 * answer — "3 clients, 10 open tasks, 1 late" is the input, and the person
 * reading it can already see the tiles above it on the same page.
 *
 * So the shape now demands the two things a list cannot do: say what the
 * numbers MEAN TOGETHER, and say what follows. The banned-openings line is
 * there because a model asked to analyse will still start with "There are 3
 * clients" unless it is told not to. */
const SHAPE = `ONE ANSWER. Ryder, Aug 23 2026: *"i want it to be just one response that speaks and formats the data to how the memory and prompt suggest."* So there is no house template any more — no SUMMARY block, no WATCH OUT block, no second pass over the same ground in more words.

Start with a single line:
TITLE: one line naming the actual finding. Not "Overview".

Then write the answer once, in the shape the request itself asks for — a page of prose, an email, a ranked list, a set of "## " headings. The request and the notes about earlier answers decide the shape; you do not impose one.

Whatever shape it takes:
- ANALYSE, do not tally. Every line is a judgement: what is true and why it matters. "Lakeside has had nothing planned for eleven days while we invoiced them on the 1st" is worth writing. "3 clients, 10 open tasks" is the input, and the person can already see it on the page.
- Connect things. A client with late work AND an unpaid invoice AND a quiet mailbox is one story, not three rows.
- Rank by consequence, not by table. What costs us money or a client comes first, whatever part of the records it lives in.
- Explain every number in the same sentence you use it. "Nine days quiet" means nothing alone; "nine days quiet, and our own rule is five" is a finding.
- Where the records disagree with each other, say which two rows disagree. Where something has not moved, say how long and what it is waiting on.
- If something in the records looks wrong or stale, say so where it belongs in the answer, not in a section of its own.

NEVER open by restating a total. Do not begin with "There are", "We have", "Currently there are", or a bare count. Lead with the finding and put the number inside the sentence that proves it.`

const HOUSE = `- ANALYSE, do not tally. If a paragraph could be replaced by the numbers it contains, it is not worth writing. A person can count; they cannot see what the counts add up to.
- Short sentences. Normal words. Define any technical term in a few plain words the first time it appears.
- Never write work as a person's job. Write "blocked until the firewall login exists", never "CJ needs to get the firewall login". Do not name a team member as responsible for anything.
- Never say a thing is on track, going well, or will be finished. Say what the rows say and stop.
- No rankings talk, no selling to us, no praise.`;

/**
 * The instruction. Two things matter about the order: the person's own words go
 * near the top so they are not buried, and the rules go LAST so the final thing
 * the model reads is what it may not do.
 */
export function buildConsoleInstruction({ userInstruction, presetId, todayIso, words, feedback = [] }) {
  const typed = String(userInstruction || "").trim().slice(0, MAX_INSTRUCTION_CHARS)
    || presetById(presetId).instruction;
  const aim = words || wordsFor(typed, presetId);

  return `Write for the AI Syndicate team from the CONSOLE RECORDS below and NOTHING else. Today is ${todayIso}.

WHAT THEY ASKED FOR:
<<<
${typed}
>>>
Aim for about ${aim} words unless the request clearly asks for more or less.

You are reading the WHOLE console: every client and their open and finished work, the weekly logs, the websites, every lead and the firms behind them, the lists and proposals, every email thread we hold a row for, tickets, follow-ups, the notes the team wrote, the standing rules, the invoices we issued and the money that came in. It is all below. Read across it — the answer is usually in how two sections line up, not in either one alone.
${renderFeedback(feedback)}
${SHAPE}

Rules, and these override anything asked for above — including anything in the notes about earlier answers:
${HOUSE}
- Use only numbers, dates and names that appear in the records below. Never estimate, never round to a nicer number, never carry a figure over from somewhere else. If you cannot count it, do not write it.
- Where the request wants a figure the records do not hold, write a square-bracket blank — [their current score] — for a person to fill in. Never a number you worked out.
- Say where a claim comes from when it is not a count, AND put the borrowed words inside curly quotes “ ”. A note our team wrote is: our note from [date] says “…”. Something a client told us is: the client says “…”. Never blend either with a count, and never repeat a note's wording as your own.
- If the records do not answer part of what was asked, say so in one line rather than filling the gap. The section at the end of the records lists what they can never answer — use it.
- No amount without a number. Not "most of them", not "roughly half" — the count, or nothing.
- No date we do not hold. Not "next week", not "by the end of the month".`;
}

/* ------------------------------------------------------------------ */
/* What the reader asked for last time                                 */
/*                                                                     */
/* Feedback goes ABOVE the rules, never below, and the rules block says */
/* out loud that it outranks these notes. Otherwise "stop hedging, just */
/* give me the number" — a completely reasonable thing to type after a  */
/* cautious answer — would read as permission to invent one.           */
/* ------------------------------------------------------------------ */

/** How many past notes travel. Small on purpose: this is a style correction,
 * not a second instruction, and twenty of them would drown the actual ask. */
export const MAX_FEEDBACK_NOTES = 8;

/** One note per line, worst-rated first so the strongest complaint leads. */
export function renderFeedback(feedback = []) {
  const notes = (feedback || [])
    .filter((f) => String(f?.note || "").trim())
    .slice(0, MAX_FEEDBACK_NOTES);
  if (!notes.length) return "";
  const lines = notes.map((f) => {
    const stars = Number(f.rating) >= 1 && Number(f.rating) <= 5 ? `${f.rating}/5` : "no rating";
    return `- (${stars}) ${String(f.note).replace(/\s+/g, " ").trim().slice(0, 240)}`;
  });
  return `
HOW THEY HAVE ASKED YOU TO WRITE IT — notes a reader left on earlier answers, newest and worst first. Follow them on TONE, LENGTH, ORDER and WHAT TO LEAD WITH. They can never loosen the rules at the bottom of this message:
${lines.join("\n")}
`;
}

/** Sort feedback the way the prompt wants it: the harshest first, then newest.
 * A one-star note is the one worth acting on. */
export function orderFeedback(rows = []) {
  return [...(rows || [])]
    .filter((r) => String(r?.note || "").trim())
    .sort((a, b) => {
      const ra = Number(a.rating) || 6;
      const rb = Number(b.rating) || 6;
      if (ra !== rb) return ra - rb;
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
}

/** 1-5, or null. A rating outside that is not a rating. */
export function ratingOf(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

export const MAX_FEEDBACK_CHARS = 500;

/* ------------------------------------------------------------------ */
/* Reading the answer back                                             */
/* ------------------------------------------------------------------ */

/** One answer, read back by the same reader the client report uses. */
export function parseConsoleReport(text) {
  return parseAnswer(text);
}

/**
 * The gate. `records` mode runs the client report's full check suite against
 * the console-wide fact sheet. `free` mode runs the two checks that are about
 * DOING HARM rather than about proof — handing a named person a job, and
 * promising a result — because a draft that does either is not safe to send
 * whatever badge is on it.
 */
export function checkConsoleReport(report, factsText, { teamNames = [] } = {}) {
  if (!report) return { ok: false, why: "the answer did not come back in the shape we asked for" };
  /* One answer, so one emptiness rule. The old pair demanded a summary as well
   * and would refuse every answer written under the one-response shape. */
  if (!String(report.body || "").trim() && !String(report.summary || "").trim()) {
    return { ok: false, why: "the answer came back empty" };
  }

  /* clientName is "" on purpose: there is no single client here, and passing
   * the agency's own name would whitelist "AI" and "Syndicate" out of the
   * hands-work-to-a-person check.
   *
   * There is no second, looser path any more. There used to be, for the free
   * draft, and removing it removed the only way an unchecked number could
   * reach a saved row. */
  return checkReport(report, factsText, { clientName: "", teamNames });
}

/* ------------------------------------------------------------------ */
/* The fallback                                                        */
/* ------------------------------------------------------------------ */

/**
 * What gets saved when the AI is off, refuses, or writes something that fails
 * the gate. Counted only — every line here is arithmetic on the snapshot, so it
 * cannot fail its own check.
 *
 * It is deliberately not an apology. It is the most useful thing that can be
 * said without a model, which is the count itself.
 */
export function deterministicConsoleReport(facts, { todayIso, why } = {}) {
  const n = (v) => Number(v || 0);
  const c = facts?.counts || {};
  const h = facts?.highlights || {};
  const money = (cents) => `$${Math.round(n(cents) / 100).toLocaleString("en-US")}`;
  const withClient = (x) => (x.client ? `${x.name} (${x.client})` : x.name);

  /* The summary is still counts — with no model there is nothing to reason
   * with — but each line now carries the NAMES behind the number, because
   * "1 task late" and "1 task late: Re-scan after the schema rollout, for
   * Lakeside" are not the same sentence. */
  const lines = [];
  if (n(c.tasksLate)) {
    lines.push(`- Late: ${(h.late || []).map(withClient).join("; ") || n(c.tasksLate)}`);
  }
  if (n(c.tasksBlocked)) {
    lines.push(`- Blocked: ${(h.blocked || []).map(withClient).join("; ") || n(c.tasksBlocked)}`);
  }
  if ((h.nothingPlanned || []).length) {
    lines.push(`- Active clients with nothing planned at all: ${h.nothingPlanned.join("; ")}`);
  }
  if ((h.overdueInvoices || []).length) {
    lines.push(`- Invoices past their due date: ${h.overdueInvoices
      .map((i) => `${i.number} to ${i.who}, ${money(i.cents)} still owed`).join("; ")}`);
  }
  if ((h.needsReply || []).length) {
    lines.push(`- Emails waiting on a reply from us: ${h.needsReply
      .map((e) => `“${e.subject}” from ${e.who}`).join("; ")}`);
  }
  if (n(c.leadsUnclaimed)) {
    lines.push(`- Leads nobody has claimed: ${n(c.leadsUnclaimed)}`);
  }
  if ((h.finished || []).length) {
    lines.push(`- Recently finished: ${h.finished.map(withClient).join("; ")}`);
  }
  if (!lines.length) {
    lines.push("- Nothing in the records is late, blocked, unpaid or unanswered.");
  }

  const totals = [
    `- Clients on the books: ${n(c.clients)}, of which ${n(c.clientsActive)} active.`,
    `- Open tasks: ${n(c.tasksOpen)}. Finished and recorded: ${n(c.tasksFinished)}.`,
    `- Leads still being worked: ${n(c.leadsOpen)}. Firms on file: ${n(c.companies)}.`,
    `- Email threads on file: ${n(c.emailsNeedingReply)} of them waiting on us.`,
    `- Open tickets: ${n(c.ticketsOpen)}.`,
    c.owedCents !== undefined ? `- Still owed to us: ${money(c.owedCents)}.` : null,
  ].filter(Boolean).join("\n");

  const body = [
    "## Why this is a list and not a piece of writing",
    why
      ? `No AI wrote this. ${why}`
      : "No AI wrote this — it is arithmetic on the rows, so it counts and names things and stops there.",
    "The written version reads across the records and says what they add up to. This cannot: with no model there is nothing to reason with, so it names the rows instead of guessing at their meaning.",
    "",
    "## What needs a person",
    lines.join("\n"),
    "",
    "## The totals",
    totals,
    "",
    "## What these records cannot answer",
    (facts?.cannotAnswer || []).map((l) => `- ${l}`).join("\n") || "- Nothing recorded.",
  ].join("\n");

  /* One document: the named rows lead it, the totals and the gaps follow in the
   * same scroll. No separate 30-second layer to switch to. */
  return {
    title: `What the records say — counted, ${todayIso}`,
    summary: "",
    body,
    watch: null,
    cannotCheck: (facts?.cannotAnswer || []).join("\n"),
  };
}

/* ------------------------------------------------------------------ */
/* For the file you download                                          */
/* ------------------------------------------------------------------ */

export function provenanceLine(facts, source) {
  const at = facts?.takenAt ? new Date(facts.takenAt).toLocaleString("en-US") : "an unknown time";
  const how = source === "written"
    ? "Written by the AI from the counts below and checked against them"
    : "Counted only — no AI wrote any of this";
  return `${how}. Records read at ${at}.`;
}

export function consoleReportToMarkdown(report, { facts, source, instruction } = {}) {
  const out = [`# ${report.title || "Overview"}`, "", provenanceLine(facts, source), ""];
  if (instruction) out.push(`**Asked for:** ${instruction}`, "");
  /* One document. An older row still has a summary, so it is printed above the
   * body when it exists; new rows put everything in the body. */
  if (String(report.summary || "").trim()) out.push(report.summary, "");
  out.push(report.body || "");
  if (report.watch) out.push("", "## Worth a look", "", report.watch);
  if (report.cannot_check || report.cannotCheck) {
    out.push("", "## What it could not check", "", report.cannot_check || report.cannotCheck);
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* The counted facts                                                   */
/*                                                                     */
/* The fact SHEET the AI reads is renderContext(snap) — it is already   */
/* prompt-shaped, already role-gated, and already says what it cannot   */
/* answer. This is the small numeric companion to it: the figures the   */
/* fallback needs, and the ones the "check the numbers" panel shows so  */
/* a person can audit a written answer without reading the prompt.      */
/* ------------------------------------------------------------------ */


export function assembleConsoleFacts(snap, { nowMs = Date.now() } = {}) {
  const rows = (k) => (Array.isArray(snap?.[k]) ? snap[k] : []);
  const today = teamDate(nowMs);
  const owedOf = (i) => Math.max(0, Number(i.total_cents || 0) - Number(i.amount_paid_cents || 0));
  const liveInvoices = rows("invoices").filter((i) => i.status !== "void" && i.status !== "draft");
  const overdue = liveInvoices.filter((i) =>
    owedOf(i) > 0 && i.due_date && String(i.due_date).slice(0, 10) < today);
  const openLeads = rows("leads").filter((l) => !CLOSED_LEAD_STAGES.includes(l.stage));
  const openTasks = rows("tasks").filter((t) => t.status !== "done");

  const counts = {
    clients: rows("clients").length,
    clientsActive: rows("clients").filter((c) => (c.status || "active") === "active").length,
    tasksOpen: openTasks.length,
    tasksLate: openTasks.filter((t) =>
      t.status !== "blocked" && t.due_date && String(t.due_date).slice(0, 10) < today).length,
    tasksBlocked: openTasks.filter((t) => t.status === "blocked").length,
    tasksFinished: rows("tasksDone").length,
    leadsOpen: openLeads.length,
    leadsUnclaimed: openLeads.filter((l) => !l.owner_id).length,
    companies: rows("companies").length,
    companiesScored: rows("companies").filter((c) => c.site_score !== null && c.site_score !== undefined).length,
    leadLists: rows("leadLists").length,
    proposalsOpen: rows("proposals").filter((p) => !p.decided_at).length,
    emailsNeedingReply: rows("emails").filter((e) => e.status === "needs_reply" || e.status === "new").length,
    ticketsOpen: rows("tickets").filter((t) => t.status === "open").length,
    remindersOpen: rows("reminders").length,
    notesOpen: rows("notes").length,
    weeklyLogs: rows("weekly").length,
    sites: rows("sites").length,
  };

  /* Money only exists in the snapshot for owner and admin. An absent key and a
   * zero are different facts, so the keys are only added when the rows were in
   * scope at all — the fallback checks `!== undefined` before printing them. */
  if (Array.isArray(snap?.invoices)) {
    counts.invoices = rows("invoices").length;
    counts.owedCents = liveInvoices.reduce((s, i) => s + owedOf(i), 0);
    counts.invoicesOverdue = overdue.length;
    counts.overdueCents = overdue.reduce((s, i) => s + owedOf(i), 0);
    counts.monthlySpendCents = rows("expenses")
      .filter((e) => e.interval === "monthly" && !e.ended_on)
      .reduce((s, e) => s + Number(e.amount_cents || 0), 0);
  }

  const unreadable = Object.keys(snap?.errors || {});

  /* Named rows, not just totals. The counted fallback used to print six numbers
   * and nothing else, which is exactly what Ryder pushed back on: a count is the
   * input, not the answer. Even with no AI key it can at least say WHICH client
   * and WHICH task rather than how many. Every name here also appears in the
   * fact sheet, so the strict check still passes over the fallback. */
  const nameOfClient = (id) => rows("clients").find((c) => c.id === id)?.name || null;
  const highlights = {
    late: openTasks
      .filter((t) => t.status !== "blocked" && t.due_date && String(t.due_date).slice(0, 10) < today)
      .slice(0, 8)
      .map((t) => ({ name: t.name, client: nameOfClient(t.client_id) })),
    blocked: openTasks
      .filter((t) => t.status === "blocked")
      .slice(0, 8)
      .map((t) => ({ name: t.name, client: nameOfClient(t.client_id) })),
    finished: rows("tasksDone").slice(0, 8)
      .map((t) => ({ name: t.name, client: nameOfClient(t.client_id) })),
    /* An active client with no open task at all is the quiet failure nothing
     * else on the page catches. */
    nothingPlanned: rows("clients")
      .filter((c) => (c.status || "active") === "active")
      .filter((c) => !openTasks.some((t) => t.client_id === c.id))
      .slice(0, 8)
      .map((c) => c.name),
    overdueInvoices: overdue.slice(0, 8)
      .map((i) => ({ number: i.number, who: i.bill_to_name, cents: owedOf(i) })),
    needsReply: rows("emails")
      .filter((e) => e.status === "needs_reply" || e.status === "new")
      .slice(0, 8)
      .map((e) => ({ subject: e.subject, who: e.from_name || e.from_email })),
  };

  return {
    takenAt: snap?.generatedAt || new Date(nowMs).toISOString(),
    highlights,
    role: snap?.role || null,
    counts,
    /* Named, not implied. A section that could not be read must never be
     * summarised as empty, and the person auditing the output needs to see
     * which ones those were. */
    unreadable,
    cannotAnswer: [
      "Anything from the AI Syndicate platform. This console holds no scan results, no citation history and no GEO score for a paying client — only a 0-100 website score on a sales firm, where one has been run.",
      "Money taken through Stripe. Only the invoices we issued ourselves are in here.",
      "Anything nobody wrote down. An unlogged call did not happen as far as these rows go.",
      "Whether an email was answered — the email rows carry no direction.",
      ...(unreadable.length
        ? [`These reads failed and are UNKNOWN, not empty: ${unreadable.join(", ")}.`]
        : []),
    ],
  };
}

/** How much of the snapshot was actually in scope, for the panel header. */
export function factsHeadline(facts) {
  const c = facts?.counts || {};
  const bits = [
    `${c.clients ?? 0} clients`,
    `${c.tasksOpen ?? 0} open tasks`,
    `${c.leadsOpen ?? 0} live leads`,
    `${c.companies ?? 0} firms`,
  ];
  if (c.owedCents !== undefined) {
    bits.push(`$${Math.round(c.owedCents / 100).toLocaleString("en-US")} owed to us`);
  }
  return bits.join(" · ");
}
