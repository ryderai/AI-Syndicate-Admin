import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SHEET_COLUMNS, DEFAULT_SHEET_COLUMNS, SHEET_COLUMN_KEYS,
  FILTERABLE, GROUPABLE,
  CLAIM_LABELS, CLAIM_COLOR,
  columnLabel, facetValue, facetValues, groupRows,
  nameParts, joinName, splitName, nextSort, sortRowsBy,
  contestedCompanies, companyHeadcount, sheetDate, sheetDateLong,
} from "../../lib/salesSheet.js";
import { LEAD_STAGES, LEAD_STAGE_LABELS } from "../../lib/data.js";
import {
  Chip, Avatar, Popover, PersonCell, SelectCell, TextCell, PopoutCell,
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
function cleanGroupBy(v) {
  return typeof v === "string" && (v === "none" || GROUPABLE.has(v)) ? v : "none";
}

export default function SalesSheet({
  rows, allLeads, member, team, lists,
  onPatch, onAssign, onOpen, onRunScore, teamName, activityWindowDays = 90,
  /* WHO IS CLAIMING. A user id turns the Sales Owner cell of an UNCLAIMED row
   * into a one-press Claim button. Aug 26 2026, Ryder: the rep's Leads page is
   * the floor, and "put your name in the Sales Owner column" is not a claim
   * button — it is a dropdown you have to find, on a page whose whole job is
   * taking a lead. Null (the owner's Sales page) keeps the dropdown everywhere,
   * because assigning somebody else's lead is a real thing an owner does. */
  claimAs = null,
}) {
  const [columns, setColumns] = useState(() => cleanColumns(loadPrefs().columns) || DEFAULT_SHEET_COLUMNS);
  const [groupBy, setGroupBy] = useState(() => cleanGroupBy(loadPrefs().groupBy));
  /* A sort is something you do for a minute, so unlike columns and grouping it
   * is deliberately NOT remembered between visits. */
  const [sort, setSort] = useState(null);
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

  useEffect(() => { savePrefs({ columns, groupBy }); }, [columns, groupBy]);

  const contested = useMemo(() => contestedCompanies(allLeads), [allLeads]);
  const headcount = useMemo(() => companyHeadcount(allLeads), [allLeads]);

  /* The header menus are built from `rows` — the page's filtered set BEFORE
   * this table's own column filters. Built from what is on screen instead, one
   * filter shrinks every other column's menu to the values that survived it,
   * and a value outside the current filter cannot be reached from a header at
   * all. That was a real bug in the Operations table. */
  const shown = useMemo(() => {
    const keys = Object.keys(facets);
    if (!keys.length) return rows;
    return rows.filter((r) => keys.every((k) => facetValue(r, k) === facets[k]));
  }, [rows, facets]);

  const labelFor = useCallback((key, value) => {
    if (value === "__none" || value === null || value === undefined || value === "") {
      return key === "owner" ? "On the floor"
        : key === "company" ? "No firm on file"
          : key === "list" ? "In no list"
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
  const span = visible.length + 1;

  const toggleFacet = (key, value) => {
    setFacets((cur) => {
      const next = { ...cur };
      if (next[key] === value) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const toggleGroup = (key) => setCollapsed((cur) => {
    const n = new Set(cur);
    const k = `${groupBy}:${key}`;
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  const personOptions = useMemo(
    () => team.filter((m) => m.active !== false).map((m) => ({ value: m.user_id, label: m.full_name || m.email })),
    [team],
  );
  /* Deactivating somebody does not hand their leads back. If the owner is no
   * longer pickable, show them anyway and mark them — rendering the cell as
   * "on the floor" would be the table lying about whose lead it is. */
  const personOptionsFor = (row) => {
    const id = row.lead.owner_id;
    if (!id || personOptions.some((o) => o.value === id)) return personOptions;
    return [...personOptions, { value: id, label: `${teamName(id) || "Former member"} · inactive` }];
  };

  const stageOptions = LEAD_STAGES.map((s) => ({ value: s, label: LEAD_STAGE_LABELS[s], color: STAGE_COLOR[s] || "default" }));
  const listOptions = lists.map((l) => ({ value: l.id, label: l.name, color: "default" }));

  const filterFor = (key, row) => {
    if (!FILTERABLE.has(key) && !GROUPABLE.has(key)) return null;
    const v = facetValue(row, key);
    return {
      label: labelFor(key, v),
      column: columnLabel(key),
      active: facets[key] === v,
      onOnly: FILTERABLE.has(key) ? () => toggleFacet(key, v) : null,
      onGroup: GROUPABLE.has(key) ? () => setGroupBy((cur) => (cur === key ? "none" : key)) : null,
    };
  };

  const runScore = async (row) => {
    if (!onRunScore) return;
    setScoring(row.id);
    try { await onRunScore(row); } finally { setScoring(null); }
  };

  /* ---- one cell ---- */
  const cell = (row, key) => {
    const l = row.lead;
    switch (key) {
      case "owner":
        /* One press, and it goes through the SAME onAssign path the dropdown
         * uses — so the claim, the cadence clock and the toast cannot behave
         * differently depending on which control you touched. */
        if (claimAs && !l.owner_id) {
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
                 * sees, and this is the one a second event already in the
                 * queue meets. */
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
        return (
          <PersonCell
            value={l.owner_id}
            options={personOptionsFor(row)}
            onChange={(v) => onAssign(row, v)}
            filter={filterFor("owner", row)}
          />
        );

      case "contacted": {
        /* READ-ONLY ON PURPOSE. In the sheet this is a dropdown that says the
         * same thing as Sales Cycle Status, reps fill one or the other, and
         * neither can be trusted. Here it is counted off the timeline, so it
         * can never disagree with anything. */
        const c = row.contacted;
        return (
          <button
            type="button" className="adm-db-btn adm-sh-readonly"
            title={c.why}
            onClick={(e) => { e.stopPropagation(); onOpen(l.id); }}
          >
            <Chip label={c.short} color={c.color} />
          </button>
        );
      }

      case "stage":
        return (
          <SelectCell
            label="Sales cycle status" value={l.stage} options={stageOptions} clearable={false}
            onChange={(v) => onPatch(l, { stage: v })}
            filter={filterFor("stage", row)}
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
        return (
          <PopoutCell
            value={l.next_step} placeholder="Add the next step…"
            title={`Next steps — ${l.name || row.companyName || "this contact"}`}
            hint="What happens next, and when. This is what your day is built from."
            onChange={(v) => onPatch(l, { next_step: v })}
          />
        );

      case "first_name":
      case "last_name": {
        const parts = nameParts(l);
        const mine = key === "first_name" ? parts.first : parts.last;
        return (
          <TextCell
            value={mine || ""}
            placeholder="Empty"
            title={parts.derived
              ? `Split from the full name on file: "${l.name || ""}". Correcting this half does NOT change that full name — switch on the Full Name column to edit it.`
              : undefined}
            onChange={(v) => {
              const first = (key === "first_name" ? (v || "") : parts.first).trim();
              const last = (key === "last_name" ? (v || "") : parts.last).trim();
              const joined = joinName(first, last);

              /* THE ORIGINAL FULL NAME IS NEVER OVERWRITTEN BY A GUESS.
               *
               * On a row whose halves were SPLIT from the full name (nobody has
               * ever typed them), the other half on screen is a guess. Writing
               * `name` from edited-half + guessed-half turned "Mary Jo Van Der
               * Berg" into "Mary Jo Jo Van Der Berg" the moment somebody
               * corrected the first name — and destroyed the only copy of what
               * we were actually given. Found by a reviewer.
               *
               * So on a derived row both halves are STORED (the guess becomes a
               * real value a person can now see and fix) and `name` is left
               * exactly as it was. Once the halves are real, editing either one
               * rewrites the display name as you would expect.
               *
               * `name` is also never set to null: a contact with no name at all
               * renders as "unnamed" on every screen including My Day. */
              onPatch(l, {
                first_name: first || null,
                last_name: last || null,
                ...(!parts.derived && joined ? { name: joined } : {}),
              });
            }}
          />
        );
      }

      case "full_name":
        return (
          <TextCell
            value={l.name} placeholder="No name on file"
            /* Writing the full name is also the moment the two halves stop
               being a guess, so they are cleared and re-split from what was
               just typed. Leaving a stale guessed half next to a corrected
               full name is how the two disagree in the first place. */
            onChange={(v) => {
              const parts = splitName(v || "");
              onPatch(l, {
                name: (v || "").trim() || null,
                first_name: parts.first || null,
                last_name: parts.last || null,
              });
            }}
          />
        );

      case "title":
        return <TextCell value={l.title} onChange={(v) => onPatch(l, { title: v })} />;
      case "email":
        return <TextCell value={l.email} onChange={(v) => onPatch(l, { email: v })} />;
      case "phone":
        return <TextCell value={l.phone} onChange={(v) => onPatch(l, { phone: v })} />;
      case "city":
        return <TextCell value={l.city} onChange={(v) => onPatch(l, { city: v })} />;
      case "state":
        return <TextCell value={l.state} onChange={(v) => onPatch(l, { state: v })} />;

      case "company": {
        /* The firm-level warning the grouped table used to carry. It is on the
         * ROW now, because a flat table has nowhere else to put it. */
        const others = l.company_id ? contested.get(l.company_id) : null;
        const n = l.company_id ? headcount.get(l.company_id) || 1 : 1;
        return (
          <FirmCell
            row={row} others={others} headcount={n} teamName={teamName}
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
        return (
          <SelectCell
            label="List" value={l.list_id} options={listOptions} placeholder="In no list"
            onChange={(v) => onPatch(l, { list_id: v })}
            filter={filterFor("list", row)}
          />
        );

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

  const activeFacets = Object.keys(facets);

  return (
    <div className="adm-db adm-sh">
      {/* ---- the strip above the table ---- */}
      <div className="adm-sh-bar">
        <span className="adm-sh-count">
          {shown.length === rows.length
            ? `${rows.length} ${rows.length === 1 ? "person" : "people"}`
            : `${shown.length} of ${rows.length} shown`}
        </span>
        {/* SAID OUT LOUD, because two columns are counted from it. "Contacted?"
            and "Touches" are read from the last N days of activity, not from
            the whole history — a person worked hard in the spring and quiet
            since shows "Yes, older" here and a full timeline inside. Leaving
            the window unsaid is what made those two columns look like lifetime
            facts. */}
        <span className="adm-sh-window" title="Contacted? and Touches are counted from this window. Open a record to read its whole history.">
          Contacted? and Touches count the last {activityWindowDays} days
        </span>

        {activeFacets.map((k) => (
          <button
            key={k} type="button" className="adm-sh-chipbtn"
            onClick={() => toggleFacet(k, facets[k])}
            title="Click to take this filter off"
          >
            {columnLabel(k)}: {labelFor(k, facets[k])} <span aria-hidden="true">✕</span>
          </button>
        ))}

        <span className="adm-sh-spacer" />

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
      <div className="adm-db-scroll">
        <table className="adm-db-table adm-sh-table">
          <colgroup>
            {visible.map((c) => <col key={c.key} style={{ width: c.width }} />)}
            <col style={{ width: 46 }} />
          </colgroup>
          <thead>
            <tr>
              {visible.map((c) => (
                <th
                  key={c.key}
                  aria-sort={sort && sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
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
              <th><span className="adm-db-sr">Open</span></th>
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
                    className={`adm-db-row adm-sh-row${row.lead.owner_id === member.user_id ? " mine" : ""}${row.gate.skip ? " skip" : ""}`}
                  >
                    {visible.map((c) => <td key={c.key} className="adm-db-cell">{cell(row, c.key)}</td>)}
                    <td className="adm-db-cell">
                      <button
                        type="button" className="adm-db-open"
                        title="Open this person's whole record"
                        onClick={() => onOpen(row.id)}
                      >⤢</button>
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
function FirmCell({ row, others, headcount, teamName, filter, onOpen }) {
  const [anchor, setAnchor] = useState(null);
  const name = row.companyName;
  return (
    <>
      <button
        type="button" className="adm-db-btn"
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        title={others ? `${others.length} reps are working this firm` : undefined}
      >
        {name
          ? <span className="adm-sh-firm">{name}</span>
          : <span className="adm-db-empty">No firm on file</span>}
        {headcount > 1 ? <span className="adm-sh-headn">{headcount}</span> : null}
        {others ? <span className="adm-sh-warn" aria-hidden="true">⚠</span> : null}
      </button>
      {anchor && (
        <Popover anchor={anchor} width={264} onClose={() => setAnchor(null)}>
          {others ? (
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
  const sorted = sort && sort.key === col.key ? sort.dir : null;

  const values = useMemo(() => (canFilter ? facetValues(rows, col.key) : []), [rows, canFilter, col.key]);

  return (
    <span className="adm-db-thwrap">
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
