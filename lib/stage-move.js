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
/* SIX COLUMNS SINCE 2 SEP 2026 — Meeting became Meeting booked and Meeting
 * complete (migration 0030). THE ARRAY ORDER IS THE COLUMN ORDER on screen, so
 * complete sits between booked and proposal, which is the order the work
 * actually happens in. A test compares this list against PICKABLE_STAGES so the
 * board and the pickers can never offer different stages. */
export const BOARD_STAGES = ["follow_up", "meeting_booked", "meeting_complete", "proposal", "won", "lost"];

/** The read-only first column. Holds every lead at a stage the system derives,
 *  so nothing on the board is invisible. You can drag OUT of it — dropCheck only
 *  ever tests the destination — and there is nothing to drag INTO it, which is
 *  the point. */
export const WORKING_COLUMN = {
  id: "__working",
  label: "Working",
  help: "Claimed and being worked. The system decides this one — move a card out when something real happens.",
  /* `meeting` is here since 2 Sep 2026, and it is not a derived stage — it is
   * the PRE-0030 single Meeting stage. 0030 split it and moved every row, so
   * nothing can be in it and nothing may be dropped on it, but a row restored
   * from a backup or a stale export has to be DRAWN somewhere. "Working" is the
   * honest column for it: an open lead somebody was working, at a stage that no
   * longer exists. The alternative — the Not a fit column — would say something
   * about the deal that is not true. */
  stages: ["new", "researching", "contacted", "in_conversation", "reopened", "meeting"],
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

/**
 * WHAT A STAGE WILL NOT LET YOU LEAVE WITHOUT.
 *
 * HubSpot ships this as a Required checkbox on the stage that blocks the save;
 * Salesforce does it with a validation formula. We already do it for Won and
 * Lost — those two ask for a written reason and have since Aug 27, and that box
 * is deliberately NOT listed here because it is a different, richer flow.
 *
 * `field` is the column that must not be empty. `ask` is what the rep is asked
 * for, in their words. There is deliberately no gate on anything earlier: the
 * early stages are derived now, and nothing should ever stand between a rep and
 * logging a call.
 */
/* WRITTEN AGAINST COLUMNS THAT EXIST. The first draft of this required
 * `meeting_at` and `proposal_amount`, and NEITHER IS A COLUMN — I invented both
 * while writing the rule. That is the exact failure this repo has a note about:
 * three files once wrote column names the tables do not have, and every fixture
 * agreed with them. Checked against the migrations before this shipped.
 *
 *   follow_up         → admin_leads.next_follow_up_at   (0002, real), future
 *   meeting_booked    → admin_leads.meeting_at          (0030, real), future
 *   meeting_complete  → admin_leads.meeting_at          (0030, real), any date
 * MEETING GOT ITS OWN COLUMN ON 2 SEP 2026, and `meeting_at` is now real —
 * migration 0030. It used to share `next_follow_up_at`, which was wrong the
 * moment a meeting could be COMPLETE: a past date on that column means OVERDUE
 * everywhere (the sweep, My Day, "Follow-up was due N days ago"), so every
 * finished meeting would have sat on the overdue list for ever.
 *
 * `field` says which column and `when` says which direction the date points. A
 * booked meeting in the past is not booked; a completed meeting in the future
 * has not happened.
 *   proposal   → a row in admin_proposals with an amount (0009, real). Not a
 *                column on the lead — proposals are their own records, and
 *                copying the number onto the lead would be a second copy that
 *                stops matching.
 */
export const STAGE_REQUIRES = {
  follow_up: {
    kind: "date",
    field: "next_follow_up_at",
    when: "future",
    ask: "When are you picking this back up?",
    why: "“Waiting on them” with no date is the definition of a forgotten lead.",
  },
  meeting_booked: {
    kind: "date",
    field: "meeting_at",
    when: "future",
    ask: "When is the meeting?",
    why: "A meeting nobody wrote a date for is not booked, and it cannot be counted, reminded about, or prepared for.",
  },
  meeting_complete: {
    kind: "date",
    field: "meeting_at",
    /* `past`, NOT `any`. The first draft said `any`, and both this file and
     * migration 0030 then claimed in prose that a completed meeting's date "is
     * in the past" while the code accepted next March. A checker caught the
     * sentence and the code disagreeing. */
    when: "past",
    ask: "When did the meeting happen?",
    why: "This is the date every meeting number is counted from. Without it, “we had four meetings” cannot be checked.",
  },
  proposal: {
    kind: "proposal",
    ask: "Add the proposal and its amount first.",
    why: "A pipeline you cannot total is a list.",
  },
};

/**
 * Does this lead already satisfy the stage's requirement?
 *
 * `proposals` is the board's proposals array — passed in rather than fetched, so
 * this answers from the same snapshot the screen is drawing. An unreadable date
 * counts as MISSING, which is the safe direction: asking twice costs a click,
 * and letting a lead through on a date nothing can parse is a lead that never
 * comes back.
 */
export function stageRequirementMet(stage, lead, { proposals = [] } = {}) {
  const need = STAGE_REQUIRES[stage];
  if (!need || !lead) return true;
  if (need.kind === "date") {
    /* IN THE FUTURE, not merely readable. A bare Date.parse accepted last
     * March, so "When is the meeting?" was satisfied by a date that had already
     * been and gone — and the lead then landed straight on the "No next step"
     * list, which correctly treats a past date as no plan. Two rules about one
     * column disagreeing is the defect this whole rebuild started with. */
    const at = Date.parse(lead[need.field || "next_follow_up_at"]);
    if (!Number.isFinite(at)) return false;
    /* THREE DIRECTIONS, and each one is a different fact.
     *   future  a plan — a follow-up owed, a meeting booked
     *   past    something that happened — a meeting completed
     *   any     a date, either way (nothing uses this today)
     * Demanding the future for a completed meeting would make the stage
     * unreachable; accepting the future would let "we met next March" through.
     * Both have been in this function at some point today. */
    if (need.when === "future") return at > Date.now();
    if (need.when === "past") return at <= Date.now();
    return true;
  }
  if (need.kind === "proposal") {
    return (proposals || []).some(
      (p) => p.lead_id === lead.id && Number.isFinite(Number(p.amount_cents)) && Number(p.amount_cents) > 0,
    );
  }
  return true;
}

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
/* `meeting` joined this list on 2 Sep 2026. Migration 0030 split it into
 * meeting_booked and meeting_complete and moved every row, so nothing can be in
 * it and nothing may be dropped on it — but a value that sat in the database for
 * months can come back from a backup or an old export, and the board's own test
 * requires every stage to be drawn SOMEWHERE. A resting place, not a column. */
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
