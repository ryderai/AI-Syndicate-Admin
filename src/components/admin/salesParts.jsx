import { LEAD_STAGE_LABELS } from "../../lib/data.js";
import { claimState, scoreGate, ROE } from "../../../lib/sales-rules.js";

/* Small pieces the Sales page draws over and over.
 *
 * The rule they all follow: a colour is never the only thing that says
 * something. Every chip carries words too, because a rep working a list at
 * speed reads the words and a rep who is colour-blind only has the words.
 */

const STAGE_TONE = {
  new: { c: "var(--accent-deep)", bg: "var(--accent-soft)" },
  researching: { c: "var(--accent-deep)", bg: "var(--accent-soft)" },
  contacted: { c: "#0369a1", bg: "#e0f2fe" },
  in_conversation: { c: "#0369a1", bg: "#e0f2fe" },
  follow_up: { c: "#92400e", bg: "#fffbeb" },
  meeting: { c: "#6d28d9", bg: "#f5f3ff" },
  proposal: { c: "#9d174d", bg: "#fdf2f8" },
  won: { c: "#006b1a", bg: "var(--success-soft)" },
  lost: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
  skip_90: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
  bad_contact: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
  reopened: { c: "#92400e", bg: "#fffbeb" },
};

export function StagePill({ stage }) {
  const t = STAGE_TONE[stage] || STAGE_TONE.new;
  return (
    <span className="adm-sl-pill" style={{ color: t.c, background: t.bg }}>
      {(LEAD_STAGE_LABELS[stage] || stage).toUpperCase()}
    </span>
  );
}

/* ------------------------------------------------------------------ */

const CLAIM_TONE = {
  unclaimed: { c: "var(--accent-deep)", bg: "var(--accent-soft)", label: "UNCLAIMED" },
  first_contact: { c: "#0369a1", bg: "#e0f2fe", label: "CLAIMED" },
  first_contact_due: { c: "#92400e", bg: "#fffbeb", label: "CONTACT DUE" },
  claim_expired: { c: "var(--danger)", bg: "#fef2f2", label: "CLAIM RUN OUT" },
  working: { c: "#006b1a", bg: "var(--success-soft)", label: "BEING WORKED" },
  going_cold: { c: "#92400e", bg: "#fffbeb", label: "GOING COLD" },
  cold: { c: "var(--danger)", bg: "#fef2f2", label: "COLD" },
  closed: { c: "var(--ink-dim)", bg: "var(--bg-3)", label: "CLOSED" },
};

/** Where the claim stands. The `title` is the plain-words reason, so hovering
 * anything on this page answers "why does it say that". */
export function ClaimChip({ lead, now }) {
  const s = claimState(lead, now);
  const t = CLAIM_TONE[s.state] || CLAIM_TONE.working;
  return (
    <span className="adm-sl-pill" style={{ color: t.c, background: t.bg, cursor: "help" }} title={s.why}>
      {t.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */

const SCORE_TONE = {
  unknown: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
  skip: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
  thin: { c: "#92400e", bg: "#fffbeb" },
  good: { c: "#0369a1", bg: "#e0f2fe" },
  wide: { c: "#006b1a", bg: "var(--success-soft)" },
};

/**
 * The site score, and what it means for whether to pitch at all.
 *
 * A LOW score is GOOD news here — it is the gap we get paid to close — which
 * is the opposite of what a score usually means on a screen. So the chip never
 * shows a bare number: it says "58 · WIDE GAP" or "93 · SKIP". A rep reading
 * 93 and thinking "great lead" is exactly the mistake rule 5 exists to stop.
 */
export function ScoreChip({ score, onRun, busy }) {
  const g = scoreGate(score);
  const t = SCORE_TONE[g.tone] || SCORE_TONE.unknown;
  if (!g.known) {
    return (
      <button
        type="button"
        className="adm-sl-pill adm-sl-pill-btn"
        style={{ color: t.c, background: t.bg }}
        onClick={onRun}
        disabled={busy || !onRun}
        title={`Run the site score. ${ROE.SKIP_SCORE_AT_OR_ABOVE}+ means they are already doing well and are not a prospect.`}
      >
        {busy ? "SCORING…" : "NO SCORE"}
      </button>
    );
  }
  const word = g.skip ? "SKIP" : g.tone === "thin" ? "NARROW GAP" : g.tone === "good" ? "CLEAR GAP" : "WIDE GAP";
  return (
    <span className="adm-sl-pill" style={{ color: t.c, background: t.bg, cursor: "help" }} title={g.why}>
      {g.score} · {word}
    </span>
  );
}

/* ------------------------------------------------------------------ */

/** How late something is, in one square. "0D LATE" is not a thing a person
 * says, so a thing that has just crossed its line is DUE NOW. */
export function LateBox({ over }) {
  const tone = over === null ? { c: "var(--ink-dim)", bg: "var(--bg-2)" }
    : over >= 3 ? { c: "var(--danger)", bg: "#fef2f2" }
      : over >= 0 ? { c: "#92400e", bg: "#fffbeb" }
        : { c: "var(--ink-dim)", bg: "var(--bg-2)" };
  return (
    <div className="adm-sl-late" style={{ color: tone.c, background: tone.bg }}>
      {over === null ? "—" : over > 0 ? `${over}D LATE` : over === 0 ? "DUE NOW" : `${Math.abs(over)}D LEFT`}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * "Larry is already in this building."
 *
 * The software version of the sheet's loudest rule. It does NOT block
 * anything — Ryder's call, Aug 21 2026: reps do not step on each other, so
 * this is something you read before you send, not a locked door.
 */
export function FirmWarning({ warning }) {
  if (!warning) return null;
  return (
    <div className="adm-sl-warn" role="status">
      <strong>Somebody else is working this firm.</strong> {warning.line}{" "}
      One firm, one rep — check with them before you send anything.
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** A number with the thing it counts, for the tiles across the top. */
export function Tile({ label, value, hint, tone, onClick, active }) {
  return (
    <button
      type="button"
      className={`adm-sl-tile${active ? " active" : ""}${onClick ? " clickable" : ""}`}
      onClick={onClick}
      disabled={!onClick}
    >
      <span className="adm-sl-tile-n" style={tone ? { color: tone } : undefined}>{value}</span>
      <span className="adm-sl-tile-l">{label}</span>
      {hint && <span className="adm-sl-tile-h">{hint}</span>}
    </button>
  );
}

/** A bar with the count printed next to it. Never a bar on its own — a bar
 * with no number is a shape, not a fact. */
export function MiniBar({ label, n, total, tone = "var(--accent)" }) {
  const pct = total ? Math.round((n / total) * 100) : 0;
  return (
    <div className="adm-sl-mini">
      <div className="adm-sl-mini-top">
        <span>{label}</span>
        <span className="adm-sl-mini-n">{n} of {total} · {pct}%</span>
      </div>
      <div className="adm-sl-mini-track"><div style={{ width: `${pct}%`, background: tone }} /></div>
    </div>
  );
}

export function money(cents) {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** A website cell that is safe to click and readable at a glance. */
export function SiteLink({ domain }) {
  if (!domain) return <span className="adm-sl-faint">no website</span>;
  const clean = String(domain).replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <a href={`https://${clean}`} target="_blank" rel="noopener noreferrer" className="adm-sl-link">
      {clean}
    </a>
  );
}
