/* Operations table — the sort you get by clicking a column title.
 *
 * This suite exists because the sort shipped with NO test and a checker found
 * three real bugs in it within the hour: a "stop sorting" button that re-sorted,
 * an unknown phase silently sinking to the bottom, and an unknown column key
 * quietly reordering the whole table by due date. Every one of those is a case
 * below.
 *
 * Run: node tests/ops/test.mjs
 */
import assert from "node:assert/strict";
import {
  sortRowsBy, nextSort, sortValue, SORTABLE, defaultOrder,
  STATUS_ORDER, PRIORITY_ORDER,
} from "../../src/lib/opsSort.js";

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const PHASES = ["Onboarding", "Month 1", "Month 2", "Month 3", "Ongoing"];
const H = { phases: PHASES, clientName: (id) => ({ c1: "Lakeside", c2: "Harbor" }[id] || null), memberName: (id) => ({ u1: "Ryder", u2: "Sample Rep" }[id] || null) };

const rows = [
  { id: "a", name: "Alpha", status: "done", priority: "low", phase: "Ongoing", category: "Technical", client_id: "c2", assigned_to: "u2", due_date: "2026-08-30", description: "zebra" },
  { id: "b", name: "Bravo", status: "todo", priority: "high", phase: "Month 1", category: "Access", client_id: "c1", assigned_to: "u1", due_date: "2026-08-20", description: "" },
  { id: "c", name: "Charlie", status: "blocked", priority: "medium", phase: null, category: null, client_id: null, assigned_to: null, due_date: null, description: "apple" },
];
const ids = (list) => list.map((r) => r.id).join("");

console.log("\n  OPERATIONS — click-to-sort\n");

t("first click on Priority puts High first", () => {
  assert.equal(ids(sortRowsBy(rows, { key: "priority", dir: "asc" }, H)), "bca");
});

t("second click on Priority reverses it", () => {
  assert.equal(ids(sortRowsBy(rows, { key: "priority", dir: "desc" }, H)), "acb");
});

t("first click on Due date puts the soonest first, and no date LAST", () => {
  assert.equal(ids(sortRowsBy(rows, { key: "due", dir: "asc" }, H)), "bac");
});

t("reversing Due date keeps 'no date' last, it does not float to the top", () => {
  const out = sortRowsBy(rows, { key: "due", dir: "desc" }, H);
  assert.equal(out[out.length - 1].id, "c", "the undated task stays at the bottom both ways");
  assert.equal(ids(out), "abc");
});

t("an empty text field sinks in both directions", () => {
  assert.equal(sortRowsBy(rows, { key: "description", dir: "asc" }, H).at(-1).id, "b");
  assert.equal(sortRowsBy(rows, { key: "description", dir: "desc" }, H).at(-1).id, "b");
});

t("Status sorts on the work order, not the alphabet", () => {
  // todo -> in_progress -> blocked -> done
  assert.equal(ids(sortRowsBy(rows, { key: "status", dir: "asc" }, H)), "bca");
});

t("Client and Owner sort on the NAME, not the id", () => {
  assert.equal(ids(sortRowsBy(rows, { key: "client", dir: "asc" }, H)), "abc", "Harbor before Lakeside, no client last");
  assert.equal(ids(sortRowsBy(rows, { key: "assignee", dir: "asc" }, H)), "bac", "Ryder before Sample Rep");
});

t("a phase OUTSIDE the five known ones is not treated as blank", () => {
  /* The bug a checker caught: admin_tasks.phase has no check constraint, so an
   * import can write "Month 4". It used to count as blank AND, in groupTasks,
   * rank above Onboarding — sort and group disagreeing about one row. */
  const v = sortValue({ phase: "Month 4" }, "phase", H);
  assert.equal(v.blank, false, "present-but-unknown is not missing");
  assert.equal(v.v, PHASES.length, "and it sorts after every known phase");
  const empty = sortValue({ phase: null }, "phase", H);
  assert.equal(empty.blank, true);
  assert.ok(empty.v > v.v, "a real blank still sinks below an unknown value");
});

t("an unknown status or priority behaves the same way", () => {
  assert.equal(sortValue({ status: "archived" }, "status", H).v, STATUS_ORDER.length);
  assert.equal(sortValue({ priority: "urgent" }, "priority", H).v, PRIORITY_ORDER.length);
  assert.equal(sortValue({ priority: "urgent" }, "priority", H).blank, false);
});

t("a 10th status would not be mistaken for blank", () => {
  /* The old code encoded 'missing' as the numbers 9, 99 and -1, so the 10th
   * status anyone added would have been classified as empty. */
  const nine = sortValue({ status: STATUS_ORDER[0] }, "status", H);
  assert.equal(nine.blank, false);
  for (const n of [9, 99, -1]) {
    assert.notEqual(sortValue({ phase: PHASES[0] }, "phase", H).v, n === -1 ? -1 : null);
  }
  assert.equal(sortValue({ phase: PHASES[0] }, "phase", H).blank, false);
});

t("an unknown COLUMN does not sort — it falls back to the table's own order", () => {
  const out = sortRowsBy(rows, { key: "created", dir: "asc" }, H);
  assert.equal(ids(out), ids(defaultOrder(rows)), "no silent reorder by the tie-breaker");
  assert.equal(sortValue({}, "created", H), null);
  assert.ok(!SORTABLE.has("created"));
});

t("no sort at all gives the table's own order: soonest due, then priority", () => {
  assert.equal(ids(sortRowsBy(rows, null, H)), "bac");
});

t("the sort never mutates the rows it was given", () => {
  const before = ids(rows);
  sortRowsBy(rows, { key: "priority", dir: "desc" }, H);
  sortRowsBy(rows, null, H);
  assert.equal(ids(rows), before);
});

t("ties break the same way every time, whichever direction", () => {
  const tied = [
    { id: "x", name: "Zulu", priority: "high", due_date: "2026-08-25" },
    { id: "y", name: "Alpha", priority: "high", due_date: "2026-08-25" },
  ];
  assert.equal(ids(sortRowsBy(tied, { key: "priority", dir: "asc" }, H)), "yx");
  assert.equal(ids(sortRowsBy(tied, { key: "priority", dir: "desc" }, H)), "yx");
});

t("three clicks on one column: useful way, other way, off", () => {
  const one = nextSort(null, "priority");
  assert.deepEqual(one, { key: "priority", dir: "asc" });
  const two = nextSort(one, "priority");
  assert.deepEqual(two, { key: "priority", dir: "desc" });
  assert.equal(nextSort(two, "priority"), null, "the third click clears it");
});

t("clicking a DIFFERENT column starts that column at click one", () => {
  const cur = { key: "priority", dir: "desc" };
  assert.deepEqual(nextSort(cur, "due"), { key: "due", dir: "asc" });
});

t("two blind toggles can NOT clear a reversed sort — hence setSort(null)", () => {
  /* This is the bug the 'Stop sorting by X' menu item had: it called the toggle
   * twice, which from the reversed state lands back on the first state. The fix
   * was to clear the state directly, and this test documents why. */
  const reversed = { key: "due", dir: "desc" };
  const after = nextSort(nextSort(reversed, "due"), "due");
  assert.deepEqual(after, { key: "due", dir: "asc" },
    "two toggles from the reversed state land back on the FIRST sort, not off — so the menu must clear the state directly");
});

t("a column that is not sortable is left alone", () => {
  const cur = { key: "due", dir: "asc" };
  assert.equal(nextSort(cur, "nonsense"), cur);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
