/* AI COST — THE MATHS, AND THE COLUMNS IT WRITES.  Aug 28 2026
 *
 * Plain node against the real modules the server loads. No mocks of our own
 * code: this repo learned the hard way that three files once wrote column
 * names the tables did not have and every fixture had invented the same wrong
 * names, so the tests agreed with the code and both were wrong. Hence part 6
 * below, which reads the migration's own SQL.
 *
 * WHAT THIS FILE IS FOR, one line each:
 *   1. Tokens: four providers name them four ways, and OpenAI folds its cached
 *      tokens INTO the prompt count while Anthropic reports them alongside.
 *      Getting that wrong charges the same tokens twice.
 *   2. Prices are DATED and compared as strings. An event on the day a price
 *      changes must use the right row, on both sides of midnight.
 *   3. Cost is whole micro-dollars, and UNPRICED is null — never 0.
 *   4. A rollup must never count a null cost as zero, and must never sort an
 *      unpriced group in among the small numbers where nobody looks at it.
 *   5. The month you are standing in is not finished.
 *   6. The columns this code writes really exist in migration 0024, and the
 *      seven hardcoded price blocks are really gone.
 *
 * Every date assertion is zone-independent on purpose: teamDate() reads the
 * team's calendar, not the machine's, so run.sh can demand that all five
 * timezones pass the SAME number of assertions.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  num, numOrNull, normalizeUsage, totalTokens,
  priceCovers, priceFor, costMicros, cacheSavingMicros, priceCall,
  microsToCents, formatMicros, formatTokens,
  eventDay, eventMonth, summarize, rollup, percentile, changeAgainst,
  daysInMonth, partMonthNote, previousMonth, drift, pricedCost,
  BASIS, INTERNAL, INTERNAL_LABEL, FEATURES, SURFACES, STATUSES,
} from "../../lib/ai-cost.js";
import { recordAiUsage, primePriceCache, priceCacheIsStale } from "../../lib/ai-usage.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

/* ================================================================== */
console.log("\n1. numbers out of the database");
/* ================================================================== */

// supabase-js returns bigint as a STRING. This is the trap the whole file
// guards: "3000000" + 1200 is "30000001200", not 3001200.
eq("num() parses a bigint-as-string", num("3000000"), 3000000);
eq("num() of null is 0", num(null), 0);
eq("num() of rubbish is 0", num("not a number"), 0);
eq("num() of empty string is 0", num(""), 0);
eq("numOrNull() keeps a real zero", numOrNull(0), 0);
eq("numOrNull() of null stays null", numOrNull(null), null);
ok("a string price still multiplies to the right integer",
  Math.round((1200 * num("3000000")) / 1_000_000) === 3600,
  `got ${Math.round((1200 * num("3000000")) / 1_000_000)}`);

/* ================================================================== */
console.log("\n2. tokens, whatever the provider called them");
/* ================================================================== */

eq("anthropic plain",
  normalizeUsage({ input_tokens: 1200, output_tokens: 480 }),
  { input_tokens: 1200, output_tokens: 480, cache_write_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 0 });

// Anthropic reports cache reads ALONGSIDE input_tokens, so nothing is subtracted.
eq("anthropic with cache — reads are NOT taken out of input",
  normalizeUsage({ input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 5000, cache_read_input_tokens: 9000 }),
  { input_tokens: 200, output_tokens: 100, cache_write_tokens: 5000, cache_write_1h_tokens: 0, cache_read_tokens: 9000 });

// A cache write costs 1.25x input if it lives 5 minutes and 2x if it lives an
// hour. Pricing an hour-long write at the 5-minute rate understates it by 60%
// and the bill would never show which it was.
eq("no breakdown means the whole write is a 5-minute one — that is the default",
  normalizeUsage({ cache_creation_input_tokens: 4000 }).cache_write_tokens, 4000);
eq("...and none of it is booked as an hour-long write",
  normalizeUsage({ cache_creation_input_tokens: 4000 }).cache_write_1h_tokens, 0);
eq("with a breakdown, the 5-minute half is kept apart",
  normalizeUsage({ cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 3000 } }).cache_write_tokens, 1000);
eq("...and the hour-long half is too",
  normalizeUsage({ cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 3000 } }).cache_write_1h_tokens, 3000);
/* THIS ASSERTION USED TO SAY 300, AND IT WAS WRONG.
 * `cache_write_tokens` is OUR stored column and already holds the 5-minute
 * figure alone; the code subtracted the 1-hour count from it and deleted 200
 * tokens, and this test agreed with it. A test that agrees with the code is not
 * a test. Found by an adversarial review, Aug 28 2026. */
eq("our own stored column names round-trip WITHOUT losing tokens",
  normalizeUsage({ cache_write_tokens: 500, cache_write_1h_tokens: 200 }),
  { input_tokens: 0, output_tokens: 0, cache_write_tokens: 500, cache_write_1h_tokens: 200, cache_read_tokens: 0 });
eq("...and a round trip through our own columns is lossless",
  normalizeUsage(normalizeUsage({ cache_creation_input_tokens: 700, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 200 } })),
  { input_tokens: 0, output_tokens: 0, cache_write_tokens: 500, cache_write_1h_tokens: 200, cache_read_tokens: 0 });
eq("a tier we have never heard of is booked, not dropped",
  normalizeUsage({ cache_creation_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 200 } }).cache_write_tokens,
  700);

// OpenAI folds cached tokens INTO prompt_tokens. Leaving them in charges the
// same tokens twice: once at the full input rate, once at the cache rate.
eq("openai — cached tokens come OUT of the prompt count",
  normalizeUsage({ prompt_tokens: 1000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 800 } }),
  { input_tokens: 200, output_tokens: 300, cache_write_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 800 });

eq("google names",
  normalizeUsage({ promptTokenCount: 900, candidatesTokenCount: 150, cachedContentTokenCount: 400 }),
  { input_tokens: 500, output_tokens: 150, cache_write_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 400 });

eq("a nonsense usage object is all zeros, not NaN",
  normalizeUsage({ input_tokens: "abc", output_tokens: undefined }),
  { input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 0 });
eq("undefined usage is all zeros", normalizeUsage(undefined),
  { input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 0 });
eq("negative counts clamp to 0", normalizeUsage({ input_tokens: -5 }).input_tokens, 0);
eq("cached larger than the prompt does not go negative",
  normalizeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 900 } }).input_tokens, 100);
eq("totalTokens counts cached tokens too",
  totalTokens({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }), 100);
eq("totalTokens counts hour-long cache writes too",
  totalTokens({ cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } }), 30);

/* ================================================================== */
console.log("\n3. prices are dated, and compared as strings");
/* ================================================================== */

const PRICES = [
  { id: "old", provider: "anthropic", model: "claude-sonnet-4-6",
    effective_from: "2026-01-01", effective_to: "2026-08-14",
    input_per_mtok: "3000000", output_per_mtok: "15000000",
    cache_write_per_mtok: "3750000", cache_write_1h_per_mtok: "6000000", cache_read_per_mtok: "300000" },
  { id: "new", provider: "anthropic", model: "claude-sonnet-4-6",
    effective_from: "2026-08-15", effective_to: null,
    input_per_mtok: "2000000", output_per_mtok: "10000000",
    cache_write_per_mtok: "2500000", cache_write_1h_per_mtok: "4000000", cache_read_per_mtok: "200000" },
  { id: "nocache", provider: "openai", model: "gpt-x",
    effective_from: "2026-01-01", effective_to: null,
    input_per_mtok: "1000000", output_per_mtok: "4000000",
    cache_write_per_mtok: null, cache_write_1h_per_mtok: null, cache_read_per_mtok: null },
];

ok("covers the first day of its window", priceCovers(PRICES[0], "2026-01-01"));
ok("covers the last day of its window", priceCovers(PRICES[0], "2026-08-14"));
ok("does not cover the day after", !priceCovers(PRICES[0], "2026-08-15"));
ok("an open-ended row covers any later day", priceCovers(PRICES[1], "2027-05-05"));
ok("a row does not cover the day before it starts", !priceCovers(PRICES[1], "2026-08-14"));

eq("the day before the change uses the OLD row",
  priceFor(PRICES, { provider: "anthropic", model: "claude-sonnet-4-6", onDate: "2026-08-14" })?.id, "old");
eq("the day of the change uses the NEW row",
  priceFor(PRICES, { provider: "anthropic", model: "claude-sonnet-4-6", onDate: "2026-08-15" })?.id, "new");
eq("an unknown model has no price",
  priceFor(PRICES, { provider: "anthropic", model: "claude-x-new", onDate: "2026-08-28" }), null);
eq("the right model on the wrong provider has no price",
  priceFor(PRICES, { provider: "openai", model: "claude-sonnet-4-6", onDate: "2026-08-28" }), null);
eq("provider match is case-insensitive",
  priceFor(PRICES, { provider: "Anthropic", model: "claude-sonnet-4-6", onDate: "2026-08-28" })?.id, "new");

// The unique index in 0024 is meant to stop this ever existing. If it does,
// the answer must still not depend on the order the database returned rows.
const OVERLAP = [
  { id: "a", provider: "x", model: "m", effective_from: "2026-01-01", effective_to: null, input_per_mtok: 1, output_per_mtok: 1 },
  { id: "b", provider: "x", model: "m", effective_from: "2026-06-01", effective_to: null, input_per_mtok: 2, output_per_mtok: 2 },
];
eq("two overlapping rows: the later start wins",
  priceFor(OVERLAP, { provider: "x", model: "m", onDate: "2026-09-01" })?.id, "b");
eq("...and the answer does not change when the rows arrive reversed",
  priceFor(OVERLAP.slice().reverse(), { provider: "x", model: "m", onDate: "2026-09-01" })?.id, "b");

/* ================================================================== */
console.log("\n4. the cost of one call");
/* ================================================================== */

const sonnetNew = PRICES[1];

// 1200 in at $2/Mtok = 2400 micros. 480 out at $10/Mtok = 4800 micros.
eq("a plain call", costMicros(sonnetNew, { input_tokens: 1200, output_tokens: 480 }), 7200);
eq("zero tokens costs zero, and zero is a real answer",
  costMicros(sonnetNew, { input_tokens: 0, output_tokens: 0 }), 0);
eq("an hour-long cache write is priced higher than a 5-minute one",
  costMicros(sonnetNew, { cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } }),
  4_000_000);
eq("...and the same tokens as a 5-minute write cost less",
  costMicros(sonnetNew, { cache_creation_input_tokens: 1_000_000 }), 2_500_000);
eq("an hour-long write with no hour rate is null, not the 5-minute rate",
  costMicros({ input_per_mtok: 1, output_per_mtok: 1, cache_write_per_mtok: 1, cache_write_1h_per_mtok: null },
    { cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } }),
  null);
eq("cache write and cache read are priced separately",
  costMicros(sonnetNew, { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 4000, cache_read_input_tokens: 20000 }),
  200 + 10000 + 4000);

ok("the answer is a whole number", Number.isInteger(costMicros(sonnetNew, { input_tokens: 7, output_tokens: 3 })));
eq("a sub-cent call keeps its fractions", costMicros(sonnetNew, { input_tokens: 7, output_tokens: 3 }), 14 + 30);

// The rule the whole file exists for.
eq("NO PRICE ROW = null, never 0", costMicros(null, { input_tokens: 1000, output_tokens: 1000 }), null);
/* A call that THREW never reported its token counts. The first version
 * normalised that to four zeros and returned a confident 0 — a priced-looking
 * figure for a call the provider may well have billed us for, which then sat in
 * the denominator of the average and dragged it down. */
eq("no usage object at all = null, not a free call", costMicros(sonnetNew, null), null);
eq("undefined usage is the same", costMicros(sonnetNew, undefined), null);
eq("...but a usage object that really says zero IS zero",
  costMicros(sonnetNew, { input_tokens: 0, output_tokens: 0 }), 0);
eq("cached tokens with no cache price = null, never 'close enough'",
  costMicros(PRICES[2], { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 500 } }), null);
eq("...but the same model with no cached tokens prices fine",
  costMicros(PRICES[2], { prompt_tokens: 1000, completion_tokens: 100 }), 1000 + 400);
eq("a price row missing its input rate is null, not free",
  costMicros({ input_per_mtok: null, output_per_mtok: 100 }, { input_tokens: 10, output_tokens: 10 }), null);

ok("null is NOT falsy-equal to zero in any total we build",
  costMicros(null, {}) !== 0 && costMicros(null, {}) === null);

eq("cache saving is the gap between the full rate and the cheap rate",
  cacheSavingMicros(sonnetNew, { cache_read_input_tokens: 1_000_000 }), 2_000_000 - 200_000);
eq("no cached tokens saved nothing — and that is 0, not null",
  cacheSavingMicros(sonnetNew, { input_tokens: 500 }), 0);
eq("no price means the saving is unknown, not zero",
  cacheSavingMicros(null, { cache_read_input_tokens: 100 }), null);

const called = priceCall({
  prices: PRICES, provider: "anthropic", model: "claude-sonnet-4-6",
  usage: { input_tokens: 1200, output_tokens: 480 },
  atMs: Date.parse("2026-08-20T15:00:00Z"),
});
eq("priceCall picks the right day in the team's calendar", called.day, "2026-08-20");
eq("priceCall carries the price row's id so the cost can be frozen", called.priceId, "new");
eq("priceCall's cost matches costMicros", called.costMicros, 7200);
ok("priceCall on an unknown model is flagged unpriced",
  priceCall({ prices: PRICES, provider: "anthropic", model: "nope", usage: {}, atMs: Date.now() }).unpriced === true);

// 7pm Chicago on Aug 20 is Aug 21 in UTC. The event belongs to the team's day.
eq("a late-evening call still belongs to the team's day, not UTC's",
  priceCall({ prices: PRICES, provider: "anthropic", model: "claude-sonnet-4-6", usage: {},
    atMs: Date.parse("2026-08-21T02:30:00Z") }).day, "2026-08-20");

/* ================================================================== */
console.log("\n5. display");
/* ================================================================== */

eq("micros to cents", microsToCents(1_234_567), 123);
eq("micros to cents of null stays null", microsToCents(null), null);
eq("a null cost prints as words, never as $0.00", formatMicros(null), "not priced yet");
eq("a real zero prints as $0.00", formatMicros(0), "$0.00");
eq("a sub-cent cost keeps four places", formatMicros(700), "$0.0007");
eq("an ordinary cost is two places", formatMicros(7_200_000), "$7.20");
eq("tokens under a thousand print plainly", formatTokens(940), "940");
eq("thousands", formatTokens(4200), "4.2k");
eq("millions", formatTokens(1_240_000), "1.24M");

/* ================================================================== */
console.log("\n6. rolling events up — a null cost is never a zero");
/* ================================================================== */

const EV = [
  { ts: "2026-08-20T15:00:00Z", client_id: "c1", user_id: "u1", feature: "client_report", surface: "client_detail",
    provider: "anthropic", model: "claude-sonnet-4-6", status: "ok", latency_ms: 900,
    input_tokens: 1000, output_tokens: 500, cache_write_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 0, cost_micros: 7000 },
  { ts: "2026-08-20T18:00:00Z", client_id: "c1", user_id: "u2", feature: "assistant", surface: "overview",
    provider: "anthropic", model: "claude-sonnet-4-6", status: "ok", latency_ms: 1500,
    input_tokens: 200, output_tokens: 100, cache_write_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 0, cost_micros: 1400 },
  { ts: "2026-08-21T14:00:00Z", client_id: null, user_id: "u1", feature: "notes", surface: "notes",
    provider: "anthropic", model: "claude-sonnet-4-6", status: "ok", latency_ms: 3000,
    input_tokens: 5000, output_tokens: 900, cache_write_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 0, cost_micros: 19000 },
  // The one that matters: a real call, real tokens, NO price.
  { ts: "2026-08-21T16:00:00Z", client_id: "c2", user_id: "u1", feature: "assistant", surface: "floor",
    provider: "openai", model: "gpt-unknown", status: "ok", latency_ms: 600,
    input_tokens: 4000, output_tokens: 1000, cache_write_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 0, cost_micros: null },
  // A failed call still costs money and still gets logged.
  { ts: "2026-08-21T17:00:00Z", client_id: "c1", user_id: "u2", feature: "client_report", surface: "client_detail",
    provider: "anthropic", model: "claude-sonnet-4-6", status: "failed", latency_ms: 40000,
    input_tokens: 3000, output_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 0, cost_micros: 6000 },
];

const S = summarize(EV);
eq("every call is counted, priced or not", S.calls, 5);
eq("a failed call is counted as failed", S.failed, 1);
eq("the priced spend adds up", S.costMicros, 7000 + 1400 + 19000 + 6000);
eq("the unpriced call is counted in its OWN column", S.unpricedCalls, 1);
eq("...and its tokens are held there too, so the gap can be sized", S.unpricedTokens, 5000);
eq("the average is over the PRICED calls, not all of them", S.avgCostMicros, Math.round(33400 / 4));
eq("median latency", S.medianLatencyMs, 1500);
ok("p95 latency is the worst one here", S.p95LatencyMs === 40000, `got ${S.p95LatencyMs}`);
eq("a set with some priced calls is METERED", S.basis, BASIS.METERED);
eq("a set where NOTHING could be priced is UNPRICED",
  summarize([EV[3]]).basis, BASIS.UNPRICED);
// The bug this pair of assertions was written for: 'unpriced' used to be a
// STATUS, so a call that failed AND could not be priced lost its failure.
eq("a call can be unpriced and still have succeeded", summarize([EV[3]]).failed, 0);
eq("...and a call can fail and still be priced",
  summarize([EV[4]]).failed === 1 && summarize([EV[4]]).unpricedCalls === 0, true);
eq("a call that threw and reported no tokens is counted as such",
  summarize([{ ts: "2026-08-21T16:00:00Z", status: "failed", cost_micros: null, meta: { tokensUnknown: true } }]).tokensUnknown, 1);

/* LEGACY rows were costed with the one hardcoded price this build removed.
 * Migration 0024 labels them so no screen can call them measured — and the
 * first version of summarize() counted them as plain 'ok' and summed them into
 * a METERED total, which made the label do nothing. */
const LEGACY = { ts: "2026-08-20T15:00:00Z", status: "legacy", cost_micros: 5000, input_tokens: 10, output_tokens: 10 };
eq("a legacy row is counted, and counted AS legacy", summarize([LEGACY]).legacyCalls, 1);
eq("...and is not counted as a failure either", summarize([LEGACY]).failed, 0);
eq("...and its money is still in the total, because it was really spent",
  summarize([LEGACY]).costMicros, 5000);

/* `billable: false` was written by both writers and read by nothing, so a call
 * we are not charged for still showed up as spend. */
eq("a not-billable call is counted",
  summarize([{ ...LEGACY, billable: false }]).nonBillable, 1);
eq("...but its money is NOT",
  summarize([{ ...LEGACY, billable: false }]).costMicros, 0);

/* The basis used to stay METERED unless EVERY call was unpriced, so 999 out of
 * 1,000 wore a green badge. */
const MOSTLY_UNPRICED = [
  { ts: "2026-08-20T15:00:00Z", cost_micros: 10 },
  ...Array.from({ length: 99 }, () => ({ ts: "2026-08-20T15:00:00Z", cost_micros: null })),
];
eq("one priced call among 99 unpriced is still METERED — there IS a measured figure",
  summarize(MOSTLY_UNPRICED).basis, BASIS.METERED);
eq("...and the unpriced 99 are counted so the page can say so",
  summarize(MOSTLY_UNPRICED).unpricedCalls, 99);
eq("nothing priced at all is UNPRICED",
  summarize(MOSTLY_UNPRICED.slice(1)).basis, BASIS.UNPRICED);

/* formatMicros(0) is the string "$0.00" and a Figure only blanks on null, so a
 * total with nothing priced in it printed a confident "$0.00" under a green
 * METERED badge — the exact failure this codebase exists to prevent. */
eq("pricedCost of a set where nothing could be priced is NULL, not 0",
  pricedCost(summarize(MOSTLY_UNPRICED.slice(1))), null);
eq("pricedCost of an empty set is null too", pricedCost(summarize([])), null);
eq("pricedCost of a real total is that total", pricedCost(summarize(MOSTLY_UNPRICED)), 10);
eq("and formatMicros of that null says words, not $0.00",
  formatMicros(pricedCost(summarize(MOSTLY_UNPRICED.slice(1)))), "not priced yet");
eq("an empty set has no average, rather than an average of zero",
  summarize([]).avgCostMicros, null);
eq("an empty set has no median latency either", summarize([]).medianLatencyMs, null);

const byClient = rollup(EV, "client", { clients: { c1: "Shiner", c2: "Dahler" } });
eq("a call with no client goes to Internal, never onto a client",
  byClient.find((r) => r.key === INTERNAL)?.label, INTERNAL_LABEL);
// Internal really is the biggest line here (19,000 against Shiner's 14,400).
// The first draft of this test asserted Shiner and was simply wrong — worth
// keeping the note, because "the client with the most calls" and "the client
// that cost the most" are different questions and it is easy to read one as
// the other.
eq("the biggest spender is first, whoever that is", byClient[0].key, INTERNAL);
eq("Shiner is second", byClient[1].label, "Shiner");
eq("Shiner's total is its three calls, the failed one included",
  byClient[1].costMicros, 7000 + 1400 + 6000);
eq("the client that could not be priced sorts LAST, not among the cheap ones",
  byClient[byClient.length - 1].key, "c2");
ok("...and it is last because it is unpriced, not because it is small",
  byClient[byClient.length - 1].unpricedCalls === 1 && byClient[byClient.length - 1].costMicros === 0);
ok("shares add up to 1 across the priced rows",
  Math.abs(byClient.filter((r) => r.share !== null).reduce((a, r) => a + r.share, 0) - 1) < 1e-9);

eq("grouping by day uses the team's calendar",
  rollup(EV, "day").map((r) => r.key).sort(), ["2026-08-20", "2026-08-21"]);
eq("grouping by model keys on provider AND model",
  rollup(EV, "model").some((r) => r.key === "openai/gpt-unknown"), true);
eq("a call with no user is System, not Unknown",
  rollup([{ ...EV[0], user_id: null }], "person")[0].label, "System / scheduled");
eq("an unknown grouping falls back to client rather than throwing",
  rollup(EV, "nonsense")[0].label, byClient[0].label);
eq("share is null when nothing was priced, so no page prints 100% of $0",
  rollup([EV[3]], "client")[0].share, null);

eq("percentile of an empty list is null", percentile([], 0.5), null);
eq("percentile of one value is that value", percentile([7], 0.95), 7);
eq("change against nothing is null, not +100%", changeAgainst(500, 0), null);
eq("a doubling reads as +1", changeAgainst(200, 100), 1);

eq("eventDay reads the team's calendar", eventDay({ ts: "2026-08-21T02:30:00Z" }), "2026-08-20");
eq("eventMonth follows it", eventMonth({ ts: "2026-09-01T02:30:00Z" }), "2026-08");
eq("a broken timestamp is no date, not today", eventDay({ ts: "nonsense" }), null);

/* ================================================================== */
console.log("\n7. the month you are standing in is not finished");
/* ================================================================== */

eq("days in August", daysInMonth("2026-08"), 31);
eq("days in February, ordinary year", daysInMonth("2026-02"), 28);
eq("days in February, leap year", daysInMonth("2028-02"), 29);
eq("days in February 2100 — divisible by 100, NOT a leap year", daysInMonth("2100-02"), 28);
eq("days in February 2000 — divisible by 400, IS a leap year", daysInMonth("2000-02"), 29);
eq("rubbish month has no length", daysInMonth("nope"), null);

const midAug = Date.parse("2026-08-18T18:00:00Z");
eq("the part-month note names the day and the month length",
  partMonthNote("2026-08", midAug)?.text, "18 of 31 days in");
eq("a finished month gets no note at all", partMonthNote("2026-07", midAug), null);

eq("the month before January is last December", previousMonth("2026-01"), "2025-12");
eq("the month before September", previousMonth("2026-09"), "2026-08");

/* ================================================================== */
console.log("\n8. drift — and what it says when there is no bill");
/* ================================================================== */

eq("no bill means no verdict, not a green tick",
  drift({ meteredMicros: 100, billedMicros: null }).band, null);
eq("...and it says why", drift({ meteredMicros: 100, billedMicros: null }).reason, "no bill on file yet");
eq("a half-percent gap is good", drift({ meteredMicros: 995, billedMicros: 1000 }).band, "good");
eq("a two-percent gap is worth watching", drift({ meteredMicros: 980, billedMicros: 1000 }).band, "watch");
eq("a five-percent gap is bad", drift({ meteredMicros: 950, billedMicros: 1000 }).band, "bad");
eq("over-counting by five percent is just as bad as under-counting",
  drift({ meteredMicros: 1050, billedMicros: 1000 }).band, "bad");

/* ================================================================== */
console.log("\n9. the logger itself — driven, not just grepped");
/* ================================================================== */
/* Nothing tested recordAiUsage before. It is the one function every AI call in
 * the console goes through, and its two hardest promises — never throws, and an
 * unpriceable call is null rather than zero — were both provably false when a
 * review looked. A fake supabase client is enough: the function only ever calls
 * .from().insert() and .from().select(). */

function fakeAdmin({ failWith = null, throwOn = null } = {}) {
  const inserted = [];
  const logged = [];
  return {
    inserted, logged,
    from(table) {
      if (throwOn === table) throw new Error("the database exploded");
      return {
        select: async () => ({ data: [], error: null }),
        insert: async (row) => {
          if (table === "admin_activity_log") { logged.push(row); return { error: null }; }
          inserted.push(row);
          return { error: failWith };
        },
      };
    },
  };
}
/* .select() has to resolve to the price book for loadPrices; primePriceCache
 * puts one in without a database at all. */
primePriceCache(PRICES);

{
  const a = fakeAdmin();
  const out = await recordAiUsage(a, {
    model: "claude-sonnet-4-6", usage: { input_tokens: 1200, output_tokens: 480 },
    requestId: "req_x", feature: "client_report", surface: "client_detail",
    at: Date.parse("2026-08-20T15:00:00Z"),
  });
  eq("a normal call is saved", out.saved, true);
  eq("...with the cost worked out from the dated price book", out.costMicros, 7200);
  eq("...and cost_usd kept in step for the old readers", a.inserted[0].cost_usd, 0.0072);
  eq("...and the price row it used recorded, so the cost is frozen", a.inserted[0].price_id, "new");
  eq("...and the dedupe key defaulted to the provider's request id",
    a.inserted[0].event_key, "client_report:req_x");
  eq("...and the status says what happened to the CALL", a.inserted[0].status, "ok");
}
{
  const a = fakeAdmin();
  const out = await recordAiUsage(a, {
    model: "claude-sonnet-4-6", usage: null, status: "failed", feature: "client_report",
  });
  eq("a call that reported NO tokens is unpriced", out.unpriced, true);
  eq("...its cost is null, never 0", a.inserted[0].cost_micros, null);
  eq("...cost_usd is null too, so the old readers cannot read it as free", a.inserted[0].cost_usd, null);
  eq("...it still says the call FAILED", a.inserted[0].status, "failed");
  eq("...and the row says why the cost is missing", a.inserted[0].meta.tokensUnknown, true);
}
{
  const a = fakeAdmin();
  await recordAiUsage(a, { model: "no-such-model", usage: { input_tokens: 10, output_tokens: 10 } });
  eq("an unknown MODEL is unpriced", a.inserted[0].cost_micros, null);
  eq("...but its tokens are kept, so the gap can be sized", a.inserted[0].input_tokens, 10);
  eq("...and the row says which of the two reasons it was",
    a.inserted[0].meta.unpricedReason, "no price row for this model on this day");
  eq("...and the call itself is still marked ok", a.inserted[0].status, "ok");
}
{
  const a = fakeAdmin();
  await recordAiUsage(a, {
    model: "claude-sonnet-4-6", usage: {}, feature: "nonsense", surface: "nowhere",
    clientId: "Shiner Law Group", userId: "not-a-uuid",
  });
  eq("an invented feature falls back rather than being written", a.inserted[0].feature, "other");
  eq("an invented page falls back too", a.inserted[0].surface, "unknown");
  eq("a client NAME where an id belongs is dropped, not written", a.inserted[0].client_id, null);
  eq("...and the row NAMES what it dropped, so the spend did not move silently",
    a.inserted[0].meta.droppedIds.clientId, "Shiner Law Group");
}
{
  const a = fakeAdmin({ failWith: { code: "23505", message: "duplicate key" } });
  const out = await recordAiUsage(a, { model: "claude-sonnet-4-6", usage: {}, eventKey: "k" });
  eq("a duplicate key is the dedupe working, not a fault", out.reason, "duplicate");
  eq("...and nothing is reported as a lost write", a.logged.length, 0);
}
{
  const a = fakeAdmin({ failWith: { code: "42P01", message: "no such table" } });
  const out = await recordAiUsage(a, { model: "claude-sonnet-4-6", usage: {} });
  eq("a real write failure is not swallowed", out.saved, false);
  eq("...it is reported where Overview can read it", a.logged[0].kind, "usage_write_failed");
}
{
  /* The never-throws guarantee, attacked three ways. It was false for the third
   * one: destructuring with `= {}` only defaults on undefined, so a null
   * options object threw a TypeError before the try block ever ran. */
  const a = fakeAdmin({ throwOn: "admin_usage_events" });
  let threw = false;
  try { await recordAiUsage(a, { model: "m", usage: {} }); } catch { threw = true; }
  ok("recordAiUsage does not throw when the database does", !threw);
  threw = false;
  try { await recordAiUsage(null, { model: "m", usage: {} }); } catch { threw = true; }
  ok("...nor when handed no client at all", !threw);
  threw = false;
  try { await recordAiUsage(a, null); } catch { threw = true; }
  ok("...nor when handed a null options object", !threw);
}
ok("a freshly primed price cache is not stale", priceCacheIsStale() === false);

/* ================================================================== */
console.log("\n10. the code and the database agree — read from the real files");
/* ================================================================== */

const migration = read("supabase/migrations/0024_ai_usage.sql");
const logger = read("lib/ai-usage.js");

// Every column the logger writes must exist in the migration. A test that
// agrees with the code is not a test; this one reads the SQL.
const WRITES = [
  "provider", "request_id", "event_key", "cost_micros", "price_id",
  "cache_write_tokens", "cache_write_1h_tokens", "cache_read_tokens", "client_id", "user_id",
  "feature", "surface", "entity_kind", "entity_id", "status", "error_code",
  "latency_ms", "billable",
];
/* Comments stripped first. `\b${col}\b` against the whole file was satisfied by
 * the word appearing in the header prose, so "the logger really writes X" was
 * true of a file that wrote nothing at all. */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const loggerCode = codeOnly(logger);
for (const col of WRITES) {
  ok(`migration 0024 really has admin_usage_events.${col}`,
    new RegExp(`add column if not exists\\s+${col}\\b`, "i").test(migration));
  ok(`the logger really writes ${col} in its CODE, not its comments`,
    new RegExp(`^\\s*${col}:`, "m").test(loggerCode));
}

const PRICE_COLS = ["provider", "model", "effective_from", "effective_to",
  "input_per_mtok", "output_per_mtok", "cache_write_per_mtok",
  "cache_write_1h_per_mtok", "cache_read_per_mtok"];
for (const col of PRICE_COLS) {
  ok(`ai_model_prices really has ${col}`, new RegExp(`^\\s+${col}\\s`, "im").test(migration));
}

ok("there is a unique index on event_key, so a retry cannot double-count",
  /unique index[\s\S]{0,120}admin_usage_events\s*\(\s*event_key/i.test(migration));
ok("there is a unique index on the price window",
  /unique index[\s\S]{0,120}ai_model_prices\s*\(\s*provider,\s*model,\s*effective_from/i.test(migration));
ok("cost_micros is a bigint, not numeric — numeric(12,6) overflows at 999,999.999999",
  /cost_micros\s+bigint/i.test(migration));
ok("the bills table exists even though nothing pulls a bill yet",
  /create table if not exists public\.ai_provider_bills/i.test(migration));
ok("reps cannot read cost data", /admin_is_admin\(\)/.test(migration));

// The seven hardcoded price blocks are the defect this whole build removes.
// If one comes back, this fails.
const AI_APIS = ["ai-chat", "console-report", "client-report", "notes-generate",
  "ai-draft", "rep-report", "client-standing"];
for (const f of AI_APIS) {
  const src = read(`api/${f}.js`);
  ok(`api/${f}.js has no hardcoded price block any more`,
    !/const\s+COST\s*=\s*\{\s*input:/.test(src));
  ok(`api/${f}.js logs through the one logger`,
    /recordAiUsage/.test(src));
  ok(`api/${f}.js no longer inserts into admin_usage_events by hand`,
    !/from\(["']admin_usage_events["']\)\s*\.insert/.test(src));
}

// The live bug the blueprint found: a reader that silently truncates.
const data = read("src/lib/data.js");
ok("listUsage no longer has a bare .limit(5000) it never mentions",
  !/from\(["']admin_usage_events["']\)[\s\S]{0,400}\.limit\(5000\)/.test(data));
// Checked against the column list itself rather than a window of characters
// after the table name — the first version of this assertion looked for "meta"
// within 400 characters of "admin_usage_events" and failed the moment the
// columns were lifted into a named constant, which is a test measuring the
// layout of the file instead of what it does.
const usageCols = (data.match(/const USAGE_COLS = \[([\s\S]*?)\]/) || [])[1] || "";
for (const col of ["meta", "client_id", "user_id", "feature", "surface", "cost_micros",
  "cache_read_tokens", "status", "latency_ms", "provider", "request_id"]) {
  ok(`the usage reader selects ${col}`, usageCols.includes(`"${col}"`));
}
ok("the usage reader reports when it hit its ceiling",
  /truncated/.test(data));

// Request ids are the only thing that could ever match a call to a bill line.
ok("lib/ai.js reads the provider's request id off the headers",
  /headers\.get\(\s*["']request-id["']\s*\)/.test(read("lib/ai.js")));
ok("lib/ai-agent.js does too", /headers\.get\(\s*["']request-id["']\s*\)/.test(read("lib/ai-agent.js")));

/* THE VOCABULARIES, CHECKED IN BOTH DIRECTIONS, AGAINST THE CONSTRAINT ITSELF.
 *
 * The first version did `migration.includes("'notes'")`, which a COMMENT
 * satisfies as readily as a constraint, and only checked one way — a value
 * added to the SQL and not to the JS passed. And `SURFACES.length > 5` is a
 * tautology that will pass forever; there was no surface constraint in the
 * migration at all, which is what that assertion was pretending to check. */
function checkList(name) {
  const m = migration.match(new RegExp(`admin_usage_events_${name}_ck[\\s\\S]*?check\\s*\\(([\\s\\S]*?)\\);`, "i"));
  if (!m) return null;
  return [...m[1].matchAll(/'([a-z0-9_-]+)'/gi)].map((x) => x[1]);
}
for (const [name, list] of [["feature", FEATURES], ["status", STATUSES], ["surface", SURFACES]]) {
  const sql = checkList(name);
  ok(`the migration really has a ${name} check constraint`, Array.isArray(sql) && sql.length > 0);
  if (!sql) continue;
  for (const v of list) ok(`the database allows ${name} '${v}'`, sql.includes(v));
  for (const v of sql) ok(`the code knows about ${name} '${v}' the database allows`, list.includes(v));
}

/* The reader's ordering. Ordering on `ts` alone is not stable across two range
 * queries because ts is not unique — 40 rows sharing a millisecond across a page
 * boundary get silently duplicated and silently lost. */
ok("the paginated reader orders on a UNIQUE tiebreak, not just ts",
  /\.order\("ts"[\s\S]{0,120}\.order\("id"/.test(data));
ok("it pages with .range rather than one big .limit",
  /\.range\(/.test(data) && !/from\("admin_usage_events"\)[\s\S]{0,600}\.limit\(/.test(data));
ok("a failed read is reported as partial, not as a window that is too big",
  /partial: true/.test(data));

/* The ingest endpoint's upsert has to match the index it targets. A PARTIAL
 * unique index cannot be an ON CONFLICT target unless the statement repeats the
 * predicate, and PostgREST never does — which made every ingest call fail. */
ok("the event_key index is NOT partial, so the ingest upsert can target it",
  /create unique index[\s\S]{0,140}admin_usage_events \(event_key\)/.test(migration)
  && !/admin_usage_event_key_idx[\s\S]{0,200}where event_key is not null/.test(
    migration.split("create unique index if not exists admin_usage_event_key_idx")[1] || ""));

/* Partial usage has to survive a mid-conversation failure: a five-round
 * conversation that dies on round five was still billed for four. */
const agent = read("lib/ai-agent.js");
ok("converse attaches what it had already been billed for to the error",
  /partialUsage/.test(agent));
ok("...and it accumulates the 5m/1h cache split, or the split can never be priced",
  /ephemeral_1h_input_tokens/.test(agent));
ok("the assistant logs on its failure path too",
  /catch[\s\S]{0,400}logUsage/.test(read("api/ai-chat.js")));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
