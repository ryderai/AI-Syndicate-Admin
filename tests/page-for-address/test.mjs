/* WHERE DOES THIS ADDRESS PUT THIS PERSON?
 *
 * src/lib/pageForAddress.js is the only thing that answers that, and until
 * 31 Aug 2026 it lived inside AdminDashboard.jsx where no test could reach it.
 * What that cost: a sales rep who connected their own mailbox was sent by
 * api/gmail-callback.js to `#/dashboard/inbox` — the SHARED team inbox, a page
 * a rep may never open — fell through to Overview, and Overview does not read
 * `?gmail=connected`. The mailbox was connected. The screen said nothing.
 *
 * So the first section here is that exact bounce, and the rest is everything
 * that already worked and must keep working.
 *
 * The role lists are the REAL ones, imported from Sidebar.jsx. A hand-written
 * copy of them is a test that agrees with itself.
 */
import { readFileSync } from "node:fs";
import { pageForAddress, SPLIT_FOR_ROLE } from "../../src/lib/pageForAddress.js";

/* Node cannot import a .jsx file, so SECTIONS is read out of Sidebar.jsx as
 * source and evaluated — the same trick tests/sales/test.mjs uses, and for the
 * same reason: a hand-copied role list is a test that agrees with itself.
 * If the declaration changes shape this throws, which is the point. */
const SIDEBAR = readFileSync(new URL("../../src/components/admin/Sidebar.jsx", import.meta.url), "utf8");
function literal(src, name) {
  const start = src.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`${name} is not declared at the top level of Sidebar.jsx any more`);
  const open = src.indexOf("=", start) + 1;
  let depth = 0, i = open, started = false;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{" || c === "[") { depth += 1; started = true; }
    else if (c === "}" || c === "]") { depth -= 1; if (started && depth === 0) { i += 1; break; } }
  }
  if (!started || depth !== 0) throw new Error(`could not read the ${name} literal`);
  return new Function(`return (${src.slice(open, i)});`)();
}
const SECTIONS = literal(SIDEBAR, "SECTIONS");
/* pageIdsForRole, two lines, exactly as Sidebar.jsx defines it. */
const pageIdsForRole = (role) => SECTIONS.filter((g) => g.roles.includes(role))
  .flatMap((g) => g.items.flatMap(([id, , kids]) => [id, ...(kids || []).map(([kid]) => kid)]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const REP = { role: "sales", allowedIds: pageIdsForRole("sales") };
const OWNER = { role: "owner", allowedIds: pageIdsForRole("owner") };
const ADMIN = { role: "admin", allowedIds: pageIdsForRole("admin") };

const at = (who, route) => pageForAddress({ route, ...who });
const eq = (name, got, want) => ok(name, got === want, `got "${got}", wanted "${want}"`);

console.log("\nTHE GMAIL SIGN-IN COMES BACK — the bug this file exists for");

/* api/gmail-callback.js redirects to "#/dashboard/inbox?gmail=connected".
 * It runs before anything knows who signed in, so it names one page for
 * everybody. That page is not a rep's. */
const repBack = at(REP, "/dashboard/inbox?gmail=connected&account=rep%40aisyndicate.com");
eq("a rep lands on their OWN mailbox, not Overview", repBack.section, "gmail");
eq("...and the query survives, because the toast is read out of it",
  repBack.query, "?gmail=connected&account=rep%40aisyndicate.com");
ok("...and the address is rewritten, because rawPage still says inbox",
  repBack.rawPage === "inbox" && repBack.rawPage !== repBack.section);

const repFailed = at(REP, "/dashboard/inbox?gmail=error&reason=browser_mismatch");
eq("a FAILED connect reaches the rep's page too — a silent failure is worse",
  repFailed.section, "gmail");
eq("...carrying the reason", repFailed.query, "?gmail=error&reason=browser_mismatch");

eq("an owner still lands on the shared inbox, unchanged",
  at(OWNER, "/dashboard/inbox?gmail=connected").section, "inbox");
eq("an admin too", at(ADMIN, "/dashboard/inbox?gmail=connected").section, "inbox");

console.log("\nTHE GATE — a page not in your role's list does not exist");

ok("`inbox` is not a rep page at all", !pageIdsForRole("sales").includes("inbox"));
ok("`gmail` IS a rep page", pageIdsForRole("sales").includes("gmail"));
ok("`gmail` is NOT an owner page — an owner's own mail is a mailbox on the shared Inbox page",
  !pageIdsForRole("owner").includes("gmail"));
eq("a rep pasting the Sales stats address lands on their own landing page, not Stats",
  at(REP, "/dashboard/sales-stats").section, "overview");
eq("a rep pasting the Vault address lands on their own page",
  at(REP, "/dashboard/vault").section, "overview");
eq("a made-up page id falls back", at(OWNER, "/dashboard/nonsense").section, "overview");

console.log("\nTHE SPLITS AND RENAMES THAT ALREADY WORKED");

eq("rep: /leads -> the floor", at(REP, "/dashboard/leads").section, "floor");
eq("rep: /mine -> the floor", at(REP, "/dashboard/mine").section, "floor");
eq("rep: /sales -> the floor", at(REP, "/dashboard/sales").section, "floor");
eq("rep: /work -> overview (Work stopped being a rep page)", at(REP, "/dashboard/work").section, "overview");
eq("owner: /leads -> sales (the rename, not the split)", at(OWNER, "/dashboard/leads").section, "sales");
eq("owner: /customers -> clients", at(OWNER, "/dashboard/customers").section, "clients");
eq("owner: /sales stays sales", at(OWNER, "/dashboard/sales").section, "sales");
eq("a bare /dashboard lands on Overview", at(OWNER, "/dashboard").section, "overview");
eq("a bare /dashboard/ lands on Overview", at(OWNER, "/dashboard/").section, "overview");

console.log("\nTHE QUERY AND THE DEEP PATH ARE NEVER EATEN");

eq("a client deep link keeps its id", at(OWNER, "/dashboard/clients?id=abc123").query, "?id=abc123");
eq("...and still renders Clients", at(OWNER, "/dashboard/clients?id=abc123").section, "clients");
eq("no query means no question mark", at(OWNER, "/dashboard/clients").query, "");
eq("anything after the page id is ignored for routing",
  at(OWNER, "/dashboard/clients/abc123").section, "clients");

console.log("\nIT FAILS CLOSED");

/* No member yet — the first paint after a reload, before the membership row
 * comes back. A role of null must never be handed a page by the split map. */
const nobody = pageForAddress({ route: "/dashboard/inbox?gmail=connected", role: null, allowedIds: [] });
eq("no member, no allowed pages: the last-resort page id is never blank", nobody.section, "work");
eq("a role nobody taught this file about gets the same last resort",
  pageForAddress({ route: "/dashboard/sales", role: "intern", allowedIds: [] }).section, "work");
eq("an empty route does not crash and does not blank the page",
  pageForAddress({ route: "", role: "sales", allowedIds: pageIdsForRole("sales") }).section, "overview");

console.log("\nEVERY SPLIT POINTS AT A PAGE THAT ROLE REALLY HAS");

/* The kind of typo that only shows up when somebody clicks it: a split entry
 * pointing at a page id the role's own menu does not carry would silently fall
 * back to the landing page, which is exactly the quiet broken link the split
 * map was written to stop. */
for (const [role, map] of Object.entries(SPLIT_FOR_ROLE)) {
  const ids = pageIdsForRole(role);
  for (const [from, to] of Object.entries(map)) {
    ok(`${role}: ${from} -> ${to} is a real page for that role`, ids.includes(to),
      `${to} is not in [${ids.join(", ")}]`);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
