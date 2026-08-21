/* POST /api/notes-generate — write the Notes page from the real rows.
 *
 * Owners and admins only. A note can quote a client email, a bill or a ticket,
 * so this is closed to the sales role at the endpoint as well as in the
 * database.
 *
 * Body: { rewrite?: boolean }   rewrite = let the AI say it in better words
 * Returns: { created, superseded, unchanged, notes: [...], aiUsed }
 *
 * THE TWO PASSES, AND WHY THEY ARE SEPARATE
 *
 *   Pass 1 — lib/notes-engine.js COUNTS the notes. Every number comes from
 *   rows that exist. No AI touches this pass. If the AI key is missing, this
 *   is still the whole page and the page is still correct.
 *
 *   Pass 2 — optional. The AI is handed the counted facts and asked to say
 *   them better. It is told, in the prompt, that it may not add a number, a
 *   name or a date.
 *
 *   What is then CHECKED is narrower than what is asked for, and it is worth
 *   being exact about which: rewriteIsFaithful compares the NUMBERS only. A
 *   rewrite that invents a figure, drops one, or changes one is refused and
 *   the counted wording is kept. A rewrite that swaps a client's name or a
 *   day of the week would pass. That is why the badge says AI-WRITTEN rather
 *   than COUNTED — it is a warning, not a decoration, and the evidence chips
 *   under every note are what settle an argument.
 *
 * Every note carries which pass wrote it (`written_by`), and the page prints
 * it. Nobody has to trust that this endpoint behaved — they can see it.
 *
 * WHAT HAPPENS TO YESTERDAY'S NOTES
 * Nothing is deleted. A note whose fingerprint comes back is UPDATED in place
 * (the numbers move, the note is the same note). A note whose fingerprint does
 * not come back is marked `superseded`, which takes it off the live list and
 * keeps it on the record. A person's own done/dismissed decision is never
 * undone by a re-run.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { loadSystemContext } from "../lib/brain-context.js";
import { computeNotes, notesToPromptLines } from "../lib/notes-engine.js";
import { draft, isAiConfigured } from "../lib/ai.js";

const COST = { input: 3.0, output: 15.0 };

const REWRITE_INSTRUCTION = `Below are notes for an internal team board. Each one was produced by
counting real records. Rewrite each one so a smart 12-year-old could act on it.

HARD RULES — breaking any one of these makes the note worse than not rewriting it:
- Do NOT change, add, or remove a single number, name, date or record.
- Do NOT add anything that is not in the FACTS line. No advice, no causes, no guesses.
- Do NOT tell anyone to do something, and never name a person as owing work.
- Keep the same count of notes, in the same order.

For each note return exactly two lines:
T: <title, under 70 characters, states the thing>
B: <body, two or three short sentences, plain words>

Separate notes with a line containing only ---`;

/** Split the model's reply back into notes. Deliberately strict: anything that
 * does not parse cleanly is dropped, and the counted note is used instead. A
 * half-parsed rewrite is how a number ends up in the wrong note. */
export function parseRewrite(text, expected) {
  const blocks = String(text || "").split(/^\s*---\s*$/m);
  const out = [];
  for (const b of blocks) {
    const t = /(?:^|\n)[ \t]*T:[ \t]*(.+)/.exec(b);
    /* Everything after B: to the end of THIS block. The previous version was
     * a lazy match ending at `$` under the /m flag, and `$` matches at every
     * line end under /m — so a two-sentence body written across two lines was
     * cut after the first line, and the note lost half of itself. The blocks
     * are already split on ---, so there is nothing to be lazy about. */
    const body = /(?:^|\n)[ \t]*B:[ \t]*([\s\S]+)/.exec(b);
    if (!t || !body) continue;
    const title = t[1].trim();
    const bodyText = body[1].trim().replace(/\s+/g, " ");
    if (!title || !bodyText) continue;
    out.push({ title: title.slice(0, 300), body: bodyText.slice(0, 4000) });
  }
  // All or nothing. A partial rewrite would pair note 3's words with note 4's
  // facts, and every number on the page would still look counted.
  return out.length === expected ? out : null;
}

/** Every number the counted note contained. If the rewrite lost one or grew a
 * new one, the rewrite is not saying the same thing and gets dropped. */
export function numbersIn(s) {
  return (String(s || "").match(/\d+(?:[.,]\d+)?/g) || []).sort();
}

export function rewriteIsFaithful(counted, rewritten) {
  const a = numbersIn(`${counted.title} ${counted.body}`);
  const b = numbersIn(`${rewritten.title} ${rewritten.body}`);
  if (a.length !== b.length) return false;
  return a.every((n, i) => n === b[i]);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const body = await readJson(req);
  const wantRewrite = body?.rewrite !== false;

  const admin = getAdminSupabase();
  const now = Date.now();

  let snap;
  try {
    snap = await loadSystemContext(admin, {
      role: member.membership.role,
      userId: member.membership.user_id,
    });
  } catch (err) {
    return res.status(500).json({ error: `Could not read the records: ${err?.message || "unknown"}` });
  }

  const counted = computeNotes(snap, now);

  /* ---- pass 2: optional rewrite ---------------------------------- */
  let aiUsed = false;
  let aiError = null;
  let finalNotes = counted;
  const usageTotals = { input: 0, output: 0 };
  let usageModel = null;

  /* Rewritten in small batches, not all at once.
   *
   * lib/ai.js caps its context at 6,000 characters and its reply at 1,200
   * tokens. A counted note runs 300-500 characters, so past about ten notes
   * the prompt was cut off mid-note, the model returned fewer blocks than
   * expected, parseRewrite refused the lot, and the page always said "the
   * rewrite came back in the wrong shape" — on any console with real data.
   * Five per call fits both limits with room to spare. Found by an adversarial
   * review, Aug 20 2026. */
  const BATCH = 5;

  if (wantRewrite && counted.length && isAiConfigured()) {
    try {
      const rewritten = [];
      for (let i = 0; i < counted.length; i += BATCH) {
        const batch = counted.slice(i, i + BATCH);
        const result = await draft({
          kind: "chat",
          context: `${REWRITE_INSTRUCTION}\n\n${notesToPromptLines(batch)}`,
          brainRows: (snap.brain || []).map((b) => ({ kind: b.kind, title: b.title, body: b.body })),
        });
        const part = parseRewrite(result.text, batch.length);
        // One bad batch costs that batch its rewrite and nothing else. Pushing
        // nulls keeps the array lined up with `counted` by index, which is what
        // stops note 7's words landing on note 6's facts.
        for (let j = 0; j < batch.length; j += 1) rewritten.push(part ? part[j] : null);
        if (!part) aiError = "One batch came back in the wrong shape, so those notes kept their counted wording.";
        usageTotals.input += result.usage.input_tokens;
        usageTotals.output += result.usage.output_tokens;
        usageModel = result.model;
      }
      const parsed = rewritten;
      if (parsed) {
        finalNotes = counted.map((n, i) => {
          const r = parsed[i];
          if (!r) return n;
          // Per-note check. One drifting note does not cost the other nine
          // their rewrite, and a note that drifted keeps its counted wording
          // with the COUNTED badge still on it — which is the truth.
          if (!rewriteIsFaithful(n, r)) return n;
          return { ...n, title: r.title, body: r.body, written_by: "ai_written" };
        });
        aiUsed = finalNotes.some((n) => n.written_by === "ai_written");
      }

      const cost = (usageTotals.input * COST.input + usageTotals.output * COST.output) / 1e6;
      admin.from("admin_usage_events").insert({
        source: "admin", model: usageModel,
        input_tokens: usageTotals.input, output_tokens: usageTotals.output,
        cost_usd: cost, meta: { kind: "notes", user: member.membership.email, batches: Math.ceil(counted.length / BATCH) },
      }).then(() => {}, () => {});
    } catch (err) {
      // The page is still correct without this. Say what happened; do not fail.
      aiError = `The AI rewrite failed (${err?.message || "unknown"}), so these are the counted words.`;
    }
  }

  /* ---- write ------------------------------------------------------ */
  /* Every note with a fingerprint, not just the open ones.
   *
   * Reading only the open ones meant a note somebody had marked "Not a thing"
   * had no match on the next run, so a brand-new open row was inserted with
   * the same fingerprint — the partial unique index allows it, because it only
   * covers open rows. Click "Not a thing", press "Write today's notes", and the
   * note is back. This file's own header claimed that could not happen. Found
   * by an adversarial review, Aug 20 2026. */
  const { data: existing, error: readErr } = await admin
    .from("admin_ai_notes")
    .select("id, fingerprint, status, title, body, status_changed_at")
    .in("status", ["open", "done", "dismissed"]);
  if (readErr) return res.status(500).json({ error: `Could not read the existing notes: ${readErr.message}` });

  /* One row per fingerprint. If several exist (an old superseded one and a
   * dismissed one), the most recently decided wins — that is the decision that
   * is still standing. */
  const byFingerprint = new Map();
  for (const n of existing || []) {
    if (!n.fingerprint) continue;
    const prior = byFingerprint.get(n.fingerprint);
    if (!prior) { byFingerprint.set(n.fingerprint, n); continue; }
    const a = Date.parse(prior.status_changed_at || 0) || 0;
    const b = Date.parse(n.status_changed_at || 0) || 0;
    if (b > a) byFingerprint.set(n.fingerprint, n);
  }

  /* How long a person's "done" or "Not a thing" holds before the same problem
   * may be raised again. Not forever: a client who goes quiet, is chased, and
   * goes quiet again a fortnight later is genuinely a new thing to know. Not
   * never, either — that is the bug above. Two weeks is the number, and it is
   * named here so it can be argued with. */
  const DECISION_HOLDS_DAYS = 14;
  const holdsUntil = (n) => {
    const decided = Date.parse(n.status_changed_at || n.updated_at || 0) || 0;
    return decided + DECISION_HOLDS_DAYS * 86400000;
  };

  const seen = new Set();
  let created = 0;
  let updated = 0;
  let heldBack = 0;
  const problems = [];

  for (const n of finalNotes) {
    seen.add(n.fingerprint);
    const prior = byFingerprint.get(n.fingerprint);
    const row = {
      category: n.category,
      title: n.title,
      body: n.body,
      evidence: n.evidence,
      written_by: n.written_by,
      client_id: n.client_id || null,
      owner_id: n.owner_id || null,
      urgency: n.urgency,
      fingerprint: n.fingerprint,
      status: "open",
      generated_at: new Date(now).toISOString(),
    };
    if (prior && (prior.status === "done" || prior.status === "dismissed")) {
      // A person has already ruled on this one. Leave their decision alone.
      if (now < holdsUntil(prior)) { heldBack += 1; continue; }
      // The hold has run out, so the same problem counts as new again — and it
      // becomes a NEW row rather than reopening the old one, because the old
      // one is the record of a decision somebody made and is not ours to edit.
      const { error } = await admin.from("admin_ai_notes").insert(row);
      if (error) problems.push(`re-raise ${n.fingerprint}: ${error.message}`);
      else created += 1;
    } else if (prior) {
      const { error } = await admin.from("admin_ai_notes").update(row).eq("id", prior.id);
      if (error) problems.push(`update ${n.fingerprint}: ${error.message}`);
      else updated += 1;
    } else {
      const { error } = await admin.from("admin_ai_notes").insert(row);
      if (error) problems.push(`insert ${n.fingerprint}: ${error.message}`);
      else created += 1;
    }
  }

  // Anything open that this run did not produce has stopped being true.
  // Marked superseded, never deleted — a note that was true last Tuesday is
  // history, and history is the point of keeping it.
  /* Only OPEN rows. A note somebody marked done or dismissed already has its
   * final status, and overwriting that with "superseded" would erase the fact
   * that a person made a call on it. */
  const goneIds = (existing || [])
    .filter((n) => n.status === "open" && n.fingerprint && !seen.has(n.fingerprint))
    .map((n) => n.id);
  let superseded = 0;
  if (goneIds.length) {
    const { error } = await admin.from("admin_ai_notes")
      .update({ status: "superseded", status_changed_at: new Date(now).toISOString() })
      .in("id", goneIds);
    if (error) problems.push(`supersede: ${error.message}`);
    else superseded = goneIds.length;
  }

  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json({
    created, updated, superseded, heldBack,
    total: finalNotes.length,
    aiUsed,
    aiAvailable: isAiConfigured(),
    aiError,
    problems,
    generatedAt: new Date(now).toISOString(),
  });
}
