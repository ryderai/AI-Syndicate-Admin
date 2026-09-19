import { useCallback, useEffect, useMemo, useState } from "react";
import { useRoute } from "../../lib/router.js";
import { useScreenContext } from "../../lib/screenContext.js";
import { isConfigured } from "../../lib/supabase.js";
import { listHsLeads } from "../../lib/data.js";
import { SectionHeader, SourceBadge, EmptyState } from "./shared.jsx";
import { Block } from "./financeParts.jsx";
import { Num, SortHeader, RangePicker } from "./homeServicesParts.jsx";
import {
  PAGE_SLUGS, PAGE_LABELS,
  HS_LEAD_STAGES, HS_LEAD_STAGE_LABELS, HS_FRESH_DAYS, HS_WEAK_SCORE,
  defaultRange, addTeamDays, teamToday, teamDayStartMs, teamDayEndMs,
  hsLeadRows, hsHotLeads, hsLeadTotals, sortRows,
} from "../../../lib/home-services.js";

/* ==================================================================
 * HOME SERVICES → LEADS.  18 Sep 2026.
 *
 * Ryder's ask: "a home service subpage for leads from the page … so they can
 * reach out to hot leads that haven't chosen to purchase yet but put in their
 * email."
 *
 * The page above this one answers "which landing page is worth spending on".
 * This one answers a different question — "who do I ring" — and that is why it
 * is its own address rather than another table on the comparison screen. One is
 * read on a Monday to decide a budget; this one is worked through with a phone
 * in your hand.
 *
 * WHAT MAKES A LEAD HOT, and it is printed on the page as well as written here:
 * they left an email, they have NOT paid, they came in HS_FRESH_DAYS days ago
 * or less, and either they opened the checkout and stopped, or their
 * own site scored HS_WEAK_SCORE or below on our scan. The test lives in
 * lib/home-services.js — isHotLead — because the reps' page shows the same list
 * and two copies of that rule would drift on the first change.
 *
 * THE SCORE IS A COLUMN, NOT A SENTENCE. Until migration 0039 the number a
 * visitor's site got existed only inside the lead's notes, as English. Sorting a
 * call queue worst-first meant a regular expression over free text. Leads
 * captured before 0039 have no score and print "not measured" — which is the
 * truth. A site nobody scanned did not score nought, and it must not sit at the
 * top of a list ordered by "worst first".
 *
 * NOBODY IS ASSIGNED ANYTHING HERE. The page shows who is worth calling and why.
 * It does not tell a named person to call them.
 * ================================================================== */

const PRESETS = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
  { id: "365", label: "Last year", days: 365 },
];

const COLUMNS = [
  { key: "who", label: "Who", numeric: false, title: "Sort by name" },
  { key: "pageLabel", label: "Page", numeric: false, title: "Which landing page they came in from" },
  { key: "score", label: "Score", numeric: true, title: "What their own website scored on our free scan, out of 100. Blank means nobody scanned it." },
  { key: "stageLabel", label: "Got as far as", numeric: false, title: "The last thing they did on the page" },
  { key: "plan", label: "Plan", numeric: false, title: "Which plan they had selected at the checkout. Blank means they never opened it." },
  { key: "daysOld", label: "Days ago", numeric: true, title: "How long since they came in" },
  { key: "utmSource", label: "Came from", numeric: false, title: "The utm_source on the link they clicked" },
];

/** A score, or an honest blank. Never a zero — see the note at the top. */
function Score({ value }) {
  if (value === null || value === undefined) {
    return <span className="adm-hs-blank" title="Nobody scanned this site. It has no score — this is not a score of zero.">not measured</span>;
  }
  const tone = value <= 40 ? "#b42318" : value <= HS_WEAK_SCORE ? "#92400e" : "#006b1a";
  return <strong style={{ color: tone }}>{value}<span style={{ color: "var(--ink-dim)", fontWeight: 500 }}>/100</span></strong>;
}

export default function HomeServicesLeads() {
  const [, go] = useRoute();

  const [range, setRange] = useState(() => ({ ...defaultRange(), preset: "30" }));
  const [data, setData] = useState({ sources: [], leads: [], events: [], errors: [], sample: false });
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState({ key: "daysOld", dir: "asc" });
  const [pageFilter, setPageFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [hotOnly, setHotOnly] = useState(true);
  const [q, setQ] = useState("");

  /* Read once, on the same clock the whole render uses. Calling Date.now() in
   * three places means a lead can be 14 days old in one column and 15 in the
   * one next to it, which is the sort of thing nobody believes twice. */
  const [nowMs, setNowMs] = useState(() => Date.now());

  const { from, to } = range;

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listHsLeads({ fromMs: teamDayStartMs(from), toMs: teamDayEndMs(to), withEvents: false });
    setData(res);
    setNowMs(Date.now());
    setLoading(false);
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const presets = useMemo(() => {
    const today = teamToday();
    return PRESETS.map((p) => ({ ...p, from: addTeamDays(today, -(p.days - 1)), to: today }));
  }, []);

  const rows = useMemo(
    () => hsLeadRows({ sources: data.sources, leads: data.leads, events: data.events, nowMs }),
    [data, nowMs],
  );
  const totals = useMemo(() => hsLeadTotals(rows), [rows]);
  const hot = useMemo(() => hsHotLeads(rows), [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = hotOnly ? hot : rows;
    const filtered = base.filter((r) => {
      if (pageFilter !== "all" && r.pageSlug !== pageFilter) return false;
      if (stageFilter !== "all" && r.stage !== stageFilter) return false;
      if (!needle) return true;
      return [r.name, r.company, r.email, r.domain, r.scannedDomain, r.pageLabel]
        .some((v) => String(v || "").toLowerCase().includes(needle));
    });
    /* The hot list has its own order — checkout first, then worst score — and
     * it is the order a rep should work. Only re-sort when they ask for a
     * different column than the one it opens on. */
    const withWho = filtered.map((r) => ({ ...r, who: r.company || r.name || r.email || "" }));
    if (hotOnly && sort.key === "daysOld" && sort.dir === "asc") return withWho;
    return sortRows(withWho, sort.key, sort.dir);
  }, [rows, hot, hotOnly, pageFilter, stageFilter, q, sort]);

  useScreenContext({
    page: "Home Services — Leads",
    summary: `${totals.total} leads from the landing pages between ${from} and ${to}; ${totals.hot} of them hot (no purchase, ${HS_FRESH_DAYS} days old or less, and either they opened the checkout or scored ${HS_WEAK_SCORE} or below).`,
    rows: shown.slice(0, 25).map((r) => ({
      who: r.company || r.name || r.email, page: r.pageLabel, score: r.score, got_as_far_as: r.stageLabel, days_ago: r.daysOld,
    })),
  });

  /* The badge says what these rows ARE. `sample` comes back from the read
   * itself rather than from isConfigured() — the preview build serves real
   * fixture rows, and calling that "waiting on key" over a full table would be
   * the badge disagreeing with the screen under it. */
  const mode = data.errors?.length ? "error" : data.sample ? "sample" : isConfigured() ? "live" : "waiting";
  const onSort = (key) => setSort((s) => (s.key === key
    ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
    : { key, dir: key === "who" || key === "pageLabel" || key === "stageLabel" || key === "plan" || key === "utmSource" ? "asc" : "desc" }));

  return (
    <div className="adm-hs">
      <SectionHeader
        kicker="Home Services"
        title="Leads from the landing pages"
        subtitle={`Everyone who left an email on one of the nine pages. The list opens on the ones worth ringing today: no purchase, ${HS_FRESH_DAYS} days old or less, and either they opened the checkout and stopped or their own website scored ${HS_WEAK_SCORE} or below on our free scan.`}
        right={<SourceBadge mode={mode} hint={mode === "live" ? "Counted from the rows the landing pages sent" : mode === "sample" ? "Sample rows — this build has no database keys" : "No database keys on this build — nothing can be read"} />}
      />

      <RangePicker
        from={from} to={to} presets={presets} activePreset={range.preset}
        onChange={(r) => setRange(r)}
      />

      {data.errors?.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 18, borderColor: "#fecdca" }}>
          <strong>Part of this could not be read.</strong>{" "}
          {data.errors.join(" · ")}{" "}
          Rows whose person could not be read are still counted below and marked <em>not readable</em>, so the totals do not quietly shrink.
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: 28 }}>Reading the leads…</div>
      ) : totals.total === 0 ? (
        <EmptyState
          icon="◎"
          title="No leads in this range"
          body="Nobody left an email on a landing page between these two dates. That is a count of rows that do not exist, not a measurement of nine failing pages — widen the range, or check the pages are deployed."
        />
      ) : (
        <>
          {/* ---------- the counts ---------- */}
          <Block
            title="What is in here"
            blurb="Counts of rows that exist. There is no percentage on this screen on purpose — this page is a call list, not a report."
          >
            <div className="adm-hs-tablewrap">
              <table className="adm-hs-table">
                <tbody>
                  <tr>
                    <td><strong>Worth ringing today</strong></td>
                    <td className="n"><strong><Num value={totals.hot} /></strong></td>
                    <td>No purchase · {HS_FRESH_DAYS} days old or less · opened the checkout, or scored {HS_WEAK_SCORE} or below</td>
                  </tr>
                  {HS_LEAD_STAGES.map((s) => (
                    <tr key={s}>
                      <td>{HS_LEAD_STAGE_LABELS[s]}</td>
                      <td className="n"><Num value={totals[s]} /></td>
                      <td className="dim">
                        {s === "paid" ? "Already a customer. Not on the call list."
                          : s === "checkout" ? "They saw the price and stopped. The warmest thing on this page."
                          : s === "scored" ? "They ran the free scan and read their number."
                          : "They gave an email, but no score was ever recorded against them."}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>Gave a phone number</td>
                    <td className="n"><Num value={totals.withPhone} /></td>
                    <td className="dim">Only the checkout asks for one, so this is small by design.</td>
                  </tr>
                  {totals.unreadable > 0 && (
                    <tr>
                      <td>Person could not be read</td>
                      <td className="n"><Num value={totals.unreadable} /></td>
                      <td className="dim">The lead row has been deleted, or it is not one you may see. Counted here rather than dropped.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Block>

          {/* ---------- the list ---------- */}
          <Block
            title={hotOnly ? "Worth ringing today" : "Every lead in this range"}
            blurb={hotOnly
              ? "In the order to work it: the people who opened the checkout first, then the worst scores, then the newest."
              : "Everyone, including the ones who already paid and the ones who have gone cold."}
            right={
              <div className="adm-hs-filters">
                <label className="adm-hs-toggle">
                  <input type="checkbox" checked={hotOnly} onChange={(e) => setHotOnly(e.target.checked)} />
                  Only the hot ones
                </label>
                <select value={pageFilter} onChange={(e) => setPageFilter(e.target.value)} aria-label="Filter by landing page">
                  <option value="all">Every page</option>
                  {PAGE_SLUGS.map((s) => <option key={s} value={s}>{PAGE_LABELS[s]}</option>)}
                </select>
                <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} aria-label="Filter by how far they got">
                  <option value="all">However far they got</option>
                  {HS_LEAD_STAGES.map((s) => <option key={s} value={s}>{HS_LEAD_STAGE_LABELS[s]}</option>)}
                </select>
                <input
                  type="search" value={q} onChange={(e) => setQ(e.target.value)}
                  placeholder="Name, company or website" aria-label="Search these leads"
                />
              </div>
            }
          >
            {shown.length === 0 ? (
              <p className="dim" style={{ padding: "8px 2px" }}>
                Nothing matches those filters. {hotOnly && <>Untick <em>Only the hot ones</em> to see the rest.</>}
              </p>
            ) : (
              <div className="adm-hs-tablewrap">
                <table className="adm-hs-table">
                  <thead>
                    <tr>
                      {COLUMNS.map((c) => (
                        <SortHeader key={c.key} id={c.key} label={c.label} sort={sort} onSort={onSort} numeric={c.numeric} title={c.title} />
                      ))}
                      <th className="n">Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.leadId} className={r.hot ? "adm-hs-hot" : ""}>
                        <td>
                          {r.readable ? (
                            <>
                              <strong>{r.company || r.name || "(no name)"}</strong>
                              {r.company && r.name ? <span className="dim"> · {r.name}</span> : null}
                              <div className="dim" style={{ fontSize: 12 }}>
                                {r.email || "no email"}{r.phone ? ` · ${r.phone}` : ""}
                              </div>
                              {/* What was MEASURED, shown only when it differs from the
                                  lead's own website — otherwise it is noise. */}
                              {r.scannedDomain && r.scannedDomain !== r.domain && (
                                <div className="dim" style={{ fontSize: 12 }} title="The address typed into the scan box. The lead's website field says something else.">
                                  scanned: {r.scannedDomain}
                                </div>
                              )}
                              {r.hotReason && <div style={{ fontSize: 12, color: "#92400e" }}>{r.hotReason}</div>}
                            </>
                          ) : (
                            <span className="adm-hs-blank" title="The lead row could not be read — it has been deleted, or it is not one you may see.">not readable</span>
                          )}
                        </td>
                        <td>{r.pageLabel}</td>
                        <td className="n"><Score value={r.score} /></td>
                        <td>{r.stageLabel}</td>
                        <td>{r.plan ? (r.plan === "year" ? "Yearly" : "Monthly") : <span className="dim">—</span>}</td>
                        <td className="n">{r.daysOld === null ? <span className="adm-hs-blank" title="No date on this row.">—</span> : r.daysOld}</td>
                        <td className="dim">{r.utmSource || "—"}</td>
                        <td className="n">
                          <button type="button" className="adm-hs-link" onClick={() => go(`#/dashboard/sales?lead=${r.leadId}`)}>
                            Open in Sales →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Block>

          <Block
            title="How “hot” is decided"
            blurb="Written down so the list can be argued with. All four have to be true."
          >
            <div className="adm-hs-tablewrap">
              <table className="adm-hs-table">
                <tbody>
                  <tr><td>They left an email</td><td className="dim">No email, nothing to reach them with.</td></tr>
                  <tr><td>They have not paid</td><td className="dim">Somebody who bought is a customer, not a lead.</td></tr>
                  <tr><td>{HS_FRESH_DAYS} days old or less</td><td className="dim">Past that they have forgotten they ever scanned their site. They stay on this page; they leave the hot list.</td></tr>
                  <tr><td>Opened the checkout, <em>or</em> scored {HS_WEAK_SCORE} or below</td><td className="dim">Either they saw the price and hesitated, or their own website has a problem worth a phone call. A site with no score is not on the list — nobody measured it.</td></tr>
                </tbody>
              </table>
            </div>
          </Block>
        </>
      )}
    </div>
  );
}
