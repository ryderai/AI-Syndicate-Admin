/* POST /api/sales-score — run our own scan against a firm's website, file the
 * result as a dated report on the firm, and save it on the firm's record.
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
 * WHERE THE NUMBERS COME FROM
 * PLATFORM_SCORE_URL — our own platform's scan. Nothing here invents a score,
 * estimates one, or falls back to a guess when the platform is down. With no
 * key set the endpoint returns 503 naming the variable, and the chip on screen
 * keeps saying NO SCORE. A made-up score would be worse than none: a rep would
 * quote it to a prospect.
 *
 * THREE NUMBERS NOW, NOT ONE — Aug 27 2026
 * AI Access, SEO, and how often the firm gets named when a buyer asks an AI a
 * question. Every one of them is INDEPENDENTLY NULLABLE and a null NEVER
 * becomes a zero. That is the whole discipline of this file. A firm shown as 0
 * for AI Access reads as the worst website anybody has ever measured, which is
 * the widest possible gap and therefore the hardest a rep goes in — it is the
 * most dangerous wrong number this feature could produce. So a half that did
 * not come back is stored as null, printed as a dash, and named in the
 * response; it is never rounded down to zero, clamped, estimated or filled in
 * from the other halves.
 *
 * WHERE THEY GO
 *   1. admin_company_reports — one row per scan, NEVER updated (0019). This is
 *      the record: "you were 65 in September and you are still 65" is the most
 *      useful line a rep has, and it only exists if last month's scan is still
 *      there.
 *   2. admin_companies.site_score — still written, from the AI Access score,
 *      because it is the column the 90+ gate, the chip and a lot of older code
 *      read.
 *   3. The timeline of every contact at the firm, as a dated line naming all
 *      three numbers.
 *
 * THE SCAN IS SAVED ON THE FIRM, NOT THE PERSON
 * Four contacts at one dealership share one website, so they share one scan.
 * Scanning per person would mean four scans, four bills, and four numbers that
 * drift apart.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { ROE } from "../lib/sales-rules.js";
import { teamDate } from "../lib/brain-context.js";

const KEY_NAME = "PLATFORM_SCORE_URL";

export function scoreReady() {
  return Boolean(process.env[KEY_NAME]);
}

/* ------------------------------------------------------------------ */
/* READING THE PLATFORM'S ANSWER                                       */
/* ------------------------------------------------------------------ */

/** One 0-100 out of a list of places it might be.
 *
 * Forgiving on the field NAME and strict on the VALUE. A platform that renames
 * `score` to `overall` should cost us a rename, not a wrong number — but
 * anything that is not a real 0-100 is refused outright rather than clamped.
 * Clamping turns a broken response into a confident 0, which is the one answer
 * that sends a rep in hardest at a firm nobody has measured.
 *
 * ONLY numbers and numeric strings are accepted, and that line matters more
 * than it looks. `Number([])` is 0 and `Number(true)` is 1, so without the
 * typeof guard a payload of `{ "score": [] }` scored a firm ZERO and a payload
 * of `{ "score": true }` scored it 1 — both of them invented, both of them
 * saved, both of them quotable.
 *
 * A decimal is rounded rather than refused: the column is an int, and 87.6
 * really was measured, so 88 is the same fact at the column's precision. That
 * is different from clamping, which makes up a fact that was not measured.
 */
function readOne(candidates) {
  for (const c of candidates) {
    if (typeof c !== "number" && typeof c !== "string") continue;
    if (String(c).trim() === "") continue;
    const n = Number(c);
    if (!Number.isFinite(n)) continue;
    if (n < 0 || n > 100) continue;
    return Math.round(n);
  }
  return null;
}

/** Kept exactly as it was, and still exported, because it is the shape the
 *  tests and any future caller already know. It reads the AI Access score. */
export function readScore(payload) {
  return readAiAccess(payload);
}

export function readAiAccess(payload) {
  const p = payload;
  return readOne([
    p?.ai_access_score, p?.aiAccessScore, p?.ai_access, p?.aiAccess,
    p?.ai_access?.score, p?.scores?.ai_access, p?.scores?.ai_access_score,
    p?.result?.ai_access_score, p?.data?.ai_access_score,
    /* The generic names come LAST. A payload carrying both `ai_access_score`
     * and `score` means the specific one, and a payload carrying only `score`
     * is the shape this endpoint shipped with. */
    p?.score, p?.overall, p?.overall_score,
    p?.result?.score, p?.data?.score,
  ]);
}

export function readSeo(payload) {
  const p = payload;
  return readOne([
    p?.seo_score, p?.seoScore, p?.seo?.score, p?.seo,
    p?.scores?.seo, p?.scores?.seo_score,
    p?.result?.seo_score, p?.data?.seo_score,
  ]);
}

/** A whole count of at least `min`, or null. Not capped at 100 — a sample of
 *  250 buyer questions is a bigger sample, not a broken one. */
function readWholeCount(candidates, min) {
  for (const c of candidates) {
    if (typeof c !== "number" && typeof c !== "string") continue;
    if (String(c).trim() === "") continue;
    const n = Number(c);
    if (!Number.isFinite(n)) continue;
    const w = Math.round(n);
    if (w < min) continue;
    return w;
  }
  return null;
}

/**
 * "Named in 2 of 10 buyer questions" — BOTH HALVES OR NEITHER.
 *
 * A hits count with no total is not a measurement. 2 out of 10 and 20% are the
 * same number and only one of them says how big the sample was, and 1 of 2
 * printed as 50% is a claim nobody made. So the pair is refused whole unless
 * all of it holds up: a total above zero, hits at zero or more, and hits no
 * bigger than the total. hits > total is not a near miss to be clamped — it
 * means we are reading the wrong two fields, and clamping it would print a
 * confident 10 of 10 on a firm that is invisible.
 *
 * `why` is filled in only when something WAS there and was refused, so the
 * response can say which half went missing instead of going quiet.
 */
export function readPromptSim(payload) {
  const p = payload;
  const hits = readWholeCount([
    p?.prompt_sim_hits, p?.promptSimHits, p?.prompt_sim?.hits,
    p?.prompt_simulation?.hits, p?.prompts?.hits,
    p?.scores?.prompt_sim_hits, p?.result?.prompt_sim_hits, p?.data?.prompt_sim_hits,
  ], 0);
  const total = readWholeCount([
    p?.prompt_sim_total, p?.promptSimTotal, p?.prompt_sim?.total,
    p?.prompt_simulation?.total, p?.prompts?.total,
    p?.scores?.prompt_sim_total, p?.result?.prompt_sim_total, p?.data?.prompt_sim_total,
  ], 1);

  if (hits === null && total === null) return { hits: null, total: null, why: null };
  if (hits === null) {
    return { hits: null, total: null, why: `the scan said ${total} buyer questions were asked but not how many named the firm, so that number was left out` };
  }
  if (total === null) {
    return { hits: null, total: null, why: `the scan said the firm was named ${hits} times but not out of how many questions, so that number was left out` };
  }
  if (hits > total) {
    return { hits: null, total: null, why: `the scan said the firm was named ${hits} times out of ${total} questions, which cannot be right, so that number was left out` };
  }
  return { hits, total, why: null };
}

/**
 * The things that are actually wrong, in words a rep can read out loud.
 *
 * Not an array → an empty list. Never a guess at what the shape meant, and
 * never a half-parsed object dressed up as one finding. A member that is not
 * an object is dropped and COUNTED, because "we found 4 things" printed over a
 * list of 3 is the kind of small lie a prospect notices, and silence about a
 * dropped row is how a broken field name survives for a month.
 *
 * An object with neither a title nor a detail is dropped too, for the same
 * reason: it draws as a blank bullet in a pitch, and a blank bullet reads as
 * carelessness.
 */
export function readFindings(payload) {
  const p = payload;
  const candidates = [p?.findings, p?.result?.findings, p?.data?.findings, p?.issues];
  let list = null;
  let sawSomething = false;
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    sawSomething = true;
    if (Array.isArray(c)) { list = c; break; }
  }
  if (list === null) {
    return {
      findings: [],
      dropped: 0,
      why: sawSomething ? "the scan's findings came back in a shape we do not understand, so none were kept" : null,
    };
  }

  const out = [];
  let dropped = 0;
  for (const f of list) {
    if (!f || typeof f !== "object" || Array.isArray(f)) { dropped++; continue; }
    const title = String(f.title ?? f.name ?? "").trim();
    const detail = String(f.detail ?? f.description ?? "").trim();
    const severity = String(f.severity ?? f.level ?? "").trim();
    if (!title && !detail) { dropped++; continue; }
    out.push({ title, detail, severity });
  }
  return {
    findings: out,
    dropped,
    why: dropped ? `${dropped} of the scan's ${list.length} findings could not be read and were left out` : null,
  };
}

/**
 * The whole answer, read once.
 *
 * `readable` is the question the endpoint hangs on: is there a MEASUREMENT in
 * here at all? Findings on their own do not count. This is the score endpoint,
 * its rule since day one has been "no score, nothing saved", and a report row
 * carrying three nulls and a list of complaints is a row that prints as a
 * measurement on screen without being one.
 */
export function readReport(payload) {
  const aiAccess = readAiAccess(payload);
  const seo = readSeo(payload);
  const sim = readPromptSim(payload);
  const found = readFindings(payload);

  const missing = [];
  if (aiAccess === null) missing.push("AI Access");
  if (seo === null) missing.push("SEO");
  if (sim.hits === null) missing.push("buyer questions");

  const notes = [];
  if (sim.why) notes.push(sim.why);
  if (found.why) notes.push(found.why);

  return {
    aiAccess, seo,
    simHits: sim.hits, simTotal: sim.total,
    findings: found.findings,
    droppedFindings: found.dropped,
    missing, notes,
    readable: aiAccess !== null || seo !== null || sim.hits !== null,
  };
}

/**
 * The one number that goes in `admin_companies.site_score`.
 *
 * AI Access first, because that is the number that column has always meant and
 * the number the 90+ gate was written against. SEO second, because a firm with
 * one measured number is better represented by that number than by nothing.
 * Both null → we write NOTHING: nulling a column an earlier scan measured
 * would throw away a real number because today's scan came back short, and the
 * chip would drop from "72" to "NO SCORE" with no scan having said so.
 */
export function effectiveScore({ aiAccess = null, seo = null } = {}) {
  if (aiAccess !== null) return { score: aiAccess, from: "AI Access" };
  if (seo !== null) return { score: seo, from: "SEO" };
  return { score: null, from: null };
}

/**
 * 'baseline' for the first scan of a firm, 'rescan' after that.
 *
 * `rescan` IS THE DEFAULT WHEN THE READ FAILED, and that direction is on
 * purpose: calling a re-scan the baseline relabels history — it makes today
 * look like the first time we ever measured this firm, which is exactly the
 * line a rep would use ("here is where you started"). Calling a genuine first
 * scan a re-scan is a wrong label on one row and nothing else.
 */
export function reportKind({ found = false, failed = false } = {}) {
  if (failed) return "rescan";
  return found ? "rescan" : "baseline";
}

/** Does this lead really belong to this firm? Anything short of a definite yes
 *  is a no — see the note where it is used. */
export function leadBelongs(lead, companyId) {
  if (!lead || !companyId) return false;
  return String(lead.company_id || "") === String(companyId);
}

/**
 * Does this look like one of our ids at all?
 *
 * Every id in this database is a uuid, and handing Postgres anything else comes
 * back as `invalid input syntax for type uuid: "co1"`. That message went
 * straight to the screen as a 500, which reads as "the console is broken" when
 * what actually happened is that a caller sent a junk id. Checked here so the
 * answer is a 400 in words a person can read.
 */
export function looksLikeId(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v ?? "").trim());
}

/** A number, or a dash. Never a zero standing in for "we did not measure it". */
function orDash(n, suffix = "/100") {
  return n === null || n === undefined ? "—" : `${n}${suffix}`;
}

/**
 * The line that lands on every contact's timeline.
 *
 * All three numbers and the day they were read, because a number without the
 * day it was read is not a measurement (§42 PART 2 rule 2) and a rep reading
 * the timeline in November needs to know whether "AI Access 41" is from August.
 * A half that did not come back prints as a dash. Never as a zero.
 */
export function scoreLine({
  domain, aiAccess = null, seo = null, simHits = null, simTotal = null,
  measuredOn, findingCount = 0, skip = false,
}) {
  const sim = simHits !== null && simTotal !== null
    ? `named in ${simHits} of ${simTotal} buyer questions`
    : "buyer questions not measured (—)";
  let s = `Website scan for ${domain}, measured ${measuredOn}: `
    + `AI Access ${orDash(aiAccess)}, SEO ${orDash(seo)}, ${sim}.`;
  if (findingCount) s += ` ${findingCount} thing${findingCount === 1 ? "" : "s"} to fix listed.`;
  if (skip) s += ` At ${ROE.SKIP_SCORE_AT_OR_ABOVE} or above they are already doing well — not a prospect.`;
  return s;
}

/**
 * WHICH CONTACTS THIS PERSON MAY PARK AS SKIP.
 *
 * ---- THE ROW LOCK, AND WHY IT IS NOT THE SAME FOR BOTH SIDE EFFECTS ----
 *
 * `getAdminSupabase()` runs on the service key and ignores row-level security
 * completely, so migration 0020's rule — a rep may work a lead that is theirs
 * or unclaimed, and nobody else's — does not apply to anything in this file
 * unless it is written here in JavaScript. 0020's own header says so: this is
 * copy 2 of 3 of that rule, and all three have to agree.
 *
 * SCANNING ITSELF IS OPEN TO EVERY MEMBER. Unchanged, and deliberately so. A
 * scan measures a FIRM, four contacts share it, and the Rules of Engagement say
 * scan before you pitch — putting it behind an admin would put the rule back
 * behind a request to somebody else, which is exactly how it stopped happening
 * in the spreadsheet.
 *
 * But the two side effects DO write leads, and they are not the same kind of
 * write, so they do not get the same answer:
 *
 *   1. PARKING A FIRM'S CONTACTS AS SKIP IS SCOPED (this function). Moving
 *      somebody's lead to skip_90 is a decision about their lead: it takes a
 *      row out of their pipeline, and if they were mid-conversation it takes a
 *      live deal. A rep may park their own and unclaimed rows; an owner or
 *      admin may park anything. Rows held by another rep are LEFT ALONE and
 *      counted in `problems` by name, so the rep can see what did not happen
 *      and an owner can finish it. Silently doing it would be a rep reaching
 *      into another rep's pipeline through a button that says "Score".
 *
 *   2. THE TIMELINE LINE IS NOT SCOPED. It goes on every contact at the firm,
 *      whoever holds them. THE TRADE-OFF, STATED: this is wider than the
 *      browser is allowed to be — 0020 § 2 stops a rep inserting activity on
 *      another rep's lead, and the service key is what lets this through. It is
 *      deliberate, for one reason: the row is a dated fact about the firm's
 *      WEBSITE, not a claim about anybody's conversation, the rows are
 *      append-only, and `actor` is the real person who pressed the button. The
 *      cost of withholding it is worse than the cost of writing it: two reps at
 *      one dealership would hold two different pictures of the same website,
 *      which is the exact failure the one-scan-per-firm design exists to
 *      prevent. If that call is ever reversed, the timeline write below and
 *      0020 § 2 are the two places to change together.
 */
export function parkableLeadIds(leads, { role = null, userId = null } = {}) {
  const rows = Array.isArray(leads) ? leads : [];
  /* "Not sales" rather than "owner or admin", the same way canEditLead() in
   * src/lib/salesSheet.js is written: a role nobody has taught this file about
   * must not silently lose the ability to do its job. */
  if (role !== "sales") return { allowed: rows.map((l) => l.id), blocked: [] };
  /* Theirs or nobody's — the same two cases as canEditLead() and as 0020's
   * USING clause. A rep with no id at all gets the unclaimed rows only, rather
   * than everything: `undefined === undefined` matching every unowned row is
   * the kind of accident that turns a lock into a doorway. */
  const mine = (l) => Boolean(userId) && l.owner_id === userId;
  return {
    allowed: rows.filter((l) => !l.owner_id || mine(l)).map((l) => l.id),
    blocked: rows.filter((l) => l.owner_id && !mine(l)).map((l) => l.id),
  };
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

/* ------------------------------------------------------------------ */
/* THE ENDPOINT                                                        */
/* ------------------------------------------------------------------ */

export default async function handler(req, res) {
  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "Waiting on the Supabase keys." });

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  /* Any member, including a sales rep. Scoring is the FIRST thing a rep should
   * do on a firm — making it admin-only would put the rule back behind a
   * request to somebody else, which is how it stopped happening in the sheet.
   * The two writes that touch LEADS are scoped further down; see the long note
   * on parkableLeadIds for which one is scoped, which one is not, and why. */
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  const me = member.membership.user_id;
  const myRole = member.membership.role;

  const body = await readJson(req);
  const companyId = String(body?.companyId || "").trim();
  if (!companyId) return res.status(400).json({ error: "Which firm? companyId is missing." });
  if (!looksLikeId(companyId)) return res.status(400).json({ error: `"${companyId}" is not a firm id.` });

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

  /* ---- WHICH CONTACT WAS ON SCREEN, CHECKED BEFORE WE SPEND A SCAN ----
   *
   * `leadId` only says which contact the person was looking at when they
   * pressed the button, but it is stored on the measurement, so a wrong one
   * hangs our reading of one firm's website off a different person's record.
   * VERIFIED AGAINST THE FIRM, not trusted: the request already only gets to
   * name the firm, and this is the same rule for the second id it may name.
   *
   * Checked HERE, before the platform is called, because a request with a bad
   * id is a bug in the caller and not a partial failure worth a scan. */
  const leadIdWanted = String(body?.leadId || "").trim();
  let leadId = null;
  if (leadIdWanted) {
    if (!looksLikeId(leadIdWanted)) {
      return res.status(400).json({ error: `"${leadIdWanted}" is not a contact id, so the scan was not run.` });
    }
    const { data: askedLead, error: leadErr } = await admin
      .from("admin_leads").select("id, company_id").eq("id", leadIdWanted).maybeSingle();
    if (leadErr) return res.status(500).json({ error: leadErr.message });
    if (!leadBelongs(askedLead, companyId)) {
      return res.status(400).json({
        error: `That contact is not at ${company.name}, so the scan was not run. A measurement filed against the wrong person's record is worse than no measurement.`,
      });
    }
    leadId = askedLead.id;
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

  const read = readReport(payload);
  if (!read.readable) {
    /* Explicitly NOT saved, and nothing is clamped, estimated or filled in. A
     * response we cannot read is not a score of zero, and writing one would put
     * "0 · WIDE GAP" on a firm nobody has measured.
     *
     * Findings alone do not make a report either. This is the scan of record and
     * its rule has always been "no number, nothing saved" — a row holding three
     * nulls and a list of complaints draws on screen as a measurement without
     * being one. The count is said out loud so nobody has to guess whether the
     * scanner replied with anything at all. */
    return res.status(502).json({
      error: "The scanner replied but there was no readable score in it — no AI Access, no SEO, no buyer questions. Nothing was saved."
        + (read.findings.length ? ` It did list ${read.findings.length} findings, which are not kept without a number to go with them.` : ""),
      problems: read.notes,
    });
  }

  const now = new Date().toISOString();
  /* THE DAY IT WAS READ, IN THE TEAM'S CALENDAR — not UTC.
   * `now.slice(0,10)` was here before and it is wrong after 7pm Central: an ISO
   * string is UTC, so a scan run on the evening of the 26th printed "measured
   * 2026-08-27" on the timeline — tomorrow, to the rep reading it. This repo has
   * shipped that same bug three times. The stored `measured_at` stays the full
   * UTC timestamp; only the words a person reads are in their own calendar. */
  const measuredOn = teamDate(Date.parse(now));
  const problems = [...read.notes];
  const eff = effectiveScore(read);
  const skip = eff.score !== null && eff.score >= ROE.SKIP_SCORE_AT_OR_ABOVE;

  /* ---- IS THIS THE FIRM'S FIRST SCAN ----
   * One row is enough to answer it; we never read the reports themselves here.
   * A failed read defaults to 'rescan' — see reportKind for why that direction
   * is the safe one — and says so, rather than guessing quietly. */
  let kind = "rescan";
  const { data: earlier, error: earlierErr } = await admin
    .from("admin_company_reports").select("id").eq("company_id", companyId).limit(1);
  if (earlierErr) {
    problems.push(`could not check whether this firm had been scanned before (${earlierErr.message}), so this scan is filed as a re-scan`);
    kind = reportKind({ failed: true });
  } else {
    kind = reportKind({ found: Boolean(earlier?.length) });
  }

  /* ---- THE REPORT ROW: THE RECORD OF THIS SCAN ----
   *
   * Inserted, never updated (0019 grants no UPDATE at all): a measurement that
   * can be edited after a rep has quoted it is not a measurement, and last
   * month's number is the most useful sales line there is.
   *
   * `raw` is exactly what the platform sent, untouched. The field names the
   * readers above look for are a guess at a contract nobody has written down;
   * the day the real shape is known, this column decides whether the scans we
   * already ran can be re-read or have to be re-run.
   *
   * A FAILURE HERE DOES NOT STOP THE REST. If migration 0019 has not been run
   * yet, this insert is the only thing that fails, and the endpoint must still
   * do what it did before 0019 existed — write site_score and the timeline —
   * loudly, rather than turning a working button into a 500. */
  let reportId = null;
  const { data: reportRow, error: reportErr } = await admin
    .from("admin_company_reports").insert({
      company_id: companyId,
      lead_id: leadId,
      kind,
      /* Every one of these four is null when the scan did not return it, and a
       * null is never turned into a zero on the way in. */
      ai_access_score: read.aiAccess,
      seo_score: read.seo,
      prompt_sim_hits: read.simHits,
      prompt_sim_total: read.simTotal,
      findings: read.findings,
      raw: payload,
      /* The four halves of a measurement (§42 PART 2 rule 2): the number, the
       * thing it was measured against, the day it was read, and who read it.
       * `domain` is stored on the row rather than read off the firm later,
       * because a firm's website can be corrected afterwards and the old
       * measurement would then silently re-attach itself to a different site. */
      domain,
      measured_at: now,
      measured_by: me,
    }).select("id").maybeSingle();
  if (reportErr) {
    problems.push(`the scan ran but the report could not be filed (${reportErr.message}) — if migration 0019 has not been run yet, that is why`);
  } else {
    reportId = reportRow?.id || null;
  }

  /* ---- THE FIRM'S OWN COLUMN ----
   * Still written, because `site_score` is what the 90+ gate, the chip and a
   * lot of older code read. From AI Access, falling back to SEO.
   *
   * When BOTH came back null we leave the column ALONE. Writing null would
   * delete a number an earlier scan really did measure, and the chip would drop
   * from "72" to "NO SCORE" without any scan having said so. */
  if (eff.score === null) {
    problems.push("no AI Access or SEO score came back, so the firm's score column was left exactly as it was rather than being emptied");
  } else {
    const { error: writeErr } = await admin.from("admin_companies").update({
      site_score: eff.score,
      site_score_at: now,
      site_score_by: me,
      site_score_note: skip ? `Scores ${eff.score} (${eff.from}). At ${ROE.SKIP_SCORE_AT_OR_ABOVE} or above they are already doing well, so not a prospect.` : null,
    }).eq("id", companyId);
    /* Not a 500 any more. The report row above is the record of the scan, and
     * throwing the whole request away because a mirror column would not take
     * the number would lose a measurement we have already paid for. */
    if (writeErr) problems.push(`the scan was filed but the firm's score column was not updated (${writeErr.message})`);
  }

  /* ---- THE TIMELINE ----
   * Put it on the timeline of every contact at the firm. A score that only
   * lives in a column is a score nobody can date later; on the timeline it is a
   * dated event next to the calls, which is how a rep can tell "we measured
   * this" apart from "somebody said this".
   *
   * NOT scoped to the person's own leads, on purpose — the long note on
   * parkableLeadIds sets out the trade-off in full.
   *
   * None of the results below are discarded. The first version read neither the
   * select's error nor the inserts' — so a failure here left a firm scored 93
   * with no record of it and its contacts still in the pool, while the endpoint
   * answered 200 {ok:true}. Anything that goes wrong after the scan is filed is
   * reported in `problems`, and the status code says so. */
  const { data: people, error: peopleErr } = await admin
    .from("admin_leads").select("id, owner_id").eq("company_id", companyId);
  if (peopleErr) problems.push(`could not read the contacts at this firm (${peopleErr.message}), so nothing was written to their timelines and nobody was moved to Skip`);

  const line = scoreLine({
    domain,
    aiAccess: read.aiAccess, seo: read.seo,
    simHits: read.simHits, simTotal: read.simTotal,
    measuredOn, findingCount: read.findings.length, skip,
  });

  if (people?.length) {
    const { error: tlErr } = await admin.from("admin_lead_activity").insert(people.map((p) => ({
      lead_id: p.id,
      actor: me,
      type: "score",
      outcome: skip ? "skip" : null,
      body: line,
    })));
    if (tlErr) problems.push(`the scan was filed but the timeline note failed (${tlErr.message})`);
  }

  /* ---- THE 90+ GATE ----
   * At 90+ the rules say stop, and doing it here rather than asking the rep to
   * remember is the whole point of the gate. Two limits on it:
   *
   *   1. Only contacts NOBODY HAS STARTED A CONVERSATION WITH. Marking somebody
   *      Skip mid-conversation would throw away a live deal because of a number.
   *   2. Only contacts THIS PERSON MAY WORK. See parkableLeadIds.
   *
   * It reads `eff.score`, the same number that went into the column, so the
   * chip on screen and the pool can never disagree — a firm showing 93 with its
   * contacts still in the pool is the bug this ordering prevents. */
  let skipped = 0;
  if (skip && people?.length) {
    const { allowed, blocked } = parkableLeadIds(people, { role: myRole, userId: me });
    if (allowed.length) {
      const { data: parked, error: parkErr } = await admin.from("admin_leads")
        .update({ stage: "skip_90" })
        .in("id", allowed)
        .in("stage", ["new", "researching"])
        .select("id");
      if (parkErr) problems.push(`the scan was filed but the contacts were not moved to Skip (${parkErr.message})`);
      skipped = parked?.length || 0;
    }
    if (blocked.length) {
      problems.push(`${blocked.length} contact${blocked.length === 1 ? " is" : "s are"} held by another rep, so ${blocked.length === 1 ? "it was" : "they were"} left alone. Scoring ${eff.score} says nobody should chase this firm — ask an owner to move ${blocked.length === 1 ? "it" : "them"}.`);
    }
  }

  res.setHeader("Cache-Control", "private, no-store");
  /* 207 when the scan landed but something after it did not. The measurement IS
   * filed either way — rolling it back would be worse — so this is honest
   * partial success rather than a failure, and it never claims to be clean. */
  return res.status(problems.length ? 207 : 200).json({
    ok: problems.length === 0,
    /* `score` stays the top-level name the two pages already read, and it is
     * the number that went into the firm's column. It CAN be null now — a scan
     * that only came back with buyer questions has no 0-100 score — and
     * `scoreFrom` says which of the two it is. */
    score: eff.score,
    scoreFrom: eff.from,
    aiAccess: read.aiAccess,
    seo: read.seo,
    simHits: read.simHits,
    simTotal: read.simTotal,
    findings: read.findings.length,
    droppedFindings: read.droppedFindings,
    /* Which halves did not come back, said out loud. A response that reports
     * only what it got leaves the reader to work out what is missing from an
     * absence, which nobody does. */
    missing: read.missing,
    kind, reportId, domain, measured_at: now, skipped,
    previous: company.site_score ?? null,
    problems,
  });
}
