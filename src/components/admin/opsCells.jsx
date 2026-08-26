import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

  /* `onClose` is an inline arrow at every call site, so it is a new function on
   * every parent render. Held in a ref and read through a stable callback, the
   * effect below runs ONCE per open instead of tearing down and re-arming on
   * every background reload — which is what made the leak below possible in
   * the first place. */
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  const close = useCallback(() => closeRef.current?.(), []);

  useEffect(() => {
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) close(); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);

    /* THE SCROLL LISTENER IS ARMED ONE FRAME LATE, ON PURPOSE.
     *
     * Found Aug 25 2026 by WATCHING the built page, not by reading this file.
     * Clicking a cell that is not fully in view makes the browser scroll the
     * table sideways to show it. That scroll event is queued, so it arrived
     * AFTER this popover had mounted — and closed it in the same instant it
     * opened. On the Sales sheet, which is wide enough that half the columns
     * are off screen, the Company and Status menus could not be opened at all.
     * The Operations table has the same shape and the same bug, quieter only
     * because its columns are narrower.
     *
     * A real scroll by a person still closes it, which is what this listener
     * was written for. What is skipped is the one scroll that opening caused.
     *
     * BOTH TIMERS ARE CANCELLED. The first version cancelled the frame and not
     * the timeout scheduled INSIDE it, so a cleanup landing between the two
     * left an armed scroll listener attached forever, to a closure whose
     * popover was already gone — and it then shut the NEXT popover on its
     * opening scroll. One leak per occurrence. Caught by a reviewer. */
    let armed = false;
    let tick = 0;
    const onMove = () => { if (armed) close(); };
    const raf = requestAnimationFrame(() => {
      tick = setTimeout(() => {
        armed = true;
        window.addEventListener("resize", onMove);
        window.addEventListener("scroll", onMove, true);
      }, 0);
    });

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(tick);
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [close]);

  return createPortal(
    <div ref={ref} className="adm-db-pop" style={{ left: pos.left, top: pos.top, width }} role="dialog">
      {children}
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */

/** The two filter actions that sit at the top of every value cell's menu.
 *
 * Ryder, Aug 23 2026: *"i want to in operations be able to click the rows and
 * it start filtering and grouping them together."* The cells were already
 * click-to-edit, so a plain click cannot mean two things. Putting the actions
 * INSIDE the menu the click already opens means one click still gets you
 * there, and nothing that used to edit a value now filters instead.
 *
 * `filter` is { label, column, active, onOnly, onGroup }. Either callback may
 * be missing — the due-date cell has no useful "only this date".
 */
export function FilterHead({ filter, close }) {
  if (!filter || (!filter.onOnly && !filter.onGroup)) return null;
  return (
    <div className="adm-db-pop-filter">
      {filter.onOnly ? (
        <button
          type="button"
          className={`adm-db-pop-item plain${filter.active ? " on" : ""}`}
          onClick={() => { close(); filter.onOnly(); }}
        >
          {filter.active ? "✓ Showing only" : "Show only"} {filter.label}
        </button>
      ) : null}
      {filter.onGroup ? (
        <button
          type="button" className="adm-db-pop-item plain"
          onClick={() => { close(); filter.onGroup(); }}
        >
          Group the table by {filter.column}
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** A floating editor for text too long to read in a cell.
 *
 * Ryder, Aug 23 2026: *"when i click the description box and the text is larger
 * than the box then it pops it out so you can read the full description."*
 *
 * Deliberately NOT the Popover above: that one closes on any scroll, which
 * while you are typing a brief would throw the paragraph away. This closes on
 * Escape (cancel), on Save, or on a click outside (which SAVES — a click
 * elsewhere on the page is not "undo").
 */
function Popout({ anchor, trigger, title, hint, value, onSave, onCancel }) {
  const ref = useRef(null);
  const box = useRef(null);
  const [draft, setDraft] = useState(value || "");
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  const W = 520;

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    let left = Math.min(anchor.left, window.innerWidth - W - 14);
    if (left < 12) left = 12;
    let top = anchor.top - 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, window.innerHeight - h - 12);
    setPos({ left, top });
  }, [anchor]);

  useLayoutEffect(() => { place(); }, [place]);
  /* Reposition rather than close on a window change: closing would either lose
   * the text or save it behind your back, and neither is what resizing means. */
  useEffect(() => {
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place]);

  /* THREE SAVE PATHS, ONE SOURCE OF TRUTH. `latest` is written in onChange, not
   * in an effect: the outside-click listener is a native capture listener, so it
   * runs before React flushes passive effects, and an effect-written mirror was
   * one keystroke behind for anyone who typed and clicked away in the same
   * frame. `settled` stops the unmount guard double-saving. */
  const latest = useRef(value || "");
  const settled = useRef(false);
  const saveRef = useRef(onSave);
  useEffect(() => { saveRef.current = onSave; }, [onSave]);

  const commit = useCallback((v) => {
    if (settled.current) return;
    settled.current = true;
    saveRef.current(v);
  }, []);
  const cancel = useCallback(() => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  }, [onCancel]);

  /* THE BRIEF IS NOT THROWN AWAY IF THE ROW DISAPPEARS. A refresh from another
   * session, or a filter the row no longer matches, unmounts this editor. Before
   * this, 400 words vanished with no toast. On unmount anything unsaved is
   * saved. */
  useEffect(() => () => {
    if (!settled.current && latest.current !== (value || "")) saveRef.current(latest.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* The caret starts at the END of what is already written. autoFocus alone
   * leaves it at position 0, so the first thing typed landed in front of the
   * existing brief — watched happen on the first try. */
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const n = el.value.length;
    el.setSelectionRange(n, n);
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    const down = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      /* Dragging the window's own scrollbar is not "clicking away". */
      if (e.clientX > document.documentElement.clientWidth
        || e.clientY > document.documentElement.clientHeight) return;
      /* Clicking the cell this editor belongs to: save and close, and swallow
       * the click so the cell's own handler cannot reopen it in the same
       * gesture. Before this the obvious close gesture saved and reopened. */
      if (trigger && trigger.current && trigger.current.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
      commit(latest.current);
    };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [commit, cancel, trigger]);

  return createPortal(
    <div
      ref={ref} className="adm-db-popout" style={{ left: pos.left, top: pos.top, width: W }}
      role="dialog" aria-modal="true" aria-label={title}
    >
      <div className="adm-db-popout-head">
        <span className="label" style={{ marginBottom: 0 }}>{title}</span>
        <span className="adm-db-popout-hint">Esc to undo · click away to keep it</span>
      </div>
      <textarea
        ref={box}
        className="adm-db-popout-text"
        autoFocus
        value={draft}
        onChange={(e) => { latest.current = e.target.value; setDraft(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(latest.current); }
        }}
        placeholder={hint}
      />
      <div className="adm-db-popout-foot">
        <span className="adm-db-popout-hint">{draft.length} characters</span>
        <span style={{ display: "flex", gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={cancel}>Undo</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => commit(latest.current)}>Save</button>
        </span>
      </div>
    </div>,
    document.body,
  );
}

/** Long text that opens in the floating editor instead of editing in place.
 *  The cell shows the first lines; the whole thing is one click away. */
export function PopoutCell({ value, onChange, placeholder = "Empty", title = "Text", hint }) {
  const [anchor, setAnchor] = useState(null);
  const trigger = useRef(null);

  /* Focus goes back to the cell when the editor closes. Without it a keyboard
   * user landed on <body> and lost their place in the table. */
  const close = () => {
    setAnchor(null);
    requestAnimationFrame(() => trigger.current?.focus());
  };

  return (
    <>
      <button
        ref={trigger}
        type="button" className="adm-db-btn"
        title={value ? "Click to read and edit the whole thing" : undefined}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        {value
          ? <span className="adm-db-multiline">{value}</span>
          : <span className="adm-db-empty">{placeholder}</span>}
      </button>
      {anchor && (
        <Popout
          anchor={anchor}
          trigger={trigger}
          title={title}
          hint={hint}
          value={value || ""}
          onCancel={close}
          onSave={(v) => {
            close();
            /* Trailing whitespace only. A brief written as labelled sections can
             * end on a deliberate blank line, and a full trim ate it. */
            const next = String(v ?? "").replace(/\s+$/, "");
            if ((value || "") !== next) onChange(next || null);
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

/** One-of-a-list cell. options: [{ value, label, color }] */
export function SelectCell({ value, options, onChange, placeholder = "Empty", clearable = true, label, width, filter = null }) {
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
          <FilterHead filter={filter} close={() => setAnchor(null)} />
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
export function PersonCell({ value, options, onChange, filter = null }) {
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
          <FilterHead filter={filter} close={() => setAnchor(null)} />
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
export function TextCell({ value, onChange, placeholder = "Empty", multiline, strong, strike, required, title }) {
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
    /* `title` is the hover explanation. Added for the Sales sheet's First/Last
     * name cells, where a person has to be able to find out that the value they
     * are looking at was SPLIT from a full name rather than typed. */
    <button type="button" className="adm-db-btn" title={title} onClick={() => setEditing(true)}>
      {value
        ? (
          /* A multiline cell keeps its line breaks. Without this the brief you
           * typed as three labelled lines read back as one run-on paragraph. */
          <span className={[
            multiline ? "adm-db-multiline" : "",
            strong ? "adm-db-strong" : "",
            strike ? "adm-db-strike" : "",
          ].filter(Boolean).join(" ")}
          >{value}</span>
        )
        : <span className="adm-db-empty">{placeholder}</span>}
    </button>
  );
}

/** Due date. Red with a warning mark when it is late. */
export function DateCell({ value, onChange, overdue, filter = null }) {
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
          <FilterHead filter={filter} close={() => setAnchor(null)} />
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
