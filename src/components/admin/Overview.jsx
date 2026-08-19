import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import { listUsage, listActivity, listLeads, listTickets } from "../../lib/data.js";
import { toast } from "../../lib/toast.js";
import {
  MetricCard, SourceBadge, MoneyBars, MONEY_RED, SectionHeader, Modal,
  fmtMoney, fmtNum, timeAgo, useHealth, CountUp,
} from "./shared.jsx";

/* Overview — the command page. Revenue (Stripe), AI usage + cost (ingest
 * feed), pipeline snapshot, support snapshot, activity feed. Every card
 * carries a SourceBadge: LIVE, SAMPLE, or WAITING ON KEY. */

const SAMPLE_STRIPE = {
  configured: false,
  sample: true,
  mrrCents: 449600,
  activeSubs: 9,
  trialingSubs: 2,
  customerCount: 14,
  monthlyRevenue: (() => {
    const now = new Date();
    const rows = [];
    const base = [1200, 1450, 1800, 2300, 2100, 2900, 3300, 3050, 3800, 4100, 4300, 4496];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      rows.push({ month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, cents: base[11 - i] * 100 });
    }
    return rows;
  })(),
  // Daily version of the same twelve months, so the chart can zoom to weeks.
  // Spread with a weekday rhythm rather than flat, so weekly bars look real.
  dailyRevenue: (() => {
    const base = [1200, 1450, 1800, 2300, 2100, 2900, 3300, 3050, 3800, 4100, 4300, 4496];
    const rows = [];
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
        rows.push({
          d: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`,
          cents: Math.round((monthCents * weights[d]) / totalW),
        });
      }
    }
    return rows;
  })(),
  recentPayments: [
    { amount: 99900, currency: "usd", created: Date.now() / 1000 - 86400, description: "Radar Pro — monthly", customerEmail: "greg@sample.com" },
    { amount: 49900, currency: "usd", created: Date.now() / 1000 - 3 * 86400, description: "Pulse — monthly", customerEmail: "dana@sample.com" },
    { amount: 199900, currency: "usd", created: Date.now() / 1000 - 6 * 86400, description: "Territory — monthly", customerEmail: "j@sample.com" },
  ],
};

/* ------------------------------------------------------------------ */
/* Bucketing money into periods                                        */
/*                                                                      */
/* Both series arrive as day → cents maps and are added up into the     */
/* chosen period here, so revenue and AI spend can never end up on      */
/* different calendars. Weeks start Monday.                             */
/* ------------------------------------------------------------------ */

const RANGES = [
  { id: "week", label: "Weekly", periods: 12, note: "last 12 weeks" },
  { id: "month", label: "Monthly", periods: 12, note: "last 12 months" },
  // Four, not six: /api/stripe-metrics only pulls twelve months of charges, so
  // a fifth quarter would always draw an empty bar and read as a bad quarter.
  { id: "quarter", label: "Quarterly", periods: 4, note: "last 4 quarters" },
];

function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const back = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - back);
  return x;
}

/** The first day of each of the last n periods, oldest first. */
function periodStarts(range, n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    if (range === "week") {
      const d = startOfWeek(now);
      d.setDate(d.getDate() - i * 7);
      out.push(d);
    } else if (range === "month") {
      out.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
    } else {
      const q = Math.floor(now.getMonth() / 3) - i;
      out.push(new Date(now.getFullYear(), q * 3, 1));
    }
  }
  return out;
}

function periodEnd(range, start) {
  const d = new Date(start);
  if (range === "week") d.setDate(d.getDate() + 7);
  else if (range === "month") d.setMonth(d.getMonth() + 1);
  else d.setMonth(d.getMonth() + 3);
  return d;
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function periodLabel(range, start) {
  if (range === "week") return start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (range === "month") return start.toLocaleDateString("en-US", { month: "short" });
  return `Q${Math.floor(start.getMonth() / 3) + 1} ${String(start.getFullYear()).slice(2)}`;
}

function periodTip(range, start) {
  if (range === "week") {
    const end = new Date(periodEnd(range, start).getTime() - 86400000);
    return `week of ${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  }
  if (range === "month") return start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return `Q${Math.floor(start.getMonth() / 3) + 1} ${start.getFullYear()}`;
}

/** [{label, tipLabel, revenue, cost}] in cents, oldest first. */
function buildMoneySeries(range, revenueByDay, costByDay) {
  const cfg = RANGES.find((r) => r.id === range) || RANGES[1];
  return periodStarts(range, cfg.periods).map((start) => {
    const end = periodEnd(range, start);
    let revenue = 0;
    let cost = 0;
    for (const d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const k = dayKey(d);
      revenue += revenueByDay[k] || 0;
      cost += costByDay[k] || 0;
    }
    return {
      label: periodLabel(range, start),
      tipLabel: periodTip(range, start),
      revenue: Math.round(revenue),
      cost: Math.round(cost),
    };
  });
}

export default function Overview({ member, setSection }) {
  const health = useHealth();
  const [stripe, setStripe] = useState(null);
  const [stripeState, setStripeState] = useState("loading"); // loading | live | waiting | sample | error
  const [usage, setUsage] = useState({ rows: [], sample: true });
  const [costByDay, setCostByDay] = useState({});
  const [range, setRange] = useState("month");
  const [activity, setActivity] = useState({ rows: [], sample: true });
  const [leadStats, setLeadStats] = useState(null);
  const [ticketStats, setTicketStats] = useState(null);
  const [ingestOpen, setIngestOpen] = useState(false);

  const load = useCallback(async () => {
    // Stripe
    if (!isConfigured()) {
      setStripe(SAMPLE_STRIPE);
      setStripeState("sample");
    } else {
      const res = await apiFetch("/api/stripe-metrics");
      if (res.ok && res.data.configured) { setStripe(res.data); setStripeState("live"); }
      else if (res.ok && !res.data.configured) { setStripe(SAMPLE_STRIPE); setStripeState("waiting"); }
      else { setStripe(SAMPLE_STRIPE); setStripeState("error"); toast.error("Couldn't reach Stripe", res.error); }
    }
    // The rest
    // A year of usage, because the money chart can zoom out to six quarters.
    // The 30-day tiles above still read from the same rows, filtered.
    const [u, a, l, t] = await Promise.all([listUsage(400), listActivity(12), listLeads(), listTickets()]);
    setUsage(u);
    // Roll every usage event into day → cents once, here at load time, so the
    // chart can re-bucket instantly when the filter changes and render stays pure.
    const byDay = {};
    for (const r of u.rows) {
      const t2 = new Date(r.ts);
      if (Number.isNaN(t2.getTime())) continue;
      const k = `${t2.getFullYear()}-${String(t2.getMonth() + 1).padStart(2, "0")}-${String(t2.getDate()).padStart(2, "0")}`;
      byDay[k] = (byDay[k] || 0) + Number(r.cost_usd || 0) * 100;
    }
    setCostByDay(byDay);
    setActivity(a);
    const leads = l.rows;
    const now = new Date();
    const sameMonth = (iso) => {
      if (!iso) return false;
      const d = new Date(iso);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    };
    setLeadStats({
      sample: l.sample,
      newCount: leads.filter((x) => x.stage === "new").length,
      working: leads.filter((x) => ["contacted", "follow_up", "meeting", "proposal"].includes(x.stage)).length,
      // "Won this month" = the lead's last activity (the stage change to won)
      // landed this calendar month — year-aware, not created-date based.
      wonThisMonth: leads.filter((x) => x.stage === "won" && sameMonth(x.last_activity_at || x.created_at)).length,
    });
    const tickets = t.rows;
    setTicketStats({
      sample: t.sample,
      open: tickets.filter((x) => x.status === "open").length,
      pending: tickets.filter((x) => x.status === "pending").length,
    });
  }, []);

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  // Usage aggregates (last 30 days)
  const totalIn = usage.rows.reduce((s, r) => s + (r.input_tokens || 0), 0);
  const totalOut = usage.rows.reduce((s, r) => s + (r.output_tokens || 0), 0);
  const totalCost = usage.rows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  const usageMode = usage.sample ? "sample" : (usage.rows.length ? "live" : (health?.usageIngest ? "live" : "waiting"));

  const stripeBadgeMode = stripeState === "live" ? "live" : stripeState === "waiting" || stripeState === "error" ? "waiting" : "sample";
  const s = stripe || SAMPLE_STRIPE;

  // Revenue day map, from whichever source answered. Falls back to spreading
  // the monthly buckets evenly if a live Stripe reply predates dailyRevenue.
  const revenueByDay = {};
  if (s.dailyRevenue?.length) {
    for (const r of s.dailyRevenue) revenueByDay[r.d] = (revenueByDay[r.d] || 0) + r.cents;
  } else {
    for (const m of s.monthlyRevenue || []) {
      const [y, mm] = m.month.split("-").map(Number);
      const days = new Date(y, mm, 0).getDate();
      for (let d = 1; d <= days; d++) {
        revenueByDay[`${y}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`] = Math.round(m.cents / days);
      }
    }
  }
  const rangeCfg = RANGES.find((r) => r.id === range) || RANGES[1];
  const moneySeries = buildMoneySeries(range, revenueByDay, costByDay);

  return (
    <>
      {/* Revenue hero */}
      <div className="card hero-dark" style={{ padding: "28px 30px", background: "linear-gradient(135deg, #0a2245 0%, #1e1b4b 60%, #312e81 100%)", border: 0, color: "white", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -120, right: -80, width: 380, height: 380, borderRadius: "50%", background: "radial-gradient(circle, rgba(139,92,246,0.35), transparent 65%)", filter: "blur(30px)" }} aria-hidden="true" />
        <div style={{ position: "relative", display: "flex", justifyContent: "space-between", gap: 24, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: "rgba(255,255,255,0.6)" }}>
                MONTHLY RECURRING REVENUE
              </span>
              <SourceBadge mode={stripeBadgeMode} hint={
                stripeState === "live" ? (s.fetchedAt ? `Measured from Stripe at ${new Date(s.fetchedAt).toLocaleTimeString()}` : "Measured from Stripe just now") :
                stripeState === "waiting" ? "Wired and waiting on STRIPE_SECRET_KEY — SETUP.md § Stripe (5 minutes)" :
                stripeState === "error" ? "Stripe key is set but the last call failed — hit Refresh" :
                "Sample numbers — preview mode"
              } />
              {stripeState === "live" && s.livemode === false && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, fontWeight: 800, letterSpacing: "0.1em", color: "#fbbf24" }}>TEST-MODE KEY</span>
              )}
            </div>
            <div style={{ fontFamily: "var(--display)", fontSize: 52, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.05, marginTop: 10 }}>
              <CountUp to={(s.mrrCents || 0) / 100} format={(v) => `$${Number(v).toLocaleString()}`} />
              <span style={{ fontSize: 20, fontWeight: 600, color: "rgba(255,255,255,0.55)" }}> /mo</span>
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 18, flexWrap: "wrap", fontSize: 13, color: "rgba(255,255,255,0.75)" }}>
              <span><strong style={{ color: "white" }}>{s.activeSubs}</strong> active subscriptions</span>
              <span><strong style={{ color: "white" }}>{s.trialingSubs || 0}</strong> in trial</span>
              <span><strong style={{ color: "white" }}>{s.customerCount}</strong> customers</span>
              {s.truncated && <span style={{ color: "#fbbf24" }}>large account — totals capped at first 1,000 rows</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <a className="btn" style={{ textDecoration: "none" }} href="https://dashboard.stripe.com" target="_blank" rel="noopener noreferrer">
              Open Stripe <span className="arr">→</span>
            </a>
          </div>
        </div>
      </div>

      {/* Metric tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16 }}>
        <MetricCard
          label="AI spend · 30 days"
          value={`$${totalCost.toFixed(2)}`}
          hint={`${fmtNum(totalIn + totalOut)} tokens`}
          badge={<SourceBadge mode={usageMode} hint={usageMode === "waiting" ? "Screen is wired — goes live when the platform posts usage to /api/usage-ingest (SETUP.md § Token usage)" : undefined} />}
        />
        <MetricCard
          label="Tokens in / out · 30 days"
          value={`${fmtNum(totalIn)} / ${fmtNum(totalOut)}`}
          hint={usage.rows.length ? `${usage.rows.length} events` : "no events yet"}
          badge={<SourceBadge mode={usageMode} />}
        />
        <MetricCard
          label="Pipeline"
          value={leadStats ? `${leadStats.newCount + leadStats.working}` : "—"}
          hint={leadStats ? `${leadStats.newCount} new · ${leadStats.working} working · ${leadStats.wonThisMonth} won this mo` : ""}
          badge={leadStats && <SourceBadge mode={leadStats.sample ? "sample" : "live"} />}
        />
        <MetricCard
          label="Support"
          value={ticketStats ? `${ticketStats.open}` : "—"}
          hint={ticketStats ? `open tickets · ${ticketStats.pending} pending` : ""}
          badge={ticketStats && <SourceBadge mode={ticketStats.sample ? "sample" : "live"} />}
        />
      </div>

      {/* ---- Money: revenue with AI spend inside it ---- */}
      <div className="card" style={{ padding: 22 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="label" style={{ marginBottom: 0 }}>Money in vs AI spend · {rangeCfg.note}</div>
              <SourceBadge mode={stripeBadgeMode} hint={stripeBadgeMode === "live" ? "Revenue measured from Stripe" : "Sample numbers until the Stripe key is set"} />
              <SourceBadge mode={usageMode} hint={usageMode === "live" ? "AI spend measured from the usage feed" : "AI spend goes live when the platform posts to /api/usage-ingest"} />
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-dim)", marginTop: 5, lineHeight: 1.5, maxWidth: 620 }}>
              Green is what was left after the AI bill. It is <strong>not</strong> full profit — wages,
              software and ad spend are not in here, only what we paid for AI.
            </div>
          </div>
          {/* Filters sit in one row above the chart */}
          <div className="aia-tabs" role="tablist" aria-label="Time range" style={{ padding: 4 }}>
            {RANGES.map((r) => (
              <button
                key={r.id}
                role="tab"
                aria-selected={range === r.id}
                onClick={() => setRange(r.id)}
                className={`aia-tab ${range === r.id ? "active" : ""}`}
                style={{ padding: "7px 13px", fontSize: 12.5 }}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {usage.rows.length || usage.sample ? (
          <>
            <MoneyBars
              data={moneySeries}
              height={230}
              ariaLabel={`Money in and AI spend per ${range} for the ${rangeCfg.note}`}
            />
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 14, alignItems: "center" }}>
              <button className="link-btn" style={{ background: "none", border: 0, color: "var(--accent-deep)", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }} onClick={() => setIngestOpen(true)}>
                How usage gets in here →
              </button>
              {moneySeries.some((d) => d.cost > d.revenue) && (
                <span style={{ fontSize: 12, color: MONEY_RED, fontWeight: 600 }}>
                  A dashed outline means AI cost more than came in that {range}.
                </span>
              )}
            </div>
          </>
        ) : (
          <div style={{ padding: "24px 8px", textAlign: "center" }}>
            <div style={{ fontSize: 13.5, color: "var(--ink-dim)", lineHeight: 1.6 }}>
              Revenue is here, but no AI usage has been reported yet, so there is nothing to
              subtract. The chart fills in as soon as the platform posts token usage to the feed.
            </div>
            <button className="btn" style={{ marginTop: 12 }} onClick={() => setIngestOpen(true)}>
              How the feed works
            </button>
          </div>
        )}
      </div>

      {/* Recent payments + activity */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16 }} className="adm-charts-row">
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "16px 20px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="label" style={{ marginBottom: 0 }}>Recent payments</div>
            <SourceBadge mode={stripeBadgeMode} />
          </div>
          {(s.recentPayments || []).length ? (
            <table className="adm-table">
              <thead><tr><th>When</th><th>Customer</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
              <tbody>
                {s.recentPayments.map((p, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 11 }}>{timeAgo(p.created * 1000)}</td>
                    <td style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 }}>{p.customerEmail || p.description || "—"}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: "var(--ink)" }}>
                      {fmtMoney(p.amount, p.currency)}{p.refunded ? <span style={{ color: "var(--danger)", fontSize: 10, marginLeft: 6, fontFamily: "var(--mono)" }}>PARTIAL REFUND</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: "10px 20px 20px", fontSize: 13, color: "var(--ink-dim)" }}>No payments in the last 12 months.</div>
          )}
        </div>

        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "16px 20px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="label" style={{ marginBottom: 0 }}>Team activity</div>
            {activity && <SourceBadge mode={activity.sample ? "sample" : "live"} />}
          </div>
          <div style={{ padding: "4px 20px 16px", maxHeight: 320, overflowY: "auto" }}>
            {activity.rows.length ? activity.rows.map((a) => (
              <div key={a.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--rule)" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{a.title}</div>
                {a.body && <div style={{ fontSize: 12, color: "var(--ink-dim)", marginTop: 2 }}>{a.body}</div>}
                <div style={{ fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--mono)", marginTop: 4, letterSpacing: "0.04em" }}>{timeAgo(a.created_at).toUpperCase()}</div>
              </div>
            )) : (
              <div style={{ padding: "16px 0", fontSize: 13, color: "var(--ink-dim)" }}>
                Nothing logged yet. Calls, task updates, and imports land here automatically as the team works.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick jumps */}
      <SectionHeader kicker="Jump in" title="Where the work happens" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginTop: -8 }}>
        {[
          ["leads", "Leads", "Work the pipeline, log calls, import lists."],
          ["operations", "Operations", "Clients, tasks, and weekly logs — the Notion replacement."],
          ["inbox", "Inbox", "Team Gmail with AI drafting."],
          ["tickets", "Tickets", "Support queue with AI-drafted replies."],
        ].filter(([id]) => member.role !== "sales" || id === "leads").map(([id, title, body]) => (
          <button key={id} onClick={() => setSection(id)} className="card" style={{ padding: 18, textAlign: "left", cursor: "pointer", border: "1px solid var(--rule)", background: "white", fontFamily: "var(--body)" }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--ink)" }}>{title} <span style={{ color: "var(--accent-deep)" }}>→</span></div>
            <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 4, lineHeight: 1.5 }}>{body}</div>
          </button>
        ))}
      </div>

      {/* Ingest explainer modal */}
      <Modal open={ingestOpen} onClose={() => setIngestOpen(false)} kicker="TOKEN USAGE FEED" title="How usage numbers get in here" width={620}>
        <p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
          The platform's backend posts every AI call it makes to this console. One HTTP call, one
          shared secret. Until that's wired, this panel says WAITING ON KEY — it never guesses.
        </p>
        <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: "var(--ink)", color: "#d6e4ff", fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.7, overflowX: "auto" }}>
          POST https://&lt;admin-domain&gt;/api/usage-ingest<br />
          Header: x-ingest-key: &lt;USAGE_INGEST_KEY&gt;<br />
          {"Body: { \"events\": [ { \"ts\": \"2026-08-16T12:00:00Z\", \"source\": \"caite\","}<br />
          {"  \"model\": \"claude-sonnet-4-6\", \"input_tokens\": 1200,"}<br />
          {"  \"output_tokens\": 480, \"cost_usd\": 0.0125 } ] }"}
        </div>
        <p style={{ fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.6, marginTop: 12 }}>
          The console's own AI drafts already report themselves this way (source: "admin"), so
          the moment the Anthropic key is set you'll see real numbers here from your own usage —
          before the platform feed even exists.
        </p>
      </Modal>
    </>
  );
}
