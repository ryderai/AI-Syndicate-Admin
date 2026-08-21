import { useEffect, useRef, useState } from "react";
import { ChartReadout, MONEY_GREEN, MONEY_RED, fmtMoney } from "./shared.jsx";

/* Building blocks for the Finance and Invoices pages. Aug 20 2026.
 *
 * Two rules run through everything in this file:
 *
 * 1. NO NUMBER WITHOUT ITS SOURCE. Every figure carries a small badge saying
 *    whether it was measured, typed in by us, or worked out with a formula.
 *    Money is the one screen where a confident-looking guess does real damage.
 *
 * 2. NO NUMBER WITHOUT ITS MEANING. Every figure has one plain sentence under
 *    it saying what it is. "CAC" means nothing to somebody reading this for the
 *    first time; "what it costs us to win one new client" does.
 */

/* ------------------------------------------------------------------ */
/* Where a number came from                                            */
/* ------------------------------------------------------------------ */

const BASIS = {
  stripe: { label: "MEASURED", c: "#006b1a", bg: "var(--success-soft)", hint: "Measured from Stripe — real money that actually moved." },
  typed: { label: "TYPED IN", c: "var(--accent-deep)", bg: "var(--accent-soft)", hint: "Typed into this console by us. Only as right as what was entered." },
  mixed: { label: "MEASURED + TYPED", c: "var(--accent-deep)", bg: "var(--accent-soft)", hint: "Stripe money, minus costs we typed in ourselves." },
  estimate: { label: "ESTIMATE", c: "#92400e", bg: "#fffbeb", hint: "Worked out with a formula from the numbers above. It is a projection, not a fact." },
  unknown: { label: "NOT MEASURED", c: "var(--ink-dim)", bg: "var(--bg-3)", hint: "We cannot work this out yet. Shown as a blank on purpose — a zero here would read as a fact." },
  sample: { label: "SAMPLE", c: "#92400e", bg: "#fffbeb", hint: "Sample data — preview only. Nothing real behind it." },
};

export function BasisBadge({ basis, hint }) {
  const t = BASIS[basis] || BASIS.unknown;
  return (
    <span
      title={hint || t.hint}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 7px", borderRadius: 4, background: t.bg, color: t.c, fontSize: 9, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.07em", cursor: "help", whiteSpace: "nowrap" }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 99, background: "currentColor" }} />
      {t.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* One figure, with its meaning and its source                         */
/* ------------------------------------------------------------------ */

export function Figure({ label, value, sub, means, basis, tone, why }) {
  const blank = value == null || value === "" || value === "—";
  return (
    <div className="card adm-fin-fig">
      <div className="adm-fin-fig-top">
        <div className="label" style={{ marginBottom: 0 }}>{label}</div>
        <BasisBadge basis={blank ? "unknown" : basis} hint={blank ? (why || BASIS.unknown.hint) : undefined} />
      </div>
      <div className="adm-fin-fig-val" style={tone ? { color: tone } : undefined}>
        {blank ? <span className="adm-fin-blank">not measured yet</span> : value}
      </div>
      {sub && <div className="adm-fin-fig-sub">{sub}</div>}
      {means && <div className="adm-fin-fig-means">{means}</div>}
      {blank && why && <div className="adm-fin-fig-why">{why}</div>}
    </div>
  );
}

export function FigureGrid({ children, min = 230 }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 16 }}>
      {children}
    </div>
  );
}

/** A titled block on the page, with a plain sentence under the title. */
export function Block({ title, blurb, right, children, id }) {
  return (
    <section className="card adm-fin-block" id={id}>
      <div className="adm-fin-block-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="adm-fin-block-title">{title}</h3>
          {blurb && <p className="adm-fin-block-blurb">{blurb}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* MONEY IN VS OUT — the main chart                                     */
/*                                                                      */
/* Bar height is money in. The red block at the bottom is everything we  */
/* paid out that month; the green above it is what was kept. Months we   */
/* have not lived through yet are drawn as a dashed outline, so a        */
/* projection can never be mistaken for a measurement — the two do not   */
/* even look alike.                                                      */
/*                                                                      */
/* Colours are the two already validated for this codebase (see          */
/* MoneyBars in shared.jsx): #0ca30c and #941f1f, which stay apart for a  */
/* red-green colourblind reader. Position backs colour up — spend is      */
/* ALWAYS the bottom block — and the readout under the chart names both   */
/* in words.                                                             */
/* ------------------------------------------------------------------ */

export function InOutBars({ rows, height = 240, ariaLabel }) {
  const [hover, setHover] = useState(null);
  const wrapRef = useRef(null);
  const [labelStep, setLabelStep] = useState(1);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const perBar = el.clientWidth / Math.max(1, rows.length);
      setLabelStep(perBar >= 34 ? 1 : perBar >= 22 ? 2 : 3);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.length]);

  const max = Math.max(1, ...rows.map((r) => Math.max(r.revenue, r.cost)));
  const plot = height - 26;
  const px = (c) => Math.round((c / max) * plot);
  const shown = rows[Math.min(hover != null ? hover : rows.length - 1, rows.length - 1)];

  const realRows = rows.filter((r) => !r.projected);
  const totalIn = realRows.reduce((s, r) => s + r.revenue, 0);
  const totalOut = realRows.reduce((s, r) => s + r.cost, 0);

  return (
    <div>
      <div className="adm-fin-legend">
        <span><i style={{ background: MONEY_GREEN }} /> Kept · {fmtMoney(Math.max(0, totalIn - totalOut))}</span>
        <span><i style={{ background: MONEY_RED }} /> All money out · {fmtMoney(totalOut)}</span>
        <span><i className="adm-fin-legend-dash" /> Projected — not measured</span>
      </div>

      <div ref={wrapRef} style={{ position: "relative" }} role="img" aria-label={ariaLabel}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height }}>
          {rows.map((r, i) => {
            const revH = Math.max(3, px(r.revenue));
            const costH = px(Math.min(r.cost, r.revenue));
            const keptH = Math.max(0, revH - costH);
            const overH = r.cost > r.revenue ? px(r.cost) - revH : 0;
            const dim = hover != null && hover !== i;
            return (
              <div
                key={r.month}
                className="adm-fin-barcol"
                style={{ opacity: dim ? 0.55 : 1 }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onTouchStart={() => setHover(i)}
              >
                {r.projected ? (
                  <div style={{ width: "100%", maxWidth: 34, height: revH, border: "1.5px dashed var(--ink-faint)", borderRadius: "4px 4px 0 0", boxSizing: "border-box" }} />
                ) : (
                  <>
                    {overH > 0 && (
                      <div style={{ width: "100%", maxWidth: 34, height: overH, border: `1.5px dashed ${MONEY_RED}`, borderBottom: 0, borderRadius: "4px 4px 0 0", boxSizing: "border-box" }} />
                    )}
                    <div style={{ width: "100%", maxWidth: 34, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: revH }}>
                      {keptH > 0 && <div style={{ height: keptH, background: MONEY_GREEN, borderRadius: "4px 4px 0 0" }} />}
                      {keptH > 0 && costH > 0 && <div style={{ height: 2, background: "white" }} />}
                      {costH > 0 && <div style={{ height: Math.max(4, costH), background: MONEY_RED, borderRadius: keptH > 0 ? 0 : "4px 4px 0 0" }} />}
                      {r.revenue === 0 && r.cost === 0 && <div style={{ height: 3, background: "var(--rule)", borderRadius: 2 }} />}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 3, marginTop: 6 }}>
          {rows.map((r, i) => {
            const hidden = (rows.length - 1 - i) % labelStep !== 0;
            return (
              <div key={r.month} style={{ visibility: hidden ? "hidden" : "visible", flex: 1, textAlign: "center", fontSize: 9, fontFamily: "var(--mono)", color: hover === i ? "var(--ink)" : "var(--ink-faint)", whiteSpace: "nowrap" }}>
                {r.label}{r.projected ? "*" : ""}
              </div>
            );
          })}
        </div>
      </div>

      {shown && (
        <ChartReadout
          when={shown.tipLabel || shown.label}
          hint={hover == null ? "newest · tap or hover" : (shown.projected ? "projected — not measured" : null)}
          cells={[
            { label: "Money in", value: fmtMoney(shown.revenue) },
            { label: "Money out", value: `−${fmtMoney(shown.cost)}`, color: MONEY_RED, wide: true, sub: shown.revenue > 0 ? `${((shown.cost / shown.revenue) * 100).toFixed(0)}% of money in` : null },
            shown.revenue - shown.cost >= 0
              ? { label: "Kept", value: fmtMoney(shown.revenue - shown.cost), color: "#006300" }
              : { label: "Short by", value: fmtMoney(shown.cost - shown.revenue), color: MONEY_RED },
          ]}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PROFIT OVER TIME — one bar per month, kept only.                     */
/* A month that lost money drops below the line, in red. Dashed = not    */
/* lived through yet.                                                    */
/* ------------------------------------------------------------------ */

export function ProfitBars({ rows, height = 170, ariaLabel }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.profit)));
  const anyLoss = rows.some((r) => r.profit < 0);
  const plot = height - 20;
  const zero = anyLoss ? plot * 0.62 : plot; // room under the line only if needed
  const shown = rows[Math.min(hover != null ? hover : rows.length - 1, rows.length - 1)];

  return (
    <div>
      <div style={{ position: "relative", height }} role="img" aria-label={ariaLabel}>
        <div style={{ display: "flex", alignItems: "stretch", gap: 3, height: plot }}>
          {rows.map((r, i) => {
            const up = r.profit >= 0;
            const h = Math.max(3, Math.round((Math.abs(r.profit) / max) * (up ? zero : plot - zero)));
            return (
              <div
                key={r.month}
                style={{ flex: 1, minWidth: 0, position: "relative", cursor: "default", opacity: hover != null && hover !== i ? 0.55 : 1 }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onTouchStart={() => setHover(i)}
              >
                <div style={{
                  position: "absolute", left: "50%", transform: "translateX(-50%)",
                  width: "100%", maxWidth: 34,
                  top: up ? zero - h : zero, height: h,
                  background: r.projected ? "transparent" : (up ? MONEY_GREEN : MONEY_RED),
                  border: r.projected ? `1.5px dashed ${up ? MONEY_GREEN : MONEY_RED}` : 0,
                  boxSizing: "border-box",
                  borderRadius: up ? "4px 4px 0 0" : "0 0 4px 4px",
                }} />
              </div>
            );
          })}
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: zero, height: 1, background: "var(--rule)" }} />
        <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
          {rows.map((r, i) => (
            <div key={r.month} style={{ flex: 1, textAlign: "center", fontSize: 9, fontFamily: "var(--mono)", color: hover === i ? "var(--ink)" : "var(--ink-faint)", whiteSpace: "nowrap" }}>
              {r.label}{r.projected ? "*" : ""}
            </div>
          ))}
        </div>
      </div>
      {shown && (
        <ChartReadout
          when={shown.tipLabel || shown.label}
          hint={hover == null ? "newest · tap or hover" : (shown.projected ? "projected — not measured" : null)}
          cells={[
            { label: shown.profit >= 0 ? "Kept" : "Lost", value: fmtMoney(Math.abs(shown.profit)), color: shown.profit >= 0 ? "#006300" : MONEY_RED },
            { label: "Money in", value: fmtMoney(shown.revenue) },
            { label: "Money out", value: fmtMoney(shown.cost), wide: true },
          ]}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* MRR MOVEMENT — start, plus new, minus churn, equals end.             */
/* ------------------------------------------------------------------ */

export function MovementBar({ movement }) {
  const m = movement;
  const parts = [
    { key: "start", label: "Start", cents: m.startMrr, color: "#c7d2fe" },
    { key: "new", label: "New", cents: m.newMrr, color: MONEY_GREEN },
    { key: "churn", label: "Churn", cents: m.churnMrr, color: MONEY_RED },
  ];
  const total = Math.max(1, parts.reduce((s, p) => s + p.cents, 0));
  return (
    <div>
      <div className="adm-fin-move-words">
        <span>Start {fmtMoney(m.startMrr)}</span>
        <span style={{ color: "#006300" }}>+ new {fmtMoney(m.newMrr)}</span>
        <span style={{ color: MONEY_RED }}>− churn {fmtMoney(m.churnMrr)}</span>
        <strong>= {fmtMoney(m.endMrr)}</strong>
      </div>
      <div className="adm-fin-move-bar" role="img" aria-label={`Start ${fmtMoney(m.startMrr)}, new ${fmtMoney(m.newMrr)}, churn ${fmtMoney(m.churnMrr)}, ending at ${fmtMoney(m.endMrr)}`}>
        {parts.map((p) => (
          <span key={p.key} title={`${p.label} · ${fmtMoney(p.cents)}`} style={{ width: `${(p.cents / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      {m.inAndOutCount > 0 && (
        <div className="adm-fin-move-note">
          {m.inAndOutCount} subscription{m.inAndOutCount === 1 ? " was" : "s were"} signed and cancelled inside
          this month. {m.inAndOutCount === 1 ? "It is" : "They are"} in neither figure above, because that money
          was never in the starting total to lose.
        </div>
      )}
      <div className="adm-fin-move-note">
        Upgrades and downgrades inside a month are <strong>not counted here</strong> — Stripe does not
        hand back a plan-change history, so this counts subscriptions that started and subscriptions
        that were cancelled. Nothing is invented to fill the gap.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* A ranked breakdown — money out by category, money in by client.      */
/* ------------------------------------------------------------------ */

export function RankedBars({ rows, total, color = "#6366f1", emptyText = "Nothing here yet." }) {
  if (!rows.length) return <div className="adm-fin-empty">{emptyText}</div>;
  const top = Math.max(1, ...rows.map((r) => r.cents));
  return (
    <div className="adm-fin-ranked">
      {rows.map((r) => (
        <div key={r.label} className="adm-fin-ranked-row">
          <div className="adm-fin-ranked-name" title={r.label}>{r.label}</div>
          <div className="adm-fin-ranked-track">
            <span style={{ width: `${Math.max(1, (r.cents / top) * 100)}%`, background: r.color || color }} />
          </div>
          <div className="adm-fin-ranked-val">
            {fmtMoney(r.cents)}
            {total ? <span className="adm-fin-ranked-pct">{((r.cents / total) * 100).toFixed(0)}%</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Small right-hand-rail card: a heading, then rows of name + amount. */
export function ListCard({ title, badge, rows, footer, emptyText }) {
  return (
    <div className="card adm-fin-list">
      <div className="adm-fin-list-head">
        <div className="label" style={{ marginBottom: 0 }}>{title}</div>
        {badge}
      </div>
      {rows.length ? (
        <div>
          {rows.map((r, i) => (
            <div key={r.key || i} className="adm-fin-list-row">
              <div className="adm-fin-list-name">
                {r.name}
                {r.sub && <span className="adm-fin-list-sub">{r.sub}</span>}
              </div>
              <div className="adm-fin-list-amt" style={r.color ? { color: r.color } : undefined}>{r.amount}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="adm-fin-empty">{emptyText || "Nothing yet."}</div>
      )}
      {footer && <div className="adm-fin-list-foot">{footer}</div>}
    </div>
  );
}

/** Percentages and ratios, formatted the same way everywhere. */
export function pct(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return null;
  return `${n.toFixed(digits)}%`;
}
export function ratio(n) {
  if (n == null || Number.isNaN(n)) return null;
  return `${n.toFixed(1)}×`;
}
export function months(n) {
  if (n == null || Number.isNaN(n)) return null;
  return `${n.toFixed(1)} mo`;
}
