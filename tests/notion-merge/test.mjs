/* BRINGING THE NOTION TASKS OVER — the rules half.
 *
 * What is expensive here, in order:
 *   1. A task landing on no client. It is then on no client page, on no Work
 *      page, and in no group — invisible. Same shape as the vanished task in
 *      the Aug 30 dry run.
 *   2. A second paste doubling everything. 108 rows becoming 216.
 *   3. A finished task reopening because a stale export says To Do.
 *   4. An empty Notion cell wiping something somebody typed here.
 *   5. A second assignee silently dropped — a person who thinks the work is
 *      theirs and never sees it.
 *   6. A due date landing a day early. That one has already happened once.
 */
import {
  nameKey, dueDate, mapTask, planTaskImport, planSummary,
  NOTION_STATUS, NOTION_PRIORITY, CATEGORIES, PHASES,
} from "../../lib/notion-merge.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, "..", "..", p), "utf8");

const CLIENTS = [
  { id: "c1", name: "Shiner Law Group" },
  { id: "c2", name: "Dahler Group (30A)" },
  { id: "c3", name: "Matt McCall" },
];
const TEAM = [
  { user_id: "u-ryder", email: "ryder@aisyndicate.com", full_name: "Ryder Schilling", active: true },
  { user_id: "u-cj", email: "cj@aisyndicate.com", full_name: "CJ Britton", active: true },
  { user_id: "u-andrew", email: "andrew@aisyndicate.com", full_name: "Andrew Soncini", active: true },
  { user_id: "u-old", email: "gone@aisyndicate.com", full_name: "Gone Person", active: false },
];

console.log("\nTHE OPTION LISTS ARE NOTION'S OWN");

/* If somebody renames an option "to look tidier" on either side, this is what
 * notices. §11 rule 1 says these are copied word for word. */
{
  const DATA = src("src/lib/data.js");
  ok("every category this file accepts is in TASK_CATEGORIES",
    CATEGORIES.every((c) => DATA.includes(`"${c}"`)));
  ok("every phase this file accepts is in TASK_PHASES",
    PHASES.every((p) => DATA.includes(`"${p}"`)));
  eq("the three Notion statuses map onto the console's three",
    Object.values(NOTION_STATUS), ["todo", "in_progress", "done"]);
  ok("the priority keys carry Notion's emoji, because that IS the stored value there",
    Object.keys(NOTION_PRIORITY).every((k) => /[🔴🟡🟢]/u.test(k)));
}

console.log("\nA DUE DATE IS A DATE, NEVER A MOMENT");

eq("a plain date is kept as written", dueDate("2026-08-13"), "2026-08-13");
eq("a timestamp keeps its DATE and throws the clock away", dueDate("2026-08-13T23:30:00.000-05:00"), "2026-08-13");
ok("...and it is not shifted into UTC, which is how Aug 30's report was headed with tomorrow",
  dueDate("2026-08-13T23:30:00.000-05:00") !== "2026-08-14");
eq("an empty date is null, not today", dueDate(""), null);
eq("nonsense is null, and the row still imports", dueDate("next tuesday"), null);

console.log("\nA CLIENT IS NEVER INVENTED");

{
  const r = mapTask({ client: "Nobody Ltd", name: "Do a thing" }, CLIENTS, TEAM);
  ok("an unknown client REFUSES the row", r.row === null);
  ok("...and says which task and which client, by name",
    r.problems[0].includes("Do a thing") && r.problems[0].includes("Nobody Ltd"), r.problems[0]);
}
ok("a task with no client at all is refused too",
  mapTask({ name: "Orphan" }, CLIENTS, TEAM).row === null);
ok("a task with no name is refused",
  mapTask({ client: "Shiner Law Group" }, CLIENTS, TEAM).row === null);
eq("client names match past case and spacing",
  mapTask({ client: "  dahler   group (30A) ", name: "x" }, CLIENTS, TEAM).row.client_id, "c2");

console.log("\nWHO OWNS IT — matched on EMAIL, never on a display name");

{
  const r = mapTask({ client: "Shiner Law Group", name: "t", assignees: ["ryder@aisyndicate.com"] }, CLIENTS, TEAM);
  eq("one assignee owns the row", r.row.assigned_to, "u-ryder");
}
{
  const r = mapTask({ client: "Shiner Law Group", name: "t", assignees: ["CJ@AISYNDICATE.COM"] }, CLIENTS, TEAM);
  eq("case in an email does not matter", r.row.assigned_to, "u-cj");
}
{
  /* THE AUG 30 TRAP: two members share a display name. Nothing here may ever
   * fall back to a name. */
  const twoRyders = [...TEAM, { user_id: "u-ryder2", email: "ryder2@aisyndicate.com", full_name: "Ryder Schilling", active: true }];
  const r = mapTask({ client: "Shiner Law Group", name: "t", assignees: ["ryder2@aisyndicate.com"] }, CLIENTS, twoRyders);
  eq("two people with ONE name still resolve, because the key is the address", r.row.assigned_to, "u-ryder2");
  ok("a bare display name is never accepted as an assignee",
    mapTask({ client: "Shiner Law Group", name: "t", assignees: ["Ryder Schilling"] }, CLIENTS, twoRyders).row.assigned_to === undefined);
}
{
  const r = mapTask({ client: "Shiner Law Group", name: "t", assignees: ["ryder@aisyndicate.com", "cj@aisyndicate.com"] }, CLIENTS, TEAM);
  eq("the first named person owns it", r.row.assigned_to, "u-ryder");
  ok("the second is WRITTEN DOWN, not dropped", /cj@aisyndicate\.com/.test(r.row.description || ""), r.row.description);
}
{
  const r = mapTask({ client: "Shiner Law Group", name: "t", assignees: ["stranger@example.com"] }, CLIENTS, TEAM);
  ok("somebody with no account here is reported by address", r.problems.some((p) => p.includes("stranger@example.com")));
  ok("...and the task still imports, unassigned", r.row && r.row.assigned_to === undefined);
  ok("...and their name is kept in the brief so it is not lost", /stranger@example\.com/.test(r.row.description || ""));
}
ok("a DEACTIVATED member is never given new work",
  mapTask({ client: "Shiner Law Group", name: "t", assignees: ["gone@aisyndicate.com"] }, CLIENTS, TEAM).row.assigned_to === undefined);

console.log("\nAN OPTION THIS CONSOLE DOES NOT HAVE IS REPORTED, NEVER GUESSED");

{
  const r = mapTask({ client: "Shiner Law Group", name: "t", status: "Waiting on legal", priority: "urgent", category: "Vibes", phase: "Year 2" }, CLIENTS, TEAM);
  ok("an unknown status is left alone", r.row.status === undefined);
  ok("an unknown priority is left alone", r.row.priority === undefined);
  ok("an unknown category is left alone", r.row.category === undefined);
  ok("an unknown phase is left alone", r.row.phase === undefined);
  ok("all four are named on screen", r.problems.length === 4, JSON.stringify(r.problems));
}
eq("Notion's own words map straight through",
  ["status", "priority", "category", "phase"].map((k) =>
    mapTask({ client: "Shiner Law Group", name: "t", status: "In Progress", priority: "🟡 Medium", category: "Technical", phase: "Month 1" }, CLIENTS, TEAM).row[k]),
  ["in_progress", "medium", "Technical", "Month 1"]);
eq("a value already in the console's own shape is accepted too",
  mapTask({ client: "Shiner Law Group", name: "t", status: "blocked" }, CLIENTS, TEAM).row.status, "blocked");

console.log("\nPASTING TWICE DOES NOT DOUBLE ANYTHING");

const ROWS = [
  { client: "Shiner Law Group", name: "Give Joey view-only access", status: "To Do", priority: "🔴 High", category: "Access", due: "2026-08-13" },
  { client: "Dahler Group (30A)", name: "Receive payment and signed agreement", status: "To Do" },
];
{
  const first = planTaskImport(ROWS, { clients: CLIENTS, team: TEAM, existing: [] });
  eq("nothing on file yet — both are new", [first.create.length, first.update.length], [2, 0]);

  /* Pretend the first run wrote them, exactly as it planned. */
  const written = first.create.map((c, i) => ({ id: `t${i}`, ...c.row }));
  const second = planTaskImport(ROWS, { clients: CLIENTS, team: TEAM, existing: written });
  eq("the same paste a second time creates NOTHING", second.create.length, 0);
  eq("...and changes nothing either", second.update.length, 0);
  eq("...and says so", second.unchanged.length, 2);
}
{
  const dupe = planTaskImport([ROWS[0], { ...ROWS[0], priority: "🟢 Low" }], { clients: CLIENTS, team: TEAM, existing: [] });
  eq("the same task twice in ONE paste is created once", dupe.create.length, 1);
  ok("...and the repeat is named", dupe.duplicatesInPaste.length === 1, JSON.stringify(dupe.duplicatesInPaste));
  eq("the FIRST one wins, not the last", dupe.create[0].row.priority, "high");
}
ok("the same task NAME under two different clients is two tasks",
  planTaskImport([
    { client: "Shiner Law Group", name: "Kickoff call" },
    { client: "Matt McCall", name: "Kickoff call" },
  ], { clients: CLIENTS, team: TEAM, existing: [] }).create.length === 2);

console.log("\nAN EMPTY CELL NEVER BLANKS SOMETHING SOMEBODY TYPED");

{
  const existing = [{ id: "t1", client_id: "c1", name: "Give Joey view-only access", status: "todo", priority: "high", category: "Access", due_date: "2026-08-13", latest_report: "half done", description: "the brief" }];
  const p = planTaskImport([{ client: "Shiner Law Group", name: "Give Joey view-only access", status: "To Do" }], { clients: CLIENTS, team: TEAM, existing });
  eq("a paste with only a status leaves everything else alone", p.update.length, 0);
  eq("...and reports it as already right", p.unchanged.length, 1);
}
{
  const existing = [{ id: "t1", client_id: "c1", name: "T", latest_report: "12 of 26 pages done" }];
  const p = planTaskImport([{ client: "Shiner Law Group", name: "T", report: "" }], { clients: CLIENTS, team: TEAM, existing });
  eq("an EMPTY report in the export does not wipe the real one", p.update.length, 0);
}

console.log("\nDONE NEVER REOPENS");

{
  const existing = [{ id: "t1", client_id: "c1", name: "T", status: "done" }];
  const p = planTaskImport([{ client: "Shiner Law Group", name: "T", status: "To Do" }], { clients: CLIENTS, team: TEAM, existing });
  eq("a stale export cannot drag a finished task back", p.update.length, 0);
}
{
  const existing = [{ id: "t1", client_id: "c1", name: "T", status: "todo" }];
  const p = planTaskImport([{ client: "Shiner Law Group", name: "T", status: "Done" }], { clients: CLIENTS, team: TEAM, existing });
  eq("but finishing one IS carried over", p.update[0].patch.status, "done");
}
{
  const existing = [{ id: "t1", client_id: "c1", name: "T", status: "done", priority: "low" }];
  const p = planTaskImport([{ client: "Shiner Law Group", name: "T", status: "To Do", priority: "🔴 High" }], { clients: CLIENTS, team: TEAM, existing });
  ok("a done task still takes its OTHER fields — only the status is held", p.update.length === 1 && p.update[0].patch.priority === "high" && p.update[0].patch.status === undefined,
    JSON.stringify(p.update[0] && p.update[0].patch));
}

console.log("\nONE BAD ROW DOES NOT STOP THE OTHER HUNDRED");

{
  const p = planTaskImport([
    ROWS[0],
    { client: "Nobody Ltd", name: "orphan" },
    null,
    { name: "no client" },
    ROWS[1],
  ], { clients: CLIENTS, team: TEAM, existing: [] });
  eq("the two good rows still go", p.create.length, 2);
  eq("the three bad ones are each named", p.problems.length, 3);
}
eq("something that is not a list is refused with a sentence, not a crash",
  planTaskImport({ client: "x" }, { clients: CLIENTS, team: TEAM, existing: [] }).problems.length, 1);
eq("an empty list does nothing at all", planSummary(planTaskImport([], { clients: CLIENTS, team: TEAM, existing: [] })), "0 new · 0 updated · 0 already right");

console.log("\nTHE KEY ITSELF");
eq("case and spacing are flattened", nameKey("  Give   JOEY access "), "give joey access");
ok("a space is NOT stripped — Week 1 and Week1 are different work", nameKey("Week 1") !== nameKey("Week1"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
