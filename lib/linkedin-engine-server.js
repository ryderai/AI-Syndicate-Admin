/* Server side of the LinkedIn messaging engine: load, lock, run, save.
 * 3 Nov 2026. Shared by api/linkedin-messages.js (a person presses
 * Generate / sends client feedback) and api/linkedin-build-due.js (the
 * hourly run that picks up paid clients on its own).
 *
 * METERING IS NOT HERE, ON PURPOSE. scripts/check-ai-usage.mjs requires the
 * api/ file that reaches the model to call recordAiUsage itself, so each
 * route records `result.calls` (and a failure) with its own surface. */
import { generate, revise } from "./linkedin-messages.js";
import { fetchSiteText } from "./linkedin-site-text.js";

export const ENGAGEMENT_COLUMNS = "id, status, answers, files, company, contact_email, client_id, paid_at, paid_source, stripe_customer_id, stripe_subscription_id, messages_generating_at, messages_attempts";
/* Longer than the longest run: two model calls of up to 110 s, plus the
 * website lookup (up to 4 hops x 8 s). 180 s was shorter than that, so a
 * second press could claim a live run's lock (3 Nov check). */
const LOCK_STALE_MS = 6 * 60 * 1000;
/* After this many failed runs the hourly job stops picking a client, so one
 * broken client can't starve every newer one (3 Nov check). A person can
 * still press Generate, which resets the count on success. */
export const MAX_AUTO_ATTEMPTS = 3;

export async function loadEngagement(admin, id) {
  const { data, error } = await admin.from("linkedin_clients").select(ENGAGEMENT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
  return data || null;
}

/** One conditional update, so only one request can win. A claim older than
 * 6 minutes is treated as dead (a request that crashed). The attempt is
 * COUNTED HERE, at the start, so a run that is killed mid-way (the platform's
 * time limit) still counts against the client (3 Nov fourth check); a
 * successful run resets the count in release(). */
export async function claim(admin, id) {
  const stale = new Date(Date.now() - LOCK_STALE_MS).toISOString();
  const { data: row } = await admin.from("linkedin_clients").select("messages_attempts").eq("id", id).maybeSingle();
  const { data } = await admin
    .from("linkedin_clients")
    .update({ messages_generating_at: new Date().toISOString(), messages_attempts: (Number(row?.messages_attempts) || 0) + 1 })
    .eq("id", id)
    .or(`messages_generating_at.is.null,messages_generating_at.lt."${stale}"`)
    .select("id");
  return Boolean(data?.length);
}

/** Free the lock and record how the run went: success resets the attempt
 * count (claim() already counted this one); a failure keeps the count and
 * the reason for the screen. */
export async function release(admin, id, outcome = null) {
  const patch = { messages_generating_at: null };
  if (outcome?.ok) { patch.messages_attempts = 0; patch.messages_last_error = null; }
  if (outcome && !outcome.ok) patch.messages_last_error = String(outcome.error || "failed").slice(0, 300);
  await admin.from("linkedin_clients").update(patch).eq("id", id);
}

/** The answers as the engine wants them: the form's answers, plus the file
 * names (never the files) so the prompt can say what was uploaded. */
export function engineAnswers(client) {
  return { ...(client?.answers || {}), _files: Array.isArray(client?.files) ? client.files.map((f) => ({ name: f?.name })) : [] };
}

/** Run the engine. `draftFn` = lib/ai.js draft. Never sends anything. */
export async function runEngine({ client, draftFn, current = null, feedback = "" }) {
  const answers = engineAnswers(client);
  const siteText = answers.website ? await fetchSiteText(answers.website) : "";
  const result = current
    ? await revise({ answers, draftFn, current, feedback, siteText })
    : await generate({ answers, draftFn, siteText });
  return { ...result, siteTextUsed: siteText.length };
}

/** Save as the next version. The (li_client_id, version) key refuses a
 * duplicate; the read-then-write retries with a fresh read, 3 times at most. */
export async function saveVersion(admin, { client, result, source, fromVersionId = null, createdBy = null, madeFromFeedback = null }) {
  let saved = null;
  let error = null;
  for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
    const { data: last } = await admin
      .from("linkedin_sequence_versions")
      .select("version")
      .eq("li_client_id", client.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ins = await admin.from("linkedin_sequence_versions").insert({
      li_client_id: client.id,
      version: (last?.version || 0) + 1,
      source,
      status: "draft",
      content: result.content,
      raw_response: result.raw,
      prompt_version: result.promptVersion,
      model: result.calls[0]?.model || null,
      request_ids: result.calls.map((c) => c.requestId).filter(Boolean),
      issues: result.parseError ? [{ where: "Whole output", level: "block", code: "parse", message: result.parseError }] : result.issues,
      risk: result.risk,
      expires_on: result.expires,
      retried: result.retried,
      from_version_id: fromVersionId,
      made_from_feedback: madeFromFeedback,
      first_dated_on: result.dated?.first || null,
      created_by: createdBy,
    }).select("*").maybeSingle();
    saved = ins.data;
    error = ins.error;
    if (error && error.code !== "23505") break;
  }
  if (!saved) throw Object.assign(new Error(`Written but not saved: ${error?.message || "unknown"}`), { statusCode: 500 });
  return saved;
}

/** The brief's revision loop, in one place so Build 4's approval page can
 * call the same thing: the client's feedback is written on the version it
 * is about (once), a full revised JSON becomes the next version (which also
 * carries the feedback that made it), and only then does the old version
 * retire. Returns the new version row. The caller meters `result.calls`. */
export async function saveRevision(admin, { client, from, feedback, result, createdBy = null }) {
  await admin.from("linkedin_sequence_versions").update({ feedback }).eq("id", from.id).is("feedback", null);
  const saved = await saveVersion(admin, { client, result, source: "revision", fromVersionId: from.id, createdBy, madeFromFeedback: feedback });
  await admin.from("linkedin_sequence_versions").update({ status: "retired" }).eq("id", from.id).in("status", ["draft", "client_review"]);
  return saved;
}
