import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listClients, upsertClient, listTasks, upsertTask, deleteTask,
  listWeekly, upsertWeekly, listTeam, logActivity, listClientSites, listEmailThreads,
  CLIENT_STAGES, TASK_STATUSES, TASK_STATUS_LABELS,
  TASK_CATEGORIES, TASK_PHASES, TASK_PRIORITIES, TASK_PRIORITY_LABELS,
} from "../../lib/data.js";
import { toast } from "../../lib/toast.js";
import { StandingCard, SitesPanel } from "./clientPage.jsx";
import { PlatformAccountsPanel, usePlatformAccounts } from "./platformAccounts.jsx";
import {
  SourceBadge, Modal, Field, TextInput, TextArea, Select, EmptyState, Explainer,
} from "./shared.jsx";
import TaskDatabase, {
  TaskBoard, COLUMNS, DEFAULT_COLUMNS, GROUP_OPTIONS, plusDaysISO, isOverdue, isGroupBy,
} from "./opsTable.jsx";
import { Popover, PRIORITY_ICON } from "./opsCells.jsx";
import { useScreenContext } from "../../lib/screenContext.js";

/* Operations — the Notion replacement, in Notion's own shape.
 *
 * One database of tasks with views over the top of it, exactly like the
 * Operations table in Notion: All tasks grouped by client, This week, a
 * board by status, and the client's own page with its weekly log. Every
 * cell edits in place. Nothing is read-only.
 *
 * The page owns the one copy of the task list. Cells report changes up,
 * the page saves and rolls back on failure. */

const VIEWS = [
  { id: "all", icon: "📋", label: "All tasks", groupBy: "client", showDone: true },
  { id: "week", icon: "📅", label: "This week", groupBy: "due", showDone: false },
  { id: "board", icon: "🗂", label: "Board", groupBy: "status", showDone: true },
  { id: "clients", icon: "🏢", label: "Clients & weekly log" },
];

const PREFS_KEY = "adm-ops-prefs";

function readPrefs() {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function writePrefs(p) {
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

export default function Operations({ member }) {
  const prefs = useMemo(() => readPrefs(), []);
  const [clients, setClients] = useState({ rows: [], sample: true });
  const [tasks, setTasks] = useState([]);
  const [team, setTeam] = useState([]);
  /* Settings are remembered PER VIEW. One shared pair meant switching to Board
   * and back reset the grouping you had chosen on All tasks. */
  const startView = VIEWS.some((v) => v.id === prefs.viewId) ? prefs.viewId : "all";
  const startSaved = (prefs.byView && prefs.byView[startView]) || VIEWS.find((v) => v.id === startView) || {};
  const [viewId, setViewId] = useState(startView);
  const [byView, setByView] = useState(prefs.byView && typeof prefs.byView === "object" ? prefs.byView : {});
  const [groupBy, setGroupBy] = useState(isGroupBy(startSaved.groupBy) ? startSaved.groupBy : "client");
  const [showDone, setShowDone] = useState(typeof startSaved.showDone === "boolean" ? startSaved.showDone : true);
  const [columns, setColumns] = useState(Array.isArray(prefs.columns) && prefs.columns.length ? prefs.columns : DEFAULT_COLUMNS);
  const [tasksError, setTasksError] = useState(null);
  const [query, setQuery] = useState("");
  const [clientFilter, setClientFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [colAnchor, setColAnchor] = useState(null);
  const [selectedClientId, setSelectedClientId] = useState(null);
  const [taskModal, setTaskModal] = useState(null);   // null | {} | task
  const [addClientOpen, setAddClientOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const loadTasks = useCallback(async () => {
    const t = await listTasks();
    setTasks(t.rows);
    setTasksError(t.error || null);
  }, []);

  const loadClients = useCallback(async () => {
    const c = await listClients();
    setClients(c);
    setSelectedClientId((cur) => (cur && c.rows.some((x) => x.id === cur) ? cur : (c.rows[0]?.id || null)));
  }, []);

  const loadAll = useCallback(async () => {
    const [, , tm] = await Promise.all([loadClients(), loadTasks(), listTeam()]);
    setTeam(tm.rows);
  }, [loadClients, loadTasks]);

  useEffect(() => {
    loadAll();
    const onRefresh = () => loadAll();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [loadAll]);

  useEffect(() => {
    const next = { ...byView, [viewId]: { groupBy, showDone } };
    setByView((cur) => (cur[viewId]?.groupBy === groupBy && cur[viewId]?.showDone === showDone ? cur : next));
    writePrefs({ viewId, byView: next, columns });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId, groupBy, showDone, columns]);

  /* Switching view restores what you last used there, or that view's default the
   * first time. Clicking the tab you are already on changes nothing. */
  const pickView = (v) => {
    if (v.id === viewId) return;
    setViewId(v.id);
    const saved = byView[v.id] || {};
    const g = isGroupBy(saved.groupBy) ? saved.groupBy : v.groupBy;
    if (g) setGroupBy(g);
    const sd = typeof saved.showDone === "boolean" ? saved.showDone : v.showDone;
    if (typeof sd === "boolean") setShowDone(sd);
  };

  /* ---- writes ---------------------------------------------------- */

  const patchTask = async (task, patch) => {
    setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, ...patch } : t)));
    const res = await upsertTask({ id: task.id, ...patch });
    if (!res.ok) {
      /* Undo only the fields this call touched. Restoring the whole old row would
       * also undo anything else that changed while we were waiting. */
      const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, task[k] ?? null]));
      setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, ...undo } : t)));
      toast.error("Couldn't save that", res.error);
      return;
    }
    if (res.row) setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, ...res.row } : t)));
    if (patch.status === "done" && task.status !== "done") {
      const client = clients.rows.find((c) => c.id === task.client_id);
      await logActivity({ actor: member.user_id, kind: "task_done", title: `Task done: ${task.name}`, body: client?.name || null });
      toast.success("Done ✓", task.name);
    }
  };

  const createTask = async (patch) => {
    const name = (patch.name || "").trim();
    if (!name) return;
    const base = { status: "todo", priority: "medium", ...patch, name };
    const res = await upsertTask(base);
    if (!res.ok) { toast.error("Couldn't add the task", res.error); return; }
    const row = res.row || null;
    if (row) setTasks((cur) => [row, ...cur]);
    else await loadTasks();
    /* A task the current filter hides would look like nothing happened. */
    if (row && !visibleHere(row)) toast.warn("Added — but this view hides it", "Open All tasks to see it.");
    else toast.success("Task added", name);
  };

  /* ---- what the table sees --------------------------------------- */

  const me = member?.user_id;

  const visibleHere = useCallback((t) => {
    const q = query.trim().toLowerCase();
    if (viewId === "week") {
      if (t.status === "done") return false;
      if (!t.due_date || t.due_date > plusDaysISO(7)) return false;
    } else if (!showDone && t.status === "done") return false;

    if (clientFilter !== "all" && (t.client_id || "__none") !== clientFilter) return false;

    if (assigneeFilter === "__me" && t.assigned_to !== me) return false;
    if (assigneeFilter === "__none" && t.assigned_to) return false;
    if (assigneeFilter !== "all" && assigneeFilter !== "__me" && assigneeFilter !== "__none"
      && t.assigned_to !== assigneeFilter) return false;

    if (q && !`${t.name} ${t.latest_report || ""}`.toLowerCase().includes(q)) return false;
    return true;
  }, [viewId, showDone, clientFilter, assigneeFilter, query, me]);

  const filtered = useMemo(() => tasks.filter(visibleHere), [tasks, visibleHere]);

  const openCount = filtered.filter((t) => t.status !== "done").length;
  const lateCount = filtered.filter(isOverdue).length;

  const openClient = (clientId) => { setSelectedClientId(clientId); setViewId("clients"); };

  /* What the assistant may see of this page: the view, the task count, and the
   * titles on screen. Stated, not scraped — see src/lib/screenContext.js. */
  useScreenContext(() => ({
    page: "Operations",
    label: `${filtered.length} task${filtered.length === 1 ? "" : "s"} in the "${viewId}" view`,
    record: selectedClientId
      ? { type: "client", id: selectedClientId, label: clients.rows.find((c) => c.id === selectedClientId)?.name || "a client" }
      : null,
    visible: filtered.slice(0, 20).map((t) => `${t.title} (${t.status})`),
  }), [filtered, viewId, selectedClientId, clients.rows]);

  const dbProps = {
    tasks: filtered, groupBy, columns, clients: clients.rows, team,
    onPatch: patchTask, onCreate: createTask, onOpen: (t) => setTaskModal(t), onOpenClient: openClient,
  };

  return (
    <>
      <Explainer
        icon="🗂"
        kicker="THE NOTION REPLACEMENT"
        title="Every client task in one table — the same layout as Notion"
        body="Click any cell to change it: status, client, who owns it, priority, due date. Nothing saves twice, nothing needs a form. The tabs are views of the same list — All tasks grouped by client, This week for what's due, Board to drag a task along, and Clients for the week-by-week log."
      />

      {/* view tabs */}
      <div className="adm-db-head">
        <div className="aia-tabs" role="tablist" aria-label="Operations views">
          {VIEWS.map((v) => (
            <button
              key={v.id} role="tab" aria-selected={viewId === v.id}
              className={`aia-tab ${viewId === v.id ? "active" : ""}`}
              onClick={() => pickView(v)}
            >
              <span className="aia-tab-dot" aria-hidden="true" />
              {v.icon} {v.label}
            </button>
          ))}
        </div>
        <div className="adm-db-head-right">
          <SourceBadge mode={clients.sample ? "sample" : "live"} />
          {viewId === "clients" ? (
            <>
              <button className="btn btn-sm" onClick={() => setImportOpen(true)}>Import clients</button>
              <button className="btn btn-accent btn-sm" onClick={() => setAddClientOpen(true)}>+ Add client</button>
            </>
          ) : (
            <button className="btn btn-accent btn-sm" onClick={() => setTaskModal({})}>+ New task</button>
          )}
        </div>
      </div>

      {(clients.error || tasksError) ? (
        <div className="adm-db-warn">
          Some of this didn't load: {clients.error || tasksError}. What's on screen may be incomplete —
          hit Refresh, and if it stays, the Supabase keys or the SQL in SETUP.md are the place to look.
        </div>
      ) : null}

      {viewId === "clients" ? (
        <ClientsView
          clients={clients} tasks={tasks} team={team} member={member}
          selectedId={selectedClientId} setSelectedId={setSelectedClientId}
          reloadClients={loadClients} onPatch={patchTask} onCreate={createTask}
          onOpen={(t) => setTaskModal(t)} onAddClient={() => setAddClientOpen(true)}
        />
      ) : (
        <>
          {/* toolbar */}
          <div className="adm-db-toolbar">
            <input
              className="adm-input adm-db-search" placeholder="Search tasks…"
              value={query} onChange={(e) => setQuery(e.target.value)}
            />
            {viewId !== "board" && (
              <label className="adm-db-ctl">
                Group by
                <select className="adm-input adm-db-mini" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                  {GROUP_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            )}
            <label className="adm-db-ctl">
              Client
              <select className="adm-input adm-db-mini" value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}>
                <option value="all">Everyone</option>
                {clients.rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                <option value="__none">No client</option>
              </select>
            </label>
            <label className="adm-db-ctl">
              Owner
              <select className="adm-input adm-db-mini" value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
                <option value="all">Anyone</option>
                <option value="__me">Just mine</option>
                {team.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>)}
                <option value="__none">Unassigned</option>
              </select>
            </label>
            {viewId !== "week" && (
              <label className="adm-db-check-ctl">
                <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
                Show done
              </label>
            )}
            {viewId !== "board" && (
              <button className="btn btn-sm" onClick={(e) => setColAnchor(e.currentTarget.getBoundingClientRect())}>Columns</button>
            )}
            <div className="adm-db-tally">
              <strong>{filtered.length}</strong> shown · {openCount} open
              {lateCount ? <> · <span className="adm-db-late">{lateCount} late</span></> : null}
            </div>
          </div>

          {colAnchor && (
            <Popover anchor={colAnchor} width={210} onClose={() => setColAnchor(null)}>
              <div className="adm-db-pop-pad">
                <div className="label" style={{ marginBottom: 8 }}>Columns to show</div>
                {COLUMNS.map((c) => (
                  <label key={c.key} className={`adm-db-colrow${c.locked ? " locked" : ""}`}>
                    <input
                      type="checkbox" checked={c.locked || columns.includes(c.key)} disabled={c.locked}
                      onChange={(e) => setColumns((cur) => (
                        e.target.checked ? [...cur, c.key] : cur.filter((k) => k !== c.key)
                      ))}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </Popover>
          )}

          {tasks.length === 0 ? (
            <EmptyState
              icon="✓"
              title="No tasks yet"
              body="Add the first one. A task needs nothing but a name — client, owner, due date and the rest can be filled in from the table afterwards."
              action={<button className="btn btn-accent" onClick={() => setTaskModal({})}>+ New task</button>}
            />
          ) : filtered.length === 0 ? (
            <EmptyState icon="🔍" title="Nothing matches" body="The filters above are hiding every task. Clear the search, or set Client and Owner back to Everyone / Anyone." />
          ) : viewId === "board" ? (
            <TaskBoard tasks={filtered} clients={clients.rows} team={team} onPatch={patchTask} onOpen={(t) => setTaskModal(t)} />
          ) : (
            <TaskDatabase {...dbProps} />
          )}
        </>
      )}

      {taskModal !== null && (
        <TaskModal
          task={taskModal.id ? taskModal : null}
          clients={clients.rows} team={team}
          defaultClientId={clientFilter !== "all" && clientFilter !== "__none" ? clientFilter : (viewId === "clients" ? selectedClientId : null)}
          onClose={() => setTaskModal(null)} reload={loadTasks}
        />
      )}
      {addClientOpen && <ClientModal member={member} onClose={() => setAddClientOpen(false)} reload={loadClients} />}
      {importOpen && <ImportClientsModal member={member} onClose={() => setImportOpen(false)} reload={loadClients} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* CLIENTS VIEW — the client list, their tasks, and the weekly log      */
/* ------------------------------------------------------------------ */

function ClientsView({
  clients, tasks, team, member, selectedId, setSelectedId,
  reloadClients, onPatch, onCreate, onOpen, onAddClient,
}) {
  const selected = clients.rows.find((c) => c.id === selectedId) || null;

  if (clients.rows.length === 0) {
    return (
      <EmptyState
        icon="🏢"
        title="No clients yet"
        body="Add the first client by hand, or bulk-import the whole roster from Notion — the Import button takes a simple JSON list and creates everything at once."
        action={<button className="btn btn-accent" onClick={onAddClient}>Add the first client</button>}
      />
    );
  }

  return (
    <div className="adm-ops-grid">
      <div className="card" style={{ padding: 10 }}>
        {clients.rows.map((c) => {
          const open = tasks.filter((t) => t.client_id === c.id && t.status !== "done").length;
          const late = tasks.filter((t) => t.client_id === c.id && isOverdue(t)).length;
          return (
            <button
              key={c.id} onClick={() => setSelectedId(c.id)}
              className={`adm-ops-client${c.id === selectedId ? " on" : ""}`}
            >
              <div className="adm-ops-client-top">
                <span className="adm-ops-client-name">{c.name}</span>
                <span className={`adm-ops-client-status ${c.status}`}>{(c.status || "").toUpperCase()}</span>
              </div>
              <div className="adm-ops-client-sub">
                {c.stage}{c.domain ? ` · ${c.domain}` : ""}
              </div>
              <div className="adm-ops-client-sub">
                {open} open{late ? <span className="adm-db-late"> · {late} late</span> : null}
              </div>
            </button>
          );
        })}
      </div>

      {selected ? (
        <ClientDetail
          key={selected.id} client={selected} member={member}
          clients={clients.rows} team={team}
          tasks={tasks.filter((t) => t.client_id === selected.id)}
          reloadClients={reloadClients} onPatch={onPatch} onCreate={onCreate} onOpen={onOpen}
        />
      ) : null}
    </div>
  );
}

function ClientDetail({ client, member, clients, team, tasks, reloadClients, onPatch, onCreate, onOpen }) {
  const [weekly, setWeekly] = useState([]);
  const [sites, setSites] = useState([]);
  const [emailCount, setEmailCount] = useState(null);
  const [tab, setTab] = useState("tasks");
  const [editOpen, setEditOpen] = useState(false);
  const [weekModal, setWeekModal] = useState(null);

  const loadWeekly = useCallback(async () => {
    const w = await listWeekly(client.id);
    setWeekly(w.rows);
  }, [client.id]);

  const loadSites = useCallback(async () => {
    const r = await listClientSites(client.id);
    setSites(r.rows);
  }, [client.id]);

  /* The platform login cards for this client. Owned here, handed to the panel,
   * so the tab count and the panel can never disagree. */
  const accounts = usePlatformAccounts(client.id);

  /* Only the email COUNT is read here, to tell whether the standing summary has
   * gone out of date. The emails themselves live on the Inbox page. */
  const loadEmailCount = useCallback(async () => {
    const r = await listEmailThreads({ clientId: client.id });
    if (r.error) { setEmailCount(null); return; }
    const rows = r.rows || [];
    setEmailCount({
      emails: rows.length,
      emailsNeedingReply: rows.filter((e) => e.status === "needs_reply" || e.status === "new").length,
      emailsWaitingOnThem: rows.filter((e) => e.status === "waiting").length,
    });
  }, [client.id]);

  useEffect(() => { loadWeekly(); loadSites(); loadEmailCount(); }, [loadWeekly, loadSites, loadEmailCount]);

  const openCount = tasks.filter((t) => t.status !== "done").length;

  return (
    <div style={{ minWidth: 0 }}>
      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "var(--display)", fontSize: 21, fontWeight: 700, color: "var(--ink)" }}>{client.name}</div>
            <div style={{ marginTop: 4, fontSize: 12.5, color: "var(--ink-dim)", display: "flex", gap: 12, flexWrap: "wrap" }}>
              {client.domain && <a href={`https://${client.domain.replace(/^https?:\/\//, "")}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-deep)" }}>{client.domain} ↗</a>}
              {client.contact_name && <span>{client.contact_name}</span>}
              {client.contact_email && <a href={`mailto:${client.contact_email}`} style={{ color: "var(--accent-deep)" }}>{client.contact_email}</a>}
              {client.start_date && <span>started {client.start_date}</span>}
            </div>
            {client.notes && <div style={{ marginTop: 8, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, maxWidth: 640 }}>{client.notes}</div>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Select style={{ width: 140 }} value={client.stage} onChange={async (e) => {
              const res = await upsertClient({ id: client.id, stage: e.target.value });
              if (res.ok) { toast.success("Stage moved", `${client.name} → ${e.target.value}`); reloadClients(); }
              else toast.error("Couldn't move stage", res.error);
            }} options={CLIENT_STAGES.map((s) => [s, s])} />
            <button className="btn" onClick={() => setEditOpen(true)}>Edit</button>
          </div>
        </div>
      </div>

      {/* The one thing to read first: what is done, what is still needed. */}
      <div style={{ marginBottom: 16 }}>
        <StandingCard client={client} reloadClients={reloadClients} liveCounts={{
          /* Counts AND status breakdowns. A count on its own misses the most
           * common change of all: a task moving from To do to Done without any
           * row being added or removed. */
          tasksTotal: tasks.length,
          tasksDone: tasks.filter((t) => t.status === "done").length,
          tasksOpen: tasks.filter((t) => t.status !== "done").length,
          tasksBlocked: tasks.filter((t) => t.status === "blocked").length,
          sites: sites.length,
          sitesLive: sites.filter((s) => s.live !== false).length,
          weeksTotal: weekly.length,
          weeksLogged: weekly.filter((w) => w.week_status === "complete" || w.week_status === "complete_late").length,
          ...(emailCount || {}),
        }} />
      </div>

      <div className="aia-tabs" role="tablist" aria-label="Client sections" style={{ marginBottom: 16 }}>
        {[["tasks", "Tasks", openCount], ["websites", "Websites", sites.length], ["platform", "Platform login", accounts.rows.length], ["weekly", "Weekly log", 0]].map(([id, label, count]) => (
          <button key={id} onClick={() => setTab(id)} role="tab" aria-selected={tab === id} className={`aia-tab ${tab === id ? "active" : ""}`}>
            <span className="aia-tab-dot" aria-hidden="true" />
            {label}
            {count > 0 ? <span className="aia-tab-badge">{count}</span> : null}
          </button>
        ))}
        {tab === "weekly" ? (
          <button onClick={() => setWeekModal({})} className="aia-tab" style={{ marginLeft: "auto", color: "var(--accent-deep)" }}>+ Add week</button>
        ) : null}
      </div>

      {tab === "websites" ? (
        <SitesPanel client={client} sites={sites} reload={loadSites} />
      ) : tab === "platform" ? (
        <PlatformAccountsPanel client={client} accounts={accounts} />
      ) : tab === "tasks" ? (
        tasks.length ? (
          <TaskDatabase
            tasks={tasks} groupBy="status" clients={clients} team={team}
            columns={["status", "assignee", "priority", "due", "category", "phase", "report"]}
            onPatch={onPatch} onCreate={onCreate} onOpen={onOpen} lockedClientId={client.id}
          />
        ) : (
          <EmptyState icon="✓" title="No tasks for this client" body="Add the first one from All tasks, or with the + New task button up top." />
        )
      ) : (
        weekly.length ? (
          <div style={{ display: "grid", gap: 12 }}>
            {weekly.map((w) => (
              <div key={w.id} className="card" style={{ padding: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 16, color: "var(--ink)" }}>Week {w.week_no}</span>
                    {w.target_date && <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-dim)" }}>target {w.target_date}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 99, fontSize: 9.5, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em",
                      color: w.week_status === "complete" ? "#006b1a" : w.week_status === "complete_late" ? "#92400e" : w.week_status === "in_progress" ? "var(--accent-deep)" : "var(--ink-dim)",
                      background: w.week_status === "complete" ? "var(--success-soft)" : w.week_status === "complete_late" ? "#fffbeb" : w.week_status === "in_progress" ? "var(--accent-soft)" : "var(--bg-3)" }}>
                      {(w.week_status || "not_logged").replace("_", " ").toUpperCase()}
                    </span>
                    <span title="Draft → Verified → Client-Ready: only Client-Ready weeks get shown to the client" style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 99, fontSize: 9.5, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em", cursor: "help",
                      color: w.readiness === "client_ready" ? "#006b1a" : w.readiness === "verified" ? "var(--accent-deep)" : "#92400e",
                      background: w.readiness === "client_ready" ? "var(--success-soft)" : w.readiness === "verified" ? "var(--accent-soft)" : "#fffbeb" }}>
                      {(w.readiness || "draft").replace("_", "-").toUpperCase()}
                    </span>
                    <button className="btn btn-ghost" style={{ padding: "5px 9px", fontSize: 12 }} onClick={() => setWeekModal(w)}>Edit</button>
                  </div>
                </div>
                <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
                  {[["What we did", w.what_we_did], ["What moved", w.what_moved], ["What's next", w.whats_next], ["Talking points", w.talking_points]].map(([label, val]) => (
                    <div key={label}>
                      <div className="label" style={{ marginBottom: 4 }}>{label}</div>
                      <div style={{ fontSize: 12.5, color: val ? "var(--ink-2)" : "var(--ink-faint)", lineHeight: 1.55 }}>{val || "—"}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="📊" title="No weeks logged yet" body="One row per client per week: what we did, what moved, what's next, and the talking points for the client call. Only Client-Ready weeks get shared." action={<button className="btn btn-accent" onClick={() => setWeekModal({})}>+ Log week 1</button>} />
        )
      )}

      {editOpen && <ClientModal member={member} client={client} onClose={() => setEditOpen(false)} reload={reloadClients} />}
      {weekModal !== null && (
        <WeekModal
          client={client} week={weekModal.id ? weekModal : null}
          nextWeekNo={weekly.length ? Math.max(...weekly.map((w) => w.week_no)) + 1 : 1}
          onClose={() => setWeekModal(null)} reload={loadWeekly}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* MODALS                                                              */
/* ------------------------------------------------------------------ */

function ClientModal({ member, client, onClose, reload }) {
  const [f, setF] = useState({
    name: client?.name || "", domain: client?.domain || "", vertical: client?.vertical || "",
    status: client?.status || "active", stage: client?.stage || "Onboarding",
    start_date: client?.start_date || "", contact_name: client?.contact_name || "",
    contact_email: client?.contact_email || "", contact_phone: client?.contact_phone || "",
    notes: client?.notes || "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.name.trim()) { toast.warn("The client needs a name"); return; }
    setBusy(true);
    const patch = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === "string" ? (v.trim() || null) : v]));
    patch.status = f.status; patch.stage = f.stage;
    if (client?.id) patch.id = client.id;
    const res = await upsertClient(patch);
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't save", res.error); return; }
    if (!client) await logActivity({ actor: member.user_id, kind: "client_added", title: `New client: ${f.name}` });
    toast.success(client ? "Client updated" : "Client added", f.name);
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker="OPERATIONS" title={client ? `Edit ${client.name}` : "Add a client"} width={600}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save client"}</button>
      </>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
        <Field label="Client name"><TextInput value={f.name} onChange={set("name")} placeholder="Lakeside Realty Group" /></Field>
        <Field label="Website"><TextInput value={f.domain} onChange={set("domain")} placeholder="lakesiderealty.com" /></Field>
        <Field label="Status"><Select value={f.status} onChange={set("status")} options={[["active", "Active"], ["prospect", "Prospect"], ["holding", "Holding"], ["closed", "Closed"]]} /></Field>
        <Field label="Stage"><Select value={f.stage} onChange={set("stage")} options={CLIENT_STAGES.map((s) => [s, s])} /></Field>
        <Field label="Start date"><TextInput type="date" value={f.start_date || ""} onChange={set("start_date")} /></Field>
        <Field label="Industry"><TextInput value={f.vertical} onChange={set("vertical")} placeholder="realtor / lawyer / …" /></Field>
        <Field label="Contact name"><TextInput value={f.contact_name} onChange={set("contact_name")} /></Field>
        <Field label="Contact email"><TextInput type="email" value={f.contact_email} onChange={set("contact_email")} /></Field>
      </div>
      <Field label="Notes" hint="Passwords never go here — Bitwarden links only.">
        <TextArea value={f.notes} onChange={set("notes")} />
      </Field>
    </Modal>
  );
}

/** The whole task on one screen — the equivalent of opening the Notion page. */
function TaskModal({ task, clients, team, defaultClientId, onClose, reload }) {
  const [f, setF] = useState({
    name: task?.name || "",
    client_id: task?.client_id || defaultClientId || "",
    assigned_to: task?.assigned_to || "",
    category: task?.category || "", phase: task?.phase || "",
    priority: task?.priority || "medium", status: task?.status || "todo",
    due_date: task?.due_date || "", latest_report: task?.latest_report || "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.name.trim()) { toast.warn("The task needs a name"); return; }
    setBusy(true);
    const patch = {
      name: f.name.trim(),
      client_id: f.client_id || null,
      assigned_to: f.assigned_to || null,
      category: f.category || null,
      phase: f.phase || null,
      priority: f.priority,
      status: f.status,
      due_date: f.due_date || null,
      latest_report: f.latest_report.trim() || null,
    };
    if (task?.id) patch.id = task.id;
    const res = await upsertTask(patch);
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't save", res.error); return; }
    toast.success(task ? "Task updated" : "Task added", patch.name);
    onClose(); reload();
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${task.name}"? This can't be undone.`)) return;
    const res = await deleteTask(task.id);
    if (!res.ok) { toast.error("Couldn't delete", res.error); return; }
    toast.success("Task deleted");
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker="OPERATIONS" title={task ? "Task" : "New task"} width={620}
      footer={<>
        {task && <button className="btn" style={{ marginRight: "auto", color: "var(--danger)" }} onClick={remove}>Delete</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save task"}</button>
      </>}>
      <Field label="Task"><TextInput value={f.name} onChange={set("name")} placeholder="Ship llms.txt + agents.md" /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
        <Field label="Client">
          <Select value={f.client_id} onChange={set("client_id")} options={[["", "No client"], ...clients.map((c) => [c.id, c.name])]} />
        </Field>
        <Field label="Assigned to" hint="Whoever this is shows it on their own Work page.">
          <Select value={f.assigned_to} onChange={set("assigned_to")} options={[["", "Unassigned"], ...team.map((m) => [m.user_id, m.full_name || m.email])]} />
        </Field>
        <Field label="Status"><Select value={f.status} onChange={set("status")} options={TASK_STATUSES.map((s) => [s, TASK_STATUS_LABELS[s]])} /></Field>
        <Field label="Priority"><Select value={f.priority} onChange={set("priority")} options={TASK_PRIORITIES.map((p) => [p, `${PRIORITY_ICON[p]} ${TASK_PRIORITY_LABELS[p]}`])} /></Field>
        <Field label="Category"><Select value={f.category} onChange={set("category")} options={[["", "None"], ...TASK_CATEGORIES.map((c) => [c, c])]} /></Field>
        <Field label="Phase"><Select value={f.phase} onChange={set("phase")} options={[["", "None"], ...TASK_PHASES.map((p) => [p, p])]} /></Field>
        <Field label="Due date"><TextInput type="date" value={f.due_date || ""} onChange={set("due_date")} /></Field>
      </div>
      <Field label="Latest report" hint="1–3 sentences — this is what shows in the table without opening the task.">
        <TextArea value={f.latest_report} onChange={set("latest_report")} />
      </Field>
    </Modal>
  );
}

function WeekModal({ client, week, nextWeekNo, onClose, reload }) {
  const [f, setF] = useState({
    week_no: week?.week_no ?? nextWeekNo,
    target_date: week?.target_date || "",
    week_status: week?.week_status || "in_progress",
    readiness: week?.readiness || "draft",
    what_we_did: week?.what_we_did || "", what_moved: week?.what_moved || "",
    whats_next: week?.whats_next || "", talking_points: week?.talking_points || "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    const weekNo = Number(f.week_no);
    if (!weekNo || weekNo < 1 || weekNo > 52) { toast.warn("Week number must be between 1 and 52"); return; }
    setBusy(true);
    const patch = {
      client_id: client.id, week_no: weekNo, target_date: f.target_date || null,
      week_status: f.week_status, readiness: f.readiness,
      what_we_did: f.what_we_did.trim() || null, what_moved: f.what_moved.trim() || null,
      whats_next: f.whats_next.trim() || null, talking_points: f.talking_points.trim() || null,
    };
    if (week?.id) patch.id = week.id;
    const res = await upsertWeekly(patch);
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't save", res.error); return; }
    toast.success("Week saved", `Week ${weekNo} · ${client.name}`);
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker={client.name.toUpperCase()} title={week ? `Edit week ${week.week_no}` : "Log a week"} width={640}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save week"}</button>
      </>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "0 12px" }}>
        <Field label="Week #"><TextInput type="number" min="1" max="52" value={f.week_no} onChange={set("week_no")} /></Field>
        <Field label="Target date"><TextInput type="date" value={f.target_date || ""} onChange={set("target_date")} /></Field>
        <Field label="Status"><Select value={f.week_status} onChange={set("week_status")} options={[["not_logged", "Not logged"], ["in_progress", "In progress"], ["complete", "Complete"], ["complete_late", "Complete · late"]]} /></Field>
        <Field label="Readiness"><Select value={f.readiness} onChange={set("readiness")} options={[["draft", "Draft"], ["verified", "Verified"], ["client_ready", "Client-Ready"]]} /></Field>
      </div>
      <Field label="What we did"><TextArea value={f.what_we_did} onChange={set("what_we_did")} /></Field>
      <Field label="What moved" hint="Numbers only if they were actually measured."><TextArea value={f.what_moved} onChange={set("what_moved")} style={{ minHeight: 60 }} /></Field>
      <Field label="What's next"><TextArea value={f.whats_next} onChange={set("whats_next")} style={{ minHeight: 60 }} /></Field>
      <Field label="Talking points"><TextArea value={f.talking_points} onChange={set("talking_points")} style={{ minHeight: 60 }} /></Field>
    </Modal>
  );
}

function ImportClientsModal({ member, onClose, reload }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const example = `[
  { "name": "Client One", "domain": "clientone.com", "stage": "Week 2",
    "status": "active", "contact_name": "Jane", "notes": "..." },
  { "name": "Client Two", "domain": "clienttwo.com", "stage": "Onboarding" }
]`;

  const doImport = async () => {
    let list;
    try { list = JSON.parse(text); } catch { toast.error("That's not valid JSON", "Copy the example shape and try again."); return; }
    if (!Array.isArray(list) || !list.length) { toast.error("Expected a JSON list", "It should start with [ and contain at least one client."); return; }
    if (list.length > 200) { toast.error("Too many at once", "Keep each import under 200 clients."); return; }
    setBusy(true);
    let okCount = 0;
    for (const c of list) {
      if (!c?.name) continue;
      const res = await upsertClient({
        name: String(c.name).slice(0, 200),
        domain: c.domain ? String(c.domain).slice(0, 200) : null,
        stage: CLIENT_STAGES.includes(c.stage) ? c.stage : "Onboarding",
        status: ["active", "prospect", "holding", "closed"].includes(c.status) ? c.status : "active",
        vertical: c.vertical ? String(c.vertical).slice(0, 100) : null,
        start_date: c.start_date || null,
        contact_name: c.contact_name ? String(c.contact_name).slice(0, 200) : null,
        contact_email: c.contact_email ? String(c.contact_email).slice(0, 200) : null,
        notes: c.notes ? String(c.notes).slice(0, 5000) : null,
      });
      if (res.ok) okCount++;
    }
    setBusy(false);
    await logActivity({ actor: member.user_id, kind: "clients_imported", title: `Imported ${okCount} clients` });
    toast.success(`${okCount} clients imported`, `${list.length - okCount} rows skipped (missing name or failed).`);
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker="OPERATIONS" title="Bulk-import clients (JSON)" width={640}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={doImport} disabled={busy || !text.trim()}>{busy ? "Importing…" : "Import"}</button>
      </>}>
      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, marginBottom: 10 }}>
        This is the copy-over path from Notion: paste a JSON list (structured text) of clients and
        they're all created at once. Ask the AI to convert the Notion export into this exact shape.
      </p>
      <div style={{ padding: 12, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--rule)", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.6, whiteSpace: "pre", overflowX: "auto", marginBottom: 12 }}>
        {example}
      </div>
      <TextArea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the JSON list here…" style={{ minHeight: 140, fontFamily: "var(--mono)", fontSize: 12 }} />
    </Modal>
  );
}
