/* END TO END: a real call in the platform -> a real row in the database.
 *
 * The unit tests on each side prove each side. This proves the SEAM, which is
 * where this kind of work actually fails: the platform builds an event shape,
 * the console's ingest endpoint reads a slightly different one, and both
 * suites stay green while nothing is ever recorded.
 *
 * So this runs the two real files against each other:
 *
 *   1. the platform's lib/ai-meter.js meters a real (stubbed-socket) call to
 *      Anthropic and produces the event body it would POST
 *   2. the console's real api/usage-ingest.js handler receives that exact
 *      body and produces the rows it would write
 *   3. those exact rows are INSERTED into a real Postgres carrying all 32
 *      migrations, and read back through the real views
 *
 * Only the socket and the Supabase client are stood in for. Every shape
 * decision on the path is made by the real code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const DB = process.env.E2E_PG;
if (!DB) {
  console.log("  --   no E2E_PG set; the end-to-end check was SKIPPED. A skip is not a pass.");
  process.exit(77);
}

/* `pg` is imported HERE, not at the top of the file.
 *
 * As first written this was a static `import pg from "pg"` above the skip
 * guard — and `pg` is not a dependency of this repo. A static import is
 * resolved before any line of the module runs, so the guard was unreachable
 * and the file crashed with ERR_MODULE_NOT_FOUND the moment anybody followed
 * the documented command. The suite it was supposed to prove could never run,
 * and every "found by the e2e half" claim beside it was unverifiable as
 * checked in.
 *
 * A dynamic import runs after the guard, and says plainly what to install
 * rather than dying on a resolver error. */
let pg;
try {
  ({ default: pg } = await import("pg"));
} catch {
  console.log("  --   the 'pg' package is not installed here; the end-to-end check was SKIPPED.");
  console.log("       A skip is not a pass. Install it in the container: npm install pg");
  process.exit(77);
}

/* ---- 1. what the platform produces ------------------------------------- */

const meter = await import(`${process.env.PLATFORM_LIB}/ai-meter.js`);
const modelJson = await import(`${process.env.PLATFORM_LIB}/model-json.js`);

process.env.ENABLE_AI_METER = "true";
meter.__resetAiMeter();

globalThis.fetch = async () => new Response(JSON.stringify({
  id: "msg_e2e", model: "claude-sonnet-4-6-20260514",
  content: [{ type: "text", text: '{"ok":true}' }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3120, output_tokens: 245, cache_read_input_tokens: 2000 },
}), { status: 200, headers: { "content-type": "application/json", "request-id": "req_e2e_1" } });

meter.installAiMeter();
meter.setAiMeterContext({ workspaceId: "22222222-2222-2222-2222-222222222222", platformFeature: "content.generate", surface: "cron" });

await modelJson.requestModelJson({
  apiKey: "k", model: "claude-sonnet-4-6", system: "s",
  messages: [{ role: "user", content: "hi" }], maxTokens: 256, timeoutMs: 5000,
  tag: "e2e", createError: (m, st) => Object.assign(new Error(m), { status: st }),
  errors: { timeout: "t", http: "h", unusable: "u", cutOff: "c", empty: "e" },
});
/* Plus a paid call with NO tokens at all — the case that was refused by the
 * database and dropped by the endpoint before this work. */
meter.recordProviderCall({ provider: "serpapi", model: "search", usage: null, status: "ok", latencyMs: 120 });

let POSTED = null;
process.env.ADMIN_USAGE_INGEST_URL = "https://admin.example.com/api/usage-ingest";
process.env.USAGE_INGEST_KEY = "shared-secret";
globalThis.fetch = async (url, init) => {
  POSTED = JSON.parse(init.body);
  return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
};
await meter.flushAiMeter();

test("1. the platform produced two events, with the tokens it really used", () => {
  assert.ok(POSTED, "the meter posted nothing at all");
  assert.equal(POSTED.events.length, 2);
  const claude = POSTED.events.find((e) => e.provider === "anthropic");
  assert.equal(claude.input_tokens, 3120);
  assert.equal(claude.output_tokens, 245);
  assert.equal(claude.cache_read_tokens, 2000);
  assert.equal(claude.model, "claude-sonnet-4-6-20260514");
  assert.equal(claude.workspace_id, "22222222-2222-2222-2222-222222222222");
  assert.equal(claude.platform_feature, "content.generate");
  const serp = POSTED.events.find((e) => e.provider === "serpapi");
  assert.equal(serp.input_tokens, null, "a call with no tokens must say null, never 0");
});

/* ---- 2. what the console's real endpoint makes of it -------------------- */

const captured = { rows: null, workspaces: [] };
mock.module(`${process.env.ADMIN_LIB}/supabase-server.js`, {
  namedExports: {
    isServerConfigured: () => true,
    readJson: async (req) => req.body,
    getAdminSupabase: () => ({
      from(table) {
        return {
          select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
          upsert: async (rows) => {
            if (table === "admin_usage_events") captured.rows = rows;
            else captured.workspaces.push(...rows);
            return { data: rows, error: null, count: rows.length };
          },
          update: () => ({ in: async () => ({ error: null }) }),
        };
      },
    }),
  },
});

const { default: ingest } = await import(`${process.env.ADMIN_API}/usage-ingest.js`);

let RESPONSE = null;
const res = {
  status(code) { this._code = code; return this; },
  json(body) { RESPONSE = { code: this._code, body }; return this; },
};

test("2. the real ingest endpoint accepts it and builds the rows", async () => {
  await ingest({ method: "POST", headers: { "x-ingest-key": "shared-secret" }, body: POSTED }, res);
  assert.equal(RESPONSE.code, 200, `endpoint said: ${JSON.stringify(RESPONSE.body)}`);
  assert.equal(captured.rows.length, 2, "BOTH events were kept — the tokenless one was dropped before this fix");
  const serpRow = captured.rows.find((r) => r.provider === "serpapi");
  assert.equal(serpRow.input_tokens, null);
  assert.equal(serpRow.cost_micros, null, "an unmeasured call must not be priced at zero");
  const claudeRow = captured.rows.find((r) => r.provider === "anthropic");
  assert.equal(claudeRow.workspace_id, "22222222-2222-2222-2222-222222222222");
  assert.equal(claudeRow.platform_feature, "content.generate");
  assert.equal(claudeRow.client_id, null, "a workspace id must never be written in as a client id");
  assert.equal(captured.workspaces.length, 1, "the workspace registered itself");
});

/* ---- 3. do those rows survive a real database? ------------------------- */

test("3. the real rows insert into a real Postgres and read back through the views", async () => {
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  try {
    await client.query(`insert into auth.users (id,email) values ('00000000-0000-0000-0000-00000000000e','e2e@x.com') on conflict do nothing`);
    await client.query(`insert into public.admin_clients (id,name) values ('eeee0000-0000-0000-0000-00000000000e','E2E Client') on conflict do nothing`);
    await client.query(`delete from public.admin_usage_events`);
    await client.query(`delete from public.admin_platform_workspaces`);
    await client.query(
      `insert into public.admin_platform_workspaces (workspace_id, client_id) values ($1,$2)`,
      ["22222222-2222-2222-2222-222222222222", "eeee0000-0000-0000-0000-00000000000e"],
    );

    for (const r of captured.rows) {
      await client.query(
        `insert into public.admin_usage_events
           (ts, source, provider, model, request_id, event_key,
            input_tokens, output_tokens, cache_write_tokens, cache_write_1h_tokens, cache_read_tokens,
            cost_micros, cost_usd, client_id, feature, surface, status, latency_ms, billable,
            workspace_id, platform_feature, meta)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [r.ts, r.source, r.provider, r.model, r.request_id, r.event_key,
         r.input_tokens, r.output_tokens, r.cache_write_tokens, r.cache_write_1h_tokens, r.cache_read_tokens,
         r.cost_micros, r.cost_usd, r.client_id, r.feature, r.surface, r.status, r.latency_ms, r.billable,
         r.workspace_id, r.platform_feature, r.meta],
      );
    }

    const rows = await client.query(
      `select attribution, provider, input_tokens, cost_micros
         from public.admin_client_ai_cost
        where client_id = 'eeee0000-0000-0000-0000-00000000000e'
        order by provider`,
    );
    assert.equal(rows.rowCount, 2, "both calls reached the client through the workspace mapping");
    assert.equal(rows.rows.every((r) => r.attribution === "mapped"), true);

    const serp = rows.rows.find((r) => r.provider === "serpapi");
    assert.equal(serp.input_tokens, null, "NULL survived the round trip — it did not become 0");
    assert.equal(serp.cost_micros, null);

    const claude = rows.rows.find((r) => r.provider === "anthropic");
    assert.equal(Number(claude.input_tokens), 3120, "the real token count is in the database");
  } finally {
    await client.end();
  }
});
