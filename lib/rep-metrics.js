/* WHICH NUMBER THE STATS CHART IS DRAWING, AND WHAT "BEST" MEANS FOR IT.
 *
 * Ryder, 30 Aug 2026: "i want it to be more like bar graphs for each rep with
 * filters at the top to click to show different stats to see who performed the
 * best."
 *
 * This file is the list of those filters and the ranking behind them. It is
 * pure — no React, no reads, no clock of its own — so tests/rep-metrics can
 * attack it directly, which is the only reason a page that crowns a winner is
 * safe to put in front of two owners.
 *
 * THREE RULES IT EXISTS TO ENFORCE.
 *
 * 1. NOT ONE NUMBER IS COMPUTED HERE. Every `read` below pulls a field that
 *    `repStats` (lib/sales-rules.js) or `outreachFor` (lib/outreach.js) already
 *    produced. Those are the same functions a rep's own Work page and rep brief
 *    call, on the same snapshot. So the owner's chart and the rep's own screen
 *    cannot drift: there is one set of maths and both ends read it.
 *
 * 2. LOWER IS BETTER FOR SOME OF THEM. Speed to first touch, At risk and Lost
 *    are metrics where the smallest bar is the best performance. A chart that
 *    sorts every metric biggest-first would put the slowest rep at the top and
 *    call it a leaderboard. `better` carries the direction and the sort follows
 *    it.
 *
 * 3. A RAW COUNT WITH NO DENOMINATOR IS NOT A PERFORMANCE. "Lost 0" and
 *    "At risk 0" are what a rep who has claimed nothing looks like, so crowning
 *    the smallest one puts a BEST chip on the person who did the least work.
 *    "Open right now" has the mirror problem: crowning the biggest one rewards
 *    hoarding leads and never working them. Those three still get a bar and a
 *    number — they are worth looking at — but `crown: false` stops the page
 *    naming a winner on them, and each prints the book it came out of beside it.
 *    Close rate is the ranked version of the same question, and it has a
 *    denominator.
 *
 * 4. NULL IS NOT ZERO. A rep who sent no emails has `emailed: 0`. A rep whose
 *    email data could not be read has `emailed: null`. Ranking those together
 *    puts a failed read at the bottom of a leaderboard as though it were
 *    measured performance. Unmeasured rows are held out of the ranking, are
 *    never crowned, and are counted separately so the page can say how many.
 */

/** Periods, so a heading can never leave off which one it means. */
export const PERIOD_ALL = "all";      /* everything loaded, no window */
export const PERIOD_WINDOW = "window"; /* the outreach window, OUTREACH_WINDOW_DAYS */
export const PERIOD_NOW = "now";       /* this moment */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The metrics, in the order the chips appear.
 *
 * `group` only groups the chips visually. `better` decides the sort AND who is
 * crowned. `sub` is the counts UNDER a rate — a rate with no denominator beside
 * it is how one reply out of one email becomes "100%, best on the team".
 */
export const REP_METRICS = [
  {
    key: "won", label: "Deals won", group: "Results",
    period: PERIOD_ALL, better: "high", unit: "count",
    what: "Leads they own that reached Won, over every contact loaded.",
    read: ({ s }) => num(s?.won),
    sub: null,
  },
  {
    key: "meetings", label: "Conversations reached", group: "Results",
    period: PERIOD_ALL, better: "high", unit: "count",
    what: "Their leads that got as far as Meeting, Proposal or Won.",
    read: ({ s }) => num(s?.meetings),
    sub: null,
  },
  {
    key: "close_rate", label: "Close rate", group: "Results",
    period: PERIOD_ALL, better: "high", unit: "percent",
    what: "Won as a share of the leads they closed either way. Leads still open are not counted as losses.",
    read: ({ s }) => num(s?.close_rate),
    sub: ({ s }) => (num(s?.decided) ? `${s.won} won of ${s.decided} decided` : null),
    rate: true,
  },
  {
    key: "proposals", label: "Proposals out", group: "Results",
    period: PERIOD_NOW, better: "high", unit: "count",
    what: "Proposals sent and not yet decided, right now.",
    read: ({ o }) => num(o?.proposalsOut),
    sub: null,
  },

  {
    key: "claimed", label: "Leads claimed", group: "Effort",
    period: PERIOD_ALL, better: "high", unit: "count",
    what: "Contacts with their name on them, over every contact loaded.",
    read: ({ s }) => num(s?.claimed),
    sub: null,
  },
  {
    key: "open", label: "Open right now", group: "Effort",
    period: PERIOD_NOW, better: "high", unit: "count",
    what: "Leads they hold that are still live. This is a workload, not a score — nobody is marked best on it.",
    read: ({ s }) => num(s?.open),
    sub: ({ s }) => (num(s?.claimed) === null ? null : `of ${s.claimed} they have claimed`),
    crown: false,
  },
  {
    key: "emailed", label: "People emailed", group: "Effort",
    period: PERIOD_WINDOW, better: "high", unit: "count",
    what: "People they emailed inside the window. People, not emails.",
    read: ({ o }) => num(o?.emailed),
    sub: null,
  },
  {
    key: "replied", label: "Replies", group: "Effort",
    period: PERIOD_WINDOW, better: "high", unit: "count",
    what: "Of the people they emailed inside the window, how many wrote back.",
    read: ({ o }) => num(o?.replied),
    sub: null,
  },
  {
    key: "reply_rate", label: "Reply rate", group: "Effort",
    period: PERIOD_WINDOW, better: "high", unit: "percent",
    what: "Replies divided by the people emailed, with dead addresses taken out of the bottom half.",
    read: ({ o }) => num(o?.replyRate),
    sub: ({ o }) => (num(o?.replyBase) === null ? null
      : `${o.replied} of ${o.replyBase} who could answer`),
    rate: true,
  },
  {
    key: "calls", label: "Calls logged", group: "Effort",
    period: PERIOD_WINDOW, better: "high", unit: "count",
    what: "Calls they logged inside the window. A call nobody logged is not counted.",
    read: ({ o }) => num(o?.logged?.call),
    sub: null,
  },

  {
    key: "speed", label: "Speed to first touch", group: "Watch",
    period: PERIOD_ALL, better: "low", unit: "days",
    what: "Business days from claiming a lead to the first touch they logged on it. Fewer days is better.",
    read: ({ s }) => num(s?.speed_days),
    sub: ({ s }) => (num(s?.speed_sample) ? `over ${s.speed_sample} claim${s.speed_sample === 1 ? "" : "s"}` : null),
    rate: true,
  },
  {
    key: "at_risk", label: "At risk", group: "Watch",
    period: PERIOD_NOW, better: "low", unit: "count",
    what: "Claims they hold that have run out or gone quiet, right now. Fewer is better — but a rep holding nothing also has none, so nobody is marked best on it.",
    read: ({ s }) => num(s?.at_risk),
    sub: ({ s }) => (num(s?.open) === null ? null : `of ${s.open} they are holding`),
    crown: false,
  },
  {
    key: "lost", label: "Lost", group: "Watch",
    period: PERIOD_ALL, better: "low", unit: "count",
    what: "Their leads that closed the other way. Fewer is better — but a rep who claimed nothing also lost nothing, so nobody is marked best on it. Close rate is the ranked version of this question.",
    read: ({ s }) => num(s?.lost),
    sub: ({ s }) => (num(s?.claimed) === null ? null : `of ${s.claimed} they have claimed`),
    crown: false,
  },
];

export const REP_METRIC_KEYS = REP_METRICS.map((m) => m.key);
export const DEFAULT_REP_METRIC = "won";

/** The chip groups, in order, without repeating them by hand. */
export const REP_METRIC_GROUPS = REP_METRICS.reduce((acc, m) => {
  const row = acc.find((g) => g.group === m.group);
  if (row) row.metrics.push(m);
  else acc.push({ group: m.group, metrics: [m] });
  return acc;
}, []);

export function metricFor(key) {
  return REP_METRICS.find((m) => m.key === key) || null;
}

/** How a value prints. Never a bare number where the unit changes the meaning. */
export function formatMetric(value, unit) {
  if (value === null || value === undefined) return null;
  if (unit === "percent") return `${value}%`;
  if (unit === "days") return `${value}d`;
  return String(value);
}

/**
 * Rank the reps on one metric and say what may be drawn.
 *
 * `rows` is `[{ rep, s, o }]` — exactly what the Stats page already builds.
 *
 * WHAT COMES BACK, AND WHY EACH PIECE EXISTS:
 *   bars            every rep, measured ones first, in ranked order
 *   max             the biggest measured value, which the bars are scaled to
 *   bestValue       the winning value, or null when nobody can be crowned
 *   measured        how many reps this metric could actually be read for
 *   unmeasured      how many it could not
 *   crowned         whether a "best" was awarded at all
 *
 * NOBODY IS CROWNED unless at least two reps were measured, because "best of
 * one" is not a comparison — and, for a high-is-better metric, unless the
 * winning value is above zero, because a team where everybody won nothing has
 * no top performer. Ties all carry the mark; a leaderboard that silently picks
 * one of two equal reps is inventing a result.
 */
export function rankReps(rows, metricKey) {
  const metric = metricFor(metricKey) || metricFor(DEFAULT_REP_METRIC);
  const list = Array.isArray(rows) ? rows : [];

  const bars = list.map((row) => {
    const value = metric.read(row);
    return {
      id: row?.rep?.user_id ?? null,
      rep: row?.rep ?? null,
      value,
      display: formatMetric(value, metric.unit),
      sub: value === null ? null : (metric.sub ? metric.sub(row) : null),
      measured: value !== null,
      best: false,
    };
  });

  const name = (b) => String(b.rep?.full_name || b.rep?.email || "").toLowerCase();
  const measured = bars.filter((b) => b.measured);
  const unmeasured = bars.filter((b) => !b.measured);

  measured.sort((a, b) => (metric.better === "low" ? a.value - b.value : b.value - a.value)
    || name(a).localeCompare(name(b)));
  unmeasured.sort((a, b) => name(a).localeCompare(name(b)));

  const values = measured.map((b) => b.value);
  const max = values.length ? Math.max(...values) : 0;

  /* `crown: false` means this metric is worth drawing and NOT worth winning.
   * See rule 3 at the top: on a raw count with no denominator, the rep who did
   * the least work has the best-looking number. */
  let bestValue = null;
  if (metric.crown !== false && measured.length >= 2) {
    const candidate = metric.better === "low" ? Math.min(...values) : max;
    /* A high-is-better metric where the winner scored zero has no winner. A
     * low-is-better metric where the winner scored zero has the best possible
     * result, so that one stands. */
    if (metric.better === "low" || candidate > 0) bestValue = candidate;
  }
  if (bestValue !== null) {
    for (const b of measured) if (b.value === bestValue) b.best = true;
  }

  return {
    metric,
    bars: [...measured, ...unmeasured],
    max,
    bestValue,
    crowned: bestValue !== null,
    /* WHY there is no winner, so the page can print the right sentence rather
     * than guessing between "no winner" and "this metric has no winners". */
    crownable: metric.crown !== false,
    measured: measured.length,
    unmeasured: unmeasured.length,
  };
}

/** Bar length as a percentage of the longest bar. Guards the 0/0 case, which
 * is the ordinary one on a metric nobody has scored yet. */
export function barPct(value, max) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}
