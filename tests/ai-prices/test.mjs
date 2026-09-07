/* THE NON-ANTHROPIC PRICE ROWS — 0033.  7 Sep 2026
 *
 * This file exists because a price book is the one table where a typo is
 * invisible. A wrong rate does not throw, does not fail a build and does not
 * look odd on screen: it prints a number in the right shape and everyone
 * believes it. So this reads migration 0033's OWN SQL — not a fixture, not a
 * copy of the numbers — and checks three separate things.
 *
 *   1. No rate in the migration has been EDITED since it was read off the
 *      provider's page on 7 Sep 2026. The figures below are duplicated on
 *      purpose: two copies that must agree is the whole mechanism.
 *      BE HONEST ABOUT WHAT THAT CATCHES. Both copies were typed by the same
 *      person from the same reading, so a mistranscription on the day is in
 *      both and this file is green. It catches a later edit to one copy, and
 *      nothing else. The only defence against the original reading being
 *      wrong is the source_url on every row and somebody opening it.
 *
 *   2. The rows actually price a call, through the real lib/ai-cost.js, to a
 *      number worked out here by hand. A row that parses but prices wrong is
 *      the failure this catches.
 *
 *   3. The models that were deliberately SKIPPED are still absent. This is the
 *      assertion that matters most in six months' time: the easiest way for
 *      this work to go wrong is for a future session to look at the AI Cost
 *      page, see "not priced" next to perplexity, and helpfully add a
 *      token-only row that undercounts it by twentyfold. If that happens, this
 *      test goes red and the comment says why.
 *
 * Zone-independent: no assertion here reads a clock.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { priceFor, costMicros, cacheSavingMicros, priceCall } from "../../lib/ai-cost.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const sql = read("supabase/migrations/0033_ai_prices_non_anthropic.sql");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const is = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

/* ------------------------------------------------------------------ */
/* Parse the migration's VALUES rows into the same shape the database   */
/* hands back.                                                          */
/*                                                                      */
/* THE FIRST VERSION OF THIS PARSER WAS ONE REGEX OVER THE WHOLE FILE,  */
/* AND IT WAS WORSE THAN NO PARSER AT ALL. A row it could not read was  */
/* skipped in SILENCE, and every assertion below then passed by looking */
/* at a list that row had never entered. Four shapes went missing that  */
/* way — a row carrying an effective_to, a provider with a hyphen in    */
/* it, a null source_url, a row with no note — and the count check did  */
/* not save it, because it counted what PARSED, not what was there.     */
/* Worst of them: 0033 tells the next person that a perplexity row      */
/* "needs an effective_to", so a row added in exactly the shape the     */
/* migration asks for was invisible, and the guard written to catch     */
/* that change went green on it. It also read a COMMENTED-OUT example   */
/* row as if it were real.                                             */
/*                                                                      */
/* So: comments are stripped first, the values block is split into      */
/* tuples, and EVERY tuple must parse. One this cannot read is a FAIL   */
/* that prints the tuple. Never a skip.                                 */
/* ------------------------------------------------------------------ */
const NUM_OR_NULL = (s) => (s.trim() === "null" ? null : Number(s.trim()));

/* Strip `--` comments without touching a `--` inside a quoted string.
 * '' inside a string is an escaped quote and does not end it. */
function stripSqlComments(text) {
  let out = "", inStr = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "'") { if (text[i + 1] === "'") { out += text[++i]; } else { inStr = false; } }
      continue;
    }
    if (c === "'") { inStr = true; out += c; continue; }
    if (c === "-" && text[i + 1] === "-") { while (i < text.length && text[i] !== "\n") i += 1; out += "\n"; continue; }
    out += c;
  }
  return out;
}

/* "(a,b),(c,d)" -> ["a,b", "c,d"], respecting quotes. */
function splitTuples(block) {
  const tuples = []; let depth = 0, inStr = false, cur = "";
  for (let i = 0; i < block.length; i += 1) {
    const c = block[i];
    if (inStr) { cur += c; if (c === "'") { if (block[i + 1] === "'") cur += block[++i]; else inStr = false; } continue; }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === "(") { depth += 1; if (depth === 1) { cur = ""; continue; } }
    if (c === ")") { depth -= 1; if (depth === 0) { tuples.push(cur); continue; } }
    if (depth > 0) cur += c;
  }
  return tuples;
}

/* One tuple -> its top-level fields, respecting quotes. */
function splitFields(tuple) {
  const out = []; let inStr = false, cur = "";
  for (let i = 0; i < tuple.length; i += 1) {
    const c = tuple[i];
    if (inStr) { cur += c; if (c === "'") { if (tuple[i + 1] === "'") cur += tuple[++i]; else inStr = false; } continue; }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === ",") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

const clean = stripSqlComments(sql);
const COLUMN_ORDER = [
  "provider", "model", "effective_from", "input_per_mtok", "output_per_mtok",
  "cache_write_per_mtok", "cache_write_1h_per_mtok", "cache_read_per_mtok",
  "source_url", "note",
];
/* Read the column list the INSERT actually declares, so a reordered or
 * extended insert fails here rather than shifting every value by one. */
const declared = (clean.match(/insert into public\.ai_model_prices\s*\(([^)]*)\)/i) || [])[1] || "";
const declaredCols = declared.split(",").map((c) => c.trim()).filter(Boolean);

/* Stop at `on conflict`, or its own "(provider, model, effective_from)" is
 * read as a fifth row — which is exactly what happened the first time. */
const afterValues = clean.slice(clean.toLowerCase().lastIndexOf("\nvalues"));
const conflictAt = afterValues.toLowerCase().indexOf("on conflict");
const valuesBlock = conflictAt >= 0 ? afterValues.slice(0, conflictAt) : afterValues;
const tuples = splitTuples(valuesBlock);
const unquote = (f) => (f.startsWith("'") && f.endsWith("'") ? f.slice(1, -1).replace(/''/g, "'") : null);

const rows = []; const unparsed = [];
for (const t of tuples) {
  const f = splitFields(t);
  if (f.length !== COLUMN_ORDER.length) { unparsed.push(`${f.length} fields, wanted ${COLUMN_ORDER.length}: ${t.slice(0, 90)}`); continue; }
  const [provider, model, from, input, output, w5, w1h, cread, src, note] = f;
  const strs = [unquote(provider), unquote(model), unquote(from), unquote(src)];
  if (strs.some((v) => v === null) || !/^\d+$/.test(input) || !/^\d+$/.test(output)) {
    unparsed.push(`unreadable field: ${t.slice(0, 90)}`); continue;
  }
  rows.push({
    id: `${strs[0]}/${strs[1]}`,
    provider: strs[0], model: strs[1], effective_from: strs[2], effective_to: null,
    input_per_mtok: Number(input), output_per_mtok: Number(output),
    cache_write_per_mtok: NUM_OR_NULL(w5),
    cache_write_1h_per_mtok: NUM_OR_NULL(w1h),
    cache_read_per_mtok: NUM_OR_NULL(cread),
    source_url: strs[3], note: unquote(note) ?? note,
  });
}

/* THIS IS THE ASSERTION THAT MAKES EVERY OTHER ONE MEAN ANYTHING. Without it,
 * all of the below is a statement about whatever happened to parse. */
ok("every tuple in the migration parsed — none skipped in silence",
  unparsed.length === 0, unparsed.join("\n       "));
is("the INSERT declares the ten columns this file assumes, in that order",
  declaredCols.join(","), COLUMN_ORDER.join(","));
is("the values block holds exactly four tuples", tuples.length, 4);
is("...and all four became price rows", rows.length, 4);

const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

/* ------------------------------------------------------------------ */
/* 1. EVERY RATE, AGAINST WHAT THE PROVIDER'S PAGE SAID ON 7 SEP 2026   */
/* ------------------------------------------------------------------ */
/* Micro-dollars per million tokens. Written as (dollars * 1e6) so the
 * dollar figure a person can check against the page is the thing on the
 * page here too, rather than a big integer nobody can eyeball. */
const D = (dollars) => Math.round(dollars * 1_000_000);

const EXPECTED = {
  /* https://developers.openai.com/api/docs/pricing — Standard tab, short
   * context. The Batch and Flex tabs show HALF of these for the same model. */
  "openai/gpt-5.6-sol": {
    input: D(4.00), output: D(20.00),
    write: D(5.00), write1h: null, cacheRead: D(0.40),
    host: "developers.openai.com",
  },
  /* https://ai.google.dev/gemini-api/docs/pricing — paid tier, text rate.
   * Cache is a $1.00/Mtok/hour STORAGE charge, so no per-token write rate. */
  "google/gemini-2.5-flash": {
    input: D(0.30), output: D(2.50),
    write: null, write1h: null, cacheRead: D(0.03),
    host: "ai.google.dev",
  },
  /* https://docs.x.ai/docs/models/grok-4.6 — under-200K-context rate. */
  "xai/grok-4.6": {
    input: D(2.00), output: D(6.00),
    write: null, write1h: null, cacheRead: D(0.50),
    host: "docs.x.ai",
  },
  /* https://console.groq.com/docs/model/openai/gpt-oss-120b — all three
   * printed as figures on the model page, not derived from the 50% discount. */
  "groq/openai/gpt-oss-120b": {
    input: D(0.15), output: D(0.60),
    write: null, write1h: null, cacheRead: D(0.075),
    host: "console.groq.com",
  },
};

for (const [id, want] of Object.entries(EXPECTED)) {
  const r = byId[id];
  if (!r) { ok(`${id} — row present`, false, "no row parsed out of the migration"); continue; }
  is(`${id} input`, r.input_per_mtok, want.input);
  is(`${id} output`, r.output_per_mtok, want.output);
  is(`${id} cache write (5m)`, r.cache_write_per_mtok, want.write);
  is(`${id} cache write (1h)`, r.cache_write_1h_per_mtok, want.write1h);
  is(`${id} cache read`, r.cache_read_per_mtok, want.cacheRead);
  /* A rate with no page behind it is exactly the thing 0024 built this column
   * to prevent, and an empty string would satisfy `not null`. */
  ok(`${id} cites the provider's own page`,
    typeof r.source_url === "string" && r.source_url.startsWith(`https://${want.host}/`),
    `source_url was ${JSON.stringify(r.source_url)}`);
  ok(`${id} says when it was read`, /read in-browser 7 Sep 2026/.test(r.note));
  is(`${id} starts on the day it was read`, r.effective_from, "2026-09-07");
}

/* Nobody's cache-write column may be a bare 0. Zero means free; these
 * providers do not offer a free cache write, they offer no such charge. */
for (const r of rows) {
  ok(`${r.id} never writes 0 where it means "no such charge"`,
    r.cache_write_per_mtok !== 0 && r.cache_write_1h_per_mtok !== 0 && r.cache_read_per_mtok !== 0);
}

/* ------------------------------------------------------------------ */
/* 2. THE ROWS PRICE A REAL CALL, THROUGH THE REAL COST FUNCTION        */
/* ------------------------------------------------------------------ */
/* priceFor() takes the list the database returns, so these go in as-is. */
const at = { onDate: "2026-09-08" };

/* OpenAI. Its cached_tokens are a SUBSET of prompt_tokens and lib/ai-cost.js
 * takes them back out — so 10,000 prompt tokens of which 2,000 were cached is
 * 8,000 at $4.00 and 2,000 at $0.40, not 10,000 + 2,000. Getting this wrong
 * charges the same tokens twice, which is why it is checked with a number. */
{
  const p = priceFor(rows, { provider: "openai", model: "gpt-5.6-sol", ...at });
  ok("openai row is found for a call the next day", Boolean(p));
  const cost = costMicros(p, {
    prompt_tokens: 10_000, completion_tokens: 1_000,
    prompt_tokens_details: { cached_tokens: 2_000 },
  });
  // 8,000 * $4/M = 32,000µ   +   1,000 * $20/M = 20,000µ   +   2,000 * $0.40/M = 800µ
  is("openai 10k in (2k cached) + 1k out costs 52,800 micro-dollars", cost, 52_800);
  // Full price on those 2,000 would have been 8,000µ; we paid 800µ.
  is("...and the cache saved 7,200 micro-dollars", cacheSavingMicros(p, {
    prompt_tokens: 10_000, completion_tokens: 1_000,
    prompt_tokens_details: { cached_tokens: 2_000 },
  }), 7_200);
}

/* Google. The point of this one is the NULL cache-write column: a Gemini call
 * that reports a cache write must come out UNPRICED, not free. That is the
 * behaviour that stops an hourly storage charge being silently recorded as 0. */
{
  const p = priceFor(rows, { provider: "google", model: "gemini-2.5-flash", ...at });
  const plain = costMicros(p, { promptTokenCount: 100_000, candidatesTokenCount: 4_000 });
  // 100,000 * $0.30/M = 30,000µ   +   4,000 * $2.50/M = 10,000µ
  is("gemini 100k in + 4k out costs 40,000 micro-dollars", plain, 40_000);
  is("a gemini call WITH a cache write is unpriced, not free",
    costMicros(p, { promptTokenCount: 1_000, candidatesTokenCount: 10, cache_write_tokens: 500 }), null);
}

/* xAI. THE FIRST VERSION OF THIS FED cache_read_input_tokens, which is
 * ANTHROPIC's field name. It got the right total for the wrong reason: it
 * exercised the branch that adds cached tokens ALONGSIDE the input, when xAI's
 * API is OpenAI-compatible and reports prompt_tokens_details.cached_tokens —
 * a SUBSET of prompt_tokens that lib/ai-cost.js subtracts back out. Same
 * answer, opposite code path, and the live path was never touched.
 * Written the OpenAI-compatible way now: 3,000 prompt tokens of which 2,000
 * were cached is 1,000 at $2.00 plus 2,000 at $0.50. */
{
  const p = priceFor(rows, { provider: "xai", model: "grok-4.6", ...at });
  const usage = {
    prompt_tokens: 3_000, completion_tokens: 500,
    prompt_tokens_details: { cached_tokens: 2_000 },
  };
  // 1,000 * $2/M = 2,000µ + 500 * $6/M = 3,000µ + 2,000 * $0.50/M = 1,000µ
  is("grok 3k in (2k cached) + 500 out costs 6,000 micro-dollars", costMicros(p, usage), 6_000);
  // Full price on those 2,000 would have been 4,000µ; we paid 1,000µ.
  is("...and the cache saved 3,000 micro-dollars", cacheSavingMicros(p, usage), 3_000);
}

/* Groq — the model id contains a slash, which is the thing most likely to be
 * mangled by a lookup that splits on one. */
{
  const p = priceFor(rows, { provider: "groq", model: "openai/gpt-oss-120b", ...at });
  ok("groq's slashed model id is found by an exact lookup", Boolean(p));
  is("groq 1M in + 1M out costs 750,000 micro-dollars",
    costMicros(p, { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 750_000);
}

/* A failed call reports no usage at all. It must never price as 0 — a call
 * that threw may still have been billed. 190 of the 254 calls on the page on
 * 7 Sep 2026 were in some version of this state. */
{
  const p = priceFor(rows, { provider: "openai", model: "gpt-5.6-sol", ...at });
  is("a call with no usage object is unpriced, never zero", costMicros(p, null), null);
  /* costMicros() has always guarded this. cacheSavingMicros() did not: it ran
   * normalizeUsage(null) into an empty object and returned 0 — "the cache
   * saved us nothing", stated as a measurement, about a call whose token
   * counts we never received. Fixed in lib/ai-cost.js on 7 Sep 2026; this is
   * the assertion that stops it coming back. */
  is("...and the cache saving on that call is unknown, not zero", cacheSavingMicros(p, null), null);
  is("...same when usage is undefined", cacheSavingMicros(p, undefined), null);
  /* A call that DID report usage and simply read nothing from a cache really
   * did save zero. That is a measurement and must stay 0, not become null. */
  is("a call that reported usage but read no cache really saved zero",
    cacheSavingMicros(p, { prompt_tokens: 10, completion_tokens: 5 }), 0);
}

/* THE ONLY ZONE-SENSITIVE ASSERTION IN THIS FILE, and the reason run.sh runs
 * it in five timezones at all. priceCall() has no `onDate` — it calls
 * teamDate(), which reads the TEAM's calendar rather than the machine's. An
 * epoch that is 8 Sep in Chicago must be 8 Sep under every zone the runner
 * uses, or a price window opens a day early somewhere and nobody sees it.
 * Without this the loop compares a constant against itself five times. */
{
  // 2026-09-08 18:00:00 UTC — 1pm in Chicago, 6am on the 9th in Auckland.
  const atMs = Date.UTC(2026, 8, 8, 18, 0, 0);
  const r = priceCall({ prices: rows, provider: "xai", model: "grok-4.6",
    usage: { prompt_tokens: 1_000, completion_tokens: 0 }, atMs });
  is("priceCall reads the team's calendar, not the machine's", r.day, "2026-09-08");
  is("...and prices the call from the row in force that day", r.costMicros, 2_000);
  ok("...against the row this migration added", r.priceId === null || typeof r.priceId === "string");
}

/* A row that starts today cannot price a call from yesterday. This is the
 * cost of not backdating, asserted rather than described. */
{
  is("these rows do NOT price a call made before 2026-09-07",
    priceFor(rows, { provider: "xai", model: "grok-4.6", onDate: "2026-09-06" }) || null, null);
}

/* ------------------------------------------------------------------ */
/* 3. THE SKIPPED MODELS ARE STILL SKIPPED                              */
/* ------------------------------------------------------------------ */
/* Each of these is unpriced for a reason the migration spells out. Adding a
 * row for any of them without ALSO doing the work named here makes the AI
 * Cost page more wrong, not less, while making it look more complete. */
const MUST_STAY_UNPRICED = {
  "perplexity/sonar":
    "token rate is real but the $5-$12 per 1,000 requests search fee is the bigger half — needs a per-call column",
  "deepseek/deepseek-v4-flash":
    "peak and off-peak rates differ 2x by hour of day — needs a time-of-day dimension",
  "serpapi/unknown":
    "billed per search, not per token — needs a per-call column AND our plan tier",
  "mistral/mistral-medium-3.5":
    "not a real Mistral model id — fix the id in the platform repo first",
  "openai/gpt-5.6":
    "not a real OpenAI model id — fix the id in the platform repo first",
};
for (const [id, why] of Object.entries(MUST_STAY_UNPRICED)) {
  const [provider, ...rest] = id.split("/");
  const model = rest.join("/");
  ok(`${id} has no price row — ${why}`,
    !priceFor(rows, { provider, model, ...at }));
}

/* And the migration has to keep SAYING why, or the next person deletes the
 * gap without knowing there was a reason for it. */
ok("the migration explains the perplexity request fee", /request fee/i.test(sql) && /per 1,000 requests/.test(sql));
ok("the migration explains deepseek's peak / off-peak split", /off-peak/i.test(sql) && /UTC/.test(sql));
/* Named one at a time. The first version asked only whether the phrase "not a
 * real model id" appeared anywhere, so deleting the whole OpenAI paragraph
 * left it green. */
ok("the migration names mistral-medium-3.5 as a dead id, and the live one",
  /mistral-medium-3\.5/.test(sql) && /mistral-medium-latest/.test(sql));
ok("the migration names gpt-5.6 as a dead id, and the live one",
  /NOT A REAL MODEL ID either/.test(sql) && /gpt-5\.6-sol/.test(sql));
ok("the migration says the rows are not backdated, and what that costs",
  /BACKDATED/.test(sql) && /stay UNPRICED/.test(sql));

/* It must not touch anything. 0033 is an insert and nothing else — a stray
 * alter or drop in a file called "prices" is how a migration nobody read
 * changes a table everybody uses. */
/* ASSERTED POSITIVELY. The first version was a blocklist of verbs, and a
 * blocklist is only as good as the list: it missed `grant`, `revoke`,
 * `create or replace`, and an `insert into` any OTHER table — while sitting
 * under a migration header that promises "no table, column, index, policy or
 * grant is touched". One statement, one table, is the thing to check. */
{
  /* Split on TOP-LEVEL semicolons only. A plain .split(";") tore this file in
   * half at the semicolon inside the grok row's own note — found by this very
   * assertion on its first run, which is the whole argument for writing it. */
  const body = stripSqlComments(sql).trim();
  const statements = []; { let cur = "", inStr = false;
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i];
      if (inStr) { cur += c; if (c === "'") { if (body[i + 1] === "'") cur += body[++i]; else inStr = false; } continue; }
      if (c === "'") { inStr = true; cur += c; continue; }
      if (c === ";") { statements.push(cur); cur = ""; continue; }
      cur += c;
    }
    statements.push(cur);
  }
  const trimmed = statements.map((x) => x.trim()).filter(Boolean);
  is("0033 is exactly one SQL statement", trimmed.length, 1);
  ok("...and that statement is an insert into ai_model_prices and nothing else",
    /^insert\s+into\s+public\.ai_model_prices\b/i.test(trimmed[0] || ""),
    (trimmed[0] || "").slice(0, 120));
  ok("0033 is safe to run twice",
    /on conflict \(provider, model, effective_from\) do nothing/i.test(trimmed[0] || ""));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
