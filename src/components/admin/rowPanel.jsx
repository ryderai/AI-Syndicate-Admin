import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* CLICK ANY ROW, SEE MORE — one shell, every page. 12 Sep 2026.
 *
 * Ryder: "across the whole platform, any row that has a subject such as a job
 * or a client or anything like that, i need to be able to click that row and it
 * pop up the sidebar so i can see more."
 *
 * WHAT WAS THERE BEFORE. Exactly two things in the whole console opened a
 * panel: a task (taskDrawer.jsx) and a lead (salesProfile.jsx). Every other row
 * on every other page was dead — Clients, Tickets, Inbox, Notes, Overview,
 * Invoices, Team, Platform. Including the row in the screenshot that prompted
 * this: clicking a name on "People who need contacting" did nothing at all.
 *
 * ================================================================
 * WHY THIS IS A SHELL AND NOT A THIRD DRAWER
 * ================================================================
 *
 * The two panels that already exist are good and they stay. What was missing is
 * the OTHER NINE PAGES, and writing nine more panels would give this project
 * eleven ways to show a record. So this file is the frame — the slide-over, the
 * backdrop, the escape key, the next/previous stepping — and the pages hand it
 * their content.
 *
 * THE NAME COLLISION, WHICH IS NOT HYPOTHETICAL. `.adm-drawer` has belonged to
 * the Sales lead record since it was built, and a later drawer took the same
 * class and squashed its own header into a two-line column — the note is still
 * in admin.css at the `.adm-dw-` block. This shell uses `.adm-row-` and nothing
 * else, and it must stay that way.
 *
 * THE ONE RULE THE PAGES HAVE TO KEEP: clicking the ROW opens the panel;
 * clicking a CONTROL inside the row still does its own thing. `rowOpenProps`
 * below is how — it refuses any click that started inside a button, a link, an
 * input or anything marked data-no-row. Without that, "Call" and "Log it" on
 * the Work page would both open a panel instead of doing their job, and the
 * page would feel broken rather than richer.
 */

/**
 * The slide-over.
 *
 * @param onPrev / onNext  optional. When given, ↑/↓ and the two chevrons step
 *                         through the list behind the panel without closing it,
 *                         which is the whole point of a panel over a page: you
 *                         are reading a list, not one record.
 */
export default function RowPanel({
  open, onClose, kicker, title, subtitle, badges = [],
  onPrev = null, onNext = null, footer = null, children,
}) {
  const panelRef = useRef(null);

  const onKey = useCallback((e) => {
    if (e.key === "Escape") { onClose?.(); return; }
    /* ARROWS ONLY WHEN THE FOCUS IS NOT IN A FIELD. Somebody editing a note
     * inside the panel is using the up arrow to move the caret, and stealing it
     * to jump to another record would lose what they typed. */
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "ArrowUp" && onPrev) { e.preventDefault(); onPrev(); }
    if (e.key === "ArrowDown" && onNext) { e.preventDefault(); onNext(); }
  }, [onClose, onPrev, onNext]);

  useEffect(() => {
    if (!open) return undefined;
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onKey]);

  /* Focus moves into the panel when it opens, so the keyboard follows the eye
   * and a screen reader announces the record rather than leaving the user on a
   * row that is now behind a sheet. */
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open, title]);

  if (!open) return null;

  return createPortal(
    <div
      className="adm-row-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        className="adm-row-panel" role="dialog" aria-modal="true" aria-label={title || "Details"}
        ref={panelRef} tabIndex={-1}
      >
        <div className="adm-row-head">
          <div className="adm-row-headtop">
            {kicker && <div className="adm-row-kicker">{kicker}</div>}
            <div className="adm-row-steps">
              {(onPrev || onNext) && (
                <>
                  <button className="adm-row-step" onClick={onPrev} disabled={!onPrev} aria-label="Previous row" title="Previous (↑)">↑</button>
                  <button className="adm-row-step" onClick={onNext} disabled={!onNext} aria-label="Next row" title="Next (↓)">↓</button>
                </>
              )}
              <button className="adm-row-x" onClick={onClose} aria-label="Close">×</button>
            </div>
          </div>
          <div className="adm-row-title">{title}</div>
          {subtitle && <div className="adm-row-sub">{subtitle}</div>}
          {badges.length > 0 && (
            <div className="adm-row-badges">
              {badges.filter(Boolean).map((b, i) => (
                <span key={`${b.label}-${i}`} className={`adm-row-badge${b.tone ? ` adm-row-badge-${b.tone}` : ""}`} title={b.why || undefined}>
                  {b.label}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="adm-row-body">{children}</div>
        {footer && <div className="adm-row-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/* Making a row clickable                                              */
/* ------------------------------------------------------------------ */

/** Everything inside a row that must keep its own click. */
const INTERACTIVE = "button, a, input, textarea, select, label, [role='button'], [role='menuitem'], [data-no-row]";

/**
 * Spread onto a row element to make it open a panel.
 *
 *     <div className="adm-db-row" {...rowOpenProps(() => setOpenId(r.id))}>
 *
 * WHAT IT GUARANTEES, and why each one is here:
 *
 * 1. A CLICK THAT LANDED ON A CONTROL IS NOT A ROW CLICK. `closest()` on the
 *    real target, not the row, so a click on the text INSIDE a button counts as
 *    the button. Without this the Work page's Call, Email and Log it buttons
 *    would each also open a panel.
 * 2. A TEXT SELECTION IS NOT A CLICK. Dragging across a row to copy an email
 *    address ends in a click event, and opening a panel would throw away the
 *    selection they just made.
 * 3. IT WORKS FROM THE KEYBOARD. role=button and tabIndex, with Enter and
 *    Space, because a row that only opens for a mouse is a row half the console
 *    cannot reach.
 */
export function rowOpenProps(onOpen, { label = "Open details" } = {}) {
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    onClick: (e) => {
      /* THE ROW MUST NOT MATCH ITSELF, and this cost a real debugging round.
       *
       * The row carries role="button" so the keyboard can reach it. INTERACTIVE
       * also lists [role='button'] — so `e.target.closest(INTERACTIVE)` walked
       * up from wherever the click landed, found THE ROW, and returned early.
       * Every click was read as "that was a control, leave it alone", and not
       * one row opened. It looked exactly like the feature had never been
       * wired: no error, no console message, nothing to notice — found by
       * clicking a row in the built page, not by reading the code.
       *
       * So the search stops AT the row. Anything interactive strictly inside it
       * keeps its own click; the row itself is not one of those things. */
      const hit = e.target?.closest?.(INTERACTIVE);
      if (hit && hit !== e.currentTarget) return;
      /* A drag to select an email address ends in a click. Opening a panel
       * would throw away the selection they just made. */
      if (window.getSelection?.()?.toString()) return;
      onOpen();
    },
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
    },
  };
}

/* ------------------------------------------------------------------ */
/* The furniture inside a panel                                        */
/* ------------------------------------------------------------------ */

/**
 * A labelled block.
 *
 * A `div`, NOT A `section`, AND THAT IS DELIBERATE.
 *
 * src/index.css:256 styles the bare element — `section { padding: 96px 0 }` —
 * for the marketing-shaped pages. Every block in this panel inherited it, so
 * each one carried 96px of empty space above and below its own content: the
 * facts list sat in the middle of a 473px box and the panel looked broken.
 * Found by measuring the boxes in the built page, not by reading the CSS.
 *
 * A class on a `section` could win that fight at full width — but index.css
 * repeats the rule at 1783 and 1788 as `padding: … !important` inside media
 * queries, so at narrow widths it could not be overridden at all without a
 * second `!important`, and two files shouting at each other over the same
 * element is how this becomes somebody else's afternoon. Not being a `section`
 * costs nothing here: the heading carries the meaning, and the panel is already
 * a labelled dialog.
 */
export function PanelSection({ title, children, hint }) {
  return (
    <div className="adm-row-sect">
      {title && <h4 className="adm-row-sect-h">{title}</h4>}
      {hint && <div className="adm-row-hint">{hint}</div>}
      {children}
    </div>
  );
}

/**
 * Label / value pairs.
 *
 * A MISSING VALUE PRINTS "not recorded", NEVER A BLANK AND NEVER A ZERO. The
 * rule person-timeline.js sets in its Rule 4 and the Finance page keeps
 * everywhere: an empty source is not a zero, and the two look identical on
 * screen while meaning opposite things. A blank cell reads as "nothing to say";
 * "not recorded" reads as what it is.
 */
export function Facts({ rows }) {
  const live = (rows || []).filter(Boolean);
  if (!live.length) return null;
  return (
    <dl className="adm-row-facts">
      {live.map(([label, value, tone]) => (
        <div key={label} className="adm-row-fact">
          <dt>{label}</dt>
          <dd className={tone ? `adm-row-v-${tone}` : ""}>
            {/* ONLY ABSENCE READS AS ABSENT. `0` and `false` are answers.
                An earlier version listed `value === false` here, so a fact whose
                honest answer is "no" printed as "nobody filled this in" — the
                exact conflation the note above says this function exists to
                prevent. A renderer that wants a boolean shown as words should
                pass the words itself; a bare boolean prints as "Yes" or "No"
                rather than being quietly reclassified as missing. */}
            {value === null || value === undefined || value === ""
              ? <span className="adm-row-none">not recorded</span>
              : value === false ? "No" : value === true ? "Yes" : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The door to the full record. Every panel has one: this shell shows what a
 *  row holds, it does not replace the pages that can change it. */
export function PanelLink({ to, children }) {
  return (
    <button
      className="adm-row-golink"
      onClick={() => { window.location.hash = to; }}
    >
      {children} →
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* One hook so nine pages do not write the same six lines              */
/* ------------------------------------------------------------------ */

/**
 * Hold which row is open, and step through the list without closing.
 *
 * IT REMEMBERS THE ROW'S ID, NOT ITS POSITION. A list behind an open panel can
 * reorder underneath it — a lead gets touched and jumps up the "quiet" sort, a
 * task is ticked and leaves the view. Holding an index would then show a
 * DIFFERENT record under the same heading with nothing on screen changing, and
 * the next edit would land on the wrong one. The index is worked out fresh from
 * the id every render, which is also what makes the arrows honest: they step
 * through the list as it is NOW.
 *
 * A row that disappears from the list entirely closes the panel, rather than
 * leaving a record on screen that is no longer in the thing it was opened from.
 *
 *     const rows = useRowPanel(work.contactable);
 *     <div {...rowOpenProps(() => rows.open(l.id))} className="adm-row-able"> … </div>
 *     {rows.row && <SubjectPanel kind="lead" row={rows.row} {...rows.panelProps} />}
 */
export function useRowPanel(list) {
  const [openId, setOpenId] = useState(null);
  const items = useMemo(() => (Array.isArray(list) ? list : []), [list]);
  const idx = openId === null ? -1 : items.findIndex((r) => r?.id === openId);
  const row = idx >= 0 ? items[idx] : null;

  /* The id is set but no longer in the list — it was ticked off, reassigned,
   * filtered away. Close rather than show a stale record. */
  useEffect(() => {
    if (openId !== null && idx < 0) setOpenId(null);
  }, [openId, idx]);

  return {
    row,
    openId,
    open: setOpenId,
    close: () => setOpenId(null),
    panelProps: {
      open: Boolean(row),
      onClose: () => setOpenId(null),
      onPrev: idx > 0 ? () => setOpenId(items[idx - 1].id) : null,
      onNext: idx >= 0 && idx < items.length - 1 ? () => setOpenId(items[idx + 1].id) : null,
    },
  };
}
