import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScreenContext } from "../../lib/screenContext.js";
import { isConfigured } from "../../lib/supabase.js";
import { getHeatRollup, getHeatSnapshots } from "../../lib/heatData.js";
import { SectionHeader, SourceBadge, EmptyState } from "./shared.jsx";
import { Figure, FigureGrid, Block, BasisBadge } from "./financeParts.jsx";
import { RangePicker } from "./homeServicesParts.jsx";
import { PAGE_SLUGS, PAGE_LABELS, defaultRange, addTeamDays, teamToday, teamDayStartMs, teamDayEndMs } from "../../../lib/home-services.js";
import { sectionRows, heatSummary, placeCells, targetLabel, orderedZones, ZONE_BY_KEY, RULES, MIN_VIEWS } from "../../../lib/heat-map.js";

/* ==================================================================
 * HEAT MAP — where people look, where they click, where they leave.
 * 30 Sep 2026.
 *
 * CJ, 30 Sep 2026: "Heat map would be cool because we could dig into where
 * people drop off, if we need to move stuff up or down and what we can
 * delete." So the screen answers those three things, in that order:
 *   1. the page, with the clicks painted on it and how far down people got,
 *   2. "What to change" — a short list, each line saying which numbers made
 *      us say it,
 *   3. the section table and the click table underneath, for anyone who
 *      wants to check the list.
 *
 * WHERE IT COMES FROM. The landing pages' own tracker (site.js section 9)
 * posts to /api/hs-heat; migration 0046 holds the rows; hs_heat_rollup()
 * counts them. The pictures are full-length screenshots taken by
 * scripts/heat-snapshots.mjs — aisyndicate.com will not be shown inside
 * another site, so we cannot draw on the live page itself. Clicks are placed
 * by the section they landed in, so a re-taken picture keeps them in place.
 *
 * Same honesty rule as the rest of the console: MEASURED counts, DERIVED
 * percentages and verdicts, and a blank with a reason where we cannot say.
 * ================================================================== */

const PRESETS = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
];

const WHO = [
  { id: "all", label: "Everyone" },
  { id: "leads", label: "People who became leads" },
  { id: "not", label: "People who did not" },
];

const DEVICE_LABEL = { mobile: "Phone", tablet: "Tablet", desktop: "Computer" };
const VERDICT_ORDER = { leave: 0, up: 1, cut: 2, dead: 3, keep: 8, few: 9 };

const n0 = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
const p0 = (v) => (v == null ? "—" : `${Math.round(v)}%`);
const secs = (v) => (v == null ? "—" : v < 60 ? `${v.toFixed(v < 10 ? 1 : 0)}s` : `${Math.floor(v / 60)}m ${String(Math.round(v % 60)).padStart(2, "0")}s`);

function fmtDay(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" });
}

export default function HeatMap() {
  const [slug, setSlug] = useState("lawn-care");
  const [range, setRange] = useState(() => ({ ...defaultRange(), preset: "30" }));
  const [device, setDevice] = useState("");
  const [who, setWho] = useState("all");
  const [source, setSource] = useState("");
  const [content, setContent] = useState("");
  const [mode, setMode] = useState("clicks");
  const [pic, setPic] = useState("desktop");

  const [res, setRes] = useState({ data: null });
  /* The picture's own numbers. A click is placed as a share of its section,
   * and sections reflow between a phone and a computer (the top box is two
   * columns on one and a single stack on the other) — so a phone tap drawn on
   * the computer picture would land in the wrong place. The picture only ever
   * paints clicks from the device it was taken on. */
  const [picRes, setPicRes] = useState({ data: null });
  const reqId = useRef(0);
  const [shots, setShots] = useState(null);
  const [loading, setLoading] = useState(true);

  const { from, to } = range;

  useEffect(() => { getHeatSnapshots().then(setShots); }, []);

  /* A phone filter shows the phone picture; a computer or tablet filter the
   * computer one. With every device, either picture can be picked. */
  const pickDevice = (d) => { setDevice(d); if (d === "mobile") setPic("mobile"); else if (d) setPic("desktop"); };

  const load = useCallback(async () => {
    setLoading(true);
    /* Only the newest request may write to the screen. Change the page and
     * then the device quickly and a slow first reply would otherwise land
     * last and show numbers for filters nobody has picked any more. */
    const id = ++reqId.current;
    const base = { slug, fromMs: teamDayStartMs(from), toMs: teamDayEndMs(to), source: source || null, content: content || null, who };
    const picDevice = pic === "mobile" ? "mobile" : "desktop";
    const [r, pr] = await Promise.all([
      getHeatRollup({ ...base, device: device || null }),
      device === picDevice ? null : getHeatRollup({ ...base, device: picDevice }),
    ]);
    if (id !== reqId.current) return;
    setRes(r);
    setPicRes(pr || r);
    setLoading(false);
  }, [slug, from, to, device, source, content, who, pic]);

  useEffect(() => { load(); }, [load]);

  /* A new page has different ads; an ad picked on the last page would filter
   * this one to nothing and read as "no data". */
  const pickPage = (s) => { setSlug(s); setSource(""); setContent(""); };

  useScreenContext(() => ({
    page: "home-services-heat",
    label: "Heat map",
    visible: [`Heat map for the ${PAGE_LABELS[slug]} landing page: clicks, how far people scroll, time per section, and suggested changes`],
  }), [slug]);

  const layout = shots?.pages?.[slug]?.[pic] || null;
  const data = res.data;
  const summary = useMemo(() => heatSummary(data), [data]);
  const rows = useMemo(() => sectionRows(data, layout || shots?.pages?.[slug]?.desktop), [data, layout, shots, slug]);
  const picRows = useMemo(() => sectionRows(picRes.data, layout), [picRes, layout]);
  const picDevice = pic === "mobile" ? "mobile" : "desktop";
  const picData = picRes.data;
  const placed = useMemo(() => placeCells(picData?.grid || [], layout), [picData, layout]);

  const presets = PRESETS.map((p) => {
    const end = teamToday();
    return { id: p.id, label: p.label, from: addTeamDays(end, -(p.days - 1)), to: end };
  });

  const mode_ = res.sample ? "sample" : res.error ? "error" : isConfigured() ? "live" : "sample";
  const nothing = !data || data.views === 0;

  const changes = rows
    .flatMap((r) => r.verdicts.map((v) => ({ ...v, row: r })))
    .filter((v) => v.id !== "keep" && v.id !== "few")
    .sort((a, b) => VERDICT_ORDER[a.id] - VERDICT_ORDER[b.id]);
  const tooFew = data && data.views > 0 && data.views < MIN_VIEWS;

  const opts = data?.options || { devices: [], sources: [], contents: [] };

  return (
    <div className="adm-hs adm-heat">
      <SectionHeader
        kicker="Command"
        title="Heat map"
        subtitle="Where people look, where they click, and where they leave — for each landing page. Use it to decide what to move up, what to cut, and what to fix."
        right={<SourceBadge mode={mode_} hint={mode_ === "live" ? "Counted from the rows the landing pages sent" : mode_ === "error" ? res.error : "No database keys on this build — these are sample visits, not real ones"} />}
      />

      <div className="adm-heat-controls">
        <label>Page
          <select value={slug} onChange={(e) => pickPage(e.target.value)}>
            {PAGE_SLUGS.map((s) => <option key={s} value={s}>{PAGE_LABELS[s]}</option>)}
          </select>
        </label>
        <label>Device
          <select value={device} onChange={(e) => pickDevice(e.target.value)}>
            <option value="">All devices</option>
            {["mobile", "desktop", "tablet"].map((d) => {
              const o = opts.devices.find((x) => x.value === d);
              return <option key={d} value={d}>{DEVICE_LABEL[d]}{o ? ` (${n0(o.n)})` : ""}</option>;
            })}
          </select>
        </label>
        <label>Who
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            {WHO.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </label>
        <label>Traffic from
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Anywhere</option>
            {opts.sources.map((o) => <option key={o.value} value={o.value}>{o.value} ({n0(o.n)})</option>)}
            {source && !opts.sources.some((o) => o.value === source) && <option value={source}>{source}</option>}
          </select>
        </label>
        <label>Ad
          <select value={content} onChange={(e) => setContent(e.target.value)} title="The ad's utm_content tag">
            <option value="">Any ad</option>
            {opts.contents.map((o) => <option key={o.value} value={o.value}>{o.value} ({n0(o.n)})</option>)}
            {content && !opts.contents.some((o) => o.value === content) && <option value={content}>{content}</option>}
          </select>
        </label>
      </div>
      <RangePicker from={from} to={to} activePreset={range.preset} presets={presets} onChange={(r) => setRange(r)} />

      {res.missing && (
        <div className="adm-hs-warn">
          <strong>The heat-map tables are not in the database yet.</strong> Migration
          <code> 0046_landing_heat_map.sql</code> has not been run in Supabase. Until it is, the landing pages&rsquo;
          heat data has nowhere to land and this page has nothing to read.
        </div>
      )}
      {res.error && !res.missing && (
        <div className="adm-hs-warn"><strong>The heat numbers could not be read.</strong> {res.error}</div>
      )}
      {res.sample && (
        <div className="adm-hs-warn adm-hs-warn-amber">
          <strong>Sample visits.</strong> This build has no database keys, so everything below is made-up
          example data showing how the page will read. None of it is a measurement.
        </div>
      )}

      {loading ? (
        <div className="adm-hs-loading">Reading the heat data…</div>
      ) : nothing && !res.error ? (
        <EmptyState
          icon="◉"
          title={`No heat data for ${PAGE_LABELS[slug]} in this range`}
          body="Either nobody has visited in these dates, or the new landing-page tracker has not been deployed yet. This is a blank, not a zero — nothing was measured."
        />
      ) : data ? (
        <>
          <FigureGrid min={150}>
            <Figure label="Visits" value={n0(summary.views)} basis="counted" sub={`${n0(summary.sessions)} browser tabs`} means="Each page load counts once. A tab that reloads is one tab, two visits." />
            <Figure label="Time on page" value={secs(summary.medianSecs)} basis="derived" means="The middle visit. Only time the tab was in front and in use." />
            <Figure label="Got halfway" value={p0(summary.halfPct)} basis="derived" means="Share of visits whose screen reached halfway down the page." />
            <Figure label="Got near the end" value={p0(summary.bottomPct)} basis="derived" means="Share whose screen reached the last tenth of the page." />
            <Figure label="Clicks" value={n0(summary.clicks)} basis="counted" means="Clicks and taps inside the page's sections that reached us." />
            <Figure label="Taps that do nothing" value={n0(summary.dead)} basis="counted" sub={`${n0(summary.rage)} angry repeat taps`} means="Taps on words or pictures that are not links." />
          </FigureGrid>

          <div className="adm-heat-main">
            <Block
              title="The page"
              blurb={layout ? `Picture taken ${fmtDay(layout.taken_at)} at ${layout.viewport?.width || layout.w}px wide. It shows clicks from ${picDevice === "mobile" ? "phones" : "computers"} only, placed by where they landed inside each section — ${n0(picData?.views)} visits. The numbers on the right and below use every visit in your filters.` : "No picture of this page yet."}
              right={<BasisBadge basis="counted" hint="Every dot is a click that was recorded. The colour is how many landed in that spot." />}
            >
              <div className="adm-heat-toggles">
                <div role="group" aria-label="What to show" className="adm-heat-seg">
                  {[["clicks", "Clicks"], ["reach", "How far they got"], ["dead", "Taps that do nothing"]].map(([id, l]) => (
                    <button key={id} type="button" className={mode === id ? "active" : ""} aria-pressed={mode === id} onClick={() => setMode(id)}>{l}</button>
                  ))}
                </div>
                <div role="group" aria-label="Which picture" className="adm-heat-seg">
                  {[["desktop", "Computer"], ["mobile", "Phone"]].map(([id, l]) => (
                    <button key={id} type="button" className={pic === id ? "active" : ""} aria-pressed={pic === id} onClick={() => setPic(id)}>{l}</button>
                  ))}
                </div>
              </div>
              {layout ? (
                <HeatPicture layout={layout} cells={placed.cells} rows={picRows} mode={mode} views={picData?.views || 0} device={picDevice === "mobile" ? "phone" : "computer"} />
              ) : (
                <p className="adm-hs-note">No picture of this page is saved. Run <code>node scripts/heat-snapshots.mjs</code> and redeploy the console. The numbers on the right do not need it.</p>
              )}
              {device === "tablet" && (
                <p className="adm-hs-note">There is no tablet picture. Tablet clicks are in the tables below; the picture shows computer clicks.</p>
              )}
              {placed.skipped > 0 && (
                <p className="adm-hs-note">{n0(placed.skipped)} clicks were in parts that are not in the picture (the scan result or the calculator popup, which only open after a click). They are in the tables below.</p>
              )}
              {layout && <p className="adm-hs-note">The picture has only the first FAQ answer open. Clicks on an answer someone opened lower down are drawn by their share of the FAQ block, so they can sit slightly off.</p>}
            </Block>

            <div className="adm-heat-side">
              <Block title="What to change" blurb="Suggestions, not orders. Each line says which numbers made us say it." right={<BasisBadge basis="derived" />}>
                {tooFew ? (
                  <p className="adm-hs-note">Only {n0(data.views)} visits in this view. Suggestions start at {MIN_VIEWS} — below that, one odd visit swings the numbers too much.</p>
                ) : changes.length === 0 ? (
                  <p className="adm-hs-note">Nothing on this page trips a rule in this view. Every section is marked Keep below.</p>
                ) : (
                  <ul className="adm-heat-changes">
                    {changes.map((c, i) => (
                      <li key={`${c.row.key}-${c.id}-${i}`} className={`v-${c.id}`}>
                        <span className="adm-heat-chip">{c.label}</span>
                        <b>{c.row.label}</b>
                        <span>{c.why}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Block>

              <Block title="How far down people got" blurb="Share of visits whose screen reached each depth of the page." right={<BasisBadge basis="derived" />}>
                <div className="adm-heat-curve">
                  {summary.scrollCurve.map((s) => (
                    <div key={s.depth} className="adm-heat-curve-row">
                      <span className="d">{s.depth}%</span>
                      <span className="bar"><i style={{ width: `${s.pct ?? 0}%` }} /></span>
                      <span className="v">{p0(s.pct)}</span>
                    </div>
                  ))}
                </div>
              </Block>
            </div>
          </div>

          <Block
            title="Section by section"
            blurb="Top to bottom, the way the page reads. Indented rows sit inside the block above them."
            right={<BasisBadge basis="derived" hint="Got here, clicks and taps are counted; the percentages and the verdict are worked out from them." />}
          >
            <div className="adm-hs-tablewrap">
              <table className="adm-hs-table adm-heat-table">
                <thead>
                  <tr>
                    <th>Section</th>
                    <th className="n" title="Share of visits whose screen got at least halfway into this section (or a third of a screen into it), by scrolling or by a jump link">Got this far</th>
                    <th className="n" title="How many points fewer visits got past this block to the next block down">Fewer after</th>
                    <th className="n" title="Average time on screen, for the people who got here">Looked at</th>
                    <th className="n">Clicks</th>
                    <th className="n" title="Share of the clicks on the page itself (not counting the popup or the scan result)">Share</th>
                    <th className="n" title="Clicks by people who became leads at any point — most of them came after they gave their email">By leads</th>
                    <th className="n" title="Separate visits that tapped words or a picture here that is not a link">Do-nothing taps</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className={r.parent ? "sub" : ""}>
                      <td>{r.parent ? "↳ " : ""}{r.label}{r.only && <div className="dim small">{r.only}</div>}</td>
                      <td className="n">{r.only ? <span className="dim">{n0(r.reached)} saw it</span> : p0(r.reachPct)}</td>
                      <td className="n">{r.dropAfter == null ? <span className="dim">—</span> : Math.round(r.dropAfter) === 0 ? "0" : `−${Math.round(r.dropAfter)} pts`}</td>
                      <td className="n">{secs(r.secs)}</td>
                      <td className="n">{n0(r.clicks)}</td>
                      <td className="n">{p0(r.clickShare)}</td>
                      <td className="n">{n0(r.leadClicks)}</td>
                      <td className="n">{n0(r.deadViews)}</td>
                      <td>
                        {r.verdicts.length === 0 && <span className="dim">—</span>}
                        {r.verdicts.map((v) => (
                          <span key={v.id} className={`adm-heat-chip v-${v.id}`} title={v.why}>{v.label}</span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Block>

          <Block title="What people clicked" blurb="The 25 things clicked most in this view. Typing boxes are named, never what was typed. “By leads” here counts only the 200 most-clicked things, so it can run low on a busy page; the section table above is complete." right={<BasisBadge basis="counted" />}>
            <div className="adm-hs-tablewrap">
              <table className="adm-hs-table">
                <thead>
                  <tr><th>What</th><th>Section</th><th className="n">Clicks</th><th className="n">By leads</th><th className="n">Angry repeats</th></tr>
                </thead>
                <tbody>
                  {(data.targets || []).slice(0, 25).map((t, i) => (
                    <tr key={`${t.zone}-${t.target}-${t.kind}-${i}`}>
                      <td>{targetLabel(t)}{t.dead > 0 && <span className="adm-heat-chip v-dead" style={{ marginLeft: 8 }}>does nothing</span>}</td>
                      <td className="dim">{ZONE_BY_KEY[t.zone]?.label || t.zone}</td>
                      <td className="n">{n0(t.n)}</td>
                      <td className="n">{n0(t.by_leads)}</td>
                      <td className="n">{n0(t.rage)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Block>

          <Block title="How this is counted" blurb="So anybody can check a number on this page.">
            <ul className="adm-heat-notes">
              <li><b>A visit</b> is one page load. Visits in the range are the ones that <em>started</em> inside it; a visit&rsquo;s clicks stay with it.</li>
              <li><b>Got this far</b> means the lowest point the visitor&rsquo;s screen reached is at least halfway into the section (or a third of a screen into it). It is depth: a jump link that skips a block still counts the block as passed. <b>Biggest drop-off</b> is where that depth falls most — not the moment anyone closed the tab.</li>
              <li><b>Looked at</b> counts only time the section filled a third of the screen (or 60% of it showed), the tab was open in front, and somebody had moved, scrolled or tapped in the last 30 seconds.</li>
              <li><b>Clicks</b> are placed inside their section as a share of its width and height, so phone and computer clicks land on the same picture.</li>
              <li><b>Verdicts</b> start at {MIN_VIEWS} visits. Move it up: {RULES.moveUp} Biggest drop-off: {RULES.leave} Cut or shorten: {RULES.cut} Fix: {RULES.dead}</li>
              <li><b>A tab nobody looked at</b> (opened in the background and closed) sends nothing and is not a visit.</li>
              <li><b>Never recorded:</b> what anybody types, cookies, IP addresses, or anything that follows a person to another site. Browsers with Global Privacy Control switched on send nothing. <b>Not anonymous:</b> if a visitor later fills in a form, this visit can be matched to their lead — that is how the &ldquo;People who became leads&rdquo; filter works.</li>
              <li><b>No video replays.</b> This shows where people clicked and how far they got, not a recording of any visit.</li>
              <li>First visit in this view: {fmtDay(data.first_at)} · last: {fmtDay(data.last_at)}.</li>
            </ul>
          </Block>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The picture with the heat painted on it                             */
/* ------------------------------------------------------------------ */

/* Blue → green → yellow → red, the usual heat-map scale. 256 steps. */
const PALETTE = (() => {
  const stops = [[0, [37, 99, 235]], [0.35, [16, 185, 129]], [0.6, [250, 204, 21]], [0.8, [249, 115, 22]], [1, [220, 38, 38]]];
  const out = [];
  for (let i = 0; i < 256; i += 1) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k += 1;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0 || 1);
    out.push(c0.map((c, j) => Math.round(c + (c1[j] - c) * f)));
  }
  return out;
})();

function reachColor(pct) {
  if (pct == null) return "rgba(148,163,184,0.25)";
  const t = Math.max(0, Math.min(1, pct / 100));
  const [r, g, b] = PALETTE[Math.round((1 - t) * 255)];
  return `rgba(${r},${g},${b},0.26)`;
}

function HeatPicture({ layout, cells, rows, mode, views, device }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [dispW, setDispW] = useState(520);
  const src = `/heat/${layout.file}`;
  const scale = 0.5;                                  // the canvas is drawn at half the picture's pixels
  const k = dispW / layout.w;                         // picture pixels → screen pixels

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setDispW(el.clientWidth || 520));
    ro.observe(el);                                  // fires once straight away with the real width
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const W = Math.round(layout.w * scale), H = Math.round(layout.h * scale);
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, W, H);

    if (mode === "reach") {
      const tops = orderedZones(layout).filter((z) => z.top && layout.zones[z.key]);
      tops.forEach((z, i) => {
        const r = rows.find((x) => x.key === z.key);
        const y0 = layout.zones[z.key].top;
        const y1 = i + 1 < tops.length ? layout.zones[tops[i + 1].key].top : layout.h;
        ctx.fillStyle = reachColor(r?.reachPct);
        ctx.fillRect(0, y0 * scale, W, (y1 - y0) * scale);
      });
      return;
    }

    const pts = cells.map((p) => ({ ...p, v: mode === "dead" ? p.dead : p.n })).filter((p) => p.v > 0);
    if (!pts.length) return;
    const max = Math.max(...pts.map((p) => p.v));
    const radius = Math.max(14, Math.round((layout.w / 40) * 1.5 * scale));
    for (const p of pts) {
      const a = Math.min(1, 0.18 + 0.82 * (p.v / max));
      const g = ctx.createRadialGradient(p.x * scale, p.y * scale, 0, p.x * scale, p.y * scale, radius);
      g.addColorStop(0, `rgba(0,0,0,${a})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x * scale, p.y * scale, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const al = d[i + 3];
      if (!al) continue;
      const [r, g, b] = PALETTE[al];
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = Math.min(230, 60 + al);
    }
    ctx.putImageData(img, 0, 0);
  }, [layout, cells, rows, mode]);

  const tops = orderedZones(layout).filter((z) => z.top && layout.zones[z.key]);
  const fold = layout.viewport?.height;

  return (
    <div className="adm-heat-pic" ref={wrapRef}>
      <div className="adm-heat-stage" style={{ height: layout.h * k }}>
        <img src={src} alt={`Full-length picture of the ${layout.url || "landing"} page`} width={dispW} style={{ width: dispW, height: layout.h * k }} />
        <canvas
          ref={canvasRef}
          style={{ width: dispW, height: layout.h * k }}
          aria-label={mode === "reach" ? "How far down the page visitors got, section by section" : mode === "dead" ? "Where taps landed on things that are not links" : "Where visitors clicked"}
          role="img"
        />
        {fold && (
          <div className="adm-heat-fold" style={{ top: fold * k }}><span>Seen without scrolling</span></div>
        )}
        {mode === "reach" && tops.map((z) => {
          const r = rows.find((x) => x.key === z.key);
          return (
            <div key={z.key} className="adm-heat-tag" style={{ top: layout.zones[z.key].top * k + 4 }}>
              <b>{p0(r?.reachPct)}</b> of {device} visits got to {ZONE_BY_KEY[z.key]?.label.toLowerCase()}
            </div>
          );
        })}
      </div>
      {mode !== "reach" && (
        <div className="adm-heat-legend" aria-hidden="true">
          <span>Few</span><i /><span>Most {mode === "dead" ? "do-nothing taps" : "clicks"}</span>
          <span className="dim"> · {n0(views)} visits</span>
        </div>
      )}
    </div>
  );
}
