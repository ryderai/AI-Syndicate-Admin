/* READING WHAT OUR OWN PLATFORM ACTUALLY SENDS BACK.
 *
 * Until 30 Aug 2026 the Scan button was dark because PLATFORM_SCORE_URL was not
 * set, and the reason it was not set is that nobody had written down what the
 * scanner answers. So it was read — out of the platform's own repo, not guessed:
 *
 *   POST /v1/audit   (api/v1/audit.js)
 *   auth   X-Api-Key: <key with the `write` scope>, or Authorization: Bearer
 *   body   { domain, pages, maxPages }
 *   answer { domain, measured, score, gated, categories, measuredAt,
 *            measuredNow, stored, pages: {scored, requested}, notes }
 *
 * `score` is the AI Access composite, 0-100. `categories` is worst-first and the
 * platform's own comment calls it "doubles as a fix list" — which is the pitch.
 * There is no SEO score and no buyer-question count in that answer, and this
 * file pins that those come back as NULL rather than as zero.
 */
import { readFileSync } from "node:fs";
import { readAiAccess, readSeo, readPromptSim, readFindings, readReport } from "../../api/sales-score.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

/* A real-shaped answer from POST /v1/audit. */
const V1 = {
  domain: "ineedarootcanal.com",
  measured: true,
  score: 41,
  gated: false,
  measuredAt: "2026-08-31T02:20:00.000Z",
  measuredNow: true,
  stored: false,
  pages: { scored: 1, requested: 1 },
  notes: [],
  categories: [
    { key: "llms", label: "AI files", score: 0, weight: 0.2 },
    { key: "schema", label: "Schema", score: 12, weight: 0.2 },
    { key: "bots", label: "AI crawlers", score: 40, weight: 0.25 },
    { key: "sitemap", label: "Sitemap", score: 100, weight: 0.15 },
  ],
};

console.log("\nTHE SCORE");

eq("the headline score is read from `score`", readAiAccess(V1), 41);
eq("SEO is NULL, not zero — /v1/audit does not measure it", readSeo(V1), null);
eq("buyer questions are null too", readPromptSim(V1).hits, null);
ok("...and null is what reaches the row", readReport(V1).seo === null);
ok("the report is still readable on the score alone", readReport(V1).readable);

console.log("\nTHE CATEGORIES BECOME THE PITCH");

const f = readFindings(V1).findings;
eq("one finding per scored category", f.length, 4);
eq("worst first, as the platform sorted them", f[0].title, "AI files");
eq("...and it says only what was measured", f[0].detail, "scored 0 out of 100");
eq("the second is schema", f[1].detail, "scored 12 out of 100");
ok("nothing invents a remedy or a severity", f.every((x) => x.severity === ""));
ok("a category scoring 100 is still listed — it is a number, not a complaint",
  f.some((x) => x.detail === "scored 100 out of 100"));

console.log("\nREAL FINDINGS ALWAYS WIN OVER CATEGORIES");

/* A scanner that sends actual defects must not have them replaced by a list of
 * scores. `categories` is the fallback, not the preference. */
const BOTH = { ...V1, findings: [{ title: "robots.txt blocks GPTBot", detail: "Disallow: / for GPTBot" }] };
eq("a payload with both keeps the real findings", readFindings(BOTH).findings.length, 1);
eq("...and it is the real one", readFindings(BOTH).findings[0].title, "robots.txt blocks GPTBot");

console.log("\nNOTHING BROKEN IS PRINTED AS A FINDING");

const junk = (cats) => readFindings({ score: 50, categories: cats }).findings;
eq("a category with no score at all is dropped", junk([{ label: "Schema" }]).length, 0);
eq("a category with no name is dropped", junk([{ score: 10 }]).length, 0);
eq("a score of 200 is dropped, never clamped", junk([{ label: "X", score: 200 }]).length, 0);
eq("a negative score is dropped", junk([{ label: "X", score: -5 }]).length, 0);
eq("a string that is not a number is dropped", junk([{ label: "X", score: "n/a" }]).length, 0);
eq("a numeric string IS read", junk([{ label: "X", score: "37" }])[0].detail, "scored 37 out of 100");
eq("null in the array does not throw", junk([null, { label: "X", score: 1 }]).length, 1);
eq("categories that is not an array falls through", readFindings({ categories: "nope" }).findings.length, 0);
eq("an all-junk categories list reports nothing rather than an empty success",
  readFindings({ categories: [{}] }).findings.length, 0);
eq("`key` is used when there is no label", junk([{ key: "bots", score: 4 }])[0].title, "bots");

console.log("\nTHE REQUEST WE SEND");

const SRC = readFileSync(new URL("../../api/sales-score.js", import.meta.url), "utf8");
ok("we ask for the FAST scan — a 20-page crawl does not fit a 55s timeout",
  /pages:\s*false/.test(SRC));
ok("the domain still goes in the body", /JSON\.stringify\(\{ domain,/.test(SRC));
ok("the key is sent as X-Api-Key, which is what the platform accepts",
  /"x-api-key": process\.env\.PLATFORM_SCORE_KEY/.test(SRC));

console.log("\nA DEAD ANSWER IS STILL NOT A SCORE OF ZERO");

ok("an unmeasured answer is not readable", !readReport({ domain: "x.com", measured: false, score: null }).readable);
ok("an empty object is not readable", !readReport({}).readable);
eq("`measured: false` does not become 0", readAiAccess({ measured: false, score: null }), null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
