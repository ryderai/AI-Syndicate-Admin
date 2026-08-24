import { useCallback, useEffect, useMemo, useState } from "react";
import { useScreenContext } from "../../lib/screenContext.js";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import { listClients, listUsage } from "../../lib/data.js";
import { listExpenses, listInvoices, getFinanceSettings, saveFinanceSettings } from "../../lib/finance.js";
import {
  SourceBadge, MetricCard, Modal, Field, TextInput, CountUp, fmtMoney,
  MONEY_GREEN, MONEY_RED, timeAgo,
} from "./shared.jsx";
import {
  Figure, FigureGrid, Block, InOutBars, ProfitBars, MovementBar, RankedBars,
  ListCard, BasisBadge, pct, ratio, months as fmtMonths,
} from "./financeParts.jsx";
import ExpensesPanel from "./expensesPanel.jsx";
import {
  lastMonths, monthKey, monthLabel, expensesByMonth, expensesByCategory, expensesByVendor,
  expenseToMonths, fixedVsVariable, profitSeries, projectForward, mrrFromSubs, trialMrr,
  PAYING_STATUSES, arrFromMrr,
  mrrMovement, cac, arpa, churnRate, revenueChurnRate, ltv, ltvToCac, cacPaybackMonths,
  nrr, quickRatio, grossMargin, netMargin, runwayMonths, breakEven, revenueConcentration,
  agingBuckets, avgDaysToPay, billedVsCollected, invoiceOutstandingCents,
  effectiveInvoiceStatus, sum, pctChange, daysBetween, todayIso, DELIVERY_CATEGORIES,
} from "../../../lib/finance-math.js";

/* ==================================================================
 * FINANCE — the money page. Aug 20 2026.
 *
 * The top of this page is the summary: what comes in, what goes out,
 * what is left, and where it is heading. Everything under it is the
 * long version — every cost, every client, and the numbers an agency
 * gets asked about (cost to win a client, what a client is worth,
 * churn, margin, runway).
 *
 * WHERE EACH NUMBER COMES FROM — the whole design of this page:
 *   money IN   → Stripe. Measured. We do not type it in.
 *   money OUT  → typed into this console by us, because nothing else on
 *                earth knows what we pay. Card fees are the exception:
 *                Stripe measures those, and they are used unless someone
 *                has already typed a "Payment fees" cost for that month
 *                (counting a cost twice is worse than missing it).
 *   everything else → worked out from those two, and labelled ESTIMATE
 *                on screen when it is.
 *
 * A number we cannot honestly work out prints "not measured yet" with the
 * reason. It never prints 0.
 * ================================================================== */

/* ---- sample numbers, for preview mode ---- */

function unixDaysAgo(n) { return Math.floor((Date.now() - n * 86400000) / 1000); }
function unixMonthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n, 8);
  return Math.floor(d.getTime() / 1000);
}

const SAMPLE_SUBS = [
  { id: "sub_a", customerName: "Harbor Legal", plan: "Territory", status: "active", mrrCents: 52000, lastMrrCents: 52000, created: unixMonthsAgo(9), canceledAt: null },
  { id: "sub_b", customerName: "Northlake Dental", plan: "Radar Pro", status: "active", mrrCents: 45000, lastMrrCents: 45000, created: unixMonthsAgo(7), canceledAt: null },
  { id: "sub_c", customerName: "Lakeside Realty Group", plan: "Radar Pro", status: "active", mrrCents: 45000, lastMrrCents: 45000, created: unixMonthsAgo(6), canceledAt: null },
  { id: "sub_d", customerName: "Vega Co", plan: "Pulse", status: "active", mrrCents: 29000, lastMrrCents: 29000, created: unixDaysAgo(9), canceledAt: null },
  { id: "sub_e", customerName: "Cedar Park Dental", plan: "Pulse", status: "active", mrrCents: 29000, lastMrrCents: 29000, created: unixMonthsAgo(4), canceledAt: null },
  { id: "sub_f", customerName: "Bloom Fitness", plan: "Starter", status: "active", mrrCents: 18000, lastMrrCents: 18000, created: unixDaysAgo(3), canceledAt: null },
  { id: "sub_g", customerName: "Ridge Roofing", plan: "Starter", status: "active", mrrCents: 18000, lastMrrCents: 18000, created: unixMonthsAgo(5), canceledAt: null },
  { id: "sub_h", customerName: "Marina Law", plan: "Pulse", status: "active", mrrCents: 32000, lastMrrCents: 32000, created: unixMonthsAgo(8), canceledAt: null },
  { id: "sub_i", customerName: "Halcyon Med Spa", plan: "Pulse", status: "active", mrrCents: 26000, lastMrrCents: 26000, created: unixMonthsAgo(10), canceledAt: null },
  { id: "sub_j", customerName: "Trail HVAC", plan: "Starter", status: "active", mrrCents: 24000, lastMrrCents: 24000, created: unixMonthsAgo(3), canceledAt: null },
  { id: "sub_k", customerName: "Gulfview Realty", plan: "Radar Pro", status: "active", mrrCents: 35000, lastMrrCents: 35000, created: unixMonthsAgo(11), canceledAt: null },
  { id: "sub_l", customerName: "Pinecrest Dental", plan: "Pulse", status: "active", mrrCents: 30000, lastMrrCents: 30000, created: unixMonthsAgo(2), canceledAt: null },
  { id: "sub_m", customerName: "Anchor Injury Law", plan: "Pulse", status: "active", mrrCents: 26000, lastMrrCents: 26000, created: unixMonthsAgo(6), canceledAt: null },
  { id: "sub_n", customerName: "Dune Coffee Roasters", plan: "Starter", status: "trialing", mrrCents: 40600, lastMrrCents: 40600, created: unixMonthsAgo(1), canceledAt: null },
  { id: "sub_x", customerName: "Former Client LLC", plan: "Starter", status: "canceled", mrrCents: 0, lastMrrCents: 18000, created: unixMonthsAgo(9), canceledAt: unixDaysAgo(11) },
];

const SAMPLE_FINANCE = (() => {
  const base = [1200, 1450, 1800, 2300, 2100, 2900, 3300, 3050, 3800, 4100, 4300, 4496];
  const dailyRevenue = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const first = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const weights = [];
    for (let d = 0; d < days; d++) {
      const dow = new Date(first.getFullYear(), first.getMonth(), d + 1).getDay();
      weights.push(dow === 0 || dow === 6 ? 0.25 : 1 + 0.35 * Math.abs(Math.sin(d * 1.3)));
    }
    const totalW = weights.reduce((a, b) => a + b, 0);
    const monthCents = base[11 - i] * 100;
    for (let d = 0; d < days; d++) {
      const day = new Date(first.getFullYear(), first.getMonth(), d + 1);
      if (day > now) break;
      dailyRevenue.push({
        d: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`,
        cents: Math.round((monthCents * weights[d]) / totalW),
      });
    }
  }
  const monthsList = lastMonths(12);
  const feesByMonth = {};
  const refundsByMonth = {};
  monthsList.forEach((m, idx) => {
    feesByMonth[m] = Math.round(base[idx] * 100 * 0.031);
    refundsByMonth[m] = idx === 8 ? 12000 : 0;
  });
  /* The month we are in is only part done, so the sample shows a part month
   * too — otherwise the sample would quietly disagree with the "20 of 31 days
   * in" note printed next to it. */
  const partDone = now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const grossByMonth = Object.fromEntries(
    monthsList.map((m, i) => [m, Math.round(base[i] * 100 * (i === monthsList.length - 1 ? partDone : 1))])
  );
  const revenueByMonth = Object.fromEntries(monthsList.map((m) => [m, grossByMonth[m] - (refundsByMonth[m] || 0)]));
  return {
    configured: false,
    sample: true,
    months: monthsList,
    revenueByMonth,
    grossByMonth,
    subscriptions: SAMPLE_SUBS,
    customerCount: 14,
    customersByMonth: Object.fromEntries(monthsList.map((m, i) => [m, i >= 9 ? 2 : 1])),
    dailyRevenue,
    feesByMonth,
    feesMeasured: true,
    refundsByMonth,
    revenueByCustomer: SAMPLE_SUBS.filter((s) => s.status !== "canceled").map((s, i) => ({
      id: s.id, name: s.customerName, cents: s.mrrCents * Math.min(12, 3 + i), payments: Math.min(12, 3 + i),
    })),
    recentTransactions: [
      { kind: "in", amountCents: 184200, created: unixDaysAgo(1), label: "Stripe payout" },
      { kind: "in", amountCents: 45000, created: unixDaysAgo(2), label: "Northlake Dental · Aug" },
      { kind: "in", amountCents: 29000, created: unixDaysAgo(4), label: "Vega Co · Aug" },
      { kind: "in", amountCents: 52000, created: unixDaysAgo(6), label: "Harbor Legal · Aug" },
    ],
    invoices: [],
    truncated: false,
    fetchedAt: new Date().toISOString(),
  };
})();

/* ------------------------------------------------------------------ */

export default function Finance({ member, setSection }) {
  const [fin, setFin] = useState(null);
  const [finState, setFinState] = useState("loading"); // loading | live | waiting | sample | error
  const [expenses, setExpenses] = useState({ rows: [], sample: true });
  const [invoices, setInvoices] = useState({ rows: [], sample: true });
  const [clients, setClients] = useState({ rows: [], sample: true });
  const [settings, setSettings] = useState(null);
  const [usage, setUsage] = useState({ rows: [], sample: true });
  const [cashOpen, setCashOpen] = useState(false);
  const [cashInput, setCashInput] = useState("");
  const [savingCash, setSavingCash] = useState(false);

  const load = useCallback(async () => {
    if (!isConfigured()) {
      setFin(SAMPLE_FINANCE);
      setFinState("sample");
    } else {
      const res = await apiFetch("/api/stripe-finance");
      if (res.ok && res.data.configured) { setFin(res.data); setFinState("live"); }
      else if (res.ok) { setFin(SAMPLE_FINANCE); setFinState("waiting"); }
      else { setFin(SAMPLE_FINANCE); setFinState("error"); toast.error("Couldn't reach Stripe", res.error); }
    }
    const [e, i, c, s, u] = await Promise.all([
      listExpenses(), listInvoices(), listClients(), getFinanceSettings(), listUsage(400),
    ]);
    setExpenses(e);
    setInvoices(i);
    setClients(c);
    setSettings(s.row);
    setUsage(u);
    if (s.missing) toast.warn("Finance tables are not in the database yet", "Run supabase/migrations/0007_finance.sql — SETUP.md § Finance.");
    else if (s.error) toast.error("Couldn't read the finance settings", `${s.error} — the bank balance and the runway will read as not measured.`);
  }, []);

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  const stripeBadge = finState === "live" ? "live" : (finState === "waiting" || finState === "error") ? "waiting" : "sample";
  const s = fin || SAMPLE_FINANCE;
  /* Wrapped in useMemo, not just `|| []`: a fresh empty array every render would
   * make the big calculation below re-run on every keystroke anywhere. */
  const expenseRows = useMemo(() => expenses.rows || [], [expenses]);
  const invoiceRows = useMemo(() => invoices.rows || [], [invoices]);

  /* ---------------- everything is worked out here, once ------------- */
  const calc = useMemo(() => {
    /* ONE CALENDAR FOR THE WHOLE PAGE.
     *
     * Stripe buckets its months in UTC; a browser in Chicago buckets them
     * locally. For a few hours around the 1st of a month those two disagree
     * about which month it is, and the page was reading a month key the server
     * had never heard of — a whole month of revenue printing as $0. So the
     * server's month list is the calendar, and everything else is bucketed into
     * it. Expense dates are plain YYYY-MM-DD strings with no zone at all, so
     * they slot into either calendar the same way. */
    const monthsList = (s.months && s.months.length === 12) ? s.months : lastMonths(12);
    const thisMonth = monthsList[monthsList.length - 1];
    const prevMonth = monthsList[monthsList.length - 2];

    /* Money in, per month. The server hands back a month map that it built
     * itself — charges minus the refunds that happened in that same month —
     * so this page never re-buckets days into months. Two sides bucketing the
     * same money on two different calendars is how a boundary payment quietly
     * disappears from a total. The daily rows are only a fallback for a reply
     * that predates the month map. */
    const revenueByMonth = Object.fromEntries(monthsList.map((m) => [m, 0]));
    if (s.revenueByMonth) {
      for (const m of monthsList) revenueByMonth[m] = s.revenueByMonth[m] || 0;
    } else {
      for (const r of s.dailyRevenue || []) {
        const k = r.d.slice(0, 7);
        if (k in revenueByMonth) revenueByMonth[k] += r.cents;
      }
    }

    // Money out, per month, from what we typed in — plus Stripe's measured card
    // fees for any month where nobody typed a "Payment fees" cost. Counting a
    // cost twice is worse than missing it, so it is one or the other, never both.
    const typedByMonth = expensesByMonth(expenseRows, monthsList);
    const typedFeeMonths = new Set();
    for (const e of expenseRows.filter((x) => x.category === "Payment fees")) {
      for (const hit of expenseToMonths(e, monthsList)) typedFeeMonths.add(hit.month);
    }
    const costByMonth = {};
    const feesAdded = {};
    for (const m of monthsList) {
      const measuredFee = (s.feesByMonth || {})[m] || 0;
      const addFee = !typedFeeMonths.has(m) ? measuredFee : 0;
      feesAdded[m] = addFee;
      costByMonth[m] = (typedByMonth[m] || 0) + addFee;
    }

    const series = profitSeries(monthsList, revenueByMonth, costByMonth);
    /* The month we are in is not finished. Everything below that compares "this
     * month" with a finished one says so out loud, and the projection ignores
     * the part-month entirely. */
    const today = new Date();
    const [tmY, tmM] = thisMonth.split("-").map(Number);
    const daysThisMonth = new Date(tmY, tmM, 0).getDate();
    // How far into that month we are. If the page's calendar and the clock on
    // this laptop briefly disagree about the month (see above), fall back to
    // "the whole month" rather than printing a day count that is not true.
    const sameMonthAsClock = monthKey(today) === thisMonth;
    const daysIn = sameMonthAsClock ? today.getDate() : daysThisMonth;
    const partOfMonth = sameMonthAsClock ? `${daysIn} of ${daysThisMonth} days in` : "full month";
    const projection = projectForward(series, 3, { partialLast: true, today });
    const chartRows = [...series, ...projection.rows];

    const subs = s.subscriptions || [];
    // Trials are NOT money. They get their own line rather than being rolled
    // into a figure badged MEASURED.
    const mrr = mrrFromSubs(subs);
    const trials = trialMrr(subs);
    const arr = arrFromMrr(mrr);
    const movement = mrrMovement(subs, thisMonth, { today });
    const payingSubs = subs.filter((x) => PAYING_STATUSES.includes(x.status));
    const trialSubs = subs.filter((x) => x.status === "trialing");
    const activeSubs = [...payingSubs, ...trialSubs];
    const payingClients = payingSubs.length;

    const thisIn = revenueByMonth[thisMonth] || 0;
    const thisOut = costByMonth[thisMonth] || 0;
    const prevIn = revenueByMonth[prevMonth] || 0;
    const prevOut = costByMonth[prevMonth] || 0;
    const thisProfit = thisIn - thisOut;

    const gm = grossMargin(thisIn, expenseRows, thisMonth, { extraDeliveryCents: feesAdded[thisMonth] });
    const nm = netMargin(thisIn, thisOut);
    const arpaNow = arpa(mrr, payingClients);

    const revChurn = revenueChurnRate(movement.startMrr, movement.churnMrr);
    // New PAYING clients. A free trial that started this month is a new
    // subscription, not a new client who has paid us anything.
    const newCustomersThisMonth = movement.newPayingCount;
    const startOfMonthClients = Math.max(0, payingClients + movement.churnCount - movement.newPayingCount);
    const custChurn = churnRate(startOfMonthClients, movement.churnCount);
    const cacNow = cac(expenseRows, thisMonth, newCustomersThisMonth);
    const ltvNow = ltv(arpaNow.cents, gm.pct, custChurn.pct);
    const ltvCac = ltvToCac(ltvNow.cents, cacNow.cents);
    const payback = cacPaybackMonths(cacNow.cents, arpaNow.cents, gm.pct);
    const nrrNow = nrr({ startMrr: movement.startMrr, churnMrr: movement.churnMrr });
    const qr = quickRatio({ newMrr: movement.newMrr, churnMrr: movement.churnMrr });
    const be = breakEven(expenseRows, thisMonth, { extraVariableCents: feesAdded[thisMonth] });
    const cash = settings?.cash_on_hand_cents || 0;
    /* Runway is worked out from the last FINISHED month. This month books a full
     * month of costs on day one against however much has cleared so far, so on
     * the 2nd of the month it would report a burn that has never happened. */
    const lastFinished = series[series.length - 2] || series[series.length - 1];
    const hadActivity = Boolean(lastFinished && (lastFinished.revenue > 0 || lastFinished.cost > 0));
    const runway = runwayMonths(cash, lastFinished ? lastFinished.profit : 0, { hadActivity });

    const byCategory = expensesByCategory(expenseRows, thisMonth);
    if (feesAdded[thisMonth]) {
      byCategory["Payment fees"] = (byCategory["Payment fees"] || 0) + feesAdded[thisMonth];
    }
    const categoryRows = Object.entries(byCategory)
      .map(([label, cents]) => ({ label, cents }))
      .sort((a, b) => b.cents - a.cents);
    const vendorRows = expensesByVendor(expenseRows, thisMonth).map((v) => ({ label: v.vendor, cents: v.cents }));
    const fvRaw = fixedVsVariable(expenseRows, thisMonth);
    /* The measured card fee is a real cost that moves with the work, so it goes
     * in the variable half. Leaving it out made fixed + variable come to less
     * than "Out this month" printed two cards away. */
    const fv = {
      fixed: fvRaw.fixed,
      variable: fvRaw.variable + (feesAdded[thisMonth] || 0),
      total: fvRaw.total + (feesAdded[thisMonth] || 0),
    };

    const concentration = revenueConcentration((s.revenueByCustomer || []).map((r) => ({ label: r.name, cents: r.cents })));
    const planTotals = {};
    for (const sub of activeSubs) planTotals[sub.plan] = (planTotals[sub.plan] || 0) + sub.mrrCents;
    const planRows = Object.entries(planTotals).map(([label, cents]) => ({ label, cents })).sort((a, b) => b.cents - a.cents);

    // Invoices
    const liveInvoices = invoiceRows.filter((x) => x.status !== "void");
    const outstanding = sum(liveInvoices, invoiceOutstandingCents);
    const overdue = liveInvoices.filter((x) => effectiveInvoiceStatus(x) === "overdue");
    const dueThisWeek = liveInvoices.filter((x) => {
      const st = effectiveInvoiceStatus(x);
      if (st !== "sent" && st !== "part_paid") return false;
      if (!x.due_date) return false;
      // Whole days between two plain dates. Running a YYYY-MM-DD through
      // new Date() reads it as midnight UTC, which dropped an invoice due today.
      const diff = daysBetween(todayIso(), x.due_date);
      return diff != null && diff >= 0 && diff <= 7;
    });
    const aging = agingBuckets(invoiceRows);
    const daysToPay = avgDaysToPay(invoiceRows);
    const collected = billedVsCollected(invoiceRows);

    // AI spend, as measured by the usage feed — a cross-check on the typed cost.
    let aiMeasuredThisMonth = 0;
    for (const r of usage.rows || []) {
      const k = monthKey(new Date(r.ts));
      if (k === thisMonth) aiMeasuredThisMonth += Number(r.cost_usd || 0) * 100;
    }
    const aiTyped = byCategory["AI & APIs"] || 0;

    // Cost to serve one client this month, and per-client profit.
    const deliveryCost = DELIVERY_CATEGORIES.reduce((t, c) => t + (byCategory[c] || 0), 0);
    const costToServe = payingClients ? Math.round(deliveryCost / payingClients) : null;

    const clientCostRows = (() => {
      const byClient = {};
      for (const e of expenseRows.filter((x) => x.client_id)) {
        for (const hit of expenseToMonths(e, [thisMonth])) {
          byClient[e.client_id] = (byClient[e.client_id] || 0) + hit.cents;
        }
      }
      return Object.entries(byClient).map(([id, cents]) => ({
        label: (clients.rows || []).find((c) => c.id === id)?.name || "Unknown client",
        cents,
      })).sort((a, b) => b.cents - a.cents);
    })();

    return {
      monthsList, thisMonth, prevMonth, series, projection, chartRows,
      daysIn, daysThisMonth, partOfMonth,
      revenueByMonth, costByMonth, feesAdded,
      mrr, trials, trialSubs, arr, movement, payingClients, startOfMonthClients, subs, activeSubs, lastFinished,
      thisIn, thisOut, thisProfit, prevIn, prevOut,
      inChangePct: pctChange(prevIn, thisIn), outChangePct: pctChange(prevOut, thisOut),
      gm, nm, arpaNow, custChurn, revChurn, cacNow, ltvNow, ltvCac, payback, nrrNow, qr, be, cash, runway,
      categoryRows, vendorRows, fv, concentration, planRows,
      outstanding, overdue, dueThisWeek, aging, daysToPay, collected,
      aiMeasuredThisMonth, aiTyped, costToServe, deliveryCost, clientCostRows,
      totalIn12: sum(Object.values(revenueByMonth)),
      totalOut12: sum(Object.values(costByMonth)),
      newCustomersThisMonth,
    };
  }, [s, expenseRows, invoiceRows, settings, usage, clients]);

  const projectedMrr = useMemo(() => {
    // Where MRR lands in 3 months if it keeps moving the way money in has been.
    const g = calc.projection.growthPct;
    if (g == null) return null;
    return Math.round(calc.mrr * Math.pow(1 + g / 100, 3));
  }, [calc]);

  /* Tell the assistant what is on this page, so "why is the runway that
   * number?" can be answered without the person re-typing the figures.
   *
   * Money needs a rule the other pages do not: the SHAPE travels, not the
   * ledger. The assistant reads the real rows itself under the same role gate
   * as everything else (lib/brain-context.js), so pasting totals here would
   * add nothing and would put revenue into a prompt for anyone who can open
   * the panel. Counts and state, not amounts. */
  useScreenContext(() => ({
    page: "Finance",
    label: `the money page — ${finState === "live" ? "live figures" : finState}`,
    visible: [
      `${expenseRows.length} costs on record`,
      `${invoiceRows.length} invoices on record`,
      settings?.cash_on_hand_cents != null
        ? `cash on hand was last set on ${settings.cash_updated_on || "an unrecorded date"}`
        : "cash on hand has never been set, so runway cannot be worked out",
      projectedMrr != null ? "a 3-month projection is on screen" : "no projection is shown",
    ],
  }), [finState, expenseRows.length, invoiceRows.length, settings, projectedMrr]);

  const saveCash = async () => {
    const dollars = Number(String(cashInput).replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(dollars) || dollars < 0) { toast.error("Type a number", "For example: 12500"); return; }
    setSavingCash(true);
    const res = await saveFinanceSettings({
      cash_on_hand_cents: Math.round(dollars * 100),
      cash_updated_on: new Date().toISOString().slice(0, 10),
    });
    setSavingCash(false);
    if (!res.ok) { toast.error("Not saved", res.error); return; }
    setSettings(res.row);
    setCashOpen(false);
    toast.success("Saved", "The runway number now uses this figure.");
  };

  const money = (c) => fmtMoney(c);

  return (
    <>
      {/* ============ 1. THE HERO ============ */}
      <div className="card hero-dark adm-fin-hero">
        <div className="adm-fin-hero-glow" aria-hidden="true" />
        <div className="adm-fin-hero-grid">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="adm-fin-hero-kicker">MONTHLY RECURRING REVENUE</span>
              <SourceBadge mode={stripeBadge} hint={
                finState === "live" ? `Measured from Stripe at ${new Date(s.fetchedAt).toLocaleTimeString()}` :
                finState === "waiting" ? "Wired and waiting on STRIPE_SECRET_KEY — SETUP.md § Stripe" :
                finState === "error" ? "The Stripe key is set but the last call failed — hit Refresh" :
                "Sample numbers — preview mode"
              } />
            </div>
            <div className="adm-fin-hero-big">
              <CountUp to={calc.mrr / 100} format={(v) => `$${Number(v).toLocaleString()}`} />
              <span className="adm-fin-hero-unit">/mo</span>
            </div>
            <div className="adm-fin-hero-note">
              {calc.payingClients} paying client{calc.payingClients === 1 ? "" : "s"}.
              {calc.trials > 0
                ? ` Another ${money(calc.trials)}/mo is sitting in ${calc.trialSubs.length} trial${calc.trialSubs.length === 1 ? "" : "s"} — a promise, not money, so it is not in the figure above.`
                : ""}
            </div>
          </div>

          <div className="adm-fin-hero-cell">
            <div className="adm-fin-hero-kicker">YEARLY RUN RATE</div>
            <div className="adm-fin-hero-mid">{money(calc.arr)}</div>
            <div className="adm-fin-hero-note">This month, twelve times over.</div>
          </div>

          <div className="adm-fin-hero-cell">
            <div className="adm-fin-hero-kicker">PROJECTED MRR · +3 MONTHS</div>
            <div className="adm-fin-hero-mid adm-fin-hero-dashed">
              {projectedMrr != null ? money(projectedMrr) : "—"}
            </div>
            <div className="adm-fin-hero-note">
              {calc.projection.growthPct != null
                ? `At ${calc.projection.growthPct.toFixed(1)}% a month, from finished months only. An estimate, not a promise.`
                : "Not enough months yet to project."}
            </div>
          </div>

          <div className="adm-fin-hero-cell">
            <div className="adm-fin-hero-kicker">CASH RUNWAY</div>
            <div className="adm-fin-hero-mid">
              {calc.runway.profitable ? <>∞ <span className="adm-fin-hero-unit">profitable</span></>
                : calc.runway.months != null ? `${calc.runway.months.toFixed(1)} mo`
                : "—"}
            </div>
            <div className="adm-fin-hero-note">
              {calc.runway.profitable
                ? `More came in than went out in ${calc.lastFinished ? monthLabel(calc.lastFinished.month, { long: true }) : "the last full month"}.`
                : calc.runway.months != null
                  ? `On ${money(calc.cash)} in the bank${settings?.cash_updated_on ? `, as of ${settings.cash_updated_on}` : ""}, at ${calc.lastFinished ? monthLabel(calc.lastFinished.month, { long: true }) : "last month"}'s burn.`
                  : "Nobody has typed in what is in the bank."}
              {" "}
              <button className="adm-fin-linkbtn" onClick={() => { setCashInput(String(Math.round((calc.cash || 0) / 100))); setCashOpen(true); }}>
                Update
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ============ 2. FOUR TILES ============ */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16 }}>
        <MetricCard
          label="Paying clients"
          value={calc.payingClients}
          hint={`${calc.movement.newPayingCount} new paying this month${calc.trialSubs.length ? ` · ${calc.trialSubs.length} in trial` : ""}`}
          badge={<SourceBadge mode={stripeBadge} />}
        />
        <MetricCard
          label="Average client value"
          value={calc.arpaNow.cents != null ? `${money(calc.arpaNow.cents)}/mo` : "—"}
          hint="MRR ÷ paying clients"
          badge={<SourceBadge mode={stripeBadge} />}
        />
        <MetricCard
          label="Kept this month"
          value={money(calc.thisProfit)}
          delta={calc.nm.pct != null ? `${calc.nm.pct.toFixed(0)}% margin` : undefined}
          deltaUp={calc.thisProfit >= 0}
          hint={`${money(calc.thisIn)} in · ${money(calc.thisOut)} out · ${calc.partOfMonth}`}
          badge={<BasisBadge basis={expenses.sample ? "sample" : "mixed"} />}
        />
        <MetricCard
          label="Churned MRR"
          value={calc.movement.churnMrr ? `−${money(calc.movement.churnMrr)}` : money(0)}
          hint={`${calc.movement.churnCount} client${calc.movement.churnCount === 1 ? "" : "s"} lost this month`}
          badge={<SourceBadge mode={stripeBadge} />}
        />
      </div>

      {/* ============ 3. CHARTS + RIGHT RAIL ============ */}
      <div className="adm-fin-main">
        <div className="adm-fin-col">
          <Block
            title="Money in vs out · 12 months + 3 projected"
            blurb="Bar height is money in. The red block at the bottom is everything paid out that month. Green is what was kept. Dashed bars are months we have not lived through — they are worked out, not measured."
            right={<div style={{ display: "flex", gap: 8 }}><SourceBadge mode={stripeBadge} hint="Money in is measured from Stripe" /><BasisBadge basis={expenses.sample ? "sample" : "typed"} hint="Money out is typed into this console — the Costs section below" /></div>}
          >
            <InOutBars rows={calc.chartRows} ariaLabel="Money in and money out per month for the last 12 months, plus 3 projected months" />
            <div className="adm-fin-foot-note">{calc.projection.method}</div>
          </Block>

          <Block
            title="What was kept, month by month"
            blurb="Money in minus every cost. A bar below the line is a month that lost money."
            right={<BasisBadge basis={expenses.sample ? "sample" : "mixed"} />}
          >
            <ProfitBars rows={calc.chartRows} ariaLabel="Profit per month for the last 12 months plus 3 projected" />
          </Block>

          <Block
            title={`What moved inside MRR · ${monthLabel(calc.thisMonth, { long: true })}`}
            blurb="Where this month's recurring revenue came from and what left."
            right={<SourceBadge mode={stripeBadge} />}
          >
            <MovementBar movement={calc.movement} />
          </Block>
        </div>

        <div className="adm-fin-rail">
          <ListCard
            title="Biggest clients"
            badge={<SourceBadge mode={stripeBadge} />}
            rows={calc.activeSubs.slice().sort((a, b) => b.mrrCents - a.mrrCents).slice(0, 5).map((x) => ({
              // A trial is named as a trial here too, so the list cannot read as
              // five paying clients when one of them has not paid anything.
              key: x.id, name: x.customerName || x.plan,
              sub: x.status === "trialing" ? `${x.plan} · in trial, not paying yet` : x.plan,
              amount: `${money(x.mrrCents)}/mo`,
            }))}
            emptyText="No active subscriptions yet."
            footer={<button className="adm-fin-linkbtn" onClick={() => setSection("clients")}>{calc.payingClients} paying · see every client →</button>}
          />

          <ListCard
            title="Invoices outstanding"
            badge={<BasisBadge basis={invoices.sample ? "sample" : "typed"} />}
            rows={[
              { key: "out", name: "Owed to us", amount: money(calc.outstanding) },
              { key: "od", name: "Overdue", sub: `${calc.overdue.length} invoice${calc.overdue.length === 1 ? "" : "s"}`, amount: money(sum(calc.overdue, invoiceOutstandingCents)), color: calc.overdue.length ? MONEY_RED : undefined },
              { key: "wk", name: "Due this week", sub: `${calc.dueThisWeek.length} invoice${calc.dueThisWeek.length === 1 ? "" : "s"}`, amount: money(sum(calc.dueThisWeek, invoiceOutstandingCents)) },
            ]}
            footer={<button className="adm-fin-linkbtn" onClick={() => setSection("invoices")}>Open invoices →</button>}
          />

          <ListCard
            title="Latest money in"
            badge={<SourceBadge mode={stripeBadge} />}
            rows={(s.recentTransactions || []).slice(0, 6).map((t, i) => ({
              key: i, name: t.label, sub: timeAgo(t.created * 1000), amount: `+${money(t.amountCents)}`, color: "#006300",
            }))}
            emptyText="No payments in the last 12 months."
          />

          <ListCard
            title="Latest money out"
            badge={<BasisBadge basis={expenses.sample ? "sample" : "typed"} />}
            rows={expenseRows.slice(0, 6).map((e) => ({
              key: e.id, name: e.vendor || e.description || e.category,
              sub: `${e.category}${e.interval !== "one_time" ? ` · ${e.interval === "monthly" ? "every month" : "yearly"}` : ""}`,
              amount: `−${money(e.amount_cents)}`, color: MONEY_RED,
            }))}
            emptyText="No costs typed in yet. Add them below — the profit line is blank until you do."
          />
        </div>
      </div>

      {/* ============ 4. THE LONG VERSION ============ */}
      <div className="adm-fin-divider">
        <span>THE LONG VERSION — EVERY NUMBER, AND WHERE IT CAME FROM</span>
      </div>

      {/* ---- money in ---- */}
      <Block
        title="Money in — where it comes from"
        blurb="Measured from Stripe. Twelve months of paid charges, minus anything refunded."
        right={<SourceBadge mode={stripeBadge} />}
      >
        <FigureGrid>
          <Figure label="In this month" value={money(calc.thisIn)} basis="stripe"
            sub={`${calc.partOfMonth}${calc.inChangePct != null ? ` · ${calc.inChangePct >= 0 ? "+" : ""}${calc.inChangePct.toFixed(0)}% against all of ${monthLabel(calc.prevMonth)}` : ""}`}
            means="Every payment that cleared so far this month. The month is not over, so it is not a fair fight against a finished one." />
          <Figure label="In over 12 months" value={money(calc.totalIn12)} basis="stripe"
            means="Everything that cleared since this month last year." />
          <Figure label="Average month" value={money(Math.round(calc.totalIn12 / 12))} basis="stripe"
            means="The 12-month total, split evenly." />
          <Figure label="Biggest client's share" value={pct(calc.concentration.topSharePct, 0)} basis="stripe"
            sub={calc.concentration.rows[0] ? calc.concentration.rows[0].label : null}
            means="How much of the money comes from one client. Over 30% is a risk worth naming out loud."
            tone={calc.concentration.topSharePct > 30 ? MONEY_RED : undefined} />
          <Figure label="Clients making half the money" value={calc.concentration.clientsForHalf ?? null} basis="stripe"
            means="How few clients we would have to lose to lose half the revenue." />
          <Figure label="Refunded · 12 months" value={money(sum(Object.values(s.refundsByMonth || {})))} basis="stripe"
            means="Money handed back. Already taken out of every figure above." />
        </FigureGrid>

        <div className="adm-fin-two">
          <div>
            <div className="label" style={{ marginTop: 20, marginBottom: 10 }}>Money in by client · 12 months</div>
            <RankedBars rows={calc.concentration.rows.slice(0, 10).map((r) => ({ label: r.label, cents: r.cents }))} total={calc.concentration.total} color={MONEY_GREEN} emptyText="No paid charges yet." />
            <div className="adm-fin-foot-note">
              A refund is taken off the client it came from here, but off the month it was issued in the
              figures above. So if a refund crossed a month boundary, these two totals will not match to
              the penny. Said out loud rather than quietly rounded away.
            </div>
          </div>
          <div>
            <div className="label" style={{ marginTop: 20, marginBottom: 10 }}>Recurring revenue by plan</div>
            <RankedBars rows={calc.planRows} total={calc.mrr} emptyText="No active subscriptions yet." />
          </div>
        </div>
      </Block>

      {/* ---- money out ---- */}
      <Block
        title="Money out — where it goes"
        blurb="Typed into this console by us. Nothing outside knows what we pay, so this section is only as true as what gets entered. Card fees are the exception — Stripe measures those."
        right={<BasisBadge basis={expenses.sample ? "sample" : "typed"} />}
      >
        <FigureGrid>
          <Figure label="Out this month" value={money(calc.thisOut)} basis={expenses.sample ? "sample" : "typed"}
            sub={`${calc.partOfMonth}${calc.outChangePct != null ? ` · ${calc.outChangePct >= 0 ? "+" : ""}${calc.outChangePct.toFixed(0)}% against ${monthLabel(calc.prevMonth)}` : ""}`}
            means="Every cost that lands in this month, including a share of yearly ones." />
          <Figure label="Out over 12 months" value={money(calc.totalOut12)} basis={expenses.sample ? "sample" : "typed"}
            means="Everything paid out since this month last year." />
          <Figure label="Costs that never stop" value={money(calc.fv.fixed)} basis="typed"
            means="Software, hosting and office costs — the bill that arrives whether or not we sign a client." />
          <Figure label="Costs that move with the work" value={money(calc.fv.variable)} basis="typed"
            means="Contractors, AI, ads, client costs. These grow as we take on more." />
          <Figure label="Break even" value={money(calc.be.cents)} basis="typed"
            means="The money in we need each month just to cover every cost." />
          <Figure
            label="Card fees · this month"
            value={money(((s.feesByMonth || {})[calc.thisMonth]) || 0)}
            basis={s.feesMeasured ? "stripe" : "unknown"}
            why={s.feesMeasured ? undefined : "At least one payment did not report its fee, so this would only be part of the bill."}
            means="What Stripe took to process the payments. Measured, not the 2.9% everyone quotes." />
        </FigureGrid>

        <div className="adm-fin-two">
          <div>
            <div className="label" style={{ marginTop: 20, marginBottom: 10 }}>By category · this month</div>
            <RankedBars rows={calc.categoryRows} total={calc.thisOut} color={MONEY_RED} emptyText="No costs typed in for this month." />
          </div>
          <div>
            <div className="label" style={{ marginTop: 20, marginBottom: 10 }}>By who gets paid · this month</div>
            <RankedBars rows={calc.vendorRows} total={calc.thisOut} color={MONEY_RED} emptyText="No costs typed in for this month." />
          </div>
        </div>

        {calc.feesAdded[calc.thisMonth] === 0 && ((s.feesByMonth || {})[calc.thisMonth] || 0) > 0 && (
          <div className="adm-fin-callout">
            <strong>Card fees are counted once, not twice.</strong> Somebody typed a "Payment fees" cost
            for this month, so that typed figure is what every total uses. Stripe measured{" "}
            <strong>{money((s.feesByMonth || {})[calc.thisMonth] || 0)}</strong> — if the two are far
            apart, the typed one is the one to fix.
          </div>
        )}

        {calc.aiMeasuredThisMonth > 0 && (
          <div className="adm-fin-callout">
            <strong>Cross-check on the AI bill.</strong> The usage feed measured{" "}
            <strong>{money(Math.round(calc.aiMeasuredThisMonth))}</strong> of AI spend this month.
            You typed <strong>{money(calc.aiTyped)}</strong> in the "AI & APIs" category.
            {Math.abs(calc.aiMeasuredThisMonth - calc.aiTyped) > Math.max(2000, calc.aiTyped * 0.25)
              ? " Those are far enough apart to be worth a look — the typed figure is the one used in every number on this page."
              : " Close enough. The typed figure is the one used on this page."}
          </div>
        )}

        {calc.clientCostRows.length > 0 && (
          <>
            <div className="label" style={{ marginTop: 20, marginBottom: 10 }}>Costs booked against a client · this month</div>
            <RankedBars rows={calc.clientCostRows} total={sum(calc.clientCostRows, (r) => r.cents)} color={MONEY_RED} />
          </>
        )}
      </Block>

      {/* ---- the cost list itself ---- */}
      <ExpensesPanel
        member={member}
        rows={expenseRows}
        sample={expenses.sample}
        clients={clients.rows || []}
        onChanged={load}
      />

      {/* ---- profit ---- */}
      <Block
        title="Profit — what is actually left"
        blurb="Two margins, because they answer different questions. Gross margin is about the work; net margin is about the whole business."
        right={<BasisBadge basis={expenses.sample ? "sample" : "mixed"} />}
      >
        <FigureGrid>
          <Figure label="Kept this month" value={money(calc.thisProfit)} basis="mixed"
            tone={calc.thisProfit >= 0 ? "#006300" : MONEY_RED}
            means="Money in, minus every cost that landed this month." />
          <Figure label="Gross margin" value={pct(calc.gm.pct, 0)} basis="mixed"
            sub={calc.gm.costCents != null ? `${money(calc.gm.costCents)} of delivery cost` : null}
            means="Of every dollar in, what is left after the cost of doing the work — contractors, AI, client costs, card fees." />
          <Figure label="Net margin" value={pct(calc.nm.pct, 0)} basis="mixed"
            means="Of every dollar in, what is left after everything, software and ads included." />
          <Figure label="Cost to serve one client" value={calc.costToServe != null ? `${money(calc.costToServe)}/mo` : null} basis="mixed"
            why="Needs at least one paying client and one delivery cost typed in."
            means="Delivery costs this month, split across the paying clients." />
          <Figure label="Kept over 12 months" value={money(calc.totalIn12 - calc.totalOut12)} basis="mixed"
            means="A year of money in, minus a year of money out." />
          <Figure label="Months in the black" value={`${calc.series.filter((r) => r.profit > 0).length} of 12`} basis="mixed"
            means="How many of the last twelve months kept more than they spent." />
        </FigureGrid>
      </Block>

      {/* ---- clients ---- */}
      <Block
        title="Clients — what they cost to win, and what they are worth"
        blurb="These are the numbers investors and agency owners ask about. Every one of them is a formula on top of the two real numbers above, so each says ESTIMATE when that is what it is."
        right={<BasisBadge basis="estimate" />}
      >
        <FigureGrid>
          <Figure label="Cost to win one client" value={calc.cacNow.cents != null ? money(calc.cacNow.cents) : null}
            basis={calc.cacNow.basis} why={calc.cacNow.cents == null ? calc.cacNow.why : undefined}
            sub={calc.cacNow.cents != null ? calc.cacNow.why : null}
            means="Ad spend and anything ticked as won-us-clients this month, divided by the clients who started paying. Often written CAC." />
          <Figure label="What a client is worth" value={calc.ltvNow.cents != null ? money(calc.ltvNow.cents) : null}
            basis={calc.ltvNow.basis} why={calc.ltvNow.cents == null ? calc.ltvNow.why : undefined}
            sub={calc.ltvNow.cents != null ? calc.ltvNow.why : null}
            means="What one client brings in over their whole time with us, after delivery costs. Often written LTV." />
          <Figure label="Worth ÷ cost to win" value={ratio(calc.ltvCac.ratio)} basis={calc.ltvCac.basis}
            tone={calc.ltvCac.ratio != null ? (calc.ltvCac.ratio >= 3 ? "#006300" : MONEY_RED) : undefined}
            why="Needs both a cost to win and a worth figure."
            means="Above 3× is the usual healthy line. Below 1× means winning a client costs more than it makes." />
          <Figure label="Months to earn back a client" value={fmtMonths(calc.payback.months)} basis={calc.payback.basis}
            why="Needs a cost to win, an average client value, and a margin."
            means="How long a new client pays before they have covered what it cost to win them." />
          <Figure label="Average client value" value={calc.arpaNow.cents != null ? `${money(calc.arpaNow.cents)}/mo` : null} basis="stripe"
            means="Recurring revenue divided by the number of paying clients." />
          <Figure label="How long a client stays" value={fmtMonths(calc.ltvNow.months)} basis="estimate"
            why="Needs at least one client lost, so there is a churn rate to work from."
            means="Worked out from today's churn. One month with no losses and this cannot be answered." />
          <Figure label="Clients lost this month" value={pct(calc.custChurn.pct, 1)} basis={calc.custChurn.basis}
            sub={`${calc.movement.churnCount} of ${calc.startOfMonthClients} we started with`}
            means="The share of clients who cancelled. Often written churn." />
          <Figure label="Money lost this month" value={pct(calc.revChurn.pct, 1)} basis={calc.revChurn.basis}
            sub={calc.movement.churnMrr ? `${money(calc.movement.churnMrr)} of recurring revenue` : null}
            means="The share of recurring revenue that walked out. Losing one big client hurts more than losing two small ones — this shows that; the line above does not." />
          <Figure label="Revenue kept" value={pct(calc.nrrNow.pct, 0)} basis={calc.nrrNow.basis}
            means="Of the money we had at the start of the month, how much is still here. 100% means nothing was lost. Often written NRR." />
          <Figure label="Gained vs lost" value={ratio(calc.qr.ratio)} basis={calc.qr.basis}
            why={calc.qr.why}
            means="New money divided by lost money. Above 4× is strong growth. Often written quick ratio." />
        </FigureGrid>
        <div className="adm-fin-foot-note">
          Upgrades and downgrades are not in any of these yet. Stripe does not hand back a plan-change
          history, so a client moving from one plan to another shows up as neither gained nor lost.
          Written down here rather than quietly rolled into a number.
        </div>
      </Block>

      {/* ---- cash and invoices ---- */}
      <Block
        title="Cash — what is owed to us, and how long the money lasts"
        blurb="Invoices are ours, typed into this console. What is in the bank is typed in too, with the date it was true."
        right={<div style={{ display: "flex", gap: 8 }}>
          <BasisBadge basis={invoices.sample ? "sample" : "typed"} />
          <button className="btn btn-sm" onClick={() => setSection("invoices")}>Open invoices →</button>
        </div>}
      >
        <FigureGrid>
          <Figure label="Owed to us" value={money(calc.outstanding)} basis="typed"
            sub={`${invoiceRows.filter((x) => invoiceOutstandingCents(x) > 0).length} unpaid invoice${invoiceRows.filter((x) => invoiceOutstandingCents(x) > 0).length === 1 ? "" : "s"}`}
            means="Every invoice sent and not fully paid." />
          <Figure label="Overdue" value={money(sum(calc.overdue, invoiceOutstandingCents))} basis="typed"
            tone={calc.overdue.length ? MONEY_RED : undefined}
            sub={`${calc.overdue.length} invoice${calc.overdue.length === 1 ? "" : "s"} past the due date`}
            means="Money we should already have." />
          <Figure label="Average days to pay" value={calc.daysToPay.days != null ? `${calc.daysToPay.days.toFixed(0)} days` : null}
            basis={calc.daysToPay.basis} why="No invoice has been marked paid yet, so there is nothing to average."
            sub={calc.daysToPay.count ? `across ${calc.daysToPay.count} paid invoice${calc.daysToPay.count === 1 ? "" : "s"}` : null}
            means="From the day an invoice is sent to the day it is fully paid." />
          <Figure label="Collected" value={pct(calc.collected.collectedPct, 0)} basis="typed"
            sub={`${money(calc.collected.collectedCents)} of ${money(calc.collected.billedCents)} billed`}
            means="Of everything we have invoiced, how much has actually arrived." />
          <Figure label="In the bank" value={calc.cash ? money(calc.cash) : null} basis="typed"
            why="Nobody has typed this in yet. Use Update in the top right of this page."
            sub={settings?.cash_updated_on ? `as of ${settings.cash_updated_on}` : null}
            means="Typed in by hand. Nothing here can see a bank account." />
          <Figure label="Runway" value={calc.runway.profitable ? "No limit" : (calc.runway.months != null ? fmtMonths(calc.runway.months) : null)}
            basis={calc.runway.basis} why={calc.runway.why}
            sub={calc.lastFinished ? `worked out from ${monthLabel(calc.lastFinished.month, { long: true })}, the last finished month` : null}
            means="How long the money in the bank lasts at the last finished month's burn. This month is not used — it books a full month of costs against a part month of income." />
        </FigureGrid>

        <div className="label" style={{ marginTop: 20, marginBottom: 10 }}>How old the unpaid money is</div>
        <RankedBars
          rows={calc.aging.filter((b) => b.cents > 0).map((b) => ({
            label: `${b.label} · ${b.count}`, cents: b.cents,
            color: b.id === "current" ? "#6366f1" : MONEY_RED,
          }))}
          total={calc.aging.reduce((t, b) => t + b.cents, 0)}
          emptyText="Nothing is owed to us right now."
        />
      </Block>

      {/* ---- projection ---- */}
      <Block
        title="What happens next"
        blurb="The only guessing on this page, kept in one place and labelled."
        right={<BasisBadge basis="estimate" />}
      >
        <div className="adm-fin-callout">{calc.projection.method}</div>
        {calc.projection.rows.length > 0 && (
          <table className="adm-table" style={{ marginTop: 12 }}>
            <thead><tr><th>Month</th><th style={{ textAlign: "right" }}>Money in</th><th style={{ textAlign: "right" }}>Money out</th><th style={{ textAlign: "right" }}>Kept</th></tr></thead>
            <tbody>
              {calc.projection.rows.map((r) => (
                <tr key={r.month}>
                  <td>{monthLabel(r.month, { long: true })} <span className="adm-fin-tag">PROJECTED</span></td>
                  <td style={{ textAlign: "right" }}>{money(r.revenue)}</td>
                  <td style={{ textAlign: "right" }}>{money(r.cost)}</td>
                  <td style={{ textAlign: "right", fontWeight: 700, color: r.profit >= 0 ? "#006300" : MONEY_RED }}>{money(r.profit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>

      {/* ---- month by month table ---- */}
      <Block
        title="Every month, side by side"
        blurb="The same twelve months as the chart, as numbers you can copy."
        right={<BasisBadge basis={expenses.sample ? "sample" : "mixed"} />}
      >
        <div style={{ overflowX: "auto" }}>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Month</th>
                <th style={{ textAlign: "right" }}>Money in</th>
                <th style={{ textAlign: "right" }}>Money out</th>
                <th style={{ textAlign: "right" }}>Kept</th>
                <th style={{ textAlign: "right" }}>Margin</th>
                <th style={{ textAlign: "right" }}>Card fees</th>
              </tr>
            </thead>
            <tbody>
              {[...calc.series].reverse().map((r) => (
                <tr key={r.month}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {monthLabel(r.month, { long: true })}
                    {r.month === calc.thisMonth && <span className="adm-fin-tag" style={{ marginLeft: 6 }}>SO FAR · {calc.partOfMonth.toUpperCase()}</span>}
                  </td>
                  <td style={{ textAlign: "right" }}>{money(r.revenue)}</td>
                  <td style={{ textAlign: "right" }}>{money(r.cost)}</td>
                  <td style={{ textAlign: "right", fontWeight: 700, color: r.profit >= 0 ? "#006300" : MONEY_RED }}>{money(r.profit)}</td>
                  <td style={{ textAlign: "right" }}>{r.marginPct != null ? `${r.marginPct.toFixed(0)}%` : "—"}</td>
                  <td style={{ textAlign: "right", color: "var(--ink-dim)" }}>{money((s.feesByMonth || {})[r.month] || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>

      {/* ---- honesty table ---- */}
      <Block
        title="Where every number on this page comes from"
        blurb="Read this once and the rest of the page reads itself."
      >
        <table className="adm-table">
          <thead><tr><th>Badge</th><th>What it means</th></tr></thead>
          <tbody>
            <tr><td><BasisBadge basis="stripe" /></td><td>Measured from Stripe. Real money that moved. Nobody typed it.</td></tr>
            <tr><td><BasisBadge basis="typed" /></td><td>Typed into this console by us — a cost, an invoice, the bank balance. Only as right as what was entered.</td></tr>
            <tr><td><BasisBadge basis="mixed" /></td><td>Stripe money minus costs we typed in.</td></tr>
            <tr><td><BasisBadge basis="estimate" /></td><td>A formula on top of the numbers above. True today, wrong the moment the inputs move.</td></tr>
            <tr><td><BasisBadge basis="unknown" /></td><td>We cannot work it out yet, and the card says why instead of printing a zero.</td></tr>
            <tr><td><BasisBadge basis="sample" /></td><td>Preview data. Nothing real behind it.</td></tr>
          </tbody>
        </table>
        <div className="adm-fin-foot-note">
          Known gaps, written down rather than hidden: plan upgrades and downgrades are not tracked, so
          expansion and contraction are blank everywhere. Stripe figures cover the last twelve months
          only{s.truncated ? ", and this account is big enough that the pull was capped — some rows are missing" : ""}.
          Costs are only in here if somebody typed them in. What is in the bank is typed in by hand.
        </div>
      </Block>

      {/* ---- cash modal ---- */}
      <Modal open={cashOpen} onClose={() => setCashOpen(false)} kicker="RUNWAY" title="What is in the bank right now" width={460}
        footer={<>
          <button className="btn" onClick={() => setCashOpen(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveCash} disabled={savingCash}>{savingCash ? "Saving…" : "Save"}</button>
        </>}>
        <p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6, marginBottom: 14 }}>
          Nothing in this console can see a bank account, so this figure is typed in. The date you saved
          it is shown next to the runway number, so a stale figure cannot pass as today's.
        </p>
        <Field label="Money in the bank (dollars)" hint="Whole dollars. For example: 12500">
          <TextInput value={cashInput} onChange={(e) => setCashInput(e.target.value)} placeholder="12500" inputMode="numeric" />
        </Field>
      </Modal>
    </>
  );
}
