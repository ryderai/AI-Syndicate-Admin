import { useCallback, useEffect, useMemo, useState } from "react";
import { useScreenContext } from "../../lib/screenContext.js";
import { isConfigured } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import {
  listUsage, listClients, listTeam, listModelPrices, listProviderBills, listUsageMisses,
} from "../../lib/data.js";
import { SourceBadge, SectionHeader, FilterTabs, EmptyState, timeAgo } from "./shared.jsx";
import { Figure, FigureGrid, Block, BasisBadge, pct } from "./financeParts.jsx";
import {
  GROUPINGS, summarize, rollup, formatMicros, formatTokens, changeAgainst,
  eventMonth, partMonthNote, previousMonth, drift, pricedCost,
  INTERNAL, MICROS_PER_DOLLAR, num,
} from "../../../lib/ai-cost.js";
import { TEAM_TZ, teamDate } from "../../../lib/brain-context.js";

/* ==================================================================
 * AI COST — what every AI call cost, and who it was for. Aug 28 2026.
 *
 * Before this page the console guessed: one price, Claude Sonnet's, was
 * hardcoded in seven separate files and applied to whatever model actually
 * ran; cached tokens were never counted; failed calls were never logged; and
 * the client was stored as a NAME, so a rename split a client's history in
 * two. All of that is fixed underneath — see lib/ai-cost.js and
 * lib/ai-usage.js — and this is the page that reads it.
 *
 * THE RULE, the same one the Finance page runs on: every figure says where it
 * came from, and a figure we cannot work out honestly prints as a gap with the
 * reason beside it. Never a zero.
 *
 *   METERED    we counted it at the moment of the call
 *   BILLED     the provider's own figure
 *   NOT PRICED tokens known, price unknown
 *   DRIFT      the gap between the first two
 *
 * WHAT IS DELIBERATELY MISSING: the BILLED column, almost always. Pulling a
 * provider's real bill needs an Admin key — a different, higher-level key that
 * only an org owner can create — and none exists yet. Rather than quietly
 * dropping the comparison, the page says so where the comparison would be. A
 * green tick we have not earned is worse than an empty space that explains
 * itself.
 * ================================================================== */

const WINDOWS = [
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
  { id: "365", label: "Last 12 months", days: 365 },
];

/* FilterTabs prepends its own "all" tab, so the first grouping is passed as
 * that one and only the REST go in the list. Passing all six drew "By client"
 * twice — caught on the first screenshot of the built page, not by a test,
 * which is the usual way this kind of thing gets caught. */
const FIRST_TAB = "client";
const TABS = ["person", "feature", "surface", "model", "day"];

const SORTS = [
  { id: "cost", label: "Cost", get: (r) => r.costMicros },
  { id: "calls", label: "Calls", get: (r) => r.calls },
  { id: "tokens", label: "Tokens", get: (r) => r.totalTokens },
  { id: "failed", label: "Failed", get: (r) => r.failed },
];

function ms(n) { return n == null ? "—" : `${Math.round(n).toLocaleString("en-US")} ms`; }

/* A change against the window before this one. Null prints nothing at all,
 * because "no previous window" and "no change" are different facts. */
function Change({ value }) {
  if (value === null || value === undefined) return null;
  const up = value > 0;
  const flat = Math.abs(value) < 0.005;
  if (flat) return <span className="adm-aic-flat">no change</span>;
  return (
    <span className={up ? "adm-aic-up" : "adm-aic-down"}>
      {up ? "▲" : "▼"} {pct(Math.abs(value) * 100, 0)}
    </span>
  );
}

export default function AiCost({ member }) {
  const [windowId, setWindowId] = useState("30");
  const [tab, setTab] = useState("client");
  const [sortId, setSortId] = useState("cost");
  const [openKey, setOpenKey] = useState(null);

  const [usage, setUsage] = useState({ rows: [], sample: false, truncated: false });
  const [prev, setPrev] = useState({ rows: [] });
  const [clients, setClients] = useState({ rows: [] });
  const [team, setTeam] = useState({ rows: [] });
  const [prices, setPrices] = useState({ rows: [] });
  const [bills, setBills] = useState({ rows: [] });
  const [misses, setMisses] = useState({ rows: [] });
  const [loading, setLoading] = useState(true);
  /* WHEN THE DATA WAS READ, not when React happens to re-render.
   *
   * Calling Date.now() inside the useMemo below made "this month" depend on the
   * instant of a render, which React's own lint rule refuses — and rightly: a
   * render at 11:59:59pm on the last of the month and the re-render a second
   * later would put the same rows in two different months. This is stamped once
   * per load, so every figure on the page is answering the same question at the
   * same moment. */
  const [readAt, setReadAt] = useState(() => Date.now());

  const days = WINDOWS.find((w) => w.id === windowId)?.days || 30;

  const load = useCallback(async () => {
    setLoading(true);
    const now = Date.now();
    /* Two windows of the SAME length, back to back, so "against the 30 days
     * before" is a real comparison rather than this month against a part of
     * last one. */
    const [u, p, c, t, pr, b, m] = await Promise.all([
      listUsage(days),
      listUsage(days * 2, { fromMs: now - days * 2 * 86400000, toMs: now - days * 86400000 }),
      listClients(),
      listTeam(),
      listModelPrices(),
      listProviderBills(),
      listUsageMisses(1),
    ]);
    setUsage(u); setPrev(p); setClients(c); setTeam(t); setPrices(pr); setBills(b); setMisses(m);
    setReadAt(now);
    setLoading(false);
    if (u.error) toast.error("Some usage rows could not be read", u.error);
  }, [days]);

  useEffect(() => { load(); }, [load]);

  useScreenContext(() => ({
    page: "ai-cost",
    label: "AI Cost",
    visible: ["AI spend by client, person, feature, page, model and day"],
  }), []);

  /* Names, so an id can be printed as a person. Built once. */
  const maps = useMemo(() => ({
    clients: Object.fromEntries((clients.rows || []).map((c) => [c.id, c.name])),
    people: Object.fromEntries((team.rows || []).map((t) => [t.user_id || t.id, t.full_name || t.email])),
  }), [clients, team]);

  /* Wrapped so its identity is stable between renders — an inline `|| []`
   * builds a new array every time and makes every useMemo below it useless. */
  const rows = useMemo(() => usage.rows || [], [usage]);

  const calc = useMemo(() => {
    const total = summarize(rows);
    const before = summarize(prev.rows || []);

    const thisMonth = teamDate(readAt).slice(0, 7);
    const lastMonth = previousMonth(thisMonth);
    const inMonth = (m) => rows.filter((r) => eventMonth(r) === m);
    const thisMonthTotals = summarize(inMonth(thisMonth));
    const lastMonthTotals = summarize(inMonth(lastMonth));

    /* The bill for the month just finished, if one has ever been filed.
     * Nothing writes to that table yet, so this is almost always null — and the
     * page says so rather than showing a 100% gap. */
    const billRow = (bills.rows || []).find(
      (b) => !b.model && String(b.period_start || "").slice(0, 7) === lastMonth,
    );
    const lastDrift = drift({
      meteredMicros: lastMonthTotals.costMicros,
      billedMicros: billRow ? billRow.billed_cost_micros : null,
    });

    /* WHAT THE CACHE SAVED, and the two ways of knowing it.
     *
     * The logger writes the figure onto each row it could price, so that is
     * used first. Rows written before this build have no such figure, and the
     * first version of this block simply reported those as "nothing saved" —
     * which put "6.10M cached tokens read" on screen directly beside "no call
     * read anything from a cache". Two true numbers that contradict each other
     * are worse than one. Caught on the first screenshot of the built page.
     *
     * So: fall back to working it out from the price book, the same way the
     * logger would have. Rows we STILL cannot price are counted separately and
     * said out loud rather than folded in as zero. */
    let saved = 0;
    let savedRows = 0;
    let savingUnknown = 0;
    for (const r of rows) {
      const cached = num(r.cache_read_tokens);
      if (!cached) continue;
      const recorded = num(r?.meta?.cacheSavingMicros);
      if (recorded) { saved += recorded; savedRows += 1; continue; }
      /* THE ROW'S OWN FROZEN PRICE, found by the id stored on it — never
       * "whatever the price is today". Looking it up by model and date would
       * re-price a nine-month-old call against a book that has since been
       * edited, moving a figure this page's own blurb calls frozen. A row with
       * no price_id cannot be worked out, and says so. */
      const price = (prices.rows || []).find((x) => x.id === r.price_id);
      const inRate = price ? Number(price.input_per_mtok) : null;
      const readRate = price ? Number(price.cache_read_per_mtok) : null;
      if (!Number.isFinite(inRate) || !Number.isFinite(readRate)) { savingUnknown += 1; continue; }
      saved += Math.round((cached * inRate) / 1e6) - Math.round((cached * readRate) / 1e6);
      savedRows += 1;
    }

    /* Calls that threw before the provider reported anything. Their spend is in
     * no total on this page, and that is worth one sentence rather than a
     * silent understatement. */
    const blind = rows.filter((r) => r?.meta?.tokensUnknown).length;

    const grouped = rollup(rows, tab, maps);
    const sorter = SORTS.find((s) => s.id === sortId) || SORTS[0];
    const sorted = grouped.slice().sort((a, b) => {
      const av = sorter.get(a) || 0;
      const bv = sorter.get(b) || 0;
      if (av !== bv) return bv - av;
      return b.calls - a.calls;
    });

    /* Cost per finished deliverable — what one report actually costs us. Only
     * the calls that produced one are counted; a rejected draft is spend, but
     * it is not a report, and dividing by it would make the answer look better
     * than it is. */
    const perReport = ["client_report", "console_report", "rep_report"].map((f) => {
      const okRows = rows.filter((r) => r.feature === f && (r.status === "ok" || r.status === "legacy"));
      const all = rows.filter((r) => r.feature === f);
      const t = summarize(okRows);
      return {
        feature: f,
        made: okRows.length,
        attempts: all.length,
        avg: t.avgCostMicros,
        wasted: summarize(all.filter((r) => r.status !== "ok" && r.status !== "legacy")).costMicros,
      };
    }).filter((r) => r.attempts > 0);

    return {
      total, before, thisMonth, lastMonth, thisMonthTotals, lastMonthTotals,
      billRow, lastDrift, saved, savedRows, savingUnknown, blind, sorted,
      perReport,
      costChange: changeAgainst(total.costMicros, before.costMicros),
      callChange: changeAgainst(total.calls, before.calls),
    };
  }, [rows, prev, tab, sortId, maps, bills, prices, readAt]);

  const partNote = partMonthNote(calc.thisMonth, readAt);
  const mode = usage.sample ? "sample" : (isConfigured() ? "live" : "sample");

  const drillRows = useMemo(() => {
    if (!openKey) return [];
    const g = GROUPINGS[tab] || GROUPINGS.client;
    /* 101 fetched, 100 shown. Fetching one more than you print is how a
     * "there are more" line gets to be true rather than decorative — this file
     * says so twice about other readers and then did not do it here. */
    return rows
      .filter((r) => String(g.keyOf(r)) === openKey)
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
      .slice(0, 101);
  }, [openKey, rows, tab]);

  if (loading) return <div className="adm-aic-loading">Reading the usage log…</div>;

  return (
    <div className="adm-aic">
      <SectionHeader
        kicker="Finance"
        title="AI Cost"
        subtitle="Every call this console makes to an AI, what it cost, who asked for it and which client it was for."
        right={<SourceBadge mode={mode} />}
      />

      {/* ---------- the things that would otherwise be silent ---------- */}
      {usage.truncated && (
        <div className="adm-aic-warn">
          <strong>This window is bigger than the reader will fetch.</strong> {rows.length.toLocaleString("en-US")} events
          were read and there are more, so every total below is a floor, not the whole figure. Pick a shorter window.
        </div>
      )}
      {calc.total.unpricedCalls > 0 && (
        <div className="adm-aic-warn adm-aic-warn-amber">
          <strong>{calc.total.unpricedCalls.toLocaleString("en-US")} calls have no price.</strong>{" "}
          {formatTokens(calc.total.unpricedTokens)} tokens went through a model with no row in the price book, so
          whatever they cost is <em>not</em> in any number on this page. Add the model under the price book at the
          bottom and they price themselves from then on. They are not free, and they are not counted as zero.
        </div>
      )}
      {calc.blind > 0 && (
        <div className="adm-aic-warn adm-aic-warn-amber">
          <strong>{calc.blind} calls failed before the AI reported anything.</strong> The failures are counted;
          any tokens they used are not, because nobody told us how many there were.
        </div>
      )}
      {calc.total.legacyCalls > 0 && (
        <div className="adm-aic-warn adm-aic-warn-amber">
          <strong>{calc.total.legacyCalls.toLocaleString("en-US")} of these calls are old estimates.</strong>{" "}
          They were costed before Aug 28 2026, when one hardcoded price was applied to whatever
          model actually ran. They are kept because they are the history of what we believed, but
          they are guesses sitting inside a measured total. Anything from before that date is
          worth reading as roughly right, not exactly right.
        </div>
      )}
      {calc.total.nonBillable > 0 && (
        <div className="adm-aic-warn adm-aic-warn-amber">
          <strong>{calc.total.nonBillable} calls are marked as not billable</strong> — counted, but
          left out of every money figure on this page.
        </div>
      )}
      {usage.partial && (
        <div className="adm-aic-warn">
          <strong>The database stopped answering part way through.</strong> {rows.length.toLocaleString("en-US")} events
          were read before it did, so every total below is a floor. This is not a window that is
          too big; it is a read that failed.
        </div>
      )}
      {(misses.rows || []).length > 0 && (
        <div className="adm-aic-warn">
          <strong>{misses.rows.length} usage events could not be saved in the last 24 hours.</strong>{" "}
          That is a hole in the books, not a display problem. Most recent: {timeAgo(misses.rows[0].created_at)} —{" "}
          {misses.rows[0].body}
        </div>
      )}

      {/* ---------- the header numbers ---------- */}
      <FigureGrid min={220}>
        <Figure
          label={`This month${partNote ? ` · ${partNote.text}` : ""}`}
          value={pricedCost(calc.thisMonthTotals) === null ? null : formatMicros(pricedCost(calc.thisMonthTotals))}
          basis="metered"
          why={calc.thisMonthTotals.calls
            ? `All ${calc.thisMonthTotals.calls} calls this month ran on a model with no price in the book.`
            : "No AI calls have been logged this month."}
          sub={`${calc.thisMonthTotals.calls.toLocaleString("en-US")} calls`}
          means="The month you are standing in is not finished, so this is a part month against nothing."
        />
        <Figure
          label={`Last month · ${calc.lastMonth}`}
          value={pricedCost(calc.lastMonthTotals) === null ? null : formatMicros(pricedCost(calc.lastMonthTotals))}
          basis="metered"
          sub={`${calc.lastMonthTotals.calls.toLocaleString("en-US")} calls`}
          why={calc.lastMonthTotals.calls
            ? `All ${calc.lastMonthTotals.calls} calls that month ran on a model with no price in the book.`
            : "No calls were logged in that month."}
        />
        <Figure
          label="Checked against the bill"
          value={calc.billRow ? formatMicros(calc.billRow.billed_cost_micros) : null}
          basis="billed"
          sub={calc.lastDrift.ratio !== null
            ? `${pct(Math.abs(calc.lastDrift.ratio) * 100, 1)} apart · ${calc.lastDrift.band}`
            : null}
          why="No bill has been filed for that month. Pulling one needs an Anthropic Admin key, which is a different key from the one that makes the calls and can only be created by an org owner."
        />
        <Figure
          label={`Spend · ${WINDOWS.find((w) => w.id === windowId)?.label.toLowerCase()}`}
          value={pricedCost(calc.total) === null ? null : formatMicros(pricedCost(calc.total))}
          basis="metered"
          why="Nothing in this window could be priced." 
          sub={<>{calc.total.calls.toLocaleString("en-US")} calls (<Change value={calc.callChange} />) · spend <Change value={calc.costChange} /></>}
        />
        <Figure
          label="Average per call"
          value={calc.total.avgCostMicros === null ? null : formatMicros(calc.total.avgCostMicros)}
          basis="metered"
          means="Over the calls we could price. Unpriced calls are left out rather than counted as free."
          why="Nothing in this window could be priced."
        />
        <Figure
          label="Tokens"
          value={formatTokens(calc.total.totalTokens)}
          basis="metered"
          sub={`${formatTokens(calc.total.inputTokens)} in · ${formatTokens(calc.total.outputTokens)} out · ${formatTokens(calc.total.cacheReadTokens)} cached`}
        />
        <Figure
          label="Calls that failed"
          value={calc.total.failed.toLocaleString("en-US")}
          basis="metered"
          tone={calc.total.failed ? "#941f1f" : undefined}
          means="Timed out, rate limited, or thrown away by the honesty gate. We are billed for most of these."
        />
        <Figure
          label="Speed"
          value={calc.total.medianLatencyMs === null ? null : ms(calc.total.medianLatencyMs)}
          basis="metered"
          sub={calc.total.p95LatencyMs === null ? null : `worst 1 in 20: ${ms(calc.total.p95LatencyMs)}`}
          why="No call recorded how long it took."
        />
      </FigureGrid>

      {/* ---------- the six groupings ---------- */}
      <Block
        title="Where it goes"
        blurb="The same spend, cut six ways. Click any row to see the individual calls behind it — a figure you cannot open is a figure you have to take on faith."
        right={
          <div className="adm-aic-controls">
            <select value={windowId} onChange={(e) => { setWindowId(e.target.value); setOpenKey(null); }} aria-label="Time window">
              {WINDOWS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
            <select value={sortId} onChange={(e) => setSortId(e.target.value)} aria-label="Sort by">
              {SORTS.map((s) => <option key={s.id} value={s.id}>Sort by {s.label.toLowerCase()}</option>)}
            </select>
          </div>
        }
      >
        <FilterTabs
          tabs={TABS.map((t) => ({ id: t, label: GROUPINGS[t].label }))}
          value={tab}
          onChange={(v) => { setTab(v); setOpenKey(null); }}
          ariaLabel="Group the spend by"
          allId={FIRST_TAB}
          allLabel={GROUPINGS[FIRST_TAB].label}
        />

        {!calc.sorted.length ? (
          <EmptyState
            title="No AI calls in this window"
            body="Nothing has been logged yet. Every report, draft and assistant answer writes a row here as it happens."
          />
        ) : (
          <div className="adm-aic-tablewrap">
            <table className="adm-aic-table">
              <thead>
                <tr>
                  <th>{GROUPINGS[tab].label.replace("By ", "")}</th>
                  <th className="n">Calls</th>
                  <th className="n">Failed</th>
                  <th className="n">In</th>
                  <th className="n">Out</th>
                  <th className="n">Cached</th>
                  <th className="n">Cost</th>
                  <th className="n">Share</th>
                </tr>
              </thead>
              <tbody>
                {calc.sorted.map((r) => {
                  const allUnpriced = r.calls > 0 && r.calls === r.unpricedCalls;
                  return (
                    <tr
                      key={r.key}
                      className={openKey === r.key ? "open" : ""}
                    >
                      {/* THE BUTTON GOES IN THE CELL, NOT ON THE ROW.
                        * role="button" on a <tr> overrides its implicit `row`
                        * role and breaks the table's required parent/child
                        * structure, so a screen reader stops announcing it as a
                        * table at all — and the aria-expanded pointed at a
                        * panel that is a sibling of the <table>, not a child of
                        * the row. A real <button> in the first cell is
                        * keyboard-operable for free and says what it controls. */}
                      <td className="adm-aic-name">
                        <button
                          type="button"
                          className="adm-aic-rowbtn"
                          onClick={() => setOpenKey(openKey === r.key ? null : r.key)}
                          aria-expanded={openKey === r.key}
                          aria-controls="adm-aic-drill"
                        >
                          {r.label}
                        </button>
                        {r.key === INTERNAL && <span className="adm-aic-hint" title="Calls with no single client — a company-wide report, or a batch spanning several clients. Never split across clients as a guess."> ⓘ</span>}
                      </td>
                      <td className="n">{r.calls.toLocaleString("en-US")}</td>
                      <td className={`n ${r.failed ? "bad" : "dim"}`}>{r.failed || "—"}</td>
                      <td className="n dim">{formatTokens(r.inputTokens)}</td>
                      <td className="n dim">{formatTokens(r.outputTokens)}</td>
                      <td className="n dim">{r.cacheReadTokens ? formatTokens(r.cacheReadTokens) : "—"}</td>
                      <td className="n strong">
                        {allUnpriced ? <BasisBadge basis="unpriced" /> : formatMicros(r.costMicros)}
                        {!allUnpriced && r.unpricedCalls > 0 && (
                          <span className="adm-aic-plus" title={`${r.unpricedCalls} more calls here could not be priced, so this figure is a floor.`}> +{r.unpricedCalls}?</span>
                        )}
                      </td>
                      <td className="n dim">{r.share === null ? "—" : pct(r.share * 100, 1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {openKey && (
          <div className="adm-aic-drill" id="adm-aic-drill">
            <div className="adm-aic-drill-head">
              <strong>The calls behind {GROUPINGS[tab].labelOf(openKey, maps)}</strong>
              <button type="button" className="adm-aic-close" onClick={() => setOpenKey(null)}>Close</button>
            </div>
            {drillRows.length > 100 && (
              <p className="adm-aic-note">Showing the 100 most recent. There are more.</p>
            )}
            <div className="adm-aic-tablewrap">
              <table className="adm-aic-table adm-aic-drill-table">
                <thead>
                  <tr>
                    <th>When</th><th>Feature</th><th>Page</th><th>Model</th>
                    <th className="n">Tokens</th><th className="n">Took</th><th className="n">Cost</th><th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {drillRows.slice(0, 100).map((r) => (
                    <tr key={r.id || `${r.ts}-${r.request_id}`}>
                      <td title={new Date(r.ts).toLocaleString("en-US", { timeZone: TEAM_TZ })}>{timeAgo(r.ts)}</td>
                      <td>{r.feature || "—"}</td>
                      <td className="dim">{r.surface || "—"}</td>
                      <td className="dim">{r.model || "—"}</td>
                      <td className="n dim">{formatTokens(
                        num(r.input_tokens) + num(r.output_tokens) + num(r.cache_read_tokens)
                        + num(r.cache_write_tokens) + num(r.cache_write_1h_tokens),
                      )}</td>
                      <td className="n dim">{r.latency_ms == null ? "—" : ms(r.latency_ms)}</td>
                      <td className="n strong">{formatMicros(r.cost_micros)}</td>
                      <td>
                        {r.status === "legacy"
                          ? <span className="adm-aic-state warn" title="Costed before Aug 28 2026 with one hardcoded price applied to whatever model actually ran. An estimate, kept as history.">legacy</span>
                          : r.status && r.status !== "ok"
                            ? <span className="adm-aic-state bad" title={r.error_code || r.meta?.rejected || ""}>{r.status}</span>
                            : <span className="adm-aic-state dim">ok</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Block>

      {/* ---------- what the numbers are for ---------- */}
      <Block
        title="What a deliverable costs us"
        blurb="What we spend to produce one finished report — and what the ones that got thrown away cost as well."
      >
        {!calc.perReport.length ? (
          <p className="adm-aic-note">No reports were generated in this window.</p>
        ) : (
          <div className="adm-aic-tablewrap">
            <table className="adm-aic-table">
              <thead>
                <tr>
                  <th>Report</th><th className="n">Made</th><th className="n">Attempts</th>
                  <th className="n">Average each</th><th className="n">Spent on rejects</th>
                </tr>
              </thead>
              <tbody>
                {calc.perReport.map((r) => (
                  <tr key={r.feature}>
                    <td className="adm-aic-name">{r.feature.replace(/_/g, " ")}</td>
                    <td className="n">{r.made}</td>
                    <td className="n dim">{r.attempts}</td>
                    <td className="n strong">{r.avg === null ? <BasisBadge basis="unpriced" /> : formatMicros(r.avg)}</td>
                    <td className={`n ${r.wasted ? "bad" : "dim"}`}>{r.wasted ? formatMicros(r.wasted) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      <Block
        title="What caching saved"
        blurb="Cached tokens are billed at a fraction of the normal input rate. This is the difference, added up from the calls that used it."
      >
        <FigureGrid min={220}>
          <Figure
            label="Saved by caching"
            value={calc.savedRows ? formatMicros(calc.saved) : null}
            basis="metered"
            sub={calc.savedRows
              ? <>across {calc.savedRows.toLocaleString("en-US")} calls
                {calc.savingUnknown > 0 && <> · {calc.savingUnknown} more could not be worked out</>}</>
              : null}
            why={calc.total.cacheReadTokens
              ? `${calc.savingUnknown} calls read from a cache but their model has no price, so what they saved cannot be worked out.`
              : "No call in this window read anything from a cache, so there is nothing to have saved."}
          />
          <Figure
            label="Cached tokens read"
            value={calc.total.cacheReadTokens ? formatTokens(calc.total.cacheReadTokens) : null}
            basis="metered"
            why="Nothing was read from a cache in this window."
          />
          <Figure
            label="Cached tokens written"
            value={calc.total.cacheWriteTokens || calc.total.cacheWrite1hTokens
              ? formatTokens(calc.total.cacheWriteTokens + calc.total.cacheWrite1hTokens)
              : null}
            basis="metered"
            means="A cache write costs more than plain input; a 1-hour write costs more than a 5-minute one. Both are priced separately."
            why="Nothing was written to a cache in this window."
          />
        </FigureGrid>
      </Block>

      {/* ---------- the price book ---------- */}
      <Block
        title="The price book"
        blurb="Prices are rows in the database, not numbers in the code, and every row is dated. A call is priced with the row that was in force on the day it ran, and that price is frozen onto the call — changing a price tomorrow cannot move last month's total."
      >
        {!(prices.rows || []).length ? (
          <p className="adm-aic-note">
            No prices are in the database. Run <code>supabase/migrations/0024_ai_usage.sql</code> — it seeds
            the Anthropic rates read off their own pricing page on Aug 28 2026.
          </p>
        ) : (
          <div className="adm-aic-tablewrap">
            <table className="adm-aic-table">
              <thead>
                <tr>
                  <th>Provider</th><th>Model</th><th>From</th>
                  <th className="n">In / Mtok</th><th className="n">Out / Mtok</th>
                  <th className="n">Cache write</th><th className="n">Cache read</th><th>Source</th>
                </tr>
              </thead>
              <tbody>
                {(prices.rows || []).map((p) => (
                  <tr key={p.id}>
                    <td className="dim">{p.provider}</td>
                    <td className="adm-aic-name">{p.model}</td>
                    <td className="dim">{String(p.effective_from).slice(0, 10)}{p.effective_to ? ` – ${String(p.effective_to).slice(0, 10)}` : ""}</td>
                    <td className="n">${(num(p.input_per_mtok) / MICROS_PER_DOLLAR).toFixed(2)}</td>
                    <td className="n">${(num(p.output_per_mtok) / MICROS_PER_DOLLAR).toFixed(2)}</td>
                    <td className="n dim">{p.cache_write_per_mtok == null ? "—" : `$${(num(p.cache_write_per_mtok) / MICROS_PER_DOLLAR).toFixed(2)}`}</td>
                    <td className="n dim">{p.cache_read_per_mtok == null ? "—" : `$${(num(p.cache_read_per_mtok) / MICROS_PER_DOLLAR).toFixed(2)}`}</td>
                    <td className="dim">
                      {p.source_url
                        ? <a href={p.source_url} target="_blank" rel="noopener noreferrer">where this came from</a>
                        : <span title="Nobody recorded where this price was copied from.">not recorded</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      {/* ---------- the honest footer ---------- */}
      <div className="adm-aic-foot">
        <p>
          <strong>What this page can and cannot see.</strong> It counts the calls this console makes. Anything
          the platform or the backend sends to an AI is <em>not</em> in these numbers until it posts to{" "}
          <code>/api/usage-ingest</code>. Nothing here has been checked against a provider's real bill, because
          that needs an Admin key that does not exist yet — so every figure is <BasisBadge basis="metered" />,
          and none of them is <BasisBadge basis="billed" />.
        </p>
        <p className="adm-aic-dim">
          Days and months are counted in the team&rsquo;s own calendar ({TEAM_TZ}), not the browser&rsquo;s and
          not UTC. Money is held as whole millionths of a dollar so a fraction of a cent cannot drift away
          across thousands of calls. Read by {member?.email || "this account"}.
        </p>
      </div>
    </div>
  );
}
