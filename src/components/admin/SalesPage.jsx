import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LEAD_STAGES, LEAD_STAGE_LABELS,
  getSalesBoard, upsertLead, claimLead, releaseLead, addLeadActivity, logActivity,
  markLeadWon, wonMessage,
} from "../../lib/data.js";
import {
  salesQueue, claimState, scoreGate, repStats, listHealth, isOpenStage, ROE,
} from "../../../lib/sales-rules.js";
import { sheetRows } from "../../lib/salesSheet.js";
import { ACTIVITY_WINDOW_DAYS } from "../../lib/data.js";
import { apiFetch } from "../../lib/adminApi.js";
import { useScreenContext } from "../../lib/screenContext.js";
import { useRoute } from "../../lib/router.js";
import { toast } from "../../lib/toast.js";
import { SourceBadge, Modal, Field, TextInput, TextArea, Select, timeAgo } from "./shared.jsx";
import { StagePill, ClaimChip, ScoreChip, LateBox, Tile, MiniBar, SiteLink } from "./salesParts.jsx";
import SalesProfile from "./salesProfile.jsx";
import SalesSheet from "./salesSheet.jsx";
import { StartOverPanel } from "./salesStartOver.jsx";
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

/* "The sheet" rather than "Lists", because that is what it now is: CJ's
 * spreadsheet, column for column, one row per person. */
const VIEWS = [["day", "My Day"], ["lists", "The sheet"], ["pipeline", "Pipeline"], ["firms", "Firms"]];

/* THE REP'S TWO PAGES ARE THIS PAGE WITH A LOCK ON IT — Ryder, Aug 26 2026.
 *
 * `mode="floor"` is Leads and `mode="mine"` is My leads. No mode is the page
 * the owner and admin have always had: four tabs, six tiles, every filter,
 * untouched. There is deliberately no second component. The console spent
 * Aug 25 deleting a client list that had drifted away from the first one, and
 * the lesson written down that day was one component, two ways in.
 *
 * WHAT A LOCK IS. Exactly one thing: whose leads the page is about. Stage, the
 * list tabs and the search box all still work on a rep's page, because they
 * narrow what the page already says it holds and so cannot contradict its
 * name. Nothing else is locked, and nothing else needs to be.
 *
 * WHERE THE LOCK LIVES. In `scopeLeads`, before any filter runs — not in the
 * dropdown's state. A lock kept in a control is only as good as the controls
 * you remembered to remove; a lock applied to the set first cannot be widened
 * by a tile, a tab, a dropdown or the next thing somebody adds.
 *
 * `tiles` lists the tiles that mode gets. A list rather than a flag because
 * the rule here is that a tile which filters nothing gets removed, not left
 * lit and inert — that is the bug "Owed a touch today" was on the sales role
 * for a day. Hence the floor's empty list: "On the floor" would filter nothing
 * (the page IS the floor), "Yours, open" and the last two would have to break
 * the lock to mean anything, "Claims at risk" is zero by definition on leads
 * nobody has claimed, and "Owed a touch today" is My Day, a view these pages
 * do not have. That is all six, so the row goes. The health card above the
 * table already counts what is on screen.
 */
const MODES = {
  floor: {
    owner: "floor",
    page: "Leads",
    saying: "On the floor · nobody has claimed these",
    tiles: [],
    emptyNote: "Nothing is on the floor right now — every contact loaded has somebody's name on it.",
    /* What a rep is told when a link points at a contact this page does not
     * hold. Per mode, because the reason differs: off the floor means somebody
     * claimed it, off My leads means it is not theirs. See openLeadById. */
    notOnPage: "Leads only opens leads nobody has claimed. Somebody has claimed this one, so it is on their page now and not on the floor.",
    /* The Claim button now lives in the row itself (salesSheet.jsx, same day),
     * so this line stopped describing a dropdown and started describing the
     * button. It still says what claiming COSTS you, which is the part a rep
     * needs before pressing it rather than after. Aug 26 2026 */
    hint: `Click a row to read the whole story, or press Claim to take it — first contact is then due within ${ROE.FIRST_CONTACT_BUSINESS_DAYS} business days or it comes back here.`,
  },
  mine: {
    owner: "mine",
    page: "My leads",
    saying: "Yours · the leads you have claimed",
    /* The three that ask something the dropdowns cannot ask, counted from this
     * rep's own leads: a claim about to lapse, live conversations, won. */
    tiles: ["atRisk", "meetings", "won"],
    emptyNote: "You have not claimed anything yet. Open Leads and press Claim on a row.",
    notOnPage: "My leads only opens the leads you have claimed, and this one is not yours. If it is still on the floor you can claim it from Leads.",
  },
};

export default function SalesPage({ member, mode = null }) {
  const isAdmin = member.role !== "sales";
  /* An unrecognised mode locks to `mine` rather than unlocking the page. A typo
   * in a route must not be the thing that hands a rep the whole pipeline and
   * the admin controls with it — same fail-open the note at the top of
   * AdminDashboard.jsx is about. */
  const lock = mode ? (MODES[mode] || MODES.mine) : null;
  const [board, setBoard] = useState(null);
  // A locked page is the sheet and nothing else, so it opens there.
  const [view, setView] = useState(lock ? "lists" : member.role === "sales" ? "day" : "lists");
  const [q, setQ] = useState("");
  const [listFilter, setListFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("open");
  const [ownerFilter, setOwnerFilter] = useState(
    lock ? lock.owner : member.role === "sales" ? member.user_id : "all",
  );
  const [openId, setOpenId] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [startOverOpen, setStartOverOpen] = useState(false);
  /* Which lead is mid-claim on My Day, or null. See quickClaim. */
  const [claimingId, setClaimingId] = useState(null);

  /* THE SIX TILES ARE ONE ROW OF SWITCHES — Ryder, Aug 26 2026.
   *
   * One piece of state, holding at most one tile id, because that is the rule
   * he asked for: never two lit at once. Before this, three tiles set filters
   * and never unset them, three had no onClick at all, and a tile looked lit
   * whenever the dropdowns happened to land on the same filter — so the lit
   * ring said "you clicked this" when nobody had.
   *
   * Reading the lit state off `tileFilter` and nothing else is what makes the
   * ring honest: it lights only when the tile itself put the filters there. */
  const [tileFilter, setTileFilter] = useState(null);

  /* Where a tile puts you back when you switch it off. These are the page's
   * OWN opening values, copied from the useState calls above — a rep opens on
   * My Day with their own name in the owner box, an owner opens on the sheet
   * with everybody. Hard-coding "lists"/"all" here would mean switching a tile
   * off dumped a rep somewhere they never were.
   *
   * A locked page's opening values are ITS values, from the lock — a rep who
   * switches a tile off on My leads has to land back on My leads. Aug 26 2026 */
  const tileOff = useMemo(() => ({
    view: lock ? "lists" : member.role === "sales" ? "day" : "lists",
    owner: lock ? lock.owner : member.role === "sales" ? member.user_id : "all",
    stage: "open",
    /* The list tabs are a filter like any other, so "back to defaults" has to
     * include them. Leaving the list out meant switching a tile off still left
     * you inside one tab of the sheet, which is not where the page opens, and
     * a tile counted from everybody sitting over one list is the same lie the
     * tile row was rewired to stop. Copied from the useState above. Aug 26 2026 */
    list: "all",
  }), [lock, member.role, member.user_id]);

  /* Press a tile. Same tile again = off, and everything goes back to `tileOff`.
   * A different tile = the old tile's filters are replaced, not added to,
   * because the list is reset once below and every branch then sets view,
   * owner and stage. */
  const pressTile = useCallback((id) => {
    /* A tile this page does not have cannot be pressed. The row below only
     * draws the mode's own tiles, so this never fires today — it is here so a
     * locked page is not one refactor away from a tile that widens it. */
    if (lock && !lock.tiles.includes(id)) return;
    const off = () => {
      setTileFilter(null);
      setView(tileOff.view); setOwnerFilter(tileOff.owner); setStageFilter(tileOff.stage);
      setListFilter(tileOff.list);
    };
    if (tileFilter === id) { off(); return; }
    setTileFilter(id);
    /* Every tile counts across all the lists, so pressing one steps back out of
     * whatever list tab you were in — same reason it resets owner and stage.
     * Aug 26 2026 */
    setListFilter(tileOff.list);
    /* "Owed a touch today" is the odd one out: it is a different VIEW (My Day,
     * which reads the cadence queue) rather than a filter on the sheet. It
     * still has to reset the other two, or the tile you pressed before it
     * would leave its filters behind on the sheet you come back to. */
    if (id === "owed") { setView("day"); setOwnerFilter(tileOff.owner); setStageFilter(tileOff.stage); return; }
    setView("lists");
    if (id === "floor") { setOwnerFilter("floor"); setStageFilter("open"); return; }
    if (id === "mine") { setOwnerFilter("mine"); setStageFilter("open"); return; }
    /* The last three count from everybody's leads on the owner's page, so they
     * show everybody's; on a locked page they count from that page's set and
     * show that. Either way the tile and the list under it agree —
     * a tile whose number does not match the list under it is worse than no
     * tile. "Claims at risk" counts open leads only, so it keeps the open
     * filter; the other two count every stage, and Won would be an empty list
     * without widening it, since the page opens on open stages only.
     *
     * On a locked page the owner filter stays on the lock: all three ask a
     * question about stage or claim state, not about whose lead it is, so none
     * of them has any business widening the page. Aug 26 2026 */
    setOwnerFilter(lock ? lock.owner : "all");
    setStageFilter(id === "atRisk" ? "open" : "all");
  }, [tileFilter, tileOff, lock]);

  /* Touching a dropdown by hand turns the tile row off. Otherwise a tile would
   * stay lit while the filter it claims to be showing had been changed under
   * it — the same lie in the other direction. */
  const handStage = (v) => { setTileFilter(null); setStageFilter(v); };
  /* A list tab is a filter the tiles do not describe, so picking one by hand
   * puts the tile row out as well. Without this, "Won" stayed lit with its own
   * whole-pipeline number over a sheet showing one list's won leads.
   * Aug 26 2026 */
  const handList = (v) => { setTileFilter(null); setListFilter(v); };
  const handOwner = (v) => { setTileFilter(null); setOwnerFilter(v); };

  /* One clock for the whole render. Calling Date.now() inside each row would
   * mean two rows on the same screen disagreeing about what day it is at
   * midnight — rare, and impossible to reproduce when somebody reports it. */
  const [now, setNow] = useState(() => new Date().toISOString());

  /* DEEP LINK: #/dashboard/sales?lead=<id>
   *
   * The client page links straight to the person whose deal closed, so
   * "what happened before they paid us" is one click from the client record
   * rather than a name to go and search for. Read ONCE and then forgotten —
   * `opened` stops the drawer springing back open every time the board
   * reloads, which it did on the first attempt. */
  const [route] = useRoute();
  const [linkOpened, setLinkOpened] = useState(false);
  const linkedLeadId = useMemo(() => {
    const q = String(route).split("?")[1] || "";
    return new URLSearchParams(q).get("lead");
  }, [route]);

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

  const listById = useMemo(() => {
    const m = new Map();
    for (const l of board?.lists || []) m.set(l.id, l);
    return m;
  }, [board]);

  /* ---- the three things a cell in the sheet can do ---- */

  /* Edit a value where it sits. One write, then one reload, so the tiles at
   * the top and the row you just changed can never be counting different
   * snapshots. A failed write says so and changes nothing on screen. */
  const patchLeadRaw = useCallback(async (lead, patch) => {
    const res = await upsertLead({ id: lead.id, ...patch });
    if (!res.ok) { toast.error("Could not save that", res.error); return; }
    /* A stage move is worth a line on the timeline. Every other field is not —
     * a timeline of "title changed" is a timeline nobody reads. */
    if (patch.stage && patch.stage !== lead.stage) {
      await addLeadActivity({
        leadId: lead.id, actor: member.user_id, type: "status_change",
        body: `${LEAD_STAGE_LABELS[lead.stage] || lead.stage} → ${LEAD_STAGE_LABELS[patch.stage] || patch.stage}`,
      });
    }

    await load();
  }, [load, member.user_id]);

  /* WON MEANS WON — through the one path every Won button uses.
   *
   * Until today this pill was decoration: `became_customer` and
   * `admin_companies.client_id` both existed and nothing ever wrote either, so
   * a closed deal left its whole chase on the far side of a gap nothing
   * crossed. See markLeadWon in src/lib/data.js.
   *
   * The guard there is `became_customer`, NOT `client_id`: every contact at a
   * firm is given a client_id the moment one of them closes, so a client_id
   * guard would mean a firm could record exactly one sale ever. */
  const winLead = useCallback(async (lead) => {
    const res = await markLeadWon(lead, { actor: member.user_id });
    if (!res.ok) { toast.error("Could not mark it won", res.error); return; }
    const m = wonMessage(res);
    toast[m.tone](m.title, m.body);
    await load();
  }, [load, member.user_id]);

  /* What a cell in the sheet actually calls. A Won choice is not an ordinary
   * field edit — it creates a client record — so it goes to winLead and
   * nowhere else. Every other patch goes straight through. */
  const patchLead = useCallback((lead, patch) => (
    patch.stage === "won" && lead.stage !== "won"
      ? winLead(lead)
      : patchLeadRaw(lead, patch)
  ), [winLead, patchLeadRaw]);

  /* Put a name in the Sales Owner column. This is a CLAIM, not a text field:
   * it stamps the claim date and starts the cadence, because the sheet's whole
   * failure mode is an owner column with no clock behind it. Clearing it hands
   * the lead back to the floor with a reason on its timeline. */
  const assignLead = useCallback(async (row, userId) => {
    const lead = row.lead;
    if (userId === lead.owner_id) return;
    if (!userId) {
      const res = await releaseLead(lead.id, {
        actor: member.user_id,
        why: `Handed back to the floor by ${member.full_name || member.email}.`,
      });
      if (!res.ok) { toast.error("Could not hand it back", res.error); return; }
      toast.success("Back on the floor", "Anybody can claim it now.");
      await load();
      return;
    }
    const who = teamName(userId) || "someone";
    /* THE ROW WE WERE LOOKING AT SAID FREE, SO THE WRITE SAYS SO TOO.
     *
     * Two reps pressing Claim on the same floor row inside the reload window
     * both used to get a green "Claimed" and the second one silently won. The
     * predicate is only asserted when the lead we read showed as unclaimed —
     * an owner deliberately moving a lead from one rep to another is not a race
     * and must not be refused, so their dropdown behaves exactly as before.
     * Aug 26 2026 */
    const res = await claimLead(lead.id, userId, { name: who, expectUnclaimed: !lead.owner_id });
    if (!res.ok) {
      /* The loser is told what happened, not congratulated — and the board is
       * reloaded underneath the message, so the name they lost it to is on
       * screen by the time they look up. */
      if (res.taken) {
        toast.error("Somebody got there first", res.error);
        await load();
        return;
      }
      toast.error("Could not claim it", res.error); return;
    }
    toast.success(
      userId === member.user_id ? "Claimed" : `Given to ${who}`,
      `First contact within ${ROE.FIRST_CONTACT_BUSINESS_DAYS} business days, or it goes back to the floor.`,
    );
    await load();
  }, [load, member, teamName]);

  /* Score the FIRM, from the row. The Rules of Engagement say score first and
   * skip anyone at 90+; in the sheet that never happened once, because doing it
   * meant leaving the sheet. */
  const runScore = useCallback(async (row) => {
    const co = row.company;
    if (!co?.id) { toast.error("No firm to score", "This contact has no firm attached, and the score belongs to the firm."); return; }
    if (!co.domain) { toast.error("No website on file", `Add a website to ${co.name} first — the scan needs somewhere to look.`); return; }
    const res = await apiFetch("/api/sales-score", { method: "POST", body: { companyId: co.id, domain: co.domain } });
    if (!res.ok) { toast.error("The scan did not run", res.error || "No score was written. Nothing was guessed."); return; }
    toast.success("Scored", `${co.name} scored ${res.score}.`);
    await load();
  }, [load]);

  const siblingsOf = useCallback((lead) => {
    if (!lead?.company_id) return [lead].filter(Boolean);
    return (board?.leads || []).filter((l) => l.company_id === lead.company_id);
  }, [board]);

  const scoreOf = useCallback((lead) => companyById.get(lead.company_id)?.site_score ?? null, [companyById]);

  /* ---- WHAT THIS PAGE IS ABOUT, before a single filter runs ----
   *
   * This is the lock. On the owner's page it is the whole board and nothing
   * changes. On a rep's page it is the floor, or the rep's own leads, and
   * everything downstream — the rows, the tiles, the list tabs, the health
   * card — is counted from here. That is why the missing owner dropdown on a
   * locked page is only tidiness: even if something set the owner filter, this
   * set has already been narrowed and no filter can put a row back into it. */
  const scopeLeads = useMemo(() => {
    const all = board?.leads || [];
    if (!lock) return all;
    if (lock.owner === "floor") return all.filter((l) => !l.owner_id);
    if (lock.owner === "mine") return all.filter((l) => l.owner_id === member.user_id);
    return all;
  }, [board, lock, member.user_id]);

  /* The page's own set, by id. Built once so the guard below is a lookup and
   * not a scan of two thousand rows on every open. */
  const scopeIds = useMemo(() => new Set(scopeLeads.map((l) => l.id)), [scopeLeads]);

  /* ---- THE ONLY WAY A LEAD GETS INTO THE DRAWER — Ryder, Aug 26 2026 ----
   *
   * Found by a checker: `#/dashboard/mine?lead=<another rep's lead>` opened the
   * drawer on it. The page id is one a rep is allowed, so the query survived,
   * and the deep-link effect below checked the id against `board.leads` — the
   * WHOLE board, which getSalesBoard reads for every role — rather than against
   * this page's set. The rep got the full timeline, every field editable, and
   * the drawer's own Claim and Release buttons, from a page titled "My leads".
   *
   * So opening is a guarded call now instead of `setOpenId` handed out raw.
   * Every row on screen came from `rows`, which is inside the lock, so no
   * in-page click can be refused; the deep link is the one caller that can, and
   * it is told why rather than left silent. The owner's page has no lock and is
   * unchanged: it may still open anything on the board, which is a real thing
   * an owner does from the client page's "what happened before they paid us".
   *
   * The check is `scopeIds` — the LOCK — and deliberately not `rows`: a link to
   * your own won lead must still open while the stage box sits on "open only".
   * `openLead` below is still read from the board, so claiming or releasing from
   * inside the drawer does not slam it shut the moment the lead leaves the set. */
  const openLeadById = useCallback((id) => {
    if (!id) return;
    if (lock && !scopeIds.has(id)) {
      toast.error("That contact is not on this page", lock.notOnPage);
      return;
    }
    setOpenId(id);
  }, [lock, scopeIds]);

  /* ---- ONE FILTER CHAIN, AND EVERY NUMBER ON THE PAGE READS IT ----
   *
   * Was inlined in `rows`. It is a function now because the list tabs above the
   * sheet have to count from the same filters the sheet is showing, minus their
   * own — and the only way two numbers on one screen cannot drift is if there
   * is one place that decides what a filtered set holds. `skipList` is the one
   * filter a caller may leave out: the tabs' own. Aug 26 2026 */
  const filterLeads = useCallback((source, { skipList = false } = {}) => {
    let list = source;
    if (!skipList && listFilter !== "all") list = list.filter((l) => l.list_id === listFilter);
    if (stageFilter === "open") list = list.filter((l) => isOpenStage(l.stage));
    else if (stageFilter === "closed") list = list.filter((l) => !isOpenStage(l.stage));
    else if (stageFilter !== "all") list = list.filter((l) => l.stage === stageFilter);
    /* The owner dropdown, and only on the page that has one. A locked page was
     * narrowed by whose leads it is above, so reading the dropdown here as
     * well could only ever narrow it twice or fight it. */
    if (!lock) {
      if (ownerFilter === "mine") list = list.filter((l) => l.owner_id === member.user_id);
      else if (ownerFilter === "floor") list = list.filter((l) => !l.owner_id);
      else if (ownerFilter !== "all") list = list.filter((l) => l.owner_id === ownerFilter);
    }
    /* THE TILE FILTER LIVES HERE, with the other filters, so there is one
     * place that decides what the list holds. Only the three tiles that ask a
     * question the dropdowns cannot ask need a line: "at risk" is a claim
     * state, not a stage, and "meetings + proposals" is TWO stages, which no
     * single value of the stage dropdown can say. Aug 26 2026. */
    if (tileFilter === "atRisk") {
      list = list.filter((l) => ["claim_expired", "cold"].includes(claimState(l, now).state));
    } else if (tileFilter === "meetings") {
      list = list.filter((l) => ["meeting", "proposal"].includes(l.stage));
    } else if (tileFilter === "won") {
      list = list.filter((l) => l.stage === "won");
    }
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((l) => {
        const co = companyById.get(l.company_id);
        return `${l.name || ""} ${l.company || ""} ${co?.name || ""} ${l.email || ""} ${l.title || ""} ${l.city || ""} ${co?.domain || ""}`
          .toLowerCase().includes(needle);
      });
    }
    return list;
  }, [lock, listFilter, stageFilter, ownerFilter, tileFilter, now, q, member.user_id, companyById]);

  /* ---- the filtered set every view draws from ---- */
  const rows = useMemo(() => filterLeads(scopeLeads), [filterLeads, scopeLeads]);

  /* WHAT THE LIST TABS COUNT FROM — Ryder, Aug 26 2026.
   *
   * The owner's page keeps the convention it has always had: a tab number
   * ignores every filter, so an owner can see what switching lists would give
   * before switching. That convention is only honest on a page with the
   * controls to reach those rows — six tiles, an owner box, and a stage box the
   * owner drives all day.
   *
   * ON A LOCKED PAGE IT IS NOT, so these two pages break with it. A rep holding
   * three won leads and nothing open read "All lists 3" over "Nothing matches
   * those filters", and on the floor — which has no tiles at all — the tab was
   * the only number on the page and it was counting lost rows nobody can see.
   * So a locked page's tabs count from the page's set with every filter applied
   * EXCEPT the tabs' own, which is the least a tab can leave out and still be
   * a tab. The number over the sheet and the sheet now agree by construction.
   */
  const tabScope = useMemo(
    () => (lock ? filterLeads(scopeLeads, { skipList: true }) : scopeLeads),
    [lock, filterLeads, scopeLeads],
  );

  /* Whether "Clear the filters" can change anything. Compared against this
   * page's OWN opening values, so the default stage box — which is a filter a
   * rep never set — does not count as something to clear. A button that
   * resets `open` to `open` and reloads the same empty table is a control that
   * lies about being able to help. Aug 26 2026 */
  const canClear = (
    q.trim() !== "" || listFilter !== tileOff.list || stageFilter !== tileOff.stage
    || ownerFilter !== tileOff.owner || tileFilter !== null
  );

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

  /* Counted from this page's set, so a tile on My leads counts the rep's own
   * leads and a tile on the owner's page counts the whole board — exactly what
   * the list under it holds. */
  const counts = useMemo(() => {
    const all = scopeLeads;
    const open = all.filter((l) => isOpenStage(l.stage));
    return {
      floor: open.filter((l) => !l.owner_id).length,
      mine: open.filter((l) => l.owner_id === member.user_id).length,
      owed: owed.length,
      atRisk: open.filter((l) => ["claim_expired", "cold"].includes(claimState(l, now).state)).length,
      meetings: all.filter((l) => ["meeting", "proposal"].includes(l.stage)).length,
      won: all.filter((l) => l.stage === "won").length,
    };
  }, [scopeLeads, member.user_id, now, owed.length]);

  useEffect(() => {
    if (linkOpened || !linkedLeadId || !board) return;
    setLinkOpened(true);
    /* Only if it is genuinely in what we loaded. Setting openId to an id that
     * is not on the board renders an empty drawer, which reads as broken. The
     * page caps at the newest 2,000 contacts, so a link to an older one lands
     * on the page and says nothing rather than lying. */
    /* Through the guard, so a link cannot reach past the lock — see
     * openLeadById. On the owner's page this is the same board check it always
     * was. */
    if (board.leads.some((l) => l.id === linkedLeadId)) openLeadById(linkedLeadId);
    /* Two different reasons, and they must not be blended. A failed read of the
     * leads table also leaves the list empty, and telling somebody to "search
     * their name" then sends them chasing advice that cannot work, for a cause
     * that is not the cause. */
    else if (board.errors.length) {
      toast.error("That contact could not be opened", "The pipeline did not load — see the message at the top of the page.");
    } else {
      toast.info("That contact is not loaded", "The sheet holds the newest contacts only. Search their name to find them.");
    }
  }, [linkedLeadId, board, linkOpened, openLeadById]);

  /* Read from the board on purpose, and safe because `openId` can only have
   * been set by openLeadById above — which is where the lock is enforced. Read
   * from `scopeLeads` instead and the drawer would close under a rep the instant
   * they pressed Claim or Release inside it, because that is the moment the lead
   * leaves the page's set. */
  const openLead = openId ? (board?.leads || []).find((l) => l.id === openId) : null;

  /* A locked page has no view tabs, so `view` is fixed at the sheet. Deriving
   * it here rather than trusting the state is what makes that structural: no
   * stray setView can put My Day on a rep's page. */
  const shownView = lock ? "lists" : view;
  const ALL_TILES = ["floor", "mine", "owed", "atRisk", "meetings", "won"];
  const tileRow = lock ? lock.tiles : ALL_TILES;

  useScreenContext(() => ({
    // The assistant should say the page's real name, which on a rep's login is
    // the name in their sidebar, not "Sales".
    page: lock ? lock.page : "Sales",
    label: openLead ? null
      : lock ? `${lock.saying} · ${rows.length} contacts shown`
        : `${VIEWS.find((v) => v[0] === view)?.[1]} · ${rows.length} contacts shown`,
    record: openLead
      ? { type: "lead", id: openLead.id, label: openLead.name || openLead.company || "unnamed contact" }
      : null,
    visible: rows.slice(0, 20).map((l) => `${l.name || l.company || "unnamed"} (${l.stage})`),
  }), [openLead, rows, view, lock]);

  /* My Day's Claim button, and the same two halves as the sheet's: this state
   * stops the second press, and `expectUnclaimed` stops somebody else's first
   * one. Aug 26 2026 */
  const quickClaim = async (lead) => {
    if (claimingId) return;
    setClaimingId(lead.id);
    try {
      const res = await claimLead(lead.id, member.user_id, {
        name: member.full_name || member.email, expectUnclaimed: !lead.owner_id,
      });
      if (!res.ok) {
        if (res.taken) { toast.error("Somebody got there first", res.error); await load(); return; }
        toast.error("Could not claim it", res.error); return;
      }
      toast.success("Claimed", `First contact within ${ROE.FIRST_CONTACT_BUSINESS_DAYS} business days, or it goes back to the floor.`);
      await load();
    } finally { setClaimingId(null); }
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

      {/* ---- tiles ----
          Which tiles a page gets is decided in MODES at the top, and a tile
          that is not on this page is not drawn at all rather than drawn dead.
          The floor gets none, so the row itself goes with them — an empty grey
          strip above the table is a row of switches that does nothing. */}
      {tileRow.length > 0 && (
        <div className="adm-sl-tiles">
          {tileRow.includes("floor") && <Tile label="On the floor" value={counts.floor} hint="nobody has claimed" onClick={() => pressTile("floor")} active={tileFilter === "floor"} />}
          {tileRow.includes("mine") && <Tile label="Yours, open" value={counts.mine} hint={member.full_name || member.email} onClick={() => pressTile("mine")} active={tileFilter === "mine"} />}
          {tileRow.includes("owed") && <Tile label="Owed a touch today" value={counts.owed} hint="from the cadence and the timers" tone={counts.owed ? "var(--danger)" : undefined} onClick={() => pressTile("owed")} active={tileFilter === "owed"} />}
          {tileRow.includes("atRisk") && <Tile label="Claims at risk" value={counts.atRisk} hint="run out or gone cold" tone={counts.atRisk ? "#92400e" : undefined} onClick={() => pressTile("atRisk")} active={tileFilter === "atRisk"} />}
          {tileRow.includes("meetings") && <Tile label="Meetings + proposals" value={counts.meetings} hint="live conversations" onClick={() => pressTile("meetings")} active={tileFilter === "meetings"} />}
          {/* NOT "all time". This is counted from the leads that were actually
              loaded, which are capped at the newest 2,000 contacts — and the
              page says so at the top when it hits the cap. A tile claiming
              "all time" over a capped read is a small, confident lie. */}
          {tileRow.includes("won") && <Tile label="Won" value={counts.won} hint="of the contacts loaded" onClick={() => pressTile("won")} active={tileFilter === "won"} />}
        </div>
      )}

      {/* ---- toolbar ---- */}
      <div className="card adm-sl-bar">
        {lock ? (
          /* THE LOCK, SAID OUT LOUD, where the view tabs sit on the owner's
             page. A page with a filter you cannot see or change reads as a page
             with a filter stuck on it, so it says which leads it holds. Plain
             text: there is nothing to press. Inline rather than a new class —
             it is the only new thing on the page, and admin.css was not opened
             for this change. Aug 26 2026 */
          <div
            role="status"
            style={{
              display: "inline-flex", alignItems: "center", padding: "8px 12px",
              borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--rule)",
              fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
              letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-dim)",
            }}
          >
            {lock.saying}
          </div>
        ) : (
          <div className="adm-sl-views">
            {VIEWS.map(([v, label]) => (
              /* Picking a view by hand puts the tile row out for the same reason
                 the dropdowns do: the tiles set the view, so leaving one lit
                 after you moved off it makes the ring mean nothing. Aug 26 2026 */
              <button key={v} className={view === v ? "active" : ""} onClick={() => { setTileFilter(null); setView(v); }}>
                {label}{v === "day" && owed.length ? ` · ${owed.length}` : ""}
              </button>
            ))}
          </div>
        )}

        <TextInput
          className="adm-sl-search"
          placeholder="Search a name, firm, title, email, website…"
          value={q} onChange={(e) => setQ(e.target.value)}
        />

        <select className="adm-input adm-sl-sel" data-filter="stage" value={stageFilter} onChange={(e) => handStage(e.target.value)}>
          <option value="open">Open only</option>
          <option value="all">Every stage</option>
          <option value="closed">Finished with</option>
          {LEAD_STAGES.map((s) => <option key={s} value={s}>{LEAD_STAGE_LABELS[s]}</option>)}
        </select>

        {/* GONE on a locked page, not disabled and not obeyed. Every value it
            could hold either says what the page already says or contradicts its
            name, and a control that contradicts the title of the page it is on
            is the bug this whole change is written around. The lock itself is
            not in here anyway — see scopeLeads. Aug 26 2026 */}
        {!lock && (
          <select className="adm-input adm-sl-sel" data-filter="owner" value={ownerFilter} onChange={(e) => handOwner(e.target.value)}>
            <option value="all">Everybody</option>
            <option value="mine">Mine</option>
            <option value="floor">On the floor</option>
            {board.team.filter((t) => t.active).map((t) => (
              <option key={t.user_id} value={t.user_id}>{t.full_name || t.email}</option>
            ))}
          </select>
        )}

        <div className="adm-sl-baractions">
          <SourceBadge mode={badge} />
          {isAdmin && <button className="btn" onClick={() => setStatsOpen(true)}>Rep numbers</button>}
          <button className="btn" onClick={() => setSourcesOpen(true)} title="Imported lists and saved searches">
            Where leads come from{board.sources.some((x) => x.last_run_error) ? " ⚠" : ""}
          </button>
          {isAdmin && <button className="btn" onClick={() => setImportOpen(true)}>Import a sheet</button>}
          {/* Owner/admin only. Hidden rather than shown-and-refused, because
              this one deletes: a rep who cannot use it does not need to be
              told twice, and the panel behind it explains itself to anybody
              who reaches it another way. */}
          {isAdmin && (
            <button className="btn" onClick={() => setStartOverOpen(true)} title="Undo an import, or clear everything imported and start fresh">
              Start over
            </button>
          )}
          <button className="btn btn-accent" onClick={() => setAddOpen(true)}>+ Add a contact</button>
        </div>
      </div>

      {/* ---- views ---- */}
      {shownView === "day" && (
        <DayView
          queue={queue} owed={owed}
          /* WHAT MY DAY IS SHOWING, said out loud at the call site.
             "Owed a touch today" used to light its ring and leave My Day
             showing every group, including "Free to claim" — leads nobody
             owes anything on. So the tile's number and the list under it
             disagreed. A word rather than a bare true/false, because
             `owedOnly` at a call site tells you nothing. Aug 26 2026 */
          showing={tileFilter === "owed" ? "owed" : "everything"}
          companyById={companyById} onOpen={openLeadById} onClaim={quickClaim}
          claimingId={claimingId}
        />
      )}

      {shownView === "lists" && (
        <ListsView
          rows={rows} board={board} now={now} teamName={teamName}
          companyById={companyById} listById={listById} scoreOf={scoreOf}
          onOpen={openLeadById} member={member}
          onPatch={patchLead} onAssign={assignLead} onRunScore={runScore}
          listFilter={listFilter} onListFilter={handList}
          /* THE LIST TABS COUNT FROM THIS, not from the whole board. A rep on
              the floor page reading "Everybody 1,847" above 300 rows is the
              same lie as a tile whose number does not match its list, and the
              tab counts were the last place still reading past the lock.
              On a locked page it is also stage- and search-filtered — see
              tabScope above for why the two pages break the old convention. */
          tabScope={tabScope}
          /* The page's whole set, filters and all off. The ONLY thing this
              decides is which empty screen is true: a page with nothing in it,
              versus filters that match nothing in a page that holds plenty. */
          scopeLeads={scopeLeads}
          allTabLabel={lock ? "All lists" : "Everybody"}
          emptyNote={lock ? lock.emptyNote : null}
          hint={lock ? lock.hint : null}
          /* Only on the floor, and only ever with YOUR OWN id: a Claim button
              that could file a lead under somebody else is not a claim. */
          claimAs={lock?.owner === "floor" ? member.user_id : null}
          /* Clear means clear, so it puts the tile row out too — otherwise a tile
              stayed lit over a list it was no longer filtering. Aug 26 2026.
              Back to THIS page's opening filters, from tileOff, so clearing on a
              rep's page cannot reach for the owner's defaults. */
          onClear={() => { setQ(""); setListFilter(tileOff.list); setStageFilter(tileOff.stage); setOwnerFilter(tileOff.owner); setTileFilter(null); }}
          /* And whether it is offered at all. See canClear. */
          canClear={canClear}
        />
      )}

      {shownView === "pipeline" && (
        <PipelineView rows={rows} teamName={teamName} companyById={companyById} onOpen={openLeadById} />
      )}

      {shownView === "firms" && (
        <FirmsView board={board} rows={rows} teamName={teamName} onOpen={openLeadById} />
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
      {startOverOpen && (
        <Modal
          open onClose={() => setStartOverOpen(false)} kicker="SALES" width={760}
          title="Imports, and starting over"
        >
          <StartOverPanel member={member} onDone={load} />
        </Modal>
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

function DayView({ queue, owed, companyById, onOpen, onClaim, showing = "everything", claimingId = null }) {
  /* The list is grouped from `owed` when the tile is lit, and `owed` is the
   * very array the tile's number is counted from — so the header and the cards
   * cannot drift apart. Everything else shows the whole queue. Aug 26 2026 */
  const onlyOwed = showing === "owed";
  const dayCards = onlyOwed ? owed : queue;

  const groups = useMemo(() => {
    const g = new Map();
    for (const card of dayCards) {
      if (!g.has(card.reason)) g.set(card.reason, []);
      g.get(card.reason).push(card);
    }
    return [...g.entries()];
  }, [dayCards]);

  if (!dayCards.length) {
    /* Two different empty screens, because they mean different things. Nothing
     * owed is good news; an empty queue means there is no work here at all. */
    return onlyOwed ? (
      <div className="card adm-sl-empty-card">
        <strong>Nothing is owed a touch today.</strong>
        <div>Press the tile again to see the rest of your day, including anything free to claim.</div>
      </div>
    ) : (
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
                    /* Disabled while a claim is in the air. Two fast presses
                       wrote two "Claimed by X" lines and restarted the
                       first-contact clock. Aug 26 2026 */
                    <button
                      className="btn btn-sm btn-accent"
                      disabled={claimingId === l.id}
                      aria-busy={claimingId === l.id}
                      onClick={(e) => { e.stopPropagation(); onClaim(l); }}
                    >
                      {claimingId === l.id ? "Claiming…" : "Claim"}
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
/* THE SHEET — one row per person, in CJ's own column order            */
/* ================================================================== */

/* Was: a table where every firm was a collapsible header row and its people
 * lived underneath it. Ryder, Aug 25 2026: *"i dont like how the business has
 * a dropdown with the owner below, thats not needed, just make it rows of the
 * people."* The grouping is now a switch inside the table rather than the
 * shape of it, and the one-firm-one-rep warning it existed to carry moved onto
 * the Company cell — see src/components/admin/salesSheet.jsx.
 */
function ListsView({
  rows, board, now, teamName, companyById, listById, scoreOf, onOpen, member,
  listFilter, onListFilter, onClear, onPatch, onAssign, onRunScore,
  /* The set this page is about — the whole board on the owner's page, the
   * floor or one rep's leads on theirs. It decides ONE thing: which empty
   * screen is true. Nothing is counted on screen from it, because "how many
   * this page holds" and "how many this page is showing" are different numbers
   * and printing the first over a list of the second is the defect a checker
   * caught here. Aug 26 2026 */
  scopeLeads = board.leads,
  /* What the TAB NUMBERS count. The owner's page passes the same set it always
   * did (a tab ignores every filter, which is honest on a page with the
   * controls to reach those rows); a locked page passes that set already
   * filtered by everything but the tabs themselves. Either way it is what the
   * sheet below would hold if you pressed that tab. */
  tabScope = scopeLeads,
  allTabLabel = "Everybody",
  emptyNote = null,
  hint = null,
  /* Whether clearing the filters could change what is on screen. False means
     no filter a person set is on, so the Clear button is not drawn at all. */
  canClear = true,
  /* Who is claiming, or null. Only the floor page sends one — see the note on
     `claimAs` in salesSheet.jsx. */
  claimAs = null,
}) {
  const health = useMemo(() => listHealth(rows, { now, scoreOf }), [rows, now, scoreOf]);

  /* One row object per person, built once. Everything the table sorts,
   * filters, groups and paints comes from the same object, so a row can never
   * be ordered by one value and drawn with another. */
  const sheet = useMemo(
    () => sheetRows(rows, {
      companyById, teamName, touchCounts: board.touchCounts, listById, now,
      /* The window getSalesBoard actually read. Passed in rather than assumed,
         so the words on the Contacted? cell can never claim a wider period than
         was looked at. */
      activityWindowDays: ACTIVITY_WINDOW_DAYS,
    }),
    [rows, companyById, teamName, board.touchCounts, listById, now],
  );

  /* WHAT AN EMPTY SCREEN SAYS — THREE CASES, NOT TWO. Aug 26 2026.
   *
   * It was two, and the missing one is what a checker found: a rep holding
   * three won leads and nothing open got "Nothing matches those filters" and a
   * Clear button that reset the stage box from `open` to `open`. The filters
   * were not the problem — the page's own opening stage was — so the words were
   * wrong, the button could not work, and the honest note ("You have not claimed
   * anything yet") was unreachable because it needed an empty page.
   *
   *   1. the page holds nothing        → the mode's own note, no button
   *   2. filters a person set          → "nothing matches", and Clear
   *   3. nothing set, and still empty  → say what is here and where it went
   *
   * The owner's page keeps its own words for 1 and 2. Case 3 is new for
   * everybody, because a dead button is not behaviour worth keeping — an owner
   * whose whole pipeline is closed saw the same lie. */
  /* COUNTED, not assumed. The words below say every contact on this page is at
     a finished stage, so that is checked rather than inferred from "the stage
     box is at its default" — an inferred sentence is the kind that is true on
     the day it is written and wrong after the next filter is added. */
  const finished = useMemo(() => scopeLeads.filter((l) => !isOpenStage(l.stage)).length, [scopeLeads]);
  const stageHiding = !canClear && scopeLeads.length > 0 && finished === scopeLeads.length;
  const emptyHead = !scopeLeads.length
    ? (emptyNote ? "Nothing here right now." : "Nothing matches those filters.")
    : stageHiding ? "Nothing open here right now."
      : canClear ? "Nothing matches those filters."
        : "Nothing here right now.";
  const emptyBody = !scopeLeads.length
    ? (emptyNote || "The pipeline is empty. Import the outreach sheet to bring everything across in one go.")
    : stageHiding
      ? (scopeLeads.length === 1
        ? "The one contact on this page is at a stage this list is not showing. Set the stage box to \"Every stage\" to see it."
        : `All ${scopeLeads.length} contacts on this page are at a stage this list is not showing. Set the stage box to "Every stage" to see them.`)
      : canClear
        ? (emptyNote
          ? "Clear the filters to see the rest of this page."
          : "Clear the filters to see the rest of the pipeline.")
        /* Nothing a person set is on, and it is not the stage box either, so
           there is nothing to tell them to undo. Say that and stop. */
        : "Nothing on this page matches the boxes above the table.";

  /* How many firms are in what is on screen — the one thing the old grouped
   * header told you that a flat table cannot. */
  const firmCount = useMemo(() => {
    const s = new Set();
    let loose = 0;
    for (const l of rows) { if (l.company_id) s.add(l.company_id); else loose += 1; }
    return s.size + loose;
  }, [rows]);

  return (
    <>
      {/* ---- the sheet's tabs ---- */}
      <div className="adm-sh-tabs" role="tablist" aria-label="Lists">
        <button
          type="button" role="tab" aria-selected={listFilter === "all"}
          className={listFilter === "all" ? "active" : ""}
          onClick={() => onListFilter("all")}
        >
          {/* "Everybody" on the owner's page; "All lists" on a locked one,
              where everybody is not what this tab means. */}
          {allTabLabel} <span>{tabScope.length}</span>
        </button>
        {board.lists.map((l) => {
          const n = tabScope.filter((x) => x.list_id === l.id).length;
          return (
            <button
              key={l.id} type="button" role="tab" aria-selected={listFilter === l.id}
              className={listFilter === l.id ? "active" : ""}
              onClick={() => onListFilter(l.id)}
            >
              {l.name} <span>{n}</span>
            </button>
          );
        })}
        {board.lists.length === 0 && (
          <span className="adm-sh-tabnone">
            No lists yet — import the outreach sheet and every tab becomes one.
          </span>
        )}
      </div>

      {/* One line, and only where a page needs it — the floor, which is the one
          page whose whole job is an action. Nothing on the owner's page. */}
      {hint && (
        <div style={{ fontSize: 12.5, color: "var(--ink-dim)", margin: "-4px 0 12px", lineHeight: 1.5 }}>
          {hint}
        </div>
      )}

      {rows.length === 0 ? (
        /* Two different empty screens again, and the difference is counted from
           the page's own set: filters that match nothing, versus a page with
           nothing in it. On a rep's page the second one is not "import a
           sheet" — that is not their job — so each mode says its own sentence. */
        <div className="card adm-sl-empty-card">
          <strong>{emptyHead}</strong>
          <div>{emptyBody}</div>
          {/* Offered only when it can DO something. `scopeLeads.length` alone
              drew it over a page whose filters were all at their opening
              values, where pressing it reloaded the same empty table. */}
          {scopeLeads.length && canClear
            ? <button className="btn" style={{ marginTop: 12 }} onClick={onClear}>Clear the filters</button>
            : null}
        </div>
      ) : (
        <>
          <div className="card adm-sl-health">
            <div className="adm-sl-health-t">
              {health.total} {health.total === 1 ? "person" : "people"} at {firmCount} {firmCount === 1 ? "firm" : "firms"}
            </div>
            <div className="adm-sl-health-bars">
              <MiniBar label="Claimed by somebody" n={health.claimed} total={health.total} />
              {/* "Ever contacted", not "actually contacted". This counts
                `first_contact_at`, which is set by a logged touch OR carried
                across from the spreadsheet — so it includes contact we were
                TOLD about as well as contact we can read. The Contacted? column
                below splits those two apart, and the two lines used to
                contradict each other on the same screen. */}
            <MiniBar label="Ever contacted (told or logged)" n={health.touched} total={health.total} tone="#0369a1" />
              <MiniBar label="Site score run" n={health.scored} total={health.total} tone="#6d28d9" />
            </div>
            <div className="adm-sl-health-n">
              {health.untouched} have no first-contact date at all. {health.stale > 0
                ? `${health.stale} claim${health.stale === 1 ? " has" : "s have"} gone stale and ${health.stale === 1 ? "is" : "are"} due to go back to the floor.`
                : "No claims are stale."}
            </div>
          </div>

          <div className="card adm-sl-tablewrap">
            <SalesSheet
              rows={sheet}
              allLeads={board.leads}
              member={member}
              team={board.team}
              lists={board.lists}
              teamName={teamName}
              onPatch={onPatch}
              onAssign={onAssign}
              onRunScore={onRunScore}
              activityWindowDays={ACTIVITY_WINDOW_DAYS}
              onOpen={onOpen}
              claimAs={claimAs}
            />
          </div>
        </>
      )}
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
