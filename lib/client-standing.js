/* "Where this client stands" — the counting, and the words when there is no AI.
 *
 * WHY THIS FILE IS PURE
 * It is imported by BOTH the server endpoint (api/client-standing.js) and the
 * browser (src/lib/data.js, for preview mode). So: no imports, no node
 * built-ins, no fetch, no database. Facts in, text out.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * The write-up may only ever say things that are in `facts`. assembleFacts()
 * counts them from real rows; factsToText() is the ONLY thing the AI is shown.
 * If a number is not in here, the AI cannot have it, so it cannot invent it and
 * have it sound official.
 */

export const SITE_KINDS = ["main", "authority", "landing", "gbp", "directory", "review", "social", "other"];

export const SITE_KIND_LABELS = {
  main: "Main website",
  authority: "Ranking site",
  landing: "Landing page",
  gbp: "Google Business Profile",
  directory: "Directory listing",
  review: "Review page",
  social: "Social profile",
  other: "Other",
};

export const SITE_KIND_HELP = {
  main: "The client's own website.",
  authority: "A site we built to rank and to get quoted by AI search.",
  landing: "A single page for one campaign or one service.",
  gbp: "Their Google Business Profile — the map listing.",
  directory: "A listing on someone else's site (Yelp, Avvo, Zillow).",
  review: "Where their reviews live.",
  social: "A social profile that shows up in search.",
  other: "Anything else worth keeping a link to.",
};

/** Tidy a typed-in address. Adds https:// when someone pastes a bare domain. */
export function normalizeUrl(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v.replace(/^\/+/, "")}`;
}

/** The bit a person reads: strip the scheme and any trailing slash. */
export function prettyUrl(raw) {
  return String(raw || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function d(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function daysBetween(aIso, nowMs) {
  const t = Date.parse(aIso);
  if (Number.isNaN(t)) return null;
  return Math.floor((nowMs - t) / 86400000);
}

/**
 * Count everything we know about one client.
 *
 * nowMs is passed in rather than read from the clock, so the same rows always
 * produce the same facts — that is what makes this testable and what keeps the
 * saved facts honest about the moment they were taken.
 */
export function assembleFacts({ client, tasks = [], weekly = [], emailThreads = [], sites = [], reminders = [], nowMs }) {
  const now = nowMs || 0;
  const openTasks = tasks.filter((t) => t.status !== "done");
  const doneTasks = tasks.filter((t) => t.status === "done");
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  const lateTasks = openTasks.filter((t) => t.due_date && Date.parse(`${t.due_date}T23:59:59`) < now);

  const loggedWeeks = weekly.filter((w) => w.week_status === "complete" || w.week_status === "complete_late");
  const lastWeek = [...weekly].sort((a, b) => (b.week_no || 0) - (a.week_no || 0))[0] || null;

  const byStatus = (s) => emailThreads.filter((e) => e.status === s);
  const lastInbound = [...emailThreads]
    .filter((e) => e.last_message_at)
    .sort((a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at))[0] || null;

  return {
    takenAt: now ? new Date(now).toISOString() : null,
    client: {
      name: client?.name || "(unnamed)",
      domain: client?.domain || null,
      stage: client?.stage || null,
      status: client?.status || null,
      vertical: client?.vertical || null,
      startDate: client?.start_date || null,
      daysWithUs: client?.start_date ? daysBetween(`${client.start_date}T00:00:00`, now) : null,
      notes: client?.notes || null,
    },
    counts: {
      tasksTotal: tasks.length,
      tasksDone: doneTasks.length,
      tasksOpen: openTasks.length,
      tasksInProgress: inProgress.length,
      tasksBlocked: blockedTasks.length,
      tasksLate: lateTasks.length,
      weeksLogged: loggedWeeks.length,
      weeksTotal: weekly.length,
      sites: sites.length,
      sitesLive: sites.filter((s) => s.live !== false).length,
      emails: emailThreads.length,
      emailsNeedingReply: byStatus("needs_reply").length + byStatus("new").length,
      emailsWaitingOnThem: byStatus("waiting").length,
      emailsScheduled: byStatus("scheduled").length,
      followUpsOpen: reminders.filter((r) => !r.done_at).length,
    },
    /* Lists are capped. A summary built from 200 task names is not a summary,
     * and the AI has a character budget. Newest first, so what is capped off is
     * the oldest and least useful. */
    done: doneTasks
      .slice()
      .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))
      .slice(0, 25)
      .map((t) => ({ name: t.name, category: t.category || null, on: d(t.updated_at || t.created_at), report: t.latest_report || null })),
    open: openTasks
      .slice()
      .sort((a, b) => String(a.due_date || "9999").localeCompare(String(b.due_date || "9999")))
      .slice(0, 25)
      .map((t) => ({
        name: t.name,
        status: t.status,
        due: t.due_date || null,
        late: Boolean(t.due_date && Date.parse(`${t.due_date}T23:59:59`) < now),
        priority: t.priority || null,
        report: t.latest_report || null,
      })),
    blocked: blockedTasks.slice(0, 15).map((t) => ({ name: t.name, why: t.latest_report || null })),
    weeks: [...weekly]
      .sort((a, b) => (b.week_no || 0) - (a.week_no || 0))
      .slice(0, 8)
      .map((w) => ({
        week: w.week_no,
        status: w.week_status,
        readiness: w.readiness,
        did: w.what_we_did || null,
        moved: w.what_moved || null,
        next: w.whats_next || null,
      })),
    lastWeekLogged: lastWeek ? { week: lastWeek.week_no, status: lastWeek.week_status, next: lastWeek.whats_next || null } : null,
    sites: sites.map((s) => ({ kind: s.kind, label: s.label, url: s.url, live: s.live !== false })),
    emailsOpen: [...byStatus("needs_reply"), ...byStatus("new"), ...byStatus("waiting"), ...byStatus("scheduled")]
      .slice(0, 15)
      .map((e) => ({ subject: e.subject || "(no subject)", status: e.status, lastAt: d(e.last_message_at), notes: e.notes || null })),
    lastContact: lastInbound
      ? { subject: lastInbound.subject || "(no subject)", on: d(lastInbound.last_message_at), direction: lastInbound.last_direction || null }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* The only thing the AI is ever shown                                 */
/* ------------------------------------------------------------------ */

/** Facts as plain lines. Capped, because lib/ai.js truncates its input at 6000
 * characters and a silent truncation would drop whole sections off the end. */
export function factsToText(facts, { maxChars = 5200 } = {}) {
  const c = facts.counts;
  const cl = facts.client;
  const lines = [];

  lines.push(`CLIENT: ${cl.name}${cl.domain ? ` (${cl.domain})` : ""}`);
  lines.push(`Stage: ${cl.stage || "not set"} · Status: ${cl.status || "not set"}${cl.vertical ? ` · Type: ${cl.vertical}` : ""}`);
  if (cl.startDate) lines.push(`Started with us: ${cl.startDate}${cl.daysWithUs != null ? ` (${cl.daysWithUs} days ago)` : ""}`);
  if (cl.notes) lines.push(`Notes on file: ${cl.notes}`);

  lines.push("");
  lines.push(`COUNTS: ${c.tasksDone} tasks done, ${c.tasksOpen} still open (${c.tasksInProgress} in progress, ${c.tasksBlocked} blocked, ${c.tasksLate} past their due date).`);
  lines.push(`${c.weeksLogged} of ${c.weeksTotal} weekly logs marked complete. ${c.sites} websites on file (${c.sitesLive} live).`);
  lines.push(`Email: ${c.emailsNeedingReply} needing a reply from us, ${c.emailsWaitingOnThem} waiting on them, ${c.emailsScheduled} scheduled to chase. ${c.followUpsOpen} open follow-ups.`);

  if (facts.done.length) {
    lines.push("");
    lines.push("FINISHED WORK (newest first):");
    for (const t of facts.done) lines.push(`- ${t.name}${t.on ? ` [${t.on}]` : ""}${t.report ? ` — ${t.report}` : ""}`);
  }
  if (facts.open.length) {
    lines.push("");
    lines.push("STILL OPEN:");
    for (const t of facts.open) {
      lines.push(`- ${t.name} (${t.status}${t.due ? `, due ${t.due}${t.late ? " — LATE" : ""}` : ", no due date"})${t.report ? ` — ${t.report}` : ""}`);
    }
  }
  if (facts.blocked.length) {
    lines.push("");
    lines.push("BLOCKED — cannot move until something outside our control exists:");
    for (const t of facts.blocked) lines.push(`- ${t.name}${t.why ? ` — ${t.why}` : ""}`);
  }
  if (facts.weeks.length) {
    lines.push("");
    lines.push("WEEKLY LOG (newest first):");
    for (const w of facts.weeks) {
      lines.push(`- Week ${w.week} (${w.status}, ${w.readiness}): did: ${w.did || "not written"} | moved: ${w.moved || "not written"} | next: ${w.next || "not written"}`);
    }
  }
  if (facts.sites.length) {
    lines.push("");
    lines.push("WEBSITES:");
    for (const s of facts.sites) lines.push(`- ${SITE_KIND_LABELS[s.kind] || s.kind}: ${s.label} — ${s.url}${s.live ? "" : " (NOT LIVE YET)"}`);
  }
  if (facts.emailsOpen.length) {
    lines.push("");
    lines.push("OPEN EMAIL THREADS:");
    for (const e of facts.emailsOpen) lines.push(`- "${e.subject}" (${e.status}${e.lastAt ? `, last message ${e.lastAt}` : ""})${e.notes ? ` — ${e.notes}` : ""}`);
  }
  if (facts.lastContact) {
    lines.push("");
    lines.push(`LAST CONTACT: "${facts.lastContact.subject}" on ${facts.lastContact.on} (${facts.lastContact.direction === "out" ? "we wrote to them" : "they wrote to us"}).`);
  }

  let text = lines.join("\n");
    /* This marker lands INSIDE the fact sheet the AI reads, and it used to say
   * "the counts above cover everything" — false in exactly the case it fires,
   * because the LISTS below it are gone. */
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[CUT HERE — the lists above stop partway. The counts near the top are complete; these lists are not.]`;
  return text;
}

export const STANDING_INSTRUCTION = `Write "where this client stands" for our own team, from the facts below and NOTHING else.

Format exactly:
HEADLINE: one sentence, under 20 words, saying where this client is right now.
DONE
- up to 6 bullets: what has actually been finished. Group small things together.
STILL NEEDED
- up to 6 bullets: what is left. Put anything blocked first and say what it is blocked on.

Rules:
- A smart 12-year-old must understand every line.
- Use only numbers and dates that appear in the facts. Never estimate.
- Never write a task as somebody's job. Write "blocked until X exists", not "CJ needs to do X".
- No praise, no selling, no promises about results.`;

/* ------------------------------------------------------------------ */
/* The no-AI version — counted, not written                            */
/* ------------------------------------------------------------------ */

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

/** Built straight from the facts with no model involved. This is what the page
 * shows before anyone sets an AI key, and it is deliberately dull: it states
 * counts and names and nothing else. */
export function deterministicStanding(facts) {
  const c = facts.counts;
  const cl = facts.client;
  const done = [];
  const needed = [];

  if (c.tasksDone) {
    const names = facts.done.slice(0, 4).map((t) => t.name);
    done.push(`${plural(c.tasksDone, "task", "tasks")} finished${names.length ? `, most recently: ${names.join("; ")}` : ""}.`);
  }
  if (c.weeksLogged) done.push(`${plural(c.weeksLogged, "week", "weeks")} written up in the weekly log.`);
  if (c.sitesLive) {
    const live = facts.sites.filter((s) => s.live).map((s) => `${s.label} (${prettyUrl(s.url)})`);
    done.push(`${plural(c.sitesLive, "website", "websites")} live: ${live.slice(0, 5).join(", ")}.`);
  }
  if (facts.lastContact) {
    done.push(`Last email on ${facts.lastContact.on} — "${facts.lastContact.subject}".`);
  }
  if (!done.length) done.push("Nothing is recorded as finished for this client yet.");

  const trimDot = (v) => String(v || "").replace(/\s*\.\s*$/, "");
  for (const b of facts.blocked.slice(0, 4)) {
    needed.push(`Blocked: ${trimDot(b.name)}${b.why ? ` — ${trimDot(b.why)}` : " (no reason written down)"}.`);
  }
  const late = facts.open.filter((t) => t.late).slice(0, 4);
  for (const t of late) needed.push(`Past its date: ${t.name} (was due ${t.due}).`);
  const rest = facts.open.filter((t) => !t.late && t.status !== "blocked").slice(0, 4);
  if (rest.length) needed.push(`Still to do: ${rest.map((t) => t.name).join("; ")}.`);
  if (c.emailsNeedingReply) needed.push(`${plural(c.emailsNeedingReply, "email", "emails")} waiting on a reply from us.`);
  if (c.emailsWaitingOnThem) needed.push(`${plural(c.emailsWaitingOnThem, "email", "emails")} waiting on them to come back to us.`);
  const notLive = facts.sites.filter((s) => !s.live);
  if (notLive.length) needed.push(`${plural(notLive.length, "website", "websites")} built but not live: ${notLive.map((s) => s.label).join(", ")}.`);
  if (!c.weeksTotal && c.tasksTotal) needed.push("No weekly log written yet for this client.");
  if (!needed.length) needed.push("Nothing is outstanding in the records.");

  const headline = `${cl.name}: ${c.tasksDone} done, ${c.tasksOpen} open${c.tasksBlocked ? ` (${c.tasksBlocked} blocked)` : ""}${cl.stage ? `, at ${cl.stage}` : ""}.`;

  return { headline, done, needed };
}

/** Read back the AI's answer. Anything it puts outside the two sections is
 * dropped rather than shown, because an unlabelled paragraph is exactly where a
 * made-up claim would hide. */
export function parseStanding(text) {
  const src = String(text || "");
  const headline = (src.match(/HEADLINE:\s*(.+)/i)?.[1] || "").trim();
  const section = (name) => {
    const re = new RegExp(`${name}\\s*\\n([\\s\\S]*?)(?=\\n\\s*(?:STILL NEEDED|DONE|HEADLINE:)\\s*\\n|$)`, "i");
    const block = src.match(re)?.[1] || "";
    return block
      .split("\n")
      .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
      .filter((l) => l && !/^(done|still needed)$/i.test(l));
  };
  const done = section("DONE");
  const needed = section("STILL NEEDED");
  if (!headline && !done.length && !needed.length) return null;
  return { headline, done, needed };
}

/* ------------------------------------------------------------------ */
/* Checking the write-up against the facts                             */
/* ------------------------------------------------------------------ */

/* Rule 4 used to be "the shape is parsed, so a loose paragraph cannot hide a
 * made-up claim". A reviewer pointed out the hole: a well-shaped bullet can
 * still contain an invented NUMBER or a promise, and the format check would wave
 * it through. Natural language cannot be fully verified, but the two dangerous
 * classes can be caught cheaply, and both are caught here. A summary that fails
 * either check is thrown away and the counted version is used instead. */

/** Words that turn a record into a sales claim. We describe what happened; we
 * never promise an outcome. */
const PROMISE_WORDS = [
  "guarantee", "guaranteed", "on track for", "will rank", "will reach", "should rank",
  "expect to see", "poised", "well positioned", "great progress", "excellent progress",
  "crushing", "smashing", "no issues at all", "nothing to worry about",
];

/** Numbers in the write-up that do not appear anywhere in the facts it was given.
 * Years and the small ordinals that show up in ordinary phrasing are ignored;
 * what this is for is "12 pages" or "a 74 score" appearing out of nowhere. */
export function unbackedNumbers(text, factsText) {
  const inFacts = new Set((String(factsText).match(/\d+/g) || []));
  const used = String(text).match(/\d+/g) || [];
  const bad = [];
  for (const n of used) {
    if (inFacts.has(n)) continue;
    if (n.length === 4 && Number(n) >= 2000 && Number(n) <= 2100) continue;  // a year
    if (Number(n) <= 1) continue;                                            // "1 of", "0"
    bad.push(n);
  }
  return [...new Set(bad)];
}

export function promiseWordsIn(text) {
  const low = String(text).toLowerCase();
  return PROMISE_WORDS.filter((w) => low.includes(w));
}

/** { ok } or { ok:false, why } — why is written for a human reading a log. */
export function checkStanding(standing, factsText) {
  const all = [standing.headline || "", ...(standing.done || []), ...(standing.needed || [])].join("\n");
  const numbers = unbackedNumbers(all, factsText);
  if (numbers.length) {
    return { ok: false, why: `numbers not in the facts: ${numbers.join(", ")}` };
  }
  const promises = promiseWordsIn(all);
  if (promises.length) {
    return { ok: false, why: `promise wording: ${promises.join(", ")}` };
  }
  if (!standing.done?.length && !standing.needed?.length) {
    return { ok: false, why: "both sections came back empty" };
  }
  return { ok: true };
}
