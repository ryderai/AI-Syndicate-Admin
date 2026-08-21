/* Turn the same cases into one SQL statement that calls the database's copy of
 * the rule, in the same order. Written as a generator rather than a checked-in
 * .sql file so the cases can only ever live in one place. */
import { readFileSync } from "node:fs";
const cases = JSON.parse(readFileSync(new URL("./dedupe-cases.json", import.meta.url), "utf8"));
const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const rows = cases.map((c) => `(${[c.email, c.phone, c.domain, c.company, c.city].map(lit).join(",")})`).join(",\n ");
console.log(`select coalesce(public.admin_lead_dedupe_key(e,p,d,c,ct),'<null>')\nfrom (values\n ${rows}\n) v(e,p,d,c,ct);`);
