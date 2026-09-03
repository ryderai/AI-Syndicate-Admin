/* Inbox access + Gmail-action tests. Run with: bash tests/inbox/run.sh
 *
 * What this proves, without a single real key:
 *   1. Who may open a shared mailbox, and who may not (this is the security
 *      question the whole shared-inbox feature rests on).
 *   2. That "Done" really archives and labels, and that a client re-link never
 *      leaves a thread claiming two clients.
 *   3. That a send from a shared mailbox goes out AS the mailbox but records the
 *      person who wrote it.
 *   4. That header injection in a recipient is rejected.
 */
/* THIS SUITE HAS NEVER RUN, ON ANY MACHINE, SINCE IT WAS WRITTEN.
 *
 * Found 2 Sep 2026 by a checker asking why "0 failing" was being counted over
 * 37 suites when the folder holds 39. Two separate faults:
 *
 *   1. Every import was `./lib/…` and `./api/…`, which resolve to
 *      tests/inbox/lib/… and tests/inbox/api/… — FIXED today, they are now
 *      ../../ as every other suite writes them.
 *
 *   2. The named exports below do not exist. `lib/supabase-server.js` exports
 *      isServerConfigured, getAdminSupabase, getUserFromRequest, requireMember
 *      and readJson — there is no `DB`. So this file was written against an API
 *      that either changed or was planned and never built.
 *
 * NOT GUESSED AT. Rewriting it would mean inventing what these four checks were
 * meant to assert, and a test whose intent is invented is worse than one that
 * does not run — it passes and means nothing. It is left failing loudly, and
 * named as not-running wherever this repo reports a total, until somebody who
 * knows what the Inbox contract is meant to be finishes it. */
import { DB } from "./lib/supabase-server.js";
import { GMAIL } from "./lib/google-oauth.js";
import { resolveMailbox, listMailboxesFor, ensureLabels, clientLabelIds } from "./lib/gmail-mailbox.js";
import { checkStanding, unbackedNumbers } from "./lib/client-standing.js";
import modify from "./api/gmail-modify.js";
import threads from "./api/gmail-threads.js";
import send from "./api/gmail-send.js";
import accounts from "./api/gmail-accounts.js";

const MODIFY = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send";
const OLD = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}
const member = (id, role, email) => ({ user: { id }, membership: { role, email } });

function seed() {
  DB.rows = [
    { __table: "admin_gmail_accounts", user_id: "ryder", email_address: "growth@aisyndicate.com", refresh_token: "RT_growth", scope: MODIFY, shared: true,  display_name: "Growth" },
    { __table: "admin_gmail_accounts", user_id: "ryder", email_address: "ryder@aisyndicate.com",  refresh_token: "RT_ryder",  scope: MODIFY, shared: false, display_name: null },
    { __table: "admin_gmail_accounts", user_id: "cj",    email_address: "cj@aisyndicate.com",     refresh_token: "RT_cj",     scope: OLD,    shared: false, display_name: null },
  ];
  DB.updates = []; DB.inserts = []; DB.failSelect = null;
  GMAIL.calls = []; GMAIL.labels = [{ id: "L_inbox", name: "INBOX" }]; GMAIL.nextCreateFails409 = false;
}

function res() {
  const r = { code: null, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.redirect = (c, u) => { r.code = c; r.body = u; return r; };
  return r;
}

console.log("\n== 1. WHO CAN OPEN A SHARED MAILBOX ==");
seed();
let g = await resolveMailbox(member("ryder", "owner"), "growth@aisyndicate.com");
check("the person who connected it gets in", g.refreshToken === "RT_growth" && g.viaShared === false, JSON.stringify(g));

g = await resolveMailbox(member("andrew", "admin"), "growth@aisyndicate.com");
check("another ADMIN gets in via sharing", g.refreshToken === "RT_growth" && g.viaShared === true, JSON.stringify(g));

g = await resolveMailbox(member("rep", "sales"), "growth@aisyndicate.com");
check("SALES is refused the shared mailbox (403)", g.status === 403 && !g.refreshToken, JSON.stringify(g));

g = await resolveMailbox(member("andrew", "admin"), "ryder@aisyndicate.com");
check("a PRIVATE mailbox stays private, even from an admin", g.status === 403, JSON.stringify(g));

g = await resolveMailbox(member("ryder", "owner"), "nobody@aisyndicate.com");
check("an unconnected address is 404, not 500", g.status === 404, JSON.stringify(g));

g = await resolveMailbox(member("cj", "admin"), "cj@aisyndicate.com");
check("an old read-only connection is flagged needsReconnect", g.needsReconnect === true, JSON.stringify(g));

g = await resolveMailbox(member("ryder", "owner"), "growth@aisyndicate.com");
check("a modify-scope connection is NOT flagged", g.needsReconnect === false);

console.log("\n== 2. THE MAILBOX LIST EACH PERSON SEES ==");
seed();
let l = await listMailboxesFor(member("ryder", "owner"));
check("owner sees both of his own", l.mailboxes.length === 2, JSON.stringify(l.mailboxes.map((m) => m.email_address)));
l = await listMailboxesFor(member("andrew", "admin"));
check("admin sees only the shared one", l.mailboxes.length === 1 && l.mailboxes[0].email_address === "growth@aisyndicate.com" && l.mailboxes[0].mine === false);
l = await listMailboxesFor(member("rep", "sales"));
check("sales sees nothing (owns none)", l.mailboxes.length === 0);

console.log("\n== 3. LABELS ==");
seed();
let map = await ensureLabels("TOKEN", ["AIS/Done", "AIS/Client/Michelle Creamer"]);
check("labels get created and return ids", map["AIS/Done"] === "id_AIS/Done" && map["AIS/Client/Michelle Creamer"] === "id_AIS/Client/Michelle Creamer", JSON.stringify(map));
const before = GMAIL.calls.length;
map = await ensureLabels("TOKEN", ["AIS/Done"]);
check("an existing label is reused, not created twice", GMAIL.calls.length === before + 1 && map["AIS/Done"] === "id_AIS/Done");
GMAIL.nextCreateFails409 = true;
map = await ensureLabels("TOKEN", ["AIS/Client/Race Co"]);
check("a 409 race takes the winner's id instead of throwing", map["AIS/Client/Race Co"] === "id_AIS/Client/Race Co", JSON.stringify(map));
const ids = await clientLabelIds("TOKEN");
check("clientLabelIds finds only AIS/Client labels", ids.length === 2 && !ids.includes("L_inbox") && !ids.includes("id_AIS/Done"), JSON.stringify(ids));

console.log("\n== 4. MARKING DONE / RE-LINKING A CLIENT ==");
seed();
let r = res();
await modify({ method: "POST", __member: member("ryder", "owner"), body: { account: "growth@aisyndicate.com", threadId: "t1", done: true, markRead: true } }, r);
let applied = r.body.applied;
check("Done -> archives (removes INBOX)", applied.removeLabelIds.includes("INBOX"), JSON.stringify(applied));
check("Done -> adds AIS/Done", applied.addLabelIds.includes("id_AIS/Done"), JSON.stringify(applied));
check("Done -> marks read", applied.removeLabelIds.includes("UNREAD"), JSON.stringify(applied));

r = res();
await modify({ method: "POST", __member: member("ryder", "owner"), body: { account: "growth@aisyndicate.com", threadId: "t1", done: false } }, r);
applied = r.body.applied;
check("un-Done -> puts it back in the inbox", applied.addLabelIds.includes("INBOX") && applied.removeLabelIds.includes("id_AIS/Done"), JSON.stringify(applied));

seed();
GMAIL.labels.push({ id: "id_old", name: "AIS/Client/Old Client" });
r = res();
await modify({ method: "POST", __member: member("ryder", "owner"), body: { account: "growth@aisyndicate.com", threadId: "t1", clientLabel: "New Client" } }, r);
applied = r.body.applied;
check("re-linking adds the new client label", applied.addLabelIds.includes("id_AIS/Client/New Client"), JSON.stringify(applied));
check("re-linking strips the OLD client label", applied.removeLabelIds.includes("id_old"), JSON.stringify(applied));
check("a label is never added and removed in the same call", !applied.addLabelIds.some((i) => applied.removeLabelIds?.includes(i)), JSON.stringify(applied));

seed();
GMAIL.labels.push({ id: "id_old", name: "AIS/Client/Old Client" });
r = res();
await modify({ method: "POST", __member: member("ryder", "owner"), body: { account: "growth@aisyndicate.com", threadId: "t1", clientLabel: null } }, r);
check("unlinking removes the client label and adds nothing", r.body.applied.removeLabelIds.includes("id_old") && !r.body.applied.addLabelIds, JSON.stringify(r.body.applied));

seed();
r = res();
await modify({ method: "POST", __member: member("ryder", "owner"), body: { account: "growth@aisyndicate.com", threadId: "t1" } }, r);
check("asking for no change touches Gmail's modify endpoint zero times", r.body.changed === false && !GMAIL.calls.some((c) => c.path.endsWith("/modify")), JSON.stringify(r.body));

seed();
r = res();
await modify({ method: "POST", __member: member("rep", "sales"), body: { account: "growth@aisyndicate.com", threadId: "t1", done: true } }, r);
check("SALES cannot modify the shared mailbox", r.code === 403 && GMAIL.calls.length === 0, `code=${r.code}`);

seed();
r = res();
await modify({ method: "POST", __member: member("cj", "admin"), body: { account: "cj@aisyndicate.com", threadId: "t1", done: true } }, r);
check("an old read-only connection is refused with 409 + needsReconnect", r.code === 409 && r.body.needsReconnect === true, JSON.stringify(r.body));

console.log("\n== 5. SENDING ==");
seed();
r = res();
await send({ method: "POST", __member: member("andrew", "admin", "andrew@aisyndicate.com"), body: { account: "growth@aisyndicate.com", to: "dana@sample.com", subject: "Hello", body: "Hi there", threadId: "t1" } }, r);
check("a shared-mailbox send succeeds", r.code === 200 && r.body.ok === true, JSON.stringify(r.body));
const sentCall = GMAIL.calls.find((c) => c.path === "/messages/send");
const raw = Buffer.from(sentCall.body.raw, "base64url").toString("utf8");
check("From is the MAILBOX, not the person", /^From: Growth <growth@aisyndicate.com>/m.test(raw), raw.split("\r\n")[0]);
check("X-AIS-Sent-By records who actually sent it", /X-AIS-Sent-By: andrew@aisyndicate.com/.test(raw));
check("the reply stays on the same Gmail thread", sentCall.body.threadId === "t1");
const statusWrite = DB.inserts.find((i) => i.table === "admin_email_threads") || DB.updates.find((u) => u.table === "admin_email_threads");
check("the thread is recorded as Waiting on them", statusWrite && (statusWrite.row?.status || statusWrite.patch?.status) === "waiting", JSON.stringify(statusWrite));
check("the send is written to the activity log", DB.inserts.some((i) => i.table === "admin_activity_log" && i.row.kind === "email_sent"));

seed();
r = res();
await send({ method: "POST", __member: member("ryder", "owner", "ryder@aisyndicate.com"), body: { account: "ryder@aisyndicate.com", to: "dana@sample.com", subject: "x", body: "y" } }, r);
const own = Buffer.from(GMAIL.calls.find((c) => c.path === "/messages/send").body.raw, "base64url").toString("utf8");
check("sending from your OWN mailbox adds no sent-by header", !/X-AIS-Sent-By/.test(own));

seed();
r = res();
await send({ method: "POST", __member: member("rep", "sales", "rep@aisyndicate.com"), body: { account: "growth@aisyndicate.com", to: "dana@sample.com", subject: "x", body: "y" } }, r);
check("SALES cannot send as growth@", r.code === 403 && GMAIL.calls.length === 0, `code=${r.code}`);

seed();
r = res();
await send({ method: "POST", __member: member("ryder", "owner"), body: { account: "growth@aisyndicate.com", to: "a@b.com\nBcc: evil@x.com", subject: "x", body: "y" } }, r);
check("a header-injection recipient is rejected", r.code === 400 && GMAIL.calls.length === 0, JSON.stringify(r.body));

seed();
r = res();
await send({ method: "POST", __member: member("ryder", "owner"), body: { account: "growth@aisyndicate.com", to: "a@b.com", subject: "x", body: "   " } }, r);
check("an empty body is rejected", r.code === 400, JSON.stringify(r.body));

console.log("\n== 6. SHARING IS THE CONNECTOR'S CALL ==");
seed();
r = res();
await accounts({ method: "PATCH", __member: member("andrew", "admin"), body: { account: "growth@aisyndicate.com", shared: false }, query: {} }, r);
check("an admin cannot un-share someone else's mailbox", r.code === 403, JSON.stringify(r.body));
seed();
r = res();
await accounts({ method: "PATCH", __member: member("rep", "sales"), body: { account: "growth@aisyndicate.com", shared: true }, query: {} }, r);
check("sales cannot share a mailbox with the team", r.code === 403, JSON.stringify(r.body));

console.log("\n== 7. THE LIST IS THE INBOX, NOT ALL MAIL ==");
/* Regression: with no query, Gmail's threads.list returns ALL MAIL — archived
 * threads included — so a finished thread came back in the list forever with its
 * old status still counted in a tab. */
seed();
r = res();
await threads({ method: "GET", __member: member("ryder", "owner"), query: { account: "growth@aisyndicate.com" } }, r);
let listCall = GMAIL.calls.find((c) => c.path.startsWith("/threads?"));
check("no search -> the query is in:inbox", /q=in%3Ainbox/.test(listCall.path), listCall.path);

seed();
r = res();
await threads({ method: "GET", __member: member("ryder", "owner"), query: { account: "growth@aisyndicate.com", q: "from:dana@sample.com" } }, r);
listCall = GMAIL.calls.find((c) => c.path.startsWith("/threads?"));
check("a search replaces it, so search reaches archived mail", /q=from%3Adana/.test(listCall.path) && !/in%3Ainbox/.test(listCall.path), listCall.path);

seed();
r = res();
await threads({ method: "GET", __member: member("rep", "sales"), query: { account: "growth@aisyndicate.com" } }, r);
check("SALES cannot list the shared mailbox", r.code === 403 && GMAIL.calls.length === 0, `code=${r.code}`);

console.log("\n== 8. THE SUMMARY GUARD (client standing) ==");
const FACTS = "COUNTS: 1 tasks done, 3 still open (1 in progress, 1 blocked, 1 past their due date).";
check("a summary built only from the facts passes",
  checkStanding({ headline: "1 done, 3 open.", done: ["1 task finished."], needed: ["1 blocked task."] }, FACTS).ok);
check("an invented number is rejected",
  checkStanding({ headline: "Score is up to 74.", done: ["12 pages shipped."], needed: [] }, FACTS).ok === false);
check("the rejection names the invented numbers",
  /74/.test(checkStanding({ headline: "Score is up to 74.", done: [], needed: ["x"] }, FACTS).why || ""));
check("a promise is rejected",
  checkStanding({ headline: "On track for a great Q3.", done: ["1 task finished."], needed: ["1 blocked task."] }, FACTS).ok === false);
check("a year is not treated as an invented number",
  checkStanding({ headline: "Started in 2026.", done: ["1 task finished."], needed: ["1 blocked task."] }, FACTS).ok);
check("two empty sections are rejected",
  checkStanding({ headline: "All good.", done: [], needed: [] }, FACTS).ok === false);
check("unbackedNumbers finds nothing when every number is in the facts",
  unbackedNumbers("1 done, 3 open, 1 blocked", FACTS).length === 0);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
