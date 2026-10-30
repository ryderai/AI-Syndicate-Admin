/* The LinkedIn Outreach onboarding questions, in form order, for the console's
 * LinkedIn page. 30 Oct 2026.
 *
 * THE SOURCE OF TRUTH IS THE WEBSITE: ai-syndicate-live/lib/linkedin-onboarding.js
 * (SECTIONS). The form at aisyndicate.com/onboarding/linkedin/ and its API are
 * built from that list; this is a copy of its keys and labels so the console
 * can print answers in the same order with the same words. If a question is
 * added there and not here, it still shows — under "Other answers", with its
 * key as the label — so nothing a client typed is ever hidden. Pure. */

export const SECTIONS = [
  { id: "contact", title: "Contact details", fields: [
    ["contact_name", "Name"], ["contact_email", "Email"], ["contact_phone", "Phone"],
    ["company", "Company"], ["website", "Website"],
  ] },
  { id: "linkedin", title: "LinkedIn account", fields: [
    ["sales_nav", "Sales Navigator Core active?"], ["two_factor_on", "Two-step verification (2FA) on?"],
    ["id_verified", "ID verified on LinkedIn?"], ["linkedin_url", "Profile to run outreach from"],
  ] },
  { id: "business", title: "Business and ideal client", fields: [
    ["about_business", "About the business"], ["client_problem", "Ideal client's biggest problem"],
    ["client_goal", "What the ideal client wants"], ["client_steps", "Steps to results"],
    ["free_resources", "Free resources to share"], ["files_resources", "Free resources (files)"],
    ["job_titles", "Job titles to target"], ["industries", "Industries to target"],
    ["headcount", "Company sizes"], ["locations", "Locations"],
    ["exclusions", "Do not contact"], ["files_exclusions", "Exclusion list (files)"],
    ["case_studies", "Case studies, scripts, templates"], ["files_case_studies", "Case studies (files)"],
    ["goals", "Goals for the service"],
  ] },
];

const KNOWN = new Set(SECTIONS.flatMap((s) => s.fields.map(([k]) => k)));

/** Sections of { key, label, value, files } in form order, plus "Other
 * answers" for any key the copy above doesn't know. Pure. */
export function answerSections(answers = {}, files = []) {
  const list = Array.isArray(files) ? files : [];
  const out = SECTIONS.map((s) => ({
    id: s.id,
    title: s.title,
    rows: s.fields.map(([key, label]) => {
      if (key.startsWith("files_")) return { key, label, files: list.filter((f) => f.field === key), value: "" };
      const v = answers?.[key];
      return { key, label, value: Array.isArray(v) ? v.join(", ") : String(v ?? "") };
    }),
  }));
  const extra = Object.keys(answers || {}).filter((k) => !KNOWN.has(k) && String(answers[k] ?? "").trim());
  if (extra.length) out.push({ id: "other", title: "Other answers", rows: extra.map((k) => ({ key: k, label: k, value: Array.isArray(answers[k]) ? answers[k].join(", ") : String(answers[k]) })) });
  return out;
}

/** Account set-up answers that aren't a plain Yes — the things to sort before launch. Pure. */
export function readinessFlags(answers = {}) {
  const out = [];
  if (answers.sales_nav && answers.sales_nav !== "Yes") out.push(`Sales Navigator: ${answers.sales_nav}`);
  if (answers.two_factor_on && answers.two_factor_on !== "Yes") out.push(`2FA on: ${answers.two_factor_on}`);
  if (answers.id_verified && answers.id_verified !== "Yes") out.push(`ID verified: ${answers.id_verified}`);
  return out;
}

export const STAGES = [
  ["new", "New"], ["setting_up", "Setting up"], ["live", "Live"], ["paused", "Paused"], ["ended", "Ended"],
];

/* The Monday that starts a YYYY-MM-DD's week, as YYYY-MM-DD. Strings only: a
 * plain date handed to new Date() is midnight UTC, the evening before in
 * Chicago (CONTEXT-FOR-AI §18). Pure. */
export function weekOf(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** Daily rows -> weekly totals, newest week first. Pure. */
export function weeklyTotals(rows = []) {
  const weeks = new Map();
  for (const r of rows) {
    const w = weekOf(r.day);
    if (!w) continue;
    const t = weeks.get(w) || { week: w, connections_sent: 0, accepted: 0, replies: 0, inmails: 0, leads: 0, days: 0 };
    for (const k of ["connections_sent", "accepted", "replies", "inmails", "leads"]) t[k] += Number(r[k]) || 0;
    t.days += 1;
    weeks.set(w, t);
  }
  return [...weeks.values()].sort((a, b) => (a.week < b.week ? 1 : -1));
}

/** Accepted ÷ sent and replies ÷ accepted, as whole percents, or null when the
 * bottom is 0 ("not measured", never a fake 0%). Pure. */
export function rates(t) {
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
  return { acceptRate: pct(t.accepted, t.connections_sent), replyRate: pct(t.replies, t.accepted) };
}
