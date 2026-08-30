import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LEAD_STAGES, LEAD_STAGE_LABELS,
  getFloorBoard, upsertLead, claimLead, releaseLead, addLeadActivity, logActivity,
  wonMessage,
  /* THE FLOOR, Aug 27 2026. Every one of these is ONE ACTION, ONE FUNCTION, and
   * each of them writes the dated line on the person's timeline in the same call.
   * A button never writes. Four buttons that could mark a deal Won had four
   * behaviours, and one of them permanently blocked the only one that worked. */
  closeLeadWon, markLeadLost, lostMessage, setLeadTag, syncAutoTags, listLeadTagEvents,
} from "../../lib/data.js";
import {
  salesQueue, claimState, scoreGate, listHealth, isOpenStage, ROE,
  textGate, LOST_REASONS, WON_REASONS, MIN_REASON_NOTE_CHARS, checkCloseReason,
} from "../../../lib/sales-rules.js";
/* Tags are an append-only event log, so "which tags are on this lead" is a
 * replay rather than a column read. One place decides it. */
import { currentTags, tagHistory } from "../../../lib/lead-tags.js";
/* The rep-by-rep table this page used to open in a modal now has a page of its
 * own — src/components/admin/SalesStats.jsx, reached from Sales → Stats. It
 * calls outreachByRep, lossReasons and repStats there, from the same
 * getSalesBoard() read, so the two screens cannot come to disagree about how
 * many deals somebody won. Nothing on this page counts a rep any more, which is
 * why none of those three is imported here. 30 Aug 2026 */
import {
  sheetRows, canEditLead,
  AVAILABILITY, AVAILABILITY_LABELS, AVAILABILITY_HINTS,
  cleanAvailability, byAvailability, availabilityCounts,
  readCompanyReport, sheetDate, sheetDateLong,
} from "../../lib/salesSheet.js";
import { ACTIVITY_WINDOW_DAYS } from "../../lib/data.js";
import { apiFetch } from "../../lib/adminApi.js";
import { useScreenContext } from "../../lib/screenContext.js";
import { useRoute } from "../../lib/router.js";
import { toast } from "../../lib/toast.js";
import { SourceBadge, Modal, Field, TextInput, TextArea, Select, timeAgo, useHealth } from "./shared.jsx";
import { StagePill, ClaimChip, ScoreChip, LateBox, Tile, MiniBar, SiteLink } from "./salesParts.jsx";
/* LogModal is exported from the drawer rather than copied here. The Floor's row
 * can log a touch without opening the record, and a second copy of the one-text
 * gate would be a second copy that stops matching — the whole reason
 * claimTextSend lives in the database. */
import SalesProfile, { LogModal } from "./salesProfile.jsx";
import SalesSheet from "./salesSheet.jsx";
import { Popover } from "./opsCells.jsx";
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
/* THE TILES' OWN WORDS, in one place. The chip that stands in for a pressed
 * tile on the sheet reads from this, so a tile and its chip cannot drift into
 * saying two different things about the same filter. */
const TILE_LABELS = {
  floor: "On the floor",
  mine: "Yours, open",
  owed: "Owed a touch today",
  atRisk: "Claims at risk",
  meetings: "Meetings + proposals",
  won: "Won",
};

const MODES = {
  /* THE FLOOR. One mode where there were two.
   *
   * `floor` used to mean "the leads nobody has claimed" and `mine` meant "the
   * ones I have". Ryder, Aug 27 2026: a rep should see every lead in the
   * company, because a rep who cannot see another rep's row cannot be stopped
   * from working the same firm — which is the loudest rule on the Rules of
   * Engagement tab. So the two pages became one page with a three-state switch
   * over it, and `mine` is where it opens.
   *
   * WHAT A LOCK IS NOW. It is no longer "whose leads this page is about" — the
   * page is about all of them. The lock moved onto the ROW: see canEditLead in
   * src/lib/salesSheet.js. Everything below is therefore about WORDS and TILES,
   * not about narrowing a set.
   *
   * `tiles: []` on purpose, and the row of tiles is not drawn at all rather than
   * drawn dead. Every tile this page could carry either duplicates the
   * availability switch above the table (which already counts Mine, Available
   * and All from the same rows the list holds) or belongs on Overview, which is
   * where a rep's own numbers live now. A tile that filters nothing gets
   * removed, not left lit and inert — that was the bug "Owed a touch today" had
   * on the sales role for a day. */
  floor: {
    page: "The Floor",
    saying: "Every lead we have · you can only change the ones that are yours or unclaimed",
    tiles: [],
    emptyNote: "There are no contacts loaded at all. Somebody with an owner login imports the outreach sheet, and every row on it appears here.",
    /* What a rep is told when a link points at a contact this page does not
     * hold. There is only ONE reason left for that now — the contact is not in
     * the rows that were loaded — because the page holds every lead it read. The
     * old wording ("somebody has claimed this one") described a lock that no
     * longer exists. */
    notOnPage: "The Floor holds the newest contacts we loaded, and this one is not among them. Search their name to find them.",
    hint: `Press Claim to take a lead — first contact is then due within ${ROE.FIRST_CONTACT_BUSINESS_DAYS} business days or it comes back to the floor. A row somebody else holds is greyed out and opens read-only, so nobody works the same firm twice.`,
  },
};

export default function SalesPage({ member, mode = null }) {
  /* NAMED ROLES, NOT "not sales". This gates the owner-only controls — the
   * person dropdown, Rep numbers, Import, Start over — and a member with no role
   * at all satisfied `role !== "sales"`, so a page that had lost track of who was
   * looking at it drew every one of them over a board where canEditLead() makes
   * every row read-only. Two guards disagreeing about the same member is worse
   * than either answer alone.
   *
   * canEditLead deliberately keeps "not sales" for the OPPOSITE reason — a role
   * nobody has taught it about must not lose the ability to work — and it refuses
   * a member with no role separately. Both fail closed on nothing; they differ on
   * an unknown role, on purpose. Aug 27 2026, after an adversarial review. */
  const isAdmin = member.role === "owner" || member.role === "admin";
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
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [startOverOpen, setStartOverOpen] = useState(false);
  /* Which lead is mid-claim on My Day, or null. See quickClaim. */
  const [claimingId, setClaimingId] = useState(null);

  /* ---- THE AVAILABILITY SWITCH — Mine · Available · All ----
   *
   * Three states, one piece of state, and it is a FILTER OVER THE FULL BOARD
   * rather than a new fetch. That is the whole architecture in one line: one
   * read, one row builder, three layouts. A page that fetches its own leads is a
   * page with its own snapshot, and two snapshots of one pipeline is how a tile
   * ends up disagreeing with the list underneath it.
   *
   * It opens on "Mine", because that is where a rep actually works. Available is
   * one click.
   *
   * DELIBERATELY NOT REMEMBERED BETWEEN VISITS. Columns and grouping are saved
   * to localStorage; filters are not. A rep who comes back tomorrow to a page
   * still filtered to one state from last week reads it as an empty pipeline —
   * and the control that would explain it is the one they have forgotten they
   * touched. */
  const [availability, setAvailability] = useState(() => cleanAvailability("mine"));

  /* ---- what the Floor's buttons open ----
   * One piece of state each, holding the row it is about or null. A single
   * "openModal" object was tried and thrown away: two of these can be reached
   * from inside the drawer, and one variable meant closing the reason box also
   * closed the record behind it. */
  const [closing, setClosing] = useState(null);      // { row, kind: 'won' | 'lost' }
  const [tagging, setTagging] = useState(null);      // the row whose tags are open
  const [scanning, setScanning] = useState(null);    // the row whose scan panel is open
  const [logging, setLogging] = useState(null);      // { row, kind }

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
  /* Where the ⋯ menu hangs from, or null. A rect, not a boolean — Popover
   * anchors to the button that opened it. */
  const [moreMenu, setMoreMenu] = useState(null);

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
    /* THE OWNER DROPDOWN DOES NOT EXIST ON A LOCKED PAGE and is not read there
     * either — filterLeads skips it whenever `lock` is set, and the availability
     * switch is the rep's version of the same question. So "all" is the honest
     * value rather than a mode's own: it used to be `lock.owner`, which was
     * "floor" or "mine" back when a mode narrowed the set, and after the Aug 27
     * rebuild there is no `owner` on a mode at all — that expression was quietly
     * producing `undefined` and putting it into a filter nothing reads. Found by
     * the test suite, not by a screen. */
    owner: lock ? "all" : member.role === "sales" ? member.user_id : "all",
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
    /* "all" either way now. On a locked page the owner dropdown does not exist
     * and filterLeads does not read it; on the owner's page these three tiles ask
     * a question about stage or claim state, not about whose lead it is, so none
     * of them has any business narrowing it. */
    setOwnerFilter("all");
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
  const [route, go] = useRoute();
  const [linkOpened, setLinkOpened] = useState(false);
  const linkedLeadId = useMemo(() => {
    const q = String(route).split("?")[1] || "";
    return new URLSearchParams(q).get("lead");
  }, [route]);

  const load = useCallback(async () => {
    /* ONE READ FOR THE WHOLE PAGE, and it is the same one the owner's Sales page
     * and a rep's Overview both use. getFloorBoard is getSalesBoard plus the tag
     * vocabulary, the current tag state and the scans — a widening, not a second
     * board, so nothing that already read the old one changed. */
    const b = await getFloorBoard();
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
  /* THE REASON BOX GOES IN FRONT OF THE ONE FUNCTION, NOT IN FRONT OF THE
   * BUTTONS — Aug 27 2026.
   *
   * Four buttons can close a deal (the sheet's status cell, the drawer's status
   * dropdown, the drawer's green "They signed", and setting a proposal to Won)
   * and all four were routed through markLeadWon on Aug 25. Putting a reason box
   * on each of them would have put it on three of them and missed one, which is
   * exactly how one of those four ended up permanently blocking the only one
   * that worked.
   *
   * So every one of them now opens THIS, and the write happens in
   * closeLeadWon() / markLeadLost() in src/lib/data.js — one call that does the
   * stage, the client link, the note in the person's own words and the tag. */
  const askForReason = useCallback((lead, kind) => {
    setClosing({ lead, kind });
  }, []);

  const saveClose = useCallback(async ({ lead, kind, reason, note }) => {
    if (kind === "won") {
      const res = await closeLeadWon(lead, {
        actor: member.user_id, reason, note, tagsBySlug: board?.tagsBySlug || new Map(),
      });
      if (!res.ok) return { ok: false, error: res.error };
      const m = wonMessage(res);
      toast[m.tone](m.title, m.body);
      /* Anything that failed AFTER the close is named, and the close still
       * stands. Rolling back a recorded sale because a tag did not save would be
       * worse than saying which half is missing. */
      if (res.problems?.length) toast.warn("Saved, with something missing", res.problems.join("; "));
      await logActivity({ actor: member.user_id, kind: "lead_won", title: `Won: ${lead.name || lead.company}` });
      await load();
      return { ok: true };
    }
    const res = await markLeadLost(lead, {
      actor: member.user_id, reason, note, tagsBySlug: board?.tagsBySlug || new Map(),
    });
    if (!res.ok) return { ok: false, error: res.error };
    const m = lostMessage(res);
    toast[m.tone](m.title, m.body);
    await logActivity({ actor: member.user_id, kind: "lead_lost", title: `Lost: ${lead.name || lead.company}` });
    await load();
    return { ok: true };
  }, [board, load, member.user_id]);



  /* What a cell in the sheet actually calls. A Won choice is not an ordinary
   * field edit — it creates a client record — so it goes to winLead and
   * nowhere else. Every other patch goes straight through. */
  const patchLead = useCallback((lead, patch) => {
    /* Won and Lost are not ordinary field edits and never were. Won creates a
     * client record; both of them now require a reason, because "why did we
     * lose" is the most useful question in sales and this database had no answer
     * to it. Picking either one from a dropdown opens the box; every other patch
     * goes straight through. */
    if (patch.stage === "won" && lead.stage !== "won") return askForReason(lead, "won");
    if (patch.stage === "lost" && lead.stage !== "lost") return askForReason(lead, "lost");
    return patchLeadRaw(lead, patch);
  }, [askForReason, patchLeadRaw]);

  /* Put a name in the Sales Owner column. This is a CLAIM, not a text field:
   * it stamps the claim date and starts the cadence, because the sheet's whole
   * failure mode is an owner column with no clock behind it. Clearing it hands
   * the lead back to the floor with a reason on its timeline. */
  const assignLead = useCallback(async (row, userId) => {
    const lead = row.lead;
    if (userId === lead.owner_id) return;
    /* THE THIRD COPY OF THE ROW LOCK — the polite one. Migration 0020 refuses
     * this at the database and every lead-writing endpoint checks it again; this
     * is the one a person sees. A rep may take a lead nobody holds and hand their
     * own back, and may never move a lead to somebody else — so the only id a
     * rep may ever write here is their own.
     *
     * The controls that could do it are not drawn for a rep at all (the Sales
     * Owner cell becomes a Claim button, and the person dropdown is owner-only),
     * so this never fires today. It is here because a disabled control is only as
     * good as the ones somebody remembered to disable. */
    if (!isAdmin && userId && userId !== member.user_id) {
      toast.error("That is not yours to move", "A lead can only be handed to somebody else by an owner or an admin. You can take one nobody has claimed.");
      return;
    }
    if (!canEditLead(lead, member)) {
      toast.error("That lead is somebody else's", `${teamName(lead.owner_id) || "Another rep"} holds it. You can read it, but only they or an owner can change it.`);
      return;
    }
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
  }, [load, member, teamName, isAdmin]);

  /* ---- PUT A TAG ON, OR TAKE ONE OFF ----
   *
   * One call to setLeadTag, which writes the event AND the dated line on the
   * person's timeline together. A removal is a NEW event, never the deletion of
   * the one that added it: "quiet was added on the 24th and taken off on the
   * 25th because she replied" is the thing a rep needs to read a month later.
   *
   * `source: "person"` is what makes the automatic rules leave it alone
   * afterwards — see removedByHand() in lib/lead-tags.js. Nothing has to
   * remember the decision, because the decision IS the record. */
  const toggleTag = useCallback(async (lead, tag, action) => {
    if (!canEditLead(lead, member)) {
      toast.error("That lead is somebody else's", "You can read its tags. Only the person holding it, or an owner, can change them.");
      return;
    }
    const res = await setLeadTag({
      leadId: lead.id, tagId: tag.id, label: tag.label, action,
      actor: member.user_id, source: "person",
      why: action === "removed" ? "removed by hand" : "added by hand",
    });
    if (!res.ok) { toast.error("That tag was not saved", res.error); return; }
    if (res.timelineFailed) {
      toast.warn("Tag saved, timeline line missing", `The tag is on the record. ${res.timelineFailed}.`);
    }
    await load();
  }, [load, member]);

  /* Bring one lead's automatic tags up to date, on demand.
   *
   * Nothing runs this on a timer yet and it is deliberately a button rather than
   * something that happens while a page loads: a page load that writes rows is a
   * page that cannot be opened twice safely, and the overnight sweep
   * (api/sales-sweep.js) is where this belongs once it is actually scheduled —
   * which it is not (§43.11). Said out loud on the button rather than left to be
   * discovered. */
  const refreshTags = useCallback(async (lead) => {
    if (!canEditLead(lead, member)) return;
    const done = await syncAutoTags(lead, {
      company: companyById.get(lead.company_id) || null,
      touchCount: board?.touchCounts?.[lead.id] || 0,
      now,
      events: board?.tagsByLead?.get(lead.id) || [],
      tagsBySlug: board?.tagsBySlug || new Map(),
      tagsById: board?.tagsById || new Map(),
      actor: member.user_id,
    });
    const moved = done.added.length + done.removed.length;
    /* THE HISTORY READ IS REPORTED FIRST, because everything under it is only as
     * good as that read. syncAutoTags computes `historyError` and nothing looked
     * at it — so when the read failed it fell back to the board's copy, which for
     * a lead past the tag cap is EMPTY, re-added tags the rep had removed by hand,
     * and toasted a success. Third review, Aug 27 2026. */
    if (done.historyError) {
      toast.warn(
        "The tag history could not be read",
        `${done.historyError} Anything below was worked out without it, so a tag you took off by hand may have come back — check the history on this contact.`,
      );
    }
    if (done.failed.length) {
      toast.error("Some tags did not save", done.failed.map((f) => `${f.slug}: ${f.error}`).join("; "));
    } else if (done.unknown.length) {
      /* Named rather than silent: a slug the vocabulary does not hold means
       * migration 0018's seed has not run, and the rep should be told the rule
       * could not be applied instead of watching nothing happen. */
      toast.warn("Some tags do not exist yet", `The tag list is missing: ${done.unknown.join(", ")}. Whoever runs the database migrations has to add them.`);
    } else if (!moved) {
      toast.info("Nothing changed", "Every automatic tag on this contact is already right.");
    } else {
      toast.success(`${moved} tag${moved === 1 ? "" : "s"} updated`, [
        done.added.length ? `added ${done.added.join(", ")}` : null,
        done.removed.length ? `removed ${done.removed.join(", ")}` : null,
      ].filter(Boolean).join(" · "));
    }
    if (moved) await load();
  }, [board, companyById, load, member, now]);

  /* Hand a lead back to the floor. Own leads only, said out loud rather than
   * refused silently — the button is not drawn on somebody else's row, and this
   * is the guard for the path that does not go through the button. */
  const doRelease = useCallback(async (lead) => {
    if (!canEditLead(lead, member)) {
      toast.error("That lead is somebody else's", "Only the person holding it, or an owner, can hand it back.");
      return;
    }
    if (!lead.owner_id) { toast.info("Already on the floor", "Nobody is holding this one."); return; }
    const res = await releaseLead(lead.id, {
      actor: member.user_id,
      why: `Handed back to the floor by ${member.full_name || member.email}.`,
    });
    if (!res.ok) { toast.error("Could not hand it back", res.error); return; }
    toast.success("Back on the floor", "Anybody can claim it now.");
    await load();
  }, [load, member]);

  /* Score the FIRM, from the row. The Rules of Engagement say score first and
   * skip anyone at 90+; in the sheet that never happened once, because doing it
   * meant leaving the sheet. */
  const runScore = useCallback(async (row) => {
    /* Called with a sheet ROW from the table, and with `{ lead, company }` from
     * the scan panel. Both carry `company`, and `lead` is only read for the id
     * that gets stored on the report — so one function serves both rather than
     * two that could drift. */
    const co = row.company;
    if (!co?.id) { toast.error("No firm to score", "This contact has no firm attached, and the score belongs to the firm."); return; }
    if (!co.domain) { toast.error("No website on file", `Add a website to ${co.name} first — the scan needs somewhere to look.`); return; }
    /* `leadId` so the measurement records WHO ran it, which the endpoint checks
     * really belongs to that firm before it stores it. `domain` is deliberately
     * still sent and deliberately still ignored by the endpoint: the firm's own
     * website is what gets scanned, so nobody can score an address typed into a
     * box. Sending it keeps the request readable in a network log. */
    const res = await apiFetch("/api/sales-score", {
      method: "POST",
      body: { companyId: co.id, domain: co.domain, leadId: row.lead?.id || null },
    });
    if (!res.ok) { toast.error("The scan did not run", res.error || "No score was written. Nothing was guessed."); return; }
    /* `res.data`, not `res` — apiFetch returns `{ ok, data }`, so this printed
     * "scored undefined" for as long as it existed. And the score can now
     * legitimately be null: a scan that returns only the buyer-question half
     * saves a row with no AI Access number in it, and "scored null" would be
     * worse than saying which halves came back. Aug 27 2026 */
    const d = res.data || {};
    const got = [
      d.aiAccess === null || d.aiAccess === undefined ? null : `AI Access ${d.aiAccess}`,
      d.seo === null || d.seo === undefined ? null : `SEO ${d.seo}`,
      d.simTotal ? `named in ${d.simHits} of ${d.simTotal}` : null,
    ].filter(Boolean);
    toast.success(
      got.length ? "Scanned" : "Scanned, with nothing readable",
      got.length
        ? `${co.name}: ${got.join(" · ")}.`
        : `${co.name} was scanned but no score came back, so nothing was saved and nothing was guessed.`,
    );
    await load();
  }, [load]);

  const siblingsOf = useCallback((lead) => {
    if (!lead?.company_id) return [lead].filter(Boolean);
    return (board?.leads || []).filter((l) => l.company_id === lead.company_id);
  }, [board]);

  const scoreOf = useCallback((lead) => companyById.get(lead.company_id)?.site_score ?? null, [companyById]);

  /* ---- WHAT THIS PAGE IS ABOUT ----
   *
   * EVERY LEAD, for every role. This used to be the lock — a rep got the
   * unclaimed rows or their own rows and nothing on the page could widen it —
   * and on Aug 27 2026 that lock was deleted, because Ryder's requirement is
   * that a rep sees the whole company's pipeline so two reps never work the same
   * firm.
   *
   * IT WAS REPLACED, NOT REMOVED. The lock is on the ROW now: canEditLead() in
   * src/lib/salesSheet.js decides whether a person may CHANGE a lead, every
   * control on the row reads it, migration 0020 enforces it in the database, and
   * every endpoint that writes a lead checks it again. Visibility is wide on
   * purpose; editability is not.
   *
   * It is kept as its own memo rather than folded into `rows` because three
   * things count from it and must count from the same set: the availability
   * switch, the list tabs, and the empty-screen wording. */
  const scopeLeads = useMemo(() => board?.leads || [], [board]);

  /* ---- THE ONLY WAY A LEAD GETS INTO THE DRAWER ----
   *
   * Aug 26 2026, found by a checker: `#/dashboard/mine?lead=<another rep's lead>`
   * opened the drawer on it with every field editable and the drawer's own Claim
   * and Release buttons, from a page titled "My leads". The fix was to check the
   * id against the page's own narrowed set before opening.
   *
   * AUG 27 2026: THE SET IS NO LONGER NARROWED, so that check would now pass for
   * everything and the guard would be theatre. It is not deleted — it is
   * repointed at the thing that actually decides:
   *
   *   an id NOT in the rows we loaded  -> refused, and told why
   *   an id in the rows, not editable  -> opens READ-ONLY. Fields, notes and the
   *                                       timeline are visible; there are no
   *                                       buttons at all.
   *   an id in the rows, editable      -> opens as it always did
   *
   * Read-only rather than refused is the requirement, not a softening of it: a
   * rep has to be able to see that Brandon is already in this building, and what
   * was said, or the whole reason for showing every row disappears.
   *
   * The read-only decision is NOT made here. It is derived once from
   * canEditLead() where the drawer is rendered, so the drawer and the row it was
   * opened from cannot disagree. */
  const openLeadById = useCallback((id) => {
    if (!id) return;
    if (!(board?.leads || []).some((l) => l.id === id)) {
      toast.error("That contact is not on this page", lock ? lock.notOnPage : "The sheet holds the newest contacts only. Search their name to find them.");
      return;
    }
    setOpenId(id);
  }, [board, lock]);

  /* ---- ONE FILTER CHAIN, AND EVERY NUMBER ON THE PAGE READS IT ----
   *
   * Was inlined in `rows`. It is a function now because the list tabs above the
   * sheet have to count from the same filters the sheet is showing, minus their
   * own — and the only way two numbers on one screen cannot drift is if there
   * is one place that decides what a filtered set holds. `skipList` is the one
   * filter a caller may leave out: the tabs' own. Aug 26 2026 */
  const filterLeads = useCallback((source, { skipList = false, skipAvailability = false } = {}) => {
    let list = source;
    /* THE AVAILABILITY SWITCH IS A FILTER LIKE ANY OTHER, and it lives here with
     * the rest of them so there is one place that decides what the list holds.
     * It runs FIRST because it is the cheapest and the most selective — on a
     * two-thousand-row board "Mine" is usually a few dozen.
     *
     * Only on a locked page. The owner's Sales page has an owner dropdown that
     * says the same thing more precisely (it can name a person), and two
     * controls filtering the same column is how one of them ends up lying. */
    if (lock && !skipAvailability) list = byAvailability(list, availability, member);
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
  }, [lock, availability, member, listFilter, stageFilter, ownerFilter, tileFilter, now, q, companyById]);

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

  /* WHAT THE AVAILABILITY SWITCH COUNTS. Every other filter that is on, minus
   * its own — so the number on each of the three buttons is exactly what pressing
   * it would show. Counted from the same rows, so the button and the list under
   * it agree by construction rather than by luck.
   *
   * Passing `skipAvailability` and then counting all three states from that one
   * set is the only shape that works: counting from `rows` would make "All" show
   * the size of whichever state is currently on. */
  const availCounts = useMemo(
    () => (lock
      ? availabilityCounts(filterLeads(scopeLeads, { skipAvailability: true }), member)
      : null),
    [lock, filterLeads, scopeLeads, member],
  );

  /* Whether "Clear the filters" can change anything. Compared against this
   * page's OWN opening values, so the default stage box — which is a filter a
   * rep never set — does not count as something to clear. A button that
   * resets `open` to `open` and reloads the same empty table is a control that
   * lies about being able to help. Aug 26 2026 */
  const canClear = (
    q.trim() !== "" || listFilter !== tileOff.list || stageFilter !== tileOff.stage
    || ownerFilter !== tileOff.owner || tileFilter !== null
    /* The availability switch counts as a filter a person set — but "Mine" is
     * where the page OPENS, so it only counts once they have moved off it.
     * Otherwise Clear would offer to undo something nobody did, and pressing it
     * would reload the same rows. */
    || (lock ? availability !== "mine" : false)
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
      {/* ---- tiles ----
          NOT ON THE SHEET any more — Ryder, 30 Aug 2026: "everything seems
          really complex and jumbled, i want to simplify it all." Six tiles of
          which four read 0 were the loudest thing on the page and the least
          used, and the sheet already carries the same numbers a row lower in a
          form that says what it is counting.
          They stay on My Day, where "Owed a touch today" is the whole point of
          the page, and the team's version of all six now has a page of its own
          at Sales → Stats. Pressing one still lands you on the sheet, and the
          chip in the toolbar below is what says so once you are there. */}
      {tileRow.length > 0 && shownView !== "lists" && (
        <div className="adm-sl-tiles">
          {tileRow.includes("floor") && <Tile label="On the floor" value={counts.floor} hint="nobody has claimed" onClick={() => pressTile("floor")} active={tileFilter === "floor"} />}
          {tileRow.includes("mine") && <Tile label="Yours, open" value={counts.mine} hint={member.full_name || member.email} onClick={() => pressTile("mine")} active={tileFilter === "mine"} />}
          {tileRow.includes("owed") && <Tile label="Owed a touch today" value={counts.owed} hint="from the cadence and the timers" tone={counts.owed ? "var(--danger)" : undefined} onClick={() => pressTile("owed")} active={tileFilter === "owed"} />}
          {tileRow.includes("atRisk") && <Tile label="Claims at risk" value={counts.atRisk} hint="run out or gone cold" tone={counts.atRisk ? "#92400e" : undefined} onClick={() => pressTile("atRisk")} active={tileFilter === "atRisk"} />}
          {tileRow.includes("meetings") && <Tile label="Meetings + proposals" value={counts.meetings} hint="live conversations" onClick={() => pressTile("meetings")} active={tileFilter === "meetings"} />}
          {/* NOT "all time". This is counted from the leads that were actually
              loaded. That used to mean the newest 2,000 — in practice the
              newest 1,000, because Supabase caps one request there and nothing
              noticed. The reader pages now (lib/paging.js), so it is normally
              everything; the hint stays honest either way, and the page still
              says so at the top if the ceiling is ever reached. */}
          {tileRow.includes("won") && <Tile label="Won" value={counts.won} hint="of the contacts loaded" onClick={() => pressTile("won")} active={tileFilter === "won"} />}
        </div>
      )}

      {/* ---- what is on screen, above the controls ----
          Only on the sheet, because it counts the rows the sheet is about to
          draw; My Day, Pipeline and Firms are different shapes with different
          numbers. And only when there ARE rows — "0 people at 0 firms" over an
          empty-state card is noise, and the empty card already says it. */}
      {shownView === "lists" && rows.length > 0 && (
        <ListHealth rows={rows} now={now} scoreOf={scoreOf} badge={badge} />
      )}

      {/* ---- toolbar ---- */}
      <div className="card adm-sl-bar">
        {lock ? (
          /* THE AVAILABILITY SWITCH, where the view tabs sit on the owner's
             page. Three states, exactly one active, and each one carries the
             number of rows pressing it would show — counted from the same set the
             list is built from, so the button and the list cannot disagree.

             IT REPLACED A LINE OF PLAIN TEXT that said which leads the page held.
             That sentence was honest when the page held one slice; the page holds
             all of them now, and this is the control that says which slice you
             are looking at. Reusing .adm-sl-views rather than adding a class: it
             is the segmented control this console already has, and admin.css was
             not opened for this change. Aug 27 2026 */
          <div className="adm-sl-views" role="group" aria-label="Which leads to show">
            {AVAILABILITY.map((a) => (
              <button
                key={a}
                type="button"
                className={availability === a ? "active" : ""}
                aria-pressed={availability === a}
                title={AVAILABILITY_HINTS[a]}
                onClick={() => { setTileFilter(null); setAvailability(a); }}
              >
                {AVAILABILITY_LABELS[a]}
                {availCounts ? <span style={{ opacity: 0.65 }}> · {availCounts[a]}</span> : null}
              </button>
            ))}
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

        {/* THE TILE YOU PRESSED, ONCE YOU ARE ON THE SHEET.
            The tiles do not draw here any more, and a filter that is ON with no
            control on screen showing it is a filter nobody can find or turn
            off. So the tile becomes one removable chip. Pressing the ✕ is the
            same act as pressing the lit tile again — one function, so the two
            cannot come to mean different things. */}
        {tileFilter && shownView === "lists" ? (
          <button
            type="button" className="adm-sh-chipbtn"
            onClick={() => pressTile(tileFilter)}
            title="Take this off and go back to the whole list"
          >
            {TILE_LABELS[tileFilter] || tileFilter} <span aria-hidden="true">✕</span>
          </button>
        ) : null}

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

          {/* FIVE BUTTONS BECAME ONE MENU AND ONE BUTTON.
              Rep numbers, Where leads come from, Import a sheet and Start over
              are all occasional — you press them once a week between them — and
              they were taking a whole row above the table you look at every
              day. Add a contact stays out because it is the one thing here you
              do without thinking.
              Nothing is removed; every entry is one click away, and the warning
              triangle still reaches the outside of the menu so a broken source
              cannot hide inside it. */}
          {board.sources.some((x) => x.last_run_error) ? (
            <button
              type="button" className="adm-sh-chipbtn"
              onClick={() => setSourcesOpen(true)}
              title="A saved search or import failed the last time it ran"
            >
              A list failed ⚠
            </button>
          ) : null}

          <button
            type="button" className="btn" aria-haspopup="menu"
            title="Stats, lists, importing and starting over"
            onClick={(e) => setMoreMenu(e.currentTarget.getBoundingClientRect())}
          >
            ⋯
          </button>

          <button className="btn btn-accent" onClick={() => setAddOpen(true)}>+ Add a contact</button>
        </div>
      </div>

      {/* ---- the ⋯ menu ---- */}
      {moreMenu && (
        <Popover anchor={moreMenu} width={264} onClose={() => setMoreMenu(null)}>
          <div className="adm-db-pop-list" role="menu">
            {isAdmin && (
              <button
                type="button" className="adm-db-pop-item" role="menuitem"
                onClick={() => { setMoreMenu(null); go("#/dashboard/sales-stats"); }}
              >
                <span>Stats</span>
                <span className="adm-db-count">every rep</span>
              </button>
            )}
            <button
              type="button" className="adm-db-pop-item" role="menuitem"
              onClick={() => { setMoreMenu(null); setSourcesOpen(true); }}
            >
              <span>Where leads come from</span>
              {board.sources.some((x) => x.last_run_error)
                ? <span className="adm-db-count">⚠</span> : null}
            </button>
            {isAdmin && (
              <button
                type="button" className="adm-db-pop-item" role="menuitem"
                onClick={() => { setMoreMenu(null); setImportOpen(true); }}
              >
                <span>Import a sheet</span>
              </button>
            )}
            {/* Owner/admin only. Hidden rather than shown-and-refused, because
                this one deletes: a rep who cannot use it does not need to be
                told twice, and the panel behind it explains itself to anybody
                who reaches it another way. */}
            {isAdmin && (
              <button
                type="button" className="adm-db-pop-item" role="menuitem"
                onClick={() => { setMoreMenu(null); setStartOverOpen(true); }}
              >
                <span>Start over</span>
                <span className="adm-db-count">undo an import</span>
              </button>
            )}
          </div>
        </Popover>
      )}

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
          companyById={companyById} listById={listById}
          onOpen={openLeadById} member={member}
          onPatch={patchLead} onAssign={assignLead} onRunScore={runScore}
          listFilter={listFilter} onListFilter={handList}
          /* THE LIST TABS COUNT FROM THIS, not from the whole board. A rep
              reading "All lists 1,847" above 300 rows is the same lie as a tile
              whose number does not match its list. On a locked page it is
              availability-, stage- and search-filtered — see tabScope above. */
          tabScope={tabScope}
          /* The page's whole set, filters and all off. The ONLY thing this
              decides is which empty screen is true: a page with nothing in it,
              versus filters that match nothing in a page that holds plenty. */
          scopeLeads={scopeLeads}
          allTabLabel={lock ? "All lists" : "Everybody"}
          emptyNote={lock ? lock.emptyNote : null}
          hint={lock ? lock.hint : null}
          /* CLAIMING, and only ever with YOUR OWN id: a Claim button that could
              file a lead under somebody else is not a claim.
              It used to be `lock.owner === "floor"` — the page that held only
              unclaimed rows. The Floor holds every row now, so the Claim button
              is decided per row by whether anybody holds it, and this just says
              "this page is a page you claim from". Aug 27 2026 */
          claimAs={lock ? member.user_id : null}
          /* Only an owner or an admin may hand a lead to somebody else (0020).
              So the Sales Owner cell is a dropdown of people on their page and a
              Claim button on a rep's. */
          canAssign={isAdmin}
          /* ---- THE FLOOR'S ROW BUTTONS. One function each, and each of those
              functions writes the dated line itself — see src/lib/data.js. ---- */
          onTag={(row) => setTagging(row)}
          onRefreshTags={(row) => refreshTags(row.lead)}
          onLog={(row, kind) => setLogging({ row, kind })}
          onScan={(row) => setScanning(row)}
          onClose={(row, kind) => askForReason(row.lead, kind)}
          onRelease={(row) => doRelease(row.lead)}
          /* Clear means clear, so it puts the tile row and the availability
              switch back too — otherwise a tile stayed lit over a list it was no
              longer filtering. Back to THIS page's opening values. */
          onClear={() => {
            setQ(""); setListFilter(tileOff.list); setStageFilter(tileOff.stage);
            setOwnerFilter(tileOff.owner); setTileFilter(null); setAvailability("mine");
          }}
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
      {/* ---- overlays ---- */}
      {openLead && (
        <SalesProfile
          lead={openLead}
          company={companyById.get(openLead.company_id) || null}
          siblings={siblingsOf(openLead)}
          member={member} team={board.team} teamName={teamName} now={now}
          touches={board.touchCounts[openLead.id] || 0}
          /* ---- THE READ-ONLY DRAWER — Aug 27 2026 ----
             Derived HERE, once, from the one exported helper, and handed down.
             The drawer does not work it out again: a drawer that decided for
             itself whether it was read-only could disagree with the row it was
             opened from, and the whole point of showing another rep's lead is
             that what you read is what they see.

             Read-only means read-only: fields, notes and the timeline are all
             visible, and there is not one button. A rep has to be able to see
             that Brandon is already in this building and what was said. */
          readOnly={!canEditLead(openLead, member)}
          heldByName={teamName(openLead.owner_id) || "another rep"}
          /* Tags: the vocabulary, this lead's dated history, and the one function
             that writes either. */
          tags={board.tagsById ? currentTags(board.tagsByLead.get(openLead.id) || [], board.tagsById) : []}
          allTags={board.leadTags || []}
          onTag={(tag, action) => toggleTag(openLead, tag, action)}
          onRefreshTags={() => refreshTags(openLead)}
          /* The newest scan of this firm, and the button that opens the panel. */
          report={board.reportByCompany && openLead.company_id
            ? readCompanyReport(board.reportByCompany.get(openLead.company_id) || null)
            : null}
          onScan={() => setScanning({ lead: openLead, company: companyById.get(openLead.company_id) || null })}
          /* Won and Lost both go through the reason box, which sits in front of
             the ONE function rather than in front of the four buttons that call
             it. See askForReason. */
          onCloseDeal={(kind) => askForReason(openLead, kind)}
          onClose={() => setOpenId(null)}
          reload={load}
        />
      )}

      {/* ---- WHY DID IT CLOSE. It will not save empty. ---- */}
      {closing && (
        <CloseReasonModal
          lead={closing.lead}
          kind={closing.kind}
          onClose={() => setClosing(null)}
          onSave={async ({ reason, note }) => {
            const res = await saveClose({ lead: closing.lead, kind: closing.kind, reason, note });
            if (res.ok) setClosing(null);
            return res;
          }}
        />
      )}

      {/* ---- TAGS on one lead, with the dated history under them ---- */}
      {tagging && (
        <TagModal
          row={tagging}
          allTags={board.leadTags || []}
          tagsById={board.tagsById || new Map()}
          teamName={teamName}
          editable={tagging.editable}
          onToggle={async (tag, action) => { await toggleTag(tagging.lead, tag, action); }}
          onRefresh={async () => { await refreshTags(tagging.lead); }}
          onClose={() => setTagging(null)}
        />
      )}

      {/* ---- THE SCAN. Built, and it cannot be switched on yet. ---- */}
      {scanning && (
        <ScanModal
          lead={scanning.lead}
          company={scanning.company || companyById.get(scanning.lead.company_id) || null}
          report={board.reportByCompany && scanning.lead.company_id
            ? readCompanyReport(board.reportByCompany.get(scanning.lead.company_id) || null)
            : null}
          teamName={teamName}
          onRun={() => runScore({ lead: scanning.lead, company: scanning.company || companyById.get(scanning.lead.company_id) || null })}
          onClose={() => setScanning(null)}
        />
      )}

      {/* ---- LOG A TOUCH, from the row instead of only from the drawer ---- */}
      {logging && (
        <LogModal
          kind={logging.kind}
          lead={logging.row.lead}
          member={member}
          text={textGate(logging.row.lead)}
          onClose={() => setLogging(null)}
          reload={load}
        />
      )}

      {importOpen && (
        <SalesImportModal member={member} team={board.team} onClose={() => setImportOpen(false)} reload={load} />
      )}
      {addOpen && (
        <AddContactModal member={member} lists={board.lists} onClose={() => setAddOpen(false)} reload={load} />
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
/* WHAT IS ON SCREEN, IN ONE LINE — how many people, at how many firms, and how
 * much of it has actually been worked.
 *
 * MOVED ABOVE THE TOOLBAR, 30 Aug 2026, on Ryder's ask: "move the second stat
 * section that shows the 820 people at 644 firms and move that up so its above
 * the search and add." It used to sit under the list tabs, which put the two
 * sets of numbers on the page — the tiles at the top and this — a whole
 * toolbar apart. They belong together: numbers first, then the controls, then
 * the table.
 *
 * It reads from `rows`, which is what the table is about to draw — every
 * filter, tab and search already applied. So it always describes exactly what
 * is underneath it, whatever the toolbar between them is set to. */
function ListHealth({ rows, now, scoreOf, badge }) {
  const health = useMemo(() => listHealth(rows, { now, scoreOf }), [rows, now, scoreOf]);

  /* How many firms are in what is on screen — the one thing the old grouped
   * header told you that a flat table cannot. A contact with no firm counts as
   * one of its own, or two hundred unattached people would read as nought
   * firms. */
  const firmCount = useMemo(() => {
    const s = new Set();
    let loose = 0;
    for (const l of rows) { if (l.company_id) s.add(l.company_id); else loose += 1; }
    return s.size + loose;
  }, [rows]);

  return (
    <div className="card adm-sl-health">
      {/* THE BADGE SITS WITH THE NUMBERS, not on the toolbar.
          It was the last item on a control row that had run out of room — it
          pushed Add a contact onto a second line — and it was in the wrong
          place anyway: "where did this come from" is a question about the
          figures, so it belongs beside them. In preview it was also a second
          copy of the one already in the page header. 30 Aug 2026. */}
      <div className="adm-sl-health-t" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span>
          {health.total} {health.total === 1 ? "person" : "people"} at {firmCount} {firmCount === 1 ? "firm" : "firms"}
        </span>
        {badge ? <SourceBadge mode={badge} /> : null}
      </div>
      <div className="adm-sl-health-bars">
        <MiniBar label="Claimed by somebody" n={health.claimed} total={health.total} />
        {/* "Ever contacted", not "actually contacted". This counts
            `first_contact_at`, which is set by a logged touch OR carried across
            from the spreadsheet — so it includes contact we were TOLD about as
            well as contact we can read. The Contacted? column in the table
            splits those two apart, and the two lines used to contradict each
            other on the same screen. */}
        <MiniBar label="Ever contacted (told or logged)" n={health.touched} total={health.total} tone="#0369a1" />
        <MiniBar label="Site score run" n={health.scored} total={health.total} tone="#6d28d9" />
      </div>
      <div className="adm-sl-health-n">
        {health.untouched} have no first-contact date at all. {health.stale > 0
          ? `${health.stale} claim${health.stale === 1 ? " has" : "s have"} gone stale and ${health.stale === 1 ? "is" : "are"} due to go back to the floor.`
          : "No claims are stale."}
      </div>
    </div>
  );
}

function ListsView({
  rows, board, now, teamName, companyById, listById, onOpen, member,
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
  /* Who is claiming, or null. Only a rep's page sends one — see the note on
     `claimAs` in salesSheet.jsx. */
  claimAs = null,
  /* ---- added Aug 27 2026 with The Floor ----
     Every one of these is passed straight through to the table. This component
     decides layout; it does not decide what a button does, and it deliberately
     holds no state of its own about any of them. */
  canAssign = true,
  onTag, onRefreshTags, onLog, onScan, onClose: onCloseDeal, onRelease,
}) {
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
      /* ---- Aug 27 2026 ----
         The tags, the newest scan of each firm, and WHO IS LOOKING. `member` is
         what makes `row.editable` and `row.heldBy` true: the lock is derived once
         per row, in one place, and every control on that row reads the answer
         rather than working it out again. */
      tagsByLead: board.tagsByLead,
      tagsById: board.tagsById,
      reportByCompany: board.reportByCompany,
      member,
    }),
    [rows, companyById, teamName, board.touchCounts, board.tagsByLead, board.tagsById,
      board.reportByCompany, listById, now, member],
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
              canAssign={canAssign}
              onTag={onTag}
              onRefreshTags={onRefreshTags}
              onLog={onLog}
              onScan={onScan}
              onCloseDeal={onCloseDeal}
              onRelease={onRelease}
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


/* ================================================================== */
/* WHY DID IT CLOSE — the box that will not save empty                 */
/* ================================================================== */

/**
 * Ryder, Aug 27 2026. Until today no reason was asked for anywhere: `lost_reason`
 * is a real column and exactly ONE button wrote it, hard-coded to "No reply after
 * the full cadence." Won recorded nothing at all. So the most useful question in
 * sales — why are we losing — had no answer in this database.
 *
 * A DROPDOWN *AND* FREE TEXT, not one or the other. A dropdown can be counted and
 * a paragraph cannot; a paragraph carries the thing that is actually useful and a
 * dropdown never does. Both, or six months from now there are eleven rows saying
 * "no reply" and nothing that says what the emails looked like.
 *
 * TWO SEPARATE LISTS. "Price" is not a reason somebody said yes and "liked the
 * free mockup" is not a reason they said no. One shared list would produce a loss
 * breakdown with a Won reason sitting in it.
 *
 * THE CHECK IS NOT WRITTEN HERE. checkCloseReason in lib/sales-rules.js is the
 * one that decides, the button reads it to know whether to light up, and
 * markLeadLost/closeLeadWon call it again at the door. Three places, one
 * function: a writer that trusts its caller is a writer that eventually gets
 * called wrong.
 */
function CloseReasonModal({ lead, kind, onClose, onSave }) {
  const won = kind === "won";
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  const gate = checkCloseReason({ kind, reason, note });
  const list = won ? WON_REASONS : LOST_REASONS;
  const left = Math.max(0, MIN_REASON_NOTE_CHARS - note.trim().length);

  const save = async () => {
    if (!gate.ok) return;
    setBusy(true);
    setFailed(null);
    const res = await onSave({ reason, note });
    setBusy(false);
    /* A FAILED SAVE KEEPS EVERY WORD ON SCREEN and says what went wrong. The
     * alternative — closing the box and showing a toast — loses the paragraph
     * somebody just typed, and they do not type it again. */
    if (!res?.ok) setFailed(res?.error || "It did not save. Nothing was changed.");
  };

  return (
    <Modal
      open onClose={onClose} kicker={won ? "MARK IT WON" : "MARK IT LOST"} width={560}
      title={won ? "Why did they say yes?" : "Why did we lose it?"}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-accent" onClick={save}
          disabled={busy || !gate.ok}
          /* The refusal is the title, so a greyed button always says why. A
             disabled control with no reason reads as a broken one, and then
             people stop trusting the page. */
          title={gate.ok ? undefined : gate.error}
        >
          {busy ? "Saving…" : won ? "Mark it won" : "Mark it lost"}
        </button>
      </>}
    >
      <div className="adm-sl-warn adm-sl-warn-flat" role="status">
        <strong>This will not save empty.</strong> Six months of these is how we find out what is
        actually going wrong — and it is the only place that answer will ever come from.
      </div>

      <Field
        label="Reason"
        hint="Pick the closest one. This is the half that gets counted."
      >
        <Select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          options={[["", "— pick one —"], ...list]}
        />
      </Field>

      <Field
        label="What actually happened"
        hint={left > 0
          ? `In your own words. ${left} more character${left === 1 ? "" : "s"} needed — this is what somebody reads back later.`
          : "In your own words. This is what somebody reads back later."}
      >
        <TextArea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={won
            ? "What tipped it. What she said. What we showed her."
            : "What they said, and what we would do differently."}
          autoFocus
        />
      </Field>

      {failed && (
        <div className="adm-sl-warn adm-sl-warn-flat" role="alert">
          <strong>Not saved.</strong> {failed} Your words are still here — try again, or copy them
          somewhere before you close this.
        </div>
      )}

      <p className="adm-sl-modalnote">
        Saving does three things at once: it records the reason on
        {" "}<strong>{lead.name || lead.company || "this contact"}</strong>, writes a dated note in
        your words that can never be edited away, and tags the lead. The dated note and the tag are
        part of the same act, so a close with no explanation next to it cannot happen.
      </p>
    </Modal>
  );
}

/* ================================================================== */
/* TAGS on one lead, and the dated history under them                  */
/* ================================================================== */

/**
 * Every add and every remove is kept, with the day and who did it. Nothing is
 * overwritten — a lead's tags right now are the result of replaying this list,
 * which is why there is no `tags` column anywhere and no way to edit one of these
 * rows (there is no update grant on the table at all, see 0018).
 *
 * AN AUTOMATIC TAG CAN BE TAKEN OFF BY HAND AND THE RULE DOES NOT FIGHT BACK.
 * That is not a flag somebody has to remember to set: the removal IS the record,
 * and removedByHand() in lib/lead-tags.js reads it.
 */
function TagModal({ row, allTags, tagsById, teamName, editable, onToggle, onRefresh, onClose }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  /* THE WHOLE HISTORY IS READ HERE, not carried on the row.
   *
   * The board reads `admin_lead_tags_now` — the NEWEST event per tag — because
   * that is all two thousand rows of chips and filters need. The dated history is
   * every event ever, which is the right read for one lead and the wrong read for
   * a board. `null` means not read yet and is deliberately not `[]`: an empty
   * history and a history we have not looked at are opposite things, and the
   * panel below says which. */
  const [events, setEvents] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  useEffect(() => {
    let live = true;
    listLeadTagEvents(row.lead.id).then((res) => {
      if (!live) return;
      setEvents(res.rows || []);
      setHistoryError(res.error || null);
    });
    return () => { live = false; };
  }, [row.lead.id, busy]);

  const on = row.tags || [];
  const onIds = new Set(on.map((t) => t.tag_id));
  const history = useMemo(
    () => (events ? tagHistory(events, tagsById, { teamName }) : null),
    [events, tagsById, teamName],
  );

  const needle = q.trim().toLowerCase();
  const offer = (allTags || [])
    .filter((t) => t.active !== false && !onIds.has(t.id))
    .filter((t) => !needle || `${t.label} ${t.slug}`.toLowerCase().includes(needle))
    .slice(0, 24);

  const run = async (fn) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };

  return (
    <Modal
      open onClose={onClose} kicker="TAGS" width={620}
      title={`Tags — ${row.lead.name || row.companyName || "this contact"}`}
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      {!editable && (
        <div className="adm-sl-warn adm-sl-warn-flat" role="status">
          <strong>Read-only.</strong> {row.heldBy ? `${row.heldBy}.` : "Somebody else holds this lead."}{" "}
          You can read every tag and its whole history. Only the person holding it, or an owner, can
          change them.
        </div>
      )}

      <div className="label" style={{ marginBottom: 8 }}>On this lead now</div>
      {on.length === 0 ? (
        <div className="adm-sl-empty">
          <strong>No tags yet.</strong>
          <div>
            Most tags are set automatically — from the website, the head count, the score and the
            clock. Press <strong>Bring the automatic tags up to date</strong> below to work them out
            for this contact now.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
          {on.map((t) => (
            <button
              key={t.tag_id}
              type="button"
              className="adm-sh-chipbtn"
              disabled={!editable || busy}
              title={editable
                ? `${t.why || "No reason recorded."} Click to take it off.`
                : (t.why || "No reason recorded.")}
              onClick={() => run(() => onToggle({ id: t.tag_id, label: t.label }, "removed"))}
            >
              {t.label}{editable ? <span aria-hidden="true"> ✕</span> : null}
            </button>
          ))}
        </div>
      )}

      {editable && (
        <>
          <Field label="Add one" hint="Only tags on the company's list. A brand new tag name is an owner's decision — three spellings of one tag is a filter nobody can use.">
            <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to search tags…" />
          </Field>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
            {offer.length === 0 ? (
              <span className="adm-sl-faint">
                {needle ? "No tag on the list matches that." : "Every tag on the list is already on this contact."}
              </span>
            ) : offer.map((t) => (
              <button
                key={t.id} type="button" className="btn btn-sm" disabled={busy}
                onClick={() => run(() => onToggle(t, "added"))}
              >
                + {t.label}
              </button>
            ))}
          </div>
          <button className="btn" disabled={busy} onClick={() => run(onRefresh)}>
            {busy ? "Working…" : "Bring the automatic tags up to date"}
          </button>
          <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 6, lineHeight: 1.5 }}>
            Works out the website, size, score, quiet and claim tags from what is on the record right
            now. A tag you took off by hand is never put back.
          </div>
        </>
      )}

      <div className="label" style={{ margin: "22px 0 8px" }}>Tag history</div>
      {historyError ? (
        <div className="adm-sl-warn adm-sl-warn-flat" role="alert">
          <strong>The history could not be read.</strong> {historyError} The tags above are what the
          board loaded; this list is missing, not empty.
        </div>
      ) : history === null ? (
        <div className="adm-sl-faint">Reading the history…</div>
      ) : history.length === 0 ? (
        <div className="adm-sl-faint">Nothing has been tagged on this contact yet.</div>
      ) : history.map((h) => (
        <div key={h.id} style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--rule)", fontSize: 13 }}>
          {/* "COULD NOT READ IT", not "no date". Every one of these rows has a
              date — `at` is `not null default now()` — so a blank here means the
              value would not parse, which is a different thing from an absent one
              and is the distinction this console enforces everywhere else. */}
          <span className="mono adm-sl-faint" style={{ width: 74, flexShrink: 0 }}>
            {sheetDate(h.at) || (h.at ? "bad date" : "no date")}
          </span>
          <span style={{ width: 14, flexShrink: 0, fontWeight: 700, color: h.action === "added" ? "#006b1a" : "var(--danger)" }}>
            {h.action === "added" ? "+" : "−"}
          </span>
          <span title={sheetDateLong(h.at) || undefined}>{h.line}</span>
        </div>
      ))}
      <p className="adm-sl-modalnote">
        Every add and every remove is kept, with the date and who did it. Nothing here is ever
        overwritten and nothing can be deleted — a correction is a new line. The tags on this
        contact right now are just this list, replayed.
      </p>
    </Modal>
  );
}

/* ================================================================== */
/* THE SCAN — built, and it cannot be switched on yet                  */
/* ================================================================== */

/**
 * THIS IS THE HONEST VERSION OF A FEATURE THAT CANNOT RUN.
 *
 * `api/sales-score.js` is careful and already written: it takes a firm id, looks
 * the website up in OUR OWN database and ignores any address sent from the
 * browser, so nobody can score a random URL against a firm. What it cannot do is
 * run — `PLATFORM_SCORE_URL` does not exist, and the field names the code reads
 * are a guess at a contract nobody has written down.
 *
 * So the panel says so, in plain words, in the place somebody would press the
 * button. The alternative — a button that looks live and returns an error — is
 * how a rep learns to distrust the whole page. Everything around it is real: the
 * three scores, the findings and the pitch all have somewhere to live
 * (admin_company_reports, 0019) and a scan that has already run is shown here
 * with the day it was measured.
 */
function ScanModal({ lead, company, report, teamName, onRun, onClose }) {
  const [busy, setBusy] = useState(false);
  const noWebsite = !company?.domain && !lead?.domain;
  const domain = company?.domain || lead?.domain || null;
  /* IS IT ACTUALLY SWITCHED ON — ASKED, NOT ASSUMED.
   *
   * This panel used to say "the address of our own scanner is not set on the
   * server" as static text, with the Scan button enabled next to it. Two problems
   * at once: the day PLATFORM_SCORE_URL is set the sentence becomes a lie, and
   * until then the button looks live and fails — which is precisely what this
   * component's own header condemns.
   *
   * /api/health already answers this (`platformScore`), and useHealth() is the
   * hook every other page in the console reads it with. `null` means we have not
   * heard back yet, which is its own third state and says so rather than guessing
   * either way. Aug 27 2026, after a review. */
  const health = useHealth();
  /* THREE STATES, AND THEY HAVE TO BE THREE.
   *
   * `Boolean(health.platformScore)` folded two different things into "not
   * switched on": preview mode and a failed /api/health both come back as an
   * object with no `platformScore` key at all, so the panel told somebody the
   * server was missing a setting when nobody had been able to ask. Asking whether
   * the KEY IS THERE separates "we know it is off" from "we could not find out".
   * Third review, Aug 27 2026. */
  const scanReady = (health && Object.prototype.hasOwnProperty.call(health, "platformScore"))
    ? Boolean(health.platformScore)
    : null;
  const scanUnknownWhy = health?.preview
    ? "This is preview mode, so there is no server to ask. Nothing can be scanned here and nothing is saved."
    : "We could not reach the console's own health check, so whether scanning is switched on is unknown right now — not off.";

  const run = async () => { setBusy(true); try { await onRun(); } finally { setBusy(false); } };

  return (
    <Modal
      open onClose={onClose} kicker={noWebsite ? "NO WEBSITE" : "SCAN THEIR SITE"} width={620}
      title={noWebsite ? "Build a mockup pitch" : `Scan ${domain}`}
      footer={<>
        <button className="btn" onClick={onClose}>Close</button>
        {!noWebsite && (
          <button
            className="btn btn-accent" onClick={run}
            /* DISABLED WITH ITS REASON ON IT, rather than enabled and failing.
               A button that looks live and returns an error is how a rep learns
               to distrust the whole page. */
            disabled={busy || scanReady === false || scanReady === null}
            title={scanReady === false
              ? "Scanning is not switched on yet — the address of our own scanner is not set on the server, so there is nothing to ask."
              : scanReady === null
                ? scanUnknownWhy
                : "Run a scan now. Nothing is saved unless a real score comes back."}
          >
            {busy ? "Asking…"
              : scanReady === false ? "Scan now — not available yet"
                : scanReady === null ? "Scan now — cannot tell yet"
                  : "Scan now"}
          </button>
        )}
      </>}
    >
      {noWebsite ? (
        /* NO WEBSITE IS A DIFFERENT PITCH, AUTOMATICALLY. There is nothing to
         * scan, so the button and the words change rather than a scan running and
         * failing. This falls straight out of the `no-website` tag. */
        <>
          <div className="adm-sl-warn adm-sl-warn-flat" role="status">
            <strong>There is no website on file for this firm.</strong> Nothing can be scanned, so
            this is the other conversation: we build them one, and we show them a free mockup first.
          </div>
          <p style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            What to say, in order: they cannot be found by an AI search engine because there is
            nothing for it to read; a mockup costs them nothing and takes days, not months; ask for
            fifteen minutes rather than for the job.
          </p>
          <p className="adm-sl-modalnote">
            If they do have a website and we simply have not recorded it, add it on the firm first —
            open the record, Details, Website. The scan will only ever read a website we already hold
            for a firm, so nobody can point it at an address somebody typed into a box.
          </p>
        </>
      ) : (
        <>
          {/* READ FROM THE SERVER, so this sentence cannot outlive the thing it
              describes. Three states, three sentences: not switched on, switched
              on, and we have not heard back yet. */}
          {scanReady === false && (
            <div className="adm-sl-warn adm-sl-warn-flat" role="status">
              <strong>Scanning is not switched on yet.</strong> The address of our own scanner is not
              set on the server, and nobody has written down what it sends back, so the button below
              is off. Nothing is guessed while it is off — <strong>no score is ever invented</strong>,
              because a rep would quote it to a prospect.
            </div>
          )}
          {scanReady === null && (
            <div className="adm-sl-warn adm-sl-warn-flat" role="status">
              <strong>Nobody could tell whether scanning is switched on.</strong> {scanUnknownWhy}
              {" "}The button is off rather than offered — a button that looks live and fails is how
              a page stops being trusted.
            </div>
          )}

          {report ? (
            <>
              <div className="label" style={{ margin: "16px 0 8px" }}>The last scan of this site</div>
              <div className="adm-sl-tiles">
                <Tile
                  label="AI Access"
                  value={report.aiAccess === null ? "—" : report.aiAccess}
                  hint={report.aiAccess === null ? "this half did not come back" : "can AI search read and quote them"}
                />
                <Tile
                  label="SEO"
                  value={report.seo === null ? "—" : report.seo}
                  hint={report.seo === null ? "this half did not come back" : "ordinary Google search"}
                />
                <Tile
                  label="Named by an AI"
                  value={report.simTotal ? `${report.simHits} of ${report.simTotal}` : "—"}
                  hint={report.simTotal ? "buyer questions we asked" : "this half did not come back"}
                />
              </div>
              {/* THE FOUR HALVES OF A MEASUREMENT: the number, what it was
                  measured against, the day it was read, and who read it.
                  Anything short of all four is not a measurement and must not be
                  printed as one. */}
              <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 8, lineHeight: 1.6 }}>
                Measured on <strong>{report.domain || domain}</strong>, read
                {" "}<strong>{sheetDate(report.measuredAt) || "date unreadable"}</strong>
                {report.measuredBy ? <> by {teamName(report.measuredBy) || "somebody on the team"}</> : null}.
                {" "}A dash means that half of the scan did not come back — it is missing, not zero.
              </div>

              {report.findings.length > 0 && (
                <>
                  <div className="label" style={{ margin: "18px 0 8px" }}>What is wrong, in their words</div>
                  {report.findings.map((f, i) => (
                    <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid var(--rule)" }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{f.title}</div>
                      <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>{f.detail}</div>
                    </div>
                  ))}
                </>
              )}

              <div className="label" style={{ margin: "18px 0 8px" }}>The pitch</div>
              {report.pitch ? (
                <p style={{ fontSize: 13.5, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{report.pitch}</p>
              ) : (
                <div className="adm-sl-faint" style={{ fontSize: 13 }}>
                  Nothing was written.{report.pitchGateReason ? ` ${report.pitchGateReason}` : ""} The
                  scores and the findings above are what the scan returned; the words are a separate
                  thing and they are missing, not empty.
                </div>
              )}
            </>
          ) : (
            <div className="adm-sl-empty" style={{ marginTop: 14 }}>
              <strong>This site has never been scanned.</strong>
              <div>
                That is not the same as a bad score — nobody has measured it. When scanning is
                switched on, the first scan is kept for life and a later one is added next to it
                rather than on top of it, so &ldquo;still the same in November&rdquo; stays readable.
              </div>
            </div>
          )}

          <p className="adm-sl-modalnote">
            Rules that stay, whatever happens to the scanner: a scan only ever reads a website we
            already hold for that firm, so nobody can score an address typed into a box. A re-scan
            never wipes the old one — both are kept, with their dates. If the scan fails, nothing is
            saved. And a firm scoring {ROE.SKIP_SCORE_AT_OR_ABOVE} or above is parked as
            &ldquo;not a prospect&rdquo; rather than worked.
          </p>
        </>
      )}
    </Modal>
  );
}
