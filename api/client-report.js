/* POST /api/client-report — generate a report about one client.
 *
 * Auth: owner/admin. Body: { clientId, instruction, preset }
 *
 * HOW IT STAYS HONEST — the same four rules as /api/client-standing, because
 * they were right there and a report is a bigger version of the same job:
 *   1. Every fact is COUNTED here, server-side, from real rows: tasks, the
 *      weekly log, websites, email threads, follow-ups, invoices, tickets and
 *      the team's own notes.
 *   2. Those facts, and only those facts, are what the AI is shown. It never
 *      touches the database.
 *   3. The facts are SAVED next to the words, so any report can be checked
 *      against the same numbers it was written from, months later.
 *   4. With no ANTHROPIC_API_KEY it still works and returns a counted version.
 *      No key is not an excuse for an empty page.
 *
 * And one more that only matters for reports:
 *   5. The draft is thrown away if it contains a number that is not in the
 *      facts, wording that promises a result, or a line that gives a person a
 *      job. The counted version ships instead and the reason is saved on the
 *      row, so a pattern of rejections is visible rather than invisible.
 *
 * WHAT IS NEVER SENT TO THE AI: anything from the vault. The facts carry a
 * COUNT of vault items and nothing else — no label, no username, obviously no
 * secret. A report gets forwarded; a list of the logins we hold should not
 * travel with it.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { draft, isAiConfigured } from "../lib/ai.js";
import {
  assembleReportFacts, buildFactsText, buildReportInstruction, parseAnswer,
  checkReport, deterministicReport, missingFrom, presetById, MAX_INSTRUCTION_CHARS,
  MAX_SHAPE_CHARS,
} from "../lib/client-report.js";

const COST = { input: 3.0, output: 15.0 };

/* The facts for a deep report run up to 13,000 characters. The default input cap
 * in lib/ai.js is 6,000, which would quietly cut the last third off — money,
 * notes, and the "what we cannot answer" list, all of it invisible.
 *
 * Set high enough that it should never bite: the fact sheet is already capped
 * and, when it is cut, buildFactsText() reports HOW MUCH and the report says so
 * in its own gaps list. `inputTruncated` below is the backstop for the case
 * nobody thought of — a very long instruction plus a very long brain — and it
 * is treated as a hard failure, not a warning. */
const AI_INPUT_CHARS = 20000;

function tokensForPreset(presetId) {
  const words = presetById(presetId).words;
  // Roughly 1.6 tokens a word, plus room for the headings and the summary.
  return Math.min(4000, Math.max(700, Math.round(words * 1.9) + 500));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const body = await readJson(req);
  const clientId = String(body?.clientId || "").trim();
  if (!clientId) return res.status(400).json({ error: "Missing clientId." });

  const presetId = String(body?.preset || "standard");
  const instruction = String(body?.instruction || "").trim().slice(0, MAX_INSTRUCTION_CHARS);
  /* HOW IT SHOULD READ — who it is for and what shape to come back in. A
   * separate question from "what should it cover", so a separate field all the
   * way down: separate box on screen, separate fenced block in the prompt,
   * separate column on the row. */
  const shapePreset = String(body?.shapePreset || "").trim().slice(0, 40) || null;
  const shape = String(body?.shape || "").trim().slice(0, MAX_SHAPE_CHARS);

  const admin = getAdminSupabase();

  const { data: client, error: clientErr } = await admin
    .from("admin_clients").select("*").eq("id", clientId).maybeSingle();
  if (clientErr) return res.status(500).json({ error: clientErr.message });
  if (!client) return res.status(404).json({ error: "That client does not exist." });

  /* Every table this client touches, in one go. Each read is capped, and the
   * caps are generous enough that hitting one is itself worth knowing about —
   * see `capped` below, which is reported rather than shrugged off. */
  const CAPS = { tasks: 400, weekly: 60, sites: 60, emails: 200, invoices: 120, tickets: 100, notes: 60, accounts: 60, vault: 200, history: 5, connections: 40, snapshots: 400 };

  const [tasks, weekly, sites, invoices, notes, accounts, vault, history, roster, connections, snapshots] = await Promise.all([
    /* ORDERED, every one. PostgREST returns rows in no defined order without
     * it, so a client at the cap gave a different arbitrary slice on every
     * press — two reports minutes apart with different "counted" numbers. The
     * caveat below says "it stopped at the first 400", which was only true once
     * there was an order to be first in. */
    admin.from("admin_tasks").select("*").eq("client_id", clientId).order("updated_at", { ascending: false }).limit(CAPS.tasks),
    admin.from("admin_weekly_log").select("*").eq("client_id", clientId).order("week_no", { ascending: false }).limit(CAPS.weekly),
    admin.from("admin_client_sites").select("*").eq("client_id", clientId).order("sort", { ascending: true }).limit(CAPS.sites),
    admin.from("admin_invoices").select("id, number, status, issue_date, due_date, total_cents, amount_paid_cents, paid_at").eq("client_id", clientId).order("issue_date", { ascending: false }).limit(CAPS.invoices),
    admin.from("admin_notes").select("id, title, body, created_at, updated_at, link_type, link_id").eq("link_type", "client").eq("link_id", clientId).order("updated_at", { ascending: false }).limit(CAPS.notes),
    admin.from("admin_platform_accounts").select("id, active").eq("client_id", clientId).limit(CAPS.accounts),
    /* Note the columns: id and secret_set_at. Not the label, not the username.
     * The report is allowed to know HOW MANY, and nothing else. */
    admin.from("admin_vault_items").select("id, secret_set_at").eq("client_id", clientId).limit(CAPS.vault),
    admin.from("admin_client_reports").select("id, created_at, instruction, summary, body").eq("client_id", clientId).order("created_at", { ascending: false }).limit(CAPS.history),
    /* The roster, for the "a report never hands work to a person" check. Read
     * from the real team rather than hard-coding three names: a contractor, or
     * anybody who joined after the code was written, walked straight through.
     * Names only — no emails, no roles, and it never reaches the AI. */
    admin.from("admin_users").select("full_name").eq("active", true).limit(60),
    /* The client's own connected accounts, and the numbers already read out of
     * them. NOTHING IS FETCHED FROM GOOGLE HERE. A report quotes a SNAPSHOT —
     * a reading taken on a known day — so pressing the button twice cannot
     * produce two different reports, and a report written in March can still
     * be checked in September. Refreshing the numbers is its own button on the
     * client page, and it is deliberately not this one: a report that silently
     * went and fetched would be slow, would fail whenever Google did, and
     * would quietly change the "measured on" date under an old report. */
    admin.from("admin_client_connections")
      .select("id, provider, property, status, active, last_synced_at")
      .eq("client_id", clientId).limit(CAPS.connections),
    admin.from("admin_connection_snapshots")
      .select("id, provider, property, period_start, period_end, taken_at, source, metrics, detail, note")
      .eq("client_id", clientId)
      .order("taken_at", { ascending: false })
      .limit(CAPS.snapshots),
  ]);

  const readFail = [tasks, weekly, sites, invoices].find((r) => r.error);
  if (readFail) return res.status(500).json({ error: `Could not read this client's records: ${readFail.error.message}` });

  /* THE OTHER READS. A failure on any of these used to be swallowed by
   * `data || []`, which turned "we could not look" into a counted zero — and
   * then into a line in the gaps list reading "No email threads are linked to
   * this client", stated as fact. A failed read is named as a failed read. */
  const softFails = [];

  /* Tickets are not linked to a client in the schema (admin_tickets has no
   * client_id), so they are matched by the client's contact email. Say that
   * plainly rather than pretending the link is exact.
   *
   * THE MATCH HAPPENS IN THE DATABASE. It used to pull an arbitrary 100 rows
   * from the whole ticket table and filter them here — so on a console with 400
   * tickets, a client's six open ones could all be outside that arbitrary 100
   * and the report would carry no ticket section and no gap line. The reader
   * would conclude there were no support issues. */
  const contact = String(client.contact_email || "").trim().toLowerCase();
  let clientTickets = [];
  let ticketErr = null;
  if (contact) {
    const { data, error } = await admin
      .from("admin_tickets")
      .select("id, subject, status, priority, requester_email, created_at")
      /* ESCAPED. `ilike` treats the value as a pattern, and `_` matches any
       * single character — so a contact of john_smith@acme.com pulled in
       * johnXsmith@ and john.smith@, and their ticket SUBJECTS then travelled
       * into this client's report and its download. A `%` anywhere would have
       * returned the whole table. Caught by a reviewer, Aug 21 2026. */
      .ilike("requester_email", contact.replace(/[\\%_]/g, (ch) => `\\${ch}`))
      .order("created_at", { ascending: false })
      .limit(CAPS.tickets);
    ticketErr = error?.message || null;
    clientTickets = data || [];
  }

  const { data: emailThreads, error: emailErr } = await admin
    .from("admin_email_threads").select("*").eq("client_id", clientId)
    /* nullsFirst: false matters. Postgres puts NULLs FIRST on a descending
     * sort, so a client at the cap would have been handed the threads that have
     * never had a message, while the caveat said "the newest 200". */
    .order("last_message_at", { ascending: false, nullsFirst: false }).limit(CAPS.emails);
  const emailRowIds = (emailThreads || []).map((e) => e.id);
  let reminders = [];
  if (emailRowIds.length) {
    const { data } = await admin
      .from("admin_reminders").select("id, due_at, done_at, link_id")
      .eq("link_type", "email").in("link_id", emailRowIds).is("done_at", null).limit(100);
    reminders = data || [];
  }
  const { data: clientReminders } = await admin
    .from("admin_reminders").select("id, due_at, done_at, link_id")
    .eq("link_type", "client").eq("link_id", clientId).is("done_at", null).limit(100);

  for (const [what, err] of [
    ["email threads", emailErr?.message],
    ["support tickets", ticketErr],
    ["the team's notes about this client", notes.error?.message],
    ["the platform logins", accounts.error?.message],
    ["the vault count", vault.error?.message],
    ["earlier reports", history.error?.message],
    /* The roster feeds the "a report never hands work to a person" check. If it
     * cannot be read, that check runs with no names in it — which is the
     * headline guarantee of this feature quietly switched off. It says so. */
    ["the team roster (so this report's check on naming people ran without it)", roster.error?.message],
    ["the client's connected accounts (Search Console, Business Profile, Analytics)", connections.error?.message],
    ["the numbers already read from the client's own accounts", snapshots.error?.message],
  ]) {
    if (err) softFails.push(`- We could not read ${what} while writing this (${err}). Anything about them is missing here, NOT absent.`);
  }

  const facts = assembleReportFacts({
    client,
    tasks: tasks.data || [],
    weekly: weekly.data || [],
    emailThreads: emailThreads || [],
    sites: sites.data || [],
    reminders: [...reminders, ...(clientReminders || [])],
    invoices: invoices.data || [],
    tickets: clientTickets,
    notes: notes.data || [],
    platformAccounts: accounts.data || [],
    vaultItems: vault.data || [],
    previousReports: history.data || [],
    /* A failed read here becomes an empty list, and an empty list makes the
     * gaps section say "no numbers are connected" — which would be a claim,
     * not a fact. So the failure is recorded in softFails below and named on
     * the report instead of being silently turned into a sentence. */
    snapshots: snapshots.error ? [] : (snapshots.data || []),
    connections: connections.error ? [] : ((connections.data || []).filter((c) => c.active !== false)),
    nowMs: Date.now(),
  });

  /* A read that came back exactly at its cap probably had more behind it. Say
   * so on the report rather than letting the reader assume it covers
   * everything — the "fetch at cap, print at cap" trap from the Aug 20 review,
   * in its other form. */
  /* The readings are capped like everything else, and hitting that cap is
   * dangerous in a way the others are not: a provider whose newest reading
   * falls outside the window drops out of facts.measured, and the gaps list
   * then states that the account "is not connected, or has never been read"
   * — about an account read every day. Named in the caveats below. */
  const capped = [
    (tasks.data || []).length >= CAPS.tasks && "tasks",
    (emailThreads || []).length >= CAPS.emails && "email threads",
    (invoices.data || []).length >= CAPS.invoices && "invoices",
  ].filter(Boolean);

  /* Named separately because the sentence it needs is a different sentence.
   * "More readings exist than this read" is not a size warning here — it is
   * the reason a connected account might be described below as one we have
   * never read, which would be false. */
  const snapshotsCapped = !snapshots.error && (snapshots.data || []).length >= CAPS.snapshots;

  /* Built once, here, so that BOTH the AI path and the counted path answer to
   * the same fact sheet — and so the cut is known before either of them runs. */
  const { text: factsText, cutChars } = buildFactsText(facts);

  let report = null;
  let source = "counted";
  let usage = null;
  let rejected = null;
  let truncated = 0;

  const todayIso = new Date().toISOString().slice(0, 10);
  const teamNames = (roster.data || []).map((r) => r.full_name).filter(Boolean);

  if (isAiConfigured()) {
    try {
      const brain = await admin
        .from("admin_brain").select("kind, title, body").eq("enabled", true)
        .order("created_at", { ascending: true }).limit(60);

      const prompt = buildReportInstruction({
        clientName: client.name,
        userInstruction: instruction,
        presetId,
        todayIso,
        shape,
      });

      const result = await draft({
        kind: "client_report",
        context: `${prompt}\n\nFACTS:\n${factsText}`,   // factsText built above
        brainRows: brain.data || [],
        maxInputChars: AI_INPUT_CHARS,
        maxTokens: tokensForPreset(presetId),
      });
      truncated = result.inputTruncated || 0;

      const parsed = parseAnswer(result.text);
      const verdict = parsed
        ? checkReport(parsed, factsText, { clientName: client.name, teamNames })
        : { ok: false, why: "it did not come back in the required shape" };

      if (parsed && verdict.ok && !truncated) {
        report = {
          ...parsed,
          cannotCheck: missingFrom(facts).map((g) => `- ${g}`).join("\n"),
        };
        source = "written";
        usage = result.usage;
        const cost = (result.usage.input_tokens * COST.input + result.usage.output_tokens * COST.output) / 1e6;
        await admin.from("admin_usage_events").insert({
          source: "admin", model: result.model,
          input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens,
          cost_usd: cost,
          meta: { kind: "client_report", client: client.name, preset: presetId, user: member.membership.email },
        });
      } else {
        /* Truncation is treated as a failure, not a warning. A report written
         * from part of the facts looks exactly like one written from all of
         * them, and there is no way for a reader to tell which they have. */
        rejected = truncated
          ? `${truncated} characters of facts did not fit, so the AI would have written from part of the story`
          : verdict.why;
        await admin.from("admin_activity_log").insert({
          actor: member.user.id,
          kind: "client_report_rejected",
          title: `AI report rejected for ${client.name}`,
          body: `${rejected} — the counted version was saved instead.`,
        });
      }
    } catch (err) {
      rejected = `the AI call failed (${String(err?.message || "unknown").slice(0, 140)})`;
    }
  }

  if (!report) report = deterministicReport(facts, { presetId, todayIso });

  const row = {
    client_id: clientId,
    instruction: instruction || null,
    preset: presetId,
    shape: shape || null,
    shape_preset: shapePreset,
    title: report.title || `${client.name} — report`,
    summary: report.summary || "",
    body: [report.body || "", report.watch ? `\n## Worth a second look\n${report.watch}` : ""].join(""),
    cannot_check: [
      report.cannotCheck || missingFrom(facts).map((g) => `- ${g}`).join("\n"),
      capped.length ? `- More ${capped.join(" and ")} exist than this report read. It read the newest ${capped.map((c) => CAPS[c === "email threads" ? "emails" : c]).join("/")} and stopped.` : "",
      /* The fact sheet itself did not fit. This is the line that stops a report
       * written from part of the records reading exactly like one written from
       * all of them. */
      cutChars ? `- About ${cutChars} characters of this client's records did not fit on the fact sheet this was written from. The counts are complete; the detailed lists stop partway.` : "",
      contact ? "" : "- Support tickets. This client has no contact email set, and tickets are matched to a client by that address.",
      snapshotsCapped
        ? `- This client has more saved readings from their own accounts than this report read — it read the newest ${CAPS.snapshots} and stopped. If an account is described above as one we have never read, check the Connections tab before repeating that.`
        : "",
      ...softFails,
    ].filter(Boolean).join("\n"),
    source,
    rejected_why: rejected,
    facts,
    counts_at: facts.takenAt,
    created_by: member.user.id,
    created_by_email: member.membership.email,
  };

  /* MIGRATION 0014 MAY NOT HAVE BEEN RUN. If the two shape columns are not
   * there yet, save the report without them rather than losing it — a report
   * you cannot generate is a far worse outcome than one whose shape was not
   * recorded. The retry is narrow on purpose: only the "column does not exist"
   * answer, and only once. Anything else is a real failure and is reported. */
  const MISSING_SHAPE = /(column|schema cache)[^]*?(shape|shape_preset)|(shape|shape_preset)[^]*?(column|schema cache|does not exist)/i;
  let { data: saved, error: saveErr } = await admin
    .from("admin_client_reports").insert(row).select().maybeSingle();
  let shapeNotSaved = false;
  if (saveErr && MISSING_SHAPE.test(saveErr.message || "")) {
    const { shape: _s, shape_preset: _sp, ...withoutShape } = row;
    ({ data: saved, error: saveErr } = await admin
      .from("admin_client_reports").insert(withoutShape).select().maybeSingle());
    shapeNotSaved = !saveErr;
  }

  res.setHeader("Cache-Control", "private, no-store");

  if (saveErr || !saved) {
    // Hand the report back anyway — a failed save is not a reason to withhold
    // the answer, it is a reason to say it was not filed.
    return res.status(200).json({
      report: { ...row, id: null, created_at: new Date().toISOString() },
      saved: false,
      saveError: saveErr?.message || "The report was written but no row came back, so it is not filed.",
      source, usage, rejected,
    });
  }

  return res.status(200).json({
    report: saved, saved: true, source, usage, rejected,
    /* Named, not swallowed. It is the one thing on this response that is
     * different from what was asked for. */
    shapeNotSaved: shapeNotSaved || undefined,
    shapeNote: shapeNotSaved
      ? "The report is saved, but how you asked it to read was not — migration 0014 has not been run on this database yet."
      : undefined,
  });
}
