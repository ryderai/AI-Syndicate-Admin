/* The assistant's conversation loop — the same direct Anthropic Messages API
 * call as lib/ai.js, plus tool use.
 *
 * A separate file rather than a change to lib/ai.js on purpose: ai.js drafts
 * one-shot text and is already relied on by the Inbox, Tickets and the client
 * page. Tool use adds a loop, a stop condition and a spend cap, and none of
 * that belongs inside a function whose job is "write me one email".
 *
 * THE LOOP, AND WHY IT IS BOUNDED
 * The model answers, may ask to run tools, gets the results, answers again.
 * Every one of those rounds is a paid call, so MAX_ROUNDS is a hard stop, not
 * a suggestion — a model that keeps searching for something that is not there
 * would otherwise bill until the function times out. When the cap is hit the
 * person is told, rather than being handed a confident answer built on a
 * search that never finished.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL_ID = "claude-sonnet-4-6";
const REQUEST_TIMEOUT_MS = 55000;
const MAX_ROUNDS = 6;
const MAX_TOKENS = 2000;

export function isAiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function createError(message, statusCode = 500) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function callAnthropic({ system, messages, tools, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw createError("The assistant is waiting on ANTHROPIC_API_KEY — SETUP.md § AI.", 503);

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_ID,
        // A caller can ask for a longer answer than a chat turn needs — a
        // written report runs to 1,200 words. Clamped, so nobody can ask for
        // an unbounded one. Added Aug 23 2026 for the Overview generator.
        max_tokens: Math.min(Math.max(Number(maxTokens) || MAX_TOKENS, 256), 8000),
        system,
        messages,
        ...(tools?.length ? { tools } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw createError(`The AI did not answer: ${err?.message || "network error"}`, 504);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw createError(`The AI responded ${response.status}: ${body.slice(0, 200) || "no body"}`, 502);
  }
  return response.json();
}

/** Pull the plain text out of a response body, ignoring tool blocks. */
function textOf(body) {
  return (body?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Run a conversation that may use tools.
 *
 * @param system     the system prompt (context block goes in here)
 * @param messages   [{role, content}] — content may be a string or blocks
 * @param tools      tool specs, or []
 * @param onToolCall async (name, input) => { ok, text, ... }
 * @returns { text, actions: [{tool, input, ok, text}], usage, rounds, cappedOut }
 */
export async function converse({ system, messages, tools = [], onToolCall, maxTokens = MAX_TOKENS }) {
  const convo = [...messages];
  const actions = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let rounds = 0;
  let cappedOut = false;
  let text = "";

  while (rounds < MAX_ROUNDS) {
    rounds += 1;
    const body = await callAnthropic({ system, messages: convo, tools, maxTokens });
    usage.input_tokens += body?.usage?.input_tokens || 0;
    usage.output_tokens += body?.usage?.output_tokens || 0;

    const toolUses = (body?.content || []).filter((b) => b.type === "tool_use");
    const said = textOf(body);
    if (said) text = said;

    if (!toolUses.length || body?.stop_reason !== "tool_use") {
      return { text: said || text, actions, usage, rounds, cappedOut };
    }

    // The model's turn goes back in whole — text blocks, tool blocks and all.
    // Rebuilding it from the parts we care about is how tool_use ids stop
    // matching their results, which the API rejects.
    convo.push({ role: "assistant", content: body.content });

    const results = [];
    for (const call of toolUses) {
      const outcome = onToolCall
        ? await onToolCall(call.name, call.input || {})
        : { ok: false, text: "No tool runner is wired up." };
      actions.push({ tool: call.name, input: call.input || {}, ok: outcome.ok, text: outcome.text });
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        // is_error tells the model this did not work, so it corrects itself
        // instead of reporting success it never had.
        is_error: !outcome.ok,
        content: String(outcome.text || (outcome.ok ? "Done." : "Failed.")).slice(0, 6000),
      });
    }
    convo.push({ role: "user", content: results });
  }

  cappedOut = true;
  return {
    text: text || "I ran out of steps before I finished that one. Here is where I got to — ask me again and be more specific about which record you mean.",
    actions, usage, rounds, cappedOut,
  };
}

export const AGENT_MODEL = MODEL_ID;
export const AGENT_MAX_ROUNDS = MAX_ROUNDS;
