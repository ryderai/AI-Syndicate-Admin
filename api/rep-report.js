/* POST /api/rep-report — the answer box on a sales rep's Work page.
 *
 * Aug 26 2026. CJ is giving the reps their own logins, so each rep needs a box
 * they can type into: "give me a rundown of my week", "which of my leads is
 * about to go cold and what do I say". This answers it from everything in the
 * system a rep is allowed to see, and nothing else.
 *
 * Auth: any active console member. Body: { instruction }
 *
 * WHY THIS IS ITS OWN ENDPOINT AND NOT A FLAG ON /api/console-report.
 * That one is closed to reps — `requireMember(req, ["owner","admin"])` — and its
 * comment on line ~60 says why: one of those rows can summarise every client,
 * lead and invoice in one place. The SAVED ROWS were written from an
 * owner-scoped snapshot, so a rep who could read one would walk straight around
 * the role scoping in lib/brain-context.js. Opening it up would undo the
 * scoping. So: separate endpoint, separate table, and a rep never reads a row
 * from admin_console_reports.
 *
 * HOW IT STAYS HONEST — the same shape as /api/console-report, because that one
 * was already right and this is the same job on a narrower slice:
 *   1. Every fact is read HERE, server-side, through loadSystemContext() — the
 *      same snapshot the assistant and the notes engine use, scoped by the same
 *      rules in the same one place.
 *   2. That snapshot, rendered, is the only thing the AI is shown. It never
 *      touches the database and it has NO TOOLS. It is a question, not an
 *      errand.
 *   3. The counted figures are SAVED next to the words, so an answer can be
 *      audited against the numbers it was written from months later.
 *   4. With no ANTHROPIC_API_KEY it still answers, with the counted version.
 *   5. A draft containing a number that is not in the facts, wording that
 *      promises a result — including promising a lead will close — a website
 *      score we never measured, or a line that gives a person a job is THROWN
 *      AWAY, not edited. The counted version ships and the reason is saved on
 *      the row. There is ONE path.
 *
 * THE ROLE AND THE USER ID COME FROM THE BEARER TOKEN, NEVER FROM THE BODY. If
 * a caller could pass a role, a rep could ask for the owner's snapshot. Nothing
 * in the request body is read except the instruction.
 *
 * WHY IT DOES NOT USE lib/ai.js: `draft()` caps input at 24,000 characters. A
 * rep-scoped snapshot is smaller than the console-wide one but an imported lead
 * sheet still runs past that, and truncating it would mean writing from part of
 * the story with no way for a reader to tell. So the context goes in the system
 * prompt through lib/ai-agent.js `converse()`, which has no input cap.
 *
 * WHAT IS NEVER IN HERE: the vault. loadSystemContext has no vault read in it at
 * all, so no label, username or secret can reach a saved answer that a rep
 * forwards. Also absent by scope: clients, tasks, email and tickets.
 *
 * MONEY, PRECISELY. There is no invoice, no payment and no expense in a rep's
 * scope, so nothing here can say what a deal was worth or what has come in. One
 * figure of money DOES reach a rep: proposals are in scope and
 * lib/brain-context.js prints each one's dollar amount, so the amount written on
 * a proposal is a fact in the sheet. Said loosely as "every figure of money"
 * until Aug 26 2026, which was simply untrue — lib/rep-report.js has always got
 * it right ("beyond the amount written on a proposal") and this comment now
 * agrees with it.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { converse, isAiConfigured } from "../lib/ai-agent.js";
import { loadSystemContext, teamDate } from "../lib/brain-context.js";
import {
  assembleRepFacts, buildRepInstruction, parseRepReport, checkRepReport, repFactsText,
  deterministicRepReport, summaryFrom, cleanInstruction, wordsForRep,
  tokensForWords, MAX_INSTRUCTION_CHARS,
} from "../lib/rep-report.js";

const COST = { input: 3.0, output: 15.0 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }
  res.setHeader("Cache-Control", "private, no-store");

  /* Any active member, and the role that comes back is the one on their
   * admin_users row — read from the token, never from the request. */
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ ok: false, error: "Not authorized." });

  const body = await readJson(req);
  const instruction = cleanInstruction(body?.instruction);
  if (!instruction) {
    return res.status(400).json({ ok: false, error: "Type what you want to know first." });
  }

  const admin = getAdminSupabase();
  if (!admin) return res.status(500).json({ ok: false, error: "The server is not connected to the database." });

  const role = member.membership?.role || "sales";
  const userId = member.membership?.user_id || null;
  const nowMs = Date.now();
  /* THE TEAM'S DAY, NOT UTC'S. Aug 26 2026: this was
   * `new Date(nowMs).toISOString().slice(0, 10)`, which rolls over at 7pm
   * Central. Between then and midnight the model was told "Today is
   * <tomorrow>" and the counted title carried tomorrow's date, so a rep asking
   * at 9pm read an answer dated a day that had not started. teamDate() is the
   * one place that maths lives — same function renderContext dates a score
   * with, so the prompt and the records cannot disagree about what day it is. */
  const todayIso = teamDate(nowMs);

  /* ---- read what a rep may see ---- */
  /* THE SNAPSHOT IS PINNED TO THE REP SCOPE FOR EVERYBODY, the owner included.
   *
   * This is a narrowing, never a widening: a rep's token cannot make it wider,
   * because "sales" is already the narrowest scope SCOPE_BY_ROLE has and
   * scopeFor() falls back to it for anything unknown. Two reasons to pin it:
   * this box exists to answer a rep's question from a rep's slice, and CJ
   * looking at the rep page should see exactly what a rep would see rather than
   * a wider answer that looks identical. An owner who wants the console-wide
   * answer has /api/console-report, which is where that belongs.
   *
   * userId is the real person from the token, so the rep-only reminder filter
   * inside loadSystemContext lines up with the person asking. */
  let snap;
  try {
    snap = await loadSystemContext(admin, { role: "sales", userId });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Could not read your sales records: ${err?.message || "unknown error"}` });
  }

  const facts = assembleRepFacts(snap, { nowMs });
  /* The rendered snapshot plus the house rules its numbers are judged by. The
   * SAME string goes to the model and to the gate — see repFactsText. */
  const factsText = repFactsText(snap, nowMs);

  let report = null;
  let countedOnly = true;
  let gateReason = null;
  let usage = null;

  if (isAiConfigured()) {
    try {
      const words = wordsForRep(instruction);
      const system = [
        buildRepInstruction({ userInstruction: instruction, todayIso, words }),
        factsText,
      ].join("\n\n---\n\nSALES RECORDS\n\n");

      /* No tools. The assistant is the thing that acts; a generator that could
       * write rows while writing about them would be impossible to audit. */
      const result = await converse({
        system,
        messages: [{ role: "user", content: "Answer it now, in the shape you were given." }],
        tools: [],
        maxTokens: tokensForWords(words),
      });

      const parsed = parseRepReport(result.text);
      const teamNames = (snap.team || []).map((t) => t.full_name).filter(Boolean);
      const verdict = parsed
        ? checkRepReport(parsed, factsText, { teamNames })
        : { ok: false, why: "it did not come back in the shape we asked for" };

      /* cappedOut means the model stopped part way. Half an answer reads
       * exactly like a whole one, so it does not ship as written. */
      if (parsed && verdict.ok && !result.cappedOut) {
        /* The summary is copied out of the body, not written separately, so it
         * can never contain a claim the body does not — which is why checking
         * the body above has already checked it. */
        report = { ...parsed, summary: summaryFrom(parsed.body) };
        countedOnly = false;
        usage = result.usage;
        const cost = (usage.input_tokens * COST.input + usage.output_tokens * COST.output) / 1e6;
        /* Best-effort. A missing usage table must not cost a rep their answer. */
        await admin.from("admin_usage_events").insert({
          source: "admin", model: "claude-sonnet-4-6",
          input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
          cost_usd: cost,
          meta: { kind: "rep_report", user: member.membership?.email, role },
        }).then(() => {}, () => {});
      } else {
        gateReason = result.cappedOut
          ? "the answer stopped part way through, so it would have been half a story"
          : verdict.why;
      }
    } catch (err) {
      /* A 503 from the model is not a server error here — the counted version
       * still answers the question, so say what happened and ship it. */
      gateReason = `the AI did not answer: ${err?.message || "unknown error"}`;
    }
  } else {
    gateReason = "there is no ANTHROPIC_API_KEY set, so nothing could be written";
  }

  if (!report) report = deterministicRepReport(facts, { todayIso, why: gateReason });

  const generatedAt = new Date(nowMs).toISOString();

  /* ---- save it ---- */
  /* owner_id is the person asking, taken from the token. It is what the table's
   * row-level security matches on, so a rep can only ever read their own rows. */
  const row = {
    owner_id: userId,
    role,
    instruction,
    title: report.title || "Your sales work",
    summary: report.summary || "",
    body: report.body || "",
    counted_only: countedOnly,
    gate_reason: gateReason,
    facts: {
      counts: facts.counts,
      cannotAnswer: facts.cannotAnswer,
      unreadable: facts.unreadable,
      takenAt: facts.takenAt,
    },
    created_by_email: member.membership?.email || null,
  };

  /* EIGHT MIGRATIONS IN THIS REPO ARE UNRUN AND NOTHING IS DEPLOYED, so this
   * table may not exist yet. A rep asking a question must never see an error
   * because of that: the words are worth more than the filing. The reason is
   * logged for whoever runs the migration. */
  let saved = false;
  let id = null;
  const { data: savedRow, error: saveErr } = await admin
    .from("admin_rep_reports").insert(row).select().maybeSingle();
  if (saveErr) {
    console.error("[rep-report] could not save the row:", saveErr.message);
  } else {
    saved = true;
    id = savedRow?.id || null;
  }

  return res.status(200).json({
    ok: true,
    report: {
      id,
      instruction,
      summary: report.summary || "",
      body: report.body || "",
      facts: row.facts,
      counted_only: countedOnly,
      gate_reason: gateReason,
      saved,
      generated_at: savedRow?.created_at || generatedAt,
    },
  });
}

/* Exported so a future caller does not re-derive the cap and get a different
 * number from the one the box enforces. */
export { MAX_INSTRUCTION_CHARS };
