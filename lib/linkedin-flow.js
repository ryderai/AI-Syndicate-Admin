/* LINKEDIN OUTREACH — the client flow: stages, dates, Late / Due today, and
 * Julie's queue. 4 Nov 2026. Pure (no database, no network).
 *
 * CJ's brief, Build 3: "Stages, in order: Form received → Paid → Building →
 * In review → Approved → Access scheduled → Live → Report due → Renewed,
 * with Paused and Churned as exits from any stage." Build 5: "Julie's queue
 * ... a single view across all her accounts" and "Late / Due today on the
 * Overview should show any Live engagement with no activity row for a
 * business day". The database trigger in 0052 computes the dates; this file
 * reads them. */

export const FLOW_STAGES = Object.freeze([
  ["form_received", "Form received"],
  ["paid", "Paid"],
  ["building", "Building"],
  ["in_review", "In review"],
  ["approved", "Approved"],
  ["access_scheduled", "Access scheduled"],
  ["live", "Live"],
  ["report_due", "Report due"],
  ["renewed", "Renewed"],
  ["paused", "Paused"],
  ["churned", "Churned"],
]);
const ORDER = FLOW_STAGES.map(([id]) => id);
export const stageLabel = (id) => (FLOW_STAGES.find(([s]) => s === id) || [id, id])[1];

/* The moves the system makes on its own. A person (owner or admin) may move
 * a client anywhere — that is how the brief's "moved through every stage by
 * hand" is done — and the move is written to the stage history either way. */
const AUTO = {
  form_received: ["paid"],
  paid: ["building"],
  building: ["in_review"],
  in_review: ["building", "approved"],
  approved: ["access_scheduled", "live"],
  access_scheduled: ["live"],
  live: ["report_due"],
  report_due: ["renewed", "live"],
  renewed: ["live", "report_due"],
  paused: [],
  churned: [],
};
/* Catch-up moves (4 Nov 2026 end-to-end test): a step can happen while the
 * stage is behind it, e.g. copy saved by hand never moved the client to
 * Building, so "send to client" and the client's approval were refused one
 * step at a time and the PIN page stayed shut. The action itself is the proof
 * the earlier steps happened, so a forward jump along the main line is
 * allowed. Never backwards, and never from before "paid" (payment is the gate). */
const LINE = ["paid", "building", "in_review", "approved", "access_scheduled", "live"];
export function canAutoMove(from, to) {
  if (to === "paused" || to === "churned") return from !== "churned";
  if ((AUTO[from] || []).includes(to)) return true;
  const a = LINE.indexOf(from), b = LINE.indexOf(to);
  return a >= 0 && b > a;
}
export function isStage(id) { return ORDER.includes(id); }

/* "Today" and business days, in Chicago, as YYYY-MM-DD strings (a plain date
 * handed to new Date() is midnight UTC — CONTEXT-FOR-AI §18). */
export function chicagoDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
/** The business day before `iso` (Mon -> Fri). */
export function previousBusinessDay(iso) {
  let d = addDays(iso, -1);
  for (;;) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return d;
    d = addDays(d, -1);
  }
}

/** Late / Due today for every engagement. Each item:
 * { id, company, level: "late"|"today", what }. Pure.
 * `activity` = { [li_client_id]: ["YYYY-MM-DD", ...] } (days with a row). */
export function lateItems(engagements = [], activity = {}, { now = new Date(), reports = {} } = {}) {
  const today = chicagoDate(now);
  const out = [];
  const push = (e, level, what) => out.push({ id: e.id, company: e.company || "(no company)", level, what });
  for (const e of engagements) {
    const s = e.flow_stage;
    if (s === "paused" || s === "churned") continue;
    if (["paid", "building"].includes(s) && e.build_due_at) {
      const due = chicagoDate(new Date(e.build_due_at));
      if (new Date(e.build_due_at) < now) push(e, "late", `Copy + lists were due ${due} (48 h after payment)`);
      else if (due === today) push(e, "today", "Copy + lists due today (48 h after payment)");
    }
    if (s === "access_scheduled" && e.booking_at) {
      const slot = chicagoDate(new Date(e.booking_at));
      if (slot === today) push(e, "today", "Julie's login slot is today");
      else if (slot < today) push(e, "late", `Login slot was ${slot} and the account isn't live yet`);
    }
    if (["live", "report_due", "renewed"].includes(s)) {
      const prev = previousBusinessDay(today);
      const days = new Set(activity[e.id] || []);
      if (e.launch_date && e.launch_date <= prev && !days.has(prev)) push(e, "late", `No activity logged for ${prev}`);
    }
    for (const [kind, field, label] of [["midmonth", "midmonth_due", "Mid-month report"], ["day30", "report_due", "Day-30 report"]]) {
      const due = e[field];
      if (!due || (reports[e.id] || []).includes(kind)) continue;
      if (due < today) push(e, "late", `${label} was due ${due}`);
      else if (due === today) push(e, "today", `${label} due today`);
    }
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "late" ? -1 : 1));
}

/** Julie's queue across all her accounts (the brief's Build 5). Pure.
 * replies = [{ li_client_id, name, needs_review, reply_status, reactivation_date }]
 * Follow-ups due "by step and delay" need to know when EACH prospect
 * accepted, which the data doesn't hold yet (daily rows are counts) — so the
 * queue shows each live account's sequence timing as a reminder instead,
 * and the gap is listed in the open questions. */
export function julieQueue(engagements = [], replies = [], activity = {}, { now = new Date() } = {}) {
  const today = chicagoDate(now);
  const byId = new Map(engagements.map((e) => [e.id, e]));
  const items = [];
  const add = (e, kind, what) => items.push({ id: e?.id, company: e?.company || "(no company)", kind, what });
  for (const r of replies) {
    const e = byId.get(r.li_client_id);
    if (!e) continue;
    if (r.needs_review) add(e, "review", `Check the classification of ${r.name || "a reply"}`);
    if (r.reactivation_date && r.reactivation_date <= today && r.reply_status === "nurture") add(e, "reactivate", `Follow up with ${r.name || "a prospect"} (reactivation ${r.reactivation_date})`);
  }
  for (const e of engagements) {
    if (e.flow_stage === "access_scheduled" && e.booking_at && chicagoDate(new Date(e.booking_at)) === today) add(e, "login", `Login slot ${new Date(e.booking_at).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} CT`);
    if (["live", "report_due", "renewed"].includes(e.flow_stage) && !(activity[e.id] || []).includes(today)) add(e, "log", "Log today's sends (connections, accepted, replies, InMails)");
    if (e.flow_stage === "building") add(e, "copy", "Review the drafted copy and lists, then send them to the client");
  }
  const order = { login: 0, review: 1, reactivate: 2, copy: 3, log: 4 };
  return items.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** The approved copy's sending rhythm, for the queue screen: which message
 * goes how many days after acceptance. Pure. */
export function sendSchedule(content, variantName) {
  const v = (content?.variants || []).find((x) => x.name === variantName) || content?.variants?.[0];
  if (!v) return [];
  let day = 0;
  return v.steps.map((s) => { day += Number(s.delay_days) || 0; return { step: s.step, dayAfterAccept: day }; });
}
