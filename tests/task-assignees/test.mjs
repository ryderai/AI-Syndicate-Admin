/* MORE THAN ONE PERSON ON A TASK.
 *
 * What is expensive here, in order:
 *   1. A task somebody is standing on that is not on their Work page. That is
 *      the Aug 30 dry run's failure, and a second assignee is a brand-new way
 *      to cause it.
 *   2. An edit that silently drops everybody but the primary. Every inline cell
 *      writes on one click; a cell that sends the single field wipes the rest.
 *   3. The array and the single field disagreeing. Two places holding "who owns
 *      this" is two places to be wrong.
 *   4. Somebody put on a task they cannot open — a sales rep has no Operations
 *      page. Two ways onto a task is two doors.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MAX_ASSIGNEES, cleanAssignees, primaryOf, assigneePatch, assigneesOf,
  isAssignedTo, addAssignee, removeAssignee, toggleAssignee, makePrimary,
  assignableTeam, assigneeLabel,
} from "../../lib/task-assignees.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, "..", "..", p), "utf8");

const TEAM = [
  { user_id: "u-ryder", email: "ryder@aisyndicate.com", full_name: "Ryder Schilling", role: "owner", active: true },
  { user_id: "u-cj", email: "cj@aisyndicate.com", full_name: "CJ Britton", role: "owner", active: true },
  { user_id: "u-andrew", email: "andrew@aisyndicate.com", full_name: "Andrew Soncini", role: "admin", active: true },
  { user_id: "u-rep", email: "rep@aisyndicate.com", full_name: "A Sales Rep", role: "sales", active: true },
  { user_id: "u-old", email: "gone@aisyndicate.com", full_name: "Gone Person", role: "admin", active: false },
];

console.log("\nEVERYBODY ON THE TASK SEES THE TASK");

{
  const t = { assigned_to: "u-ryder", assignees: ["u-ryder", "u-cj"] };
  ok("the primary sees it", isAssignedTo(t, "u-ryder"));
  ok("THE SECOND PERSON SEES IT — this is the whole feature", isAssignedTo(t, "u-cj"));
  ok("somebody else does not", !isAssignedTo(t, "u-andrew"));
  ok("nobody is not somebody", !isAssignedTo(t, null) && !isAssignedTo(t, ""));
}
{
  /* A row read before 0028 ran, or written by a caller that only knows the
   * single field. It must still work from the first deploy, not after a
   * backfill lands. */
  const old = { assigned_to: "u-ryder" };
  eq("a pre-0028 row reads as a one-name list", assigneesOf(old), ["u-ryder"]);
  ok("...and that person still sees it", isAssignedTo(old, "u-ryder"));
  eq("an unassigned row is an empty list, not [null]", assigneesOf({ assigned_to: null }), []);
  eq("a row with neither field is empty", assigneesOf({}), []);
  eq("no row at all is empty rather than a crash", assigneesOf(undefined), []);
}
{
  /* THE READER THE WORK PAGE USES. If this ever regresses to comparing the
   * single field, a second assignee's work goes invisible to them. */
  /* CODE ONLY. Both of the checks below used to read the file whole and both
   * matched their own explanatory COMMENT — the "loose regex is a guard that
   * cannot fire" trap, in its other direction: a guard that fires on prose.
   * Comments are stripped first, every time, in this file. */
  const codeOf = (p) => src(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/^\s*(\/\/|--).*$/, "")).join("\n");
  const DATA = codeOf("src/lib/data.js");
  ok("getMyWork asks isAssignedTo", /isAssignedTo\(t, userId\)/.test(DATA));
  {
    /* Narrowed to the TASK read. `mine(t.assigned_to)` is still correct on
     * tickets, which are a different table and still hold one person. */
    const myTasks = DATA.slice(DATA.indexOf("const myTasks"), DATA.indexOf("const myTasks") + 400);
    ok("...and the task read no longer compares the single field",
      !/mine\(t\.assigned_to\)/.test(myTasks), myTasks.slice(0, 160));
    ok("tickets are untouched — they are a different table and still hold one person",
      /mine\(t\.assigned_to\)/.test(DATA));
  }
  const OPS = codeOf("src/components/admin/Operations.jsx");
  ok("the Owner filter asks the same question", /isAssignedTo\(t, me\)/.test(OPS));
  ok("...and 'Unassigned' means the list is empty, not that the single field is",
    /assigneesOf\(t\)\.length/.test(OPS));
}

console.log("\nTHE TWO FIELDS CAN NEVER DISAGREE");

eq("the patch always carries both", Object.keys(assigneePatch(["a"])).sort(), ["assigned_to", "assignees"]);
eq("the primary is the first name", assigneePatch(["b", "a"]), { assignees: ["b", "a"], assigned_to: "b" });
eq("empty means empty on both", assigneePatch([]), { assignees: [], assigned_to: null });
eq("...and so does a list of nothing but blanks", assigneePatch([null, "", undefined]), { assignees: [], assigned_to: null });
eq("the primary is always IN the list", primaryOf(["x", "y"]), "x");
{
  const DATA = src("src/lib/data.js");
  ok("every write through upsertTask is normalised, so the row sent matches the row stored",
    /function withAssignees/.test(DATA) && /const patch = withAssignees\(rawPatch\)/.test(DATA));
  ok("...including a caller that only knows assigned_to", /patch\.assigned_to \? \[patch\.assigned_to\] : \[\]/.test(DATA));
}

console.log("\nORDER IS MEANING, SO DE-DUPLICATING MUST NOT SORT");

eq("first-seen order is kept", cleanAssignees(["z", "a", "m"]), ["z", "a", "m"]);
eq("a duplicate keeps its FIRST position", cleanAssignees(["a", "b", "a"]), ["a", "b"]);
eq("blanks are dropped", cleanAssignees(["a", null, "", "  ", "b"]), ["a", "b"]);
eq("not a list is an empty list", cleanAssignees("u-ryder"), []);
ok("a runaway paste is capped", cleanAssignees(Array.from({ length: 400 }, (_, i) => `u${i}`)).length === MAX_ASSIGNEES);

console.log("\nADDING, REMOVING, AND WHO BECOMES PRIMARY");

eq("adding puts them last, so the primary does not move", addAssignee(["a"], "b"), ["a", "b"]);
eq("adding somebody already on it changes nothing", addAssignee(["a", "b"], "b"), ["a", "b"]);
eq("removing a second person leaves the primary alone", removeAssignee(["a", "b"], "b"), ["a"]);
{
  /* The one that matters: taking the primary off must not drop the task to
   * Unassigned while somebody is still standing on it. */
  eq("removing the PRIMARY promotes the next person", removeAssignee(["a", "b", "c"], "a"), ["b", "c"]);
  eq("...and the patch agrees", assigneePatch(removeAssignee(["a", "b"], "a")).assigned_to, "b");
}
eq("removing the last person unassigns it", assigneePatch(removeAssignee(["a"], "a")), { assignees: [], assigned_to: null });
eq("toggle on", toggleAssignee(["a"], "b"), ["a", "b"]);
eq("toggle off", toggleAssignee(["a", "b"], "b"), ["a"]);
eq("make primary moves them to the front and removes nobody", makePrimary(["a", "b", "c"], "c"), ["c", "a", "b"]);
eq("make primary on somebody who is not on it does nothing", makePrimary(["a", "b"], "z"), ["a", "b"]);

console.log("\nNOBODY IS PUT ON A TASK THEY CANNOT OPEN");

{
  const pickable = assignableTeam(TEAM).map((m) => m.user_id);
  ok("a sales rep is not offered — Operations is not on their console", !pickable.includes("u-rep"), JSON.stringify(pickable));
  ok("a deactivated member is not offered", !pickable.includes("u-old"));
  eq("owners and admins are", pickable, ["u-ryder", "u-cj", "u-andrew"]);
}
{
  /* Rule 4 the other way round: filtering somebody OUT who is already on the
   * task makes the screen say Unassigned while the database says otherwise. */
  const pickable = assignableTeam(TEAM, ["u-rep"]).map((m) => m.user_id);
  ok("somebody already on the task is still shown, whatever their role", pickable.includes("u-rep"));
}

console.log("\nWHAT ONE SLOT SAYS WHEN THERE ARE TWO");

{
  const label = (id) => ({ "u-ryder": "Ryder Schilling", "u-cj": "CJ Britton" })[id];
  eq("one person is just their name", assigneeLabel({ assignees: ["u-ryder"] }, label), "Ryder Schilling");
  eq("two people say so", assigneeLabel({ assignees: ["u-ryder", "u-cj"] }, label), "Ryder Schilling +1");
  eq("nobody is null, so each screen says its own word for it", assigneeLabel({ assignees: [] }, label), null);
  eq("an unknown id does not blank the cell", assigneeLabel({ assignees: ["u-ghost"] }, () => null), "Someone");
}
{
  const CELLS = src("src/components/admin/opsCells.jsx");
  ok("the cell sends the LIST back, not one id", /onChange\(ids\.includes\(id\)/.test(CELLS));
  ok("the menu stays open while picking — three people is one thought, not three round trips",
    /Done\s*<\/button>/.test(CELLS));
  const TABLE = src("src/components/admin/opsTable.jsx");
  ok("the table hands the cell the whole list", /PersonCell value=\{assigneesOf\(t\)\}/.test(TABLE));
  ok("...and writes the whole list back", /onPatch\(t, \{ assignees: v \}\)/.test(TABLE));
}

console.log("\nTHE DATABASE IS THE SECOND LOCK, NOT THE ONLY ONE");

{
  const SQLRAW = src("supabase/migrations/0028_task_assignees.sql");
  const SQL = SQLRAW.split("\n").map((l) => l.replace(/^\s*--.*$/, "")).join("\n");
  ok("the column is an array with a real default, so no row is ever null", /assignees uuid\[\] not null default '\{\}'::uuid\[\]/.test(SQL));
  ok("existing tasks are backfilled", /update public\.admin_tasks/.test(SQL) && /array\[assigned_to\]/.test(SQL));
  ok("...and the backfill is safe to run twice", /and assignees = '\{\}'::uuid\[\]/.test(SQL));
  ok("a trigger keeps the two fields in step whichever one a writer sets", /create trigger admin_tasks_assignees_sync/.test(SQL));
  ok("the trigger de-duplicates WITHOUT sorting — order is who the primary is",
    /with ordinality/.test(SQL) && !/array_agg\(distinct/.test(SQL));
  ok("setting only assigned_to keeps everybody else on the task",
    /array\[new\.assigned_to\] \|\| array_remove\(cleaned, new\.assigned_to\)/.test(SQL));
  ok("there is a GIN index, or the Work page scans the table on every load", /using gin \(assignees\)/.test(SQL));
  ok("the grants are re-asserted — a lost GRANT has broken two pages here", /grant select, insert, update, delete on public\.admin_tasks to authenticated/.test(SQL));
  ok("the reader that must page is told about the new column",
    /assigned_to, assignees"\)/.test(src("src/lib/data.js")));
}

console.log("\nDEPLOY ORDER DOES NOT MATTER");

{
  /* 0012 set this trap once already: Postgres rejects the WHOLE row when sent a
   * column the table does not have, so a console deployed before its migration
   * ran could not save ANY task edit — a due-date change died on a field the
   * person never touched. */
  const OPS = src("src/components/admin/Operations.jsx");
  ok("a missing assignees column is recognised", /const MISSING_ASSIGNEES/.test(OPS));
  ok("the inline edit falls back to the single field rather than failing",
    /MISSING_ASSIGNEES\.test[\s\S]{0,400}assigned_to: \(assignees \|\| \[\]\)\[0\]/.test(OPS));
  ok("...and says why, instead of pretending two people were stored",
    /This database has no assignees column yet/.test(OPS));
  ok("the same guard is on creating a task, not just editing one",
    (OPS.match(/MISSING_ASSIGNEES\.test/g) || []).length >= 2);
  ok("the 0012 description fallback is still there — this did not replace it",
    /MISSING_DESCRIPTION\.test/.test(OPS));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
