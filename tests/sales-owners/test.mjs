/* EVERY NAME IN THE SHEET GETS AN ACCOUNT — the rules half.
 *
 * What is expensive here, in order:
 *   1. Handing one rep another rep's pipeline. 82 firms is a person's month.
 *   2. Taking a lead OFF somebody who already owns it. Migration 0020 closed
 *      this hole from the other side; nothing here may reopen it.
 *   3. Emailing a stranger. Most of these "reps" are one word in a column.
 *   4. Making two accounts for one person — "Brandon R" and "Brandon Roberts"
 *      are one man across 82 rows.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  slug, placeholderEmail, isPlaceholderEmail, PLACEHOLDER_DOMAIN, CONFIDENT,
  groupOwnerNames, planAccounts, planClaims, projectedTeam,
} from "../../lib/sales-owners.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, "..", "..", p), "utf8");

/* The nine spellings actually on the sheet, read from CJ's workbook 31 Aug 2026.
 * Row counts are a floor — the Drive export truncates — but the SPELLINGS are
 * the thing being tested and they are exact. */
const SHEET = [
  { name: "Larry Pike", rows: 58 }, { name: "Brandon R", rows: 51 },
  { name: "Brandon Roberts", rows: 31 }, { name: "Cameron", rows: 27 },
  { name: "Troy", rows: 7 }, { name: "Hunter Grant", rows: 6 },
  { name: "Matt Brown", rows: 6 }, { name: "Andrew", rows: 1 }, { name: "Sawyer", rows: 1 },
];
const TEAM = [
  { user_id: "u-ryder", email: "ryder@aisyndicate.com", full_name: "Ryder Schilling", active: true },
  { user_id: "u-cj", email: "cj@aisyndicate.com", full_name: "CJ Britton", active: true },
  { user_id: "u-andrew", email: "andrew@aisyndicate.com", full_name: "Andrew Soncini", active: true },
];

console.log("\nNOBODY GETS EMAILED");

{
  const API = src("api/sales-owners.js");
  ok("the endpoint calls createUser", /auth\.admin\.createUser/.test(API));
  ok("the endpoint NEVER calls inviteUserByEmail", !/inviteUserByEmail/.test(API));
  ok("...and never generateLink either", !/generateLink/.test(API));
  ok("the invite endpoint is untouched and still the way a real person is invited",
    /inviteUserByEmail/.test(src("api/invite.js")));
}
ok("a placeholder address is on a domain that resolves nowhere (RFC 2606)",
  PLACEHOLDER_DOMAIN.endsWith(".invalid"));
ok("...which is recognisable afterwards", isPlaceholderEmail(`x@${PLACEHOLDER_DOMAIN}`));
ok("...and a real address is not mistaken for one", !isPlaceholderEmail("larry@aisyndicate.com"));

console.log("\nONE PERSON, ONE ACCOUNT");

{
  const { groups, ambiguous } = groupOwnerNames(SHEET);
  eq("nine spellings are eight people", groups.length, 8);
  const brandon = groups.find((g) => /Roberts/.test(g.label));
  eq("Brandon R folds into Brandon Roberts", brandon.spellings.sort(), ["Brandon R", "Brandon Roberts"]);
  eq("...and their rows add up", brandon.rows, 82);
  ok("the fuller spelling is the label, not the abbreviation", brandon.label === "Brandon Roberts");
  ok("Matt Brown does NOT fold into anything", groups.some((g) => g.label === "Matt Brown"));
  ok("Larry Pike stands alone", groups.some((g) => g.label === "Larry Pike" && g.spellings.length === 1));
  eq("nothing was ambiguous on the real sheet", ambiguous.length, 0);
  ok("the biggest pipeline is listed first", groups[0].rows >= groups[groups.length - 1].rows);
}
{
  /* THE ONE THAT MUST REFUSE. Two Brandons with different surnames: "Brandon R"
   * could be either, and picking one hands over 51 rows of somebody's work. */
  const { groups, ambiguous } = groupOwnerNames([
    { name: "Brandon R", rows: 51 }, { name: "Brandon Roberts", rows: 31 }, { name: "Brandon Reyes", rows: 9 },
  ]);
  ok("an abbreviation two people could own is REFUSED", ambiguous.some((a) => a.name === "Brandon R"), JSON.stringify(ambiguous));
  ok("...and it says who it could have been", (ambiguous[0].couldBe || []).length === 2);
  ok("...and the two full names still each get an account", groups.length === 2);
}
{
  const { ambiguous } = groupOwnerNames([{ name: "Andrew", rows: 1 }, { name: "Andrew Soncini", rows: 4 }, { name: "Andrew Pike", rows: 2 }]);
  ok("a bare FIRST name two people could own is refused too", ambiguous.some((a) => a.name === "Andrew"));
}
eq("a blank owner cell is not a person", groupOwnerNames([{ name: "  ", rows: 9 }]).groups.length, 0);
eq("case does not split one person in two", groupOwnerNames([{ name: "larry pike", rows: 2 }, { name: "Larry Pike", rows: 3 }]).groups.length, 1);

console.log("\nSOMEBODY WHO IS ALREADY HERE IS NOT MADE AGAIN");

{
  const { groups } = groupOwnerNames(SHEET);
  const plan = planAccounts(groups, TEAM, {});
  ok('"Andrew" is NOT quietly treated as Andrew Soncini', !plan.already.some((a) => a.label === "Andrew"), JSON.stringify(plan.already));
  ok("...it is put in front of a person instead", plan.needsAPerson.some((n) => n.label === "Andrew" && n.couldBe === "Andrew Soncini"), JSON.stringify(plan.needsAPerson));
  ok("...and no account is made for it either way", !plan.create.some((c) => c.fullName === "Andrew"));
  eq("the other seven are created", plan.create.length, 7);
  ok("every one of them gets an address", plan.create.every((c) => /@/.test(c.email)));
  ok("...all of them placeholders when nothing was typed", plan.create.every((c) => c.placeholder));
  ok("no two people are handed the same address", new Set(plan.create.map((c) => c.email)).size === plan.create.length);
  ok("a real address typed in is used instead, and is not a placeholder",
    planAccounts(groups, TEAM, { "Larry Pike": "larry@aisyndicate.com" }).create
      .some((c) => c.fullName === "Larry Pike" && c.email === "larry@aisyndicate.com" && c.placeholder === false));
}
eq("two people with the same slug do not collide",
  placeholderEmail("Larry Pike", [`larry-pike@${PLACEHOLDER_DOMAIN}`]), `larry-pike-2@${PLACEHOLDER_DOMAIN}`);
eq("accents and punctuation become a plain address", slug("José O'Neill-Smith"), "jose-o-neill-smith");
ok("a name with nothing usable in it still produces an address", /@/.test(placeholderEmail("!!!", [])));

console.log("\nHANDING THE ROWS BACK");

const FULL_TEAM = [...TEAM,
  { user_id: "u-larry", email: `larry-pike@${PLACEHOLDER_DOMAIN}`, full_name: "Larry Pike", active: true },
  { user_id: "u-brandon", email: `brandon-roberts@${PLACEHOLDER_DOMAIN}`, full_name: "Brandon Roberts", active: true },
];
{
  const leads = [
    { id: "l1", owner_id: null, imported_owner_name: "Larry Pike" },
    { id: "l2", owner_id: null, imported_owner_name: "Brandon R" },
    { id: "l3", owner_id: null, imported_owner_name: "Brandon Roberts" },
    { id: "l4", owner_id: "u-cj", imported_owner_name: "Larry Pike" },
    { id: "l5", owner_id: null, imported_owner_name: null },
    { id: "l6", owner_id: null, imported_owner_name: "Somebody Else" },
  ];
  const p = planClaims(leads, FULL_TEAM);
  eq("three rows are handed back", p.claim.length, 3);
  eq("both Brandon spellings reach the same man",
    [...new Set(p.claim.filter((c) => /Brandon/.test(c.name)).map((c) => c.user_id))], ["u-brandon"]);
  ok("A ROW THAT ALREADY HAS AN OWNER IS NEVER TOUCHED", !p.claim.some((c) => c.id === "l4"));
  eq("...and that is counted, not silently skipped", p.skipped.alreadyOwned, 1);
  eq("a row with no owner name is left alone", p.skipped.noNameOnTheRow, 1);
  ok("a name matching nobody is reported with its row count", p.unresolved.some((u) => u.name === "Somebody Else" && u.rows === 1));
  ok("every claim says WHICH rule matched it", p.claim.every((c) => ["exact", "initial", "first"].includes(c.how)));
}
{
  /* The one that must never claim. Two Brandons on the roster and a row that
   * just says "Brandon R" — the sheet cannot say which, so neither can this. */
  const twoBrandons = [...FULL_TEAM, { user_id: "u-b2", email: "b2@x.com", full_name: "Brandon Reyes", active: true }];
  const p = planClaims([{ id: "l1", owner_id: null, imported_owner_name: "Brandon R" }], twoBrandons);
  eq("an ambiguous name claims NOTHING", p.claim.length, 0);
  eq("...and is reported as ambiguous, with the row still unclaimed", p.unresolved[0].how, "ambiguous");
}
{
  const off = [...FULL_TEAM.slice(0, 3), { user_id: "u-larry", email: "x@y.com", full_name: "Larry Pike", active: false }];
  eq("a DEACTIVATED account is never handed rows",
    planClaims([{ id: "l1", owner_id: null, imported_owner_name: "Larry Pike" }], off).claim.length, 0);
}
eq("no leads at all is not an error", planClaims([], FULL_TEAM).claim.length, 0);
eq("no team at all claims nothing", planClaims([{ id: "l1", owner_id: null, imported_owner_name: "Larry Pike" }], []).claim.length, 0);

console.log("\nA FIRST NAME IS NOT ENOUGH TO HAND SOMEBODY A PIPELINE");

/* THE WORST DEFECT IN THE FIRST VERSION OF THIS FILE, found by an adversarial
 * checker on 31 Aug: planAccounts accepted ANY truthy matchOwner hit, including
 * matchOwner's "first" rule, which fires on a shared first name alone. */
eq("only exact and initial are acted on", CONFIDENT, ["exact", "initial"]);
{
  const roster = [{ user_id: "u-aik", email: "troy@x.com", full_name: "Troy Aikman", active: true }];
  const { groups } = groupOwnerNames([{ name: "Troy Bennett", rows: 40 }, { name: "Troy", rows: 5 }]);
  const plan = planAccounts(groups, roster, {});
  ok("Troy Bennett is NOT mistaken for Troy Aikman", !plan.already.some((a) => a.matchedAs === "Troy Aikman"), JSON.stringify(plan.already));
  ok("...he is put in front of a person", plan.needsAPerson.some((n) => n.label === "Troy Bennett"));
  eq("...and none of his 45 rows are claimed for the other Troy",
    planClaims([{ id: "l1", owner_id: null, imported_owner_name: "Troy Bennett" }], roster).claim.length, 0);
  ok("...and the refusal says only the first name matched",
    /first name/.test(planClaims([{ id: "l1", owner_id: null, imported_owner_name: "Troy Bennett" }], roster).unresolved[0].how));
}
{
  /* But once his OWN account exists, the same name matches exactly and the rows
   * go where they belong. The rule refuses a guess, it does not refuse work. */
  const roster = [{ user_id: "u-aik", email: "troy@x.com", full_name: "Troy Aikman", active: true },
                  { user_id: "u-ben", email: "b@x.com", full_name: "Troy Bennett", active: true }];
  const p = planClaims([{ id: "l1", owner_id: null, imported_owner_name: "Troy Bennett" }], roster);
  eq("the right Troy gets it", p.claim[0].user_id, "u-ben");
}

console.log("\nTHIS FILE AND matchOwner MUST NEVER DISAGREE");

{
  /* The grouping screen showed 5 rows as Baker's and the run then handed over
   * none of them, because this file read the whole surname and matchOwner reads
   * only the second word. */
  const names = [{ name: "Mary Jo Baker", rows: 10 }, { name: "Mary Jo B", rows: 5 }, { name: "Mary Ann Cole", rows: 8 }];
  const { groups } = groupOwnerNames(names);
  eq("a two-word surname does not fold on this side either", groups.length, 3);
}
{
  /* The property that matters, checked on every spelling: whatever this file
   * groups, matchOwner must then be able to claim. */
  const { groups } = groupOwnerNames(SHEET);
  const plan = planAccounts(groups, TEAM, {});
  const after = projectedTeam(TEAM, plan.create);
  const leads = SHEET.map((c, i) => ({ id: `l${i}`, owner_id: null, imported_owner_name: c.name }));
  const claimed = planClaims(leads, after);
  const createdLabels = new Set(plan.create.map((c) => c.fullName));
  const shouldClaim = SHEET.filter((c) => {
    const g = groups.find((x) => x.spellings.includes(c.name));
    return g && createdLabels.has(g.label);
  });
  eq("every spelling this file makes an account for is then claimable",
    claimed.claim.length, shouldClaim.length);
  ok("...and none of them lands on somebody who was already here",
    claimed.claim.every((c) => String(c.user_id).startsWith("will-be:")), JSON.stringify(claimed.claim));
}

console.log("\nTHE SCREEN'S NUMBER IS THE NUMBER THE BUTTON WILL DO");

{
  const { groups } = groupOwnerNames(SHEET);
  const plan = planAccounts(groups, TEAM, {});
  const leads = [];
  for (let i = 0; i < 40; i += 1) leads.push({ id: `l${i}`, owner_id: null, imported_owner_name: "Larry Pike" });
  const before = planClaims(leads, TEAM).claim.length;
  const after = planClaims(leads, projectedTeam(TEAM, plan.create)).claim.length;
  eq("counted against today's roster it would say nothing", before, 0);
  eq("counted against the roster as it WILL be, it says forty", after, 40);
  ok("...which is the number the screen has to show", after !== before);
}

console.log("\nRULES THE FIRST VERSION HAD NO TEST FOR");

{
  const g = groupOwnerNames([{ name: "Zed", rows: 1 }, { name: "Aaron Smith", rows: 99 }]);
  eq("the biggest pipeline really is sorted first", g.groups[0].label, "Aaron Smith");
}
{
  const g = groupOwnerNames([{ name: "larry pike", rows: 2 }, { name: "LARRY PIKE", rows: 1 }, { name: "Larry Pike", rows: 3 }]);
  eq("a case-only clash is one person", g.groups.length, 1);
  eq("...whose rows all add up", g.groups[0].rows, 6);
  eq("...and the properly-capitalised spelling is the one shown", g.groups[0].label, "Larry Pike");
}
{
  const g = groupOwnerNames([{ name: "Cameron", rows: 5 }]);
  eq("a bare first name nobody extends stands on its own", g.groups.length, 1);
  eq("...and is not reported as ambiguous", g.ambiguous.length, 0);
}
{
  const roster = [{ user_id: "u1", email: "a@x.com", full_name: "Sam Smith", active: true },
                  { user_id: "u2", email: "b@x.com", full_name: "Sam Smythe", active: true }];
  const { groups } = groupOwnerNames([{ name: "Sam", rows: 20 }]);
  const plan = planAccounts(groups, roster, {});
  ok("a name two roster members answer to makes NO account", !plan.create.length, JSON.stringify(plan.create));
  ok("...and is reported rather than guessed", plan.already.some((a) => a.how === "ambiguous"));
}

console.log("\nTHE WRITE ITSELF IS GUARDED");
{
  const API = src("api/sales-owners.js");
  ok("every claim update also insists the row is STILL unowned", /\.is\("owner_id", null\)/.test(API));
  ok("the roster is RE-READ after the accounts are made, rather than assumed",
    /freshTeam = await readTeam\(admin\)/.test(API) && /planClaims\(leads, freshTeam\)/.test(API));
  ok("an account that already exists is found before one is created, so a half-finished run can be retried",
    /findAuthUser/.test(API) && /listUsers/.test(API));
  ok("the claim carries cadence_started_at as well as claimed_at — one without the other is a cadence that began at the epoch",
    /cadence_started_at: at/.test(API) && /claimed_at: at/.test(API));
  ok("the claim date comes from first_contact_at, not from today",
    /c\.firstContactAt \|\| nowIso/.test(API));
  ok("a row that changes hands leaves a line on its own timeline",
    /admin_lead_activity/.test(API) && /type: "assigned"/.test(API));
  ok("a partial lead read is said out loud rather than swallowed",
    /if \(out\.error\) \{/.test(API) && /do not treat it as the whole pipeline/.test(API));
  ok("a typed email is format-checked before anything is created",
    /EMAIL_OK/.test(API));
  ok("the endpoint has a time ceiling in vercel.json — it is the heaviest route here",
    /"api\/sales-owners\.js"/.test(src("vercel.json")));
  ok("only an owner or an admin can reach it", /requireMember\(req, \["owner", "admin"\]\)/.test(API));
  ok("a real run has to be asked for — dry run is the default", /dryRun = body\?\.dryRun !== false/.test(API));
  ok("new accounts are made as sales reps, never admins", /role: "sales"/.test(API) && !/role: "owner"/.test(API));
  ok("leads are read a page at a time, so 3,663 rows are not silently 1,000", /fetchPaged/.test(API));
}

console.log("\nTHE ENDPOINT ITSELF ANSWERS, RATHER THAN 500-ING");
{
  /* START-HERE's trap 1: a new api/ route that throws shows its reason only in
   * a terminal nobody is reading. So the handler is actually CALLED here, with
   * no keys and no Authorization header. It must refuse politely. */
  const { default: handler } = await import("../../api/sales-owners.js");
  let code = null, payload = null;
  const res = { status(c) { code = c; return this; }, json(b) { payload = b; return this; }, setHeader() {} };
  await handler({ method: "GET", headers: {} }, res);
  eq("no token, no keys — 401, not a crash", code, 401);
  ok("...and it says so in words", typeof payload?.error === "string" && payload.error.length > 4, JSON.stringify(payload));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
