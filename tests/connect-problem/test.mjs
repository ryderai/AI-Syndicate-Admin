/* WHY THE MAILBOX DID NOT CONNECT — the words a rep actually reads.
 *
 * Two rules this pins, both of which were broken on 31 Aug 2026:
 *   1. A reason is never shown raw. "browser_mismatch" is not a message.
 *   2. A reason is never SWALLOWED either — an unknown one comes through,
 *      because a friendly sentence that is wrong is worse than a raw string.
 * And the structural one: the connect screen must warn about org_internal
 * BEFORE the button, because that failure never reaches our code at all.
 */
import { readFileSync } from "node:fs";
import { explainConnectFailure, COMPANY_ADDRESS_NOTE } from "../../src/lib/connectProblem.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

console.log("\nEVERY REASON THE CALLBACK CAN SEND");

/* The list is taken from api/gmail-callback.js, not invented here. If that file
 * grows a new reason and this test does not, the loop below fails — which is
 * the point. A test that agrees with itself is not a test. */
const CALLBACK = readFileSync(new URL("../../api/gmail-callback.js", import.meta.url), "utf8");
const emitted = [...CALLBACK.matchAll(/reason:\s*"([a-z_]+)"/g)].map((m) => m[1]);
ok("the callback still emits reasons this test can read", emitted.length >= 5, `found ${emitted.length}`);

for (const reason of [...new Set(emitted)]) {
  const out = explainConnectFailure(reason);
  ok(`"${reason}" is translated, not echoed`, out !== reason && out.length > 20, `got "${out}"`);
  ok(`"${reason}" has no code-speak left in it`, !/_/.test(out), `got "${out}"`);
}

console.log("\nGOOGLE'S OWN REFUSALS");

const denied = explainConnectFailure("access_denied");
ok("access_denied says nothing was connected", /nothing was connected/i.test(denied), denied);
ok("access_denied points at the company address", /aisyndicate\.com/.test(denied), denied);
const org = explainConnectFailure("org_internal");
ok("org_internal names the company address", /aisyndicate\.com/.test(org), org);

console.log("\nIT NEVER SWALLOWS AND NEVER BLANKS");

ok("an unknown reason comes through rather than vanishing",
  explainConnectFailure("some_new_thing_google_invented").includes("some_new_thing"));
ok("a url-encoded sentence from the token exchange is decoded",
  explainConnectFailure("token%20exchange%20failed") === "token exchange failed");
ok("a stray %% does not throw, it comes back as it was",
  explainConnectFailure("100% broken") === "100% broken");
for (const empty of ["", null, undefined, "   "]) {
  const out = explainConnectFailure(empty);
  ok(`${JSON.stringify(empty)} still produces a real sentence`, out.length > 20, `got "${out}"`);
}

console.log("\nTHE ONE FAILURE THAT NEVER REACHES US IS WARNED ABOUT UP FRONT");

/* org_internal happens on Google's page. There is no redirect back, so no
 * toast, no ?gmail=error, nothing. The only possible warning is on the connect
 * screen itself. */
const INBOX = readFileSync(new URL("../../src/components/admin/Inbox.jsx", import.meta.url), "utf8");
ok("the connect screen renders the company-address note",
  INBOX.includes("COMPANY_ADDRESS_NOTE"));
ok("...above the Continue with Google button, not below it",
  INBOX.indexOf("COMPANY_ADDRESS_NOTE") < INBOX.indexOf("Continue with Google"));
ok("the note names the domain", /aisyndicate\.com/.test(COMPANY_ADDRESS_NOTE), COMPANY_ADDRESS_NOTE);
ok("the note says the refusal is Google's, not ours",
  /google/i.test(COMPANY_ADDRESS_NOTE), COMPANY_ADDRESS_NOTE);
ok("the toast no longer prints the raw reason",
  !INBOX.includes('params.get("reason") || "unknown reason"'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
