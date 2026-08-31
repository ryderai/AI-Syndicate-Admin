/* MOVING A LEAD THROUGH THE PIPELINE — the rules, with no screen attached.
 *
 * Ryder, 30 Aug 2026: "i want it so that its a normal row that when you click
 * anything that isnt a tag it opens the client card. but on the tages, wgen you
 * click it you get a set of premade tags and then when you click a tag you can
 * add a optional note. i dont want to be able to add tags, i want everything
 * simple, one click movement through the pipeline. also in the pipeline i want
 * to be able to drag the client over into new pipes and have the tag update
 * with it."
 *
 * And, on why: "the goal is to make the salesmans job as easy as possible …
 * we have friggin 3000+ leads, we need to be able to do this at scale."
 *
 * THREE PLACES MOVE A LEAD NOW: the chip on the sheet, the drop target on the
 * board, and the dropdown in the card. This file is what all three ask, so a
 * lead dragged onto Won cannot behave differently from one picked from a menu.
 * Every function here is pure — no React, no database, no clock — which is what
 * makes tests/stage-move able to attack the rules directly.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: invent a stage. The list is fixed and comes
 * from the database's own check constraint. "i dont want to be able to add
 * tags" is a rule, not a preference — a free-text status column is the thing
 * the Google sheet had, and it is why nobody could count anything in it.
 */

/** The stages that appear as DROP TARGETS on the board, in pipeline order.
 *
 * 30 AUG 2026 — the four early ones came off. They are derived now (see
 * PICKABLE_STAGES in src/lib/data.js): the activity log decides whether we have
 * reached out, so dragging a card into "Contacted" would be typing a second copy
 * of the timeline by hand. Nothing may set them, here or anywhere.
 *
 * THE LEADS HOLDING THEM DID NOT VANISH. The board draws two read-only columns
 * — WORKING_COLUMN for the derived stages, PARKED_COLUMN for the not-a-fit
 * ones — so every stage is drawn somewhere.
 *
 * The first version of this comment claimed the Working column fixed the
 * invisibility for `skip_90`, `bad_contact` AND `reopened`. It held only
 * `reopened`; the other two were still drawn nowhere, which is the exact defect
 * an audit had found that morning. A checker caught the comment describing a
 * fix the code had not made. PARKED_COLUMN is that fix. */
export const BOARD_STAGES = ["follow_up", "meeting", "proposal", "won", "lost"];

/** The read-only first column. Holds every lead at a stage the system derives,
 *  so nothing on the board is invisible. You can drag OUT of it — dropCheck only
 *  ever tests the destination — and there is nothing to drag INTO it, which is
 *  the point. */
export const WORKING_COLUMN = {
  id: "__working",
  label: "Working",
  help: "Claimed and being worked. The system decides this one — move a card out when something real happens.",
  stages: ["new", "researching", "contacted", "in_conversation", "reopened"],
};

/** The other read-only column: leads that are finished with but not won or lost.
 *  Also not a drop target — "not a fit" carries a reason, and a reason cannot be
 *  supplied by dragging. `not_a_fit` is listed before migration 0027 creates it,
 *  so the column is right the moment it runs. */
export const PARKED_COLUMN = {
  id: "__parked",
  label: "Not a fit",
  help: "Not going to work — the score, the contact details, or the kind of business. Set it from the row, where it asks for a reason.",
  stages: ["skip_90", "bad_contact", "not_a_fit"],
};

/** Every stage that is drawn somewhere on the board. If a stage is in neither
 *  this nor BOARD_STAGES, it is invisible — which is the failure both read-only
 *  columns exist to prevent, and what tests/stage-move asserts against. */
export const READ_ONLY_COLUMNS = [WORKING_COLUMN, PARKED_COLUMN];

/** The two that are not ordinary field edits.
 *
 * Won creates a client record; Lost is the answer to the most useful question
 * in sales. Both already open a reason box (Aug 27 2026), and that box IS the
 * note — so a move to either one must never also ask for an optional note, or
 * the same person is asked to explain the same act twice in a row. */
export const REASON_STAGES = ["won", "lost"];

/** Stages that are a resting place rather than a step — no drop target of their
 *  own. They are DRAWN, in the two read-only columns above; "off the board" here
 *  has only ever meant "you cannot drag a card into it".
 *
 *  It used to list exactly the three that were invisible, which made it read as
 *  a list of things nobody had to draw. Kept, corrected, and now derived from
 *  the two columns so it cannot drift from them. */
export const OFF_BOARD_STAGES = [...WORKING_COLUMN.stages, ...PARKED_COLUMN.stages];

/** Is this actually a change? Dropping a card back where it came from, or
 * picking the stage a lead is already on, is not a move and must not write a
 * row, log a timeline line, or ask for a note. */
export function isStageMove(from, to) {
  if (!to) return false;
  return from !== to;
}

/** Does this move go through the reason box instead of the note box? */
export function needsReason(from, to) {
  return isStageMove(from, to) && REASON_STAGES.includes(to);
}

/** Does this move offer the optional note afterwards? */
export function offersNote(from, to) {
  return isStageMove(from, to) && !REASON_STAGES.includes(to);
}

/* A note is a sentence somebody typed in a hurry between calls. It is trimmed,
 * capped, and its newlines are flattened — a timeline line is one line. */
export const NOTE_MAX = 400;

export function cleanNote(note) {
  if (typeof note !== "string") return null;
  const flat = note.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > NOTE_MAX ? `${flat.slice(0, NOTE_MAX - 1)}…` : flat;
}

/**
 * The one line that goes on the person's timeline.
 *
 * Labels are passed in rather than looked up, because the label table lives in
 * src/lib/data.js next to the database client and this file has to stay
 * importable by a plain node test.
 *
 * A lead with no previous stage reads "Set to Meeting", not "undefined →
 * Meeting" — which is what the first version printed for every lead the import
 * created without one.
 */
export function stageMoveBody(fromLabel, toLabel, note = null) {
  const to = String(toLabel || "").trim();
  const from = String(fromLabel || "").trim();
  const head = from ? `${from} → ${to}` : `Set to ${to}`;
  const n = cleanNote(note);
  return n ? `${head} — "${n}"` : head;
}

/**
 * May this row be dropped on this column, and if not, what do we tell them?
 *
 * `editable` is the row lock the whole Floor runs on: a rep may change a lead
 * they hold or one nobody holds, and somebody else's row is readable and not
 * writable. The board has to enforce it too — a card you can pick up and drag
 * across the screen, only to have the write refused, is worse than a card that
 * will not lift.
 */
export function dropCheck({ editable = false, from = null, to = null } = {}) {
  if (!to || !BOARD_STAGES.includes(to)) {
    return { ok: false, moved: false, why: "That is not a pipeline column." };
  }
  if (!isStageMove(from, to)) {
    return { ok: false, moved: false, why: "It is already there." };
  }
  if (!editable) {
    return { ok: false, moved: false, why: "Somebody else holds this lead. You can read it, not move it." };
  }
  return { ok: true, moved: true, why: null, needsReason: needsReason(from, to) };
}
