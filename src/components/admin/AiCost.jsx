import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScreenContext } from "../../lib/screenContext.js";
import { isConfigured } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import { getAiCost } from "../../lib/moneyApi.js";
import { timeAgo } from "./shared.jsx";
import {
  RangePicker, Tabs, Stat, SimpleTable, Card, Loading, pctText, C_PLATFORM,
} from "./moneyParts.jsx";
import { aiCostView, jobLabel, NO_ACCOUNT, CONSOLE } from "../../../lib/ai-cost-view.js";
import { presetRange, previousRange, rangeLabel, monthName, addDays } from "../../../lib/money-range.js";
import { teamDate } from "../../../lib/brain-context.js";

/* ==================================================================
 * AI COST — rebuilt 24 Sep 2026. OWNERS ONLY.
 *
 * Ryder: "for ai cost we need to make sure all usage gets a tag. so if a
 * account uses a credit it needs to be added as usage under that account. the
 * jobs i care less about but i do really want that to track as well. and also
 * we need the month by month and custom timeframes as well. make it all
 * simpler and make the important stuff stand out."
 *
 * The page answers, in this order:
 *   1. How much did AI cost us in this period, and how much of it is tied to
 *      an account?
 *   2. Which ACCOUNTS used it — with the platform's own workspace name,
 *      domain and owner email, and the credits each one spent.
 *   3. Which JOBS (tools, crons, endpoints) used it.
 *   4. Which AI services, and day by day / month by month.
 *
 * SPEED: one read of grouped rows (api/ai-cost.js → admin_ai_cost_rollup).
 * The old page read every raw row twice in the browser — ~30 s, measured
 * 12 Sep and again 24 Sep 2026 — and hung forever if any one of its eleven
 * reads failed.
 *
 * TOKENS, NOT DOLLARS (Ryder, 24 Sep 2026: "make it all based off of token
 * usage. no need for ai cost yet in dollars"). Every figure is the token
 * count the AI company's own reply carried, counted at the moment of the
 * call. No price book is involved, so nothing on this page depends on a
 * price being right. Dollars can come back later from the same rows — the
 * server still sends cost_micros.
 * ================================================================== */

const VIEWS = [
  { id: "accounts", label: "By account" },
  { id: "jobs", label: "By job" },
  { id: "services", label: "By AI service" },
  { id: "time", label: "Over time" },
];

const C_NONE = "#9eb1c7";

function n(v) { return (v || 0).toLocaleString("en-US"); }

export default function AiCost({ member }) {
  const [today, setToday] = useState(() => teamDate(Date.now()));
  const [preset, setPreset] = useState("this-month");
  const [range, setRange] = useState(() => presetRange("this-month", today));
  const [viewId, setViewId] = useState("accounts");
  const [data, setData] = useState(null);
  const [prevData, setPrevData] = useState(null);
  const [state, setState] = useState("loading");
  const [err, setErr] = useState(null);
  const [openKey, setOpenKey] = useState(null);

  /* Only the newest request may paint. Click "Last 6 months" then "This
   * month": the slow 6-month reply must not land last and overwrite the
   * month. Found by the review pass, 24 Sep 2026. */
  const seq = useRef(0);
  const load = useCallback(async (r, refresh = false) => {
    if (!isConfigured()) { setState("nokey"); return; }
    const mine = ++seq.current;
    setState((s) => (s === "live" ? "reloading" : s));
    const pr = previousRange(r);
    const [res, prev] = await Promise.all([
      getAiCost(r, { refresh, onCached: (d) => { if (mine === seq.current) { setData(d); setState("stale"); } } }),
      getAiCost(pr, { refresh }),
    ]);
    if (mine !== seq.current) return;
    if (res.ok) { setData(res.data); setState("live"); setErr(null); }
    else { setState("error"); setErr(res.error); toast.error("AI cost could not be read", res.error); }
    setPrevData(prev.ok ? prev.data : null);
  }, []);

  useEffect(() => { load(range); }, [range, load]);

  useEffect(() => {
    const onRefresh = () => { setToday(teamDate(Date.now())); load(range, true); };
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [range, load]);

  useScreenContext(() => ({
    page: "ai-cost",
    label: "AI Cost",
    visible: [`AI token use for ${rangeLabel(range)} by account, job, service and day`],
  }), [range]);

  const v = useMemo(() => (data ? aiCostView(data, range) : null), [data, range]);
  const pv = useMemo(() => (prevData ? aiCostView(prevData, previousRange(range)) : null), [prevData, range]);

  if (member?.role !== "owner") {
    return <div className="mny-page"><Card title="Owners only">AI Cost is for owners.</Card></div>;
  }

  const stateLine = state === "live" && data
    ? `Read ${timeAgo(Date.parse(data.readAt))} · ${n(data.rowCount)} calls${data.via === "scan" ? " · slow mode until migration 0041 runs" : ""}${data.cached ? " · kept for a minute" : ""}`
    : state === "stale" ? "Showing your last numbers — reading fresh ones…"
      : state === "reloading" ? "Reading…"
        : state === "error" ? `Could not read: ${err}`
          : state === "nokey" ? "Preview mode — no database." : "Reading the usage log…";

  const change = (a, b) => (b && b > 0 ? (a - b) / b : null);
  const share = (x) => pctText(v && v.total.tokens ? x / v.total.tokens : null);

  return (
    <div className="mny-page">
      <div className="mny-head">
        <div className="mny-sub">How many AI tokens we used, and which account or job used them. Owners only.</div>
        <div className="mny-head-right">
          <span className="mny-muted mny-state">{stateLine}</span>
          <button type="button" className="btn" onClick={() => { setToday(teamDate(Date.now())); load(range, true); }}>Refresh</button>
        </div>
      </div>

      <RangePicker range={range} preset={preset} today={today} onChange={(r, id) => { setRange(r); setPreset(id); setOpenKey(null); }} />

      {!v ? (
        state === "error" ? <Card title="Could not read the usage log">{err}</Card> : <Loading what="Reading the usage log…" />
      ) : (
        <>
          <div className="mny-hero">
            <Stat
              big
              label="Tokens used"
              value={tok(v.total.tokens)}
              change={change(v.total.tokens, pv?.total.tokens)}
              changeGoodWhenUp={false}
              sub={`${tok(v.total.tokensIn)} in · ${tok(v.total.tokensOut)} out · ${n(v.total.calls)} calls`}
            />
            <Stat
              big
              label="Tied to an account"
              value={pctText(v.accountShare)}
              sub={`${tok(v.accountTokens)} tokens across ${v.workspaceCount} account${v.workspaceCount === 1 ? "" : "s"}`}
            />
            <Stat
              big
              label="Credits used"
              value={v.creditsTotal ? n(v.creditsTotal) : "0"}
              sub={data.creditsVia === "none" ? "the credit ledger could not be read" : "plan tokens charged to platform accounts"}
            />
          </div>

          <div className="mny-note-line">
            {v.total.cacheRead > 0 && <><strong>{tok(v.total.cacheRead)}</strong> more tokens were read back from a cache (re-used, not new work — not in the total). </>}
            {v.total.tokenlessCalls > 0 && <><strong>{n(v.total.tokenlessCalls)}</strong> calls went to services that do not use tokens (search APIs, image tools) — counted as calls.</>}
          </div>
          {v.unnamed.after.calls > 0 && (
            <div className="mny-alert">
              <strong>{n(v.unnamed.after.calls)} calls since 23 Sep carry no job name</strong> ({tok(v.unnamed.after.tokens)} tokens).
              The platform names every call since then, so these point at something that bypasses its meter.
            </div>
          )}

          <Tabs value={viewId} onChange={setViewId} options={VIEWS} label="How to group AI use" />

          {viewId === "accounts" && (
            <Card
              title={`Accounts · ${rangeLabel(range)}`}
              note={'An account is a platform workspace (its own name, domain and owner). "No account" is the platform\'s public tools (free scan, lead capture) and our own scheduled jobs. Click an account to see its jobs and AI services.'}
            >
              <AccountTable v={v} openKey={openKey} setOpenKey={setOpenKey} share={share} />
            </Card>
          )}

          {viewId === "jobs" && (
            <Card title={`Jobs · ${rangeLabel(range)}`} note="The job is the name the platform gives the work (brand.scan), or the tool or endpoint that made the call.">
              <SimpleTable
                columns={[
                  { key: "job", label: "Job", render: (r) => <span title={r.job || ""}>{jobLabel(r.job)}</span>, sortValue: (r) => r.job || "" },
                  { key: "accountCount", label: "Accounts", num: true },
                  { key: "calls", label: "Calls", num: true, render: (r) => n(r.calls) },
                  { key: "tokens", label: "Tokens", num: true, render: (r) => (r.tokens ? tok(r.tokens) : "—") },
                  { key: "share", label: "Share", num: true, render: (r) => share(r.tokens), sortValue: (r) => r.tokens },
                ]}
                rows={v.jobs.map((j) => ({ ...j, key: j.job || "none" }))}
                total={{ job: "Total", calls: n(v.total.calls), tokens: tok(v.total.tokens) }}
              />
            </Card>
          )}

          {viewId === "services" && (
            <Card title={`AI services · ${rangeLabel(range)}`}>
              <SimpleTable
                columns={[
                  { key: "provider", label: "Service" },
                  { key: "model", label: "Model", render: (r) => r.model || "—" },
                  { key: "calls", label: "Calls", num: true, render: (r) => n(r.calls) },
                  { key: "tokensIn", label: "Tokens in", num: true, render: (r) => (r.tokens ? tok(r.tokensIn) : "—") },
                  { key: "tokensOut", label: "Tokens out", num: true, render: (r) => (r.tokens ? tok(r.tokensOut) : "—") },
                  { key: "tokens", label: "Total", num: true, render: (r) => (r.tokens ? tok(r.tokens) : <span className="mny-muted">no tokens</span>) },
                ]}
                rows={v.services.map((s) => ({ ...s, key: `${s.provider}|${s.model}` }))}
                total={{ provider: "Total", calls: n(v.total.calls), tokensIn: tok(v.total.tokensIn), tokensOut: tok(v.total.tokensOut), tokens: tok(v.total.tokens) }}
              />
            </Card>
          )}

          {viewId === "time" && (
            <Card title={v.bucket === "day" ? "Day by day" : "Month by month"}>
              <TokenBars series={v.series} bucket={v.bucket} />
              <SimpleTable
                columns={[
                  { key: "label", label: v.bucket === "day" ? "Day" : "Month", sortValue: (r) => r.key },
                  { key: "calls", label: "Calls", num: true, render: (r) => n(r.calls) },
                  { key: "tagged", label: "Accounts", num: true, render: (r) => tok(r.tagged) },
                  { key: "none", label: "No account", num: true, render: (r) => tok(r.none) },
                  { key: "total", label: "Total tokens", num: true, render: (r) => tok(r.total) },
                ]}
                rows={v.series.map((b) => ({ ...b, total: b.tagged + b.none, label: v.bucket === "day" ? b.key : monthName(b.key, { long: true }) })).reverse()}
                max={62}
              />
            </Card>
          )}

          <div className="mny-foot">
            Token counts are the ones each AI company's own reply carried, counted by us at the moment of the call. "Tokens"
            here = tokens in (including cache writes) + tokens out. Dollar cost is switched off for now. Days follow Chicago time.
            {v.unnamed.before.calls > 0 && ` ${n(v.unnamed.before.calls)} calls from before ${addDays(data.taggingSince, 0)} carry no job name — the platform started naming every call that day.`}
            {data.truncated && " The period held more rows than one read allows — pick a shorter period for exact totals."}
          </div>
        </>
      )}
    </div>
  );
}

/* 12,400,000 → "12.4M". Tokens run into the millions within days, and a
 * wall of digits is harder to compare than three characters. The exact
 * number is in the title (hover). */
function tok(x) {
  const v = Number(x) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}K`;
  return v.toLocaleString("en-US");
}

function AccountTable({ v, openKey, setOpenKey, share }) {
  const [all, setAll] = useState(false);
  const rows = all ? v.accounts : v.accounts.slice(0, 25);
  if (!v.accounts.length) return <div className="mny-empty">No AI calls in this period.</div>;
  return (
    <div className="mny-table-wrap">
      <table className="mny-table">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Credits used</th>
            <th className="num">Calls</th>
            <th className="num">Tokens in</th>
            <th className="num">Tokens out</th>
            <th className="num">Total tokens</th>
            <th className="num">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const open = openKey === a.key;
            const isNone = a.key === NO_ACCOUNT || a.key === CONSOLE;
            return [
              <tr key={a.key} className="mny-row-click" onClick={() => setOpenKey(open ? null : a.key)}>
                <td>
                  <button type="button" className="mny-rowbtn" aria-expanded={open}>
                    <span className="mny-caret">{open ? "▾" : "▸"}</span>
                    <span className="mny-dot" style={{ background: isNone ? C_NONE : C_PLATFORM }} />
                    <span>
                      <strong>{a.info.name}</strong>
                      {(a.info.domain || a.info.email || a.info.clientName) && (
                        <span className="mny-acc-sub">
                          {[a.info.domain, a.info.email, a.info.clientName ? `client: ${a.info.clientName}` : null].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </span>
                  </button>
                </td>
                <td className="num">{a.credits ? n(a.credits) : "—"}</td>
                <td className="num">{n(a.calls)}</td>
                <td className="num" title={n(a.tokensIn)}>{tok(a.tokensIn)}</td>
                <td className="num" title={n(a.tokensOut)}>{tok(a.tokensOut)}</td>
                <td className="num" title={n(a.tokens)}><strong>{tok(a.tokens)}</strong></td>
                <td className="num">{share(a.tokens)}</td>
              </tr>,
              open && (
                <tr key={`${a.key}-open`} className="mny-open-row">
                  <td colSpan={7}>
                    <div className="mny-two">
                      <div>
                        <div className="mny-mini-head">Jobs</div>
                        <SimpleTable
                          max={15}
                          columns={[
                            { key: "job", label: "Job", render: (r) => jobLabel(r.job), sortValue: (r) => r.job || "" },
                            { key: "calls", label: "Calls", num: true, render: (r) => n(r.calls) },
                            { key: "tokens", label: "Tokens", num: true, render: (r) => (r.tokens ? tok(r.tokens) : "—") },
                          ]}
                          rows={a.jobs.map((j) => ({ ...j, key: j.job || "none" }))}
                        />
                      </div>
                      <div>
                        <div className="mny-mini-head">AI services</div>
                        <SimpleTable
                          max={15}
                          columns={[
                            { key: "provider", label: "Service", render: (r) => `${r.provider}${r.model ? ` · ${r.model}` : ""}` },
                            { key: "calls", label: "Calls", num: true, render: (r) => n(r.calls) },
                            { key: "tokens", label: "Tokens", num: true, render: (r) => (r.tokens ? tok(r.tokens) : "no tokens") },
                          ]}
                          rows={a.services.map((s) => ({ ...s, key: `${s.provider}|${s.model}` }))}
                        />
                      </div>
                    </div>
                    {a.info.kind === "workspace" && (
                      <div className="mny-note">
                        Workspace id <code>{a.info.workspaceId}</code>
                        {a.info.plan ? ` · plan ${a.info.plan}` : ""}
                        {a.info.subscriptionStatus ? ` · subscription ${a.info.subscriptionStatus}` : ""}
                        {a.creditSpends ? ` · ${n(a.creditSpends)} credit charges` : ""}
                        {a.cacheRead ? ` · ${tok(a.cacheRead)} tokens read from cache` : ""}
                      </div>
                    )}
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td className="num">{v.creditsTotal ? n(v.creditsTotal) : "—"}</td>
            <td className="num">{n(v.total.calls)}</td>
            <td className="num">{tok(v.total.tokensIn)}</td>
            <td className="num">{tok(v.total.tokensOut)}</td>
            <td className="num">{tok(v.total.tokens)}</td>
            <td className="num">100%</td>
          </tr>
        </tfoot>
      </table>
      {v.accounts.length > 25 && (
        <button type="button" className="mny-more" onClick={() => setAll((x) => !x)}>{all ? "Show fewer" : `Show all ${v.accounts.length}`}</button>
      )}
    </div>
  );
}

function TokenBars({ series, bucket }) {
  const [hover, setHover] = useState(null);
  const width = 900, height = 200, pad = { l: 56, r: 12, t: 10, b: 26 };
  const innerW = width - pad.l - pad.r, innerH = height - pad.t - pad.b;
  const max = Math.max(1, ...series.map((b) => b.tagged + b.none));
  const y = (val) => pad.t + innerH - (val / max) * innerH;
  const slot = innerW / Math.max(1, series.length);
  const bw = Math.max(3, Math.min(30, slot * 0.6));
  const every = Math.max(1, Math.ceil(series.length / 12));
  const lab = (k) => (bucket === "day" ? k.slice(5) : monthName(k));
  const h = hover !== null ? series[hover] : null;
  return (
    <div className="mny-chart" style={{ marginBottom: 14 }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="AI tokens over time" preserveAspectRatio="none" style={{ height: 200 }}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={width - pad.r} y1={y(f * max)} y2={y(f * max)} stroke="var(--rule)" />
            <text x={pad.l - 8} y={y(f * max) + 4} textAnchor="end" className="mny-axis">{tok(f * max)}</text>
          </g>
        ))}
        {series.map((b, i) => {
          const x = pad.l + slot * i + (slot - bw) / 2;
          const yT = y(b.tagged);
          const yN = y(b.tagged + b.none);
          return (
            <g key={b.key} opacity={hover === null || hover === i ? 1 : 0.45}>
              {b.tagged > 0 && <rect x={x} y={yT} width={bw} height={y(0) - yT} fill={C_PLATFORM} rx="2" />}
              {b.none > 0 && <rect x={x} y={yN} width={bw} height={Math.max(0, yT - yN - (b.tagged > 0 ? 2 : 0))} fill={C_NONE} rx="2" />}
              {i % every === 0 && <text x={x + bw / 2} y={height - 8} textAnchor="middle" className="mny-axis">{lab(b.key)}</text>}
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={innerH} fill="transparent" tabIndex={0}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                aria-label={`${lab(b.key)}: ${tok(b.tagged + b.none)} tokens`} />
            </g>
          );
        })}
      </svg>
      <div className="mny-legend">
        <span><i style={{ background: C_PLATFORM }} />Tied to an account</span>
        <span><i style={{ background: C_NONE }} />No account</span>
        <span className="mny-readout">
          {h ? <><strong>{lab(h.key)}</strong> · accounts {tok(h.tagged)} · no account {tok(h.none)} · {n(h.calls)} calls</> : "Point at a bar to read it."}
        </span>
      </div>
    </div>
  );
}
