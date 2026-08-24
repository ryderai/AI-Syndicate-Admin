import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Field, TextInput, TextArea, Select, EmptyState, SourceBadge } from "./shared.jsx";
import { toast } from "../../lib/toast.js";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import {
  listClientConnections, upsertClientConnection, deleteClientConnection,
  listConnectionSnapshots, addManualSnapshot,
} from "../../lib/data.js";
import {
  PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT, PROVIDER_HELP, PROVIDER_ANSWERS,
  PROVIDER_METRICS, METRIC_LABELS, PROPERTY_HELP, STATUS_LABELS, STATUS_HELP,
  RANGES, isGoogleProvider, prettyProperty, formatMetric, canSync, newestPerProperty,
  connectionNeedsReconnect, SCOPE_IS_READ_ONLY, rangeById, windowDays,
} from "../../../lib/connectors.js";

/* The Connections tab — the client's OWN accounts, connected.
 *
 * WHY THIS EXISTS (Aug 24 2026). Everything else on the client page is what WE
 * did: tasks we finished, sites we built, weeks we logged. None of it says what
 * actually HAPPENED — how many people found them, called them, clicked
 * through. Those numbers live in accounts the client already owns:
 *
 *   Search Console    how often their site showed up in Google, and the clicks.
 *   Business Profile  the map listing: calls, direction taps, website taps.
 *   Analytics 4       what people did once they were on the site.
 *   Bing              the same as Search Console, for Bing — which is what
 *                     Microsoft Copilot searches with.
 *
 * TWO RULES THIS PANEL KEEPS, EVERYWHERE:
 *
 *   1. A number is never shown without the window it covers and the day it was
 *      read. A count with no dates is not a measurement.
 *   2. Read-by-us and typed-in-by-us are never drawn the same way. Every
 *      snapshot carries which it was, and every card says it out loud.
 */

const STATUS_TONE = {
  connected: { c: "#006b1a", bg: "var(--success-soft)" },
  needs_reconnect: { c: "#92400e", bg: "#fffbeb" },
  error: { c: "#991b1b", bg: "#fef2f2" },
  manual: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
};

function whenText(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Everything this tab reads, owned by the caller so the tab badge and the
 * panel can never disagree — the same rule as the vault and login panels. */
export function useClientConnections(clientId) {
  const [rows, setRows] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [error, setError] = useState(null);
  const [sample, setSample] = useState(true);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!clientId) return;
    const [c, s] = await Promise.all([
      listClientConnections(clientId),
      listConnectionSnapshots(clientId, { limit: 60 }),
    ]);
    setRows(c.rows || []);
    setSnapshots(s.rows || []);
    /* Either read failing is reported. A failed read that becomes an empty
     * list turns "we could not look" into "there is nothing", and this panel
     * is the one place where that difference is the whole point. */
    setError(c.error || s.error || null);
    setSample(Boolean(c.sample));
    setLoaded(true);
  }, [clientId]);

  useEffect(() => { reload(); }, [reload]);

  return { rows, snapshots, error, sample, loaded, reload };
}

/* ------------------------------------------------------------------ */
/* THE PANEL                                                           */
/* ------------------------------------------------------------------ */

export function ConnectionsPanel({ client, connections, member, focusConnectionId }) {
  const { rows, snapshots, error, sample, reload } = connections;
  const [range, setRange] = useState("28d");
  const [addOpen, setAddOpen] = useState(false);
  /* IDS, never row snapshots. A modal holding a copy of the row it was opened
   * on saved stale values over newer ones after any Refresh, and stayed open
   * on rows another action had removed. Every one is looked up from `rows`
   * when it renders, and closes itself if the row is gone. */
  const [editingId, setEditingId] = useState(null);
  const [propertyFor, setPropertyFor] = useState(null);
  const [manualForId, setManualForId] = useState(null);
  const [historyForId, setHistoryForId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [busyAll, setBusyAll] = useState(false);
  const live = isConfigured();

  /* Coming back from a Google sign-in, the address names the connection that
   * was just made. Open its property picker straight away — the sign-in is
   * only half the job, and a card that says "connected" with nothing chosen is
   * where people got stuck in testing. */
  /* Offered ONCE. The deps include `rows`, which is a fresh array after every
   * action, so without this the picker reopened itself every time anybody
   * pressed Refresh or switched a card off — over and over, with Cancel doing
   * nothing lasting. */
  const offeredPicker = useRef(null);
  useEffect(() => {
    if (!focusConnectionId || offeredPicker.current === focusConnectionId) return;
    const row = rows.find((r) => r.id === focusConnectionId);
    if (!row) return;                       // rows have not arrived yet
    offeredPicker.current = focusConnectionId;
    if (!row.property) setPropertyFor(row.id);
  }, [focusConnectionId, rows]);

  const newest = useMemo(() => {
    const byConn = new Map();
    for (const s of newestPerProperty(snapshots)) {
      if (s.connection_id) byConn.set(s.connection_id, s);
    }
    return byConn;
  }, [snapshots]);

  /* Snapshots whose connection row is gone. They are still real measurements
   * and still what some past report was written from, so they are shown
   * rather than quietly dropped off the screen. */
  /* "Last 7 days" pressed once makes the 7-day figure the one every report
   * quotes from then on, and a client comparing months would see their clicks
   * apparently collapse. The dates are always printed; this says it in words. */
  const mixedWindows = useMemo(() => {
    const lengths = [...newest.values()].map(windowDays).filter((n) => typeof n === "number");
    const set = [...new Set(lengths)].sort((a, b) => a - b);
    return set.length > 1 ? set.map((n) => `${n} days`).join(" and ") : null;
  }, [newest]);

  const orphans = useMemo(
    () => newestPerProperty(snapshots).filter((s) => !s.connection_id || !rows.some((r) => r.id === s.connection_id)),
    [snapshots, rows]
  );

  const readyCount = rows.filter(canSync).length;

  /* Looked up fresh on every render. A modal whose row has gone simply does
   * not render, which is the right answer — better than a form that saves
   * into nothing and reports a puzzling failure. */
  const byId = (id) => (id ? rows.find((r) => r.id === id) || null : null);
  const editingRow = byId(editingId);
  const propertyRow = byId(propertyFor);
  const manualRow = byId(manualForId);
  const historyRow = byId(historyForId);

  const connect = async (provider, connectionId) => {
    if (!live) {
      toast.warn("Preview mode", "Connecting a real Google account needs the console's own keys set. Everything here is sample data.");
      return;
    }
    setBusyId(connectionId || provider);
    /* connectionId goes with it. "Connect again" has to land back on THIS
     * card — without it the far end could only match a card with no property
     * chosen, so every repair made a second empty card and left the broken
     * one broken for ever. */
    const res = await apiFetch("/api/connect-start", { method: "POST", body: { clientId: client.id, provider, connectionId: connectionId || null } });
    setBusyId(null);
    if (!res.ok) { toast.error("Could not start the sign-in", res.error); return; }
    /* Same tab, on purpose. Google refuses to show its consent screen inside a
     * pop-up opened by some browsers, and a blocked pop-up looks exactly like
     * a button that does nothing. */
    window.location.assign(res.data.authUrl);
  };

  const refreshOne = async (row) => {
    if (!live) { toast.warn("Preview mode", "Reading a real account needs the console's own keys set."); return; }
    setBusyId(row.id);
    const res = await apiFetch("/api/connector", { method: "POST", body: { action: "sync", connectionId: row.id, range } });
    setBusyId(null);
    if (!res.ok) { toast.error("Could not read that account", res.error); await reload(); return; }
    if (res.data?.warnings?.length) toast.warn("Read, with gaps", res.data.warnings.join(" "));
    else toast.success("Numbers updated", `${res.data.label} · ${res.data.window.start} to ${res.data.window.end}`);
    await reload();
  };

  const refreshAll = async () => {
    if (!live) { toast.warn("Preview mode", "Reading real accounts needs the console's own keys set."); return; }
    setBusyAll(true);
    const res = await apiFetch("/api/connector", { method: "POST", body: { action: "syncClient", clientId: client.id, range } });
    setBusyAll(false);
    if (!res.ok) { toast.error("Could not refresh", res.error); return; }
    const d = res.data;
    const failed = (d.results || []).filter((r) => !r.ok);
    if (d.readCount) toast.success(`${d.readCount} read`, d.overCapNote || `Window ${RANGES.find((r) => r.id === range)?.label.toLowerCase()}.`);
    if (failed.length) toast.error(`${failed.length} could not be read`, failed.map((f) => `${f.label}: ${f.error}`).join(" · "));
    if (!d.readCount && !failed.length) toast.warn("Nothing to read", "No connection here is signed in with a property chosen.");
    await reload();
  };

  const disconnect = async (row) => {
    if (!live) { toast.warn("Preview mode", "Nothing real is stored here."); return; }
    setBusyId(row.id);
    const res = await apiFetch("/api/connector", { method: "POST", body: { action: "disconnect", connectionId: row.id } });
    setBusyId(null);
    if (!res.ok) { toast.error("Could not disconnect", res.error); return; }
    toast.success("Sign-in thrown away", "The numbers already read are kept — old reports quote them.");
    await reload();
  };

  const toggleActive = async (row) => {
    const res = await upsertClientConnection({ id: row.id, active: !row.active });
    if (!res.ok) { toast.error("Couldn't change that", res.error); return; }
    toast.success(row.active ? "Switched off" : "Switched back on", row.label);
    await reload();
  };

  const remove = async (row) => {
    const res = await deleteClientConnection(row.id);
    if (!res.ok) { toast.error("Not removed", res.error); return; }
    toast.success("Connection removed", "Every number already read is kept.");
    await reload();
  };

  return (
    <>
      <div className="card" style={{ padding: 16, marginBottom: 14, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 320px" }}>
          <div className="label" style={{ marginBottom: 4 }}>Their own accounts</div>
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
            Connect once and this console can read {client.name}&apos;s real numbers whenever a report needs
            them — searches, clicks, calls, direction taps. We only ever read. Nothing here can change
            anything in their accounts.
          </div>
        </div>
        <Select
          style={{ width: 150 }} value={range} onChange={(e) => setRange(e.target.value)}
          options={RANGES.map((r) => [r.id, r.label])}
        />
        <button className="btn" onClick={refreshAll} disabled={busyAll || !readyCount}
          title={readyCount
            ? `Read every connected account again, for ${rangeById(range).label.toLowerCase()}. Whatever you read last is the window every report quotes.`
            : "Nothing here is signed in with a property chosen yet"}>
          {busyAll ? "Reading…" : `Refresh${readyCount ? ` (${readyCount})` : ""}`}
        </button>
        <button className="btn btn-accent" onClick={() => setAddOpen(true)}>+ Add an account</button>
        <SourceBadge mode={sample ? "sample" : "live"} />
      </div>

      {mixedWindows ? (
        <div className="card" style={{ padding: 14, marginBottom: 14, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12.5, lineHeight: 1.55 }}>
          These accounts were last read over <strong>different lengths of time</strong>
          {" "}({mixedWindows}). The newest reading of each is the one every report quotes, so two of these
          numbers cannot be compared with each other. Pick one window above and press Refresh to put them
          back in step.
        </div>
      ) : null}

      {error ? (
        <div className="card" style={{ padding: 14, marginBottom: 14, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12.5, lineHeight: 1.5 }}>
          Some of this didn&apos;t load: {error}. What is on screen may be incomplete — an empty list here
          does not mean nothing is connected.
        </div>
      ) : null}

      {rows.length === 0 && orphans.length === 0 ? (
        <EmptyState
          icon="🔌"
          title="No accounts connected yet"
          body={`Nothing in this console can say what actually happened for ${client.name} — how many people found them, called them, or clicked through. Connect their Search Console and Business Profile and every report can.`}
          action={<button className="btn btn-accent" onClick={() => setAddOpen(true)}>Add the first one</button>}
        />
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {rows.map((row) => (
            <ConnectionCard
              key={row.id} row={row} snapshot={newest.get(row.id)} busy={busyId === row.id}
              onConnect={() => connect(row.provider, row.id)}
              onChoose={() => setPropertyFor(row.id)}
              onRefresh={() => refreshOne(row)}
              onManual={() => setManualForId(row.id)}
              onEdit={() => setEditingId(row.id)}
              onHistory={() => setHistoryForId(row.id)}
              onDisconnect={() => disconnect(row)}
              onToggle={() => toggleActive(row)}
              onRemove={() => remove(row)}
            />
          ))}
          {orphans.map((s) => (
            <div key={s.id} className="card" style={{ padding: 16, borderStyle: "dashed" }}>
              <div className="label" style={{ marginBottom: 6 }}>Numbers kept from a connection that is gone</div>
              <SnapshotLine snapshot={s} />
              <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--ink-dim)" }}>
                The card was removed, these numbers were not. Reports written from them have to stay checkable.
              </div>
            </div>
          ))}
        </div>
      )}

      {addOpen && (
        <AddConnectionModal
          client={client} member={member} existing={rows}
          onClose={() => setAddOpen(false)}
          onConnect={(p) => { setAddOpen(false); connect(p, null); }}
          reload={reload}
        />
      )}
      {editingRow && (
        <EditConnectionModal key={editingRow.id} row={editingRow} onClose={() => setEditingId(null)} reload={reload} />
      )}
      {propertyRow && (
        <PropertyModal key={propertyRow.id} row={propertyRow} live={live} onClose={() => setPropertyFor(null)} reload={reload} />
      )}
      {manualRow && (
        <ManualNumbersModal
          key={manualRow.id} row={manualRow} client={client} member={member}
          onClose={() => setManualForId(null)} reload={reload}
        />
      )}
      {historyRow && (
        <HistoryModal
          key={historyRow.id} row={historyRow}
          snapshots={snapshots.filter((s) => s.connection_id === historyRow.id)}
          onClose={() => setHistoryForId(null)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* ONE CARD                                                            */
/* ------------------------------------------------------------------ */

function ConnectionCard({
  row, snapshot, busy, onConnect, onChoose, onRefresh, onManual, onEdit,
  onHistory, onDisconnect, onToggle, onRemove,
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const tone = STATUS_TONE[row.status] || STATUS_TONE.manual;
  const google = isGoogleProvider(row.provider);
  const staleScope = google && row.auth_kind === "google" && connectionNeedsReconnect(row.provider, row.scope);
  const ready = canSync(row);

  return (
    <div className="card" style={{ padding: 18, opacity: row.active === false ? 0.6 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--display)", fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>
              {PROVIDER_LABELS[row.provider] || row.provider}
            </span>
            <span title={STATUS_HELP[row.status] || ""} style={{ cursor: "help", display: "inline-flex", padding: "2px 8px", borderRadius: 99, fontSize: 9.5, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em", color: tone.c, background: tone.bg }}>
              {(STATUS_LABELS[row.status] || row.status).toUpperCase()}
            </span>
            {row.active === false && (
              <span style={{ fontSize: 9.5, fontFamily: "var(--mono)", fontWeight: 800, letterSpacing: "0.06em", color: "var(--ink-dim)" }}>SWITCHED OFF</span>
            )}
          </div>
          <div style={{ marginTop: 4, fontSize: 12.5, color: "var(--ink-2)" }}>
            {row.property
              ? <>Reading <strong style={{ color: "var(--ink)" }}>{row.property_label || prettyProperty(row.provider, row.property)}</strong></>
              : <span style={{ color: "#92400e" }}>No property chosen yet — nothing can be read until one is.</span>}
          </div>
          <div style={{ marginTop: 3, fontSize: 11.5, color: "var(--ink-dim)", fontFamily: "var(--mono)" }}>
            {row.account_email ? `${row.account_email} · ` : ""}last read {whenText(row.last_synced_at)}
          </div>
          {row.notes && <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>{row.notes}</div>}
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {google && (row.status !== "connected" || staleScope) && (
            <button className="btn btn-accent" onClick={onConnect} disabled={busy}>
              {busy ? "Working…" : row.auth_kind === "google" ? "Connect again" : "Connect"}
            </button>
          )}
          {google && row.auth_kind === "google" && (
            <button className="btn" onClick={onChoose} disabled={busy}>
              {row.property ? "Change property" : "Choose property"}
            </button>
          )}
          {ready && <button className="btn" onClick={onRefresh} disabled={busy}>{busy ? "Reading…" : "Refresh now"}</button>}
          <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={onManual}>Type in numbers</button>
          <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={onHistory}>History</button>
          <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={onEdit}>Edit</button>
          <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={onToggle}>
            {row.active === false ? "Switch on" : "Switch off"}
          </button>
          {row.auth_kind === "google" && (
            <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={onDisconnect} disabled={busy}>Disconnect</button>
          )}
          {confirmRemove ? (
            <>
              <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12, color: "var(--danger)" }} onClick={onRemove}>Yes, remove</button>
              <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setConfirmRemove(false)}>No</button>
            </>
          ) : (
            <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12, color: "var(--ink-dim)" }} onClick={() => setConfirmRemove(true)}>Remove</button>
          )}
        </div>
      </div>

      {staleScope && (
        <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12.5, lineHeight: 1.5 }}>
          This sign-in was granted before we needed everything we now read. One press of <strong>Connect again</strong> fixes it — nothing is lost.
        </div>
      )}
      {row.last_error && (
        <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 12.5, lineHeight: 1.5 }}>
          Last time: {row.last_error}
        </div>
      )}

      <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
        {snapshot ? <SnapshotLine snapshot={snapshot} /> : (
          <div style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>
            No numbers have been read from this account yet, so no report can quote it.
          </div>
        )}
      </div>
    </div>
  );
}

/** One reading, printed the only way it is ever allowed to be printed: with
 * the window it covers, the day it was taken, and who took it. */
export function SnapshotLine({ snapshot }) {
  const keys = (PROVIDER_METRICS[snapshot.provider] || [])
    .filter((k) => snapshot.metrics?.[k] !== null && snapshot.metrics?.[k] !== undefined);
  const extra = Object.keys(snapshot.metrics || {}).filter((k) => !keys.includes(k) && snapshot.metrics[k] !== null && snapshot.metrics[k] !== undefined);
  const all = [...keys, ...extra];
  return (
    <div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
        {all.length ? all.map((k) => (
          <div key={k}>
            <div style={{ fontFamily: "var(--display)", fontSize: 20, fontWeight: 700, color: "var(--ink)" }}>
              {formatMetric(k, snapshot.metrics[k])}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-dim)" }}>{METRIC_LABELS[k] || k}</div>
          </div>
        )) : (
          <div style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>The account returned no numbers for that window.</div>
        )}
      </div>
      <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--ink-dim)", fontFamily: "var(--mono)" }}>
        {snapshot.period_start} → {snapshot.period_end} · {snapshot.source === "manual" ? "TYPED IN BY ONE OF US" : "READ BY THIS CONSOLE"} on {String(snapshot.taken_at || "").slice(0, 10)}
      </div>
      {Array.isArray(snapshot.detail?.warnings) && snapshot.detail.warnings.length ? (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "#92400e" }}>{snapshot.detail.warnings.join(" ")}</div>
      ) : null}
      {Array.isArray(snapshot.detail?.topQueries) && snapshot.detail.topQueries.length ? (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-2)", lineHeight: 1.6 }}>
          <span className="label">Top searches</span>{" "}
          {snapshot.detail.topQueries.slice(0, 5).map((q) => `“${q.query}” (${q.clicks})`).join(" · ")}
        </div>
      ) : null}
      {Array.isArray(snapshot.detail?.topChannels) && snapshot.detail.topChannels.length ? (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-2)", lineHeight: 1.6 }}>
          <span className="label">Where visitors came from</span>{" "}
          {snapshot.detail.topChannels.slice(0, 5).map((c) => `${c.channel} (${c.sessions})`).join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* MODALS                                                              */
/* ------------------------------------------------------------------ */

function AddConnectionModal({ client, existing, onClose, onConnect, reload }) {
  const [provider, setProvider] = useState("gsc");
  const [busy, setBusy] = useState(false);
  const google = isGoogleProvider(provider);
  const already = existing.filter((r) => r.provider === provider);

  const addManual = async () => {
    setBusy(true);
    const res = await upsertClientConnection({
      client_id: client.id, provider, auth_kind: "manual",
      label: PROVIDER_LABELS[provider], status: "manual",
      sort: existing.length,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't add it", res.error); return; }
    toast.success("Added", `${PROVIDER_LABELS[provider]} — numbers get typed in until it is connected.`);
    onClose();
    reload();
  };

  return (
    <Modal open onClose={onClose} kicker="CONNECTIONS" title={`Add an account for ${client.name}`} width={620}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={addManual} disabled={busy}>Add without connecting</button>
        {google && <button className="btn btn-accent" onClick={() => onConnect(provider)} disabled={busy}>Sign in with Google</button>}
      </>}>
      <Field label="Which account" hint="One card per account. Which exact site or location it reads gets picked next.">
        <Select value={provider} onChange={(e) => setProvider(e.target.value)}
          options={PROVIDERS.map((p) => [p, PROVIDER_LABELS[p]])} />
      </Field>

      <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, marginTop: -4 }}>
        {PROVIDER_HELP[provider]}
      </div>

      <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: "var(--bg-3)" }}>
        <div className="label" style={{ marginBottom: 6 }}>What a report can say once this is connected</div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.7 }}>
          {(PROVIDER_ANSWERS[provider] || []).join(" · ")}
        </div>
      </div>

      {google ? (
        <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
          <strong>What happens when you press Sign in with Google:</strong> Google asks which account, then asks
          whether to let AI Syndicate {SCOPE_IS_READ_ONLY[provider] ? "read" : "manage"} it.
          {SCOPE_IS_READ_ONLY[provider]
            ? " We ask for read-only, so nothing here can change anything in their account."
            : " Google has no read-only permission for Business Profile, so the screen says manage. This console only ever reads — it has no code that writes to a listing."}
          {" "}Sign in with the account that already has access, or ask the client to add ours first.
        </div>
      ) : (
        <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
          This one cannot be signed into from here yet. Add the card and type its numbers in — every typed
          number is labelled as typed, and never gets described as something we measured.
        </div>
      )}

      {already.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: "#92400e", lineHeight: 1.55 }}>
          {client.name} already has {already.length} {PROVIDER_SHORT[provider]} card
          {already.length === 1 ? "" : "s"}. Add another only if it reads a different site or location — two
          cards may not end up pointed at the same one.
        </div>
      )}
    </Modal>
  );
}

function EditConnectionModal({ row, onClose, reload }) {
  const [f, setF] = useState({
    label: row.label || "", property: row.property || "", property_label: row.property_label || "",
    account_email: row.account_email || "", notes: row.notes || "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.label.trim()) { toast.warn("It needs a name"); return; }
    setBusy(true);
    const res = await upsertClientConnection({
      id: row.id,
      label: f.label.trim(),
      property: f.property.trim() || null,
      property_label: f.property_label.trim() || null,
      account_email: f.account_email.trim() || null,
      notes: f.notes.trim() || null,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't save", res.error); return; }
    toast.success("Saved", f.label);
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker="CONNECTIONS" title={`Edit ${PROVIDER_LABELS[row.provider]}`} width={600}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      <Field label="What to call it"><TextInput value={f.label} onChange={set("label")} /></Field>
      <Field label="Property" hint={PROPERTY_HELP[row.provider]}>
        <TextInput value={f.property} onChange={set("property")} placeholder={row.provider === "ga4" ? "properties/123456789" : row.provider === "gbp" ? "locations/1234567890" : "sc-domain:example.com"} />
      </Field>
      <Field label="What to call the property"><TextInput value={f.property_label} onChange={set("property_label")} /></Field>
      <Field label="Account email" hint="Which login this belongs to. Passwords never go here — the Vault holds those.">
        <TextInput value={f.account_email} onChange={set("account_email")} />
      </Field>
      <Field label="Notes"><TextArea value={f.notes} onChange={set("notes")} /></Field>
    </Modal>
  );
}

function PropertyModal({ row, live, onClose, reload }) {
  const [list, setList] = useState(null);
  /* True when Google had more to give than we asked for. A shortened list
   * that looks complete sends somebody hunting for a site that is really
   * there — or worse, makes them believe the account has no access. */
  const [cut, setCut] = useState(false);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(row.property || "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stop = false;
    (async () => {
      if (!live) { setError("Preview mode — a real account has to be signed in before this list can be read."); return; }
      const res = await apiFetch("/api/connector", { method: "POST", body: { action: "properties", connectionId: row.id } });
      if (stop) return;
      if (!res.ok) { setError(res.error); return; }
      setList(res.data.properties || []);
      setCut(Boolean(res.data.more));
    })();
    return () => { stop = true; };
  }, [row.id, live]);

  const choose = async () => {
    const chosen = (list || []).find((p) => p.property === picked);
    setBusy(true);
    const res = await apiFetch("/api/connector", {
      method: "POST",
      body: { action: "choose", connectionId: row.id, property: picked, propertyLabel: chosen?.label || "" },
    });
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't set that", res.error); return; }
    toast.success("Property set", chosen?.label || picked);
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker="CONNECTIONS" title={`Which one should we read?`} width={620}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={choose} disabled={busy || !picked}>{busy ? "Saving…" : "Use this one"}</button>
      </>}>
      <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, marginBottom: 12 }}>
        This sign-in can see everything below. Pick the one that belongs to this client. One card reads one
        property — a report about &ldquo;the site&rdquo; has to say which site.
      </div>

      {error ? (
        <div style={{ padding: 12, borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 12.5, lineHeight: 1.55 }}>
          {error}
        </div>
      ) : list === null ? (
        <div style={{ fontSize: 13, color: "var(--ink-dim)" }}>Asking Google what this account can see…</div>
      ) : list.length === 0 ? (
        <div style={{ padding: 12, borderRadius: 8, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12.5, lineHeight: 1.55 }}>
          That account can see nothing. Either it has not been given access to the client&apos;s property yet, or
          the sign-in used the wrong Google account. Ask the client to add it, then press Connect again.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8, maxHeight: 320, overflowY: "auto" }}>
          {cut ? (
            <div style={{ padding: "8px 12px", borderRadius: 8, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12, lineHeight: 1.5 }}>
              This account can see more than fits in one look, so the list below is not all of it. If the one you
              want is missing, type it in by hand with <strong>Edit</strong> on the card.
            </div>
          ) : null}
          {list.map((p) => (
            <label key={p.property} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, border: `1px solid ${picked === p.property ? "var(--accent-deep)" : "var(--line)"}`, background: picked === p.property ? "var(--accent-soft)" : "transparent", cursor: "pointer" }}>
              <input type="radio" name="prop" checked={picked === p.property} onChange={() => setPicked(p.property)} style={{ marginTop: 3 }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{p.label}</span>
                <span style={{ display: "block", fontSize: 11, color: "var(--ink-dim)", fontFamily: "var(--mono)", wordBreak: "break-all" }}>
                  {p.property}{p.permission ? ` · ${p.permission}` : ""}{p.account ? ` · ${p.account}` : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

function ManualNumbersModal({ row, client, member, onClose, reload }) {
  const keys = PROVIDER_METRICS[row.provider] || [];
  const [f, setF] = useState(() => Object.fromEntries(keys.map((k) => [k, ""])));
  const [dates, setDates] = useState({ start: "", end: "" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    /* Percent in, fraction stored. Everything that prints a click rate
     * multiplies by 100, so the stored number has to be the fraction. */
    const metrics = { ...f };
    if (metrics.ctr !== "" && metrics.ctr !== undefined && metrics.ctr !== null) {
      const pct = Number(metrics.ctr);
      metrics.ctr = Number.isFinite(pct) ? pct / 100 : "";
    }
    const res = await addManualSnapshot({
      clientId: client.id, connectionId: row.id, provider: row.provider,
      property: row.property || "",
      periodStart: dates.start, periodEnd: dates.end,
      metrics, note: note.trim() || null, userId: member?.user_id || null,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Not saved", res.error); return; }
    toast.success("Numbers saved", "Labelled as typed in by one of us — never as measured by this console.");
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker="CONNECTIONS" title={`Type in ${PROVIDER_SHORT[row.provider]} numbers`} width={620}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save these numbers"}</button>
      </>}>
      <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, marginBottom: 12 }}>
        Read these off the client&apos;s own screen and type them in. They are saved as
        <strong> typed in by one of us</strong> — every report that uses them says so, and they are never
        described as something this console measured.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
        <Field label="First day these cover"><TextInput type="date" value={dates.start} onChange={(e) => setDates({ ...dates, start: e.target.value })} /></Field>
        <Field label="Last day these cover"><TextInput type="date" value={dates.end} onChange={(e) => setDates({ ...dates, end: e.target.value })} /></Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
        {keys.map((k) => (
          <Field
            key={k}
            /* A click rate is read off Google's screen as "3.2%", and a plain
             * box labelled "click rate" got 3.2 typed into it — which the
             * console then printed as 320.0%. The box says what it wants, and
             * the number is converted on the way in. */
            label={k === "ctr" ? "click rate, in percent (3.2 for 3.2%)" : (METRIC_LABELS[k] || k)}
            hint="Leave blank if you do not have it."
          >
            <TextInput inputMode="decimal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      {!keys.length && (
        <Field label="There is no fixed list for this one" hint="Add the account as Search Console, Business Profile or Analytics to get named boxes.">
          <div style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>Nothing to type here yet.</div>
        </Field>
      )}
      <Field label="Note" hint="Where you read these, and anything odd about them.">
        <TextArea value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function HistoryModal({ row, snapshots, onClose }) {
  return (
    <Modal open onClose={onClose} kicker="CONNECTIONS" title={`Readings — ${PROVIDER_LABELS[row.provider]}`} width={680}
      footer={<button className="btn" onClick={onClose}>Close</button>}>
      {snapshots.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--ink-dim)" }}>Nothing has been read from this account yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {snapshots.map((s) => (
            <div key={s.id} className="card" style={{ padding: 14 }}>
              <SnapshotLine snapshot={s} />
              {s.note && <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--ink-2)" }}>{s.note}</div>}
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 12, fontSize: 11.5, color: "var(--ink-dim)", lineHeight: 1.55 }}>
        Old readings are never rewritten. A report written in March quotes March&apos;s numbers, and has to stay
        checkable against them for ever. This box shows the newest readings for this client, not necessarily
        every one ever taken — the page reads the most recent 60 across all of their accounts.
      </div>
    </Modal>
  );
}
