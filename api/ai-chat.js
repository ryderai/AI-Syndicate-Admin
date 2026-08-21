/* POST /api/ai-chat — the always-on assistant.
 *
 * Auth: any active member. What it can see and do is decided by their role,
 * in lib/brain-context.js and lib/assistant-tools.js, not here.
 *
 * Body: { message, history?: [{role,text}], screen?: {...}, allowActions?: bool }
 * Returns: { text, actions: [...], usage, context: { rows, truncatedParts } }
 *
 * The order of operations is the whole point of this file:
 *   1. read the real rows this person is allowed to see
 *   2. render them into the system prompt
 *   3. let the model answer, and run any tools it asks for
 *   4. log every tool run and the token spend
 *
 * Step 1 is what makes the answers worth anything. Step 4 is what makes step 3
 * acceptable.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { loadSystemContext, renderContext, renderFocus } from "../lib/brain-context.js";
import { toolsForRole, runTool, logToolRun } from "../lib/assistant-tools.js";
import { converse, isAiConfigured, AGENT_MODEL } from "../lib/ai-agent.js";

// Same table as api/ai-draft.js. Keep the two in step with Anthropic pricing.
const COST = { input: 3.0, output: 15.0 };

const HOUSE = `You are the AI Syndicate console assistant. You work for a small GEO agency —
GEO means Generative Engine Optimization: getting businesses found, trusted and quoted by AI
search engines (ChatGPT, Google AI Overviews, Perplexity, Gemini, Copilot).

HOW TO WRITE
- A smart 12-year-old should follow you with no questions. That is the bar, every time.
- Short sentences. Normal words. Start with the answer, then the detail.
- Define any acronym or technical term in plain words the first time you use it.
- Never use these words: leverage, robust, holistic, synergy, utilize, ecosystem, granular,
  seamless, actionable insights, best-in-class.
- Steps a person has to do themselves: numbered, one action per step, exact page and button.
- Never hand someone a choice without saying which one you would pick and why, in one line.
- Keep it to a few sentences unless they ask for more. This is a chat box, not a report.

HOW TO BE HONEST — this matters more than sounding helpful
- Everything you know about this company is in the context block below. It was counted from
  real rows. If something is not in it, you do not know it — say so and offer to search.
- The context block is capped. Where it says rows were not shown, say that out loud rather
  than answering as if you had seen everything.
- Never invent a number, a date, a name, or a promise. Missing fact? Write [CONFIRM: ...].
- Say where a claim came from when it matters: counted from the rows, remembered from an
  earlier conversation, or the person's own words. Never blend the three.
- A memory marked UNCONFIRMED may be wrong. Lean on it only when you say that you are.

DOING THINGS
- You can change records with the tools you have been given. Use them when the person asks
  for something to happen — do not describe the change and wait.
- Name the record before you change it. If two records could match, ask which.
- After a tool runs, say plainly what changed in one line. Do not repeat the tool's output.
- If a tool fails, say what failed and why. Never report a change that did not happen.
- You cannot delete anything. Say so if asked, and say a person has to do it themselves.
- Reports and summaries describe work. They never assign a task to a named person — write
  "this is blocked until X exists", not "CJ needs to do X".

REMEMBERING
- When you learn something that will still be true next week, keep it with the remember tool:
  how a client likes to be contacted, why a call was made, a trap in a tool, who handles what.
- Do not remember anything already stored in a row — stages, dates and statuses are read fresh
  every time, and a copy of one just goes stale and starts lying.
- Never store a password, a card number, or anything from someone's private life.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  if (!isAiConfigured()) {
    return res.status(503).json({ error: "The assistant is waiting on ANTHROPIC_API_KEY — SETUP.md § AI." });
  }

  const body = await readJson(req);
  const message = String(body?.message || "").trim().slice(0, 4000);
  if (!message) return res.status(400).json({ error: "Nothing to answer — the message is empty." });

  const history = Array.isArray(body?.history) ? body.history.slice(-12) : [];
  const screen = body?.screen && typeof body.screen === "object" ? body.screen : null;
  // Actions default ON. The person can switch them off from the chat header,
  // and when they do the model is told, so it explains what it would have done
  // instead of failing silently.
  const allowWrites = body?.allowActions !== false;

  const admin = getAdminSupabase();
  const role = member.membership.role;
  const userId = member.membership.user_id;

  let snap;
  try {
    snap = await loadSystemContext(admin, { role, userId });
  } catch (err) {
    return res.status(500).json({ error: `Could not read the console's records: ${err?.message || "unknown"}` });
  }

  const contextBlock = renderContext(snap);
  const focusBlock = renderFocus(snap, screen);
  const today = new Date().toISOString().slice(0, 10);

  const system = [
    HOUSE,
    `Today is ${today}. Work every "Friday" or "next week" out from that date before you use it.`,
    allowWrites ? "" : "ACTIONS ARE SWITCHED OFF right now. You cannot change anything. When asked to, say exactly what you would have done and that they can switch actions on in the chat header.",
    focusBlock,
    contextBlock,
  ].filter(Boolean).join("\n\n---\n\n");

  const messages = [];
  for (const turn of history) {
    const text = String(turn?.text || "").trim().slice(0, 4000);
    if (!text) continue;
    messages.push({ role: turn.role === "assistant" ? "assistant" : "user", content: text });
  }
  messages.push({ role: "user", content: message });

  const tools = toolsForRole(role, { allowWrites });

  try {
    const out = await converse({
      system,
      messages,
      tools,
      onToolCall: async (name, input) => {
        const result = await runTool(admin, member, name, input, { allowWrites });
        // Logged before the answer is built, so a crash later still leaves the
        // record of what was changed.
        const logged = await logToolRun(admin, {
          actor: userId, tool: name, args: input, result, screen: screen?.page,
        });
        if (!logged && result.ok) {
          // Say it in the tool result so it reaches the person, rather than
          // disappearing into a server log nobody reads.
          result.text += " (Note: this action could not be written to the assistant log.)";
        }
        return result;
      },
    });

    // Our own spend, measured rather than guessed — it shows on Overview.
    const cost = (out.usage.input_tokens * COST.input + out.usage.output_tokens * COST.output) / 1e6;
    await admin.from("admin_usage_events").insert({
      source: "admin",
      model: AGENT_MODEL,
      input_tokens: out.usage.input_tokens,
      output_tokens: out.usage.output_tokens,
      cost_usd: cost,
      meta: { kind: "assistant", user: member.membership.email, rounds: out.rounds, screen: screen?.page || null },
    }).then(() => {}, () => {}); // never let bookkeeping break the answer

    // Recency on the memories that were in play. Fire-and-forget on purpose:
    // a failure to stamp last_used_at must never cost the person their answer.
    if (snap.memory?.length) {
      const ids = snap.memory.slice(0, 20).map((m) => m.id);
      admin.from("admin_brain_memory")
        .update({ last_used_at: new Date().toISOString() })
        .in("id", ids)
        .then(() => {}, () => {});
    }

    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({
      text: out.text,
      actions: out.actions,
      usage: out.usage,
      cappedOut: out.cappedOut,
      context: {
        // What the answer was actually built on. Printed under the chat so a
        // thin answer can be told apart from a thin dataset.
        counts: {
          clients: snap.clients?.length || 0,
          tasks: snap.tasks?.length || 0,
          leads: snap.leads?.length || 0,
          emails: snap.emails?.length || 0,
          tickets: snap.tickets?.length || 0,
          reminders: snap.reminders?.length || 0,
          memories: snap.memory?.length || 0,
          rules: snap.brain?.length || 0,
        },
        unreadable: Object.keys(snap.errors || {}),
      },
    });
  } catch (err) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    return res.status(status).json({ error: err?.message || "The assistant failed." });
  }
}
