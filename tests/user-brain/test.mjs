/* A REP'S OWN AI RULES — the pure half.  Aug 27 2026
 *
 * Plain node against the real module the browser loads. No mocks of our own
 * code: a test that agrees with a stub is not a test.
 *
 * THERE IS ESSENTIALLY ONE FUNCTION HERE AND IT IS A GATE, so this file is
 * mostly one question asked many ways: does a personal rule containing a number
 * ever get saved. The answer has to be no, and the reason is mechanical rather
 * than stylistic — it is written out above checkPersonalRule in
 * lib/sales-rules.js and restated as an assertion NAME below, because a reason
 * that only lives in a comment is a reason the next person deletes.
 */
import { readFileSync } from "node:fs";
import { checkPersonalRule, PERSONAL_RULE_MAX_CHARS } from "../../lib/sales-rules.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const refused = (text) => checkPersonalRule(text).ok === false;
const errorFor = (text) => String(checkPersonalRule(text).error || "");

/* ================================================================== */
console.log("\nWHY A NUMBER IN A PERSONAL RULE IS NOT A STYLE PROBLEM");
/* ================================================================== */
/* THE MECHANISM, AS AN ASSERTION RATHER THAN A COMMENT. The honesty gate works
 * by checking every number in a draft against the fact sheet the model was
 * shown, and the personal rules HAVE to be part of that fact sheet or the gate
 * throws away honest answers for using words it was never given. So a number
 * typed into a personal rule enters the pool the gate checks against — and the
 * gate would then let the AI write it to a prospect, because as far as the gate
 * can tell, we told it that. One rep's sentence becomes a claim the agency made. */
ok("A NUMBER TYPED INTO A PERSONAL RULE WOULD ENTER THE POOL THE HONESTY GATE CHECKS ANSWERS AGAINST, SO THE GATE WOULD LET THE AI WRITE IT TO A PROSPECT — WHICH IS WHY THIS IS REFUSED AT THE DOOR",
  refused("Mention that our clients see a 40% lift in AI citations."));
/* Read out of the source, so the reason cannot be deleted from the file while
 * this suite still claims to be guarding it. */
const RULES_SRC = readFileSync(new URL("../../lib/sales-rules.js", import.meta.url), "utf8");
ok("...and the same reason is still written above the function, in words",
  /honesty gate[\s\S]{0,900}?enters the pool/i.test(RULES_SRC)
  || /enters the pool[\s\S]{0,900}?gate/i.test(RULES_SRC),
  "the header explaining WHY has gone from lib/sales-rules.js");

/* ================================================================== */
console.log("\nIT REFUSES ANY DIGIT — NOT 'ANY PERCENTAGE', ANY DIGIT");
/* ================================================================== */
ok("a percentage is refused", refused("Say we get a 40% lift."));
ok("a price is refused", refused("Never quote under $500."));
ok("a year is refused", refused("Mention we have been doing this since 2026."));
ok("a figure with commas is refused", refused("We have generated 1,200 leads."));
ok("a decimal is refused", refused("Average score is 6.5 out of ten."));
ok("a digit inside a word is refused", refused("Use the GEO2 framing."));
/* THE ONE THE STRICT VERSION EXISTS FOR. "Allow a single digit, refuse two in a
 * row" lets "if their score is under 6, name it" through — and a bare 6 in the
 * pool is a number the model may then attach to a firm. */
ok("A SINGLE BARE DIGIT IS REFUSED — 'Keep it to 4 sentences' is not allowed",
  refused("Keep it to 4 sentences."));
ok("...and so is 'if their score is under 6, name it', which a two-digits-in-a-row rule would have let through",
  refused("If their score is under 6, name it."));
ok("a phone number in a sign-off is refused", refused("Sign off with — Cam, AI Syndicate, 555-123-4567"));
ok("a room for one digit is not left anywhere — every single digit is refused",
  "0123456789".split("").every((d) => refused(`Write like this ${d}`)));

console.log("  -- and the refusal says where the thing they wanted DOES belong");
/* A refusal that only says no gets worked around. Length and a phone number are
 * the two things a rep actually wants a digit for, and both have a real home. */
ok("THE REFUSAL POINTS AT THE LENGTH SETTING, so 'keep it to 4 sentences' has somewhere to go",
  /length is a setting/i.test(errorFor("Keep it to 4 sentences.")), errorFor("Keep it to 4 sentences."));
ok("THE REFUSAL POINTS AT THE GMAIL SIGNATURE, so a phone number has somewhere to go",
  /gmail signature/i.test(errorFor("— Cam, AI Syndicate, 555-123-4567")), errorFor("— Cam, AI Syndicate, 555-123-4567"));
ok("...and it says WHY, not just no",
  /prospect/i.test(errorFor("Say we get a 40% lift.")), errorFor("Say we get a 40% lift."));
ok("the refusal never quotes the number back, so it cannot be copied out of the error",
  !/40/.test(errorFor("Say we get a 40% lift.")));

/* ================================================================== */
console.log("\nAN EMPTY RULE, AND ONE TOO LONG TO BE A RULE");
/* ================================================================== */
ok("nothing typed is refused", refused(""));
ok("undefined is refused rather than throwing", refused(undefined));
ok("null is refused rather than saving the word 'null'", refused(null));
ok("whitespace only is refused", refused("   \n\t  "));
eq("...and the refusal asks for the rule rather than explaining numbers",
  /write the rule first/i.test(errorFor("")), true);
ok(`exactly PERSONAL_RULE_MAX_CHARS (${PERSONAL_RULE_MAX_CHARS}) characters is allowed`,
  checkPersonalRule("a".repeat(PERSONAL_RULE_MAX_CHARS)).ok);
ok("one character over the limit is refused", refused("a".repeat(PERSONAL_RULE_MAX_CHARS + 1)));
ok("...and the refusal names both the length and the limit, so it is actionable",
  errorFor("a".repeat(PERSONAL_RULE_MAX_CHARS + 1)).includes(String(PERSONAL_RULE_MAX_CHARS + 1))
  && errorFor("a".repeat(PERSONAL_RULE_MAX_CHARS + 1)).includes(String(PERSONAL_RULE_MAX_CHARS)));
ok("...and says why a long rule is a problem — it pushes the facts out of the reading",
  /facts/i.test(errorFor("a".repeat(PERSONAL_RULE_MAX_CHARS + 1))));
/* The cap is measured AFTER trimming, so trailing whitespace cannot make an
 * otherwise fine rule unsaveable. */
ok("padding does not count towards the limit",
  checkPersonalRule(`  ${"a".repeat(PERSONAL_RULE_MAX_CHARS)}  `).ok);
/* The database's own cap is 2,000 (0022). If these two ever disagree, a rule
 * passes the gate and then fails to save with a Postgres error nobody can read. */
const SQL = readFileSync(new URL("../../supabase/migrations/0022_personal_brain.sql", import.meta.url), "utf8");
const dbCap = /admin_user_brain_body_len_check[\s\S]*?check \(length\(body\) <= (\d+)\)/.exec(SQL);
ok("0022 declares a body length check", Boolean(dbCap));
eq("the gate's limit and the database's CHECK are the same number", Number(dbCap[1]), PERSONAL_RULE_MAX_CHARS);
/* And the database refuses an empty body too, so the two halves agree on that.
 *
 * THE CHARACTER SET IS THE POINT. `btrim(body)` with no second argument only
 * trims SPACES, so a body of one newline or one tab walked straight through the
 * check and saved as a rule with no words in it — a blank bullet on the page and
 * a blank line in every draft's prompt. Fixed in 0022 on Aug 27 2026 after this
 * suite's own SQL half caught it, and this assertion now demands the spelled-out
 * set rather than the bare call. */
ok("0022 refuses an empty body, and trims TABS AND NEWLINES too, not only spaces",
  /admin_user_brain_body_check[\s\S]*?check \(length\(btrim\(body, E' \\t\\r\\n'\)\) > 0\)/.test(SQL));

/* ================================================================== */
console.log("\nWHAT A REAL RULE LOOKS LIKE, AND IT HAS TO PASS");
/* ================================================================== */
/* A gate that refuses everything is not a gate, it is a broken page. These are
 * the shapes a rep actually types. */
const GOOD = [
  "Plain and direct",
  "Short — a few sentences at most",
  "Lowercase, no punctuation",
  "— Sample Rep, AI Syndicate",
  "synergy, leverage, circle back, touch base",
  "Open with something about their business, never about us.",
  "One question per email, at the end.",
  "Never send a price in the first email.",
  "If they have no website, lead with the free mockup.",
  "Ask one small yes, never a half-hour call.",
  "Name the firm in the first line.",
];
for (const g of GOOD) ok(`a real rule passes: "${g}"`, checkPersonalRule(g).ok);
eq("what comes back is trimmed, so the prompt does not carry the padding",
  checkPersonalRule("  One question per email.  "), { ok: true, text: "One question per email." });
ok("a sign-off with a dash and a comma is fine — the rule is about digits, not punctuation",
  checkPersonalRule("— Cam, AI Syndicate").ok);
ok("a spelled-out amount of anything is fine", checkPersonalRule("Ask one question, never two.").ok);

/* THE HONEST LIMIT, ON RECORD RATHER THAN FOUND LATER. The gate is a character
 * class, so a claim spelled out in words walks straight through it — and so
 * does one written in non-ASCII digits. That is a deliberate line: no digits at
 * all is a rule a rep can understand and a machine can enforce, and judging
 * whether a sentence is a factual claim is not. It is pinned here so the limit
 * is a decision on record instead of a surprise. */
ok("a claim spelled out in WORDS is not caught, and that is a known limit rather than an oversight",
  checkPersonalRule("Say our clients see a forty percent lift.").ok);
ok("a non-ASCII digit is not caught either — same known limit",
  checkPersonalRule("Keep it to ٤ sentences.").ok);

/* ================================================================== */
console.log("\nEVERY SAMPLE ROW PASSES ITS OWN CHECK");
/* ================================================================== */
/* A fixture the real save path would refuse is a fixture that lies: preview mode
 * exists to be a fair rehearsal of the live console, and a sample rule that
 * could never have been saved makes the rehearsal wrong in exactly the place it
 * is meant to be right. Read out of src/lib/data.js as TEXT — importing it would
 * pull in the browser's Supabase client. */
const DATA = readFileSync(new URL("../../src/lib/data.js", import.meta.url), "utf8");
const block = /userBrain: \[([\s\S]*?)\n {2}\],/.exec(DATA);
ok("previewStore.userBrain is where this test expects it in src/lib/data.js", Boolean(block));
const rows = [...block[1].matchAll(/\{\s*id:\s*"([^"]+)",\s*user_id:\s*"([^"]+)",\s*kind:\s*"([^"]+)",\s*setting_key:\s*(?:"([^"]*)"|null),\s*title:\s*(?:"([^"]*)"|null),\s*body:\s*"([^"]*)"/g)]
  .map((m) => ({ id: m[1], user_id: m[2], kind: m[3], setting_key: m[4] ?? null, title: m[5] ?? null, body: m[6] }));
eq("every sample row was actually parsed — a parser that skips what it cannot read agrees with anything",
  rows.length, (block[1].match(/\{ id: "ub/g) || []).length);
ok("there are sample rows at all", rows.length > 5, `${rows.length} rows`);
for (const r of rows) {
  const gate = checkPersonalRule(r.body);
  ok(`${r.id} would really save: "${r.body.slice(0, 46)}${r.body.length > 46 ? "…" : ""}"`, gate.ok, gate.error);
}
ok("NOT ONE SAMPLE BODY CONTAINS A DIGIT", rows.every((r) => !/[0-9]/.test(r.body)),
  rows.filter((r) => /[0-9]/.test(r.body)).map((r) => r.id).join(", "));
/* The kinds have to be ones the database accepts, or the sample rows describe a
 * table that would refuse them. */
const kindCheck = /admin_user_brain_kind_check[\s\S]*?check \(kind in \(([\s\S]*?)\)\)/.exec(SQL);
ok("0022 declares a kind check", Boolean(kindCheck));
const kinds = [...kindCheck[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
eq("the four kinds are the ones this build knows about", kinds.sort(), ["rule", "signature", "snippet", "voice"]);
ok("every sample row's kind is one the database accepts", rows.every((r) => kinds.includes(r.kind)),
  rows.filter((r) => !kinds.includes(r.kind)).map((r) => `${r.id}:${r.kind}`).join(", "));
/* The unique index in 0022 is (user_id, setting_key) where setting_key is not
 * null. Two sample rows sharing a pair is a fixture the live table would refuse
 * on insert — the same class of lie as a body with a number in it. */
const pairs = rows.filter((r) => r.setting_key).map((r) => `${r.user_id}|${r.setting_key}`);
eq("no two sample rows share a (person, setting) pair, which the live unique index would refuse",
  pairs.length, new Set(pairs).size);
/* And the split the preview exists to rehearse: a rep must see only their own
 * rows and an owner must see everybody's, which needs a second person's row. */
ok("the sample data holds rows for MORE THAN ONE person, or the own/all split cannot be rehearsed",
  new Set(rows.map((r) => r.user_id)).size > 1, [...new Set(rows.map((r) => r.user_id))].join(", "));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
