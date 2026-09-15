import { BasisBadge, pct } from "./financeParts.jsx";
import { PAGE_LABELS } from "../../../lib/home-services.js";

/* Building blocks for the Home Services page. 14 Sep 2026.
 *
 * The rule this whole page runs on, inherited from Finance and AI Cost: a
 * figure that cannot be worked out honestly is printed as a gap with the
 * reason attached, never as a zero. On this page the gap has a specific and
 * common cause — a percentage whose denominator is nobody — and `Pct` below is
 * the one place that is turned into something a person can read.
 */

/* ------------------------------------------------------------------ */
/* A percentage, or an honest blank                                    */
/* ------------------------------------------------------------------ */

/** Renders a percentage, or an em dash carrying the reason it is missing.
 *
 * A null here is never "0%". It means the bottom of the fraction was zero:
 * nobody visited, so nothing can have converted. Printing 0% would answer a
 * question nobody could have asked — and 0% reads as "this page is failing"
 * when the truth is "this page has had no visitors".
 */
export function Pct({ value, digits = 1, why = "Nothing to work this out from yet — no visits in this range." }) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span className="adm-hs-blank" title={why}>—</span>;
  }
  return <span>{pct(value, digits)}</span>;
}

/** A whole number, right-aligned wherever it is used. Zero is a real answer
 * here — it is a count of rows that exist — so unlike Pct it prints. */
export function Num({ value }) {
  const n = Number(value);
  return <span>{Number.isFinite(n) ? n.toLocaleString("en-US") : "—"}</span>;
}

/* ------------------------------------------------------------------ */
/* A column heading you can click                                      */
/* ------------------------------------------------------------------ */

/** One sortable heading.
 *
 * It is a real <button> inside the <th>, not an onClick on the cell. A cell
 * with a click handler cannot be reached by keyboard and is announced as a
 * heading rather than a control — the same mistake Operations made and fixed
 * on Aug 23 2026, written down here so the third table does not make it again.
 */
export function SortHeader({ id, label, sort, onSort, numeric = false, title = null }) {
  const active = sort?.key === id;
  const dir = active ? sort.dir : null;
  return (
    <th className={numeric ? "n" : ""} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className={`adm-hs-sort${active ? " active" : ""}`}
        onClick={() => onSort(id)}
        title={title || `Sort by ${label.toLowerCase()}`}
      >
        {label}
        <span className="adm-hs-caret" aria-hidden="true">{active ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

/* ------------------------------------------------------------------ */
/* The date range                                                      */
/* ------------------------------------------------------------------ */

/* PLAIN STRINGS, NEVER Date OBJECTS. `<input type="date">` gives and takes
 * "YYYY-MM-DD" and that is exactly what the maths in lib/home-services.js
 * wants. Turning it into a Date here would put it in UTC, which is the evening
 * of the day before in Chicago — the trap this console has hit three times
 * already (lib/sales-rules.js has the long note). */
export function RangePicker({ from, to, onChange, presets = [], activePreset = null }) {
  return (
    <div className="adm-hs-range">
      <div className="adm-hs-presets" role="group" aria-label="Quick ranges">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            className={activePreset === p.id ? "active" : ""}
            onClick={() => onChange({ from: p.from, to: p.to, preset: p.id })}
          >
            {p.label}
          </button>
        ))}
      </div>
      <label className="adm-hs-date">
        From
        <input type="date" value={from} max={to} onChange={(e) => onChange({ from: e.target.value, to, preset: null })} />
      </label>
      <label className="adm-hs-date">
        To
        <input type="date" value={to} min={from} onChange={(e) => onChange({ from, to: e.target.value, preset: null })} />
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The funnel                                                          */
/* ------------------------------------------------------------------ */

/** One page's funnel: six steps, the share of visitors still there at each,
 * and what was lost on the way.
 *
 * COUNTED IN VISITS, NOT EVENTS — see funnelFor() in lib/home-services.js for
 * why that distinction changes the numbers. The bar is drawn against the FIRST
 * step, so its length is "share of everyone who landed", which is the only
 * reading that makes six bars comparable to each other.
 */
export function Funnel({ slug, steps }) {
  const top = steps?.[0]?.sessions || 0;
  return (
    <div className="adm-hs-funnel">
      <div className="adm-hs-funnel-head">
        <strong>{PAGE_LABELS[slug] || slug}</strong>
        <BasisBadge basis="counted" hint="Each step counts VISITS that reached it, not clicks — one person who scrolls up and back down is one visit, not two." />
      </div>
      {!top ? (
        <p className="adm-hs-note">
          Nobody has landed on this page in this range, so there is no funnel to draw.
          This is not a zero conversion rate — it is no visitors at all.
        </p>
      ) : (
        <ol className="adm-hs-funnel-steps">
          {steps.map((s, i) => (
            <li key={s.event}>
              <div className="adm-hs-funnel-row">
                <span className="adm-hs-funnel-label">{s.label}</span>
                <span className="adm-hs-funnel-n"><Num value={s.sessions} /></span>
                <span className="adm-hs-funnel-pct"><Pct value={s.ofTop} digits={0} why="Nobody landed on this page, so there is no share to work out." /></span>
              </div>
              <div className="adm-hs-funnel-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(0, Math.min(100, s.ofTop ?? 0))}%` }} />
              </div>
              {i > 0 && (
                <div className="adm-hs-funnel-drop">
                  {s.drop === null
                    ? <span className="adm-hs-blank" title="The step before this one had nobody in it, so nothing can have been lost between them.">drop-off not measured</span>
                    : <>lost <strong>{pct(s.drop, 0)}</strong> of the step before</>}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
