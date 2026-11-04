/**
 * WHERE A CLAUDE CALL GOES — 4 Nov 2026
 *
 * WHY. The live console's ANTHROPIC_API_KEY is a key that is not scoped to a
 * workspace: Anthropic answers every call made with it with a 400 that asks
 * for an `anthropic-workspace-id` header (measured 4 Nov on the LinkedIn
 * engine's first live call; the console's notes and assistant calls show as
 * failed in admin_usage_events too). Two ways out, both settings in Vercel,
 * neither a code change:
 *
 *   1. AI_GATEWAY_API_KEY set  → the call goes through Vercel AI Gateway
 *      (same Anthropic Messages API, billed to the Vercel team). Wins when set.
 *   2. ANTHROPIC_WORKSPACE_ID set → the direct call carries that header.
 *
 * Neither set → exactly the old direct call. Pure: takes the env, returns
 * where to send the request; lib/ai.js and lib/ai-agent.js both use it.
 */

export const ANTHROPIC_DIRECT_URL = "https://api.anthropic.com/v1/messages";
export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/messages";

/** Our model id → the Gateway's name for it: claude-sonnet-4-6 → anthropic/claude-sonnet-4.6 */
export function gatewayModel(modelId) {
  return `anthropic/${String(modelId).replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
}

/** { via, url, model, headers } or null when no key is set at all. */
export function anthropicRoute(modelId, env = process.env) {
  const gateway = String(env.AI_GATEWAY_API_KEY || "").trim();
  if (gateway) {
    return {
      via: "gateway",
      url: GATEWAY_URL,
      model: gatewayModel(modelId),
      headers: { authorization: `Bearer ${gateway}`, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    };
  }
  const key = String(env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return null;
  const workspace = String(env.ANTHROPIC_WORKSPACE_ID || "").trim();
  return {
    via: "anthropic",
    url: ANTHROPIC_DIRECT_URL,
    model: modelId,
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      ...(workspace ? { "anthropic-workspace-id": workspace } : {}),
      "content-type": "application/json",
    },
  };
}
