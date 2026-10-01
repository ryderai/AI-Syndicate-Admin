/* The Heat map page's two reads.  30 Sep 2026.
 * Kept out of data.js (5,000+ lines) so this feature can be read, reviewed and
 * reverted as one small file. */

import { getSupabase, isConfigured } from "./supabase.js";
import { rollupFromRows } from "../../lib/heat-map.js";
import { heatPreviewRows } from "./heatPreview.js";

/** One page's heat numbers for a window, filtered.
 * Returns { data, sample?, error?, missing? }. `missing` is true when the
 * database answered that hs_heat_rollup does not exist — migration 0046 has
 * not been run — so the page can say exactly that instead of a raw error. */
export async function getHeatRollup({ slug, fromMs, toMs, device = null, source = null, content = null, who = "all" }) {
  if (!isConfigured()) {
    const { views, clicks, leadSessions } = heatPreviewRows();
    const leads = leadSessions.filter((l) => l.slug === slug).map((l) => l.session_id);
    return { data: rollupFromRows(views, clicks, leads, { slug, fromMs, toMs, device, source, content, who }), sample: true };
  }
  const { data, error } = await getSupabase().rpc("hs_heat_rollup", {
    p_slug: slug,
    p_from: fromMs != null ? new Date(fromMs).toISOString() : null,
    p_to: toMs != null ? new Date(toMs).toISOString() : null,
    p_device: device || null,
    p_source: source || null,
    p_content: content || null,
    p_who: who || "all",
  });
  if (error) {
    const missing = /hs_heat_rollup|function .* does not exist|PGRST202/i.test(`${error.code || ""} ${error.message || ""}`);
    return { data: null, error: error.message || String(error), missing };
  }
  return { data };
}

/** The pictures' manifest (public/heat/snapshots.json), or null. */
export async function getHeatSnapshots() {
  try {
    const r = await fetch("/heat/snapshots.json", { cache: "no-cache" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
