import { useCallback, useEffect, useMemo, useState } from "react";
import { useRoute } from "../../lib/router.js";
import { useScreenContext } from "../../lib/screenContext.js";
import { isConfigured } from "../../lib/supabase.js";
import { listCalcRunsWithLeads } from "../../lib/data.js";
import { SectionHeader, SourceBadge, EmptyState, MetricCard } from "./shared.jsx";
import { Block } from "./financeParts.jsx";
import { Num, SortHeader, RangePicker } from "./homeServicesParts.jsx";
import { defaultRange, addTeamDays, teamToday, teamDayStartMs, teamDayEndMs, sortRows } from "../../../lib/home-services.js";
import { summarise, upliftShare, CALC_INDUSTRY_LABELS } from "../../../lib/calculator.js";

/* ==================================================================
 * COMMAND → AI REVENUE CALCULATOR.  24 Sep 2026.
 *
 * Ryder: "a new leads table for the calculator just so the leads are visible
 * and never hidden … and save the numbers of businesses so we can see like
 * what the average someone would increase if they optimized with AI."
 *
 * Two jobs on one page, top to bottom: who left an email (a call list, with
 * the numbers they typed next to their name) and what the calculations add up
 * to (the averages). Every lead here is also an ordinary row on the Sales page
 * — "Open in Sales" goes straight to it.
 *
 * THE AVERAGES ARE COUNTED FROM EDITED ROWS ONLY. A calculation still on the
 * page's starting guesses is our own numbers echoed back, so averaging it would
 * report our defaults as if a business had typed them. The page says so.
 * ================================================================== */

const PRESETS = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
  { id: "365", label: "Last year", days: 365 },
];

const usd = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : `$${Math.round(Number(n)).toLocaleString("en-US")}`);
const pct = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? "—" : `${Math.round(Number(x) * 100)}%`);
const pageLabel = (p) => {
  const slug = String(p || "").replace(/^\/ai-revenue-calculator\/?/, "").replace(/\/$/, "");
  return slug ? slug.replace(/-/g, " ") : "main page";
};

const LEAD_COLUMNS = [
  { key: "who", label: "Who", numeric: false },
  { key: "industryLabel", label: "Business type", numeric: false },
  { key: "added", label: "Shown +/yr", numeric: true, title: "The added revenue a year the calculator showed them" },
  { key: "uplift", label: "% of their year", numeric: true, title: "That added revenue as a share of their yearly revenue (typed, or what their leads add up to)" },
  { key: "score", label: "AI score", numeric: true, title: "Measured by our scan, or their own guess" },
  { key: "leads", label: "Leads/mo", numeric: true },
  { key: "value", label: "Per client", numeric: true },
  { key: "when", label: "When", numeric: false },
];

export default function Calculator() {
  const [, go] = useRoute();
  const [range, setRange] = useState(() => ({ ...defaultRange(), preset: "30" }));
  const [data, setData] = useState({ runs: [], leads: [], errors: [], sample: false });
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState({ key: "when", dir: "desc" });
  const [showAll, setShowAll] = useState(false);
  const { from, to } = range;

  const load = useCallback(async () => {
    setLoading(true);
    setData(await listCalcRunsWithLeads({ fromMs: teamDayStartMs(from), toMs: teamDayEndMs(to) }));
    setLoading(false);
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const presets = useMemo(() => {
    const today = teamToday();
    return PRESETS.map((p) => ({ ...p, from: addTeamDays(today, -(p.days - 1)), to: today }));
  }, []);

  const stats = useMemo(() => summarise(data.runs), [data.runs]);

  const leadRows = useMemo(() => {
    const byId = new Map((data.leads || []).map((l) => [l.id, l]));
    /* One line per LEAD, from their newest calculation. */
    const seen = new Set();
    const out = [];
    for (const r of data.runs) {
      if (!r.lead_id || seen.has(r.lead_id)) continue;
      seen.add(r.lead_id);
      const l = byId.get(r.lead_id);
      out.push({
        leadId: r.lead_id,
        readable: Boolean(l),
        who: l ? (l.name || l.email || "") : "",
        name: l?.name, email: l?.email, domain: l?.domain || r.scanned_domain,
        industryLabel: CALC_INDUSTRY_LABELS[r.industry] || r.industry,
        page: pageLabel(r.page_path),
        added: Number(r.added_revenue),
        uplift: upliftShare(r),
        score: r.ai_score, measured: r.score_measured,
        leads: Number(r.leads_per_month), value: Number(r.client_value),
        when: r.created_at,
      });
    }
    /* Calculator leads whose run never linked (a failed write, or the page fell
     * back to the platform's own lead form). Their numbers are in the note. */
    for (const l of data.notedLeads || []) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      out.push({
        leadId: l.id, readable: true, who: l.name || l.email || "", name: l.name, email: l.email, domain: l.domain,
        industryLabel: "see note", page: "numbers in the lead's note", added: NaN, uplift: null, score: null, measured: false,
        leads: NaN, value: NaN, when: l.last_activity_at || l.created_at,
      });
    }
    return sortRows(out, sort.key, sort.dir);
  }, [data, sort]);

  const runRows = useMemo(() => (showAll ? data.runs : data.runs.slice(0, 50)), [data.runs, showAll]);

  useScreenContext({
    page: "AI Revenue Calculator",
    summary: `${stats.runs} calculations between ${from} and ${to}; ${stats.people} people left an email. Median added revenue shown (edited rows only): ${usd(stats.medianAdded)} a year.`,
    rows: leadRows.slice(0, 25).map((r) => ({ who: r.who, type: r.industryLabel, shown: usd(r.added), score: r.score })),
  });

  const mode = data.errors?.length ? "error" : data.sample ? "sample" : isConfigured() ? "live" : "waiting";
  const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "who" || key === "industryLabel" ? "asc" : "desc" }));

  return (
    <div className="adm-hs">
      <SectionHeader
        kicker="Command"
        title="AI Revenue Calculator"
        subtitle="Everyone who used the calculator on aisyndicate.com, what they typed, what it showed them, and who left an email. Every lead here is also on the Sales page. A calculation holds no name and no website until the visitor leaves an email."
        right={<SourceBadge mode={mode} hint={mode === "live" ? "Counted from calc_runs, written by the calculator pages" : mode === "sample" ? "Sample rows — this build has no database keys" : undefined} />}
      />

      <RangePicker from={from} to={to} presets={presets} activePreset={range.preset} onChange={(r) => setRange(r)} />

      {data.errors?.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 18, borderColor: "#fecdca" }}>
          <strong>Part of this could not be read.</strong> {data.errors.join(" · ")}
          {" "}If it says calc_runs does not exist, migration 0040 has not been run yet (SETUP.md).
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: 28 }}>Reading the calculations…</div>
      ) : stats.runs === 0 ? (
        <EmptyState icon="◎" title="No calculations in this range"
          body="Nobody used the calculator between these two dates — or the pages are not posting here yet. That is a count of rows that do not exist, not a measurement. Widen the range, and check SETUP.md → Migration 0040." />
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 18 }}>
            <MetricCard label="Calculations" value={<Num value={stats.runs} />} hint={`${stats.edited} changed the numbers`} />
            <MetricCard label="Left an email" value={<Num value={stats.people} />} hint={`people · ${pct(stats.leadRate)} of calculations`} />
            <MetricCard label="Median added / yr" value={usd(stats.medianAdded)} hint="a year · edited rows" />
            <MetricCard label="Median lift" value={pct(stats.medianUplift)} hint="of their year · edited rows" />
            <MetricCard label="Median added profit" value={usd(stats.medianProfit)} hint="a year · edited rows" />
            <MetricCard label="Average measured AI score" value={stats.meanMeasuredScore === null ? "—" : Math.round(stats.meanMeasuredScore)} hint={`${stats.measuredCount} sites scanned`} />
          </div>

          <Block title="Leads from the calculator" blurb="Everyone who left an email, with the numbers they typed and what the calculator showed them. Newest first. The same numbers are written on the lead's notes in Sales.">
            {leadRows.length === 0 ? (
              <p className="dim" style={{ padding: "8px 2px" }}>Nobody left an email in this range yet.</p>
            ) : (
              <div className="adm-hs-tablewrap">
                <table className="adm-hs-table">
                  <thead><tr>
                    {LEAD_COLUMNS.map((c) => <SortHeader key={c.key} id={c.key} label={c.label} sort={sort} onSort={onSort} numeric={c.numeric} title={c.title} />)}
                    <th className="n">Open</th>
                  </tr></thead>
                  <tbody>
                    {leadRows.map((r) => (
                      <tr key={r.leadId}>
                        <td>
                          {r.readable ? (
                            <>
                              <strong>{r.name || r.email || "(no name)"}</strong>
                              <div className="dim" style={{ fontSize: 12 }}>{r.email}{r.domain ? ` · ${r.domain}` : ""}</div>
                            </>
                          ) : <span className="adm-hs-blank" title="The lead row was deleted, or is not one you may see.">not readable</span>}
                        </td>
                        <td>{r.industryLabel}<div className="dim" style={{ fontSize: 12 }}>{r.page}</div></td>
                        <td className="n"><strong>{usd(r.added)}</strong></td>
                        <td className="n">{pct(r.uplift)}</td>
                        <td className="n">{r.score ?? "—"}{r.score !== null && r.score !== undefined && <span className="dim" style={{ fontSize: 11 }}>{r.measured ? " measured" : " guess"}</span>}</td>
                        <td className="n">{Number.isFinite(r.leads) ? r.leads : "—"}</td>
                        <td className="n">{usd(r.value)}</td>
                        <td className="dim">{String(r.when || "").slice(0, 10)}</td>
                        <td className="n"><button type="button" className="adm-hs-link" onClick={() => go(`#/dashboard/sales?lead=${r.leadId}`)}>Open in Sales →</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Block>

          <Block title="By business type" blurb="Medians and averages use edited rows only. A dash means no edited rows of that type yet.">
            <div className="adm-hs-tablewrap">
              <table className="adm-hs-table">
                <thead><tr><th>Business type</th><th className="n">Calculations</th><th className="n">Changed numbers</th><th className="n">Leads</th><th className="n">Median +/yr</th><th className="n">Average lift</th><th className="n">Average AI score</th></tr></thead>
                <tbody>
                  {stats.byIndustry.map((g) => (
                    <tr key={g.key}>
                      <td>{g.label}</td><td className="n"><Num value={g.runs} /></td><td className="n"><Num value={g.edited} /></td>
                      <td className="n"><Num value={g.leads} /></td><td className="n">{usd(g.medianAdded)}</td><td className="n">{pct(g.meanUplift)}</td>
                      <td className="n">{g.meanScore === null ? "—" : Math.round(g.meanScore)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Block>

          <Block title="Where they came from" blurb="Which calculator page, and which source brought them (the link's utm_source, or the site that sent them).">
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[["Page", stats.byPage, pageLabel], ["Source", stats.bySource, (k) => k]].map(([title, list, lab]) => (
                <div key={title} className="adm-hs-tablewrap">
                  <table className="adm-hs-table">
                    <thead><tr><th>{title}</th><th className="n">Calculations</th><th className="n">Leads</th></tr></thead>
                    <tbody>{list.map((g) => <tr key={g.key}><td>{lab(g.key)}</td><td className="n"><Num value={g.runs} /></td><td className="n"><Num value={g.leads} /></td></tr>)}</tbody>
                  </table>
                </div>
              ))}
            </div>
          </Block>

          <Block title="Every calculation" blurb="No names and no websites — a calculation only has those once the visitor leaves an email."
            right={data.runs.length > 50 ? <button type="button" className="adm-hs-link" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show the newest 50" : `Show all ${data.runs.length}`}</button> : null}>
            <div className="adm-hs-tablewrap">
              <table className="adm-hs-table">
                <thead><tr><th>When</th><th>Business type</th><th className="n">Leads/mo</th><th className="n">Close</th><th className="n">Per client</th><th className="n">Ask AI</th><th className="n">AI score</th><th className="n">Shown +/yr</th><th>Changed?</th><th>Lead?</th></tr></thead>
                <tbody>
                  {runRows.map((r) => (
                    <tr key={r.id || r.run_key}>
                      <td className="dim">{String(r.created_at || "").slice(0, 16).replace("T", " ")}</td>
                      <td>{CALC_INDUSTRY_LABELS[r.industry] || r.industry}</td>
                      <td className="n">{r.leads_per_month ?? "—"}</td>
                      <td className="n">{r.close_rate === null || r.close_rate === undefined ? "—" : `${r.close_rate}%`}</td>
                      <td className="n">{usd(r.client_value)}</td>
                      <td className="n">{r.ai_share === null || r.ai_share === undefined ? "—" : `${r.ai_share}%`}</td>
                      <td className="n">{r.ai_score ?? "—"}{r.score_measured ? " ✓" : ""}</td>
                      <td className="n">{usd(r.added_revenue)}{r.capped ? " (capped)" : ""}</td>
                      <td>{r.edited ? "yes" : <span className="dim">starting guesses</span>}</td>
                      <td>{r.lead_id ? "yes" : <span className="dim">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Block>

          <Block title="How these numbers are counted" blurb="Written down so they can be argued with.">
            <div className="adm-hs-tablewrap">
              <table className="adm-hs-table"><tbody>
                <tr><td>One calculation</td><td className="dim">One visit's use of the calculator. Changing ten numbers is one row with the last numbers, not ten rows.</td></tr>
                <tr><td>Changed the numbers</td><td className="dim">They moved at least one input off the starting guesses. Only these rows go into medians and averages.</td></tr>
                <tr><td>Added revenue shown</td><td className="dim">What the calculator displayed, from the page's own maths. An estimate we showed, not a result we measured.</td></tr>
                <tr><td>Lift</td><td className="dim">Added revenue ÷ their yearly revenue — the one they typed, or leads × 12 × close rate × value of a client. Never above 25%, because the calculator never shows more; a posted result above that is dropped as not from the page.</td></tr>
                <tr><td>AI score</td><td className="dim">“measured” means our scan read their site. Otherwise it is the slider, which starts at 40.</td></tr>
              </tbody></table>
            </div>
          </Block>
        </>
      )}
    </div>
  );
}
