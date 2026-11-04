/* lib/anthropic-route.js — where a Claude call goes (4 Nov 2026). Run: node tests/anthropic-route/test.mjs */
import { anthropicRoute, gatewayModel, GATEWAY_URL, ANTHROPIC_DIRECT_URL } from "../../lib/anthropic-route.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log("FAIL", name); } };

ok("model name maps to the Gateway's", gatewayModel("claude-sonnet-4-6") === "anthropic/claude-sonnet-4.6");
ok("a dotted name is left alone", gatewayModel("claude-haiku-4.5") === "anthropic/claude-haiku-4.5");

ok("no keys → null", anthropicRoute("claude-sonnet-4-6", {}) === null);
ok("blank keys → null", anthropicRoute("claude-sonnet-4-6", { ANTHROPIC_API_KEY: "  ", AI_GATEWAY_API_KEY: "" }) === null);

const direct = anthropicRoute("claude-sonnet-4-6", { ANTHROPIC_API_KEY: "k1" });
ok("direct url", direct.url === ANTHROPIC_DIRECT_URL && direct.via === "anthropic");
ok("direct model unchanged", direct.model === "claude-sonnet-4-6");
ok("direct sends x-api-key", direct.headers["x-api-key"] === "k1");
ok("no workspace header unless set", !("anthropic-workspace-id" in direct.headers));

const ws = anthropicRoute("claude-sonnet-4-6", { ANTHROPIC_API_KEY: "k1", ANTHROPIC_WORKSPACE_ID: " wrkspc_01ABC " });
ok("workspace header when set (trimmed)", ws.headers["anthropic-workspace-id"] === "wrkspc_01ABC");

const gw = anthropicRoute("claude-sonnet-4-6", { ANTHROPIC_API_KEY: "k1", AI_GATEWAY_API_KEY: "g1" });
ok("gateway wins when set", gw.via === "gateway" && gw.url === GATEWAY_URL);
ok("gateway uses bearer", gw.headers.authorization === "Bearer g1");
ok("gateway never gets the Anthropic key", !("x-api-key" in gw.headers) && !JSON.stringify(gw.headers).includes("k1"));
ok("gateway model name", gw.model === "anthropic/claude-sonnet-4.6");
ok("gateway alone is enough", anthropicRoute("claude-sonnet-4-6", { AI_GATEWAY_API_KEY: "g1" })?.via === "gateway");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
