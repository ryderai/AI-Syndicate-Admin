/* GET /api/ai-cost?from=YYYY-MM-DD&to=YYYY-MM-DD[&refresh=1]
 *
 * THE AI COST PAGE'S ONE READ — 24 Sep 2026. Owners only.
 *
 * WHY THIS EXISTS. The AI Cost page and the Finance page both used to pull
 * the whole usage log into the browser — 51,230 rows on 24 Sep 2026, read
 * 1,000 at a time, one request after another. Measured on the live console:
 * 20 to 30 seconds before anything drew, and past 50,000 rows the reader hit
 * its own cap, so the totals were short. It only gets worse: the platform
 * writes roughly 2,800 rows a day.
 *
 * Now the database groups the rows (admin_ai_cost_rollup, migration 0041) and
 * this endpoint hands back a few hundred grouped rows plus the names that go
 * with them. If 0041 has not been run yet, it reads the rows itself, a day at
 * a time and several days at once, and groups them here — slower, but the
 * same answer, so nothing waits on the SQL.
 *
 * EVERY ROW LEAVES WITH A TAG. Ryder: "we need to make sure all usage gets a
 * tag. so if a account uses a credit it needs to be added as usage under that
 * account." So each group carries:
 *   account  the platform workspace that ran it (name + domain + owner's
 *            email, read from the platform's own `workspaces` table, which
 *            lives in this same database) — or the client, or the console —
 *            or, for public tools and internal jobs that have no account,
 *            says exactly that.
 *   job      the platform's job name, else the tool that made the call, else
 *            the endpoint it ran under. The platform stamps the last two on
 *            every call since 23 Sep 2026; older rows without them say so.
 * And, beside the money, the CREDITS each workspace used in the window, from
 * the platform's plan_token_ledger.
 */

import { requireMember, getAdminSupabase } from "../lib/supabase-server.js";
import { normalizeRange, rangeToInstants, daysIn, addDays } from "../lib/money-range.js";
import { teamDate } from "../lib/brain-context.js";

const CACHE_MS = 60_000;
const cache = new Map();

/* Rows are read in these columns only when the SQL rollup is missing. */
/* Only the two meta keys the job label needs — `meta` itself carries a call
 * stack per row since 23 Sep, and pulling it whole made the scan slow. */
const SCAN_COLS = "ts, provider, model, workspace_id, client_id, platform_feature, feature, surface, status, source, cost_micros, billable, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, feature_name:meta->>feature_name, entry:meta->>entry";
const SCAN_PAGE = 1000;
const SCAN_PARALLEL = 6;
const SCAN_MAX_ROWS = 400_000;

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function jobOf(row) {
  const meta = row.meta && typeof row.meta === "object" ? row.meta : { feature_name: row.feature_name, entry: row.entry };
  const pf = String(row.platform_feature || "").trim();
  if (pf) return pf;
  const fname = String(meta.feature_name || "").trim();
  if (fname) return fname;
  const entry = String(meta.entry || "").trim();
  if (entry) return entry;
  if (row.feature && row.feature !== "other") return `console · ${row.feature}`;
  return null;
}

function keyOf(r) {
  return [r.day, r.provider, r.model, r.workspace_id, r.client_id, r.job, r.surface, r.status, r.source].join("\u0001");
}

/** Group raw rows exactly the way admin_ai_cost_rollup does. */
export function groupRows(rows) {
  const out = new Map();
  for (const e of rows) {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    /* `?? null`, not `|| null`: the SQL keeps an empty string as itself, so
     * the two paths must too, or the same data groups differently. */
    const g = {
      day: teamDate(t),
      provider: e.provider ?? null,
      model: e.model ?? null,
      workspace_id: e.workspace_id ?? null,
      client_id: e.client_id ?? null,
      job: jobOf(e),
      surface: e.surface ?? null,
      status: e.status ?? null,
      source: e.source ?? null,
    };
    const k = keyOf(g);
    let cur = out.get(k);
    if (!cur) {
      cur = { ...g, calls: 0, priced_calls: 0, cost_micros: 0, nonbillable_calls: 0, input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, first_ts: e.ts, last_ts: e.ts };
      out.set(k, cur);
    }
    cur.calls += 1;
    /* A non-billable call is not spend — lib/ai-cost.js has always left it
     * out of the dollar total. Counted on its own instead. */
    if (e.billable === false) {
      cur.nonbillable_calls += 1;
    } else if (e.cost_micros !== null && e.cost_micros !== undefined) {
      cur.priced_calls += 1;
      cur.cost_micros += n(e.cost_micros);
    }
    cur.input_tokens += n(e.input_tokens);
    cur.output_tokens += n(e.output_tokens);
    cur.cache_write_tokens += n(e.cache_write_tokens);
    cur.cache_read_tokens += n(e.cache_read_tokens);
    if (e.ts < cur.first_ts) cur.first_ts = e.ts;
    if (e.ts > cur.last_ts) cur.last_ts = e.ts;
  }
  return [...out.values()];
}

/* Postgres bigint arrives as a string. Every number crosses this once. */
function cleanRollupRow(r) {
  return {
    day: String(r.day).slice(0, 10),
    provider: r.provider, model: r.model,
    workspace_id: r.workspace_id, client_id: r.client_id,
    job: r.job, surface: r.surface, status: r.status, source: r.source,
    calls: n(r.calls), priced_calls: n(r.priced_calls), cost_micros: n(r.cost_micros),
    nonbillable_calls: n(r.nonbillable_calls),
    input_tokens: n(r.input_tokens), output_tokens: n(r.output_tokens),
    cache_write_tokens: n(r.cache_write_tokens),
    cache_read_tokens: n(r.cache_read_tokens),
    first_ts: r.first_ts, last_ts: r.last_ts,
  };
}

/* The function returns ONE jsonb array, not a table: PostgREST caps a table
 * reply at 1,000 rows, and a month can hold more groups than that. A reply
 * that is not an array is an older copy of the function — treated as missing
 * so the scan runs instead of trusting a possibly cut-short answer. */
async function readViaSql(admin, fromIso, toIso) {
  const { data, error } = await admin.rpc("admin_ai_cost_rollup", { p_from: fromIso, p_to: toIso });
  if (error) return { ok: false, error };
  if (!Array.isArray(data) || (data.length && typeof data[0] !== "object")) return { ok: false, error: { message: "unexpected shape" } };
  return { ok: true, rows: data.map(cleanRollupRow) };
}

/* One day's rows, paged. A day is ~3,000 rows today, so three pages. Ordered
 * on ts AND id: ts alone is not unique, and an unstable order across two
 * range requests hands back some rows twice and others never. */
async function scanWindow(admin, fromIso, toIso) {
  const rows = [];
  for (let page = 0; ; page += 1) {
    const { data, error } = await admin
      .from("admin_usage_events").select(SCAN_COLS)
      .gte("ts", fromIso).lt("ts", toIso)
      .order("ts", { ascending: true }).order("id", { ascending: true })
      .range(page * SCAN_PAGE, (page + 1) * SCAN_PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < SCAN_PAGE) break;
    if (rows.length > SCAN_MAX_ROWS) throw new Error("more than 400,000 rows in one day");
  }
  return rows;
}

async function readViaScan(admin, range) {
  const days = daysIn(range, 1200);
  const groups = [];
  let rowCount = 0;
  for (let i = 0; i < days.length; i += SCAN_PARALLEL) {
    const slice = days.slice(i, i + SCAN_PARALLEL);
    const parts = await Promise.all(slice.map((d) => {
      const w = rangeToInstants({ from: d, to: d });
      return scanWindow(admin, new Date(w.fromMs).toISOString(), new Date(w.toMs).toISOString());
    }));
    for (const p of parts) { rowCount += p.length; groups.push(...groupRows(p)); }
    if (rowCount > SCAN_MAX_ROWS) return { rows: groups, rowCount, truncated: true };
  }
  return { rows: groups, rowCount, truncated: false };
}

async function readCredits(admin, fromIso, toIso) {
  const rpc = await admin.rpc("admin_credit_rollup", { p_from: fromIso, p_to: toIso });
  if (!rpc.error && Array.isArray(rpc.data)) {
    return {
      via: "sql",
      rows: (rpc.data || []).map((r) => ({
        workspace_id: r.workspace_id, feature: r.feature,
        spent: n(r.spent), refunded: n(r.refunded), spends: n(r.spends),
      })),
    };
  }
  /* No function yet (0041 not run): read the ledger directly. It is the
   * platform's table and the service key can read it. */
  /* Paged, and ordered so the pages do not overlap: one request returns at
   * most 1,000 rows whatever .limit() says. */
  const data = [];
  let truncated = false;
  for (let page = 0; ; page += 1) {
    const res = await admin
      .from("plan_token_ledger")
      .select("workspace_id, feature, delta, reason")
      .gte("created_at", fromIso).lt("created_at", toIso)
      .in("reason", ["spend", "shadow_spend", "refund"])
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (res.error) return { via: "none", rows: [], error: res.error.message };
    data.push(...(res.data || []));
    if (!res.data || res.data.length < 1000) break;
    if (page >= 49) { truncated = true; break; }
  }
  const by = new Map();
  for (const r of data) {
    const k = `${r.workspace_id}\u0001${r.feature || ""}`;
    const cur = by.get(k) || { workspace_id: r.workspace_id, feature: r.feature || null, spent: 0, refunded: 0, spends: 0 };
    if (r.reason === "refund") cur.refunded += n(r.delta);
    else { cur.spent += -n(r.delta); cur.spends += 1; }
    by.set(k, cur);
  }
  return { via: "scan", rows: [...by.values()], truncated };
}

/* Names for every workspace, client and person that appears. */
async function readNames(admin, rows, credits) {
  const wsIds = [...new Set([...rows.map((r) => r.workspace_id), ...credits.map((c) => c.workspace_id)].filter(Boolean))];
  const clientIds = new Set(rows.map((r) => r.client_id).filter(Boolean));
  const workspaces = {};
  const notes = [];

  if (wsIds.length) {
    /* Columns checked against the live table on 24 Sep 2026. In chunks of 100
     * so a long id list cannot outgrow the request URL. */
    const data = [];
    for (let i = 0; i < wsIds.length; i += 100) {
      const res = await admin
        .from("workspaces")
        .select("id, name, domain, owner_id, stripe_customer_id, stripe_subscription_status, plan_id, product, created_at")
        .in("id", wsIds.slice(i, i + 100));
      if (res.error) { notes.push(`platform workspaces could not be read: ${res.error.message}`); break; }
      data.push(...(res.data || []));
    }
    const owners = [...new Set(data.map((w) => w.owner_id).filter(Boolean))];
    let emails = {};
    if (owners.length) {
      const p = await admin.from("profiles").select("id, email, full_name").in("id", owners);
      if (!p.error) emails = Object.fromEntries((p.data || []).map((x) => [x.id, x]));
    }
    for (const w of data) {
      workspaces[w.id] = {
        name: w.name || null,
        domain: w.domain || null,
        ownerEmail: emails[w.owner_id]?.email || null,
        ownerName: emails[w.owner_id]?.full_name || null,
        stripeCustomerId: w.stripe_customer_id || null,
        subscriptionStatus: w.stripe_subscription_status || null,
        plan: w.plan_id || null,
        product: w.product || null,
        createdAt: w.created_at || null,
      };
    }
    /* Which of our clients each workspace belongs to, where someone said. */
    const links = await admin.from("admin_platform_workspaces").select("workspace_id, client_id, label").in("workspace_id", wsIds);
    for (const l of links.data || []) {
      const w = workspaces[l.workspace_id] || (workspaces[l.workspace_id] = {});
      w.clientId = l.client_id || null;
      if (!w.name && l.label) w.name = l.label;
      if (l.client_id) clientIds.add(l.client_id);
    }
  }

  const clients = {};
  if (clientIds.size) {
    const { data } = await admin.from("admin_clients").select("id, name").in("id", [...clientIds]);
    for (const c of data || []) clients[c.id] = c.name;
  }
  return { workspaces, clients, notes };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  /* Owners only — Ryder, Andrew, CJ. 24 Sep 2026. */
  const member = await requireMember(req, ["owner"]);
  if (!member) return res.status(401).json({ error: "Owners only." });
  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "The server is missing its database key." });

  const today = teamDate(Date.now());
  const q = req.query || {};
  const range = normalizeRange({ from: q.from, to: q.to }, today);
  const key = `${range.from}|${range.to}`;
  const hit = cache.get(key);
  if (hit && q.refresh !== "1" && Date.now() - hit.at < CACHE_MS) {
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({ ...hit.body, cached: true });
  }

  const started = Date.now();
  const w = rangeToInstants(range);
  const fromIso = new Date(w.fromMs).toISOString();
  const toIso = new Date(w.toMs).toISOString();

  try {
    let via = "sql";
    let rows;
    let rowCount = null;
    let truncated = false;
    const sql = await readViaSql(admin, fromIso, toIso);
    if (sql.ok) {
      rows = sql.rows;
      rowCount = rows.reduce((s, r) => s + r.calls, 0);
    } else {
      via = "scan";
      const scan = await readViaScan(admin, range);
      rows = scan.rows;
      rowCount = scan.rowCount;
      truncated = scan.truncated;
    }
    const credits = await readCredits(admin, fromIso, toIso);
    /* The first day anything was metered — the month picker starts there
     * instead of offering a row of empty months. One indexed row (ts desc
     * index read backwards). */
    const first = await admin.from("admin_usage_events").select("ts").order("ts", { ascending: true }).limit(1);
    const earliest = first.data?.[0]?.ts ? teamDate(Date.parse(first.data[0].ts)) : null;
    const names = await readNames(admin, rows, credits.rows);

    const body = {
      range,
      today,
      via,
      rowCount,
      truncated,
      rows,
      credits: credits.rows,
      creditsVia: credits.via,
      creditsError: credits.error || null,
      workspaces: names.workspaces,
      clients: names.clients,
      notes: names.notes,
      /* The first day the platform stamped every call with the tool that made
       * it (platform commit b20d1134). A row with no job before this is an
       * old row, not a gap in today's tagging. */
      taggingSince: "2026-09-23",
      earliest,
      ms: Date.now() - started,
      readAt: new Date().toISOString(),
    };
    cache.set(key, { at: Date.now(), body });
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json(body);
  } catch (err) {
    return res.status(502).json({ error: `Could not read the usage log: ${err.message}` });
  }
}

// Exported for tests.
export const __test = { groupRows, jobOf, cleanRollupRow, addDays };
