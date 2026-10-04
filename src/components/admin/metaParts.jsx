import { useState } from "react";
import { Num, Pct } from "./homeServicesParts.jsx";
import { BasisBadge } from "./financeParts.jsx";
import { ChartReadout } from "./shared.jsx";
import { statusWord } from "../../../lib/meta-ads.js";

/* Building blocks for the Meta page — 4 Oct 2026. */

export function StatusPill({ status }) {
  const s = statusWord(status);
  return <span className={`adm-meta-pill adm-meta-pill-${s.tone}`} title={String(status || "")}>{s.label}</span>;
}

/* The funnel for ad visitors. Same look as the Home Services funnel, two
 * differences on purpose:
 *  - the form steps are named for what they are ("Tapped into the form" is a
 *    tap, not a scan), and
 *  - a step people can SKIP (scrolling halfway — the form is at the top) never
 *    shows a negative loss; the next step is compared with the step before it.
 * The step that loses the most people is marked. */
export function MetaFunnel({ steps = [], compact = false }) {
  const top = steps?.[0]?.sessions || 0;
  if (!top) {
    return <p className="adm-hs-note">Nobody from the ads landed in these days, so there is no funnel to draw. This is not a 0% rate — it is no visitors.</p>;
  }
  let worst = null;
  for (const s of steps) {
    if (s.skippable || s.lost == null || (s.prevSessions ?? 0) < 10) continue;
    if (!worst || s.lost * 1 > worst.lost) worst = s;
  }
  return (
    <div className="adm-hs-funnel">
      {!compact && (
        <div className="adm-hs-funnel-head">
          <BasisBadge basis="counted" hint="Each step counts VISITS that got that far, not clicks." />
          {worst && worst.lost >= 30 && <span className="adm-meta-leak">Biggest leak: “{worst.label}” — {Math.round(worst.lost)}% of the step before did not get here</span>}
        </div>
      )}
      <ol className="adm-hs-funnel-steps">
        {steps.map((s, i) => (
          <li key={s.event} className={worst && s.event === worst.event && worst.lost >= 30 ? "adm-meta-leakstep" : ""}>
            <div className="adm-hs-funnel-row">
              <span className="adm-hs-funnel-label">{s.label}{s.skippable ? <span className="dim"> (can be skipped)</span> : null}</span>
              <span className="adm-hs-funnel-n"><Num value={s.sessions} /></span>
              <span className="adm-hs-funnel-pct"><Pct value={s.ofTop} digits={0} /></span>
            </div>
            <div className="adm-hs-funnel-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(0, Math.min(100, s.ofTop ?? 0))}%` }} />
            </div>
            {i > 0 && !compact && (
              <div className="adm-hs-funnel-drop">
                {s.lost != null
                  ? <>lost <strong>{Math.round(s.lost)}%</strong> of {i > 0 && steps[i - 1].skippable ? <>those at “{s.prevLabel}”</> : "the step before"}{s.prevSessions != null && s.prevSessions < 10 ? <span className="dim"> (only {s.prevSessions} people — too few to read much into)</span> : null}</>
                  : s.note ? s.note : <span className="adm-hs-blank" title="Nobody reached the step before this one, so nobody could be lost here.">drop-off not measured</span>}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* Spend per day as bars, with our visitors per day as a dot line on top. Two
 * scales: the bars are dollars (left), the dots are people (right). The
 * readout under the chart names both in words, so colour is never the only
 * way to tell them apart. */
export function DayChart({ rows = [], height = 170 }) {
  const [hover, setHover] = useState(null);
  if (!rows.length) return null;
  const maxSpend = Math.max(1, ...rows.map((r) => r.spend || 0));
  const maxVisits = Math.max(1, ...rows.map((r) => r.visits || 0));
  const shown = rows[Math.min(hover ?? rows.length - 1, rows.length - 1)];
  const w = 100 / rows.length;
  const label = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div className="adm-meta-daychart">
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img" aria-label="Spend and visitors per day">
        {rows.map((r, i) => {
          const h = Math.max(1, ((r.spend || 0) / maxSpend) * (height - 24));
          return (
            <g key={r.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onTouchStart={() => setHover(i)}>
              <rect x={i * w} y={0} width={w} height={height} fill="transparent" />
              <rect x={i * w + (w - Math.min(w * 0.64, 7)) / 2} y={height - h} width={Math.min(w * 0.64, 7)} height={h} rx="0.6"
                fill={hover === i ? "var(--accent-deep)" : "#6366f1"} />
            </g>
          );
        })}
        <polyline fill="none" stroke="#0ca30c" strokeWidth="0.8" vectorEffect="non-scaling-stroke"
          points={rows.map((r, i) => `${i * w + w / 2},${height - 4 - ((r.visits || 0) / maxVisits) * (height - 30)}`).join(" ")} />
        {rows.map((r, i) => (
          <circle key={`d${r.day}`} cx={i * w + w / 2} cy={height - 4 - ((r.visits || 0) / maxVisits) * (height - 30)} r="1.2" fill="#0ca30c" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="adm-meta-daylabels">{rows.map((r) => <span key={r.day} style={{ width: `${w}%` }}>{label(r.day)}</span>)}</div>
      {shown && (
        <ChartReadout
          when={label(shown.day)}
          hint={hover == null ? "newest day · hover a bar" : null}
          cells={[
            { label: "Spent (bar)", value: `$${(shown.spend || 0).toFixed(2)}` },
            { label: "Link clicks", value: (shown.linkClicks || 0).toLocaleString("en-US") },
            { label: "Our visitors (line)", value: (shown.visits || 0).toLocaleString("en-US"), color: "#0a7a0a" },
            { label: "Leads", value: (shown.leads || 0).toLocaleString("en-US") },
          ]}
        />
      )}
    </div>
  );
}
