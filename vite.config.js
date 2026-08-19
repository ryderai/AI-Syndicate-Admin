import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* Dev-time /api runner.
 *
 * On Vercel each file in /api is its own serverless function. `vite dev` knows
 * nothing about that, so before this existed every API card read "waiting on
 * key" locally and nothing server-side could be tested without deploying.
 *
 * This mounts every api/<name>.js at /api/<name> with the same request and
 * response shape Vercel gives the handler (req.query, req.body,
 * res.status().json(), res.redirect). Same idea as the platform's
 * devApiPlugin, just generic instead of one block per route.
 *
 * Known differences from Vercel, deliberately left alone (dev only):
 *  - Vercel 308-redirects a trailing slash; here /api/health/ just works.
 *  - Vercel rejects bodies over 4.5MB with a 413; the cap here is our own.
 *  - Unknown content types arrive as a string here, a Buffer on Vercel.
 */
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;
// One path segment, no slashes, no dots — so nothing can climb out of api/.
const ROUTE_NAME = /^[A-Za-z0-9_-]+$/;

function devApiPlugin(env) {
  // Server-side code reads process.env, and Vite only exposes VITE_ vars to the
  // browser, so push every value from .env.local into process.env here.
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  const apiDir = path.resolve(process.cwd(), "api");

  return {
    name: "dev-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.originalUrl || req.url || "";
        if (!rawUrl.startsWith("/api/")) return next();

        const url = new URL(rawUrl, "http://localhost");
        const name = decodeURIComponent(url.pathname.replace(/^\/api\//, "").replace(/\/+$/, ""));

        const send = (code, payload) => {
          if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(payload));
        };

        if (!ROUTE_NAME.test(name)) return send(404, { error: "No such API route." });
        const file = path.join(apiDir, name + ".js");
        // Belt and braces: the regex already forbids separators, but never
        // import a file that resolved outside api/.
        if (path.dirname(file) !== apiDir || !fs.existsSync(file)) {
          return send(404, { error: `No API route named ${name}.` });
        }

        // Vercel-shaped request. Repeated params come back as an array there,
        // so do the same here or a handler can pass locally and fail in prod.
        req.query = {};
        for (const key of new Set(url.searchParams.keys())) {
          const all = url.searchParams.getAll(key);
          req.query[key] = all.length > 1 ? all : all[0];
        }

        if (req.method !== "GET" && req.method !== "HEAD") {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) return send(413, { error: "Request body too large." });
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          req.body = raw;
          if (raw && (req.headers["content-type"] || "").includes("application/json")) {
            try { req.body = JSON.parse(raw); } catch { /* the handler decides */ }
          }
        }

        // Vercel-shaped response.
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (payload) => {
          if (!res.headersSent && !res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(payload));
          return res;
        };
        res.send = (payload) => { res.end(typeof payload === "string" ? payload : JSON.stringify(payload)); return res; };
        res.redirect = (codeOrUrl, maybeUrl) => {
          const code = typeof codeOrUrl === "number" ? codeOrUrl : 302;
          res.statusCode = code;
          res.setHeader("Location", typeof codeOrUrl === "number" ? maybeUrl : codeOrUrl);
          res.end();
          return res;
        };

        try {
          // Cache-bust so edits to an api file take effect without a restart.
          const mod = await import(pathToFileURL(file).href + "?t=" + fs.statSync(file).mtimeMs);
          if (typeof mod.default !== "function") {
            return send(500, { error: `api/${name}.js has no default export.` });
          }
          await mod.default(req, res);
          if (!res.writableEnded) res.end();
        } catch (err) {
          // The real message goes to the terminal only. Client errors can carry
          // request URLs and credential fragments, and on Vercel a crash is
          // opaque anyway — so don't teach yourself to rely on it locally.
          server.config.logger.error(`[dev-api] ${name}: ${err?.stack || err}`);
          send(500, { error: "That API route crashed. The reason is in the terminal running npm run dev." });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // "" prefix = load every variable, not just the VITE_ ones.
  const env = loadEnv(mode, process.cwd(), "");
  return { plugins: [react(), devApiPlugin(env)] };
});
