/* POST /api/ai-draft — every AI draft in the console goes through here.
 * Auth: any active member.
 * Body: { kind: "email_reply"|"email_new"|"ticket_reply"|"lead_outreach"|"chat",
 *         context: string, history?: [{role,text}] }
 *
 * Grounded in the AI Brain (enabled admin_brain rows) so the team's edits
 * to the Brain page change how every draft is written. Each call also logs
 * its own token usage through lib/ai-usage.js, so the
 * console's AI spend shows up on the Overview page automatically. */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { draft, isAiConfigured, AI_MODEL } from "../lib/ai.js";
import { recordAiUsage } from "../lib/ai-usage.js";

// Rough cost table (USD per 1M tokens) — keep in sync with Anthropic pricing.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  if (!isAiConfigured()) {
    return res.status(503).json({ error: "AI drafting is waiting on ANTHROPIC_API_KEY — SETUP.md § AI." });
  }

  const body = await readJson(req);
  const kind = String(body?.kind || "chat");
  const context = String(body?.context || "");
  const history = Array.isArray(body?.history) ? body.history : [];

  const admin = getAdminSupabase();
  // The Brain is closed to the sales role at the database — so it must not
  // leak through this endpoint either (a sales rep could otherwise just ask
  // the AI to recite it). Sales drafts run on the base house rules only.
  const isAdminRole = ["owner", "admin"].includes(member.membership.role);
  let brainRows = [];
  if (isAdminRole) {
    const { data } = await admin
      .from("admin_brain")
      .select("kind, title, body")
      .eq("enabled", true)
      .order("created_at", { ascending: true })
      .limit(60);
    brainRows = data || [];
  }

  /* THE PERSON'S OWN RULES — read UNCONDITIONALLY, for every role, and only ever
   * their own. Aug 27 2026, migration 0022.
   *
   * This is deliberately the opposite gate from the block above it, and the
   * difference is the whole point. `admin_brain` is the COMPANY's and is
   * admin-only, so a rep must not be able to make the AI recite it — that is
   * trap #8 in CONTEXT-FOR-AI.md §8, and the `if (isAdminRole)` above is the fix
   * for it. `admin_user_brain` is one person's own tone settings, so there is
   * nothing to leak: the filter is `user_id = the caller`, which is also what the
   * policy in 0022 says.
   *
   * A FAILED READ IS NOT AN EMPTY ONE, and it is not fatal either: the draft still
   * goes out on the house rules, and `personalRulesRead: false` comes back on the
   * response. NOTHING READS THAT FLAG YET — said plainly, because an earlier
   * version of this comment claimed "so the screen can say the settings were not
   * applied", and no screen does. The AI Brain page covers the common cause a
   * different way (its own read of the table fails too, and it prints that error),
   * so the gap is a draft box that cannot tell somebody their tone settings were
   * skipped. Worth wiring; not wired. Third review, Aug 27 2026.
   *
   * NO ROLE GATE and NO WIDENING: it never reads a row belonging to anybody else,
   * for anybody, including an owner. An owner auditing a rep's rules does it on
   * the page, where it is visible, not through a draft. */
  let personalRows = [];
  let personalRulesRead = true;
  const callerId = member.membership.user_id || member.user.id;
  if (callerId) {
    const { data, error } = await admin
      .from("admin_user_brain")
      .select("kind, setting_key, title, body, enabled")
      .eq("user_id", callerId)
      .eq("enabled", true)
      .order("created_at", { ascending: true })
      .limit(60);
    if (error) {
      personalRulesRead = false;
      console.error("[ai-draft] could not read the caller's own AI rules:", error.message);
    } else {
      personalRows = data || [];
    }
  } else {
    /* No id means the token did not identify a person. Nothing is read rather
     * than everything: the same refusal askRepReport makes, for the same reason. */
    personalRulesRead = false;
  }

  try {
    const result = await draft({ kind, context, history, brainRows, personalRows });

    // Measured, not guessed, and on every path — see the catch below.
    await recordAiUsage(admin, {
      model: result.model || AI_MODEL,
      usage: result.usage,
      requestId: result.requestId,
      latencyMs: result.latencyMs,
      status: "ok",
      feature: featureForKind(kind),
      surface: surfaceOf(body),
      clientId: body?.clientId || null,
      userId: member.user?.id || null,
      entity: body?.entityKind && body?.entityId ? { kind: body.entityKind, id: body.entityId } : null,
      meta: { kind },
    });

    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({
      text: result.text,
      usage: result.usage,
      /* Said out loud so a screen never has to guess. `personalRules: 0` with
       * `personalRulesRead: true` means the person has not set any; `false` means
       * we could not look, which is a different sentence. */
      personalRules: personalRows.length,
      personalRulesRead,
    });
  } catch (err) {
    /* A failed draft is still a call the provider may have billed us for. It is
     * logged with tokensUnknown, because a call that threw never reported its
     * token counts — so the FAILURE is countable even though its cost is not.
     * Before this build these calls left no trace at all. */
    await recordAiUsage(admin, {
      model: AI_MODEL,
      usage: null,
      status: "failed",
      errorCode: String(err?.message || "unknown").slice(0, 120),
      feature: featureForKind(kind),
      surface: surfaceOf(body),
      clientId: body?.clientId || null,
      userId: member.user?.id || null,
      meta: { kind, tokensUnknown: true },
    });
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    return res.status(status).json({ error: err?.message || "Draft failed." });
  }
}

/* The draft kinds are the caller's vocabulary; FEATURES is the cost page's.
 * Mapped in one place rather than at each call site, because two spellings of
 * the same feature split one row on the page into two. */
function featureForKind(kind) {
  switch (kind) {
    case "email_reply":
    case "email_new":
    case "ticket_reply":
      return "email_draft";
    case "lead_outreach":
      return "outreach_draft";
    case "chat":
      return "assistant";
    default:
      return "other";
  }
}

/* The page the person was on, when they told us. Never guessed from the kind:
 * a lead outreach draft can be written from the Floor or from Sales, and
 * pretending to know which would put real calls under the wrong heading. */
function surfaceOf(body) {
  return body?.surface || "unknown";
}
