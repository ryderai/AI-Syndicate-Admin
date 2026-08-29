/* AI cost maths for the admin console — Aug 28 2026.
 *
 * Every figure the AI Cost page shows is worked out in here, and nowhere else.
 * Pure functions: data in, data out. No database, no network, no clock of its
 * own (every function that needs "today" is handed it). That is why
 * tests/ai-cost/test.mjs can check the lot without a single key.
 *
 * THE HONESTY RULE, because a cost page that guesses is worse than no page.
 * Every figure carries a `basis`:
 *
 *   "metered"  — we counted it at the moment of the call, from the token
 *                numbers the AI company's own reply carried.
 *   "billed"   — the AI company's own figure, from their admin API or typed
 *                off an invoice.
 *   "unpriced" — we have the tokens but no price for that model. Shown as
 *                "not priced yet", NEVER as 0.
 *   "drift"    — metered against billed for the same month.
 *
 * MONEY IS MICRO-DOLLARS, AS WHOLE NUMBERS, EVERYWHERE IN THIS FILE.
 * One micro-dollar is a millionth of a dollar. A cheap call can cost a
 * fraction of a cent and floating-point dollars lose those fractions a little
 * at a time across tens of thousands of calls; lib/finance-math.js already
 * runs the money pages in whole cents for exactly this reason, and cents are
 * too coarse for one API call. The single division in costMicros() is rounded
 * on the spot; nothing float-shaped is ever returned, stored or summed.
 *
 * TRAP, and it is a real one: supabase-js hands back a Postgres `bigint` as a
 * STRING, not a number. "3000000" * 1200 coerces and happens to work;
 * "3000000" + 1200 concatenates into "30000001200". Every number that comes
 * out of the database goes through num() once, at the edge.
 *
 * DATES. A price window is a plain "YYYY-MM-DD" string and is compared as a
 * STRING. `new Date("2026-09-01")` is midnight UTC — the evening of Aug 31 in
 * Chicago — and this repo has shipped that bug twice. Day and month keys come
 * from teamDate(), which reads the team's own calendar.
 */

import { TEAM_TZ, teamDate } from "./brain-context.js";

export { TEAM_TZ };

export const MICROS_PER_DOLLAR = 1_000_000;
export const MICROS_PER_CENT = 10_000;

/* The bases a figure can carry. Exported so the UI cannot invent a fourth. */
export const BASIS = {
  METERED: "metered",
  BILLED: "billed",
  UNPRICED: "unpriced",
  DRIFT: "drift",
};

/* What happened to the CALL. A status outside this list is a bug, not a new
 * category, so readers fall back to "ok" rather than inventing one.
 *
 * THERE IS NO 'unpriced' STATUS, deliberately, and there used to be. It made
 * one column answer two different questions — what happened to the call, and
 * whether we could price it — so a call to an unknown model that ALSO failed
 * came out labelled 'unpriced' and the failure disappeared. Whether we could
 * price it is `cost_micros IS NULL`, which was already unambiguous. Found by
 * tests/ai-cost/test.mjs the first time it ran. */
export const STATUSES = ["ok", "failed", "rejected", "capped", "legacy"];

/* What the call was doing. Fixed, because free text turns into
 * Assistant / assistant / AI Assistant inside a month and the grouping
 * quietly splits in three. */
export const FEATURES = [
  "assistant", "client_report", "console_report", "rep_report", "client_standing",
  "notes", "email_draft", "outreach_draft", "lead_scrape", "audit", "prompt_sim", "other",
];

/* Which page it came from. Same reason. */
export const SURFACES = [
  "overview", "clients", "client_detail", "operations", "floor", "sales", "inbox",
  "tickets", "leads", "notes", "finance", "invoices", "brain", "settings",
  "api", "cron", "ai-cost", "unknown",
];

/* The bucket a call with no client belongs to. Never spread across clients. */
export const INTERNAL = "__internal__";
export const INTERNAL_LABEL = "Internal (no client)";

/* ------------------------------------------------------------------ */
/* Numbers                                                             */
/* ------------------------------------------------------------------ */

/** A number out of the database, safely. Strings, nulls and NaN all become 0. */
export function num(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Same, but a missing value stays missing. Used for prices, where 0 and
 *  "no such charge" mean completely different things. */
export function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* Usage — one shape, whatever the provider called it                  */
/* ------------------------------------------------------------------ */

/**
 * Every provider names its token counts differently. This turns any of them
 * into the four numbers the rest of the file uses.
 *
 * Anthropic: input_tokens, output_tokens, cache_creation_input_tokens,
 *            cache_read_input_tokens, and — when the request asked for it —
 *            cache_creation: { ephemeral_5m_input_tokens,
 *                              ephemeral_1h_input_tokens }
 * OpenAI:    prompt_tokens, completion_tokens,
 *            prompt_tokens_details.cached_tokens
 * Google:    promptTokenCount, candidatesTokenCount, cachedContentTokenCount
 *
 * OpenAI's cached_tokens are a SUBSET of prompt_tokens, not an extra pile, so
 * they are taken back out of the input count — otherwise the same tokens are
 * charged twice, once at the full rate and once at the cache rate.
 */
export function normalizeUsage(raw = {}) {
  const u = raw || {};

  const openAiCached = num(u.prompt_tokens_details?.cached_tokens);
  const anthropicCacheRead = num(u.cache_read_input_tokens ?? u.cache_read_tokens);
  const googleCached = num(u.cachedContentTokenCount);
  const cacheRead = anthropicCacheRead || openAiCached || googleCached;

  /* A CACHE WRITE COSTS A DIFFERENT AMOUNT DEPENDING ON HOW LONG IT LIVES.
   * Anthropic charges 1.25x the input rate for a 5-minute cache write and 2x
   * for a 1-hour one. `cache_creation_input_tokens` is the TOTAL of both; the
   * `cache_creation` object breaks it down. Folding the two together and
   * pricing them at the 5-minute rate understates a 1-hour write by 60%, and
   * nothing on the bill would ever show which it was. When the breakdown is
   * absent the whole write is a 5-minute one, which is the default. */
  const detail = u.cache_creation && typeof u.cache_creation === "object" ? u.cache_creation : null;
  const write1h = detail ? num(detail.ephemeral_1h_input_tokens) : num(u.cache_write_1h_tokens);
  let write5m;
  if (detail) {
    /* The breakdown is authoritative when it is there. If Anthropic ever adds a
     * third tier, the total will exceed the two we know about — that remainder
     * is booked as a 5-minute write rather than silently dropped, because
     * under-counting tokens is the one thing this file must never do. */
    const known = num(detail.ephemeral_5m_input_tokens) + write1h;
    const total = num(u.cache_creation_input_tokens);
    write5m = num(detail.ephemeral_5m_input_tokens) + Math.max(0, total - known);
  } else if (u.cache_write_tokens !== undefined || u.cache_write_1h_tokens !== undefined) {
    /* OUR OWN STORED COLUMNS, read back off a row. `cache_write_tokens` already
     * holds the 5-minute figure ALONE — subtracting the 1-hour count from it
     * deletes tokens. The first version did exactly that and a test asserted
     * the wrong answer (500 + 200 came back as 300), which is how a test that
     * agrees with the code hides a bug instead of finding it. */
    write5m = num(u.cache_write_tokens);
  } else {
    /* Anthropic's flat field is the TOTAL of both tiers, so the 1-hour part
     * comes out. With no breakdown, write1h is 0 and it is all a 5m write. */
    write5m = Math.max(0, num(u.cache_creation_input_tokens) - write1h);
  }

  let input = num(u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount);
  // OpenAI and Google fold the cached tokens INTO the prompt count. Anthropic
  // reports them alongside. Only subtract where they were folded in.
  if (!anthropicCacheRead && cacheRead && input >= cacheRead) input -= cacheRead;

  return {
    input_tokens: Math.max(0, Math.round(input)),
    output_tokens: Math.max(0, Math.round(num(u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount))),
    cache_write_tokens: Math.max(0, Math.round(write5m)),
    cache_write_1h_tokens: Math.max(0, Math.round(write1h)),
    cache_read_tokens: Math.max(0, Math.round(cacheRead)),
  };
}

/** Every token in a call, cached ones included. */
export function totalTokens(usage) {
  const u = normalizeUsage(usage);
  return u.input_tokens + u.output_tokens + u.cache_write_tokens
    + u.cache_write_1h_tokens + u.cache_read_tokens;
}

/* ------------------------------------------------------------------ */
/* Prices — dated rows, compared as strings                            */
/* ------------------------------------------------------------------ */

/** Is this plain YYYY-MM-DD inside the row's window? Both ends inclusive. */
export function priceCovers(row, ymd) {
  if (!row || !ymd) return false;
  const from = String(row.effective_from || "").slice(0, 10);
  const to = row.effective_to ? String(row.effective_to).slice(0, 10) : null;
  if (!from || from > ymd) return false;
  return !to || to >= ymd;
}

/**
 * The price for one model on one day.
 *
 * `onDate` is a plain "YYYY-MM-DD" in the TEAM's calendar. Never a Date.
 *
 * When two rows somehow cover the same day — which the unique index in
 * migration 0024 is there to prevent — the LATEST effective_from wins, so the
 * answer never depends on the order the database happened to return.
 */
export function priceFor(prices, { provider, model, onDate }) {
  if (!Array.isArray(prices) || !provider || !model || !onDate) return null;
  const ymd = String(onDate).slice(0, 10);
  const p = String(provider).toLowerCase();
  const m = String(model);
  let best = null;
  for (const row of prices) {
    if (!row) continue;
    if (String(row.provider || "").toLowerCase() !== p) continue;
    if (String(row.model || "") !== m) continue;
    if (!priceCovers(row, ymd)) continue;
    if (!best || String(row.effective_from) > String(best.effective_from)) best = row;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* The cost of one call                                                */
/* ------------------------------------------------------------------ */

/**
 * What one call cost, in whole micro-dollars.
 *
 * Returns NULL — never 0 — when we cannot work it out honestly:
 *   - no price row for that model on that day
 *   - the call used cached tokens and the price row has no cache rate
 *
 * A wrong number that looks right is worse than a gap that says it is a gap.
 * Zero is a real answer meaning "this was free", and it must never be the
 * shape "we don't know" takes.
 */
export function costMicros(price, usage) {
  if (!price) return null;
  /* NO USAGE OBJECT AT ALL MEANS WE DO NOT KNOW, NOT THAT IT WAS FREE.
   * Every catch block in api/ passes `usage: null` or an undefined
   * `aiResult?.usage` — a call that threw never reported its token counts. The
   * first version normalised that to four zeros and returned a confident 0: a
   * priced-looking figure for a call the provider may well have billed us for,
   * which then sat in the denominator of the average and pulled it down. Zero
   * is a real answer meaning "free". This is not that. */
  if (usage === null || usage === undefined) return null;
  const u = normalizeUsage(usage);

  const inRate = numOrNull(price.input_per_mtok);
  const outRate = numOrNull(price.output_per_mtok);
  if (inRate === null || outRate === null) return null;

  const writeRate = numOrNull(price.cache_write_per_mtok);
  const write1hRate = numOrNull(price.cache_write_1h_per_mtok);
  const readRate = numOrNull(price.cache_read_per_mtok);
  if (u.cache_write_tokens > 0 && writeRate === null) return null;
  if (u.cache_write_1h_tokens > 0 && write1hRate === null) return null;
  if (u.cache_read_tokens > 0 && readRate === null) return null;

  // Rounded here, once, per component. Rounding the total instead would let
  // the four parts drift against a per-line breakdown of the same call.
  const per = (tokens, rate) => Math.round((tokens * rate) / 1_000_000);

  return per(u.input_tokens, inRate)
    + per(u.output_tokens, outRate)
    + per(u.cache_write_tokens, writeRate || 0)
    + per(u.cache_write_1h_tokens, write1hRate || 0)
    + per(u.cache_read_tokens, readRate || 0);
}

/**
 * What the cache actually saved us on this call, in micro-dollars.
 * Cached tokens read at the cheap rate instead of the full input rate.
 * Null when it cannot be worked out — same rule as everywhere else.
 */
export function cacheSavingMicros(price, usage) {
  if (!price) return null;
  const u = normalizeUsage(usage);
  if (!u.cache_read_tokens) return 0;
  const inRate = numOrNull(price.input_per_mtok);
  const readRate = numOrNull(price.cache_read_per_mtok);
  if (inRate === null || readRate === null) return null;
  const full = Math.round((u.cache_read_tokens * inRate) / 1_000_000);
  const paid = Math.round((u.cache_read_tokens * readRate) / 1_000_000);
  return full - paid;
}

/** Everything the logger needs to write one row, worked out in one place. */
export function priceCall({ prices, provider, model, usage, atMs, now = Date.now() }) {
  const ymd = teamDate(typeof atMs === "number" ? atMs : now);
  const price = priceFor(prices, { provider, model, onDate: ymd });
  const cost = costMicros(price, usage);
  return {
    day: ymd,
    price,
    priceId: price?.id || null,
    costMicros: cost,
    unpriced: cost === null,
    savingMicros: cacheSavingMicros(price, usage),
    usage: normalizeUsage(usage),
  };
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

/** Micro-dollars to whole cents, for anything that meets lib/finance-math.js. */
export function microsToCents(micros) {
  if (micros === null || micros === undefined) return null;
  return Math.round(num(micros) / MICROS_PER_CENT);
}

/**
 * Money, written the way a person reads it.
 * Under a cent it prints four decimal places, because "$0.00" next to 4,000
 * tokens reads as a bug and "$0.0007" reads as a small number.
 */
export function formatMicros(micros) {
  if (micros === null || micros === undefined) return "not priced yet";
  const dollars = num(micros) / MICROS_PER_DOLLAR;
  if (dollars === 0) return "$0.00";
  const abs = Math.abs(dollars);
  if (abs < 0.01) return `$${dollars.toFixed(4)}`;
  if (abs < 1000) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** 1,240,000 -> "1.24M". Token counts get long fast. */
export function formatTokens(n) {
  const v = num(n);
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(2)}M`;
}

/* ------------------------------------------------------------------ */
/* Rolling events up                                                   */
/* ------------------------------------------------------------------ */

/** The team-calendar day an event belongs to. */
export function eventDay(ev) {
  const t = Date.parse(ev?.ts || "");
  return Number.isNaN(t) ? null : teamDate(t);
}

/** The team-calendar month, "YYYY-MM". */
export function eventMonth(ev) {
  const d = eventDay(ev);
  return d ? d.slice(0, 7) : null;
}

/** An empty tally. Every rollup starts here so no field can be undefined. */
function blankTotals() {
  return {
    calls: 0,
    ok: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    costMicros: 0,
    unpricedCalls: 0,
    unpricedTokens: 0,
    tokensUnknown: 0,
    legacyCalls: 0,
    nonBillable: 0,
    latencySamples: [],
  };
}

function addEvent(t, ev) {
  t.calls += 1;
  const status = STATUSES.includes(ev?.status) ? ev.status : "ok";
  if (status === "ok" || status === "legacy") t.ok += 1;
  else t.failed += 1;
  /* LEGACY ROWS ARE NOT MEASURED. They were costed with the hardcoded Sonnet
   * rate this build removed, applied to whatever model actually ran. Migration
   * 0024 labels them so no screen can present them as measured — and then the
   * first version of this counted them as plain 'ok' and summed them straight
   * into a METERED total, which made the label pointless. */
  if (status === "legacy") t.legacyCalls += 1;
  /* A call that threw never reported its token counts, so whatever it cost is
   * in nobody's total. Counted separately so the page can say how big the hole
   * is instead of implying there isn't one. */
  if (status !== "ok" && status !== "legacy" && ev?.meta?.tokensUnknown) t.tokensUnknown += 1;

  t.inputTokens += num(ev?.input_tokens);
  t.outputTokens += num(ev?.output_tokens);
  t.cacheWriteTokens += num(ev?.cache_write_tokens);
  t.cacheWrite1hTokens += num(ev?.cache_write_1h_tokens);
  t.cacheReadTokens += num(ev?.cache_read_tokens);

  // cost_micros is deliberately nullable and null means UNPRICED. Counting a
  // null as 0 is the exact failure this whole file exists to prevent, so it is
  // counted in its own column instead and printed beside the total.
  /* `billable: false` marks something we are not actually charged for. It was
   * written by both writers and read by nothing, so a free call still showed as
   * spend. Counted, not summed. */
  if (ev?.billable === false) t.nonBillable += 1;

  const c = ev?.cost_micros;
  if (c === null || c === undefined) {
    t.unpricedCalls += 1;
    t.unpricedTokens += num(ev?.input_tokens) + num(ev?.output_tokens)
      + num(ev?.cache_write_tokens) + num(ev?.cache_write_1h_tokens)
      + num(ev?.cache_read_tokens);
  } else if (ev?.billable !== false) {
    t.costMicros += num(c);
  }

  const ms = numOrNull(ev?.latency_ms);
  if (ms !== null && ms >= 0) t.latencySamples.push(ms);
}

/** Nearest-rank percentile. p is 0..1. Null on an empty list, never 0. */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || !sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function finishTotals(t) {
  const lat = t.latencySamples.slice().sort((a, b) => a - b);
  const priced = t.calls - t.unpricedCalls;
  return {
    calls: t.calls,
    ok: t.ok,
    failed: t.failed,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    cacheWrite1hTokens: t.cacheWrite1hTokens,
    cacheReadTokens: t.cacheReadTokens,
    totalTokens: t.inputTokens + t.outputTokens + t.cacheWriteTokens
      + t.cacheWrite1hTokens + t.cacheReadTokens,
    costMicros: t.costMicros,
    unpricedCalls: t.unpricedCalls,
    unpricedTokens: t.unpricedTokens,
    tokensUnknown: t.tokensUnknown,
    legacyCalls: t.legacyCalls,
    nonBillable: t.nonBillable,
    // The average is over the calls we could actually price. Dividing priced
    // spend by every call, priced or not, understates it silently.
    avgCostMicros: priced > 0 ? Math.round(t.costMicros / priced) : null,
    medianLatencyMs: percentile(lat, 0.5),
    p95LatencyMs: percentile(lat, 0.95),
    /* UNPRICED the moment nothing is left that we DID price. The first version
     * only said so when every single call was unpriced, so 999 of 1,000 still
     * wore a green METERED badge. */
    basis: priced > 0 ? BASIS.METERED : BASIS.UNPRICED,
  };
}

/** The money figure, or null when there is no honestly-priced money behind it.
 *
 *  Every tile on the page goes through this rather than printing a bare total.
 *  `formatMicros(0)` is the string "$0.00", and a Figure only blanks on null —
 *  so a month in which nothing could be priced printed a confident "$0.00"
 *  under a green METERED badge, which is the exact failure this codebase exists
 *  to prevent. */
export function pricedCost(totals) {
  if (!totals || !totals.calls) return null;
  return totals.calls > totals.unpricedCalls ? totals.costMicros : null;
}

/** Everything, added up. */
export function summarize(events = []) {
  const t = blankTotals();
  for (const ev of events) addEvent(t, ev);
  return finishTotals(t);
}

/* How each grouping reads its key and its label off an event. `clients` and
 * `people` are lookup maps so an id can be printed as a name. */
export const GROUPINGS = {
  client: {
    label: "By client",
    keyOf: (ev) => ev?.client_id || INTERNAL,
    labelOf: (key, maps) => (key === INTERNAL ? INTERNAL_LABEL : (maps?.clients?.[key] || "Unknown client")),
  },
  person: {
    label: "By person",
    keyOf: (ev) => ev?.user_id || "__system__",
    labelOf: (key, maps) => (key === "__system__" ? "System / scheduled" : (maps?.people?.[key] || "Unknown person")),
  },
  feature: {
    label: "By feature",
    keyOf: (ev) => ev?.feature || "other",
    labelOf: (key) => key,
  },
  surface: {
    label: "By page",
    keyOf: (ev) => ev?.surface || "unknown",
    labelOf: (key) => key,
  },
  model: {
    label: "By model",
    keyOf: (ev) => `${ev?.provider || "unknown"}/${ev?.model || "unknown"}`,
    labelOf: (key) => key,
  },
  day: {
    label: "By day",
    keyOf: (ev) => eventDay(ev) || "no date",
    labelOf: (key) => key,
  },
};

/**
 * Group events and total each group.
 *
 * Rows come back biggest-spend first, with the unpriced groups after the
 * priced ones — a group we cannot price is not a cheap group, and sorting it
 * in among the small numbers is how it stops being noticed.
 */
export function rollup(events = [], by = "client", maps = {}) {
  const g = GROUPINGS[by] || GROUPINGS.client;
  const buckets = new Map();
  for (const ev of events) {
    const key = String(g.keyOf(ev));
    if (!buckets.has(key)) buckets.set(key, blankTotals());
    addEvent(buckets.get(key), ev);
  }
  const grand = summarize(events);
  const rows = [];
  for (const [key, t] of buckets) {
    const totals = finishTotals(t);
    rows.push({
      key,
      label: g.labelOf(key, maps),
      ...totals,
      // Share of the priced total. Null when nothing was priced, so the page
      // cannot print "100% of $0".
      share: grand.costMicros > 0 ? totals.costMicros / grand.costMicros : null,
    });
  }
  rows.sort((a, b) => {
    const aAll = a.calls > 0 && a.calls === a.unpricedCalls;
    const bAll = b.calls > 0 && b.calls === b.unpricedCalls;
    if (aAll !== bAll) return aAll ? 1 : -1;
    if (b.costMicros !== a.costMicros) return b.costMicros - a.costMicros;
    return b.calls - a.calls;
  });
  return rows;
}

/** Two windows of the same length, compared. Null when there is nothing to
 *  compare against — a first month has no change, and "+100%" would be a lie. */
export function changeAgainst(current, previous) {
  const a = num(current);
  const b = num(previous);
  if (!b) return null;
  return (a - b) / b;
}

/* ------------------------------------------------------------------ */
/* The month you are standing in is not finished                       */
/* ------------------------------------------------------------------ */

/** Days in a calendar month, from its "YYYY-MM" key. No Date() involved. */
export function daysInMonth(monthKey) {
  const [y, m] = String(monthKey).split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) return 29;
  return lengths[m - 1];
}

/**
 * "18 of 31 days in" — the sentence that stops a part month being read as a
 * whole one. Returns null for a month that has finished, so the caller prints
 * nothing rather than a confusing "31 of 31".
 */
export function partMonthNote(monthKey, nowMs = Date.now()) {
  const today = teamDate(nowMs);
  if (today.slice(0, 7) !== String(monthKey)) return null;
  const total = daysInMonth(monthKey);
  const day = Number(today.slice(8, 10));
  if (!total || !day) return null;
  return { day, total, text: `${day} of ${total} days in` };
}

/** The team-calendar month before this one. Strings only. */
export function previousMonth(monthKey) {
  const [y, m] = String(monthKey).split("-").map(Number);
  if (!y || !m) return null;
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* The true-up. Nothing calls this yet — no admin keys exist — but the  */
/* maths is here and tested so the page can never invent it later.      */
/* ------------------------------------------------------------------ */

export const DRIFT_BANDS = { GOOD: 0.01, WATCH: 0.03 };

/**
 * Our count against the provider's bill.
 * Null band when there is no bill: the page must show "no bill on file", not
 * a green tick it has not earned.
 */
export function drift({ meteredMicros, billedMicros }) {
  const billed = numOrNull(billedMicros);
  if (billed === null || billed === 0) {
    return { basis: BASIS.DRIFT, ratio: null, band: null, reason: "no bill on file yet" };
  }
  const ratio = (billed - num(meteredMicros)) / billed;
  const abs = Math.abs(ratio);
  const band = abs < DRIFT_BANDS.GOOD ? "good" : abs < DRIFT_BANDS.WATCH ? "watch" : "bad";
  return { basis: BASIS.DRIFT, ratio, band, reason: null };
}
