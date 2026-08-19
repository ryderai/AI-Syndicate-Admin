import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* Inline-edit cells for the Operations database.
 *
 * Notion's table is the reference: every cell is edited where it sits — one
 * click, no modal, no Save button. Two rules make it hold up here:
 *
 *   1. Popovers are portaled to <body> and positioned in FIXED coordinates
 *      from the button's own rect. The table scrolls sideways, and anything
 *      absolutely positioned inside a scroll container gets clipped.
 *   2. A cell never owns the value. It shows what it is handed and reports a
 *      change upward. The page keeps one copy of the truth, so a failed save
 *      can put the old value back everywhere at once.
 */

/* Notion's own option colours, matched against the workspace. */
export const NOTION_COLORS = {
  default: { c: "#3f4753", bg: "#eef0f3" },
  gray: { c: "#4b5563", bg: "#ebedee" },
  brown: { c: "#7a4b2a", bg: "#f0e7e0" },
  orange: { c: "#a04d16", bg: "#fbecdd" },
  yellow: { c: "#8a6a12", bg: "#fbf3db" },
  green: { c: "#1a6b3c", bg: "#dcede4" },
  blue: { c: "#1d5aa7", bg: "#ddebf4" },
  purple: { c: "#6740b4", bg: "#eae4f5" },
  pink: { c: "#a3417a", bg: "#f7e0ee" },
  red: { c: "#b02a1e", bg: "#fbe4e2" },
};

export function chipStyle(color) {
  const t = NOTION_COLORS[color] || NOTION_COLORS.default;
  return { color: t.c, background: t.bg };
}

export const STATUS_COLOR = { todo: "default", in_progress: "blue", done: "green", blocked: "red" };
export const PRIORITY_COLOR = { high: "red", medium: "yellow", low: "green" };
export const PRIORITY_ICON = { high: "🔴", medium: "🟡", low: "🟢" };
export const CATEGORY_COLOR = {
  "Access": "blue", "Business Intel": "purple", "Legal/Compliance": "red",
  "Client Comms": "pink", "Billing": "green", "Technical": "gray",
  "Content": "yellow", "Reporting": "orange",
};
export const PHASE_COLOR = {
  "Onboarding": "purple", "Month 1": "blue", "Month 2": "green",
  "Month 3": "yellow", "Ongoing": "orange",
};

/* The same client always gets the same colour, without storing one. */
const CLIENT_PALETTE = ["blue", "purple", "green", "yellow", "gray", "orange", "pink", "brown", "red"];
export function clientColor(name = "") {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 9973;
  return CLIENT_PALETTE[h % CLIENT_PALETTE.length];
}

export function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */

export function Chip({ label, color = "default", title }) {
  return <span className="adm-db-chip" style={chipStyle(color)} title={title}>{label}</span>;
}

export function Avatar({ name, size = 20 }) {
  const initials = (name || "?")
    .split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <span className="adm-db-avatar" style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden="true">
      {initials || "?"}
    </span>
  );
}

/* ------------------------------------------------------------------ */

/** A menu anchored to a rect, portaled to <body>, flipped up when it would
 *  fall off the bottom. Closes on outside click, Escape, resize, or scroll. */
export function Popover({ anchor, onClose, width = 232, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let left = anchor.left;
    let top = anchor.bottom + 4;
    if (left + w > window.innerWidth - 10) left = Math.max(10, window.innerWidth - w - 10);
    if (top + h > window.innerHeight - 10) top = Math.max(10, anchor.top - h - 4);
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="adm-db-pop" style={{ left: pos.left, top: pos.top, width }} role="dialog">
      {children}
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */

/** One-of-a-list cell. options: [{ value, label, color }] */
export function SelectCell({ value, options, onChange, placeholder = "Empty", clearable = true, label, width }) {
  const [anchor, setAnchor] = useState(null);
  const opt = options.find((o) => o.value === value) || null;
  return (
    <>
      <button
        type="button" className="adm-db-btn" aria-haspopup="listbox"
        aria-label={`${label || "Value"}: ${opt ? opt.label : "empty"} — click to change`}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        {opt ? <Chip label={opt.label} color={opt.color} /> : <span className="adm-db-empty">{placeholder}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} width={width} onClose={() => setAnchor(null)}>
          <div className="adm-db-pop-list" role="listbox">
            {options.map((o) => (
              <button
                key={String(o.value)} type="button" role="option" aria-selected={o.value === value}
                className={`adm-db-pop-item${o.value === value ? " on" : ""}`}
                onClick={() => { setAnchor(null); if (o.value !== value) onChange(o.value); }}
              >
                <Chip label={o.label} color={o.color} />
                {o.value === value ? <span className="adm-db-check">✓</span> : null}
              </button>
            ))}
            {clearable && value ? (
              <button type="button" className="adm-db-pop-item plain" onClick={() => { setAnchor(null); onChange(null); }}>
                Clear
              </button>
            ) : null}
          </div>
        </Popover>
      )}
    </>
  );
}

/** Who owns the task. options: [{ value, label }]. */
export function PersonCell({ value, options, onChange }) {
  const [anchor, setAnchor] = useState(null);
  const opt = options.find((o) => o.value === value) || null;
  return (
    <>
      <button
        type="button" className="adm-db-btn" aria-haspopup="listbox"
        aria-label={`Assigned to ${opt ? opt.label : "nobody"} — click to change`}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        {opt ? (
          <span className="adm-db-person"><Avatar name={opt.label} />{opt.label}</span>
        ) : (
          <span className="adm-db-empty">Unassigned</span>
        )}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div className="adm-db-pop-list" role="listbox">
            {options.map((o) => (
              <button
                key={String(o.value)} type="button" role="option" aria-selected={o.value === value}
                className={`adm-db-pop-item${o.value === value ? " on" : ""}`}
                onClick={() => { setAnchor(null); if (o.value !== value) onChange(o.value); }}
              >
                <span className="adm-db-person"><Avatar name={o.label} />{o.label}</span>
                {o.value === value ? <span className="adm-db-check">✓</span> : null}
              </button>
            ))}
            {value ? (
              <button type="button" className="adm-db-pop-item plain" onClick={() => { setAnchor(null); onChange(null); }}>
                Unassign
              </button>
            ) : null}
          </div>
        </Popover>
      )}
    </>
  );
}

/** Free text. Enter saves (Cmd/Ctrl+Enter when multiline), Escape puts it back. */
export function TextCell({ value, onChange, placeholder = "Empty", multiline, strong, strike, required }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");

  useEffect(() => { if (!editing) setDraft(value || ""); }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (required && !v) { setDraft(value || ""); return; }
    if ((value || "") !== v) onChange(v || null);
  };

  if (editing) {
    const common = {
      className: "adm-db-edit", autoFocus: true, value: draft,
      onChange: (e) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === "Escape") { e.stopPropagation(); setDraft(value || ""); setEditing(false); }
        else if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
      },
    };
    return multiline ? <textarea rows={3} {...common} /> : <input type="text" {...common} />;
  }

  return (
    <button type="button" className="adm-db-btn" onClick={() => setEditing(true)}>
      {value
        ? <span className={`${strong ? "adm-db-strong" : ""}${strike ? " adm-db-strike" : ""}`}>{value}</span>
        : <span className="adm-db-empty">{placeholder}</span>}
    </button>
  );
}

/** Due date. Red with a warning mark when it is late. */
export function DateCell({ value, onChange, overdue }) {
  const [anchor, setAnchor] = useState(null);
  return (
    <>
      <button
        type="button" className={`adm-db-btn mono${overdue ? " overdue" : ""}`}
        aria-label={`Due ${value || "never set"} — click to change`}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        {value ? <>{value}{overdue ? " ⚠" : ""}</> : <span className="adm-db-empty">Empty</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} width={214} onClose={() => setAnchor(null)}>
          <div className="adm-db-pop-pad">
            <input
              type="date" className="adm-input" defaultValue={value || ""} autoFocus
              onChange={(e) => {
                /* A half-typed date reports "" on every keystroke. Committing that
                 * would delete the date you are in the middle of typing, and close
                 * the menu under your hands. Only a whole date counts. */
                const v = e.target.value;
                if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
                onChange(v);
                setAnchor(null);
              }}
            />
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button className="btn btn-sm" onClick={() => { onChange(todayISO()); setAnchor(null); }}>Today</button>
              {value ? <button className="btn btn-sm" onClick={() => { onChange(null); setAnchor(null); }}>Clear</button> : null}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
