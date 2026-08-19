/* POST /api/ai-draft — every AI draft in the console goes through here.
 * Auth: any active member.
 * Body: { kind: "email_reply"|"email_new"|"ticket_reply"|"lead_outreach"|"chat",
 *         context: string, history?: [{role,text}] }
 *
 * Grounded in the AI Brain (enabled admin_brain rows) so the team's edits
 * to the Brain page change how every draft is written. Each call also logs
 * its own token usage into admin_usage_events (source: "admin"), so the
 * console's AI spend shows up on the Overview page automatically. */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { draft, isAiConfigured } from "../lib/ai.js";

// Rough cost table (USD per 1M tokens) — keep in sync with Anthropic pricing.
const COST = { input: 3.0, output: 15.0 };

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

  try {
    const result = await draft({ kind, context, history, brainRows });

    // Log our own usage so admin AI spend is measured, not guessed.
    const cost = (result.usage.input_tokens * COST.input + result.usage.output_tokens * COST.output) / 1e6;
    await admin.from("admin_usage_events").insert({
      source: "admin",
      model: result.model,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cost_usd: cost,
      meta: { kind, user: member.membership.email },
    });

    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({ text: result.text, usage: result.usage });
  } catch (err) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    return res.status(status).json({ error: err?.message || "Draft failed." });
  }
}
