/* EVERY COLUMN NAME THE APP WRITES IS A COLUMN THE DATABASE HAS.
 *
 * Written 2 Sep 2026, immediately after shipping a form that sent `client_id`
 * to `admin_proposals` — a table with no such column. Postgres rejects the
 * WHOLE row over one unknown name, so the button did nothing and the message
 * was "Could not find the 'client_id' column of 'admin_proposals' in the schema
 * cache". The same insert also omitted `title`, which is NOT NULL, so it would
 * have failed a second time once the first was fixed.
 *
 * THIS REPO ALREADY HAD A NOTE ABOUT THIS EXACT MISTAKE — "three files once
 * wrote column names the tables do not have, and every fixture agreed with
 * them" — and I made it again in the code that note is attached to. A note is
 * not a guard. This is the guard.
 *
 * HOW IT WORKS. It reads the migrations for what each table really holds
 * (`create table` plus every `add column`), then reads every literal object
 * handed to one of the writers in src/ and lib/, and fails on any key that is
 * not a column. It also checks the NOT NULL columns that have no default are
 * present on an INSERT — the second half of the same bug.
 *
 * WHAT IT CANNOT SEE, said plainly: an object built up in a variable and passed
 * by name, and a spread of another object. Those are skipped rather than
 * guessed at, and the count of what it checked is printed so a drop is visible.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGDIR = join(ROOT, "supabase", "migrations");

/* ---------- what the database actually holds ---------- */
const sqlAll = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(join(MIGDIR, f), "utf8")).join("\n");
/* Comments out first: a column named in an explanation is not a column. */
const sql = sqlAll.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

const tables = new Map();   // name -> { cols:Set, required:Set }
for (const m of sql.matchAll(/create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const [, name, bodyRaw] = m;
  const cols = new Set();
  const required = new Set();
  /* One column per line, and a line that starts with a constraint is not one. */
  for (const line of bodyRaw.split("\n")) {
    const t = line.trim();
    const col = /^([a-z_][a-z0-9_]*)\s+(.+)$/.exec(t);
    if (!col) continue;
    if (["primary", "unique", "constraint", "check", "foreign", "exclude"].includes(col[1])) continue;
    cols.add(col[1]);
    /* NOT NULL and no DEFAULT and not the generated primary key = an insert
     * has to supply it. */
    if (/\bnot null\b/i.test(col[2]) && !/\bdefault\b/i.test(col[2])) required.add(col[1]);
  }
  tables.set(name, { cols, required });
}
for (const m of sql.matchAll(/alter table\s+(?:only\s+)?public\.(\w+)[\s\S]{0,120}?add column(?: if not exists)?\s+([a-z_][a-z0-9_]*)/g)) {
  const t = tables.get(m[1]);
  if (t) t.cols.add(m[2]);
}

ok(`the migrations describe the tables (${tables.size} of them)`, tables.size > 15);
for (const t of ["admin_proposals", "admin_leads", "admin_tasks", "admin_companies", "admin_clients"]) {
  ok(`${t} was read`, tables.has(t) && tables.get(t).cols.size > 3, [...(tables.get(t)?.cols || [])].join(","));
}
/* The two facts behind the bug, stated as checks so they cannot rot. */
ok("admin_proposals has NO client_id — the column that caused this",
  !tables.get("admin_proposals").cols.has("client_id"));
ok("...it has company_id instead", tables.get("admin_proposals").cols.has("company_id"));
ok("...and title is required on an insert", tables.get("admin_proposals").required.has("title"));

/* ---------- what the app writes ---------- */
const WRITERS = {
  upsertProposal: "admin_proposals",
  upsertLead: "admin_leads",
  upsertTask: "admin_tasks",
  upsertCompany: "admin_companies",
  upsertClient: "admin_clients",
  upsertClientSite: "admin_client_sites",
  upsertNote: "admin_notes",
  upsertReminder: "admin_reminders",
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "dist", "_to_delete", ".git"].includes(e.name)) continue;
      walk(full, out);
    } else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}
const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "lib")), ...walk(join(ROOT, "api"))];

/* STRINGS ARE NOT CODE. A template literal reading `Follow up on the email:
 * ${x}` contains ` email:` — which is exactly the shape of an object key, and
 * the first version of this file duly reported that `admin_reminders` has no
 * column called `email`. Same trap as a guard firing on its own comment, in a
 * new outfit: strip what is quoted before reading what is written. */
function stripStrings(code) {
  return code.replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/* `x === "" ? null : y` puts ` null :` in front of the reader, which is not a
 * key either. Nothing that is a JS literal or keyword can be one. */
const NOT_A_KEY = new Set(["null", "true", "false", "undefined", "default", "case", "return", "await", "new", "typeof", "void", "in", "of"]);

/** The literal object at `from`, if the call opens with `({`. Null otherwise. */
function literalAt(code, from) {
  let i = from;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  if (code[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < code.length; j += 1) {
    if (code[j] === "{") depth += 1;
    else if (code[j] === "}") { depth -= 1; if (!depth) return code.slice(i + 1, j); }
  }
  return null;
}

/* ---------- and the VALUES a check constraint allows ---------- */
/* The other half of the same bug, and it found an older one: the Inbox writes
 * `link_type: "email"` and `admin_reminders` stopped allowing that value in
 * migration 0006 — which REPLACED the constraint to add 'note' and rebuilt the
 * list by hand from the 0002 original, dropping the 'email' that 0003 had added.
 * The comment above that statement calls it "widening the constraint"; the
 * statement narrows it. So "remind me about this email" had been refused by
 * Postgres for months. Migration 0031 restores it.
 *
 * A column that exists is not the same as a value it accepts, and a replacement
 * is not a widening. */
const allowed = new Map();   // "table.column" -> Set(values)
  for (const m of sql.matchAll(/create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const [, table, body] = m;
    for (const c of body.matchAll(/([a-z_][a-z0-9_]*)[^\n]*?check\s*\([\s\S]{0,120}?\1\s+in\s*\(([^)]*)\)/gi)) {
      allowed.set(`${table}.${c[1]}`, new Set([...c[2].matchAll(/'([^']+)'/g)].map((x) => x[1])));
    }
  }
  /* A later migration can widen or replace one; the LAST word wins, exactly as
   * Postgres sees it. */
  /* `check (link_type is null or link_type in (…))` is the shape three of these
   * actually use, and the first version demanded the column IMMEDIATELY after
   * `check (` — so it silently skipped every nullable one, including the very
   * constraint this guard was written to catch. A parser that quietly matches
   * nothing reads exactly like a passing test. */
  for (const m of sql.matchAll(/alter table[\s\S]{0,80}?public\.(\w+)[\s\S]{0,300}?check\s*\([\s\S]{0,160}?\b([a-z_][a-z0-9_]*)\s+in\s*\(([^)]*)\)/g)) {
    allowed.set(`${m[1]}.${m[2]}`, new Set([...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1])));
  }

/* The regression itself, pinned. If somebody rebuilds this list by hand again
 * and drops a value, this says which one and why it matters. */
{
  const rem = allowed.get("admin_reminders.link_type");
  ok("a follow-up may point at an email — dropped by 0006, restored by 0031",
    Boolean(rem && rem.has("email")), rem ? [...rem].join(", ") : "not parsed");
  ok("...and at a note, which 0006 was actually there to add", Boolean(rem && rem.has("note")));
}

let calls = 0, skipped = 0, checkedValues = 0;
const problems = [];

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  /* Comments out, strings KEPT: the literal is read from this, so the values a
   * check constraint has to approve are still here. Strings are stripped per
   * literal, below, only for finding the keys. */
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  for (const [fn, table] of Object.entries(WRITERS)) {
    const spec = tables.get(table);
    if (!spec) continue;
    for (const m of code.matchAll(new RegExp(`\\b${fn}\\(`, "g"))) {
      const rawBody = literalAt(code, m.index + m[0].length);
      if (rawBody === null) { skipped += 1; continue; }
      calls += 1;
      const body = stripStrings(rawBody);
      /* Top-level keys only: `key:` at nesting depth 0 of this object. */
      let depth = 0;
      const keys = [];
      for (let k = 0; k < body.length; k += 1) {
        const c = body[k];
        if ("{[(".includes(c)) depth += 1;
        else if ("}])".includes(c)) depth -= 1;
        else if (depth === 0) {
          const km = /^([a-z_][a-z0-9_]*)\s*:/.exec(body.slice(k));
          if (km && !NOT_A_KEY.has(km[1]) && (k === 0 || /[\s,{]/.test(body[k - 1]))) {
            keys.push(km[1]); k += km[0].length - 1;
          }
        }
      }
      for (const key of keys) {
        if (!spec.cols.has(key)) {
          problems.push(`${relative(ROOT, file)}: ${fn}({ … ${key} … }) — ${table} has no column "${key}"`);
        }
      }
      /* THE VALUES, from the literal that is actually being written — not from
       * anywhere else in the file. A first version scanned the whole file and
       * blamed `admin_clients` for a `status: "connected"` that belongs to
       * `admin_client_connections` three functions away. */
      for (const [key, values] of allowed) {
        const [t, col] = key.split(".");
        if (t !== table) continue;
        for (const v of rawBody.matchAll(new RegExp(`\\b${col}:\\s*["']([^"']+)["']`, "g"))) {
          checkedValues += 1;
          if (!values.has(v[1])) {
            problems.push(`${relative(ROOT, file)}: ${fn}({ … ${col}: "${v[1]}" … }) — ${t} only accepts ${[...values].join(", ")}`);
          }
        }
      }

      /* An INSERT is a call with no `id`. Every required column must be there,
       * unless it is spread in — which this cannot see, so a spread makes the
       * check abstain rather than accuse. */
      const spread = /\.\.\./.test(body);
      if (!keys.includes("id") && !spread) {
        for (const need of spec.required) {
          if (!keys.includes(need)) {
            problems.push(`${relative(ROOT, file)}: ${fn}({ … }) inserts without "${need}", which is NOT NULL on ${table}`);
          }
        }
      }
    }
  }
}

ok(`it read the writers (${calls} literal calls, ${checkedValues} constrained values, ${skipped} skipped as passed-by-name)`, calls >= 8);
ok("EVERY COLUMN THE APP WRITES IS A REAL COLUMN, AND EVERY REQUIRED ONE IS SENT",
  problems.length === 0, problems.join("\n       "));

/* And it has to be able to fail, or it is decoration. */
{
  const spec = tables.get("admin_proposals");
  ok("...and it would have caught the bug that shipped today",
    !spec.cols.has("client_id") && spec.required.has("title"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
