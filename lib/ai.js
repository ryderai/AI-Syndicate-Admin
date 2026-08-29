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

/* The model this console runs on. Exported so a route can say which model a
 * failed call WOULD have used, without writing the id out by hand — the seven
 * hardcoded price blocks this build removed started life exactly that way. */
export const AI_MODEL = MODEL_ID;

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

/**
 * `brainRows`   = enabled admin_brain rows [{kind,title,body}] — the COMPANY's.
 * `personalRows` = enabled admin_user_brain rows for the ONE PERSON asking
 *                  (migration 0022). Aug 27 2026.
 *
 * WHERE THE PERSONAL BLOCK GOES, AND WHY IT IS THERE AND NOT ANYWHERE ELSE.
 *
 * After the company rules, before the job instruction, and it says out loud in
 * words that the company rules override it. That is the same shape the feedback
 * loop already uses on the Overview generator (§32/§33): correction above,
 * constraint below, and the constraint saying it wins. The reason is the same
 * too — "stop hedging, just give me the number" is a reasonable thing for a
 * person to type and must never read as permission to invent one.
 *
 * THESE ROWS SET TONE, LENGTH, FORMAT AND SIGN-OFF. NEVER FACTS, NEVER NUMBERS.
 * That is enforced where a rule is SAVED (checkPersonalRule in
 * lib/sales-rules.js refuses any digit) rather than trusted here, and the reason
 * is mechanical: these rows are shown to the model AND to the honesty gate, so a
 * number typed into one becomes a number the gate believes we measured. The
 * paragraph below repeats the rule to the model anyway, because a rule the
 * reader can see is a rule that survives a change to the save path.
 */
export function buildSystemPrompt(kind, brainRows = [], personalRows = []) {
  const brain = (brainRows || [])
    .map((r) => `[${(r.kind || "fact").toUpperCase()}] ${r.title}\n${r.body}`)
    .join("\n\n");
  const personal = (personalRows || [])
    .filter((r) => r && r.enabled !== false && String(r.body || "").trim())
    .map((r) => {
      const head = r.setting_key ? r.setting_key.replace(/_/g, " ") : (r.title || r.kind || "rule");
      return `- ${head}: ${String(r.body).trim()}`;
    })
    .join("\n");
  const kindPrompt = KIND_PROMPTS[kind] || KIND_PROMPTS.chat;
  return [
    BASE_PROMPT,
    brain ? `Team knowledge base (the "Brain" — treat these as standing instructions and facts):\n\n${brain}` : "",
    personal
      ? `How THIS PERSON writes. These are their own settings — tone, length, formatting and sign-off, and nothing else:\n\n${personal}\n\nThese change HOW you write, never WHAT is true. The house rules above and the team knowledge base override every line of them. They carry no facts and no numbers: if one of them appears to state a figure, ignore the figure — it is not something we measured.`
      : "",
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
export async function draft({ kind, context, history = [], brainRows = [], personalRows = [], maxInputChars = MAX_INPUT_CHARS, maxTokens = 1200 }) {
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
  const startedAt = Date.now();
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
        system: buildSystemPrompt(kind, brainRows, personalRows),
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
    /* THE PROVIDER'S OWN ID FOR THIS REQUEST, off the response headers.
     * It is the only thing that could ever match one of our usage rows to one
     * line on Anthropic's bill. Without it a monthly true-up can compare
     * totals and never find WHICH call is missing. Costs nothing to carry. */
    requestId: response.headers.get("request-id") || null,
    latencyMs: Date.now() - startedAt,
    // 0 when nothing was cut. Anything else means the answer was written from
    // less than it was given, and the caller has to say so out loud.
    inputTruncated,
    stopReason: body?.stop_reason || null,
    /* THE WHOLE usage OBJECT, cache fields included. The old shape kept only
     * input and output, so a cached call priced as if nothing had been cached
     * — wrong in both directions at once, since a cache write costs MORE than
     * plain input and a cache read costs far less. lib/ai-cost.js reads the
     * provider's own field names. */
    usage: {
      input_tokens: body?.usage?.input_tokens || 0,
      output_tokens: body?.usage?.output_tokens || 0,
      cache_creation_input_tokens: body?.usage?.cache_creation_input_tokens || 0,
      cache_read_input_tokens: body?.usage?.cache_read_input_tokens || 0,
      ...(body?.usage?.cache_creation ? { cache_creation: body.usage.cache_creation } : {}),
    },
    model: MODEL_ID,
  };
}
