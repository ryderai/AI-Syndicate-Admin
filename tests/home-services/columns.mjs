/* EVERY COLUMN THE HOME SERVICES CODE NAMES IS A COLUMN THE DATABASE HAS.
 *
 * This is the same guard tests/db-columns/test.mjs put on the older writers,
 * pointed at the four files added on 14 Sep 2026 — and it is here because the
 * note at the top of that file is the history of this repo: "three files once
 * wrote column names the tables do not have, and the tests missed it because
 * the fixtures invented the same wrong names." A fixture cannot catch that. A
 * reader of the real CREATE TABLE can.
 *
 * HOW IT WORKS. It reads supabase/migrations/*.sql for what each table really
 * holds (`create table` plus every `add column`), then walks every Supabase
 * call in the new files — from `.from("table")` to the end of that statement —
 * and collects three kinds of column name out of it:
 *
 *   1. the keys of any object literal being inserted, updated or upserted
 *   2. the names inside `.select("a, b, c")`
 *   3. the first argument of every filter and sort: eq, gte, lt, is, in,
 *      ilike, order, and `onConflict`
 *
 * Anything that is not a column of that table is a failure, named.
 *
 * WHAT IT CANNOT SEE, said plainly rather than papered over: an object built
 * up in a variable and handed over by name, and a spread of another object.
 * Both are invisible here, which is exactly why the two endpoints write their
 * literals INLINE and without a spread — there are comments in both files
 * saying so. The count of what was checked is printed below, so if somebody
 * moves a literal into a variable the number drops and the drop is visible.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGDIR = join(ROOT, "supabase", "migrations");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

/* ---------- what the database actually holds ---------- */

const sqlAll = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(join(MIGDIR, f), "utf8")).join("\n");
/* Comments out first. A column named in an explanation is not a column — the
 * exact trap tests/db-columns hit on its own first run. */
const sql = sqlAll.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

const tables = new Map();
for (const m of sql.matchAll(/create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const [, name, body] = m;
  const cols = new Set();
  const required = new Set();
  for (const line of body.split("\n")) {
    const t = line.trim();
    const col = /^([a-z_][a-z0-9_]*)\s+(.+)$/.exec(t);
    if (!col) continue;
    if (["primary", "unique", "constraint", "check", "foreign", "exclude"].includes(col[1])) continue;
    cols.add(col[1]);
    if (/\bnot null\b/i.test(col[2]) && !/\bdefault\b/i.test(col[2])) required.add(col[1]);
  }
  tables.set(name, { cols, required });
}
for (const m of sql.matchAll(/alter table\s+(?:only\s+)?public\.(\w+)[\s\S]{0,120}?add column(?: if not exists)?\s+([a-z_][a-z0-9_]*)/g)) {
  const t = tables.get(m[1]);
  if (t) t.cols.add(m[2]);
}

ok(`the migrations describe the tables (${tables.size} of them)`, tables.size > 15);
ok("0035's hs_page_events was read", (tables.get("hs_page_events")?.cols.size || 0) > 10,
  [...(tables.get("hs_page_events")?.cols || [])].join(","));
ok("0035's hs_lead_sources was read", (tables.get("hs_lead_sources")?.cols.size || 0) > 8,
  [...(tables.get("hs_lead_sources")?.cols || [])].join(","));
ok("admin_leads was read", (tables.get("admin_leads")?.cols.size || 0) > 20);

/* The two facts the capture endpoint depends on, pinned so they cannot rot. */
ok("admin_leads has NO `zip` column — which is why the postcode goes in notes",
  !tables.get("admin_leads").cols.has("zip"));
ok("admin_leads has NO `website` column — which is why the site goes in `domain`",
  !tables.get("admin_leads").cols.has("website") && tables.get("admin_leads").cols.has("domain"));
ok("hs_lead_sources requires lead_id and page_slug on an insert",
  tables.get("hs_lead_sources").required.has("page_slug"));

/* ---------- what the code names ---------- */

const FILES = [
  { rel: "api/hs-event.js" },
  { rel: "api/hs-lead.js" },
  /* Only the section appended on 14 Sep 2026. The rest of data.js is 5,500
   * lines of other people's readers and is guarded by tests/db-columns. */
  { rel: "src/lib/data.js", from: "HOME SERVICES LANDING PAGES — 14 Sep 2026" },
];

const FILTERS = ["eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "ilike", "like", "order", "contains"];
/* Option keys that travel inside these calls and are NOT columns. */
const NOT_COLUMNS = new Set(["ascending", "count", "ignoreDuplicates", "head", "nullsFirst", "referencedTable", "foreignTable", "onConflict"]);
const NOT_A_KEY = new Set(["null", "true", "false", "undefined", "default", "case", "return", "await", "new", "typeof", "void", "in", "of"]);

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}
function stripStrings(code) {
  return code.replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/** The whole chained statement starting at `.from("t")`: forward to the first
 * `;` that is not inside brackets. */
function statementAt(code, i) {
  let depth = 0;
  for (let j = i; j < code.length; j += 1) {
    const c = code[j];
    if ("{[(".includes(c)) depth += 1;
    else if ("}])".includes(c)) depth -= 1;
    else if (c === ";" && depth <= 0) return code.slice(i, j);
  }
  return code.slice(i);
}

let statements = 0;
let names = 0;
const problems = [];

for (const spec of FILES) {
  let raw = readFileSync(join(ROOT, spec.rel), "utf8");
  if (spec.from) {
    const at = raw.indexOf(spec.from);
    if (at < 0) { problems.push(`${spec.rel}: the section marker "${spec.from}" is gone — this guard is reading nothing`); continue; }
    raw = raw.slice(at);
  }
  const code = stripComments(raw);

  for (const m of code.matchAll(/\.from\(\s*["']([a-z_][a-z0-9_]*)["']\s*\)/g)) {
    const table = m[1];
    const spec2 = tables.get(table);
    if (!spec2) { problems.push(`${spec.rel}: .from("${table}") — no such table in any migration`); continue; }
    statements += 1;
    const stmt = statementAt(code, m.index + m[0].length);
    const bare = stripStrings(stmt);

    const claim = (name, where) => {
      names += 1;
      if (!spec2.cols.has(name)) problems.push(`${spec.rel}: ${table} has no column "${name}" (${where})`);
    };

    /* 1. object-literal keys */
    for (let k = 0; k < bare.length; k += 1) {
      const km = /^([a-z_][a-z0-9_]*)\s*:/.exec(bare.slice(k));
      if (!km) continue;
      const before = k === 0 ? "{" : bare[k - 1];
      if (!/[\s,{]/.test(before)) continue;
      k += km[0].length - 1;
      if (NOT_A_KEY.has(km[1]) || NOT_COLUMNS.has(km[1])) continue;
      claim(km[1], "object key");
    }

    /* 2. select("a, b, c") */
    for (const s of stmt.matchAll(/\.select\(\s*["']([^"']*)["']/g)) {
      for (const part of s[1].split(",")) {
        const n = part.trim();
        if (!n || n === "*") continue;
        claim(n, "select");
      }
    }

    /* 3. filters, sorts and the upsert key */
    for (const f of stmt.matchAll(new RegExp(`\\.(${FILTERS.join("|")})\\(\\s*["']([^"']+)["']`, "g"))) {
      claim(f[2], `.${f[1]}()`);
    }
    for (const f of stmt.matchAll(/onConflict:\s*["']([^"']+)["']/g)) {
      claim(f[1], "onConflict");
    }
  }
}

ok(`${statements} Supabase statements read, ${names} column names checked`, statements >= 7 && names >= 30,
  `statements=${statements} names=${names}`);
ok("every column name the Home Services code uses exists in the migrations",
  problems.length === 0, problems.join("\n       "));

/* ---------- the dynamic patch, which no parser can see ---------- */
/* /api/hs-lead builds its UPDATE from a list of field names in a constant. A
 * literal-reader walks straight past that, so the list is read out of the
 * source and checked by name. This is the half of the guard that would have
 * caught the original bug in its second form. */
{
  const src = readFileSync(join(ROOT, "api/hs-lead.js"), "utf8");
  const m = /const FILLABLE = \[([^\]]*)\]/.exec(src);
  const fields = m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
  ok("the FILLABLE list was found in api/hs-lead.js", fields.length > 0);
  const bad = fields.filter((f) => !tables.get("admin_leads").cols.has(f));
  ok(`every FILLABLE field is a real admin_leads column (${fields.length} of them)`,
    bad.length === 0, bad.join(", "));
  for (const seed of ["last_activity_at", "notes"]) {
    ok(`the update also sets ${seed}, which admin_leads has`,
      new RegExp(`\\b${seed}\\b`).test(src) && tables.get("admin_leads").cols.has(seed));
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
