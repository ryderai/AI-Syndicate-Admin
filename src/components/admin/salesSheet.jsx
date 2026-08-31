import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SHEET_COLUMNS, DEFAULT_SHEET_COLUMNS, SHEET_COLUMN_KEYS,
  FILTERABLE, GROUPABLE, SORTABLE,
  CLAIM_LABELS, CLAIM_COLOR,
  columnLabel, facetValue, facetValues, groupRows,
  nameParts, nextSort, sortRowsBy,
  contestedCompanies, companyHeadcount, sheetDate, sheetDateLong,
  /* ---- Aug 27 2026, The Floor ----
   * The filters hold SEVERAL VALUES PER COLUMN now, so every one of these takes
   * a `{ colKey: Set<value> }` rather than a `{ colKey: value }`. They live in
   * the pure module because the rules about what a filter means have tests and a
   * component cannot be given any. */
  applyFacets, toggleFacetValue, clearFacet, facetChips,
  SCORE_BANDS, SIZE_BANDS, TOUCH_BANDS, WEBSITE_BANDS,
  readCount,
  /* ---- 30 Aug 2026 ----
   * A rep no longer sees another rep's rows at all, so the firm cell is the one
   * place left that can tell them a firm is taken. The words live in the pure
   * module so the chip here and the line in the drawer cannot drift. */
  FIRM_BUSY_LABEL, FIRM_BUSY_WHY,
} from "../../lib/salesSheet.js";
import { LEAD_STAGES, LEAD_STAGE_LABELS, LEAD_STAGE_HELP, PICKABLE_STAGES, stageIsDerived } from "../../lib/data.js";

/* WAS the two "not a fit" stages under names that said they were one outcome.
 * Migration 0027 ran on 31 Aug and made them one stage, so the workaround is
 * gone and the picker shows what the database holds. Kept as an empty table
 * rather than deleted, because the next stage that needs a different word in
 * the chooser than on the row will want it back. */
const STAGE_PICK_LABELS = {};
import { ChipPicker } from "./chipPicker.jsx";
/* Two clicks on the Contacted? cell. Its own component rather than a `mode` on
 * ChipPicker: that one moves a lead between stages and the value it shows is
 * the value it sets, and this does neither. 30 Aug 2026 */
import { TouchPicker } from "./touchPicker.jsx";
/* The one-text gate, read rather than re-implemented: the row, the drawer and the
 * database function admin_lead_claim_text all have to agree about it. */
import { textGate, canEmail } from "../../../lib/sales-rules.js";
import {
  Chip, Avatar, Popover,
} from "./opsCells.jsx";
import { ScoreChip, SiteLink } from "./salesParts.jsx";

/* THE SHEET — one row per person, in CJ's own column order.
 *
 * Ryder, Aug 25 2026: *"i dont like how the business has a dropdown with the
 * owner below, thats not needed, just make it rows of the people. you can take
 * inspo from the google sheet that there using already."*
 *
 * What that replaced: a table where every firm was a collapsible header row and
 * the people lived underneath it. It was built that way to make "one firm, one
 * rep" visible, and it did — at the cost of a screen where you could not read
 * ten people in a row, could not sort by anything, and had to open a firm to
 * find out whether anybody was working it.
 *
 * The rule the grouping existed for is NOT dropped. It moved onto the Company
 * cell: a firm two reps are both working is marked on every one of its rows,
 * counted across the whole pipeline rather than across the rows on screen —
 * filter to your own leads and a contested firm would otherwise stop looking
 * contested at exactly the moment you need telling.
 *
 * And grouping is still one click away. It is a switch now, not the shape.
 */

/* The four columns whose FILTER is a band rather than their own value. Kept at
 * module level rather than inside the component: a new object every render is a
 * new dependency every render, and useCallback then rebuilds labelFor on every
 * keystroke — which rebuilds every header menu under it. */
const BANDS = {
  site_score: SCORE_BANDS, employees: SIZE_BANDS,
  last_touch: TOUCH_BANDS, website: WEBSITE_BANDS,
};

/* The Do column, in ONE place. It used to be written twice — 46 in the colgroup
 * and 210 in the header — and the two disagreed for as long as the sheet has
 * existed. */
const DO_COLUMN_WIDTH = 210;

/* The two columns that are counted from a WINDOW rather than from the whole
 * history. Their heading says so; nothing else on the sheet needs to. */
const WINDOWED_COLUMNS = ["contacted", "touches"];

const PREFS_KEY = "ais.sales.sheet.v1";

function loadPrefs() {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === "object" ? p : {};
  } catch { return {}; }
}
function savePrefs(p) {
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

/** A stored column list has to be checked before it is used. A key that was
 *  renamed or removed since it was saved would otherwise render an empty
 *  column with a header nobody can switch off. */
function cleanColumns(v) {
  if (!Array.isArray(v)) return null;
  const keep = v.filter((k) => SHEET_COLUMN_KEYS.includes(k));
  return keep.length ? keep : null;
}

/**
 * A COLUMN ADDED AFTER SOMEBODY SAVED THEIR PREFERENCES HAS TO APPEAR ANYWAY.
 *
 * 31 Aug 2026: the Draft email column went into DEFAULT_SHEET_COLUMNS and did
 * not appear on the screen at all, because a saved list from yesterday wins
 * over today's defaults — so the one control the whole rebuild points at was
 * invisible to every person who had ever touched the column menu. Found by
 * counting the columns on the page, not by a test.
 *
 * This console already has a note about the shape: a saved preference can
 * delete an action, and it did exactly that to the Claim button in August.
 *
 * `seen` is the set of keys that EXISTED when the preference was saved. Any
 * default column that is not in it is new since, so it is added — in its proper
 * place, not at the end. A column the person actually switched off is in `seen`
 * and stays off, which is the whole point: this restores columns nobody has had
 * the chance to decide about, and never overrules a decision somebody made.
 *
 * With no `seen` (a preference saved before this existed) the fallback is the
 * key list as it was the day before, so the same reasoning holds for it too.
 */
const KEYS_BEFORE_DRAFT_EMAIL = SHEET_COLUMN_KEYS.filter((k) => k !== "draft_email");

function withNewColumns(saved, seen) {
  if (!saved) return null;
  const known = new Set(Array.isArray(seen) && seen.length ? seen : KEYS_BEFORE_DRAFT_EMAIL);
  const missing = DEFAULT_SHEET_COLUMNS.filter((k) => !known.has(k) && !saved.includes(k));
  if (!missing.length) return saved;
  /* Back in SHEET_COLUMNS order, so a new column lands where it was designed to
   * be rather than after the notes. */
  const wanted = new Set([...saved, ...missing]);
  return SHEET_COLUMN_KEYS.filter((k) => wanted.has(k));
}
function cleanGroupBy(v) {
  return typeof v === "string" && (v === "none" || GROUPABLE.has(v)) ? v : "none";
}

export default function SalesSheet({
  /* `team` was dropped from this list on 30 Aug 2026 along with the owner
   * dropdown — handing a lead to somebody else is done on the card now. The
   * page still passes it; the sheet no longer needs it. */
  rows, allLeads, member, lists,
  onPatch, onAssign, onOpen, onRunScore, teamName, activityWindowDays = 90,
  /* ---- added Aug 27 2026 with The Floor ----
   * WHETHER THE SALES OWNER CELL IS A DROPDOWN OF PEOPLE OR A CLAIM BUTTON.
   * Only an owner or an admin may hand a lead to somebody else — that is
   * enforced in the database (migration 0020) and again in the page's
   * assignLead. This is the third copy, the one a person sees. */
  canAssign = true,
  /* One function per action, and every one of them writes the dated line itself.
   * A button in here never writes: it calls one of these and nothing else. See
   * the note at the top of the SALES section of src/lib/data.js for the defect
   * that rule exists to prevent. */
  onTag, onRefreshTags, onLog, onScan, onCloseDeal, onRelease,
  /* onTouch(row, channel, outcome) — logs ONE touch from the Contacted? cell.
     Resolving false means it was refused and the note step is skipped.
     onTouchDone(row, { next, note }) — the "and next?" step, on a touch that is
     already written. Two callbacks, not one with an optional argument, because
     one callback is how the third step ends up logging a second touch. */
  onTouch = null, onTouchDone = null,
  /* onDraftEmail(row) — asks the server for a draft and opens the panel.
     `drafting` is the id of the row whose draft is in flight, or null: one at a
     time, because a rep pressing four buttons should not get four panels. */
  onDraftEmail = null, drafting = null,
  /* WHO IS CLAIMING. A user id turns the Sales Owner cell of an UNCLAIMED row
   * into a one-press Claim button. Aug 26 2026, Ryder: the rep's Leads page is
   * the floor, and "put your name in the Sales Owner column" is not a claim
   * button — it is a dropdown you have to find, on a page whose whole job is
   * taking a lead. Null (the owner's Sales page) keeps the dropdown everywhere,
   * because assigning somebody else's lead is a real thing an owner does. */
  claimAs = null,
}) {
  const [columns, setColumns] = useState(() => {
    const p = loadPrefs();
    return withNewColumns(cleanColumns(p.columns), p.seen) || DEFAULT_SHEET_COLUMNS;
  });
  const [groupBy, setGroupBy] = useState(() => cleanGroupBy(loadPrefs().groupBy));
  /* A sort is something you do for a minute, so unlike columns and grouping it
   * is deliberately NOT remembered between visits. */
  const [sort, setSort] = useState(null);
  /* `{ colKey: Set<value> }` — several columns at once, several values each.
   *
   * It was `{ colKey: value }`: one value per column, so State could be FL or AL
   * and never both, and seven columns could be filtered at all. Ryder, Aug 27
   * 2026, on the Floor: the filters have to stack, and a filter has to hold more
   * than one value.
   *
   * DELIBERATELY NOT SAVED TO localStorage, unlike the columns and the grouping.
   * A rep who comes back tomorrow to a page still filtered to one state from
   * last week reads it as an empty pipeline, and the control that would explain
   * it is the one they have forgotten they touched. */
  const [facets, setFacets] = useState({});
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [colsOpen, setColsOpen] = useState(null);
  const [scoring, setScoring] = useState(null);
  /* WHICH ROW IS MID-CLAIM. A claim is a write plus a reload, which is long
   * enough to press the button again — and two presses wrote two "Claimed by X"
   * lines on the timeline and re-stamped `claimed_at`, restarting the
   * first-contact clock the rep is being judged on. One id rather than a
   * boolean, so a slow claim on one row does not freeze the whole floor.
   * The refusal underneath it is in claimLead (src/lib/data.js): a guard on the
   * button stops YOUR second click, and only the query can stop somebody
   * else's first one. Aug 26 2026 */
  const [claiming, setClaiming] = useState(null);

  /* `seen` travels with the preference so the NEXT column added can tell what
   * this person had already been offered. Without it, every future column would
   * need its own hard-coded before-list like the one above. */
  useEffect(() => { savePrefs({ columns, groupBy, seen: SHEET_COLUMN_KEYS }); }, [columns, groupBy]);

  /* Whether the person reading this may be told WHO holds something. Derived
   * once, here, from the same `member` every other rule on this table reads —
   * not re-tested inline in a cell. 30 Aug 2026 */
  const hideNames = member?.role === "sales";

  const contested = useMemo(() => contestedCompanies(allLeads), [allLeads]);
  const headcount = useMemo(() => companyHeadcount(allLeads), [allLeads]);

  /* The header menus are built from `rows` — the page's filtered set BEFORE
   * this table's own column filters. Built from what is on screen instead, one
   * filter shrinks every other column's menu to the values that survived it,
   * and a value outside the current filter cannot be reached from a header at
   * all. That was a real bug in the Operations table. */
  const shown = useMemo(() => applyFacets(rows, facets), [rows, facets]);

  /* ---- the words for a filter value, per column ----
   * The banded columns are checked FIRST, before the "__none" branch: on those
   * four, "__none" is a real band with its own name ("No score yet", "Never
   * touched") rather than an absence, and falling through would have printed
   * "No site score" where the menu means "nobody has scanned this". */
  const labelFor = useCallback((key, value) => {
    if (BANDS[key]) {
      const hit = BANDS[key].find(([v]) => v === value);
      return hit ? hit[1] : String(value);
    }
    /* A tag's words come from the vocabulary, so a slug never reaches a screen.
     * `tags` is the one multi-valued column; "__none" on it means the lead has
     * no tags at all, which is a thing a rep filters FOR. */
    if (key === "tags") {
      if (value === "__none") return "No tags";
      const hit = (rows || []).flatMap((r) => r.tags || []).find((t) => t.slug === value);
      return hit?.label || String(value);
    }
    if (value === "__none" || value === null || value === undefined || value === "") {
      return key === "owner" ? "On the floor"
        : key === "company" ? "No firm on file"
          : key === "list" ? "In no list"
            : key === "vertical" ? "No line of business on file"
              : key === "city" ? "No city on file"
                : `No ${columnLabel(key).toLowerCase()}`;
    }
    if (key === "owner") return teamName(value) || "Former member";
    if (key === "stage") return LEAD_STAGE_LABELS[value] || value;
    if (key === "claim") return CLAIM_LABELS[value] || value;
    if (key === "contacted") {
      return value === "yes" ? "Contacted recently"
        : value === "older" ? "Contacted, but not lately"
          : "No contact on record";
    }
    if (key === "company") {
      const r = rows.find((x) => x.lead.company_id === value) || allRowFor(allLeads, value);
      return r?.companyName || r?.company || "Unknown firm";
    }
    if (key === "list") return lists.find((l) => l.id === value)?.name || "Unknown list";
    return String(value);
  }, [teamName, rows, lists, allLeads]);

  const groups = useMemo(
    () => groupRows(shown, groupBy, { labelFor }),
    [shown, groupBy, labelFor],
  );

  /* THE CLAIM BUTTON'S COLUMN CANNOT BE SWITCHED OFF — Ryder, Aug 26 2026.
   *
   * Found by a checker. The Claim button renders inside the Sales Owner cell,
   * the column list is chosen from a menu, and that menu's choice is saved in
   * localStorage under ONE key shared by every page that draws this sheet. So
   * on the floor: Columns → uncheck "Sales Owner" → every Claim button gone,
   * across reloads, under a hint that still read "press Claim to take it". The
   * page's words and the page's controls disagreed, and the only way left to
   * claim was to open a row and use the drawer.
   *
   * `claimAs` is exactly "this page is a page you claim from", so it pins the
   * column: the pin is applied to what is RENDERED, and `columns` — the saved
   * preference — is left alone. Uncheck it here and the owner's Sales page,
   * which sends no claimer, still honours the choice. The menu entry below is
   * disabled with the reason on it, so the pin is visible rather than a click
   * that appears to do nothing. */
  const pinned = claimAs ? "owner" : null;
  const shownKeys = pinned && !columns.includes(pinned)
    ? SHEET_COLUMN_KEYS.filter((k) => columns.includes(k) || k === pinned)
    : columns;
  const visible = SHEET_COLUMNS.filter((c) => shownKeys.includes(c.key));
  /* +1 for the Do column at the end, which is never switchable: a table of leads
   * with no way to act on one is a spreadsheet, which is the thing this replaced. */
  const span = visible.length + 1;

  /* AND across columns, OR inside one column — decided in matchesFacets() in the
   * pure module, not here, so the same answer is what the tests read. This just
   * flips one value on or off. */
  const toggleFacet = (key, value) => setFacets((cur) => toggleFacetValue(cur, key, value));
  const dropFacet = (key) => setFacets((cur) => clearFacet(cur, key));
  const clearAllFacets = () => setFacets({});

  const toggleGroup = (key) => setCollapsed((cur) => {
    const n = new Set(cur);
    const k = `${groupBy}:${key}`;
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  /* The picker shows what each stage MEANS, not just its name. A status
   * nobody can explain out loud is a status nobody uses — the help text has
   * existed in data.js since the drawer was built and the sheet never showed it. */
  /* ONLY THE STAGES A PERSON DECIDES — 30 Aug 2026.
   *
   * Was every value in LEAD_STAGES. The four early ones are derived now: the
   * activity log knows whether we have reached out, and the Contacted? column
   * two cells to the left prints it live. A dropdown asking a rep to keep a
   * second copy of that by hand is how the two came to disagree.
   *
   * Rows still HOLDING an early stage keep it and keep displaying it — nothing
   * is rewritten. It just cannot be chosen. `PICKABLE_STAGES` is the list; the
   * two "Not a fit" entries are one outcome with two reasons until 0027 merges
   * them into a single stage value. */
  const stageOptions = PICKABLE_STAGES.map((v) => ({
    value: v, label: STAGE_PICK_LABELS[v] || LEAD_STAGE_LABELS[v],
    color: STAGE_COLOR[v] || "default", help: LEAD_STAGE_HELP[v],
  }));
  const listOptions = lists.map((l) => ({ value: l.id, label: l.name, color: "default" }));

  const filterFor = (key, row) => {
    if (!FILTERABLE.has(key) && !GROUPABLE.has(key)) return null;
    const v = facetValue(row, key);
    return {
      label: labelFor(key, v),
      column: columnLabel(key),
      /* `.has`, not `===`. A column holds a SET of values now, and comparing a
       * Set to a string is quietly false for every row — the tick would simply
       * never appear on a filter that is on. */
      active: Boolean(facets[key]?.has(v)),
      onOnly: FILTERABLE.has(key) ? () => toggleFacet(key, v) : null,
      onGroup: GROUPABLE.has(key) ? () => setGroupBy((cur) => (cur === key ? "none" : key)) : null,
    };
  };

  /* ---- WHAT A ROW MAY DO ----
   * Read off `row.editable`, which sheetRow() derived ONCE from canEditLead().
   * Nothing in this file works it out again: a cell that decided for itself
   * whether it was editable could disagree with the row it sits in, and the
   * greyed row would still have one live control on it. */
  const locked = (row) => !row.editable;

  /* A read-only cell. Same shape as the three cells that were ALWAYS read-only
   * (Contacted?, First Contact, Last Touch) so a locked row looks like a row and
   * not like a broken one: the value is still there, still readable, and the
   * click opens the record instead of editing it. */
  const readOnlyCell = (row, content, why) => (
    <button
      type="button" className="adm-db-btn adm-sh-readonly"
      title={why}
      onClick={(e) => { e.stopPropagation(); onOpen(row.lead.id); }}
    >
      {content}
    </button>
  );

  const runScore = async (row) => {
    if (!onRunScore) return;
    setScoring(row.id);
    try { await onRunScore(row); } finally { setScoring(null); }
  };

  /* The value a LOCKED row shows for a column that would otherwise be editable.
   * Plain text, no control. Kept in one place so a greyed row cannot end up with
   * one column that still looks clickable. */
  const plainValue = (row, key) => {
    const l = row.lead;
    const parts = nameParts(l);
    switch (key) {
      case "owner": return row.ownerName || "On the floor";
      case "stage": return LEAD_STAGE_LABELS[l.stage] || l.stage;
      case "list": return row.listName || "In no list";
      case "next_step": return l.next_step || "—";
      case "first_name": return parts.first || "—";
      case "last_name": return parts.last || "—";
      case "full_name": return l.name || "—";
      case "title": return l.title || "—";
      case "email": return l.email || "—";
      case "phone": return l.phone || "—";
      case "city": return l.city || "—";
      case "state": return l.state || "—";
      default: return "—";
    }
  };

  /* EVERY COLUMN THAT IS NOT A PRESET CHIP IS READ-ONLY ON THE SHEET.
   *
   * Ryder, 30 Aug 2026: "i want it so that its a normal row that when you click
   * anything that isnt a tag it opens the client card … i want everything
   * simple, one click movement through the pipeline … we have friggin 3000+
   * leads, we need to be able to do this at scale."
   *
   * What this replaced: nine columns you could type into where you sat. It
   * sounds like less and it is more. A row where every cell is a different kind
   * of control is a row you have to aim at before you can click it, and the
   * thing a rep does three hundred times a day — open the person, read them,
   * move them on — was the thing that took the most aim.
   *
   * NOTHING BECAME UNEDITABLE. Name, title, email, phone, city, the next step,
   * the owner and the stage are all on the client card, which is now one click
   * from anywhere on the row. This is a move, not a removal.
   *
   * These cells do not swallow the click: it passes up to the row, which opens
   * the record. That is why they are a span and not a button. */
  const plainCell = (row, key, why) => {
    const v = plainValue(row, key);
    const empty = v === "—" || v === "Empty" || v === "In no list";
    return (
      <span className={`adm-sh-plain${empty ? " adm-db-empty" : ""}`} title={why || undefined}>
        {v}
      </span>
    );
  };

  /* ---- one cell ---- */
  const cell = (row, key) => {
    const l = row.lead;

    /* ---- THE ROW LOCK ----
     *
     * A rep may change a lead they hold or a lead nobody holds. Somebody else's
     * row is readable and not editable: visibility wide on purpose, editability
     * not.
     *
     * IT IS NO LONGER A BRANCH IN FRONT OF THE SWITCH. Since 30 Aug 2026 the
     * only controls left on a row are the preset chips, so the lock is passed
     * INTO those two cells as `disabled` — which is what lets a locked row still
     * show its status in colour, and still say why it cannot be moved, instead
     * of turning into plain grey text that looks like a different column.
     *
     * This is the POLITE half of the lock. The half that works is migration 0020
     * and the check inside every endpoint that writes a lead. */

    switch (key) {
      case "owner":
        /* THE ONE ACTION THAT IS STILL A BUTTON ON A ROW, because it is a
         * one-click act and not a field: taking a lead off the floor. It goes
         * through the SAME onAssign path every other claim uses, so the claim,
         * the cadence clock and the toast cannot behave differently depending on
         * which control you touched. */
        if (claimAs && !l.owner_id && !locked(row)) {
          const busy = claiming === row.id;
          return (
            <button
              type="button"
              className="btn btn-accent btn-sm adm-sh-claim"
              disabled={busy}
              aria-busy={busy}
              onClick={async (e) => {
                e.stopPropagation();
                /* Belt as well as braces: `disabled` is the guard a person
                 * sees, this is the one a second queued event meets. */
                if (claiming === row.id) return;
                setClaiming(row.id);
                try { await onAssign(row, claimAs); } finally { setClaiming(null); }
              }}
              title={busy ? "Claiming…" : "Take this lead. First contact is then on the clock."}
            >
              {busy ? "Claiming…" : "Claim"}
            </button>
          );
        }
        /* HANDING A LEAD TO SOMEBODY ELSE HAPPENS ON THE CARD. It is an owner's
         * act — migration 0020 refuses it in the database for everybody else —
         * it is rare, and it is not worth a dropdown on three thousand rows.
         * The card has the picker. */
        return plainCell(row, "owner", l.owner_id
          ? `${row.ownerName || "Someone"} holds this. Open the record to hand it over.`
          : (canAssign ? "Nobody has claimed this. Open the record to give it to somebody."
            : "Nobody has claimed this."));

      case "contacted": {
        /* STILL COUNTED, NEVER SET — and now it is also where you log the touch.
         *
         * The VALUE stays derived. In the outreach sheet this was a dropdown
         * saying the same thing as Sales Cycle Status; reps filled one or the
         * other and neither could be trusted. Here it is counted off the
         * timeline, so it cannot disagree with anything, and that does not
         * change: nothing below writes a "contacted" field, because there is
         * none.
         *
         * What clicking it does is log a real touch, and the chip follows on the
         * next read. Ryder, 30 Aug 2026 — two clicks, and the data is there.
         *
         * `blocked.text` carries the one-text rule as a REASON on a disabled
         * row rather than a hidden row. A rule you cannot see is a rule nobody
         * learns; the drawer has shown it this way since Aug 27. */
        const c = row.contacted;
        const chip = <Chip label={c.short} color={c.color} />;
        if (!onTouch || locked(row)) {
          return (
            <button
              type="button" className="adm-db-btn adm-sh-readonly"
              title={c.why}
              onClick={(e) => { e.stopPropagation(); onOpen(l.id); }}
            >
              {chip}
            </button>
          );
        }
        /* BOTH SEND RULES, not just the text one. `canEmail` refuses a
           bounced address and was written the same evening and then wired
           nowhere — a checker found it had exactly one caller, its own test.
           A rule that nothing reads is a rule that is not in force. */
        const tGate = textGate(l);
        const eGate = canEmail(l);
        const blocked = {};
        if (!tGate.allowed) blocked.text = tGate.reason;
        if (!eGate.allowed) blocked.email = eGate.reason;
        return (
          <TouchPicker
            current={chip}
            blocked={blocked}
            onPick={(channel, outcome) => onTouch(row, channel, outcome)}
            onDone={onTouchDone ? (payload) => onTouchDone(row, payload) : null}
          />
        );
      }

      case "stage":
        /* THE FAST LANE. One click moves the lead. The note afterwards is
         * optional and never blocks — see chipPicker.jsx for why that order is
         * the whole design. Won and Lost hand off to the reason box that has
         * existed since Aug 27 rather than asking for the same sentence twice. */
        return (
          <ChipPicker
            label="Sales cycle status"
            value={l.stage}
            options={stageOptions}
            /* A ROW HOLDING A DERIVED STAGE STILL SHOWS IT.
               The picker offers six now, so a lead sitting on `contacted` matched
               no option and the closed cell rendered the "—" placeholder — three
               thousand rows suddenly claiming to have no stage at all. Found by
               looking at the page, not by a test.
               The label is drawn muted, because it is real history you can read
               and not a thing you can set. What it means today is in the two
               columns either side, live. 30 Aug 2026 */
            current={stageIsDerived(l.stage)
              ? (
                <span className="adm-sh-stage-derived" title="The system works this one out from the timeline — open the record to move it on.">
                  {LEAD_STAGE_LABELS[l.stage] || l.stage}
                </span>
              )
              : undefined}
            disabled={locked(row)}
            disabledWhy={`${row.heldBy || "Somebody else holds this lead"} — you can read it, not move it.`}
            onPick={(v) => onPatch(l, { stage: v })}
            onNote={(v, note) => onPatch(l, { stage: v }, note)}
          />
        );

      case "claim": {
        const s = row.claim;
        const late = s.over !== null && s.over !== undefined && s.over > 0;
        return (
          <button
            type="button" className="adm-db-btn adm-sh-readonly" title={s.why}
            onClick={(e) => { e.stopPropagation(); onOpen(l.id); }}
          >
            <Chip label={CLAIM_LABELS[s.state] || s.state} color={CLAIM_COLOR[s.state] || "default"} />
            {late ? <span className="adm-sh-over">{s.over}d</span> : null}
          </button>
        );
      }

      case "first_contact":
      case "last_touch": {
        /* READ-ONLY: a database trigger writes both of these from real logged
         * calls and emails (migration 0009), and they are what the 3-business-day
         * and 14-day timers count. A timer you can type over is a timer that
         * never fires, which is exactly what happened in the sheet. */
        const iso = key === "first_contact" ? l.first_contact_at : l.last_touch_at;
        const txt = sheetDate(iso);
        return (
          <button
            type="button" className="adm-db-btn mono adm-sh-readonly"
            title={iso
              ? `${sheetDateLong(iso)} — set by a logged touch, not typed`
              : "Nothing logged. This fills in the moment a call or email is logged on the timeline."}
            onClick={(e) => { e.stopPropagation(); onOpen(l.id); }}
          >
            {txt || <span className="adm-db-empty">—</span>}
          </button>
        );
      }

      case "next_step":
        /* Still the widest column and still the first thing a rep reads across
         * a row. It is written on the card now, where there is room to write a
         * sentence rather than a cell's worth of one. */
        return plainCell(row, "next_step", l.next_step || "Nothing planned yet.");

      case "first_name":
      case "last_name":
      case "full_name":
      case "title":
      case "email":
      case "phone":
      case "city":
      case "state":
        return plainCell(row, key);

      case "company": {
        /* The firm-level warning the grouped table used to carry. It is on the
         * ROW now, because a flat table has nowhere else to put it. */
        const others = l.company_id ? contested.get(l.company_id) : null;
        const n = l.company_id ? headcount.get(l.company_id) || 1 : 1;
        return (
          <FirmCell
            row={row} others={others} headcount={n} teamName={teamName}
            /* THE TWO FIRM WARNINGS ARE ONE CELL, ON PURPOSE.
               `others` is "two or more people hold contacts here", which needs
               the reader to hold one of them to be true. `row.firmBusy` is the
               case that rule can never see: an UNCLAIMED row at a firm somebody
               else is inside, where there is exactly one owner and it is not
               you. Before 30 Aug that case did not need saying, because the
               other rep's row was on screen. It is not any more. */
            busy={row.firmBusy}
            /* NO NAMES FOR A REP. A rep is told a firm is taken; who is in it is
               the thing that was just hidden from them, and printing it in a
               popover would hand it straight back. Owners and admins keep the
               names — the whole point of their page is knowing who has what. */
            hideNames={hideNames}
            filter={filterFor("company", row)} onOpen={() => onOpen(l.id)}
          />
        );
      }

      case "site_score":
        return <ScoreChip score={row.company?.site_score} onRun={onRunScore ? () => runScore(row) : undefined} busy={scoring === row.id} />;

      case "website":
        return row.domain
          ? <SiteLink domain={row.domain} />
          : <span className="adm-db-empty">—</span>;

      case "list":
        /* The same control as the status chip, for the same reason: it is a
         * fixed list of things somebody already made, and picking one is one
         * click. No note step — moving a contact between lists is filing, not
         * a thing that happened to them. */
        return (
          <ChipPicker
            label="List"
            value={l.list_id}
            options={listOptions}
            placeholder="In no list"
            disabled={locked(row)}
            disabledWhy={`${row.heldBy || "Somebody else holds this lead"} — you can read it, not change it.`}
            onPick={(v) => onPatch(l, { list_id: v })}
          />
        );

      /* ---- TAGS ----
       * Display only since 30 Aug 2026. Ryder: "i dont want to be able to add
       * tags." Most of these are applied by rules in lib/sales-rules.js anyway
       * — a rep hand-adding "Gone quiet" next to a rule that counts it is two
       * sources for one fact. The dated history, and the few that CAN be put on
       * by hand, are still one click away in the row's ⋯ menu.
       *
       * A plain span, not a button: the click passes up to the row and opens
       * the record, like every other reading cell. */
      case "tags": {
        const on = row.tags || [];
        if (!on.length) return <span className="adm-sh-plain adm-db-empty">—</span>;
        return (
          <span className="adm-sh-plain" title={on.map((t) => t.label).join(" · ")}>
            <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
              {on.slice(0, 3).map((t) => <Chip key={t.tag_id} label={t.label} color={t.color} />)}
              {/* SAID, not hidden. Three chips is what fits; a cell that quietly
                  stops at three reads as a lead with three tags. */}
              {on.length > 3 ? <span className="adm-sh-headn">+{on.length - 3}</span> : null}
            </span>
          </span>
        );
      }

      case "draft_email": {
        /* AN ACTION, NOT A VALUE — Ryder, 31 Aug 2026: "add a row for email that
         * drafts up an email based on stage, notes, timeline and everything else
         * thats known about the client."
         *
         * Nothing is stored behind this cell. It asks the server to write one,
         * from that lead's stage, notes, timeline, tags, proposals and the
         * newest scan of their site, and opens it in a panel a person edits.
         * IT NEVER SENDS — see api/lead-email.js.
         *
         * Three states, and each one says something different:
         *   no address        → nothing to write to
         *   bounced           → refused, with the date, because canEmail refuses
         *   otherwise         → Draft email
         * The bounce case is a REFUSAL WITH A REASON rather than a hidden
         * button: a rule you cannot see is a rule nobody learns. */
        const eg = canEmail(l);
        if (!l.email) {
          return (
            <span className="adm-db-empty" title="No email address on this contact.">no email</span>
          );
        }
        if (!eg.allowed) {
          return (
            <span className="adm-sh-refused" title={eg.reason}>
              {eg.bounced ? "bounced" : "cannot email"}
            </span>
          );
        }
        return (
          <button
            type="button" className="adm-db-btn adm-sh-draftbtn"
            disabled={!onDraftEmail || drafting === l.id}
            title="Write the next email to this person, from everything on their record. It drafts — it never sends."
            onClick={(e) => { e.stopPropagation(); onDraftEmail?.(row); }}
          >
            {drafting === l.id ? "Writing…" : "Draft email"}
          </button>
        );
      }

      case "scores": {
        const r = row.report;
        if (!r) {
          return (
            <button
              type="button" className="adm-db-btn"
              title={row.domain
                ? "Nobody has scanned this site. That is not a bad score — it is no score."
                : "No website on file for this firm, so there is nothing to scan."}
              onClick={(e) => { e.stopPropagation(); onScan?.({ lead: l, company: row.company }); }}
            >
              <span className="adm-db-empty">{row.domain ? "Scan site" : "no site"}</span>
            </button>
          );
        }
        const bit = (label, v) => (
          <span className="mono" style={{ fontSize: 11.5 }}>
            {label} {v === null ? <span className="adm-db-empty">—</span> : v}
          </span>
        );
        return (
          <button
            type="button" className="adm-db-btn"
            title={`Measured ${sheetDateLong(r.measuredAt) || "on an unreadable date"} on ${r.domain || row.domain || "an unrecorded website"}. A dash means that half of the scan did not come back — missing, not zero. Click for the findings.`}
            onClick={(e) => { e.stopPropagation(); onScan?.({ lead: l, company: row.company }); }}
          >
            <span style={{ display: "inline-flex", gap: 8 }}>
              {bit("AI", r.aiAccess)}
              {bit("SEO", r.seo)}
              {r.simTotal ? bit("named", `${r.simHits}/${r.simTotal}`) : null}
            </span>
          </button>
        );
      }

      /* Two columns that have arrived with every sheet import since Aug 25 and
       * were displayed nowhere. Read-only here, because they belong to the firm
       * and the firm is edited on the firm. */
      case "employees": {
        const n = readCount(row.company?.employees);
        return readOnlyCell(
          row,
          n === null
            ? <span className="adm-db-empty">—</span>
            : <span className="mono">{n}</span>,
          n === null
            ? "No head count on file for this firm. That is unknown, not one person."
            : `${n} people at this firm, from the sheet import.`,
        );
      }

      case "vertical": {
        const v = row.company?.vertical || l.vertical || null;
        return readOnlyCell(
          row,
          v ? <span>{v}</span> : <span className="adm-db-empty">—</span>,
          v
            ? "The firm's line of business, from the sheet import. Filter on it from the header."
            : "No line of business on file for this firm.",
        );
      }

      case "touches": {
        const c = row.cadence;
        return (
          <button
            type="button" className="adm-db-btn adm-sh-readonly"
            title={c.finished
              ? "All five touches of the cadence are logged."
              : c.step
                ? `Next: ${c.step.label} (day ${c.step.day} after the claim). ${c.step.hint}`
                : "The cadence is not running — nobody has claimed this, or it is finished with."}
            onClick={(e) => { e.stopPropagation(); onOpen(l.id); }}
          >
            <span className="adm-sh-dots" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className={`adm-sh-dot${i < row.touches ? " on" : ""}`} />
              ))}
            </span>
            <span className="adm-sh-touchn">{row.touches}</span>
          </button>
        );
      }

      default:
        return null;
    }
  };

  const activeFacets = Object.keys(facets).filter((k) => facets[k]?.size);
  const chips = useMemo(() => facetChips(facets, { labelFor }), [facets, labelFor]);

  return (
    <div className="adm-db adm-sh">
      {/* ---- the strip above the table ----
          Ryder, 30 Aug 2026, pointing at it: "remove this text".

          WHAT WENT, AND WHERE IT WENT. Two things used to sit on the left of
          this strip and both were duplicates of something already on screen:

          - the row count, which the list tab above already carries ("Everybody
            3663") and the summary card above that states in full;
          - "Contacted? and Touches count the last 90 days", which is a real and
            important fact — those two columns are counted from a WINDOW, not
            from the whole history, and a person worked hard in the spring and
            quiet since reads "Yes, older" here with a full timeline inside.

          That fact is NOT dropped. It moved onto the two column headings it is
          about, as their tooltip, which is where somebody wondering about that
          exact column will look. A window left unsaid is what made those two
          columns look like lifetime facts in the first place.

          The strip still carries everything on its RIGHT — the filter chips,
          Type of business, Filters, Group by and Columns. Only the left-hand
          text is gone. */}
      <div className="adm-sh-bar">
        {/* ---- EVERY FILTER THAT IS ON, AS A REMOVABLE CHIP — Aug 27 2026 ----
            One chip per VALUE, not per column, because a column can hold several
            now: "State: FL" and "State: AL" are two chips and taking one off
            leaves the other. Built by facetChips() in the pure module so the
            chips and the filtering cannot disagree about what is on. */}
        {chips.map((c) => (
          <button
            key={`${c.key}:${c.value}`} type="button" className="adm-sh-chipbtn"
            onClick={() => toggleFacet(c.key, c.value)}
            title={`Take this filter off. ${c.column} can hold more than one value at a time.`}
          >
            {c.column}: {c.label} <span aria-hidden="true">✕</span>
          </button>
        ))}
        {/* Offered only when there is more than one thing to clear. With exactly
            one chip on screen, "Clear all" and pressing that chip are the same
            act, and two controls for one act is one of them being ignored. */}
        {chips.length > 1 ? (
          <button type="button" className="adm-db-link" onClick={clearAllFacets}>
            Clear all
          </button>
        ) : null}

        <span className="adm-sh-spacer" />

        {/* ---- FILTER BY A COLUMN THAT IS NOT ON SCREEN ----
            Every filterable column, whether or not its header is showing. The
            header's own caret does the same job for a visible column; this row
            exists because the columns are switchable, and a filter you can only
            reach from a header is a filter you lose the moment somebody hides
            that column. Tags and the score bands are exactly the two a rep would
            hide and still want to filter on. */}
        <FilterMenuBar
          rows={rows}
          facets={facets}
          labelFor={labelFor}
          onFacet={toggleFacet}
          onClearColumn={dropFacet}
          onClearAll={clearAllFacets}
        />

        <label className="adm-sh-groupsel">
          Group by
          <select
            className="adm-input adm-sl-sel" data-filter="groupby" value={groupBy}
            onChange={(e) => setGroupBy(cleanGroupBy(e.target.value))}
          >
            <option value="none">Nothing — just rows</option>
            {SHEET_COLUMNS.filter((c) => c.groupable).map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </label>

        <button
          type="button" className="btn btn-sm"
          onClick={(e) => setColsOpen(e.currentTarget.getBoundingClientRect())}
        >
          Columns · {visible.length}
        </button>
        {sort ? (
          <button type="button" className="btn btn-sm" onClick={() => setSort(null)}>
            Stop sorting by {columnLabel(sort.key)}
          </button>
        ) : null}
      </div>

      {colsOpen && (
        <Popover anchor={colsOpen} width={250} onClose={() => setColsOpen(null)}>
          <div className="adm-db-pop-filter">
            {/* Both of these CLOSE the menu as well as acting. Leaving it open
                meant the next click anywhere went to dismissing this menu
                instead of to the thing that was clicked — which is how the
                stage cell below it appeared to do nothing. */}
            <button type="button" className="adm-db-pop-item plain"
              onClick={() => { setColsOpen(null); setColumns(DEFAULT_SHEET_COLUMNS); }}>
              Back to the usual columns
            </button>
            <button type="button" className="adm-db-pop-item plain"
              onClick={() => { setColsOpen(null); setColumns(SHEET_COLUMN_KEYS); }}>
              Show every column
            </button>
          </div>
          <div className="adm-db-pop-list" role="menu">
            {SHEET_COLUMNS.map((c) => {
              const on = shownKeys.includes(c.key);
              /* One column has to stay on. A table with no columns is a blank
               * card with a header bar and no way back. */
              const last = on && shownKeys.length === 1;
              /* And on a page you claim from, the Claim button's column stays
               * on too — see `pinned` above. */
              const isPinned = c.key === pinned;
              return (
                <button
                  key={c.key} type="button" role="menuitemcheckbox" aria-checked={on}
                  className={`adm-db-pop-item${on ? " on" : ""}`}
                  disabled={last || isPinned}
                  title={isPinned ? "The Claim button lives in this column, and this page is where leads are claimed. It stays on."
                    : last ? "At least one column has to stay on." : undefined}
                  onClick={() => setColumns((cur) => (
                    cur.includes(c.key) ? cur.filter((k) => k !== c.key)
                      : SHEET_COLUMN_KEYS.filter((k) => cur.includes(k) || k === c.key)
                  ))}
                >
                  <span>{c.label}</span>
                  {on ? <span className="adm-db-check">✓</span> : null}
                </button>
              );
            })}
          </div>
        </Popover>
      )}

      {/* ---- the table ---- */}
      {/* THE TABLE IS THE SCROLLER, NOT THE PAGE — 30 Aug 2026.
          Ryder: "when you scroll down i still need to be able to see the title
          of the row."

          A sticky <th> sticks to its nearest scrolling ancestor. This div has
          always had `overflow-x: auto`, which makes it that ancestor in BOTH
          directions, so a header stuck to the page would have stuck to nothing.
          Bounding its height turns it into a real scroll box: the headers stay
          put, and 3,663 rows no longer push the toolbar off the top of the
          screen every time you look down the list. */}
      <div className="adm-db-scroll adm-sh-scroll">
        <table className="adm-db-table adm-sh-table">
          <colgroup>
            {visible.map((c) => <col key={c.key} style={{ width: c.width }} />)}
            {/* THE LAST COLUMN WAS 46px WIDE AND ITS HEADER SAID 210.
                `table-layout: fixed` reads the COLGROUP and ignores the <th>,
                so the Do column was laid out at 46px and its buttons — Claim,
                Email, ⋯, ⤢ — were cut off the right-hand edge of every row.
                Ryder, 30 Aug 2026: "make sure the rows on the end dont get cut
                off." One number, in two places, disagreeing. */}
            <col style={{ width: DO_COLUMN_WIDTH }} />
          </colgroup>
          <thead>
            <tr>
              {visible.map((c) => (
                <th
                  key={c.key}
                  aria-sort={sort && sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  /* The window that used to be printed above the table. Only
                     the two columns it is actually about carry it. */
                  title={WINDOWED_COLUMNS.includes(c.key)
                    ? `Counted from the last ${activityWindowDays} days of logged activity, not from the whole history. Open a record to read all of it.`
                    : undefined}
                >
                  <SheetHead
                    col={c} rows={rows} groupBy={groupBy} sort={sort}
                    onSort={() => setSort((cur) => nextSort(cur, c.key))}
                    onClearSort={() => setSort(null)}
                    activeValue={facets[c.key]}
                    labelFor={labelFor}
                    onFacet={toggleFacet}
                    onGroupBy={(k) => setGroupBy((cur) => (cur === k ? "none" : k))}
                  />
                </th>
              ))}
              {/* "Do" rather than a blank header. The column holds the row's
                  buttons now, not just the open arrow, and a column of controls
                  with no name is a column people do not look in. */}
              <th style={{ width: DO_COLUMN_WIDTH }}>Do</th>
            </tr>
          </thead>

          {groups.map((g) => {
            const gkey = `${groupBy}:${g.key}`;
            const shut = collapsed.has(gkey);
            const ordered = sortRowsBy(g.rows, sort);
            return (
              <tbody key={g.key}>
                {g.label !== null && (
                  <tr className="adm-db-group">
                    <td colSpan={span}>
                      <button
                        type="button" className="adm-db-arrow" onClick={() => toggleGroup(g.key)}
                        aria-expanded={!shut} aria-label={`${shut ? "Show" : "Hide"} ${g.label}`}
                      >{shut ? "▸" : "▾"}</button>
                      <Chip label={g.label} color="default" />
                      <span className="adm-db-count">{g.rows.length}</span>
                      <button
                        type="button" className="adm-db-link"
                        onClick={() => toggleFacet(groupBy, g.key)}
                        title={facets[groupBy] === g.key ? "Stop filtering to this" : `Show only ${g.label}`}
                      >{facets[groupBy] === g.key ? "✓ Only this" : "Only this"}</button>
                    </td>
                  </tr>
                )}

                {!shut && ordered.map((row) => (
                  <tr
                    key={row.id}
                    /* THE WHOLE ROW OPENS THE PERSON — Ryder, 30 Aug 2026:
                       "a normal row that when you click anything that isnt a
                       tag it opens the client card."

                       It is safe to put on the <tr> because every control left
                       on a row stops the event itself: the chips, the Claim
                       button and the three Do buttons all call
                       stopPropagation, and the reading cells are plain spans
                       with nothing to swallow the click.

                       Not a keyboard control, deliberately: a <tr> cannot hold
                       focus without pretending to be something it is not. The
                       ⤢ button at the end of every row is the keyboard path,
                       and it is in the tab order already. */
                    onClick={() => onOpen(row.id)}
                    title="Open this person's record"
                    /* THREE STATES, READABLE AT A GLANCE. `mine` is an accent
                       edge, `theirs` is dimmed with every control off, and
                       neither means nobody has claimed it. Read off
                       `row.editable`, which sheetRow derived once from
                       canEditLead — not re-derived here. */
                    className={[
                      "adm-db-row", "adm-sh-row", "adm-sh-open",
                      row.lead.owner_id === member.user_id ? "mine" : "",
                      locked(row) ? "theirs" : "",
                      row.gate.skip ? "skip" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    {visible.map((c) => <td key={c.key} className="adm-db-cell">{cell(row, c.key)}</td>)}
                    <td className="adm-db-cell">
                      <RowActions
                        row={row}
                        claimAs={claimAs}
                        claiming={claiming === row.id}
                        onClaim={async () => {
                          if (claiming === row.id) return;
                          setClaiming(row.id);
                          try { await onAssign(row, claimAs); } finally { setClaiming(null); }
                        }}
                        onOpen={() => onOpen(row.id)}
                        onTag={() => onTag?.(row)}
                        onRefreshTags={() => onRefreshTags?.(row)}
                        onLog={(kind) => onLog?.(row, kind)}
                        onScan={() => onScan?.({ lead: row.lead, company: row.company })}
                        onCloseDeal={(kind) => onCloseDeal?.(row, kind)}
                        onRelease={() => onRelease?.(row)}
                      />
                    </td>
                  </tr>
                ))}

                {/* Only inside a GROUP. Flat, an empty table already has the
                    "No rows match" panel below it, and printing both put two
                    different empty-state messages on screen for one condition. */}
                {!shut && ordered.length === 0 && g.label !== null && (
                  <tr className="adm-db-newrow"><td colSpan={span}>Nothing in this group.</td></tr>
                )}
              </tbody>
            );
          })}
        </table>
      </div>

      {shown.length === 0 && (
        <div className="adm-sh-none">
          <strong>No rows match.</strong>{" "}
          {activeFacets.length
            ? <>Take a filter off above{sort ? ", or stop sorting" : ""}.</>
            : <>Clear the filters at the top of the page.</>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** Firm name, how many of its people we hold, and the one-firm-one-rep
 *  warning that used to live on the group header. */
function FirmCell({ row, others, headcount, teamName, filter, onOpen, busy = false, hideNames = false }) {
  const [anchor, setAnchor] = useState(null);
  const name = row.companyName;
  /* ONE MARK, NOT TWO. `others` is the stronger statement and swallows the
   * weaker one where both are true, so a cell never carries two triangles
   * saying the same thing in different words. */
  /* ONE MARK, NOT TWO, and `busy` wins on a rep's page because `others` cannot
   * be true there — see the popover below. */
  const mark = (others && !hideNames) ? "others" : busy ? "busy" : null;
  const hint = mark === "others"
    ? `${others.length} reps are working this firm`
    : mark === "busy" ? FIRM_BUSY_LABEL : undefined;
  return (
    <>
      <button
        type="button" className="adm-db-btn"
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        title={hint}
      >
        {name
          ? <span className="adm-sh-firm">{name}</span>
          : <span className="adm-db-empty">No firm on file</span>}
        {headcount > 1 ? <span className="adm-sh-headn">{headcount}</span> : null}
        {mark ? <span className="adm-sh-warn" aria-hidden="true">⚠</span> : null}
      </button>
      {anchor && (
        <Popover anchor={anchor} width={264} onClose={() => setAnchor(null)}>
          {mark === "busy" ? (
            <div className="adm-sh-pop-warn">
              <strong>{FIRM_BUSY_LABEL}.</strong> {FIRM_BUSY_WHY}
            </div>
          ) : null}
          {/* THIS BRANCH CANNOT FIRE ON A REP'S PAGE and that is by construction,
              not by luck: contestedCompanies needs two different owners in the
              list it is given, and since 30 Aug the sheet hands it the rep's own
              set, which can hold at most one. The ⚠ a rep sees is the `busy`
              block above. Kept, unchanged, for the owner's page, where naming
              the two people is the entire point.

              An earlier draft printed "Their contacts are not on your floor"
              here for a rep. One of the two owners is always the reader, so that
              sentence was false about the row it was on. */}
          {others && !hideNames ? (
            <div className="adm-sh-pop-warn">
              <strong>{others.length} reps are working this firm.</strong>{" "}
              {others.map((id) => teamName(id) || "someone").join(" and ")}. The Rules of
              Engagement say one firm, one rep. Nothing here stops you — it just refuses to
              let it be a surprise.
            </div>
          ) : null}
          {headcount > 1 ? (
            <div className="adm-sh-pop-note">
              We hold {headcount} people at this firm. Group the table by Company to see them
              together.
            </div>
          ) : null}
          <div className="adm-db-pop-filter">
            {filter?.onOnly ? (
              <button type="button" className={`adm-db-pop-item plain${filter.active ? " on" : ""}`}
                onClick={() => { setAnchor(null); filter.onOnly(); }}
              >{filter.active ? "✓ Showing only" : "Show only"} {filter.label}</button>
            ) : null}
            {filter?.onGroup ? (
              <button type="button" className="adm-db-pop-item plain"
                onClick={() => { setAnchor(null); filter.onGroup(); }}
              >Group the table by Company</button>
            ) : null}
            <button type="button" className="adm-db-pop-item plain"
              onClick={() => { setAnchor(null); onOpen(); }}
            >Open this person's record</button>
          </div>
        </Popover>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

/** The title sorts. The caret beside it filters and groups.
 *  Two separate buttons on purpose: one click on the word has to do one
 *  predictable thing. Same shape as the Operations table, so a person who has
 *  learned one has learned the other. */
function SheetHead({ col, rows, groupBy, sort, onSort, onClearSort, activeValue, labelFor, onFacet, onGroupBy }) {
  const [anchor, setAnchor] = useState(null);
  const canFilter = FILTERABLE.has(col.key);
  const canGroup = GROUPABLE.has(col.key);
  /* A COLUMN THAT DECLARES ITSELF UNSORTABLE MUST NOT OFFER TO SORT.
   *
   * This header never read SORTABLE — every column got a sort button — and it
   * went unnoticed because every column in the sheet was sortable until 31 Aug.
   * `draft_email` is the first that is not: it stores nothing, so there is
   * nothing to order by, and clicking its header sorted the whole table by a
   * value that does not exist. A control that does nothing is worse than no
   * control, because the person who pressed it now distrusts the order. */
  const canSort = SORTABLE.has(col.key);
  const sorted = canSort && sort && sort.key === col.key ? sort.dir : null;

  const values = useMemo(() => (canFilter ? facetValues(rows, col.key) : []), [rows, canFilter, col.key]);

  return (
    <span className="adm-db-thwrap">
      {canSort ? (
        <button
          type="button"
          className={`adm-db-th${sorted ? " sorted" : ""}${activeValue !== undefined ? " on" : ""}`}
          onClick={onSort}
          title={sorted === "asc" ? `Sorted by ${col.label} — click for the other way`
            : sorted === "desc" ? `Sorted by ${col.label}, reversed — click to stop sorting`
              : `Sort by ${col.label}`}
        >
          {col.label}
          {activeValue !== undefined ? <span className="adm-db-th-dot" aria-hidden="true">●</span> : null}
          <span className="adm-db-th-arrow" aria-hidden="true">
            {sorted === "asc" ? "↑" : sorted === "desc" ? "↓" : ""}
          </span>
        </button>
      ) : (
        /* Not a button at all. Disabled-looking-but-clickable is the shape that
           teaches people the header is broken; a plain label says the column is
           an action and there is nothing to order. */
        <span className="adm-db-th adm-db-th-plain" title={`${col.label} — an action, so there is nothing to sort by`}>
          {col.label}
        </span>
      )}
      {(canFilter || canGroup) && (
        <button
          type="button"
          className={`adm-db-thmenu${groupBy === col.key || activeValue !== undefined ? " on" : ""}`}
          aria-haspopup="menu" aria-label={`${col.label}: filter or group`}
          title={`${col.label} — filter or group`}
          onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        >▾</button>
      )}
      {anchor && (
        <Popover anchor={anchor} width={258} onClose={() => setAnchor(null)}>
          <div className="adm-db-pop-filter">
            {canGroup ? (
              <button
                type="button" className={`adm-db-pop-item plain${groupBy === col.key ? " on" : ""}`}
                onClick={() => { setAnchor(null); onGroupBy(col.key); }}
              >{groupBy === col.key ? `✓ Grouped by ${col.label} — click to go flat` : `Group the table by ${col.label}`}</button>
            ) : null}
            {activeValue !== undefined ? (
              <button type="button" className="adm-db-pop-item plain"
                onClick={() => { setAnchor(null); onFacet(col.key, activeValue); }}
              >Clear this filter</button>
            ) : null}
            {sorted ? (
              /* onClearSort, not two toggles: two blind toggles cannot drive a
               * three-state cycle, and from the reversed state they land back
               * on the first one — so the button that says "stop" re-sorts. */
              <button type="button" className="adm-db-pop-item plain"
                onClick={() => { setAnchor(null); onClearSort(); }}
              >Stop sorting by {col.label}</button>
            ) : null}
          </div>
          {canFilter && (
            <div className="adm-db-pop-list" role="menu">
              {values.length === 0 ? (
                <div className="adm-db-pop-none">No rows to filter.</div>
              ) : values.map(([v, n]) => (
                <button
                  key={v} type="button" role="menuitem"
                  className={`adm-db-pop-item${activeValue === v ? " on" : ""}`}
                  onClick={() => { setAnchor(null); onFacet(col.key, v); }}
                >
                  <span>{labelFor(col.key, v)}</span>
                  <span className="adm-db-count">{n}</span>
                </button>
              ))}
            </div>
          )}
        </Popover>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */

/** Notion-ish colours for the twelve stages, so a status reads at a glance. */
const STAGE_COLOR = {
  new: "default",
  researching: "gray",
  contacted: "blue",
  in_conversation: "blue",
  follow_up: "yellow",
  meeting: "purple",
  proposal: "orange",
  won: "green",
  lost: "red",
  reopened: "yellow",
  skip_90: "gray",
  bad_contact: "red",
};

/** Last-resort label for a firm id that is not on any row currently shown —
 *  a filter menu can offer a firm none of the visible rows belong to.
 *
 *  It falls back to `lead.company`, the firm name COPIED DOWN by the
 *  spreadsheet, which is exactly the stale text the firm record exists to
 *  replace. That is acceptable only here, where the alternative is a menu entry
 *  reading "Unknown firm", and it can never reach a row: every row on screen
 *  reads its name off the firm record via sheetRow(). */
function allRowFor(allLeads, companyId) {
  const l = (allLeads || []).find((x) => x.company_id === companyId);
  return l ? { companyName: l.company || null, company: l.company || null } : null;
}

/* ------------------------------------------------------------------ */

/**
 * ONE PILL PER FILTERABLE COLUMN, whether or not that column is on screen.
 *
 * The header's own caret already filters a VISIBLE column. This row exists
 * because the columns are switchable: hide Tags and, without this, the tag
 * filter goes with it — and Tags and the score bands are exactly the two
 * somebody would hide to make room and still want to filter on.
 *
 * A pill lights up when its column has anything on, and carries how many values
 * that is, so "State · 2" is readable without opening it.
 *
 * THE MENU IS BUILT FROM THE UNFILTERED ROWS, like every other menu in this
 * table. Built from what is on screen, one filter shrinks every other column's
 * options to the values that survived it and a value outside the current filter
 * cannot be reached at all. That was a real shipped bug on the Operations table,
 * and facetValues() carries the same warning.
 */
/* THE ONE COLUMN THAT STAYS OUT ON THE BAR.
 *
 * Ryder, 30 Aug 2026: "its important to be abel to filter by type of business,
 * and the pipeline is basically where you can filter them by stage." So Type of
 * business keeps its own button and everything else moves behind Filters —
 * including stage, which has a whole view of its own for exactly that job.
 *
 * A list rather than a single value because the next one he names should be a
 * one-word change, not a refactor. */
const PINNED_FILTERS = ["vertical"];

/**
 * EVERY FILTER, BEHIND ONE BUTTON.
 *
 * There were fourteen of these across two rows above the table, permanently, on
 * a page whose job is the table. Ryder, 30 Aug 2026: "everything seems really
 * complex and jumbled, i want to simplify it all."
 *
 * Nothing is removed. The button says how many filters are on, the panel lists
 * every column with its own count, and picking one shows that column's values.
 *
 * ONE POPOVER, TWO LEVELS — not a popover opened from inside another popover.
 * That nesting is what made the cell menus close themselves the instant they
 * opened back in August: the outer one closes on any outside click, and the
 * inner one's own button is an outside click. So the panel swaps its contents
 * instead, with a Back that returns to the column list.
 */
function FilterMenuBar({ rows, facets, labelFor, onFacet, onClearColumn, onClearAll }) {
  const [open, setOpen] = useState(null);       // the anchor rect, or null
  const [column, setColumn] = useState(null);   // which column the panel is showing
  const cols = SHEET_COLUMNS.filter((c) => c.filterable);
  const pinned = cols.filter((c) => PINNED_FILTERS.includes(c.key));
  const rest = cols.filter((c) => !PINNED_FILTERS.includes(c.key));

  /* How many COLUMNS are filtered, not how many values. "Filters · 2" over two
   * columns holding four values between them is the number a person is
   * actually asking for — how many things are narrowing this list. */
  const onCount = cols.filter((c) => facets[c.key]?.size).length;

  const close = () => { setOpen(null); setColumn(null); };

  /* One column's values. Shared by the pinned buttons and the panel, so a
   * column cannot behave one way on the bar and another inside the menu. */
  const valueList = (key) => {
    const values = facetValues(rows, key);
    if (!values.length) return <div className="adm-db-pop-none">No rows to filter.</div>;
    /* Capped, and the cap SAYS SO. A city column on the real sheet has hundreds
     * of values, and a menu that quietly stops at forty reads as a list of
     * every city we hold. */
    const CAP = 40;
    return (
      <>
        {values.slice(0, CAP).map(([v, n]) => {
          const ticked = Boolean(facets[key]?.has(v));
          return (
            <button
              key={v} type="button" role="menuitemcheckbox" aria-checked={ticked}
              className={`adm-db-pop-item${ticked ? " on" : ""}`}
              /* The menu STAYS OPEN, unlike the header's single-value one.
               * Picking three states means three clicks, and closing after each
               * would mean re-opening twice. */
              onClick={() => onFacet(key, v)}
            >
              <span>{ticked ? "✓ " : ""}{labelFor(key, v)}</span>
              <span className="adm-db-count">{n}</span>
            </button>
          );
        })}
        {values.length > CAP ? (
          <div className="adm-db-pop-none">
            Showing the {CAP} commonest of {values.length}. Search above the table to reach
            the rest.
          </div>
        ) : null}
      </>
    );
  };

  const shownCol = column ? cols.find((c) => c.key === column) : null;

  return (
    <>
      {/* ---- the columns that stay out ---- */}
      {pinned.map((c) => {
        const on = facets[c.key]?.size || 0;
        return (
          <button
            key={c.key} type="button"
            className={on ? "adm-sh-chipbtn" : "btn btn-sm"}
            aria-haspopup="menu"
            title={on
              ? `${c.label}: ${on} value${on === 1 ? "" : "s"} on. Click to change.`
              : `Filter by ${c.label}. More than one value at a time is allowed.`}
            onClick={(e) => {
              setColumn(c.key);
              setOpen(e.currentTarget.getBoundingClientRect());
            }}
          >
            {c.label}{on ? ` · ${on}` : ""} <span aria-hidden="true">▾</span>
          </button>
        );
      })}

      {/* ---- and everything else, behind one ---- */}
      <button
        type="button"
        className={onCount ? "adm-sh-chipbtn" : "btn btn-sm"}
        aria-haspopup="menu"
        title={onCount
          ? `${onCount} column${onCount === 1 ? " is" : "s are"} filtering this list. Click to change or clear.`
          : "Filter by any column — Sales Owner, Contacted?, Status, Claim, Last Touch, Tags, Company, City, State, Company size, Site Score, Website or List."}
        onClick={(e) => {
          setColumn(null);
          setOpen(e.currentTarget.getBoundingClientRect());
        }}
      >
        Filters{onCount ? ` · ${onCount}` : ""} <span aria-hidden="true">▾</span>
      </button>

      {/* A value list needs a little more room than a column list — it just
          stops the longest city names wrapping onto three lines. */}
      {open && (
        <Popover anchor={open} width={shownCol ? 266 : 250} onClose={close}>
          {shownCol ? (
            <>
              <div className="adm-db-pop-filter">
                {/* Back, not a second popover. See the note on the component. */}
                {PINNED_FILTERS.includes(shownCol.key) ? null : (
                  <button
                    type="button" className="adm-db-pop-item plain"
                    onClick={() => setColumn(null)}
                  >
                    ‹ All filters
                  </button>
                )}
                <div style={{ padding: "6px 10px", fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.45 }}>
                  <strong>{shownCol.label}</strong> — tick as many as you like. Inside one column
                  they are <strong>or</strong>; across columns they are <strong>and</strong>.
                </div>
                {facets[shownCol.key]?.size ? (
                  <button
                    type="button" className="adm-db-pop-item plain"
                    onClick={() => { onClearColumn(shownCol.key); setColumn(null); }}
                  >
                    Clear this column
                  </button>
                ) : null}
              </div>
              <div className="adm-db-pop-list" role="menu">{valueList(shownCol.key)}</div>
            </>
          ) : (
            <>
              <div className="adm-db-pop-filter">
                <div style={{ padding: "6px 10px", fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.45 }}>
                  Pick a column to filter by. A number beside one means it is already
                  narrowing this list.
                </div>
                {onCount ? (
                  <button
                    type="button" className="adm-db-pop-item plain"
                    onClick={() => { onClearAll(); close(); }}
                  >
                    Clear all {onCount} filter{onCount === 1 ? "" : "s"}
                  </button>
                ) : null}
              </div>
              <div className="adm-db-pop-list" role="menu">
                {rest.map((c) => {
                  const on = facets[c.key]?.size || 0;
                  return (
                    <button
                      key={c.key} type="button" role="menuitem"
                      className={`adm-db-pop-item${on ? " on" : ""}`}
                      onClick={() => setColumn(c.key)}
                    >
                      <span>{c.label}</span>
                      <span className="adm-db-count">{on ? `${on} on` : "›"}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </Popover>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

/**
 * THE ROW'S BUTTONS. Small, one line, always in the same order.
 *
 * ONE PRIMARY BUTTON AND A MENU, rather than eleven buttons in a cell. Eleven
 * would either shrink the row to nothing or wrap onto three lines on the one
 * column a rep reads while somebody is on the phone. So the primary is whatever
 * this row most obviously needs next — Claim on a free row, Email on your own —
 * and the rest are behind "⋯", in the order the build spec lists them:
 *
 *   Claim · Email · Call · Text · Scan site (or Build mockup pitch) ·
 *   Log a touch · Note · Tag · Stage · Release · Open
 *
 * A BUTTON THAT DOES NOT APPLY IS NOT DRAWN, rather than drawn dead — with one
 * exception, Text, which is drawn disabled WITH ITS REASON on it, because the
 * one-text rule is a rule a rep needs to be told rather than a button that
 * quietly is not there. A greyed control with no reason reads as a broken
 * control, and then people stop trusting the whole page.
 *
 * NOTHING IN HERE WRITES. Every entry calls one function that the page passed
 * down, and each of those functions does the write, the timeline line and the tag
 * event together. Four buttons that each did their own version of one act had
 * four behaviours, and one of them permanently blocked the only one that worked.
 */
function RowActions({
  row, claimAs, claiming,
  onClaim, onOpen, onTag, onRefreshTags, onLog, onScan, onCloseDeal, onRelease,
}) {
  const [anchor, setAnchor] = useState(null);
  const l = row.lead;
  const editable = row.editable;
  const free = !l.owner_id;
  const noWebsite = !row.domain;
  /* The one-text rule, read from the one function that decides it. Not
   * re-implemented here: textGate lives in lib/sales-rules.js because the page,
   * the drawer and the database function all have to agree about it. */
  const text = textGate(l);

  const item = (label, fn, { title, disabled } = {}) => (
    <button
      key={label}
      type="button"
      className="adm-db-pop-item plain"
      disabled={Boolean(disabled)}
      title={title}
      onClick={() => { setAnchor(null); fn(); }}
    >
      {label}
    </button>
  );

  return (
    <span className="adm-sh-do">
      {/* ---- the lock, said out loud on the row itself ---- */}
      {!editable && (
        <span className="adm-sh-held" title="You can read this record. Only the person holding it, or an owner, can change it.">
          🔒 {row.heldBy}
        </span>
      )}

      {/* ---- the primary ---- */}
      {editable && free && claimAs ? (
        <button
          type="button" className="btn btn-sm btn-accent"
          disabled={claiming} aria-busy={claiming}
          title="Take this lead. First contact is then on the clock."
          onClick={(e) => { e.stopPropagation(); onClaim(); }}
        >
          {claiming ? "Claiming…" : "Claim"}
        </button>
      ) : editable ? (
        <button
          type="button" className="btn btn-sm"
          title={l.email ? "Log the email you send, so the timers and the cadence move." : "No email address on this contact."}
          disabled={!l.email}
          onClick={(e) => { e.stopPropagation(); onLog("email"); }}
        >
          Email
        </button>
      ) : null}

      {/* ---- everything else ---- */}
      <button
        type="button" className="btn btn-sm"
        aria-haspopup="menu" aria-label="What you can do with this contact"
        title="Everything you can do with this contact"
        onClick={(e) => { e.stopPropagation(); setAnchor(e.currentTarget.getBoundingClientRect()); }}
      >
        ⋯
      </button>

      <button
        type="button" className="adm-db-open"
        title="Open this person's whole record"
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
      >⤢</button>

      {anchor && (
        <Popover anchor={anchor} width={252} onClose={() => setAnchor(null)}>
          <div className="adm-db-pop-filter">
            {!editable ? (
              <div style={{ padding: "8px 10px", fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.5 }}>
                <strong>{row.heldBy}.</strong> You can open this record and read everything on it —
                the notes, the timeline, the scan. Nothing here can change it.
              </div>
            ) : null}

            {editable && free && claimAs ? item("Claim", onClaim, { title: "Take this lead." }) : null}

            {editable ? item("Log an email", () => onLog("email"), {
              disabled: !l.email,
              title: l.email ? "Log the email you sent." : "No email address on this contact.",
            }) : null}

            {editable ? item("Log a call", () => onLog("call"), {
              disabled: !l.phone,
              title: l.phone ? `Call ${l.phone} and log how it went.` : "No phone number on this contact.",
            }) : null}

            {/* DRAWN DISABLED WITH THE REASON, on purpose — see the note above
                this component. One text per lead, and only after they reply. */}
            {editable ? item("Log a text", () => onLog("text"), {
              disabled: !text.allowed,
              title: text.reason,
            }) : null}

            {editable ? item(noWebsite ? "Build a mockup pitch" : "Scan their site", onScan, {
              title: noWebsite
                ? "No website on file, so there is nothing to scan — this is the other pitch."
                : "Read the last scan, or run a new one.",
            }) : null}

            {editable ? item("Log a LinkedIn touch", () => onLog("linkedin"), {
              disabled: !l.linkedin_url,
              title: l.linkedin_url ? "Log the connection or the message." : "No LinkedIn on this contact.",
            }) : null}

            {editable ? item("Add a note", () => onLog("note"), {
              title: "Dated, signed, and it can never be edited away.",
            }) : null}

            {item(editable ? "Tags" : "See the tags", onTag, {
              title: editable ? "Add or remove a tag. Every change is dated." : "Read the tags and their history.",
            })}

            {editable ? item("Bring the automatic tags up to date", onRefreshTags, {
              title: "Works out the website, size, score, quiet and claim tags from the record as it stands now.",
            }) : null}

            {editable ? item("Mark it won", () => onCloseDeal("won"), {
              title: "You will be asked why. It will not save empty.",
            }) : null}

            {editable ? item("Mark it lost", () => onCloseDeal("lost"), {
              title: "You will be asked why. It will not save empty.",
            }) : null}

            {editable && !free ? item("Hand it back to the floor", onRelease, {
              title: "Anybody can claim it after that. A dated line says you handed it back.",
            }) : null}

            {item("Open the whole record", onOpen, {
              title: "Timeline, notes, the firm, the proposals and the scan.",
            })}
          </div>
        </Popover>
      )}
    </span>
  );
}
