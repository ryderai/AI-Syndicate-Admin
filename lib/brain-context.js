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

/* Hard caps. Raising these raises the bill on every single AI call in the
 * console, so they are named and gathered rather than sprinkled inline. */
export const CAPS = {
  clients: 40,
  tasks: 120,
  leads: 90,
  leadsRecent: 25,   // a second, small read so recent wins are not sorted out
  leadActivity: 60,
  tickets: 30,
  emails: 45,
  reminders: 40,
  weekly: 40,
  sites: 60,
  memory: 60,
  brain: 60,
  notes: 40,
  team: 25,
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
    "emails", "reminders", "sites", "brain", "memory", "notes", "team", "money"],
  admin: ["clients", "tasks", "weekly", "leads", "leadActivity", "leadSources", "tickets",
    "emails", "reminders", "sites", "brain", "memory", "notes", "team", "money"],
  sales: ["leads", "leadActivity", "leadSources", "reminders", "team"],
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
  if (has("emails")) take("emails", "admin_email_threads", (q) =>
    q.in("status", ["needs_reply", "waiting", "scheduled"])
      .order("last_message_at", { ascending: false }).limit(fetchCap(CAPS.emails)));
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

  await Promise.all(jobs);

  for (const k of ["clients", "tasks", "weekly", "leads", "leadActivity", "leadSources", "tickets",
    "emails", "reminders", "sites", "brain", "memory", "notes", "team"]) {
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
      .filter((l) => !["won", "lost"].includes(l.stage))
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

  if (canSee(role, "emails") && snap.emails?.length) {
    out.push(section("EMAIL THREADS NOT FINISHED", snap.emails.map((e) =>
      `- [${e.status}] "${short(e.subject, 80)}" from ${e.from_name || e.from_email || "?"}`
      + ` — ${cn(e.client_id) || "no client linked"}, ${who(e.assigned_to)}, last message ${relDays(e.last_message_at, now)}`
      + `${e.priority === "high" ? ", HIGH" : ""}${e.notes ? `. Team note: ${short(e.notes, 100)}` : ""}`), CAPS.emails));
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
