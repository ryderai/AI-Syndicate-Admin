/* POST /api/console-report — the Overview generator.
 *
 * You type what you want. This reads everything the console holds and writes it.
 *
 * Auth: owner/admin. Body: { instruction, mode, preset }
 *
 * HOW IT STAYS HONEST — the same shape as /api/client-report, because that one
 * was already right and a console-wide answer is a bigger version of the same
 * job:
 *   1. Every fact is read HERE, server-side, through loadSystemContext() — the
 *      same snapshot the assistant and the notes engine use, role-scoped by the
 *      same rules.
 *   2. That snapshot, rendered, is the only thing the AI is shown. It never
 *      touches the database and it has no tools.
 *   3. The counted figures are SAVED next to the words, so an answer can be
 *      audited against the numbers it was written from, months later.
 *   4. With no ANTHROPIC_API_KEY it still answers, with the counted version.
 *   5. A draft containing a number that is not in the facts, wording that
 *      promises a result, or a line that gives a person a job is THROWN AWAY —
 *      not edited. The counted version ships and the reason is saved on the row.
 *      There is ONE path. The "free draft" mode that skipped this is gone: a
 *      badge saying "numbers unchecked" is not a control, because the person who
 *      forwards it is not the person who read the badge.
 *
 *   6. Notes a reader left on earlier answers are read here and put in the
 *      instruction ABOVE the rules, so "too long, lead with the money" changes
 *      the next answer. They cannot loosen the checks — the rules block says so
 *      out loud and it comes last.
 *
 * WHY IT DOES NOT USE lib/ai.js: `draft()` caps input at 24,000 characters and
 * a full console snapshot runs to 60,000+. Truncating it would mean writing
 * from part of the story with no way for a reader to tell. So the context goes
 * in the system prompt through lib/ai-agent.js `converse()`, which has no input
 * cap, with NO TOOLS — one question, one answer, nothing written.
 *
 * WHAT IS NEVER IN HERE: the vault. loadSystemContext does not read it, so no
 * label, username or secret can reach a saved report that gets forwarded.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { converse, isAiConfigured } from "../lib/ai-agent.js";
import { loadSystemContext, renderContext, teamDate } from "../lib/brain-context.js";
import {
  assembleConsoleFacts, buildConsoleInstruction, parseConsoleReport, checkConsoleReport,
  deterministicConsoleReport, modeOf, wordsFor, tokensForWords, orderFeedback,
  MAX_INSTRUCTION_CHARS, MAX_FEEDBACK_NOTES,
} from "../lib/console-report.js";

const COST = { input: 3.0, output: 15.0 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  res.setHeader("Cache-Control", "private, no-store");

  /* Owner/admin only, and that is not just about who may press the button. One
   * of these rows can summarise every client, lead and invoice in one place, so
   * a rep reading one would walk straight around the role scoping. */
  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const body = await readJson(req);
  const instruction = String(body?.instruction || "").trim().slice(0, MAX_INSTRUCTION_CHARS);
  /* Always "records". The body may still carry a mode — an older browser tab,
   * a hand-made request — and it is ignored rather than trusted. */
  const mode = modeOf();
  const presetId = String(body?.preset || "").trim() || null;
  if (!instruction) {
    return res.status(400).json({ error: "Say what you want written." });
  }

  const admin = getAdminSupabase();
  const role = member.membership?.role || "admin";
  const nowMs = Date.now();
  /* The TEAM's day, not UTC's. Aug 26 2026: this line was
   * `new Date(nowMs).toISOString().slice(0, 10)`, so between 7pm and midnight
   * in Chicago the model was told "Today is <tomorrow>" and the report's title
   * carried tomorrow's date. Found while fixing the same copied line in
   * api/rep-report.js. Day maths in this repo goes through the team clock —
   * three date bugs shipped in one day from raw local-time arithmetic. */
  const todayIso = teamDate(nowMs);

  /* ---- read everything ---- */
  let snap;
  try {
    snap = await loadSystemContext(admin, { role, userId: member.membership?.user_id || null });
  } catch (err) {
    return res.status(500).json({ error: `Could not read the console: ${err?.message || "unknown error"}` });
  }

  const facts = assembleConsoleFacts(snap, { nowMs });
  const factsText = renderContext(snap, nowMs);

  /* What the reader has asked for differently before. Read a few more than are
   * used, because the ones without a note are dropped on the way through
   * orderFeedback and would otherwise eat the budget. */
  let feedback = [];
  {
    const fb = await admin
      .from("admin_console_feedback")
      .select("rating, note, created_at")
      .not("note", "is", null)
      .order("created_at", { ascending: false })
      .limit(MAX_FEEDBACK_NOTES * 4);
    /* A failed feedback read must not stop an answer. It is a style hint, not a
     * fact — losing it means a slightly worse answer, not a wrong one. */
    if (!fb.error) feedback = orderFeedback(fb.data || []).slice(0, MAX_FEEDBACK_NOTES);
  }

  let report = null;
  let source = "counted";
  let rejected = null;
  let usage = null;
  let model = null;

  if (isAiConfigured()) {
    try {
      const words = wordsFor(instruction, presetId);
      const system = [
        buildConsoleInstruction({ userInstruction: instruction, presetId, todayIso, words, feedback }),
        factsText,
      ].join("\n\n---\n\nCONSOLE RECORDS\n\n");

      /* No tools. This is a question, not an errand — the assistant is the
       * thing that acts, and a generator that could write rows while writing
       * about them would be impossible to audit. */
      const result = await converse({
        system,
        messages: [{ role: "user", content: "Write it now, in the shape you were given." }],
        tools: [],
        maxTokens: tokensForWords(words),
      });

      const parsed = parseConsoleReport(result.text);
      const teamNames = (snap.team || []).map((t) => t.full_name).filter(Boolean);
      const verdict = parsed
        ? checkConsoleReport(parsed, factsText, { teamNames })
        : { ok: false, why: "it did not come back in the required shape" };

      /* cappedOut means the model stopped mid-answer. Same rule as truncated
       * input on the client report: half an answer reads exactly like a whole
       * one, so it does not ship as written. */
      if (parsed && verdict.ok && !result.cappedOut) {
        report = { ...parsed, cannotCheck: facts.cannotAnswer.map((g) => `- ${g}`).join("\n") };
        source = "written";
        usage = result.usage;
        model = "claude-sonnet-4-6";
        const cost = (usage.input_tokens * COST.input + usage.output_tokens * COST.output) / 1e6;
        await admin.from("admin_usage_events").insert({
          source: "admin", model,
          input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
          cost_usd: cost,
          meta: { kind: "console_report", preset: presetId, user: member.membership?.email, feedbackUsed: feedback.length },
        }).then(() => {}, () => {});
      } else {
        rejected = result.cappedOut
          ? "the answer stopped part way through, so it would have been half a story"
          : verdict.why;
      }
    } catch (err) {
      /* A 503/504 from the model is not a server error here — the counted
       * version still answers the question, so say what happened and ship it. */
      rejected = `the AI did not answer: ${err?.message || "unknown error"}`;
    }
  } else {
    rejected = "there is no ANTHROPIC_API_KEY set, so nothing could be written";
  }

  if (!report) report = deterministicConsoleReport(facts, { todayIso, why: rejected });

  /* ---- save it ---- */
  const row = {
    instruction,
    preset: presetId,
    mode,
    title: report.title || "Overview",
    summary: report.summary || "",
    body: report.body || "",
    watch: report.watch || null,
    cannot_check: report.cannotCheck || null,
    source,
    rejected_why: rejected,
    facts: { counts: facts.counts, cannotAnswer: facts.cannotAnswer, unreadable: facts.unreadable, takenAt: facts.takenAt },
    counts_at: facts.takenAt,
    created_by_email: member.membership?.email || null,
  };

  const { data: saved, error: saveErr } = await admin
    .from("admin_console_reports").insert(row).select().maybeSingle();

  if (saveErr) {
    /* The words are worth more than the filing. Hand them back with the reason
     * the row did not stick, rather than throwing away work that cost money. */
    return res.status(200).json({
      report: { ...row, id: null, created_at: new Date(nowMs).toISOString() },
      saved: false, saveError: saveErr.message, source, usage, rejected,
      unreadable: facts.unreadable,
    });
  }

  return res.status(200).json({
    report: saved, saved: true, source, usage, rejected,
    unreadable: facts.unreadable,
    /* Reported so the panel can say "shaped by 3 notes you left" rather than
     * silently behaving differently from last week. */
    feedbackUsed: feedback.length,
  });
}
