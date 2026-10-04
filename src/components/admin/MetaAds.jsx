import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "../../lib/router.js";
import { useScreenContext } from "../../lib/screenContext.js";
import { toast } from "../../lib/toast.js";
import { getMetaAds } from "../../lib/moneyApi.js";
import { SectionHeader, EmptyState, timeAgo, useNow } from "./shared.jsx";
import { Figure, FigureGrid, Block, BasisBadge } from "./financeParts.jsx";
import { Pct, Num } from "./homeServicesParts.jsx";
import { PAGE_LABELS, teamToday } from "../../../lib/home-services.js";
import { addDays } from "../../../lib/money-range.js";
import { statusWord, RANKING_WORDS, RULES, adFunnel } from "../../../lib/meta-ads.js";
import { MetaFunnel, DayChart, StatusPill } from "./metaParts.jsx";

/* ==================================================================
 * META — every campaign, ad set and ad, and what the people they sent did.
 * 4 Oct 2026.
 *
 * Ryder: "build a page on the admin called META that tracks everything on
 * these ads in a dashboard that i can click refresh to get updated numbers. i
 * want to see every campaign, set and ad and be able to see everything about
 * them, whats working, whats not … a section to be the landing page and to
 * show me where people are dropping off … so that i can view, monitor and
 * adjust to optimize and get more sales."
 *
 * One read: api/meta-ads.js. It returns Meta's numbers, OUR landing-page rows
 * for visits that came from Meta, and Stripe's AI Pulse sales — already joined
 * by the ad's tracking code (utm_campaign). This file only draws.
 *
 * THE BADGES are the same rule as Finance and Home Services:
 *   FROM META  Meta's own reporting. Estimated in places; revised for ~3 days.
 *   MEASURED   rows our landing pages wrote, or Stripe money.
 *   DERIVED    one of those divided by another.
 * A gap is a dash with the reason on hover — never a zero.
 * ================================================================== */

const fmt$ = (v, d = 2) => (v == null ? null : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const fmtN = (v) => (v == null ? null : Number(v).toLocaleString("en-US"));
const fmtP = (v, d = 1) => (v == null ? null : `${Number(v).toFixed(d)}%`);

const LAUNCH_DAY = "2026-10-03";

function presets(today) {
  return [
    { id: "today", label: "Today", from: today, to: today },
    { id: "yesterday", label: "Yesterday", from: addDays(today, -1), to: addDays(today, -1) },
    { id: "7", label: "Last 7 days", from: addDays(today, -6), to: today },
    { id: "launch", label: "Since launch", from: LAUNCH_DAY <= today ? LAUNCH_DAY : today, to: today },
  ];
}

export default function MetaAds() {
  const [, go] = useRoute();
  const today = teamToday();
  const [range, setRange] = useState(() => ({ ...presets(today)[3], preset: "launch" }));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [picked, setPicked] = useState(null);       // ad id shown in the detail panel
  const [funnelCode, setFunnelCode] = useState("all");
  const [hideTests, setHideTests] = useState(true);
  useNow(30000);
  /* Only the newest request may draw. Clicking Today then Yesterday quickly
   * must never leave Yesterday's buttons lit over Today's numbers. */
  const reqId = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const mine = ++reqId.current;
    if (refresh) setRefreshing(true); else setLoading(true);
    setError(null);
    const res = await getMetaAds({ from: range.from, to: range.to }, {
      refresh,
      onCached: (d) => { if (mine === reqId.current) { setData(d); setLoading(false); } },
    });
    if (mine !== reqId.current) return;
    if (res.ok) {
      setData(res.data);
      /* First read: open every campaign and ad set, so the ads are on screen
       * without a click. After that the page keeps whatever was opened. */
      setOpen((cur) => (cur.size ? cur : new Set([...(res.data.campaigns || []).map((c) => c.id), ...(res.data.adsets || []).map((x) => x.id)])));
      if (refresh) toast.success("Updated", `Read at ${new Date(res.data.readAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`);
    } else {
      setError(res.error || "Could not read the Meta page.");
      toast.error("Could not refresh", res.error);
    }
    setLoading(false);
    setRefreshing(false);
  }, [range.from, range.to]);

  useEffect(() => { load(false); }, [load]);

  useScreenContext(() => ({
    page: "meta",
    label: "Meta ads",
    visible: ["Meta ad campaigns, ad sets and ads with spend, clicks, landing-page visits, leads and sales, and where ad visitors drop off on the landing page"],
  }), []);

  const ads = useMemo(() => data?.ads || [], [data]);
  const adById = useMemo(() => Object.fromEntries(ads.map((a) => [a.id, a])), [ads]);
  const pickedAd = picked ? adById[picked] : null;

  /* The funnel to draw: all ads together, or one ad's own visitors. The
   * per-ad funnel is computed from the counts the server already grouped. */
  const funnel = useMemo(() => {
    if (!data) return [];
    if (funnelCode === "all") return data.landing?.funnel || [];
    const ad = ads.find((a) => a.code === funnelCode);
    return ad?.land?.funnel || adFunnel([]);
  }, [data, ads, funnelCode]);

  if (loading && !data) return <div className="adm-hs-loading">Reading Meta, the landing pages and Stripe…</div>;
  const stale = data && data.range && (data.range.from !== range.from || data.range.to !== range.to);

  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const t = data?.total || {};
  const land = data?.landing || {};
  const adsLand = data?.adsLand || {};
  const metaOk = !!data?.meta?.ok;
  const realLeads = (data?.leads || []).filter((l) => !l.test);
  const salesRows = data?.sales?.rows || [];
  const salesFromAds = salesRows.filter((s) => s.code);
  const camp = data?.campaigns?.[0] || null;
  const pace = camp?.pace || null;
  const list = presets(today);

  return (
    <div className="adm-hs adm-meta">
      <SectionHeader
        kicker="Money"
        title="Meta ads"
        subtitle="Every campaign, ad set and ad — what Meta charged, who clicked, and what those people did on our landing page."
        right={
          <div className="adm-meta-refresh">
            <span className="adm-meta-readat" title={data?.readAt ? new Date(data.readAt).toLocaleString("en-US") : ""}>
              {data?.readAt ? <>Updated {timeAgo(data.readAt)}{data.cached ? " · saved copy" : ""}</> : "Not read yet"}
            </span>
            <button type="button" className="btn btn-primary" onClick={() => load(true)} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "↻ Refresh"}
            </button>
          </div>
        }
      />

      <div className="adm-hs-range">
        <div className="adm-hs-presets" role="group" aria-label="Date range">
          {list.map((p) => (
            <button key={p.id} type="button" className={range.preset === p.id ? "active" : ""}
              onClick={() => setRange({ from: p.from, to: p.to, preset: p.id })}>{p.label}</button>
          ))}
        </div>
        <label className="adm-hs-date">From
          <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ from: e.target.value, to: range.to, preset: null })} />
        </label>
        <label className="adm-hs-date">To
          <input type="date" value={range.to} min={range.from} max={today} onChange={(e) => e.target.value && setRange({ from: range.from, to: e.target.value, preset: null })} />
        </label>
      </div>

      {(loading || stale) && <div className="adm-hs-warn">Reading {range.from === range.to ? range.from : `${range.from} to ${range.to}`}… the numbers below are still the previous range until it lands.</div>}
      {data?.meta?.timezoneMismatch && (
        <div className="adm-hs-warn adm-hs-warn-amber"><strong>Two clocks.</strong> The ad account reports days in {data.meta.timezoneMismatch}; our landing pages count Chicago days. Per-day costs can be off by a few hours' worth of traffic.</div>
      )}
      {(data?.meta?.extraErrors || []).length > 0 && (
        <div className="adm-hs-warn"><strong>Some of Meta's extra breakdowns could not be read</strong> (the campaigns, ads and spend did): {data.meta.extraErrors.join(" · ")}</div>
      )}
      {error && <div className="adm-hs-warn"><strong>The last refresh failed.</strong> {error} The numbers below are from the previous read.</div>}

      {data && !metaOk && (
        <div className="adm-hs-warn adm-hs-warn-amber">
          <strong>{data.meta?.kind === "missing" ? "Meta is not connected yet." : "Meta's numbers could not be read."}</strong>{" "}
          {data.meta?.error} {data.meta?.kind === "missing" || data.meta?.kind === "token"
            ? <>The steps are in <code>SETUP.md → Meta page</code>: make a read-only token in Meta Business settings and paste it into Vercel as <code>META_ACCESS_TOKEN</code>.</>
            : null}
        </div>
      )}
      {(land.errors || []).length > 0 && (
        <div className="adm-hs-warn"><strong>Part of our own data could not be read:</strong> {land.errors.join(" · ")}</div>
      )}

      {/* ================= THE TOP LINE ================= */}
      <FigureGrid min={150}>
        <Figure label="Spent" value={metaOk ? fmt$(t.spend) : null} basis="meta"
          sub={pace && (data.campaigns || []).length === 1 ? `Campaign so far: ${fmt$(pace.spent, 0) ?? "—"} of ${fmt$(camp.lifetimeBudget, 0)} · ${pace.daysLeft.toFixed(1)} days left` : null}
          why="Meta is not connected, so spend cannot be read." />
        <Figure label="Views" value={metaOk ? fmtN(t.impressions) : null} basis="meta" means="Times an ad was on someone's screen." why="Meta is not connected." />
        <Figure label="Link clicks" value={metaOk ? fmtN(t.linkClicks) : null} basis="meta"
          sub={metaOk && t.ctrLink != null ? `${fmtP(t.ctrLink)} of views clicked` : null} why="Meta is not connected." />
        <Figure label="Cost per click" value={metaOk ? fmt$(t.cpcLink) : null} basis="derived" why="No clicks yet, or Meta is not connected." />
        <Figure label="Page loads (Meta)" value={metaOk ? fmtN(t.landingViews) : null} basis="meta"
          sub={metaOk && t.costPerLanding != null ? `${fmt$(t.costPerLanding)} each` : null}
          means="Clicks where our page finished loading, by Meta's count." why="Meta is not connected." />
      </FigureGrid>
      <div style={{ height: 12 }} />
      <FigureGrid min={150}>
        <Figure label="Visitors (our count)" value={fmtN(land.sessions)} basis="counted"
          sub={metaOk && t.spend > 0 && land.sessions ? `${fmt$(t.spend / land.sessions)} each` : null}
          means="Separate visits our page recorded from the ads." />
        <Figure label="Emails / leads" value={fmtN(land.leads)} basis="counted"
          sub={land.leadRate != null ? `${fmtP(land.leadRate)} of visitors` : null}
          means="People from the ads who left their details. Test leads left out." />
        <Figure label="Cost per lead" value={metaOk && land.leads > 0 ? fmt$(t.spend / land.leads) : null} basis="derived"
          why={land.leads ? "Meta is not connected, so there is no spend to divide." : "No leads yet — there is nothing to divide by. This is not $0."} />
        <Figure label="Opened checkout" value={fmtN(land.checkoutOpens)} basis="counted"
          sub={land.pressedPay ? `${land.pressedPay} pressed Pay` : null} />
        <Figure label="Sales" value={data?.sales?.ok ? fmtN(salesRows.length) : null} basis="stripe"
          sub={data?.sales?.ok ? `${salesFromAds.length} matched to an ad` : null}
          means="New AI Pulse subscriptions in Stripe in these days, from any source."
          why={data?.sales?.why || "Stripe could not be read."} />
      </FigureGrid>

      {/* ================= WHAT'S WORKING ================= */}
      <Block
        title="What's working, and what isn't"
        blurb="Written from the numbers below by fixed rules (listed at the bottom of the page). Problems first. Nothing is judged on too little data — it says too early instead."
        right={<BasisBadge basis="derived" />}
      >
        {!(data?.verdicts || []).length ? (
          <p className="adm-hs-note">Nothing to say yet — too little data in this date range.</p>
        ) : (
          <ul className="adm-meta-verdicts">
            {data.verdicts.map((v, i) => (
              <li key={i} className={`adm-meta-v adm-meta-v-${v.tone}`}>
                <span className="adm-meta-v-dot" aria-hidden="true" />
                <div>
                  <strong>{v.title}</strong>
                  <div>{v.body}</div>
                  {v.adId && adById[v.adId] && (
                    <button type="button" className="adm-hs-link" onClick={() => { setPicked(v.adId); document.getElementById("meta-ad-detail")?.scrollIntoView({ behavior: "smooth" }); }}>See this ad →</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Block>

      {/* ================= THE TREE ================= */}
      <Block
        title="Campaigns, ad sets and ads"
        blurb="Click a campaign or ad set to open it. Click an ad's name for everything about it. Grey columns are Meta's numbers; the rest are what those visitors did on our page."
        right={<span className="adm-meta-legend"><BasisBadge basis="meta" /> <BasisBadge basis="counted" /></span>}
      >
        {!metaOk && !ads.length ? (
          <EmptyState title="No ads to list" body="The campaign list comes from Meta. Connect it (see the yellow note above) and every campaign, ad set and ad appears here." />
        ) : (
          <div className="adm-hs-tablewrap">
            <table className="adm-hs-table adm-meta-tree">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="n m">Spent</th>
                  <th className="n m">Views</th>
                  <th className="n m">Link clicks</th>
                  <th className="n m" title="Link clicks ÷ views">CTR</th>
                  <th className="n m">Per click</th>
                  <th className="n m" title="Meta's count of clicks where the page loaded">Page loads</th>
                  <th className="n" title="Separate visits our page recorded from this ad">Visitors</th>
                  <th className="n" title="Visitors who tapped into the free-scan form">Tapped form</th>
                  <th className="n" title="Visitors who gave their email">Emails</th>
                  <th className="n">Leads</th>
                  <th className="n">Per lead</th>
                  <th className="n">Checkout</th>
                  <th className="n">Sales</th>
                </tr>
              </thead>
              <tbody>
                {(data.campaigns || []).map((c) => (
                  <Fragment key={c.id}>
                    <TreeRow row={c} depth={0} open={open.has(c.id)} onToggle={() => toggle(c.id)} />
                    {open.has(c.id) && (data.adsets || []).filter((s) => s.campaignId === c.id).map((s) => (
                      <Fragment key={s.id}>
                        <TreeRow row={s} depth={1} open={open.has(s.id)} onToggle={() => toggle(s.id)} />
                        {open.has(s.id) && ads.filter((a) => a.adsetId === s.id)
                          .slice().sort((x, y) => y.meta.spend - x.meta.spend)
                          .map((a) => (
                            <TreeRow key={a.id} row={a} depth={2} picked={picked === a.id}
                              onPick={() => { setPicked(a.id); setTimeout(() => document.getElementById("meta-ad-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0); }} />
                          ))}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
                {metaOk && (
                  <tr className="adm-meta-total">
                    <td>All ads</td>
                    <td className="n m">{fmt$(t.spend) ?? "—"}</td>
                    <td className="n m"><Num value={t.impressions} /></td>
                    <td className="n m"><Num value={t.linkClicks} /></td>
                    <td className="n m"><Pct value={t.ctrLink} why="No views yet." /></td>
                    <td className="n m">{fmt$(t.cpcLink) ?? <span className="adm-hs-blank">—</span>}</td>
                    <td className="n m"><Num value={t.landingViews} /></td>
                    <td className="n"><Num value={adsLand.sessions} /></td>
                    <td className="n"><Num value={adsLand.tappedForm} /></td>
                    <td className="n"><Num value={adsLand.gaveEmail} /></td>
                    <td className="n"><Num value={adsLand.leads} /></td>
                    <td className="n">{adsLand.leads ? fmt$(t.spend / adsLand.leads) : <span className="adm-hs-blank" title="No leads yet.">—</span>}</td>
                    <td className="n"><Num value={adsLand.checkoutOpens} /></td>
                    <td className="n"><Num value={data.adsSales} /></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {ads.length > 0 && open.size === 0 && (
          <p className="adm-hs-note">
            <button type="button" className="adm-hs-link" onClick={() => setOpen(new Set([...(data.campaigns || []).map((c) => c.id), ...(data.adsets || []).map((s) => s.id)]))}>Open everything</button>
          </p>
        )}
      </Block>

      {/* ================= ONE AD ================= */}
      <div id="meta-ad-detail" />
      {pickedAd ? <AdDetail ad={pickedAd} totalSpend={t.spend} onClose={() => setPicked(null)} />
        : ads.length > 0 && (
          <Block title="One ad, in full" blurb="Pick an ad above — its words, its picture, every number Meta has on it, and what its visitors did, step by step.">
            <div className="adm-meta-chips">
              {ads.slice().sort((x, y) => y.meta.spend - x.meta.spend).map((a) => (
                <button key={a.id} type="button" className="adm-meta-chip" onClick={() => setPicked(a.id)}>
                  {a.name} <span className="dim">{fmt$(a.meta.spend)}</span>
                </button>
              ))}
            </div>
          </Block>
        )}

      {/* ================= DAY BY DAY ================= */}
      <Block title="Day by day" blurb="What Meta spent each day, beside the visitors and leads our page counted from the ads that day." right={<BasisBadge basis="meta" />}>
        {!(data?.daily || []).length ? <p className="adm-hs-note">No days to show yet.</p> : (
          <>
            {metaOk ? <DayChart rows={data.daily} /> : <p className="adm-hs-note">Spend per day needs Meta connected. Visitors and leads per day are in the table.</p>}
            <div className="adm-hs-tablewrap">
              <table className="adm-hs-table">
                <thead><tr><th>Day</th><th className="n">Spent</th><th className="n">Views</th><th className="n">Link clicks</th><th className="n">Page loads</th><th className="n">Our visitors</th><th className="n">Leads</th><th className="n">Per lead</th></tr></thead>
                <tbody>
                  {data.daily.slice().reverse().map((d) => (
                    <tr key={d.day}>
                      <td>{new Date(`${d.day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}</td>
                      <td className="n">{metaOk ? fmt$(d.spend) : "—"}</td>
                      <td className="n">{metaOk ? <Num value={d.impressions} /> : "—"}</td>
                      <td className="n">{metaOk ? <Num value={d.linkClicks} /> : "—"}</td>
                      <td className="n">{metaOk ? <Num value={d.landingViews} /> : "—"}</td>
                      <td className="n"><Num value={d.visits} /></td>
                      <td className="n"><Num value={d.leads} /></td>
                      <td className="n">{metaOk && d.leads ? fmt$(d.spend / d.leads) : <span className="adm-hs-blank" title="No leads that day.">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Block>

      {/* ================= WHERE AND WHO ================= */}
      {metaOk && (
        <div className="adm-meta-grid3">
          <Breakdown title="Where the ads show" blurb="Facebook feed, Instagram Reels, Stories…" rows={data.placements} />
          <Breakdown title="Who sees them" blurb="Age and gender, as Meta reports it." rows={data.ages} />
          <Breakdown title="On what" blurb="The device the ad was seen on." rows={data.devices} />
        </div>
      )}

      {/* ================= THE LANDING PAGE ================= */}
      <h2 className="adm-meta-h2" id="meta-landing">The landing page — what ad visitors did</h2>
      <p className="adm-hs-note" style={{ marginTop: 0 }}>
        Only visits that arrived from a Meta ad (tracking tag <code>utm_source=meta</code>). Counted by our own page, visit by visit. Test visits are left out.
      </p>

      <FigureGrid min={150}>
        <Figure label="Visitors" value={fmtN(land.sessions)} basis="counted" />
        <Figure label="Left inside 10 seconds" value={fmtP(land.bounced10s, 0)} basis="derived" means="Less than 10 seconds of activity and never scrolled past the first screen." why="No heat-map rows from ad visitors yet." />
        <Figure label="Typical time on page" value={land.medianActiveSec != null ? `${Math.round(land.medianActiveSec)} sec` : null} basis="counted" means="Half of visitors spent less, half more (active time only)." why="No heat-map rows from ad visitors yet." />
        <Figure label="Typical scroll depth" value={fmtP(land.medianScroll, 0)} basis="counted" means="How far down the page the middle visitor got." why="No heat-map rows from ad visitors yet." />
        <Figure label="Scans that failed" value={fmtN(land.scansFailed)} basis="counted" means="Did everything right and got an error from the free scan." />
      </FigureGrid>

      <div className="adm-meta-grid2">
        <Block
          title="Where people drop off"
          blurb="Each step counts visits that got that far. The bar is the share of everyone who landed."
          right={
            <select value={funnelCode} onChange={(e) => setFunnelCode(e.target.value)} aria-label="Which ad">
              <option value="all">All ads together</option>
              {ads.filter((a) => a.code).map((a) => <option key={a.id} value={a.code}>{a.name}</option>)}
            </select>
          }
        >
          <MetaFunnel steps={funnel} />
        </Block>

        <Block title="How far down they read" blurb="Share of ad visitors whose screen reached each section of the page, top to bottom." right={<BasisBadge basis="counted" />}>
          {!(land.sections || []).length || !land.heatViews ? (
            <p className="adm-hs-note">No heat-map rows from ad visitors in these days.</p>
          ) : (
            <ol className="adm-meta-ladder">
              {land.sections.map((z) => (
                <li key={z.key}>
                  <div className="adm-hs-funnel-row">
                    <span className="adm-hs-funnel-label">{z.label}</span>
                    <span className="adm-hs-funnel-n"><Num value={z.reached} /></span>
                    <span className="adm-hs-funnel-pct"><Pct value={z.pct} digits={0} /></span>
                  </div>
                  <div className="adm-hs-funnel-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, z.pct ?? 0)}%` }} /></div>
                  {z.avgSec != null && <div className="adm-hs-funnel-drop">{Math.round(z.avgSec)} sec on screen on average, for those who reached it</div>}
                </li>
              ))}
            </ol>
          )}
          <p className="adm-hs-note"><button type="button" className="adm-hs-link" onClick={() => go("#/dashboard/home-services-heat")}>Open the full heat map →</button></p>
        </Block>
      </div>

      <div className="adm-meta-grid2">
        <Block title="What they tapped" blurb="The buttons and boxes ad visitors tapped, by how many people tapped each." right={<BasisBadge basis="counted" />}>
          {!(land.taps || []).length ? <p className="adm-hs-note">No taps recorded from ad visitors yet.</p> : (
            <div className="adm-hs-tablewrap">
              <table className="adm-hs-table" style={{ minWidth: 0 }}>
                <thead><tr><th>What</th><th>Where</th><th className="n">People</th><th className="n">Taps</th></tr></thead>
                <tbody>{land.taps.map((x) => (
                  <tr key={x.target}><td>{x.target.replace(/^field:/, "box: ")}</td><td className="dim">{x.zone || "—"}</td><td className="n"><Num value={x.sessions} /></td><td className="n"><Num value={x.clicks} /></td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Block>
        <Block title="Which page, which device" blurb="Where the ads landed people, and what they were holding." right={<BasisBadge basis="counted" />}>
          <div className="adm-hs-tablewrap">
            <table className="adm-hs-table" style={{ minWidth: 0 }}>
              <tbody>
                {(land.byPage || []).map((p) => <tr key={p.slug}><td>{PAGE_LABELS[p.slug] || p.slug}</td><td className="n"><Num value={p.sessions} /> visitors</td></tr>)}
                {Object.entries(land.devices || {}).sort((a, b) => b[1] - a[1]).map(([d, n]) => <tr key={d}><td className="dim">On {d}</td><td className="n"><Num value={n} /> page loads</td></tr>)}
              </tbody>
            </table>
          </div>
        </Block>
      </div>

      {/* ================= LEADS AND SALES ================= */}
      <Block
        title="Leads from the ads"
        blurb="Everyone from a Meta ad who left their details, newest first. Click a name to open them on the Sales page."
        right={<label className="adm-hs-toggle"><input type="checkbox" checked={hideTests} onChange={(e) => setHideTests(e.target.checked)} /> Hide tests</label>}
      >
        {!(hideTests ? realLeads : data?.leads || []).length ? (
          <EmptyState title="No leads from the ads in these days" body="When someone from an ad leaves their email, they appear here and on the Sales page in the same moment." />
        ) : (
          <div className="adm-hs-tablewrap">
            <table className="adm-hs-table">
              <thead><tr><th>Who</th><th>Email / phone</th><th>Ad</th><th>Page</th><th>Checkout</th><th>When</th><th /></tr></thead>
              <tbody>
                {(hideTests ? realLeads : data.leads).map((l) => (
                  <tr key={l.leadId}>
                    <td><strong>{l.name || l.company || "(no name)"}</strong>{l.company && l.name ? <span className="dim"> · {l.company}</span> : null}{l.test ? <span className="adm-meta-test"> TEST</span> : null}{l.domain ? <div className="dim">{l.domain}</div> : null}</td>
                    <td>{l.email || "—"}{l.phone ? <div className="dim">{l.phone}</div> : null}</td>
                    <td>{adNameFor(ads, l.code) || <span className="dim">{l.code || "—"}</span>}</td>
                    <td>{PAGE_LABELS[l.page] || l.page}</td>
                    <td>{l.paid ? <strong>paid</strong> : l.reachedCheckout ? "opened" : <span className="dim">no</span>}</td>
                    <td className="dim">{l.at ? new Date(l.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</td>
                    <td className="n"><button type="button" className="adm-hs-link" onClick={() => go(`#/dashboard/sales?lead=${l.leadId}`)}>Open in Sales →</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      <Block
        title="Sales"
        blurb="New AI Pulse subscriptions in Stripe in these days. Stripe does not know which ad a buyer came from, so each sale is matched to an ad through its lead — same email or same website."
        right={<BasisBadge basis="stripe" />}
      >
        {!data?.sales?.ok ? <p className="adm-hs-note">{data?.sales?.why || "Stripe could not be read."}</p>
          : !salesRows.length ? <EmptyState title="No sales in these days" body="Nobody started an AI Pulse subscription in this date range." />
            : (
              <div className="adm-hs-tablewrap">
                <table className="adm-hs-table">
                  <thead><tr><th>Customer</th><th>Plan</th><th>Status</th><th>From ad</th><th>When</th></tr></thead>
                  <tbody>{salesRows.map((s) => (
                    <tr key={s.id}>
                      <td><strong>{s.name || s.business || s.email || s.id}</strong>{s.email ? <div className="dim">{s.email}</div> : null}</td>
                      <td>${s.amount}/{s.interval === "year" ? "yr" : "mo"}</td>
                      <td>{s.status}</td>
                      <td>{s.code ? <>{adNameFor(ads, s.code) || s.code} <span className="dim">· by {s.matchedBy}</span></> : <span className="dim">not matched to an ad</span>}</td>
                      <td className="dim">{new Date(s.created).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
      </Block>

      {(data?.unmatchedCodes || []).length > 0 && (
        <Block title="Visits from Meta that no ad matches" blurb="A tracking code no current ad uses — our own tests, an old ad, or a link someone shared. Kept apart so they never inflate an ad's numbers." right={<BasisBadge basis="counted" />}>
          <div className="adm-hs-tablewrap">
            <table className="adm-hs-table" style={{ minWidth: 0 }}>
              <thead><tr><th>Tracking code</th><th className="n">Visitors</th><th className="n">Leads</th></tr></thead>
              <tbody>{data.unmatchedCodes.map((u) => (
                <tr key={u.code}><td>{u.code}{u.test ? <span className="adm-meta-test"> TEST</span> : null}</td><td className="n"><Num value={u.land.sessions} /></td><td className="n"><Num value={u.land.leads} /></td></tr>
              ))}</tbody>
            </table>
          </div>
        </Block>
      )}

      {/* ================= THE RULES ================= */}
      <Block title="How to read this page" blurb="The badges, and the rules the verdicts at the top are written from.">
        <div className="adm-hs-tablewrap">
          <table className="adm-hs-table" style={{ minWidth: 0 }}>
            <tbody>
              <tr><td><BasisBadge basis="meta" /></td><td>Meta's own reporting. Some of it is estimated, and Meta can revise the last three days.</td></tr>
              <tr><td><BasisBadge basis="counted" /></td><td>Counted from rows our landing pages wrote. Somebody did a thing and a row exists saying so.</td></tr>
              <tr><td><BasisBadge basis="stripe" /></td><td>Stripe — real money that moved.</td></tr>
              <tr><td><BasisBadge basis="derived" /></td><td>One of the above divided by another.</td></tr>
              <tr><td><span className="adm-hs-blank">—</span></td><td>Cannot be worked out yet (usually nothing to divide by). Never a zero in disguise.</td></tr>
              <tr><td>Page loads vs visitors</td><td>Meta's "page loads" and our "visitors" are two counts of nearly the same thing. They will not match exactly: Meta needs its pixel to load, we count every visit with the tag.</td></tr>
              <tr><td>Verdict rules</td><td>
                No CTR verdict under {RULES.minImpressionsToJudge.toLocaleString("en-US")} views · no cost verdict under {RULES.minClicksToJudge} clicks · no page verdict under {RULES.minVisitsToJudgeForm} visitors ·
                low CTR is under {RULES.lowCtrPct}% · clicks-that-never-load is under {RULES.lowLoadRatePct}% · tired audience is {RULES.highFrequency}+ views per person ·
                starved is under {RULES.starvedSpendShare}% of spend · stuck is {RULES.stuckHours}+ hours on with no views. These are our own rules of thumb, kept in <code>lib/meta-ads.js</code>, not Meta's.
              </td></tr>
            </tbody>
          </table>
        </div>
        {metaOk && <p className="adm-hs-note">Ad account {data.meta.account.name || data.meta.account.id} · {data.meta.account.timezone || "timezone unknown"} · read with Marketing API {data.meta.version} in {data.ms} ms.</p>}
      </Block>
    </div>
  );
}

function adNameFor(ads, code) {
  if (!code) return null;
  const a = ads.find((x) => x.code && x.code.toLowerCase() === String(code).toLowerCase());
  return a ? a.name : null;
}

function TreeRow({ row, depth, open, onToggle, onPick, picked }) {
  const m = row.meta || {};
  const l = row.land || {};
  const isAd = row.level === "ad";
  return (
    <tr className={`adm-meta-row d${depth}${picked ? " picked" : ""}`}>
      <td>
        <div className="adm-meta-name" style={{ paddingLeft: depth * 18 }}>
          {!isAd
            ? <button type="button" className="adm-meta-caret" aria-expanded={!!open} onClick={onToggle} aria-label={open ? "Close" : "Open"}>{open ? "▾" : "▸"}</button>
            : <span className="adm-meta-caret-spacer" />}
          {isAd ? <button type="button" className="adm-hs-link adm-meta-adname" onClick={onPick}>{row.name}</button>
            : <button type="button" className="adm-meta-groupname" onClick={onToggle}>{row.name}</button>}
          <StatusPill status={row.status} />
          {isAd && row.sharedCode && <span className="adm-meta-test" title={`Another ad uses the same tracking code (${row.code}), so their visitors cannot be told apart. The visitor numbers on this line are for every ad with that code; totals above count them once.`}>SHARED CODE</span>}
          {!isAd && <span className="adm-meta-level">{row.level === "campaign" ? "campaign" : "ad set"}</span>}
        </div>
      </td>
      <td className="n m">{fmt$(m.spend) ?? "—"}</td>
      <td className="n m"><Num value={m.impressions} /></td>
      <td className="n m"><Num value={m.linkClicks} /></td>
      <td className="n m"><Pct value={m.ctrLink} why="No views yet." /></td>
      <td className="n m">{fmt$(m.cpcLink) ?? <span className="adm-hs-blank" title="No clicks yet.">—</span>}</td>
      <td className="n m"><Num value={m.landingViews} /></td>
      <td className="n">{row.land ? <Num value={l.sessions} /> : <span className="adm-hs-blank" title="This ad has no tracking code we can read, so its visitors cannot be told apart.">—</span>}</td>
      <td className="n">{row.land ? <Num value={l.tappedForm} /> : "—"}</td>
      <td className="n">{row.land ? <Num value={l.gaveEmail} /> : "—"}</td>
      <td className="n">{row.land ? <Num value={l.leads} /> : "—"}</td>
      <td className="n">{fmt$(row.costs?.perLead) ?? <span className="adm-hs-blank" title="No leads yet — nothing to divide by.">—</span>}</td>
      <td className="n">{row.land ? <Num value={l.checkoutOpens} /> : "—"}</td>
      <td className="n"><Num value={row.sales} /></td>
    </tr>
  );
}

function Breakdown({ title, blurb, rows = [] }) {
  return (
    <Block title={title} blurb={blurb} right={<BasisBadge basis="meta" />}>
      {!rows.length ? <p className="adm-hs-note">Nothing yet.</p> : (
        <div className="adm-hs-tablewrap">
          <table className="adm-hs-table" style={{ minWidth: 0 }}>
            <thead><tr><th>Where</th><th className="n">Spent</th><th className="n">Clicks</th><th className="n">CTR</th></tr></thead>
            <tbody>{rows.slice(0, 10).map((r) => (
              <tr key={r.label}><td>{r.label}</td><td className="n">{fmt$(r.spend)}</td><td className="n"><Num value={r.linkClicks} /></td><td className="n"><Pct value={r.ctrLink} why="No views." /></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Block>
  );
}

function AdDetail({ ad, totalSpend, onClose }) {
  const m = ad.meta;
  const l = ad.land;
  const c = ad.creative || {};
  const s = statusWord(ad.status);
  const share = totalSpend > 0 ? (m.spend / totalSpend) * 100 : null;
  const rows = [
    ["Spent", fmt$(m.spend), share != null ? `${share.toFixed(0)}% of all ad spend` : null, "meta"],
    ["Views", fmtN(m.impressions), m.reach != null ? `${fmtN(m.reach)} different people · ${m.frequency?.toFixed(2)} each` : null, "meta"],
    ["Cost per 1,000 views", fmt$(m.cpm), null, "derived"],
    ["Link clicks", fmtN(m.linkClicks), m.ctrLink != null ? `${fmtP(m.ctrLink, 2)} of views` : null, "meta"],
    ["All clicks", fmtN(m.clicksAll), "includes likes, profile taps, 'see more'", "meta"],
    ["Cost per link click", fmt$(m.cpcLink), null, "derived"],
    ["Page loads", fmtN(m.landingViews), m.loadRate != null ? `${fmtP(m.loadRate, 0)} of clicks loaded the page` : null, "meta"],
    ["Cost per page load", fmt$(m.costPerLanding), null, "derived"],
    ["Meta's pixel: leads", fmtN(m.metaLeads), "Meta's count, not ours", "meta"],
    ["Meta's pixel: checkouts", fmtN(m.metaCheckouts), null, "meta"],
    ["Meta's pixel: purchases", fmtN(m.metaPurchases), null, "meta"],
    ["Likes · comments · shares · saves", [m.reactions, m.comments, m.shares, m.saves].map((v) => (v == null ? "—" : fmtN(v))).join(" · "), null, "meta"],
  ];
  const video = c.isVideo || m.videoViews3s != null;
  return (
    <Block
      title={ad.name}
      blurb={<>
        <StatusPill status={ad.status} /> {s.label}
        {ad.code ? <> · tracking code <code>{ad.code}</code></> : <> · <span className="adm-hs-blank">no tracking code found — its visitors cannot be told apart</span></>}
        {ad.path ? <> · sends people to <code>{ad.path}</code></> : null}
      </>}
      right={<button type="button" className="btn" onClick={onClose}>Close</button>}
    >
      {ad.sharedCode && <div className="adm-hs-warn adm-hs-warn-amber"><strong>Another ad uses the same tracking code.</strong> The landing-page numbers below are for every ad sending <code>{ad.code}</code>, not this one alone. Give each ad its own code in Ads Manager → the ad → URL parameters.</div>}
      {ad.issues.length > 0 && (
        <div className="adm-hs-warn"><strong>Meta flagged this ad:</strong> {ad.issues.map((i) => i.text).join(" · ")}</div>
      )}
      <div className="adm-meta-detail">
        <div className="adm-meta-creative">
          {c.thumbnail ? <img src={c.thumbnail} alt={`Thumbnail of the ad ${ad.name}`} loading="lazy" /> : <div className="adm-meta-nothumb">No picture from Meta</div>}
          <div className="adm-meta-kind">{c.isCarousel ? `Carousel · ${c.cards.length} cards` : c.isVideo ? "Video" : "Picture"}{c.cta ? ` · button: ${c.cta.replace(/_/g, " ").toLowerCase()}` : ""}</div>
          {c.title && <div className="adm-meta-headline">{c.title}</div>}
          {c.body && <p className="adm-meta-body">{c.body}</p>}
          {c.isCarousel && (
            <ol className="adm-meta-cards">{c.cards.map((k, i) => <li key={i}>{k.name || "(no headline)"}</li>)}</ol>
          )}
        </div>
        <div>
          <h4 className="adm-meta-h4">Meta's numbers</h4>
          <table className="adm-hs-table adm-meta-kv" style={{ minWidth: 0 }}>
            <tbody>{rows.map(([k, v, sub, b]) => (
              <tr key={k}><td>{k}</td><td className="n"><strong>{v ?? <span className="adm-hs-blank">—</span>}</strong>{sub ? <div className="dim" style={{ fontWeight: 400 }}>{sub}</div> : null}</td><td><BasisBadge basis={b} /></td></tr>
            ))}</tbody>
          </table>
          {video && (
            <>
              <h4 className="adm-meta-h4">How much of the video people watched</h4>
              <table className="adm-hs-table" style={{ minWidth: 0 }}>
                <tbody>
                  <tr><td>Watched 3+ seconds</td><td className="n"><strong>{fmtN(m.videoViews3s) ?? "—"}</strong> <span className="dim">{m.hookRate != null ? `· ${fmtP(m.hookRate, 0)} of views (the hook)` : ""}</span></td></tr>
                  <tr><td>Watched a quarter</td><td className="n">{fmtN(m.videoP25) ?? "—"}</td></tr>
                  <tr><td>Watched half</td><td className="n">{fmtN(m.videoP50) ?? "—"}</td></tr>
                  <tr><td>Watched three quarters</td><td className="n">{fmtN(m.videoP75) ?? "—"}</td></tr>
                  <tr><td>Watched to the end</td><td className="n">{fmtN(m.videoP100) ?? "—"}</td></tr>
                  <tr><td>ThruPlays (15 sec or the end)</td><td className="n">{fmtN(m.thruplays) ?? "—"} <span className="dim">{m.holdRate != null ? `· ${fmtP(m.holdRate, 0)} of 3-second viewers` : ""}</span></td></tr>
                  <tr><td>Average watch time</td><td className="n">{m.videoAvgSec != null ? `${m.videoAvgSec} sec` : "—"}</td></tr>
                </tbody>
              </table>
            </>
          )}
          <h4 className="adm-meta-h4">How Meta rates it against other ads</h4>
          <p className="adm-hs-note" style={{ marginTop: 0 }}>
            Quality: <strong>{RANKING_WORDS[m.qualityRanking] || "not enough views yet"}</strong> ·
            Engagement: <strong>{RANKING_WORDS[m.engagementRanking] || "not enough views yet"}</strong> ·
            Conversion: <strong>{RANKING_WORDS[m.conversionRanking] || "not enough views yet"}</strong>
            <br />Meta only rates an ad after about 500 views.
          </p>
        </div>
        <div>
          <h4 className="adm-meta-h4">What its visitors did on our page</h4>
          {l ? <MetaFunnel steps={l.funnel} compact /> : <p className="adm-hs-note">No tracking code, so its visitors cannot be told apart.</p>}
          {l && (
            <table className="adm-hs-table" style={{ minWidth: 0, marginTop: 12 }}>
              <tbody>
                <tr><td>Cost per visitor</td><td className="n">{fmt$(ad.costs.perVisit) ?? <span className="adm-hs-blank">—</span>}</td></tr>
                <tr><td>Cost per email</td><td className="n">{fmt$(ad.costs.perEmail) ?? <span className="adm-hs-blank" title="No emails yet.">—</span>}</td></tr>
                <tr><td>Cost per lead</td><td className="n">{fmt$(ad.costs.perLead) ?? <span className="adm-hs-blank" title="No leads yet.">—</span>}</td></tr>
                <tr><td>Cost per checkout opened</td><td className="n">{fmt$(ad.costs.perCheckout) ?? <span className="adm-hs-blank" title="Nobody opened the checkout yet.">—</span>}</td></tr>
                <tr><td>Sales matched to it</td><td className="n"><Num value={ad.sales} /></td></tr>
                <tr><td>Typical time on page</td><td className="n">{l.medianActiveSec != null ? `${Math.round(l.medianActiveSec)} sec` : "—"}</td></tr>
                <tr><td>Left inside 10 seconds</td><td className="n"><Pct value={l.bounced10s} digits={0} why="No heat-map rows for this ad." /></td></tr>
              </tbody>
            </table>
          )}
          {c.link && <p className="adm-hs-note"><a href={c.link} target="_blank" rel="noopener noreferrer">Open the page this ad sends people to ↗</a></p>}
        </div>
      </div>
    </Block>
  );
}
