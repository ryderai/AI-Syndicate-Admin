import { useCallback, useEffect, useMemo, useState } from "react";
import { getFloorBoard, LEAD_STAGE_LABELS } from "../../lib/data.js";
import { outreachFor, OUTREACH_WINDOW_DAYS } from "../../../lib/outreach.js";
import { teamDate } from "../../../lib/brain-context.js";
import { SectionHeader, SourceBadge } from "./shared.jsx";
import { Tile, MiniBar, money } from "./salesParts.jsx";
/* THE ASK BOX IS THE ONE ON THE WORK PAGE, not a copy of it. Two boxes that
 * send the same question to the same endpoint would drift the first time
 * somebody changed one of them, and the thing they drift on is what a rep is
 * allowed to be told about. So repBrief.jsx keeps it and this page borrows it. */
import { RepAskBox } from "./repBrief.jsx";

/* A SALES REP'S OVERVIEW — their landing page.
 *
 * Aug 27 2026. CJ is giving the reps their own logins, so a rep needs a page
 * that opens with "how am I doing" rather than with a list to grind. Two halves,
 * in this order:
 *   1. THE BOX. Ask the AI anything about your own book.
 *   2. YOUR NUMBERS. The funnel, then what you are holding, then where the
 *      pipeline sits, then why deals were won and lost.
 *
 * NOTHING ON THIS PAGE COMPARES ONE PERSON WITH ANOTHER. No other rep's name, no
 * league table, no "best" or "worst", not even by implication. lib/rep-report.js
 * blocks the AI from writing that kind of sentence on purpose; a tile that did
 * it by accident would walk straight past the gate. If a comparison is ever
 * wanted, it belongs on the owner's page, where the person reading it is the
 * person who has to make a decision about it.
 *
 * EVERY NUMBER HERE IS COUNTED BY lib/outreach.js FROM ONE READ. This file does
 * no arithmetic of its own. That is not tidiness: outreachFor() is also what
 * fills the owner's per-rep table, so a rep's tile and CJ's cell for that rep
 * are the same function over the same rows, and neither can be the one that is
 * wrong.
 *
 * AND EVERY NUMBER CARRIES THE WINDOW IT COVERS AND THE DAY IT WAS READ. A count
 * with no period attached is not a measurement — "12 replies" is a different
 * fact over a week than over a quarter, and the number that gets quoted in a
 * meeting is the one somebody read off a screen three days earlier.
 */

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

/** The words we use for a number that does not exist. Never 0.
 *
 * "Nobody replied" and "we could not count the replies" are opposite answers,
 * and a zero says the first one confidently. So a missing number prints as
 * words, and the reason it is missing prints under it — see the null rule at the
 * top of lib/outreach.js. */
const NOT_MEASURED = "not measured yet";

/**
 * One tile, with the window it covers and the day it was read stamped on it.
 *
 * `stamp` is not optional and there is no default. A default would be the thing
 * that quietly puts an unstamped number on the screen the next time somebody
 * adds a tile in a hurry.
 *
 * Tile from salesParts.jsx is a button, and with no `onClick` it renders
 * disabled. That is on purpose here: nothing on this page is clickable yet
 * because the routing is being wired separately, and a tile that looks pressable
 * and does nothing is worse than one that plainly is not.
 */
function StampedTile({ label, value, unknownWhy, hint, tone, stamp }) {
  const missing = value === null || value === undefined;
  return (
    <Tile
      label={label}
      value={missing
        /* The display font is 27px, which "not measured yet" cannot live in
         * without wrapping into the label underneath it. Shrunk here rather
         * than in salesParts.jsx — that file is shared, and this is a decision
         * about this page's wording, not about tiles. */
        ? <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-dim)", lineHeight: 1.3, display: "inline-block", paddingTop: 6 }}>{NOT_MEASURED}</span>
        : value}
      hint={[missing ? unknownWhy : hint, stamp].filter(Boolean).join(" · ")}
      tone={missing ? undefined : tone}
    />
  );
}

/** A block heading with the same shape as the ones on the owner's Overview, so a
 * rep's page reads as a sibling of it rather than as a different product. */
function Block({ kicker, title, subtitle, children, right }) {
  return (
    <>
      <SectionHeader kicker={kicker} title={title} subtitle={subtitle} right={right} />
      {children}
    </>
  );
}

/** The reasons a close was given, grouped, or the reason there are none.
 *
 * WHEN THERE ARE NONE IT SAYS WHY THERE ARE NONE. An empty box reads as a
 * failure — either yours or the page's — and neither is what "nothing closed in
 * the last thirty days" means. */
function ReasonList({ title, rows, total, empty, stamp }) {
  return (
    <div className="card rb-named">
      <div className="label" style={{ marginBottom: 8 }}>{title}</div>
      {rows === null && (
        <div className="rb-unknown">
          Your leads could not be read, so this is unknown rather than empty.
        </div>
      )}
      {rows && rows.length === 0 && (
        <div style={{ fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.6 }}>{empty}</div>
      )}
      {(rows || []).map((r) => (
        <div key={r.code || "none"} className="rb-named-row" style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          <span className="rb-named-l" style={{ flex: 1 }}>{r.label}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700 }}>{r.count}</span>
        </div>
      ))}
      {rows && rows.length > 0 && (
        <div className="rb-owed-foot" style={{ marginTop: 8 }}>
          {total} in total, {stamp}. Every one of them is in exactly one line above, including the
          ones nobody wrote a reason on.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A rep's landing page. `member` is the signed-in person; `member.user_id` is
 * what every number on the page is counted for.
 */
export default function RepOverview({ member }) {
  const userId = member?.user_id || null;

  const [board, setBoard] = useState(null);
  const [loadError, setLoadError] = useState(null);
  /* ONE CLOCK FOR THE WHOLE RENDER, taken when the rows arrive and not touched
   * again. Calling Date.now() inside a tile means two tiles on one screen can
   * disagree about what day it is — which happens at midnight, to one person,
   * and is impossible to reproduce when they report it. */
  const [nowMs, setNowMs] = useState(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      /* ONE READ. getFloorBoard() already returns the leads, the firms, what was
       * logged, the proposals, the team, the tags and the scans, plus its own
       * errors and caps. A second read of the same tables would be a second
       * snapshot of them, and two snapshots is how a tile ends up disagreeing
       * with the list underneath it. */
      const got = await getFloorBoard();
      setNowMs(Date.now());
      setBoard(got);
    } catch (err) {
      setLoadError(String(err?.message || err));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => {
    if (!board || nowMs === null) return null;
    return outreachFor({
      leads: board.leads,
      activity: board.activity,
      proposals: board.proposals,
      userId,
      nowMs,
    });
  }, [board, nowMs, userId]);

  if (loadError) {
    return (
      <div className="card" style={{ padding: "14px 18px", border: "1px solid var(--danger)", background: "#fef3f2" }}>
        <div className="label" style={{ color: "var(--danger)" }}>NOTHING COULD BE READ</div>
        <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
          The read failed, so there are no numbers on this page rather than zeros.
          <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, marginTop: 6 }}>{loadError}</div>
        </div>
        <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => load()}>Try again</button>
      </div>
    );
  }

  if (!board || !stats) return <div className="adm-sl-loading">Reading your rows…</div>;

  /* The stamp every tile carries. Two facts, always together: the length of time
   * the number covers, and the day the rows were read.
   *
   * teamDate() and not the browser clock. The team works on one calendar (see
   * lib/brain-context.js), and a page that dates itself from the laptop it is
   * open on will call the same read two different days depending on who opened
   * it. Printed as YYYY-MM-DD rather than run back through new Date(), which on
   * a bare date string means midnight UTC — the evening before, here. That trap
   * has cost this repo three shipped bugs. */
  const readOn = teamDate(nowMs);
  const days = stats.window?.days ?? OUTREACH_WINDOW_DAYS;
  const windowStamp = `last ${days} days · read ${readOn}`;
  const nowStamp = `right now · read ${readOn}`;

  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginTop: -6 };

  return (
    <>
      <Block
        kicker="Yours"
        title="Overview"
        subtitle="Your landing page. Ask the AI anything about your own book at the top, then your own numbers underneath. Nothing here compares you to another rep."
        right={<SourceBadge
          mode={board.sample ? "sample" : "live"}
          hint={board.sample
            ? "Sample rows — these are made-up leads, not yours"
            : "Counted from your own leads, your own logged touches and your own proposals"}
        />}
      />

      {/* ---------------- WHAT DID NOT LOAD, AND WHAT WAS CUT SHORT ----------
        * ABOVE EVERY NUMBER, both of them. Somebody who reads a number and then
        * the warning under it has already believed the number.
        *
        * These two panels are the ONLY thing that can tell you a read failed.
        * getFloorBoard() hands a failed read over as an empty list with its
        * error in `errors` — so downstream, an empty book and a broken database
        * look exactly alike. That is why these come first and why they say what
        * they say. Same wording as the top of SalesPage.jsx on purpose. */}
      {board.errors.length > 0 && (
        <div className="adm-sl-warn" role="alert">
          <strong>Some of this did not load.</strong> {board.errors.join(" · ")} Everything below is
          counted from what did load, so read it as incomplete, not as a full picture — a number
          that came out low here may only mean the rows behind it are missing.
        </div>
      )}
      {board.truncated.length > 0 && (
        <div className="adm-sl-warn" role="status">
          <strong>Not everything is loaded.</strong> {board.truncated.join(" ")} The counts below
          cover what was actually fetched and nothing more.
        </div>
      )}

      {/* ---------------- THE BOX ----------------
        * Above the numbers. Collapsed it is one strip, so it costs about sixty
        * pixels and pushes nothing below the fold — and the question a rep wants
        * to ask is usually the one the numbers underneath just put in their
        * head. */}
      <RepAskBox userId={userId} sample={board.sample} />

      {/* ---------------- THE REFUSAL ----------------
        * NO SIGNED-IN ID, NO NUMBERS AT ALL. The "mine" filter is `owner_id ===
        * userId`, and with a falsy id that test passes nothing — but the older
        * readers in this codebase pass EVERYTHING, which on this page would
        * print another rep's book as yours. outreachFor refuses rather than
        * guessing which. The reason is written out above buildRepOverview in
        * src/lib/repBrief.js.
        *
        * It is drawn instead of the numbers, not above them, so there is no
        * chance of a blank tile row underneath reading as "you have nothing". */}
      {!stats.knowsWho ? (
        <div className="rb-note rb-note-stop" style={{ marginTop: 14 }}>
          <strong>We do not know which account you are signed in as</strong>, so nothing on this page
          could be counted for you. Every number is left off rather than shown as zero — a zero here
          would read as &ldquo;you have done nothing&rdquo;, which is not what we know.
          <div style={{ marginTop: 6 }}>
            Sign out and back in. If it says this again, it is ours to fix, not yours.
          </div>
        </div>
      ) : (
        <>
          {stats.unreadable.length > 0 && (
            <div className="rb-note rb-note-stop" style={{ marginTop: 14 }}>
              <strong>Some of this could not be read</strong>: {stats.unreadable.join(", ")}. Those
              figures say &ldquo;{NOT_MEASURED}&rdquo; below instead of zero.
            </div>
          )}

          {/* ---------------- OUTREACH — THE FUNNEL ---------------- */}
          <Block
            kicker="Outreach"
            title="The funnel"
            subtitle={`Who you reached, who wrote back, and how fast. Everything in this block covers the last ${days} days and nothing older.`}
          >
            <div style={grid}>
              {/* PEOPLE, NOT EMAILS. Five follow-ups to one person is one person
                * reached, and counting it as five would give a rep a 20% reply
                * rate for a conversation that actually worked. The count of
                * emails is its own tile further along, labelled as what it is. */}
              <StampedTile
                label="People emailed"
                value={stats.emailed}
                hint="each person counted once, however many emails you sent them"
                unknownWhy="your leads could not be read"
                stamp={windowStamp}
              />
              <StampedTile
                label="People who replied"
                value={stats.replied}
                hint="a real answer from a real person"
                unknownWhy="your leads could not be read"
                stamp={windowStamp}
              />
              {/* THE RATE, AND WHAT IT WAS DIVIDED BY, on the same tile. A
                * percentage with no denominator is the easiest number in this
                * console to misread: 100% of one person is not a good month. */}
              <StampedTile
                label="Reply rate"
                value={stats.replyRate === null ? null : `${stats.replyRate}%`}
                hint={`${stats.replied} of ${stats.replyBase} people who could answer`}
                unknownWhy={stats.replyBase === 0
                  ? "nobody was emailed in this window, so there is nothing to divide by"
                  : "your leads could not be read"}
                stamp={windowStamp}
              />
              <StampedTile
                label="Average time to reply"
                value={stats.avgReplyDays === null ? null : `${stats.avgReplyDays}d`}
                hint={`averaged over ${stats.avgReplySample} ${stats.avgReplySample === 1 ? "reply" : "replies"}`}
                /* NOT "nobody has replied yet". That is one of three reasons this
                   can be blank, and the other two are reachable: a reply with no
                   send on record, and a reply dated before the send it answers.
                   The screen would then read "People who replied: 2" next to
                   "Average time to reply: nobody has replied yet", which is the
                   page arguing with itself. Aug 27 2026, after a review. */
                unknownWhy="no reply in this window has both a send and an answer we can date, so there is no gap to average"
                stamp={windowStamp}
              />
              {/* A BOUNCE IS NOT A REFUSAL. The address does not exist, so that
                * person was never given the chance to answer — which is why they
                * are taken out of the reply rate above rather than counted
                * against you. Said here, on the tile, because the alternative is
                * a rep working out their own version of the number and getting a
                * worse one. */}
              <StampedTile
                label="Bounced"
                value={stats.bounced}
                hint="dead addresses — taken out of the reply rate, not counted against you"
                unknownWhy="your leads could not be read"
                stamp={windowStamp}
              />
              <StampedTile
                label="Emails you sent"
                value={stats.logged?.email}
                hint="every email, including follow-ups to the same person"
                unknownWhy="what was logged could not be read"
                stamp={windowStamp}
              />
              <StampedTile
                label="Calls logged"
                value={stats.logged?.call}
                hint="calls you wrote down — a call nobody logged is not here"
                unknownWhy="what was logged could not be read"
                stamp={windowStamp}
              />
              {/* MEETINGS ARE NOT COUNTED ANYWHERE YET, so this tile says so
                * rather than borrowing a number that means something else.
                *
                * There is no "meeting" kind of logged touch — the four kinds are
                * email, call, text and LinkedIn — so nothing in the system knows
                * a meeting happened on a day. The only meeting figure that
                * exists is how many of your leads are SITTING at the Meeting
                * stage, which is a fact about right now and not about the last
                * thirty days, and it is in "Pipeline by stage" below where its
                * heading says so. Putting it here under a windowed stamp would
                * make that stamp a lie. */}
              <StampedTile
                label="Meetings"
                value={null}
                unknownWhy="nothing logs a meeting as an event yet — the leads sitting at the Meeting stage are in Pipeline by stage below"
                stamp={windowStamp}
              />
              {/* THE TOTAL ONLY WHEN IT IS REAL. Three proposals nobody priced
                * add up to $0, and $0 is a number somebody would quote in a
                * meeting. outreachFor returns null for the amount in that case
                * and says how many of them carry a price. */}
              <StampedTile
                label="Proposals out"
                value={stats.proposalsOut}
                /* Three answers, not two: none out at all, some out with no
                 * price written on them, or a real total. The middle one used to
                 * borrow the "no amount on any of them" wording for the case
                 * where there were no proposals either, which reads as a
                 * complaint about paperwork that does not exist. */
                hint={stats.proposalsOut === 0
                  ? "nothing out with anybody at the moment"
                  : stats.proposalCents === null
                    ? "sent and not yet answered · no amount written on any of them"
                    : `${money(stats.proposalCents)} across the ${stats.proposalsPriced} with an amount on them`}
                unknownWhy="your proposals could not be read"
                stamp={windowStamp}
              />
            </div>

            {/* ONE NOTE, TWO FACTS, and both of them are things a rep would
              * otherwise ask about within a week. */}
            <div className="card" style={{ padding: "13px 16px", marginTop: 12, fontSize: 12.5, lineHeight: 1.65, color: "var(--ink-2)" }}>
              <div>
                <strong>No open rate anywhere.</strong> Gmail cannot tell us whether somebody opened
                an email — only a tracking pixel can, and that number lies. People emailed and
                replies are both real and both measured.
              </div>
              {/* WHY THE ROW IS ZEROS TODAY, said out loud. Nothing sends mail
                * through the console yet, and the columns these tiles read start
                * filling from the first send — nothing is back-filled, on
                * purpose, because dating an old email by the day we read it
                * would make the window stamp on every tile above false. A row of
                * zeros with no explanation reads as bad performance, and it is
                * not: it is an empty measuring jug. */}
              <div style={{ marginTop: 8 }}>
                <strong>These start at nothing.</strong> They begin filling from the first email sent
                through this console — nothing older is counted backwards, because dating an old
                email by the day we read it would make &ldquo;{windowStamp}&rdquo; above untrue. Zeros
                here mean nothing has been measured yet, not that you have done nothing.
              </div>
            </div>
          </Block>

          {/* ---------------- YOUR BOOK RIGHT NOW ----------------
            * NOT WINDOWED, and the heading says so rather than leaving somebody
            * to assume the stamp above still applies. "How many leads you hold"
            * is a fact about this second; "how many people you emailed" is a
            * fact about a period. Mixing the two under one stamp is how a
            * screen starts being quoted wrongly. */}
          <Block
            kicker="Your book"
            title="Right now"
            subtitle="This block is a snapshot of this moment, not of the last few weeks. It is what you are holding as you read it."
          >
            <div style={grid}>
              <StampedTile
                label="Leads you hold"
                value={stats.holding}
                hint="open leads claimed in your name"
                unknownWhy="your leads could not be read"
                stamp={nowStamp}
              />
              {/* The two states the overnight sweep actually acts on: a claim
                * with no first contact whose days have run out, and one about to.
                * Every claim and cold decision on this page comes from
                * lib/sales-rules.js — nothing here re-derives one, so this page
                * and the Sales page cannot tell you two things about one firm. */}
              <StampedTile
                label="Claims running out"
                value={stats.claimsExpiring}
                hint="no first contact logged and the days are nearly up"
                tone="#b54708"
                unknownWhy="your leads could not be read"
                stamp={nowStamp}
              />
              <StampedTile
                label="Gone quiet"
                value={stats.quiet}
                hint={`nothing logged for a while — ${stats.coldAfterDays} days and it goes back on the floor`}
                tone="#b42318"
                unknownWhy="your leads could not be read"
                stamp={nowStamp}
              />
              <StampedTile
                label="Never touched"
                value={stats.neverTouched}
                hint="claimed by you, no first contact logged at all"
                unknownWhy="your leads could not be read"
                stamp={nowStamp}
              />
            </div>
          </Block>

          {/* ---------------- PIPELINE BY STAGE ---------------- */}
          <Block
            kicker="Your pipeline"
            title="By stage"
            subtitle="Where the leads you hold have got to. Open stages only — won, lost, skipped and bad-contact rows are finished with and are not in here or in the block above."
          >
            <div className="card" style={{ padding: "15px 16px" }}>
              {stats.stages === null && (
                <div className="rb-unknown">Your leads could not be read, so this is unknown rather than empty.</div>
              )}
              {stats.stages && stats.holding === 0 && (
                <div style={{ fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.6 }}>
                  You hold no open leads at the moment, so there is nothing to break down. Unclaimed
                  leads are on the <strong>Leads</strong> page.
                </div>
              )}
              {/* IN THE LADDER'S ORDER, AND EVERY RUNG DRAWN, including the empty
                * ones. outreachFor decides the set and the order; this only
                * draws it. A stage quietly dropped for having nobody in it reads
                * as a stage that does not exist — and "nobody has reached
                * Proposal" is exactly the sort of gap this page is for. The
                * empty ones are greyed so they are quiet without being hidden. */}
              {stats.stages && stats.holding > 0 && (
                <div style={{ display: "grid", gap: 10 }}>
                  {stats.stages.map((s) => (
                    <div key={s.stage} style={{ opacity: s.count === 0 ? 0.45 : 1 }}>
                      <MiniBar
                        label={LEAD_STAGE_LABELS[s.stage] || s.stage}
                        n={s.count}
                        total={stats.holding}
                      />
                    </div>
                  ))}
                </div>
              )}
              {stats.stages && stats.holding > 0 && (
                <div className="rb-owed-foot" style={{ marginTop: 10 }}>
                  Every one of your {stats.holding} open leads is on exactly one rung above.
                  Read {readOn}.
                </div>
              )}
            </div>
          </Block>

          {/* ---------------- WON AND LOST, WITH THE REASON ----------------
            * Dated from the day the deal actually closed, which is the only
            * honest way to put a close inside a window. A won or lost lead with
            * no closing date on it is left OUT of both lists and counted in the
            * footnote instead — a breakdown quietly missing rows is the thing
            * this whole page exists to avoid. */}
          <Block
            kicker="Closed"
            title="Why they said no, and why they said yes"
            subtitle={`Deals of yours that finished in the last ${days} days, grouped by the reason written on them at the time.`}
          >
            <div className="rb-two" style={{ marginTop: 0 }}>
              <ReasonList
                title="Why you lost"
                rows={stats.lostReasons}
                total={stats.lost}
                stamp={windowStamp}
                empty={`Nothing of yours was marked lost in the last ${days} days, so there is nothing to group. This is an empty list, not a missing one.`}
              />
              <ReasonList
                title="Won — why they said yes"
                rows={stats.wonReasons}
                total={stats.won}
                stamp={windowStamp}
                empty={`Nothing of yours closed as won in the last ${days} days, so there is nothing to group. This is an empty list, not a missing one.`}
              />
            </div>
            {stats.closedWithNoDate > 0 && (
              <div className="adm-sl-warn adm-sl-warn-flat" role="status">
                <strong>{stats.closedWithNoDate} of your finished deals have no closing date on
                them</strong>, so they are not in either list above and not in the totals under them.
                They were closed before the date was recorded. Nothing is wrong with the deal; there
                is just no day to file it under.
              </div>
            )}
          </Block>
        </>
      )}
    </>
  );
}
