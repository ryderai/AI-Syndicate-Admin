/* /api/linkedin-flow — the LinkedIn Outreach flow in the console (Builds 3, 4, 5). 4 Nov 2026.
 *
 *   GET                       every sent-in client with its stage, dates, latest Sequence version,
 *                             live PIN, Late / Due today, Julie's queue, drafts in the outbox, settings
 *   PATCH { id, action, ... } move_stage {to} · set_launch {date} · booked {at} · live
 *                             approval_link · pin_link · save_lists {versionId} · settings {key, value}
 *                             outbox_done {outboxId, status: "sent"|"skipped"} · pin_seen {pinId}
 *
 * WHO. Owners + admins for everything; the 'linkedin' role (Julie, 0050)
 * for GET, booked, live, pin_seen and outbox reads — the steps the brief
 * gives her. settings: owner only. NOTHING HERE SENDS ANY EMAIL: drafts wait
 * in the outbox for a person to copy into Gmail and mark sent. No model calls. */
import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { lateItems, julieQueue, chicagoDate, isStage } from "../lib/linkedin-flow.js";
import { moveStage, approvalLink, pinLink, getSettings, draftToOutbox, linkSignups, mergeSignupInto } from "../lib/linkedin-flow-server.js";
import { onboardingLink, dueFollowUps } from "../lib/linkedin-v2.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENG = "id, company, contact_name, contact_email, status, flow_stage, stage_changed_at, stage_history, paid_at, paid_source, build_due_at, booking_at, launch_date, period_start, midmonth_due, report_due, renewal_date, renewed_at, payment_failed_at, messages_attempts, messages_last_error, submitted_at";
/* v2 (6 Nov 2026) columns, read in their own query and merged in, so the
 * page still loads if migration 0053 hasn't been run yet (6 Nov check). */
const ENG_V2 = "id, login_email, login_location, whatsapp, login_times, code_method, login_details_at, password_received_at";
/* v2 (6 Nov 2026): sales-page sign-ups shown on their own card. */
const SIGNUP = "id, status, company, contact_name, contact_email, linkedin_url, answers, paid_at, checkout_started_at, merged_into, created_at";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const member = await requireMember(req, ["owner", "admin", "linkedin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  const role = member.membership.role;
  const isAdmin = role === "owner" || role === "admin";
  const admin = getAdminSupabase();

  if (req.method === "GET") {
    const now = new Date();
    const since = new Date(now.getTime() - 40 * 864e5).toISOString().slice(0, 10);
    /* Expired login codes are deleted, not just hidden. The PIN page does this
     * too, and so does the daily reports run, so a code never outlives a day
     * even when nobody opens anything (4 Nov check). */
    await admin.from("linkedin_pins").delete().lt("expires_at", now.toISOString());
    /* v2: a paid sales-page sign-up is moved onto its onboarding-form row
     * before anything is read, so the list shows it paid. Guarded: before
     * migration 0053 the columns don't exist and this does nothing. */
    try { await linkSignups(admin); } catch { /* 0053 not run yet */ }
    const [eng, vers, acts, reps, pins, outbox, reports, settings, signups, prospects] = await Promise.all([
      admin.from("linkedin_clients").select(ENG).eq("status", "submitted").order("submitted_at", { ascending: false }).limit(200),
      admin.from("linkedin_sequence_versions").select("id, li_client_id, version, status, chosen_variant, issues, first_dated_on, expires_on, created_at").order("version", { ascending: false }).limit(500),
      admin.from("linkedin_daily_activity").select("li_client_id, day").gte("day", since).limit(5000),
      admin.from("linkedin_responses").select("id, li_client_id, day, name, reply_status, needs_review, reactivation_date, classification").limit(2000),
      admin.from("linkedin_pins").select("id, li_client_id, code, created_at, expires_at, seen_at").gt("expires_at", now.toISOString()).order("created_at", { ascending: false }).limit(50),
      admin.from("linkedin_outbox").select("id, li_client_id, kind, to_email, cc, subject, body_text, internal_note, status, created_at").eq("status", "draft").order("created_at", { ascending: false }).limit(40),
      admin.from("linkedin_reports").select("li_client_id, kind, period_start").limit(2000),
      getSettings(admin),
      admin.from("linkedin_clients").select(SIGNUP).in("status", ["signup", "merged"]).gte("created_at", new Date(now.getTime() - 90 * 864e5).toISOString()).order("created_at", { ascending: false }).limit(50),
      admin.from("linkedin_prospects").select("id, li_client_id, name, profile_url, accepted_on, last_step, last_sent_on, status").eq("status", "active").limit(5000),
    ]);
    const err = [eng, vers, acts, reps, pins, outbox, reports].find((r) => r.error)?.error;
    if (err) return res.status(500).json({ error: err.message });
    const ids = (eng.data || []).map((e) => e.id);
    const v2 = ids.length ? await admin.from("linkedin_clients").select(ENG_V2).in("id", ids) : { data: [] };
    const v2By = Object.fromEntries((v2.error ? [] : v2.data || []).map((r) => [r.id, r]));
    const engagements = (eng.data || []).map((e) => ({ ...e, ...(v2By[e.id] || {}) }));
    const activity = {};
    for (const a of acts.data || []) (activity[a.li_client_id] ||= []).push(a.day);
    /* Reports written for each client's CURRENT month only. */
    const periodOf = Object.fromEntries(engagements.map((e) => [e.id, e.period_start || e.launch_date]));
    const reportKinds = {};
    for (const r of reports.data || []) if (r.period_start === periodOf[r.li_client_id]) (reportKinds[r.li_client_id] ||= []).push(r.kind);
    const latest = {};
    for (const v of vers.data || []) if (!latest[v.li_client_id]) latest[v.li_client_id] = { ...v, blocking: (v.issues || []).filter((i) => i?.level === "block").length, issues: undefined };
    /* Follow-ups due: each client's APPROVED variant's delays (the brief). */
    const steps = await approvedSteps(admin, engagements.map((e) => e.id));
    const followUps = prospects.error ? [] : dueFollowUps(prospects.data || [], steps, chicagoDate(now));
    return res.status(200).json({
      today: chicagoDate(now),
      engagements: engagements.map((e) => ({ ...e, latestVersion: latest[e.id] || null, pins: (pins.data || []).filter((p) => p.li_client_id === e.id) })),
      late: [
        ...engagements.filter((e) => e.payment_failed_at && !["paused", "churned"].includes(e.flow_stage)).map((e) => ({ id: e.id, company: e.company, level: "late", what: `Stripe payment failed ${e.payment_failed_at.slice(0, 10)} — pauses after 3 days unpaid` })),
        ...lateItems(engagements, activity, { now, reports: reportKinds }),
        /* v2: a sales-page buyer paid but has no onboarding form yet. The
         * page promises the form within one business day. */
        ...(signups.error ? [] : signups.data || []).filter((x) => x.status === "signup" && x.paid_at).map((x) => {
          const hrs = (now - new Date(x.paid_at)) / 3600e3;
          return hrs >= 24 ? { id: x.id, company: x.company, level: "late", what: `Paid on the sales page ${x.paid_at.slice(0, 10)} — no onboarding form yet (send the welcome email in Emails waiting)` }
            : { id: x.id, company: x.company, level: "today", what: "Paid on the sales page — send the welcome email with their onboarding form (Emails waiting)" };
        }),
      ],
      queue: julieQueue(engagements, reps.data || [], activity, { now, followUps }),
      outbox: outbox.data || [],
      settings,
      signups: signups.error ? [] : (signups.data || []).map((x) => ({ ...x, formUrl: onboardingLink(x.id), phone: x.answers?.contact_phone || null, goal: x.answers?.goals || null, answers: undefined })),
    });
  }

  if (req.method !== "PATCH") { res.setHeader("Allow", "GET, PATCH"); return res.status(405).json({ error: "Method not allowed." }); }
  const body = await readJson(req);
  const action = String(body?.action || "");
  const julieMay = ["booked", "live", "pin_seen", "password_received"];
  if (!isAdmin && !julieMay.includes(action)) return res.status(403).json({ error: "Only an owner or admin can do that." });

  if (action === "settings") {
    if (role !== "owner") return res.status(403).json({ error: "Only an owner can change LinkedIn settings." });
    const key = String(body?.key || "");
    if (!["daily_caps", "booking_url", "report_cc", "julie_email", "julie_whatsapp", "password_method", "code_alert_email", "signup_notify"].includes(key)) return res.status(400).json({ error: "Unknown setting." });
    const { error } = await admin.from("linkedin_settings").upsert({ key, value: body?.value ?? null, updated_at: new Date().toISOString(), updated_by: member.user.id });
    return error ? res.status(500).json({ error: error.message }) : res.status(200).json({ ok: true });
  }
  if (action === "outbox_done") {
    const status = body?.status === "skipped" ? "skipped" : "sent";
    if (!UUID.test(String(body?.outboxId || ""))) return res.status(400).json({ error: "outboxId is required." });
    const { error } = await admin.from("linkedin_outbox").update({ status, done_at: new Date().toISOString(), done_by: member.user.id }).eq("id", body.outboxId).eq("status", "draft");
    return error ? res.status(500).json({ error: error.message }) : res.status(200).json({ ok: true });
  }
  if (action === "pin_seen") {
    if (!UUID.test(String(body?.pinId || ""))) return res.status(400).json({ error: "pinId is required." });
    await admin.from("linkedin_pins").update({ seen_at: new Date().toISOString() }).eq("id", body.pinId);
    return res.status(200).json({ ok: true });
  }

  if (action === "link_signup") {
    /* An owner or admin ties a paid sign-up to a form row by hand, when the
     * automatic match can't (a different email on the form). All or nothing:
     * lib/linkedin-flow-server.js mergeSignupInto. */
    const formId = String(body?.id || ""), signupId = String(body?.signupId || "");
    if (!UUID.test(formId) || !UUID.test(signupId)) return res.status(400).json({ error: "id and signupId are required." });
    const { data: sgn } = await admin.from("linkedin_clients").select("id, status, paid_at, paid_source, stripe_customer_id, stripe_subscription_id, renewal_date, last_invoice_paid_at").eq("id", signupId).maybeSingle();
    if (!sgn || sgn.status !== "signup" || !sgn.paid_at) return res.status(409).json({ error: "That sign-up isn't paid, or is already linked." });
    const r = await mergeSignupInto(admin, sgn, formId);
    return r.ok ? res.status(200).json({ ok: true }) : res.status(409).json({ error: r.error });
  }

  const id = String(body?.id || "");
  if (!UUID.test(id)) return res.status(400).json({ error: "id is required." });
  const { data: client } = await admin.from("linkedin_clients").select("id, company, contact_name, contact_email, flow_stage").eq("id", id).maybeSingle();
  if (!client) return res.status(404).json({ error: "LinkedIn client not found." });

  try {
    switch (action) {
      case "move_stage": {
        if (!isStage(String(body?.to))) return res.status(400).json({ error: "Unknown stage." });
        const r = await moveStage(admin, id, body.to, { manual: true });
        return r.ok ? res.status(200).json(r) : res.status(500).json(r);
      }
      case "set_launch": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body?.date || ""))) return res.status(400).json({ error: "date must be YYYY-MM-DD." });
        const { error } = await admin.from("linkedin_clients").update({ launch_date: body.date }).eq("id", id);
        return error ? res.status(500).json({ error: error.message }) : res.status(200).json({ ok: true });
      }
      case "booked": {
        const at = new Date(String(body?.at || ""));
        if (Number.isNaN(at.getTime())) return res.status(400).json({ error: "at must be a date and time." });
        await admin.from("linkedin_clients").update({ booking_at: at.toISOString() }).eq("id", id);
        await moveStage(admin, id, "access_scheduled");
        return res.status(200).json({ ok: true });
      }
      case "live": {
        /* Julie confirms she's logged in: Live, launch date today (the
         * trigger), report dates follow; the "outreach is live" email is
         * drafted ONCE. Julie can only take the normal step (approved /
         * access scheduled -> live); an owner or admin can force it. */
        const r = await moveStage(admin, id, "live", { manual: isAdmin });
        if (!r.ok) return res.status(500).json(r);
        if (r.skipped) return res.status(409).json({ error: `Can't go live from ${client.flow_stage.replace("_", " ")}.` });
        if (!r.unchanged) await draftToOutbox(admin, { client, kind: "live" });
        return res.status(200).json({ ok: true });
      }
      case "approval_link":
        return res.status(200).json({ url: await approvalLink(admin, id) });
      case "pin_link":
        return res.status(200).json({ url: await pinLink(admin, id) });
      case "onboarding_link":
        return res.status(200).json({ url: onboardingLink(id) });
      case "password_received": {
        /* Julie has the password. The password itself is never sent here or
         * stored (CJ's brief, Guardrails) — only that she has it. `undo`
         * clears it (e.g. the client changed their password). */
        const patch = body?.undo ? { password_received_at: null, password_received_by: null } : { password_received_at: new Date().toISOString(), password_received_by: member.user.id };
        const { error } = await admin.from("linkedin_clients").update(patch).eq("id", id);
        return error ? res.status(500).json({ error: error.message }) : res.status(200).json({ ok: true });
      }
      case "save_lists": {
        /* The approved version's three list specs become rows on the
         * Searches tab (Draft), where Julie adds the Sales Navigator link,
         * the result count and where she left off. */
        if (!UUID.test(String(body?.versionId || ""))) return res.status(400).json({ error: "versionId is required." });
        const { data: v } = await admin.from("linkedin_sequence_versions").select("id, li_client_id, content").eq("id", body.versionId).maybeSingle();
        if (!v || v.li_client_id !== id) return res.status(404).json({ error: "That version isn't this client's." });
        const { data: already } = await admin.from("linkedin_searches").select("id").eq("source_version_id", v.id).limit(1);
        if (already?.length) return res.status(409).json({ error: "These lists were already added." });
        const rows = (v.content?.target_lists || []).map((l) => ({
          li_client_id: id, source_version_id: v.id, list_status: "draft", status: "Draft", campaign_title: l.title,
          job_titles: (l.job_titles || []).join(", "), industry: (l.industries || []).join(", "), headcount: (l.headcount || []).join(", "),
          geography: (l.geography || []).join(", "), keywords: l.keywords || null, exclusions: l.exclusions || null, created_by: member.user.id,
        }));
        const { error } = await admin.from("linkedin_searches").insert(rows);
        return error ? res.status(500).json({ error: error.message }) : res.status(200).json({ added: rows.length });
      }
      default:
        return res.status(400).json({ error: "Unknown action." });
    }
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Failed." });
  }
}

/** Each client's approved variant's steps: { [li_client_id]: [{ step, delay_days }] }. */
async function approvedSteps(admin, ids) {
  if (!ids.length) return {};
  const { data } = await admin.from("linkedin_sequence_versions").select("li_client_id, chosen_variant, content").eq("status", "approved").in("li_client_id", ids).limit(500);
  const out = {};
  for (const v of data || []) {
    const variant = (v.content?.variants || []).find((x) => x?.name === v.chosen_variant) || v.content?.variants?.[0];
    if (variant?.steps) out[v.li_client_id] = variant.steps;
  }
  return out;
}
