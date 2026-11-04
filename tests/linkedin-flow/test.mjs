/* LinkedIn Outreach flow (Builds 2-5): stages, Late / Due today, Julie's
 * queue, reply classifier, reports, draft emails, tokens. 4 Nov 2026.
 * Run: node tests/linkedin-flow/test.mjs — no key, no network. */
import { FLOW_STAGES, canAutoMove, isStage, lateItems, julieQueue, previousBusinessDay, chicagoDate, sendSchedule } from "../../lib/linkedin-flow.js";
import { CLASSES, ACTIONS, parseClassification, classify, override, buildSystem as replySystem } from "../../lib/linkedin-replies.js";
import { reportsDue, periodTotals, classificationCounts, parseReportLines, reportEmail } from "../../lib/linkedin-reports.js";
import { draftEmail } from "../../lib/linkedin-emails.js";
import { newToken, hashToken, looksLikeToken } from "../../lib/linkedin-tokens.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); } };

// ---- stages
ok("11 stages in the brief's order", FLOW_STAGES.map(([id]) => id).join() === "form_received,paid,building,in_review,approved,access_scheduled,live,report_due,renewed,paused,churned");
ok("paid -> building is automatic", canAutoMove("paid", "building"));
ok("in_review -> building (client asked for changes)", canAutoMove("in_review", "building"));
ok("live -> building is NOT automatic (a revision doesn't drag a live client back)", !canAutoMove("live", "building"));
ok("anything can pause", canAutoMove("live", "paused") && canAutoMove("paid", "paused"));
ok("churned stays churned automatically", !canAutoMove("churned", "paused"));
ok("isStage", isStage("live") && !isStage("nope"));

// ---- dates
ok("previous business day of a Monday is Friday", previousBusinessDay("2026-11-09") === "2026-11-06");
ok("previous business day of a Wednesday is Tuesday", previousBusinessDay("2026-11-04") === "2026-11-03");
ok("Chicago date at 03:00 UTC is the day before", chicagoDate(new Date("2026-11-04T03:00:00Z")) === "2026-11-03");

const now = new Date("2026-11-10T18:00:00Z"); // Tue 10 Nov, noon CT
const late = lateItems([
  { id: "a", company: "A", flow_stage: "building", build_due_at: "2026-11-09T12:00:00Z" },
  { id: "b", company: "B", flow_stage: "paid", build_due_at: "2026-11-10T22:00:00Z" },
  { id: "c", company: "C", flow_stage: "live", launch_date: "2026-11-02" },
  { id: "d", company: "D", flow_stage: "live", launch_date: "2026-11-02" },
  { id: "e", company: "E", flow_stage: "access_scheduled", booking_at: "2026-11-10T20:00:00Z" },
  { id: "f", company: "F", flow_stage: "live", launch_date: "2026-10-01", midmonth_due: "2026-10-15", report_due: "2026-10-30" },
  { id: "g", company: "G", flow_stage: "paused", build_due_at: "2026-11-01T00:00:00Z" },
], { c: ["2026-11-09"], f: ["2026-11-09"] }, { now, reports: { f: ["midmonth"] } });
const has = (id, level, re) => late.some((x) => x.id === id && x.level === level && re.test(x.what));
ok("copy past its 48 h is late", has("a", "late", /were due/));
ok("copy due later today is 'today'", has("b", "today", /due today/));
ok("live with yesterday logged is fine", !late.some((x) => x.id === "c"));
ok("live with no row for the last business day is late", has("d", "late", /No activity logged for 2026-11-09/));
ok("a login slot today shows", has("e", "today", /slot is today/));
ok("a report already written isn't late; a missing one is", !late.some((x) => x.id === "f" && /Mid-month/.test(x.what)) && has("f", "late", /Day-30 report was due/));
ok("paused clients are left out", !late.some((x) => x.id === "g"));
ok("late items come first", late[0].level === "late");

const q = julieQueue(
  [{ id: "a", company: "A", flow_stage: "live", launch_date: "2026-11-02" }, { id: "e", company: "E", flow_stage: "access_scheduled", booking_at: "2026-11-10T20:00:00Z" }, { id: "b", company: "B", flow_stage: "building" }],
  [{ li_client_id: "a", name: "Jane", needs_review: true }, { li_client_id: "a", name: "Tom", reply_status: "nurture", reactivation_date: "2026-11-10" }, { li_client_id: "a", name: "Old", reply_status: "nurture", reactivation_date: "2026-12-01" }],
  {}, { now });
ok("queue: login slot first", q[0].kind === "login" && /CT/.test(q[0].what));
ok("queue: a reply to check", q.some((x) => x.kind === "review" && /Jane/.test(x.what)));
ok("queue: a reactivation due today, not a future one", q.some((x) => /Tom/.test(x.what)) && !q.some((x) => /Old/.test(x.what)));
ok("queue: live account with no log today", q.some((x) => x.kind === "log" && x.company === "A"));
ok("queue: copy to review", q.some((x) => x.kind === "copy" && x.company === "B"));
ok("send schedule: days after acceptance", sendSchedule({ variants: [{ name: "Direct", steps: [{ step: 1, delay_days: 1 }, { step: 2, delay_days: 2 }, { step: 3, delay_days: 4 }, { step: 4, delay_days: 7 }] }] }, "Direct").map((s) => s.dayAfterAccept).join() === "1,3,7,14");

// ---- replies
const answers = { contact_name: "Dana Ruiz", about_business: "We fix water heaters in Tampa. 24 years." };
const raiser = { contact_name: "Pat Lee", about_business: "We are forming an SPV with a preferred return." };
const P = (o, a = answers) => parseClassification(JSON.stringify(o), { answers: a, today: "2026-11-10" });
ok("the brief's 7 classes", CLASSES.length === 7 && CLASSES.includes("Out of office"));
ok("Interested = lead, client + CJ told", ACTIONS.Interested.status === "lead" && ACTIONS.Interested.notify === "client+cj");
ok("Not interested = closed, nobody told", ACTIONS["Not interested"].status === "closed" && !ACTIONS["Not interested"].notify);
const r1 = P({ classification: "interested", confidence: 0.9, suggested_reply: "Great, Tuesday or Wednesday for a short call?", summary: "Wants a call" });
ok("case-insensitive class, lead, no review", r1.ok && r1.classification === "Interested" && r1.reply_status === "lead" && !r1.needs_review);
ok("under 0.6 waits for Julie", P({ classification: "Question", confidence: 0.4, suggested_reply: "Happy to explain — when works?" }).needs_review);
ok("Not now without a date -> 30 days out", P({ classification: "Not now", confidence: 0.9, suggested_reply: "Understood." }).reactivation_date === "2026-12-10");
ok("Out of office keeps the date it gave", P({ classification: "Out of office", confidence: 0.9, reactivation_date: "2026-11-20", suggested_reply: "Thanks." }).reactivation_date === "2026-11-20");
ok("Interested never gets a reactivation date", P({ classification: "Interested", confidence: 0.9, reactivation_date: "2026-11-20", suggested_reply: "Great — call Tuesday?" }).reactivation_date === null);
ok("an unknown class fails", !P({ classification: "Maybe", confidence: 0.9 }).ok);
ok("an invented number in the suggested reply forces review", P({ classification: "Interested", confidence: 0.95, suggested_reply: "We've helped 300 buildings. Call Tuesday?" }).needs_review);
ok("a securities client's suggested reply with returns forces review", P({ classification: "Interested", confidence: 0.95, suggested_reply: "Our preferred return is strong. Call?" }, raiser).needs_review);
ok("confidence is clamped", P({ classification: "Question", confidence: 7, suggested_reply: "Sure — when?" }).confidence === 1);
ok("regulated reply prompt carries the rule", /regulated/.test(replySystem(raiser)) && !/regulated/.test(replySystem(answers)));
let n = 0;
const cr = await classify({ answers, reply: "Sounds good", today: "2026-11-10", draftFn: async () => { n += 1; return { text: n === 1 ? "not json" : JSON.stringify({ classification: "Interested", confidence: 0.8, suggested_reply: "Great — call Tuesday?" }), usage: {} }; } });
ok("classify retries once on bad JSON", cr.ok && cr.calls.length === 2);
ok("override: Not now -> nurture + 30 days", JSON.stringify(override("Not now", "2026-11-10")) === JSON.stringify({ classification: "Not now", reply_status: "nurture", notify: null, reactivation_date: "2026-12-10", needs_review: false }));
ok("override refuses an unknown class", override("Bogus", "2026-11-10") === null);

// ---- reports
const e = { launch_date: "2026-11-02", midmonth_due: "2026-11-16", report_due: "2026-12-01" };
ok("nothing due before mid-month", reportsDue(e, "2026-11-15").length === 0);
ok("mid-month due on its day", reportsDue(e, "2026-11-16").map((x) => x.kind).join() === "midmonth");
ok("both due later, minus any written", reportsDue(e, "2026-12-02", ["midmonth"]).map((x) => x.kind).join() === "day30");
const daily = [{ day: "2026-11-02", connections_sent: 20, accepted: 5, replies: 2, inmails: 3 }, { day: "2026-11-03", connections_sent: 20, accepted: 4, replies: 1, inmails: 0 }, { day: "2026-11-20", connections_sent: 99 }];
const reps = [{ day: "2026-11-03", name: "Jane", reply_status: "lead", classification: "Interested" }, { day: "2026-11-04", name: "Tom", reply_status: "nurture", classification: "Not now" }, { day: "2026-11-30", name: "Late", reply_status: "lead" }];
const pt = periodTotals(daily, reps, "2026-11-02", "2026-11-16");
ok("totals are sums inside the period only", pt.totals.connections_sent === 40 && pt.totals.accepted === 9 && pt.totals.inmails === 3 && pt.totals.replies === 3 && pt.totals.days_logged === 2);
ok("leads come from classified replies", pt.totals.leads === 1 && pt.leadNames.join() === "Jane");
ok("classification counts", JSON.stringify(classificationCounts(reps, "2026-11-02", "2026-11-16")) === JSON.stringify({ Interested: 1, "Not now": 1 }));
ok("report lines parse; day-30 keeps 2 recommendations", parseReportLines('{"summary":"Good start.","recommendations":["a","b","c"]}', "day30").recommendations.length === 2);
ok("mid-month never carries recommendations", parseReportLines('{"summary":"x","recommendations":["a"]}', "midmonth").recommendations.length === 0);
const mail = reportEmail("day30", { contactName: "Daniel Yearwood", company: "8th St", start: "2026-11-02", end: "2026-12-01", totals: pt.totals, leadNames: pt.leadNames, summary: "Good start.", recommendations: ["Work list 2 next.", "Test Message 2."] });
ok("report email has every number and the names", /Connection requests sent: 40/.test(mail.text) && /Leads: 1 \(Jane\)/.test(mail.text) && /For next month:/.test(mail.text) && /Hi Daniel,/.test(mail.text));

// ---- emails
for (const k of ["resources_ready", "revision_coming", "revised_ready", "approved_book", "live", "lead_alert"]) {
  const m = draftEmail(k, { contactName: "Daniel Y", company: "8th St", approvalUrl: "https://x/li/approve/?t=1", pinUrl: "https://x/li/pin/?t=1", prospect: "Jane", message: "Yes", suggested: "Great" });
  ok(`email ${k} drafts`, m && m.subject && /Hi Daniel,/.test(m.text));
}
ok("approved_book includes the PIN page and never asks for a password", /li\/pin/.test(draftEmail("approved_book", { pinUrl: "https://x/li/pin/?t=1" }).text) && !/send (us )?your password/i.test(draftEmail("approved_book", {}).text));
ok("no booking link -> asks for a time", /Reply with a time/.test(draftEmail("approved_book", { pinUrl: "p" }).text));
ok("unknown kind -> null", draftEmail("nope") === null);

// ---- tokens
const t = newToken();
ok("token looks right and is long", looksLikeToken(t) && t.length >= 43);
ok("hash is stable and not the token", hashToken(t) === hashToken(t) && hashToken(t) !== t && hashToken(t).length === 64);
ok("junk isn't a token", !looksLikeToken("abc") && !looksLikeToken("'; drop table"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
