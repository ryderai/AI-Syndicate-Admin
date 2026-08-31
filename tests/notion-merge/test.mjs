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
  { user_id: "u-ryder", email: "ryder@aisyndicate.com", full_name: "Ryder Schilling", role: "owner", active: true },
  { user_id: "u-cj", email: "cj@aisyndicate.com", full_name: "CJ Britton", role: "owner", active: true },
  { user_id: "u-andrew", email: "andrew@aisyndicate.com", full_name: "Andrew Soncini", role: "admin", active: true },
  { user_id: "u-old", email: "gone@aisyndicate.com", full_name: "Gone Person", role: "admin", active: false },
  { user_id: "u-rep", email: "rep@aisyndicate.com", full_name: "A Sales Rep", role: "sales", active: true },
];

console.log("\nTHE OPTION LISTS ARE NOTION'S OWN");

/* If somebody renames an option "to look tidier" on either side, this is what
 * notices. §11 rule 1 says these are copied word for word. */
{
  const DATA = src("src/lib/data.js");
  /* PINNED TO THE DECLARATION, not to the word appearing anywhere in a
   * 5,000-line file. "Access", "Technical", "Content", "Billing" and
   * "Reporting" all occur elsewhere in data.js, so a looser check passed even
   * with TASK_CATEGORIES deleted outright — a guard that cannot fire. */
  const constLine = (name) => (DATA.match(new RegExp(`export const ${name} = \\[[^\\]]*\\]`)) || [""])[0];
  ok("TASK_CATEGORIES still exists as a declaration", constLine("TASK_CATEGORIES").length > 20);
  ok("every category this file accepts is IN that declaration",
    CATEGORIES.every((c) => constLine("TASK_CATEGORIES").includes(`"${c}"`)));
  ok("TASK_PHASES still exists as a declaration", constLine("TASK_PHASES").length > 20);
  ok("every phase this file accepts is IN that declaration",
    PHASES.every((p) => constLine("TASK_PHASES").includes(`"${p}"`)));
  ok("...and the console has no category this importer would silently drop",
    (constLine("TASK_CATEGORIES").match(/"/g) || []).length / 2 === CATEGORIES.length);
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
  const twoRyders = [...TEAM, { user_id: "u-ryder2", email: "ryder2@aisyndicate.com", full_name: "Ryder Schilling", role: "admin", active: true }];
  const r = mapTask({ client: "Shiner Law Group", name: "t", assignees: ["ryder2@aisyndicate.com"] }, CLIENTS, twoRyders);
  eq("two people with ONE name still resolve, because the key is the address", r.row.assigned_to, "u-ryder2");
  ok("a bare display name is never accepted as an assignee",
    mapTask({ client: "Shiner Law Group", name: "t", assignees: ["Ryder Schilling"] }, CLIENTS, twoRyders).row.assigned_to === undefined);
}
{
  /* MIGRATION 0028. Until 31 Aug this console held one person per task, so the
   * import put the first name on the row and the rest into the brief — a name
   * demoted to prose. Both go on the task now. */
  const r = mapTask({ client: "Shiner Law Group", name: "t", assignees: ["ryder@aisyndicate.com", "cj@aisyndicate.com"] }, CLIENTS, TEAM);
  eq("BOTH people go on the task", r.row.assignees, ["u-ryder", "u-cj"]);
  eq("the first named person is the primary", r.row.assigned_to, "u-ryder");
  ok("the second is NOT also written into the brief — that would read as a third person",
    !/cj@aisyndicate\.com/.test(r.row.description || ""), r.row.description);
  ok("the primary is always inside the list", r.row.assignees.includes(r.row.assigned_to));
}
{
  /* A re-paste must not rewrite 107 rows because two arrays are never ===. */
  const existing = [{ id: "t1", client_id: "c1", name: "T", assigned_to: "u-ryder", assignees: ["u-ryder", "u-cj"] }];
  const p = planTaskImport([{ client: "Shiner Law Group", name: "T", assignees: ["ryder@aisyndicate.com", "cj@aisyndicate.com"] }], { clients: CLIENTS, team: TEAM, existing });
  eq("the same two people is not a change", p.update.length, 0);
  const p2 = planTaskImport([{ client: "Shiner Law Group", name: "T", assignees: ["cj@aisyndicate.com", "ryder@aisyndicate.com"] }], { clients: CLIENTS, team: TEAM, existing });
  eq("...but swapping who is primary IS a change", p2.update.length, 1);
  const p3 = planTaskImport([{ client: "Shiner Law Group", name: "T", assignees: ["ryder@aisyndicate.com"] }], { clients: CLIENTS, team: TEAM, existing: [{ id: "t1", client_id: "c1", name: "T", assigned_to: "u-ryder" }] });
  eq("a row written before 0028 is read from its single field, not seen as a change", p3.update.length, 0);
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

console.log("\nRULES THE FIRST VERSION OF THIS FILE HAD NO TEST FOR");

/* Every check below was written after an adversarial reviewer deleted the rule
 * it guards and no test noticed. */

{
  /* THE CLIENT MATCH IS EQUALITY. Loosening it to startsWith put 36 tasks on
   * the wrong client and the whole suite still passed. */
  ok("a client name that merely STARTS the real one is refused",
    mapTask({ client: "Matt", name: "t" }, CLIENTS, TEAM).row === null);
  ok("...and so is one the real name starts with",
    mapTask({ client: "Matt McCall Realty", name: "t" }, CLIENTS, TEAM).row === null);
}
{
  /* TWO CLIENTS WITH ONE NAME. Every other matcher here refuses; this one used
   * to take whichever sorted first. */
  const dupes = [...CLIENTS, { id: "c99", name: "matt  mccall" }];
  const r = mapTask({ client: "Matt McCall", name: "t" }, dupes, TEAM);
  ok("two clients answering to one name refuses the row", r.row === null);
  ok("...and says to merge or rename them", /more than one client/.test(r.problems[0]), r.problems[0]);
}
{
  /* A REP CANNOT BE HANDED DELIVERY WORK. src/lib/people.js: "a task handed to
   * a rep is a task nobody can open". The import was the one door left open. */
  const r = mapTask({ client: "Shiner Law Group", name: "t", assignees: ["rep@aisyndicate.com"] }, CLIENTS, TEAM);
  ok("a SALES REP is never given an Operations task", r.row.assigned_to === undefined);
  ok("...and the reason says which console they have", /console/.test(r.problems[0] || ""), r.problems[0]);
  ok("...and their name is still kept in the brief", /rep@aisyndicate\.com/.test(r.row.description || ""));
  ok("an owner and an admin both still can", 
    mapTask({ client: "Shiner Law Group", name: "t", assignees: ["andrew@aisyndicate.com"] }, CLIENTS, TEAM).row.assigned_to === "u-andrew");
}
{
  /* THE ONE-LINE STATUS IS THE POINT OF THE EXPORT. Turning the carry-over off
   * broke nothing, on a payload where 68 of 107 rows have one. */
  const r = mapTask({ client: "Shiner Law Group", name: "t", report: "12 of 26 pages done" }, CLIENTS, TEAM);
  eq("the latest report is carried over", r.row.latest_report, "12 of 26 pages done");
}
{
  /* FILL-ONLY. The export writes a link into description; a re-paste must not
   * replace a brief somebody typed here with that link. */
  const existing = [{ id: "t1", client_id: "c1", name: "T", description: "the real brief, typed here" }];
  const p = planTaskImport([{ client: "Shiner Law Group", name: "T", description: "Copied from Notion. Original: https://..." }], { clients: CLIENTS, team: TEAM, existing });
  eq("a description already written here is NEVER overwritten", p.update.length, 0);
  const p2 = planTaskImport([{ client: "Shiner Law Group", name: "T", description: "from Notion" }], { clients: CLIENTS, team: TEAM, existing: [{ id: "t1", client_id: "c1", name: "T" }] });
  eq("...but an empty one is filled", p2.update[0].patch.description, "from Notion");
}
{
  /* THE CHECK SCREEN HAS TO BE ABLE TO SAY WHAT CHANGES, field by field, or a
   * person is agreeing to a number rather than to a change. */
  const existing = [{ id: "t1", client_id: "c1", name: "T", status: "todo", priority: "low" }];
  const p = planTaskImport([{ client: "Shiner Law Group", name: "T", status: "In Progress", priority: "🔴 High" }], { clients: CLIENTS, team: TEAM, existing });
  eq("every update lists its fields", p.update[0].changes.map((c) => c.field).sort(), ["priority", "status"]);
  eq("...with the value it is replacing", p.update[0].changes.find((c) => c.field === "priority").from, "low");
  eq("...and the value going in", p.update[0].changes.find((c) => c.field === "priority").to, "high");
}
{
  /* THE LENGTH LIMITS. All three could be deleted freely; the longest real
   * task name is 178 characters, so nothing exercised them. */
  const long = "x".repeat(30000);
  const r = mapTask({ client: "Shiner Law Group", name: long, report: long, description: long }, CLIENTS, TEAM);
  ok("a runaway task name is cut, not sent whole", r.row.name.length === 400);
  ok("a runaway report is cut", r.row.latest_report.length === 20000);
  ok("a runaway brief is cut", r.row.description.length === 20000);
}
{
  /* AN EMPTY CELL ARRIVES AS AN ABSENT KEY. This is where rule 3 actually acts;
   * the line in planTaskImport is the second lock on the same door. */
  const r = mapTask({ client: "Shiner Law Group", name: "t", status: "", priority: "   ", category: null, phase: undefined, report: "", due: "" }, CLIENTS, TEAM);
  eq("nothing blank is even put on the patch", Object.keys(r.row).sort(), ["client_id", "name"]);
  eq("...and a blank is not reported as a problem either", r.problems.length, 0);
}

console.log("\nTHE KEY ITSELF");
eq("case and spacing are flattened", nameKey("  Give   JOEY access "), "give joey access");
ok("a space is NOT stripped — Week 1 and Week1 are different work", nameKey("Week 1") !== nameKey("Week1"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
