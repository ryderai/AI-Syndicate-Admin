import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import {
  getMyWork, listAiNotes, listTasks, listEmailThreads, listTickets, listLeads,
  listAllLeadActivity, touchCountsByLead, listUsage, listActivity,
  upsertTask, upsertReminder, setNoteStatus,
  NOTE_CATEGORY_LABELS, TASK_STATUS_LABELS,
} from "../../lib/data.js";
/* The Sales rebuild (Aug 21-22 2026) moved every "who owes a contact" judgement
 * into one pure file. Overview imports it rather than keeping its own copy: the
 * old lead logic in getMyWork() — stale-after-N-days-per-stage — predates the
 * claim windows, the cold clock and the cadence, so a snapshot built on it
 * would have quietly disagreed with the Sales page's My Day about who is owed
 * a call. Their rule, one place. */
import { salesQueue, isOpenStage } from "../../../lib/sales-rules.js";
import { listInvoices } from "../../lib/finance.js";
import { invoiceOutstandingCents } from "../../../lib/finance-math.js";
import { teamDate } from "../../../lib/brain-context.js";
import {
  teamDayStartOf, teamDayEndOf, dueLabel, taskBucket, parsedOr0,
} from "../../lib/teamDay.js";
import { toast } from "../../lib/toast.js";
import { useScreenContext } from "../../lib/screenContext.js";
import {
  SourceBadge, SectionHeader, EmptyState, Modal, fmtMoney, timeAgo, useHealth,
} from "./shared.jsx";
import ConsoleReportsPanel, { useConsoleReports } from "./consoleReports.jsx";

/* OVERVIEW — the snapshot you open first.
 *
 * This page used to be the money page. Finance took that job on Aug 20 2026,
 * so this is now one screen that answers "what do I need to know right now":
 * your day, the things the console noticed for you, the state of the agency,
 * one line of money, and what changed.
 *
 * Three rules keep it honest:
 *   1. Nothing here is a list you work through. Every block is capped, and
 *      every block links to the page that owns it. Work is still where you
 *      grind; this is where you look.
 *   2. The only actions allowed inline are the one-click ones. Anything that
 *      needs a form sends you to the page that owns it.
 *   3. A read that failed says so. It never renders as a zero. Every label on
 *      this page describes exactly what the code counted — no more.
 */

/** Never lets a sentence read "1 things". */
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/* Tasks and reminders are re-bucketed here, on the team calendar, rather than
 * trusting the buckets getMyWork() attached — those are computed on whatever
 * clock the browser happens to have, so at 00:30 in New York a task due today
 * arrived pre-labelled "overdue" while the pill beside it read TODAY. The maths
 * lives in src/lib/teamDay.js and is tested in five timezones. */

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

function Pill({ children, tone, bg }) {
  return (
    <span style={{
      padding: "2px 8px", borderRadius: 4, background: bg, color: tone,
      fontSize: 9.5, fontWeight: 800, fontFamily: "var(--mono)",
      letterSpacing: "0.06em", whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

/** A number you can click. Zero is grey — a quiet page should look quiet. */
function CounterTile({ label, value, hint, tone, onClick, title, broken }) {
  const hot = !broken && Number(value) > 0;
  return (
    <button
      className="card"
      onClick={onClick}
      title={title}
      style={{
        padding: 14, textAlign: "left", cursor: "pointer", display: "block",
        width: "100%", border: "1px solid var(--rule)", background: "white",
        fontFamily: "var(--body)",
      }}
    >
      <div className="label">{label}</div>
      <div style={{
        fontFamily: "var(--display)", fontSize: 28, fontWeight: 700, lineHeight: 1.05,
        marginTop: 6, color: hot ? tone : "var(--ink-dim)",
      }}>{broken ? "—" : value}</div>
      <div style={{ fontSize: 11.5, color: broken ? "var(--danger)" : "var(--ink-dim)", marginTop: 3, lineHeight: 1.4 }}>
        {broken ? "couldn't read this" : hint}
      </div>
    </button>
  );
}

/** Header for a block, with the count of what the block is actually showing. */
function BlockHead({ title, count, capped, onSeeAll, seeAllLabel }) {
  return (
    <div style={{
      padding: "14px 18px 10px", display: "flex", alignItems: "center",
      justifyContent: "space-between", gap: 10, flexWrap: "wrap",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div className="label" style={{ marginBottom: 0 }}>{title}</div>
        {count > 0 && (
          <span style={{ fontSize: 11.5, color: "var(--ink-dim)", fontFamily: "var(--mono)" }}>
            {capped ? `showing ${capped} of ${count}` : count}
          </span>
        )}
      </div>
      {onSeeAll && (
        <button
          onClick={onSeeAll}
          style={{
            background: "none", border: 0, padding: 0, cursor: "pointer",
            color: "var(--accent-deep)", fontSize: 12, fontWeight: 600,
            fontFamily: "var(--body)",
          }}
        >{seeAllLabel || "See all"} →</button>
      )}
    </div>
  );
}

/* Urgency runs 3 → 1, most urgent first. That is the direction the database
 * check constraint, notes-engine.js and the AI Notes page all use; reading it
 * the other way round put the calm notes on top and hid the urgent ones behind
 * the "6 more" link. */
const NOTE_TONE = {
  3: { tone: "#b42318", bg: "#fef3f2" },
  2: { tone: "#b54708", bg: "#fffaeb" },
  1: { tone: "var(--ink-dim)", bg: "var(--bg-3)" },
};

/* ------------------------------------------------------------------ */

export default function Overview({ member, setSection }) {
  const userId = member?.user_id || null;
  const go = typeof setSection === "function" ? setSection : () => {};

  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState(() => new Set());
  const [moneyOpen, setMoneyOpen] = useState(false);
  /* The generator owns its own reads: it is the one block on this page whose
   * list changes because of something you did rather than something that
   * happened, so folding it into the snapshot's load would mean re-reading the
   * whole console every time you wrote a sentence. */
  const consoleReports = useConsoleReports();
  const health = useHealth();

  /* Loads are numbered so a slow one that started earlier can never overwrite
   * a fast one that started later — three inline actions in a row used to be
   * able to leave the page showing the oldest of the three snapshots. */
  const loadSeq = useRef(0);
  /* "unread" is a real state, not a stand-in for preview. An inline action
   * reloads without calling Stripe, and that used to publish the initial
   * "unknown" while the first Stripe call was still in flight — the card then
   * said "preview mode" with a WAITING badge on a live console, and stayed
   * that way until someone pressed Refresh. */
  const stripeRef = useRef({ state: "unread", data: null });

  const markBusy = (id, on) => setBusy((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const load = useCallback(async ({ withStripe = true } = {}) => {
    const seq = ++loadSeq.current;
    try {
      /* Everything the snapshot needs, in one round of parallel reads. */
      const [work, aiNotes, allTasks, emails, tickets, leads, leadActivity, usage, activity, invoices] =
        await Promise.all([
          getMyWork(userId),
          listAiNotes({ statuses: ["open"] }),
          listTasks(),
          listEmailThreads({}),
          listTickets(),
          listLeads(),
          // 90 days, the same window getSalesBoard() reads, so a cadence step
          // cannot be counted here and missed there.
          listAllLeadActivity(90),
          listUsage(40),
          listActivity(8),
          listInvoices(),
        ]);

      /* Stripe is the only server call. It is skipped in preview mode, because
       * apiFetch short-circuits there, and skipped after an inline action, so
       * ticking a reminder does not re-page the whole subscription list — but
       * never skipped while we still have no answer at all. */
      let stripe = stripeRef.current;
      if (!isConfigured()) {
        stripe = { state: "preview", data: null };
      } else if (withStripe || stripe.state === "unread") {
        const res = await apiFetch("/api/stripe-metrics");
        if (res.ok && res.data?.configured) stripe = { state: "live", data: res.data, at: Date.now() };
        else if (res.ok) stripe = { state: "nokey", data: null };
        else stripe = { state: "failed", data: null, error: res.error };
      }

      if (seq !== loadSeq.current) return; // a newer load is already in flight
      stripeRef.current = stripe;
      setLoadError(null);
      setNowMs(Date.now());
      setData({
        work, aiNotes, allTasks, emails, tickets, leads, leadActivity, usage, activity, invoices, stripe,
      });
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setLoadError(err?.message || String(err));
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  /* The clock has to move on its own, or a dashboard left open overnight keeps
   * yesterday's date in the banner and calls today's tasks late. */
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  /* ---------------- derived, all counted ---------------- */

  const view = useMemo(() => {
    if (!data) return null;
    const { work, aiNotes, allTasks, emails, tickets, leads, leadActivity, usage, activity, invoices, stripe } = data;

    /* A read that failed is named, not rendered as a zero. */
    const problems = [];
    const fail = (label, res) => {
      if (res?.error) { problems.push({ label, error: res.error }); return true; }
      return false;
    };
    const notesBroken = fail("what the console noticed", aiNotes);
    const tasksBroken = fail("client tasks", allTasks);
    const emailsBroken = fail("the mailbox", emails);
    const ticketsBroken = fail("tickets", tickets);
    const leadsBroken = fail("leads", leads) || fail("lead call history", leadActivity);
    const usageBroken = fail("AI usage", usage);
    const invoicesBroken = fail("invoices", invoices);
    const activityBroken = fail("the activity log", activity);
    /* getMyWork collapses six reads into one error, so name all six rather than
     * blaming tasks for a client read that failed. */
    const workBroken = Boolean(work.error);
    if (workBroken) {
      problems.push({
        label: "your clients, tasks, leads, tickets, reminders or call history",
        error: work.error,
      });
    }

    const today = teamDate(nowMs);
    const thisMonth = today.slice(0, 7);
    const endToday = teamDayEndOf(today);

    // --- your day, re-bucketed on the team calendar ---
    const myTasks = (work.tasks || []).map((t) => {
      const ymd = t.due_date ? String(t.due_date).slice(0, 10) : null;
      return { ...t, bucket: taskBucket(t, nowMs), dueEndMs: ymd ? teamDayEndOf(ymd) : null };
    });
    const counts = {
      overdue: myTasks.filter((t) => t.bucket === "overdue").length,
      today: myTasks.filter((t) => t.bucket === "today").length,
      blocked: myTasks.filter((t) => t.bucket === "blocked").length,
      tickets: (work.tickets || []).length,
    };
    const doNow = myTasks
      .filter((t) => t.bucket === "overdue" || t.bucket === "today")
      .sort((a, b) => (a.dueEndMs || 0) - (b.dueEndMs || 0));
    const nextUpTasks = myTasks
      .filter((t) => t.bucket === "week")
      .sort((a, b) => (a.dueEndMs || 0) - (b.dueEndMs || 0));

    const openReminders = (work.reminders || []).filter((r) => !r.done_at).map((r) => {
      const at = Date.parse(r.due_at);
      const ok = !Number.isNaN(at);
      return {
        ...r,
        atMs: ok ? at : null,
        dueEndMs: ok ? teamDayEndOf(teamDate(at)) : null,
        // A reminder whose date will not parse is shown, not swallowed. It used
        // to fall out of both buckets and disappear while still being counted.
        due: ok ? at <= endToday : true,
        late: ok ? at < teamDayStartOf(today) : false,
      };
    });
    /* A row whose date will not parse sorts LAST, not first. Treating its null
     * as 0 put it ahead of a reminder six days late and handed it the START
     * HERE slot. It is still shown, still counted, just not promoted. */
    const byDue = (a, b) => (a.atMs ?? Number.MAX_SAFE_INTEGER) - (b.atMs ?? Number.MAX_SAFE_INTEGER);
    const remindersDue = openReminders.filter((r) => r.due).sort(byDue);
    const remindersSoon = openReminders.filter((r) => !r.due).sort(byDue);
    const remindersUndated = openReminders.filter((r) => r.atMs === null);

    // --- the agency ---
    const clients = work.clients || [];
    // "active" is a real column value: active | prospect | holding | closed.
    // The first version of this filtered on "paused", which does not exist, so
    // it counted prospects and closed accounts as active clients.
    const activeClients = clients.filter((c) => (c.status || "active") === "active");
    const emailRows = emails.rows || [];
    const needsReply = emailRows.filter((e) => e.status === "needs_reply" || e.status === "new");
    const ticketRows = tickets.rows || [];
    const openTickets = ticketRows.filter((t) => t.status === "open");
    const pendingTickets = ticketRows.filter((t) => t.status === "pending");

    const leadRows = leads.rows || [];
    /* isOpenStage is theirs — CLOSED_STAGES is won / lost / skip_90 / bad_contact.
     * Naming the OPEN stages here instead would have silently dropped every one
     * of the eight stages the Sales rebuild added. */
    const pipelineNew = leadRows.filter((l) => l.stage === "new");
    const pipelineWorking = leadRows.filter((l) => l.stage !== "new" && isOpenStage(l.stage));

    /* MY DAY, from the same function the Sales page uses, so the two cannot
     * disagree about who is owed a call.
     *
     * `touchCounts` uses THEIR touchCountsByLead over the same 90-day window
     * getSalesBoard reads. An earlier version of this counted the types itself
     * from the same documented list, which was right on the day and would have
     * drifted the first time somebody added a touch type in one place only.
     *
     * `scoreOf` returns null on purpose: site scores live on admin_companies,
     * and reading them here would mean a second full companies fetch on a page
     * that is meant to be one glance. So the 90-and-above skip gate does not
     * run here. It only applies at `new` and `researching`, so the effect is
     * bounded — Overview can count a very-high-scoring firm the Sales page
     * leaves out of those two stages. Said on the page, not hidden. */
    const touchCounts = touchCountsByLead(leadActivity.rows || []);
    const nowIso = new Date(nowMs).toISOString();
    const queue = salesQueue(leadRows, {
      userId, now: nowIso, touchCounts, includeUnclaimed: true, scoreOf: () => null,
    });
    /* The same expression SalesPage uses for its "owed" number, character for
     * character, so the tile here and the tile there are the same count. */
    const owed = queue.filter((c) => c.over !== null && c.over >= 0 && c.reason !== "unclaimed");
    const soon = queue.filter((c) => c.over !== null && c.over < 0 && c.reason !== "unclaimed");
    const unclaimed = queue.filter((c) => c.reason === "unclaimed");
    /* Leads that ARRIVED this month, counted off created_at. It used to say
     * "won this month", which the database cannot answer: there is no won_at
     * column, and last_activity_at moves whenever anyone logs anything. */
    const newThisMonth = leadRows.filter((l) =>
      l.created_at ? teamDate(parsedOr0(l.created_at)).slice(0, 7) === thisMonth : false);
    const wonAllTime = leadRows.filter((l) => l.stage === "won");

    /* The "clients that need attention" card was removed on Aug 23 2026 — the
     * other sections already name everyone who needs chasing — so the whole
     * per-client tally that fed it is gone with it rather than left to run
     * every 60 seconds for nobody. */

    // --- money, one line ---
    const outstandingCents = (invoices.rows || []).reduce((sum, inv) => sum + invoiceOutstandingCents(inv), 0);
    const usageRows = usage.rows || [];
    const aiSpendMonth = usageRows.reduce((sum, r) => {
      const t = Date.parse(r.ts);
      if (Number.isNaN(t)) return sum;
      return teamDate(t).slice(0, 7) === thisMonth ? sum + Number(r.cost_usd || 0) : sum;
    }, 0);

    // --- the one sentence at the top ---
    const bits = [];
    if (counts.overdue) bits.push(`${plural(counts.overdue, "task", "tasks")} late`);
    if (counts.today) bits.push(`${counts.today} due today`);
    if (remindersDue.length) bits.push(`${plural(remindersDue.length, "reminder", "reminders")} due`);
    if (owed.length) bits.push(`${plural(owed.length, "lead", "leads")} owed a contact`);
    if (counts.tickets) bits.push(`${plural(counts.tickets, "ticket", "tickets")} on you`);

    /* The START HERE headline went with the greeting banner on Aug 23 2026.
     * Nothing renders it, so nothing computes it. */

    const notes = (aiNotes.rows || []).slice()
      // 3 is the most urgent, so descending. Then newest first.
      .sort((a, b) => (b.urgency || 0) - (a.urgency || 0)
        || parsedOr0(b.generated_at || b.created_at) - parsedOr0(a.generated_at || a.created_at));

    return {
      sample: Boolean(work.sample),
      problems,
      broken: {
        notes: notesBroken, tasks: tasksBroken, emails: emailsBroken,
        tickets: ticketsBroken, leads: leadsBroken, usage: usageBroken,
        invoices: invoicesBroken, activity: activityBroken, work: workBroken,
      },
      counts, doNow, nextUpTasks,
      openReminders, remindersDue, remindersSoon, remindersUndated,
      owed, soon, unclaimed,
      notes, notesSample: Boolean(aiNotes.sample),
      activeClients, clientTotal: clients.length,
      needsReply, openTickets, pendingTickets,
      pipelineNew, pipelineWorking, newThisMonth, wonAllTime,
      leadsTruncated: leads.truncated || leadActivity.truncated || null,
      money: {
        stripeState: stripe.state,
        stripeAt: stripe.at || null,
        // "just now" / "4m ago" — so a figure left on screen after an inline
        // reload is dated rather than presented as this second's truth.
        stripeAgo: stripe.at ? timeAgo(stripe.at) : "",
        mrrCents: stripe.data ? stripe.data.mrrCents : null,
        stripeTruncated: Boolean(stripe.data?.truncated),
        stripeTestMode: stripe.data?.livemode === false,
        outstandingCents,
        aiSpendMonth,
        invoiceSample: Boolean(invoices.sample),
        usageSample: Boolean(usage.sample),
        noUsageYet: usageRows.length === 0,
      },
      bits,
    };
  }, [data, nowMs, userId]);

  /* Keyed on the summary text, not on `view`. `view` is a new object every 60s
   * when the clock ticks, and each new identity tore the context down and
   * rebuilt it — leaving a window every minute where the assistant, asked
   * about "this screen", could see nothing. */
  const ctxKey = view
    ? `${view.bits.join("|")}::${view.doNow.map((t) => t.id).join(",")}::${view.remindersDue.map((r) => r.id).join(",")}::${view.notes.map((n) => n.id).join(",")}`
    : "";
  useScreenContext(() => ({
    page: "Overview",
    label: view
      ? (view.bits.length ? `Snapshot — ${view.bits.join(", ")}` : "Snapshot — nothing is late or due")
      : "still loading",
    visible: view
      ? [
        ...view.doNow.slice(0, 8).map((t) => `task due: ${t.name}`),
        ...view.remindersDue.slice(0, 5).map((r) => `reminder due: ${r.body}`),
        ...view.owed.slice(0, 6).map((c) => `lead owed a contact: ${c.lead.name || c.lead.company} (${c.headline})`),
        ...view.notes.slice(0, 8).map((n) => `note: ${n.title}`),
      ]
      : [],
  }), [ctxKey]);

  /* ---------------- the three inline actions ---------------- */

  async function finishTask(task) {
    markBusy(task.id, true);
    const res = await upsertTask({ id: task.id, status: "done" });
    markBusy(task.id, false);
    if (!res.ok) return toast.error("Couldn't save that", res.error);
    toast.success("Done — nice", task.name);
    load({ withStripe: false });
  }

  async function tickReminder(r) {
    markBusy(r.id, true);
    const res = await upsertReminder({ id: r.id, done_at: new Date().toISOString() });
    markBusy(r.id, false);
    if (!res.ok) return toast.error("Couldn't tick that off", res.error);
    toast.success("Ticked off", r.body);
    load({ withStripe: false });
  }

  async function dismissNote(n) {
    markBusy(n.id, true);
    const res = await setNoteStatus(n.id, "dismissed", userId);
    markBusy(n.id, false);
    if (!res.ok) return toast.error("Couldn't dismiss that", res.error);
    toast.info("Dismissed", n.title);
    load({ withStripe: false });
  }

  /* ---------------- render ---------------- */

  if (loadError) {
    return (
      <div className="card" style={{ padding: 28 }}>
        <div className="label" style={{ color: "var(--danger)" }}>THIS PAGE DIDN&apos;T LOAD</div>
        <div style={{ fontSize: 14, color: "var(--ink)", marginTop: 8, lineHeight: 1.6 }}>
          Nothing on the snapshot could be read, so nothing is shown rather than a screen of zeros.
        </div>
        <div style={{
          fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-dim)", marginTop: 10,
          padding: 12, borderRadius: 8, background: "var(--bg-3)", overflowX: "auto",
        }}>{loadError}</div>
        <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => load()}>Try again</button>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--ink-dim)" }}>
        Putting your snapshot together…
      </div>
    );
  }

  const dayBroken = view.broken.work;
  const m = view.money;
  const moneyMode = m.stripeState === "live" ? "live"
    : m.stripeState === "preview" ? "sample"
      : m.stripeState === "failed" ? "error" : "waiting";

  return (
    <>
      {/* ---------------- WHAT DIDN'T LOAD ---------------- */}
      {view.problems.length > 0 && (
        <div className="card" style={{ padding: "14px 18px", border: "1px solid var(--danger)", background: "#fef3f2" }}>
          <div className="label" style={{ color: "var(--danger)" }}>SOME OF THIS PAGE IS MISSING</div>
          <div style={{ fontSize: 13, color: "var(--ink)", marginTop: 6, lineHeight: 1.6 }}>
            These reads failed, so their numbers show a dash instead of a zero. A zero here would have
            read as good news.
          </div>
          <ul style={{ margin: "8px 0 0", paddingLeft: 20, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.7 }}>
            {view.problems.map((p, i) => (
              <li key={i}><strong>{p.label}</strong> — <span style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>{p.error}</span></li>
            ))}
          </ul>
          <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => load()}>Try again</button>
        </div>
      )}

      {/* ---------------- ASK FOR ANYTHING ---------------- */}
      {/* First on the page. Ryder, Aug 23 2026: "put this card at the top of
        * the page." It stays BELOW the red "some of this page is missing" panel,
        * so nothing comes between a failed read and its reason.
        *
        * No section header: collapsed this is one strip. */}
      <ConsoleReportsPanel reports={consoleReports} aiReady={Boolean(health?.ai)} />

      {/* ---------------- YOUR NUMBERS ---------------- */}
      <SectionHeader kicker="Yours" title="Your day right now" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: -6 }}>
        <CounterTile
          broken={dayBroken}
          label="Late" value={view.counts.overdue} hint="past their due date"
          tone="#b42318" onClick={() => go("work")} title="Open the Work page"
        />
        <CounterTile
          broken={dayBroken}
          label="Due today" value={view.counts.today} hint="finish these"
          tone="#b54708" onClick={() => go("work")} title="Open the Work page"
        />
        <CounterTile
          broken={dayBroken}
          label="Reminders due" value={view.remindersDue.length}
          hint={view.remindersUndated.length
            ? `today or earlier, Central time · ${view.remindersUndated.length} with an unreadable date`
            : "today or earlier, Central time"}
          tone="#6941c6" onClick={() => go("work")} title="Open the Work page"
        />
        <CounterTile
          broken={view.broken.leads}
          label="Leads owed a contact" value={view.owed.length}
          hint={view.soon.length
            ? `${view.soon.length} more going cold or due soon`
            : "expired claims, cold firms, and touches past due"}
          tone="var(--accent-deep)" onClick={() => go("sales")} title="Open the Sales page"
        />
        <CounterTile
          broken={dayBroken}
          label="Tickets on you" value={view.counts.tickets} hint="open or pending, assigned to you"
          tone="#0e7490" onClick={() => go("tickets")} title="Open the Tickets page"
        />
      </div>

      {/* ---------------- THE AGENCY ---------------- */}
      <SectionHeader
        kicker="The agency"
        title="Where everything stands"
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: -6 }}>
        <CounterTile
          label="Active clients" value={view.activeClients.length}
          hint={`of ${plural(view.clientTotal, "client", "clients")} on the books`}
          tone="var(--ink)" broken={dayBroken} onClick={() => go("operations")} title="Open Operations"
        />
        <CounterTile
          label="Emails needing a reply" value={view.needsReply.length}
          hint="new or needs-reply · every mailbox" tone="#b54708" broken={view.broken.emails}
          onClick={() => go("inbox")} title="Open the Inbox"
        />
        <CounterTile
          label="Open tickets" value={view.openTickets.length}
          hint={view.pendingTickets.length
            ? `${view.pendingTickets.length} pending too · whole team`
            : "whole team · none pending"} tone="#0e7490"
          broken={view.broken.tickets} onClick={() => go("tickets")} title="Open Tickets"
        />
        <CounterTile
          label="Pipeline" value={view.pipelineNew.length + view.pipelineWorking.length}
          hint={`${view.pipelineNew.length} new · ${view.pipelineWorking.length} working`}
          tone="var(--accent-deep)" broken={view.broken.leads}
          onClick={() => go("sales")} title="Open Sales"
        />
        <CounterTile
          label="New leads this month" value={view.newThisMonth.length}
          hint={`arrived since the 1st · ${plural(view.wonAllTime.length, "win", "wins")} on the books`} tone="#0ca30c"
          broken={view.broken.leads} onClick={() => go("sales")} title="Open Sales"
        />
      </div>

      <div style={{ fontSize: 11.5, color: "var(--ink-dim)", lineHeight: 1.6, marginTop: -4 }}>
        Counted from the newest 400 emails, 500 tasks and 5,000 AI calls. Past those limits the real
        number is higher.{view.leadsTruncated ? ` ${view.leadsTruncated}` : ""}
        <br />
        <strong style={{ color: "var(--ink-2)" }}>Leads owed a contact</strong> uses the Sales
        page&apos;s own rules and the same 90 days of call history. One gap: it cannot read site
        scores here, so unlike Sales it does not skip firms already scoring 90 or more.
      </div>

      {/* ---------------- YOUR DAY ---------------- */}
      {/* auto-fit, not two fixed columns: the old Overview used a class
        * (.adm-charts-row) that no stylesheet ever defined, so its two columns
        * never collapsed on a narrow window. alignItems:start stops the shorter
        * card stretching to match the taller one. */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        gap: 16, alignItems: "start",
      }}>
        {/* Tasks */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <BlockHead
            title="Do these today"
            count={view.doNow.length}
            capped={view.doNow.length > 6 ? 6 : null}
            onSeeAll={() => go("work")}
            seeAllLabel="All your tasks"
          />
          {view.doNow.length === 0 ? (
            <div style={{ padding: "4px 18px 20px", fontSize: 13, color: dayBroken ? "var(--ink-2)" : "var(--ink-dim)", lineHeight: 1.6 }}>
              {dayBroken
                ? "Your tasks could not be read, so this is empty for a reason, not because there is nothing to do. See the red panel above."
                : "Nothing of yours is late or due today."}
              {!dayBroken && view.nextUpTasks.length
                ? ` Next up: ${view.nextUpTasks[0].name} — ${dueLabel(view.nextUpTasks[0].dueEndMs, nowMs)}.`
                : " Nothing is due this week either."}
            </div>
          ) : (
            <div>
              {view.doNow.slice(0, 6).map((t) => (
                <div
                  key={t.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "11px 18px",
                    borderTop: "1px solid var(--line)", flexWrap: "wrap",
                  }}
                >
                  <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{t.name}</div>
                    <div style={{
                      fontSize: 11.5, color: "var(--ink-dim)", marginTop: 3,
                      display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center",
                    }}>
                      <Pill
                        tone={t.bucket === "overdue" ? "#b42318" : "#b54708"}
                        bg={t.bucket === "overdue" ? "#fef3f2" : "#fffaeb"}
                      >{dueLabel(t.dueEndMs, nowMs).toUpperCase()}</Pill>
                      {t.client_name && <span>{t.client_name}</span>}
                      {t.priority === "high" && <><span>·</span><span style={{ color: "#b42318", fontWeight: 700 }}>high</span></>}
                      {t.status !== "todo" && <><span>·</span><span>{TASK_STATUS_LABELS[t.status] || t.status}</span></>}
                    </div>
                  </div>
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy.has(t.id)}
                    onClick={() => finishTask(t)}
                  >Done</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Reminders */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <BlockHead
            title="Reminders due"
            count={view.remindersDue.length}
            capped={view.remindersDue.length > 6 ? 6 : null}
            onSeeAll={() => go("work")}
            seeAllLabel="All reminders"
          />
          {view.remindersDue.length === 0 ? (
            <div style={{ padding: "4px 18px 16px", fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.6 }}>
              {dayBroken
                ? "Your reminders could not be read. See the red panel above."
                : view.openReminders.length === 0
                ? "You have no open reminders. Set one on the Work page for anything you would otherwise keep in your head."
                  : `Nothing is due today. You have ${plural(view.openReminders.length, "reminder", "reminders")} set for later.`}
            </div>
          ) : (
            <div>
              {view.remindersDue.slice(0, 6).map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "11px 18px",
                    borderTop: "1px solid var(--line)", flexWrap: "wrap",
                  }}
                >
                  <button
                    onClick={() => tickReminder(r)}
                    disabled={busy.has(r.id)}
                    title="Tick off"
                    role="checkbox"
                    aria-checked="false"
                    aria-label={`Tick off: ${r.body}`}
                    style={{
                      width: 20, height: 20, flex: "0 0 auto", borderRadius: 5,
                      cursor: "pointer", border: "1.5px solid var(--rule)", background: "white",
                    }}
                  />
                  <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, color: "var(--ink)" }}>{r.body}</div>
                    <div style={{
                      fontSize: 11.5, marginTop: 3, fontWeight: 700,
                      color: r.late ? "#b42318" : "#b54708",
                    }}>{r.atMs === null ? "the date on this one won't read — open it on Work" : dueLabel(r.dueEndMs, nowMs)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {view.remindersSoon.length > 0 && (
            <div style={{
              padding: "10px 18px 16px", borderTop: "1px solid var(--line)",
              fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.6,
            }}>
              <strong style={{ color: "var(--ink-2)" }}>Coming up:</strong>{" "}
              {view.remindersSoon.slice(0, 3).map((r) => `${r.body} (${dueLabel(r.dueEndMs, nowMs)})`).join(" · ")}
              {view.remindersSoon.length > 3 ? ` · and ${view.remindersSoon.length - 3} more` : ""}
            </div>
          )}
        </div>
      </div>

      {/* ---------------- WHAT THE CONSOLE NOTICED ---------------- */}
      <SectionHeader
        kicker="You should know"
        title="What the console noticed"
        subtitle="Late follow-ups, quiet clients, emails nobody answered. Each card says whether it was counted from our rows or written by the AI, and every one points at the record it came from."
        right={<SourceBadge mode={view.broken.notes ? "error" : view.notesSample ? "sample" : "live"} />}
      />
      {view.broken.notes ? (
        <div className="card" style={{ padding: 20, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
          These notes could not be read, so none are shown. The reason is in the red panel above.
        </div>
      ) : view.notes.length === 0 ? (
        <EmptyState
          icon="◎"
          title="Nothing flagged right now"
          body="Notes appear here on their own when something goes quiet or slips. The full list, including ones already handled, lives on the AI Notes page."
          action={<button className="btn" onClick={() => go("notes")}>Open AI Notes</button>}
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12, marginTop: -6 }}>
          {view.notes.slice(0, 6).map((n) => {
            const t = NOTE_TONE[n.urgency] || NOTE_TONE[1];
            return (
              <div key={n.id} className="card" style={{ padding: 15, display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                  <Pill tone={t.tone} bg={t.bg}>
                    {(NOTE_CATEGORY_LABELS[n.category] || n.category || "note").toUpperCase()}
                  </Pill>
                  <span style={{ fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>
                    {/* Three values live in the column, not two: a note a person
                      * typed used to be labelled AI-WRITTEN. */}
                    {n.written_by === "counted" ? "COUNTED"
                      : n.written_by === "person" ? "WRITTEN BY A PERSON"
                        : n.written_by === "ai_written" ? "AI-WRITTEN" : "SOURCE UNKNOWN"}
                  </span>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", lineHeight: 1.4 }}>{n.title}</div>
                {n.body && (
                  <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.6, flex: 1 }}>{n.body}</div>
                )}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
                  <span style={{ fontSize: 10.5, color: "var(--ink-dim)", fontFamily: "var(--mono)" }}>
                    {timeAgo(n.generated_at || n.created_at)}
                    {(n.evidence || []).length ? ` · ${plural(n.evidence.length, "record", "records")}` : ""}
                  </span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-sm" onClick={() => go("notes")}>Open</button>
                    <button className="btn btn-sm" disabled={busy.has(n.id)} onClick={() => dismissNote(n)}>Dismiss</button>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {view.notes.length > 6 && (
        <button
          onClick={() => go("notes")}
          style={{
            background: "none", border: 0, padding: 0, cursor: "pointer", marginTop: -4,
            color: "var(--accent-deep)", fontSize: 12.5, fontWeight: 600, fontFamily: "var(--body)",
          }}
        >{plural(view.notes.length - 6, "more note", "more notes")} on the AI Notes page →</button>
      )}


      {/* ---------------- MONEY, ONE LINE ---------------- */}
      <div className="card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 26, flexWrap: "wrap" }}>
            <div>
              <div className="label" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                Recurring revenue <SourceBadge mode={moneyMode} />
              </div>
              <div style={{ fontFamily: "var(--display)", fontSize: 22, fontWeight: 700, marginTop: 4 }}>
                {m.mrrCents === null ? "—" : `${fmtMoney(m.mrrCents)}/mo`}
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-dim)", marginTop: 2 }}>
                {m.stripeState === "live"
                  ? (m.stripeTruncated ? `from Stripe ${m.stripeAgo} · capped at 1,000 rows, so this reads low`
                    : m.stripeTestMode ? `from Stripe ${m.stripeAgo} · test-mode key`
                      : `measured from Stripe ${m.stripeAgo}, trials included`)
                  : m.stripeState === "failed" ? "the Stripe call failed — hit Refresh"
                    : m.stripeState === "nokey" ? "needs the Stripe key"
                      : m.stripeState === "preview" ? "preview mode — no Stripe call made"
                        : "not read yet — hit Refresh"}
              </div>
            </div>
            <div>
              <div className="label" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                Still owed to us <SourceBadge mode={view.broken.invoices ? "error" : m.invoiceSample ? "sample" : "live"} />
              </div>
              <div style={{ fontFamily: "var(--display)", fontSize: 22, fontWeight: 700, marginTop: 4 }}>
                {view.broken.invoices ? "—" : fmtMoney(m.outstandingCents)}
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-dim)", marginTop: 2 }}>
                {view.broken.invoices ? "invoices couldn't be read" : "sent invoices, not paid in full"}
              </div>
            </div>
            <div>
              <div className="label" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                AI spend this month <SourceBadge mode={view.broken.usage ? "error" : m.usageSample ? "sample" : m.noUsageYet ? "waiting" : "live"} />
              </div>
              <div style={{ fontFamily: "var(--display)", fontSize: 22, fontWeight: 700, marginTop: 4 }}>
                {view.broken.usage || m.noUsageYet ? "—"
                  : `$${m.aiSpendMonth.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-dim)", marginTop: 2 }}>
                {view.broken.usage ? "usage couldn't be read"
                  : m.noUsageYet ? "no usage reported yet"
                    : m.usageSample ? "sample feed, not real spend" : "from the usage feed"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setMoneyOpen(true)}>What are these?</button>
            <button className="btn btn-primary" onClick={() => go("finance")}>Open Finance →</button>
          </div>
        </div>
      </div>

      {/* ---------------- WHAT CHANGED ---------------- */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <BlockHead title="What changed lately" count={(data.activity.rows || []).length} />
        {(data.activity.rows || []).length === 0 ? (
          <div style={{ padding: "4px 18px 20px", fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.6 }}>
            {data.activity.error
              ? "The activity log could not be read."
              : "Nothing logged yet. Calls, task updates and imports land here on their own as the team works."}
          </div>
        ) : (
          <div style={{ padding: "0 18px 14px", maxHeight: 300, overflowY: "auto" }}>
            {data.activity.rows.map((a) => (
              <div key={a.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{a.title}</div>
                {a.body && <div style={{ fontSize: 12, color: "var(--ink-dim)", marginTop: 2 }}>{a.body}</div>}
                <div style={{
                  fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--mono)",
                  marginTop: 4, letterSpacing: "0.04em",
                }}>{timeAgo(a.created_at).toUpperCase()}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------------- JUMP IN ---------------- */}
      <SectionHeader kicker="Jump in" title="Where the work happens" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14, marginTop: -8 }}>
        {[
          ["work", "Your work", "Every task, reminder and note with your name on it."],
          ["sales", "Sales", "Work the pipeline, log calls, import lists."],
          ["operations", "Operations", "Clients, tasks and weekly logs."],
          ["inbox", "Inbox", "The shared team mailbox."],
        ].map(([id, title, body]) => (
          <button
            key={id}
            onClick={() => go(id)}
            className="card"
            style={{
              padding: 17, textAlign: "left", cursor: "pointer",
              border: "1px solid var(--rule)", background: "white", fontFamily: "var(--body)",
            }}
          >
            <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--ink)" }}>
              {title} <span style={{ color: "var(--accent-deep)" }}>→</span>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 4, lineHeight: 1.5 }}>{body}</div>
          </button>
        ))}
      </div>

      {/* ---------------- money explainer ---------------- */}
      <Modal
        open={moneyOpen}
        onClose={() => setMoneyOpen(false)}
        kicker="MONEY ON THIS PAGE"
        title="What these three numbers mean"
        width={620}
      >
        <p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.7 }}>
          <strong>Recurring revenue</strong> is what our live subscriptions add up to each month, read
          straight from Stripe. It includes anyone still in a free trial. The Finance page keeps trials
          on their own line, so its figure reads lower until a trial starts paying.
        </p>
        <p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.7, marginTop: 12 }}>
          <strong>Still owed to us</strong> adds up every invoice we have sent and not been paid in full
          for. Drafts and voided invoices are left out, because nobody owes us for those yet. This is
          the same figure, from the same function, as the Finance page headline — if the two ever differ,
          one of them is broken.
        </p>
        <p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.7, marginTop: 12 }}>
          <strong>AI spend this month</strong> is what we have paid for AI calls since the 1st. It comes
          from the usage feed, so it reads a dash until the platform starts posting to it.
        </p>
        <p style={{ fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.6, marginTop: 14 }}>
          Every date on this page is counted on the team&apos;s calendar (Central time), including the
          month boundary above. The Finance page counts its months on your computer&apos;s clock, so on
          the 1st the two AI-spend figures can differ by a few hours&apos; worth of calls.
        </p>
        <p style={{ fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.6, marginTop: 10 }}>
          None of these three is profit. Wages, software and ad spend are on the Finance page.
        </p>
      </Modal>
    </>
  );
}
