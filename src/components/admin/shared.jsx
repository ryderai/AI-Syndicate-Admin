import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toastListeners } from "../../lib/toast.js";
import { getHealth } from "../../lib/adminApi.js";

/* Shared building blocks for the admin console. Toaster/CountUp/SectionHeader
 * mirror the platform's dash/shared.jsx so the two products feel identical. */

const TOAST_TONE = {
  success: { c: "#7dd3a0", icon: "✓", glow: "rgba(125,211,160,0.3)" },
  info: { c: "#a78bfa", icon: "i", glow: "rgba(167,139,250,0.3)" },
  warn: { c: "#fbbf24", icon: "!", glow: "rgba(251,191,36,0.3)" },
  error: { c: "#fb7185", icon: "✕", glow: "rgba(251,113,133,0.3)" },
};

export function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const handler = (t) => {
      setItems((cur) => [...cur, t]);
      setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== t.id)), 4200);
    };
    toastListeners.push(handler);
    return () => {
      const i = toastListeners.indexOf(handler);
      if (i >= 0) toastListeners.splice(i, 1);
    };
  }, []);
  return (
    <div className="dash-toaster" aria-live="polite" aria-atomic="true">
      {items.map((t) => {
        const tone = TOAST_TONE[t.type] || TOAST_TONE.info;
        return (
          <div key={t.id} className="dash-toast" style={{ "--toast-color": tone.c, "--toast-glow": tone.glow }}>
            <span className="dash-toast-icon">{tone.icon}</span>
            <div className="dash-toast-body">
              <div className="dash-toast-title">{t.title}</div>
              {t.body && <div className="dash-toast-sub">{t.body}</div>}
            </div>
            <button className="dash-toast-close" onClick={() => setItems((cur) => cur.filter((x) => x.id !== t.id))} aria-label="Dismiss">×</button>
          </div>
        );
      })}
    </div>
  );
}

export function CountUp({ to, duration = 1200, suffix = "", prefix = "", decimals = 0, format }) {
  const [n, setN] = useState(0);
  const rafRef = useRef(0);
  useEffect(() => {
    let start;
    const step = (t) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(eased * to);
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [to, duration]);
  const v = decimals > 0 ? n.toFixed(decimals) : Math.round(n);
  const display = format ? format(v) : `${prefix}${typeof v === "number" ? v.toLocaleString() : v}${suffix}`;
  return <>{display}</>;
}

export function SectionHeader({ kicker, title, subtitle, right }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, marginBottom: 22, flexWrap: "wrap" }}>
      <div style={{ minWidth: 0 }}>
        {kicker && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ width: 4, height: 4, borderRadius: 99, background: "var(--accent-2)", boxShadow: "0 0 0 3px color-mix(in oklab, var(--accent-2) 18%, transparent)" }} />
            <span className="label" style={{ marginBottom: 0 }}>{kicker}</span>
          </div>
        )}
        <h2 style={{ fontFamily: "var(--display)", fontSize: 24, fontWeight: 700, letterSpacing: "-0.022em", color: "var(--ink)", lineHeight: 1.18 }}>{title}</h2>
        {subtitle && <p style={{ marginTop: 8, color: "var(--ink-2)", fontSize: 14, lineHeight: 1.6, maxWidth: 720 }}>{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function ChipBadge({ label, color = "var(--accent-deep)", bg = "var(--accent-soft)" }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px", borderRadius: 99, background: bg, color, fontSize: 11, fontWeight: 700, fontFamily: "var(--mono)", letterSpacing: "0.04em" }}>
      {label}
    </span>
  );
}

/** Where a number comes from — the honesty badge. Every data card carries one.
 * live    = measured from the real integration just now
 * sample  = preview data, nothing real behind it
 * waiting = the screen is real but the key/feed isn't set yet
 * error   = the read was attempted and failed. Added Aug 22 2026: a broken
 *           query used to borrow "waiting", which told the reader to go and set
 *           a key that was already set. */
export function SourceBadge({ mode, hint }) {
  const map = {
    live: { l: "LIVE", c: "#006b1a", bg: "var(--success-soft)" },
    sample: { l: "SAMPLE", c: "#92400e", bg: "#fffbeb" },
    waiting: { l: "WAITING ON KEY", c: "var(--ink-dim)", bg: "var(--bg-3)" },
    error: { l: "READ FAILED", c: "#b42318", bg: "#fef3f2" },
  };
  const t = map[mode] || map.sample;
  return (
    <span
      title={hint || (mode === "live" ? "Pulled from the real source just now" : mode === "error" ? "This read was tried and failed — the reason is on the page" : mode === "waiting" ? "The screen is wired — it goes live the moment the key is set (SETUP.md)" : "Sample data — preview only")}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 4, background: t.bg, color: t.c, fontSize: 9, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.08em", cursor: "help" }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 99, background: "currentColor" }} />
      {t.l}
    </span>
  );
}

export function MetricCard({ label, value, delta, deltaUp, hint, badge }) {
  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div className="label">{label}</div>
        {badge}
      </div>
      <div style={{ fontFamily: "var(--display)", fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", lineHeight: 1, marginTop: 10, color: "var(--ink)" }}>{value}</div>
      {(delta || hint) && (
        <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          {delta ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: deltaUp ? "#006b1a" : "var(--danger)", fontFamily: "var(--mono)", fontWeight: 700 }}>
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                <path d={deltaUp ? "M2 9 L6 4 L10 9" : "M2 4 L6 9 L10 4"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {delta}
            </span>
          ) : <span />}
          {hint && <span style={{ fontSize: 11, color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>{hint}</span>}
        </div>
      )}
    </div>
  );
}

export function EmptyState({ icon = "◎", title, body, action }) {
  return (
    <div className="card" style={{ padding: "44px 32px", textAlign: "center" }}>
      <div style={{ width: 52, height: 52, margin: "0 auto", borderRadius: 14, background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: "var(--accent-deep)" }} aria-hidden="true">{icon}</div>
      <div style={{ marginTop: 14, fontFamily: "var(--display)", fontSize: 17, fontWeight: 700, color: "var(--ink)" }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 13.5, color: "var(--ink-dim)", lineHeight: 1.55, maxWidth: 420, marginLeft: "auto", marginRight: "auto" }}>{body}</div>
      {action && <div style={{ marginTop: 18 }}>{action}</div>}
    </div>
  );
}

export function Modal({ open, onClose, kicker, title, width = 560, children, footer }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="adm-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="adm-modal" style={{ width: `min(${width}px, 94vw)` }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="adm-modal-head">
          <div>
            {kicker && <div style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--accent-deep)" }}>{kicker}</div>}
            <div style={{ fontFamily: "var(--display)", fontSize: 19, fontWeight: 700, color: "var(--ink)", marginTop: kicker ? 4 : 0 }}>{title}</div>
          </div>
          <button className="adm-modal-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="adm-modal-body">{children}</div>
        {footer && <div className="adm-modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

export function Field({ label, children, hint }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--ink-faint)" }}>{hint}</div>}
    </label>
  );
}

export function TextInput(props) {
  return <input {...props} className={`adm-input ${props.className || ""}`} />;
}
export function TextArea(props) {
  return <textarea {...props} className={`adm-input ${props.className || ""}`} style={{ minHeight: 90, resize: "vertical", ...(props.style || {}) }} />;
}
/**
 * `options` is [[value, label], …]. `groups` is [{ label, options }, …] and
 * draws real <optgroup>s — added 2 Sep 2026 for the industry picker, which is
 * 56 trades long and unusable as one flat list. Both may be given: the flat
 * options are drawn first, which is how "— none —" and anything already on the
 * record stay at the top.
 */
export function Select({ options = [], groups = null, ...props }) {
  return (
    <select {...props} className={`adm-input ${props.className || ""}`}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      {groups?.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/* ------------------------------------------------------------------ */
/* Charts — single-series only (palette-validated: #6366f1 on light).   */
/* Thin marks, 4px rounded data-ends, 2px gaps, in-card hover readout.  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* ChartReadout — one bar's numbers, printed INSIDE the card BELOW the  */
/* chart. Replaces the old floating box (`.adm-chart-tip`), which sat   */
/* on top of the bars and hid the very bar you were pointing at, plus   */
/* its neighbours. Ryder asked for this on Aug 19 2026.                 */
/*                                                                      */
/* Three rules this follows:                                            */
/*  1. It is ALWAYS on screen. An empty-until-hover strip would make    */
/*     the card grow and shrink under the mouse, which moves the bars   */
/*     while you are trying to point at them. With nothing hovered it   */
/*     shows the newest period and says so.                             */
/*  2. It never sits on top of data. Below the axis labels, in flow.    */
/*  3. Phones and tablets have no hover, so the bars answer to a tap    */
/*     as well. Known limit, written down rather than papered over: the */
/*     bars are not reachable by keyboard, so a keyboard-only or        */
/*     screen-reader user gets the newest period and the chart's spoken */
/*     summary, not one period at a time. Fixing that means making      */
/*     every bar a real focusable control, which is a bigger job than   */
/*     this one. No aria-live here on purpose — it would read all four  */
/*     values aloud again for every bar the pointer crosses.            */
/* ------------------------------------------------------------------ */
export function ChartReadout({ when, cells, hint }) {
  return (
    <div className="adm-chart-readout">
      <div className="adm-chart-readout-when">
        <span>{String(when).toUpperCase()}</span>
        {/* The hint line is ALWAYS rendered — an empty one when a bar is
          * hovered — so the strip cannot change height under the pointer. */}
        <span className="adm-chart-readout-hint">{hint || "\u00A0"}</span>
      </div>
      <div className="adm-chart-readout-cells">
        {cells.map((c) => (
          <div key={c.label} className={`adm-chart-readout-cell${c.wide ? " adm-chart-readout-cell--wide" : ""}`}>
            <div className="adm-chart-readout-label">{c.label}</div>
            <div className="adm-chart-readout-value" style={c.color ? { color: c.color } : undefined}>
              {c.value}
              {c.sub && <span className="adm-chart-readout-sub">· {c.sub}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Bars({ data, height = 160, format = (v) => v, ariaLabel }) {
  // data: [{ label, value }]
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const maxIdx = data.reduce((mi, d, i) => (d.value > data[mi].value ? i : mi), 0);
  // Nothing hovered → read out the newest bar, and say that is what it is.
  // Clamped: switching range shortens the series while a tap can still be
  // "held", and an out-of-range index used to blank the strip.
  const shown = Math.min(hover != null ? hover : data.length - 1, data.length - 1);
  const row = data[shown];
  return (
    <div>
    <div style={{ position: "relative" }} aria-label={ariaLabel} role="img">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height }}>
        {data.map((d, i) => {
          const h = Math.max(3, Math.round((d.value / max) * (height - 26)));
          return (
            <div
              key={d.label}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%", cursor: "default", minWidth: 0 }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onTouchStart={() => setHover(i)}
            >
              {i === maxIdx && d.value > 0 && (
                <div style={{ fontSize: 10, fontFamily: "var(--mono)", fontWeight: 700, color: "var(--ink-2)", marginBottom: 3, whiteSpace: "nowrap" }}>{format(d.value)}</div>
              )}
              <div style={{
                width: "100%", maxWidth: 34, height: h,
                background: hover === i ? "var(--accent-deep)" : "#6366f1",
                borderRadius: "4px 4px 0 0",
                transition: "background 0.15s",
              }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 2, marginTop: 6 }}>
        {data.map((d, i) => (
          <div key={d.label} style={{ flex: 1, textAlign: "center", fontSize: 9, fontFamily: "var(--mono)", color: hover === i ? "var(--ink)" : "var(--ink-faint)", overflow: "hidden", whiteSpace: "nowrap" }}>
            {d.label}
          </div>
        ))}
      </div>
    </div>
      {row && (
        <ChartReadout
          when={row.label}
          hint={hover == null ? "newest · tap or hover" : null}
          cells={[
            { label: "Amount", value: format(row.value) },
            ...(row.detail ? [{ label: "Detail", value: row.detail }] : []),
          ]}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* MoneyBars — revenue with AI spend stacked inside it.                 */
/*                                                                      */
/* One bar per period. Bar height = revenue. The red block at the bottom */
/* is what we spent on AI in that period; the green above it is what was */
/* left. No green means AI ate everything that came in.                  */
/*                                                                      */
/* Colour choice is not taste. Plain red-vs-green is the classic         */
/* colourblind failure: #0ca30c vs #d03b3b measures a CVD separation of  */
/* 4.1 (needs 8+), so a red-green colourblind reader — about 1 man in 12 */
/* — sees one colour. Darkening the red to #941f1f lifts that to 17.8    */
/* while both still clear 3:1 against a white card, and both still read  */
/* plainly as red and green. Checked with a validator, not by eye.       */
/* Position backs the colour up: spend is ALWAYS the bottom block, and   */
/* the legend and tooltip name both in words.                            */
/* ------------------------------------------------------------------ */
export const MONEY_GREEN = "#0ca30c";
export const MONEY_RED = "#941f1f";

/* A healthy month has an AI bill worth well under 1% of revenue, which on a
 * 200px bar is one pixel. Floor it so "there IS a cost" is always visible; the
 * tooltip carries the exact figure and its share, so the floor never becomes
 * the number anyone reads. */
const MIN_COST_PX = 4;

export function MoneyBars({ data, height = 210, ariaLabel }) {
  // data: [{ label, revenue, cost }] in cents
  const [hover, setHover] = useState(null);

  /* Axis labels are thinned by measuring the chart, not by media queries.
   * Two media queries ("hide every 2nd" under 760px, "hide every 3rd" under
   * 520px) intersect into "hide every 6th" and leave 2 labels on a phone —
   * tried it, counted it, threw it away. Width per bar is the real question. */
  const wrapRef = useRef(null);
  const [labelStep, setLabelStep] = useState(1);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const perBar = el.clientWidth / Math.max(1, data.length);
      setLabelStep(perBar >= 34 ? 1 : perBar >= 22 ? 2 : perBar >= 15 ? 3 : 4);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data.length]);

  // One axis, in cents, tall enough for the worst case — which includes a
  // period where AI cost MORE than came in.
  const max = Math.max(1, ...data.map((d) => Math.max(d.revenue, d.cost)));
  const plot = height - 26;
  const px = (cents) => Math.round((cents / max) * plot);

  const maxIdx = data.reduce((mi, d, i) => (d.revenue > data[mi].revenue ? i : mi), 0);
  // Nothing hovered → the readout shows the newest period, and labels it as
  // such. Clamped: the Weekly/Monthly/Quarterly tabs change how many bars
  // there are, and a stale index used to blank the strip.
  const shown = data[Math.min(hover != null ? hover : data.length - 1, data.length - 1)];
  const totalRev = data.reduce((s, d) => s + d.revenue, 0);
  const totalCost = data.reduce((s, d) => s + d.cost, 0);

  return (
    <div>
      {/* Legend — always present with two series, so identity is never colour alone */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12, fontSize: 11.5, color: "var(--ink-2)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: MONEY_GREEN, flex: "0 0 auto" }} />
          Left after AI · {fmtMoney(Math.max(0, totalRev - totalCost))}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: MONEY_RED, flex: "0 0 auto" }} />
          AI spend · {fmtMoney(totalCost)}
        </span>
        <span style={{ color: "var(--ink-faint)" }}>Bar height = money in</span>
      </div>

      <div ref={wrapRef} style={{ position: "relative" }} aria-label={ariaLabel} role="img">
        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height }}>
          {data.map((d, i) => {
            const revH = px(d.revenue);
            const costH = px(Math.min(d.cost, d.revenue));
            const keptH = Math.max(0, revH - costH);
            const overH = d.cost > d.revenue ? px(d.cost) - revH : 0;
            const dim = hover != null && hover !== i;
            return (
              <div
                key={d.label}
                style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%", minWidth: 0, opacity: dim ? 0.55 : 1, transition: "opacity 0.15s" }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onTouchStart={() => setHover(i)}
              >
                {i === maxIdx && d.revenue > 0 && (
                  <div style={{ fontSize: 10, fontFamily: "var(--mono)", fontWeight: 700, color: "var(--ink-2)", marginBottom: 3, whiteSpace: "nowrap" }}>
                    {fmtMoney(d.revenue)}
                  </div>
                )}
                {/* AI cost above the bar = it cost more than came in */}
                {overH > 0 && (
                  <div style={{ width: "100%", maxWidth: 34, height: overH, border: `1.5px dashed ${MONEY_RED}`, borderBottom: 0, borderRadius: "4px 4px 0 0", boxSizing: "border-box" }} />
                )}
                <div style={{ width: "100%", maxWidth: 34, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: Math.max(3, revH) }}>
                  {keptH > 0 && (
                    <div style={{ height: keptH, background: MONEY_GREEN, borderRadius: "4px 4px 0 0" }} />
                  )}
                  {/* 2px surface gap between the two fills so they never merge */}
                  {keptH > 0 && costH > 0 && <div style={{ height: 2, background: "white", flex: "0 0 auto" }} />}
                  {costH > 0 && (
                    <div style={{ height: Math.max(MIN_COST_PX, costH), background: MONEY_RED, borderRadius: keptH > 0 ? 0 : "4px 4px 0 0" }} />
                  )}
                  {d.revenue === 0 && d.cost === 0 && (
                    <div style={{ height: 3, background: "var(--rule)", borderRadius: 2 }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Axis labels thin out on narrow screens instead of colliding. Counted
          * from the RIGHT so the most recent period always keeps its label. */}
        <div style={{ display: "flex", gap: 3, marginTop: 6 }}>
          {data.map((d, i) => {
            // Counted from the RIGHT so "now" always keeps its label.
            const hidden = (data.length - 1 - i) % labelStep !== 0;
            return (
              <div key={d.label} style={{ visibility: hidden ? "hidden" : "visible", flex: 1, textAlign: "center", fontSize: 9, fontFamily: "var(--mono)", color: hover === i ? "var(--ink)" : "var(--ink-faint)", overflow: "visible", whiteSpace: "nowrap" }}>
                {d.label}
              </div>
            );
          })}
        </div>

      </div>

      {/* The numbers for one period — inside the card, under the chart, never
        * on top of the bars. Nothing hovered = the newest period. */}
      {shown && (
        <ChartReadout
          when={shown.tipLabel || shown.label}
          hint={hover == null ? "newest · tap or hover" : null}
          cells={[
            { label: "Money in", value: fmtMoney(shown.revenue) },
            {
              label: "AI spend",
              value: `−${fmtMoney(shown.cost)}`,
              color: MONEY_RED,
              // Widest cell, fixed width: its share text changes length
              // ("0.63%" vs "1.0%"), which used to nudge the figure after it.
              wide: true,
              sub: shown.revenue > 0
                ? `${((shown.cost / shown.revenue) * 100).toFixed((shown.cost / shown.revenue) * 100 < 1 ? 2 : 1)}% of money in`
                : null,
            },
            shown.revenue - shown.cost >= 0
              ? { label: "Left after AI", value: fmtMoney(shown.revenue - shown.cost), color: "#006300" }
              : { label: "Short by", value: fmtMoney(shown.cost - shown.revenue), color: MONEY_RED },
          ]}
        />
      )}
    </div>
  );
}

export function Sparkline({ points, width = 120, height = 34 }) {
  if (!points?.length) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const step = width / Math.max(1, points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - 3 - ((p - min) / span) * (height - 6)).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

export function fmtMoney(cents, currency = "usd") {
  const v = (cents || 0) / 100;
  return v.toLocaleString("en-US", { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: v >= 1000 ? 0 : 2 });
}

export function fmtNum(n) {
  if (n == null) return "—";
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  return Number(n).toLocaleString();
}

/* Moved to src/lib/timeAgo.js on 30 Aug 2026 and re-exported here so every
 * existing `import { timeAgo } from "./shared.jsx"` keeps working. It left
 * this file because node cannot import .jsx, so it had no test — and it was
 * printing "just now" for a date in the FUTURE and "Invalid Date" for
 * anything unparseable. tests/time-ago pins both. */
export { timeAgo } from "../../lib/timeAgo.js";

/** The current time, as state that ticks. Reading the clock straight out of a
 * render is impure — the same render would produce different output on a
 * re-render, which React (and our lint rule) rightly rejects. Starts at 0 so the
 * first paint is deterministic; one tick later it is the real time. */
export function useNow(intervalMs = 60000) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useHealth() {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    let alive = true;
    getHealth().then((h) => { if (alive) setHealth(h); });
    return () => { alive = false; };
  }, []);
  return health;
}

/* ------------------------------------------------------------------ */
/* FILTER TABS — one row of tabs, a count on each, one active at a time */
/* ------------------------------------------------------------------ */

/* Added Aug 26 2026 at Ryder's request. He pointed at the list tabs on the
 * Sales sheet — "Everybody 7 · Luxury Agents 3 · Car Dealership 1" — and asked
 * for the same row on the Clients page and above the Vault groups, in place of
 * a side rail on one and a long scroll on the other.
 *
 * It reuses the `adm-sh-tabs` CSS the Sales sheet already uses rather than
 * adding a second set of rules that look almost the same. One row, one
 * stylesheet block: when the look changes, it changes everywhere at once.
 *
 * Rules this component enforces so no caller can get them wrong:
 *
 *   - Exactly ONE tab is active. `value` decides which; there is no way to
 *     express two.
 *   - Clicking the ACTIVE tab does nothing. It does not toggle the row off,
 *     because a tab row with nothing selected has no meaning — there would be
 *     no answer to "which of these am I looking at". The way back to everything
 *     is the first tab, which is why `allId` exists and is always drawn.
 *   - A count of 0 is still PRINTED. A tab that hides its zero reads as "we
 *     have not counted this", and an empty group is a fact worth seeing.
 *   - A count of `null` prints NOTHING at all, which is how a caller says "not
 *     counted" and means it. Never pass 0 for unknown.
 *
 * tabs: [{ id, label, count }]  — count may be a number or null
 */
export function FilterTabs({
  tabs, value, onChange, ariaLabel = "Filters",
  allId = "all", allLabel = "Everybody", allCount = null,
  emptyNote = null,
}) {
  const all = [{ id: allId, label: allLabel, count: allCount }, ...(tabs || [])];

  /* Left and right arrows walk the row. Added Aug 26 2026 with the row itself:
   * `role="tablist"` is a promise to anyone using a keyboard or a screen reader
   * that the arrows work, and a promise the browser does not keep on its own.
   * Without this, the reader announces "tab, 2 of 5" and then the arrows do
   * nothing, which is worse than not claiming to be tabs at all.
   *
   * Only the selected tab is in the tab order (`tabIndex`), which is the other
   * half of the same pattern: one Tab press reaches the row, then the arrows
   * move inside it, rather than Tab having to walk past every group. */
  /* Focus has to travel WITH the selection. Without the `.focus()` below, the
   * pressed key selected the next tab but left the finger on the old button, so
   * a second press moved to the same place again and the row felt stuck. */
  const move = (e, i, step) => {
    const at = (i + step + all.length) % all.length;
    const next = all[at];
    if (!next) return;
    const row = e.currentTarget.parentElement;
    const btn = row ? row.querySelectorAll('[role="tab"]')[at] : null;
    if (btn) btn.focus();
    if (next.id !== value) onChange(next.id);
  };

  return (
    <div className="adm-sh-tabs" role="tablist" aria-label={ariaLabel}>
      {all.map((t, i) => (
        <button
          key={t.id} type="button" role="tab"
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          className={value === t.id ? "active" : ""}
          onClick={() => { if (value !== t.id) onChange(t.id); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") { e.preventDefault(); move(e, i, 1); }
            else if (e.key === "ArrowLeft") { e.preventDefault(); move(e, i, -1); }
            else if (e.key === "Home") { e.preventDefault(); move(e, 0, 0); }
            else if (e.key === "End") { e.preventDefault(); move(e, all.length - 1, 0); }
          }}
        >
          {t.label}
          {t.count === null || t.count === undefined ? null : <span>{t.count}</span>}
        </button>
      ))}
      {tabs && tabs.length === 0 && emptyNote
        ? <span className="adm-sh-tabnone">{emptyNote}</span>
        : null}
    </div>
  );
}
