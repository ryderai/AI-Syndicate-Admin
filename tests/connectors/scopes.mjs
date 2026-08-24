/* SCOPE_BY_ROLE is private to lib/brain-context.js on purpose — nothing should
 * be able to widen it by importing it. So this file READS the source and pulls
 * the lists out of it, rather than the test agreeing with a copy somebody has
 * to remember to update. A test that agrees with a copy is not a test. */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../lib/brain-context.js", import.meta.url), "utf8");
const block = /const SCOPE_BY_ROLE = \{([\s\S]*?)\n\};/.exec(src)?.[1];
if (!block) throw new Error("SCOPE_BY_ROLE could not be found in lib/brain-context.js — the test cannot check what it cannot read.");

const out = {};
for (const m of block.matchAll(/(\w+):\s*\[([\s\S]*?)\]/g)) {
  out[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}
for (const role of ["owner", "admin", "sales"]) {
  if (!out[role]?.length) throw new Error(`No scope list was read for the "${role}" role.`);
}
export const SCOPE_BY_ROLE_TEST_ONLY = out;
