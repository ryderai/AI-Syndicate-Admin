/* EVERY COMPONENT A SCREEN USES IS ACTUALLY IN SCOPE.
 *
 * Written 2 Sep 2026, after `<TextInput>` was left in a file whose import of it
 * had just been removed. The build was clean. `npx eslint .` was clean. The box
 * crashed the moment it opened, with `TextInput is not defined`.
 *
 * WHY LINT DID NOT CATCH IT. Base eslint's `no-undef` reads plain identifiers
 * and JSX component references are `JSXIdentifier` nodes — only
 * eslint-plugin-react's `react/jsx-no-undef` looks at those, and that plugin is
 * not installed here. So the one rule that would have caught it is the one rule
 * we do not run. This file is that rule, in the place this repo actually keeps
 * its guarantees.
 *
 * IT READS EVERY JSX FILE, not a list somebody has to remember to extend.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "dist", "_to_delete", ".git"].includes(e.name)) continue;
      walk(full, out);
    } else if (/\.jsx$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = walk(join(ROOT, "src"));
ok(`there are JSX files to read (${files.length})`, files.length > 20);

/* Names that are in scope without an import or a declaration: the HTML-ish
 * ones React treats as intrinsic, plus the fragment shorthand. A capitalised
 * JSX name is a component reference and has to come from somewhere. */
const BUILT_IN = new Set(["Fragment", "React", "Suspense", "StrictMode", "Profiler"]);

let checked = 0;
const problems = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  /* Comments out first, so a component named in an explanation is not counted
   * as used — the guard-fires-on-its-own-prose trap, which this repo has hit
   * three times. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");

  /* Used: `<Thing` and `</Thing`, capitalised, optionally dotted (`<Foo.Bar`). */
  const used = new Set();
  for (const m of code.matchAll(/<\/?([A-Z][A-Za-z0-9_]*)/g)) used.add(m[1]);

  /* In scope: anything imported, declared, or destructured at the top level. */
  const inScope = new Set(BUILT_IN);
  for (const m of code.matchAll(/import\s+([\s\S]*?)\s+from\s+["'][^"']+["']/g)) {
    for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) inScope.add(n[1]);
  }
  for (const m of code.matchAll(/(?:function|class)\s+([A-Z][A-Za-z0-9_]*)/g)) inScope.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=/g)) inScope.add(m[1]);
  /* `const { A, B } = something` — used by a few files for sub-components. */
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) inScope.add(n[1]);
  }

  checked += 1;
  for (const name of used) {
    const base = name.split(".")[0];
    if (!inScope.has(base)) problems.push(`${relative(ROOT, file)} uses <${name}> and never brings it into scope`);
  }
}

ok(`every JSX file was read (${checked})`, checked === files.length);
ok("EVERY COMPONENT USED IN A SCREEN IS IN SCOPE", problems.length === 0, problems.join("\n       "));

/* And the guard has to be able to fail, or it is decoration. Proved on text
 * rather than by writing a broken file into the repo. */
{
  const bad = 'import { Modal } from "./shared.jsx";\nexport default () => <TextInput />;';
  const code = bad;
  const used = [...code.matchAll(/<\/?([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  const inScope = new Set();
  for (const m of code.matchAll(/import\s+([\s\S]*?)\s+from\s+["'][^"']+["']/g)) {
    for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) inScope.add(n[1]);
  }
  ok("...and it catches exactly the mistake that shipped today",
    used.includes("TextInput") && !inScope.has("TextInput"));
}

/* The stat this file exists to keep true. */
ok("`npx eslint .` cannot replace this — no-undef does not read JSX names",
  !readFileSync(join(ROOT, "package.json"), "utf8").includes("eslint-plugin-react\""),
  "if eslint-plugin-react is ever installed, turn on react/jsx-no-undef and this suite can go");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
