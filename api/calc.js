/* POST /api/calc — the AI Revenue Calculator on www.aisyndicate.com. 24 Sep 2026.
 *
 * One endpoint, two kinds of post, same public door as /api/hs-event and
 * /api/hs-lead (lib/hs-http.js: an allow-listed Origin, an 8KB body cap, a
 * per-session rate limit). The calculator page holds no key.
 *
 *   { kind: "run",  run_key, session_id, page_path, industry, inputs, result, … }
 *       Saves the numbers of one calculation into calc_runs, upserted on
 *       run_key. No person in it. Answers 204 always — a stats beacon is never
 *       why a visitor sees something break.
 *
 *   { kind: "lead", …the same run fields…, name, email, website }
 *       Saves the run too (so the numbers exist even if the beacon never
 *       landed), then makes the person an admin_leads row — deduped on email,
 *       blanks filled, never overwritten, exactly like /api/hs-lead — writes
 *       the numbers on the lead as a note, and links the run to the lead.
 *       Answers { ok, lead_id, created }. A lead that could not be saved is a
 *       500 the page can see, because the page then keeps the email box open
 *       and falls back to the platform's own /api/lead.
 *
 * Every object handed to Supabase below is written INLINE, key by key, with
 * no spread: tests/calculator/columns.mjs reads these literals against the
 * real CREATE TABLE, and a spread is invisible to it.
 */

import { getAdminSupabase, isServerConfigured } from "../lib/supabase-server.js";
import { applyCors, readCappedJson, allowHit } from "../lib/hs-http.js";
import { normaliseEmail, hostFromWebsite, clean, digitsOnly } from "../lib/home-services.js";
import { cleanRun, leadNote, CALC_VERTICAL } from "../lib/calculator.js";
import { cleanConsent, consentNote, recordConsent } from "../lib/lead-consent.js";

const RUN_LIMIT = 60;    // per session per minute — the page debounces to ~1 every 3s while typing
const LEAD_LIMIT = 6;
const WINDOW_MS = 60_000;

const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";

export default async function handler(req, res) {
  const cors = applyCors(req, res);
  if (!cors.ok) return undefined;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const read = await readCappedJson(req);
  if (!read.ok) return res.status(400).json({ ok: false, error: read.error });
  const b = read.body || {};
  const kind = b.kind === "lead" ? "lead" : b.kind === "run" ? "run" : null;
  if (!kind) return res.status(400).json({ ok: false, error: "Unknown kind." });

  const cleaned = cleanRun(b);
  if (!cleaned.ok) return res.status(400).json({ ok: false, error: cleaned.error });
  const row = cleaned.row;
  /* The scanned website names a business, and a sole trader's names a
   * person. Kept only once they choose to leave an email. */
  if (kind === "run") row.scanned_domain = null;

  const who = row.session_id || row.run_key;
  if (!allowHit(`calc:${kind}:${who}`, kind === "lead" ? LEAD_LIMIT : RUN_LIMIT, WINDOW_MS)) {
    return res.status(429).json({ ok: false, error: "Too many posts from that visit." });
  }

  if (!isServerConfigured()) {
    console.error("[calc] refused: Supabase is not configured on this deployment");
    if (kind === "run") return res.status(204).end();
    return res.status(503).json({ ok: false, error: "The lead could not be saved. Nothing is configured to receive it." });
  }

  const admin = getAdminSupabase();
  const nowIso = new Date().toISOString();

  /* ---- the numbers. For a run this is the whole job. ---- */
  let saved = await saveRun(admin, row, nowIso);
  if (!saved && kind === "lead") saved = await saveRun(admin, row, nowIso);   // one retry: a lead's numbers matter
  if (kind === "run") return res.status(204).end();
  if (!saved) console.error("[calc] lead arrived but its run row did not save; the lead is still saved below");

  /* ---- the person ---- */
  const email = normaliseEmail(b.email);
  const name = clean(b.name, 160);
  /* Julia, 24 Sep 2026: "is it possible to add a phone number field". The
   * page requires it (Ryder: "dont make it optional"); this endpoint stays
   * lenient so a page cached from before the change never loses a lead over
   * it. Digits only, like every other phone in this console; fewer than
   * 10 digits is not a number anybody can ring, so it is dropped, not stored. */
  const phoneDigits = digitsOnly(b.phone);
  const phone = phoneDigits && phoneDigits.length >= 10 && phoneDigits.length <= 15 ? phoneDigits : null;
  if (!email) return res.status(400).json({ ok: false, error: "Please add a real email address." });
  const domain = hostFromWebsite(b.website) || row.scanned_domain || null;
  /* 25 Sep 2026: proof of consent (lib/lead-consent.js, migration 0045). */
  const consent = cleanConsent(b.consent);
  const note = leadNote(row, nowIso) + (consent ? `\n${consentNote(consent, row.page_path, nowIso)}` : "");

  try {
    const existing = await findByEmail(admin, email);
    let leadId = null;
    let created = false;

    if (existing) {
      leadId = existing.id;
      const patch = { last_activity_at: nowIso };
      if (isBlank(existing.name) && name) patch.name = name;
      if (isBlank(existing.domain) && domain) patch.domain = domain;
      if (isBlank(existing.phone) && phone) patch.phone = phone;
      const { error } = await admin.from("admin_leads").update(patch).eq("id", leadId);
      if (error) {
        console.error("[calc] lead update failed", error.message);
        return res.status(500).json({ ok: false, error: "That lead could not be updated." });
      }
      /* Appended inside the database (0037), so two posts a second apart
       * cannot read the same old notes and erase each other's line. */
      const { error: noteErr } = await admin.rpc("hs_append_lead_note", { p_lead: leadId, p_note: note });
      if (noteErr) console.error("[calc] note append failed", noteErr.message);
    } else {
      const { data, error } = await admin.from("admin_leads").insert({
        name,
        domain,
        email,
        phone,
        /* Legal on the live check constraint since 0009/0030. */
        source: "inbound",
        stage: "new",
        /* The business type they picked. The Sales page filters on it. */
        vertical: CALC_VERTICAL[row.industry] || row.industry,
        notes: note,
        last_activity_at: nowIso,
      }).select("id").maybeSingle();
      if (error || !data?.id) {
        console.error("[calc] lead insert failed", error?.message || "no row returned");
        return res.status(500).json({ ok: false, error: "That lead could not be saved." });
      }
      leadId = data.id;
      created = true;
    }

    if (consent) await recordConsent(admin, req, leadId, consent, { source: "calc", pagePath: row.page_path });

    /* Link the numbers to the person. Logged and swallowed: the lead is saved,
     * and its note already carries the numbers. */
    let { error: linkErr } = await admin.from("calc_runs")
      .update({ lead_id: leadId, updated_at: nowIso })
      .eq("run_key", row.run_key);
    if (linkErr) {
      ({ error: linkErr } = await admin.from("calc_runs")
        .update({ lead_id: leadId, updated_at: nowIso })
        .eq("run_key", row.run_key));
      /* Still swallowed for the visitor — the lead IS saved — but the Calculator
       * page also lists leads by the note this endpoint wrote, so it is not hidden. */
      if (linkErr) console.error("[calc] run link failed twice", linkErr.message);
    }

    return res.status(200).json({ ok: true, lead_id: leadId, created });
  } catch (err) {
    console.error("[calc] threw", err?.message || err);
    return res.status(500).json({ ok: false, error: "That lead could not be saved." });
  }
}

/** Upsert one calculation on run_key. lead_id is NOT in this object, so a
 * later beacon can never unlink a lead. Returns true when it landed. */
async function saveRun(admin, row, nowIso) {
  const { error } = await admin.from("calc_runs").upsert({
    run_key: row.run_key,
    session_id: row.session_id,
    page_path: row.page_path,
    industry: row.industry,
    leads_per_month: row.leads_per_month,
    close_rate: row.close_rate,
    client_value: row.client_value,
    ai_share: row.ai_share,
    ai_score: row.ai_score,
    score_measured: row.score_measured,
    scanned_domain: row.scanned_domain,
    target_score: row.target_score,
    yearly_revenue: row.yearly_revenue,
    clients_per_year: row.clients_per_year,
    margin: row.margin,
    repeat_buys: row.repeat_buys,
    ad_spend: row.ad_spend,
    edited: row.edited,
    added_revenue: row.added_revenue,
    added_revenue_year_one: row.added_revenue_year_one,
    added_profit: row.added_profit,
    lifetime_revenue: row.lifetime_revenue,
    extra_leads_year: row.extra_leads_year,
    extra_clients_year: row.extra_clients_year,
    capped: row.capped,
    warnings: row.warnings,
    plan_key: row.plan_key,
    referrer_host: row.referrer_host,
    utm_source: row.utm_source,
    utm_medium: row.utm_medium,
    utm_campaign: row.utm_campaign,
    device: row.device,
    updated_at: nowIso,
  }, { onConflict: "run_key" });
  if (error) { console.error("[calc] run upsert failed", error.message); return false; }
  return true;
}

/** The OLDEST lead with that email, or null. ilike to ask, exact to answer —
 * the same reason as api/hs-lead.js findByEmail. */
async function findByEmail(admin, email) {
  const { data, error } = await admin
    .from("admin_leads")
    .select("id, name, domain, email, phone, created_at")
    .ilike("email", email)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) { console.error("[calc] dedupe read failed", error.message); return null; }
  return (data || []).find((r) => String(r.email || "").trim().toLowerCase() === email) || null;
}
