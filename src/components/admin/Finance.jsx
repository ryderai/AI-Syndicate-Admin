import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScreenContext } from "../../lib/screenContext.js";
import { isConfigured, getSupabase } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import { listClients } from "../../lib/data.js";
import { listExpenses } from "../../lib/finance.js";
import { getFinanceSummary, getAiCost } from "../../lib/moneyApi.js";
import { timeAgo } from "./shared.jsx";
import ExpensesPanel from "./expensesPanel.jsx";
import {
  RangePicker, Tabs, Stat, MoneyChart, SimpleTable, ShareList, Card, Loading,
  usd, pctText, C_PLATFORM, C_AGENCY, C_OUT,
} from "./moneyParts.jsx";
import { financeView, changeVs, DEPT_LABEL } from "../../../lib/money-view.js";
import {
  previousRange, rangeLabel, addMonths, monthName, monthRange, monthsIn, rangeMonth,
} from "../../../lib/money-range.js";
import { teamDate } from "../../../lib/brain-context.js";

/* ==================================================================
 * FINANCE — rebuilt 24 Sep 2026. OWNERS ONLY (Ryder, Andrew, CJ).
 *
 * Ryder: "remove projected and cash runway. we need to really simplify this
 * to make it easy and the numbers work out correctly. so we need to seperate
 * this to two departments, one for the platform and just people buy the
 * platform, then one for the largest agency purchases where we actually are
 * helping them implement. remove all projections. and the money in vs money
 * out must be accurate for all costs and everything. and make it filtered at
 * the top by month so i know the time period and can even customize it. i
 * want to be able to see trends and everything."
 *
 * So the page is, top to bottom:
 *   1. The period (This month … All time, or any two dates).
 *   2. All / Platform / Agency.
 *   3. Three numbers: money in, money out, kept — each against the period
 *      before.
 *   4. The two sides next to each other (on "All").
 *   5. Money in vs out over time, and the last 12 months.
 *   6. Where the money came from, where it went.
 *   7. Every payment (with the side it counted on, and a way to flip it).
 *   8. The cost list.
 * Nothing on it is a forecast. The old page (runway, projections, CAC, LTV,
 * quick ratio …) is in git history — commit before 24 Sep 2026.
 *
 * SPEED. The old page waited on Stripe AND on reading every AI usage row in
 * the browser (51,230 on 24 Sep, 20–30 s). Now: one Stripe read that the
 * server keeps for a minute, one grouped AI read, and the last answer drawn
 * at once from this tab while the fresh one loads.
 *
 * The maths lives in lib/money-view.js (tests/money). This file only draws.
 * ================================================================== */

const SIDES = [
  { id: "all", label: "All" },
  { id: "platform", label: "Platform", dot: C_PLATFORM },
  { id: "agency", label: "Agency", dot: C_AGENCY },
];

export default function Finance({ member }) {
  /* Stamped once per page open. A page left open past midnight keeps the day
   * it opened on until Refresh — which also re-stamps it. */
  const [today, setToday] = useState(() => teamDate(Date.now()));
  /* Opens on THIS MONTH, picked as a month (Ryder, 24 Sep 2026: "filter the
   * finance page by month"). */
  const [preset, setPreset] = useState(() => `m:${today.slice(0, 7)}`);
  const [range, setRange] = useState(() => monthRange(today.slice(0, 7), today));
  const [side, setSide] = useState("all");
  /* BY MONTH unless someone asks for days — Ryder, 24 Sep 2026: "we need this
   * by month, i dont care about day unless someone clicks that they want to
   * see by day." */
  const [chartMode, setChartMode] = useState("month");

  const [summary, setSummary] = useState(null);
  const [summaryState, setSummaryState] = useState("loading"); // loading | stale | live | nokey | error
  const [summaryErr, setSummaryErr] = useState(null);
  const [ai, setAi] = useState(null);
  const [aiState, setAiState] = useState("loading");
  const [aiWindow, setAiWindow] = useState(null);
  const [expenses, setExpenses] = useState({ rows: [], loaded: false });
  const [clients, setClients] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  /* The AI window always covers the chosen period AND the 12 months the trend
   * chart draws, so switching between recent presets never waits on a read. */
  const wantAi = useMemo(() => {
    const trendFrom = `${addMonths(today.slice(0, 7), -11)}-01`;
    /* …and the period before it, or the "vs before" costs would count its AI
     * as $0 on long ranges. */
    const prevFrom = previousRange(range).from;
    const from = [range.from, trendFrom, prevFrom].sort()[0];
    return { from, to: today };
  }, [range, today]);

  const loadSummary = useCallback(async (refresh = false) => {
    if (!isConfigured()) { setSummaryState("nokey"); return; }
    const res = await getFinanceSummary({
      refresh,
      onCached: (d) => { setSummary(d); setSummaryState("stale"); },
    });
    if (res.ok && res.data?.configured) { setSummary(res.data); setSummaryState("live"); setSummaryErr(null); }
    else if (res.ok) setSummaryState("nokey");
    else { setSummaryState("error"); setSummaryErr(res.error); }
  }, []);

  /* Only the newest AI read may paint — a slow wide window must not land
   * after a narrow one and replace it. */
  const aiSeq = useRef(0);
  const loadAi = useCallback(async (win, refresh = false) => {
    if (!isConfigured()) { setAiState("nokey"); return; }
    const mine = ++aiSeq.current;
    setAiState((s) => (s === "live" ? "loading-more" : s));
    const res = await getAiCost(win, {
      refresh,
      onCached: (d) => { if (mine === aiSeq.current) { setAi(d); setAiWindow(win); setAiState("stale"); } },
    });
    if (mine !== aiSeq.current) return;
    if (res.ok) { setAi(res.data); setAiWindow(win); setAiState("live"); }
    else { setAiState("error"); toast.error("AI cost could not be read", res.error); }
  }, []);

  const loadExpenses = useCallback(async () => {
    const e = await listExpenses({ sinceMonths: 36 });
    setExpenses({ rows: e.rows || [], loaded: true, error: e.error || null });
    if (e.error) toast.error("Couldn't read the cost list", e.error);
  }, []);

  useEffect(() => {
    loadSummary();
    loadExpenses();
    listClients().then((c) => setClients(c.rows || []));
  }, [loadSummary, loadExpenses]);

  useEffect(() => {
    /* Only read again when the window we hold does not cover the one we need. */
    if (aiWindow && aiWindow.from <= wantAi.from && aiWindow.to >= wantAi.to) return;
    loadAi(wantAi);
  }, [wantAi, aiWindow, loadAi]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    setToday(teamDate(Date.now()));
    await Promise.all([loadSummary(true), loadAi(wantAi, true), loadExpenses()]);
    setRefreshing(false);
  }, [loadSummary, loadAi, loadExpenses, wantAi]);

  useEffect(() => {
    const onRefresh = () => refreshAll();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [refreshAll]);

  useScreenContext(() => ({
    page: "finance",
    label: "Finance",
    visible: [`Money in, out and kept for ${rangeLabel(range)}`, `Showing: ${side}`],
  }), [range, side]);

  /* ---------------- the numbers ---------------- */
  const view = useMemo(() => (summary ? financeView({ summary, ai, expenses: expenses.rows, range, today }) : null), [summary, ai, expenses, range, today]);
  const before = useMemo(() => {
    if (!summary) return null;
    const pr = previousRange(range);
    /* No comparison against a period before the first payment — "up from
     * nothing" is not a trend. */
    if (summary.earliest && pr.from < summary.earliest) return null;
    return financeView({ summary, ai, expenses: expenses.rows, range: pr, today });
  }, [summary, ai, expenses, range, today]);
  /* THE MONTHLY CHART always runs to this month, so every month is on it and
   * the months you picked are the ones drawn solid. Twelve months back, but
   * never before the first payment — empty months before we had customers
   * are not a trend. */
  const trend = useMemo(() => {
    if (!summary) return null;
    let from = `${addMonths(today.slice(0, 7), -11)}-01`;
    if (summary.earliest && summary.earliest.slice(0, 7) > from.slice(0, 7)) from = `${summary.earliest.slice(0, 7)}-01`;
    if (range.from < from) from = `${range.from.slice(0, 7)}-01`;
    return financeView({ summary, ai, expenses: expenses.rows, range: { from, to: today }, bucket: "month", today });
  }, [summary, ai, expenses, range, today]);
  const picked = useMemo(() => new Set(monthsIn(range)), [range]);
  /* Days only when someone asks for them. */
  const daily = useMemo(() => (summary && chartMode === "day"
    ? financeView({ summary, ai, expenses: expenses.rows, range, bucket: "day", today })
    : null), [summary, ai, expenses, range, today, chartMode]);

  const pick = (s) => (s === "all" ? view?.all : view?.sides[s]);
  const pickBefore = (s) => (s === "all" ? before?.all : before?.sides[s]);
  const cur = pick(side);
  const prev = pickBefore(side);

  /* ---------------- flipping a customer's side ---------------- */
  const [flipping, setFlipping] = useState(null);
  const setDept = useCallback(async (customerId, dept) => {
    if (!customerId) return;
    setFlipping(customerId);
    const sb = getSupabase();
    const { error } = dept === "auto"
      ? await sb.from("admin_finance_departments").delete().eq("stripe_customer_id", customerId)
      : await sb.from("admin_finance_departments").upsert({ stripe_customer_id: customerId, department: dept, set_at: new Date().toISOString() });
    setFlipping(null);
    if (error) {
      toast.error("Not saved", /does not exist|schema cache/i.test(error.message)
        ? "Migration 0041 has not been run yet, so a customer's side cannot be changed."
        : error.message);
      return;
    }
    toast.success("Saved", "Every number moved with it.");
    await loadSummary(true);
    await loadAi(wantAi, true);
  }, [loadSummary, loadAi, wantAi]);

  /* ---------------- drawing ---------------- */
  const stateLine = summaryState === "live" && summary
    ? `Stripe read ${timeAgo(Date.parse(summary.fetchedAt))}${summary.cached ? " (kept for a minute)" : ""}`
    : summaryState === "stale" ? "Showing your last numbers — reading fresh ones…"
      : summaryState === "error" ? `Stripe could not be read: ${summaryErr}`
        : summaryState === "nokey" ? "Stripe is not connected (STRIPE_SECRET_KEY)."
          : "Reading Stripe…";

  if (member?.role !== "owner") {
    return <div className="mny-page"><Card title="Owners only">Finance is for owners.</Card></div>;
  }

  return (
    <div className="mny-page">
      <div className="mny-head">
        {/* The page title is drawn by Header.jsx; a second one here said
            "Finance" twice (seen on the live page, 24 Sep 2026). */}
        <div className="mny-sub">Money in, money out, and what we kept. Owners only.</div>
        <div className="mny-head-right">
          <span className="mny-muted mny-state">{stateLine}</span>
          <button type="button" className="btn" onClick={refreshAll} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>

      <RangePicker
        range={range}
        preset={preset}
        today={today}
        earliest={summary?.earliest}
        onChange={(r, id) => { setRange(r); setPreset(id); }}
      />

      <Tabs value={side} onChange={setSide} options={SIDES} label="Which side of the business" />

      {!view ? (
        summaryState === "error" || summaryState === "nokey"
          ? <Card title="No money figures">{stateLine}</Card>
          : <Loading what="Reading Stripe…" />
      ) : (
        <>
          {/* ---------- the three numbers ---------- */}
          <div className="mny-hero">
            <Stat
              big
              label={side === "all" ? "Money in" : `${DEPT_LABEL[side]} money in`}
              dot={side === "platform" ? C_PLATFORM : side === "agency" ? C_AGENCY : null}
              value={usd(cur.in)}
              change={changeVs(cur.in, prev?.in)}
              sub={cur.refunds ? `after ${usd(cur.refunds)} refunded` : `${plural(side === "all" ? view.sides.platform.payments + view.sides.agency.payments : cur.payments, "payment")}`}
            />
            <Stat
              big
              label={side === "all" ? "Money out" : `${DEPT_LABEL[side]} costs`}
              dot={C_OUT}
              value={usd(cur.out)}
              change={changeVs(cur.out, prev?.out)}
              changeGoodWhenUp={false}
              sub={outLine(cur)}
            />
            <Stat
              big
              label="Kept"
              value={usd(cur.kept)}
              tone={cur.kept >= 0 ? "good" : "bad"}
              change={changeVs(cur.kept, prev?.kept)}
              sub={cur.in > 0 ? `${pctText(cur.kept / cur.in)} of money in` : "nothing came in"}
            />
          </div>

          {view.typedCount === 0 && expenses.loaded && !expenses.error && (
            <div className="mny-alert">
              <strong>Money out is missing most of our costs.</strong> Only Stripe card fees are counted, because
              no other cost has been typed in yet — software, people, hosting, AI bills, ads. Add them
              in <a href="#mny-costs">the cost list</a> at the bottom (a monthly cost is typed once and counts
              every month).
            </div>
          )}
          {side !== "all" && view.sides.shared.out > 0 && (
            <div className="mny-note-line">
              Not included above: <strong>{usd(view.sides.shared.out)}</strong> of shared costs (costs marked
              "both") that belong to neither side. They are in the All view.
            </div>
          )}

          {/* ---------- the two sides ---------- */}
          {side === "all" && (
            <div className="mny-two">
              <SideCard name="platform" view={view} before={before} onOpen={() => setSide("platform")} />
              <SideCard name="agency" view={view} before={before} onOpen={() => setSide("agency")} />
            </div>
          )}

          {/* ---------- over time ---------- */}
          <Card
            title={chartMode === "month" ? "Money in vs out, month by month" : `Money in vs out, day by day · ${rangeLabel(range)}`}
            right={<Tabs value={chartMode} onChange={setChartMode} label="Chart period" options={[{ id: "month", label: "By month" }, { id: "day", label: "By day" }]} />}
            note={chartMode === "month" ? "The months you picked above are solid; the rest are faded. Click a month in the table or at the top to switch to it." : null}
          >
            {chartMode === "month"
              ? trend && <MoneyChart series={trend.series} bucket="month" show={side} highlight={picked} />
              : daily && <MoneyChart series={daily.series} bucket="day" show={side} />}
            {chartMode === "month" && trend && (
              <div style={{ marginTop: 14 }}>
                <MonthTable
                  trend={trend}
                  side={side}
                  picked={picked}
                  onPick={(ym) => { setRange(monthRange(ym, today)); setPreset(`m:${ym}`); }}
                />
              </div>
            )}
          </Card>

          {/* ---------- detail per side ---------- */}
          {side !== "agency" && <PlatformDetail view={view} />}
          {side !== "platform" && <AgencyDetail view={view} />}

          {/* ---------- where it came from / went ---------- */}
          <div className="mny-two">
            <Card title="Where the money came from">
              <ShareList
                total={Math.max(1, view.customers.filter((c) => side === "all" || c.dept === side).reduce((a, c) => a + Math.max(0, c.cents), 0))}
                rows={view.customers
                  .filter((c) => (side === "all" || c.dept === side) && c.cents !== 0)
                  .slice(0, 10)
                  .map((c) => ({
                    key: c.id || c.name, label: c.name, value: c.cents,
                    color: c.dept === "platform" ? C_PLATFORM : C_AGENCY,
                    sub: `${DEPT_LABEL[c.dept]} · ${plural(c.payments, "payment")}`,
                  }))}
              />
            </Card>
            <Card
              title="Where the money went"
              note={aiState === "error" ? "AI token use could not be read just now — see the AI Cost page." : view.ai.tokensTotal > 0
                ? `AI is counted in tokens, not dollars, for now: ${fmtTokens(side === "all" ? view.ai.tokensTotal : view.ai.tokens[side])} tokens used in this period (details on the AI Cost page). A real AI bill typed into the cost list counts here like any other cost.`
                : null}
            >
              <ShareList
                color={C_OUT}
                total={Math.max(1, cur.out)}
                rows={outRows(view, side)}
                empty="No costs in this period."
              />
            </Card>
          </div>

          {/* ---------- every payment ---------- */}
          <PaymentsCard
            summary={summary}
            range={range}
            side={side}
            onSetDept={setDept}
            flipping={flipping}
          />

          <div id="mny-costs">
            <ExpensesPanel
              key={rangeMonth(range, today) || "range"}
              initialMonth={rangeMonth(range, today) || "all"}
              member={member}
              rows={expenses.rows}
              sample={!isConfigured()}
              clients={clients}
              onChanged={loadExpenses}
            />
          </div>

          <div className="mny-foot">
            Money in and card fees are measured by Stripe. Every other cost is typed in. AI use is shown in tokens on
            the AI Cost page and is not in money out until a real bill is typed in. Dates follow Chicago time.
            {summary.truncated && " Stripe returned more than 2,000 rows of something — the oldest may be missing."}
            {summary.invoicesLinked === false && " Stripe did not link payments to invoices on this read, so each payment's side was taken from its description."}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */

function fmtTokens(x) {
  const v = Number(x) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}K`;
  return v.toLocaleString("en-US");
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function outLine(s) {
  const bits = [];
  if (s.fees) bits.push(`${usd(s.fees)} card fees`);
  if (s.ai) bits.push(`${usd(s.ai)} AI`);
  if (s.typed) bits.push(`${usd(s.typed)} other`);
  return bits.length ? bits.join(" · ") : "no costs in this period";
}

function outRows(view, side) {
  const sides = side === "all" ? ["platform", "agency", "shared"] : [side];
  const sum = (k) => sides.reduce((a, d) => a + (view.sides[d][k] || 0), 0);
  const rows = [
    { key: "fees", label: "Stripe card fees", value: sum("fees"), sub: "measured by Stripe" },
    { key: "ai", label: "AI calls", value: sum("ai"), sub: "metered by us" },
  ];
  const cats = {};
  for (const e of view.typedRows) {
    if (!sides.includes(e.dept)) continue;
    cats[e.category || "Other"] = (cats[e.category || "Other"] || 0) + e.inRangeCents;
  }
  for (const [cat, cents] of Object.entries(cats)) rows.push({ key: `t-${cat}`, label: cat, value: cents, sub: "typed in" });
  return rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
}

function SideCard({ name, view, before, onOpen }) {
  const s = view.sides[name];
  const b = before?.sides[name];
  const color = name === "platform" ? C_PLATFORM : C_AGENCY;
  return (
    <section className="mny-card mny-side" style={{ borderTopColor: color }}>
      <div className="mny-card-head">
        <h3><span className="mny-dot" style={{ background: color }} />{DEPT_LABEL[name]}</h3>
        <button type="button" className="mny-link" onClick={onOpen}>Open {DEPT_LABEL[name]} →</button>
      </div>
      <div className="mny-side-grid">
        <Stat label="In" value={usd(s.in)} change={changeVs(s.in, b?.in)} />
        <Stat label="Costs" value={usd(s.out)} change={changeVs(s.out, b?.out)} changeGoodWhenUp={false} />
        <Stat label="Kept" value={usd(s.kept)} tone={s.kept >= 0 ? "good" : "bad"} change={changeVs(s.kept, b?.kept)} />
      </div>
      {name === "platform" ? (
        <ul className="mny-facts">
          <li><strong>{view.platform.paying.length}</strong> paying subscriber{view.platform.paying.length === 1 ? "" : "s"} {view.platform.asOf === "today" ? "today" : `on ${view.platform.asOf}`} · <strong>{usd(view.platform.mrrCents)}/mo</strong></li>
          <li><strong>{view.platform.free.length}</strong> on a free ($0) plan</li>
          <li><strong>{view.platform.newPaying.length}</strong> new paying · <strong>{view.platform.cancelled.length}</strong> cancelled in this period</li>
        </ul>
      ) : (
        <ul className="mny-facts">
          <li><strong>{view.agency.clientsPaid}</strong> client{view.agency.clientsPaid === 1 ? "" : "s"} paid in this period</li>
          <li><strong>{usd(view.agency.owedCents)}</strong> owed right now on {plural(view.agency.owed.length, "open invoice")}</li>
          {view.agency.overdue.length > 0 && <li className="bad"><strong>{view.agency.overdue.length}</strong> past due</li>}
        </ul>
      )}
    </section>
  );
}

function PlatformDetail({ view }) {
  const p = view.platform;
  return (
    <Card title="Platform subscribers" note="Paying = more than $0 a month. Monthly amounts are what Stripe will charge; yearly plans are shown per month.">
      <div className="mny-side-grid">
        <Stat label={p.asOf === "today" ? "Paying today" : `Paying on ${p.asOf}`} value={p.paying.length} sub={`${usd(p.mrrCents)}/mo recurring`} />
        <Stat label="Free ($0) seats" value={p.free.length} sub="active, not paying" />
        <Stat label="New paying" value={p.newPaying.length} sub="started in this period" />
        <Stat label="Cancelled" value={p.cancelled.length} sub="paying plans that ended" />
      </div>
      <SimpleTable
        columns={[
          { key: "name", label: "Subscriber" },
          { key: "state", label: "Status" },
          { key: "mrr", label: "Per month", num: true, render: (r) => (r.mrr === null ? "—" : usd(r.mrr)), sortValue: (r) => r.mrr ?? -1 },
          { key: "since", label: "Since" },
        ]}
        rows={[
          ...p.paying.map((s) => ({ key: `p-${s.name}-${s.started}`, name: s.name, state: s.pastDue ? "Paying · payment late" : "Paying", mrr: s.mrrCents, since: s.started })),
          ...p.trialing.map((s) => ({ key: `t-${s.name}`, name: s.name, state: `Trial to ${s.trialEnd || "?"}`, mrr: s.mrrCents, since: "—" })),
          ...p.free.map((s) => ({ key: `f-${s.name}-${s.started}`, name: s.name, state: "Free", mrr: 0, since: s.started })),
          ...p.cancelled.map((s) => ({ key: `c-${s.name}-${s.ended}`, name: s.name, state: `Cancelled ${s.ended}`, mrr: null, since: "—" })),
        ]}
        empty="No subscribers yet."
      />
    </Card>
  );
}

function AgencyDetail({ view }) {
  const a = view.agency;
  const clientsPaid = view.customers.filter((c) => c.dept === "agency" && c.cents !== 0);
  return (
    <div className="mny-two">
      <Card title="Agency clients paid">
        <SimpleTable
          columns={[
            { key: "name", label: "Client" },
            { key: "payments", label: "Payments", num: true },
            { key: "last", label: "Last paid" },
            { key: "cents", label: "Paid", num: true, render: (r) => usd(r.cents) },
          ]}
          rows={clientsPaid.map((c) => ({ ...c, key: c.id || c.name }))}
          total={{ name: "Total", cents: usd(clientsPaid.reduce((s, c) => s + c.cents, 0)) }}
          initialSort={{ key: "cents", dir: "desc" }}
          empty="No agency payments in this period."
        />
      </Card>
      <Card title="Owed to us right now" note="Open Stripe invoices on the agency side, oldest due date first. This is today's list whatever period is picked — Stripe does not keep what was open on a past day. Not counted as money in until paid.">
        <SimpleTable
          columns={[
            { key: "customerName", label: "Client" },
            { key: "dueDate", label: "Due", render: (r) => <span className={r.late ? "mny-bad" : ""}>{r.dueDate || "—"}{r.late ? " · late" : ""}</span> },
            { key: "dueCents", label: "Owed", num: true, render: (r) => (r.hostedUrl ? <a href={r.hostedUrl} target="_blank" rel="noopener noreferrer">{usd(r.dueCents)}</a> : usd(r.dueCents)) },
          ]}
          rows={a.owed.map((i) => ({ ...i, key: i.id, late: a.overdue.includes(i) }))}
          total={{ customerName: "Total", dueCents: usd(a.owedCents) }}
          empty="Nothing owed."
        />
      </Card>
    </div>
  );
}

function MonthTable({ trend, side, picked, onPick }) {
  const rows = trend.series.map((b) => {
    const inP = b.platformIn, inA = b.agencyIn;
    const inn = side === "platform" ? inP : side === "agency" ? inA : inP + inA;
    const out = side === "all" ? b.out : b.outDept[side];
    return { key: b.key, month: monthName(b.key, { long: true }), inP, inA, inn, out, kept: inn - out };
  }).reverse();
  const cols = [
    {
      key: "month", label: "Month", sortValue: (r) => r.key,
      render: (r) => (onPick
        ? <button type="button" className={`mny-link${picked?.has(r.key) ? " mny-picked" : ""}`} onClick={() => onPick(r.key)}>{r.month}</button>
        : r.month),
    },
    ...(side !== "agency" ? [{ key: "inP", label: "Platform in", num: true, render: (r) => usd(r.inP) }] : []),
    ...(side !== "platform" ? [{ key: "inA", label: "Agency in", num: true, render: (r) => usd(r.inA) }] : []),
    { key: "out", label: side === "all" ? "Money out" : "Costs", num: true, render: (r) => usd(r.out) },
    { key: "kept", label: "Kept", num: true, render: (r) => <span className={r.kept < 0 ? "mny-bad" : "mny-good"}>{usd(r.kept)}</span> },
  ];
  const t = rows.reduce((a, r) => ({ inP: a.inP + r.inP, inA: a.inA + r.inA, out: a.out + r.out, kept: a.kept + r.kept }), { inP: 0, inA: 0, out: 0, kept: 0 });
  return (
    <SimpleTable
      columns={cols}
      rows={rows}
      total={{ month: "Total", inP: usd(t.inP), inA: usd(t.inA), out: usd(t.out), kept: usd(t.kept) }}
    />
  );
}

function PaymentsCard({ summary, range, side, onSetDept, flipping }) {
  const [open, setOpen] = useState(false);
  const rows = (summary.transactions || [])
    .filter((t) => t.date >= range.from && t.date <= range.to && (side === "all" || t.dept === side))
    .sort((a, b) => b.date.localeCompare(a.date));
  const refunded = new Map();
  for (const r of summary.refunds || []) refunded.set(r.chargeId, (refunded.get(r.chargeId) || 0) + r.cents);
  const cust = summary.customers || {};
  return (
    <Card
      title={`Every payment · ${rows.length}`}
      right={<button type="button" className="mny-link" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"}</button>}
      note={open ? (summary.overridesReady
        ? "A payment's side comes from Stripe: subscription = Platform, one-off invoice = Agency. Change a customer's side and all their payments move with it."
        : "Changing a customer's side needs migration 0041 to be run first.") : null}
    >
      {open && (
        <SimpleTable
          max={100}
          columns={[
            { key: "date", label: "Date" },
            { key: "customerName", label: "Who" },
            { key: "why", label: "What", render: (r) => r.why + (r.invoiceNumber ? ` · ${r.invoiceNumber}` : "") },
            {
              key: "dept", label: "Side", render: (r) => {
                const c = cust[r.customerId];
                return (
                  <select
                    className="mny-select"
                    value={c?.override || "auto"}
                    disabled={!r.customerId || flipping === r.customerId || !summary.overridesReady}
                    onChange={(e) => onSetDept(r.customerId, e.target.value)}
                    aria-label={`Side for ${r.customerName}`}
                  >
                    <option value="auto">{DEPT_LABEL[r.autoDept || r.dept]} (automatic)</option>
                    <option value="platform">Platform</option>
                    <option value="agency">Agency</option>
                  </select>
                );
              },
            },
            { key: "cents", label: "Amount", num: true, render: (r) => (refunded.get(r.id) ? <span>{usd(r.cents)} <span className="mny-muted">({usd(refunded.get(r.id))} refunded)</span></span> : usd(r.cents)) },
            { key: "feeCents", label: "Fee", num: true, render: (r) => (r.feeCents === null ? "—" : usd(r.feeCents, { cents: true })) },
          ]}
          rows={rows.map((r) => ({ ...r, key: r.id }))}
          empty="No payments in this period."
        />
      )}
    </Card>
  );
}

