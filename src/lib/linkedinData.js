/* The LinkedIn page's reads and writes. 30 Oct 2026.
 *
 * Tables: migration 0048_linkedin_clients.sql. Every one is gated by
 * linkedin_can_work() in the database (owners + admins today), so these run as
 * the signed-in user with no server in between — the same as Operations.
 * With sign-in off (preview), a small sample store stands in and every card
 * says SAMPLE. */
import { getSupabase, isConfigured } from "./supabase.js";

export const FORM_URL = "https://www.aisyndicate.com/onboarding/linkedin/";
export const BUCKET = "linkedin-onboarding";
const live = () => isConfigured();
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const pid = () => `s-${Math.random().toString(36).slice(2, 10)}`;

/* The client columns the console reads. Never edit_key_hash: that belongs to
 * the client's resume link, not to us. */
const CLIENT_COLS = "id, status, stage, flow_stage, company, contact_name, contact_email, linkedin_url, ref, source, answers, files, owner_id, client_id, notes, last_saved_at, submitted_at, team_emailed_at, created_at, updated_at";

export const TRACKERS = {
  daily: { table: "linkedin_daily_activity", order: "day" },
  searches: { table: "linkedin_searches", order: "created_at" },
  sequences: { table: "linkedin_sequences", order: "created_at" },
  responses: { table: "linkedin_responses", order: "created_at" },
};

/* ---------- preview ---------- */
const sampleId = "00000000-0000-4000-8000-0000000000a1";
const store = {
  clients: [{
    id: sampleId, status: "submitted", stage: "setting_up", company: "Sample Consulting (preview)", contact_name: "Dana Sample",
    contact_email: "dana@sample.test", linkedin_url: "https://www.linkedin.com/in/sample", ref: "netwrks", source: "website",
    answers: {
      contact_name: "Dana Sample", contact_email: "dana@sample.test", contact_phone: "(205) 555-0100", company: "Sample Consulting (preview)",
      sales_nav: "Yes", two_factor_on: "No", id_verified: "Yes", linkedin_url: "https://www.linkedin.com/in/sample",
      about_business: "Preview data. Nothing here is a real client.", client_problem: "—", client_goal: "—", client_steps: "—",
      free_resources: "None yet", job_titles: "Founder, CEO", industries: "SaaS", headcount: ["11-50 employees"], locations: "Southeast US", goals: "8 meetings a month",
    },
    files: [], owner_id: null, client_id: null, notes: "", submitted_at: new Date().toISOString(), team_emailed_at: new Date().toISOString(), created_at: new Date().toISOString(),
  }],
  daily: [{ id: pid(), li_client_id: sampleId, day: today(), connections_sent: 20, accepted: 6, replies: 2, inmails: 0, leads: 1, lead_names: "Sample lead" }],
  searches: [], sequences: [], responses: [],
};

/* ---------- clients ---------- */
export async function listLiClients() {
  if (!live()) return { rows: [...store.clients], sample: true };
  /* Sales-page sign-ups (0053) are shown on their own card, and are kept out
   * HERE, on the server, so a burst of them can't push real clients past
   * the 500-row limit (6 Nov check). Before 0053, no row has those statuses. */
  const { data, error } = await getSupabase().from("linkedin_clients").select(CLIENT_COLS).not("status", "in", "(signup,merged)").order("created_at", { ascending: false }).limit(500);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function updateLiClient(id, patch) {
  if (!live()) {
    const r = store.clients.find((c) => c.id === id);
    if (r) Object.assign(r, patch);
    return { ok: true, row: r, sample: true };
  }
  const { data, error } = await getSupabase().from("linkedin_clients").update(patch).eq("id", id).select(CLIENT_COLS).maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

/** A client added by hand (one who never filled in the form). */
export async function addLiClient({ company, contact_name, contact_email }) {
  const answers = { company, contact_name, contact_email };
  const row = { company, contact_name, contact_email, answers, source: "console", status: "submitted", submitted_at: new Date().toISOString() };
  if (!live()) {
    const r = { id: pid(), stage: "new", files: [], created_at: new Date().toISOString(), ...row };
    store.clients.unshift(r);
    return { ok: true, row: r, sample: true };
  }
  const { data, error } = await getSupabase().from("linkedin_clients").insert(row).select(CLIENT_COLS).maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

/** A short-lived link to an uploaded file (private bucket). */
export async function fileLink(path) {
  if (!live()) return { ok: false, error: "Files open on the live console only." };
  const { data, error } = await getSupabase().storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return { ok: false, error: error?.message || "No link" };
  return { ok: true, url: data.signedUrl };
}

/* ---------- the four tracker tabs ---------- */
export async function listTracker(kind, liId) {
  const t = TRACKERS[kind];
  if (!live()) return { rows: store[kind].filter((r) => r.li_client_id === liId), sample: true };
  const { data, error } = await getSupabase().from(t.table).select("*").eq("li_client_id", liId).order(t.order, { ascending: false }).limit(1000);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function addTrackerRow(kind, row) {
  const t = TRACKERS[kind];
  if (!live()) { const r = { id: pid(), ...row }; store[kind].unshift(r); return { ok: true, row: r, sample: true }; }
  const { data, error } = await getSupabase().from(t.table).insert(row).select("*").maybeSingle();
  if (error) return { ok: false, error: /duplicate key/i.test(error.message) ? "That day already has a row. Edit it instead." : error.message };
  return { ok: true, row: data };
}

export async function updateTrackerRow(kind, id, patch) {
  const t = TRACKERS[kind];
  if (!live()) { const r = store[kind].find((x) => x.id === id); if (r) Object.assign(r, patch); return { ok: true, row: r, sample: true }; }
  const { data, error } = await getSupabase().from(t.table).update(patch).eq("id", id).select("*").maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

export async function deleteTrackerRow(kind, id) {
  const t = TRACKERS[kind];
  if (!live()) { store[kind] = store[kind].filter((x) => x.id !== id); return { ok: true, sample: true }; }
  const { error } = await getSupabase().from(t.table).delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export { today };
