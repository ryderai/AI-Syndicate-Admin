/* POST /api/hs-lead — somebody filled the form on a landing page.
 *
 * The other half of /api/hs-event: that one counts what happened, this one
 * turns a form fill into a row on the Sales page. Public, for the same reason
 * and behind the same door (lib/hs-http.js): an allow-listed Origin, a body
 * cap and a rate limit stand in for a login that cannot exist.
 *
 *   Body: {
 *     page_slug, session_id,
 *     name, company, email, phone, city, state, zip, website,
 *     reached_checkout, paid,
 *     utm: { source, medium, campaign, content, term },
 *     best_time, kind
 *   }
 *   Returns: { ok: true, lead_id, created: true|false, updated: true|false }
 *
 * ============================================================
 * THE FOUR THINGS THIS FILE DOES, AND WHY EACH IS THE WAY IT IS
 * ============================================================
 *
 * 1. IT DEDUPES BEFORE IT INSERTS. The same person fills the form on the lawn
 *    page and again on the pressure-washing page a week later. Two rows means
 *    two reps ringing one man, and it means the second row has none of the
 *    first one's history. So: an existing lead with the same lower(email) is
 *    UPDATED. `created` / `updated` in the answer says which happened, because
 *    a caller that cannot tell them apart cannot tell a working form from one
 *    that silently overwrites.
 *
 * 2. AN UPDATE FILLS BLANKS AND NOTHING ELSE. If the console already holds a
 *    phone number, a form that arrives with a different one does NOT replace
 *    it. Somebody in this business may have corrected that field by hand; a
 *    stranger typing into a marketing page does not get to undo that. The one
 *    exception is `notes`, which is APPENDED to — appending loses nothing, so
 *    it is not an overwrite, and dropping the record of a second capture
 *    entirely would be worse than either.
 *
 * 3. IT DOES NOT WRITE A TIMELINE ROW, and that is a deliberate gap.
 *    admin_lead_activity.actor is `uuid not null references auth.users`
 *    (migration 0001) — every line on a lead's timeline is filed under the
 *    PERSON who did it. A service-role insert has no auth.uid(), and the
 *    visitor is not a user of this console. There is no honest value to put in
 *    that column. Inventing one — the owner's id, a fake "system" user — would
 *    put a stranger's form fill on the timeline under a real person's name,
 *    and this console has already been burned once by exactly that shape of
 *    forgery (migration 0023, "A FORGED AUTHOR"). So the capture is recorded
 *    in the lead's `notes` and in hs_lead_sources, both of which are true, and
 *    the timeline stays a record of what PEOPLE did. CONTEXT §61 says what it
 *    would take to close this properly.
 *
 * 4. IT NEVER 500s AT THE VISITOR over bookkeeping. The lead row is the thing
 *    that matters. If hs_lead_sources or the event back-fill fails afterwards,
 *    that is logged and the answer is still ok — refusing the whole call would
 *    throw away a lead to protect a statistic.
 */

import { getAdminSupabase, isServerConfigured } from "../lib/supabase-server.js";
import { applyCors, readCappedJson, allowHit } from "../lib/hs-http.js";
import {
  isPageSlug, normaliseEmail, digitsOnly, hostFromWebsite, clean, captureNote,
} from "../lib/home-services.js";

/* Six form fills a minute from one visit is already somebody testing. */
const PER_SESSION_LIMIT = 6;
const WINDOW_MS = 60_000;

/** Fields a form fill may fill in, in the order they are read. `vertical`,
 * `source`, `stage` and `notes` are handled separately below. */
const FILLABLE = ["name", "company", "domain", "email", "phone", "city", "state"];

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

  const pageSlug = String(b.page_slug ?? "");
  if (!isPageSlug(pageSlug)) return res.status(400).json({ ok: false, error: "Unknown page." });

  const sessionId = clean(b.session_id, 120);
  if (!allowHit(`lead:${sessionId || req.headers?.origin || "-"}`, PER_SESSION_LIMIT, WINDOW_MS)) {
    return res.status(429).json({ ok: false, error: "Too many submissions from that session." });
  }

  const email = normaliseEmail(b.email);
  const phone = digitsOnly(b.phone);
  const name = clean(b.name, 160);
  /* SOMETHING TO REACH THEM BY, or there is no lead. A row with a name and
   * nothing else cannot be worked, and it would sit in the pipeline forever
   * looking like a lead somebody forgot to ring. */
  if (!email && !phone) {
    return res.status(400).json({ ok: false, error: "An email address or a phone number is required." });
  }

  if (!isServerConfigured()) {
    /* NOT swallowed. Unlike a tracking beacon, a lost lead is the whole point
     * of the page, and the caller has to know it did not land so it can say
     * so to the person who just typed their name in. */
    console.error("[hs-lead] refused: Supabase is not configured on this deployment");
    return res.status(503).json({ ok: false, error: "The lead could not be saved. Nothing is configured to receive it." });
  }

  /* The page sends { utm_source, utm_medium, … } (the names in the URL). An
   * earlier version of this file read utm.source, so no lead ever carried its
   * ad tags — fixed 16 Sep 2026. Both spellings are accepted. */
  const rawUtm = (b.utm && typeof b.utm === "object") ? b.utm : {};
  const utm = {
    source: rawUtm.utm_source ?? rawUtm.source ?? "",
    medium: rawUtm.utm_medium ?? rawUtm.medium ?? "",
    campaign: rawUtm.utm_campaign ?? rawUtm.campaign ?? "",
    content: rawUtm.utm_content ?? rawUtm.content ?? "",
    term: rawUtm.utm_term ?? rawUtm.term ?? "",
  };
  const reachedCheckout = b.reached_checkout === true;
  /* Which plan they picked at the checkout — yearly (2 months free, the default)
   * or monthly. Anything else is ignored rather than refused: a lead is never
   * lost over a field Sales only uses for context. */
  const plan = (b.plan === "year" || b.plan === "month") ? b.plan : null;
  const paid = b.paid === true;
  const zip = clean(b.zip, 20);
  const bestTime = clean(b.best_time, 120);
  const kind = clean(b.kind, 120);
  /* The quick GEO Score the visitor saw on the page, 0-100. Anything that is
   * not a whole number in that range is dropped, never guessed. */
  const scoreNum = Number(b.score);
  const score = Number.isInteger(scoreNum) && scoreNum >= 0 && scoreNum <= 100 ? scoreNum : null;

  const incoming = {
    name,
    company: clean(b.company, 200),
    /* admin_leads has `domain`, not `website`. The host is what every other
     * screen in this console reads. See migration 0035's closing note. */
    domain: hostFromWebsite(b.website),
    email,
    phone,
    city: clean(b.city, 120),
    state: clean(b.state, 120),
  };

  const note = captureNote({ pageSlug, kind, reachedCheckout, paid, zip, bestTime, score });

  const admin = getAdminSupabase();
  const nowIso = new Date().toISOString();

  try {
    const existing = email ? await findByEmail(admin, email) : null;

    let leadId = null;
    let created = false;

    if (existing) {
      leadId = existing.id;
      const patch = { last_activity_at: nowIso };
      for (const key of FILLABLE) {
        if (!isBlank(incoming[key]) && isBlank(existing[key])) patch[key] = incoming[key];
      }
      const { error } = await admin.from("admin_leads").update(patch).eq("id", leadId);
      if (error) {
        console.error("[hs-lead] update failed", error.message);
        return res.status(500).json({ ok: false, error: "That lead could not be updated." });
      }
      /* Appended, never replaced — see rule 2 in the header. Done INSIDE the
       * database (migration 0037) so two submits a second apart cannot read the
       * same old notes and erase each other's line. If the function is not
       * there yet (0037 not run), fall back to the old read-then-write. */
      const { error: noteErr } = await admin.rpc("hs_append_lead_note", { p_lead: leadId, p_note: note });
      if (noteErr) {
        console.error("[hs-lead] hs_append_lead_note unavailable, falling back", noteErr.message);
        const notes = isBlank(existing.notes) ? note : `${existing.notes}\n${note}`;
        const { error: e2 } = await admin.from("admin_leads").update({ notes }).eq("id", leadId);
        if (e2) console.error("[hs-lead] note fallback failed", e2.message);
      }
    } else {
      /* EVERY COLUMN NAMED IN FULL, inline, and no spread. A spread makes the
       * column guard abstain (tests/db-columns says so in as many words) and
       * this is the one insert on the whole path that creates a person. */
      const { data, error } = await admin.from("admin_leads").insert({
        name: incoming.name,
        company: incoming.company,
        domain: incoming.domain,
        email: incoming.email,
        phone: incoming.phone,
        city: incoming.city,
        state: incoming.state,
        /* All three are already legal values on the live check constraints —
         * source since 0009, stage since 0030. tests/home-services reads both
         * constraints out of the migrations and proves it. */
        source: "inbound",
        stage: "new",
        /* The page IS the vertical. A lead off the painting page is a painting
         * lead, and the Sales page already groups and filters on this column. */
        vertical: pageSlug,
        notes: note,
        last_activity_at: nowIso,
      }).select("id").maybeSingle();
      if (error || !data?.id) {
        console.error("[hs-lead] insert failed", error?.message || "no row returned");
        return res.status(500).json({ ok: false, error: "That lead could not be saved." });
      }
      leadId = data.id;
      created = true;
    }

    /* ---- bookkeeping. Logged and swallowed — see rule 4. ---- */
    await recordSource(admin, {
      leadId, pageSlug, sessionId, utm, reachedCheckout, paid, plan, nowIso,
    }).catch((err) => console.error("[hs-lead] source row failed", err?.message || err));

    await linkEvents(admin, leadId, sessionId)
      .catch((err) => console.error("[hs-lead] event back-fill failed", err?.message || err));

    return res.status(200).json({ ok: true, lead_id: leadId, created, updated: !created });
  } catch (err) {
    console.error("[hs-lead] threw", err?.message || err);
    return res.status(500).json({ ok: false, error: "That lead could not be saved." });
  }
}

/* ------------------------------------------------------------------ */

/** The OLDEST lead with that email, or null.
 *
 * PostgREST cannot filter on `lower(email)`, so this asks with `ilike` — which
 * is case-insensitive — and then checks the match EXACTLY in JavaScript. That
 * second step is not belt-and-braces: `ilike` treats `_` as a single-character
 * wildcard and PostgREST turns `*` into `%`, so an address containing either
 * can match somebody else. Widening the ask and narrowing the answer is safe
 * in a way that trusting the pattern is not.
 *
 * Oldest first, because the first row is the one carrying the history. */
async function findByEmail(admin, email) {
  const { data, error } = await admin
    .from("admin_leads")
    .select("id, name, company, domain, email, phone, city, state, notes, created_at")
    /* The address is sent as it is. A `_` or a `*` inside it can only make the
     * pattern match MORE rows, never fewer, and the exact check below throws
     * those away — so the widening is harmless and the narrowing is exact. */
    .ilike("email", email)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) {
    console.error("[hs-lead] dedupe read failed", error.message);
    return null;
  }
  return (data || []).find((r) => String(r.email || "").trim().toLowerCase() === email) || null;
}

/** The hs_lead_sources row, created or merged.
 *
 * MERGED, not upserted blind. `paid` and `reached_checkout` only ever go from
 * false to true here: somebody who paid on Tuesday and comes back on Friday
 * without paying has still paid, and a plain upsert would quietly un-pay them.
 * The page they FIRST came from is kept for the same reason. */
async function recordSource(admin, { leadId, pageSlug, sessionId, utm, reachedCheckout, paid, plan, nowIso }) {
  const { data: prior } = await admin
    .from("hs_lead_sources")
    .select("*")
    .eq("lead_id", leadId)
    .maybeSingle();

  /* The first event we ever saw from this visit, so "how long did they read
   * before filling it in" is answerable. Null when we never saw one — which
   * is honest and is what the column means. */
  let firstSeen = prior?.first_seen_at || null;
  if (!firstSeen && sessionId) {
    const { data: ev } = await admin
      .from("hs_page_events")
      .select("created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(1);
    firstSeen = ev?.[0]?.created_at || null;
  }

  const { error } = await admin.from("hs_lead_sources").upsert({
    lead_id: leadId,
    page_slug: prior?.page_slug || pageSlug,
    session_id: prior?.session_id || sessionId || null,
    first_seen_at: firstSeen,
    converted_at: prior?.converted_at || nowIso,
    utm_source: prior?.utm_source || clean(utm.source, 120),
    utm_medium: prior?.utm_medium || clean(utm.medium, 120),
    utm_campaign: prior?.utm_campaign || clean(utm.campaign, 120),
    utm_content: prior?.utm_content || clean(utm.content, 120),
    utm_term: prior?.utm_term || clean(utm.term, 120),
    reached_checkout: Boolean(prior?.reached_checkout) || reachedCheckout,
    paid: Boolean(prior?.paid) || paid,
    /* The latest choice wins — somebody who switches from yearly to monthly
     * before pressing the button meant the second one. */
    plan: plan || prior?.plan || null,
  }, { onConflict: "lead_id" });
  if (error) throw new Error(error.message);
}

/** Put the lead's id on the events from that visit, so the reading they did
 * BEFORE they filled the form can be read back against the person. Only rows
 * that have no lead yet — a session shared by two form fills keeps its first. */
async function linkEvents(admin, leadId, sessionId) {
  if (!sessionId) return;
  const { error } = await admin
    .from("hs_page_events")
    .update({ lead_id: leadId })
    .eq("session_id", sessionId)
    .is("lead_id", null);
  if (error) throw new Error(error.message);
}
