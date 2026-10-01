/* The REAL /api/hs-heat handler, served on a port, with its database swapped
 * for a local Postgres. Used by e2e.sh only.
 *   node --experimental-test-module-mocks tests/heat-map/e2e-server.mjs 3999 */
import { mock } from "node:test";
import http from "node:http";
import { execFileSync } from "node:child_process";

const calls = [];
mock.module("../../lib/supabase-server.js", {
  namedExports: {
    isServerConfigured: () => true,
    getAdminSupabase: () => ({
      rpc: async (fn, args) => {
        if (fn !== "hs_heat_ingest") return { error: { message: `unexpected rpc ${fn}` } };
        calls.push({ ...args.p, at: Date.now() });
        const lit = JSON.stringify(args.p).replace(/'/g, "''");
        const out = execFileSync("psql", ["-tAq", "-v", "ON_ERROR_STOP=1", "-c", `set role service_role; select public.hs_heat_ingest('${lit}'::jsonb);`], { encoding: "utf8" }).trim();
        return { data: out === "t", error: null };
      },
    }),
  },
});
const { default: handler } = await import("../../api/hs-heat.js");

http.createServer(async (req, res) => {
  if (req.url === "/_calls") { res.end(JSON.stringify(calls)); return; }
  if (!req.url.startsWith("/api/hs-heat")) { res.statusCode = 204; res.setHeader("Access-Control-Allow-Origin", "*"); res.end(); return; }
  const r = {
    statusCode: 200,
    setHeader: (k, v) => res.setHeader(k, v),
    status(c) { this.statusCode = c; res.statusCode = c; return this; },
    json(b) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(b)); return this; },
    end() { res.end(); return this; },
  };
  await handler(req, r);
}).listen(Number(process.argv[2] || 3999));
console.log("hs-heat harness up");
