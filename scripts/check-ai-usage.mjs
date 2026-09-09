#!/usr/bin/env node
/* NOTHING IN THIS CONSOLE MAY SPEND MONEY WITHOUT RECORDING IT.
 *
 * WHY THIS FILE EXISTS
 *
 * On 8 Sep 2026 the platform repo learned this the expensive way: two paid
 * vendors — searchapi.io and zernio.com — spent real money every day for two
 * months and appeared on NO screen, not even as a call, because the only check
 * that existed could look for hostnames that were already in the meter's
 * table. It could not notice a vendor nobody had added.
 *
 * This repo was in a worse position than that. It had NO check at all — no
 * scripts/ directory — and its usage recording is remember-to-call:
 * `recordAiUsage` is invoked by hand in each handler, and the two transports
 * (lib/ai.js, lib/ai-agent.js) return `usage` and record nothing themselves.
 *
 * An audit on 8 Sep found the recording actually COMPLETE — all eight handlers
 * that can reach a model API call recordAiUsage, converse() totals its usage
 * across every billed round, and the handlers record `err.partialUsage` when
 * it throws part-way. That is diligence, and diligence is not a guarantee. A
 * ninth handler written next month would ship unrecorded and nothing anywhere
 * would go red. This is that gap closed.
 *
 * WHAT IT CHECKS — five things, and each one fails the build
 *
 *  1. MODEL SPEND IS RECORDED. Any non-test file under api/ that can reach a
 *     model transport through the REAL import graph must call recordAiUsage.
 *  2. EVERY PAID VENDOR IS CLASSIFIED. Any hostname reached with a credential
 *     is either recorded or listed in PAID_HOSTS below with a reason.
 *  3. A HOST CLAIMED AS `recorded` REALLY IS. A label nothing verifies is how
 *     an exemption list rots; the platform's own guard shipped that backwards.
 *  4. A `must-record-before-use` HOST IS NOT CALLED AT ALL. Listing a paid host
 *     is how we remember it costs money, never permission to spend on it.
 *  5. THE TOKEN-LESS LIST MATCHES THE PLATFORM'S. api/usage-ingest.js keeps a
 *     copy of the platform's TOKENLESS_PROVIDERS. The repos cannot import each
 *     other, so this asserts the copy against a written-out list — a name
 *     missing from it gets stamped meta.tokensUnknown and rendered in the AI
 *     Cost page's metering-is-broken banner, and its per-call price is thrown
 *     away. That is what happened to searchapi and zernio.
 *
 * WHAT IT CANNOT DO
 *
 * It reads the import graph and the source text. It cannot tell whether a
 * recordAiUsage call is on every code path inside a handler, only that the
 * handler has one. It cannot see a hostname built by string concatenation, or
 * a credential held in a module the calling file does not import. Those gaps
 * are real and are the reason this is a floor, not a proof.
 *
 * Run by `npm run lint`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { parse } from "espree";

/* A CALL, not a mention. A bare /recordAiUsage/ text test was satisfied by the
 * `import { recordAiUsage } from ...` line on its own, so a file could import
 * it, never call it, and pass. Found by mutation-testing this very check:
 * ripping the call out of api/lead-scrape.js and leaving its import behind left
 * the guard green. The paren is what separates a call from an import. */
const RECORDS = /recordAiUsage\s*\(/;

/* ============================= the paid-host registry =============================
 *
 * ["hostname", "state", "why"]
 *   recorded    the spend reaches admin_usage_events and the AI Cost page.
 *   must-record-before-use
 *               a known paid host that NOTHING here may call until its spend is
 *               recorded. Listing it does not permit it: if any credentialed
 *               file names it, the build FAILS. This is a reservation, not an
 *               exemption — the whole failure this repo is guarding against is
 *               a paid host arriving with nobody noticing, and a label that
 *               lets it arrive quietly would reproduce it.
 *   free        no per-call charge.
 *   ours        our own services.
 */
const PAID_HOSTS = [
  ["api.anthropic.com", "recorded", "the console's own model calls; every handler that reaches it calls recordAiUsage"],
  ["api.apollo.io", "recorded", "api/lead-scrape.js fetchApollo() — Apollo people search, billed per credit. Recorded NOWHERE until 8 Sep 2026; runSource() now writes one usage row per search, tokens null, so it prints NOT PRICED rather than $0.00. A price row will NOT change that: costMicros() returns null when usage is null, so a per-search fee needs the per_call_micros column, still open in both repos"],
  ["api.stripe.com", "free", "reading our own billing data; Stripe charges on payments, not API calls"],
  ["businessprofileperformance.googleapis.com", "free", "Google Business Profile Performance API (lib/connector-fetch.js). No per-call charge; the exposure is a quota hard stop. Found the moment the blanket googleapis.com exemption was removed, which is the point of removing it"],
  ["generativelanguage.googleapis.com", "must-record-before-use", "Gemini. A PAID model API, and it sits under googleapis.com, which the OURS exemption below used to wave through wholesale. Nothing in this repo calls it today — this line exists so that the day something does, it is already named"],
];

const RESERVED = PAID_HOSTS.filter(([, s]) => s === "must-record-before-use");
const CLAIMED_RECORDED = PAID_HOSTS.filter(([, s]) => s === "recorded").map(([h]) => h);

/* The platform's lib/ai-meter.js TOKENLESS_PROVIDERS, written out. If this
 * fails, the fix is TWO repos: this list, api/usage-ingest.js's
 * ADMIN_TOKENLESS_PROVIDERS, and the platform's set must all agree. */
const EXPECTED_TOKENLESS = [
  "firecrawl", "higgsfield", "platform-audit", "searchapi", "serpapi", "serper", "zernio",
];

/* Files that talk to a model API. A file that can reach one of these through
 * the import graph is spending money. */
const TRANSPORTS = new Set(["lib/ai.js", "lib/ai-agent.js"]);

/* Reaching a transport only to read a config flag is not spending. */
const CONFIG_ONLY = /^\s*import\s*\{([^}]*)\}\s*from\s*["'][^"']*(ai|ai-agent)\.js["']/;
const CONFIG_EXPORTS = new Set(["isAiConfigured", "AI_MODEL", "AGENT_MODEL", "AGENT_MAX_ROUNDS", "buildSystemPrompt"]);

const ROOTS = ["api", "lib"];
/* Vercel deploys api/*.ts too, and .cjs is a module like any other. The first
 * version listed only three and a .ts handler walked past every check. */
const EXTS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"];
const isTest = (rel) => /(^|\/)tests?\//.test(rel) || /\.(test|spec)\.[a-z]+$/.test(rel);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r)).map((f) => relative(process.cwd(), f).replace(/\\/g, "/"));
const raw = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

/* ⭐ EVERY TEXT TEST BELOW RUNS ON CODE WITH THE COMMENTS REMOVED.
 *
 * The first version of this file did not, and check 4 below silently passed
 * when the recording was ripped out of api/lead-scrape.js — because the word
 * `recordAiUsage` still appeared in a COMMENT explaining that recordAiUsage
 * never throws. A guard that reads comments is checking prose.
 *
 * This is the same defect the platform's scripts/check-ai-meter-context.mjs
 * shipped and fixed on 8 Sep 2026, and a regex stripper is not the fix either:
 * a comment-opening sequence inside a string literal eats live code, and a
 * hand-rolled scanner cannot read JSX. espree is already here because eslint
 * is, and it is the same parser `npm run lint` runs over these files.
 *
 * FAIL-SAFE: a file that will not parse is used UNCHANGED, comments and all.
 * That direction can only make a check see more and complain; it can never
 * make one go quiet. */
function stripComments(text) {
  for (const sourceType of ["module", "script"]) {
    try {
      const ast = parse(text, {
        sourceType, ecmaVersion: "latest", comment: true, range: true,
        ecmaFeatures: { jsx: true, globalReturn: true },
      });
      let out = text;
      for (const [start, end] of ast.comments.map((c) => c.range).sort((a, b) => b[0] - a[0])) {
        out = out.slice(0, start) + out.slice(start, end).replace(/[^\n]/g, " ") + out.slice(end);
      }
      return out;
    } catch { /* try the next sourceType, then give up safely */ }
  }
  return text;
}

const source = new Map(files.map((f) => [f, stripComments(raw.get(f))]));

/** Resolve this file's relative imports to real repo paths. */
function importsOf(file) {
  const out = [];
  /* Static `import x from "./y"` AND dynamic `await import("./y")`. The first
   * version required whitespace after `import`, which `import("./y")` never
   * has, so a handler could reach a paid transport through a dynamic import
   * and the graph walk saw nothing. */
  const patterns = [/(?:from|import)\s+["'](\.[^"']+)["']/g, /\bimport\s*\(\s*["'](\.[^"']+)["']/g];
  for (const m of patterns.flatMap((re) => [...source.get(file).matchAll(re)])) {
    let p = resolve(dirname(file), m[1]).replace(process.cwd() + "/", "");
    if (!source.has(p)) {
      for (const ext of ["", ".js", ".mjs", ".jsx", "/index.js"]) if (source.has(p + ext)) { p += ext; break; }
    }
    if (source.has(p)) out.push(p);
  }
  return out;
}

/** Does this file import a transport ONLY for a config flag? */
/* ⭐ FAIL TOWARDS "IT SPENDS".
 *
 * The first version returned true when it found no matching import line, so an
 * extensionless `import { draft } from "../lib/ai"` — which importsOf resolves
 * perfectly well — was exempted as config-only and its spend went unchecked.
 * A guard's default answer must be the unsafe one. This looks at the whole
 * import STATEMENT (which may span lines) rather than a single line, and only
 * says "config only" when it has actually read a named-import list and every
 * name in it is a config export. A namespace or default import is never
 * config-only, because you cannot tell from the import what it reaches. */
function transportIsConfigOnly(file, transport) {
  const stem = transport.replace(/^lib\//, "").replace(/\.js$/, "");
  const text = source.get(file);
  const spec = new RegExp(`import\\s+([^;]*?)\\s+from\\s+["'][^"']*\\/${stem}(?:\\.js)?["']`, "g");
  let sawOne = false;
  for (const m of text.matchAll(spec)) {
    sawOne = true;
    const clause = m[1].trim();
    if (clause.startsWith("*")) return false;                 // namespace import
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    if (!braces) return false;                                 // default or mixed import
    const named = braces[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    if (!named.length) return false;
    if (!named.every((n) => CONFIG_EXPORTS.has(n))) return false;
  }
  return sawOne;
}

const memo = new Map();
/** The import chain from `file` to a transport, or null. */
function reachesTransport(file, seen = new Set()) {
  if (memo.has(file)) return memo.get(file);
  if (seen.has(file)) return { chain: null, cut: true };
  seen.add(file);
  let chain = null;
  let cut = false;
  for (const dep of importsOf(file)) {
    if (TRANSPORTS.has(dep)) {
      if (transportIsConfigOnly(file, dep)) continue;
      chain = [dep];
      break;
    }
    const deeper = reachesTransport(dep, seen);
    if (deeper.cut) cut = true;
    if (deeper.chain) { chain = [dep, ...deeper.chain]; break; }
  }
  const result = { chain, cut };
  /* ⭐ DO NOT CACHE A "no" THAT ONLY MEANS "I WAS ALREADY LOOKING AT THAT".
   * The first version memoized the null produced by the cycle guard above, so
   * with an import cycle in the graph the first handler to touch it poisoned
   * the answer for every later handler — one of which reached a paid transport
   * through that cycle, unrecorded, with the check printing a tick. Only a
   * complete search is worth remembering. */
  if (!cut) memo.set(file, result);
  return result;
}

const unrecorded = [];
let spenders = 0;

for (const file of files) {
  if (isTest(file) || TRANSPORTS.has(file)) continue;
  /* Only a request handler can be the place a recording belongs; a lib is
   * allowed to be a step on the way to one. */
  if (!file.startsWith("api/")) continue;
  const { chain } = reachesTransport(file);
  if (!chain) continue;
  spenders++;
  if (RECORDS.test(source.get(file))) continue;
  unrecorded.push({ file, via: chain.join(" -> ") });
}

/* --- check 2: a credentialed hostname must be classified ------------------ */
const KNOWN_HOSTS = new Set(PAID_HOSTS.map(([h]) => h));
/* OVER-matching costs one registry line. UNDER-matching is the bug this file
 * exists to stop: the first version wanted the whole word PASSWORD, so
 * `process.env.EXA_PASS` skipped the file entirely and its brand-new paid host
 * was never even considered. The header-based tells are the strongest of these
 * and do not depend on how anybody spelled a variable. */
const CREDENTIAL = new RegExp([
  "process\\s*\\.\\s*env\\s*\\.\\s*[A-Za-z0-9_$]*(?:key|token|tok|secret|password|passwd|pass|pw|auth|bearer|sid|cred|access|signature|private|apikey)[A-Za-z0-9_$]*",
  "process\\s*\\.\\s*env\\s*\\[",
  "\\{[^{}]*\\}\\s*=\\s*process\\s*\\.\\s*env\\b",
  "[\"'`]?[Aa]uthorization[\"'`]?\\s*:",
  "[\"'`]x-[a-z-]*(?:api-)?key[\"'`]",
  "[\"'`]x-goog-api-key[\"'`]",
  "\\bBearer\\s",
].join("|"), "i");
const URL_HOST = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
/* ⭐ NOT a blanket googleapis.com exemption. That one line waved through every
 * Google API, INCLUDING generativelanguage.googleapis.com and
 * aiplatform.googleapis.com, which are paid model APIs. The free-quota Google
 * hosts this repo actually uses are named one by one instead. */
const OURS = new RegExp([
  "(^|\\.)aisyndicate\\.com$",
  "(^|\\.)supabase\\.(co|com)$",
  "(^|\\.)vercel\\.app$",
  "(^|\\.)schema\\.org$",
  "^www\\.googleapis\\.com$",
  "^oauth2\\.googleapis\\.com$",
  "^accounts\\.google\\.com$",
  "^searchconsole\\.googleapis\\.com$",
  "^analytics(admin|data)\\.googleapis\\.com$",
  "^gmail\\.googleapis\\.com$",
  "^mybusiness[a-z]*\\.googleapis\\.com$",
  "^(www\\.)?google\\.com$",
].join("|"));

const unclassified = new Map();
for (const file of files) {
  if (isTest(file)) continue;
  const text = source.get(file);
  if (!CREDENTIAL.test(text)) continue;
  for (const m of text.matchAll(URL_HOST)) {
    const host = m[1].toLowerCase();
    if (KNOWN_HOSTS.has(host) || OURS.test(host)) continue;
    if (!unclassified.has(host)) unclassified.set(host, new Set());
    unclassified.get(host).add(file);
  }
}

/* --- check 3: the token-less list agrees with the platform's -------------- */
let tokenlessProblem = null;
try {
  /* ⭐ THE STRIPPED SOURCE, not readFileSync. The first version read the raw
   * file, so a provider commented OUT inside the Set's own brackets —
   * `// dropped "zernio" while we investigate` — still satisfied the scrape
   * while the runtime Set no longer contained it. Exit 0, and zernio back in
   * the metering-broken banner. This is the check whose silent pass matters
   * most, and it was the silent one. */
  const ingest = source.get("api/usage-ingest.js") ?? readFileSync("api/usage-ingest.js", "utf8");
  const block = ingest.match(/ADMIN_TOKENLESS_PROVIDERS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!block) {
    tokenlessProblem = "api/usage-ingest.js no longer exports ADMIN_TOKENLESS_PROVIDERS as a literal Set — this check can no longer read it.";
  } else {
    const got = [...block[1].matchAll(/["']([a-z0-9-]+)["']/g)].map((m) => m[1]).sort();
    const want = [...EXPECTED_TOKENLESS].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      tokenlessProblem = `api/usage-ingest.js lists [${got.join(", ")}] but this check expects [${want.join(", ")}].`;
    }
  }
} catch (err) {
  tokenlessProblem = `could not read api/usage-ingest.js: ${err.message}`;
}

/* --- check 4: a host CLAIMED as recorded must really be recorded ---------
 *
 * A label nothing verifies is the "stale exemption" failure: the platform's
 * own guard shipped with that backwards and silently accepted the one case it
 * existed for. So for every host marked `recorded`, at least one file that
 * names it must either call recordAiUsage itself or be imported (however
 * deeply) by a file that does. Move the recording out and this goes red. */
const reverse = new Map(files.map((f) => [f, []]));
for (const f of files) for (const dep of importsOf(f)) reverse.get(dep)?.push(f);

function recordedNearby(file, seen = new Set()) {
  if (seen.has(file)) return false;
  seen.add(file);
  if (RECORDS.test(source.get(file))) return true;
  return (reverse.get(file) || []).some((up) => recordedNearby(up, seen));
}

const falseClaims = [];
for (const host of CLAIMED_RECORDED) {
  const naming = files.filter((f) => !isTest(f) && source.get(f).includes(host));
  if (!naming.length) { falseClaims.push({ host, why: "no file names this host any more — the line is stale" }); continue; }
  if (!naming.some((f) => recordedNearby(f))) {
    falseClaims.push({ host, why: `named in ${naming.join(", ")}, and nothing there or above it calls recordAiUsage` });
  }
}

/* --- check 5: a reserved host must not be called at all ------------------
 *
 * `must-record-before-use` means exactly that. Naming the host in the registry
 * is how we remember it is paid; it is not permission to spend on it. Without
 * this, adding a line to the registry would be the cheapest way to silence the
 * check — which is the failure mode, not the fix. */
const reservedInUse = [];
for (const [host] of RESERVED) {
  const naming = files.filter((f) => !isTest(f) && source.get(f).includes(host));
  if (naming.length) reservedInUse.push({ host, naming });
}

/* ------------------------------------------------------------------ report */
let failed = false;

if (unrecorded.length) {
  failed = true;
  console.error("\n✗ ai-usage: these handlers can spend money on a model API and never record it.");
  console.error("  Their spend would appear on no screen. Add a recordAiUsage call after the model call.\n");
  for (const u of unrecorded) console.error(`  ${u.file}\n      reaches a paid call via ${u.via}\n`);
}

if (unclassified.size) {
  failed = true;
  console.error("\n✗ ai-usage: a hostname is reached with a credential and is not classified.");
  console.error("  If it charges us, that money lands on no screen. Add one line to PAID_HOSTS");
  console.error("  in scripts/check-ai-usage.mjs, with a reason.\n");
  for (const [host, where] of [...unclassified].sort()) {
    console.error(`  ${host}\n      named in: ${[...where].sort().join(", ")}\n`);
  }
}

if (falseClaims.length) {
  failed = true;
  console.error("\n✗ ai-usage: a host is listed as `recorded` and is not.");
  console.error("  A label nothing verifies is how an exemption list rots.\n");
  for (const c of falseClaims) console.error(`  ${c.host} — ${c.why}`);
  console.error("");
}

if (reservedInUse.length) {
  failed = true;
  console.error("\n✗ ai-usage: something now calls a paid host that has no recording yet.");
  console.error("  The registry reserved it precisely so this could not happen quietly.");
  console.error("  Record its spend (see recordLeadSearch in api/lead-scrape.js for the shape),");
  console.error("  then change its line to `recorded`.\n");
  for (const r of reservedInUse) console.error(`  ${r.host}\n      called from: ${r.naming.join(", ")}\n`);
}

if (tokenlessProblem) {
  failed = true;
  console.error("\n✗ ai-usage: the token-less provider list is out of step.");
  console.error(`  ${tokenlessProblem}`);
  console.error("  A provider missing from it is stamped meta.tokensUnknown and shown in the AI Cost");
  console.error("  page's metering-is-broken banner, and its per-call price is discarded. Fix BOTH");
  console.error("  this repo's api/usage-ingest.js AND the platform's lib/ai-meter.js in one change.\n");
}

if (failed) process.exit(1);

console.log(`✓ ai-usage: all ${spenders} handlers that can reach a model API record their usage.`);
console.log(`  token-less list agrees with the platform's (${EXPECTED_TOKENLESS.length} providers).`);
console.log(`  ${CLAIMED_RECORDED.length} paid vendor host(s) claimed as recorded, and each one really is.`);
if (RESERVED.length) {
  console.log(`  ${RESERVED.length} paid host(s) reserved — known to cost money, nothing calls them, and the build fails if anything starts:`);
  for (const [host] of RESERVED) console.log(`      ${host}`);
}
