import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listClients, listTasks, listTeam, listClientConnections,
  upsertTask, upsertClient, logActivity,
} from "../../lib/data.js";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import { SourceBadge, TextInput, Select, EmptyState, Modal, Field, FilterTabs, fmtMoney, timeAgo } from "./shared.jsx";
import { ClientDetail, ClientModal, TaskModal, ImportClientsModal } from "./Operations.jsx";

import { isOverdue } from "./opsTable.jsx";
import { canSync } from "../../../lib/connectors.js";
import { useScreenContext } from "../../lib/screenContext.js";
import { useRoute, stampRoute } from "../../lib/router.js";
import { teamDayStartOf } from "../../lib/teamDay.js";

/* CLIENTS — everyone, in one list.
 *
 * This page replaced Customers on Aug 24 2026. Customers showed Stripe and
 * only Stripe, so half the people we deal with were invisible on it: the
 * clients we do the work for live in our own table, and Stripe knows nothing
 * about them until they pay us through it.
 *
 * So this page shows BOTH, in one list, and says which each row is:
 *
 *   CLIENT      — a row in our own records. We do work for them: tasks, sites,
 *                 reports, logins, connected accounts.
 *   SUBSCRIBER  — pays for the platform through Stripe, and we do no delivery
 *                 work for them. No client record exists.
 *   BOTH        — a client of ours who also pays through Stripe. Matched on
 *                 the contact email, and nothing else — see matchKey below.
 *
 * Clicking any row opens the client page. It is the SAME component the
 * Operations page uses, not a copy: one client page, two ways in.
 *
 * A subscriber has no client page to open, because there is nothing behind it
 * yet. The row offers to make one instead, which is a real gap being closed —
 * before this, a lead marked Won and a customer who paid both left you typing
 * the client in by hand.
 */

const TYPE_TONE = {
  client: { c: "var(--accent-deep)", bg: "var(--accent-soft)", label: "CLIENT" },
  both: { c: "#006b1a", bg: "var(--success-soft)", label: "CLIENT + PAYING" },
  subscriber: { c: "#92400e", bg: "#fffbeb", label: "SUBSCRIBER" },
};

const SUB_TONE = {
  active: { c: "#006b1a", bg: "var(--success-soft)" },
  trialing: { c: "var(--accent-deep)", bg: "var(--accent-soft)" },
  past_due: { c: "#92400e", bg: "#fffbeb" },
  unpaid: { c: "#991b1b", bg: "#fef2f2" },
  canceled: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
};

/* The ONE thing two records are matched on: the email address, lowercased and
 * trimmed. Nothing else.
 *
 * Matching on the name was tried and thrown out: "Harbor Injury Law" in our
 * records and "Harbor Injury Law, PLLC" in Stripe are the same firm, and
 * "Smith Law" and "Smith Law Group" are not — and no rule tells those two
 * cases apart. A wrong match here does not look like a bug. It looks like a
 * client whose money belongs to somebody else. When the email does not match,
 * both rows are shown separately and a person decides. */
function matchKey(email) {
  const v = String(email || "").trim().toLowerCase();
  return v.includes("@") ? v : "";
}

export default function ClientsPage({ member, query = "" }) {
  /* The address is what decides which client is open, so opening one is a
   * route change and not a piece of local state. A reload, a bookmark, Back,
   * and the link a Google sign-in bounces back to all land in one place. */
  const [, go] = useRoute();
  const [clients, setClients] = useState({ rows: [], sample: true });
  const [tasks, setTasks] = useState([]);
  const [team, setTeam] = useState([]);
  const [stripe, setStripe] = useState({ customers: [], mode: "loading" });
  const [connCounts, setConnCounts] = useState({});   // clientId -> { total, ready, lastRead }
  const [connTruncated, setConnTruncated] = useState(false);
  const [connError, setConnError] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [q, setQ] = useState("");
  /* What KIND of row: our client, a client who also pays, or a subscriber.
   * These are the tabs across the top, and they are the three values a row
   * can actually be, so the three counts add up to the whole list. */
  const [typeFilter, setTypeFilter] = useState("all");
  /* The two questions the tabs cannot answer, because they cut ACROSS the
   * kinds instead of splitting them: who is paying right now, and who has
   * nothing connected. Kept as a dropdown next to the search box (Ryder,
   * Aug 26 2026) — as tabs they would have looked like more kinds of person,
   * and the counts would have added up to more than the list. */
  const [extraFilter, setExtraFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [taskModal, setTaskModal] = useState(null);
  const [makeClientFrom, setMakeClientFrom] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  /* What the address bar says. `id` opens a client; `connect` is how the
   * Google sign-in comes back. Read once per change, never held in state —
   * two copies of "which client is open" is how they drift apart. */
  /* stampRoute rewrites the ADDRESS BAR without firing a hashchange, so the
   * `query` prop keeps the old value for the rest of the session. Clearing it
   * here too is what actually makes `?connect=ok` stop being read — otherwise
   * the property picker kept being offered on every later visit. */
  const [connectSeen, setConnectSeen] = useState(false);
  const params = useMemo(
    () => new URLSearchParams((connectSeen ? "" : query).replace(/^\?/, "")),
    [query, connectSeen]
  );
  /* `id` is read from the real address whatever happens to the banner — it is
   * which client is open, and it must survive the banner being cleared. */
  const urlClientId = new URLSearchParams(query.replace(/^\?/, "")).get("id");
  const connectResult = params.get("connect");
  const connectReason = params.get("reason");
  const focusConnectionId = params.get("conn");

  /* ---- loading ---------------------------------------------------- */

  const loadCore = useCallback(async () => {
    const [c, t, tm] = await Promise.all([listClients(), listTasks(), listTeam()]);
    setClients(c);
    setTasks(t.rows || []);
    setTeam(tm.rows || []);
    setLoadError(c.error || t.error || null);
    return c.rows || [];
  }, []);

  const loadStripe = useCallback(async () => {
    if (!isConfigured()) { setStripe({ customers: [], mode: "sample" }); return; }
    const res = await apiFetch("/api/stripe-customers");
    if (res.ok && res.data?.configured) setStripe({ customers: res.data.customers || [], mode: "live" });
    else if (res.ok) setStripe({ customers: [], mode: "waiting" });
    else setStripe({ customers: [], mode: "waiting", error: res.error });
  }, []);

  /* How many accounts are connected per client, and when anything was last
   * read. One read of the whole table, not one per client — a list of forty
   * clients firing forty requests is how a page takes ten seconds. */
  const CONNECTION_READ_CAP = 400;
  const loadConnections = useCallback(async () => {
    const conns = await listClientConnections(null);
    const counts = {};
    for (const row of conns.rows || []) {
      if (row.active === false) continue;
      const c = counts[row.client_id] || (counts[row.client_id] = { total: 0, ready: 0, lastRead: null });
      c.total += 1;
      /* The SAME test the client page uses to decide whether it can read an
       * account (canSync). Counting `status === "connected" && property` here
       * meant a connection whose last read failed showed as not readable on
       * this list while the client page offered to refresh it. */
      if (canSync(row)) c.ready += 1;
      if (row.last_synced_at && (!c.lastRead || row.last_synced_at > c.lastRead)) c.lastRead = row.last_synced_at;
    }
    setConnCounts(counts);
    /* A read that came back exactly at its cap probably had more behind it,
     * and the column would then print "none connected" as a fact about
     * clients whose rows were simply never fetched. */
    setConnTruncated((conns.rows || []).length >= CONNECTION_READ_CAP);
    setConnError(conns.error || null);
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.all([loadCore(), loadStripe(), loadConnections()]);
  }, [loadCore, loadStripe, loadConnections]);

  useEffect(() => {
    loadAll();
    const onRefresh = () => loadAll();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [loadAll]);

  /* The address decides which client is open, so a reload, a bookmark and the
   * link a Google sign-in bounces back to all land in the same place. */
  /* Both ways. It used to only ever SET, never clear — so pressing Back from
   * a client page to the list left the client page rendered over a list
   * address, and Back looked broken. */
  useEffect(() => {
    setSelectedId(urlClientId || null);
  }, [urlClientId]);

  /* One message, once, when a Google sign-in comes back. */
  useEffect(() => {
    if (!connectResult) return;
    if (connectResult === "ok") {
      toast.success("Account connected", "Now pick which site or location it should read.");
    } else {
      toast.error("That sign-in did not finish", REASONS[connectReason] || connectReason || "No reason came back.");
    }
    /* Take it out of the address so a reload does not say it again, but keep
     * the client open — replaceState, so no junk history entry. */
    stampRoute(`/dashboard/clients${urlClientId ? `?id=${urlClientId}` : ""}`);
    setConnectSeen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectResult]);

  /* ---- the merged list -------------------------------------------- */

  const rows = useMemo(() => {
    const byEmail = new Map();
    for (const c of clients.rows) {
      const k = matchKey(c.contact_email);
      if (k) byEmail.set(k, c);
    }
    const usedClientIds = new Set();
    const out = [];

    for (const cust of stripe.customers) {
      const k = matchKey(cust.email);
      const client = k ? byEmail.get(k) : null;
      if (client) usedClientIds.add(client.id);
      out.push({
        key: `stripe:${cust.id}`,
        kind: client ? "both" : "subscriber",
        client: client || null,
        stripe: cust,
        name: client?.name || cust.name || cust.email || cust.id,
        email: client?.contact_email || cust.email || null,
        since: cust.created ? cust.created * 1000 : null,
      });
    }

    for (const c of clients.rows) {
      if (usedClientIds.has(c.id)) continue;
      out.push({
        key: `client:${c.id}`,
        kind: "client",
        client: c,
        stripe: null,
        name: c.name,
        email: c.contact_email || null,
        /* MIDNIGHT IN CHICAGO, NOT IN LONDON. `Date.parse("2026-08-31T00:00:00Z")`
         * is 7pm the evening BEFORE, team time, so the "With us" column read the
         * start date five hours early: a client who starts tomorrow showed
         * "1h ago" — as if they had already been with us for an hour. Caught in
         * the 30 Aug 2026 dry run, on the first client ever created here.
         * teamDayStartOf() is the same function every lateness number uses. */
        since: c.start_date ? teamDayStartOf(c.start_date) : (c.created_at ? Date.parse(c.created_at) : null),
      });
    }

    /* Our own clients first — they are the ones with work behind them — then
     * paying subscribers, then everything else, each group by name. */
    const order = { both: 0, client: 1, subscriber: 2 };
    return out.sort((a, b) =>
      order[a.kind] - order[b.kind] || String(a.name).localeCompare(String(b.name))
    );
  }, [clients.rows, stripe.customers]);

  const shown = useMemo(() => {
    let list = rows;
    /* The tab is just the row's own kind, so no clever rule is needed. */
    if (typeFilter !== "all") list = list.filter((r) => r.kind === typeFilter);
    if (extraFilter === "paying") list = list.filter((r) => r.stripe?.subscription?.status === "active" || r.stripe?.subscription?.status === "trialing");
    /* Only offered as an answer when the connection list actually loaded in
     * full. Filtering on a truncated read would present clients as having
     * nothing connected when their rows were never fetched. */
    else if (extraFilter === "unconnected") list = list.filter((r) => r.client && !(connCounts[r.client.id]?.ready));
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((r) =>
        `${r.name} ${r.email || ""} ${r.client?.domain || ""}`.toLowerCase().includes(needle));
    }
    return list;
  }, [rows, typeFilter, extraFilter, q, connCounts]);

  const selected = clients.rows.find((c) => c.id === selectedId) || null;

  const openClient = (clientId) => {
    setSelectedId(clientId);
    go(`/dashboard/clients?id=${clientId}`);
  };
  const backToList = () => {
    setSelectedId(null);
    go("/dashboard/clients");
  };

  useScreenContext(() => ({
    page: "Clients",
    label: `${shown.length} of ${rows.length} accounts`,
    record: selected ? { type: "client", id: selected.id, label: selected.name } : null,
    visible: shown.slice(0, 20).map((r) => `${r.name} (${TYPE_TONE[r.kind].label.toLowerCase()})`),
  }), [shown, rows.length, selected]);

  /* ---- task writes, for the client page --------------------------- */

  const patchTask = async (task, patch) => {
    setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, ...patch } : t)));
    const res = await upsertTask({ id: task.id, ...patch });
    if (!res.ok) {
      const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, task[k] ?? null]));
      setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, ...undo } : t)));
      toast.error("Couldn't save that", res.error);
      return;
    }
    if (res.row) setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, ...res.row } : t)));
    if (patch.status === "done" && task.status !== "done") {
      await logActivity({ actor: member.user_id, kind: "task_done", title: `Task done: ${task.name}`, body: selected?.name || null });
      toast.success("Done ✓", task.name);
    }
  };

  const createTask = async (patch) => {
    const name = (patch.name || "").trim();
    if (!name) return;
    const res = await upsertTask({ status: "todo", priority: "medium", ...patch, name });
    if (!res.ok) { toast.error("Couldn't add the task", res.error); return; }
    if (res.row) setTasks((cur) => [res.row, ...cur]);
    else { const t = await listTasks(); setTasks(t.rows || []); }
    toast.success("Task added", name);
  };

  /* ---- the client page -------------------------------------------- */

  if (selected) {
    return (
      <>
        <button className="btn btn-ghost" style={{ marginBottom: 14, padding: "6px 10px", fontSize: 12.5 }} onClick={backToList}>
          ← Every client
        </button>
        <ClientDetail
          key={selected.id}
          client={selected} member={member} clients={clients.rows} team={team}
          tasks={tasks.filter((t) => t.client_id === selected.id)}
          reloadClients={loadCore}
          onPatch={patchTask} onCreate={createTask} onOpen={(t) => setTaskModal(t)}
          startTab={focusConnectionId ? "connections" : "tasks"}
          focusConnectionId={focusConnectionId}
        />
        {taskModal !== null && (
          <TaskModal
            task={taskModal.id ? taskModal : null}
            clients={clients.rows} team={team} defaultClientId={selected.id}
            onClose={() => setTaskModal(null)}
            reload={async () => { const t = await listTasks(); setTasks(t.rows || []); }}
          />
        )}
      </>
    );
  }

  /* ---- the list --------------------------------------------------- */

  const clientCount = rows.filter((r) => r.client).length;
  const subCount = rows.filter((r) => r.kind === "subscriber").length;

  /* The tab counts are taken from `rows`, which is everybody before any filter
   * runs. Counting `shown` instead would make a number change the moment you
   * clicked it, and a count that moves when you touch it cannot be trusted.
   * The words are the ones TYPE_TONE puts on the row badges, so the tab and
   * the badge never use two names for the same thing. */
  const kindTabs = ["client", "both", "subscriber"].map((k) => ({
    id: k,
    label: k === "client" ? "Clients" : k === "both" ? "Client + paying" : "Subscribers",
    count: rows.filter((r) => r.kind === k).length,
  }));
  const totalMrr = shown.reduce((s, r) => s + (r.stripe?.subscription?.mrrCents || 0), 0);

  return (
    <>
      <FilterTabs
        tabs={kindTabs} value={typeFilter} onChange={setTypeFilter}
        ariaLabel="Who to show" allLabel="Everybody" allCount={rows.length}
      />

      <div className="card" style={{ padding: 18, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px" }}>
          <TextInput placeholder="Search a name, an email or a website…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select style={{ width: 210 }} value={extraFilter} onChange={(e) => setExtraFilter(e.target.value)}
          options={[
            ["all", "Anyone, paying or not"],
            ["paying", "Paying right now"],
            ["unconnected", "No accounts connected"],
          ]} />
        <button className="btn" onClick={() => setImportOpen(true)}>Import clients</button>
        <button className="btn btn-accent" onClick={() => setAddOpen(true)}>+ Add a client</button>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
            <strong style={{ color: "var(--ink)" }}>{shown.length}</strong> shown
            {totalMrr ? ` · ${fmtMoney(totalMrr)}/mo` : ""}
          </span>
          <SourceBadge
            mode={clients.sample ? "sample" : "live"}
            hint={stripe.mode === "waiting" ? "Our own records are live. Stripe is wired but needs STRIPE_SECRET_KEY — SETUP.md § Stripe." : undefined}
          />
        </div>
      </div>

      <div style={{ margin: "10px 2px 14px", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
        {clientCount} client{clientCount === 1 ? "" : "s"} we do work for
        {subCount ? `, and ${subCount} who only pay for the platform` : ""}.
        {stripe.mode === "waiting" && " Stripe is not connected yet, so nobody who only pays for the platform is on this list."}
        {stripe.mode === "sample" && " Nothing here is real — this is the sample list."}
      </div>

      {(connTruncated || connError) && (
        <div className="card" style={{ padding: 14, marginBottom: 14, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12.5, lineHeight: 1.5 }}>
          {connError
            ? <>The list of connected accounts didn&apos;t load ({connError}).</>
            : <>There are more connected accounts than this page reads in one go.</>}
          {" "}The <strong>Their accounts</strong> column says &ldquo;not known&rdquo; where it could not look, and
          the <em>No accounts connected</em> filter may be missing people. Open a client to see the real list.
        </div>
      )}

      {loadError && (
        <div className="card" style={{ padding: 14, marginBottom: 14, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12.5, lineHeight: 1.5 }}>
          Some of this didn&apos;t load: {loadError}. The list may be missing people.
        </div>
      )}

      {shown.length ? (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Name</th><th>What they are</th><th>Plan</th>
                  <th style={{ textAlign: "right" }}>Per month</th>
                  <th>Work open</th><th>Their accounts</th><th>With us</th><th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const tone = TYPE_TONE[r.kind];
                  const sub = r.stripe?.subscription;
                  const subTone = SUB_TONE[sub?.status] || SUB_TONE.canceled;
                  const mine = r.client ? tasks.filter((t) => t.client_id === r.client.id) : [];
                  const open = mine.filter((t) => t.status !== "done").length;
                  const late = mine.filter(isOverdue).length;
                  const conn = r.client ? connCounts[r.client.id] : null;
                  return (
                    <tr
                      key={r.key}
                      onClick={() => (r.client ? openClient(r.client.id) : setMakeClientFrom(r))}
                      style={{ cursor: "pointer" }}
                      title={r.client ? `Open ${r.name}` : "No client record yet — click to make one"}
                    >
                      <td>
                        <div style={{ fontWeight: 600, color: "var(--ink)" }}>{r.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>
                          {r.client?.domain || r.email || r.stripe?.id}
                        </div>
                      </td>
                      <td>
                        <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 99, fontSize: 9.5, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em", color: tone.c, background: tone.bg }}>
                          {tone.label}
                        </span>
                        {/* The client's status — ACTIVE, HOLDING and so on. The
                          * Operations client rail used to show this, and that rail
                          * was deleted on Aug 26 2026, so the only place left to
                          * read it was inside a client page. Overview counts
                          * "Active clients" off this very field and its tile now
                          * lands here, so the number has to be checkable here.
                          * Same class the old rail used, so it reads the way
                          * people already know it. A client with no status set
                          * shows nothing: an empty badge looks like a badge that
                          * failed to load. */}
                        {r.client?.status ? (
                          <span className={`adm-ops-client-status ${r.client.status}`} style={{ marginLeft: 8 }}>
                            {String(r.client.status).toUpperCase()}
                          </span>
                        ) : null}
                        {r.client?.stage ? <div style={{ fontSize: 11.5, color: "var(--ink-dim)", marginTop: 3 }}>{r.client.stage}</div> : null}
                      </td>
                      <td>
                        {sub ? (
                          <>
                            <div style={{ fontSize: 12.5 }}>{sub.plan || "—"}</div>
                            <span style={{ display: "inline-flex", marginTop: 3, padding: "1px 7px", borderRadius: 99, fontSize: 9, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em", color: subTone.c, background: subTone.bg }}>
                              {String(sub.status || "").toUpperCase()}
                            </span>
                          </>
                        ) : (
                          <span style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>
                            {stripe.mode === "live" ? "not paying through Stripe" : "—"}
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: "right", fontWeight: 700, color: "var(--ink)" }}>
                        {sub?.mrrCents ? fmtMoney(sub.mrrCents) : "—"}
                      </td>
                      <td style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>
                        {r.client ? (
                          <>
                            {open} open
                            {late ? <span className="adm-db-late"> · {late} late</span> : null}
                          </>
                        ) : <span style={{ color: "var(--ink-faint)" }}>no client record</span>}
                      </td>
                      <td style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>
                        {!r.client ? <span style={{ color: "var(--ink-faint)" }}>—</span>
                          : !conn?.total ? (
                            connTruncated || connError
                              ? <span style={{ color: "var(--ink-dim)" }} title="The list of connections did not load in full, so this is not known.">not known</span>
                              : <span style={{ color: "#92400e" }}>none connected</span>
                          )
                            : <>
                              {conn.ready} of {conn.total} readable
                              <div style={{ fontSize: 11, color: "var(--ink-dim)", fontFamily: "var(--mono)" }}>
                                {conn.lastRead ? `read ${timeAgo(conn.lastRead)}` : "never read"}
                              </div>
                            </>}
                      </td>
                      <td style={{ whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 11 }}>
                        {r.since ? timeAgo(r.since) : "—"}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {r.client ? (
                          <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => openClient(r.client.id)}>
                            Open →
                          </button>
                        ) : (
                          <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12, color: "var(--accent-deep)" }} onClick={() => setMakeClientFrom(r)}>
                            Make a client
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <EmptyState
          icon="🏢"
          title={q || typeFilter !== "all" || extraFilter !== "all" ? "Nobody matches that" : "Nobody here yet"}
          body={q || typeFilter !== "all" || extraFilter !== "all"
            ? "Clear the search box, or go back to the Everybody tab."
            : "Add the first client, or connect Stripe and everyone who pays for the platform appears here on their own."}
          action={q || typeFilter !== "all" || extraFilter !== "all"
            ? <button className="btn" onClick={() => { setQ(""); setTypeFilter("all"); setExtraFilter("all"); }}>Clear filters</button>
            : <button className="btn btn-accent" onClick={() => setAddOpen(true)}>Add a client</button>}
        />
      )}

      {makeClientFrom && (
        <MakeClientModal
          row={makeClientFrom} member={member}
          onClose={() => setMakeClientFrom(null)}
          onMade={async (id) => { setMakeClientFrom(null); await loadCore(); openClient(id); }}
        />
      )}
      {importOpen && (
        <ImportClientsModal member={member} onClose={() => setImportOpen(false)} reload={loadCore} />
      )}
      {addOpen && (
        <ClientModal member={member} client={null} onClose={() => setAddOpen(false)} reload={loadCore} />
      )}
    </>
  );
}

/* What each failure from the Google sign-in actually means, in words. The raw
 * reason ("browser_mismatch") is useless to the person reading it. */
const REASONS = {
  browser_mismatch: "The sign-in finished in a different browser or tab than the one that started it. Start it again in one tab.",
  invalid_state: "That sign-in link had already been used, or it expired. Press Connect again.",
  state_expired: "The sign-in took more than ten minutes. Press Connect again.",
  server_not_configured: "The console's own Google keys are not set on the server yet.",
  no_vault_key: "VAULT_KEY is not set on the server, so the sign-in could not be stored safely.",
  could_not_save: "The connection could not be written to our records.",
  could_not_store: "The sign-in came back fine but could not be saved.",
  wrong_purpose: "That link belongs to a different kind of sign-in.",
  state_incomplete: "We lost track of which client the sign-in was for. Start it again from that client's page.",
  access_denied: "The Google account said no on the permission screen.",
};

/* ------------------------------------------------------------------ */
/* TURNING A PAYING CUSTOMER INTO A CLIENT                             */
/* ------------------------------------------------------------------ */

function MakeClientModal({ row, member, onClose, onMade }) {
  const guessDomain = () => {
    const at = String(row.email || "").split("@")[1] || "";
    /* Free mail is not a business website. Guessing "gmail.com" as somebody's
     * site would put a wrong address on the client record, and a wrong address
     * on a client record ends up in a report. */
    const free = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "proton.me", "protonmail.com"];
    return at && !free.includes(at.toLowerCase()) ? at.toLowerCase() : "";
  };
  const [f, setF] = useState({
    name: row.name || "", domain: guessDomain(),
    contact_email: row.email || "", contact_name: "",
    stage: "Onboarding", status: "active",
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.name.trim()) { toast.warn("It needs a name"); return; }
    setBusy(true);
    const res = await upsertClient({
      name: f.name.trim(),
      domain: f.domain.trim() || null,
      contact_email: f.contact_email.trim() || null,
      contact_name: f.contact_name.trim() || null,
      stage: f.stage, status: f.status,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't make the client", res.error); return; }
    await logActivity({ actor: member.user_id, kind: "client_added", title: `New client: ${f.name.trim()}`, body: "Made from a paying customer on the Clients page." });
    toast.success("Client made", `${f.name.trim()} now has a client page.`);
    onMade(res.row.id);
  };

  return (
    <Modal open onClose={onClose} kicker="CLIENTS" title={`Make a client record for ${row.name}`} width={620}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Making…" : "Make the client"}</button>
      </>}>
      <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, marginBottom: 12 }}>
        This person pays through Stripe but has no client record, so there is nowhere to keep their tasks,
        their websites, their logins or their connected accounts. Making one gives them a client page.
        <br />
        <strong>Keep the email exactly as it is</strong> unless it is wrong — it is the only thing that ties
        this record to the money in Stripe.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
        <Field label="Client name"><TextInput value={f.name} onChange={set("name")} /></Field>
        <Field label="Website" hint="Left blank if the email is a free address."><TextInput value={f.domain} onChange={set("domain")} /></Field>
        <Field label="Contact email"><TextInput value={f.contact_email} onChange={set("contact_email")} /></Field>
        <Field label="Contact name"><TextInput value={f.contact_name} onChange={set("contact_name")} /></Field>
      </div>
    </Modal>
  );
}

/* Exported for the tests: matching two records is the one piece of logic on
 * this page that can be wrong in a way nobody sees. */
export { matchKey };
