/* NEW-LEAD ALERTS TO SLACK #leads, THROUGH MAKE.COM — 18 Oct 2026.
 *
 * Why this exists: before today a lead off the landing pages only landed on the
 * admin Sales page, and nobody was told. The sales team works out of Slack, and
 * a lead called in five minutes is worth far more than one called tomorrow.
 *
 * How it works: one small JSON body is POSTed to MAKE_LEADS_WEBHOOK_URL, a Make
 * custom webhook ("AI Syndicate site leads", scenario "Site leads (landing pages
 * + website) to Slack #leads"). Make posts `slack_text` into #leads as it is.
 * The other fields ride along so Make can grow (a CRM row, a sheet) without a
 * code change.
 *
 * Meta lead-form leads do NOT come through here — Make reads those from Meta
 * directly (scenario "Meta lead form to Slack #leads"). Both use the same card
 * layout, so the channel reads as one list.
 *
 * Rules:
 *   - Unset env = a silent no-op. Nothing in the request path depends on it.
 *   - Never throws, time-boxed (4 s): it is awaited inside the visitor's
 *     request because Vercel freezes the function once the response is sent.
 *   - Only ever posts to a hook.<region>.make.com URL — the URL is the secret,
 *     and lead details must not go anywhere else by a typo in an env var.
 *   - Everything a stranger typed is escaped for Slack, so a name like
 *     "<!channel>" cannot ping the whole team.
 *   - "Can call? Yes" is said ONLY when this lead carries recorded consent.
 *     Anything else says "No". Unknown is never shown as yes.
 *
 * This file is copied, byte for byte, into both repos (ai-syndicate-admin and
 * ai-syndicate-live). Change one, change the other.
 */

const POST_TIMEOUT_MS = 4000;
const TEAM_TZ = "America/Chicago";

export function makeLeadsWebhookUrl(env = process.env) {
  const raw = String(env?.MAKE_LEADS_WEBHOOK_URL || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || !/^hook\.[a-z0-9-]+\.make\.com$/.test(host)) return "";
    return u.toString();
  } catch {
    return "";
  }
}

export function isLeadAlertConfigured(env = process.env) {
  return Boolean(makeLeadsWebhookUrl(env));
}

/** Slack mrkdwn escaping — the three characters Slack itself requires. */
export function escapeSlack(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

/** "5125550100" / "15125550100" / "+15125550100" -> "(512) 555-0100". Anything
 * that is not a 10-digit US number is shown as typed, digits only, with a +. */
export function formatPhone(raw) {
  const d = String(raw ?? "").replace(/\D+/g, "");
  if (!d) return "";
  const us = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (us.length === 10) return `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}`;
  return `+${d}`;
}

/** Where the visit came from, in words a rep can use on the phone. */
export function sourceLabel(utm = {}) {
  const src = String(utm?.source || utm?.utm_source || "").toLowerCase();
  const campaign = String(utm?.campaign || utm?.utm_campaign || "").trim();
  let label = "";
  if (/^(fb|facebook|ig|instagram|meta)$/.test(src) || src.includes("facebook") || src.includes("meta")) label = "Meta ad";
  else if (src.includes("google")) label = "Google";
  else if (src) label = src;
  if (!label) return "";
  return campaign ? `${label} (${campaign})` : label;
}

/** "Sun Oct 18, 1:05 PM CT" in the team's own clock. */
export function teamTime(now = new Date()) {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(now);
  return `${s} CT`;
}

/** "Landing page /free-ai-score/" -> "Landing page", "Website free AI score" -> "Website".
 * The card headline names the kind of form, not the exact page. */
export function shortSource(where) {
  const w = String(where || "").trim();
  if (/^landing page/i.test(w)) return "Landing page";
  if (/^revenue calculator/i.test(w)) return "Revenue calculator";
  if (/^website/i.test(w)) return "Website";
  return w;
}

/** "https://www.Acme.com/" and "acme.com" are the same site. */
function sameSite(a, b) {
  const n = (x) => String(x || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  return Boolean(n(a)) && n(a) === n(b);
}

/**
 * Build the payload for one alert. Pure.
 *
 * The card (picked by Ryder, 18 Oct 2026, "Labeled list"): one headline, then
 * the same six labeled lines on every card, "—" when we don't have it, so a rep
 * always finds the phone in the same place. No score, no ad codes and no claim
 * line on the card: the reaction key lives in the #leads channel description.
 *
 * @param {object} o
 * @param {"new_lead"|"phone_added"} o.event
 * @param {string} o.where       e.g. "Landing page /free-ai-score/" or "Website free AI score"
 * @param {string} [o.name]
 * @param {string} [o.company]
 * @param {string} [o.email]
 * @param {string} [o.phone]
 * @param {string} [o.website]   host, e.g. "acme.com"
 * @param {boolean} [o.callConsent]  true ONLY when this lead carries recorded call/text consent
 * @param {number|null} [o.score]    0-100 (kept in the payload, not shown)
 * @param {object} [o.utm]
 * @param {string} [o.note]      one extra line (e.g. why a scan failed)
 * @param {Date} [o.now]
 */
export function buildLeadAlert({
  event = "new_lead", where = "", name = "", company = "", email = "", phone = "", website = "",
  callConsent = false, score = null, utm = null, note = "", now = new Date(),
} = {}) {
  const phoneText = formatPhone(phone);
  const okToCall = Boolean(callConsent && phoneText);
  const source = sourceLabel(utm || {});
  const ad = source.replace(/\s*\(.*\)$/, "");
  const kind = shortSource(where);
  const from = ad && ad.toLowerCase() !== kind.toLowerCase() ? ` (from ${ad})` : "";
  const head = event === "phone_added"
    ? `:large_yellow_circle: *Same lead, now has a phone · ${escapeSlack(kind)}${escapeSlack(from)}*`
    : `:large_green_circle: *New lead · ${escapeSlack(kind)}${escapeSlack(from)}*`;
  const v = (x) => escapeSlack(String(x || "").trim()) || "—";
  const business = sameSite(company, website) ? "" : company;
  const canCall = okToCall ? ":white_check_mark: Yes"
    : phoneText ? ":no_entry: No, email only"
      : ":no_entry: No phone, email only";

  const lines = [
    head,
    `*Name:* ${v(name)}`,
    `*Business:* ${v(business)}`,
    `*Website:* ${v(website)}`,
    `*Phone:* ${v(phoneText)}`,
    `*Email:* ${v(email)}`,
    `*Can call?* ${canCall}`,
  ];
  if (note) lines.push(`*Note:* ${escapeSlack(note)}`);

  return {
    event,
    source: where,
    name: name || "",
    company: company || "",
    email: email || "",
    phone: phone || "",
    phone_display: phoneText,
    website: website || "",
    ok_to_call: okToCall ? "yes" : phoneText ? "no_consent_on_record" : "no_phone",
    score: Number.isInteger(score) ? score : null,
    campaign: source,
    time_ct: teamTime(now),
    slack_text: lines.join("\n"),
  };
}

/** Post one alert. Never throws; returns { ok, skipped?, error? }. */
export async function postLeadAlert(alert, { fetchImpl = fetch, env = process.env } = {}) {
  const url = makeLeadsWebhookUrl(env);
  if (!url) return { ok: false, skipped: true };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(alert),
      redirect: "manual",
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[lead-alert] post failed: ${res.status} ${String(body).slice(0, 200)}`);
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.warn("[lead-alert] post threw:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}
