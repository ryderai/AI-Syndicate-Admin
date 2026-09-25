/* ONE ACCOUNT, LOOKED AT CLOSELY — the maths. 25 Sep 2026.
 *
 * Ryder: "so does this show more in depth why troy specifically spent more
 * tokens?" → "go ahead and build that layer."
 *
 * Input: api/ai-account.js (migration 0044) — AI requests per Chicago hour ×
 * job, the websites the account audited, credits by feature. Output: work
 * sessions, a websites summary, sent vs written, and credits by how they
 * started. Pure — no clock, no network — so tests/money can check it.
 *
 * A WORK SESSION is a stretch of activity with no more than one quiet hour
 * inside it. Two busy hours with one empty hour between them are one session;
 * two empty hours start a new one.
 */

/* "2026-09-22T22" → an hour number. The hours are Chicago wall-clock hours;
 * reading them as UTC only keeps the arithmetic simple (a DST night shifts one
 * gap by an hour, nothing else). */
export function hourNum(h) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(String(h));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) / 3_600_000;
}
export function hourText(n) {
  const d = new Date(n * 3_600_000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}`;
}

const MAX_GAP = 2; // next busy hour at most 2 after the last = at most 1 quiet hour between

export function sessionsOf(hours) {
  const byHour = new Map();
  for (const h of hours || []) {
    const n = hourNum(h.hour);
    if (n === null || !h.calls) continue;
    let b = byHour.get(n);
    if (!b) { b = { n, calls: 0, ok: 0, failed: 0, sent: 0, written: 0, jobs: new Map() }; byHour.set(n, b); }
    b.calls += h.calls; b.ok += h.ok; b.failed += h.failed; b.sent += h.sent; b.written += h.written;
    const j = b.jobs.get(h.job ?? "") || { calls: 0, tokens: 0, failed: 0 };
    j.calls += h.calls; j.tokens += h.sent + h.written; j.failed += h.failed;
    b.jobs.set(h.job ?? "", j);
  }
  const list = [...byHour.values()].sort((a, b) => a.n - b.n);
  const out = [];
  let cur = null;
  for (const b of list) {
    if (!cur || b.n - cur.lastN > MAX_GAP) {
      cur = { startN: b.n, lastN: b.n, busyHours: 0, calls: 0, ok: 0, failed: 0, sent: 0, written: 0, jobs: new Map(), peakN: b.n, peakCalls: 0 };
      out.push(cur);
    }
    cur.lastN = b.n;
    cur.busyHours += 1;
    cur.calls += b.calls; cur.ok += b.ok; cur.failed += b.failed; cur.sent += b.sent; cur.written += b.written;
    if (b.calls > cur.peakCalls) { cur.peakCalls = b.calls; cur.peakN = b.n; }
    for (const [k, j] of b.jobs) {
      const t = cur.jobs.get(k) || { calls: 0, tokens: 0, failed: 0 };
      t.calls += j.calls; t.tokens += j.tokens; t.failed += j.failed;
      cur.jobs.set(k, t);
    }
  }
  return out.map((s) => {
    const jobs = [...s.jobs.entries()].map(([job, j]) => ({ job: job || null, ...j }))
      .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
    const tokens = s.sent + s.written;
    return {
      start: hourText(s.startN),
      end: hourText(s.lastN + 1), // the session runs to the end of its last hour
      hours: s.lastN + 1 - s.startN,
      busyHours: s.busyHours,
      calls: s.calls, ok: s.ok, failed: s.failed, sent: s.sent, written: s.written, tokens,
      peakHour: hourText(s.peakN), peakCalls: s.peakCalls,
      jobs,
      mainJob: jobs[0]?.job ?? null,
      mainJobShare: jobs[0] && tokens > 0 ? jobs[0].tokens / tokens : (jobs[0] && s.calls ? jobs[0].calls / s.calls : null),
    };
  }).sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
}

export function accountDetailView(detail) {
  const hours = detail?.hours || [];
  const sessions = sessionsOf(hours);
  const total = hours.reduce((t, h) => {
    t.calls += h.calls; t.ok += h.ok; t.failed += h.failed; t.sent += h.sent; t.written += h.written;
    return t;
  }, { calls: 0, ok: 0, failed: 0, sent: 0, written: 0 });
  total.tokens = total.sent + total.written;

  /* Sent vs written, per job. */
  const jobs = new Map();
  for (const h of hours) {
    const j = jobs.get(h.job ?? "") || { job: h.job ?? null, calls: 0, sent: 0, written: 0 };
    j.calls += h.calls; j.sent += h.sent; j.written += h.written;
    jobs.set(h.job ?? "", j);
  }
  const sentWritten = [...jobs.values()].map((j) => ({ ...j, tokens: j.sent + j.written }))
    .sort((a, b) => b.tokens - a.tokens);

  const sites = detail?.sites || [];
  const siteTotals = {
    sites: sites.length,
    audits: sites.reduce((s, x) => s + x.audits, 0),
    fixedPages: sites.reduce((s, x) => s + x.fixedPages, 0),
    sitesWithFixes: sites.filter((x) => x.fixedPages > 0).length,
  };

  const credits = detail?.credits || [];
  const creditsBy = { manual: 0, scheduled: 0, other: 0 };
  for (const c of credits) {
    if (c.source === "manual") creditsBy.manual += c.units;
    else if (c.source === "cron") creditsBy.scheduled += c.units;
    else creditsBy.other += c.units;
  }

  const biggest = sessions[0] || null;
  return {
    total,
    sessions,
    biggest,
    biggestShare: biggest && total.tokens > 0 ? biggest.tokens / total.tokens : (biggest && total.calls ? biggest.calls / total.calls : null),
    sentWritten,
    sites,
    siteTotals,
    credits,
    creditsBy,
  };
}
