import { useCallback, useEffect, useMemo, useState } from "react";
import { useRoute } from "../../lib/router.js";
import { useScreenContext } from "../../lib/screenContext.js";
import { isConfigured } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import { listHsEvents, listHsLeadSources, listLeadsByIds } from "../../lib/data.js";
import { SectionHeader, SourceBadge, EmptyState } from "./shared.jsx";
import { Figure, FigureGrid, Block, BasisBadge } from "./financeParts.jsx";
import { Pct, Num, SortHeader, RangePicker, Funnel } from "./homeServicesParts.jsx";
import {
  PAGE_SLUGS, PAGE_LABELS,
  defaultRange, addTeamDays, teamToday, teamDayStartMs, teamDayEndMs,
  summarise, comparePages, funnelFor, ctaCounts, trafficBy, sortRows,
} from "../../../lib/home-services.js";

/* ==================================================================
 * HOME SERVICES — do the trade pages beat the general one?  14 Sep 2026
 *
 * AI Syndicate is putting up one overarching Home Services page and one page
 * per trade. The question this screen exists to answer is a COMPARISON: the
 * lawn page against the painting page against the page that covers all of
 * them. Everything here is arranged around that — the table in the middle is
 * the page, and the tiles above it are its summary.
 *
 * WHERE THE NUMBERS COME FROM. Two tables, both added by migration 0035 and
 * both written server-side:
 *   hs_page_events    one row per tracked thing a visitor did
 *   hs_lead_sources   one row per lead those pages produced
 * The landing pages themselves hold no database key. They POST to
 * /api/hs-event and /api/hs-lead, which write with the service role.
 *
 * ============================================================
 * THE HONESTY RULE. It is the same one the Finance page runs on and it is not
 * decoration — it is why anybody can trust a number on this screen.
 *
 *   MEASURED  a count of rows that exist. Visits, scans, leads, purchases.
 *   DERIVED   a division of two measured counts. Every percentage here.
 *   a gap     we cannot work it out. It prints "not measured yet", or an em
 *             dash with the reason on hover, and NEVER a zero.
 *
 * The distinction that matters most on this page: a conversion rate with no
 * visitors underneath it is not 0%. "Nobody came" and "everybody who came
 * left" are different facts about a business, and a 0% on screen tells you
 * the second one when the truth is the first. rate() in lib/home-services.js
 * returns null for an empty denominator and every % on this page comes
 * through it.
 *
 * And when there is nothing at all in the range, the page says so in a
 * sentence — "no events recorded yet, nothing has been deployed" — instead of
 * drawing a full dashboard of zeroes that looks like a measurement of six
 * failing pages.
 * ============================================================
 *
 * DAYS ARE CHICAGO DAYS. The range is two plain "YYYY-MM-DD" strings and they
 * are never handed to `new Date()` — that reads them as UTC, which is the
 * evening before here, and would file an evening's visits under the wrong day.
 * teamDayStartMs / teamDayEndMs do the conversion and the tests pin them
 * either side of both clock changes.
 * ================================================================== */

const PRESETS = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
];

/* Every column on the comparison table, in the order it is drawn. `key` is
 * what it sorts on, and it is the field name on the row — so a column that
 * sorts on something it does not show is impossible to write by accident. */
const COLUMNS = [
  { key: "label", label: "Page", numeric: false, title: "Sort by page name" },
  { key: "visits", label: "Visits", numeric: true, title: "Times the page was loaded. One person who comes back twice is two visits." },
  { key: "sessions", label: "Unique", numeric: true, title: "Separate visits, counted by the random id the page makes for each one. No cookies." },
  { key: "scanStartPct", label: "Scan start", numeric: true, title: "Share of visits that started the scan." },
  { key: "scanCompletePct", label: "Scan done", numeric: true, title: "Share of visits that finished the scan." },
  { key: "leadPct", label: "Lead", numeric: true, title: "Share of visits that left their details." },
  { key: "checkoutOpenPct", label: "Checkout", numeric: true, title: "Share of visits that opened the checkout." },
  { key: "paidPct", label: "Paid", numeric: true, title: "Share of visits that paid." },
  { key: "leads", label: "Leads", numeric: true, title: "Leads captured from this page." },
  { key: "purchases", label: "Purchases", numeric: true, title: "Leads from this page that paid." },
];

const NOTHING_WHY = "No events have been recorded in this range. Nothing has been deployed to a landing page yet, so there is nothing to count — this is not a zero.";

export default function HomeServices() {
  const [, go] = useRoute();

  const [range, setRange] = useState(() => ({ ...defaultRange(), preset: "30" }));
  const [events, setEvents] = useState({ rows: [] });
  const [sources, setSources] = useState({ rows: [] });
  const [leads, setLeads] = useState({ rows: [] });
  const [loading, setLoading] = useState(true);

  const [sort, setSort] = useState({ key: "sessions", dir: "desc" });
  const [funnelSlug, setFunnelSlug] = useState(PAGE_SLUGS[0]);
  const [utmField, setUtmField] = useState("utm_source");

  const { from, to } = range;

  const load = useCallback(async () => {
    setLoading(true);
    const fromMs = teamDayStartMs(from);
    const toMs = teamDayEndMs(to);
    /* Both reads are cut to the SAME window. AI Cost shipped with one side on
     * the chosen window and the other on all time, and printed the two against
     * each other as a rate — the fastest way to a wrong number on a page whose
     * whole point is comparison. */
    const [ev, ls] = await Promise.all([
      listHsEvents({ fromMs, toMs }),
      listHsLeadSources({ fromMs, toMs }),
    ]);
    setEvents(ev);
    setSources(ls);

    /* Only the 25 the Recent leads table will print. Reading every lead these
     * pages have ever produced to show the newest 25 of them is a habit this
     * repo has paid for before. */
    const ids = (ls.rows || []).slice(0, 25).map((r) => r.lead_id);
    setLeads(await listLeadsByIds(ids));

    setLoading(false);
    if (ev.error) toast.error("Some page events could not be read", ev.error);
    if (ls.error) toast.error("Some lead sources could not be read", ls.error);
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  useScreenContext(() => ({
    page: "home-services",
    label: "Home Services",
    visible: ["Visits, scans, leads and purchases for the Home Services landing pages, one row per trade"],
  }), []);

  const ev = useMemo(() => events.rows || [], [events]);
  const ls = useMemo(() => sources.rows || [], [sources]);

  /* THE ONE FACT THE WHOLE PAGE HANGS OFF. Nothing measured means nothing to
   * divide, so every tile blanks with a reason rather than printing zeroes. */
  const nothing = ev.length === 0 && ls.length === 0;

  const totals = useMemo(() => summarise(ev, ls), [ev, ls]);
  const table = useMemo(() => sortRows(comparePages(ev, ls), sort.key, sort.dir), [ev, ls, sort]);
  const funnel = useMemo(() => funnelFor(ev, funnelSlug), [ev, funnelSlug]);
  const ctas = useMemo(() => ctaCounts(ev), [ev]);
  const traffic = useMemo(() => trafficBy(ev, utmField), [ev, utmField]);
  const recent = useMemo(() => ls.slice(0, 25), [ls]);
  const leadById = useMemo(
    () => Object.fromEntries((leads.rows || []).map((l) => [l.id, l])),
    [leads],
  );

  const onSort = (key) => {
    setSort((s) => (s.key === key
      ? { key, dir: s.dir === "desc" ? "asc" : "desc" }
      /* A new column opens biggest-first, except the name, which opens A–Z.
       * Every other reading of "sort by page" is somebody counting backwards. */
      : { key, dir: key === "label" ? "asc" : "desc" }));
  };

  const presets = PRESETS.map((p) => {
    const end = teamToday();
    return { id: p.id, label: p.label, from: addTeamDays(end, -(p.days - 1)), to: end };
  });

  /* A count, or a blank when nothing was recorded at all. Zero is a real
   * answer for a page that HAS traffic and no scans; it is not a real answer
   * for a console that has never received an event. */
  const count = (v) => (nothing ? null : Number(v || 0).toLocaleString("en-US"));

  const mode = events.sample || sources.sample ? "sample" : (isConfigured() ? "live" : "sample");

  if (loading) return <div className="adm-hs-loading">Reading the landing-page events…</div>;

  return (
    <div className="adm-hs">
      <SectionHeader
        kicker="Command"
        title="Home Services"
        subtitle="What the Home Services landing pages actually do — one row per trade, measured against the page that covers all of them."
        right={<SourceBadge mode={mode} hint={mode === "live" ? "Counted from the rows the landing pages sent" : "No database keys on this build — nothing can be measured"} />}
      />

      <RangePicker
        from={from}
        to={to}
        activePreset={range.preset}
        presets={presets}
        onChange={(r) => setRange(r)}
      />

      {events.truncated && (
        <div className="adm-hs-warn">
          <strong>This range is bigger than the reader will fetch.</strong>{" "}
          {ev.length.toLocaleString("en-US")} events were read and there are more, so every total
          below is a floor rather than the whole figure. Pick a shorter range.
        </div>
      )}
      {events.partial && (
        <div className="adm-hs-warn">
          <strong>The database stopped answering part way through.</strong> {ev.length.toLocaleString("en-US")} events
          were read before it did. This is not a range that is too big; it is a read that failed.
        </div>
      )}

      {nothing && (
        <div className="adm-hs-warn adm-hs-warn-amber">
          <strong>No events recorded yet — nothing has been deployed to a landing page.</strong>{" "}
          Not one row exists in this range, so there is nothing on this screen to measure and every
          figure below is shown as a gap rather than a zero. The pages start filling this in the
          moment they are live and posting to <code>/api/hs-event</code>. If a page IS live and this
          is still empty, the first thing to check is <code>HS_ALLOWED_ORIGINS</code> — an origin
          that is not on that list is refused, by design.
        </div>
      )}

      {/* ---------- the tiles ---------- */}
      <FigureGrid min={210}>
        <Figure label="Visits" value={count(totals.views)} basis="counted" why={NOTHING_WHY}
          means="Times a page was loaded. One person coming back twice is two visits." />
        <Figure label="Unique visits" value={count(totals.sessions)} basis="counted" why={NOTHING_WHY}
          means="Separate visits, counted by a random id the page makes in memory. No cookies, nothing that follows anybody." />
        <Figure label="Scans started" value={count(totals.scanStarts)} basis="counted" why={NOTHING_WHY} />
        <Figure label="Scans completed" value={count(totals.scansDone)} basis="counted" why={NOTHING_WHY} />
        <Figure label="Leads captured" value={count(totals.leads)} basis="counted" why={NOTHING_WHY}
          means="People who left their details. Each one is a real row on the Sales page." />
        <Figure label="Checkouts opened" value={count(totals.checkoutOpens)} basis="counted" why={NOTHING_WHY} />
        <Figure label="Purchases" value={count(totals.purchases)} basis="counted" why={NOTHING_WHY}
          means="Leads from these pages that paid on the page." />
        <Figure
          label="Conversion rate"
          value={totals.leadRate === null ? null : `${totals.leadRate.toFixed(1)}%`}
          basis="derived"
          sub="leads ÷ unique visits"
          means="Of everyone who turned up, how many left their details."
          why="Nobody has visited in this range, so there is nothing to divide by. This is not 0% — it is no visitors."
        />
        <Figure
          label="Buy rate"
          value={totals.buyRate === null ? null : `${totals.buyRate.toFixed(1)}%`}
          basis="derived"
          sub="purchases ÷ unique visits"
          means="Of everyone who turned up, how many paid."
          why="Nobody has visited in this range, so there is nothing to divide by. This is not 0% — it is no visitors."
        />
      </FigureGrid>

      {/* ---------- THE COMPARISON. This is the page. ---------- */}
      <Block
        title="Every page, side by side"
        blurb="The overarching page and each trade, on the same rows. Click a column heading to sort by it. A dash means the sum could not be done — never that the answer was zero."
        right={<BasisBadge basis="derived" hint="The counts are measured; every percentage is those counts divided by the unique visits beside them." />}
      >
        <div className="adm-hs-tablewrap">
          <table className="adm-hs-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <SortHeader key={c.key} id={c.key} label={c.label} title={c.title}
                    numeric={c.numeric} sort={sort} onSort={onSort} />
                ))}
              </tr>
            </thead>
            <tbody>
              {table.map((r) => (
                <tr key={r.slug} className={r.slug === "home-services" ? "adm-hs-overarching" : ""}>
                  <td>
                    <button type="button" className="adm-hs-link" onClick={() => setFunnelSlug(r.slug)}
                      title="Show this page's funnel below">
                      {r.label}
                    </button>
                  </td>
                  <td className="n"><Num value={r.visits} /></td>
                  <td className="n"><Num value={r.sessions} /></td>
                  <td className="n"><Pct value={r.scanStartPct} /></td>
                  <td className="n"><Pct value={r.scanCompletePct} /></td>
                  <td className="n"><Pct value={r.leadPct} /></td>
                  <td className="n"><Pct value={r.checkoutOpenPct} /></td>
                  <td className="n"><Pct value={r.paidPct} /></td>
                  <td className="n"><Num value={r.leads} /></td>
                  <td className="n"><Num value={r.purchases} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="adm-hs-note">
          Every percentage is worked out against <strong>unique visits</strong>, not against the step
          before it — so the columns can be read down as well as across, and one page's lead rate
          means the same thing as another&apos;s. The step-to-step losses are in the funnel below.
        </p>
      </Block>

      {/* ---------- the funnel ---------- */}
      <Block
        title="Where people stop"
        blurb="One page at a time: what share of the people who landed got as far as each step, and what was lost between them."
        right={
          <select value={funnelSlug} onChange={(e) => setFunnelSlug(e.target.value)} aria-label="Which page">
            {PAGE_SLUGS.map((s) => <option key={s} value={s}>{PAGE_LABELS[s]}</option>)}
          </select>
        }
      >
        <Funnel slug={funnelSlug} steps={funnel} />
      </Block>

      {/* ---------- the buttons ---------- */}
      <Block
        title="Which button gets pressed"
        blurb="Every click we track, by the name the page gives the button. A page with two calls to action and all the clicks on one of them is telling you something."
        right={<BasisBadge basis="counted" />}
      >
        {!ctas.length ? (
          <EmptyState
            title="No button clicks recorded"
            body="Nothing has sent a cta_click event in this range. Either no page is live yet, or a live page is not naming its buttons when it tracks them."
          />
        ) : (
          <div className="adm-hs-tablewrap">
            <table className="adm-hs-table">
              <thead><tr><th>Button</th><th className="n">Clicks</th><th className="n">Visits that clicked</th></tr></thead>
              <tbody>
                {ctas.map((c) => (
                  <tr key={c.cta}>
                    <td>{c.cta}</td>
                    <td className="n"><Num value={c.clicks} /></td>
                    <td className="n"><Num value={c.sessions} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      {/* ---------- traffic ---------- */}
      <Block
        title="Where the visits come from"
        blurb="Counted off the tracking tags on the address. A visit that arrives with no tag at all is counted as direct rather than dropped — on a new page that is most of them, and dropping it would make every total here wrong."
        right={
          <select value={utmField} onChange={(e) => setUtmField(e.target.value)} aria-label="Group traffic by">
            <option value="utm_source">By source</option>
            <option value="utm_campaign">By campaign</option>
            <option value="utm_medium">By medium</option>
          </select>
        }
      >
        {!traffic.length ? (
          <EmptyState
            title="No visits recorded"
            body="Nothing has sent a view event in this range, so there are no sources to group."
          />
        ) : (
          <div className="adm-hs-tablewrap">
            <table className="adm-hs-table">
              <thead><tr><th>Source</th><th className="n">Visits</th><th className="n">Unique</th></tr></thead>
              <tbody>
                {traffic.map((t) => (
                  <tr key={t.key}>
                    <td>{t.key}</td>
                    <td className="n"><Num value={t.views} /></td>
                    <td className="n"><Num value={t.sessions} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      {/* ---------- recent leads ---------- */}
      <Block
        title="The last 25 leads these pages produced"
        blurb="Every one of these is a real row on the Sales page. Click a name to open it there."
        right={<BasisBadge basis="counted" />}
      >
        {!recent.length ? (
          <EmptyState
            title="No leads yet"
            body="No landing page has captured anybody in this range. When one does, the lead appears here and on the Sales page in the same moment."
          />
        ) : (
          <div className="adm-hs-tablewrap">
            <table className="adm-hs-table">
              <thead>
                <tr>
                  <th>Who</th><th>Page</th><th>Checkout</th><th>Paid</th><th>Captured</th><th />
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => {
                  const lead = leadById[r.lead_id];
                  return (
                    <tr key={r.lead_id}>
                      <td>
                        {/* The lead row may be gone — deleted, or hidden from
                          * this person by the sales row policy. Saying so is
                          * better than printing a blank cell that reads like a
                          * lead with no name. */}
                        {lead
                          ? <><strong>{lead.name || "(no name)"}</strong>{lead.company ? <span className="dim"> · {lead.company}</span> : null}</>
                          : <span className="adm-hs-blank" title="The lead row could not be read — it has been deleted, or it is not one you may see.">not readable</span>}
                      </td>
                      <td>{PAGE_LABELS[r.page_slug] || r.page_slug}</td>
                      <td>{r.reached_checkout ? "opened" : <span className="dim">no</span>}</td>
                      <td>{r.paid ? <strong>paid</strong> : <span className="dim">no</span>}</td>
                      <td className="dim">{String(r.converted_at || "").slice(0, 10)}</td>
                      <td className="n">
                        <button type="button" className="adm-hs-link"
                          onClick={() => go(`#/dashboard/sales?lead=${r.lead_id}`)}>
                          Open in Sales →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      {/* ---------- what the badges mean ---------- */}
      <Block
        title="What the badges mean"
        blurb="Two words, and the difference between them is why anything on this page can be trusted."
      >
        <div className="adm-hs-tablewrap">
          <table className="adm-hs-table">
            <tbody>
              <tr>
                <td><BasisBadge basis="counted" /></td>
                <td>Counted from rows that exist. Somebody did a thing and the page sent a row saying so.</td>
              </tr>
              <tr>
                <td><BasisBadge basis="derived" /></td>
                <td>One measured count divided by another. Nothing new was seen — if the counts are right, this is right.</td>
              </tr>
              <tr>
                <td><span className="adm-hs-blank">—</span></td>
                <td>We cannot work it out. Almost always because nobody visited, so there is nothing to divide by. It is never a zero wearing a disguise.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Block>
    </div>
  );
}
