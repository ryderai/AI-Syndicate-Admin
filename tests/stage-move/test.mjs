/* Tests for moving a lead through the pipeline — lib/stage-move.js.
 *
 * Run with:  bash tests/stage-move/run.sh
 *
 * Three different screens move a lead now: the chip on the sheet, the drop
 * target on the board, and the dropdown on the card. This file exists so those
 * three cannot drift apart — every one of them asks the functions below, and a
 * lead dragged onto Won has to behave exactly like a lead picked from a menu.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BOARD_STAGES, WORKING_COLUMN, REASON_STAGES, OFF_BOARD_STAGES, NOTE_MAX,
  isStageMove, needsReason, offersNote, cleanNote, stageMoveBody, dropCheck,
} from "../../lib/stage-move.js";

/* LEAD_STAGES IS READ AS TEXT, NOT IMPORTED. src/lib/data.js pulls in
 * src/lib/supabase.js, which reads `import.meta.env` — undefined under plain
 * node, so importing it throws before a single assertion runs. Every other suite
 * in this repo reads that file the same way for the same reason. */
const DATA_SRC = readFileSync(new URL("../../src/lib/data.js", import.meta.url), "utf8");
const LEAD_STAGES = (() => {
  const m = DATA_SRC.match(/export const LEAD_STAGES = \[([\s\S]*?)\];/);
  if (!m) throw new Error("LEAD_STAGES could not be read out of data.js — this test is now blind");
  return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
})();

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed += 1; results.push(`  ok   ${name}`); }
  catch (err) { failed += 1; results.push(`  FAIL ${name}\n       ${err.message}`); }
}

/* ================================================================== */
/* THE STAGES ARE THE DATABASE'S STAGES                                */
/* ================================================================== */

test("every board column is a stage the database will accept", () => {
  /* Read out of the migration rather than out of a fixture. A test whose
   * fixture agrees with the code proves the code agrees with itself — this
   * repo has shipped that mistake before. */
  /* The stage list lives in 0009_sales.sql's check constraint. Named
   * explicitly rather than globbed: if somebody moves it, this test should
   * fail loudly rather than quietly pass against some other file. */
  const live = readFileSync(new URL("../../supabase/migrations/0009_sales.sql", import.meta.url), "utf8")
    + readFileSync(new URL("../../supabase/migrations/0015_sales_lifecycle.sql", import.meta.url), "utf8");
  /* EVERY DROP TARGET must be a stage the database accepts TODAY. These are the
   * ones a person can write by dragging, so a value the constraint refuses is a
   * card that bounces back with a database error. */
  for (const stage of BOARD_STAGES) {
    assert.ok(live.includes(`'${stage}'`), `${stage} is a drop target the database would refuse`);
  }
  /* The read-only columns are a softer bar on purpose: they DRAW a stage, they
   * never write one. `not_a_fit` is drawn before migration 0027 creates it, so
   * the board is already right the moment that runs — but it must at least be
   * named in a migration somebody can point at, or it is a typo. */
  const pending = live + readFileSync(new URL("../../supabase/migrations/0027_pipeline_spec.sql", import.meta.url), "utf8");
  for (const stage of OFF_BOARD_STAGES) {
    assert.ok(pending.includes(`'${stage}'`), `${stage} appears in no migration at all`);
  }
});

test("the board's columns are in pipeline order and hold no duplicates", () => {
  assert.equal(new Set(BOARD_STAGES).size, BOARD_STAGES.length);
  /* WAS `BOARD_STAGES[0] === "new"`. The four early stages came off the board on
   * 30 Aug because they are derived — nothing may set them, so a column you drag
   * a card INTO would be typing a second copy of the timeline by hand. */
  assert.equal(BOARD_STAGES[0], "follow_up");
  assert.deepEqual(BOARD_STAGES.slice(-2), ["won", "lost"]);
  for (const s of ["new", "researching", "contacted", "in_conversation"]) {
    assert.ok(!BOARD_STAGES.includes(s), `${s} is derived and must not be a drop target`);
  }
});

test("NOTHING IS INVISIBLE ON THE BOARD — the derived stages have a column of their own", () => {
  /* Shrinking BOARD_STAGES without this would have repeated the defect an audit
   * found the same morning: a lead at an off-board stage matched no column and
   * was drawn NOWHERE. Not greyed, not bucketed — gone. */
  assert.ok(WORKING_COLUMN, "there has to be somewhere for the derived stages to show");
  for (const s of ["new", "researching", "contacted", "in_conversation", "reopened"]) {
    assert.ok(WORKING_COLUMN.stages.includes(s), `${s} is drawn nowhere`);
  }
  /* And it must not also be a drop target, or the stage becomes settable again
   * through the back door. */
  for (const s of WORKING_COLUMN.stages) {
    assert.ok(!BOARD_STAGES.includes(s), `${s} is both derived and droppable`);
    assert.equal(dropCheck({ editable: true, from: "follow_up", to: s }).ok, false,
      `a card can be dropped into the derived stage ${s}`);
  }
  /* Between them, the two lists have to account for every stage that is not a
   * deliberate resting place — otherwise the next stage somebody adds is
   * invisible and nobody finds out for a month. */
  const drawn = [...BOARD_STAGES, ...WORKING_COLUMN.stages];
  for (const s of LEAD_STAGES) {
    assert.ok(drawn.includes(s) || OFF_BOARD_STAGES.includes(s),
      `${s} appears in no board column and is not a declared resting place`);
  }
});

test("the resting stages are NOT board columns", () => {
  /* skip_90, bad_contact and reopened are places a lead lands, not steps
   * somebody walks it through. A column for each would be three columns nobody
   * ever drags anything into. */
  for (const s of OFF_BOARD_STAGES) assert.ok(!BOARD_STAGES.includes(s), `${s} is a column`);
});

/* ================================================================== */
/* WHAT COUNTS AS A MOVE                                               */
/* ================================================================== */

test("dropping a card back where it came from is not a move", () => {
  assert.equal(isStageMove("meeting", "meeting"), false);
  assert.equal(offersNote("meeting", "meeting"), false);
  assert.equal(needsReason("won", "won"), false, "a lead already Won must not re-open the reason box");
});

test("a lead with no stage at all can still be moved", () => {
  assert.equal(isStageMove(null, "contacted"), true);
  assert.equal(isStageMove(undefined, "contacted"), true);
});

test("a move to nothing is not a move", () => {
  assert.equal(isStageMove("new", null), false);
  assert.equal(isStageMove("new", ""), false);
});

/* ================================================================== */
/* WON AND LOST GO THROUGH THE REASON BOX, NOT THE NOTE BOX            */
/* ================================================================== */

test("Won and Lost ask for a reason and NOT for a note", () => {
  /* Asking for the same sentence twice in a row teaches people to close both
   * boxes. The reason box has existed since Aug 27 and it IS the note. */
  for (const s of REASON_STAGES) {
    assert.equal(needsReason("contacted", s), true, `${s} does not ask for a reason`);
    assert.equal(offersNote("contacted", s), false, `${s} asks for a note as well`);
  }
});

test("every other stage offers the note and never the reason box", () => {
  /* From a stage that is not the one being tested — moving a lead to where it
   * already is is not a move, and this test is about the stages, not that. */
  for (const s of BOARD_STAGES.filter((x) => !REASON_STAGES.includes(x))) {
    const from = s === "new" ? "contacted" : "new";
    assert.equal(offersNote(from, s), true, `${s} does not offer a note`);
    assert.equal(needsReason(from, s), false, `${s} opens the reason box`);
  }
});

/* ================================================================== */
/* THE NOTE                                                            */
/* ================================================================== */

test("a note is trimmed, flattened to one line, and empty means none", () => {
  assert.equal(cleanNote("  booked   for\n\ntue  "), "booked for tue");
  assert.equal(cleanNote("   "), null);
  assert.equal(cleanNote(""), null);
  assert.equal(cleanNote(null), null);
  assert.equal(cleanNote(undefined), null);
  assert.equal(cleanNote(42), null, "a number is not a note");
});

test("a very long note is cut rather than refused", () => {
  /* A rep pasting half an email into the box should not lose the move. */
  const long = "x".repeat(NOTE_MAX + 200);
  const out = cleanNote(long);
  assert.equal(out.length, NOTE_MAX);
  assert.ok(out.endsWith("…"), "a cut note must say it was cut");
});

test("the timeline line reads as a sentence, with and without a note", () => {
  assert.equal(stageMoveBody("Contacted", "Meeting"), "Contacted → Meeting");
  assert.equal(stageMoveBody("Contacted", "Meeting", "booked for tue"),
    'Contacted → Meeting — "booked for tue"');
});

test("a lead with no previous stage does not print 'undefined'", () => {
  /* Every contact the import created without a stage would have read
   * "undefined → Contacted" on its own timeline, for ever. */
  assert.equal(stageMoveBody(null, "Contacted"), "Set to Contacted");
  assert.equal(stageMoveBody("", "Contacted", "cold call"), 'Set to Contacted — "cold call"');
});

test("a whitespace-only note does not produce empty quotes", () => {
  assert.equal(stageMoveBody("New", "Contacted", "   "), "New → Contacted");
});

/* ================================================================== */
/* THE DROP                                                            */
/* ================================================================== */

test("a rep cannot drag somebody else's lead into another column", () => {
  /* The row lock the whole Floor runs on. A card you can pick up and drag
   * across the screen, only to have the write refused, is worse than a card
   * that will not lift — so the board asks before it writes, as well as the
   * database asking after. */
  const r = dropCheck({ editable: false, from: "new", to: "meeting" });
  assert.equal(r.ok, false);
  assert.match(r.why, /holds this lead/);
});

test("dropping on the column it is already in changes nothing and says nothing", () => {
  const r = dropCheck({ editable: true, from: "meeting", to: "meeting" });
  assert.equal(r.ok, false);
  assert.equal(r.moved, false);
  assert.equal(r.why, "It is already there.");
});

test("a drop on something that is not a column is refused", () => {
  assert.equal(dropCheck({ editable: true, from: "new", to: "skip_90" }).ok, false,
    "skip_90 is a real stage but not a column — nothing can be dropped on it");
  assert.equal(dropCheck({ editable: true, from: "new", to: "banana" }).ok, false);
  assert.equal(dropCheck({ editable: true, from: "new", to: null }).ok, false);
  assert.equal(dropCheck({}).ok, false, "an empty call must not read as a valid drop");
});

test("a real drop is allowed and says whether the reason box is coming", () => {
  const plain = dropCheck({ editable: true, from: "contacted", to: "meeting" });
  assert.equal(plain.ok, true);
  assert.equal(plain.needsReason, false);

  const won = dropCheck({ editable: true, from: "proposal", to: "won" });
  assert.equal(won.ok, true);
  assert.equal(won.needsReason, true, "dragging onto Won must still create the client through the reason box");
});

test("the lock is checked AFTER the is-it-a-move check, so a no-op is never scolded", () => {
  /* Dropping somebody else's card back on its own column should say "it is
   * already there", not accuse the rep of trying to steal a lead. */
  const r = dropCheck({ editable: false, from: "meeting", to: "meeting" });
  assert.equal(r.why, "It is already there.");
});

/* ================================================================== */
/* THE SCREENS AGREE WITH THIS FILE                                    */
/* ================================================================== */

const SHEET = readFileSync(new URL("../../src/components/admin/salesSheet.jsx", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../../src/components/admin/SalesPage.jsx", import.meta.url), "utf8");
const PICKER = readFileSync(new URL("../../src/components/admin/chipPicker.jsx", import.meta.url), "utf8");
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SHEET_CODE = strip(SHEET);
const PAGE_CODE = strip(PAGE);

test("the board reads the shared stage list, not its own copy", () => {
  /* It had its own `const BOARD_STAGES = [...]`. Two lists of stages is two
   * lists to forget to update. */
  assert.ok(!/const\s+BOARD_STAGES\s*=/.test(PAGE_CODE), "SalesPage still defines its own stage list");
  assert.ok(/import\s*\{[^}]*BOARD_STAGES[^}]*\}\s*from\s*"[^"]*stage-move\.js"/.test(PAGE_CODE),
    "SalesPage does not import the shared list");
});

test("the board asks dropCheck before it writes", () => {
  assert.ok(/dropCheck\(/.test(PAGE_CODE), "nothing on the board calls dropCheck");
  assert.ok(/draggable=/.test(PAGE_CODE), "the cards are not draggable");
  assert.ok(/onDrop=/.test(PAGE_CODE), "the columns take no drop");
});

test("the board and the sheet write through the SAME function", () => {
  /* If the board had its own upsert, a lead dragged onto Won would not create
   * a client and nobody would notice for a month. */
  assert.ok(/onMove=\{\(lead, stage, note\) => patchLead\(/.test(PAGE_CODE),
    "the board does not write through patchLead");
  /* Scoped to PipelineView's own body. Slicing to the end of the file swept in
   * AddContactModal, which legitimately calls upsertLead — a test that fails
   * for a reason it does not name is a test nobody trusts. */
  const from = PAGE_CODE.indexOf("function PipelineView");
  const body = PAGE_CODE.slice(from, PAGE_CODE.indexOf("function FirmsView", from));
  assert.ok(from > -1 && body.length > 200, "PipelineView could not be found");
  assert.ok(!/upsertLead\(/.test(body), "the board writes to the database directly");
  assert.ok(!/addLeadActivity\(/.test(body), "the board writes its own timeline line");
});

test("the timeline line is built by stageMoveBody, not by hand", () => {
  assert.ok(/stageMoveBody\(/.test(PAGE_CODE), "the page builds the timeline line itself");
  assert.ok(!/→ \$\{LEAD_STAGE_LABELS/.test(PAGE_CODE), "the hand-built arrow line is back");
});

test("the sheet's rows open the record, and only the chips stop the click", () => {
  assert.ok(/<tr[\s\S]{0,900}?onClick=\{\(\) => onOpen\(row\.id\)\}/.test(SHEET_CODE),
    "the row does not open the record");
  /* The reading cells must be spans. A <button> would swallow the click and
   * the row would do nothing on nine of its columns. */
  assert.ok(/const plainCell = [\s\S]{0,400}?<span/.test(SHEET_CODE),
    "the reading cell is not a plain span");
});

test("no free-text editing is left on a sheet row", () => {
  /* Ryder: "i want everything simple". TextCell, PopoutCell and the person
   * dropdown all went to the card. */
  for (const gone of ["TextCell", "PopoutCell", "PersonCell", "SelectCell"]) {
    assert.ok(!SHEET_CODE.includes(`<${gone}`), `${gone} is still on a sheet row`);
  }
});

test("there is no way to invent a tag or a status from the sheet", () => {
  /* "i dont want to be able to add tags." The picker offers a fixed list and
   * has no text input in it at all. */
  const picker = strip(PICKER);
  assert.ok(!/<input/.test(picker), "the picker has a text input in it");
  assert.ok(/options\.map/.test(picker), "the picker does not render a fixed list");
  assert.ok(picker.includes("This list is fixed"), "the panel does not say the list is fixed");
});

test("the note is written AFTER the move, never before it", () => {
  /* The order is the whole design: one click moves the lead, and walking away
   * from the note box loses nothing. */
  const picker = strip(PICKER);
  const pickAt = picker.indexOf("await onPick(");
  const noteAt = picker.indexOf("setNoted(next)");
  assert.ok(pickAt > -1 && noteAt > pickAt, "the note step is not after the write");
  assert.ok(/if \(!ok \|\| wantsReason \|\| !wantsNote\)/.test(picker),
    "a refused write can still open the note box");
});

test("the picker's own panel stops its clicks reaching the row", () => {
  /* A React event bubbles through the REACT tree, not the DOM one, so a click
   * on an option inside the popover arrived at the <tr> underneath and opened
   * the client card on top of the menu — every single time a stage was picked.
   * Found by clicking it in a browser on 30 Aug 2026. */
  const picker = strip(PICKER);
  assert.ok(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(picker),
    "the panel lets its clicks through to the row");
  assert.ok(/onMouseDown=\{\(e\) => e\.stopPropagation\(\)\}/.test(picker),
    "a mousedown still reaches the row");
});

test("the board's note box stops its clicks too", () => {
  const from = PAGE_CODE.indexOf("function PipelineView");
  const body = PAGE_CODE.slice(from, PAGE_CODE.indexOf("function FirmsView", from));
  assert.ok(/stopPropagation/.test(body), "the board's popover lets clicks through to the card behind it");
});

test("the Do column is one number in one place", () => {
  /* It was 46 in the colgroup and 210 in the header, and `table-layout: fixed`
   * reads the colgroup — so every row's buttons were cut off the right edge.
   * Ryder, 30 Aug 2026: "make sure the rows on the end dont get cut off." */
  assert.ok(/const DO_COLUMN_WIDTH = \d+;/.test(SHEET_CODE), "the width is not a constant");
  assert.equal((SHEET_CODE.match(/DO_COLUMN_WIDTH/g) || []).length, 3,
    "the Do width is declared once and used in exactly two places");
  assert.ok(!/<col style=\{\{ width: 46 \}\} \/>/.test(SHEET_CODE), "the 46px column is back");
});

/* ================================================================== */

console.log("\nMOVING A LEAD THROUGH THE PIPELINE\n");
console.log(results.join("\n"));
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
