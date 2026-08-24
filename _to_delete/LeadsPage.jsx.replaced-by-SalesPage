import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  listLeads, upsertLead, listLeadActivity, addLeadActivity,
  listAllLeadActivity, listTeam, logActivity, listLeadSources, buildCallQueue,
  LEAD_STAGES, LEAD_STAGE_LABELS,
} from "../../lib/data.js";
import { ImportModal, SourcesModal } from "./leadsIntake.jsx";
import { useScreenContext } from "../../lib/screenContext.js";
import { apiFetch } from "../../lib/adminApi.js";
import { toast } from "../../lib/toast.js";
import {
  MetricCard, SourceBadge, Modal, Field, TextInput, TextArea, Select,
  EmptyState, timeAgo,
} from "./shared.jsx";

/* Leads — the sales floor. Admins see everything including rep stats;
 * sales reps see the same pipeline minus delete + team stats. */

const STAGE_TONE = {
  new: { c: "var(--accent-deep)", bg: "var(--accent-soft)" },
  contacted: { c: "#0369a1", bg: "#e0f2fe" },
  follow_up: { c: "#92400e", bg: "#fffbeb" },
  meeting: { c: "#6d28d9", bg: "#f5f3ff" },
  proposal: { c: "#9d174d", bg: "#fdf2f8" },
  won: { c: "#006b1a", bg: "var(--success-soft)" },
  lost: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
};

function StagePill({ stage }) {
  const t = STAGE_TONE[stage] || STAGE_TONE.new;
  return (
    <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 99, fontSize: 10, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em", color: t.c, background: t.bg }}>
      {(LEAD_STAGE_LABELS[stage] || stage).toUpperCase()}
    </span>
  );
}

const OUTCOMES = [["talked", "Talked"], ["voicemail", "Voicemail"], ["no_answer", "No answer"], ["booked", "Booked meeting"], ["not_interested", "Not interested"], ["bad_number", "Bad number"]];

export default function LeadsPage({ member }) {
  const isAdmin = member.role !== "sales";
  const [leads, setLeads] = useState({ rows: [], sample: true });
  const [team, setTeam] = useState([]);
  const [q, setQ] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [mineOnly, setMineOnly] = useState(member.role === "sales");
  const [view, setView] = useState(member.role === "sales" ? "queue" : "table"); // queue | table | board
  const [sources, setSources] = useState([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [openLead, setOpenLead] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);

  const load = useCallback(async () => {
    const [l, t, src] = await Promise.all([listLeads(), listTeam(), listLeadSources()]);
    setLeads(l);
    setTeam(t.rows);
    setSources(src.rows);
  }, []);

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  const teamName = useCallback((userId) => {
    if (!userId) return null;
    const m = team.find((t) => t.user_id === userId);
    return m ? (m.full_name || m.email) : "someone";
  }, [team]);

  const rows = useMemo(() => {
    let list = leads.rows;
    if (stageFilter !== "all") list = list.filter((l) => l.stage === stageFilter);
    if (mineOnly) list = list.filter((l) => l.owner_id === member.user_id);
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((l) => `${l.name || ""} ${l.company || ""} ${l.email || ""} ${l.domain || ""} ${l.city || ""}`.toLowerCase().includes(needle));
    return list;
  }, [leads, q, stageFilter, mineOnly, member.user_id]);

  const counts = useMemo(() => ({
    new: leads.rows.filter((l) => l.stage === "new").length,
    working: leads.rows.filter((l) => ["contacted", "follow_up", "meeting", "proposal"].includes(l.stage)).length,
    won: leads.rows.filter((l) => l.stage === "won").length,
    mine: leads.rows.filter((l) => l.owner_id === member.user_id && !["won", "lost"].includes(l.stage)).length,
  }), [leads, member.user_id]);

  /* THE CALL QUEUE — the rep's actual job, in order.
   *
   * Built from the same staleness rules as the Work page (buildCallQueue in
   * data.js calls the same STALE_AFTER_DAYS table), so a rep can never see a
   * lead here that their Work page says is fine, or the other way round. That
   * disagreement is the classic way two screens quietly stop being trusted. */
  const queue = useMemo(
    () => buildCallQueue(leads.rows, member.user_id, { includeUnclaimed: true }),
    [leads.rows, member.user_id]
  );
  const owed = queue.filter((q) => q.over >= 0);

  /* Tell the assistant what is on screen. The open lead if there is one,
   * otherwise the list they are looking at. Nothing else travels — see
   * src/lib/screenContext.js for why this is stated rather than scraped. */
  useScreenContext(() => ({
    page: "Leads",
    label: openLead
      ? null
      : `${rows.length} lead${rows.length === 1 ? "" : "s"} shown${stageFilter !== "all" ? `, stage ${stageFilter}` : ""}${mineOnly ? ", mine only" : ""}`,
    record: openLead
      ? { type: "lead", id: openLead.id, label: openLead.name || openLead.company || "unnamed lead" }
      : null,
    visible: rows.slice(0, 20).map((l) => `${l.name || l.company || "unnamed"} (${l.stage})`),
  }), [openLead, rows, stageFilter, mineOnly]);

  const patchLead = async (id, patch, note) => {
    const res = await upsertLead({ id, ...patch });
    if (!res.ok) { toast.error("Save failed", res.error); return false; }
    if (note) {
      await addLeadActivity({ leadId: id, actor: member.user_id, type: "status_change", body: note });
    }
    await load();
    return true;
  };

  const badgeMode = leads.sample ? "sample" : "live";

  return (
    <>
      {/* Stat tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
        <MetricCard label="New · unclaimed" value={counts.new} badge={<SourceBadge mode={badgeMode} />} hint="waiting for a rep" />
        <MetricCard label="Being worked" value={counts.working} hint="contacted → proposal" />
        <MetricCard label="Won · all time" value={counts.won} hint="marked won" />
        <MetricCard label="My open leads" value={counts.mine} hint={member.full_name || member.email} />
      </div>

      {/* Toolbar */}
      <div className="card" style={{ padding: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px" }}>
          <TextInput placeholder="Search name, company, email, city…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="adm-input" style={{ width: 150 }} value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
          <option value="all">All stages</option>
          {LEAD_STAGES.map((s) => <option key={s} value={s}>{LEAD_STAGE_LABELS[s]}</option>)}
        </select>
        <button className={`btn ${mineOnly ? "btn-accent" : ""}`} style={{ padding: "9px 13px", fontSize: 13 }} onClick={() => setMineOnly(!mineOnly)}>
          {mineOnly ? "✓ My leads" : "My leads"}
        </button>
        <div style={{ display: "inline-flex", padding: 3, borderRadius: 10, background: "white", border: "1px solid var(--rule)" }}>
          {[["queue", "My queue"], ["table", "Table"], ["board", "Board"]].map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} title={v === "queue" ? "Who to call next, coldest first" : undefined} style={{ padding: "6px 12px", border: 0, borderRadius: 7, background: view === v ? "var(--ink)" : "transparent", color: view === v ? "white" : "var(--ink-2)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--body)" }}>
              {label}{v === "queue" && owed.length ? ` · ${owed.length}` : ""}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {isAdmin && <button className="btn" onClick={() => setStatsOpen(true)}>Rep stats</button>}
          <button className="btn" onClick={() => setSourcesOpen(true)} title="Imported lists and saved searches">
            Where leads come from{sources.some((x) => x.last_run_error) ? " ⚠" : ""}
          </button>
          {isAdmin && <button className="btn" onClick={() => setImportOpen(true)}>Import a list</button>}
          <button className="btn btn-accent" onClick={() => setAddOpen(true)}>+ Add lead</button>
        </div>
      </div>

      {/* List */}
      {rows.length === 0 ? (
        <EmptyState
          icon="☎"
          title={leads.rows.length === 0 ? "The pipeline is empty" : "Nothing matches those filters"}
          body={leads.rows.length === 0
            ? "Add a lead by hand, or import a CSV list — column names are matched automatically and you confirm before anything saves."
            : "Clear the search or stage filter to see the rest."}
          action={leads.rows.length === 0
            ? (isAdmin
              ? <button className="btn btn-accent" onClick={() => setImportOpen(true)}>Import your first list</button>
              : <button className="btn" onClick={() => setAddOpen(true)}>Add a lead by hand</button>)
            : <button className="btn" onClick={() => { setQ(""); setStageFilter("all"); setMineOnly(false); }}>Clear filters</button>}
        />
      ) : view === "queue" ? (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--rule)", background: "var(--bg-1)" }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>
              {owed.length ? `${owed.length} owed a contact right now` : "Nothing is overdue"}
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-dim)", marginTop: 2 }}>
              Coldest first. A lead counts as owed once it has sat longer than its stage allows —
              a day for a new lead, three once you have spoken, five while you are following up.
              Unclaimed leads are shown too, so nothing sits in the pool unnoticed.
            </div>
          </div>
          {queue.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--ink-dim)", fontSize: 13 }}>
              No open leads with your name on them, and nothing unclaimed.
            </div>
          ) : (
            <div>
              {queue.slice(0, 60).map(({ lead: l, over, mine }) => (
                <div key={l.id} className="adm-row-click" onClick={() => setOpenLead(l)}
                  style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 16px", borderTop: "1px solid var(--rule)", cursor: "pointer" }}>
                  <div style={{
                    width: 58, flexShrink: 0, textAlign: "center", padding: "4px 0", borderRadius: 8,
                    background: over >= 3 ? "#fef2f2" : over >= 0 ? "#fffbeb" : "var(--bg-2)",
                    color: over >= 3 ? "var(--danger)" : over >= 0 ? "#92400e" : "var(--ink-dim)",
                    fontFamily: "var(--mono)", fontSize: 10.5, fontWeight: 800, letterSpacing: "0.04em",
                  }}>
                    {/* "0D LATE" is not a thing a person says. A lead that has
                        just crossed its line is due now; one that has not is fine. */}
                    {over > 0 ? `${over}D LATE` : over === 0 ? "DUE NOW" : "OK"}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>
                      {l.name || l.company || "unnamed"}
                      {!mine && <span style={{ marginLeft: 8, fontSize: 10, fontFamily: "var(--mono)", fontWeight: 800, letterSpacing: "0.06em", color: "var(--accent-deep)" }}>UNCLAIMED</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>
                      {[l.company && l.name ? l.company : null, l.city ? `${l.city}${l.state ? `, ${l.state}` : ""}` : null, l.phone || l.email].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <StagePill stage={l.stage} />
                  <div style={{ width: 92, textAlign: "right", flexShrink: 0, fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-faint)" }}>
                    {l.last_activity_at ? timeAgo(l.last_activity_at) : "never"}
                  </div>
                </div>
              ))}
              {queue.length > 60 && (
                <div style={{ padding: "10px 16px", borderTop: "1px solid var(--rule)", fontSize: 11.5, color: "var(--ink-faint)" }}>
                  Showing the first 60 of {queue.length}. Work these and the rest move up.
                </div>
              )}
            </div>
          )}
        </div>
      ) : view === "table" ? (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="adm-table">
              <thead>
                <tr><th>Lead</th><th>Contact</th><th>Stage</th><th>Rep</th><th>Last activity</th><th>Source</th></tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className="adm-row-click" onClick={() => setOpenLead(l)}>
                    <td>
                      <div style={{ fontWeight: 600, color: "var(--ink)" }}>{l.name || l.company || "—"}</div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>{l.company && l.name ? l.company : (l.domain || "")}{l.city ? ` · ${l.city}${l.state ? `, ${l.state}` : ""}` : ""}</div>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <div>{l.email || <span style={{ color: "var(--ink-faint)" }}>no email</span>}</div>
                      <div style={{ color: "var(--ink-dim)" }}>{l.phone || ""}</div>
                    </td>
                    <td><StagePill stage={l.stage} /></td>
                    <td style={{ fontSize: 12.5 }}>{teamName(l.owner_id) || <span style={{ color: "var(--ink-faint)" }}>unclaimed</span>}</td>
                    <td style={{ whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 11 }}>{l.last_activity_at ? timeAgo(l.last_activity_at) : "—"}</td>
                    <td style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.06em", color: "var(--ink-dim)" }}>{(l.source || "").toUpperCase()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="adm-board">
          {LEAD_STAGES.map((stage) => {
            const col = rows.filter((l) => l.stage === stage);
            return (
              <div key={stage} className="adm-board-col">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <StagePill stage={stage} />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-dim)" }}>{col.length}</span>
                </div>
                {col.map((l) => (
                  <div key={l.id} className="adm-board-card" onClick={() => setOpenLead(l)}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{l.name || l.company || "—"}</div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-dim)", marginTop: 2 }}>{l.company && l.name ? l.company : l.domain || ""}</div>
                    <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 10.5, color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>{teamName(l.owner_id) || "unclaimed"}</span>
                      {l.score != null && <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", fontWeight: 700, color: "var(--accent-deep)" }}>{l.score}</span>}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {openLead && (
        <LeadDrawer
          lead={leads.rows.find((l) => l.id === openLead.id) || openLead}
          member={member}
          isAdmin={isAdmin}
          team={team}
          teamName={teamName}
          onClose={() => setOpenLead(null)}
          onPatch={patchLead}
          reload={load}
        />
      )}
      {addOpen && <AddLeadModal member={member} onClose={() => setAddOpen(false)} reload={load} />}
      {importOpen && <ImportModal member={member} team={team} onClose={() => setImportOpen(false)} reload={load} />}
      {sourcesOpen && (
        <SourcesModal member={member} team={team} sources={sources}
          onClose={() => setSourcesOpen(false)} reload={load} />
      )}
      {statsOpen && <RepStatsModal team={team} leads={leads.rows} onClose={() => setStatsOpen(false)} />}
    </>
  );
}

/* ------------------------------------------------------------------ */

function LeadDrawer({ lead, member, isAdmin, team, teamName, onClose, onPatch, reload }) {
  const [activity, setActivity] = useState([]);
  const [logType, setLogType] = useState("call");
  const [logOutcome, setLogOutcome] = useState("talked");
  const [logBody, setLogBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draft, setDraft] = useState("");

  const loadActivity = useCallback(async () => {
    const a = await listLeadActivity(lead.id);
    setActivity(a.rows);
  }, [lead.id]);

  useEffect(() => { loadActivity(); }, [loadActivity]);

  const logIt = async () => {
    if (logType !== "note" && !logOutcome) { toast.warn("Pick an outcome first"); return; }
    if (logType === "note" && !logBody.trim()) { toast.warn("Write the note first"); return; }
    setBusy(true);
    const res = await addLeadActivity({
      leadId: lead.id, actor: member.user_id, type: logType,
      outcome: logType === "note" ? null : logOutcome, body: logBody.trim() || null,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't log that", res.error); return; }
    await logActivity({ actor: member.user_id, kind: `lead_${logType}`, title: `${logType === "call" ? "Called" : logType === "email" ? "Emailed" : logType === "text" ? "Texted" : "Note on"} ${lead.name || lead.company || "a lead"}`, body: logBody.trim() || logOutcome });
    setLogBody("");
    toast.success("Logged", `${logType} saved to this lead's timeline.`);
    await loadActivity();
    await reload();
  };

  const claim = async () => {
    if (await onPatch(lead.id, { owner_id: member.user_id }, `claimed by ${member.full_name || member.email}`)) {
      toast.success("Lead claimed", "It now shows under My leads.");
    }
  };

  const aiOutreach = async () => {
    setDraftBusy(true);
    const res = await apiFetch("/api/ai-draft", {
      method: "POST",
      body: {
        kind: "lead_outreach",
        context: `Lead: ${lead.name || "?"} at ${lead.company || "?"} (${lead.vertical || "unknown industry"}), ${lead.city || ""} ${lead.state || ""}. Website: ${lead.domain || "unknown"}. Notes: ${lead.notes || "none"}.`,
      },
    });
    setDraftBusy(false);
    if (!res.ok) {
      if (res.preview) setDraft("PREVIEW — with the AI key set, a personalized outreach draft appears here based on this lead's info and the Brain's rules.");
      else toast.error("Draft failed", res.error);
      if (!res.preview) return;
    } else {
      setDraft(res.data.text);
    }
  };

  return createPortal(
    <>
      <div className="adm-drawer-backdrop" onClick={onClose} />
      <div className="adm-drawer" role="dialog" aria-modal="true" aria-label={`Lead: ${lead.name || lead.company}`}>
        <div className="adm-drawer-head">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <div style={{ fontFamily: "var(--display)", fontSize: 20, fontWeight: 700, color: "var(--ink)" }}>{lead.name || lead.company || "Lead"}</div>
              <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 2 }}>
                {[lead.company && lead.name ? lead.company : null, lead.city ? `${lead.city}${lead.state ? `, ${lead.state}` : ""}` : null, lead.vertical].filter(Boolean).join(" · ")}
              </div>
            </div>
            <button className="adm-modal-x" onClick={onClose} aria-label="Close">×</button>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select className="adm-input" style={{ width: 150 }} value={lead.stage} onChange={async (e) => {
              const to = e.target.value;
              if (await onPatch(lead.id, { stage: to, ...(to === "won" ? { became_customer: true } : {}) }, `${lead.stage} → ${to}`)) {
                toast.success("Stage updated", `${LEAD_STAGE_LABELS[lead.stage]} → ${LEAD_STAGE_LABELS[to]}`);
              }
            }}>
              {LEAD_STAGES.map((s) => <option key={s} value={s}>{LEAD_STAGE_LABELS[s]}</option>)}
            </select>
            {isAdmin ? (
              <select className="adm-input" style={{ width: 170 }} value={lead.owner_id || ""} onChange={async (e) => {
                const v = e.target.value || null;
                if (await onPatch(lead.id, { owner_id: v }, v ? `assigned to ${teamName(v)}` : "unassigned")) {
                  toast.success(v ? "Assigned" : "Unassigned", v ? `Now with ${teamName(v)}.` : "Back in the pool.");
                }
              }}>
                <option value="">Unclaimed</option>
                {team.filter((t) => t.active).map((t) => <option key={t.user_id} value={t.user_id}>{t.full_name || t.email}</option>)}
              </select>
            ) : lead.owner_id !== member.user_id && (
              <button className="btn btn-accent" style={{ padding: "9px 14px", fontSize: 13 }} onClick={claim}>Claim this lead</button>
            )}
          </div>
        </div>

        <div className="adm-drawer-body">
          <dl className="adm-kv">
            <dt>Email</dt><dd>{lead.email ? <a href={`mailto:${lead.email}`} style={{ color: "var(--accent-deep)" }}>{lead.email}</a> : "—"}</dd>
            <dt>Phone</dt><dd>{lead.phone ? <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} style={{ color: "var(--accent-deep)" }}>{lead.phone}</a> : "—"}</dd>
            <dt>Website</dt><dd>{lead.domain ? <a href={`https://${lead.domain.replace(/^https?:\/\//, "")}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-deep)" }}>{lead.domain}</a> : "—"}</dd>
            <dt>Source</dt><dd style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{(lead.source || "manual").toUpperCase()}</dd>
            {lead.score != null && <><dt>Fit score</dt><dd>{lead.score}/100</dd></>}
            {lead.notes && <><dt>Notes</dt><dd>{lead.notes}</dd></>}
          </dl>

          {/* AI outreach */}
          <div style={{ marginTop: 20, padding: 14, borderRadius: 12, background: "var(--accent-soft)", border: "1px solid color-mix(in oklab, var(--accent) 25%, transparent)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>AI outreach draft</div>
              <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={aiOutreach} disabled={draftBusy}>
                {draftBusy ? "Drafting…" : draft ? "Redraft" : "Draft it"}
              </button>
            </div>
            {draft && (
              <>
                <div style={{ marginTop: 10, padding: 12, background: "white", borderRadius: 8, fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--ink-2)" }}>{draft}</div>
                <button
                  className="btn"
                  style={{ marginTop: 8, padding: "6px 12px", fontSize: 12 }}
                  onClick={async () => {
                    try { await navigator.clipboard.writeText(draft); toast.success("Copied to clipboard"); }
                    catch { toast.warn("Couldn't copy — select the text by hand."); }
                  }}
                >
                  Copy
                </button>
              </>
            )}
          </div>

          {/* Log activity */}
          <div style={{ marginTop: 20 }}>
            <div className="label" style={{ marginBottom: 8 }}>Log what you did</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Select style={{ width: 110 }} value={logType} onChange={(e) => setLogType(e.target.value)}
                options={[["call", "Call"], ["email", "Email"], ["text", "Text"], ["note", "Note"]]} />
              {logType !== "note" && (
                <Select style={{ width: 160 }} value={logOutcome} onChange={(e) => setLogOutcome(e.target.value)} options={OUTCOMES} />
              )}
            </div>
            <TextArea style={{ marginTop: 8 }} placeholder={logType === "note" ? "Write the note…" : "Anything worth remembering about it? (optional)"} value={logBody} onChange={(e) => setLogBody(e.target.value)} />
            <button className="btn btn-accent" style={{ marginTop: 8 }} onClick={logIt} disabled={busy}>
              {busy ? "Saving…" : "Log it"}
            </button>
          </div>

          {/* Timeline */}
          <div style={{ marginTop: 24 }}>
            <div className="label" style={{ marginBottom: 10 }}>Timeline</div>
            {activity.length ? (
              <div className="adm-timeline">
                {activity.map((a) => (
                  <div key={a.id} className="adm-timeline-item">
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>
                      {a.type === "status_change" ? "Stage change" : a.type[0].toUpperCase() + a.type.slice(1)}
                      {a.outcome ? <span style={{ fontFamily: "var(--mono)", fontSize: 10, marginLeft: 8, color: "var(--accent-deep)", letterSpacing: "0.06em" }}>{a.outcome.toUpperCase().replace("_", " ")}</span> : null}
                    </div>
                    {a.body && <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2, lineHeight: 1.5 }}>{a.body}</div>}
                    <div style={{ fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--mono)", marginTop: 3 }}>{timeAgo(a.created_at).toUpperCase()}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>Nothing yet — the first call you log starts the timeline.</div>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

/* ------------------------------------------------------------------ */

function AddLeadModal({ member, onClose, reload }) {
  const [f, setF] = useState({ name: "", company: "", domain: "", email: "", phone: "", city: "", state: "", vertical: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.name.trim() && !f.company.trim()) { toast.warn("Give the lead a name or a company"); return; }
    if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) { toast.warn("That email doesn't look right"); return; }
    setBusy(true);
    const res = await upsertLead({
      ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null])),
      source: "manual", stage: "new",
    });
    setBusy(false);
    if (!res.ok) { toast.error("Couldn't save", res.error); return; }
    await logActivity({ actor: member.user_id, kind: "lead_added", title: `Added lead: ${f.name || f.company}` });
    toast.success("Lead added", "It's in the pipeline as New.");
    onClose();
    reload();
  };

  return (
    <Modal open onClose={onClose} kicker="SALES" title="Add a lead" width={560}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Add lead"}</button>
      </>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
        <Field label="Name"><TextInput value={f.name} onChange={set("name")} placeholder="Sarah Chen" /></Field>
        <Field label="Company"><TextInput value={f.company} onChange={set("company")} placeholder="Chen Dental Studio" /></Field>
        <Field label="Email"><TextInput type="email" value={f.email} onChange={set("email")} placeholder="sarah@…" /></Field>
        <Field label="Phone"><TextInput value={f.phone} onChange={set("phone")} placeholder="(555) 000-0000" /></Field>
        <Field label="Website"><TextInput value={f.domain} onChange={set("domain")} placeholder="chendental.com" /></Field>
        <Field label="Industry"><TextInput value={f.vertical} onChange={set("vertical")} placeholder="realtor / lawyer / medspa…" /></Field>
        <Field label="City"><TextInput value={f.city} onChange={set("city")} /></Field>
        <Field label="State"><TextInput value={f.state} onChange={set("state")} placeholder="TX" /></Field>
      </div>
      <Field label="Notes"><TextArea value={f.notes} onChange={set("notes")} placeholder="Where they came from, what they need…" /></Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function RepStatsModal({ team, leads, onClose }) {
  const [activity, setActivity] = useState(null);
  useEffect(() => {
    listAllLeadActivity(30).then((a) => setActivity(a.rows));
  }, []);

  const reps = team.filter((t) => t.active);
  const stats = reps.map((r) => {
    const acts = (activity || []).filter((a) => a.actor === r.user_id);
    const owned = leads.filter((l) => l.owner_id === r.user_id);
    return {
      rep: r,
      calls: acts.filter((a) => a.type === "call").length,
      emails: acts.filter((a) => a.type === "email").length,
      open: owned.filter((l) => !["won", "lost"].includes(l.stage)).length,
      won: owned.filter((l) => l.stage === "won").length,
    };
  });

  return (
    <Modal open onClose={onClose} kicker="LAST 30 DAYS" title="Rep activity" width={640}>
      {!activity ? (
        <div style={{ padding: 20, textAlign: "center", color: "var(--ink-dim)", fontSize: 13 }}>Loading…</div>
      ) : (
        <table className="adm-table">
          <thead><tr><th>Rep</th><th style={{ textAlign: "right" }}>Calls</th><th style={{ textAlign: "right" }}>Emails</th><th style={{ textAlign: "right" }}>Open leads</th><th style={{ textAlign: "right" }}>Won</th></tr></thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.rep.user_id}>
                <td>
                  <div style={{ fontWeight: 600, color: "var(--ink)" }}>{s.rep.full_name || s.rep.email}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-dim)", fontFamily: "var(--mono)" }}>{s.rep.role.toUpperCase()}</div>
                </td>
                <td style={{ textAlign: "right", fontWeight: 700 }}>{s.calls}</td>
                <td style={{ textAlign: "right", fontWeight: 700 }}>{s.emails}</td>
                <td style={{ textAlign: "right" }}>{s.open}</td>
                <td style={{ textAlign: "right", color: "#006b1a", fontWeight: 700 }}>{s.won}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 12 }}>
        Counted from logged activity — if a call isn't logged on the lead, it isn't counted.
      </p>
    </Modal>
  );
}
