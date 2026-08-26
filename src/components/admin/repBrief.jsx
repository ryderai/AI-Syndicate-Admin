import { useEffect, useMemo, useRef, useState } from "react";
import { askRepReport, LEAD_STAGE_LABELS } from "../../lib/data.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { toast } from "../../lib/toast.js";
import { SectionHeader, SourceBadge, TextArea, timeAgo } from "./shared.jsx";
import {
  REP_PRESETS, MAX_INSTRUCTION_CHARS, buildRepOverview, checkInstruction,
  countedOnlyCause, splitCountedFigures,
} from "../../lib/repBrief.js";

/* THE REP'S WORK PAGE — the two panels.
 *
 * Aug 26 2026. Ryder asked for "an overall work page that is like an overview of
 * everything plus ai reports and everything so you can effectively convert
 * leads", and on the AI half: "just a prompt text that you fill in to ask ai to
 * give a report and then you type what you want, then ai with its knowledge of
 * everything going on in the system can give a full rundown".
 *
 * So two things, in this order:
 *   1. THE BOX. You type the question, it answers underneath.
 *   2. YOUR NUMBERS. How your claims stand, who has gone quiet, what stage your
 *      own pipeline is in.
 *
 * WHY THE BOX IS ABOVE THE NUMBERS. Collapsed it is one strip, so it costs about
 * sixty pixels and pushes nothing below the fold — and the four tiles already at
 * the top of Work are what make somebody want to ask a question in the first
 * place ("why am I four late?"). The numbers then sit directly above the tabs
 * they explain: the claim buckets and the stage breakdown are the detail behind
 * People to contact and My leads, so they belong next to them rather than
 * separated from them by a text box.
 *
 * IT IS A SIBLING OF consoleReports.jsx, not a different product. The strip that
 * expands in place, the presets that only FILL the box, the busy label, the
 * counted figures shown beside the words — all of it is that panel's, pointed at
 * a rep's slice. Somebody who has used the owner's box has used this one.
 *
 * WHAT IS DELIBERATELY NOT HERE: a list of everything written before. The
 * endpoint's own comment says the table it saves to may not exist yet, so a
 * history panel would spend most of its life explaining why it is empty. And a
 * count on a filing cabinet reads as "something needs you" — the same rule that
 * keeps a number off the Reports tab on the client page.
 */

/* ------------------------------------------------------------------ */
/* The answer, rendered                                                */
/* ------------------------------------------------------------------ */

/* Minimal renderer — the same approach consoleReports.jsx and clientReports.jsx
 * take, and for the same reason: the only things the instruction asks for are
 * "## " headings, bullets and paragraphs, so a markdown library would be a
 * dependency to draw three shapes. It is copied rather than shared because the
 * Overview's copy is local to that file and not exported. */
function RichText({ text }) {
  const blocks = useMemo(() => {
    const lines = String(text || "").split("\n");
    const out = [];
    let list = null;
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (/^\s*[-*•]\s+/.test(line)) {
        list = list || [];
        list.push(line.replace(/^\s*[-*•]\s+/, ""));
        continue;
      }
      if (list) { out.push({ t: "ul", items: list }); list = null; }
      if (!line.trim()) continue;
      if (/^\s{0,3}#{2,6}\s+/.test(line)) out.push({ t: "h", text: line.replace(/^\s{0,3}#+\s+/, "") });
      else out.push({ t: "p", text: line });
    }
    if (list) out.push({ t: "ul", items: list });
    return out;
  }, [text]);

  return (
    <>
      {blocks.map((b, i) => {
        if (b.t === "h") {
          return <h4 key={i} className="rb-h">{b.text}</h4>;
        }
        if (b.t === "ul") {
          return (
            <ul key={i} className="rb-ul">
              {b.items.map((it, j) => <li key={j}>{it}</li>)}
            </ul>
          );
        }
        return <p key={i} className="rb-p">{b.text}</p>;
      })}
    </>
  );
}

/** A count key turned into a label, the way the Overview's fact panel does it. */
function factLabel(k) {
  return k.replace(/([A-Z])/g, " $1").toUpperCase();
}

/** The figures the answer was written from, shown BESIDE the words rather than
 * behind a button. A number a reader cannot check against its source is a number
 * they have to take on trust, and this box exists partly so they do not have to.
 * The Overview hides the same grid behind "Check the numbers"; that is a page
 * where the numbers are also drawn on twenty cards above it. Here they are not. */
function CountedFigures({ facts }) {
  /* THE RULES ARE NOT FIGURES. `facts.counts` carries four house settings next to
   * the counts so the counted answer can write "past the 14-day line" without
   * stating a number nothing backs. Printed in this grid they read as measured:
   * "COLD AFTER DAYS 14" under "the figures this was written from" tells a rep
   * something was counted about them. Split, with a sentence each, so a rule
   * reads as a rule. Aug 26 2026. */
  const { figures, rules } = splitCountedFigures(facts?.counts);
  return (
    <div className="rb-facts">
      <div className="label" style={{ marginBottom: 6 }}>The figures this was written from</div>
      <div style={{ fontSize: 11.5, color: "var(--ink-dim)", lineHeight: 1.6, marginBottom: 10 }}>
        Read at {facts?.takenAt ? new Date(facts.takenAt).toLocaleString("en-US") : "an unknown time"}.
        {" Every number above had to appear in these counts."}
      </div>
      {(facts?.unreadable || []).length > 0 && (
        <div className="rb-note rb-note-stop">
          These reads failed and are <strong>unknown, not empty</strong>: {facts.unreadable.join(", ")}.
          Anything about them is missing from the answer rather than counted as none.
        </div>
      )}
      {figures.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>
          No figures came back with this answer, so there is nothing here to check it against.
        </div>
      ) : (
        <div className="rb-fact-grid">
          {figures.map((f) => (
            <div key={f.key} className="rb-fact">
              <div className="rb-fact-k">{factLabel(f.key)}</div>
              <div className="rb-fact-v">{String(f.value)}</div>
            </div>
          ))}
        </div>
      )}
      {rules.length > 0 && (
        <>
          <div className="label" style={{ marginTop: 16, marginBottom: 6 }}>The rules and read limits behind them</div>
          <div style={{ fontSize: 11.5, color: "var(--ink-dim)", lineHeight: 1.6, marginBottom: 6 }}>
            Settings, not counts. Nothing here was measured about you — these are the lines the
            figures above were measured against.
          </div>
          <ul className="rb-ul">
            {rules.map((r) => <li key={r.key}>{r.sentence}</li>)}
          </ul>
        </>
      )}
      {(facts?.cannotAnswer || []).length > 0 && (
        <>
          <div className="label" style={{ marginTop: 16, marginBottom: 6 }}>What these records cannot answer</div>
          <div style={{ fontSize: 11.5, color: "var(--ink-dim)", lineHeight: 1.6, marginBottom: 6 }}>
            Nothing above is based on these. Named out loud on purpose — a gap nobody mentions reads
            as &ldquo;checked, all fine&rdquo;.
          </div>
          <ul className="rb-ul">
            {facts.cannotAnswer.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

/** The finished answer. The two warnings come FIRST, above the words, because
 * somebody who reads the answer and then the warning has already believed it. */
function RepAnswer({ report }) {
  /* Worked out once and used in all three places the fact has to be told — the
   * paragraph, the copied markdown, and the toast — so a forwarded copy cannot
   * say something different from the screen it came off. */
  const cause = countedOnlyCause(report);

  async function copyAll() {
    const md = [
      `# ${report.instruction}`,
      "",
      report.counted_only ? `> No AI wrote this. ${cause.lead}${cause.reason ? ` Why: ${cause.reason}.` : ""}` : "",
      report.saved === false ? "> This answer was not filed. It is on this screen and nowhere else." : "",
      "",
      report.body || "",
    ].filter((l) => l !== "").join("\n");
    const ok = await copyToClipboard(md);
    if (ok) toast.success("Copied");
    else toast.error("Couldn't copy", "Select the text and copy it by hand.");
  }

  return (
    <div className="rb-answer">
      <div className="rb-asked">
        Asked for: &ldquo;{report.instruction}&rdquo;
        {report.generated_at ? ` · written ${timeAgo(report.generated_at)}` : ""}
      </div>

      {/* ---- no AI wrote this, and which of the three reasons ----
        * NOT A BADGE. A badge saying "numbers unchecked" is not a control,
        * because the person who forwards the answer is not the person who read
        * the badge. So it is a paragraph, in the reading order, in plain words,
        * and it carries the reason.
        *
        * It used to say "the written draft was thrown away" for all three
        * reasons, which in preview mode — the default path — printed a thrown-away
        * draft and then explained that nothing was ever sent. countedOnlyCause
        * picks the half that is true for this one. The bold sentence does not
        * change: no AI wrote these words, in all three cases. Aug 26 2026. */}
      {report.counted_only && (
        <div className="rb-note rb-note-warn">
          <strong>No AI wrote this.</strong> {cause.lead}
          {cause.reason && (
            <div style={{ marginTop: 6 }}>Why: {cause.reason}.</div>
          )}
        </div>
      )}

      {/* ---- it was not filed ---- */}
      {report.saved === false && (
        <div className="rb-note rb-note-stop">
          <strong>This answer was not filed.</strong> It is on this screen and nowhere else — reload
          the page and it is gone. Copy anything you need out of it now.
          {/* ONE CAUSE WAS NAMED HERE AS IF IT WERE THE CAUSE. `saved: false` is
            * set for any insert error at all — a constraint, a permission rule,
            * a network blip — and the old wording asserted the missing table,
            * with a hard-coded "eight migrations" that would rot the next time
            * somebody ran one. The hint is still worth giving; asserting it is
            * not. Aug 26 2026. */}
          <div style={{ marginTop: 6 }}>
            The database refused to store it and the reason is in the server log. The likeliest one
            is that the table it saves to does not exist yet — not every migration in this project
            has been run — but a permission rule or a dropped connection looks the same from here.
            Nothing you asked for was lost; it just was not written down.
          </div>
        </div>
      )}

      {/* The summary is LIFTED from the body's first paragraph, which is what
          stops it claiming anything the body does not. The cost is that printing
          both reads as a stutter — every counted answer opened with the same
          sentence twice. So it is shown only when the body does not already
          start with it. Aug 26 2026, after seeing it in the browser. */}
      {String(report.summary || "").trim()
        && !String(report.body || "").trim().startsWith(String(report.summary).trim()) ? (
        <div className="rb-summary"><RichText text={report.summary} /></div>
      ) : null}
      <RichText text={report.body} />

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
        <button className="btn btn-sm" onClick={copyAll}>Copy all</button>
      </div>

      <CountedFigures facts={report.facts} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The box                                                             */
/* ------------------------------------------------------------------ */

function RepAskBox({ userId, sample }) {
  /* SMALL BY DEFAULT, same as the Overview's generator. Ryder, Aug 23 2026, on
   * that one: "put the ai generator as like a small box but when you click open
   * it enlarges the box with the full thing." A rep's Work page is a page you
   * open to get through the day, so a full-height panel above the day's work
   * would be the wrong thing twice over. */
  const [open, setOpen] = useState(false);
  /* WHERE FOCUS GOES WHEN IT OPENS. Expanding used to leave focus on a button
   * that had just unmounted, which drops a keyboard or screen-reader user back at
   * the top of the document with no idea anything appeared. It goes to the box
   * they came to type in. `openedOnce` keeps it from stealing focus on the first
   * paint of a panel that was already open. Aug 26 2026. */
  const openedOnce = useRef(false);
  const [preset, setPreset] = useState(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);

  const gate = checkInstruction(instruction);
  const over = instruction.length > MAX_INSTRUCTION_CHARS;

  useEffect(() => {
    if (!open) { openedOnce.current = false; return; }
    if (openedOnce.current) return;
    openedOnce.current = true;
    /* By id rather than a ref: TextArea in shared.jsx is a plain function
     * component, so it does not forward one, and that file belongs to somebody
     * else this week. */
    document.getElementById("rb-ask-input")?.focus();
  }, [open]);

  async function run() {
    /* Refused here as well as in the reader. The button is disabled when the box
     * is empty, so this only fires if something got past that — and a reader
     * that trusts its caller is a reader that eventually gets called wrong. */
    if (!gate.ok) return toast.warn("Nothing to ask", gate.error);
    setBusy(true);
    const res = await askRepReport({ instruction, userId });
    setBusy(false);
    if (!res.ok) return toast.error("Couldn't answer that", res.error);
    setReport(res.report);
    /* Same classifier as the paragraph, so the toast cannot claim a draft was
     * thrown away when the panel underneath says nothing was sent. */
    if (res.report.counted_only) toast.warn("You got the counted version", countedOnlyCause(res.report).short);
    else if (res.report.saved === false) toast.warn("Written, but not filed", "Copy it before you reload.");
    else toast.success("Done");
  }

  const badge = (
    <SourceBadge
      mode={sample ? "sample" : "live"}
      hint={sample
        ? "Sample rows — you get the counted answer, no AI call"
        : "Reads your leads, your firms and your own follow-ups. Nothing else."}
    />
  );

  if (!open) {
    return (
      <button
        className="card rb-strip"
        onClick={() => setOpen(true)}
        aria-expanded="false"
        aria-controls="rb-ask-panel"
      >
        <span className="rb-strip-icon" aria-hidden="true">✎</span>
        <span style={{ flex: "1 1 240px", minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="rb-strip-title">Ask for a rundown of your own work</span>
            {badge}
          </span>
          <span className="rb-strip-hint">
            Type the question in your own words · a rundown of your week · which leads are going cold
            and what to say · what to do next and why that order
          </span>
        </span>
        <span className="rb-strip-open">Open ▾</span>
      </button>
    );
  }

  return (
    <div className="card rb-panel">
      <div className="rb-panel-head">
        <div style={{ minWidth: 0, flex: "1 1 320px", display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          <div className="rb-strip-title">Ask for a rundown of your own work</div>
          {badge}
        </div>
        <button
          className="btn"
          onClick={() => setOpen(false)}
          style={{ whiteSpace: "nowrap" }}
          aria-expanded="true"
          aria-controls="rb-ask-panel"
        >
          Close ▴
        </button>
      </div>

      <div className="rb-panel-body" id="rb-ask-panel">
        {/* A preset only FILLS the box. What is in the box is what gets sent —
          * a button that sends something other than what is on screen is a
          * button nobody trusts. */}
        {/* WHICH ONE IS CHOSEN WAS CARRIED BY COLOUR ALONE, and the group had no
          * name, so a screen reader read four unrelated buttons. aria-pressed says
          * chosen, and the group borrows the label already above it. */}
        <div className="label" style={{ marginBottom: 7 }} id="rb-preset-label">Start from one of these</div>
        <div
          role="group"
          aria-labelledby="rb-preset-label"
          style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 14 }}
        >
          {REP_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={preset === p.id}
              className={`rb-preset ${preset === p.id ? "active" : ""}`}
              onClick={() => { setPreset(p.id); setInstruction(p.instruction); }}
            >
              <span className="rb-preset-l">{p.label}</span>
              <span className="rb-preset-h">{p.hint}</span>
            </button>
          ))}
        </div>

        <label className="label" style={{ marginBottom: 6, display: "block" }} htmlFor="rb-ask-input">
          Say what you want, in your own words
        </label>
        <TextArea
          id="rb-ask-input"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          style={{ minHeight: 100 }}
          placeholder="Which of my leads is going cold, and what do I say to each one?"
        />
        {/* --ink-faint on white measured 2.2:1, and this only turns red once you
          * are already over the cap, so the number telling you how much room is
          * left was unreadable until it stopped mattering. --rb-quieter is the
          * same weight of quiet at 4.8:1. Aug 26 2026. */}
        <div className="rb-count" style={{ color: over ? "var(--danger)" : "var(--rb-quieter)" }}>
          {instruction.length} / {MAX_INSTRUCTION_CHARS}
          {over ? " · anything past the cap is cut off before it is sent" : ""}
        </div>

        <div className="rb-run">
          <div className="rb-run-note">
            It reads your leads, the firms behind them, what has been logged on them lately, the
            lists, the proposals and the follow-ups that are on you &mdash; including the amount
            written on a proposal, which it can quote. It cannot see invoices, payments or what
            anything cost, our paying clients, anybody else&apos;s follow-ups, or a call nobody
            wrote down.
          </div>
          <button className="btn btn-primary" disabled={busy || !gate.ok} onClick={run}>
            {busy ? "Reading your rows…" : "Write it"}
          </button>
        </div>

        {report && <RepAnswer report={report} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The numbers                                                         */
/* ------------------------------------------------------------------ */

/* One tone per kind of trouble, matching the piles at the top of Work so a red
 * number means the same thing everywhere on the page. */
const HARD = { tone: "#b42318", bg: "#fef3f2" };
const WARN = { tone: "#b54708", bg: "#fffaeb" };
const CALM = { tone: "var(--ink-dim)", bg: "var(--bg-3)" };
const TONE_FOR = {
  claim_expired: HARD, cold: HARD,
  first_contact_due: WARN, going_cold: WARN,
  first_contact: CALM, working: CALM,
};

/** A number, or the reason there is no number. `null` never prints as 0 — see
 * the note in buildRepOverview. */
function Figure({ value, unknown = "not read" }) {
  if (value === null || value === undefined) {
    return <span className="rb-unknown" title="This read failed, so the number is unknown rather than zero.">{unknown}</span>;
  }
  return <>{value}</>;
}

function RepNumbers({ overview, stageLabels }) {
  const o = overview;

  return (
    <div id="work-rep-numbers">
      <SectionHeader
        kicker="Your pipeline"
        title="What you are holding"
        subtitle="Every firm claimed in your name, how long each claim has left, and where your own leads sit. The claim and cold rules are the same ones the Sales page draws with."
        right={
          <span style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>
            <Figure value={o.owned} unknown="leads not read" /> open · <Figure value={o.floor} unknown="floor not read" /> on the floor
          </span>
        }
      />

      {!o.knowsWho && (
        <div className="rb-note rb-note-stop">
          <strong>We do not know which account you are signed in as</strong>, so none of these
          numbers could be counted. They are left blank rather than shown as zero — a zero here
          would read as &ldquo;you hold nothing&rdquo;.
        </div>
      )}

      {o.knowsWho && o.unreadable.length > 0 && (
        <div className="rb-note rb-note-stop">
          <strong>Some of this could not be read</strong>: {o.unreadable.join(", ")}. Those figures
          are blank below, not zero — &ldquo;none&rdquo; and &ldquo;could not read it&rdquo; are
          different answers.
        </div>
      )}

      {/* ---- how the claims stand ---- */}
      <div className="rb-claims">
        {(o.buckets || []).map((b) => {
          const t = TONE_FOR[b.key] || CALM;
          return (
            <div key={b.key} className="rb-claim" style={{ background: b.count > 0 ? t.bg : "var(--bg-3)" }}>
              <div className="rb-claim-n" style={{ color: b.count > 0 ? t.tone : "var(--ink-dim)" }}>{b.count}</div>
              <div className="rb-claim-l">{b.label}</div>
              <div className="rb-claim-w">{b.why}</div>
            </div>
          );
        })}
        {o.buckets === null && (
          <div className="rb-claim" style={{ background: "var(--bg-3)" }}>
            <div className="rb-claim-l">Your leads could not be read, so the claims cannot be counted.</div>
          </div>
        )}
      </div>
      {o.buckets && o.owned !== null && (
        <div className="rb-addup">
          These add up to your {o.owned} open lead{o.owned === 1 ? "" : "s"} — every claim is in
          exactly one of them.
          {o.neverContacted ? ` ${o.neverContacted} of them have no first contact logged at all.` : ""}
        </div>
      )}

      {/* ---- what is about to be lost, then who has gone quiet ----
        * In that order on purpose: a claim that runs out tomorrow beats a firm
        * that is merely quiet. */}
      <div className="rb-two">
        {/* NOT "at risk". SalesPage.jsx's "Claims at risk" tile counts claims that
          * have run out plus firms past the cold line; this list is claims that
          * have run out plus first contacts about to run out. Two different
          * numbers under one phrase, on two pages shipped the same day. The
          * counting did not change — see the note on atRisk in src/lib/repBrief.js
          * for why — so the title says exactly what is in the list, and the phrase
          * "at risk" is left to the page that had it first. Aug 26 2026. */}
        <NamedList
          title="No first contact logged, and the clock is up"
          empty="Every claim of yours has a first contact logged, or still has days to get one."
          rows={o.atRisk}
          unknown="Your leads could not be read, so this list is unknown rather than empty."
        />
        <NamedList
          title="Gone quiet"
          empty="Nothing of yours has gone quiet."
          rows={o.quiet}
          unknown="Your leads could not be read, so this list is unknown rather than empty."
        />
      </div>

      {/* ---- who is owed a touch, and why ---- */}
      <div className="card rb-owed">
        <div className="rb-owed-head">
          <div>
            <div className="rb-owed-n"><Figure value={o.owed} unknown="not read" /></div>
            <div className="label" style={{ marginBottom: 0 }}>Owed a touch</div>
          </div>
          <div className="rb-owed-why">
            {o.owedWhy === null && <span className="rb-unknown">Who is owed a touch could not be read.</span>}
            {o.owedWhy && o.owedWhy.length === 0 && <span style={{ color: "var(--ink-dim)" }}>Nobody is waiting on you.</span>}
            {(o.owedWhy || []).map((r) => (
              <span key={r.key} className="rb-owed-tag">
                <strong>{r.count}</strong> {r.label.toLowerCase()}
              </span>
            ))}
          </div>
        </div>
        <div className="rb-owed-foot">
          The same people the <strong>People to contact</strong> tab lists — this only says why each
          one is on it. Open follow-ups on you, whoever set them:{" "}
          <Figure value={o.remindersOpen} />.
        </div>
      </div>

      {/* ---- stage breakdown ---- */}
      <div className="card rb-stages">
        <div className="label" style={{ marginBottom: 8 }}>Your own pipeline, by stage</div>
        {o.stages === null && <div className="rb-unknown">Your leads could not be read.</div>}
        {o.stages && o.stages.length === 0 && (
          <div style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>
            You hold no open leads. The floor is on the <strong>Leads</strong> page.
          </div>
        )}
        {(o.stages || []).map((s) => (
          <div key={s.stage} className="rb-stage">
            <span className="rb-stage-l">{stageLabels[s.stage] || s.stage}</span>
            <span className="rb-stage-bar" aria-hidden="true">
              <span style={{ width: `${o.owned ? Math.round((s.count / o.owned) * 100) : 0}%` }} />
            </span>
            <span className="rb-stage-n">{s.count}</span>
          </div>
        ))}
        {o.stages && o.stages.length > 0 && (
          <div className="rb-owed-foot" style={{ marginTop: 10 }}>
            Open stages only. Won, lost, skipped and bad-contact rows are finished with and are not
            counted here or in the claims above.
          </div>
        )}
      </div>
    </div>
  );
}

/** A short list of named firms with claimState's own sentence beside each. Eight
 * at most: this is a place to start, not the whole list, and the whole list is
 * what My leads is for. */
function NamedList({ title, rows, empty, unknown }) {
  return (
    <div className="card rb-named">
      <div className="label" style={{ marginBottom: 8 }}>{title}</div>
      {rows === null && <div className="rb-unknown">{unknown}</div>}
      {rows && rows.length === 0 && <div style={{ fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.6 }}>{empty}</div>}
      {(rows || []).slice(0, 8).map((r) => {
        const t = TONE_FOR[r.state] || CALM;
        return (
          <div key={r.id} className="rb-named-row">
            <span className="rb-named-l">{r.label}</span>
            <span className="rb-named-w" style={{ color: t.tone }}>{r.why}</span>
          </div>
        );
      })}
      {rows && rows.length > 8 && (
        <div className="rb-owed-foot" style={{ marginTop: 8 }}>
          {rows.length - 8} more like this. The full list is on <strong>My leads</strong>.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Everything the rep's Work page adds, in one component so WorkPage decides
 * WHETHER to draw it and this file decides WHAT it is.
 *
 * `work` is the object getMyWork() already returned, and the numbers are counted
 * from its rows rather than from a second read. Two reads of the same table are
 * two snapshots of it, and that is how the tiles at the top of a page end up
 * disagreeing with the panel underneath.
 */
export default function RepBrief({ member, work }) {
  const userId = member?.user_id || null;

  const overview = useMemo(() => buildRepOverview({
    userId,
    leads: work?.leadRows ?? null,
    contactable: work?.contactable ?? null,
    reminders: work?.reminderRows ?? null,
  }), [userId, work]);

  return (
    <>
      <RepAskBox userId={userId} sample={Boolean(work?.sample)} />
      <RepNumbers overview={overview} stageLabels={LEAD_STAGE_LABELS} />
    </>
  );
}
