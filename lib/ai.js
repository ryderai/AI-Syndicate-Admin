/* AI drafting for the admin console — mirrors the platform's Caite pattern
 * (lib/help-chat.js): direct Anthropic Messages API call, no SDK.
 *
 * Every draft is grounded in the AI Brain: the enabled rows of admin_brain,
 * which the team edits on the Brain page. Uses the same ANTHROPIC_API_KEY
 * the platform already has in Vercel. */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL_ID = "claude-sonnet-4-6";
const REQUEST_TIMEOUT_MS = 40000;
const MAX_INPUT_CHARS = 6000;

/* Ceilings a caller cannot go past, whatever it asks for. One bad call must not
 * be able to post a whole table into a prompt or ask for a novel back. */
const HARD_MAX_INPUT_CHARS = 24000;
const HARD_MAX_TOKENS = 4000;

function createError(message, statusCode = 500) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export function isAiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const BASE_PROMPT = `You draft internal and outbound text for AI Syndicate, a GEO
(Generative Engine Optimization) agency. GEO means getting businesses found, trusted,
and cited by AI search engines (ChatGPT, Google AI Overviews, Perplexity, Gemini, Copilot).

House writing rules — always:
- Short sentences. Normal words. No jargon without a one-line plain definition.
- Start with the point. No warm-up sentences.
- Never invent facts, numbers, client names, or promises. If a fact is missing, write [CONFIRM: ...] instead.
- Never guarantee results or rankings.
- Banned words: leverage, robust, holistic, synergy, utilize, ecosystem, granular, seamless, actionable insights, best-in-class.`;

const KIND_PROMPTS = {
  email_reply: "Draft a reply to the email below. Match a professional, friendly tone. Keep it under 150 words unless the thread demands more. Output ONLY the reply body — no subject line, no signature block.",
  email_new: "Draft a new email based on the instruction below. Output the subject on the first line as 'Subject: ...' then a blank line, then the body.",
  ticket_reply: "Draft a support reply for the ticket below. Be direct about what was done or what happens next. If the fix needs something from the customer, give numbered steps. Output ONLY the reply body.",
  lead_outreach: "Draft a short cold outreach message to this lead about AI Syndicate's GEO services. 90 words max. One specific hook from their info, one plain sentence about what we do, one low-pressure ask.",
  chat: "Answer the team member's question. Be concise and practical.",
  /* The full instruction lives in lib/client-standing.js (STANDING_INSTRUCTION)
   * and is sent as part of the message, because it has to travel with the facts
   * it applies to. This line just sets the frame. */
  client_standing: "Summarise where a client stands for our own team, using only the facts given in the message. Follow the format in the message exactly.",
  /* Same idea as client_standing, one step bigger: the full instruction —
   * including how deep the person asked to go — travels with the facts in
   * lib/client-report.js, because an instruction separated from the facts it
   * applies to is how a report ends up the right length about the wrong thing. */
  client_report: "Write an internal report about one client for our own team, using only the facts given in the message. Follow the format and the length in the message exactly.",
};

/** rows = enabled admin_brain rows [{kind,title,body}] */
export function buildSystemPrompt(kind, brainRows = []) {
  const brain = (brainRows || [])
    .map((r) => `[${(r.kind || "fact").toUpperCase()}] ${r.title}\n${r.body}`)
    .join("\n\n");
  const kindPrompt = KIND_PROMPTS[kind] || KIND_PROMPTS.chat;
  return [
    BASE_PROMPT,
    brain ? `Team knowledge base (the "Brain" — treat these as standing instructions and facts):\n\n${brain}` : "",
    `Task type: ${kindPrompt}`,
  ].filter(Boolean).join("\n\n---\n\n");
}

/**
 * `maxInputChars` and `maxTokens` exist for the client report, which sends far
 * more counted facts than an email draft does and gets far more back. Both are
 * capped above.
 *
 * TRUNCATION IS REPORTED, NOT SWALLOWED. The returned object carries
 * `inputTruncated`. Before this, a context longer than the limit was silently
 * cut and the model answered confidently from half the facts — the caller had
 * no way to know, and neither did the person reading the answer.
 */
export async function draft({ kind, context, history = [], brainRows = [], maxInputChars = MAX_INPUT_CHARS, maxTokens = 1200 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw createError("AI drafting is not configured yet (ANTHROPIC_API_KEY missing).", 503);

  const limit = Math.min(Math.max(500, Number(maxInputChars) || MAX_INPUT_CHARS), HARD_MAX_INPUT_CHARS);
  const tokenLimit = Math.min(Math.max(256, Number(maxTokens) || 1200), HARD_MAX_TOKENS);

  const full = String(context || "").trim();
  const clean = full.slice(0, limit);
  const inputTruncated = full.length > clean.length ? full.length - clean.length : 0;
  if (!clean) throw createError("Nothing to draft from — context is empty.", 400);

  const messages = [];
  for (const turn of Array.isArray(history) ? history.slice(-10) : []) {
    const text = String(turn?.text || "").trim().slice(0, limit);
    if (!text) continue;
    messages.push({ role: turn.role === "assistant" ? "assistant" : "user", content: text });
  }
  messages.push({ role: "user", content: clean });

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
        max_tokens: tokenLimit,
        system: buildSystemPrompt(kind, brainRows),
        messages,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw createError(`AI request failed: ${err?.message || "network error"}`, 504);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw createError(`AI responded ${response.status}: ${errBody.slice(0, 200) || "no body"}`, 502);
  }

  const body = await response.json();
  const text = body?.content?.[0]?.text;
  if (!text) throw createError("The AI returned an empty draft. Try again.", 502);
  return {
    text: text.trim(),
    // 0 when nothing was cut. Anything else means the answer was written from
    // less than it was given, and the caller has to say so out loud.
    inputTruncated,
    stopReason: body?.stop_reason || null,
    usage: {
      input_tokens: body?.usage?.input_tokens || 0,
      output_tokens: body?.usage?.output_tokens || 0,
    },
    model: MODEL_ID,
  };
}
