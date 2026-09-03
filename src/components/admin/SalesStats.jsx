import { useEffect, useMemo, useState } from "react";
import { getSalesBoard, ACTIVITY_WINDOW_DAYS } from "../../lib/data.js";
import { repStats, isOpenStage } from "../../../lib/sales-rules.js";
import { outreachByRep, lossReasons, OUTREACH_WINDOW_DAYS } from "../../../lib/outreach.js";
import {
  REP_METRIC_GROUPS, DEFAULT_REP_METRIC, rankReps, barPct,
  PERIOD_ALL, PERIOD_WINDOW, PERIOD_NOW,
} from "../../../lib/rep-metrics.js";
import { Tile, MiniBar, money } from "./salesParts.jsx";
import { SourceBadge } from "./shared.jsx";

/* SALES · STATS — how the team is doing, and every rep beside every other.
 *
 * Ryder, 30 Aug 2026: "i would maybe like to add a stats page in the owner and
 * admin part where when you click sales a dropdown appears to click to the
 * stats page if you want and then as an owner you can see the stats by rep and
 * see all stats and be able to track the sales and performance of the team."
 *
 * And, the same day: "i want it to be more like bar graphs for each rep with
 * filters at the top to click to show different stats to see who performed the
 * best." That is the chart in the middle of this page — one row of chips, one
 * bar per rep, sorted so the best is at the top.
 *
 * WHERE THE NUMBERS COME FROM.
 * EVERY PER-REP FIGURE — the chart and every cell of the table — is produced by
 * a function the console already had and already tested: `repStats`,
 * `outreachByRep` and `lossReasons`, all from the same `getSalesBoard()` read
 * the Sales page itself runs. The chart adds nothing: it reads those same
 * objects through lib/rep-metrics.js, which only picks a field and sorts on it.
 *
 * The ONE exception, and it is deliberate: the six team tiles and the pipeline
 * bar are counted here, over every lead, in the `team` memo below. They have to
 * be, and the note on that memo says why — most of this pipeline has no owner,
 * so adding the rep rows together would give a much smaller number than the
 * truth. Nothing per-rep is worked out twice.
 *
 * That is deliberate. This page replaces the "Rep numbers" modal that used to
 * open from the Sales toolbar, and the fastest way to end up with two screens
 * that quietly disagree about how many deals somebody won is to work the answer
 * out twice. There is one set of maths, and this page, the rep's own Work page
 * and the rep brief all read it together.
 *
 * THE CHART AND THE TABLE ARE THE SAME NUMBERS. The bars are the one metric you
 * picked; the table underneath is all of them at once. Neither is a summary of
 * the other — the table is the chart's plain-text twin, which is what makes the
 * chart safe for somebody who cannot tell the two blues apart.
 *
 * TWO WINDOWS, AND EVERY COLUMN SAYS WHICH.
 * `repStats` has NO window: it is everything, over the rows that were loaded.
 * The outreach half — emailed, replied, bounced, calls — is the last
 * OUTREACH_WINDOW_DAYS. A page with both on it and neither labelled is a page
 * where "Won 4" and "Emailed 40" look like the same period. Every heading below
 * carries its own, and so does the chart.
 *
 * WHO MAY SEE IT: owner and admin. The menu leaves it out for a rep, and
 * AdminDashboard refuses to route there — a hidden link is not a permission.
 */

/* The two blues. One hue at two depths, not two hues: this chart draws ONE
 * measure, and a colour per rep would spend the only free channel on identity
 * the name already carries. The leader is the deep one.
 *
 * Colour is never the only thing that says who won — the leader also carries a
 * BEST chip and sits at the top of the list, and every bar prints its own
 * number. That is the same rule the stage pills on the Sales sheet follow. */
const BAR_BEST = "var(--accent-deep)";
const BAR_REST = "#a5b4fc";

/* "over everything loaded", not "all time". `PERIOD_ALL` means every row the
 * page managed to READ, which is not the same sentence — and on a short or
 * failed read it is very much not the same sentence. The table's own footnote
 * has always been careful about this; the chart heading was not.
 *
 * There is no silent default: an unrecognised period prints nothing rather than
 * labelling an all-time figure "right now". */
function periodWords(period) {
  if (period === PERIOD_ALL) return "over everything loaded";
  if (period === PERIOD_WINDOW) return `last ${OUTREACH_WINDOW_DAYS} days`;
  if (period === PERIOD_NOW) return "right now";
  return "";
}

/* ------------------------------------------------------------------ */
/* THE CHART                                                          */
/* ------------------------------------------------------------------ */

/**
 * One metric, every rep, biggest performance first.
 *
 * `rows` is the same `[{ rep, s, o }]` the table below renders. It is passed in
 * rather than read again, so the chart and the table cannot show a different
 * snapshot of the same team.
 */
function RepBars({ rows, metricKey, onPick, meId }) {
  const r = useMemo(() => rankReps(rows, metricKey), [rows, metricKey]);
  const m = r.metric;

  return (
    <>
      {/* ---- the filters: one band above the chart, nothing inside the card ----
          Every chip is a real button with aria-pressed, so the choice is
          announced and reachable by keyboard rather than being a coloured div. */}
      <div className="adm-st-filters" role="group" aria-label="Which number to chart">
        {REP_METRIC_GROUPS.map((g) => (
          /* Each band is its own group with its own name. Without this a
             screen reader hears thirteen buttons under one flat label and
             loses the Results / Effort / Watch split the eye gets for free. */
          <div className="adm-st-fgroup" key={g.group} role="group" aria-label={g.group}>
            <span className="adm-st-fglabel" aria-hidden="true">{g.group}</span>
            {g.metrics.map((mm) => (
              <button
                key={mm.key}
                type="button"
                className={`adm-st-chip${mm.key === m.key ? " on" : ""}`}
                aria-pressed={mm.key === m.key}
                /* The explanation is on the button itself, not only in a
                   `title` — a hover tooltip is unreachable by keyboard and does
                   not exist on a touch screen. `title` stays for the mouse. */
                aria-label={`${mm.label} — ${mm.what}`}
                title={mm.what}
                onClick={() => onPick(mm.key)}
              >
                {mm.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="card adm-st-chart">
        <div className="adm-st-head">
          <div>
            <h3 className="adm-st-title">
              {m.label} <span className="adm-sl-faint">· {periodWords(m.period)}</span>
            </h3>
            <p className="adm-st-what">{m.what}</p>
          </div>
          <div className="adm-st-scale">
            {m.better === "low" ? "Fewer is better — shortest bar wins" : "More is better — longest bar wins"}
            {r.max > 0 ? (
              <span className="adm-st-scale-2">
                bars are scaled to the biggest here
              </span>
            ) : null}
          </div>
        </div>

        {!r.bars.length ? (
          <div className="adm-sl-empty">Nobody to chart yet.</div>
        ) : (
          <div className="adm-st-bars" role="list">
            {r.bars.map((b, i) => {
              const pct = barPct(b.value, r.max);
              const who = b.rep?.full_name || b.rep?.email || "Unnamed";
              return (
                /* The id, never the display name: two rows both falling back
                   to "Unnamed" would share a key and React would reuse the
                   wrong row. */
                <div className="adm-st-row" role="listitem" key={b.id || `row-${i}`}>
                  <div className="adm-st-name">
                    <span className="adm-st-who">
                      {who}
                      {b.id && b.id === meId ? <span className="adm-sl-faint"> · you</span> : null}
                    </span>
                    {b.best ? <span className="adm-st-best">BEST</span> : null}
                  </div>

                  <div className="adm-st-track">
                    {/* A measured ZERO draws no bar and prints "0". A row that
                        could not be read draws no bar either — which is why the
                        number beside it has to say which of the two it is. */}
                    <div
                      className="adm-st-fill"
                      style={{ width: `${pct}%`, background: b.best ? BAR_BEST : BAR_REST }}
                    />
                  </div>

                  <div className="adm-st-val">
                    {b.measured
                      ? <span className={`adm-st-num${b.best ? " best" : ""}`}>{b.display}</span>
                      : <span className="adm-sl-faint">not measured</span>}
                    {b.sub ? <span className="adm-st-sub">{b.sub}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="adm-st-foot">
          {/* WHY THERE MAY BE NO WINNER, said out loud rather than left as a
              missing chip. Three different reasons, three different sentences. */}
          {r.crowned ? null : !r.crownable ? (
            <span>
              <strong>Nobody is marked best on this one, on purpose.</strong> It is a plain count
              with nothing underneath it, so a rep who has claimed nothing has the best-looking
              number on the team. The figure beside each bar says which book it came out of.
              {m.better === "low" ? " Close rate is the version of this question that can be won." : ""}
            </span>
          ) : r.measured === 0 ? (
            <span>
              Nobody is marked best, because nobody has this number yet. There is nothing to
              rank rather than a team that all scored the same.
            </span>
          ) : r.measured === 1 ? (
            <span>
              Nobody is marked best: only one rep has this number, and best of one is not a
              comparison.
            </span>
          ) : (
            <span>Nobody is marked best: every rep is on zero, so there is no top performer to name.</span>
          )}
          {r.unmeasured > 0 ? (
            /* TWO REASONS A ROW IS UNMEASURED, and this sentence must not pick
               one. A rate is null when nothing has been sent yet — there is no
               denominator — and it is ALSO null when the read failed. Saying
               "could not read it" for a rep who simply has not emailed anybody
               is a claim about our systems that is not true. */
            <span>
              {r.unmeasured} rep{r.unmeasured === 1 ? "" : "s"} sit at the bottom with no bar. That is
              not a score of zero: this page has no number for them at all — either there is nothing
              to count yet, or the read came back empty — so they are kept out of the ranking rather
              than counted as a bad result.
            </span>
          ) : null}
          {m.rate ? (
            <span>
              This one is an average, not a count, so the numbers behind it are printed beside every
              bar. One reply out of one email is 100% and is not a better month than nine out of
              thirty.
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
}

export default function SalesStats({ member }) {
  const [board, setBoard] = useState(null);
  const [err, setErr] = useState(null);

  /* ONE CLOCK, taken when the page loads and then held. Reading Date.now()
   * during a render is impure: two renders would count two different windows,
   * and the same rep's "last 30 days" would move under them mid-scroll. */
  const [nowMs] = useState(() => Date.now());

  /* WHICH NUMBER THE CHART IS DRAWING. Held here, not in RepBars, because the
   * chart is rebuilt on every board change and a choice that lived inside it
   * would reset itself under the reader every time the page refreshed. */
  const [metricKey, setMetricKey] = useState(DEFAULT_REP_METRIC);
  const now = useMemo(() => new Date(nowMs).toISOString(), [nowMs]);

  useEffect(() => {
    let alive = true;
    getSalesBoard()
      .then((b) => { if (alive) setBoard(b); })
      .catch((e) => { if (alive) setErr(e?.message || "Could not load the pipeline."); });
    return () => { alive = false; };
  }, []);

  const reps = useMemo(() => (board?.team || []).filter((t) => t.active), [board]);

  /* A FAILED READ HAS TO ARRIVE AS `null`, NOT AS AN EMPTY LIST.
   *
   * Every reader in src/lib/data.js turns a failure into `{ rows: [], error }`,
   * so "nothing came back" and "nothing is there" reach this page as the same
   * value. lib/outreach.js was written against a null-is-not-zero contract —
   * `emailed: null` means could not read, `emailed: 0` means sent none — and
   * that contract was unreachable here, so a broken read would have printed
   * confident zeros and a rep with forty emails out would have shown "0".
   * `board.failed` is exactly what makes it reachable. Found by an adversarial
   * review, Aug 30 2026.
   *
   * Note repStats has no such contract: it takes arrays. So the table's
   * repStats half still shows zeros on a failed leads read — which is why the
   * banner above the page, not this, is what has to stop somebody reading it. */
  const readable = useMemo(() => {
    if (!board) return { leads: null, activity: null, proposals: null };
    const f = board.failed || {};
    return {
      leads: f.leads ? null : board.leads,
      activity: f.activity ? null : board.activity,
      proposals: f.proposals ? null : board.proposals,
    };
  }, [board]);

  const outreachById = useMemo(() => {
    if (!board) return new Map();
    const rows = outreachByRep({
      team: reps, leads: readable.leads, activity: readable.activity,
      proposals: readable.proposals, nowMs,
    });
    return new Map(rows.map((o) => [o.member.user_id, o.stats]));
  }, [board, readable, reps, nowMs]);

  /* A REP APPEARS ONCE THERE IS ANYTHING TO COUNT — including outreach alone.
   * Reading repStats by itself left a rep who had emailed forty people and
   * claimed nothing with no row and no explanation for its absence. */
  const rows = useMemo(() => {
    if (!board) return [];
    return reps
      .map((r) => ({
        rep: r,
        s: repStats(board.leads, board.activity, { userId: r.user_id, now }),
        o: outreachById.get(r.user_id) || null,
      }))
      .filter(({ s, o }) => s.claimed > 0 || s.calls > 0 || s.emails > 0
        || Boolean(o?.emailed) || Boolean(o?.replied) || Boolean(o?.proposalsOut))
      .sort((a, b) => b.s.won - a.s.won || b.s.meetings - a.s.meetings);
  }, [board, reps, outreachById, now]);

  /* THE TEAM'S OWN NUMBERS, COUNTED FROM THE LEADS — not by adding the rows
   * above together.
   *
   * A per-rep sum misses every lead nobody owns, and on this pipeline that is
   * most of them: 3,650 of 3,663 contacts sit on the floor unclaimed. It also
   * misses a deal that was won and then released, which has no owner at all. So
   * the team line is counted over every lead, once, and the difference between
   * it and the sum of the rows is real information rather than a bug. */
  const team = useMemo(() => {
    if (!board) return null;
    const leads = board.leads;
    let claimed = 0;
    let open = 0;
    let won = 0;
    let lost = 0;
    let meetings = 0;
    let contacted = 0;
    for (const l of leads) {
      if (l.owner_id) claimed += 1;
      if (isOpenStage(l.stage)) open += 1;
      if (l.stage === "won") won += 1;
      if (l.stage === "lost") lost += 1;
      /* Cumulative: got to a meeting or past it. Both halves of the 0030
         split count, or a finished meeting reads as no meeting. */
      if (["meeting", "meeting_booked", "meeting_complete", "proposal", "won"].includes(l.stage)) meetings += 1;
      if (l.first_contact_at) contacted += 1;
    }
    const decided = won + lost;
    return {
      total: leads.length,
      claimed,
      floor: leads.length - claimed,
      open,
      won,
      lost,
      meetings,
      contacted,
      /* null, not 0. "Nothing has been decided yet" and "we decided plenty and
       * won none" are opposite answers and must not print the same. */
      closeRate: decided ? Math.round((won / decided) * 100) : null,
    };
  }, [board]);

  const losses = useMemo(
    () => (board ? lossReasons({ leads: readable.leads, nowMs }) : null),
    [board, readable, nowMs],
  );

  if (err) {
    return (
      <div className="adm-db">
        <div className="adm-sl-warn adm-sl-warn-flat" role="alert">
          <strong>The pipeline could not be read.</strong> {err} Nothing on this page is
          counted from a part read, so there is nothing below.
        </div>
      </div>
    );
  }
  if (!board) return <div className="adm-db"><div className="adm-sl-empty">Counting…</div></div>;

  /* THE ONLY THING ON THIS PAGE THAT CAN TELL YOU A NUMBER IS SHORT.
   *
   * `getSalesBoard()` does not reject when a read fails — it returns a board
   * with an empty list and the failure recorded in `errors` / `failed` — so the
   * catch above never fires for the ordinary case. Without these two banners the
   * page renders "Contacts loaded 0 · Won 0", says "that is an empty list, not a
   * missing one", and signs off with "every figure here is counted from real
   * rows", and every one of those sentences is false.
   *
   * The Sales page and a rep's own Overview have carried this pair since Aug 27.
   * This page shipped without them. Found by an adversarial review, Aug 30 2026. */
  const errors = board.errors || [];
  const truncated = board.truncated || [];
  const short = errors.length > 0 || truncated.length > 0;

  /* One dash function for the whole table. `null` and `0` are different
   * sentences — "nobody replied" and "we have not measured" are opposite
   * answers — and printing them the same is the defect this console keeps
   * having to fix. */
  const n = (v, suffix = "") => (v === null || v === undefined
    ? <span className="adm-sl-faint">—</span>
    : <>{v}{suffix}</>);

  return (
    /* `adm-st-page` scopes this page's roomier spacing. The tile, health-bar and
       table classes are shared with the Sales sheet, and the sheet is a working
       screen where tighter rows are the point — this is a reading screen. */
    <div className="adm-db adm-sl adm-st-page">
      {errors.length > 0 && (
        <div className="adm-sl-warn" role="alert">
          <strong>Some of this did not load.</strong> {errors.join(" · ")} Every number below is
          counted from what did come back, so treat them as incomplete — and do not compare two
          reps on a number one of them is missing.
        </div>
      )}

      {/* A CAP MATTERS AS MUCH AS AN ERROR. A page quietly showing half the
          pipeline reads exactly like a page showing all of it — and this one
          names a top performer, which a half-read pipeline can get wrong. */}
      {truncated.length > 0 && (
        <div className="adm-sl-warn" role="status">
          <strong>Not everything is loaded.</strong> {truncated.join(" ")} The chart ranks the reps
          on what was loaded, so the order can change once the rest arrives.
        </div>
      )}

      {/* ---- the team, in one row ---- */}
      <div className="adm-sl-tiles">
        <Tile label="Contacts loaded" value={team.total} hint="everything the pipeline holds" />
        <Tile label="Claimed" value={team.claimed} hint={`${team.floor} still on the floor`} />
        <Tile label="Ever contacted" value={team.contacted} hint="told or logged" />
        <Tile label="Live conversations" value={team.meetings} hint="meeting, proposal or won" />
        <Tile label="Won" value={team.won} hint={team.closeRate === null ? "nothing decided yet" : `${team.closeRate}% of decided`} />
        <Tile label="Lost" value={team.lost} hint="closed the other way" />
      </div>

      {/* ---- how far the whole pipeline has actually been worked ---- */}
      <div className="card adm-sl-health">
        <div className="adm-sl-health-t">
          {team.total} {team.total === 1 ? "person" : "people"} in the pipeline
        </div>
        <div className="adm-sl-health-bars">
          <MiniBar label="Claimed by somebody" n={team.claimed} total={team.total} />
          <MiniBar label="Ever contacted (told or logged)" n={team.contacted} total={team.total} tone="#0369a1" />
          <MiniBar label="Reached a conversation" n={team.meetings} total={team.total} tone="#6d28d9" />
        </div>
        <div className="adm-sl-health-n">
          {/* THE TEAM LINE IS NOT THE SUM OF THE ROWS BELOW, and that is said
              rather than left to be discovered. Most of this pipeline has no
              owner, so adding up the reps would give a much smaller number. */}
          Counted over every contact, not by adding the reps together — {team.floor} of these
          have nobody&rsquo;s name on them, so they belong to no row in the table below.
        </div>
      </div>

      {/* ---- every rep, beside every other ---- */}
      <div className="label" style={{ display: "flex", alignItems: "center", gap: 10, margin: "34px 0 14px" }}>
        By rep <SourceBadge mode={board.sample ? "sample" : "live"} />
      </div>

      {rows.length ? (
        <RepBars rows={rows} metricKey={metricKey} onPick={setMetricKey} meId={member.user_id} />
      ) : null}

      <div className="label" style={{ margin: "34px 0 14px" }}>
        Every number, side by side
      </div>

      {!rows.length ? (
        <div className="card adm-sl-empty-card">
          <strong>Nothing to count yet.</strong>
          <div>
            A rep appears here once they have claimed something, logged a touch, emailed
            somebody, had a reply, or got a proposal out.
          </div>
        </div>
      ) : (
        <div className="card adm-sl-scroll">
          <table className="adm-sl-table">
            <thead>
              <tr>
                <th>Rep</th>
                <th title="Leads with their name on them, over every row loaded — not a 30-day figure">Claimed<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>all time</span></th>
                <th title="Still open, right now">Open<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>now</span></th>
                <th title="Business days from claiming to the first logged touch, over every row loaded">Speed to 1st<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>all time</span></th>
                <th title={`People they emailed in the last ${OUTREACH_WINDOW_DAYS} days. People, not emails.`}>Emailed<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>{OUTREACH_WINDOW_DAYS} days</span></th>
                <th title="Of those people, how many wrote back">Replied<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>{OUTREACH_WINDOW_DAYS} days</span></th>
                <th title="Replies divided by people emailed, with dead addresses taken out of the bottom half">Reply rate<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>{OUTREACH_WINDOW_DAYS} days</span></th>
                <th title="Bad addresses. Taken out of the reply-rate maths.">Bounced<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>{OUTREACH_WINDOW_DAYS} days</span></th>
                <th title={`Calls logged in the last ${OUTREACH_WINDOW_DAYS} days`}>Calls<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>{OUTREACH_WINDOW_DAYS} days</span></th>
                <th title="Leads that reached Meeting, Proposal or Won, over every row loaded">Meetings<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>all time</span></th>
                <th title="Sent and not yet decided, right now">Proposals<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>now</span></th>
                <th title="Over every row loaded, not a 30-day figure">Won<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>all time</span></th>
                <th title="Over every row loaded, not a 30-day figure">Lost<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>all time</span></th>
                <th title="Won as a share of leads that were decided either way, over every row loaded">Close rate<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>all time</span></th>
                <th title="Claims that have run out or gone cold, right now">At risk<br /><span className="adm-sl-faint" style={{ fontWeight: 400 }}>now</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ rep, s, o }) => (
                <tr key={rep.user_id}>
                  <td>
                    <div className="adm-sl-rowname">
                      {rep.full_name || rep.email}
                      {rep.user_id === member.user_id ? <span className="adm-sl-faint"> · you</span> : null}
                    </div>
                    <div className="adm-sl-rowmono">{String(rep.role || "").toUpperCase()}</div>
                  </td>
                  <td>{s.claimed}</td>
                  <td>{s.open}</td>
                  <td>{s.speed_days === null
                    ? <span className="adm-sl-faint">not measured</span>
                    : <>{s.speed_days}d <span className="adm-sl-faint">({s.speed_sample})</span></>}</td>
                  <td>{n(o?.emailed)}</td>
                  <td>{n(o?.replied)}</td>
                  {/* FOUR REASONS A RATE CAN BE MISSING, four sentences. A failed
                      read is not "nothing sent" — that is a claim about sends,
                      made for a read that returned nothing. */}
                  <td>{o?.replyRate !== null && o?.replyRate !== undefined
                    ? `${o.replyRate}%`
                    : <span className="adm-sl-faint">
                      {o?.emailed === null || o?.emailed === undefined ? "could not read it"
                        : o.emailed === 0 ? "nothing sent"
                          : "every address bounced"}
                    </span>}</td>
                  <td>{n(o?.bounced)}</td>
                  <td>{n(o?.logged?.call)}</td>
                  <td>{s.meetings}</td>
                  <td>{o?.proposalsOut === null || o?.proposalsOut === undefined
                    ? <span className="adm-sl-faint">—</span>
                    /* `!== null`, not truthy. A proposal genuinely priced at zero
                       is a real figure, and hiding it is the same null-versus-zero
                       mistake this page is written against. */
                    : <>{o.proposalsOut}{o.proposalCents !== null && o.proposalCents !== undefined
                      ? <span className="adm-sl-faint"> ({money(o.proposalCents)})</span> : null}</>}</td>
                  <td style={{ color: s.won ? "#006b1a" : undefined, fontWeight: s.won ? 700 : 400 }}>{s.won}</td>
                  <td>{s.lost}</td>
                  <td>{s.close_rate === null
                    ? <span className="adm-sl-faint">nothing decided</span>
                    : `${s.close_rate}%`}</td>
                  <td style={{ color: s.at_risk ? "var(--danger)" : undefined }}>{s.at_risk}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="adm-sl-imp-note">
        The two halves of this table cover different periods, and each heading says which.
        Claimed, Speed, Meetings, Won, Lost and Close rate are <strong>everything</strong>, over
        the contacts that were loaded. Emailed, Replied, Reply rate, Bounced and Calls are the
        last {OUTREACH_WINDOW_DAYS} days. Open, Proposals and At risk are right now.
        Touch counts elsewhere in the console read a {ACTIVITY_WINDOW_DAYS}-day window, which is
        why a rep&rsquo;s own Overview can show a smaller number for the same word.
      </div>

      {/* ---- where deals die ----
          Counted over every lead rather than by summing the reps: a loss on a
          lead that was released after it was lost has no owner, so a per-rep
          sum would silently miss it and this would add up to less than the
          total above it. */}
      <div className="label" style={{ margin: "34px 0 14px" }}>
        Where deals die — everybody, last {losses.window.days} days
      </div>
      {losses.rows === null ? (
        <div className="adm-sl-warn adm-sl-warn-flat" role="alert">
          <strong>The leads could not be read</strong>, so this is missing rather than empty.
        </div>
      ) : losses.total === 0 ? (
        <div className="card adm-sl-empty-card">
          <strong>Nothing was marked Lost in the last {losses.window.days} days.</strong>
          <div>
            {short
              ? "Some of this page did not load — see the warning at the top — so this may be a missing list rather than an empty one."
              : "That is an empty list, not a missing one."}
            {losses.undated > 0
              ? ` ${losses.undated} lost lead${losses.undated === 1 ? " has" : "s have"} no date on the close, so ${losses.undated === 1 ? "it is" : "they are"} in no window at all.`
              : ""}
          </div>
        </div>
      ) : (
        <div className="card adm-sl-health">
          <div className="adm-sl-health-bars">
            {losses.rows.map((r) => (
              <MiniBar key={r.code || "none"} label={r.label} n={r.count} total={losses.total} tone="#941f1f" />
            ))}
          </div>
          <div className="adm-sl-health-n">
            {losses.total} lost in the last {losses.window.days} days.
            {losses.noReason > 0
              ? ` ${losses.noReason} of them carr${losses.noReason === 1 ? "ies" : "y"} no reason — every one of those closed before the reason box existed, and nothing has been guessed for them.`
              : " Every one of them has a reason and a note somebody typed."}
            {losses.undated > 0
              ? ` A further ${losses.undated} lost lead${losses.undated === 1 ? "" : "s"} ${losses.undated === 1 ? "has" : "have"} no close date at all, so ${losses.undated === 1 ? "it is" : "they are"} not counted above.`
              : ""}
          </div>
        </div>
      )}

      <p className="adm-sl-modalnote">
        {short
          ? "Every figure here is counted from the rows that came back, and some did not — the warning at the top says which. "
          : "Every figure here is counted from real rows. "}
        <strong>There is no open rate</strong> — Gmail
        cannot tell anybody whether an email was opened, and the only thing that can is a tracking
        image that Apple Mail loads for everybody, so the number would not be a measurement. People
        emailed and replies are both real. A call that was not logged is not counted, and a rep with
        nothing measured says so rather than showing a zero.
      </p>

    </div>
  );
}
