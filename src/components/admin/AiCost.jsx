import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScreenContext } from "../../lib/screenContext.js";
import { isConfigured } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import { getAiCost } from "../../lib/moneyApi.js";
import { timeAgo } from "./shared.jsx";
import {
  RangePicker, Tabs, Stat, SimpleTable, Card, Loading, pctText, C_PLATFORM,
} from "./moneyParts.jsx";
import { aiCostView, explain as explain2, NO_ACCOUNT, CONSOLE } from "../../../lib/ai-cost-view.js";
import { jobInfo, serviceName } from "../../../lib/ai-job-names.js";
import { monthRange, previousRange, rangeLabel, monthName } from "../../../lib/money-range.js";
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

/* Plain English, 25 Sep 2026 (Ryder: "i dont want to read code, i want to
 * read english"). */
const VIEWS = [
  { id: "accounts", label: "Who used it" },
  { id: "jobs", label: "What it was used for" },
  { id: "services", label: "Which AI" },
  { id: "time", label: "Over time" },
];

const C_NONE = "#9eb1c7";

function n(v) { return (v || 0).toLocaleString("en-US"); }

export default function AiCost({ member }) {
  const [today, setToday] = useState(() => teamDate(Date.now()));
  const [preset, setPreset] = useState(() => `m:${today.slice(0, 7)}`);
  const [range, setRange] = useState(() => monthRange(today.slice(0, 7), today));
  /* Month bars unless someone asks for days (Ryder, 24 Sep 2026). */
  const [timeMode, setTimeMode] = useState("month");
  const [earliest, setEarliest] = useState(null);
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
    if (res.ok) { setData(res.data); setState("live"); setErr(null); if (res.data.earliest) setEarliest(res.data.earliest); }
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
  /* The over-time view: months of the picked period by default, days on request. */
  const tv = useMemo(() => (data ? aiCostView(data, range, { bucket: timeMode }) : null), [data, range, timeMode]);
  const pv = useMemo(() => (prevData ? aiCostView(prevData, previousRange(range)) : null), [prevData, range]);

  if (member?.role !== "owner") {
    return <div className="mny-page"><Card title="Owners only">AI Cost is for owners.</Card></div>;
  }

  const stateLine = state === "live" && data
    ? `Read ${timeAgo(Date.parse(data.readAt))} · ${n(data.rowCount)} log rows${data.via === "scan" ? " · slow mode until migration 0041 runs" : ""}${data.cached ? " · kept for a minute" : ""}`
    : state === "stale" ? "Showing your last numbers — reading fresh ones…"
      : state === "reloading" ? "Reading…"
        : state === "error" ? `Could not read: ${err}`
          : state === "nokey" ? "Preview mode — no database." : "Reading the usage log…";

  const change = (a, b) => (b && b > 0 ? (a - b) / b : null);
  const share = (x) => pctText(v && v.total.tokens ? x / v.total.tokens : null);

  return (
    <div className="mny-page">
      <div className="mny-head">
        <div className="mny-sub">How much AI work we used, who used it, and what for. Owners only.</div>
        <div className="mny-head-right">
          <span className="mny-muted mny-state">{stateLine}</span>
          <button type="button" className="btn" onClick={() => { setToday(teamDate(Date.now())); load(range, true); }}>Refresh</button>
        </div>
      </div>

      <RangePicker range={range} preset={preset} today={today} earliest={earliest} onChange={(r, id) => { setRange(r); setPreset(id); setOpenKey(null); }} />

      {!v ? (
        state === "error" ? <Card title="Could not read the usage log">{err}</Card> : <Loading what="Reading the usage log…" />
      ) : (
        <>
          <div className="mny-hero">
            <Stat
              big
              label="AI work used (tokens)"
              value={tok(v.total.tokens)}
              change={change(v.total.tokens, pv?.total.tokens)}
              changeGoodWhenUp={false}
              sub={`${n(v.total.calls)} requests to an AI · a token is about ¾ of a word`}
            />
            <Stat
              big
              label="Used by a named account"
              value={pctText(v.accountShare)}
              sub={`${tok(v.accountTokens)} tokens across ${v.workspaceCount} account${v.workspaceCount === 1 ? "" : "s"} · the rest is public tools and our own scheduled jobs`}
            />
            <Stat
              big
              label="Credits charged"
              value={v.creditsTotal ? n(v.creditsTotal) : "0"}
              sub={data.creditsVia === "none" ? "the credit ledger could not be read" : "credits the platform recorded against accounts for this work"}
            />
          </div>

          {v.outliers.map((a) => (
            <Outlier key={a.key} a={a} onOpen={() => { setViewId("accounts"); setOpenKey(a.key); }} />
          ))}

          <div className="mny-note-line">
            {v.total.tokenlessCalls > 0 && <><strong>{n(v.total.tokenlessCalls)}</strong> requests went to search tools that don&apos;t use tokens (like Google search results) — they are counted as requests only. </>}
            {v.total.cacheRead > 0 && <><strong>{tok(v.total.cacheRead)}</strong> tokens were re-used from memory (cache) and are not in the total.</>}
          </div>

          <Tabs value={viewId} onChange={setViewId} options={VIEWS} label="How to group AI use" />

          {viewId === "accounts" && (
            <Card
              title={`Who used it · ${rangeLabel(range)}`}
              note={'Each account is a workspace on our platform — a customer\'s, or one of ours. "No account" is the platform\'s free public tools (like the free scan on our website) and our own scheduled jobs. Click any row to see exactly what it was used for.'}
            >
              <AccountTable v={v} openKey={openKey} setOpenKey={setOpenKey} share={share} />
            </Card>
          )}

          {viewId === "jobs" && (
            <Card title={`What it was used for · ${rangeLabel(range)}`} note="Every job the AI did in this period, biggest first. Hover a name to see what it does.">
              <SimpleTable
                columns={[
                  { key: "job", label: "What the AI was doing", render: (r) => <JobName job={r.job} />, sortValue: (r) => jobInfo(r.job).name },
                  { key: "accountCount", label: "Accounts", num: true },
                  { key: "calls", label: "Requests", num: true, render: (r) => n(r.calls) },
                  { key: "failed", label: "Failed", num: true, render: (r) => (r.failed ? <span className="mny-bad">{n(r.failed)}</span> : "—") },
                  { key: "tokens", label: "Tokens", num: true, render: (r) => (r.tokens ? tok(r.tokens) : "—") },
                  { key: "share", label: "Share", num: true, render: (r) => share(r.tokens), sortValue: (r) => r.tokens },
                ]}
                rows={v.jobs.map((j) => ({ ...j, key: j.job || "none" }))}
                total={{ job: "Total", calls: n(v.total.calls), failed: v.total.failed ? n(v.total.failed) : "—", tokens: tok(v.total.tokens) }}
              />
            </Card>
          )}

          {viewId === "services" && (
            <Card title={`Which AI · ${rangeLabel(range)}`} note="Which AI company and model did the work. Search tools show requests only — they don't use tokens.">
              <SimpleTable
                columns={[
                  { key: "name", label: "AI", render: (r) => serviceName(r.provider, r.model), sortValue: (r) => serviceName(r.provider, r.model) },
                  { key: "calls", label: "Requests", num: true, render: (r) => n(r.calls) },
                  { key: "failed", label: "Failed", num: true, render: (r) => (r.failed ? <span className="mny-bad">{n(r.failed)}</span> : "—") },
                  { key: "tokens", label: "Tokens", num: true, render: (r) => (r.tokens ? tok(r.tokens) : <span className="mny-muted">no tokens</span>) },
                  { key: "share", label: "Share", num: true, render: (r) => share(r.tokens), sortValue: (r) => r.tokens },
                ]}
                rows={v.services.map((x) => ({ ...x, key: `${x.provider}|${x.model}` }))}
                total={{ name: "Total", calls: n(v.total.calls), tokens: tok(v.total.tokens) }}
              />
            </Card>
          )}

          {viewId === "time" && (
            <Card
              title={timeMode === "day" ? "Day by day" : "Month by month"}
              right={<Tabs value={timeMode} onChange={setTimeMode} label="Group by" options={[{ id: "month", label: "By month" }, { id: "day", label: "By day" }]} />}
            >
              <TokenBars series={tv.series} bucket={tv.bucket} />
              <SimpleTable
                columns={[
                  { key: "label", label: tv.bucket === "day" ? "Day" : "Month", sortValue: (r) => r.key },
                  { key: "calls", label: "Requests", num: true, render: (r) => n(r.calls) },
                  { key: "tagged", label: "Named accounts", num: true, render: (r) => tok(r.tagged) },
                  { key: "none", label: "No account", num: true, render: (r) => tok(r.none) },
                  { key: "total", label: "All tokens", num: true, render: (r) => tok(r.total) },
                ]}
                rows={tv.series.map((b) => ({ ...b, total: b.tagged + b.none, label: tv.bucket === "day" ? b.key : monthName(b.key, { long: true }) })).reverse()}
                max={62}
              />
            </Card>
          )}

          <div className="mny-foot">
            Token counts come from each AI company&apos;s own reply, counted the moment the request was made. Dollar cost is
            switched off for now. Days follow Chicago time.
            {v.unnamed.before.calls > 0 && ` ${n(v.unnamed.before.calls)} requests from before ${shortDay(data.taggingSince)} are marked "not labelled" — the platform started naming every job that day.`}
            {data.truncated && " The period held more rows than one read allows — pick a shorter period for exact totals."}
          </div>
        </>
      )}
    </div>
  );
}

/* A job's plain-English name, with what it does on hover and the platform's
 * own key underneath for anyone matching this to the code. */
function JobName({ job }) {
  const j = jobInfo(job);
  return (
    <span className="mny-job" title={j.what}>
      <span className="mny-job-name">{j.name}</span>
      {j.raw && <span className="mny-job-raw">{j.raw}</span>}
    </span>
  );
}

function shortDay(d) {
  if (!d) return "";
  const [, m, day] = d.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${day}`;
}

function daySpan(st) {
  if (!st.firstDay) return "";
  return st.firstDay === st.lastDay ? `on ${shortDay(st.firstDay)}` : `between ${shortDay(st.firstDay)} and ${shortDay(st.lastDay)}`;
}

/* The one paragraph that says what an account's AI went on. */
function Story({ a }) {
  const st = a.story;
  const top = jobInfo(st.topJob);
  const who = a.info.kind === "none" ? "Public tools and our own scheduled jobs" : `${a.info.name}'s account${a.info.domain ? ` (website: ${a.info.domain})` : ""}`;
  return (
    <p className="mny-story">
      {who} used <strong>{tok(a.tokens)} tokens</strong> across <strong>{n(a.calls)} AI requests</strong> {daySpan(st)}
      {a.share !== null && <> — <strong>{pctText(a.share)}</strong> of all AI use in this period</>}.
      {st.topJob !== undefined && st.topJobShare !== null && (
        <> <strong>{pctText(st.topJobShare)}</strong> of it was <strong>{top.name}</strong> ({n(st.topJobCalls)} requests). <span className="mny-muted">{top.what}</span></>
      )}
      {st.busiestDay && st.days.length > 1 && <> The busiest day was <strong>{shortDay(st.busiestDay)}</strong> ({tok(st.busiestDayTokens)} tokens).</>}
      {a.failed > 0 && (
        <> <span className={st.failedShare >= 0.2 ? "mny-bad" : ""}><strong>{n(a.failed)}</strong> requests failed ({pctText(st.failedShare)})</span>
          {st.failedShare >= 0.2 ? " — a high failure rate, so something went wrong while this ran." : "."}</>
      )}
      {a.credits > 0 && <> The platform recorded <strong>{n(a.credits)} credits</strong> for this work.</>}
    </p>
  );
}

function Outlier({ a, onOpen }) {
  const top = jobInfo(a.story.topJob);
  return (
    <div className="mny-alert mny-outlier">
      <div>
        <strong>{a.info.name} used {pctText(a.share)} of all AI this period</strong> — more than twice anyone else.
        {" "}Mostly <strong>{top.name}</strong> {daySpan(a.story)}
        {a.failed > 0 && <>, and {n(a.failed)} of the requests failed</>}.
      </div>
      <button type="button" className="btn" onClick={onOpen}>Show what it was spent on</button>
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
  if (!v.accounts.length) return <div className="mny-empty">No AI use in this period.</div>;
  return (
    <div className="mny-table-wrap">
      <table className="mny-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Mostly used for</th>
            <th className="num">Requests</th>
            <th className="num">Failed</th>
            <th className="num">Tokens</th>
            <th className="num">Share</th>
            <th className="num">Credits charged</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const open = openKey === a.key;
            const isNone = a.key === NO_ACCOUNT || a.key === CONSOLE;
            const top = a.story.topJob !== null || a.jobs.length ? jobInfo(a.story.topJob) : null;
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
                <td title={top?.what}>{top ? top.name : "—"}{a.story.topJobShare !== null && a.jobs.length > 1 ? <span className="mny-muted"> · {pctText(a.story.topJobShare)}</span> : null}</td>
                <td className="num">{n(a.calls)}</td>
                <td className="num">{a.failed ? <span className={a.story.failedShare >= 0.2 ? "mny-bad" : ""}>{n(a.failed)}</span> : "—"}</td>
                <td className="num" title={`${n(a.tokens)} tokens`}><strong>{tok(a.tokens)}</strong></td>
                <td className="num">{share(a.tokens)}</td>
                <td className="num">{a.credits ? n(a.credits) : "—"}</td>
              </tr>,
              open && (
                <tr key={`${a.key}-open`} className="mny-open-row">
                  <td colSpan={7}>
                    <Story a={a} />
                    <div className="mny-mini-head">What it was spent on</div>
                    <SimpleTable
                      max={20}
                      columns={[
                        { key: "job", label: "What the AI was doing", render: (r) => <JobName job={r.job} />, sortValue: (r) => jobInfo(r.job).name },
                        { key: "days", label: "When", render: (r) => daySpan(explain2(r)).replace(/^on |^between /, ""), sortValue: (r) => Object.keys(r.days || {}).sort()[0] || "" },
                        { key: "calls", label: "Requests", num: true, render: (r) => n(r.calls) },
                        { key: "failed", label: "Failed", num: true, render: (r) => (r.failed ? <span className="mny-bad">{n(r.failed)}</span> : "—") },
                        { key: "tokens", label: "Tokens", num: true, render: (r) => (r.tokens ? tok(r.tokens) : "—") },
                        { key: "share", label: "Of this account", num: true, render: (r) => (a.tokens ? pctText(r.tokens / a.tokens) : "—"), sortValue: (r) => r.tokens },
                      ]}
                      rows={a.jobs.map((j) => ({ ...j, key: j.job || "none" }))}
                    />
                    <div className="mny-mini-head">Which AI did the work</div>
                    <SimpleTable
                      max={10}
                      columns={[
                        { key: "name", label: "AI", render: (r) => serviceName(r.provider, r.model), sortValue: (r) => serviceName(r.provider, r.model) },
                        { key: "calls", label: "Requests", num: true, render: (r) => n(r.calls) },
                        { key: "failed", label: "Failed", num: true, render: (r) => (r.failed ? <span className="mny-bad">{n(r.failed)}</span> : "—") },
                        { key: "tokens", label: "Tokens", num: true, render: (r) => (r.tokens ? tok(r.tokens) : "no tokens") },
                      ]}
                      rows={a.services.map((x) => ({ ...x, key: `${x.provider}|${x.model}` }))}
                    />
                    {a.info.kind === "workspace" && (
                      <div className="mny-note">
                        {a.info.plan ? `Plan: ${a.info.plan}` : "No plan on file"}
                        {a.info.subscriptionStatus ? ` · subscription ${a.info.subscriptionStatus}` : ""}
                        {a.cacheRead ? ` · ${tok(a.cacheRead)} tokens re-used from memory (not counted above)` : ""}
                        <span className="mny-job-raw"> · workspace id {a.info.workspaceId}</span>
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
            <td />
            <td className="num">{n(v.total.calls)}</td>
            <td className="num">{v.total.failed ? n(v.total.failed) : "—"}</td>
            <td className="num">{tok(v.total.tokens)}</td>
            <td className="num">100%</td>
            <td className="num">{v.creditsTotal ? n(v.creditsTotal) : "—"}</td>
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
        <span><i style={{ background: C_NONE }} />No account (public tools, scheduled jobs)</span>
        <span className="mny-readout">
          {h ? <><strong>{lab(h.key)}</strong> · accounts {tok(h.tagged)} · no account {tok(h.none)} · {n(h.calls)} requests</> : "Point at a bar to read it."}
        </span>
      </div>
    </div>
  );
}
