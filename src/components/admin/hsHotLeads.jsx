import { useCallback, useEffect, useMemo, useState } from "react";
import { useRoute } from "../../lib/router.js";
import { listHsLeads } from "../../lib/data.js";
import { teamDate } from "../../../lib/brain-context.js";
import {
  HS_FRESH_DAYS, HS_WEAK_SCORE,
  teamDayStartMs, teamDayEndMs, teamToday, addTeamDays,
  hsLeadRows, hsHotLeads,
} from "../../../lib/home-services.js";

/* ==================================================================
 * HOT LEADS FROM THE LANDING PAGES — the block on a rep's own screen.
 * 18 Sep 2026, Ryder's ask: "added to the reps page so they can reach out to
 * hot leads that haven't chosen to purchase yet but put in their email."
 *
 * THIS IS THE SAME LIST AS THE ONE ON HOME SERVICES → LEADS. Not a similar
 * one — the same two functions, hsLeadRows and hsHotLeads, over the same two
 * tables. A rep's block and the owner's page cannot show different people,
 * and neither of them can be the one that is wrong.
 *
 * IT IS NOT FILTERED TO THE SIGNED-IN REP, and that is deliberate. A lead off
 * a landing page arrives owned by nobody — /api/hs-lead sets no owner_id,
 * because a visitor filling in a form has not been assigned to anyone. So
 * "your hot leads" would be an empty list forever. This block says what it is:
 * the ones nobody has bought yet, open to whoever picks up the phone.
 *
 * NOBODY IS TOLD TO CALL ANYBODY. It shows who is worth calling and why. The
 * rest of a rep's page carries the same rule — no league table, no comparison
 * with another rep, and no task assigned to a named person.
 * ================================================================== */

const LOOKBACK_DAYS = 90;
const SHOW = 8;

function Score({ value }) {
  if (value === null || value === undefined) {
    return <span className="adm-hs-blank" title="Nobody scanned this site. It has no score — this is not a score of zero.">not measured</span>;
  }
  const tone = value <= 40 ? "#b42318" : value <= HS_WEAK_SCORE ? "#92400e" : "#006b1a";
  return <strong style={{ color: tone }}>{value}<span style={{ color: "var(--ink-dim)", fontWeight: 500 }}>/100</span></strong>;
}

export default function HotLandingLeads() {
  const [, go] = useRoute();
  const [state, setState] = useState({ loading: true, rows: [], errors: [], nowMs: null, sample: false });
  const [all, setAll] = useState(false);

  const load = useCallback(async () => {
    /* NO isConfigured() GATE. listHsLeads answers in preview too, from the
     * sample rows in data.js, and an early return here made this block vanish
     * on the preview build — which is the build CJ looks at before he hands a
     * rep their login. A new section that is simply not there reads as broken.
     * Caught by driving the page, not by a test. */
    const today = teamToday();
    const res = await listHsLeads({
      fromMs: teamDayStartMs(addTeamDays(today, -(LOOKBACK_DAYS - 1))),
      toMs: teamDayEndMs(today),
    });
    const nowMs = Date.now();
    setState({
      loading: false,
      nowMs,
      errors: res.errors || [],
      sample: Boolean(res.sample),
      rows: hsHotLeads(hsLeadRows({ sources: res.sources, leads: res.leads, nowMs })),
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => (all ? state.rows : state.rows.slice(0, SHOW)), [state.rows, all]);

  if (state.loading) return <div className="adm-sl-loading">Reading the landing-page leads…</div>;

  /* Every number on a rep's page carries the window it covers and the day it was
   * read. This one is no different. */
  const stamp = state.nowMs ? `last ${LOOKBACK_DAYS} days · read ${teamDate(state.nowMs)}` : "";

  return (
    <section className="card adm-fin-block" style={{ marginTop: 14 }}>
      <div className="adm-fin-block-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="adm-fin-block-title">Worth ringing — from the landing pages</h3>
          <p className="adm-fin-block-blurb">
            People who ran the free scan on one of our own pages, left an email, and have not bought.
            {HS_FRESH_DAYS} days old or less, and either they opened the checkout and stopped or their
            website scored {HS_WEAK_SCORE} or below. Nobody owns these — whoever rings first.
            <span className="dim"> · {stamp}{state.sample ? " · sample rows" : ""}</span>
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => go("#/dashboard/home-services-leads")}>
          See all of them →
        </button>
      </div>

      {state.errors?.length > 0 && (
        <div className="rb-note rb-note-stop" style={{ marginBottom: 12 }}>
          <strong>Part of this could not be read</strong>: {state.errors.join(" · ")}. The list below is
          what came back, not everything there is.
        </div>
      )}

      {state.rows.length === 0 ? (
        <p className="dim" style={{ margin: 0 }}>
          Nobody is on this list right now. That means no unsold scan in the last {HS_FRESH_DAYS} days —
          it is a count of rows that do not exist, not a broken read.
        </p>
      ) : (
        <>
          <div className="adm-hs-tablewrap">
            <table className="adm-hs-table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Page</th>
                  <th className="n">Score</th>
                  <th>Why they are on this list</th>
                  <th className="n">Days ago</th>
                  <th className="n">Open</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.leadId} className="adm-hs-hot">
                    <td>
                      {r.readable ? (
                        <>
                          <strong>{r.company || r.name || "(no name)"}</strong>
                          <div className="dim" style={{ fontSize: 12 }}>
                            {r.email || "no email"}{r.phone ? ` · ${r.phone}` : ""}
                          </div>
                          {(r.scannedDomain || r.domain) && (
                            <div className="dim" style={{ fontSize: 12 }}>{r.scannedDomain || r.domain}</div>
                          )}
                        </>
                      ) : (
                        <span className="adm-hs-blank" title="The lead row could not be read — it has been deleted, or it is not one you may see.">not readable</span>
                      )}
                    </td>
                    <td>{r.pageLabel}</td>
                    <td className="n"><Score value={r.score} /></td>
                    <td className="dim">{r.hotReason}</td>
                    <td className="n">{r.daysOld === null ? "—" : r.daysOld}</td>
                    <td className="n">
                      <button type="button" className="adm-hs-link" onClick={() => go(`#/dashboard/floor?lead=${r.leadId}`)}>
                        Open →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.rows.length > SHOW && (
            <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setAll((v) => !v)}>
              {all ? `Show the top ${SHOW}` : `Show all ${state.rows.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
