/* ONE ACCOUNT, LOOKED AT CLOSELY — 25 Sep 2026. OWNERS ONLY.
 *
 * Ryder: "so does this show more in depth why troy specifically spent more
 * tokens?" → "go ahead and build that layer."
 *
 * GET /api/ai-account?workspace=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Read only when an owner opens an account on the AI Cost page. One call to
 * admin_ai_account_detail (migration 0044): AI requests per Chicago hour and
 * job, the websites the account audited and how many pages got fixes, and
 * credits by feature. The page turns the hours into work sessions.
 */
import { requireMember, getAdminSupabase } from "../lib/supabase-server.js";
import { normalizeRange, rangeToInstants } from "../lib/money-range.js";
import { teamDate } from "../lib/brain-context.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_MS = 60_000;
const cache = new Map();

const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/* Postgres bigint arrives as a string. */
export function cleanDetail(d) {
  const x = d && typeof d === "object" ? d : {};
  return {
    hours: (x.hours || []).map((h) => ({
      hour: String(h.hour), job: h.job ?? null,
      calls: num(h.calls), ok: num(h.ok), failed: num(h.failed), sent: num(h.sent), written: num(h.written),
    })),
    sites: (x.sites || []).map((s) => ({
      domain: s.domain, audits: num(s.audits), firstAt: s.first_at || null, lastAt: s.last_at || null, fixedPages: num(s.fixed_pages),
    })),
    credits: (x.credits || []).map((c) => ({ feature: c.feature, source: c.source, charges: num(c.charges), units: num(c.units) })),
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req, ["owner"]);
  if (!member) return res.status(401).json({ error: "Owners only." });
  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "The server is missing its database key." });

  const q = req.query || {};
  const workspace = String(q.workspace || "");
  if (!UUID.test(workspace)) return res.status(400).json({ error: "Pick an account first." });
  const today = teamDate(Date.now());
  const range = normalizeRange({ from: q.from, to: q.to }, today);
  const key = `${workspace}|${range.from}|${range.to}`;
  const hit = cache.get(key);
  res.setHeader("Cache-Control", "private, no-store");
  if (hit && q.refresh !== "1" && Date.now() - hit.at < CACHE_MS) return res.status(200).json({ ...hit.body, cached: true });

  const w = rangeToInstants(range);
  const { data, error } = await admin.rpc("admin_ai_account_detail", {
    p_workspace: workspace,
    p_from: new Date(w.fromMs).toISOString(),
    p_to: new Date(w.toMs).toISOString(),
  });
  if (error) {
    const missing = /admin_ai_account_detail|function .* does not exist|schema cache/i.test(error.message || "");
    return res.status(missing ? 501 : 502).json({
      error: missing ? "This view needs database update 0044." : `Could not read this account: ${error.message}`,
      needsMigration: missing,
    });
  }
  const body = { workspace, range, ...cleanDetail(data), readAt: new Date().toISOString() };
  cache.set(key, { at: Date.now(), body });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return res.status(200).json(body);
}
