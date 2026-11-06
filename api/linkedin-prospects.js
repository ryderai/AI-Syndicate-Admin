/* /api/linkedin-prospects — one row per person who accepted, so follow-ups
 * are tracked per person. 6 Nov 2026.
 *
 * WHY. CJ's brief, Build 5: Julie's queue shows "follow-ups due today by step
 * and delay ... This is what makes one VA able to run 4–6 accounts". The
 * daily rows are counts, so they can't say who is due. Ryder told CJ on 4 Nov
 * "next I build a per-person prospect list so follow-ups are tracked"; no
 * objection.
 *
 *   GET   ?liClientId=<id>                      prospects with their next step + due date
 *   POST  { liClientId, lines, acceptedOn, listId? }   paste names (one per line, optional profile link)
 *   PATCH { id, action: "sent" | "replied" | "done" | "undo" }
 *
 * The delays come from the client's APPROVED variant (step 1 counts from
 * acceptance, each later step from the one before). Julie still sends every
 * message by hand in LinkedIn; this only tells her who is due. Owners,
 * admins and the 'linkedin' role (Julie). Nothing here sends anything. */
import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { parseProspectLines, nextStep } from "../lib/linkedin-v2.js";
import { chicagoDate } from "../lib/linkedin-flow.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLS = "id, li_client_id, name, profile_url, list_id, accepted_on, last_step, last_sent_on, prev_sent_on, status, created_at";

async function stepsFor(admin, liClientId) {
  const { data } = await admin.from("linkedin_sequence_versions").select("chosen_variant, content").eq("li_client_id", liClientId).eq("status", "approved").order("version", { ascending: false }).limit(1);
  const v = data?.[0];
  const variant = (v?.content?.variants || []).find((x) => x?.name === v?.chosen_variant) || v?.content?.variants?.[0];
  return { steps: variant?.steps || [], variant: variant?.name || null };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const member = await requireMember(req, ["owner", "admin", "linkedin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  const admin = getAdminSupabase();
  const today = chicagoDate();

  if (req.method === "GET") {
    const liClientId = String(req.query?.liClientId || "");
    if (!UUID.test(liClientId)) return res.status(400).json({ error: "liClientId is required." });
    const [{ data, error }, seq] = await Promise.all([
      admin.from("linkedin_prospects").select(COLS).eq("li_client_id", liClientId).order("accepted_on", { ascending: false }).limit(1000),
      stepsFor(admin, liClientId),
    ]);
    if (error) return res.status(500).json({ error: error.message });
    const rows = (data || []).map((p) => ({ ...p, next: nextStep(p, seq.steps) }));
    return res.status(200).json({ today, variant: seq.variant, hasSequence: seq.steps.length > 0, prospects: rows });
  }

  const body = await readJson(req);
  if (req.method === "POST") {
    const liClientId = String(body?.liClientId || "");
    if (!UUID.test(liClientId)) return res.status(400).json({ error: "liClientId is required." });
    const acceptedOn = DATE.test(String(body?.acceptedOn || "")) ? body.acceptedOn : today;
    if (acceptedOn > today) return res.status(400).json({ error: "The accepted date can't be in the future." });
    const listId = UUID.test(String(body?.listId || "")) ? body.listId : null;
    const people = parseProspectLines(body?.lines);
    if (!people.length) return res.status(400).json({ error: "Paste at least one name, one per line." });
    const rows = people.map((p) => ({ li_client_id: liClientId, name: p.name, profile_url: p.profile_url, list_id: listId, accepted_on: acceptedOn, created_by: member.user.id }));
    /* The same person pasted twice is one row: repeats (same name, same
     * link) are skipped here, and the unique index is the backstop. */
    const { data: have } = await admin.from("linkedin_prospects").select("name, profile_url").eq("li_client_id", liClientId).limit(5000);
    const key = (r) => `${String(r.name).toLowerCase()}|${r.profile_url || ""}`;
    const seen = new Set((have || []).map(key));
    const fresh = rows.filter((r) => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; });
    if (!fresh.length) return res.status(200).json({ added: 0, skipped: rows.length });
    const { data, error } = await admin.from("linkedin_prospects").insert(fresh).select("id");
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ added: data?.length || 0, skipped: rows.length - (data?.length || 0) });
  }

  if (req.method === "PATCH") {
    const id = String(body?.id || "");
    if (!UUID.test(id)) return res.status(400).json({ error: "id is required." });
    const { data: p } = await admin.from("linkedin_prospects").select(COLS).eq("id", id).maybeSingle();
    if (!p) return res.status(404).json({ error: "Prospect not found." });
    let patch;
    switch (body?.action) {
      case "sent": {
        if (p.status !== "active") return res.status(409).json({ error: "This person isn't in the follow-up run any more." });
        if (p.last_step >= 4) return res.status(409).json({ error: "All 4 messages are already sent." });
        const step = p.last_step + 1;
        patch = { last_step: step, last_sent_on: today, prev_sent_on: p.last_sent_on, ...(step >= 4 ? { status: "done" } : {}) };
        break;
      }
      case "replied": patch = { status: "replied" }; break;    // log the reply itself in "Log a reply"
      case "done": patch = { status: "done" }; break;
      case "undo":
        /* Undo the last thing: a "replied"/"done" mark, else the last "sent".
         * A run finished by sending message 4 goes back to step 3 and active
         * (6 Nov check: it used to stay stuck at 4). */
        if (p.status !== "active" && !(p.status === "done" && p.last_step === 4)) patch = { status: "active" };
        else if (p.last_step > 1 && !p.prev_sent_on) return res.status(409).json({ error: "Only the last step can be undone. Ask Ryder to fix anything older." });
        else if (p.last_step > 0) patch = { status: "active", last_step: p.last_step - 1, last_sent_on: p.last_step - 1 > 0 ? p.prev_sent_on : null, prev_sent_on: null };
        else return res.status(409).json({ error: "Nothing to undo." });
        break;
      default: return res.status(400).json({ error: "Unknown action." });
    }
    const { error } = await admin.from("linkedin_prospects").update(patch).eq("id", id);
    return error ? res.status(500).json({ error: error.message }) : res.status(200).json({ ok: true });
  }
  res.setHeader("Allow", "GET, POST, PATCH");
  return res.status(405).json({ error: "Method not allowed." });
}
