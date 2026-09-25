import { useMemo, useState } from "react";
import { PRESETS, presetRange, rangeLabel, normalizeRange, monthName } from "../../../lib/money-range.js";

/* Pieces the Finance and AI Cost pages share — 24 Sep 2026.
 *
 * The rule for everything in here: the important number is big, the reason
 * for it is one short line under it, and nothing else competes. Ryder: "make
 * it all simpler and make the important stuff stand out."
 *
 * Colours were run through the dataviz validator (light surface): platform
 * indigo #6366f1, agency teal #0d9488, money out #d9544a — all checks pass,
 * worst colour-blind separation 11.1. Every coloured mark also has a text
 * label beside it, so nothing is told by colour alone. */

export const C_PLATFORM = "#6366f1";
export const C_AGENCY = "#0d9488";
export const C_OUT = "#d9544a";
export const C_KEPT = "#0a2245";

export function usd(cents, { cents: showCents = false } = {}) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return "—";
  const v = cents / 100;
  const abs = Math.abs(v);
  const s = abs.toLocaleString("en-US", {
    minimumFractionDigits: showCents || (abs < 100 && abs % 1) ? 2 : 0,
    maximumFractionDigits: showCents || abs < 100 ? 2 : 0,
  });
  return `${v < 0 ? "−" : ""}$${s}`;
}

export function usdMicros(micros) {
  if (micros === null || micros === undefined) return "—";
  const v = micros / 1_000_000;
  if (v > 0 && v < 0.01) return "<$0.01";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pctText(f, digits = 0) {
  if (f === null || f === undefined || !Number.isFinite(f)) return "—";
  return `${(f * 100).toFixed(digits)}%`;
}

/* ------------------------------------------------------------------ */
/* The date range: presets in one row, "Custom" opens two date boxes.   */
/* ------------------------------------------------------------------ */

export function RangePicker({ range, preset, onChange, today, earliest }) {
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const pick = (id) => {
    setCustom(false);
    onChange(presetRange(id, today, { earliest }), id);
  };
  const apply = () => {
    const r = normalizeRange({ from, to }, today);
    setFrom(r.from); setTo(r.to);
    onChange(r, "custom");
  };
  return (
    <div className="mny-range">
      <div className="mny-range-row" role="group" aria-label="Time period">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`mny-chip${preset === p.id ? " on" : ""}`}
            aria-pressed={preset === p.id}
            onClick={() => pick(p.id)}
          >{p.label}</button>
        ))}
        <button
          type="button"
          className={`mny-chip${preset === "custom" || custom ? " on" : ""}`}
          aria-pressed={preset === "custom"}
          onClick={() => { setCustom((c) => !c); setFrom(range.from); setTo(range.to); }}
        >Custom…</button>
      </div>
      {custom && (
        <div className="mny-custom">
          <label>From <input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To <input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} /></label>
          <button type="button" className="btn btn-primary mny-apply" onClick={apply}>Show</button>
        </div>
      )}
      <div className="mny-range-label">
        Showing <strong>{rangeLabel(range)}</strong>
        {range.to === today && <span className="mny-muted"> · through today</span>}
      </div>
    </div>
  );
}

/* A switch: All / Platform / Agency. */
export function Tabs({ value, onChange, options, label }) {
  return (
    <div className="mny-tabs" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          className={`mny-tab${value === o.id ? " on" : ""}`}
          onClick={() => onChange(o.id)}
        >
          {o.dot && <span className="mny-dot" style={{ background: o.dot }} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* One big number. `tone` is "good" | "bad" | undefined. */
export function Stat({ label, value, sub, change, changeGoodWhenUp = true, tone, big, badge, dot }) {
  let changeEl = null;
  if (change !== null && change !== undefined && Number.isFinite(change)) {
    const up = change > 0;
    const flat = Math.abs(change) < 0.005;
    const good = flat ? null : (up === changeGoodWhenUp);
    changeEl = (
      <span className={`mny-change ${flat ? "flat" : good ? "good" : "bad"}`}>
        {flat ? "no change" : `${up ? "▲" : "▼"} ${Math.abs(change) > 5 ? "over 500" : Math.abs(change * 100).toFixed(0)}%`}
      </span>
    );
  }
  return (
    <div className={`mny-stat${big ? " big" : ""}`}>
      <div className="mny-stat-label">
        {dot && <span className="mny-dot" style={{ background: dot }} />}
        {label}{badge && <span className="mny-badge">{badge}</span>}
      </div>
      <div className={`mny-stat-val${tone ? ` ${tone}` : ""}`}>{value}</div>
      <div className="mny-stat-sub">{changeEl}{changeEl && sub ? " " : ""}{sub}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stacked bars: money in (platform + agency) with money out beside.    */
/* ------------------------------------------------------------------ */

function bucketLabel(key, bucket) {
  if (bucket === "month") return monthName(key);
  const [, m, d] = key.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${d}`;
}

export function MoneyChart({ series, bucket, show = "all", height = 240 }) {
  const [hover, setHover] = useState(null);
  const n = series.length;
  const width = 900;
  const pad = { l: 56, r: 12, t: 12, b: 28 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const inOf = (b) => (show === "platform" ? b.platformIn : show === "agency" ? b.agencyIn : b.platformIn + b.agencyIn);
  /* On one side's view the red bar is that side's costs only — shared costs
   * belong to neither, and adding them would make each side look worse than
   * it is by a made-up amount. */
  const outOf = (b) => (show === "all" ? b.out : (b.outDept?.[show] ?? 0));
  const max = Math.max(1, ...series.map((b) => Math.max(inOf(b), outOf(b))));
  const niceMax = (() => {
    const p = 10 ** Math.floor(Math.log10(max));
    return Math.ceil(max / p) * p;
  })();
  const y = (v) => pad.t + innerH - (Math.max(0, v) / niceMax) * innerH;
  const slot = innerW / Math.max(1, n);
  const barW = Math.max(3, Math.min(34, slot * 0.36));
  const gap = 2;
  const labelEvery = Math.max(1, Math.ceil(n / 12));
  const ticks = [0, 0.5, 1].map((f) => f * niceMax);
  const h = hover !== null ? series[hover] : null;

  return (
    <div className="mny-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Money in and money out over time" preserveAspectRatio="none">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--rule)" strokeWidth="1" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="mny-axis">{usd(t)}</text>
          </g>
        ))}
        {series.map((b, i) => {
          const cx = pad.l + slot * i + slot / 2;
          const pIn = show === "agency" ? 0 : Math.max(0, b.platformIn);
          const aIn = show === "platform" ? 0 : Math.max(0, b.agencyIn);
          const x1 = cx - barW - gap / 2;
          const x2 = cx + gap / 2;
          const yA = y(aIn);
          const yP = y(aIn + pIn);
          return (
            <g key={b.key} opacity={hover === null || hover === i ? 1 : 0.45}>
              {aIn > 0 && <rect x={x1} y={yA} width={barW} height={Math.max(0, y(0) - yA)} fill={C_AGENCY} rx="2" />}
              {pIn > 0 && <rect x={x1} y={yP} width={barW} height={Math.max(0, yA - yP - (aIn > 0 ? gap : 0))} fill={C_PLATFORM} rx="2" />}
              {outOf(b) > 0 && <rect x={x2} y={y(outOf(b))} width={barW} height={Math.max(0, y(0) - y(outOf(b)))} fill={C_OUT} rx="2" />}
              {i % labelEvery === 0 && (
                <text x={cx} y={height - 8} textAnchor="middle" className="mny-axis">{bucketLabel(b.key, bucket)}</text>
              )}
              <rect
                x={pad.l + slot * i} y={pad.t} width={slot} height={innerH}
                fill="transparent"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                tabIndex={0}
                aria-label={`${bucketLabel(b.key, bucket)}: in ${usd(inOf(b))}, out ${usd(outOf(b))}`}
              />
            </g>
          );
        })}
        <line x1={pad.l} x2={width - pad.r} y1={y(0)} y2={y(0)} stroke="var(--rule-2)" strokeWidth="1" />
      </svg>
      <div className="mny-legend">
        {show !== "agency" && <span><i style={{ background: C_PLATFORM }} />Platform in</span>}
        {show !== "platform" && <span><i style={{ background: C_AGENCY }} />Agency in</span>}
        <span><i style={{ background: C_OUT }} />{show === "all" ? "Money out" : `${show === "platform" ? "Platform" : "Agency"} costs`}</span>
        <span className="mny-readout">
          {h ? (
            <>
              <strong>{bucketLabel(h.key, bucket)}</strong>
              {show !== "agency" && <> · platform {usd(h.platformIn)}</>}
              {show !== "platform" && <> · agency {usd(h.agencyIn)}</>}
              {" "}· out {usd(outOf(h))} · kept <strong>{usd(inOf(h) - outOf(h))}</strong>
            </>
          ) : "Point at a bar to read it."}
        </span>
      </div>
    </div>
  );
}

/* A plain table with a total line, sortable by clicking a heading. */
export function SimpleTable({ columns, rows, empty = "Nothing in this period.", total, initialSort, max = 50 }) {
  const [sort, setSort] = useState(initialSort || null);
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = col.sortValue || ((r) => r[col.key]);
    return rows.slice().sort((a, b) => {
      const av = get(a), bv = get(b);
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return (av > bv ? 1 : -1) * (sort.dir === "asc" ? 1 : -1);
    });
  }, [rows, sort, columns]);
  const shown = all ? sorted : sorted.slice(0, max);
  if (!rows.length) return <div className="mny-empty">{empty}</div>;
  return (
    <div className="mny-table-wrap">
      <table className="mny-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={c.num ? "num" : ""}
                onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === "desc" ? "asc" : "desc" }))}
                aria-sort={sort?.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
              >
                {c.label}{sort?.key === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={r.id || r.key || i}>
              {columns.map((c) => (
                <td key={c.key} className={c.num ? "num" : ""}>{c.render ? c.render(r) : r[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot>
            <tr>{columns.map((c) => <td key={c.key} className={c.num ? "num" : ""}>{total[c.key] ?? ""}</td>)}</tr>
          </tfoot>
        )}
      </table>
      {rows.length > max && (
        <button type="button" className="mny-more" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

/* A horizontal share bar list — "where it went". */
export function ShareList({ rows, total, color = C_PLATFORM, format = usd, empty = "Nothing in this period." }) {
  if (!rows.length) return <div className="mny-empty">{empty}</div>;
  return (
    <div className="mny-share">
      {rows.map((r) => {
        const f = total > 0 ? Math.max(0, r.value) / total : 0;
        return (
          <div key={r.key} className="mny-share-row">
            <div className="mny-share-top">
              <span className="mny-share-name" title={r.title || r.label}>{r.label}</span>
              <span className="mny-share-val">{format(r.value)}<span className="mny-muted"> · {pctText(f)}</span></span>
            </div>
            <div className="mny-share-track"><div style={{ width: `${Math.max(1, f * 100)}%`, background: r.color || color }} /></div>
            {r.sub && <div className="mny-share-sub">{r.sub}</div>}
          </div>
        );
      })}
    </div>
  );
}

export function Card({ title, right, children, note }) {
  return (
    <section className="mny-card">
      {(title || right) && (
        <div className="mny-card-head">
          <h3>{title}</h3>
          {right}
        </div>
      )}
      {children}
      {note && <div className="mny-note">{note}</div>}
    </section>
  );
}

export function Loading({ what = "Reading…" }) {
  return (
    <div className="mny-loading" role="status">
      <span className="mny-spin" aria-hidden="true" />{what}
    </div>
  );
}
