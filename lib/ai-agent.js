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
  const json = await response.json();
  /* The provider's own request id rides along on the body object rather than
   * in a second return value, because callAnthropic() is called from inside a
   * loop that already destructures the body in four places. A non-enumerable
   * property keeps it out of anything that spreads or serialises the body —
   * including the conversation we send straight back to the API, which
   * rejects unknown fields. */
  Object.defineProperty(json, "__requestId", {
    value: response.headers.get("request-id") || null,
    enumerable: false,
  });
  return json;
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
  /* Cache fields are accumulated too. A tool-using conversation is the single
   * most cache-heavy thing this console does — the same system prompt and the
   * same context block go up on every round — so leaving them out understates
   * exactly the calls that cost the most. */
  const usage = {
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    /* THE 5-MINUTE / 1-HOUR SPLIT HAS TO TRAVEL WITH THE TOTAL. Without it,
     * lib/ai-cost.js has no way to tell the two apart and books everything at
     * the 5-minute rate — a 60% understatement on the three most cache-heavy
     * features in the console, and nothing on the bill would show which it was. */
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  };
  let requestId = null;
  const startedAt = Date.now();
  let rounds = 0;
  let cappedOut = false;
  let text = "";

  /* WHAT HAS ALREADY BEEN BILLED SURVIVES A FAILURE.
   *
   * A conversation is several separate billed requests. When round 5 times out,
   * rounds 1-4 have already been charged — and before this, the throw took the
   * whole accumulator with it, so those tokens were recorded as "unknown" and
   * cost nothing on any screen. The partial usage rides out on the error, and
   * the routes log it. */
  const attachPartial = (err) => {
    err.partialUsage = usage;
    err.partialRequestId = requestId;
    err.partialRounds = rounds;
    err.latencyMs = Date.now() - startedAt;
    return err;
  };

  while (rounds < MAX_ROUNDS) {
    rounds += 1;
    let body;
    try {
      body = await callAnthropic({ system, messages: convo, tools, maxTokens });
    } catch (err) {
      throw attachPartial(err);
    }
    usage.input_tokens += body?.usage?.input_tokens || 0;
    usage.output_tokens += body?.usage?.output_tokens || 0;
    usage.cache_creation_input_tokens += body?.usage?.cache_creation_input_tokens || 0;
    usage.cache_read_input_tokens += body?.usage?.cache_read_input_tokens || 0;
    usage.cache_creation.ephemeral_5m_input_tokens += body?.usage?.cache_creation?.ephemeral_5m_input_tokens || 0;
    usage.cache_creation.ephemeral_1h_input_tokens += body?.usage?.cache_creation?.ephemeral_1h_input_tokens || 0;
    /* The LAST round's id. A conversation is several billed requests and only
     * one id can go on one row; the last one is the one whose answer the person
     * actually read, and it is the one Anthropic's own logs sort to the top. */
    if (body?.__requestId) requestId = body.__requestId;

    const toolUses = (body?.content || []).filter((b) => b.type === "tool_use");
    const said = textOf(body);
    if (said) text = said;

    if (!toolUses.length || body?.stop_reason !== "tool_use") {
      return { text: said || text, actions, usage, rounds, cappedOut, requestId, latencyMs: Date.now() - startedAt };
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
    actions, usage, rounds, cappedOut, requestId, latencyMs: Date.now() - startedAt,
  };
}

export const AGENT_MODEL = MODEL_ID;
export const AGENT_MAX_ROUNDS = MAX_ROUNDS;
