import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScreenContext } from "../../lib/screenContext.js";
import { isConfigured } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import { getAiCost, getAiAccount } from "../../lib/moneyApi.js";
import { timeAgo } from "./shared.jsx";
import {
  RangePicker, Tabs, Stat, SimpleTable, Card, Loading, pctText, C_PLATFORM,
} from "./moneyParts.jsx";
import { aiCostView, explain as explain2, NO_ACCOUNT, CONSOLE } from "../../../lib/ai-cost-view.js";
import { jobInfo, serviceName, OUTCOMES, outcomeOf, reasonLabel } from "../../../lib/ai-job-names.js";
import { accountDetailView } from "../../../lib/ai-account-view.js";
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
  { id: "problems", label: "What went wrong" },
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

  const v = useMemo(() => (data ? aiCostView(data, range, { now: Date.parse(data.readAt) || null }) : null), [data, range]);
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

          <OutcomeBar v={v} onOpen={() => setViewId("problems")} />

          <div className="mny-note-line">
            {v.total.webSearches > 0 && <>The AI also ran <strong>{n(v.total.webSearches)}</strong> web searches for us (these are charged per search, on top of tokens). </>}
            {v.total.reasoning > 0 && <><strong>{tok(v.total.reasoning)}</strong> tokens were hidden &quot;thinking&quot; (counted inside the total, where the AI company reports it). </>}
            {v.total.cutOffCalls > 0 && <><strong>{n(v.total.cutOffCalls)}</strong> answers were cut off mid-way — <strong>{tok(v.total.cutOffTokens)}</strong> tokens paid for with nothing usable. </>}
            {v.total.tokenlessCalls > 0 && <><strong>{n(v.total.tokenlessCalls)}</strong> requests went to search tools that don&apos;t use tokens (like Google search results) — they are counted as requests only. </>}
            {v.total.cacheRead > 0 && <><strong>{tok(v.total.cacheRead)}</strong> tokens were re-used from memory (cache) and are not in the total.</>}
          </div>

          <Tabs value={viewId} onChange={setViewId} options={VIEWS} label="How to group AI use" />

          {viewId === "accounts" && (
            <Card
              title={`Who used it · ${rangeLabel(range)}`}
              note={'Each account is a workspace on our platform — a customer\'s, or one of ours. "No account" is the platform\'s free public tools (like the free scan on our website) and our own scheduled jobs. Click any row to see exactly what it was used for.'}
            >
              <AccountTable v={v} openKey={openKey} setOpenKey={setOpenKey} share={share} range={range} />
            </Card>
          )}

          {viewId === "problems" && (
            <Card
              title={`What went wrong · ${rangeLabel(range)}`}
              note="Every problem in this period: which AI company, what it said, when it started and stopped, and what it hit. Problems seen in the last 24 hours are marked as still happening and sit at the top."
            >
              <ProblemList v={v} detail={data.detail !== false} />
            </Card>
          )}

          {viewId === "jobs" && (
            <Card title={`What it was used for · ${rangeLabel(range)}`} note={'Every job the AI did in this period, biggest first. Hover a name to see what it does. "Worked" is the share of requests the AI answered. "Per request" is the average tokens one working request used — a big number means a heavy job. "Avg wait" is how long each request took.'}>
              <SimpleTable
                columns={[
                  { key: "job", label: "What the AI was doing", render: (r) => <JobName job={r.job} />, sortValue: (r) => jobInfo(r.job).name },
                  { key: "accountCount", label: "Accounts", num: true },
                  { key: "calls", label: "Requests", num: true, render: (r) => n(r.calls) },
                  { key: "worked", label: "Worked", num: true, render: (r) => <Worked d={r.detail} />, sortValue: (r) => r.detail.workedShare ?? 1 },
                  { key: "problem", label: "Main problem", render: (r) => <MainProblem d={r.detail} />, sortValue: (r) => r.detail.topReasonCalls },
                  { key: "tokens", label: "Tokens", num: true, render: (r) => (r.tokens ? tok(r.tokens) : "—") },
                  { key: "per", label: "Per request", num: true, render: (r) => (r.detail.tokensPerRequest ? tok(r.detail.tokensPerRequest) : "—"), sortValue: (r) => r.detail.tokensPerRequest || 0 },
                  { key: "wait", label: "Avg wait", num: true, render: (r) => waitText(r.detail.avgWaitSec), sortValue: (r) => r.detail.avgWaitSec || 0 },
                  { key: "share", label: "Share", num: true, render: (r) => share(r.tokens), sortValue: (r) => r.tokens },
                ]}
                rows={v.jobs.map((j) => ({ ...j, key: j.job || "none" }))}
                total={{ job: "Total", calls: n(v.total.calls), worked: <Worked d={v.detail} />, tokens: tok(v.total.tokens), per: v.detail.tokensPerRequest ? tok(v.detail.tokensPerRequest) : "—", wait: waitText(v.detail.avgWaitSec) }}
              />
            </Card>
          )}

          {viewId === "services" && (
            <Card title={`Which AI · ${rangeLabel(range)}`} note="Which AI company and model did the work. Search tools show requests only — they don't use tokens.">
              <SimpleTable
                columns={[
                  { key: "name", label: "AI", render: (r) => serviceName(r.provider, r.model), sortValue: (r) => serviceName(r.provider, r.model) },
                  { key: "calls", label: "Requests", num: true, render: (r) => n(r.calls) },
                  { key: "worked", label: "Worked", num: true, render: (r) => <Worked d={r.detail} />, sortValue: (r) => r.detail.workedShare ?? 1 },
                  { key: "problem", label: "Main problem", render: (r) => <MainProblem d={r.detail} />, sortValue: (r) => r.detail.topReasonCalls },
                  { key: "tokens", label: "Tokens", num: true, render: (r) => (r.tokens ? tok(r.tokens) : <span className="mny-muted">no tokens</span>) },
                  { key: "wait", label: "Avg wait", num: true, render: (r) => waitText(r.detail.avgWaitSec), sortValue: (r) => r.detail.avgWaitSec || 0 },
                  { key: "share", label: "Share", num: true, render: (r) => share(r.tokens), sortValue: (r) => r.tokens },
                ]}
                rows={v.services.map((x) => ({ ...x, key: `${x.provider}|${x.model}` }))}
                total={{ name: "Total", calls: n(v.total.calls), worked: <Worked d={v.detail} />, tokens: tok(v.total.tokens), wait: waitText(v.detail.avgWaitSec) }}
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
  const who = a.info.kind === "none" ? "Public tools and our own scheduled jobs" : `${a.info.name}'s account${a.info.domain ? ` (set up for ${a.info.domain} — see "Look closer" for every website it worked on)` : ""}`;
  return (
    <p className="mny-story">
      {who} used <strong>{tok(a.tokens)} tokens</strong> across <strong>{n(a.calls)} AI requests</strong> {daySpan(st)}
      {a.share !== null && <> — <strong>{pctText(a.share)}</strong> of all AI use in this period</>}.
      {st.topJob !== undefined && st.topJobShare !== null && (
        <> <strong>{pctText(st.topJobShare)}</strong> of it was <strong>{top.name}</strong> ({n(st.topJobCalls)} requests). <span className="mny-muted">{top.what}</span></>
      )}
      {st.busiestDay && st.days.length > 1 && <> The busiest day was <strong>{shortDay(st.busiestDay)}</strong> ({tok(st.busiestDayTokens)} tokens).</>}
      {a.failed > 0 && (
        <> <span className={st.failedShare >= 0.2 ? "mny-bad" : ""}><strong>{n(a.failed)}</strong> requests didn&apos;t work ({pctText(st.failedShare)})</span>
          {a.detail?.topReason && a.detail.topReason !== "unknown"
            ? <> — mostly <strong>{reasonLabel(a.detail.topReason)}</strong> ({n(a.detail.topReasonCalls)}). See &quot;How its requests went&quot; below.</>
            : "."}</>
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
        {a.failed > 0 && <>, and {n(a.failed)} of the requests didn&apos;t work</>}.
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
  return Math.round(v).toLocaleString("en-US");
}

function AccountTable({ v, openKey, setOpenKey, share, range }) {
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
            <th className="num">Didn&apos;t work</th>
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
                    <div className="mny-two mny-acct-top">
                      <div>
                        <div className="mny-mini-head">Day by day</div>
                        <DayBars days={a.days} />
                      </div>
                      <div>
                        <div className="mny-mini-head">How its requests went</div>
                        <OutcomeRows t={a} />
                      </div>
                    </div>
                    {a.info.kind === "workspace" && a.info.workspaceId && <CloserLook a={a} range={range} />}
                    <div className="mny-mini-head">What it was spent on</div>
                    <SimpleTable
                      max={20}
                      columns={[
                        { key: "job", label: "What the AI was doing", render: (r) => <JobName job={r.job} />, sortValue: (r) => jobInfo(r.job).name },
                        { key: "days", label: "When", render: (r) => daySpan(explain2(r)).replace(/^on |^between /, ""), sortValue: (r) => Object.keys(r.days || {}).sort()[0] || "" },
                        { key: "calls", label: "Requests", num: true, render: (r) => n(r.calls) },
                        { key: "worked", label: "Worked", num: true, render: (r) => <Worked d={r.detail} />, sortValue: (r) => r.detail.workedShare ?? 1 },
                        { key: "problem", label: "Main problem", render: (r) => <MainProblem d={r.detail} />, sortValue: (r) => r.detail.topReasonCalls },
                        { key: "tokens", label: "Tokens", num: true, render: (r) => (r.tokens ? tok(r.tokens) : "—") },
                        { key: "per", label: "Per request", num: true, render: (r) => (r.detail.tokensPerRequest ? tok(r.detail.tokensPerRequest) : "—"), sortValue: (r) => r.detail.tokensPerRequest || 0 },
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
                        { key: "worked", label: "Worked", num: true, render: (r) => <Worked d={r.detail} />, sortValue: (r) => r.detail.workedShare ?? 1 },
                        { key: "problem", label: "Main problem", render: (r) => <MainProblem d={r.detail} />, sortValue: (r) => r.detail.topReasonCalls },
                        { key: "tokens", label: "Tokens", num: true, render: (r) => (r.tokens ? tok(r.tokens) : "no tokens") },
                        { key: "wait", label: "Avg wait", num: true, render: (r) => waitText(r.detail.avgWaitSec), sortValue: (r) => r.detail.avgWaitSec || 0 },
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

/* ---- Deeper view, 25 Sep 2026 (Andrew: "even more detail") ------------- */

function waitText(sec) {
  if (sec === null || sec === undefined) return "—";
  return sec >= 10 ? `${Math.round(sec)} s` : `${sec.toFixed(1)} s`;
}

function Worked({ d }) {
  if (!d || d.workedShare === null) return "—";
  const cls = d.workedShare >= 0.95 ? "mny-good" : d.workedShare >= 0.8 ? "mny-warn" : "mny-bad";
  return <span className={cls}>{pctText(d.workedShare)}</span>;
}

function MainProblem({ d }) {
  if (!d || !d.topReason) return <span className="mny-muted">—</span>;
  const o = outcomeOf(d.topReason);
  return (
    <span className="mny-reason" title={`${reasonLabel(d.topReason)}. ${OUTCOMES[o].what}`}>
      <i style={{ background: OUTCOMES[o].color }} />{OUTCOMES[o].label} <span className="mny-muted">· {n(d.topReasonCalls)}</span>
    </span>
  );
}

/* One bar: how every request in the period went. */
function OutcomeBar({ v, onOpen }) {
  const list = v.outcomeList;
  if (!v.total.calls) return null;
  const bad = v.total.calls - v.total.okCalls;
  const live = v.problems.filter((p) => p.live);
  return (
    <div className="mny-outcomes">
      <div className="mny-outcomes-head">
        <strong>How the {n(v.total.calls)} requests went</strong>
        {bad > 0 && (
          <span className="mny-muted">
            {" "}· {n(bad)} didn&apos;t work
            {live.length > 0 ? <> · <span className="mny-bad">{live.length} problem{live.length === 1 ? "" : "s"} still happening</span></> : " · none still happening"}
            {" "}· <button type="button" className="mny-linkbtn" onClick={onOpen}>See what went wrong</button>
          </span>
        )}
      </div>
      <div className="mny-outcome-bar" role="img" aria-label="How requests went">
        {list.map((o) => (
          <span key={o.key} style={{ width: `${Math.max(o.share * 100, 0.6)}%`, background: OUTCOMES[o.key].color }} title={`${OUTCOMES[o.key].label}: ${n(o.calls)} (${pctText(o.share)})`} />
        ))}
      </div>
      <div className="mny-legend mny-outcome-legend">
        {list.map((o) => (
          <span key={o.key} title={OUTCOMES[o.key].what}><i style={{ background: OUTCOMES[o.key].color }} />{OUTCOMES[o.key].label} <strong>{o.share > 0 && o.share < 0.005 ? "<1%" : pctText(o.share)}</strong> <span className="mny-muted">({n(o.calls)})</span></span>
        ))}
      </div>
    </div>
  );
}

/* The same breakdown for one account, as short rows with the plain meaning. */
function OutcomeRows({ t }) {
  const reasons = Object.entries(t.reasons || {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="mny-outcome-rows">
      <div><i style={{ background: OUTCOMES.ok.color }} />Worked <strong>{n(t.okCalls)}</strong> <span className="mny-muted">({pctText(t.calls ? t.okCalls / t.calls : null)})</span></div>
      {reasons.slice(0, 6).map(([r, c]) => {
        const o = outcomeOf(r);
        return (
          <div key={r} title={OUTCOMES[o].what}>
            <i style={{ background: OUTCOMES[o].color }} />{reasonLabel(r)} <strong>{n(c)}</strong> <span className="mny-muted">({pctText(c / t.calls)})</span>
          </div>
        );
      })}
      {t.webSearches > 0 && <div className="mny-muted">Web searches run by the AI: {n(t.webSearches)}</div>}
      {t.reasoning > 0 && <div className="mny-muted">Hidden thinking tokens: {tok(t.reasoning)}</div>}
      {t.detail?.avgWaitSec ? <div className="mny-muted">Average wait per request: {waitText(t.detail.avgWaitSec)}</div> : null}
    </div>
  );
}

/* Requests per day, worked vs didn't, with tokens on hover. */
function DayBars({ days }) {
  const [hover, setHover] = useState(null);
  const keys = Object.keys(days || {}).sort();
  if (!keys.length) return <div className="mny-muted">No requests.</div>;
  const w = 460, h = 110, padB = 18;
  const max = Math.max(1, ...keys.map((k) => days[k].calls));
  const slot = w / keys.length;
  const bw = Math.max(2, Math.min(22, slot * 0.7));
  const hk = hover !== null ? keys[hover] : null;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="mny-daybars" role="img" aria-label="Requests per day">
        {keys.map((k, i) => {
          const d = days[k];
          const ok = d.calls - d.failed;
          const x = slot * i + (slot - bw) / 2;
          const hOk = (ok / max) * (h - padB);
          const hBad = (d.failed / max) * (h - padB);
          return (
            <g key={k} opacity={hover === null || hover === i ? 1 : 0.45} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={h - padB - hOk} width={bw} height={hOk} fill={OUTCOMES.ok.color} rx="1.5" />
              <rect x={x} y={h - padB - hOk - hBad} width={bw} height={hBad} fill="#dc2626" rx="1.5" />
              <rect x={slot * i} y={0} width={slot} height={h} fill="transparent" />
              {(keys.length <= 12 || i % Math.ceil(keys.length / 10) === 0) && <text x={x + bw / 2} y={h - 4} textAnchor="middle" className="mny-axis">{shortDay(k)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="mny-readout mny-muted">
        {hk ? <><strong>{shortDay(hk)}</strong> · {n(days[hk].calls)} requests · {n(days[hk].failed)} didn&apos;t work · {tok(days[hk].tokens)} tokens</> : <>Green = worked, red = didn&apos;t. Point at a day to read it.</>}
      </div>
    </div>
  );
}

const CHI = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function when(ms) { return ms ? CHI.format(new Date(ms)).replace(" AM", " am").replace(" PM", " pm") : "—"; }

/* The plain meaning of a problem. The spending-limit hint only fits Claude:
 * Anthropic answers "bad request" when an account's limit is hit. */
function problemWhat(p) {
  const what = OUTCOMES[p.outcome].what;
  return p.provider === "anthropic" ? what : what.replace(" (Anthropic also answers this way when a spending limit is hit.)", "");
}

function ProblemList({ v, detail }) {
  const [openK, setOpenK] = useState(null);
  if (!v.problems.length) return <div className="mny-empty">Every request in this period worked.</div>;
  const nameOf = (key) => v.accounts.find((a) => a.key === key)?.info.name || "Unknown account";
  return (
    <div className="mny-table-wrap">
      {!detail && <div className="mny-alert" style={{ marginBottom: 12 }}>The reason for each failure appears once database update 0043 is run. Until then failures show as &quot;reason not saved&quot;.</div>}
      <table className="mny-table">
        <thead>
          <tr>
            <th>Problem</th>
            <th className="num">Requests</th>
            <th>Hit</th>
            <th>First seen</th>
            <th>Last seen</th>
            <th>Now</th>
          </tr>
        </thead>
        <tbody>
          {v.problems.map((p) => {
            const o = OUTCOMES[p.outcome];
            const open = openK === p.key;
            const topJob = p.jobs[0];
            return [
              <tr key={p.key} className="mny-row-click" onClick={() => setOpenK(open ? null : p.key)}>
                <td>
                  <button type="button" className="mny-rowbtn" aria-expanded={open}>
                    <span className="mny-caret">{open ? "▾" : "▸"}</span>
                    <span className="mny-dot" style={{ background: o.color }} />
                    <span>
                      <strong>{serviceName(p.provider, null)}</strong> — {reasonLabel(p.reason)}
                      <span className="mny-acc-sub">{problemWhat(p)}</span>
                    </span>
                  </button>
                </td>
                <td className="num"><strong>{n(p.calls)}</strong></td>
                <td>
                  {topJob ? jobInfo(topJob.job).name : "—"}
                  {p.jobs.length > 1 && <span className="mny-muted"> +{p.jobs.length - 1} more</span>}
                  <span className="mny-acc-sub">{p.accountCount} account{p.accountCount === 1 ? "" : "s"} · {p.days.length} day{p.days.length === 1 ? "" : "s"}</span>
                </td>
                <td className="mny-nowrap">{when(p.firstTs)}</td>
                <td className="mny-nowrap">{when(p.lastTs)}</td>
                <td>{p.live ? <span className="mny-pill mny-pill-bad">Still happening</span> : <span className="mny-pill">Stopped</span>}</td>
              </tr>,
              open && (
                <tr key={`${p.key}-open`} className="mny-open-row">
                  <td colSpan={6}>
                    <div className="mny-two">
                      <div>
                        <div className="mny-mini-head">Jobs it hit</div>
                        <SimpleTable
                          max={10}
                          columns={[
                            { key: "job", label: "What the AI was doing", render: (r) => <JobName job={r.job} /> },
                            { key: "calls", label: "Requests", num: true, render: (r) => n(r.calls) },
                          ]}
                          rows={p.jobs.map((j) => ({ ...j, key: j.job || "none" }))}
                        />
                      </div>
                      <div>
                        <div className="mny-mini-head">Accounts it hit</div>
                        <ul className="mny-plain-list">
                          {p.accounts.slice(0, 12).map((k) => <li key={k}>{nameOf(k)}</li>)}
                          {p.accounts.length > 12 && <li className="mny-muted">+{p.accounts.length - 12} more</li>}
                        </ul>
                        {p.models.length > 0 && <div className="mny-note">Model{p.models.length === 1 ? "" : "s"}: {p.models.map((m) => serviceName(p.provider, m)).join(", ")}</div>}
                        <div className="mny-note">Days: {p.days.map(shortDay).join(", ")}</div>
                      </div>
                    </div>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---- Look closer: one account's sessions and websites (25 Sep 2026) ----- */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function hourLabel(h, withDay = true) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(h || "");
  if (!m) return "";
  const hr = +m[4];
  const t = hr === 0 ? "midnight" : hr === 12 ? "noon" : hr < 12 ? `${hr} am` : `${hr - 12} pm`;
  return withDay ? `${MON[+m[2] - 1]} ${+m[3]}, ${t}` : t;
}
function sessionWhen(s) {
  const sameDay = s.start.slice(0, 10) === s.end.slice(0, 10);
  return `${hourLabel(s.start)} → ${hourLabel(s.end, !sameDay)}`;
}
function lengthText(h) { return h < 24 ? `${h} hour${h === 1 ? "" : "s"}` : `${Math.round((h / 24) * 10) / 10} days`; }
const DATE_CHI = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" });

function CloserLook({ a, range }) {
  const [state, setState] = useState({ status: "loading" });
  const [allSessions, setAllSessions] = useState(false);
  const [allSites, setAllSites] = useState(false);
  useEffect(() => {
    let live = true;
    getAiAccount(a.info.workspaceId, range).then((res) => {
      if (!live) return;
      if (res.ok) setState({ status: "ok", d: accountDetailView(res.data) });
      else setState({ status: "error", error: res.error, needs: res.status === 501 });
    });
    return () => { live = false; };
  }, [a.info.workspaceId, range]);

  if (state.status === "loading") return <div className="mny-closer"><div className="mny-mini-head">Look closer</div><div className="mny-muted">Reading this account&apos;s hours and websites…</div></div>;
  if (state.status === "error") {
    return (
      <div className="mny-closer">
        <div className="mny-mini-head">Look closer</div>
        <div className="mny-muted">{state.needs ? "Sessions and websites appear once database update 0044 is run." : `Could not read this account: ${state.error}`}</div>
      </div>
    );
  }
  const d = state.d;
  const b = d.biggest;
  const st = d.siteTotals;
  const sessions = allSessions ? d.sessions : d.sessions.slice(0, 8);
  const sites = allSites ? d.sites : d.sites.slice(0, 12);
  return (
    <div className="mny-closer">
      <div className="mny-mini-head">Look closer</div>
      <p className="mny-story">
        {b ? (
          <>
            This account&apos;s AI use came in <strong>{n(d.sessions.length)} work session{d.sessions.length === 1 ? "" : "s"}</strong>.
            {" "}The biggest ran <strong>{sessionWhen(b)}</strong> ({lengthText(b.hours)}): <strong>{n(b.calls)} requests</strong>, {tok(b.tokens)} tokens
            {d.biggestShare !== null && d.sessions.length > 1 && <> — <strong>{pctText(d.biggestShare)}</strong> of this account&apos;s tokens</>}
            , mostly <strong>{jobInfo(b.mainJob).name}</strong>.
            {b.failed > 0 && <> <span className={b.failed / b.calls >= 0.2 ? "mny-bad" : ""}>{n(b.failed)} of its requests didn&apos;t work.</span></>}
            {" "}Its busiest hour was {hourLabel(b.peakHour)} ({n(b.peakCalls)} requests).
          </>
        ) : "No AI requests in this period."}
        {st.sites > 0 && (
          <> In this period the account ran <strong>{n(st.audits)} website audit{st.audits === 1 ? "" : "s"}</strong> on <strong>{n(st.sites)} different website{st.sites === 1 ? "" : "s"}</strong>
            {st.fixedPages > 0 ? <>, and fixes were written for <strong>{n(st.fixedPages)} pages</strong> on <strong>{n(st.sitesWithFixes)}</strong> of them</> : null}.</>
        )}
        {d.total.tokens > 0 && (
          <> Of its tokens, <strong>{tok(d.total.sent)}</strong> were sent to the AI (the page text and instructions) and <strong>{tok(d.total.written)}</strong> were written back by the AI.</>
        )}
        {(d.creditsBy.manual > 0 || d.creditsBy.scheduled > 0) && (
          <> Credits: <strong>{n(d.creditsBy.manual)}</strong> from things a person clicked{d.creditsBy.scheduled > 0 && <>, <strong>{n(d.creditsBy.scheduled)}</strong> from scheduled jobs</>}.</>
        )}
        {" "}<span className="mny-muted">The platform doesn&apos;t record which person clicked — this workspace belongs to {a.info.email || a.info.name}.</span>
      </p>

      {d.sessions.length > 0 && (
        <>
          <div className="mny-mini-head">Work sessions (biggest first)</div>
          <SimpleTable
            max={50}
            columns={[
              { key: "when", label: "When", render: (r) => <span className="mny-nowrap">{sessionWhen(r)}</span>, sortValue: (r) => r.start },
              { key: "hours", label: "Length", num: true, render: (r) => lengthText(r.hours), sortValue: (r) => r.hours },
              { key: "calls", label: "Requests", num: true, render: (r) => n(r.calls) },
              { key: "failed", label: "Didn't work", num: true, render: (r) => (r.failed ? <span className={r.failed / r.calls >= 0.2 ? "mny-bad" : ""}>{n(r.failed)}</span> : "—") },
              { key: "tokens", label: "Tokens", num: true, render: (r) => (r.tokens ? tok(r.tokens) : "—") },
              { key: "job", label: "Mostly", render: (r) => <>{jobInfo(r.mainJob).name}{r.jobs.length > 1 && <span className="mny-muted"> +{r.jobs.length - 1} more</span>}</>, sortValue: (r) => jobInfo(r.mainJob).name },
            ]}
            rows={sessions.map((x) => ({ ...x, key: x.start }))}
            initialSort={{ key: "tokens", dir: "desc" }}
          />
          {d.sessions.length > 8 && <button type="button" className="mny-more" onClick={() => setAllSessions((x) => !x)}>{allSessions ? "Show fewer" : `Show all ${d.sessions.length} sessions`}</button>}
        </>
      )}

      {d.sites.length > 0 && (
        <>
          <div className="mny-mini-head">Websites it worked on</div>
          <SimpleTable
            max={1000}
            columns={[
              { key: "domain", label: "Website", render: (r) => <strong>{r.domain}</strong> },
              { key: "audits", label: "Audits", num: true, render: (r) => n(r.audits) },
              { key: "fixedPages", label: "Pages fixed", num: true, render: (r) => (r.fixedPages ? n(r.fixedPages) : "—") },
              { key: "lastAt", label: "Last audit", render: (r) => (r.lastAt ? DATE_CHI.format(new Date(r.lastAt)) : "—"), sortValue: (r) => r.lastAt || "" },
            ]}
            rows={sites.map((x) => ({ ...x, key: x.domain }))}
          />
          {d.sites.length > 12 && <button type="button" className="mny-more" onClick={() => setAllSites((x) => !x)}>{allSites ? "Show fewer" : `Show all ${n(d.sites.length)} websites`}</button>}
          <div className="mny-note">&quot;Pages fixed&quot; counts pages on that website that got fixes written in this period. The platform stores fixes by page, not by account, so a page another account fixed on the same website would count too.</div>
        </>
      )}

      {d.sentWritten.length > 0 && d.total.tokens > 0 && (
        <>
          <div className="mny-mini-head">Tokens sent vs written, by job</div>
          <SimpleTable
            max={10}
            columns={[
              { key: "job", label: "What the AI was doing", render: (r) => jobInfo(r.job).name, sortValue: (r) => jobInfo(r.job).name },
              { key: "sent", label: "Sent to the AI", num: true, render: (r) => (r.sent ? tok(r.sent) : "—") },
              { key: "written", label: "Written by the AI", num: true, render: (r) => (r.written ? tok(r.written) : "—") },
              { key: "ratio", label: "Sent for each 1 written", num: true, render: (r) => (r.written ? `${Math.round(r.sent / r.written)} : 1` : "—"), sortValue: (r) => (r.written ? r.sent / r.written : 0) },
            ]}
            rows={d.sentWritten.filter((r) => r.tokens > 0).map((x) => ({ ...x, key: x.job || "none" }))}
          />
        </>
      )}
    </div>
  );
}
