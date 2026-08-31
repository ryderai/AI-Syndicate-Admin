/* DELETING A CLIENT.
 *
 * Until 31 Aug 2026 a client could not be removed from this console at all —
 * the Aug 30 dry run left a fake one on the list with no way to take it off.
 *
 * What is expensive here, in order:
 *   1. Deleting the wrong client. There is no undo, and the row takes ten
 *      tables of work with it.
 *   2. A screen that says "are you sure?" and nothing else, so nobody knows
 *      what "sure" costs.
 *   3. This list going stale. A new table gains a client_id, nothing here
 *      changes, and the screen starts lying by omission.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CLIENT_DELETE_CASCADES, CLIENT_DELETE_KEEPS, confirmsDelete, deleteWarning,
} from "../../lib/client-delete.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

console.log("\nTHE GATE — typing the name");

ok("the exact name opens it", confirmsDelete("ZZ TEST — Dry Run Realty", "ZZ TEST — Dry Run Realty"));
ok("case is forgiven — it is retyped, not pasted", confirmsDelete("zz test — dry run realty", "ZZ TEST — Dry Run Realty"));
ok("outside spacing is forgiven", confirmsDelete("  Shiner Law Group  ", "Shiner Law Group"));
ok("A NEAR MISS IS A NO", !confirmsDelete("Shiner Law", "Shiner Law Group"));
ok("...in the other direction too", !confirmsDelete("Shiner Law Group LLC", "Shiner Law Group"));
ok("inside spacing is NOT forgiven — it is a different name", !confirmsDelete("ShinerLawGroup", "Shiner Law Group"));
ok("empty never opens it", !confirmsDelete("", "Shiner Law Group"));
ok("...and neither does a client with no name, whatever you type",
  !confirmsDelete("", "") && !confirmsDelete("anything", "") && !confirmsDelete("anything", null));

console.log("\nTHE SCREEN SAYS WHAT IT COSTS");

{
  const w = deleteWarning("ZZ TEST — Dry Run Realty", 4);
  ok("it names the client", w.includes("ZZ TEST — Dry Run Realty"));
  ok("it counts the tasks", w.includes("4 tasks"), w);
  ok("it says there is no undo", /cannot be undone/i.test(w));
  ok("one task is not '1 tasks'", deleteWarning("X", 1).includes("1 task go"), deleteWarning("X", 1));
  ok("an unknown count does not print a number it does not have",
    !/\d/.test(deleteWarning("X", null)) && deleteWarning("X", null).includes("Its tasks"));
}

console.log("\nTHE LIST MATCHES THE DATABASE — this is what stops it going stale");

{
  /* Read the migrations and find every table that points at admin_clients.
   * If somebody adds one and does not name it here, this fails — which is the
   * whole point. Comments are stripped so prose cannot satisfy the check. */
  const dir = join(ROOT, "supabase", "migrations");
  const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n")
    .split("\n").map((l) => l.replace(/^\s*--.*$/, "")).join("\n");

  /* Which table a line belongs to: the last `create table` or `alter table`
   * above it. */
  const lines = sql.split("\n");
  let current = null;
  const cascade = new Set();
  const setNull = new Set();
  for (const line of lines) {
    const create = line.match(/create table if not exists public\.(\w+)/);
    if (create) { current = create[1]; continue; }
    const alter = line.match(/^alter table public\.(\w+)/);
    if (alter) { current = alter[1]; }
    if (!current || !/references public\.admin_clients/.test(line)) continue;
    if (/on delete cascade/.test(line)) cascade.add(current);
    else if (/on delete set null/.test(line)) setNull.add(current);
  }

  ok("the migrations really do carry client links", cascade.size > 0 && setNull.size > 0,
    `cascade ${[...cascade]} / setNull ${[...setNull]}`);

  const named = new Set(CLIENT_DELETE_CASCADES.map(([t]) => t));
  const missing = [...cascade].filter((t) => !named.has(t));
  const invented = [...named].filter((t) => !cascade.has(t));
  eq("every table that is DELETED with a client is named on the screen", missing, []);
  eq("...and nothing is named that is not", invented, []);

  const kept = new Set(CLIENT_DELETE_KEEPS.map(([t]) => t));
  const missingKeep = [...setNull].filter((t) => !kept.has(t));
  eq("every table that SURVIVES is named too", missingKeep, []);

  ok("admin_tasks is on the delete side — it is the one people will care about",
    named.has("admin_tasks"));
  ok("admin_leads is on the KEEP side — the lead stays on the sales sheet",
    kept.has("admin_leads"));
  ok("every entry says what it is in plain words, not just a table name",
    [...CLIENT_DELETE_CASCADES, ...CLIENT_DELETE_KEEPS].every(([, what]) => what && what.length > 8));
}

console.log("\nTHE BUTTON ITSELF");

{
  const OPS = src("src/components/admin/Operations.jsx")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  ok("it calls deleteClient", /deleteClient\(client\.id\)/.test(OPS));
  ok("it is gated on the typed name", /disabled=\{!nameMatches \|\| busy\}/.test(OPS));
  ok("...and the gate is the tested rule, not a second copy of it", /confirmsDelete\(typed, client\?\.name\)/.test(OPS));
  ok("OWNERS ONLY", /member\?\.role === "owner"/.test(OPS));
  ok("it is behind a fold, not sitting next to Save", /setDangerOpen\(true\)/.test(OPS));
  ok("it counts the tasks from the database when the fold opens, not from a stale page load",
    /listTasks\(client\.id\)/.test(OPS));
  ok("it writes what happened to the activity log", /kind: "client_deleted"/.test(OPS));
  ok("a new client has no delete button — there is nothing to delete", /client\?\.id && member\?\.role/.test(OPS));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
