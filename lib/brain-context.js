/* The context engine — everything the console knows, in one block of text the
 * AI can read.
 *
 * WHY THIS FILE EXISTS
 * Before it, every AI call in the console saw only the handful of rules on the
 * Brain page plus whatever the calling screen happened to paste in. So the AI
 * could follow the house style perfectly and still not know that Shiner has
 * three open tasks, or that a lead went cold eleven days ago. It sounded right
 * and knew nothing.
 *
 * This file reads the real rows and renders them as plain text. It is the
 * single place that decides what the AI is allowed to see and how much of it.
 *
 * TWO HARD RULES, both of which cost something to keep:
 *
 * 1. SCOPE IS DECIDED BY ROLE, HERE, ONCE.
 *    A sales rep gets leads and nothing else — no clients, no email, no
 *    tickets, no money, no Brain. Trap #8 in CONTEXT-FOR-AI.md is exactly this
 *    mistake made once already: a table a rep cannot query was loaded with the
 *    service role and put in a prompt, so the rep could just ask the AI to
 *    read it out. The service role bypasses row-level security, so the only
 *    thing standing between a rep and the whole company is this function.
 *
 * 2. EVERY LINE IS COUNTED, NOT DESCRIBED.
 *    Numbers here come from counting rows that exist. Nothing in this file
 *    estimates, rounds up, or fills a gap. When something is unknown it says
 *    "unknown" and the AI is told, in the prompt, to say so too.
 *
 * SIZE
 * A prompt is not a database dump. Each section has a hard row cap and the
 * rows are sorted so the ones that matter survive the cap. `truncated` is
 * recorded and PRINTED — an AI that thinks it saw all 400 leads when it saw 80
 * will answer "no" to "is anyone chasing X" with total confidence.
 */

/* One list of "nobody is chasing this any more", shared with the sales page
 * and the overnight sweep. A bare ["won","lost"] here would keep nagging about
 * a lead somebody deliberately marked Skip - 90+ or Bad contact info. */
import { isOpenStage } from "./sales-rules.js";
/* The client's own connected accounts. Same file the client page and the
 * report engine read, so all three call the same number the same thing. */
import { newestPerProperty, snapshotToLines, PROVIDER_LABELS } from "./connectors.js";

/* Hard caps. Raising these raises the bill on every single AI call in the
 * console, so they are named and gathered rather than sprinkled inline. */
export const CAPS = {
  clients: 60,
  tasks: 200,
  /* Aug 23 2026, third pass. Ryder: "i want it to include everything, all sent
   * emails, all clients, all operations, all sales, everything." Three real
   * holes were closed:
   *   - `tasks` read `status != done`, so FINISHED work was invisible. A Monday
   *     update could say what was late and not what shipped.
   *   - `emails` read three statuses, so sent and finished threads were absent.
   *   - the caps were sized for five clients, not an imported sheet.
   * A full snapshot is now roughly 40-60k tokens, which Sonnet reads in one
   * pass, so the ceiling is cost rather than capability. */
  tasksDone: 80,
  leads: 220,
  leadsRecent: 40,   // a second, small read so recent wins are not sorted out
  leadActivity: 120,
  tickets: 50,
  emails: 120,
  reminders: 40,
  weekly: 40,
  sites: 60,
  /* Added Aug 24 2026 with the client connections.
   *
   * THE SNAPSHOTS CAP IS APPLIED BEFORE ANYTHING IS REDUCED, so it is a cap
   * on ROWS READ, not on rows shown. Newest-first across every client at
   * once: at four connections a client refreshed daily, 80 rows is about
   * four clients' worth of one day. Anything past it simply is not there —
   * which is why renderContext below counts what it got and says so, instead
   * of stating "nothing has been read" about a client whose readings were
   * never fetched. An earlier comment here claimed a bigger number bought
   * nothing. That was backwards, and a reviewer caught it. */
  connections: 200,
  snapshots: 400,
  memory: 60,
  brain: 60,
  notes: 40,
  team: 25,
  /* Added Aug 23 2026. Until this the snapshot had no Sales tables and no money
   * at all, so the assistant, the notes engine and anything else built on it
   * were blind to the entire pipeline and every invoice — and answered as if
   * that meant there was none. "money" had been in the owner/admin scope list
   * since Aug 20 with no loader behind it. */
  companies: 60,
  leadLists: 25,
  proposals: 30,
  invoices: 60,
  expenses: 40,
  /* Added Aug 23 2026, second pass. Ryder: "it has to always pull from the
   * admin platform and pull all clients, thier info, recent reports,
   * operation, finances, EVERYTHING!" These are the last three tables that
   * were still outside the snapshot. The vault stays out — permanently, see
   * the note at the bottom of this file. */
  clientReports: 24,
  payments: 60,
  platformAccounts: 40,
};

const DAY = 86400000;

/* The team works in Chicago. Every "is this late?" question is answered
 * against THEIR calendar day, not UTC's.
 *
 * Counting whole days from a UTC midnight made a task due today read as
 * "LATE by 1d" from 7pm Central onwards, and the Notes page raised "1 task
 * past the date" that same evening — every evening. Found by an adversarial
 * review, Aug 20 2026.
 *
 * One place, one timezone. If the team ever spans two, this is the line that
 * changes, and it should become per-person rather than per-company. */
export const TEAM_TZ = "America/Chicago";

/** The calendar date in the team's timezone, as YYYY-MM-DD. */
export function teamDate(ms) {
  // en-CA formats as YYYY-MM-DD, which is the one thing it is reliably good for.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TEAM_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
}

/** Midnight of that team-calendar day, as epoch ms. */
function teamDayStart(ms) {
  return Date.parse(`${teamDate(ms)}T00:00:00Z`);
}

/** Parse a timestamp. NaN — never a number — when there is nothing to parse.
 *
 * `Date.parse(x || 0)` was used in a few places and is a trap: the fallback 0
 * becomes the STRING "0", which parses as the year 2000. A row with a missing
 * date then looked twenty-six years old and won every "what is the oldest"
 * sort in the codebase. */
export function parseWhen(v) {
  if (v === null || v === undefined || v === "") return NaN;
  return Date.parse(v);
}

/** Whole days between then and now, counted in the team's calendar days.
 * Negative = in the future. A date-only value ("2026-08-20") is read as that
 * calendar day, which is what a due date means. */
export function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(iso))
    ? Date.parse(`${iso}T00:00:00Z`)
    : parseWhen(iso);
  if (Number.isNaN(t)) return null;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? t : teamDayStart(t);
  return Math.round((teamDayStart(now) - from) / DAY);
}

/** "3 days ago" / "in 2 days" / "today" — the AI reads these better than dates. */
export function relDays(iso, now = Date.now()) {
  const d = daysSince(iso, now);
  if (d === null) return "unknown";
  if (d === 0) return "today";
  if (d > 0) return `${d} day${d === 1 ? "" : "s"} ago`;
  const a = Math.abs(d);
  return `in ${a} day${a === 1 ? "" : "s"}`;
}

/** Trim and cap a free-text field so one long note cannot eat the prompt. */
function short(v, n = 160) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* ------------------------------------------------------------------ */
/* What each role may see                                              */
/* ------------------------------------------------------------------ */

/* The whole security model of this file, in one object. Read it as: "a sales
 * rep's AI can see leads, lead activity, the team roster and their own
 * reminders." Nothing outside the list is fetched at all — not filtered later,
 * not fetched. A row that is never read cannot leak. */
const SCOPE_BY_ROLE = {
  owner: ["clients", "tasks", "weekly", "leads", "leadActivity", "leadSources", "tickets",
    "emails", "reminders", "sites", "brain", "memory", "notes", "team", "money",
    "companies", "leadLists", "proposals", "clientReports", "platformAccounts", "measured"],
  admin: ["clients", "tasks", "weekly", "leads", "leadActivity", "leadSources", "tickets",
    "emails", "reminders", "sites", "brain", "memory", "notes", "team", "money",
    "companies", "leadLists", "proposals", "clientReports", "platformAccounts", "measured"],
  /* A rep gets the firms, the lists and the proposals — that IS their job, and
   * the Sales page already shows them all three. Money stays out. */
  sales: ["leads", "leadActivity", "leadSources", "reminders", "team",
    "companies", "leadLists", "proposals"],
};

export function scopeFor(role) {
  return SCOPE_BY_ROLE[role] || SCOPE_BY_ROLE.sales;
}

export function canSee(role, part) {
  return scopeFor(role).includes(part);
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/** One table read, capped and ordered, that never throws.
 *
 * A failed read returns an empty list AND records the error, because the
 * alternative — an exception — makes the whole assistant fall over when one
 * table is missing. The error is printed in the context block, so the AI
 * knows the difference between "there are no open tickets" and "I could not
 * read the tickets", which are opposite answers to the same question. */
async function readTable(admin, table, build) {
  try {
    const { data, error } = await build(admin.from(table).select("*"));
    if (error) return { rows: [], error: error.message };
    return { rows: data || [], error: null };
  } catch (err) {
    return { rows: [], error: err?.message || "read failed" };
  }
}

/**
 * Read everything this role is allowed to see.
 *
 * @param admin   service-role Supabase client
 * @param role    owner | admin | sales
 * @param userId  the person asking — used for "yours" markers, not for filtering
 * @param focus   optional { clientId, leadId } to pull extra detail on one record
 */
export async function loadSystemContext(admin, { role = "sales", userId = null, focus = {} } = {}) {
  const allow = scopeFor(role);
  const has = (p) => allow.includes(p);
  const errors = {};
  const snap = { role, userId, focus, generatedAt: new Date().toISOString(), errors };

  const jobs = [];
  const take = (key, table, build) => {
    jobs.push(readTable(admin, table, build).then((r) => {
      snap[key] = r.rows;
      if (r.error) errors[key] = r.error;
    }));
  };

  if (has("clients")) take("clients", "admin_clients", (q) => q.order("name").limit(fetchCap(CAPS.clients)));
  if (has("tasks")) take("tasks", "admin_tasks", (q) =>
    q.neq("status", "done").order("due_date", { ascending: true, nullsFirst: false }).limit(fetchCap(CAPS.tasks)));
  /* TWO reads, for the same reason the leads use two: one list cannot be both
   * "what is still open, soonest first" and "what we finished recently". Asking
   * for done work inside the open read would spend the cap on history. */
  if (has("tasks")) take("tasksDone", "admin_tasks", (q) =>
    q.eq("status", "done")
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(fetchCap(CAPS.tasksDone)));
  if (has("weekly")) take("weekly", "admin_weekly_log", (q) =>
    q.order("created_at", { ascending: false }).limit(fetchCap(CAPS.weekly)));
  /* TWO reads, not one. Ordering by coldest-first is what makes the list
   * useful — but it also sorts the recently-touched leads out of the fetch,
   * so "1 lead marked won this week" could never be true and the AI would say
   * nothing had closed. The second read puts the recent ones back.
   * Won and lost are excluded in the FIRST read rather than after it, so the
   * cap is spent on leads somebody still has to work. */
  if (has("leads")) {
    jobs.push(Promise.all([
      readTable(admin, "admin_leads", (q) => q
        .not("stage", "in", "(won,lost)")
        .order("last_activity_at", { ascending: true, nullsFirst: true })
        .limit(fetchCap(CAPS.leads))),
      readTable(admin, "admin_leads", (q) => q
        .order("updated_at", { ascending: false })
        .limit(CAPS.leadsRecent)),
    ]).then(([cold, recent]) => {
      const byId = new Map();
      for (const row of [...cold.rows, ...recent.rows]) byId.set(row.id, row);
      snap.leads = [...byId.values()];
      // The cold read is the one that gets capped, so its truncation is the
      // one worth reporting.
      snap.leadsTruncated = cold.rows.length > CAPS.leads;
      const err = cold.error || recent.error;
      if (err) errors.leads = err;
    }));
  }
  if (has("leadActivity")) take("leadActivity", "admin_lead_activity", (q) =>
    q.gte("created_at", new Date(Date.now() - 21 * DAY).toISOString())
      .order("created_at", { ascending: false }).limit(fetchCap(CAPS.leadActivity)));
  if (has("leadSources")) take("leadSources", "admin_lead_sources", (q) =>
    q.eq("active", true).order("created_at", { ascending: false }).limit(20));
  if (has("tickets")) take("tickets", "admin_tickets", (q) =>
    q.in("status", ["open", "pending"]).order("updated_at", { ascending: false }).limit(fetchCap(CAPS.tickets)));
  /* EVERY status, not just the unfinished three. "All sent emails" was the
   * explicit ask, and a thread we already answered is exactly the evidence that
   * we did. `last_direction` is what says who spoke last. */
  if (has("emails")) take("emails", "admin_email_threads", (q) =>
    q.order("last_message_at", { ascending: false }).limit(fetchCap(CAPS.emails)));
  /* A rep sees THEIR OWN follow-ups and nobody else's. An owner or admin sees
   * the team's, which is deliberate — it is how nothing quietly rots — and is
   * the same split admin_reminders' own row-level security makes.
   *
   * This filter was missing until an adversarial review found it on Aug 20
   * 2026: a sales rep's context block was carrying every owner's follow-up,
   * text and all, and the rep could simply ask the assistant to read them out.
   * The service role ignores row-level security, so this line IS the guard. */
  if (has("reminders")) take("reminders", "admin_reminders", (q) => {
    let r = q.is("done_at", null).order("due_at", { ascending: true }).limit(fetchCap(CAPS.reminders));
    if (role === "sales") r = r.eq("owner_id", userId);
    return r;
  });
  if (has("sites")) take("sites", "admin_client_sites", (q) => q.order("client_id").limit(fetchCap(CAPS.sites)));
  if (has("brain")) take("brain", "admin_brain", (q) =>
    q.eq("enabled", true).order("created_at", { ascending: true }).limit(fetchCap(CAPS.brain)));
  if (has("memory")) take("memory", "admin_brain_memory", (q) =>
    q.eq("active", true).order("weight", { ascending: false })
      .order("last_used_at", { ascending: false, nullsFirst: false }).limit(fetchCap(CAPS.memory)));
  if (has("notes")) take("notes", "admin_ai_notes", (q) =>
    q.eq("status", "open").order("urgency", { ascending: false })
      .order("generated_at", { ascending: false }).limit(fetchCap(CAPS.notes)));
  if (has("team")) take("team", "admin_users", (q) =>
    q.eq("active", true).order("full_name").limit(fetchCap(CAPS.team)));

  /* ---- Sales, and the money ---- */
  if (has("companies")) take("companies", "admin_companies", (q) =>
    q.order("site_score", { ascending: false, nullsFirst: false })
      .order("name").limit(fetchCap(CAPS.companies)));
  if (has("leadLists")) take("leadLists", "admin_lead_lists", (q) =>
    q.eq("active", true).order("sort").limit(fetchCap(CAPS.leadLists)));
  /* Every proposal that has not been decided, newest first — plus recently
   * decided ones, because "we lost Summit last week" is exactly the kind of
   * thing somebody asks about and a not-yet-decided-only read cannot answer. */
  if (has("proposals")) take("proposals", "admin_proposals", (q) =>
    q.order("created_at", { ascending: false }).limit(fetchCap(CAPS.proposals)));
  /* Money is owner/admin only, and it is the whole invoice row: the report
   * generator works out overdue from the dates and the amounts rather than
   * trusting the stored status, the same way the Finance page does. */
  if (has("money")) {
    take("invoices", "admin_invoices", (q) =>
      q.order("issue_date", { ascending: false }).limit(fetchCap(CAPS.invoices)));
    take("expenses", "admin_expenses", (q) =>
      q.order("incurred_on", { ascending: false }).limit(fetchCap(CAPS.expenses)));
    /* Money ACTUALLY RECEIVED, not just billed. Without this "still owed" was
     * the only money fact in the snapshot, so "how much did we collect this
     * month" had no answer at all. */
    take("payments", "admin_invoice_payments", (q) =>
      q.order("paid_on", { ascending: false }).limit(fetchCap(CAPS.payments)));
  }
  /* What we have already told ourselves about each client. Only the title and
   * the first line of the summary — a full report is up to 1,200 words and
   * twenty of them would be the whole prompt. */
  /* No second .select() here: readTable already applied select("*"), and
   * chaining another one relies on override behaviour that is not worth
   * betting a silent empty read on. The trimming happens in renderContext,
   * which is where prompt size is actually decided. */
  if (has("clientReports")) take("clientReports", "admin_client_reports", (q) =>
    q.order("created_at", { ascending: false }).limit(fetchCap(CAPS.clientReports)));
  /* Which platform logins exist, per client. Emails and labels only — the
   * password never lives here, it lives in the vault, which is not read. */
  if (has("platformAccounts")) take("platformAccounts", "admin_platform_accounts", (q) =>
    q.order("client_id").limit(fetchCap(CAPS.platformAccounts)));
  /* The client's OWN accounts, and the numbers read out of them. These are the
   * only rows in the whole snapshot that describe the outside world rather
   * than our own work, so renderContext prints them under their own heading
   * with the dates attached — never mixed into the client line. */
  if (has("measured")) take("connections", "admin_client_connections", (q) =>
    q.eq("active", true).order("client_id").limit(fetchCap(CAPS.connections)));
  if (has("measured")) take("snapshots", "admin_connection_snapshots", (q) =>
    q.order("taken_at", { ascending: false }).limit(fetchCap(CAPS.snapshots)));
  /* Whether that read came back full is remembered, because a full read is
   * the one case where "nothing has been read for this client" cannot be
   * said. Set after the reads finish, below. */

  await Promise.all(jobs);

  /* A read that came back exactly at its cap almost certainly had more behind
   * it. Recorded rather than shrugged off — renderContext changes what it is
   * willing to state when this is true. */
  snap.snapshotsCapped = (snap.snapshots || []).length >= fetchCap(CAPS.snapshots);

  for (const k of ["clients", "tasks", "weekly", "leads", "leadActivity", "leadSources", "tickets",
    "emails", "reminders", "sites", "brain", "memory", "notes", "team",
    "companies", "leadLists", "proposals", "invoices", "expenses",
    "clientReports", "payments", "platformAccounts", "tasksDone",
    "connections", "snapshots"]) {
    if (!snap[k]) snap[k] = [];
  }
  return snap;
}

/* ------------------------------------------------------------------ */
/* Rendering — pure, so it can be tested without a database            */
/* ------------------------------------------------------------------ */

function nameFor(team, userId) {
  if (!userId) return "unassigned";
  const m = (team || []).find((t) => t.user_id === userId);
  return m ? (m.full_name || m.email || "someone") : "someone";
}

function clientName(clients, id) {
  if (!id) return null;
  return (clients || []).find((c) => c.id === id)?.name || null;
}

/* Every list is FETCHED at cap + 1 and PRINTED at cap. That one extra row is
 * the whole mechanism: without it lines.length could never exceed cap, so the
 * "+N more not shown" warning below was unreachable and the AI was told it had
 * seen everything, every time. With 400 leads it would show 90 and answer
 * "nobody is chasing Chen Dental" with total confidence. Found by an
 * adversarial review, Aug 20 2026. */
export function fetchCap(cap) { return cap + 1; }

function section(title, lines, cap, note) {
  if (!lines.length) return `## ${title}\nnone`;
  const shown = lines.slice(0, cap);
  const tail = lines.length > cap
    ? `\n(AT LEAST ${lines.length - cap} more were not shown, and there may be many more. Say so rather than answering as if this were the whole list.)`
    : "";
  return `## ${title}${note ? ` — ${note}` : ""}\n${shown.join("\n")}${tail}`;
}

/**
 * Turn a snapshot into the text block the AI reads. Pure: same snapshot in,
 * same string out, no clock reads except the one passed in.
 */
export function renderContext(snap, now = Date.now()) {
  const out = [];
  const { role, team, clients } = snap;
  const cn = (id) => clientName(clients, id);
  const who = (id) => nameFor(team, id);

  out.push(`# WHAT THE CONSOLE KNOWS RIGHT NOW`);
  out.push(`Read at ${new Date(now).toISOString()}. Every line below was counted from a real row.`);
  out.push(`You are answering ${who(snap.userId)} (role: ${role}).`);

  const errKeys = Object.keys(snap.errors || {});
  if (errKeys.length) {
    out.push(`\n## COULD NOT BE READ\n${errKeys.map((k) => `- ${k}: ${snap.errors[k]}`).join("\n")}\n` +
      `Treat these as UNKNOWN, never as empty. "No open tickets" and "I could not read tickets" are opposite answers.`);
  }

  /* Gated here as well as at load time, and that is not belt-and-braces.
   * loadSystemContext decides what to FETCH; this decides what to PRINT. A
   * caller that passes a fuller snapshot than the role allows — a test, a
   * future endpoint, a cached object reused for two people — would otherwise
   * walk straight past the fetch-time gate. A test caught exactly that: a
   * client's name reached a sales rep through a memory attached to that
   * client, because this section was not gated. Trap #8 in CONTEXT-FOR-AI.md,
   * one layer up. */
  if (canSee(role, "brain") && snap.brain?.length) {
    out.push(section("STANDING RULES (a person wrote these — they outrank everything else here)",
      snap.brain.map((b) => `- [${(b.kind || "fact").toUpperCase()}] ${b.title}: ${short(b.body, 400)}`), CAPS.brain));
  }

  if (canSee(role, "memory") && snap.memory?.length) {
    out.push(section("REMEMBERED (learned while working — weaker than the rules above)",
      snap.memory.map((m) => {
        const tag = m.confirmed ? "confirmed" : "UNCONFIRMED";
        const attached = cn(m.client_id) ? ` [${cn(m.client_id)}]` : "";
        return `- (${tag}, weight ${m.weight}) ${m.subject}${attached}: ${short(m.body, 300)}`;
      }), CAPS.memory,
      "an UNCONFIRMED memory may be wrong; say where a claim came from if you lean on one"));
  }

  if (canSee(role, "clients")) {
    out.push(section("CLIENTS", (snap.clients || []).map((c) => {
      const tasks = (snap.tasks || []).filter((t) => t.client_id === c.id);
      const late = tasks.filter((t) => t.due_date && daysSince(t.due_date, now) > 0).length;
      const sites = (snap.sites || []).filter((s) => s.client_id === c.id);
      const notLive = sites.filter((s) => !s.live).length;
      return `- ${c.name} — ${c.status}, stage ${c.stage || "?"}${c.vertical ? `, ${c.vertical}` : ""}. `
        + `${tasks.length} open task${tasks.length === 1 ? "" : "s"}${late ? `, ${late} past its date` : ""}. `
        + `${sites.length} site${sites.length === 1 ? "" : "s"} on record${notLive ? `, ${notLive} not live` : ""}.`
        + (c.notes ? ` Note: ${short(c.notes, 120)}` : "");
    }), CAPS.clients));
  }

  /* WHAT THEIR OWN ACCOUNTS SHOW.
   *
   * Its own section, never folded into the client line above, because these
   * are the only numbers in the whole snapshot that did not come out of our
   * records. Every line carries the window it covers and the day it was read,
   * and says whether this console read it or a person typed it in — the AI
   * cannot describe a number honestly without all three.
   *
   * Only the newest reading per property is shown. Handing a writer two
   * readings of the same thing invites a comparison out of windows that may
   * not line up. */
  if (canSee(role, "measured")) {
    const byClient = new Map();
    for (const c of snap.clients || []) byClient.set(c.id, c.name);
    const lines = [];
    const grouped = new Map();
    for (const sn of newestPerProperty(snap.snapshots || [])) {
      const list = grouped.get(sn.client_id) || [];
      list.push(sn);
      grouped.set(sn.client_id, list);
    }
    for (const [clientId, list] of grouped) {
      lines.push(`- ${byClient.get(clientId) || "an unnamed client"}:`);
      for (const sn of list) for (const l of snapshotToLines(sn)) lines.push(`  ${l}`);
    }
    /* Connected but never read is a different problem from not connected, and
     * both are different from "they have no visibility". Say which.
     *
     * BUT NOT WHEN THE READ WAS CUT. If the snapshot read came back at its
     * cap, a missing reading may simply be one that was never fetched, and
     * "There is NO number for it" would be a flat falsehood about a client
     * whose numbers are refreshed every day. In that case the line says what
     * is actually true: we did not look far enough back to tell. */
    const cut = snap.snapshotsCapped;
    for (const conn of snap.connections || []) {
      if ((snap.snapshots || []).some((sn) => sn.connection_id === conn.id)) continue;
      const who = byClient.get(conn.client_id) || "an unnamed client";
      const what = PROVIDER_LABELS[conn.provider] || conn.provider;
      lines.push(cut
        ? `- ${who}: ${what} is on file. No reading for it is in this snapshot, but the reading list was cut short — do NOT say there are no numbers for it, say you cannot see any from here.`
        : `- ${who}: ${what} is on file but nothing has been read from it${conn.property ? "" : " (no property chosen yet)"}. There is NO number for it.`);
    }
    if (cut) {
      lines.push("- NOTE: the list of readings was cut at its limit. Clients whose accounts were read longer ago may be missing from this section entirely. Absence here is not evidence.");
    }
    if (lines.length) {
      out.push(section("WHAT THEIR OWN ACCOUNTS SHOW", lines, 200,
        "these are the CLIENT'S numbers, not ours. Never present one as something we achieved, and always print the window and the date it was read beside it"));
    }
  }

  if (canSee(role, "tasks")) {
    const sorted = [...(snap.tasks || [])].sort((a, b) => {
      const ad = a.due_date ? Date.parse(a.due_date) : Infinity;
      const bd = b.due_date ? Date.parse(b.due_date) : Infinity;
      return ad - bd;
    });
    out.push(section("OPEN TASKS (soonest date first)", sorted.map((t) => {
      const d = t.due_date ? daysSince(t.due_date, now) : null;
      const when = t.due_date ? (d > 0 ? `LATE by ${d}d` : relDays(t.due_date, now)) : "no date";
      // `name`, not `title`. admin_tasks has no `title` column, and reading one
      // rendered every task line to the AI as "- [todo]  — Harbor, due LATE by 3d":
      // a task list with no task names in it, stated with total confidence.
      return `- [${t.status}] ${short(t.name, 110)} — ${cn(t.client_id) || "no client"}, ${who(t.assigned_to)}, due ${when}`
        + (t.priority && t.priority !== "medium" ? `, ${t.priority} priority` : "");
    }), CAPS.tasks));
  }

  if (canSee(role, "leads")) {
    const sorted = [...(snap.leads || [])]
      .filter((l) => isOpenStage(l.stage))
      .sort((a, b) => {
        // A lead nobody has ever touched is the coldest thing there is, so a
        // missing timestamp sorts FIRST. Reading it as epoch 0 did that by
        // accident; saying it is what stops the next person "tidying" it.
        const at = a.last_activity_at ? Date.parse(a.last_activity_at) : 0;
        const bt = b.last_activity_at ? Date.parse(b.last_activity_at) : 0;
        return at - bt;
      });
    if (snap.leadsTruncated) {
      out.push(`NOTE: there are MORE open leads than the ${CAPS.leads} shown below. `
        + `Never answer "nobody is chasing X" from this list — search for X instead.`);
    }
    out.push(section("OPEN LEADS (coldest first)", sorted.map((l) => {
      const quiet = l.last_activity_at ? relDays(l.last_activity_at, now) : "never touched";
      return `- ${l.name || l.company || "unnamed"}${l.company && l.name ? ` (${l.company})` : ""} — `
        + `${l.stage}, ${who(l.owner_id)}, last touch ${quiet}`
        + `${l.city ? `, ${l.city}${l.state ? `, ${l.state}` : ""}` : ""}`
        + `${l.vertical ? `, ${l.vertical}` : ""}, from ${l.source || "manual"}`
        + (l.notes ? `. Note: ${short(l.notes, 100)}` : "");
    }), CAPS.leads));

    const won = (snap.leads || []).filter((l) => l.stage === "won").length;
    const lost = (snap.leads || []).filter((l) => l.stage === "lost").length;
    out.push(`Closed in the rows read: ${won} won, ${lost} lost.`);
  }

  if (canSee(role, "leadActivity") && snap.leadActivity?.length) {
    const leadName = (id) => {
      const l = (snap.leads || []).find((x) => x.id === id);
      return l ? (l.name || l.company || "a lead") : "a lead";
    };
    out.push(section("SALES ACTIVITY, LAST 21 DAYS", snap.leadActivity.map((a) =>
      `- ${relDays(a.created_at, now)}: ${who(a.actor)} ${a.type} → ${leadName(a.lead_id)}`
      + `${a.outcome ? ` (${a.outcome})` : ""}${a.body ? ` — ${short(a.body, 90)}` : ""}`), CAPS.leadActivity));
  }

  if (canSee(role, "tasks") && snap.tasksDone?.length) {
    /* What actually shipped. Without this the snapshot could say what was late
     * and never what was finished, so "what did we get done" had no answer and
     * every summary read like a list of problems. */
    out.push(section("WORK FINISHED (most recently updated first)", snap.tasksDone.map((t) =>
      `- ${short(t.name, 90)} — ${cn(t.client_id) || "internal"}`
      + `${t.category ? `, ${t.category}` : ""}${t.phase ? `, ${t.phase}` : ""}`
      + `, finished ${relDays(t.updated_at || t.created_at, now)} by ${who(t.assigned_to)}`
      + `${t.latest_report ? `. Note: ${short(t.latest_report, 140)}` : ""}`), CAPS.tasksDone,
    "these are DONE. Use them to say what moved, never to say something is still open"));
  }

  if (canSee(role, "emails") && snap.emails?.length) {
    /* Every status, and WHO SPOKE LAST. `last_direction` is the only thing in
     * these rows that distinguishes a thread we answered from one we owe, and
     * "all sent emails" cannot be answered without it. */
    const dir = (e) => (e.last_direction === "out" ? "WE spoke last"
      : e.last_direction === "in" ? "THEY spoke last" : "direction not recorded");
    out.push(section("EMAIL THREADS", snap.emails.map((e) =>
      `- [${e.status}] "${short(e.subject, 80)}" from ${e.from_name || e.from_email || "?"}`
      + ` — ${cn(e.client_id) || "no client linked"}, ${who(e.assigned_to)}, last message ${relDays(e.last_message_at, now)}`
      + `, ${dir(e)}${e.message_count ? `, ${e.message_count} messages` : ""}`
      + `${e.priority === "high" ? ", HIGH" : ""}${e.snippet ? `. Latest: “${short(e.snippet, 120)}”` : ""}`
      + `${e.notes ? `. Team note: ${short(e.notes, 100)}` : ""}`), CAPS.emails,
    "every thread we have a row for, answered and unanswered. We store the subject, the sender, a snippet and the status — NOT the full message text"));
  }

  if (canSee(role, "tickets") && snap.tickets?.length) {
    out.push(section("OPEN TICKETS", snap.tickets.map((t) =>
      `- [${t.status}/${t.priority}] ${short(t.subject, 90)} — ${t.requester_name || t.requester_email || "?"}, `
      + `${who(t.assigned_to)}, updated ${relDays(t.updated_at, now)}`), CAPS.tickets));
  }

  if (canSee(role, "reminders") && snap.reminders?.length) {
    /* Second gate, on purpose. "A rep may see reminders" is true, but only
     * THEIR OWN — which is a filter, not a yes/no, and canSee() cannot express
     * it. The load-time query already narrows this for a rep; doing it again
     * here means a caller that hands over a fuller snapshot (a test, a reused
     * cached object, a future endpoint) still cannot spill one person's
     * follow-ups into another person's prompt. */
    const mine = role === "sales"
      ? snap.reminders.filter((r) => r.owner_id === snap.userId)
      : snap.reminders;
    if (mine.length) out.push(section("FOLLOW-UPS SET BY PEOPLE", mine.map((r) => {
      const d = daysSince(r.due_at, now);
      // admin_reminders stores the text in `body`.
      return `- ${d > 0 ? `OVERDUE ${d}d` : relDays(r.due_at, now)}: ${short(r.body, 100)} — ${who(r.owner_id)}`;
    }), CAPS.reminders));
  }

  if (canSee(role, "weekly") && snap.weekly?.length) {
    /* admin_weekly_log has no single summary column — it has four. Reading a
     * `summary` that does not exist rendered every week as "(blank)", so the
     * assistant would say a client's log was empty while it was full. */
    out.push(section("WEEKLY CLIENT LOG (most recent first)", snap.weekly.map((w) => {
      const parts = [
        w.what_we_did ? `did: ${short(w.what_we_did, 120)}` : null,
        w.what_moved ? `moved: ${short(w.what_moved, 90)}` : null,
        w.whats_next ? `next: ${short(w.whats_next, 90)}` : null,
      ].filter(Boolean);
      return `- ${cn(w.client_id) || "?"} week ${w.week_no ?? "?"} [${w.week_status || "?"}]: `
        + (parts.length ? parts.join(" · ") : "(nothing written in it)");
    }), CAPS.weekly));
  }

  if (canSee(role, "notes") && snap.notes?.length) {
    out.push(section("NOTES ALREADY RAISED AND STILL OPEN", snap.notes.map((n) =>
      `- [${n.category}] ${short(n.title, 100)} (raised ${relDays(n.generated_at, now)})`), CAPS.notes,
    "do not raise these again as if they were new"));
  }

  if (canSee(role, "leadSources") && snap.leadSources?.length) {
    out.push(section("WHERE LEADS COME FROM", snap.leadSources.map((s) =>
      `- ${s.label} (${s.kind}${s.provider ? `, ${s.provider}` : ""})`
      + `${s.auto_daily ? ", runs daily" : ""} — last run ${s.last_run_at ? relDays(s.last_run_at, now) : "never"}`
      + `${s.last_run_error ? `, LAST RUN FAILED: ${short(s.last_run_error, 80)}` : ""}`), 20));
  }

  if (canSee(role, "team") && snap.team?.length) {
    out.push(section("THE TEAM", snap.team.map((t) =>
      `- ${t.full_name || t.email} (${t.role})`), CAPS.team));
  }

  /* ---- Sales and money. Added Aug 23 2026; before this an "everything"
   * answer silently left out every firm, list, proposal and invoice. ---- */

  if (canSee(role, "companies") && snap.companies?.length) {
    out.push(section("FIRMS WE ARE SELLING TO (highest site score first; a score is the platform's 0-100 for their website)",
      snap.companies.map((c) => {
        const bits = [`- ${c.name}`];
        if (c.domain) bits.push(c.domain);
        if (c.vertical) bits.push(c.vertical);
        if (c.city || c.state) bits.push([c.city, c.state].filter(Boolean).join(" "));
        /* "no score yet" and "scored 0" are opposite facts. A missing score
         * must never print as a number. */
        bits.push(c.site_score === null || c.site_score === undefined
          ? "no score yet"
          : `score ${c.site_score}${c.site_score_at ? ` on ${teamDate(parseWhen(c.site_score_at))}` : ""}`);
        if (c.client_id) bits.push("ALREADY A CLIENT");
        return bits.join(" · ");
      }), CAPS.companies));
  }

  if (canSee(role, "leadLists") && snap.leadLists?.length) {
    out.push(section("THE LISTS LEADS ARE ORGANISED INTO (the tabs of the old outreach sheet)",
      snap.leadLists.map((l) => `- ${l.name}${l.vertical ? ` (${l.vertical})` : ""}${l.sheet_tab ? ` · from sheet tab "${l.sheet_tab}"` : ""}`),
      CAPS.leadLists));
  }

  if (canSee(role, "proposals") && snap.proposals?.length) {
    out.push(section("PROPOSALS", snap.proposals.map((p) => {
      const money = p.amount_cents ? `$${Math.round(p.amount_cents / 100).toLocaleString("en-US")}` : "no amount set";
      const when = p.decided_at ? `decided ${relDays(p.decided_at, now)}`
        : p.sent_at ? `sent ${relDays(p.sent_at, now)}`
          : `made ${relDays(p.created_at, now)}`;
      return `- ${p.title || p.package || "proposal"} · ${money} · ${p.status || "no status"} · ${when}`
        + `${p.lost_reason ? ` · lost because: ${short(p.lost_reason, 90)}` : ""}`;
    }), CAPS.proposals));
  }

  if (canSee(role, "money")) {
    /* Overdue is worked out from the dates and the amounts, never read from the
     * stored status — the same rule the Finance page follows, because only four
     * statuses are ever stored and "overdue" is not one of them. */
    const todayStr = teamDate(now);
    const live = (snap.invoices || []).filter((i) => i.status !== "void" && i.status !== "draft");
    const owedOf = (i) => Math.max(0, Number(i.total_cents || 0) - Number(i.amount_paid_cents || 0));
    const owed = live.reduce((sum, i) => sum + owedOf(i), 0);
    const overdue = live.filter((i) => owedOf(i) > 0 && i.due_date && String(i.due_date).slice(0, 10) < todayStr);
    const dollars = (cents) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
    out.push(section("MONEY — INVOICES",
      [
        `- Still owed to us across every sent invoice: ${dollars(owed)}.`,
        `- Sent invoices not paid in full and past their due date: ${overdue.length}`
          + `${overdue.length ? ` (${dollars(overdue.reduce((s, i) => s + owedOf(i), 0))})` : ""}.`,
        `- Drafts not sent yet: ${(snap.invoices || []).filter((i) => i.status === "draft").length}.`,
        ...live.slice(0, 20).map((i) => `- ${i.number} · ${i.bill_to_name} · ${dollars(i.total_cents)}`
          + ` · ${owedOf(i) > 0 ? `${dollars(owedOf(i))} still owed` : "paid in full"}`
          + `${i.due_date ? ` · due ${String(i.due_date).slice(0, 10)}` : ""}`),
      ], CAPS.invoices,
      "these are the invoices WE issued. There is no Stripe figure in here"));

    if (snap.payments?.length) {
      const paidTotal = snap.payments.reduce((sum, p) => sum + Number(p.amount_cents || 0), 0);
      const thisMonth = snap.payments.filter((p) => String(p.paid_on || "").slice(0, 7) === todayStr.slice(0, 7));
      out.push(section("MONEY — WHAT HAS ACTUALLY COME IN",
        [
          `- Collected across the payments read: ${dollars(paidTotal)}.`,
          `- Collected so far this calendar month: ${dollars(thisMonth.reduce((s, p) => s + Number(p.amount_cents || 0), 0))}`
            + ` across ${thisMonth.length} payment${thisMonth.length === 1 ? "" : "s"}.`,
          ...snap.payments.slice(0, 20).map((p) => `- ${String(p.paid_on || "").slice(0, 10)}`
            + ` · ${dollars(p.amount_cents)}${p.method ? ` · ${p.method}` : ""}`
            + `${p.note ? ` · ${short(p.note, 70)}` : ""}`),
        ], CAPS.payments,
        "these are payments recorded against OUR invoices, not Stripe"));
    }

    if (snap.expenses?.length) {
      const monthly = snap.expenses.filter((e) => e.interval === "monthly" && !e.ended_on);
      out.push(section("MONEY — WHAT WE SPEND",
        [
          `- Recurring monthly costs still running: ${monthly.length},`
            + ` ${dollars(monthly.reduce((s, e) => s + Number(e.amount_cents || 0), 0))} a month.`,
          ...snap.expenses.slice(0, 20).map((e) => `- ${e.vendor || "unnamed"} · ${e.category || "no category"}`
            + ` · ${dollars(e.amount_cents)} ${e.interval === "monthly" ? "a month" : "one-off"}`
            + ` · from ${String(e.incurred_on || "").slice(0, 10)}${e.ended_on ? ` to ${String(e.ended_on).slice(0, 10)}` : ""}`),
        ], CAPS.expenses));
    }
  }

  if (canSee(role, "clientReports") && snap.clientReports?.length) {
    out.push(section("WHAT WE HAVE ALREADY WRITTEN ABOUT EACH CLIENT (newest first — the headline only)",
      snap.clientReports.map((r) => {
        /* First real line only. A full report runs to 1,200 words and twenty of
         * them would BE the prompt.
         *
         * `summary || body`, and headings skipped: since Aug 23 2026 a report is
         * ONE answer, so `summary` is empty on every new row and reading it
         * alone left the assistant with a title and no content. */
        const first = short(
          String(r.summary || r.body || "")
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l && !/^#{1,6}\s/.test(l)) || "",
          180,
        );
        return `- ${cn(r.client_id) || "unknown client"} · ${relDays(r.created_at, now)}`
          + ` · ${r.source === "written" ? "AI-written" : "counted"}`
          + `${r.title ? ` · "${short(r.title, 90)}"` : ""}${first ? ` · ${first}` : ""}`
          + `${r.rejected_why ? " · (the written draft was thrown away)" : ""}`;
      }), CAPS.clientReports,
      "do NOT repeat these as new findings. They are what we said before"));
  }

  if (canSee(role, "platformAccounts") && snap.platformAccounts?.length) {
    out.push(section("PLATFORM LOGINS WE HOLD (which accounts exist — never the passwords)",
      snap.platformAccounts.map((a) => `- ${cn(a.client_id) || "ours"} · ${a.label || "account"}`
        + `${a.email ? ` · ${a.email}` : ""}${a.plan ? ` · ${a.plan}` : ""}`
        + `${a.active === false ? " · NOT ACTIVE" : ""}`), CAPS.platformAccounts));
  }

  /* What this snapshot CANNOT answer, said in the context block itself. Without
   * it the AI treats an absent subject as an absent fact — the difference
   * between "no GEO scores" and "we hold no GEO scores". */
  out.push(`## WHAT THESE RECORDS CANNOT ANSWER
- Anything from the AI Syndicate platform itself. This console holds NO scan results, NO citation history, NO module state and NO GEO score for a paying client. The only platform number anywhere in here is the 0-100 website score on a sales firm, and only where one has been run.
- Money taken through Stripe. Subscriptions and payments live in Stripe; the invoices above are the ones we issued ourselves.
- Anything nobody wrote down. A call that was never logged did not happen as far as these rows are concerned.
- The TEXT of any email. We store the subject, the sender, a one-line snippet and the status — the message bodies live in Gmail and are not in this console. Never quote an email body; quote the snippet and say it is a snippet.`);

  return out.join("\n\n");
}

/** Extra detail on the one record the person is looking at. Small on purpose:
 * the point is the thing in front of them, not a second copy of everything. */
export function renderFocus(snap, screen) {
  if (!screen) return "";
  const bits = [`# WHAT THEY ARE LOOKING AT`, `Page: ${screen.page || "unknown"}`];
  if (screen.label) bits.push(`On screen: ${short(screen.label, 120)}`);
  if (screen.record?.type) {
    bits.push(`Open record: ${screen.record.type} — ${short(screen.record.label || screen.record.id, 120)}`);
  }
  if (Array.isArray(screen.visible) && screen.visible.length) {
    bits.push(`Rows visible to them right now (${screen.visible.length}): `
      + screen.visible.slice(0, 25).map((v) => short(v, 60)).join(" · "));
  }
  bits.push(`When they say "this one", "here", or "that", they mean what is above.`);
  return bits.join("\n");
}
