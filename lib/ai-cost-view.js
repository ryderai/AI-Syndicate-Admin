/* THE AI COST PAGE'S MATHS — 24 Sep 2026.
 *
 * Ryder: "for ai cost we need to make sure all usage gets a tag. so if a
 * account uses a credit it needs to be added as usage under that account. the
 * jobs i care less about but i do really want that to track as well. and also
 * we need the month by month and custom timeframes as well. make it all
 * simpler and make the important stuff stand out."
 *
 * Input: the grouped rows from api/ai-cost.js (already one row per day ×
 * account × job × model). Output: four tables and the headline numbers.
 * Pure — no clock, no network — so tests/money can check it.
 *
 * THE TAG EVERY ROW GETS
 *   account   a platform workspace (by name), else one of our clients, else
 *             "AI Syndicate console" for calls the console made, else
 *             "No account — public tools & our own jobs" for everything the
 *             platform ran that belongs to nobody (the free scan, lead
 *             capture, crons). That last one is a real answer, not a gap.
 *   job       the job name the call carried. A row with none is one written
 *             before the platform began naming every call (23 Sep 2026) —
 *             counted and shown as exactly that.
 */

import { daysIn, monthsIn, bucketFor } from "./money-range.js";
import { outcomeOf, OUTCOME_ORDER } from "./ai-job-names.js";

export const NO_ACCOUNT = "__none__";
export const CONSOLE = "__console__";

export function accountKey(row) {
  if (row.workspace_id) return `ws:${row.workspace_id}`;
  if (row.client_id) return `client:${row.client_id}`;
  if (row.source === "admin") return CONSOLE;
  return NO_ACCOUNT;
}

export function accountInfo(key, { workspaces = {}, clients = {} } = {}) {
  if (key === NO_ACCOUNT) return { name: "No account — public tools & our own jobs", kind: "none" };
  if (key === CONSOLE) return { name: "AI Syndicate console", kind: "console" };
  if (key.startsWith("client:")) {
    const id = key.slice(7);
    return { name: clients[id] || "A client (name not found)", kind: "client", clientId: id };
  }
  const id = key.slice(3);
  const w = workspaces[id] || {};
  const name = w.name || w.domain || (w.ownerEmail ? w.ownerEmail : `Workspace ${id.slice(0, 8)}`);
  return {
    name,
    kind: "workspace",
    workspaceId: id,
    domain: w.domain || null,
    email: w.ownerEmail || null,
    clientName: w.clientId ? (clients[w.clientId] || null) : null,
    stripeCustomerId: w.stripeCustomerId || null,
    plan: w.plan || null,
    subscriptionStatus: w.subscriptionStatus || null,
  };
}

/* Job names like "brand.scan" or "/api/lead/" read fine to us; a couple of
 * words make the rest readable. */
export function jobLabel(job) {
  if (!job) return "Not named (before 23 Sep)";
  if (job.startsWith("/api/cron/")) return `Scheduled: ${job.slice(10).replace(/\/$/, "")}`;
  if (job.startsWith("/api/")) return `Endpoint: ${job.slice(5).replace(/\/$/, "")}`;
  return job;
}

/* TOKENS, NOT DOLLARS — Ryder, 24 Sep 2026: "for ai cost can we make it all
 * based off of token usage. no need for ai cost yet in dollars."
 *
 *   tokensIn   what we sent: input + cache WRITES (a cache write is new input
 *              the model read in full, just stored for later)
 *   tokensOut  what the model wrote back
 *   tokens     tokensIn + tokensOut — the headline figure
 *   cacheRead  input served from a cache. Counted on its own, never added to
 *              the headline: it is re-reading, not new work, and adding it
 *              would make a heavily cached job look ten times bigger.
 * Calls to services that do not use tokens (search APIs, image tools) add 0
 * tokens and are counted as calls. Dollar fields are still carried so a later
 * build can switch money back on without changing the reads. */
function blank() {
  return {
    calls: 0, tokensIn: 0, tokensOut: 0, tokens: 0, cacheRead: 0, tokenlessCalls: 0, pricedCalls: 0, costMicros: 0, failed: 0, days: {},
    /* 25 Sep 2026 (migration 0043): how each request went, how long we
     * waited, and the extras Andrew's meter records. */
    okCalls: 0, outcomes: {}, reasons: {}, waitMs: 0, reasoning: 0, webSearches: 0, cutOffCalls: 0, cutOffTokens: 0,
  };
}
export function tokensOf(r) {
  const tin = (r.input_tokens || 0) + (r.cache_write_tokens || 0);
  const tout = r.output_tokens || 0;
  return { tin, tout, total: tin + tout, cache: r.cache_read_tokens || 0 };
}
function add(t, r) {
  const k = tokensOf(r);
  t.calls += r.calls || 0;
  t.tokensIn += k.tin;
  t.tokensOut += k.tout;
  t.tokens += k.total;
  t.cacheRead += k.cache;
  if (k.total === 0 && k.cache === 0) t.tokenlessCalls += r.calls || 0;
  t.pricedCalls += r.priced_calls || 0;
  t.costMicros += r.cost_micros || 0;
  const bad = Boolean(r.status && r.status !== "ok" && r.status !== "legacy");
  if (bad) t.failed += r.calls || 0;
  else t.okCalls += r.calls || 0;
  const reason = bad ? (r.reason && r.reason !== "ok" ? r.reason : "unknown") : "ok";
  const oc = outcomeOf(reason);
  t.outcomes[oc] = (t.outcomes[oc] || 0) + (r.calls || 0);
  if (bad) t.reasons[reason] = (t.reasons[reason] || 0) + (r.calls || 0);
  t.waitMs += r.wait_ms || 0;
  t.reasoning += r.reasoning_tokens || 0;
  t.webSearches += r.web_searches || 0;
  t.cutOffCalls += r.cut_off_calls || 0;
  t.cutOffTokens += r.cut_off_tokens || 0;
  if (r.day) {
    const d = t.days[r.day] || (t.days[r.day] = { calls: 0, tokens: 0, failed: 0 });
    d.calls += r.calls || 0;
    d.tokens += k.total;
    if (r.status && r.status !== "ok" && r.status !== "legacy") d.failed += r.calls || 0;
  }
}

/* WHAT HAPPENED, IN ONE PARAGRAPH — 25 Sep 2026. Ryder saw one rep using
 * 43% of all AI and wanted to "show what its being spent on clearly and so we
 * all can see and understand it". For each account: the job that took most of
 * its tokens, the days it ran, the busiest day, and how many calls failed. */
export function explain(t) {
  const days = Object.keys(t.days || {}).sort();
  const busiest = days.slice().sort((a, b) => t.days[b].tokens - t.days[a].tokens || t.days[b].calls - t.days[a].calls)[0] || null;
  const top = (t.jobs || [])[0] || null;
  return {
    days,
    firstDay: days[0] || null,
    lastDay: days[days.length - 1] || null,
    busiestDay: busiest,
    busiestDayTokens: busiest ? t.days[busiest].tokens : 0,
    busiestDayCalls: busiest ? t.days[busiest].calls : 0,
    topJob: top ? top.job : null,
    topJobTokens: top ? top.tokens : 0,
    topJobCalls: top ? top.calls : 0,
    topJobFailed: top ? top.failed : 0,
    topJobShare: top && t.tokens > 0 ? top.tokens / t.tokens : null,
    failedShare: t.calls > 0 ? t.failed / t.calls : 0,
  };
}
const byTokens = (x, y) => y.tokens - x.tokens || y.calls - x.calls;

/* Share that worked, tokens per working request, seconds waited per request,
 * and the biggest reason it didn't work. Added to every table row. */
export function detailOf(t) {
  const top = Object.entries(t.reasons || {}).sort((a, b) => b[1] - a[1])[0] || null;
  return {
    workedShare: t.calls > 0 ? t.okCalls / t.calls : null,
    tokensPerRequest: t.okCalls > 0 && t.tokens > 0 ? t.tokens / t.okCalls : null,
    avgWaitSec: t.calls > 0 && t.waitMs > 0 ? t.waitMs / t.calls / 1000 : null,
    topReason: top ? top[0] : null,
    topReasonCalls: top ? top[1] : 0,
  };
}

function outcomeList(t) {
  return OUTCOME_ORDER.filter((k) => t.outcomes[k]).map((k) => ({ key: k, calls: t.outcomes[k], share: t.calls ? t.outcomes[k] / t.calls : 0 }));
}

/* A problem is "still happening" if it was seen in the last 24 hours before
 * `now` (the page passes the read time). Without a clock, never. */
function problemList(problems, liveSince) {
  return [...problems.values()].map((p) => ({
    ...p,
    days: [...p.days].sort(),
    jobs: [...p.jobs.entries()].map(([job, calls]) => ({ job: job || null, calls })).sort((a, b) => b.calls - a.calls),
    accountCount: p.accounts.size,
    accounts: [...p.accounts],
    models: [...p.models],
    live: Boolean(liveSince && p.lastTs !== null && p.lastTs >= liveSince),
  })).sort((a, b) => (b.live - a.live) || b.calls - a.calls);
}

export function aiCostView(data, range, { bucket: forced = null, now = null } = {}) {
  const liveSince = now ? now - 24 * 3600 * 1000 : null;
  const rows = (data?.rows || []).filter((r) => r.day >= range.from && r.day <= range.to);
  const names = { workspaces: data?.workspaces || {}, clients: data?.clients || {} };
  const total = blank();
  const accounts = new Map();
  const jobs = new Map();
  const services = new Map();
  const bucket = forced || bucketFor(range);
  const keys = bucket === "day" ? daysIn(range) : monthsIn(range);
  const byBucket = Object.fromEntries(keys.map((k) => [k, { key: k, tagged: 0, none: 0, calls: 0 }]));
  const taggingSince = data?.taggingSince || "2026-09-23";
  const unnamed = { before: blank(), after: blank() };
  /* WHAT WENT WRONG — one line per AI company × reason, with first and last
   * time seen, the jobs and accounts it hit, and whether it is still going. */
  const problems = new Map();

  for (const r of rows) {
    add(total, r);
    const ak = accountKey(r);
    let a = accounts.get(ak);
    if (!a) { a = { key: ak, ...blank(), jobs: new Map(), services: new Map(), credits: 0, creditSpends: 0 }; accounts.set(ak, a); }
    add(a, r);
    const jk = r.job || "";
    const aj = a.jobs.get(jk) || { job: r.job, ...blank() };
    add(aj, r); a.jobs.set(jk, aj);
    const sk = `${r.provider || "?"}|${r.model || ""}`;
    const as = a.services.get(sk) || { provider: r.provider, model: r.model, ...blank() };
    add(as, r); a.services.set(sk, as);

    const j = jobs.get(jk) || { job: r.job, ...blank(), accounts: new Set() };
    add(j, r); j.accounts.add(ak); jobs.set(jk, j);

    const s = services.get(sk) || { provider: r.provider, model: r.model, ...blank() };
    add(s, r); services.set(sk, s);

    const b = byBucket[bucket === "day" ? r.day : r.day.slice(0, 7)];
    if (b) {
      const tk = tokensOf(r).total;
      if (ak === NO_ACCOUNT || ak === CONSOLE) b.none += tk;
      else b.tagged += tk;
      b.calls += r.calls || 0;
    }
    if (!r.job) add(r.day < taggingSince ? unnamed.before : unnamed.after, r);

    if (r.status && r.status !== "ok" && r.status !== "legacy") {
      const reason = r.reason && r.reason !== "ok" ? r.reason : "unknown";
      const pk = `${r.provider || "?"}|${reason}`;
      let p = problems.get(pk);
      if (!p) { p = { key: pk, provider: r.provider, reason, outcome: outcomeOf(reason), calls: 0, firstTs: null, lastTs: null, days: new Set(), jobs: new Map(), accounts: new Set(), models: new Set() }; problems.set(pk, p); }
      p.calls += r.calls || 0;
      const f = Date.parse(r.first_ts || `${r.day}T12:00:00Z`), l = Date.parse(r.last_ts || `${r.day}T12:00:00Z`);
      if (Number.isFinite(f) && (p.firstTs === null || f < p.firstTs)) p.firstTs = f;
      if (Number.isFinite(l) && (p.lastTs === null || l > p.lastTs)) p.lastTs = l;
      p.days.add(r.day);
      p.jobs.set(r.job || "", (p.jobs.get(r.job || "") || 0) + (r.calls || 0));
      p.accounts.add(ak);
      if (r.model) p.models.add(r.model);
    }
  }

  /* Credits: plan-token use per workspace in the same window. A workspace
   * that used credits but made no metered call still gets a row — credits
   * spent are usage under that account whether or not a call was metered. */
  let creditsTotal = 0;
  for (const c of data?.credits || []) {
    if (!c.workspace_id) continue;
    const ak = `ws:${c.workspace_id}`;
    let a = accounts.get(ak);
    if (!a) { a = { key: ak, ...blank(), jobs: new Map(), services: new Map(), credits: 0, creditSpends: 0 }; accounts.set(ak, a); }
    a.credits += (c.spent || 0) - (c.refunded || 0);
    a.creditSpends += c.spends || 0;
    creditsTotal += (c.spent || 0) - (c.refunded || 0);
  }

  const accountRows = [...accounts.values()].map((a) => {
    const row = {
      ...a,
      info: accountInfo(a.key, names),
      jobs: [...a.jobs.values()].sort(byTokens),
      services: [...a.services.values()].sort(byTokens),
    };
    row.story = explain(row);
    row.share = total.tokens > 0 ? row.tokens / total.tokens : null;
    row.detail = detailOf(row);
    row.outcomeList = outcomeList(row);
    row.jobs = row.jobs.map((j) => ({ ...j, detail: detailOf(j) }));
    row.services = row.services.map((x) => ({ ...x, detail: detailOf(x) }));
    return row;
  }).sort((x, y) => y.tokens - x.tokens || y.credits - x.credits || y.calls - x.calls);

  /* Anyone using a lot more than everyone else: at least 30% of all tokens,
   * and at least twice the next account. Named at the top of the page. */
  const named = accountRows.filter((a) => a.info.kind === "workspace" || a.info.kind === "client");
  const outliers = named.filter((a) => {
    const nextBiggest = Math.max(0, ...named.filter((b) => b !== a).map((b) => b.tokens));
    return a.share !== null && a.share >= 0.3 && a.tokens >= 2 * nextBiggest;
  });

  const accountTokens = accountRows.filter((a) => a.info.kind === "workspace" || a.info.kind === "client")
    .reduce((s, a) => s + a.tokens, 0);

  return {
    range, bucket,
    total,
    accountShare: total.tokens > 0 ? accountTokens / total.tokens : null,
    accountTokens,
    accounts: accountRows,
    jobs: [...jobs.values()].map((j) => ({ ...j, accountCount: j.accounts.size, detail: detailOf(j) })).sort(byTokens),
    services: [...services.values()].map((x) => ({ ...x, detail: detailOf(x) })).sort(byTokens),
    detail: detailOf(total),
    outcomeList: outcomeList(total),
    problems: problemList(problems, liveSince),
    series: keys.map((k) => byBucket[k]),
    unnamed,
    creditsTotal,
    workspaceCount: accountRows.filter((a) => a.info.kind === "workspace").length,
    outliers,
  };
}
