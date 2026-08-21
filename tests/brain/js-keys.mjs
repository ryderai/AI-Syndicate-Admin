/* Print one dedupe key per case from tests/brain/dedupe-cases.json, in order.
 * Its twin is tests/brain/sql-keys.sql. sql-crosscheck.sh diffs the two. */
import { readFileSync } from "node:fs";
import { dedupeKey } from "../../lib/lead-intake.js";
const cases = JSON.parse(readFileSync(new URL("./dedupe-cases.json", import.meta.url), "utf8"));
console.log(cases.map((c) => dedupeKey(c) ?? "<null>").join("\n"));
