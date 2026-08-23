import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LEAD_STAGES, LEAD_STAGE_LABELS,
  getSalesBoard, upsertLead, claimLead, addLeadActivity, logActivity,
} from "../../lib/data.js";
import {
  salesQueue, claimState, scoreGate, repStats, listHealth, isOpenStage, ROE,
} from "../../../lib/sales-rules.js";
import { useScreenContext } from "../../lib/screenContext.js";
import { toast } from "../../lib/toast.js";
import { SourceBadge, Modal, Field, TextInput, TextArea, Select, timeAgo } from "./shared.jsx";
import { StagePill, ClaimChip, ScoreChip, LateBox, Tile, MiniBar, SiteLink } from "./salesParts.jsx";
import SalesProfile from "./salesProfile.jsx";
import { SalesImportModal } from "./salesImport.jsx";
/* Saved searches and imported-list records. Carried over from the old Leads
 * page rather than rewritten — it already works, and dropping it would have
 * quietly removed the scraper controls along with the page's old name. */
import { SourcesModal } from "./leadsIntake.jsx";

/* SALES — the page that replaces CJ's outreach spreadsheet.
 *
 * Four views, and which one you land on depends on your job:
 *   My Day    — a rep's actual work, in the order to do it. Reps land here.
 *   Lists     — the sheet's tabs, as a grid. Owners land here.
 *   Pipeline  — the same leads as a board, by stage.
 *   Firms     — one row per company, with its site score. The view the sheet
 *               could never have, because it knew rows and not firms.
 *
 * Everything is read in ONE call (getSalesBoard) so the tiles at the top and
 * the list underneath can never be counting different snapshots — a header
 * that says 3 above a list of four is how a screen stops being believed.
 */

const VIEWS = [["day", "My Day"], ["lists", "Lists"], ["pipeline", "Pipeline"], ["firms", "Firms"]];

export default function SalesPage({ member }) {
  const isAdmin = member.role !== "sales";
  const [board, setBoard] = useState(null);
  const [view, setView] = useState(member.role === "sales" ? "day" : "lists");
  const [q, setQ] = useState("");
  const [listFilter, setListFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("open");
  const [ownerFilter, setOwnerFilter] = useState(member.role === "sales" ? member.user_id : "all");
  const [openId, setOpenId] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  /* One clock for the whole render. Calling Date.now() inside each row would
   * mean two rows on the same screen disagreeing about what day it is at
   * midnight — rare, and impossible to reproduce when somebody reports it. */
  const [now, setNow] = useState(() => new Date().toISOString());

  const load = useCallback(async () => {
    const b = await getSalesBoard();
    setBoard(b);
    setNow(new Date().toISOString());
  }, []);

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  const teamName = useCallback((userId) => {
    if (!userId || !board) return null;
    const m = board.team.find((t) => t.user_id === userId);
    return m ? (m.full_name || m.email) : "someone";
  }, [board]);

  const companyById = useMemo(() => {
    const m = new Map();
    for (const c of board?.companies || []) m.set(c.id, c);
    return m;
  }, [board]);

  const siblingsOf = useCallback((lead) => {
    if (!lead?.company_id) return [lead].filter(Boolean);
    return (board?.leads || []).filter((l) => l.company_id === lead.company_id);
  }, [board]);

  const scoreOf = useCallback((lead) => companyById.get(lead.company_id)?.site_score ?? null, [companyById]);

  /* ---- the filtered set every view draws from ---- */
  const rows = useMemo(() => {
    let list = board?.leads || [];
    if (listFilter !== "all") list = list.filter((l) => l.list_id === listFilter);
    if (stageFilter === "open") list = list.filter((l) => isOpenStage(l.stage));
    else if (stageFilter === "closed") list = list.filter((l) => !isOpenStage(l.stage));
    else if (stageFilter !== "all") list = list.filter((l) => l.stage === stageFilter);
    if (ownerFilter === "mine") list = list.filter((l) => l.owner_id === member.user_id);
    else if (ownerFilter === "floor") list = list.filter((l) => !l.owner_id);
    else if (ownerFilter !== "all") list = list.filter((l) => l.owner_id === ownerFilter);
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((l) => {
        const co = companyById.get(l.company_id);
        return `${l.name || ""} ${l.company || ""} ${co?.name || ""} ${l.email || ""} ${l.title || ""} ${l.city || ""} ${co?.domain || ""}`
          .toLowerCase().includes(needle);
      });
    }
    return list;
  }, [board, listFilter, stageFilter, ownerFilter, q, member.user_id, companyById]);

  const queue = useMemo(() => {
    if (!board) return [];
    return salesQueue(board.leads, {
      userId: member.user_id, now,
      touchCounts: board.touchCounts,
      includeUnclaimed: true,
      scoreOf,
    });
  }, [board, member.user_id, now, scoreOf]);

  const owed = queue.filter((c) => c.over !== null && c.over >= 0 && c.reason !== "unclaimed");

  const counts = useMemo(() => {
    const all = board?.leads || [];
    const open = all.filter((l) => isOpenStage(l.stage));
    return {
      floor: open.filter((l) => !l.owner_id).length,
      mine: open.filter((l) => l.owner_id === member.user_id).length,
      owed: owed.length,
      atRisk: open.filter((l) => ["claim_expired", "cold"].includes(claimState(l, now).state)).length,
      meetings: all.filter((l) => ["meeting", "proposal"].includes(l.stage)).length,
      won: all.filter((l) => l.stage === "won").length,
    };
  }, [board, member.user_id, now, owed.length]);

  const openLead = openId ? (board?.leads || []).find((l) => l.id === openId) : null;

  useScreenContext(() => ({
    page: "Sales",
    label: openLead ? null : `${VIEWS.find((v) => v[0] === view)?.[1]} · ${rows.length} contacts shown`,
    record: openLead
      ? { type: "lead", id: openLead.id, label: openLead.name || openLead.company || "unnamed contact" }
      : null,
    visible: rows.slice(0, 20).map((l) => `${l.name || l.company || "unnamed"} (${l.stage})`),
  }), [openLead, rows, view]);

  const quickClaim = async (lead) => {
    const res = await claimLead(lead.id, member.user_id, { name: member.full_name || member.email });
    if (!res.ok) { toast.error("Could not claim it", res.error); return; }
    toast.success("Claimed", `First contact within ${ROE.FIRST_CONTACT_BUSINESS_DAYS} business days, or it goes back to the floor.`);
    await load();
  };

  if (!board) return <div className="adm-sl-loading">Reading the pipeline…</div>;

  const badge = board.sample ? "sample" : "live";

  return (
    <>
      {board.errors.length > 0 && (
        <div className="adm-sl-warn" role="alert">
          <strong>Some of this did not load.</strong> {board.errors.join(" · ")} The numbers below are
          therefore incomplete — do not read them as a full picture.
        </div>
      )}

      {/* A cap is as important to say out loud as an error. Every tile and
          every list below is counted from what was actually fetched, and a
          page quietly showing half the pipeline reads exactly like a page
          showing all of it. */}
      {board.truncated.length > 0 && (
        <div className="adm-sl-warn" role="status">
          <strong>Not everything is loaded.</strong> {board.truncated.join(" ")}
        </div>
      )}

      {/* ---- tiles ---- */}
      <div className="adm-sl-tiles">
        <Tile label="On the floor" value={counts.floor} hint="nobody has claimed" onClick={() => { setView("lists"); setOwnerFilter("floor"); setStageFilter("open"); }} active={ownerFilter === "floor"} />
        <Tile label="Yours, open" value={counts.mine} hint={member.full_name || member.email} onClick={() => { setView("lists"); setOwnerFilter("mine"); setStageFilter("open"); }} active={ownerFilter === "mine"} />
        <Tile label="Owed a touch today" value={counts.owed} hint="from the cadence and the timers" tone={counts.owed ? "var(--danger)" : undefined} onClick={() => setView("day")} active={view === "day"} />
        <Tile label="Claims at risk" value={counts.atRisk} hint="run out or gone cold" tone={counts.atRisk ? "#92400e" : undefined} />
        <Tile label="Meetings + proposals" value={counts.meetings} hint="live conversations" />
        <Tile label="Won" value={counts.won} hint="all time" />
      </div>

      {/* ---- toolbar ---- */}
      <div className="card adm-sl-bar">
        <div className="adm-sl-views">
          {VIEWS.map(([v, label]) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              {label}{v === "day" && owed.length ? ` · ${owed.length}` : ""}
            </button>
          ))}
        </div>

        <TextInput
          className="adm-sl-search"
          placeholder="Search a name, firm, title, email, website…"
          value={q} onChange={(e) => setQ(e.target.value)}
        />

        <select className="adm-input adm-sl-sel" value={listFilter} onChange={(e) => setListFilter(e.target.value)}>
          <option value="all">Every list</option>
          {board.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>

        <select className="adm-input adm-sl-sel" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
          <option value="open">Open only</option>
          <option value="all">Every stage</option>
          <option value="closed">Finished with</option>
          {LEAD_STAGES.map((s) => <option key={s} value={s}>{LEAD_STAGE_LABELS[s]}</option>)}
        </select>

        <select className="adm-input adm-sl-sel" value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
          <option value="all">Everybody</option>
          <option value="mine">Mine</option>
          <option value="floor">On the floor</option>
          {board.team.filter((t) => t.active).map((t) => (
            <option key={t.user_id} value={t.user_id}>{t.full_name || t.email}</option>
          ))}
        </select>

        <div className="adm-sl-baractions">
          <SourceBadge mode={badge} />
          {isAdmin && <button className="btn" onClick={() => setStatsOpen(true)}>Rep numbers</button>}
          <button className="btn" onClick={() => setSourcesOpen(true)} title="Imported lists and saved searches">
            Where leads come from{board.sources.some((x) => x.last_run_error) ? " ⚠" : ""}
          </button>
          {isAdmin && <button className="btn" onClick={() => setImportOpen(true)}>Import a sheet</button>}
          <button className="btn btn-accent" onClick={() => setAddOpen(true)}>+ Add a contact</button>
        </div>
      </div>

      {/* ---- views ---- */}
      {view === "day" && (
        <DayView
          queue={queue} owed={owed}
          companyById={companyById} onOpen={setOpenId} onClaim={quickClaim}
        />
      )}

      {view === "lists" && (
        <ListsView
          rows={rows} board={board} now={now} teamName={teamName}
          companyById={companyById} scoreOf={scoreOf} onOpen={setOpenId} member={member}
          listFilter={listFilter} onClear={() => { setQ(""); setListFilter("all"); setStageFilter("open"); setOwnerFilter("all"); }}
        />
      )}

      {view === "pipeline" && (
        <PipelineView rows={rows} teamName={teamName} companyById={companyById} onOpen={setOpenId} />
      )}

      {view === "firms" && (
        <FirmsView board={board} rows={rows} teamName={teamName} onOpen={setOpenId} />
      )}

      {/* ---- overlays ---- */}
      {openLead && (
        <SalesProfile
          lead={openLead}
          company={companyById.get(openLead.company_id) || null}
          siblings={siblingsOf(openLead)}
          member={member} team={board.team} teamName={teamName} now={now}
          touches={board.touchCounts[openLead.id] || 0}
          onClose={() => setOpenId(null)}
          reload={load}
        />
      )}
      {importOpen && (
        <SalesImportModal member={member} team={board.team} onClose={() => setImportOpen(false)} reload={load} />
      )}
      {addOpen && (
        <AddContactModal member={member} lists={board.lists} onClose={() => setAddOpen(false)} reload={load} />
      )}
      {statsOpen && (
        <RepNumbersModal board={board} now={now} onClose={() => setStatsOpen(false)} />
      )}
      {sourcesOpen && (
        <SourcesModal member={member} team={board.team} sources={board.sources}
          onClose={() => setSourcesOpen(false)} reload={load} />
      )}
    </>
  );
}

/* ================================================================== */
/* MY DAY                                                              */
/* ================================================================== */

const REASON_HEAD = {
  reply_waiting: "Replies waiting on you",
  claim_expired: "Claims that have run out",
  first_contact_due: "First contact due",
  cold: "Gone cold",
  going_cold: "Going cold",
  touch_due: "Touches owed",
  unclaimed: "Free to claim",
};

function DayView({ queue, owed, companyById, onOpen, onClaim }) {
  const groups = useMemo(() => {
    const g = new Map();
    for (const card of queue) {
      if (!g.has(card.reason)) g.set(card.reason, []);
      g.get(card.reason).push(card);
    }
    return [...g.entries()];
  }, [queue]);

  if (!queue.length) {
    return (
      <div className="card adm-sl-empty-card">
        <strong>Nothing is owed and nothing is free.</strong>
        <div>Either everything you hold has been touched recently, or there is nothing on the floor
          to claim. Import a list, or look at Lists to see the whole pipeline.</div>
      </div>
    );
  }

  return (
    <>
      <div className="card adm-sl-dayhead">
        <div className="adm-sl-dayhead-t">
          {owed.length ? `${owed.length} thing${owed.length === 1 ? "" : "s"} owed right now` : "Nothing is late"}
        </div>
        <div className="adm-sl-dayhead-b">
          Worked out from the Rules of Engagement: first contact within {ROE.FIRST_CONTACT_BUSINESS_DAYS} business
          days of claiming, a touch on the cadence day, and nothing left quiet for {ROE.COLD_REOPEN_DAYS} days.
          Every card says why it is here.
        </div>
      </div>

      {groups.map(([reason, cards]) => (
        <div key={reason} className="card adm-sl-group">
          <div className="adm-sl-grouphead">
            {REASON_HEAD[reason] || reason}
            <span>{cards.length}</span>
          </div>
          {cards.slice(0, 40).map((card) => {
            const l = card.lead;
            const co = companyById.get(l.company_id);
            return (
              <div key={l.id} className="adm-sl-card" onClick={() => onOpen(l.id)} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") onOpen(l.id); }}>
                <LateBox over={card.reason === "unclaimed" ? null : card.over} />
                <div className="adm-sl-card-main">
                  <div className="adm-sl-card-t">
                    {l.name || l.company || "unnamed"}
                    {l.title && <span className="adm-sl-card-title"> · {l.title}</span>}
                  </div>
                  <div className="adm-sl-card-s">
                    {[co?.name || l.company, l.city, l.email || l.phone].filter(Boolean).join(" · ")}
                  </div>
                  <div className="adm-sl-card-why">
                    <strong>{card.headline}.</strong> {card.detail}
                  </div>
                </div>
                <div className="adm-sl-card-right">
                  <StagePill stage={l.stage} />
                  <ScoreChip score={co?.site_score} />
                  {!l.owner_id && (
                    <button className="btn btn-sm btn-accent" onClick={(e) => { e.stopPropagation(); onClaim(l); }}>
                      Claim
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {cards.length > 40 && (
            <div className="adm-sl-more">Showing the first 40 of {cards.length}. Work these and the rest move up.</div>
          )}
        </div>
      ))}
    </>
  );
}

/* ================================================================== */
/* LISTS — the sheet, but grouped by firm                              */
/* ================================================================== */

function ListsView({ rows, board, now, teamName, companyById, scoreOf, onOpen, member, listFilter, onClear }) {
  /* Grouped by firm, because that is the sheet's biggest lie: four rows of
   * ACME look like four prospects, and one claimed row leaves three open. */
  const groups = useMemo(() => {
    const byCompany = new Map();
    const loose = [];
    for (const l of rows) {
      if (!l.company_id) { loose.push(l); continue; }
      if (!byCompany.has(l.company_id)) byCompany.set(l.company_id, []);
      byCompany.get(l.company_id).push(l);
    }
    const out = [...byCompany.entries()].map(([id, leads]) => ({
      company: companyById.get(id) || null, leads,
    }));
    out.sort((a, b) => (a.company?.name || "").localeCompare(b.company?.name || ""));
    if (loose.length) out.push({ company: null, leads: loose });
    return out;
  }, [rows, companyById]);

  const health = useMemo(() => listHealth(rows, { now, scoreOf }), [rows, now, scoreOf]);
  const list = board.lists.find((l) => l.id === listFilter);

  if (!rows.length) {
    return (
      <div className="card adm-sl-empty-card">
        <strong>Nothing matches those filters.</strong>
        <div>{board.leads.length
          ? "Clear the filters to see the rest of the pipeline."
          : "The pipeline is empty. Import the outreach sheet to bring everything across in one go."}</div>
        {board.leads.length ? <button className="btn" style={{ marginTop: 12 }} onClick={onClear}>Clear the filters</button> : null}
      </div>
    );
  }

  return (
    <>
      <div className="card adm-sl-health">
        <div className="adm-sl-health-t">
          {list ? list.name : "Everything shown"} — {health.total} contacts at {groups.length} firms
        </div>
        <div className="adm-sl-health-bars">
          <MiniBar label="Claimed by somebody" n={health.claimed} total={health.total} />
          <MiniBar label="Actually contacted" n={health.touched} total={health.total} tone="#0369a1" />
          <MiniBar label="Site score run" n={health.scored} total={health.total} tone="#6d28d9" />
        </div>
        <div className="adm-sl-health-n">
          {health.untouched} have never been contacted. {health.stale > 0
            ? `${health.stale} claim${health.stale === 1 ? " has" : "s have"} gone stale and will go back to the floor.`
            : "No claims are stale."}
        </div>
      </div>

      <div className="card adm-sl-tablewrap">
        <div className="adm-sl-scroll">
          <table className="adm-sl-table">
            <thead>
              <tr>
                <th style={{ width: 260 }}>Contact</th>
                <th style={{ width: 150 }}>Title</th>
                <th style={{ width: 130 }}>Stage</th>
                <th style={{ width: 140 }}>Claim</th>
                <th style={{ width: 140 }}>Rep</th>
                <th style={{ width: 110 }}>Last touch</th>
                <th>Next step</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(({ company, leads }) => (
                <FirmGroup
                  key={company?.id || "__none"}
                  company={company} leads={leads} now={now}
                  teamName={teamName} onOpen={onOpen} member={member}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function FirmGroup({ company, leads, now, teamName, onOpen, member }) {
  const [open, setOpen] = useState(true);
  const owners = [...new Set(leads.filter((l) => l.owner_id).map((l) => l.owner_id))];
  const contested = owners.length > 1;

  return (
    <>
      <tr className="adm-sl-firmrow">
        <td colSpan={7}>
          <button className="adm-sl-firmtoggle" onClick={() => setOpen(!open)}>
            <span className={`adm-sl-caret${open ? " open" : ""}`}>▸</span>
            <span className="adm-sl-firmname">{company?.name || "No firm on file"}</span>
            <span className="adm-sl-firmn">{leads.length} contact{leads.length === 1 ? "" : "s"}</span>
            {company && <ScoreChip score={company.site_score} />}
            {company?.domain && <SiteLink domain={company.domain} />}
            {contested && (
              /* The sheet's loudest rule, made visible. It does not stop
                 anybody — Ryder's call — it just refuses to let it be a
                 surprise. */
              <span className="adm-sl-contested" title={owners.map(teamName).join(" and ")}>
                {owners.length} reps working this firm
              </span>
            )}
          </button>
        </td>
      </tr>
      {open && leads.map((l) => (
        <tr key={l.id} className="adm-sl-row" onClick={() => onOpen(l.id)}>
          <td>
            <div className="adm-sl-rowname">{l.name || "unnamed"}</div>
            <div className="adm-sl-rowsub">{l.email || l.phone || "no contact details"}</div>
          </td>
          <td className="adm-sl-rowsub">{l.title || "—"}</td>
          <td><StagePill stage={l.stage} /></td>
          <td><ClaimChip lead={l} now={now} /></td>
          <td className="adm-sl-rowsub">
            {l.owner_id
              ? (l.owner_id === member.user_id ? <strong>You</strong> : teamName(l.owner_id))
              : <span className="adm-sl-faint">on the floor</span>}
          </td>
          <td className="adm-sl-rowmono">{l.last_touch_at ? timeAgo(l.last_touch_at) : "never"}</td>
          <td className="adm-sl-rowsub">{l.next_step || <span className="adm-sl-faint">—</span>}</td>
        </tr>
      ))}
    </>
  );
}

/* ================================================================== */
/* PIPELINE                                                            */
/* ================================================================== */

/* Only the stages a live deal moves through. The parked ones (Skip - 90+,
 * Bad contact info) are real states but they are not steps on a road, and
 * putting them on the board makes the board look full of work it is not. */
const BOARD_STAGES = ["new", "researching", "contacted", "in_conversation", "follow_up", "meeting", "proposal", "won", "lost"];

function PipelineView({ rows, teamName, companyById, onOpen }) {
  return (
    <div className="adm-board">
      {BOARD_STAGES.map((stage) => {
        const col = rows.filter((l) => l.stage === stage);
        return (
          <div key={stage} className="adm-board-col">
            <div className="adm-sl-colhead">
              <StagePill stage={stage} />
              <span>{col.length}</span>
            </div>
            {col.slice(0, 60).map((l) => {
              const co = companyById.get(l.company_id);
              return (
                <div key={l.id} className="adm-board-card" onClick={() => onOpen(l.id)}>
                  <div className="adm-sl-bc-t">{l.name || l.company || "—"}</div>
                  <div className="adm-sl-bc-s">{co?.name || l.company || ""}</div>
                  <div className="adm-sl-bc-f">
                    <span>{teamName(l.owner_id) || "on the floor"}</span>
                    <ScoreChip score={co?.site_score} />
                  </div>
                </div>
              );
            })}
            {col.length > 60 && <div className="adm-sl-more">+{col.length - 60} more</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ================================================================== */
/* FIRMS                                                               */
/* ================================================================== */

function FirmsView({ board, rows, teamName, onOpen }) {
  const shown = useMemo(() => {
    const ids = new Set(rows.map((l) => l.company_id).filter(Boolean));
    return board.companies
      .filter((c) => ids.has(c.id))
      .map((c) => {
        const people = board.leads.filter((l) => l.company_id === c.id);
        const owners = [...new Set(people.filter((p) => p.owner_id).map((p) => p.owner_id))];
        return { company: c, people, owners, gate: scoreGate(c.site_score) };
      })
      .sort((a, b) => {
        // Unscored first (they need work doing), then the widest gap.
        if (a.gate.known !== b.gate.known) return a.gate.known ? 1 : -1;
        return (a.gate.score ?? 0) - (b.gate.score ?? 0);
      });
  }, [board, rows]);

  if (!shown.length) {
    return (
      <div className="card adm-sl-empty-card">
        <strong>No firms match those filters.</strong>
        <div>A firm appears here once at least one of its people is in the pipeline.</div>
      </div>
    );
  }

  return (
    <div className="card adm-sl-tablewrap">
      <div className="adm-sl-firmsnote">
        One row per firm, worst score first — the lower the score, the bigger the gap to sell.
        A firm at {ROE.SKIP_SCORE_AT_OR_ABOVE} or above is not a prospect and is kept out of every rep&rsquo;s queue.
      </div>
      <div className="adm-sl-scroll">
        <table className="adm-sl-table">
          <thead>
            <tr>
              <th style={{ width: 280 }}>Firm</th>
              <th style={{ width: 150 }}>Score</th>
              <th style={{ width: 90 }}>People</th>
              <th style={{ width: 180 }}>Working it</th>
              <th style={{ width: 130 }}>Where</th>
              <th>Website</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ company: c, people, owners }) => (
              <tr key={c.id} className="adm-sl-row" onClick={() => onOpen(people[0]?.id)}>
                <td>
                  <div className="adm-sl-rowname">{c.name}</div>
                  <div className="adm-sl-rowsub">{c.vertical || "industry unknown"}</div>
                </td>
                <td>
                  <ScoreChip score={c.site_score} />
                  {c.site_score_at && <div className="adm-sl-rowmono">{timeAgo(c.site_score_at)}</div>}
                </td>
                <td className="adm-sl-rowsub">{people.length}</td>
                <td className="adm-sl-rowsub">
                  {owners.length === 0 ? <span className="adm-sl-faint">nobody</span>
                    : owners.map(teamName).join(", ")}
                </td>
                <td className="adm-sl-rowsub">{[c.city, c.state].filter(Boolean).join(", ") || "—"}</td>
                <td><SiteLink domain={c.domain} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ================================================================== */
/* MODALS                                                              */
/* ================================================================== */

function AddContactModal({ member, lists, onClose, reload }) {
  const [f, setF] = useState({ name: "", company: "", title: "", email: "", phone: "", domain: "", city: "", state: "", list_id: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.name.trim() && !f.company.trim()) { toast.warn("Give them a name or a firm"); return; }
    if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) { toast.warn("That email does not look right"); return; }
    setBusy(true);
    const res = await upsertLead({
      name: f.name.trim() || null, company: f.company.trim() || null, title: f.title.trim() || null,
      email: f.email.trim() || null, phone: f.phone.trim() || null, domain: f.domain.trim() || null,
      city: f.city.trim() || null, state: f.state.trim() || null,
      list_id: f.list_id || null, notes: f.notes.trim() || null,
      source: "manual", stage: "new",
    });
    setBusy(false);
    if (!res.ok) { toast.error("Could not save", res.error); return; }
    if (res.row?.id) {
      await addLeadActivity({
        leadId: res.row.id, actor: member.user_id, type: "import",
        body: `Added by hand by ${member.full_name || member.email}.`,
      });
    }
    await logActivity({ actor: member.user_id, kind: "lead_added", title: `Added contact: ${f.name || f.company}` });
    toast.success("Added", "On the floor as New. Claim it before you reach out.");
    onClose();
    await reload();
  };

  return (
    <Modal open onClose={onClose} kicker="SALES" title="Add a contact" width={620}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Add contact"}</button>
      </>}>
      <div className="adm-sl-grid2">
        <Field label="Name"><TextInput value={f.name} onChange={set("name")} placeholder="Sarah Chen" autoFocus /></Field>
        <Field label="Job title"><TextInput value={f.title} onChange={set("title")} placeholder="Marketing Director" /></Field>
        <Field label="Firm"><TextInput value={f.company} onChange={set("company")} placeholder="Chen Dental Studio" /></Field>
        <Field label="Website"><TextInput value={f.domain} onChange={set("domain")} placeholder="chendental.com" /></Field>
        <Field label="Email"><TextInput type="email" value={f.email} onChange={set("email")} /></Field>
        <Field label="Phone"><TextInput value={f.phone} onChange={set("phone")} /></Field>
        <Field label="City"><TextInput value={f.city} onChange={set("city")} /></Field>
        <Field label="State"><TextInput value={f.state} onChange={set("state")} placeholder="FL" /></Field>
      </div>
      <Field label="Which list" hint="Lists are the tabs from the outreach sheet.">
        <Select value={f.list_id} onChange={set("list_id")}
          options={[["", "— none —"], ...lists.map((l) => [l.id, l.name])]} />
      </Field>
      <Field label="Notes"><TextArea value={f.notes} onChange={set("notes")} placeholder="Where they came from, what they need…" /></Field>
    </Modal>
  );
}

function RepNumbersModal({ board, now, onClose }) {
  const reps = board.team.filter((t) => t.active);
  const stats = reps.map((r) => ({ rep: r, s: repStats(board.leads, board.activity, { userId: r.user_id, now }) }))
    .filter(({ s }) => s.claimed > 0 || s.calls > 0 || s.emails > 0)
    .sort((a, b) => b.s.won - a.s.won || b.s.meetings - a.s.meetings);

  return (
    <Modal open onClose={onClose} kicker="COUNTED FROM THE ROWS" title="Rep numbers" width={880}>
      {!stats.length ? (
        <div className="adm-sl-empty">
          <strong>Nothing to count yet.</strong>
          <div>A rep appears here once they have claimed something or logged a touch.</div>
        </div>
      ) : (
        <div className="adm-sl-scroll">
          <table className="adm-sl-table">
            <thead>
              <tr>
                <th>Rep</th>
                <th title="Leads with their name on them">Claimed</th>
                <th title="Still open">Open</th>
                <th title="Business days from claiming to the first logged touch">Speed to 1st</th>
                <th>Calls</th>
                <th>Emails</th>
                <th>Meetings</th>
                <th>Won</th>
                <th title="Won as a share of leads that were decided either way">Close rate</th>
                <th title="Claims that have run out or gone cold">At risk</th>
              </tr>
            </thead>
            <tbody>
              {stats.map(({ rep, s }) => (
                <tr key={rep.user_id}>
                  <td>
                    <div className="adm-sl-rowname">{rep.full_name || rep.email}</div>
                    <div className="adm-sl-rowmono">{rep.role.toUpperCase()}</div>
                  </td>
                  <td>{s.claimed}</td>
                  <td>{s.open}</td>
                  {/* null and 0 are different sentences and must not print the same. */}
                  <td>{s.speed_days === null
                    ? <span className="adm-sl-faint">not measured</span>
                    : <>{s.speed_days}d <span className="adm-sl-faint">({s.speed_sample})</span></>}</td>
                  <td>{s.calls}</td>
                  <td>{s.emails}</td>
                  <td>{s.meetings}</td>
                  <td style={{ color: s.won ? "#006b1a" : undefined, fontWeight: s.won ? 700 : 400 }}>{s.won}</td>
                  <td>{s.close_rate === null
                    ? <span className="adm-sl-faint">nothing decided</span>
                    : `${s.close_rate}%`}</td>
                  <td style={{ color: s.at_risk ? "var(--danger)" : undefined }}>{s.at_risk}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="adm-sl-modalnote">
        Every figure is counted from real rows over the last 90 days of activity. A call that was not
        logged is not counted, and a rep with nothing measured says so rather than showing a zero —
        &ldquo;no meetings yet&rdquo; and &ldquo;we have not measured&rdquo; are different sentences.
      </p>
    </Modal>
  );
}
