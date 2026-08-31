import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listClients, upsertClient, listTasks, listAllTasksForImport, upsertTask, deleteTask,
  listWeekly, upsertWeekly, listTeam, logActivity, listClientSites, listEmailThreads,
  CLIENT_STAGES, TASK_STATUSES, TASK_STATUS_LABELS,
  TASK_CATEGORIES, TASK_PHASES, TASK_PRIORITIES, TASK_PRIORITY_LABELS,
} from "../../lib/data.js";
import { toast } from "../../lib/toast.js";
import { StandingCard, SitesPanel, SalesHistoryPanel } from "./clientPage.jsx";
import { PlatformAccountsPanel, usePlatformAccounts } from "./platformAccounts.jsx";
import { VaultPanel, useVaultItems } from "./vaultParts.jsx";
import { ClientReportsPanel, useClientReports } from "./clientReports.jsx";
import { ConnectionsPanel, useClientConnections } from "./connectionsPanel.jsx";
import {
  SourceBadge, Modal, Field, TextInput, TextArea, Select, EmptyState, } from "./shared.jsx";
import TaskDatabase, {
  TaskBoard, COLUMNS, DEFAULT_COLUMNS, GROUP_OPTIONS, isOverdue, isGroupBy,
} from "./opsTable.jsx";
import { Popover, PRIORITY_ICON } from "./opsCells.jsx";
import { useScreenContext } from "../../lib/screenContext.js";
import { useRoute } from "../../lib/router.js";
import { peopleOptions, personLabel, deliveryPeopleOptions } from "../../lib/people.js";
import { planTaskImport, planSummary } from "../../../lib/notion-merge.js";

/* Operations — the Notion replacement, in Notion's own shape.
 *
 * One database of tasks with views over the top of it, exactly like the
 * Operations table in Notion: All tasks grouped by client, and a board by
 * status. Every cell edits in place. Nothing is read-only.
 *
 * The page owns the one copy of the task list. Cells report changes up,
 * the page saves and rolls back on failure.
 *
 * Two views were taken out on Aug 26 2026, both Ryder's call:
 *
 *   This week — the same tasks the All tasks view already showed, just
 *   hidden down to seven days. A due-date filter is not a view.
 *   Clients & weekly log — the console had TWO client lists, and two lists
 *   of the same people drift apart. The Clients page is the only one now.
 *   Clicking a client here goes there. The client page itself did not move:
 *   ClientDetail still lives in this file and the Clients page opens it,
 *   weekly log tab and all. */

const VIEWS = [
  { id: "all", icon: "📋", label: "All tasks", groupBy: "client", showDone: true },
  { id: "board", icon: "🗂", label: "Board", groupBy: "status", showDone: true },
];

/* The columns a click can filter on that have no dropdown in the toolbar.
 * Field name and column key are the same word for all four, which is why one
 * list serves both. */
const FACET_FIELDS = ["status", "priority", "category", "phase"];
const FACET_LABELS = { status: "Status", priority: "Priority", category: "Category", phase: "Phase" };

const PREFS_KEY = "adm-ops-prefs";

/* What Postgres says when a column in the patch is not in the table. Matched so
 * a missing migration reads as one plain sentence instead of PGRST204. */
const MISSING_DESCRIPTION = /(column|schema cache)[^]*?description|description[^]*?(column|schema cache|does not exist)/i;

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
  const [, go] = useRoute();
  const [clients, setClients] = useState({ rows: [], sample: true });
  const [tasks, setTasks] = useState([]);
  const [team, setTeam] = useState([]);
  /* Settings are remembered PER VIEW. One shared pair meant switching to Board
   * and back reset the grouping you had chosen on All tasks. */
  /* Anyone who used this page before Aug 26 2026 may have "week" or "clients"
   * saved as their view. Those views are gone, so the saved name is checked
   * against the list that exists NOW and falls back to All tasks. Without the
   * check a returning user would open the page and see nothing at all. */
  const startView = VIEWS.some((v) => v.id === prefs.viewId) ? prefs.viewId : "all";
  const startSaved = (prefs.byView && prefs.byView[startView]) || VIEWS.find((v) => v.id === startView) || {};
  const [viewId, setViewId] = useState(startView);
  const [byView, setByView] = useState(prefs.byView && typeof prefs.byView === "object" ? prefs.byView : {});
  const [groupBy, setGroupBy] = useState(isGroupBy(startSaved.groupBy) ? startSaved.groupBy : "client");
  const [showDone, setShowDone] = useState(typeof startSaved.showDone === "boolean" ? startSaved.showDone : true);
  /* A column list saved before a new column existed does not contain it, so the
   * column would never appear for anyone who had used the page before.
   *
   * `colsSeen` is the list of column keys this browser has already been OFFERED.
   * Anything in COLUMNS that is not in it is new, so it is switched on once;
   * anything already offered and since switched off stays off. No version
   * number to bump, so adding a column later cannot skip one — a numbered
   * ladder only worked for people who opened the page at every version. */
  const seen = Array.isArray(prefs.colsSeen) ? prefs.colsSeen : null;
  const [columns, setColumns] = useState(() => {
    const saved = Array.isArray(prefs.columns) && prefs.columns.length ? prefs.columns : null;
    if (!saved) return DEFAULT_COLUMNS;
    const offered = seen || saved;
    const brandNew = DEFAULT_COLUMNS.filter((k) => !offered.includes(k));
    return brandNew.length ? [...saved, ...brandNew] : saved;
  });
  const [tasksError, setTasksError] = useState(null);
  const [query, setQuery] = useState("");
  const [clientFilter, setClientFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  /* Filters set by clicking a value in the table. Client and owner are NOT
   * kept here on purpose — they go into the two dropdowns above, so a filter
   * you set by clicking is visible in the same control you would have used by
   * hand. These four have no dropdown of their own. */
  const [facets, setFacets] = useState({});
  const [colAnchor, setColAnchor] = useState(null);
  const [taskModal, setTaskModal] = useState(null);   // null | {} | task
  const [importTasksOpen, setImportTasksOpen] = useState(false);

  const loadTasks = useCallback(async () => {
    const t = await listTasks();
    setTasks(t.rows);
    setTasksError(t.error || null);
  }, []);

  const loadClients = useCallback(async () => {
    const c = await listClients();
    setClients(c);
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
    writePrefs({ viewId, byView: next, columns, colsSeen: DEFAULT_COLUMNS });
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
      if (MISSING_DESCRIPTION.test(String(res.error || ""))) {
        toast.error("The Description column does not exist yet",
          "Run supabase/migrations/0012_task_description.sql in Supabase, then try again.");
      } else {
        toast.error("Couldn't save that", res.error);
      }
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
    if (!showDone && t.status === "done") return false;

    if (clientFilter !== "all" && (t.client_id || "__none") !== clientFilter) return false;

    if (assigneeFilter === "__me" && t.assigned_to !== me) return false;
    if (assigneeFilter === "__none" && t.assigned_to) return false;
    if (assigneeFilter !== "all" && assigneeFilter !== "__me" && assigneeFilter !== "__none"
      && t.assigned_to !== assigneeFilter) return false;

    for (const k of FACET_FIELDS) {
      const want = facets[k];
      if (want === undefined) continue;
      if (String(t[k] || "__none") !== String(want)) return false;
    }

    /* The brief is searchable too. A task you remember by a detail in its
     * description was unfindable before. */
    if (q && !`${t.name} ${t.latest_report || ""} ${t.description || ""}`.toLowerCase().includes(q)) return false;
    return true;
  }, [showDone, clientFilter, assigneeFilter, query, me, facets]);

  const filtered = useMemo(() => tasks.filter(visibleHere), [tasks, visibleHere]);

  const openCount = filtered.filter((t) => t.status !== "done").length;
  const lateCount = filtered.filter(isOverdue).length;

  /* Clicking a client leaves Operations. The Clients page is the only client
   * list now (Ryder, Aug 26 2026), and it reads which client is open out of
   * the address, so the way to open one is to change the address. `go` is the
   * right call here and not stampRoute: the user chose to go there, so Back
   * should bring them back to the task table. */
  const openClient = (clientId) => { go(`/dashboard/clients?id=${clientId}`); };

  /* What the assistant may see of this page: the view, the task count, and the
   * titles on screen. Stated, not scraped — see src/lib/screenContext.js. */
  useScreenContext(() => ({
    page: "Operations",
    label: `${filtered.length} task${filtered.length === 1 ? "" : "s"} in the "${viewId}" view`,
    /* No record: this page no longer opens a client, so there is never one
     * "current client" here to tell the assistant about. */
    record: null,
    visible: filtered.slice(0, 20).map((t) => `${t.title} (${t.status})`),
  }), [filtered, viewId]);

  /* One entry point for every click-to-filter in the table. Client and owner
   * are routed into the dropdowns that already exist for them; the rest go
   * into `facets`. Clicking the value that is already filtered clears it, so
   * the same click gets you back out. */
  const applyFacet = (key, rawValue) => {
    const v = rawValue === null || rawValue === undefined ? "__none" : String(rawValue);
    if (key === "client") {
      setClientFilter((cur) => (cur === v ? "all" : v));
      return;
    }
    if (key === "assignee") {
      setAssigneeFilter((cur) => (cur === v ? "all" : v));
      return;
    }
    if (!FACET_FIELDS.includes(key)) return;
    setFacets((cur) => {
      const next = { ...cur };
      if (String(next[key]) === v) delete next[key];
      else next[key] = v;
      return next;
    });
  };

  const facetValue = (key) => {
    if (key === "client") return clientFilter === "all" ? undefined : clientFilter;
    /* "__me" is not one of the values in the menu, so reporting it as the active
     * value lit the header dot next to a menu where nothing was ticked. The chip
     * bar says "Owner: just mine" — that is where that filter is visible. */
    if (key === "assignee") return (assigneeFilter === "all" || assigneeFilter === "__me") ? undefined : assigneeFilter;
    return facets[key];
  };

  /* What is being hidden right now, in words, with an × on each one. A filter
   * you cannot see is a table that looks broken. */
  const activeFilters = [];
  if (clientFilter !== "all") {
    activeFilters.push({
      key: "client",
      label: `Client: ${clientFilter === "__none" ? "no client" : (clients.rows.find((c) => c.id === clientFilter)?.name || "unknown")}`,
      clear: () => setClientFilter("all"),
    });
  }
  if (assigneeFilter !== "all") {
    const who = assigneeFilter === "__me" ? "just mine"
      : assigneeFilter === "__none" ? "unassigned"
        : (team.find((m) => m.user_id === assigneeFilter)?.full_name || team.find((m) => m.user_id === assigneeFilter)?.email || "unknown");
    activeFilters.push({ key: "assignee", label: `Owner: ${who}`, clear: () => setAssigneeFilter("all") });
  }
  for (const k of FACET_FIELDS) {
    if (facets[k] === undefined) continue;
    const v = facets[k];
    const shown = v === "__none" ? `no ${k}`
      : k === "status" ? (TASK_STATUS_LABELS[v] || v)
        : k === "priority" ? (TASK_PRIORITY_LABELS[v] || v) : v;
    activeFilters.push({
      key: k,
      label: `${FACET_LABELS[k]}: ${shown}`,
      clear: () => setFacets((cur) => { const next = { ...cur }; delete next[k]; return next; }),
    });
  }
  if (query.trim()) {
    activeFilters.push({ key: "__q", label: `Search: “${query.trim()}”`, clear: () => setQuery("") });
  }

  const clearAllFilters = () => {
    setClientFilter("all"); setAssigneeFilter("all"); setFacets({}); setQuery("");
  };

  const dbProps = {
    tasks: filtered, groupBy, columns, clients: clients.rows, team,
    onPatch: patchTask, onCreate: createTask, onOpen: (t) => setTaskModal(t), onOpenClient: openClient,
    onFacet: applyFacet, onGroupBy: setGroupBy, facetValue,
    /* Unfiltered, for the column-header menus — see TaskDatabase. */
    allTasks: tasks,
  };

  return (
    <>
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
          {/* Add client and Import clients used to sit here, but only on the
              clients view. They moved to the Clients page with the list they
              belong to. */}
          <button className="btn btn-sm" onClick={() => setImportTasksOpen(true)}>Bring tasks over from Notion</button>
          <button className="btn btn-accent btn-sm" onClick={() => setTaskModal({})}>+ New task</button>
        </div>
      </div>

      {(clients.error || tasksError) ? (
        <div className="adm-db-warn">
          Some of this didn't load: {clients.error || tasksError}. What's on screen may be incomplete —
          hit Refresh, and if it stays, the Supabase keys or the SQL in SETUP.md are the place to look.
        </div>
      ) : null}

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
            {/* peopleOptions, not full_name: two teammates with the same name
              * drew two identical rows and a task assigned to the wrong one
              * vanished off the right person's Work page. src/lib/people.js
              *
              * THE FULL ROSTER HERE, DELIBERATELY — unlike the assignee picker,
              * which is owners and admins only. This is a FILTER, and filtering
              * to a sales rep is how you FIND a task that was wrongly put on
              * one before that rule existed. Narrowing it would hide exactly the
              * rows somebody needs to go and fix. */}
            {peopleOptions(team).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            <option value="__none">Unassigned</option>
          </select>
        </label>
        <label className="adm-db-check-ctl">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          Show done
        </label>
        {viewId !== "board" && (
          <button className="btn btn-sm" onClick={(e) => setColAnchor(e.currentTarget.getBoundingClientRect())}>Columns</button>
        )}
        <div className="adm-db-tally">
          <strong>{filtered.length}</strong> shown · {openCount} open
          {lateCount ? <> · <span className="adm-db-late">{lateCount} late</span></> : null}
        </div>
      </div>

      {activeFilters.length > 0 && (
        <div className="adm-db-filters">
          <span className="adm-db-filters-label">Filtered by</span>
          {activeFilters.map((f) => (
            <button
              key={f.key} type="button" className="adm-db-filter-chip"
              onClick={f.clear} title="Remove this filter"
            >{f.label} <span aria-hidden="true">×</span></button>
          ))}
          {activeFilters.length > 1 ? (
            <button type="button" className="adm-db-link" onClick={clearAllFilters}>Clear all</button>
          ) : null}
        </div>
      )}

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
        <EmptyState
          icon="🔍" title="Nothing matches"
          body="The filters above are hiding every task."
          action={activeFilters.length ? <button className="btn" onClick={clearAllFilters}>Clear the filters</button> : null}
        />
      ) : viewId === "board" ? (
        <TaskBoard tasks={filtered} clients={clients.rows} team={team} onPatch={patchTask} onOpen={(t) => setTaskModal(t)} />
      ) : (
        <TaskDatabase {...dbProps} />
      )}

      {importTasksOpen && (
        <ImportTasksModal
          member={member} clients={clients.rows} team={team}
          onClose={() => setImportTasksOpen(false)} reload={loadAll}
        />
      )}

      {taskModal !== null && (
        <TaskModal
          task={taskModal.id ? taskModal : null}
          clients={clients.rows} team={team}
          defaultClientId={clientFilter !== "all" && clientFilter !== "__none" ? clientFilter : null}
          onClose={() => setTaskModal(null)} reload={loadTasks}
        />
      )}
    </>
  );
}

/* Exported Aug 24 2026 so the Clients page can show the SAME client page this
 * one does. One component, two ways in — a second copy would have drifted
 * within a week, and then two screens would disagree about the same client. */
export function ClientDetail({
  client, member, clients, team, tasks, reloadClients, onPatch, onCreate, onOpen,
  startTab = "tasks", focusConnectionId = null,
}) {
  const [weekly, setWeekly] = useState([]);
  const [sites, setSites] = useState([]);
  const [emailCount, setEmailCount] = useState(null);
  const [tab, setTab] = useState(startTab);
  const [reportAuto, setReportAuto] = useState(false);
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

  /* The vault items for this client, owned here and handed to the panel, so
   * the tab count and the panel can never disagree. Same rule as the platform
   * login cards above. */
  const vault = useVaultItems(client.id);

  /* Same reason as the vault above: the tab badge and the panel read from one
   * list. The badge was hard-coded to 0, so a client with nine saved reports
   * showed no badge at all. */
  const reports = useClientReports(client.id);

  /* The client's OWN accounts — Search Console, Business Profile, Analytics.
   * Owned here for the same reason as everything above it: the tab count and
   * the panel read one list. */
  const connections = useClientConnections(client.id);

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

  /* Coming back from a Google sign-in, land on Connections rather than
   * wherever the tab happened to be. The person pressed one button and left
   * the console; putting them back on Tasks reads as "nothing happened". */
  useEffect(() => { if (focusConnectionId) setTab("connections"); }, [focusConnectionId]);

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
            {/* The report button sits up here, next to Edit, because "write me
                a report on this client" is a thing you arrive wanting to do —
                not something you go hunting through tabs for. It jumps to the
                Reports tab AND opens the box in one press. */}
            <button className="btn btn-accent" onClick={() => { setTab("reports"); setReportAuto(true); }}>
              Generate report
            </button>
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
        {[["tasks", "Tasks", openCount], ["websites", "Websites", sites.length], /* ACTIVE ones only. A client with three connections all switched off
                 * showed a "3" next to a panel that greys every one of them out. */
                ["connections", "Connections", connections.rows.filter((c) => c.active !== false).length], ["platform", "Platform login", accounts.rows.length], ["vault", "Vault", vault.rows.length],
                /* NO COUNT on Reports. Ryder, Aug 25 2026. The badge is a
                 * red dot with a number in it — it reads as "something needs
                 * you", and a report you generated yesterday does not. The
                 * other tabs count things you might have to act on: open
                 * tasks, sites, connected accounts, logins. Saved reports are
                 * a filing cabinet. */
                ["reports", "Reports", 0],
                /* Where this client came from. NO COUNT, for the same reason
                   Reports has none: it is a filing cabinet, not a thing that
                   needs you. Added Aug 25 2026 — before it, a client page began
                   on the day the money started and the whole chase was
                   invisible from here. */
                ["sales", "How they started", 0],
                ["weekly", "Weekly log", weekly.length]].map(([id, label, count]) => (
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
      ) : tab === "connections" ? (
        <ConnectionsPanel client={client} connections={connections} member={member} focusConnectionId={focusConnectionId} />
      ) : tab === "platform" ? (
        <PlatformAccountsPanel client={client} accounts={accounts} />
      ) : tab === "vault" ? (
        <VaultPanel client={client} vault={vault} />
      ) : tab === "reports" ? (
        <ClientReportsPanel client={client} reports={reports} autoOpen={reportAuto} onAutoOpened={() => setReportAuto(false)} />
      ) : tab === "sales" ? (
        <SalesHistoryPanel client={client} teamName={(id) => {
          const m = team.find((x) => x.user_id === id);
          return m ? personLabel(m, team) : null;
        }} />
      ) : tab === "tasks" ? (
        tasks.length ? (
          <TaskDatabase
            tasks={tasks} groupBy="status" clients={clients} team={team}
            columns={["status", "assignee", "priority", "category", "phase", "report", "description", "due"]}
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

export function ClientModal({ member, client, onClose, reload }) {
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
export function TaskModal({ task, clients, team, defaultClientId, onClose, reload }) {
  const [f, setF] = useState({
    name: task?.name || "",
    client_id: task?.client_id || defaultClientId || "",
    assigned_to: task?.assigned_to || "",
    category: task?.category || "", phase: task?.phase || "",
    priority: task?.priority || "medium", status: task?.status || "todo",
    due_date: task?.due_date || "", latest_report: task?.latest_report || "",
    description: task?.description || "",
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
      description: f.description.trim() || null,
    };
    if (task?.id) patch.id = task.id;
    let res = await upsertTask(patch);
    /* MIGRATION 0012 MAY NOT BE RUN YET. Sending a column the database does not
     * have makes Postgres reject the WHOLE row, so before this retry existed a
     * console without 0012 could not save ANY task edit at all — a due date
     * change died on a field the person never touched. Now the brief is dropped,
     * the rest saves, and the reason is said out loud. */
    if (!res.ok && MISSING_DESCRIPTION.test(String(res.error || ""))) {
      const { description, ...withoutBrief } = patch;   // eslint-disable-line no-unused-vars
      res = await upsertTask(withoutBrief);
      if (res.ok) {
        toast.warn("Saved — but not the Description",
          "This database has no description column yet. Run supabase/migrations/0012_task_description.sql, then save the brief again.");
        onClose(); reload();
        setBusy(false);
        return;
      }
    }
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
          {/* deliveryPeopleOptions, not everybody: a sales rep has no Operations
            * page, so a task handed to one can never be opened by the person it
            * is on. Whoever already holds it stays in the list, marked. */}
          <Select value={f.assigned_to} onChange={set("assigned_to")} options={[["", "Unassigned"], ...deliveryPeopleOptions(team, f.assigned_to).map((o) => [o.value, o.label])]} />
        </Field>
        <Field label="Status"><Select value={f.status} onChange={set("status")} options={TASK_STATUSES.map((s) => [s, TASK_STATUS_LABELS[s]])} /></Field>
        <Field label="Priority"><Select value={f.priority} onChange={set("priority")} options={TASK_PRIORITIES.map((p) => [p, `${PRIORITY_ICON[p]} ${TASK_PRIORITY_LABELS[p]}`])} /></Field>
        <Field label="Category"><Select value={f.category} onChange={set("category")} options={[["", "None"], ...TASK_CATEGORIES.map((c) => [c, c])]} /></Field>
        <Field label="Phase"><Select value={f.phase} onChange={set("phase")} options={[["", "None"], ...TASK_PHASES.map((p) => [p, p])]} /></Field>
        <Field label="Due date"><TextInput type="date" value={f.due_date || ""} onChange={set("due_date")} /></Field>
      </div>
      <Field label="Latest report" hint="1–3 sentences — where it stands right now. This is what shows in the table.">
        <TextArea value={f.latest_report} onChange={set("latest_report")} />
      </Field>
      {/* The brief. Deliberately below the status line and deliberately taller:
        * this is the field you write once and read before starting, where
        * Latest report is rewritten every week. */}
      <Field label="Description" hint="The full brief. What this work is, why we are doing it, what finished looks like, and any link or login it needs.">
        <TextArea
          value={f.description} onChange={set("description")} style={{ minHeight: 190 }}
          placeholder={"What it is: rebuild llms.txt and agents.md to the current rubric.\nWhy: the AI answer engines read these first and both are 8 months old.\nDone means: both files live, 200 on a plain fetch, and the re-scan shows AI intent above 90."}
        />
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

/* Exported Aug 26 2026: the clients view that used to hold the Import button
 * is gone, so the button lives on the Clients page now. The modal itself did
 * not need to move — it only needs to be reachable from there. */
export function ImportClientsModal({ member, onClose, reload }) {
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

/* ------------------------------------------------------------------ */
/* BRING THE NOTION TASKS OVER — added 31 Aug 2026                     */
/* ------------------------------------------------------------------ */
/* Clients had a paste-JSON path from the first week. Tasks never did, and
 * project memory has carried "No task-level JSON import — that is what the
 * real Notion rows need to come over" as an open item since Aug 17.
 *
 * This is that path, and it is deliberately a TWO-STEP: press Check first and
 * read exactly what will happen, then press Bring them over. An import that
 * writes 108 rows on one click, with no way to see what it is about to do, is
 * how you find out afterwards. Every rule it follows is in lib/notion-merge.js
 * where a test can reach it. */
const MERGE_LINE = { fontSize: 12, lineHeight: 1.6, color: "var(--ink-2)" };

export function ImportTasksModal({ member, clients, team, onClose, reload }) {
  const [text, setText] = useState("");
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [readError, setReadError] = useState(null);

  const example = `[
  { "client": "Shiner Law Group", "name": "Give Joey view-only access",
    "status": "To Do", "priority": "🔴 High", "category": "Access",
    "phase": "Onboarding", "due": "2026-08-13",
    "report": "the one-line status", "description": "the standing brief",
    "assignees": ["ryder@aisyndicate.com"] }
]`;

  const check = async () => {
    setResult(null);
    let list;
    try { list = JSON.parse(text); }
    catch { toast.error("That's not valid JSON", "It has to start with [ and end with ]."); return; }
    setBusy(true);
    /* EVERY existing task is read here, not the page's capped 500. Whether a
     * task already exists is the ONLY thing standing between one paste and two
     * copies of 107 rows, so it is never decided off a partial list. */
    const all = await listAllTasksForImport();
    setBusy(false);
    if (all.error && !all.rows.length) { setReadError(all.error); return; }
    setReadError(all.error || all.truncated || null);
    setPlan(planTaskImport(list, { clients, team, existing: all.rows }));
  };

  const run = async () => {
    if (!plan) return;
    setBusy(true);
    let made = 0, changed = 0;
    const failures = [];
    for (const c of plan.create) {
      const res = await upsertTask(c.row);
      if (res.ok) made += 1; else failures.push(`${c.clientName} — "${c.row.name}": ${res.error}`);
    }
    for (const u of plan.update) {
      const res = await upsertTask(u.patch);
      if (res.ok) changed += 1; else failures.push(`${u.clientName} — "${u.name}": ${res.error}`);
    }
    setBusy(false);
    setResult({ made, changed, failures });
    if (made || changed) {
      await logActivity({
        actor: member.user_id, kind: "tasks_imported",
        title: `Brought ${made} new and ${changed} updated tasks over from Notion`,
      });
    }
    toast.success(`${made} new, ${changed} updated`, failures.length ? `${failures.length} could not be written.` : "Nothing else changed.");
    reload();
  };

  return (
    <Modal open onClose={onClose} kicker="OPERATIONS" title="Bring the tasks over from Notion" width={720}
      footer={<>
        <button className="btn" onClick={onClose}>{result ? "Close" : "Cancel"}</button>
        {!result && (plan
          ? <button className="btn btn-accent" onClick={run} disabled={busy || (!plan.create.length && !plan.update.length)}>
              {busy ? "Writing…" : `Bring them over (${plan.create.length + plan.update.length})`}
            </button>
          : <button className="btn btn-accent" onClick={check} disabled={busy || !text.trim()}>{busy ? "Reading what is already here…" : "Check it first"}</button>)}
      </>}>

      {result ? (
        <div>
          <p style={{ fontSize: 14, marginBottom: 10 }}>
            <strong>{result.made} created · {result.changed} updated.</strong>
          </p>
          {result.failures.length ? (
            <div className="adm-db-warn" style={{ marginBottom: 10 }}>
              {result.failures.length} could not be written:
              <ul style={{ margin: "6px 0 0 16px" }}>{result.failures.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </div>
          ) : <div style={MERGE_LINE}>Every row went in. Nothing was deleted — this screen has no way to delete anything.</div>}
        </div>
      ) : (
        <>
          <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, marginBottom: 10 }}>
            Paste the Notion Operations rows as a JSON list. A task is matched on its client plus its
            name, so pasting the same list twice updates instead of doubling. A row whose client is not
            in this console is refused by name rather than landing nowhere.
          </p>
          <div style={{ padding: 12, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--rule)", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.6, whiteSpace: "pre", overflowX: "auto", marginBottom: 12 }}>
            {example}
          </div>
          <TextArea value={text} onChange={(e) => { setText(e.target.value); setPlan(null); }}
            placeholder="Paste the JSON list here…" style={{ minHeight: 130, fontFamily: "var(--mono)", fontSize: 12 }} />

          {readError ? (
            <div className="adm-db-warn" style={{ marginTop: 10 }}>
              The list of tasks already here could not be read in full: {readError}. Whether something
              already exists is decided from that list, so treat &ldquo;new&rdquo; below with suspicion —
              close this and try again rather than writing on a partial read.
            </div>
          ) : null}

          {plan && (
            <div style={{ marginTop: 14, padding: 12, borderRadius: 10, border: "1px solid var(--rule)" }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{planSummary(plan)}</div>
              <div style={MERGE_LINE}><strong>{plan.create.length}</strong> will be created.</div>
              <div style={MERGE_LINE}><strong>{plan.update.length}</strong> already exist here and will be updated. An empty
                cell in Notion never blanks something already filled in, and a task marked Done here is
                never dragged back to To Do.</div>
              <div style={MERGE_LINE}><strong>{plan.unchanged.length}</strong> already say exactly this, so nothing happens to them.</div>

              {/* WHAT CHANGES, not how many. Agreeing to "12 will be updated"
                  is agreeing to a number; this is the list. */}
              {plan.update.length ? (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", fontSize: 12 }}>
                    Show me every field that changes ({plan.update.reduce((n, u) => n + u.changes.length, 0)})
                  </summary>
                  <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 6 }}>
                    {plan.update.map((u, i) => (
                      <div key={i} style={{ ...MERGE_LINE, padding: "4px 0", borderBottom: "1px solid var(--rule)" }}>
                        <strong>{u.clientName}</strong> — {u.name}
                        <ul style={{ margin: "2px 0 0 16px" }}>
                          {u.changes.map((c, j) => (
                            <li key={j}>
                              <code>{c.field}</code>: {c.from === null || c.from === undefined || c.from === "" ? "(empty)" : String(c.from).slice(0, 90)}
                              {" → "}{String(c.to).slice(0, 90)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
              {plan.duplicatesInPaste.length ? (
                <div className="adm-db-warn" style={{ marginTop: 8 }}>
                  {plan.duplicatesInPaste.map((d, i) => <div key={i}>{d}</div>)}
                </div>
              ) : null}
              {plan.problems.length ? (
                <div className="adm-db-warn" style={{ marginTop: 8 }}>
                  <strong>{plan.problems.length} refused or carried over incompletely:</strong>
                  <ul style={{ margin: "6px 0 0 16px" }}>{plan.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
