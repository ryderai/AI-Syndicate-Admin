/* POST /api/lead-scrape — run a saved lead search and put what it finds into
 * the pipeline. Also GET, for the daily scheduled run.
 *
 * WHAT THIS IS FOR
 * The platform already finds businesses that are invisible to AI search —
 * that is the product. Those are exactly the people who should be hearing
 * from us. This endpoint is the pipe between the two: a saved search runs,
 * the leads land on the Leads page already deduped and already handed to a
 * rep, and the rep sees them at the top of their queue in the morning.
 *
 * PROVIDERS — two, chosen by what exists
 *   platform : POST to the platform's own lead generator (PLATFORM_LEADGEN_URL).
 *              Preferred, because those leads come with a GEO score attached.
 *   apollo   : Apollo's people search (APOLLO_API_KEY), for contact details
 *              when the platform's rows have no human on them.
 *
 * Neither key exists in this project yet. That is deliberately not hidden:
 * with no key the endpoint returns 503 with the exact variable name, the
 * source card on the Leads page shows WAITING ON KEY, and nothing pretends
 * to have run. Never fake-live — same rule as every other integration here.
 *
 * MONEY
 * Provider calls cost money per search. Three things stop a runaway bill:
 * a per-run cap on the source (daily_cap, max 500), one page of results per
 * run and no automatic paging, and auto_daily defaulting to off so a source
 * only runs when somebody switched it on.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { recordAiUsage } from "../lib/ai-usage.js";
import {
  toLeadRow, dedupeKey, dedupeWithin, splitAgainstExisting,
  normalizeApollo, normalizePlatform, assignRoundRobin,
} from "../lib/lead-intake.js";

const PROVIDER_KEYS = {
  platform: "PLATFORM_LEADGEN_URL",
  apollo: "APOLLO_API_KEY",
};

export function providerReady(provider) {
  const name = PROVIDER_KEYS[provider];
  return Boolean(name && process.env[name]);
}

/* ------------------------------------------------------------------ */
/* Fetching from a provider                                            */
/* ------------------------------------------------------------------ */

async function fetchPlatform(query, limit) {
  const url = process.env.PLATFORM_LEADGEN_URL;
  const key = process.env.PLATFORM_LEADGEN_KEY;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: JSON.stringify({ ...query, limit }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    /* The vendor ANSWERED, with a refusal. Flagged so runSource can tell this
     * apart from never having reached them at all — a network drop or our own
     * 45s timeout is not a search anybody could have charged us for. */
    const err = new Error(`The platform's lead generator answered ${res.status}: ${text.slice(0, 160) || "no body"}`);
    err.vendorResponded = true;
    err.httpStatus = res.status;
    throw err;
  }
  const body = await res.json();
  // Accept the three shapes a JSON list arrives in rather than demanding one.
  const rows = Array.isArray(body) ? body : (body.leads || body.results || body.data || []);
  if (!Array.isArray(rows)) throw new Error("The lead generator did not return a list.");
  return rows.map(normalizePlatform);
}

async function fetchApollo(query, limit) {
  const res = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": process.env.APOLLO_API_KEY,
    },
    body: JSON.stringify({
      page: 1,
      per_page: Math.min(limit, 100),
      ...(query.keywords ? { q_keywords: query.keywords } : {}),
      ...(query.vertical ? { q_organization_keyword_tags: [query.vertical] } : {}),
      ...(query.city || query.state
        ? { person_locations: [[query.city, query.state].filter(Boolean).join(", ")] }
        : {}),
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    /* The vendor ANSWERED, with a refusal. Flagged so runSource can tell this
     * apart from never having reached them at all — a network drop or our own
     * 45s timeout is not a search anybody could have charged us for. */
    const err = new Error(`Apollo answered ${res.status}: ${text.slice(0, 160) || "no body"}`);
    err.vendorResponded = true;
    err.httpStatus = res.status;
    throw err;
  }
  const body = await res.json();
  const people = body?.people || body?.contacts || [];
  return people.map(normalizeApollo);
}

/* ------------------------------------------------------------------ */
/* Running one source                                                  */
/* ------------------------------------------------------------------ */

/** Runs one source end to end. Every exit writes the outcome back onto the
 * source row — including the failures. A scraper that fails quietly is worse
 * than one that never ran, because the pipeline looks calm instead of empty,
 * and the Notes page raises exactly that as a note. */
/** One lead search = one row on the AI Cost page.
 *
 * ⭐ BOTH PROVIDERS COST MONEY PER SEARCH and neither was recorded anywhere
 * before 8 Sep 2026, so the spend appeared on no screen at all — not even as a
 * call. Same shape as the platform's searchapi.io and zernio.com, which spent
 * money unseen for two months.
 *
 * `usage` is null on purpose: these are charged per search or per credit, not
 * per token. Inventing a token count would be a lie and a zero would say the
 * search was free. Both providers are in LOCAL_TOKENLESS_PROVIDERS so the row
 * is marked `tokenless` and NOT `tokensUnknown`, which would put a working
 * meter in the AI Cost page's metering-is-broken banner.
 *
 * ⭐ THE COST COLUMN WILL READ "NOT PRICED" AND A PRICE ROW WILL NOT CHANGE
 * THAT. `costMicros()` returns null whenever usage is null, before it ever
 * looks at a price, so a per-search fee cannot be expressed in the price book
 * as it stands — it needs the `per_call_micros` column that is still an open
 * item in both repos. Until that exists the honest reading of these rows is
 * "this many searches happened, and we cannot price them here".
 *
 * recordAiUsage never throws, so this can never break a scrape.
 *
 * @param billed  true only when the search SUCCEEDED. A vendor refusal may or
 *                may not have been charged and we do not know which, so it is
 *                written with billable:false rather than counted as our spend.
 */
async function recordLeadSearch({ admin, source, provider, actor, startedAt, ok, found, latencyMs, errorMessage = null, httpStatus = null }) {
  await recordAiUsage(admin, {
    provider: provider === "apollo" ? "apollo" : "platform-leadgen",
    model: provider === "apollo" ? "mixed_people/search" : "leadgen/search",
    usage: null,
    status: ok ? "ok" : "failed",
    errorCode: errorMessage ? String(errorMessage).slice(0, 120) : null,
    latencyMs,
    /* These two are validated against FEATURES and SURFACES in lib/ai-cost.js
     * and anything else is silently rewritten to "other" / "unknown" — which
     * is how the first version of this filed every Apollo row as
     * unattributable while looking correct. `leads` and `console` are NOT
     * valid values; `lead_scrape` and `leads` are. */
    feature: "lead_scrape",
    surface: "leads",
    userId: actor || null,
    entity: { kind: "lead_source", id: source?.id },
    /* ONE ROW PER SOURCE PER RUN, keyed on the RUN's own timestamp.
     *
     * The first version keyed on `new Date()` at record time, which was wrong
     * in both directions: two genuinely different runs of the same source
     * inside the same UTC minute collapsed to one row — and the unique index
     * on event_key is not partial, so the second REAL billed search was
     * silently dropped with 23505 deliberately not reported — while a Vercel
     * retry of a timed-out invocation landed in a later minute and was not
     * deduped at all. `startedAt` is stamped once per run, so a retry of that
     * run reuses it and two separate runs never share it. */
    eventKey: `${provider}:${source?.id}:${startedAt}`,
    billable: Boolean(ok),
    meta: {
      /* THE VENDOR'S OWN RECORD COUNT, which is what a per-search charge is
       * levied on. Deliberately not the same as `last_run_found` on the source
       * row: that one is counted AFTER toLeadRow() drops rows we cannot use,
       * so the two figures differ on the same run and neither is wrong. */
      found,
      perSearch: true,
      ...(httpStatus === null ? {} : { httpStatus }),
      ...(ok ? {} : { billedUnknown: true }),
    },
  });
}

export async function runSource(admin, source, { actor = null } = {}) {
  const startedAt = new Date().toISOString();
  const finish = async (patch) => {
    await admin.from("admin_lead_sources").update({ last_run_at: startedAt, ...patch }).eq("id", source.id);
  };

  const provider = source.provider;
  if (!provider) {
    const msg = "This source has no provider set, so there is nothing to ask.";
    await finish({ last_run_error: msg, last_run_found: 0, last_run_new: 0 });
    return { ok: false, error: msg };
  }
  if (!providerReady(provider)) {
    const msg = `Waiting on ${PROVIDER_KEYS[provider]} — the key is not set on this deployment.`;
    await finish({ last_run_error: msg, last_run_found: 0, last_run_new: 0 });
    return { ok: false, waitingOnKey: PROVIDER_KEYS[provider], error: msg };
  }

  const limit = Math.min(Math.max(source.daily_cap || 50, 1), 500);
  const query = source.query || {};

  let raw;
  const calledAt = Date.now();
  try {
    raw = provider === "apollo" ? await fetchApollo(query, limit) : await fetchPlatform(query, limit);
  } catch (err) {
    const msg = err?.message || "The search failed.";
    /* RECORD THE FAILED SEARCH TOO. Apollo bills per credit and a search that
     * errored after the vendor accepted it can still have been charged. A
     * failure we do not record is the same hole as a success we do not
     * record — it is just harder to notice. */
    /* Only if they actually answered. A network drop or our own timeout is not
     * a search anybody could have billed, and recording it would inflate the
     * call count with attempts that never reached the vendor. */
    if (err?.vendorResponded) {
      await recordLeadSearch({
        admin, source, provider, actor, startedAt, ok: false, found: 0,
        latencyMs: Date.now() - calledAt, errorMessage: msg, httpStatus: err.httpStatus ?? null,
      });
    }
    await finish({ last_run_error: msg, last_run_found: 0, last_run_new: 0 });
    return { ok: false, error: msg };
  }
  await recordLeadSearch({
    admin, source, provider, actor, startedAt, ok: true,
    found: raw.length, latencyMs: Date.now() - calledAt,
  });

  const rows = raw
    .map((r) => toLeadRow(r, { source: "scraper", sourceId: source.id }))
    .filter(Boolean);
  const { kept } = dedupeWithin(rows);

  // Check against what is already in the pipeline. Reading only the keys of
  // the rows that could match keeps this one small query rather than the whole
  // leads table.
  const keys = kept.map((r) => dedupeKey(r)).filter(Boolean);
  const existingKeys = new Set();
  if (keys.length) {
    // Chunked: a very long `in` list is what turns a working query into a URL
    // the database rejects.
    for (let i = 0; i < keys.length; i += 100) {
      const { data } = await admin.from("admin_leads")
        .select("dedupe_key").in("dedupe_key", keys.slice(i, i + 100));
      for (const row of data || []) if (row.dedupe_key) existingKeys.add(row.dedupe_key);
    }
  }
  const { fresh, already } = splitAgainstExisting(kept, existingKeys);

  if (!fresh.length) {
    await finish({ last_run_error: null, last_run_found: rows.length, last_run_new: 0 });
    return { ok: true, found: rows.length, added: 0, duplicates: already.length };
  }

  // Hand them out. Where the run starts in the rotation comes from how many
  // leads this source has produced already, so two runs in a day do not both
  // dump everything on the first rep.
  const { count: soFar } = await admin.from("admin_leads")
    .select("id", { count: "exact", head: true }).eq("source_id", source.id);
  const owners = assignRoundRobin(fresh, source.assign_to || [], soFar || 0);
  const stamped = fresh.map((r, i) => ({
    ...r,
    owner_id: owners[i],
    last_import_at: startedAt,
    raw: { provider, query },
  }));

  const { data, error } = await admin.from("admin_leads").insert(stamped).select("id");
  if (error) {
    await finish({ last_run_error: `Saving failed: ${error.message}`, last_run_found: rows.length, last_run_new: 0 });
    return { ok: false, error: error.message, found: rows.length };
  }

  await finish({ last_run_error: null, last_run_found: rows.length, last_run_new: data?.length || 0 });

  if (actor) {
    admin.from("admin_activity_log").insert({
      actor, kind: "leads_scraped",
      title: `${data?.length || 0} new leads from ${source.label}`,
      body: `${rows.length} found, ${already.length} already in the pipeline.`,
    }).then(() => {}, () => {});
  }

  return { ok: true, found: rows.length, added: data?.length || 0, duplicates: already.length };
}

/* ------------------------------------------------------------------ */
/* The endpoint                                                        */
/* ------------------------------------------------------------------ */

export default async function handler(req, res) {
  const admin = getAdminSupabase();
  if (!admin) return res.status(503).json({ error: "Waiting on the Supabase keys." });

  /* GET = the daily scheduled run. Authorised by CRON_SECRET, never by a
   * session — there is no person behind it. Without the secret set, the
   * scheduled path is simply closed rather than open. */
  if (req.method === "GET") {
    const secret = process.env.CRON_SECRET;
    const given = req.headers?.authorization || "";
    if (!secret || given !== `Bearer ${secret}`) {
      return res.status(401).json({ error: "Not authorized." });
    }
    const { data: sources, error } = await admin.from("admin_lead_sources")
      .select("*").eq("active", true).eq("auto_daily", true).eq("kind", "scraper");
    if (error) return res.status(500).json({ error: error.message });

    const results = [];
    // One at a time on purpose. These are paid, rate-limited calls, and a
    // provider that starts refusing halfway through should stop the run, not
    // hammer it in parallel.
    for (const s of sources || []) {
      results.push({ source: s.label, ...(await runSource(admin, s)) });
    }
    return res.status(200).json({ ran: results.length, results });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  // Running a source spends money, so it is an admin action even though every
  // member can read the source list.
  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const body = await readJson(req);
  const sourceId = String(body?.source_id || "").trim();
  if (!sourceId) return res.status(400).json({ error: "Which source? source_id is missing." });

  const { data: source, error } = await admin.from("admin_lead_sources")
    .select("*").eq("id", sourceId).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!source) return res.status(404).json({ error: "No lead source with that id." });
  if (!source.active) return res.status(400).json({ error: "That source is switched off." });

  const result = await runSource(admin, source, { actor: member.membership.user_id });
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(result.ok ? 200 : (result.waitingOnKey ? 503 : 502)).json(result);
}
