/* POST /api/sales-score — run our own site score against a firm's website and
 * save it on the firm.
 *
 * WHY THIS ENDPOINT EXISTS AT ALL
 * The Rules of Engagement say: score the site before you pitch, and anything
 * at 90 or above is not a prospect. That rule has never once been followed.
 * Not because reps ignore it — because the sheet's own "Site Score" column
 * does not exist on a single tab, and running a score meant leaving the sheet,
 * opening AISyndicate.com, waiting, and typing a number back into a column
 * that was not there. A rule that costs four minutes per lead is a rule that
 * does not happen. This makes it a button.
 *
 * WHERE THE NUMBER COMES FROM
 * PLATFORM_SCORE_URL — our own platform's scan. Nothing here invents a score,
 * estimates one, or falls back to a guess when the platform is down. With no
 * key set the endpoint returns 503 naming the variable, and the chip on screen
 * keeps saying NO SCORE. A made-up score would be worse than none: a rep would
 * quote it to a prospect.
 *
 * THE SCORE IS SAVED ON THE FIRM, NOT THE PERSON
 * Four contacts at one dealership share one website, so they share one score.
 * Scoring per person would mean four scans, four bills, and four numbers that
 * drift apart.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";

const KEY_NAME = "PLATFORM_SCORE_URL";

export function scoreReady() {
  return Boolean(process.env[KEY_NAME]);
}

/** Pull a 0-100 out of whatever shape the platform answers with.
 *
 * Written forgiving on the field NAME and strict on the VALUE. A platform that
 * renames `score` to `overall` should cost us a rename, not a wrong number —
 * but anything that is not a real 0-100 is refused outright rather than
 * clamped. Clamping turns a broken response into a confident 0, which reads
 * as "the worst site we have ever seen" and is the most dangerous possible
 * wrong answer here: it is the one that sends a rep in hardest.
 */
export function readScore(payload) {
  const candidates = [
    payload?.score, payload?.overall, payload?.overall_score,
    payload?.result?.score, payload?.data?.score, payload?.ai_access_score,
  ];
  for (const c of candidates) {
    if (c === null || c === undefined || String(c).trim() === "") continue;
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return Math.round(n);
  }
  return null;
}

/** A bare hostname the scanner can take. Same cleaning as the lead intake, so
 * a firm's website means the same thing in both places. */
export function cleanDomain(v) {
  let s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split("/")[0].split("?")[0].replace(/\.$/, "");
  if (!s.includes(".") || /\s/.test(s)) return null;
  return s;
}

export default async function handler(req, res) {
  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "Waiting on the Supabase keys." });

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  /* Any member, including a sales rep. Scoring is the FIRST thing a rep should
   * do on a firm — making it admin-only would put the rule back behind a
   * request to somebody else, which is how it stopped happening in the sheet. */
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const body = await readJson(req);
  const companyId = String(body?.companyId || "").trim();
  if (!companyId) return res.status(400).json({ error: "Which firm? companyId is missing." });

  const { data: company, error: readErr } = await admin
    .from("admin_companies").select("id, name, domain, site_score").eq("id", companyId).maybeSingle();
  if (readErr) return res.status(500).json({ error: readErr.message });
  if (!company) return res.status(404).json({ error: "No firm with that id." });

  /* The firm's OWN website, never one posted in the request.
   *
   * Taking `body.domain` meant any member could post any URL and have that
   * score — and a "measured" timeline note — written against any firm. The
   * request may only name WHICH firm to score; what gets scored is whatever is
   * on file for it, which is also the thing a rep can see and correct. */
  const domain = cleanDomain(company.domain);
  if (!domain) {
    return res.status(400).json({ error: `${company.name} has no website on file, so there is nothing to score. Add one on the firm first.` });
  }

  if (!scoreReady()) {
    return res.status(503).json({
      error: `Scoring is not wired up yet — ${KEY_NAME} is not set in Vercel. Nothing was saved, and no score was invented. See SETUP.md.`,
      waitingOnKey: KEY_NAME,
    });
  }

  let payload;
  try {
    const r = await fetch(process.env[KEY_NAME], {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.PLATFORM_SCORE_KEY ? { "x-api-key": process.env.PLATFORM_SCORE_KEY } : {}),
      },
      body: JSON.stringify({ domain, source: "admin-console-sales" }),
      signal: AbortSignal.timeout(55000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.status(502).json({ error: `The scanner answered ${r.status}. ${text.slice(0, 160)}` });
    }
    payload = await r.json();
  } catch (err) {
    return res.status(502).json({
      error: err?.name === "TimeoutError"
        ? "The scan took longer than a minute and was given up on. Nothing was saved."
        : `Could not reach the scanner: ${err?.message || "unknown"}.`,
    });
  }

  const score = readScore(payload);
  if (score === null) {
    /* Explicitly NOT saved. A response we cannot read is not a score of zero,
     * and writing one would put "0 · WIDE GAP" on a firm nobody has measured. */
    return res.status(502).json({
      error: "The scanner replied but there was no readable score in it. Nothing was saved.",
    });
  }

  const now = new Date().toISOString();
  const { error: writeErr } = await admin.from("admin_companies").update({
    site_score: score,
    site_score_at: now,
    site_score_by: member.membership.user_id,
    site_score_note: score >= 90 ? "Scores 90 or above — already doing well, so not a prospect." : null,
  }).eq("id", companyId);
  if (writeErr) return res.status(500).json({ error: writeErr.message });

  /* Put it on the timeline of every contact at the firm. A score that only
   * lives in a column is a score nobody can date later; on the timeline it is
   * a dated event next to the calls, which is how a rep can tell "we measured
   * this" apart from "somebody said this".
   *
   * Three writes follow, and NONE of their results are discarded. The first
   * version read neither the select's error nor the two inserts' — so a failure
   * here left a firm scored 93 with no record of it and its contacts still in
   * the pool, while the endpoint answered 200 {ok:true}. Anything that goes
   * wrong after the score is committed is reported in `problems`, and the
   * status code says so. */
  const problems = [];
  const { data: people, error: peopleErr } = await admin
    .from("admin_leads").select("id").eq("company_id", companyId);
  if (peopleErr) problems.push(`could not read the contacts at this firm (${peopleErr.message}), so nothing was written to their timelines`);

  if (people?.length) {
    const { error: tlErr } = await admin.from("admin_lead_activity").insert(people.map((p) => ({
      lead_id: p.id,
      actor: member.membership.user_id,
      type: "score",
      outcome: score >= 90 ? "skip" : null,
      body: `Site score for ${domain}: ${score}/100, measured ${now.slice(0, 10)}.` +
        (score >= 90 ? " At 90 or above they are already doing well — not a prospect." : ""),
    })));
    if (tlErr) problems.push(`the score was saved but the timeline note failed (${tlErr.message})`);
  }

  /* At 90+ the rules say stop. Doing it here rather than asking the rep to
   * remember is the whole point of the gate — but only for contacts nobody has
   * started a conversation with. Marking somebody Skip mid-conversation would
   * throw away a live deal because of a number. */
  let skipped = 0;
  if (score >= 90) {
    const { data: parked, error: parkErr } = await admin.from("admin_leads")
      .update({ stage: "skip_90" })
      .eq("company_id", companyId)
      .in("stage", ["new", "researching"])
      .select("id");
    if (parkErr) problems.push(`the score was saved but the contacts were not moved to Skip (${parkErr.message})`);
    skipped = parked?.length || 0;
  }

  res.setHeader("Cache-Control", "private, no-store");
  /* 207 when the score landed but something after it did not. The score IS
   * saved either way — rolling it back would be worse — so this is honest
   * partial success rather than a failure, and it never claims to be clean. */
  return res.status(problems.length ? 207 : 200).json({
    ok: problems.length === 0, score, domain, measured_at: now, skipped,
    previous: company.site_score ?? null,
    problems,
  });
}
