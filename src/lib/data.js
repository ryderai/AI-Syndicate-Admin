/* Data layer for the admin console.
 *
 * Every read/write goes through here. Two modes:
 *   LIVE     — Supabase configured → real tables, RLS applies.
 *   PREVIEW  — no Supabase keys → an in-memory sample store so the whole
 *              console can be clicked through before any key exists.
 *              Every result carries { sample: true } and the UI shows a
 *              SAMPLE badge. Nothing in preview mode persists.
 */

import { getSupabase, isConfigured } from "./supabase.js";
/* Shared with the server endpoint api/client-standing.js. It is pure (no
 * imports, no database, no fetch) precisely so both sides can use the same
 * counting rules — a client page that counted differently from the saved
 * summary would be worse than no summary. */
import { assembleFacts, deterministicStanding } from "../../lib/client-standing.js";
import { assembleConsoleFacts, deterministicConsoleReport } from "../../lib/console-report.js";
/* Same reason, one level up: the report's counting is shared with
 * api/client-report.js so preview mode and the real thing count identically. */
import { assembleReportFacts, deterministicReport, buildFactsText } from "../../lib/client-report.js";
/* The Rules of Engagement engine. Pure, and shared with api/sales-sweep.js and
 * tests/sales — the page a rep reads and the job that runs overnight must
 * never disagree about whose claim has run out. */
import { isOpenStage as isOpen } from "../../lib/sales-rules.js";
import { normaliseDomain } from "../../lib/sales-import.js";
/* The team's own day. A number typed in at 8pm in Chicago is still today to
 * everybody here; UTC would file it under tomorrow, and the database's "one
 * reading per window per day" rule counts the day it is given. */
import { teamDate } from "../../lib/brain-context.js";
/* The rep's Work page. The counting and the answer shaping are pure and shared
 * with tests/rep-brief, so preview mode and the live endpoint cannot count the
 * same rows two different ways. */
import {
  repSnapshotFromRows, buildRepPreviewAnswer, checkInstruction,
} from "./repBrief.js";
/* Live mode posts to /api/rep-report through the same wrapper every other
 * endpoint call in this console goes through — it adds the bearer token and it
 * is the thing that refuses the call in preview mode. */
import { apiFetch } from "./adminApi.js";

/* THE FLOOR (Aug 27 2026). Tags are an event log and the automatic rules that
 * produce them are pure, so both live outside this file: the rules next to
 * claimState in lib/sales-rules.js, the replay in lib/lead-tags.js. The two
 * report readers come from the sheet module because that is where "what counts
 * as a score" is already decided, and deciding it twice is deciding it wrong
 * once. */
import {
  TAG, TAG_SLUGS, checkCloseReason, checkPersonalRule, reasonLabel,
} from "../../lib/sales-rules.js";
import {
  tagIndex, eventsByLead, currentTags, currentSlugs, tagHistory, autoTagPlan,
} from "../../lib/lead-tags.js";
import { newestReportByCompany, readCompanyReport } from "./salesSheet.js";

/* ONE STAGE LADDER, replacing the outreach sheet's two overlapping columns.
 *
 * The sheet has "Contacted?" (Yes - Email / No) AND "Sales Cycle Status"
 * (Contacted / Closed - Lost / Bad contact info). Reps fill one or the other,
 * so neither can be trusted. These are the twelve the database accepts —
 * migration 0009's admin_leads_stage_check is the same list, and
 * tests/sales/test.mjs reads that constraint out of the SQL file and checks
 * the two have not drifted. */
export const LEAD_STAGES = [
  "new", "researching", "contacted", "in_conversation", "follow_up",
  "meeting", "proposal", "won", "lost", "skip_90", "bad_contact", "reopened",
];
export const LEAD_STAGE_LABELS = {
  new: "New", researching: "Researching", contacted: "Contacted",
  in_conversation: "In conversation", follow_up: "Follow up",
  meeting: "Meeting", proposal: "Proposal", won: "Won", lost: "Lost",
  skip_90: "Skip – 90+", bad_contact: "Bad contact info", reopened: "Reopened",
};
/* What each one means, shown in the picker. Same reason as the email statuses:
 * a status nobody can explain out loud does not get used. */
export const LEAD_STAGE_HELP = {
  new: "Nobody has worked this yet.",
  researching: "Claimed. Reading up on them before the first touch.",
  contacted: "We have reached out. No reply yet.",
  in_conversation: "They answered. This is a live conversation.",
  follow_up: "Waiting on them, with a reason to chase.",
  meeting: "A meeting is booked or has happened.",
  proposal: "A proposal is out with them.",
  won: "They signed. Flip them to a client from here.",
  lost: "Decided against us, or not a fit.",
  skip_90: "Their site scores 90 or above — already doing well, so not a prospect.",
  bad_contact: "The email bounces or the number is dead. Nobody's fault.",
  reopened: "Was claimed, went quiet, came back to the floor.",
};
/* The stages nobody should be chasing. `skip_90` and `bad_contact` are in here
 * on purpose — they are not failures, but a rep who keeps being nagged about a
 * firm they were told to skip stops reading the nags. Before Aug 21 2026 four
 * different places wrote a bare ["won","lost"], which is how a skipped lead
 * would have kept turning up on the Work page forever. lib/sales-rules.js
 * exports the same list; this re-export is so the pages that already import
 * from data.js do not need a second import. */
export { CLOSED_STAGES as LEAD_CLOSED_STAGES, isOpenStage as isLeadOpen } from "../../lib/sales-rules.js";
export const TASK_STATUSES = ["todo", "in_progress", "done", "blocked"];
export const TASK_STATUS_LABELS = { todo: "To do", in_progress: "In progress", done: "Done", blocked: "Blocked" };
/* Notion parity — these are the Operations database's own option lists, copied
 * word for word (data source f9655de0-c309-4335-bd74-75b71bdb5089) so a task
 * means the same thing in both places and a copy-over needs no translation. */
export const TASK_CATEGORIES = ["Access", "Business Intel", "Legal/Compliance", "Client Comms", "Billing", "Technical", "Content", "Reporting"];
export const TASK_PHASES = ["Onboarding", "Month 1", "Month 2", "Month 3", "Ongoing"];
export const TASK_PRIORITIES = ["high", "medium", "low"];
export const TASK_PRIORITY_LABELS = { high: "High", medium: "Medium", low: "Low" };
export const CLIENT_STAGES = ["Onboarding", "Week 1", "Week 2", "Week 3", "Week 4", "Week 5", "Week 6", "Week 7", "Week 8", "Ongoing", "Holding"];
export const TICKET_STATUSES = ["open", "pending", "solved", "closed"];

/* ------------------------------------------------------------------ */
/* THE TEAM INBOX                                                      */
/* ------------------------------------------------------------------ */
/* Gmail knows read/unread and nothing else. These are OUR statuses, kept in
 * admin_email_threads, and they are the whole reason the inbox page is not just
 * Gmail in a smaller window. Plain words on purpose — a status nobody can
 * explain out loud does not get used. */
export const EMAIL_STATUSES = ["new", "needs_reply", "waiting", "scheduled", "done", "ignored"];
export const EMAIL_STATUS_LABELS = {
  new: "New",
  needs_reply: "Needs reply",
  waiting: "Waiting on them",
  scheduled: "Scheduled",
  done: "Done",
  ignored: "No reply needed",
};
/* What each one means, shown in the picker so two people cannot use the same
 * word for different things. */
export const EMAIL_STATUS_HELP = {
  new: "Nobody has picked this up yet.",
  needs_reply: "Ours to answer.",
  waiting: "We replied. The ball is with them.",
  scheduled: "Answered for now, with a date to chase it.",
  done: "Finished. Leaves the Gmail inbox and gets the AIS/Done label.",
  ignored: "No reply needed — receipts, newsletters. A new message will not reopen it.",
};
export const EMAIL_PRIORITIES = ["high", "normal", "low"];
export const EMAIL_PRIORITY_LABELS = { high: "High", normal: "Normal", low: "Low" };
/* Statuses whose lists come from OUR table rather than the Gmail inbox listing,
 * because a Done thread has been archived and is not in the inbox any more. */
export const DB_DRIVEN_EMAIL_STATUSES = ["waiting", "scheduled", "done", "ignored"];

/* ------------------------------------------------------------------ */
/* PREVIEW STORE — believable but fake. Names are invented on purpose. */
/* ------------------------------------------------------------------ */

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

const previewStore = {
  clients: [
    { id: "c1", name: "Lakeside Realty Group", domain: "lakesiderealty-sample.com", stage: "Week 3", status: "active", vertical: "realtor", start_date: daysAgo(24).slice(0, 10), contact_name: "Dana W.", contact_email: "dana@sample.com", notes: "IDX feed live. GEO package week 3 of 8.", links: {}, created_at: daysAgo(24) },
    { id: "c2", name: "Harbor Injury Law", domain: "harborinjurylaw-sample.com", stage: "Ongoing", status: "active", vertical: "lawyer", start_date: daysAgo(90).slice(0, 10), contact_name: "J. Alvarez", contact_email: "j@sample.com", notes: "Monthly GEO retainer. Score 88.", links: {}, created_at: daysAgo(90) },
    { id: "c3", name: "Summit Roofing Co", domain: "summitroofing-sample.com", stage: "Onboarding", status: "prospect", vertical: "generic", start_date: null, contact_name: "Mike T.", contact_email: "mike@sample.com", notes: "Proposal sent. Waiting on signature.", links: {}, created_at: daysAgo(4) },
  ],
  tasks: [
    { id: "t1", client_id: "c1", name: "Ship llms.txt + agents.md", status: "done", category: "Technical", priority: "high", phase: "Month 1", assigned_to: "preview-user", due_date: daysAgo(10).slice(0, 10), latest_report: "All three AI files live and verified 200.", description: "What it is: write llms.txt, llms-full.txt and agents.md for the main site.\nWhy: AI answer engines read these three files before they read the pages, and the site had none.\nDone means: all three return 200 on a plain fetch with no redirect, and the office address and phone in them match the Google profile exactly.", created_at: daysAgo(12) },
    { id: "t2", client_id: "c1", name: "Schema on all listing pages", status: "in_progress", category: "Technical", priority: "high", phase: "Month 1", assigned_to: "preview-user", due_date: daysAgo(-3).slice(0, 10), latest_report: "12 of 26 pages done.", description: "What it is: add JSON-LD (hidden code that tells search engines facts) to every listing page.\nWhy: 0 of 26 listing pages carry any schema, so nothing on them can be quoted as a fact.\nDone means: every listing page validates, the price and address in the code match the page, and the re-scan shows the pages counted.", created_at: daysAgo(6) },
    { id: "t3", client_id: "c2", name: "Weekly report to client", status: "todo", category: "Reporting", priority: "medium", phase: "Ongoing", assigned_to: "preview-user", due_date: daysAgo(0).slice(0, 10), latest_report: null, created_at: daysAgo(2) },
    { id: "t4", client_id: "c2", name: "Unblock 3 AI crawlers at firewall", status: "blocked", category: "Access", priority: "high", phase: "Ongoing", assigned_to: "preview-user", due_date: null, latest_report: "Blocked until firewall login exists.", description: "What it is: allow GPTBot, ClaudeBot and PerplexityBot through the firewall.\nWhy: all three are being served a 403, so the firm cannot appear in AI answers at all.\nDone means: a fetch as each of the three bots returns 200 from outside our network.\nBlocked: nobody has the firewall login yet — it is not known which product is in front of the site.", created_at: daysAgo(20) },
    { id: "t5", client_id: "c1", name: "Re-scan after the schema rollout", status: "todo", category: "Reporting", priority: "high", phase: "Month 2", assigned_to: "preview-user", due_date: daysAgo(4).slice(0, 10), latest_report: "Waiting on the last 14 pages.", created_at: daysAgo(11) },
    { id: "t6", client_id: "c3", name: "Write the proposal follow-up email", status: "todo", category: "Content", priority: "medium", phase: "Onboarding", assigned_to: "preview-rep", due_date: daysAgo(1).slice(0, 10), latest_report: null, created_at: daysAgo(5) },
    { id: "t7", client_id: "c2", name: "Fix the second office address in schema", status: "todo", category: "Technical", priority: "low", phase: "Ongoing", assigned_to: "preview-rep", due_date: null, latest_report: null, created_at: daysAgo(3) },
    { id: "t8", client_id: "c1", name: "Quarterly review deck", status: "todo", category: "Reporting", priority: "medium", phase: "Ongoing", assigned_to: null, due_date: daysAgo(-20).slice(0, 10), latest_report: "Nobody picked this up yet.", created_at: daysAgo(1) },
    { id: "t9", client_id: "c3", name: "Send the signed agreement + first invoice", status: "todo", category: "Billing", priority: "high", phase: "Onboarding", assigned_to: "preview-rep", due_date: daysAgo(-2).slice(0, 10), latest_report: "Proposal accepted verbally.", created_at: daysAgo(2) },
    { id: "t10", client_id: "c2", name: "Two FAQ pages for the AI answers", status: "in_progress", category: "Content", priority: "medium", phase: "Ongoing", assigned_to: "preview-user", due_date: daysAgo(-6).slice(0, 10), latest_report: "First draft written, needs the firm's numbers.", created_at: daysAgo(4) },
    { id: "t11", client_id: "c1", name: "Ask about the second office address", status: "todo", category: "Client Comms", priority: "low", phase: "Month 2", assigned_to: "preview-user", due_date: daysAgo(-5).slice(0, 10), latest_report: null, created_at: daysAgo(7) },
    { id: "t12", client_id: "c3", name: "Baseline AI Access scan", status: "done", category: "Business Intel", priority: "low", phase: "Onboarding", assigned_to: "preview-user", due_date: daysAgo(3).slice(0, 10), latest_report: "Scored 61 on the first run.", created_at: daysAgo(4) },
  ],
  weekly: [
    { id: "w1", client_id: "c1", week_no: 1, target_date: daysAgo(17).slice(0, 10), week_status: "complete", readiness: "client_ready", what_we_did: "Baseline audit run. AI Access 74.", what_moved: "Baseline set.", whats_next: "Head package.", talking_points: "74 is a solid starting point for this market.", created_at: daysAgo(17) },
    { id: "w2", client_id: "c1", week_no: 2, target_date: daysAgo(10).slice(0, 10), week_status: "complete", readiness: "verified", what_we_did: "GEO head package + AI files shipped.", what_moved: "AI intent 42 → 100.", whats_next: "Listing schema.", talking_points: null, created_at: daysAgo(10) },
    { id: "w3", client_id: "c1", week_no: 3, target_date: daysAgo(3).slice(0, 10), week_status: "in_progress", readiness: "draft", what_we_did: "Listing schema rollout in progress.", what_moved: null, whats_next: null, talking_points: null, created_at: daysAgo(3) },
  ],
  /* Every state the Sales page has to be able to draw, on purpose:
   * l1  a live meeting with a proposal out
   * l2  a claim that has gone COLD — 16 days quiet, the sweep will reopen it
   * l3  a claim whose FIRST CONTACT is late — claimed, never touched
   * l4  won, already a client
   * l5  unclaimed, at a firm somebody else is already working (the warning)
   * l6  the second contact at that same firm, claimed by another rep
   * l7  a firm scoring 93 — Skip - 90+, and it must stay out of every queue
   */
  leads: [
    { id: "l1", name: "Sarah Chen", company: "Bright Coast Medspa", company_id: "co3", list_id: "li3", title: "Owner", seniority: "Owner", department: null, linkedin_url: null, domain: "brightcoast-sample.com", email: "sarah@sample.com", phone: "(555) 201-8890", city: "Destin", state: "FL", vertical: "medspa", source: "platform", stage: "proposal", owner_id: "preview-user", score: 86, notes: "Booked for Tuesday 2pm. Wants the audit first.", next_step: "Send the audit before the 2pm call", became_customer: false, created_at: daysAgo(9), last_activity_at: daysAgo(1), claimed_at: daysAgo(9), first_contact_at: daysAgo(8), claim_contacted_at: daysAgo(8), last_touch_at: daysAgo(1), cadence_started_at: daysAgo(9), cadence_paused: false, email_opened_at: daysAgo(7), texts_sent: 0, last_text_at: null, imported_owner_name: null, next_follow_up_at: daysAgo(0), follow_up_note: "Send the audit first." , first_email_at: daysAgo(8), first_reply_at: daysAgo(6), bounced_at: null },
    { id: "l2", name: "Tom Rivera", company: "Westpoint Auto Group", company_id: "co2", list_id: "li2", title: "Internet Director", seniority: "Director", department: "Marketing", linkedin_url: null, domain: "westpointauto-sample.com", email: "tom@sample.com", phone: "(555) 318-2244", city: "San Francisco", state: "California", vertical: "car dealership", source: "sheet", stage: "contacted", owner_id: "preview-user", score: 71, notes: "Left voicemail. Callback Friday.", next_step: "Try the mobile", became_customer: false, created_at: daysAgo(30), last_activity_at: daysAgo(16), claimed_at: daysAgo(30), first_contact_at: daysAgo(28), claim_contacted_at: daysAgo(28), last_touch_at: daysAgo(16), cadence_started_at: daysAgo(30), cadence_paused: false, email_opened_at: null, texts_sent: 0, last_text_at: null, imported_owner_name: "Brandon R" , first_email_at: daysAgo(28), first_reply_at: null, bounced_at: null },
    { id: "l3", name: "Priya Patel", company: "Harborline Realty Group", company_id: "co1", list_id: "li1", title: "Licensed Realtor", seniority: null, department: null, linkedin_url: null, domain: "harborline-sample.com", email: "priya@sample.com", phone: null, city: "Los Angeles", state: "California", vertical: "realtor", source: "sheet", stage: "new", owner_id: "preview-user", score: null, notes: null, next_step: null, became_customer: false, created_at: daysAgo(9), last_activity_at: null, claimed_at: daysAgo(9), first_contact_at: null, claim_contacted_at: null, last_touch_at: null, cadence_started_at: daysAgo(9), cadence_paused: false, email_opened_at: null, texts_sent: 0, last_text_at: null, imported_owner_name: "Larry Pike" , first_email_at: daysAgo(8), first_reply_at: null, bounced_at: daysAgo(7) },
    { id: "l4", name: "Greg Olson", company: "Olson Law PLLC", company_id: null, list_id: null, title: "Managing Partner", seniority: "Owner", department: null, linkedin_url: null, domain: "olsonlaw-sample.com", email: "greg@sample.com", phone: "(555) 442-9012", city: "Tampa", state: "FL", vertical: "lawyer", source: "manual", stage: "won", owner_id: "preview-user", score: 88, notes: "Signed Radar Pro. Handed to onboarding.", next_step: null, became_customer: true, created_at: daysAgo(30), last_activity_at: daysAgo(12), claimed_at: daysAgo(30), first_contact_at: daysAgo(29), claim_contacted_at: daysAgo(29), last_touch_at: daysAgo(12), cadence_started_at: daysAgo(30), cadence_paused: false, email_opened_at: daysAgo(28), texts_sent: 1, last_text_at: daysAgo(27), imported_owner_name: null, closed_at: daysAgo(12) , first_email_at: daysAgo(29), first_reply_at: daysAgo(27), bounced_at: null, won_reason: "scared_by_score", won_reason_note: "Showed her the 42 for AI search next to her competitor at 78. She asked what it would cost the same afternoon." },
    { id: "l5", name: "Marcus Webb", company: "Harborline Realty Group", company_id: "co1", list_id: "li1", title: "Business Development Manager", seniority: "Manager", department: "Sales", linkedin_url: null, domain: "harborline-sample.com", email: "marcus@sample.com", phone: "(555) 310-5460", city: "Los Angeles", state: "California", vertical: "realtor", source: "sheet", stage: "new", owner_id: null, score: null, notes: null, next_step: null, became_customer: false, created_at: daysAgo(9), last_activity_at: null, claimed_at: null, first_contact_at: null, claim_contacted_at: null, last_touch_at: null, cadence_started_at: null, cadence_paused: false, email_opened_at: null, texts_sent: 0, last_text_at: null, imported_owner_name: null },
    { id: "l6", name: "Dana Whitfield", company: "Harborline Realty Group", company_id: "co1", list_id: "li1", title: "Internet Sales Director", seniority: "Director", department: "Sales", linkedin_url: null, domain: "harborline-sample.com", email: "dana@sample.com", phone: "(555) 310-5461", city: "Los Angeles", state: "California", vertical: "realtor", source: "sheet", stage: "contacted", owner_id: "preview-rep", score: null, notes: null, next_step: null, became_customer: false, created_at: daysAgo(9), last_activity_at: daysAgo(2), claimed_at: daysAgo(8), first_contact_at: daysAgo(7), claim_contacted_at: daysAgo(7), last_touch_at: daysAgo(2), cadence_started_at: daysAgo(8), cadence_paused: false, email_opened_at: daysAgo(6), texts_sent: 0, last_text_at: null, imported_owner_name: "Hunter Grant" , first_email_at: daysAgo(7), first_reply_at: daysAgo(2), bounced_at: null },
    { id: "l7", name: "Elena Ruiz", company: "Bright Coast Medspa", company_id: "co3", list_id: "li3", title: "Marketing Director", seniority: "Director", department: "Marketing", linkedin_url: null, domain: "brightcoast-sample.com", email: "elena@sample.com", phone: "(555) 201-8891", city: "Destin", state: "FL", vertical: "medspa", source: "sheet", stage: "skip_90", owner_id: null, score: null, notes: null, next_step: null, became_customer: false, created_at: daysAgo(4), last_activity_at: null, claimed_at: null, first_contact_at: null, claim_contacted_at: null, last_touch_at: null, cadence_started_at: null, cadence_paused: false, email_opened_at: null, texts_sent: 0, last_text_at: null, imported_owner_name: null },
  ],
  notes: [
    { id: "n1", author_id: "preview-user", title: "Michelle domain cutover", body: "Registrar is GoDaddy. Nameservers stay, just the A record.\nAsk CJ for the go-ahead before the swap — she has an open house Saturday.", pinned: true, link_type: null, link_id: null, created_at: daysAgo(2), updated_at: daysAgo(1) },
    { id: "n2", author_id: "preview-user", title: "Things that keep biting me", body: "Vercel Root Directory = the 404 cause, every time.\nCheck the MEASURED timestamp before quoting any score.", pinned: false, link_type: null, link_id: null, created_at: daysAgo(9), updated_at: daysAgo(9) },
    { id: "n3", author_id: "preview-user", title: null, body: "Harbor Injury wants their report on Thursdays, not Fridays.", pinned: false, link_type: "client", link_id: "c2", created_at: daysAgo(4), updated_at: daysAgo(4) },
    /* The rep's own note. Added Aug 26 2026 with the account picker: notes are
     * private to their author, so once the preview stopped leaking the owner's
     * notes to everybody, the rep had an empty Notes tab and nothing to test. */
    { id: "n4", author_id: "preview-rep", title: "My call script notes", body: "Lead with their AI Access score, not the pitch.\nDana at Harborline answers before 9am, never after 4.", pinned: true, link_type: null, link_id: null, created_at: daysAgo(3), updated_at: daysAgo(2) },
  ],
  reminders: [
    { id: "r-email-1", owner_id: "preview-user", body: "Chase the second office address for Harbor Injury Law", due_at: new Date(Date.now() - 26 * 3600e3).toISOString(), done_at: null, link_type: "email", link_id: "et4", created_by: "preview-user", created_at: daysAgo(5), updated_at: daysAgo(5) },
    { id: "r1", owner_id: "preview-user", body: "Chase Summit Roofing on the proposal", due_at: daysAgo(2), done_at: null, link_type: "client", link_id: "c3", created_by: "preview-user", created_at: daysAgo(8) },
    { id: "r2", owner_id: "preview-user", body: "Send Sarah Chen the audit before the 2pm call", due_at: daysAgo(0), done_at: null, link_type: "lead", link_id: "l1", created_by: "preview-user", created_at: daysAgo(3) },
    { id: "r3", owner_id: "preview-user", body: "Re-scan Lakeside after the schema rollout", due_at: daysAgo(-2), done_at: null, link_type: "client", link_id: "c1", created_by: "preview-user", created_at: daysAgo(5) },
    /* The rep's own reminders, for the same reason as note n4 above. One due
     * today and one already late, so the rep's Work tiles are not all zero. */
    { id: "r4", owner_id: "preview-rep", body: "Email #1 to Dana Whitfield at Harborline", due_at: daysAgo(0), done_at: null, link_type: "lead", link_id: "l6", created_by: "preview-rep", created_at: daysAgo(2) },
    { id: "r5", owner_id: "preview-rep", body: "Try Tom Rivera on his mobile", due_at: daysAgo(1), done_at: null, link_type: "lead", link_id: "l2", created_by: "preview-rep", created_at: daysAgo(4) },
    { id: "r4", owner_id: "preview-user", body: "Ask about the second office address", due_at: daysAgo(-6), done_at: null, link_type: "client", link_id: "c2", created_by: "preview-user", created_at: daysAgo(1) },
    { id: "r5", owner_id: "preview-user", body: "Book the quarterly review", due_at: daysAgo(6), done_at: daysAgo(5), link_type: null, link_id: null, created_by: "preview-user", created_at: daysAgo(12) },
  ],
  leadActivity: [
    { id: "a1", lead_id: "l1", actor: "preview-user", type: "call", outcome: "talked", body: "15-min intro call. Wants the AI visibility audit first.", created_at: daysAgo(3) },
    { id: "a2", lead_id: "l1", actor: "preview-user", type: "status_change", outcome: null, body: "contacted → meeting", created_at: daysAgo(1) },
    { id: "a3", lead_id: "l2", actor: "preview-user", type: "call", outcome: "voicemail", body: "Left VM re: their site not showing in AI Overviews.", created_at: daysAgo(2) },
  ],
  tickets: [
    { id: "k1", subject: "Audit stuck at 'measuring' for 2 days", requester_name: "Dana W.", requester_email: "dana@sample.com", status: "open", priority: "high", source: "email", assigned_to: "preview-user", created_at: daysAgo(1), updated_at: daysAgo(1) },
    { id: "k2", subject: "How do I add a teammate to my workspace?", requester_name: "J. Alvarez", requester_email: "j@sample.com", status: "solved", priority: "normal", source: "platform", assigned_to: null, created_at: daysAgo(5), updated_at: daysAgo(4) },
  ],
  ticketMessages: [
    { id: "m1", ticket_id: "k1", author_kind: "requester", author: null, body: "The AI Access audit has said 'measuring' since Tuesday. Can you take a look?", created_at: daysAgo(1) },
    { id: "m2", ticket_id: "k2", author_kind: "requester", author: null, body: "Want to give my marketing manager access.", created_at: daysAgo(5) },
    { id: "m3", ticket_id: "k2", author_kind: "agent", author: "preview-user", body: "Settings → Team → Invite. She'll get an email link. Just did it for you as well.", created_at: daysAgo(4) },
  ],
  brain: [
    { id: "b1", kind: "voice", title: "House writing style", body: "Short sentences. Normal words. Start with the answer. Define any technical term in plain words the first time it appears.", enabled: true, created_at: daysAgo(30) },
    { id: "b2", kind: "rule", title: "Never promise rankings", body: "We never guarantee a score, a ranking, or a timeline in writing. Say what we measured and what we shipped.", enabled: true, created_at: daysAgo(30) },
    { id: "b3", kind: "fact", title: "What AI Syndicate does", body: "GEO agency. We get businesses found, trusted, and cited by AI search engines (ChatGPT, Google AI Overviews, Perplexity, Gemini, Copilot) plus classic Google.", enabled: true, created_at: daysAgo(30) },
  ],
  usage: (() => {
    /* A year of daily AI spend, so the Overview money chart has something to
     * show at every zoom level. Rises over time, with a weekday rhythm.
     * No invented disaster month: the chart's "AI cost more than came in" state
     * is real code, proven by a screenshot test, but faking a loss in sample
     * data would put a number on screen that never happened. */
    const rows = [];
    for (let d = 369; d >= 0; d--) {
      const growth = 0.35 + 0.65 * ((369 - d) / 369);          // spend rises as we scale
      const weekday = [0.45, 1, 1.1, 1.05, 1, 0.95, 0.5][new Date(Date.now() - d * 86400000).getDay()];
      const calls = Math.round((30 + 70 * Math.abs(Math.sin(d * 1.7))) * growth * weekday);
      /* Spread across the real groupings so the AI Cost page has something to
       * group BY in preview. The ids are the preview store's own client ids.
       * One model is deliberately left with no price row (`gpt-preview`) so the
       * UNPRICED path is visible on screen rather than only in a test. */
      const feat = ["assistant", "client_report", "notes", "rep_report", "email_draft"][d % 5];
      const surf = ["overview", "client_detail", "notes", "floor", "inbox"][d % 5];
      const client = [null, "c1", "c2", "c3", "c1"][d % 5];
      const model = d % 17 === 0 ? "gpt-preview" : "claude-sonnet-4-6";
      const unpriced = model === "gpt-preview";
      const inTok = calls * 1900;
      const outTok = calls * 620;
      const micros = (inTok * 3 + outTok * 15);
      rows.push({
        id: `u${d}`, ts: daysAgo(d), source: "platform",
        provider: unpriced ? "openai" : "anthropic", model,
        input_tokens: inTok, output_tokens: outTok,
        cache_write_tokens: 0, cache_write_1h_tokens: 0,
        cache_read_tokens: d % 3 === 0 ? Math.round(inTok * 0.6) : 0,
        cost_micros: unpriced ? null : micros,
        cost_usd: unpriced ? null : micros / 1e6,
        client_id: client, user_id: `t${(d % 3) + 1}`,
        feature: feat, surface: surf,
        status: d % 23 === 0 ? "rejected" : "ok",
        latency_ms: 700 + (d % 40) * 55,
        billable: true, meta: {},
      });
    }
    return rows;
  })(),
  activity: [
    { id: "g1", actor: "preview-user", kind: "lead_call", title: "Called Sarah Chen (Chen Dental Studio)", body: "Talked 15 min — booked Tuesday.", created_at: daysAgo(1) },
    { id: "g2", actor: "preview-user", kind: "task_done", title: "Task done: Ship llms.txt + agents.md", body: "Lakeside Realty Group", created_at: daysAgo(2) },
    { id: "g3", actor: "preview-user", kind: "client_added", title: "New prospect: Summit Roofing Co", body: null, created_at: daysAgo(4) },
  ],
  team: [
    { user_id: "preview-user", email: "you@aisyndicate.com", full_name: "Preview Admin", role: "owner", active: true, created_at: daysAgo(60) },
    /* Added Aug 26 2026 with the account picker: you can now enter the preview
     * console as an admin, and an account you can sign in as has to appear on
     * the Team page too — a member the console lets you be but does not list is
     * a screen disagreeing with itself. Nothing in the sample data is assigned
     * to them on purpose, which is what a brand-new admin actually looks like. */
    { user_id: "preview-admin", email: "admin@aisyndicate.com", full_name: "Sample Admin", role: "admin", active: true, created_at: daysAgo(9) },
    { user_id: "preview-rep", email: "rep@aisyndicate.com", full_name: "Sample Rep", role: "sales", active: true, created_at: daysAgo(20) },
  ],

  /* ---------------- SAMPLE MAIL ----------------
   * Preview mode has no Gmail, so the sample mailbox lives here and behaves
   * like the real thing: statuses, client links and reminders are all editable
   * and survive until the page is reloaded. Thread s7 is DELIBERATELY archived
   * (inInbox: false) so the Done view proves the point that a thread we finished
   * is still ours to find after it leaves the inbox. */
  mailThreads: [
    { id: "s1", subject: "AI visibility audit for our firm", from: "Dana W. <dana@sample.com>", fromEmail: "dana@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 2 * 3600e3, snippet: "This looks great - can you walk me through what the score means before our call?", messageCount: 3, unread: true, starred: false, inInbox: true, lastDirection: "in" },
    { id: "s2", subject: "Invoice question", from: "Mike T. <mike@sample.com>", fromEmail: "mike@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 26 * 3600e3, snippet: "Quick one - does the monthly price include the content pieces or is that separate?", messageCount: 2, unread: false, starred: false, inInbox: true, lastDirection: "out" },
    { id: "s3", subject: "Intro: GEO for our dealer group", from: "referral@sample.com", fromEmail: "referral@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 3 * 86400e3, snippet: "You were recommended by Greg at Olson Law. We have 4 locations and none of them show up in ChatGPT...", messageCount: 1, unread: true, starred: false, inInbox: true, lastDirection: "in" },
    { id: "s4", subject: "Second office address for the schema", from: "J. Alvarez <j@sample.com>", fromEmail: "j@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 5 * 86400e3, snippet: "Sorry for the delay - I have to check the lease dates with our office manager.", messageCount: 4, unread: false, starred: true, inInbox: true, lastDirection: "in" },
    { id: "s5", subject: "Your receipt from Hosting Co", from: "billing@vendor-sample.com", fromEmail: "billing@vendor-sample.com", to: "growth@aisyndicate.com", date: Date.now() - 6 * 86400e3, snippet: "Thanks for your payment of $49.00. No action needed.", messageCount: 1, unread: false, starred: false, inInbox: true, lastDirection: "in" },
    { id: "s6", subject: "Following up on Tuesday's call", from: "Sarah Chen <sarah@chendental-sample.com>", fromEmail: "sarah@chendental-sample.com", to: "growth@aisyndicate.com", date: Date.now() - 20 * 3600e3, snippet: "We talked it over and we want to start with the audit. What do you need from us?", messageCount: 2, unread: true, starred: false, inInbox: true, lastDirection: "in" },
    { id: "s7", subject: "Week 3 report - looks good", from: "Dana W. <dana@sample.com>", fromEmail: "dana@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 9 * 86400e3, snippet: "Got it, thanks - nothing needed from us this week.", messageCount: 3, unread: false, starred: false, inInbox: false, lastDirection: "in" },
    { id: "s8", subject: "The AI search weekly", from: "The AI Search Weekly <noreply@newsletter-sample.com>", fromEmail: "noreply@newsletter-sample.com", to: "growth@aisyndicate.com", date: Date.now() - 2 * 86400e3, snippet: "Perplexity ships a shopping feed, Google widens AI Overviews to 40 more countries...", messageCount: 1, unread: false, starred: false, inInbox: true, lastDirection: "in" },
  ],
  mailMessages: {
    s1: [
      { id: "m1", from: "Dana W. <dana@sample.com>", fromEmail: "dana@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 2 * 86400e3, direction: "in", body: "Hi - we got the audit report. Before I share it with my partner, can you explain what the AI Access score actually measures?", attachments: [] },
      { id: "m2", from: "growth@aisyndicate.com", fromEmail: "growth@aisyndicate.com", to: "dana@sample.com", date: Date.now() - 86400e3, direction: "out", body: "Of course - it measures whether AI search engines can read your site at all: the files they look for, whether your pages let them in, and whether your business facts are machine-readable.", attachments: [] },
      { id: "m3", from: "Dana W. <dana@sample.com>", fromEmail: "dana@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 2 * 3600e3, direction: "in", body: "This looks great - can you walk me through what the score means before our call?", attachments: [] },
    ],
    s2: [
      { id: "m4", from: "Mike T. <mike@sample.com>", fromEmail: "mike@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 30 * 3600e3, direction: "in", body: "Quick one - does the monthly price include the content pieces or is that separate?", attachments: [] },
      { id: "m5", from: "growth@aisyndicate.com", fromEmail: "growth@aisyndicate.com", to: "mike@sample.com", date: Date.now() - 26 * 3600e3, direction: "out", body: "Content is included on Radar and up - Pulse covers the audit and the fixes only.", attachments: [] },
    ],
    s3: [
      { id: "m6", from: "referral@sample.com", fromEmail: "referral@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 3 * 86400e3, direction: "in", body: "You were recommended by Greg at Olson Law. We have 4 locations and none of them show up in ChatGPT. Who can we talk to?", attachments: [] },
    ],
    s4: [
      { id: "m7", from: "growth@aisyndicate.com", fromEmail: "growth@aisyndicate.com", to: "j@sample.com", date: Date.now() - 14 * 86400e3, direction: "out", body: "One thing we need for the schema: the full address of the second office, and whether it takes walk-ins.", attachments: [] },
      { id: "m8", from: "J. Alvarez <j@sample.com>", fromEmail: "j@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 12 * 86400e3, direction: "in", body: "On it - I need to dig out the lease.", attachments: [] },
      { id: "m9", from: "growth@aisyndicate.com", fromEmail: "growth@aisyndicate.com", to: "j@sample.com", date: Date.now() - 7 * 86400e3, direction: "out", body: "No rush - whenever you have it. We can ship everything else in the meantime.", attachments: [] },
      { id: "m10", from: "J. Alvarez <j@sample.com>", fromEmail: "j@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 5 * 86400e3, direction: "in", body: "Sorry for the delay - I have to check the lease dates with our office manager.", attachments: [] },
    ],
    s5: [
      { id: "m11", from: "billing@vendor-sample.com", fromEmail: "billing@vendor-sample.com", to: "growth@aisyndicate.com", date: Date.now() - 6 * 86400e3, direction: "in", body: "Thanks for your payment of $49.00. No action needed.", attachments: [{ filename: "receipt-4471.pdf", mimeType: "application/pdf", size: 24100 }] },
    ],
    s6: [
      { id: "m12", from: "growth@aisyndicate.com", fromEmail: "growth@aisyndicate.com", to: "sarah@chendental-sample.com", date: Date.now() - 2 * 86400e3, direction: "out", body: "Great talking Tuesday. Here is the one-pager on what the audit covers.", attachments: [] },
      { id: "m13", from: "Sarah Chen <sarah@chendental-sample.com>", fromEmail: "sarah@chendental-sample.com", to: "growth@aisyndicate.com", date: Date.now() - 20 * 3600e3, direction: "in", body: "We talked it over and we want to start with the audit. What do you need from us?", attachments: [] },
    ],
    s7: [
      { id: "m14", from: "growth@aisyndicate.com", fromEmail: "growth@aisyndicate.com", to: "dana@sample.com", date: Date.now() - 11 * 86400e3, direction: "out", body: "Week 3 report attached. AI intent went 42 to 100 after the head package.", attachments: [{ filename: "lakeside-week-3.pdf", mimeType: "application/pdf", size: 481000 }] },
      { id: "m15", from: "Dana W. <dana@sample.com>", fromEmail: "dana@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 10 * 86400e3, direction: "in", body: "Reading now.", attachments: [] },
      { id: "m16", from: "Dana W. <dana@sample.com>", fromEmail: "dana@sample.com", to: "growth@aisyndicate.com", date: Date.now() - 9 * 86400e3, direction: "in", body: "Got it, thanks - nothing needed from us this week.", attachments: [] },
    ],
    s8: [
      { id: "m17", from: "The AI Search Weekly <noreply@newsletter-sample.com>", fromEmail: "noreply@newsletter-sample.com", to: "growth@aisyndicate.com", date: Date.now() - 2 * 86400e3, direction: "in", body: "Perplexity ships a shopping feed, Google widens AI Overviews to 40 more countries, and Bing quietly changes how it cites sources.", attachments: [] },
    ],
  },
  clientSites: [
    { id: "cs1", client_id: "c1", kind: "main", label: "Main site", url: "https://lakesiderealty-sample.com", live: true, notes: null, sort: 0, created_at: daysAgo(24), updated_at: daysAgo(24) },
    { id: "cs2", client_id: "c1", kind: "authority", label: "Panhandle Home Buyer Guide", url: "https://panhandle-home-buyer-guide-sample.com", live: true, notes: "Ranking site we built. Feeds leads to the main site.", sort: 1, created_at: daysAgo(14), updated_at: daysAgo(14) },
    { id: "cs3", client_id: "c1", kind: "gbp", label: "Google Business Profile", url: "https://maps.google.com/?cid=sample1", live: true, notes: null, sort: 2, created_at: daysAgo(20), updated_at: daysAgo(20) },
    { id: "cs4", client_id: "c2", kind: "main", label: "Main site", url: "https://harborinjurylaw-sample.com", live: true, notes: null, sort: 0, created_at: daysAgo(90), updated_at: daysAgo(90) },
    { id: "cs5", client_id: "c2", kind: "authority", label: "Florida Injury Claim Guide", url: "https://florida-injury-claim-guide-sample.com", live: true, notes: "In the firm's legal review since Aug 16.", sort: 1, created_at: daysAgo(3), updated_at: daysAgo(3) },
    { id: "cs6", client_id: "c2", kind: "directory", label: "Avvo profile", url: "https://avvo-sample.com/harbor-injury-law", live: true, notes: null, sort: 2, created_at: daysAgo(60), updated_at: daysAgo(60) },
    { id: "cs7", client_id: "c3", kind: "main", label: "Main site", url: "https://summitroofing-sample.com", live: true, notes: null, sort: 0, created_at: daysAgo(4), updated_at: daysAgo(4) },
    { id: "cs8", client_id: "c3", kind: "landing", label: "Storm damage page", url: "https://summitroofing-sample.com/storm-damage", live: false, notes: "Written, waiting on their photos before it goes live.", sort: 1, created_at: daysAgo(1), updated_at: daysAgo(1) },
  ],
  emailThreads: [
    { id: "et1", mailbox: "growth@aisyndicate.com", thread_id: "s1", status: "needs_reply", client_id: "c1", lead_id: null, assigned_to: "preview-user", priority: "high", subject: "AI visibility audit for our firm", from_name: "Dana W.", from_email: "dana@sample.com", snippet: "This looks great - can you walk me through what the score means before our call?", last_message_at: new Date(Date.now() - 2 * 3600e3).toISOString(), message_count: 3, last_direction: "in", notes: "She wants the score explained in plain words on the call.", status_changed_at: daysAgo(0), status_changed_by: "preview-user", created_at: daysAgo(2), updated_at: daysAgo(0) },
    { id: "et2", mailbox: "growth@aisyndicate.com", thread_id: "s2", status: "waiting", client_id: "c3", lead_id: null, assigned_to: "preview-user", priority: "normal", subject: "Invoice question", from_name: "Mike T.", from_email: "mike@sample.com", snippet: "Content is included on Radar and up.", last_message_at: new Date(Date.now() - 26 * 3600e3).toISOString(), message_count: 2, last_direction: "out", notes: null, status_changed_at: daysAgo(1), status_changed_by: "preview-user", created_at: daysAgo(2), updated_at: daysAgo(1) },
    { id: "et4", mailbox: "growth@aisyndicate.com", thread_id: "s4", status: "scheduled", client_id: "c2", lead_id: null, assigned_to: "preview-user", priority: "normal", subject: "Second office address for the schema", from_name: "J. Alvarez", from_email: "j@sample.com", snippet: "Sorry for the delay - I have to check the lease dates.", last_message_at: new Date(Date.now() - 5 * 86400e3).toISOString(), message_count: 4, last_direction: "in", notes: "Blocked until the lease dates exist. Nothing else on this client waits on it.", status_changed_at: daysAgo(5), status_changed_by: "preview-user", created_at: daysAgo(14), updated_at: daysAgo(5) },
    { id: "et5", mailbox: "growth@aisyndicate.com", thread_id: "s5", status: "ignored", client_id: null, lead_id: null, assigned_to: null, priority: "low", subject: "Your receipt from Hosting Co", from_name: null, from_email: "billing@vendor-sample.com", snippet: "Thanks for your payment of $49.00.", last_message_at: new Date(Date.now() - 6 * 86400e3).toISOString(), message_count: 1, last_direction: "in", notes: null, status_changed_at: daysAgo(6), status_changed_by: "preview-user", created_at: daysAgo(6), updated_at: daysAgo(6) },
    { id: "et7", mailbox: "growth@aisyndicate.com", thread_id: "s7", status: "done", client_id: "c1", lead_id: null, assigned_to: "preview-user", priority: "normal", subject: "Week 3 report - looks good", from_name: "Dana W.", from_email: "dana@sample.com", snippet: "Got it, thanks - nothing needed from us this week.", last_message_at: new Date(Date.now() - 9 * 86400e3).toISOString(), message_count: 3, last_direction: "in", notes: null, status_changed_at: daysAgo(9), status_changed_by: "preview-user", created_at: daysAgo(11), updated_at: daysAgo(9) },
    { id: "et8", mailbox: "growth@aisyndicate.com", thread_id: "s8", status: "ignored", client_id: null, lead_id: null, assigned_to: null, priority: "low", subject: "The AI search weekly", from_name: "The AI Search Weekly", from_email: "noreply@newsletter-sample.com", snippet: "Perplexity ships a shopping feed.", last_message_at: new Date(Date.now() - 2 * 86400e3).toISOString(), message_count: 1, last_direction: "in", notes: null, status_changed_at: daysAgo(2), status_changed_by: "preview-user", created_at: daysAgo(2), updated_at: daysAgo(2) },
  ],

  /* ---------------- SAMPLE VAULT ----------------
   * Nothing here is real, and nothing here is scrambled: preview mode has no
   * server and therefore no VAULT_KEY, so the sample secrets sit in memory in
   * plain text and vanish on reload. That is stated on the page itself, in the
   * banner above the list, because a vault that looks encrypted and is not is
   * the single most dangerous thing this file could pretend to be.
   *
   * secret_set_at / secret_fields mirror the real columns so the list, the
   * badges and the counts behave exactly as they will with a real key. */
  vaultItems: [
    { id: "v1", client_id: null, kind: "login", label: "GoDaddy (ours)", description: "Where our own domains are registered.", username: "billing@aisyndicate.com", url: "https://sso.godaddy.com", card_brand: null, card_last4: null, card_exp_month: null, card_exp_year: null, card_holder: null, card_zip: null, secret_set_at: daysAgo(30), secret_fields: ["password", "totp"], secret_by: "preview-user", vault_url: "https://vault.bitwarden.com/#/vault?itemId=sample-1", notes: "Two-factor is on. The codes are in the vault entry.", tags: ["domains"], favorite: true, active: true, sort: 0, added_by: "preview-user", created_at: daysAgo(30), updated_at: daysAgo(30) },
    { id: "v2", client_id: null, kind: "card", label: "Business card — Chase", description: "The card every subscription is on.", username: null, url: null, card_brand: "Visa", card_last4: "4242", card_exp_month: 11, card_exp_year: 2028, card_holder: "AI SYNDICATE LLC", card_zip: "32541", secret_set_at: daysAgo(30), secret_fields: ["cvv", "number"], secret_by: "preview-user", vault_url: null, notes: "Anthropic, Vercel and Supabase all bill to this.", tags: ["money"], favorite: true, active: true, sort: 1, added_by: "preview-user", created_at: daysAgo(30), updated_at: daysAgo(30) },
    { id: "v3", client_id: "c1", kind: "login", label: "Lakeside — WordPress admin", description: "Their own website's back end.", username: "aisyndicate", url: "https://lakesiderealty-sample.com/wp-admin", card_brand: null, card_last4: null, card_exp_month: null, card_exp_year: null, card_holder: null, card_zip: null, secret_set_at: daysAgo(21), secret_fields: ["password"], secret_by: "preview-user", vault_url: null, notes: "Editor rights only — they kept the owner account.", tags: ["client site"], favorite: false, active: true, sort: 0, added_by: "preview-user", created_at: daysAgo(21), updated_at: daysAgo(21) },
    { id: "v4", client_id: "c2", kind: "api_key", label: "Harbor Injury — Cloudflare token", description: "Lets us change their firewall rules.", username: null, url: "https://dash.cloudflare.com", card_brand: null, card_last4: null, card_exp_month: null, card_exp_year: null, card_holder: null, card_zip: null, secret_set_at: null, secret_fields: [], secret_by: null, vault_url: null, notes: "Waiting on the token. Nothing works until it exists.", tags: [], favorite: false, active: true, sort: 0, added_by: "preview-user", created_at: daysAgo(3), updated_at: daysAgo(3) },
  ],
  vaultReveals: [
    { id: "vr1", item_id: "v1", item_label: "GoDaddy (ours)", client_id: null, actor: "preview-user", actor_email: "you@aisyndicate.com", action: "reveal", fields: ["password"], created_at: daysAgo(2) },
    { id: "vr2", item_id: "v2", item_label: "Business card — Chase", client_id: null, actor: "preview-user", actor_email: "you@aisyndicate.com", action: "reveal", fields: ["number", "cvv"], created_at: daysAgo(5) },
  ],
  clientReports: [],

  /* ---- THE SALES SYSTEM (Aug 21 2026) --------------------------------
   * Shaped like CJ's real outreach sheet rather than like a tidy demo: two
   * people at the same firm, a claim that has run out, one that has gone cold,
   * a firm that scores 90+ and is therefore not a prospect at all. If preview
   * mode only ever showed the happy case, nobody would see the warnings until
   * they hit them on real data. */
  companies: [
    { id: "co1", name: "Harborline Realty Group", name_key: "harborlinerealtygroup", domain: "harborline-sample.com", city: "Los Angeles", state: "California", country: "United States", phone: "(555) 310-5460", vertical: "realtor", employees: 21, annual_revenue: 11026000, linkedin_url: null, facebook_url: null, twitter_url: null, site_score: 58, site_score_at: daysAgo(2), site_score_note: null, client_id: null, notes: null, created_at: daysAgo(9) },
    { id: "co2", name: "Westpoint Auto Group", name_key: "westpointautogroup", domain: "westpointauto-sample.com", city: "San Francisco", state: "California", country: "United States", phone: "(555) 750-8300", vertical: "car dealership", employees: 90, annual_revenue: 10000000, linkedin_url: null, facebook_url: null, twitter_url: null, site_score: null, site_score_at: null, site_score_note: null, client_id: null, notes: null, created_at: daysAgo(6) },
    { id: "co3", name: "Bright Coast Medspa", name_key: "brightcoastmedspa", domain: "brightcoast-sample.com", city: "Destin", state: "FL", country: "United States", phone: "(555) 201-8890", vertical: "medspa", employees: 8, annual_revenue: null, linkedin_url: null, facebook_url: null, twitter_url: null, site_score: 93, site_score_at: daysAgo(1), site_score_note: "Already strong — not a prospect.", client_id: null, notes: null, created_at: daysAgo(4) },
  ],
  leadLists: [
    { id: "li1", name: "Luxury Agents", vertical: "realtor", description: "Apollo pull, LA + South Florida", sheet_tab: "Luxury Agents", source_id: "ls1", active: true, sort: 0, created_at: daysAgo(9) },
    { id: "li2", name: "Car Dealership", vertical: "car dealership", description: "Apollo pull, California", sheet_tab: "Car Dealership", source_id: "ls1", active: true, sort: 1, created_at: daysAgo(6) },
    { id: "li3", name: "Medspas", vertical: "medspa", description: "Gulf coast", sheet_tab: "Medspas", source_id: "ls2", active: true, sort: 2, created_at: daysAgo(4) },
  ],
  proposals: [
    { id: "pr1", lead_id: "l1", company_id: "co3", title: "Radar Pro — 6 month GEO package", package: "Radar Pro", amount_cents: 450000, currency: "usd", term: "monthly", status: "sent", sent_at: daysAgo(2), viewed_at: daysAgo(1), decided_at: null, lost_reason: null, doc_url: null, notes: null, created_at: daysAgo(2) },
  ],

  /* ---- TAGS (Aug 27 2026) ------------------------------------------
   * THE VOCABULARY, mirroring 0018_lead_tags.sql's seed row for row.
   *
   * This IS a second copy of the tag names, and a second copy of anything is a
   * copy that eventually stops matching — so it is cross-checked rather than
   * trusted: tests/lead-tags reads the INSERT out of 0018_lead_tags.sql and
   * asserts every slug, label, colour, group and sort below is identical. The
   * same trick tests/sales already uses on the stage constraint. Copying it was
   * the lesser evil: deriving the labels from the slugs would put "no-website"
   * on a chip where the real console says "No website", so preview mode would
   * stop being a fair rehearsal of the thing it exists to rehearse.
   *
   * The ids are `tg-<slug>` on purpose. In the real database they are uuids, and
   * nothing anywhere may assume the shape of one — but a readable id makes a
   * failing preview assertion legible instead of a wall of hex. */
  leadTags: [
    { id: "tg-no-website", slug: "no-website", label: "No website", color: "red", tag_group: "website", sort: 10, active: true },
    { id: "tg-has-website", slug: "has-website", label: "Has a website", color: "gray", tag_group: "website", sort: 11, active: true },
    { id: "tg-size-solo", slug: "size-solo", label: "Solo (1)", color: "gray", tag_group: "size", sort: 20, active: true },
    { id: "tg-size-small", slug: "size-small", label: "Small (2-10)", color: "blue", tag_group: "size", sort: 21, active: true },
    { id: "tg-size-mid", slug: "size-mid", label: "Mid (11-50)", color: "purple", tag_group: "size", sort: 22, active: true },
    { id: "tg-size-large", slug: "size-large", label: "Large (51+)", color: "brown", tag_group: "size", sort: 23, active: true },
    { id: "tg-never-touched", slug: "never-touched", label: "Never touched", color: "yellow", tag_group: "source", sort: 30, active: true },
    { id: "tg-imported", slug: "imported", label: "Imported", color: "gray", tag_group: "source", sort: 31, active: true },
    { id: "tg-unscanned", slug: "unscanned", label: "Not scanned yet", color: "yellow", tag_group: "score", sort: 40, active: true },
    { id: "tg-scored-under-60", slug: "scored-under-60", label: "Scored under 60", color: "green", tag_group: "score", sort: 41, active: true },
    { id: "tg-scored-60s", slug: "scored-60s", label: "Scored 60-79", color: "blue", tag_group: "score", sort: 42, active: true },
    { id: "tg-scored-80s", slug: "scored-80s", label: "Scored 80-89", color: "orange", tag_group: "score", sort: 43, active: true },
    { id: "tg-scored-90-plus", slug: "scored-90-plus", label: "Scored 90+", color: "gray", tag_group: "score", sort: 44, active: true },
    { id: "tg-hot", slug: "hot", label: "Replied", color: "green", tag_group: "state", sort: 50, active: true },
    { id: "tg-quiet", slug: "quiet", label: "Gone quiet (7d)", color: "yellow", tag_group: "state", sort: 51, active: true },
    { id: "tg-cold", slug: "cold", label: "Cold (14d)", color: "red", tag_group: "state", sort: 52, active: true },
    { id: "tg-claim-expiring", slug: "claim-expiring", label: "Claim expiring", color: "orange", tag_group: "state", sort: 53, active: true },
    { id: "tg-bounced", slug: "bounced", label: "Bad address", color: "red", tag_group: "state", sort: 54, active: true },
    { id: "tg-skip-90", slug: "skip-90", label: "Not a prospect", color: "gray", tag_group: "state", sort: 55, active: true },
    { id: "tg-won", slug: "won", label: "Won", color: "green", tag_group: "state", sort: 56, active: true },
    { id: "tg-lost", slug: "lost", label: "Lost", color: "red", tag_group: "state", sort: 57, active: true },
  ],

  /* THE EVENTS. Append-only here too — the preview branch of setLeadTag pushes
   * a row and never edits one, because a preview looser than the query
   * underneath it is a trap this repo has been bitten by twice.
   *
   * Deliberately SPARSE. Most of what a lead carries is worked out by the
   * automatic rules on load, so seeding every tag here would hide the thing that
   * needs rehearsing. What IS seeded is the two cases the rules cannot produce
   * on their own: the import's own dated line, and a tag a person took off by
   * hand (which the rules must then leave alone). */
  leadTagEvents: [
    { id: "te1", lead_id: "l6", tag_id: "tg-imported", action: "added", at: daysAgo(9), by: null, source: "import", why: "On import, Luxury Agents tab." },
    { id: "te2", lead_id: "l6", tag_id: "tg-quiet", action: "added", at: daysAgo(4), by: null, source: "auto", why: "7 days with no update." },
    /* THE ONE THAT PROVES THE RULE. A rep took `quiet` off by hand, so the
     * automatic rule must never put it back — and it does not, because
     * removedByHand() in lib/lead-tags.js reads the newest event for the tag
     * rather than a flag somebody has to remember to set. */
    { id: "te3", lead_id: "l6", tag_id: "tg-quiet", action: "removed", at: daysAgo(2), by: "preview-rep", source: "person", why: "removed by hand — she replied" },
    { id: "te4", lead_id: "l1", tag_id: "tg-imported", action: "added", at: daysAgo(9), by: null, source: "import", why: "On import, Medspas tab." },
  ],

  /* ---- WHAT A SCAN FOUND, ON THE FIRM (Aug 27 2026) ---------------
   * One row per scan, never overwritten — see 0019_reasons_and_company_reports.sql.
   *
   * TWO ROWS FOR THE SAME FIRM ON PURPOSE, dated a month apart. "Was 61 in July
   * and is still 61 now" is itself a sales line, and it is the case a single-row
   * fixture can never exercise: the newest one has to win, and the older one has
   * to still be readable.
   *
   * co2 (Westpoint) has NO row at all and co3 has one with a null AI Access
   * score — the two states the screen must not print as a zero. */
  companyReports: [
    { id: "cr1", company_id: "co1", lead_id: "l3", kind: "baseline", ai_access_score: 42, seo_score: 61, prompt_sim_hits: 2, prompt_sim_total: 10, findings: [{ title: "No facts file for AI", detail: "There is no llms.txt, so an AI answering a question about this firm has nothing to quote about its prices, hours or services.", severity: "high" }, { title: "Seven pages share one title", detail: "Search cannot tell the pages apart, so none of them ranks for anything specific.", severity: "high" }, { title: "The name, address and phone disagree", detail: "The website and the Google profile do not match, so neither can be trusted as the record.", severity: "medium" }], raw: { note: "sample" }, pitch: null, pitch_gate_reason: "No ANTHROPIC_API_KEY is set in preview mode, so nothing was written.", domain: "harborline-sample.com", measured_at: daysAgo(35), measured_by: "preview-user", created_at: daysAgo(35) },
    { id: "cr2", company_id: "co1", lead_id: "l3", kind: "rescan", ai_access_score: 44, seo_score: 61, prompt_sim_hits: 2, prompt_sim_total: 10, findings: [{ title: "No facts file for AI", detail: "Still nothing for an AI to quote — this has not moved since the first scan.", severity: "high" }, { title: "Seven pages share one title", detail: "Unchanged since the first scan.", severity: "high" }], raw: { note: "sample" }, pitch: null, pitch_gate_reason: "No ANTHROPIC_API_KEY is set in preview mode, so nothing was written.", domain: "harborline-sample.com", measured_at: daysAgo(2), measured_by: "preview-user", created_at: daysAgo(2) },
    { id: "cr3", company_id: "co3", lead_id: "l1", kind: "baseline", ai_access_score: null, seo_score: 88, prompt_sim_hits: null, prompt_sim_total: null, findings: [{ title: "The AI-access half of the scan did not come back", detail: "Only the search half returned. The number that is missing is missing, not zero.", severity: "low" }], raw: { note: "sample, half a response" }, pitch: null, pitch_gate_reason: "No ANTHROPIC_API_KEY is set in preview mode, so nothing was written.", domain: "brightcoast-sample.com", measured_at: daysAgo(1), measured_by: "preview-user", created_at: daysAgo(1) },
  ],

  /* ---- A REP'S OWN AI RULES (Aug 27 2026) -------------------------
   * One row per rule, `user_id` on every one, and NOT A SINGLE NUMBER anywhere
   * in a body — see checkPersonalRule in lib/sales-rules.js for why a number in
   * here would break the honesty gate rather than just look untidy. */
  userBrain: [
    { id: "ub1", user_id: "preview-rep", kind: "voice", setting_key: "tone", title: "Tone", body: "Plain and direct", enabled: true, created_at: daysAgo(6), updated_at: daysAgo(6) },
    { id: "ub2", user_id: "preview-rep", kind: "voice", setting_key: "length", title: "Length", body: "Short — a few sentences at most", enabled: true, created_at: daysAgo(6), updated_at: daysAgo(6) },
    { id: "ub3", user_id: "preview-rep", kind: "voice", setting_key: "subject", title: "Subject lines", body: "Lowercase, no punctuation", enabled: true, created_at: daysAgo(6), updated_at: daysAgo(6) },
    { id: "ub4", user_id: "preview-rep", kind: "signature", setting_key: "signoff", title: "Sign-off", body: "— Sample Rep, AI Syndicate", enabled: true, created_at: daysAgo(6), updated_at: daysAgo(6) },
    { id: "ub5", user_id: "preview-rep", kind: "voice", setting_key: "never_say", title: "Never say", body: "synergy, leverage, circle back, touch base", enabled: true, created_at: daysAgo(6), updated_at: daysAgo(6) },
    { id: "ub6", user_id: "preview-rep", kind: "rule", setting_key: null, title: null, body: "Open with something about their business, never about us.", enabled: true, created_at: daysAgo(5), updated_at: daysAgo(5) },
    { id: "ub7", user_id: "preview-rep", kind: "rule", setting_key: null, title: null, body: "One question per email, at the end.", enabled: true, created_at: daysAgo(5), updated_at: daysAgo(5) },
    { id: "ub8", user_id: "preview-rep", kind: "rule", setting_key: null, title: null, body: "Never send a price in the first email.", enabled: true, created_at: daysAgo(5), updated_at: daysAgo(5) },
    { id: "ub9", user_id: "preview-rep", kind: "rule", setting_key: null, title: null, body: "If they have no website, lead with the free mockup.", enabled: true, created_at: daysAgo(4), updated_at: daysAgo(4) },
    /* One belonging to somebody ELSE, so the preview can prove the split: a rep
     * must see only their own, and an owner must see everybody's. Without a
     * second person's row, both screens look identical and neither is tested. */
    { id: "ub10", user_id: "preview-user", kind: "rule", setting_key: null, title: null, body: "Always name the firm in the first line.", enabled: true, created_at: daysAgo(8), updated_at: daysAgo(8) },
  ],
};
/* Sample secrets. In-memory, plain text, preview mode only. There is no key in
 * the browser and there never will be — see the banner note above. */
/* Which VALUES somebody actually typed in this tab, as opposed to the made-up
 * ones seeded below. Keyed "<item id>:<field>", not by item: marking the whole
 * item meant typing a new password into the sample GoDaddy entry made the
 * untouched two-factor code claim to be something you had typed.
 *
 * Reveal used to call everything "a made-up value from the sample data" —
 * including a real password somebody had pasted in despite the banner, which is
 * the exact opposite of the warning preview mode exists to give. */
const previewTyped = new Set();
const previewSecrets = {
  v1: { password: "sample-not-a-real-password-1", totp: "SAMPLEOTPSEED2345" },
  v2: { number: "4242424242424242", cvv: "123" },
  v3: { password: "sample-not-a-real-password-3" },
};

let previewSeq = 100;
function pid(prefix) { return `${prefix}${++previewSeq}`; }

/* ------------------------------------------------------------------ */
/* Generic helpers                                                      */
/* ------------------------------------------------------------------ */

function live() { return isConfigured(); }

async function selectAll(table, { order = "created_at", ascending = false, limit = 500 } = {}) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from(table).select("*").order(order, { ascending }).limit(limit);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/* ------------------------------------------------------------------ */
/* CLIENTS / TASKS / WEEKLY (Operations)                                */
/* ------------------------------------------------------------------ */

export async function listClients() {
  if (!live()) return { rows: [...previewStore.clients], sample: true };
  return selectAll("admin_clients", { order: "name", ascending: true });
}

export async function upsertClient(patch) {
  if (!live()) {
    if (patch.id) {
      const i = previewStore.clients.findIndex((c) => c.id === patch.id);
      if (i >= 0) previewStore.clients[i] = { ...previewStore.clients[i], ...patch };
      return { ok: true, row: previewStore.clients[i], sample: true };
    }
    const row = { id: pid("c"), links: {}, status: "active", stage: "Onboarding", created_at: new Date().toISOString(), ...patch };
    previewStore.clients.unshift(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_clients").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_clients").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

export async function deleteClient(id) {
  if (!live()) {
    previewStore.clients = previewStore.clients.filter((c) => c.id !== id);
    previewStore.tasks = previewStore.tasks.filter((t) => t.client_id !== id);
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_clients").delete().eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function listTasks(clientId = null) {
  if (!live()) {
    const rows = clientId ? previewStore.tasks.filter((t) => t.client_id === clientId) : [...previewStore.tasks];
    return { rows, sample: true };
  }
  const supabase = getSupabase();
  let q = supabase.from("admin_tasks").select("*").order("created_at", { ascending: false }).limit(500);
  if (clientId) q = q.eq("client_id", clientId);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function upsertTask(patch) {
  if (!live()) {
    if (patch.id) {
      const i = previewStore.tasks.findIndex((t) => t.id === patch.id);
      if (i >= 0) previewStore.tasks[i] = { ...previewStore.tasks[i], ...patch };
      return { ok: true, row: previewStore.tasks[i], sample: true };
    }
    const row = { id: pid("t"), status: "todo", priority: "medium", created_at: new Date().toISOString(), ...patch };
    previewStore.tasks.unshift(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_tasks").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_tasks").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

export async function deleteTask(id) {
  if (!live()) {
    previewStore.tasks = previewStore.tasks.filter((t) => t.id !== id);
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_tasks").delete().eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function listWeekly(clientId) {
  if (!live()) {
    return { rows: previewStore.weekly.filter((w) => w.client_id === clientId).sort((a, b) => a.week_no - b.week_no), sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_weekly_log").select("*").eq("client_id", clientId).order("week_no", { ascending: true });
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function upsertWeekly(patch) {
  if (!live()) {
    if (patch.id) {
      const i = previewStore.weekly.findIndex((w) => w.id === patch.id);
      if (i >= 0) previewStore.weekly[i] = { ...previewStore.weekly[i], ...patch };
      return { ok: true, row: previewStore.weekly[i], sample: true };
    }
    const row = { id: pid("w"), week_status: "not_logged", readiness: "draft", created_at: new Date().toISOString(), ...patch };
    previewStore.weekly.push(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_weekly_log").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_weekly_log").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

/* ------------------------------------------------------------------ */
/* LEADS                                                                */
/* ------------------------------------------------------------------ */

/* THE CAP, AND WHY IT IS FETCHED AT +1.
 *
 * Every tile, every list and every number on the Sales page is computed from
 * what this returns. A silent cap therefore does not hide "some old leads" —
 * it makes the whole page quietly wrong, while the page promises the tiles and
 * the list are counting the same thing. Import CJ's eight tabs and 1,000 is
 * reachable in one afternoon.
 *
 * So: ask for one more than the cap. That extra row is the only thing that can
 * tell "exactly 2,000" apart from "2,000 and there are more", and it is what
 * makes the warning on screen possible. Fetching and printing the same number
 * means the page is told it saw everything, every time. */
export const LEAD_FETCH_CAP = 2000;
export const ACTIVITY_FETCH_CAP = 4000;

export async function listLeads() {
  if (!live()) return { rows: [...previewStore.leads], sample: true };
  const res = await selectAll("admin_leads", { order: "created_at", ascending: false, limit: LEAD_FETCH_CAP + 1 });
  if (res.rows.length > LEAD_FETCH_CAP) {
    return {
      ...res,
      rows: res.rows.slice(0, LEAD_FETCH_CAP),
      truncated: `Only the ${LEAD_FETCH_CAP} newest contacts were loaded. Everything on this page is counted from those — filter to a list to see the rest.`,
    };
  }
  return res;
}

export async function upsertLead(patch) {
  if (!live()) {
    if (patch.id) {
      const i = previewStore.leads.findIndex((l) => l.id === patch.id);
      if (i >= 0) previewStore.leads[i] = { ...previewStore.leads[i], ...patch };
      return { ok: true, row: previewStore.leads[i], sample: true };
    }
    const row = { id: pid("l"), stage: "new", source: "manual", became_customer: false, created_at: new Date().toISOString(), ...patch };
    previewStore.leads.unshift(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_leads").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_leads").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

export async function insertLeadsBatch(rows) {
  if (!live()) {
    const inserted = rows.map((r) => ({ id: pid("l"), stage: "new", source: "csv", became_customer: false, created_at: new Date().toISOString(), ...r }));
    previewStore.leads.unshift(...inserted);
    return { ok: true, count: inserted.length, ids: inserted.map((r) => r.id), sample: true };
  }
  /* Chunked, for the same reason insertCompaniesBatch is: one statement of two
   * thousand rows is one thing that can fail, and ONE bad cell fails all of it.
   * A single unreadable date in row 1,400 used to throw away the other 1,399 —
   * after the firms for that tab had already been written. Chunking means a
   * failure names how far it got. */
  const supabase = getSupabase();
  let count = 0;
  /* The ids come back so the caller can write each contact's first timeline
   * line, paired by position within the chunk.
   *
   * Position is only safe here because Postgres returns multi-row
   * INSERT ... RETURNING in insertion order, and that is worth stating rather
   * than assuming: it is the one thing standing between a correct import note
   * and one person's history written onto somebody else's record. Two guards
   * back it up — the row count must match, and the emails must line up
   * wherever both sides have one. Anything off and the ids are dropped, so the
   * caller writes NO notes rather than wrong ones. */
  const ids = [];
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error, data } = await supabase.from("admin_leads").insert(chunk).select("id, email");
    if (error) return { ok: false, error: error.message, count, ids, partial: count > 0 };
    count += data?.length || 0;
    const rows = data || [];
    const aligned = rows.length === chunk.length
      && rows.every((r, j) => !r.email || !chunk[j].email || r.email === chunk[j].email);
    if (aligned) ids.push(...rows.map((r) => r.id));
    else return { ok: true, count, ids: [], shortReturn: true };
  }
  return { ok: true, count, ids };
}

export async function listLeadActivity(leadId) {
  if (!live()) {
    return { rows: previewStore.leadActivity.filter((a) => a.lead_id === leadId).sort((a, b) => b.created_at.localeCompare(a.created_at)), sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_lead_activity").select("*").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(200);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function listAllLeadActivity(sinceDays = 30) {
  if (!live()) return { rows: [...previewStore.leadActivity], sample: true };
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const { data, error } = await getSupabase()
    .from("admin_lead_activity").select("*").gte("created_at", since)
    .order("created_at", { ascending: false }).limit(ACTIVITY_FETCH_CAP + 1);
  if (error) return { rows: [], error: error.message, sample: false };
  const rows = data || [];
  if (rows.length > ACTIVITY_FETCH_CAP) {
    /* This one matters more than it looks: the cadence counts touches from
     * these rows, so a truncated read makes a lead with all five touches logged
     * reappear on somebody's day asking for email #1. */
    return {
      rows: rows.slice(0, ACTIVITY_FETCH_CAP),
      sample: false,
      truncated: `Only the ${ACTIVITY_FETCH_CAP} most recent activity records were loaded, so touch counts and rep numbers below may be low.`,
    };
  }
  return { rows, sample: false };
}

export async function addLeadActivity({ leadId, actor, type, outcome, body }) {
  if (!live()) {
    const row = { id: pid("a"), lead_id: leadId, actor: actor || "preview-user", type, outcome: outcome || null, body: body || null, created_at: new Date().toISOString() };
    previewStore.leadActivity.unshift(row);
    const li = previewStore.leads.findIndex((l) => l.id === leadId);
    if (li >= 0) previewStore.leads[li].last_activity_at = row.created_at;
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("admin_lead_activity")
    .insert({ lead_id: leadId, actor, type, outcome: outcome || null, body: body || null })
    .select().maybeSingle();
  if (error) return { ok: false, error: error.message };
  await supabase.from("admin_leads").update({ last_activity_at: new Date().toISOString() }).eq("id", leadId);
  return { ok: true, row: data };
}

/* ------------------------------------------------------------------ */
/* TICKETS                                                              */
/* ------------------------------------------------------------------ */

export async function listTickets() {
  if (!live()) return { rows: [...previewStore.tickets], sample: true };
  return selectAll("admin_tickets", { order: "updated_at", ascending: false });
}

export async function upsertTicket(patch) {
  if (!live()) {
    if (patch.id) {
      const i = previewStore.tickets.findIndex((t) => t.id === patch.id);
      if (i >= 0) previewStore.tickets[i] = { ...previewStore.tickets[i], ...patch, updated_at: new Date().toISOString() };
      return { ok: true, row: previewStore.tickets[i], sample: true };
    }
    const row = { id: pid("k"), status: "open", priority: "normal", source: "manual", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...patch };
    previewStore.tickets.unshift(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_tickets").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_tickets").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

export async function listTicketMessages(ticketId) {
  if (!live()) {
    return { rows: previewStore.ticketMessages.filter((m) => m.ticket_id === ticketId), sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_ticket_messages").select("*").eq("ticket_id", ticketId).order("created_at", { ascending: true });
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function addTicketMessage({ ticketId, authorKind, author, body }) {
  if (!live()) {
    const row = { id: pid("m"), ticket_id: ticketId, author_kind: authorKind, author: author || null, body, created_at: new Date().toISOString() };
    previewStore.ticketMessages.push(row);
    return { ok: true, row, sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_ticket_messages")
    .insert({ ticket_id: ticketId, author_kind: authorKind, author: author || null, body })
    .select().maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

/* ------------------------------------------------------------------ */
/* BRAIN                                                                */
/* ------------------------------------------------------------------ */

export async function listBrain() {
  if (!live()) return { rows: [...previewStore.brain], sample: true };
  return selectAll("admin_brain", { order: "created_at", ascending: true });
}

export async function upsertBrain(patch) {
  if (!live()) {
    if (patch.id) {
      const i = previewStore.brain.findIndex((b) => b.id === patch.id);
      if (i >= 0) previewStore.brain[i] = { ...previewStore.brain[i], ...patch };
      return { ok: true, row: previewStore.brain[i], sample: true };
    }
    const row = { id: pid("b"), kind: "fact", enabled: true, created_at: new Date().toISOString(), ...patch };
    previewStore.brain.push(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_brain").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_brain").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

export async function deleteBrain(id) {
  if (!live()) {
    previewStore.brain = previewStore.brain.filter((b) => b.id !== id);
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_brain").delete().eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/* ------------------------------------------------------------------ */
/* USAGE + ACTIVITY + TEAM                                              */
/* ------------------------------------------------------------------ */

/* Everything the AI Cost page groups on. `meta` is in the list because the
 * attribution used to live ONLY in meta and this reader never fetched it, so
 * no per-client or per-feature figure was possible at all. */
const USAGE_COLS = [
  "id", "ts", "source", "provider", "model", "request_id",
  "input_tokens", "output_tokens", "cache_write_tokens", "cache_write_1h_tokens",
  "cache_read_tokens", "cost_micros", "cost_usd", "price_id",
  "client_id", "user_id", "feature", "surface", "entity_kind", "entity_id",
  "status", "error_code", "latency_ms", "billable", "meta",
].join(", ");

/* One page of rows. 1,000 is Supabase's own default ceiling per request, so
 * asking for more in one go silently gets 1,000 back. */
const USAGE_PAGE = 1000;

/* A hard stop, so a runaway query cannot hang the page — but unlike the old
 * `.limit(5000)` this one is REPORTED when it is hit. */
const USAGE_MAX = 50000;

/**
 * AI usage events.
 *
 * THE BUG THIS REPLACED, and it was live: the old reader had a bare
 * `.limit(5000)` and never selected `meta`. Past 5,000 events in the window
 * the AI figure on the Finance page was simply too low, with no warning, on
 * the page whose whole premise is that every number says where it came from.
 *
 * It now pages until it has everything, and when it does hit the ceiling it
 * says so — `truncated: true` — so a caller can print the caveat instead of a
 * confident wrong number.
 *
 * `sinceDays` keeps working exactly as it did, so Overview and Finance are
 * unchanged. Pass `{ fromMs, toMs }` for an explicit window.
 */
export async function listUsage(sinceDays = 30, opts = {}) {
  if (!live()) return { rows: [...previewStore.usage], sample: true, truncated: false };

  const fromMs = typeof opts.fromMs === "number" ? opts.fromMs : Date.now() - sinceDays * 86400000;
  const toMs = typeof opts.toMs === "number" ? opts.toMs : null;

  const rows = [];
  let truncated = false;
  for (let page = 0; page * USAGE_PAGE < USAGE_MAX; page += 1) {
    let q = getSupabase()
      .from("admin_usage_events").select(USAGE_COLS)
      .gte("ts", new Date(fromMs).toISOString());
    if (toMs) q = q.lte("ts", new Date(toMs).toISOString());
    /* ORDERED ON ts AND THEN id, and the second one is load-bearing.
     * `ts` is not unique — usage-ingest writes up to 500 rows in one call and
     * recordAiUsage stamps whole milliseconds — and Postgres gives no stable
     * order inside a tie group across two separate range queries. With 40 rows
     * sharing a timestamp across a page boundary, page 1 can re-order and hand
     * back rows page 0 already had while others are never returned at all. The
     * old `.limit(5000)` was a known undercount; ordering on ts alone would
     * have replaced it with a silent, non-repeatable one. */
    const { data, error } = await q
      .order("ts", { ascending: true })
      .order("id", { ascending: true })
      .range(page * USAGE_PAGE, (page + 1) * USAGE_PAGE - 1);
    if (error) {
      /* Rows already read are still true. Return them AND the error, so a page
       * can show what it has and say the rest is missing — rather than
       * throwing away good rows or, worse, presenting a part total as whole. */
      /* `partial`, not `truncated`. They are different sentences on screen:
       * one says "pick a shorter window", the other says "the database did not
       * answer". The first version returned truncated for both. */
      return { rows, error: error.message, sample: false, truncated: false, partial: true };
    }
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < USAGE_PAGE) return { rows, sample: false, truncated: false };
    if (rows.length >= USAGE_MAX) { truncated = true; break; }
  }
  return { rows, sample: false, truncated };
}

/** The price book, for the AI Cost page's own price table. */
export async function listModelPrices() {
  if (!live()) {
    return { rows: [{
      id: "p1", provider: "anthropic", model: "claude-sonnet-4-6",
      effective_from: "2026-01-01", effective_to: null,
      input_per_mtok: 3000000, output_per_mtok: 15000000,
      cache_write_per_mtok: 3750000, cache_write_1h_per_mtok: 6000000,
      cache_read_per_mtok: 300000, currency: "USD",
      source_url: "https://platform.claude.com/docs/en/about-claude/pricing",
    }], sample: true };
  }
  const { data, error } = await getSupabase()
    .from("ai_model_prices").select("*")
    .order("provider", { ascending: true }).order("model", { ascending: true })
    .order("effective_from", { ascending: false }).limit(500);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/**
 * The provider's own bills, for the true-up.
 * NOTHING WRITES TO THIS TABLE YET — that needs an Admin key, which only an org
 * owner can create. An empty list here is the normal state, not a fault, and
 * the page says "no bill on file" rather than showing a gap of 100%.
 */
export async function listProviderBills() {
  if (!live()) return { rows: [], sample: true };
  const { data, error } = await getSupabase()
    .from("ai_provider_bills").select("*").order("period_start", { ascending: false }).limit(200);
  /* A missing table is the expected state until 0024 has been run, and it is
   * not worth an error banner. Anything else is. */
  if (error) return { rows: [], error: error.message, sample: false, missing: /does not exist|schema cache/i.test(error.message) };
  return { rows: data || [], sample: false };
}

/** Usage writes we are KNOWN to have lost. A hole nobody is told about is the
 *  same as no books at all. */
export async function listUsageMisses(sinceDays = 1) {
  if (!live()) return { rows: [], sample: true };
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const { data, error } = await getSupabase()
    .from("admin_activity_log").select("id, created_at, body")
    .eq("kind", "usage_write_failed").gte("created_at", since)
    .order("created_at", { ascending: false }).limit(51);
  if (error) return { rows: [], error: error.message, sample: false };
  const rows = data || [];
  // 51 asked for, 50 shown: fetching one more than you print is how a "there
  // are more" line gets to be true rather than decorative.
  return { rows: rows.slice(0, 50), more: rows.length > 50, sample: false };
}

export async function listActivity(limit = 30) {
  if (!live()) return { rows: [...previewStore.activity], sample: true };
  const { data, error } = await getSupabase()
    .from("admin_activity_log").select("*").order("created_at", { ascending: false }).limit(limit);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function logActivity({ actor, kind, title, body }) {
  if (!live()) {
    previewStore.activity.unshift({ id: pid("g"), actor: actor || "preview-user", kind, title, body: body || null, created_at: new Date().toISOString() });
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_activity_log").insert({ actor, kind, title, body: body || null });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function listTeam() {
  if (!live()) return { rows: [...previewStore.team], sample: true };
  const { data, error } = await getSupabase()
    .from("admin_users").select("user_id, email, full_name, role, active, created_at").order("created_at", { ascending: true });
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function updateTeamMember(userId, patch) {
  if (!live()) {
    const i = previewStore.team.findIndex((m) => m.user_id === userId);
    if (i >= 0) previewStore.team[i] = { ...previewStore.team[i], ...patch };
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_users").update(patch).eq("user_id", userId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/* ------------------------------------------------------------------ */
/* NOTES + REMINDERS (the Work page)                                    */
/*                                                                      */
/* Notes are private to their author — enforced in the database, not     */
/* just here. Reminders are per-person too, but an owner/admin can read  */
/* the team's so nothing quietly rots.                                   */
/* ------------------------------------------------------------------ */

export async function listNotes(authorId) {
  if (!live()) {
    /* Filter by author here too. Aug 26 2026: the preview branch ignored
     * `authorId` while the live branch below filters on it, so once you could
     * enter the preview console as the rep, the rep was shown the owner's
     * private notes. A preview that leaks something the real thing locks down
     * is worse than no preview — it teaches you the console is fine. */
    const rows = [...previewStore.notes]
      .filter((n) => !authorId || n.author_id === authorId)
      .sort(
        (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated_at.localeCompare(a.updated_at)
      );
    return { rows, sample: true };
  }
  let q = getSupabase().from("admin_notes").select("*")
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(300);
  if (authorId) q = q.eq("author_id", authorId);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function upsertNote(patch) {
  if (!live()) {
    const now = new Date().toISOString();
    if (patch.id) {
      const i = previewStore.notes.findIndex((n) => n.id === patch.id);
      if (i >= 0) previewStore.notes[i] = { ...previewStore.notes[i], ...patch, updated_at: now };
      return { ok: true, row: previewStore.notes[i], sample: true };
    }
    const row = { id: pid("n"), author_id: "preview-user", title: null, body: "", pinned: false, link_type: null, link_id: null, created_at: now, updated_at: now, ...patch };
    previewStore.notes.unshift(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_notes").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_notes").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

export async function deleteNote(id) {
  if (!live()) {
    previewStore.notes = previewStore.notes.filter((n) => n.id !== id);
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_notes").delete().eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Open reminders (done_at is null) unless includeDone. Soonest due first. */
export async function listReminders(ownerId, { includeDone = false } = {}) {
  if (!live()) {
    /* Same fix as listNotes above, same date, same reason: the preview branch
     * ignored `ownerId` and handed the owner's follow-ups to every account. */
    let rows = previewStore.reminders.filter((r) => !ownerId || r.owner_id === ownerId);
    if (!includeDone) rows = rows.filter((r) => !r.done_at);
    rows.sort((a, b) => a.due_at.localeCompare(b.due_at));
    return { rows, sample: true };
  }
  let q = getSupabase().from("admin_reminders").select("*").order("due_at", { ascending: true }).limit(300);
  if (ownerId) q = q.eq("owner_id", ownerId);
  if (!includeDone) q = q.is("done_at", null);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function upsertReminder(patch) {
  if (!live()) {
    if (patch.id) {
      const i = previewStore.reminders.findIndex((r) => r.id === patch.id);
      if (i >= 0) previewStore.reminders[i] = { ...previewStore.reminders[i], ...patch };
      return { ok: true, row: previewStore.reminders[i], sample: true };
    }
    const row = { id: pid("r"), owner_id: "preview-user", created_by: "preview-user", done_at: null, link_type: null, link_id: null, created_at: new Date().toISOString(), ...patch };
    previewStore.reminders.unshift(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_reminders").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_reminders").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

export async function deleteReminder(id) {
  if (!live()) {
    previewStore.reminders = previewStore.reminders.filter((r) => r.id !== id);
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_reminders").delete().eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/* ------------------------------------------------------------------ */
/* THE WORK PAGE AGGREGATOR                                             */
/* ------------------------------------------------------------------ */

/** Whole days since an ISO timestamp. null when there is no timestamp. */
function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/* How long a lead in each stage may sit untouched before it counts as owed a
 * contact. A lead nobody has ever called is more urgent than one you spoke to
 * yesterday, and a won or lost lead is never chased. */
const STALE_AFTER_DAYS = { new: 1, contacted: 3, follow_up: 5, meeting: 5, proposal: 4 };

/** Everything one person owes work on, in one read.
 *
 * The buckets are decided here rather than in the page, so the same rules
 * drive both the counts and the lists. Computing them twice is how you end up
 * with a header that says "3 due" above a list of four. */
export async function getMyWork(userId) {
  const [clients, tasks, leads, tickets, reminders, activity] = await Promise.all([
    listClients(), listTasks(), listLeads(), listTickets(), listReminders(userId), listAllLeadActivity(60),
  ]);

  const sample = Boolean(clients.sample || tasks.sample || leads.sample);
  const clientName = (id) => clients.rows.find((c) => c.id === id)?.name || null;
  const mine = (v) => !userId || v === userId;

  const endOfToday = new Date().setHours(23, 59, 59, 999);
  const endOfWeek = endOfToday + 6 * 86400000;
  /* Due dates are compared as YYYY-MM-DD text. Subtracting 86400000ms from
   * end-of-today assumes every yesterday was 24 hours long, so on the day after
   * a clock change a task that was due yesterday landed in "due today". */
  const todayStr = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  /* ---- tasks assigned to me, still open ---- */
  const myTasks = tasks.rows
    .filter((t) => mine(t.assigned_to) && t.status !== "done")
    .map((t) => {
      const due = t.due_date ? Date.parse(t.due_date + "T23:59:59") : null;
      let bucket = "later";
      if (t.status === "blocked") bucket = "blocked";
      else if (due === null) bucket = "nodate";
      else if (t.due_date < todayStr) bucket = "overdue";
      else if (t.due_date === todayStr) bucket = "today";
      else if (due <= endOfWeek) bucket = "week";
      return { ...t, client_name: clientName(t.client_id), due_ms: due, bucket };
    });

  /* ---- leads owed a contact, each with the reason why ---- */
  const lastTouch = {};
  for (const a of activity.rows) {
    const prev = lastTouch[a.lead_id];
    if (!prev || a.created_at > prev) lastTouch[a.lead_id] = a.created_at;
  }
  const contactable = leads.rows
    /* isOpen, not a bare ["won","lost"]: a lead marked Skip – 90+ or Bad
     * contact info is finished with too, and nagging somebody about a firm
     * they were told to skip is how this list stops being read. */
    .filter((l) => mine(l.owner_id) && isOpen(l.stage) && !l.became_customer)
    .map((l) => {
      const touched = l.last_activity_at || lastTouch[l.id] || null;
      const idle = daysSince(touched);
      const followMs = l.next_follow_up_at ? Date.parse(l.next_follow_up_at) : null;
      let reason = null;
      let urgency = 3;
      if (followMs !== null && followMs < endOfToday - 86400000) {
        reason = "Follow-up was due " + Math.abs(daysSince(l.next_follow_up_at)) + "d ago";
        urgency = 0;
      } else if (followMs !== null && followMs <= endOfToday) {
        reason = "Follow-up due today"; urgency = 1;
      } else if (touched === null) {
        reason = "Never contacted"; urgency = 1;
      } else if (idle !== null && idle >= (STALE_AFTER_DAYS[l.stage] ?? 7)) {
        reason = "No contact in " + idle + "d"; urgency = 2;
      }
      return { ...l, last_touch: touched, idle_days: idle, follow_ms: followMs, reason, urgency };
    })
    .filter((l) => l.reason)
    .sort((a, b) => a.urgency - b.urgency || (b.idle_days ?? 0) - (a.idle_days ?? 0));

  /* ---- tickets on me that aren't finished ---- */
  const myTickets = tickets.rows
    .filter((t) => mine(t.assigned_to) && !["solved", "closed"].includes(t.status));

  const dueReminders = reminders.rows.filter((r) => Date.parse(r.due_at) <= endOfToday);

  return {
    sample,
    /* activity.error was missing here until Aug 22 2026 (carried over from the
     * parallel Overview session). That read decides "never contacted" and "no
     * contact in N days", so losing it silently mis-counted People to contact
     * with nothing on screen to say so. */
    error: clients.error || tasks.error || leads.error || tickets.error || reminders.error
      || activity.error || null,
    clients: clients.rows,
    tasks: myTasks,
    contactable,
    /* THE RAW ROWS, and null when the read failed.
     *
     * Added Aug 26 2026 for the rep's Work page, which needs every lead the
     * person owns — not just the ones owed a contact — to show how their claims
     * stand and what stage their own pipeline is in. It reads them from HERE
     * rather than calling listLeads() again on purpose: two reads of the same
     * table are two snapshots, and two snapshots are how the tiles at the top of
     * a page end up disagreeing with the panel below them.
     *
     * null, not [], when the read failed. That is the only thing telling "you
     * own no leads" apart from "your leads could not be read", and printing the
     * second one as a zero says "nothing there", which is a different claim. */
    leadRows: leads.error ? null : leads.rows,
    reminderRows: reminders.error ? null : reminders.rows,
    tickets: myTickets,
    reminders: reminders.rows,
    counts: {
      overdue: myTasks.filter((t) => t.bucket === "overdue").length,
      today: myTasks.filter((t) => t.bucket === "today").length,
      blocked: myTasks.filter((t) => t.bucket === "blocked").length,
      contact: contactable.length,
      remindersDue: dueReminders.length,
      tickets: myTickets.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* CSV parsing (RFC 4180-ish: quotes, escaped quotes, newlines in cells) */
/* ------------------------------------------------------------------ */

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const src = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell); cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}

/** Guess which lead field each CSV column maps to, by header name. */
export function guessLeadColumn(header) {
  const h = String(header || "").toLowerCase().replace(/[^a-z]/g, "");
  if (/^(fullname|name|contact|contactname|firstname)/.test(h)) return "name";
  if (/(company|business|firm|org)/.test(h)) return "company";
  if (/(domain|website|url|site)/.test(h)) return "domain";
  if (/(email|mail)/.test(h)) return "email";
  if (/(phone|mobile|cell|number)/.test(h)) return "phone";
  if (/^city/.test(h)) return "city";
  if (/^(state|region|province)/.test(h)) return "state";
  if (/(vertical|industry|category|niche)/.test(h)) return "vertical";
  if (/(note|comment|detail)/.test(h)) return "notes";
  return "";
}


/* ------------------------------------------------------------------ */
/* THE TEAM INBOX                                                      */
/* ------------------------------------------------------------------ */
/* Gmail itself is read through the /api endpoints (tokens never touch the
 * browser). Everything in here is OUR side of it: the status of a thread, which
 * client it belongs to, who owns it.
 *
 * Preview mode has a whole sample mailbox in previewStore, and every write below
 * mutates it, so the page can be clicked through end to end before the Google
 * keys exist. Sample writes do not persist past a page reload — that is the
 * point of the SAMPLE badge. */

/** Our rows for a mailbox. Used directly for the Waiting / Scheduled / Done /
 * No-reply-needed views, because those threads have often left the Gmail inbox
 * and would not come back in an inbox listing. */
export async function listEmailThreads({ mailbox, statuses, clientId } = {}) {
  if (!live()) {
    let rows = previewStore.emailThreads.filter((r) => !mailbox || r.mailbox === mailbox);
    if (statuses?.length) rows = rows.filter((r) => statuses.includes(r.status));
    if (clientId) rows = rows.filter((r) => r.client_id === clientId);
    rows = [...rows].sort((a, b) => String(b.last_message_at || "").localeCompare(String(a.last_message_at || "")));
    return { rows, sample: true };
  }
  let q = getSupabase()
    .from("admin_email_threads")
    .select("*")
    .order("last_message_at", { ascending: false })
    .limit(400);
  if (mailbox) q = q.eq("mailbox", mailbox);
  if (statuses?.length) q = q.in("status", statuses);
  if (clientId) q = q.eq("client_id", clientId);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/** Create-or-update the bookkeeping row for one Gmail thread.
 *
 * `cache` is what Gmail told us about the thread (subject, sender, snippet). It
 * is only used when the row does not exist yet, so a hand-typed note or a
 * client link is never clobbered by a background refresh.
 */
export async function upsertEmailThread({ mailbox, threadId, patch, cache, userId }) {
  if (!mailbox || !threadId) return { ok: false, error: "Missing mailbox or thread." };
  const now = new Date().toISOString();
  const changed = { ...patch };
  if (Object.prototype.hasOwnProperty.call(changed, "status")) {
    changed.status_changed_at = now;
    changed.status_changed_by = userId || null;
  }

  if (!live()) {
    const i = previewStore.emailThreads.findIndex((r) => r.mailbox === mailbox && r.thread_id === threadId);
    if (i >= 0) {
      previewStore.emailThreads[i] = { ...previewStore.emailThreads[i], ...changed, updated_at: now };
    } else {
      previewStore.emailThreads.unshift({
        id: pid("et"), mailbox, thread_id: threadId,
        status: "new", client_id: null, lead_id: null, assigned_to: null, priority: "normal",
        subject: cache?.subject || null, from_name: cache?.fromName || null, from_email: cache?.fromEmail || null,
        snippet: cache?.snippet || null,
        last_message_at: cache?.lastMessageAt || now,
        message_count: cache?.messageCount || 1,
        last_direction: cache?.lastDirection || "in",
        notes: null, status_changed_at: now, status_changed_by: userId || null,
        created_at: now, updated_at: now,
        ...changed,
      });
    }
    // Marking Done archives the mail. The sample mailbox has to behave the same
    // way or the Done view would be lying about what it does.
    if (changed.status) {
      const t = previewStore.mailThreads.find((x) => x.id === threadId);
      if (t) {
        if (changed.status === "done") t.inInbox = false;
        else if (t.inInbox === false) t.inInbox = true;
      }
    }
    const row = previewStore.emailThreads.find((r) => r.mailbox === mailbox && r.thread_id === threadId);
    return { ok: true, row, sample: true };
  }

  const supabase = getSupabase();
  const { data: existing, error: readErr } = await supabase
    .from("admin_email_threads")
    .select("id")
    .eq("mailbox", mailbox)
    .eq("thread_id", threadId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };

  if (existing) {
    const { data, error } = await supabase
      .from("admin_email_threads")
      .update(changed)
      .eq("id", existing.id)
      .select()
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, row: data };
  }

  const insert = {
    mailbox,
    thread_id: threadId,
    subject: cache?.subject || null,
    from_name: cache?.fromName || null,
    from_email: cache?.fromEmail || null,
    snippet: cache?.snippet || null,
    last_message_at: cache?.lastMessageAt || now,
    message_count: cache?.messageCount || 1,
    last_direction: cache?.lastDirection || "in",
    ...changed,
  };
  const { data, error } = await supabase
    .from("admin_email_threads")
    .insert(insert)
    .select()
    .maybeSingle();

  if (error) {
    /* Two people working the same shared inbox can set a status on the same
     * untracked thread in the same second. Both insert, one loses on the
     * (mailbox, thread_id) unique index. Turn that into an update instead of an
     * error toast — the other person's row is the row we wanted. */
    const isDuplicate = error.code === "23505" || /duplicate key|already exists/i.test(error.message || "");
    if (isDuplicate) {
      const { data: winner } = await supabase
        .from("admin_email_threads").select("id")
        .eq("mailbox", mailbox).eq("thread_id", threadId).maybeSingle();
      if (winner) {
        const retry = await supabase
          .from("admin_email_threads").update(changed).eq("id", winner.id).select().maybeSingle();
        if (!retry.error) return { ok: true, row: retry.data };
      }
    }
    return { ok: false, error: error.message };
  }
  return { ok: true, row: data };
}

/* ---------------- preview-mode Gmail stand-in ---------------- */

/** The sample mailbox, shaped exactly like /api/gmail-threads returns it, so the
 * page has one shape to render whether Gmail is connected or not. */
export function sampleMailThreads({ q } = {}) {
  const tracked = new Map(previewStore.emailThreads.map((r) => [r.thread_id, r]));
  let rows = previewStore.mailThreads
    .filter((t) => t.inInbox !== false)
    .map((t) => {
      const row = tracked.get(t.id);
      return {
        ...t,
        rowId: row?.id || null,
        status: row?.status || "new",
        clientId: row?.client_id || null,
        leadId: row?.lead_id || null,
        assignedTo: row?.assigned_to || null,
        priority: row?.priority || "normal",
        threadNotes: row?.notes || null,
      };
    });
  if (q?.trim()) {
    const needle = q.trim().toLowerCase();
    rows = rows.filter((t) => `${t.subject} ${t.from} ${t.snippet}`.toLowerCase().includes(needle));
  }
  return rows.sort((a, b) => (b.date || 0) - (a.date || 0));
}

export function sampleThreadMessages(threadId) {
  return previewStore.mailMessages[threadId] || [];
}

/** Add a sent reply to the sample thread so preview mode shows the same
 * before-and-after a real send does. */
export function sampleAppendMessage(threadId, message) {
  if (!previewStore.mailMessages[threadId]) previewStore.mailMessages[threadId] = [];
  previewStore.mailMessages[threadId].push({
    id: pid("m"), direction: "out", attachments: [], date: Date.now(), ...message,
  });
  const t = previewStore.mailThreads.find((x) => x.id === threadId);
  if (t) {
    t.messageCount = previewStore.mailMessages[threadId].length;
    t.snippet = String(message.body || "").slice(0, 140);
    t.date = Date.now();
    t.unread = false;
    t.lastDirection = "out";
  }
}

/** Mark a sample thread read, so opening one behaves like the real thing. */
export function sampleMarkRead(threadId) {
  const t = previewStore.mailThreads.find((x) => x.id === threadId);
  if (t) t.unread = false;
}

/* ---------------- linking mail to who it is about ---------------- */

/** Guess which client or lead an email belongs to, by address then by domain.
 * A guess is only ever OFFERED in the UI — nothing is linked without a click,
 * because "dana@" at a shared agency address would link the wrong company. */
export function suggestLinkForEmail(fromEmail, clients = [], leads = []) {
  const addr = String(fromEmail || "").toLowerCase().trim();
  if (!addr || !addr.includes("@")) return null;
  const domain = addr.split("@")[1];

  const clientByEmail = clients.find((c) => (c.contact_email || "").toLowerCase() === addr);
  if (clientByEmail) return { kind: "client", id: clientByEmail.id, name: clientByEmail.name, why: "same email address as the client contact" };

  const leadByEmail = leads.find((l) => (l.email || "").toLowerCase() === addr);
  if (leadByEmail) return { kind: "lead", id: leadByEmail.id, name: leadByEmail.company || leadByEmail.name, why: "same email address as the lead" };

  // Domain match, but never on a free mailbox provider — half our clients use
  // Gmail, and "@gmail.com" would link every one of them to the first match.
  const FREE = ["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "msn.com", "comcast.net"];
  if (FREE.includes(domain)) return null;

  const clientByDomain = clients.find((c) => {
    const d = String(c.domain || "").toLowerCase().replace(/^www\./, "");
    return d && (d === domain || domain.endsWith(`.${d}`));
  });
  if (clientByDomain) return { kind: "client", id: clientByDomain.id, name: clientByDomain.name, why: `same website domain (${domain})` };

  const leadByDomain = leads.find((l) => {
    const d = String(l.domain || "").toLowerCase().replace(/^www\./, "");
    return d && (d === domain || domain.endsWith(`.${d}`));
  });
  if (leadByDomain) return { kind: "lead", id: leadByDomain.id, name: leadByDomain.company || leadByDomain.name, why: `same website domain (${domain})` };

  return null;
}


/* ------------------------------------------------------------------ */
/* CLIENT WEBSITES                                                     */
/* ------------------------------------------------------------------ */
/* Every address that belongs to a client: their own site, the ranking sites we
 * build, their Google Business Profile, their listings. A list, not a text box,
 * so it can be sorted, checked and counted. */

export async function listClientSites(clientId) {
  if (!live()) {
    const rows = previewStore.clientSites
      .filter((s) => !clientId || s.client_id === clientId)
      .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.created_at).localeCompare(String(b.created_at)));
    return { rows, sample: true };
  }
  let q = getSupabase().from("admin_client_sites").select("*")
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(300);
  if (clientId) q = q.eq("client_id", clientId);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function upsertClientSite(patch) {
  if (!live()) {
    const now = new Date().toISOString();
    if (patch.id) {
      const i = previewStore.clientSites.findIndex((s) => s.id === patch.id);
      if (i >= 0) previewStore.clientSites[i] = { ...previewStore.clientSites[i], ...patch, updated_at: now };
      return { ok: true, row: previewStore.clientSites[i], sample: true };
    }
    const row = {
      id: pid("cs"), kind: "authority", label: "", url: "", live: true, notes: null, sort: 0,
      created_at: now, updated_at: now, ...patch,
    };
    previewStore.clientSites.push(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_client_sites").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_client_sites").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

export async function deleteClientSite(id) {
  if (!live()) {
    previewStore.clientSites = previewStore.clientSites.filter((s) => s.id !== id);
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_client_sites").delete().eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/* ------------------------------------------------------------------ */
/* WHERE THIS CLIENT STANDS                                            */
/* ------------------------------------------------------------------ */

/** Read back what was saved on the client row. Returns null when nobody has
 * written one yet. Bad JSON is treated as "none" rather than crashing the page. */
export function readSavedStanding(client) {
  if (!client?.standing_summary) return null;
  try {
    const standing = JSON.parse(client.standing_summary);
    if (!standing || (!standing.headline && !standing.done?.length && !standing.needed?.length)) return null;
    return {
      standing,
      facts: client.standing_facts || null,
      at: client.standing_at || null,
      source: client.standing_source || "counted",
    };
  } catch {
    return null;
  }
}

/** PREVIEW MODE ONLY. Live mode posts to /api/client-standing, which counts the
 * same facts server-side with the same shared functions. Kept here so the whole
 * client page can be used before any key exists. */
export async function computeStandingPreview(clientId) {
  const client = previewStore.clients.find((c) => c.id === clientId);
  if (!client) return { ok: false, error: "No such client." };
  const emailThreads = previewStore.emailThreads.filter((e) => e.client_id === clientId);
  const rowIds = new Set(emailThreads.map((e) => e.id));
  const facts = assembleFacts({
    client,
    tasks: previewStore.tasks.filter((t) => t.client_id === clientId),
    weekly: previewStore.weekly.filter((w) => w.client_id === clientId),
    emailThreads,
    sites: previewStore.clientSites.filter((s) => s.client_id === clientId),
    reminders: previewStore.reminders.filter((r) => r.link_type === "email" && rowIds.has(r.link_id) && !r.done_at),
    nowMs: Date.now(),
  });
  const standing = deterministicStanding(facts);
  const at = new Date().toISOString();
  client.standing_summary = JSON.stringify(standing);
  client.standing_facts = facts;
  client.standing_at = at;
  client.standing_source = "counted";
  return { ok: true, standing, facts, at, source: "counted", sample: true };
}


/* ------------------------------------------------------------------ */
/* PLATFORM ACCOUNTS (the login cards)                                 */
/* ------------------------------------------------------------------ */
/* One row per login we hold on the customer platform: ours, and one for each
 * client whose workspace we work inside. The console never stores a password —
 * it asks the server for a one-time sign-in link for the saved address.
 *
 * Added Aug 18 2026. Table: admin_platform_accounts (migration 0005).
 * Appended at the end of this file on purpose — see the append-only rule. */

/* Sample rows so the whole page works before any key exists. Attached to the
 * preview store rather than written into its literal, so two sessions editing
 * this file cannot collide on the same lines. */
previewStore.platformAccounts = [
  { id: "pa1", client_id: null, label: "AI Syndicate (us)", email: "team@aisyndicate-sample.com", site: "aisyndicate.com", plan: "Agency", vault_url: null, notes: "Our own workspace. Point YOUR SITE at aisyndicate.com before running anything.", active: true, sort: 0, last_opened_at: daysAgo(1), last_opened_by: "preview-user", created_at: daysAgo(30), updated_at: daysAgo(1) },
  { id: "pa2", client_id: "c1", label: "Lakeside Realty Group", email: "dana@sample.com", site: "lakesiderealty-sample.com", plan: "Radar", vault_url: null, notes: null, active: true, sort: 0, last_opened_at: daysAgo(3), last_opened_by: "preview-user", created_at: daysAgo(24), updated_at: daysAgo(3) },
  { id: "pa3", client_id: "c2", label: "Harbor Injury Law", email: "j@sample.com", site: "harborinjurylaw-sample.com", plan: "Radar", vault_url: null, notes: "Two-factor is on — the tab stops for a code.", active: true, sort: 0, last_opened_at: null, last_opened_by: null, created_at: daysAgo(90), updated_at: daysAgo(90) },
];

/** Every saved login, or just one client's. Pass "ours" for the agency's own. */
export async function listPlatformAccounts(clientId = null) {
  const pick = (rows) => {
    if (clientId === "ours") return rows.filter((a) => !a.client_id);
    if (clientId) return rows.filter((a) => a.client_id === clientId);
    return [...rows]; // never hand back the store itself — the sort below would reorder it
  };
  if (!live()) {
    const rows = pick(previewStore.platformAccounts)
      .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.created_at).localeCompare(String(b.created_at)));
    return { rows, sample: true };
  }
  let q = getSupabase().from("admin_platform_accounts").select("*")
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(300);
  if (clientId === "ours") q = q.is("client_id", null);
  else if (clientId) q = q.eq("client_id", clientId);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function upsertPlatformAccount(patch) {
  if (!live()) {
    const now = new Date().toISOString();
    const clash = previewStore.platformAccounts.find(
      (a) => a.id !== patch.id && String(a.email || "").toLowerCase() === String(patch.email || "").toLowerCase()
    );
    if (patch.email && clash) return { ok: false, error: `That login is already saved as "${clash.label}".` };
    if (patch.id) {
      const i = previewStore.platformAccounts.findIndex((a) => a.id === patch.id);
      if (i < 0) return { ok: false, error: "That account is not on the list any more. Refresh the page." };
      previewStore.platformAccounts[i] = { ...previewStore.platformAccounts[i], ...patch, updated_at: now };
      return { ok: true, row: previewStore.platformAccounts[i], sample: true };
    }
    const row = {
      id: pid("pa"), client_id: null, label: "", email: "", site: null, plan: null, vault_url: null,
      notes: null, active: true, sort: 0, last_opened_at: null, last_opened_by: null,
      created_at: now, updated_at: now, ...patch,
    };
    previewStore.platformAccounts.push(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_platform_accounts").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_platform_accounts").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) {
    // The unique index on lower(email) is the guard against two cards fighting
    // over one login. Say what actually happened instead of the raw text.
    const dup = /duplicate key|unique constraint/i.test(error.message || "");
    return { ok: false, error: dup ? "That login is already saved on another card." : error.message };
  }
  /* A write that changed nothing comes back as { data: null, error: null } —
   * the row was deleted by someone else, or row-level security filtered it
   * out. Reporting that as saved is how a change quietly disappears. */
  if (!data) {
    return {
      ok: false,
      error: patch.id
        ? "Nothing was saved — that account is gone, or your account is not allowed to change it. Refresh the page."
        : "Nothing was saved. Your account may not be allowed to add one.",
    };
  }
  return { ok: true, row: data };
}

/** Owners only in the database (migration 0005). An admin's delete matches no
 * rows rather than failing, so the returned rows are counted — a "Removed"
 * message over a card that is still there is worse than a plain no. */
export async function deletePlatformAccount(id) {
  if (!live()) {
    const before = previewStore.platformAccounts.length;
    previewStore.platformAccounts = previewStore.platformAccounts.filter((a) => a.id !== id);
    if (previewStore.platformAccounts.length === before) return { ok: false, error: "That account is not on the list any more." };
    return { ok: true, sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_platform_accounts").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "Nothing was removed. Removing a login card is owners only — switch it off instead, or ask an owner." };
  }
  return { ok: true };
}

/* ==================================================================== */
/* APPENDED Aug 20 2026 — AI notes, brain memory, lead sources.          */
/* Nothing above this line was changed. New sections go BELOW this one.  */
/* ==================================================================== */

/* Preview rows for the three new tables. Names are deliberately fake and
 * domains end in -sample, same rule as the store above. */
const previewNotes = [
  { id: "an1", category: "follow_up", title: "3 leads owed a contact", body: "3 leads have gone past the point where a contact is due. The coldest is Sarah Chen — last touched 9 days ago, sitting at \"contacted\".", evidence: [{ table: "admin_leads", id: "l1", label: "Sarah Chen" }, { table: "admin_leads", id: "l2", label: "Summit Roofing Co" }], written_by: "counted", client_id: null, lead_id: null, owner_id: "preview-user", urgency: 3, status: "open", fingerprint: "lead-cold:preview-user", generated_at: new Date(Date.now() - 2 * 3600e3).toISOString(), created_at: new Date(Date.now() - 2 * 3600e3).toISOString(), updated_at: new Date(Date.now() - 2 * 3600e3).toISOString() },
  { id: "an2", category: "attention", title: "2 tasks for Harbor Injury Law past the date", body: "The oldest is \"Send the schema markup for the second office\" — 6 days past its date, still \"blocked\".", evidence: [{ table: "admin_tasks", id: "t3", label: "Send the schema markup for the second office" }], written_by: "counted", client_id: "c2", lead_id: null, owner_id: null, urgency: 2, status: "open", fingerprint: "tasks-late:c2", generated_at: new Date(Date.now() - 2 * 3600e3).toISOString(), created_at: new Date(Date.now() - 2 * 3600e3).toISOString(), updated_at: new Date(Date.now() - 2 * 3600e3).toISOString() },
  { id: "an3", category: "attention", title: "1 email waiting on us", body: "\"AI visibility audit for our firm\" from Dana W. has been marked needs reply for 2 days.", evidence: [{ table: "admin_email_threads", id: "et1", label: "AI visibility audit for our firm" }], written_by: "ai_written", client_id: "c1", lead_id: null, owner_id: "preview-user", urgency: 2, status: "open", fingerprint: "email-needs-reply", generated_at: new Date(Date.now() - 2 * 3600e3).toISOString(), created_at: new Date(Date.now() - 2 * 3600e3).toISOString(), updated_at: new Date(Date.now() - 2 * 3600e3).toISOString() },
  { id: "an4", category: "in_circulation", title: "6 leads worked in the last 7 days", body: "4 calls, 2 emails across 6 leads. Counted from logged activity only — a call nobody logged is not in this number.", evidence: [{ table: "admin_lead_activity", id: "a1", label: "call (talked)" }], written_by: "counted", client_id: null, lead_id: null, owner_id: null, urgency: 1, status: "open", fingerprint: "sales-moving", generated_at: new Date(Date.now() - 2 * 3600e3).toISOString(), created_at: new Date(Date.now() - 2 * 3600e3).toISOString(), updated_at: new Date(Date.now() - 2 * 3600e3).toISOString() },
  { id: "an5", category: "win", title: "1 lead marked won this week", body: "Lakeside Realty Group.", evidence: [{ table: "admin_leads", id: "l4", label: "Lakeside Realty Group" }], written_by: "counted", client_id: null, lead_id: null, owner_id: null, urgency: 1, status: "open", fingerprint: "leads-won", generated_at: new Date(Date.now() - 2 * 3600e3).toISOString(), created_at: new Date(Date.now() - 2 * 3600e3).toISOString(), updated_at: new Date(Date.now() - 2 * 3600e3).toISOString() },
];

const previewMemory = [
  { id: "bm1", kind: "preference", subject: "Harbor Injury Law", body: "Everything the firm publishes goes through their legal review first. Allow a week.", origin: "assistant", origin_ref: null, client_id: "c2", lead_id: null, weight: 5, confirmed: true, confirmed_by: "preview-user", last_used_at: new Date(Date.now() - 20 * 3600e3).toISOString(), use_count: 4, active: true, created_by: "preview-user", created_at: daysAgo(6), updated_at: daysAgo(1) },
  { id: "bm2", kind: "gotcha", subject: "The platform's scores", body: "Scores cache, sometimes for days. Always re-run and read the MEASURED timestamp before quoting a number.", origin: "person", origin_ref: null, client_id: null, lead_id: null, weight: 5, confirmed: true, confirmed_by: "preview-user", last_used_at: new Date(Date.now() - 3 * 3600e3).toISOString(), use_count: 11, active: true, created_by: "preview-user", created_at: daysAgo(12), updated_at: daysAgo(2) },
  { id: "bm3", kind: "fact", subject: "Lakeside Realty Group", body: "Dana W. is the decision maker. Her office manager handles scheduling but does not sign.", origin: "assistant", origin_ref: null, client_id: "c1", lead_id: null, weight: 3, confirmed: false, confirmed_by: null, last_used_at: null, use_count: 0, active: true, created_by: "preview-user", created_at: daysAgo(2), updated_at: daysAgo(2) },
];

const previewLeadSources = [
  { id: "ls1", label: "CJ's realtor sheet — August", kind: "import", query: {}, provider: null, auto_daily: false, daily_cap: 50, assign_to: [], last_run_at: daysAgo(3), last_run_found: 214, last_run_new: 186, last_run_error: null, active: true, created_by: "preview-user", created_at: daysAgo(3), updated_at: daysAgo(3) },
  { id: "ls2", label: "Destin med spas", kind: "scraper", query: { vertical: "medical spa", city: "Destin", state: "FL", keywords: "med spa" }, provider: "platform", auto_daily: false, daily_cap: 25, assign_to: [], last_run_at: null, last_run_found: null, last_run_new: null, last_run_error: null, active: true, created_by: "preview-user", created_at: daysAgo(1), updated_at: daysAgo(1) },
];

/* ---- AI NOTES ---------------------------------------------------- */

export const NOTE_CATEGORIES = ["follow_up", "attention", "in_circulation", "win"];
export const NOTE_CATEGORY_LABELS = {
  follow_up: "Needs a follow-up",
  attention: "Needs attention",
  in_circulation: "In circulation",
  win: "Wins",
};
export const NOTE_CATEGORY_HELP = {
  follow_up: "Somebody is owed a reply or a call, and it is past due.",
  attention: "This has stopped moving, or it is going wrong.",
  in_circulation: "This is moving right now — here is where it stands.",
  win: "This went well. Nothing else on this page ever says so.",
};

export async function listAiNotes({ statuses = ["open"] } = {}) {
  if (!live()) {
    return { rows: previewNotes.filter((n) => statuses.includes(n.status)), sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_ai_notes").select("*")
    .in("status", statuses)
    .order("urgency", { ascending: false })
    .order("generated_at", { ascending: false })
    .limit(300);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/** Mark a note done or dismissed. A person's decision is never undone by a
 * re-run of the generator, which is why this writes a status and not a delete. */
export async function setNoteStatus(id, status, userId) {
  const patch = { status, status_changed_at: new Date().toISOString(), status_changed_by: userId || null };
  if (!live()) {
    const i = previewNotes.findIndex((n) => n.id === id);
    if (i >= 0) previewNotes[i] = { ...previewNotes[i], ...patch };
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_ai_notes").update(patch).eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Write the note's link back after a task or reminder is made from it, so the
 * page can show "turned into a task" instead of offering it again. */
export async function linkNote(id, patch) {
  if (!live()) {
    const i = previewNotes.findIndex((n) => n.id === id);
    if (i >= 0) previewNotes[i] = { ...previewNotes[i], ...patch };
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_ai_notes").update(patch).eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/* ---- BRAIN MEMORY ------------------------------------------------- */

export const MEMORY_KINDS = ["fact", "preference", "event", "person", "decision", "gotcha"];
export const MEMORY_KIND_LABELS = {
  fact: "Fact", preference: "How they like it", event: "Something that happened",
  person: "About a person", decision: "A decision and why", gotcha: "A trap",
};

export async function listMemory({ includeRetired = false } = {}) {
  if (!live()) {
    return { rows: previewMemory.filter((m) => includeRetired || m.active), sample: true };
  }
  let q = getSupabase().from("admin_brain_memory").select("*")
    .order("weight", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(500);
  if (!includeRetired) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function upsertMemory(patch) {
  if (!live()) {
    const now = new Date().toISOString();
    if (patch.id) {
      const i = previewMemory.findIndex((m) => m.id === patch.id);
      if (i >= 0) previewMemory[i] = { ...previewMemory[i], ...patch, updated_at: now };
      return { ok: true, row: previewMemory[i], sample: true };
    }
    const row = { id: pid("bm"), kind: "fact", origin: "person", weight: 3, confirmed: true, active: true, use_count: 0, last_used_at: null, created_at: now, updated_at: now, ...patch };
    previewMemory.unshift(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_brain_memory").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_brain_memory").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  // 23505 = the unique index. This exact memory is already stored, which is
  // the outcome the person wanted, so it is not reported as a failure.
  if (error?.code === "23505") return { ok: true, duplicate: true };
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

export async function deleteMemory(id) {
  if (!live()) {
    const i = previewMemory.findIndex((m) => m.id === id);
    if (i >= 0) previewMemory.splice(i, 1);
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_brain_memory").delete().eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/* ---- LEAD SOURCES ------------------------------------------------- */

export async function listLeadSources() {
  if (!live()) return { rows: [...previewLeadSources], sample: true };
  const { data, error } = await getSupabase()
    .from("admin_lead_sources").select("*")
    .order("created_at", { ascending: false }).limit(100);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function upsertLeadSource(patch) {
  if (!live()) {
    const now = new Date().toISOString();
    if (patch.id) {
      const i = previewLeadSources.findIndex((s) => s.id === patch.id);
      if (i >= 0) previewLeadSources[i] = { ...previewLeadSources[i], ...patch, updated_at: now };
      return { ok: true, row: previewLeadSources[i], sample: true };
    }
    const row = { id: pid("ls"), kind: "import", query: {}, provider: null, auto_daily: false, daily_cap: 50, assign_to: [], active: true, last_run_at: null, last_run_found: null, last_run_new: null, last_run_error: null, created_at: now, updated_at: now, ...patch };
    previewLeadSources.unshift(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_lead_sources").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_lead_sources").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

/**
 * Which of these dedupe keys are already in the pipeline.
 *
 * Asked BEFORE an import saves anything, so the person is told "12 of these
 * 214 are already here" while they can still do something about it. Chunked at
 * 100, because a single `in` list of two thousand values makes a URL long
 * enough for the database to refuse it — and the refusal would arrive as
 * "import failed" with no clue why.
 */
export async function findExistingLeadKeys(keys) {
  const unique = [...new Set(keys.filter(Boolean))];
  if (!unique.length) return { keys: new Set(), sample: !live() };
  if (!live()) {
    // Preview has no dedupe_key column, so it is computed the same way the
    // browser computes it for the incoming rows — otherwise the preview would
    // claim nothing is ever a duplicate.
    const have = new Set();
    for (const l of previewStore.leads) {
      const k = l.email ? `e:${String(l.email).toLowerCase()}` : null;
      if (k && unique.includes(k)) have.add(k);
    }
    return { keys: have, sample: true };
  }
  const found = new Set();
  const supabase = getSupabase();
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await supabase
      .from("admin_leads").select("dedupe_key").in("dedupe_key", unique.slice(i, i + 100));
    if (error) return { keys: found, error: error.message };
    for (const row of data || []) if (row.dedupe_key) found.add(row.dedupe_key);
  }
  return { keys: found };
}

/** Leads a rep should work next: theirs, still open, coldest first. The same
 * staleness rules as the Work page, so the two can never disagree. */
export function buildCallQueue(leads, userId, { includeUnclaimed = true } = {}) {
  const rows = (leads || []).filter((l) => {
    if (!isOpen(l.stage)) return false;   // skip_90 and bad_contact are finished too
    if (l.owner_id === userId) return true;
    return includeUnclaimed && !l.owner_id;
  });
  const rank = (l) => {
    const limit = STALE_AFTER_DAYS[l.stage];
    const quiet = daysSince(l.last_activity_at || l.created_at);
    if (limit === undefined || quiet === null) return -1;
    return quiet - limit; // above zero = overdue, and by how much
  };
  return rows
    .map((l) => ({ lead: l, over: rank(l), mine: l.owner_id === userId }))
    .sort((a, b) => (b.over - a.over) || (a.mine === b.mine ? 0 : a.mine ? -1 : 1));
}

/* ================================================================== */
/* THE VAULT — passwords, cards and keys                    Aug 21 2026 */
/* ================================================================== */
/*
 * WHAT THIS LAYER CAN AND CANNOT SEE
 *
 * It reads and writes the READABLE half of a vault item: the name, the client,
 * the username, the card brand and last 4, the notes. That half goes straight
 * through Supabase like every other table, guarded by row-level security.
 *
 * It never touches the secret half. `secret_cipher` is not even selected —
 * there is no point carrying a column the browser cannot read, and not
 * selecting it means an accidental console.log of a row cannot print it. The
 * scrambled value is written and read only by /api/vault-secret, on the server,
 * with a key the browser has never had.
 *
 * PREVIEW MODE IS DIFFERENT AND SAYS SO. With no Supabase keys there is no
 * server, so the sample secrets live in memory in plain text. Every function
 * below returns { sample: true } in that mode and the page prints a warning
 * across the top of the list. A vault that looked encrypted and was not would
 * be worse than no vault at all.
 */

/** The columns the browser is allowed to ask for. secret_cipher is missing on
 * purpose — see the note above. */
const VAULT_COLUMNS = "id, client_id, kind, label, description, username, url, card_brand, card_last4, card_exp_month, card_exp_year, card_holder, card_zip, secret_set_at, secret_fields, secret_by, vault_url, notes, tags, favorite, active, sort, added_by, created_at, updated_at";

/** clientId: null = every item, "ours" = the agency's own, or a client id. */
export async function listVaultItems(clientId = null) {
  const pick = (rows) => {
    if (clientId === "ours") return rows.filter((v) => !v.client_id);
    if (clientId) return rows.filter((v) => v.client_id === clientId);
    return [...rows];
  };
  if (!live()) {
    return { rows: pick(previewStore.vaultItems), sample: true };
  }
  let q = getSupabase().from("admin_vault_items").select(VAULT_COLUMNS)
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(500);
  if (clientId === "ours") q = q.is("client_id", null);
  else if (clientId) q = q.eq("client_id", clientId);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function upsertVaultItem(patch) {
  /* Belt and braces. The database trigger in migration 0008 already refuses a
   * secret written from the browser, but the browser should never be the thing
   * that tries: a rejected write shows up as a red toast about a trigger, and
   * nobody reading that toast would know it was working as designed. */
  const clean = { ...patch };
  delete clean.secret_cipher;
  delete clean.secret_fields;
  delete clean.secret_set_at;
  delete clean.secret_by;

  if (!live()) {
    const now = new Date().toISOString();
    if (clean.id) {
      const i = previewStore.vaultItems.findIndex((v) => v.id === clean.id);
      if (i < 0) return { ok: false, error: "That item is not in the vault any more. Refresh the page." };
      previewStore.vaultItems[i] = { ...previewStore.vaultItems[i], ...clean, updated_at: now };
      return { ok: true, row: previewStore.vaultItems[i], sample: true };
    }
    const row = {
      id: pid("v"), client_id: null, kind: "login", label: "", description: null, username: null, url: null,
      card_brand: null, card_last4: null, card_exp_month: null, card_exp_year: null, card_holder: null, card_zip: null,
      secret_set_at: null, secret_fields: [], secret_by: null, vault_url: null, notes: null, tags: [],
      favorite: false, active: true, sort: 0, added_by: "preview-user", created_at: now, updated_at: now, ...clean,
    };
    previewStore.vaultItems.push(row);
    return { ok: true, row, sample: true };
  }

  const supabase = getSupabase();
  const q = clean.id
    ? supabase.from("admin_vault_items").update(clean).eq("id", clean.id).select(VAULT_COLUMNS).maybeSingle()
    : supabase.from("admin_vault_items").insert(clean).select(VAULT_COLUMNS).maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  /* A write that matched no rows comes back { data: null, error: null } from
   * PostgREST. Saying "Saved" over that is how a change quietly disappears —
   * the trap written up in CONTEXT-FOR-AI §17. */
  if (!data) {
    return {
      ok: false,
      error: clean.id
        ? "Nothing was saved — that item is gone, or your account is not allowed to change it. Refresh the page."
        : "Nothing was saved. Your account may not be allowed to add vault items.",
    };
  }
  return { ok: true, row: data };
}

/** Deleting the item does NOT delete the record that somebody read it: the log
 * rows keep the label and drop the link (migration 0008). Say that on the
 * confirm box, not just here. */
export async function deleteVaultItem(id) {
  if (!live()) {
    const before = previewStore.vaultItems.length;
    const gone = previewStore.vaultItems.find((v) => v.id === id);
    previewStore.vaultItems = previewStore.vaultItems.filter((v) => v.id !== id);
    delete previewSecrets[id];
    for (const key of [...previewTyped]) if (key.startsWith(`${id}:`)) previewTyped.delete(key);
    if (previewStore.vaultItems.length === before) return { ok: false, error: "That item is not in the vault any more." };
    // The log outlives the item here too, so preview behaves like the real thing.
    previewStore.vaultReveals.unshift({
      id: pid("vr"), item_id: null, item_label: gone?.label || "(unnamed item)",
      client_id: gone?.client_id || null, actor: "preview-user",
      actor_email: "you@aisyndicate.com", action: "delete",
      fields: gone?.secret_fields || [], created_at: new Date().toISOString(),
    });
    return { ok: true, sample: true };
  }
  const { data, error } = await getSupabase().from("admin_vault_items").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) {
    return { ok: false, error: "Nothing was removed — that item is already gone, or your account is not allowed to remove it." };
  }
  return { ok: true };
}

/** The reveal log. itemId null = everything, newest first. */
export async function listVaultReveals(itemId = null, limit = 100) {
  if (!live()) {
    const rows = previewStore.vaultReveals
      .filter((r) => !itemId || r.item_id === itemId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { rows, sample: true };
  }
  let q = getSupabase().from("admin_vault_reveals").select("*")
    .order("created_at", { ascending: false }).limit(limit);
  if (itemId) q = q.eq("item_id", itemId);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/* ---- preview-mode stand-ins for the three server actions ---- */
/* These exist so the whole page can be clicked through before any key exists.
 * Each one returns { sample: true } and the UI shows it. */

export function previewRevealSecret(itemId, fields) {
  const held = previewSecrets[itemId] || {};
  const values = {};
  for (const f of fields) if (f in held) values[f] = held[f];
  const item = previewStore.vaultItems.find((v) => v.id === itemId);
  previewStore.vaultReveals.unshift({
    id: pid("vr"), item_id: itemId, item_label: item?.label || "(unnamed item)", client_id: item?.client_id || null,
    actor: "preview-user", actor_email: "you@aisyndicate.com", action: "reveal", fields,
    created_at: new Date().toISOString(),
  });
  return {
    ok: true, values, missing: fields.filter((f) => !(f in values)),
    sample: true,
    // true when EVERY field asked for was typed here rather than seeded.
    typed: fields.length > 0 && fields.every((f) => previewTyped.has(`${itemId}:${f}`)),
  };
}

export function previewSaveSecret(itemId, secrets) {
  const i = previewStore.vaultItems.findIndex((v) => v.id === itemId);
  if (i < 0) return { ok: false, error: "That item is not in the vault any more." };
  const next = { ...(previewSecrets[itemId] || {}) };
  for (const [k, v] of Object.entries(secrets)) {
    if (v === null || String(v).trim() === "") delete next[k];
    else next[k] = String(v);
  }
  previewSecrets[itemId] = next;
  for (const [field, value] of Object.entries(secrets || {})) {
    const key = `${itemId}:${field}`;
    if (value !== null && String(value).trim() !== "") previewTyped.add(key);
    else previewTyped.delete(key);
  }
  const fields = Object.keys(next).sort();
  previewStore.vaultItems[i] = {
    ...previewStore.vaultItems[i],
    secret_fields: fields,
    secret_set_at: fields.length ? new Date().toISOString() : null,
    secret_by: fields.length ? "preview-user" : null,
  };
  return { ok: true, fields, sample: true, row: previewStore.vaultItems[i] };
}

export function previewClearSecret(itemId) {
  return previewSaveSecret(itemId, Object.fromEntries(Object.keys(previewSecrets[itemId] || {}).map((k) => [k, ""])));
}

/* ================================================================== */
/* SAVED CLIENT REPORTS                                     Aug 21 2026 */
/* ================================================================== */

export async function listClientReports(clientId, limit = 25) {
  if (!live()) {
    const rows = previewStore.clientReports
      .filter((r) => r.client_id === clientId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { rows, sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_client_reports").select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function deleteClientReport(id) {
  if (!live()) {
    const before = previewStore.clientReports.length;
    previewStore.clientReports = previewStore.clientReports.filter((r) => r.id !== id);
    if (previewStore.clientReports.length === before) return { ok: false, error: "That report is already gone." };
    return { ok: true, sample: true };
  }
  const { data, error } = await getSupabase().from("admin_client_reports").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Nothing was removed — that report is already gone." };
  return { ok: true };
}

/**
 * Preview mode's Generate report. Counts the sample rows with the SAME pure
 * functions the server uses, so what you see before the keys exist is the same
 * shape as what you get after — only the AI wording is missing, and that is
 * labelled COUNTED either way.
 */
export async function generateClientReportPreview(clientId, { instruction, preset, shape, shapePreset } = {}) {
  const client = previewStore.clients.find((c) => c.id === clientId);
  if (!client) return { ok: false, error: "That client does not exist." };

  const todayIso = new Date().toISOString().slice(0, 10);
  const facts = assembleReportFacts({
    client,
    tasks: previewStore.tasks.filter((t) => t.client_id === clientId),
    weekly: previewStore.weekly.filter((w) => w.client_id === clientId),
    emailThreads: previewStore.emailThreads.filter((e) => e.client_id === clientId),
    sites: previewStore.clientSites.filter((s) => s.client_id === clientId),
    reminders: previewStore.reminders.filter((r) => r.link_type === "client" && r.link_id === clientId && !r.done_at),
    invoices: [],
    /* Matched by contact email, the same way the server does it — preview used
     * to hard-code an empty list, so the sample client's one open ticket
     * vanished and preview did not behave like the real thing at all. */
    tickets: previewStore.tickets.filter((t) => {
      const contact = String(client.contact_email || "").trim().toLowerCase();
      return contact && String(t.requester_email || "").trim().toLowerCase() === contact;
    }),
    notes: previewStore.notes.filter((n) => n.link_type === "client" && n.link_id === clientId),
    platformAccounts: previewStore.platformAccounts.filter((a) => a.client_id === clientId),
    vaultItems: previewStore.vaultItems.filter((v) => v.client_id === clientId),
    previousReports: previewStore.clientReports.filter((r) => r.client_id === clientId),
    /* The sample client's own connected accounts, so preview shows the
     * "what their own accounts show" section exactly as the real thing does.
     * Both lists are declared at the bottom of this file (Aug 24 2026) — this
     * function only ever runs on a click, long after the module has loaded. */
    snapshots: previewSnapshots.filter((sn) => sn.client_id === clientId),
    connections: previewConnections.filter((cx) => cx.client_id === clientId && cx.active !== false),
    nowMs: Date.now(),
  });

  const built = deterministicReport(facts, { presetId: preset, todayIso });

  /* The same extra gap lines the server adds, so preview does not quietly
   * under-state what a report cannot cover. Preview has no invoices and no
   * Gmail, and saying so is the whole point of this section. */
  const { cutChars } = buildFactsText(facts);
  const previewGaps = [
    built.cannotCheck,
    cutChars ? `- About ${cutChars} characters of this client's detailed lists did not fit on the fact sheet.` : "",
    "- Money. Preview mode has no invoices at all, so nothing here is about what has been billed or paid.",
    "- Anything the real console would read from Gmail, Stripe or the platform. None of them are connected in preview.",
    shape ? "- How you asked this to read. Preview always writes the plain counted version, which has one fixed shape. With an AI key set, the real console follows what you typed." : "",
  ].filter(Boolean).join("\n");

  const row = {
    id: pid("rep"), client_id: clientId,
    instruction: instruction || null, preset: preset || "standard",
    /* Saved so preview behaves like the real thing on screen. Preview always
     * writes the COUNTED version, which cannot change its own shape — that is
     * the AI's job — so the row carries what was asked for and the answer does
     * not follow it. Said out loud in the gaps below rather than left to
     * surprise somebody. */
    shape: shape || null, shape_preset: shapePreset || null,
    title: built.title, summary: built.summary, body: built.body,
    cannot_check: previewGaps,
    source: "counted", rejected_why: null,
    facts, counts_at: facts.takenAt,
    created_by: "preview-user", created_by_email: "you@aisyndicate.com",
    created_at: new Date().toISOString(),
  };
  previewStore.clientReports.unshift(row);
  return { ok: true, report: row, sample: true, source: "counted" };
}

/* ================================================================== */
/* THE SALES SYSTEM                                         Aug 21 2026 */
/* ================================================================== */
/*
 * Everything the Sales page reads and writes. The rules that DECIDE anything
 * are not here — they are in lib/sales-rules.js, pure and shared with
 * api/sales-sweep.js, because the page a rep reads at 9am and the job that
 * runs at 3am must never disagree about whose claim has run out.
 *
 * This layer only fetches and saves. It follows the same two-mode contract as
 * everything above: LIVE against Supabase, PREVIEW against the in-memory store,
 * and every result carries { sample } so the screen can say which it is.
 */

/* ---- COMPANIES ---------------------------------------------------- */

export async function listCompanies() {
  if (!live()) return { rows: [...previewStore.companies], sample: true };
  return selectAll("admin_companies", { order: "created_at", ascending: false, limit: 2000 });
}

export async function upsertCompany(patch) {
  if (!live()) {
    const now = new Date().toISOString();
    if (patch.id) {
      const i = previewStore.companies.findIndex((c) => c.id === patch.id);
      if (i >= 0) previewStore.companies[i] = { ...previewStore.companies[i], ...patch, updated_at: now };
      return { ok: true, row: previewStore.companies[i], sample: true };
    }
    const row = { id: pid("co"), site_score: null, site_score_at: null, client_id: null, created_at: now, updated_at: now, ...patch };
    previewStore.companies.unshift(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_companies").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_companies").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

/**
 * Save a batch of firms and hand back a map of import-key → real id, so the
 * leads that follow can point at them.
 *
 * Chunked at 200. A single insert of two thousand rows is one request that can
 * time out halfway, and a half-finished company table is worse than none —
 * every lead in the second half would come in with no firm attached and
 * nobody would know which half.
 */
export async function insertCompaniesBatch(rows) {
  const idByKey = {};
  if (!rows.length) return { ok: true, idByKey, count: 0 };
  if (!live()) {
    for (const r of rows) {
      const { key, contacts, ...rest } = r;   // eslint-disable-line no-unused-vars
      const row = { id: pid("co"), site_score: null, site_score_at: null, created_at: new Date().toISOString(), ...rest };
      previewStore.companies.unshift(row);
      idByKey[key] = row.id;
    }
    return { ok: true, idByKey, count: rows.length, sample: true };
  }
  const supabase = getSupabase();
  let count = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const payload = chunk.map(({ key, contacts, ...rest }) => rest);   // eslint-disable-line no-unused-vars
    /* Matched on NAME + WEBSITE together, not on either alone and not on array
     * position.
     *
     * Position assumes PostgREST returns one row per input in the order given;
     * a reordered return would attach every later firm's contacts to the wrong
     * firm, invisibly. But matching on the name alone was just as wrong in the
     * other direction: `groupIntoCompanies` deliberately emits TWO firms with
     * the same name when one name has two websites ("Above & Beyond Real
     * Estate" exists in more than one state), so both keys resolved to
     * whichever one came back last and one office's contacts were filed under
     * the other's. Name and website together are exactly what made them two
     * groups in the first place, so the pair is unique within the batch. */
    const { data, error } = await supabase.from("admin_companies").insert(payload).select("id, name, domain");
    if (error) return { ok: false, error: error.message, idByKey, count };
    const pair = (name, domain) => `${name ?? ""}\u0000${domain ?? ""}`;
    const byPair = new Map((data || []).map((r) => [pair(r.name, r.domain), r.id]));
    const unresolved = [];
    for (const c of chunk) {
      const id = byPair.get(pair(c.name, c.domain));
      if (id) idByKey[c.key] = id;
      else unresolved.push(c.name);
    }
    if ((data || []).length !== chunk.length || unresolved.length) {
      return {
        ok: false, idByKey, count,
        error: unresolved.length
          ? `The database did not return a matching row for ${unresolved.length} firm(s) (${unresolved.slice(0, 3).join(", ")}). Stopping rather than attaching contacts to the wrong firm.`
          : `The database saved ${(data || []).length} of ${chunk.length} firms in one batch. Stopping rather than attaching contacts to the wrong firms.`,
      };
    }
    count += (data || []).length;
  }
  return { ok: true, idByKey, count };
}

/** Firms already on file, keyed the same way the importer keys them, so an
 * import can attach to a firm that is already here instead of making a second
 * copy of it. */
export async function findExistingCompanies() {
  const res = await listCompanies();
  const byKey = {};
  for (const c of res.rows) {
    /* Normalised the same way the importer keys them. Lower-casing alone meant
     * a firm already on file as "backbeathomes.com" did not match an incoming
     * "https://www.backbeathomes.com", so every re-import made a second copy. */
    const d = normaliseDomain(c.domain);
    if (d) byKey[`d:${d}`] = c.id;
    if (c.name_key) byKey[`n:${c.name_key}`] = c.id;
  }
  return { byKey, sample: res.sample };
}

/* ---- LISTS (the sheet's tabs) ------------------------------------- */

export async function listLeadLists() {
  if (!live()) return { rows: [...previewStore.leadLists], sample: true };
  const { data, error } = await getSupabase()
    .from("admin_lead_lists").select("*").order("sort", { ascending: true }).limit(200);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/** The list a tab already made, if there is one. Migration 0009 keeps
 * `sheet_tab` precisely so a second import of the same workbook updates the
 * same list instead of putting a second "Medspas" in the filter dropdown with
 * the contacts split between them — but nothing was ever looking it up. */
export async function findLeadListByTab(tab) {
  if (!tab) return null;
  const res = await listLeadLists();
  return res.rows.find((l) => l.sheet_tab === tab) || null;
}

export async function upsertLeadList(patch) {
  if (!live()) {
    const now = new Date().toISOString();
    if (patch.id) {
      const i = previewStore.leadLists.findIndex((l) => l.id === patch.id);
      if (i >= 0) previewStore.leadLists[i] = { ...previewStore.leadLists[i], ...patch, updated_at: now };
      return { ok: true, row: previewStore.leadLists[i], sample: true };
    }
    const row = { id: pid("li"), active: true, sort: previewStore.leadLists.length, created_at: now, updated_at: now, ...patch };
    previewStore.leadLists.push(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_lead_lists").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_lead_lists").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

/* ---- PROPOSALS ---------------------------------------------------- */

export async function listProposals(leadId = null) {
  if (!live()) {
    const rows = leadId ? previewStore.proposals.filter((p) => p.lead_id === leadId) : [...previewStore.proposals];
    return { rows, sample: true };
  }
  /* +1, so the extra row is the only thing that can tell "exactly 500" apart
   * from "500 and there are more" — the same trick listLeads uses. Every other
   * capped read in this file says when it hit its cap and this one did not, so a
   * rep with more than 500 proposals read part of their pipeline as all of it.
   * Found by an adversarial review, Aug 27 2026. */
  const CAP = 500;
  let q = getSupabase().from("admin_proposals").select("*").order("created_at", { ascending: false }).limit(CAP + 1);
  if (leadId) q = q.eq("lead_id", leadId);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  const rows = data || [];
  if (rows.length > CAP) {
    return {
      rows: rows.slice(0, CAP),
      sample: false,
      truncated: `Only the ${CAP} newest proposals were loaded, so the proposal counts and totals below may be low.`,
    };
  }
  return { rows, sample: false };
}

export async function upsertProposal(patch) {
  if (!live()) {
    const now = new Date().toISOString();
    if (patch.id) {
      const i = previewStore.proposals.findIndex((p) => p.id === patch.id);
      if (i >= 0) previewStore.proposals[i] = { ...previewStore.proposals[i], ...patch, updated_at: now };
      return { ok: true, row: previewStore.proposals[i], sample: true };
    }
    const row = { id: pid("pr"), status: "draft", currency: "usd", created_at: now, updated_at: now, ...patch };
    previewStore.proposals.unshift(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_proposals").update(patch).eq("id", patch.id).select().maybeSingle()
    : supabase.from("admin_proposals").insert(patch).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

export async function deleteProposal(id) {
  if (!live()) {
    previewStore.proposals = previewStore.proposals.filter((p) => p.id !== id);
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_proposals").delete().eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/* ---- THE CLAIM ---------------------------------------------------- */

/**
 * Claim a lead — and, if asked, everybody else at the same firm.
 *
 * The Rules of Engagement say claiming one contact claims the whole firm. The
 * sheet could not do that (it knew rows, not firms), which is why one claimed
 * row at Agents of LA leaves two open for anybody. `alsoSiblings` is what makes
 * that rule real, and it is a choice the person makes on screen rather than
 * something that happens to them.
 *
 * `claimed_at` and `cadence_started_at` are stamped together: the 3-day first
 * contact clock and the 5-touch cadence both start at the claim, so setting
 * one without the other gives a lead a cadence that started at the epoch.
 *
 * `expectUnclaimed` — THE DOUBLE-CLAIM GUARD. Aug 26 2026, found by a checker.
 *
 * This was an unconditional update, so two reps pressing Claim on the same
 * floor row inside the reload window both got a green "Claimed" toast, both
 * wrote a "Claimed by X" line on the timeline, `claimed_at` was re-stamped, and
 * the second write silently won. The rep who saw "Claimed" first did not hold
 * the lead and was not told.
 *
 * So a caller who believes the lead is free says so, and the DATABASE decides:
 * the update carries `owner_id is null` and hands back the rows it actually
 * touched. Whoever loses is told what happened instead of being congratulated.
 *
 * It is opt-in, not the default, because reassigning a lead that already has an
 * owner is a real thing an owner does from the Sales Owner dropdown — a blanket
 * predicate here would have broken that. Callers pass `expectUnclaimed: true`
 * exactly when the row they were looking at showed as unclaimed.
 */
export async function claimLead(leadId, userId, { alsoSiblings = [], name = "someone", fresh = true, expectUnclaimed = false } = {}) {
  const now = new Date().toISOString();
  /* Only the CURRENT claim's clock is reset. `first_contact_at` and
   * `last_touch_at` are history and are never touched here.
   *
   * An earlier version cleared all three, which did stop a re-claimed lead
   * reading as instantly cold — by deleting the date it was first contacted.
   * That took the lead out of the speed-to-first-contact sample and made a
   * lead at proposal stage with nine logged touches report as "never
   * contacted". claimState now runs its cold clock from the LATER of the last
   * touch and the claim, so nothing has to be erased for a new claim to be a
   * new start. */
  const patch = {
    owner_id: userId, claimed_at: now, cadence_started_at: now,
    ...(fresh ? { claim_contacted_at: null } : {}),
  };
  const ids = [leadId, ...alsoSiblings.filter((id) => id !== leadId)];

  /* The message both branches give the loser. One string, in one place: a
   * preview that says something softer than the live path is how a race stops
   * being tested before it is shipped. */
  const TAKEN = "Somebody else claimed this lead first, so nothing was written. Reload to see who holds it now.";

  /* Which ids were actually written. Under `expectUnclaimed` that is decided by
   * the query, not by what we read a moment ago — and only these get a timeline
   * line, so a sibling that was already somebody's does not get a "Claimed by
   * X" it did not receive. */
  let done;

  if (!live()) {
    /* THE PREVIEW BRANCH MATCHES THE LIVE ONE, predicate for predicate. A
     * preview looser than its query is a trap this repo has been bitten by
     * twice: the race passes by hand on sample data and fails in production. */
    done = [];
    for (const id of ids) {
      const i = previewStore.leads.findIndex((l) => l.id === id);
      if (i < 0) continue;
      if (expectUnclaimed && previewStore.leads[i].owner_id) continue;
      previewStore.leads[i] = { ...previewStore.leads[i], ...patch };
      done.push(id);
    }
    if (expectUnclaimed && !done.includes(leadId)) {
      return { ok: false, taken: true, sample: true, error: TAKEN };
    }
  } else {
    let query = getSupabase().from("admin_leads").update(patch).in("id", ids);
    if (expectUnclaimed) query = query.is("owner_id", null);
    /* `select` so the rows the predicate let through come back. Counting on a
     * separate read afterwards would be the same two-step race one step later. */
    const { data, error } = await query.select("id");
    if (error) return { ok: false, error: error.message };
    done = expectUnclaimed ? (data || []).map((r) => r.id) : ids;
    if (expectUnclaimed && !done.includes(leadId)) {
      return { ok: false, taken: true, error: TAKEN };
    }
  }

  /* One timeline line per lead written, so a rep opening any of them later can
   * see it was claimed as part of a firm rather than by itself. */
  for (const id of done) {
    await addLeadActivity({
      leadId: id, actor: userId, type: "claim",
      body: done.length > 1
        ? `Claimed by ${name} — with ${done.length - 1} other contact${done.length === 2 ? "" : "s"} at this firm.`
        : `Claimed by ${name}.`,
    });
  }
  /* What was CLAIMED, not what was asked for. The screen says "and 3 others at
   * this firm" off this number. */
  return { ok: true, count: done.length, asked: ids.length };
}

/** Hand a lead back to the floor, with a reason on its timeline. Never a
 * silent unassign: a firm that vanishes from under a rep with no explanation
 * is how a rep decides the system is against them. */
export async function releaseLead(leadId, { actor, why }) {
  /* The stage is deliberately NOT touched.
   *
   * An earlier version wrote stage:"reopened" here and in the overnight sweep,
   * so a lead sitting at PROPOSAL — with a real proposal row and a number
   * attached — lost that position the night it went quiet, and nothing recorded
   * what it had been. "Reopened" is a fact about the CLAIM, and `owner_id`
   * being null already says it. Where a lead had got to is a different fact and
   * it is not the sweep's to overwrite. */
  const patch = { owner_id: null, claimed_at: null, cadence_started_at: null, claim_contacted_at: null };
  if (!live()) {
    const i = previewStore.leads.findIndex((l) => l.id === leadId);
    if (i >= 0) previewStore.leads[i] = { ...previewStore.leads[i], ...patch };
  } else {
    const { error } = await getSupabase().from("admin_leads").update(patch).eq("id", leadId);
    if (error) return { ok: false, error: error.message };
  }
  await addLeadActivity({ leadId, actor, type: "reopen", body: why });
  return { ok: true };
}

/* ---- THE ONE-TEXT RULE -------------------------------------------- */

/**
 * Claim the one text a lead is allowed, atomically.
 *
 * The browser cannot enforce "exactly one" by reading a counter and writing
 * counter + 1. Two tabs — or two reps — both read 0, both write 1, and two
 * texts go out under a counter that says one. That is not a rare race: a rep
 * with the drawer open in two tabs is a Tuesday.
 *
 * So the database decides, in one statement that only increments if the lead
 * is still under the limit AND an email open is on record (migration 0009,
 * `admin_lead_claim_text`). It returns true to exactly one caller. Everybody
 * else is told no, with a reason.
 */
export async function claimTextSend(leadId, max = 1) {
  if (!live()) {
    const i = previewStore.leads.findIndex((l) => l.id === leadId);
    if (i < 0) return { ok: false, error: "No such lead." };
    const l = previewStore.leads[i];
    /* THE SAME GATE THE DATABASE FUNCTION USES, and it moved. 0021 repointed
     * admin_lead_claim_text at `first_reply_at` because nothing has ever written
     * `email_opened_at`; this preview branch kept the old column, so preview mode
     * refused a text the live path would have allowed. A preview looser OR
     * tighter than the query underneath it is the same trap. Found by the third
     * review, Aug 27 2026. */
    if (!l.first_reply_at) return { ok: false, won: false, error: "They have not written back yet." };
    if (Number(l.texts_sent || 0) >= max) return { ok: false, won: false, error: "A text has already gone out." };
    previewStore.leads[i] = { ...l, texts_sent: Number(l.texts_sent || 0) + 1, last_text_at: new Date().toISOString() };
    return { ok: true, won: true, sample: true };
  }
  const { data, error } = await getSupabase().rpc("admin_lead_claim_text", { p_lead: leadId, p_max: max });
  if (error) return { ok: false, error: error.message };
  if (data !== true) {
    return { ok: false, won: false, error: "Somebody has already used this lead's one text, or no email open is on record." };
  }
  return { ok: true, won: true };
}

/* ---- COUNTING TOUCHES --------------------------------------------- */

/** lead id → how many call/email/text/LinkedIn rows it has. This is what the
 * cadence counts against, and it is derived from real activity rows rather
 * than a counter column — a counter is a number somebody can forget to bump,
 * and then the cadence quietly asks for the same email twice.
 *
 * It cannot tell an inbound email from an outbound one; the table has no
 * direction column. Written down rather than described away. */
export function touchCountsByLead(activityRows) {
  const out = {};
  for (const a of activityRows || []) {
    if (!["call", "email", "text", "linkedin"].includes(a.type)) continue;
    out[a.lead_id] = (out[a.lead_id] || 0) + 1;
  }
  return out;
}

/** Everything the Sales page needs, in one read, so the tiles and the lists
 * can never be counting different snapshots of the same pipeline. */
/** How far back getSalesBoard reads activity. Exported, because two columns on
 *  the sheet are counted from it and the words on them must name the same
 *  number the read used. Hardcoding 90 in the page is how a column ends up
 *  claiming a lifetime fact from a 90-day count. */
export const ACTIVITY_WINDOW_DAYS = 90;

export async function getSalesBoard() {
  const [leads, companies, lists, team, activity, proposals, sources] = await Promise.all([
    listLeads(), listCompanies(), listLeadLists(), listTeam(),
    listAllLeadActivity(ACTIVITY_WINDOW_DAYS), listProposals(), listLeadSources(),
  ]);
  return {
    leads: leads.rows,
    companies: companies.rows,
    lists: lists.rows,
    team: team.rows,
    activity: activity.rows,
    proposals: proposals.rows,
    sources: sources.rows,
    touchCounts: touchCountsByLead(activity.rows),
    sample: Boolean(leads.sample || companies.sample),
    /* Errors are carried, not swallowed. A page that renders an empty pipeline
     * because one fetch failed looks exactly like a page with no leads. */
    /* EVERY READ'S ERROR, not four of the seven. `proposals`, `team` and
     * `sources` were dropped on the floor, so a failed proposals read showed a
     * rep "Proposals out: 0" with no warning anywhere on the page while five of
     * their proposals sat in the table. A wrong number with nothing to contradict
     * it is the worst shape this can take. Found by an adversarial review,
     * Aug 27 2026. */
    errors: [
      leads.error, companies.error, lists.error, activity.error,
      proposals.error, team.error, sources.error,
    ].filter(Boolean),
    /* WHICH READS FAILED, BY NAME, so a caller can pass `null` and mean it.
     * Every reader in this file turns a failure into `{ rows: [], error }`, which
     * means "nothing came back" and "nothing is there" arrive as the same value —
     * so lib/outreach.js's whole null-is-not-zero contract was unreachable on the
     * live path and a broken read printed confident zeros. This is what makes it
     * reachable. */
    failed: {
      leads: Boolean(leads.error),
      companies: Boolean(companies.error),
      lists: Boolean(lists.error),
      activity: Boolean(activity.error),
      proposals: Boolean(proposals.error),
      team: Boolean(team.error),
      sources: Boolean(sources.error),
    },
    /* Same rule for a cap as for an error: a page that quietly shows half the
     * pipeline is worse than one that says it is showing half. */
    truncated: [leads.truncated, activity.truncated, proposals.truncated].filter(Boolean),
  };
}

/* ============================================================================
 * THE OVERVIEW GENERATOR — saved output
 *
 * You type what you want on the Overview page, /api/console-report reads the
 * whole console and writes it, and every press files a row. Append-only: there
 * is no update path, here or in the database (0010).
 *
 * Owner/admin only, enforced by row-level security as well as by the endpoint.
 * One of these rows can summarise every client, lead and invoice at once.
 * ==========================================================================*/

const PREVIEW_CONSOLE_REPORTS = [];

export async function listConsoleReports(limit = 25) {
  if (!live()) {
    return { rows: [...PREVIEW_CONSOLE_REPORTS].slice(0, limit), sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_console_reports").select("*")
    .order("created_at", { ascending: false }).limit(limit);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function deleteConsoleReport(id) {
  if (!live()) {
    const i = PREVIEW_CONSOLE_REPORTS.findIndex((r) => r.id === id);
    if (i >= 0) PREVIEW_CONSOLE_REPORTS.splice(i, 1);
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_console_reports").delete().eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Preview mode: the counted version, from the same rows the pages show.
 *
 * No AI, and it says so on the row rather than pretending. The point of running
 * it here is that the shape, the saving, the history and the honesty line are
 * all exercised before a single key is set. */
export async function generateConsoleReportPreview({ instruction, preset } = {}) {
  const [clients, tasks, leads, tickets, emails, reminders, notes, weekly, sites, companies] =
    await Promise.all([
      listClients(), listTasks(), listLeads(), listTickets(), listEmailThreads({}),
      listReminders(null), listAiNotes({ statuses: ["open"] }), listWeekly(null).catch(() => ({ rows: [] })),
      listClientSites(null).catch(() => ({ rows: [] })), listCompanies().catch(() => ({ rows: [] })),
    ]);

  /* A snapshot shaped exactly like loadSystemContext's, so the same pure
   * functions run over it. `errors` carries anything that failed, because a
   * preview that hides a broken read teaches the wrong thing. */
  const errors = {};
  const rowsOf = (r, key) => {
    if (r?.error) errors[key] = r.error;
    return r?.rows || [];
  };
  const snap = {
    role: "owner", userId: null, generatedAt: new Date().toISOString(), errors,
    clients: rowsOf(clients, "clients"),
    tasks: rowsOf(tasks, "tasks"),
    weekly: rowsOf(weekly, "weekly"),
    leads: rowsOf(leads, "leads"),
    leadActivity: [], leadSources: [],
    tickets: rowsOf(tickets, "tickets"),
    emails: rowsOf(emails, "emails"),
    reminders: rowsOf(reminders, "reminders"),
    sites: rowsOf(sites, "sites"),
    brain: [], memory: [], notes: rowsOf(notes, "notes"), team: [],
    companies: rowsOf(companies, "companies"),
    leadLists: [], proposals: [], invoices: [], expenses: [],
  };

  const facts = assembleConsoleFacts(snap, { nowMs: Date.now() });
  const todayIso = new Date().toISOString().slice(0, 10);
  const report = deterministicConsoleReport(facts, {
    todayIso,
    why: "this is preview mode — no database key, so no AI call was made",
  });

  const row = {
    id: `preview-${PREVIEW_CONSOLE_REPORTS.length + 1}`,
    instruction: String(instruction || "").slice(0, 1500),
    preset: preset || null,
    mode: "records",
    title: report.title,
    summary: report.summary,
    body: report.body,
    watch: null,
    cannot_check: report.cannotCheck,
    source: "counted",
    rejected_why: "preview mode — nothing was sent to an AI",
    facts: { counts: facts.counts, cannotAnswer: facts.cannotAnswer, unreadable: facts.unreadable, takenAt: facts.takenAt },
    counts_at: facts.takenAt,
    created_by_email: "preview@aisyndicate.com",
    created_at: new Date().toISOString(),
  };
  PREVIEW_CONSOLE_REPORTS.unshift(row);
  return { ok: true, report: row, sample: true, source: "counted" };
}

/* ---- Rating an answer, and what it teaches the next one ------------------
 *
 * Append-only. Rating the same answer twice writes a second row and the newest
 * wins when it is read, so "I hated it, then I re-read it" is a history rather
 * than a correction. The notes are read server-side by /api/console-report and
 * put into the next instruction.
 * ------------------------------------------------------------------------ */

const PREVIEW_CONSOLE_FEEDBACK = [];

export async function listConsoleFeedback(limit = 40) {
  if (!live()) return { rows: [...PREVIEW_CONSOLE_FEEDBACK].slice(0, limit), sample: true };
  const { data, error } = await getSupabase()
    .from("admin_console_feedback").select("*")
    .order("created_at", { ascending: false }).limit(limit);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function saveConsoleFeedback({ reportId, rating, note }) {
  const clean = {
    report_id: reportId,
    rating: Math.min(5, Math.max(1, Math.round(Number(rating) || 0))),
    note: String(note || "").trim().slice(0, 500) || null,
  };
  if (!clean.report_id) return { ok: false, error: "No answer to rate." };
  if (!(clean.rating >= 1 && clean.rating <= 5)) return { ok: false, error: "Pick one to five stars." };

  if (!live()) {
    const row = { id: `pf-${PREVIEW_CONSOLE_FEEDBACK.length + 1}`, ...clean, created_at: new Date().toISOString() };
    PREVIEW_CONSOLE_FEEDBACK.unshift(row);
    return { ok: true, row, sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_console_feedback").insert(clean).select().maybeSingle();
  return error ? { ok: false, error: error.message } : { ok: true, row: data };
}

/* ==================================================================== */
/* APPENDED Aug 24 2026 — the client's own connected accounts.           */
/* Nothing above this line was changed. New sections go BELOW this one.  */
/* ==================================================================== */

/* Search Console, Business Profile, Analytics and Bing — the accounts the
 * CLIENT owns, that we are allowed to read. Two tables (migration 0013):
 *
 *   admin_client_connections   — one row per account+property we can read.
 *   admin_connection_snapshots — the numbers we actually read, with the dates
 *                                they cover and the date we read them.
 *
 * THE SNAPSHOT IS THE POINT. A report quotes a snapshot, never a live call, so
 * the same report always shows the same numbers and can be checked in six
 * months. Nothing here ever rewrites an old snapshot.
 *
 * The scrambled sign-in is not on the connection row at all. It lives in
 * admin_connection_secrets, a separate table no signed-in browser has any
 * permission on — only the server's service-role key reaches it. It is a
 * separate TABLE rather than a column here because taking a permission away
 * from one column does nothing once the whole table has been granted, which
 * is how the first version of this got it wrong.
 */

const CONNECTION_COLUMNS =
  "id, client_id, provider, auth_kind, label, account_email, property, property_label, " +
  /* `scope` is what Google GRANTED — the list of permissions, not the token.
   * The card needs it to spot a sign-in that predates something we now read
   * and offer "Connect again" before the next refresh fails. The token itself
   * is not on this table at all (see the note above). */
  "scope, status, last_synced_at, last_error, meta, notes, active, sort, connected_at, connected_by, " +
  "created_at, updated_at, added_by";

const previewConnections = [
  { id: "cx1", client_id: "c1", provider: "gsc", auth_kind: "google", label: "Google Search Console — lakesiderealty-sample.com", account_email: "dana@sample.com", scope: "openid email https://www.googleapis.com/auth/webmasters.readonly", property: "sc-domain:lakesiderealty-sample.com", property_label: "lakesiderealty-sample.com", status: "connected", last_synced_at: daysAgo(1), last_error: null, meta: {}, notes: null, active: true, sort: 0, connected_at: daysAgo(20), created_at: daysAgo(20), updated_at: daysAgo(1) },
  { id: "cx2", client_id: "c1", provider: "gbp", auth_kind: "google", label: "Google Business Profile — Lakeside Realty (Destin)", account_email: "dana@sample.com", scope: "openid email https://www.googleapis.com/auth/business.manage", property: "locations/1234567890", property_label: "Lakeside Realty — Destin", status: "connected", last_synced_at: daysAgo(1), last_error: null, meta: {}, notes: null, active: true, sort: 1, connected_at: daysAgo(20), created_at: daysAgo(20), updated_at: daysAgo(1) },
  { id: "cx3", client_id: "c1", provider: "ga4", auth_kind: "manual", label: "Google Analytics 4", account_email: null, scope: null, property: null, property_label: null, status: "manual", last_synced_at: null, last_error: null, meta: {}, notes: "Waiting on the client to add us to Analytics.", active: true, sort: 2, connected_at: null, created_at: daysAgo(6), updated_at: daysAgo(6) },
  { id: "cx4", client_id: "c2", provider: "gsc", auth_kind: "google", label: "Google Search Console — harborinjurylaw-sample.com", account_email: "j@sample.com", scope: "openid email https://www.googleapis.com/auth/webmasters.readonly", property: "sc-domain:harborinjurylaw-sample.com", property_label: "harborinjurylaw-sample.com", status: "needs_reconnect", last_synced_at: daysAgo(19), last_error: "The client's Google sign-in was withdrawn or expired. Press Connect again.", meta: {}, notes: null, active: true, sort: 0, connected_at: daysAgo(60), created_at: daysAgo(60), updated_at: daysAgo(19) },
];

/* Sample numbers, deliberately unremarkable. Every one carries the window it
 * covers and the day it was taken, exactly like a real row — a sample that is
 * shaped differently from the real thing teaches the wrong lesson. */
const previewSnapshots = [
  { id: "sn1", connection_id: "cx1", client_id: "c1", provider: "gsc", property: "sc-domain:lakesiderealty-sample.com", period_start: daysAgo(31).slice(0, 10), period_end: daysAgo(3).slice(0, 10), taken_at: daysAgo(1), taken_on: daysAgo(1).slice(0, 10), source: "api", metrics: { clicks: 412, impressions: 18240, ctr: 412 / 18240, position: 14.2 }, detail: { topQueries: [{ query: "destin realtor", clicks: 61, impressions: 1840, position: 8.1 }, { query: "30a homes for sale", clicks: 44, impressions: 2210, position: 11.6 }], topPages: [{ page: "/", clicks: 150, impressions: 5100 }, { page: "/listings", clicks: 96, impressions: 4300 }] }, note: null, created_at: daysAgo(1) },
  { id: "sn2", connection_id: "cx2", client_id: "c1", provider: "gbp", property: "locations/1234567890", period_start: daysAgo(33).slice(0, 10), period_end: daysAgo(5).slice(0, 10), taken_at: daysAgo(1), taken_on: daysAgo(1).slice(0, 10), source: "api", metrics: { businessImpressions: 9120, callClicks: 74, directionRequests: 131, websiteClicks: 288, bookings: 0 }, detail: {}, note: null, created_at: daysAgo(1) },
  { id: "sn3", connection_id: "cx4", client_id: "c2", provider: "gsc", property: "sc-domain:harborinjurylaw-sample.com", period_start: daysAgo(50).slice(0, 10), period_end: daysAgo(22).slice(0, 10), taken_at: daysAgo(19), taken_on: daysAgo(19).slice(0, 10), source: "api", metrics: { clicks: 903, impressions: 40110, ctr: 903 / 40110, position: 9.8 }, detail: { topQueries: [{ query: "injury lawyer near me", clicks: 120, impressions: 5400, position: 6.2 }], topPages: [] }, note: null, created_at: daysAgo(19) },
];

/* ---- CONNECTIONS -------------------------------------------------- */

/** Every connected account for one client. Pass null for every client's. */
export async function listClientConnections(clientId = null) {
  if (!live()) {
    const rows = (clientId ? previewConnections.filter((c) => c.client_id === clientId) : [...previewConnections])
      .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.created_at).localeCompare(String(b.created_at)));
    return { rows, sample: true };
  }
  let q = getSupabase().from("admin_client_connections").select(CONNECTION_COLUMNS)
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(400);
  if (clientId) q = q.eq("client_id", clientId);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function upsertClientConnection(patch) {
  if (!live()) {
    const now = new Date().toISOString();
    if (patch.id) {
      const i = previewConnections.findIndex((c) => c.id === patch.id);
      if (i < 0) return { ok: false, error: "That connection is not on the list any more. Refresh the page." };
      previewConnections[i] = { ...previewConnections[i], ...patch, updated_at: now };
      return { ok: true, row: previewConnections[i], sample: true };
    }
    const row = {
      id: pid("cx"), client_id: null, provider: "other", auth_kind: "manual", label: "",
      account_email: null, scope: null, property: null, property_label: null, status: "manual",
      last_synced_at: null, last_error: null, meta: {}, notes: null, active: true, sort: 0,
      connected_at: null, created_at: now, updated_at: now, ...patch,
    };
    previewConnections.push(row);
    return { ok: true, row, sample: true };
  }
  const supabase = getSupabase();
  const q = patch.id
    ? supabase.from("admin_client_connections").update(patch).eq("id", patch.id).select(CONNECTION_COLUMNS).maybeSingle()
    : supabase.from("admin_client_connections").insert(patch).select(CONNECTION_COLUMNS).maybeSingle();
  const { data, error } = await q;
  if (error) {
    const dup = /duplicate key|unique constraint/i.test(error.message || "");
    return {
      ok: false,
      error: dup
        ? "This client already has a connection reading that exact property. Change the property, or edit the card that already exists."
        : error.message,
    };
  }
  /* A write that changed nothing comes back as { data: null, error: null } —
   * the row is gone, or row-level security filtered it out. Calling that
   * "saved" is how a change quietly disappears. Same rule as the login cards. */
  if (!data) {
    return {
      ok: false,
      error: patch.id
        ? "Nothing was saved — that connection is gone, or your account is not allowed to change it. Refresh the page."
        : "Nothing was saved. Your account may not be allowed to add one.",
    };
  }
  return { ok: true, row: data };
}

/** Owners only in the database (migration 0013), same as the login cards. An
 * admin's delete matches no rows rather than failing, so the rows are counted
 * — a "Removed" message over a card that is still there is worse than a no. */
export async function deleteClientConnection(id) {
  if (!live()) {
    const before = previewConnections.length;
    const i = previewConnections.findIndex((c) => c.id === id);
    if (i >= 0) previewConnections.splice(i, 1);
    if (previewConnections.length === before) return { ok: false, error: "That connection is not on the list any more." };
    return { ok: true, sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_client_connections").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "Nothing was removed. Removing a connection is owners only — switch it off instead, or ask an owner." };
  }
  return { ok: true };
}

/* ---- SNAPSHOTS ---------------------------------------------------- */

/** The numbers read for one client, newest first. */
export async function listConnectionSnapshots(clientId, { provider = null, limit = 60 } = {}) {
  if (!live()) {
    let rows = previewSnapshots.filter((s) => s.client_id === clientId);
    if (provider) rows = rows.filter((s) => s.provider === provider);
    rows = [...rows].sort((a, b) => String(b.taken_at).localeCompare(String(a.taken_at))).slice(0, limit);
    return { rows, sample: true };
  }
  let q = getSupabase().from("admin_connection_snapshots").select("*")
    .eq("client_id", clientId)
    .order("taken_at", { ascending: false })
    .limit(limit);
  if (provider) q = q.eq("provider", provider);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/**
 * Save numbers a person read off a screen and typed in.
 *
 * source is forced to "manual" here AND in the database policy. Only the
 * server may write "api", because only the server actually asked the account.
 * A typed number that could pass itself off as a measured one would break the
 * only rule these tables exist to keep.
 */
export async function addManualSnapshot({ clientId, connectionId = null, provider, property = "", periodStart, periodEnd, metrics = {}, note = null, userId = null }) {
  if (!clientId) return { ok: false, error: "No client." };
  if (!provider) return { ok: false, error: "Pick which account these numbers came from." };
  if (!periodStart || !periodEnd) return { ok: false, error: "Say which dates these numbers cover." };
  if (String(periodStart) > String(periodEnd)) return { ok: false, error: "The first date has to come before the last one." };

  /* Empty boxes are left OUT, not saved as zero. A blank that becomes 0 reads
   * in a report as "nobody called them", which is a claim nobody made. */
  const clean = {};
  for (const [k, v] of Object.entries(metrics)) {
    if (v === "" || v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isFinite(n)) clean[k] = n;
  }
  if (!Object.keys(clean).length) return { ok: false, error: "Type at least one number." };

  const takenAt = new Date().toISOString();
  const row = {
    connection_id: connectionId,
    client_id: clientId,
    provider,
    property: property || "",
    period_start: periodStart,
    period_end: periodEnd,
    taken_at: takenAt,
    taken_on: teamDate(Date.parse(takenAt)),
    taken_by: userId,
    source: "manual",
    metrics: clean,
    detail: note ? { note } : {},
    note: note || null,
  };

  if (!live()) {
    const made = { id: pid("sn"), created_at: takenAt, ...row };
    previewSnapshots.unshift(made);
    return { ok: true, row: made, sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_connection_snapshots").insert(row).select().maybeSingle();
  if (error) {
    const dup = /duplicate key|unique constraint/i.test(error.message || "");
    return {
      ok: false,
      error: dup
        ? "Numbers for that exact window were already saved today. Change the dates, or remove the earlier one first."
        : error.message,
    };
  }
  if (!data) return { ok: false, error: "Nothing was saved. Your account may not be allowed to add numbers." };
  return { ok: true, row: data };
}

/* ============================================================================
 * ONE RECORD, LEAD → PAYING CLIENT → BEYOND  (Aug 25 2026, append-only)
 *
 * Ryder: "have everything connected and context saved to all people in our
 * system from the time there created as a lead all the way to a paying client
 * and beyond."
 *
 * The tables were built for this on Aug 22 and then nothing ever wrote the
 * links. Marking a deal Won put a green pill on a row and stopped. Migration
 * 0015 adds the one function that closes it; this is the browser's side of it.
 *
 * THE RULE HERE: the browser never decides whether a client already exists.
 * It asks the database to do the whole thing in one statement, because "read,
 * then write if missing" is a race two open tabs both win — which is the same
 * reason the one-text rule had to move into the database in 0009.
 * ==========================================================================*/

/**
 * Turn a won lead into a paying client, and attach everybody at that firm.
 *
 * Safe to call twice: the second call returns the same client id and changes
 * nothing. Returns `{ ok, clientId, alreadyLinked }`, or `{ ok:false, error }`
 * with a reason a person can read.
 */
export async function convertLeadToClient(leadId, { actor = null, stage = "Onboarding" } = {}) {
  if (!live()) {
    const lead = previewStore.leads.find((l) => l.id === leadId);
    if (!lead) return { ok: false, error: "No such contact." };
    if (lead.client_id && lead.became_customer) {
      return { ok: true, clientId: lead.client_id, created: false, alreadyLinked: true, siblings: 0, sample: true };
    }

    const company = previewStore.companies?.find((c) => c.id === lead.company_id) || null;
    let clientId = lead.client_id || company?.client_id || null;
    let created = false;
    const name = (company?.name || lead.company || lead.name || "").trim();
    /* The same name match the SQL does, so preview and live cannot behave
     * differently. A contact added by hand has no firm row, so without this a
     * second person at the same firm would make a SECOND client here while the
     * database reused the first. Preview drifting from live is how a bug gets
     * demonstrated as working. */
    const nameKey = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const bare = (v) => String(v || "").toLowerCase().replace(/^https?:\/\/(www\.)?|\/$/g, "");
    if (!clientId && name) {
      const want = bare(company?.domain || lead.domain || "");
      /* Same rule as the SQL: a blank website on either side does not block the
       * match; two DIFFERENT websites do. */
      const hit = previewStore.clients.find((c) => nameKey(c.name) === nameKey(name)
        && (!c.domain || !want || bare(c.domain) === want));
      if (hit) clientId = hit.id;
    }
    if (!clientId) {
      if (!name) return { ok: false, error: "This contact has no firm name and no person name, so there is nothing to call the client." };
      created = true;
      clientId = pid("c");
      previewStore.clients.unshift({
        id: clientId, name,
        domain: company?.domain || lead.domain || null,
        vertical: company?.vertical || lead.vertical || null,
        stage: stage || "Onboarding", status: "active",
        start_date: new Date().toISOString().slice(0, 10),
        contact_name: lead.name || null, contact_email: lead.email || null,
        contact_phone: lead.phone || company?.phone || null,
        company_id: company?.id || null, origin: "sales",
        notes: "Came up through the sales pipeline.",
        links: {}, created_at: new Date().toISOString(),
      });
    }
    let siblings = 0;
    if (company) {
      company.client_id = clientId;
      for (const l of previewStore.leads) {
        if (l.company_id === company.id && l.id !== leadId && !l.client_id) { l.client_id = clientId; siblings += 1; }
      }
    }
    Object.assign(lead, {
      client_id: clientId, became_customer: true,
      became_customer_at: new Date().toISOString(), became_customer_by: actor,
      stage: "won", closed_at: lead.closed_at || new Date().toISOString(),
    });
    return { ok: true, clientId, created, alreadyLinked: false, siblings, sample: true };
  }

  const { data, error } = await getSupabase().rpc("admin_lead_to_client", {
    p_lead: leadId, p_actor: actor, p_stage: stage,
  });
  if (error) {
    /* The function raises in plain words for the two cases a person can act on.
     * Passing the raw Postgres text through unchanged is worse than useless —
     * "P0001" tells nobody what to do. */
    const msg = String(error.message || "");
    if (msg.includes("nothing to call the client")) {
      return { ok: false, error: "This contact has no firm name and no person name, so there is nothing to call the client. Add the company on the Details tab first." };
    }
    if (msg.includes("not authorized")) {
      return { ok: false, error: "Your account is not allowed to do that." };
    }
    if (msg.includes("admin_lead_to_client") || msg.includes("does not exist") || error.code === "42883") {
      return { ok: false, error: "Migration 0015 has not been run on the database yet, so nothing can be linked. Nothing was changed." };
    }
    return { ok: false, error: msg };
  }
  if (!data || !data.client_id) return { ok: false, error: "Nothing came back. No client was created." };
  /* The three states are kept apart all the way to the screen. Returning only
   * an id made the page say "they are now a client" every single time,
   * including the times when nothing at all had been created. */
  return {
    ok: true,
    clientId: data.client_id,
    created: data.created === true,
    alreadyLinked: data.already_customer === true,
    siblings: Number(data.siblings || 0),
  };
}

/**
 * Every person we hold for one client — whoever closed the deal AND everybody
 * else at that firm. This is what makes a client page able to show the chase
 * that happened before the money started.
 *
 * Read through the database function so the "which firm belongs to this
 * client" join lives in exactly one place. Falls back to a plain read on the
 * columns if 0015 has not been run, and SAYS SO rather than returning an empty
 * list — an empty list reads identically to "this client never was a lead".
 */
export async function listClientContacts(clientId) {
  if (!live()) {
    const company = previewStore.companies?.find((c) => c.client_id === clientId) || null;
    const rows = previewStore.leads.filter(
      (l) => l.client_id === clientId || (company && l.company_id === company.id),
    );
    return { rows, sample: true };
  }
  const { data, error } = await getSupabase().rpc("admin_client_contacts", { p_client: clientId });
  if (!error) return { rows: data || [], sample: false };

  const fallback = await getSupabase().from("admin_leads").select("*").eq("client_id", clientId);
  if (fallback.error) {
    return {
      rows: [], sample: false,
      error: "The sales history could not be read, so nothing below counts it. Migration 0015 may not have been run.",
    };
  }
  return {
    rows: fallback.data || [], sample: false,
    partial: "Read without the firm join, so contacts at this firm who were never linked to the client may be missing. Migration 0015 may not have been run.",
  };
}

/**
 * MARK A DEAL WON — the ONE path, wherever the button lives.
 *
 * There are four places a person can close a deal: the Sales sheet's status
 * cell, the profile drawer's status dropdown, the drawer's big green "They
 * signed" button, and setting a proposal to won. Before this, ONE of them
 * created a client and the other three quietly did not — and because the
 * converting one skipped anything already at stage `won`, using any of the
 * other three first made the working path a no-op for that lead forever. A
 * deal closed on the green button could never become a client through the
 * screen at all. Found by a reviewer, not by a test.
 *
 * So all four call this. The rules it holds:
 *
 * 1. THE STAGE MOVE IS SAVED FIRST AND SEPARATELY. If the link then fails, the
 *    close is still recorded and the message says exactly which half did not
 *    happen — rather than a half-done thing nobody can see.
 * 2. THE GUARD IS `became_customer`, NOT `client_id`. Every contact at a firm
 *    gets `client_id` the moment ONE of them closes — that is the whole point —
 *    so a client_id guard means a firm can record exactly one sale, ever, and
 *    the rep who closes the second one watches the button do nothing. Being
 *    attached to a client and having closed a deal are two different facts.
 *    (Migration 0015 has the same rule, for the same reason, in SQL.)
 * 3. IT NEVER SAYS MORE THAN IT DID. The result carries `created`,
 *    `alreadyLinked` and `siblings` so the message on screen can be true.
 */
export async function markLeadWon(lead, { actor, stage = "Onboarding", extraPatch = {} } = {}) {
  const wasWon = lead.stage === "won";
  if (!wasWon) {
    const res = await upsertLead({ id: lead.id, stage: "won", closed_at: lead.closed_at || new Date().toISOString(), ...extraPatch });
    if (!res.ok) return { ok: false, error: res.error, stageMoved: false };
    await addLeadActivity({
      leadId: lead.id, actor, type: "status_change",
      body: `${LEAD_STAGE_LABELS[lead.stage] || lead.stage} → Won`,
    });
  } else if (Object.keys(extraPatch).length) {
    const res = await upsertLead({ id: lead.id, ...extraPatch });
    if (!res.ok) return { ok: false, error: res.error, stageMoved: false };
  }

  /* BOTH, exactly as migration 0015 checks both. `became_customer` alone was
   * wrong and a reviewer proved it: a lead can carry the flag with no client
   * behind it — the assistant's set-stage tool used to write it directly, and
   * `client_id` is `on delete set null`, so deleting a client leaves every
   * contact at that firm flagged and unlinked. Guarding on the flag alone made
   * every one of those permanently unconvertible, and told the person "already
   * a client" about a client that does not exist. When they disagree, let the
   * database decide — it is the thing that can actually look. */
  if (lead.became_customer && lead.client_id) {
    return { ok: true, stageMoved: !wasWon, conversion: { ok: true, clientId: lead.client_id, created: false, alreadyLinked: true, siblings: 0 } };
  }
  const conversion = await convertLeadToClient(lead.id, { actor, stage });
  return { ok: true, stageMoved: !wasWon, conversion };
}

/** The one sentence to show after markLeadWon, true in every case it can end
 *  in. Kept next to the function so the words and the states cannot drift. */
export function wonMessage(result) {
  const c = result?.conversion;
  if (!c?.ok) {
    return {
      tone: "error",
      title: result?.stageMoved ? "Marked Won, but not linked to a client" : "Not linked to a client",
      body: c?.error || "The client link did not happen. Nothing else was changed.",
    };
  }
  if (c.alreadyLinked) {
    /* Only ever said when there is a real client id behind it. Saying "already
     * a client" with `clientId: null` was describing a state that cannot be
     * true, and it was reachable. */
    if (!c.clientId) {
      return {
        tone: "error", title: "Marked Won, but no client record was found",
        body: "This contact is flagged as a customer but is not linked to any client record. Nothing was created. Tell whoever looks after the console.",
      };
    }
    return { tone: "info", title: "Already a client", body: "This deal was already recorded as closed, so nothing new was created." };
  }
  if (c.created) {
    return {
      tone: "success", title: "Won — and a client record was created",
      body: c.siblings > 0
        ? `The other ${c.siblings} contact${c.siblings === 1 ? "" : "s"} we hold at this firm now point at the same client, so every call and note stays on the record.`
        : "Every call, email and note logged during the chase stays on the record.",
    };
  }
  return {
    tone: "success", title: "Won — linked to their existing client record",
    body: c.siblings > 0
      ? `No new client was created; this firm already had one. The other ${c.siblings} contact${c.siblings === 1 ? "" : "s"} here now point at it too.`
      : "No new client was created — this firm already had one.",
  };
}

/* ============================================================================
 * IMPORT BATCHES, AND STARTING OVER  (Aug 25 2026, append-only)
 *
 * Ryder: "i cant have the real google sheet messed up at all, then when we
 * actually start using the admin then i want to delete all that data and import
 * the list fresh again so that everything is up to date."
 *
 * The first half was already true: the importer reads a DOWNLOADED copy and
 * there is no code path from this console to Google Sheets at all. Nothing can
 * write back to the spreadsheet because nothing knows how.
 *
 * The second half needed this. Every press of Import files a batch row, and a
 * batch can be undone — or everything imported can be cleared at once, which is
 * the thing to press on go-live day.
 *
 * THE RULE: the browser NEVER works out what to delete. It asks the database
 * for a dry run, shows exactly that, and then asks the same function to do it.
 * One statement decides both times, so the number on the screen and the number
 * that goes cannot come apart — which is precisely how the importer once
 * printed "412 rows dropped" and imported all 412.
 * ==========================================================================*/

const PREVIEW_BATCHES = [];

export async function listImportBatches(limit = 40) {
  if (!live()) return { rows: [...PREVIEW_BATCHES].slice(0, limit), sample: true };
  const { data, error } = await getSupabase()
    .from("admin_import_batches").select("*").order("created_at", { ascending: false }).limit(limit);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/** Opened at the START of an import, so a run that dies half way still leaves a
 *  row naming what it was — and those rows are still clearable. An import with
 *  no batch behind it is one nobody can undo. */
export async function startImportBatch({ label, sourceFile, tabs, counts, userId }) {
  const row = {
    label: String(label || "").trim() || "Outreach sheet",
    source_file: sourceFile || null,
    tabs: tabs || [],
    counts: counts || {},
    created_by: userId || null,
  };
  if (!live()) {
    const made = { id: pid("ib"), ...row, created_at: new Date().toISOString(), cleared_at: null };
    PREVIEW_BATCHES.unshift(made);
    return { ok: true, id: made.id, sample: true };
  }
  const { data, error } = await getSupabase().from("admin_import_batches").insert(row).select("id").maybeSingle();
  /* A missing table means migration 0016 has not been run. The import still
   * goes ahead without a batch — refusing to import because the undo is not
   * installed would be the safety feature breaking the thing it protects — and
   * the screen says the run will not be undoable. */
  if (error) return { ok: false, error: error.message, id: null };
  return { ok: true, id: data?.id || null };
}

export async function finishImportBatch(batchId, counts) {
  if (!batchId) return { ok: true };
  if (!live()) {
    const b = PREVIEW_BATCHES.find((x) => x.id === batchId);
    if (b) b.counts = counts;
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase().from("admin_import_batches").update({ counts }).eq("id", batchId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Ask what a clear-out WOULD do (`dryRun: true`), or do it.
 *
 * Scope is exactly one of `batchId`, `listId`, or `allImported`. The database
 * raises if that is not true — a delete that guesses its own scope is the worst
 * kind there is.
 *
 * Returns `{ ok, leads, companies, lists, kept, keptTotal, considered }`.
 * `kept` is a reason → count map, in plain words, and it is shown rather than
 * summed away: "we refused to touch 12 of them" and "nothing happened" look
 * identical otherwise.
 */
export async function clearImport({ batchId = null, listId = null, allImported = false, dryRun = true, expectLeads = null, role = null } = {}) {
  /* THE SAME REFUSALS THE SQL MAKES, MADE HERE TOO, BEFORE ANYTHING ELSE.
   *
   * Preview mode had none of them: `clearImport({ dryRun: false })` with no
   * arguments fell through both branches and deleted every imported lead in the
   * store, and a sales rep could run it because the only thing stopping them
   * was a hidden button. A preview that behaves differently from live is how a
   * bug gets demonstrated as working. Found by a reviewer. */
  const scopes = (batchId ? 1 : 0) + (listId ? 1 : 0) + (allImported ? 1 : 0);
  if (scopes === 0) return { ok: false, error: "Nothing to clear: name an import, a list, or ask for everything imported." };
  if (scopes > 1) return { ok: false, error: "Clear one thing at a time: an import, a list, or everything imported." };
  if (role && role !== "owner" && role !== "admin") {
    return { ok: false, error: "Only an owner or an admin can clear an import." };
  }

  if (!live()) {
    /* Preview mode mirrors the SQL's rules exactly, or a person testing the
     * button here would be shown behaviour the real thing does not have. */
    const inScope = previewStore.leads.filter((l) => {
      if (batchId) return l.import_batch_id === batchId;
      if (listId) return l.list_id === listId;
      return ["sheet", "csv", "import", "scraper"].includes(l.source);
    });
    const reason = (l) => {
      if (l.client_id || l.became_customer) return "they are a paying client";
      if (!["sheet", "csv", "import", "scraper"].includes(l.source)) return "added by hand, not imported";
      if ((previewStore.proposals || []).some((p) => p.lead_id === l.id && p.status !== "draft")) return "a proposal has gone out";
      /* Anything the import did not write itself — same rule as the SQL. The
       * five-type list this replaced missed `claim` and `status_change`, which
       * is most of what a rep actually does. */
      if (previewStore.leadActivity.some((a) => a.lead_id === l.id && a.type !== "import")) {
        return "somebody has worked them in here";
      }
      return null;
    };
    const kept = {};
    const go = [];
    for (const l of inScope) {
      const why = reason(l);
      if (why) kept[why] = (kept[why] || 0) + 1;
      else go.push(l);
    }
    const goIds = new Set(go.map((l) => l.id));
    const companies = (previewStore.companies || []).filter((c) => !c.client_id
      && c.import_batch_id
      && go.some((l) => l.company_id === c.id)
      && !previewStore.leads.some((l) => l.company_id === c.id && !goIds.has(l.id)));
    const lists = (previewStore.leadLists || []).filter((li) => go.some((l) => l.list_id === li.id)
      && !previewStore.leads.some((l) => l.list_id === li.id && !goIds.has(l.id)));

    const out = {
      ok: true, dryRun, sample: true,
      leads: go.length, companies: companies.length, lists: lists.length,
      companiesKept: (previewStore.companies || []).filter((c) => !c.client_id
        && !c.import_batch_id
        && go.some((l) => l.company_id === c.id)
        && !previewStore.leads.some((l) => l.company_id === c.id && !goIds.has(l.id))).length,
      kept, keptTotal: Object.values(kept).reduce((a, b) => a + b, 0),
      considered: inScope.length,
    };
    if (dryRun) return out;

    /* The same handshake the database makes. Nothing can change underneath a
     * single-threaded browser store, so this can only ever pass here — it
     * exists so the two paths have the same shape and the UI is exercising the
     * real contract in sample mode. */
    if (expectLeads !== null && expectLeads !== go.length) {
      return { ok: false, error: `This changed while you were looking at it: you were shown ${expectLeads} and there are now ${go.length}. Nothing was deleted — look again.` };
    }

    previewStore.leads = previewStore.leads.filter((l) => !goIds.has(l.id));
    previewStore.leadActivity = previewStore.leadActivity.filter((a) => !goIds.has(a.lead_id));
    if (previewStore.proposals) previewStore.proposals = previewStore.proposals.filter((p) => !goIds.has(p.lead_id));
    const coIds = new Set(companies.map((c) => c.id));
    if (previewStore.companies) previewStore.companies = previewStore.companies.filter((c) => !coIds.has(c.id));
    const liIds = new Set(lists.map((l) => l.id));
    if (previewStore.leadLists) previewStore.leadLists = previewStore.leadLists.filter((l) => !liIds.has(l.id));
    for (const b of PREVIEW_BATCHES) {
      if ((batchId && b.id === batchId) || (allImported && !b.cleared_at)) {
        b.cleared_at = new Date().toISOString();
        b.cleared_counts = out;
      }
    }
    /* On the record here too. The SQL writes this row under the banner "a bulk
     * delete with no trace is how a team stops trusting a tool" — and preview
     * mode, the only path the browser walkthrough exercises, was writing
     * nothing. The property being demonstrated was absent from the
     * demonstration. */
    previewStore.activity.unshift({
      id: pid("g"), actor: "preview-user", kind: "import_cleared",
      title: `Cleared ${out.leads} imported contact${out.leads === 1 ? "" : "s"}`,
      body: `${out.companies} firm${out.companies === 1 ? "" : "s"} and ${out.lists} list${out.lists === 1 ? "" : "s"} went with them. Kept ${out.keptTotal} that were not test data.`,
      created_at: new Date().toISOString(),
    });
    return out;
  }

  const { data, error } = await getSupabase().rpc("admin_clear_import", {
    p_batch: batchId, p_list: listId, p_all_imported: allImported, p_dry_run: dryRun,
    p_expect_leads: expectLeads,
  });
  if (error) {
    const msg = String(error.message || "");
    if (msg.includes("only an owner or admin")) {
      return { ok: false, error: "Only an owner or an admin can clear an import." };
    }
    if (msg.includes("nothing to clear") || msg.includes("one thing at a time")) {
      return { ok: false, error: msg };
    }
    if (msg.includes("changed while you were looking at it")) {
      return { ok: false, error: msg, stale: true };
    }
    /* Only the error code that actually means "no such function". Matching the
     * words "does not exist" caught a missing COLUMN and any unrelated missing
     * relation too, and told the person to run a migration that was already
     * run — sending them to fix the wrong thing. */
    if (error.code === "42883") {
      return { ok: false, error: "Migration 0016 has not been run on the database yet, so nothing can be cleared. Nothing was changed." };
    }
    return { ok: false, error: msg };
  }
  if (!data) return { ok: false, error: "Nothing came back. Nothing was deleted." };
  return {
    ok: true,
    dryRun: data.dry_run === true,
    leads: Number(data.leads || 0),
    companies: Number(data.companies || 0),
    lists: Number(data.lists || 0),
    kept: data.kept || {},
    keptTotal: Number(data.kept_total || 0),
    considered: Number(data.considered || 0),
    /* Firms left standing with nobody at them, because a person built them
     * rather than an import. Counted so the screen can say so. */
    companiesKept: Number(data.companies_kept || 0),
  };
}


/* ============================================================================
 * THE REP'S WORK PAGE
 *
 * Aug 26 2026, for CJ giving the sales reps their own logins. Scoped to one
 * person, and refusing to run without a user id.
 *
 * WHY THE USER ID IS A HARD REQUIREMENT HERE. A falsy id does not quietly
 * return nothing — it returns EVERYBODY'S. getMyWork's `mine()` filter passes
 * every row in the system, and listReminders(undefined) hands back the whole
 * table. On a rep's page that prints another rep's work as theirs.
 *
 * THE COMMENT USED TO SAY "both readers below refuse" AND NOTHING DID. Found by
 * a checker, Aug 26 2026: there is one reader below, not two, and it did not
 * refuse — it called listReminders(undefined) and leaned on a downstream
 * `userId &&` in repSnapshotFromRows to stop the rows being counted. Everybody's
 * reminders were read into the browser and one guard, three files away, was all
 * that stood between them and the answer box.
 *
 * The code was made true rather than the comment, because "a guard somewhere
 * downstream" is the shape of every leak this section exists to prevent, and a
 * refusal at the door is the only version a reader can check. askRepReport now
 * returns an error before it reads anything. getMyWork's own fail-open is called
 * out where it lives and at its call sites (AdminDashboard.jsx) — it is not this
 * section's to change today, and no new call site may pass it a falsy id.
 * ==========================================================================*/

/** How far back the rep's answer box reads lead activity. 21 days, because that
 * is the window lib/brain-context.js caps the server-side read at and
 * assembleRepFacts saves as `activityWindowDays` — a preview that read further
 * back would count touches the live answer cannot see. */
export const REP_ACTIVITY_WINDOW_DAYS = 21;

/**
 * Ask for a written rundown of your own sales work.
 *
 * LIVE: POST /api/rep-report, which reads the records server-side, asks the
 * model, throws away a draft that fails the gate, and saves the row.
 * PREVIEW: the same counted answer the endpoint falls back to, built by the same
 * functions in lib/rep-report.js from the sample rows. No model, nothing saved,
 * and it says both out loud — `counted_only: true`, `saved: false`, `sample:
 * true`.
 *
 * Both branches hand back the endpoint's exact response shape, so the panel has
 * one code path. Using the real helpers rather than faking prose is the point:
 * what Ryder clicks today is what a rep gets tomorrow, minus the writing.
 */
export async function askRepReport({ instruction, userId } = {}) {
  /* Refused before anything is read or sent. An empty box is a mis-click, and
   * the wording matches the endpoint's 400 so the two cannot disagree. */
  const gate = checkInstruction(instruction);
  if (!gate.ok) return { ok: false, error: gate.error };

  /* And refused without a user id, in BOTH branches — see the note above this
   * section. Not just the preview: the live endpoint scopes itself from the
   * session, so a missing id there means the page has lost track of who is
   * asking, and an answer about "your work" from a page that does not know
   * whose work it is has nothing to be right about. */
  if (!userId) {
    return {
      ok: false,
      error: "Nobody is signed in as far as this page can tell, so nothing was read. This answer is about one person's own work and would otherwise count everybody's. Sign in again and ask once more.",
    };
  }

  if (live()) {
    const res = await apiFetch("/api/rep-report", { method: "POST", body: { instruction: gate.instruction } });
    if (!res.ok) return { ok: false, error: res.error };
    if (!res.data?.report) return { ok: false, error: "Nothing came back. Try again." };
    return { ok: true, report: res.data.report, sample: false };
  }

  const nowMs = Date.now();
  const since = new Date(nowMs - REP_ACTIVITY_WINDOW_DAYS * 86400000).toISOString();
  const [leads, activity, reminders, companies, lists, proposals, sources, team] = await Promise.all([
    listLeads(),
    listAllLeadActivity(REP_ACTIVITY_WINDOW_DAYS),
    /* The person asking, and nobody else. The reader filters and
     * repSnapshotFromRows filters again — see the note in that function. */
    listReminders(userId),
    listCompanies(),
    listLeadLists(),
    listProposals(),
    listLeadSources(),
    listTeam(),
  ]);

  /* Anything that failed is NAMED, not swallowed. assembleRepFacts turns these
   * keys into the "these reads failed and are UNKNOWN, not empty" line, and a
   * preview that hides a broken read teaches the wrong thing about the console. */
  const errors = {};
  const rowsOf = (r, key) => {
    if (r?.error) errors[key] = r.error;
    return r?.rows || [];
  };

  const snap = repSnapshotFromRows({
    userId,
    nowMs,
    errors,
    leads: rowsOf(leads, "leads"),
    /* Trimmed to the window by hand. listAllLeadActivity's preview branch hands
     * back every sample row whatever `sinceDays` says, and a preview branch that
     * is looser than the query underneath it is the trap that leaked the owner's
     * notes to a rep yesterday. */
    activity: rowsOf(activity, "leadActivity").filter((a) => String(a.created_at || "") >= since),
    reminders: rowsOf(reminders, "reminders"),
    companies: rowsOf(companies, "companies"),
    lists: rowsOf(lists, "leadLists"),
    proposals: rowsOf(proposals, "proposals"),
    sources: rowsOf(sources, "leadSources"),
    team: rowsOf(team, "team"),
  });

  return buildRepPreviewAnswer({ instruction: gate.instruction, snap, nowMs });
}


/* ============================================================================
 * TAGS, CLOSE REASONS, SCAN REPORTS AND A REP'S OWN AI RULES
 *
 * Aug 27 2026, for THE FLOOR — the rep console rebuilt as four pages. Appended
 * rather than woven in, the same way every section above this one was, so the
 * file reads as a history of what was added when.
 *
 * ONE ACTION, ONE FUNCTION, AND THE FUNCTION WRITES THE TIMELINE.
 *
 * Every write below does the whole act in one call: the row, the dated line on
 * the person's timeline, and the tag event where there is one. A button never
 * writes. That is not tidiness — it is the fix for a defect that shipped: FOUR
 * buttons could mark a deal Won and they had four behaviours, and because one of
 * them skipped anything already at stage `won`, pressing any of the other three
 * first made the only working one a no-op for that lead FOREVER.
 *
 * A WRITE ASSERTS WHAT THE SCREEN SAID.
 *
 * claimLead already carries `.is("owner_id", null)` under `expectUnclaimed`.
 * Everything new here follows it: two reps clicking at the same moment is a
 * thing that has already happened in this console, and disabling the button is
 * the polite half of the fix — the predicate in the query is the half that
 * works.
 * ==========================================================================*/

/* The imports these functions need are at the TOP of this file with every other
 * one, not here. ES modules hoist an import wherever it is written, so a block
 * of them halfway down a 3,500-line file reads as a second, later set of
 * dependencies and is not one. */

/* Re-exported so a page asks this file for everything and never has to reach
 * past it into two libraries to draw one row. Same reason lib/rep-report.js
 * re-exports tokensForWords. */
export {
  TAG, TAG_SLUGS, reasonLabel, checkCloseReason, checkPersonalRule,
  tagIndex, eventsByLead, currentTags, currentSlugs, tagHistory, autoTagPlan,
  newestReportByCompany, readCompanyReport,
};
export { LOST_REASONS, WON_REASONS, MIN_REASON_NOTE_CHARS } from "../../lib/sales-rules.js";

/* ---- reading -------------------------------------------------------- */

/** The tag vocabulary. Every member may read it; only an admin may write it
 *  (0018), because naming a new tag is a decision about the whole company's
 *  filter menu — "medspa", "med-spa" and "MedSpa" as three tags is a menu
 *  nobody can use. */
export async function listLeadTags() {
  if (!live()) return { rows: [...previewStore.leadTags], sample: true };
  const { data, error } = await getSupabase()
    .from("admin_lead_tags").select("*").order("sort", { ascending: true, nullsFirst: false }).limit(300);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/**
 * WHICH TAGS ARE ON EVERY LEAD RIGHT NOW — read from the view, not by replaying
 * the whole log in the browser.
 *
 * `admin_lead_tags_now` (0018) is the newest event per lead per tag, computed in
 * one line of SQL. It is not a stored copy — a view holds nothing — so there is
 * still exactly one record and nothing to fall out of step.
 *
 * WHY NOT JUST READ THE EVENTS. The Floor loads two thousand leads and a lead
 * accumulates events for life, so the log is the wrong shape for a board read —
 * and it cannot be windowed. An `added` from three months ago that falls outside
 * a window makes a tag that IS on a lead look like a tag that is off, and a
 * filter built on quietly wrong tags looks like it worked.
 *
 * REMOVALS COME BACK TOO. The rows are "the newest event", not "the tags that
 * are on": currentTags() filters for `added`, and the automatic rules read the
 * removals to see what a person took off by hand so they never put it back.
 */
export const TAG_STATE_FETCH_CAP = 12000;

export async function listLeadTagState() {
  if (!live()) return { rows: [...previewStore.leadTagEvents], sample: true };
  /* ORDERED AT ALL, WHICH IS THE POINT — the direction is the lesser half.
   *
   * Without an `order` the rows that come back when the cap bites are whatever
   * Postgres felt like returning, so a lead's chips could appear on one reload and
   * vanish on the next with nothing changed. Newest first at least makes the
   * answer stable and repeatable.
   *
   * WHAT IT IS NOT: "the leads somebody touched lately keep their tags". An
   * earlier version of this comment said that and it is wrong twice over. The view
   * is ONE ROW PER LEAD-TAG PAIR, not per lead, and `at` is when the TAG changed —
   * which an automatic rule writes, not a person. So the cap keeps the most
   * recently CHANGED pairs, and a lead can keep a newer `removed` row (no chip)
   * while losing an older `added` row (a chip). Corrected by the third review. */
  const { data, error } = await getSupabase()
    .from("admin_lead_tags_now").select("*")
    .order("at", { ascending: false })
    .limit(TAG_STATE_FETCH_CAP + 1);
  if (error) return { rows: [], error: error.message, sample: false };
  const rows = data || [];
  if (rows.length > TAG_STATE_FETCH_CAP) {
    /* SAID OUT LOUD, AND SAID CORRECTLY ON THE SECOND ATTEMPT.
     *
     * The cap is on LEAD-TAG PAIRS, not on leads, so a lead past it does not lose
     * all of its tags — it loses the pairs that changed longest ago. It therefore
     * shows FEWER chips than it carries, which is the original wording, and my
     * "NO tags at all" rewrite was wrong. Either way the tag FILTERS quietly leave
     * those rows out, which is the part that matters and is now said explicitly.
     * Corrected by the third review, Aug 27 2026. */
    return {
      rows: rows.slice(0, TAG_STATE_FETCH_CAP),
      sample: false,
      truncated: `Only ${TAG_STATE_FETCH_CAP} tag records were loaded, so a contact past that shows fewer tags than it carries — and the tag filters leave it out of their counts. Filter to a list to bring it back into range.`,
    };
  }
  return { rows, sample: false };
}

/** THE WHOLE dated history for ONE lead — every add and every remove, for the
 *  drawer's tag panel. Unwindowed and uncapped-by-date on purpose: this is the
 *  record, and a record that stops three months back is not one. */
export async function listLeadTagEvents(leadId) {
  if (!live()) {
    return {
      rows: previewStore.leadTagEvents
        .filter((e) => e.lead_id === leadId)
        .sort((a, b) => String(b.at).localeCompare(String(a.at))),
      sample: true,
    };
  }
  const { data, error } = await getSupabase()
    .from("admin_lead_tag_events").select("*").eq("lead_id", leadId)
    .order("at", { ascending: false }).limit(500);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/** Every scan on file, newest first. Capped, and the cap is carried — a firm
 *  whose scans fell off the end would read as never scanned. */
export const COMPANY_REPORT_FETCH_CAP = 2000;

export async function listCompanyReports(companyId = null) {
  if (!live()) {
    const rows = companyId
      ? previewStore.companyReports.filter((r) => r.company_id === companyId)
      : [...previewStore.companyReports];
    return { rows: rows.sort((a, b) => String(b.measured_at).localeCompare(String(a.measured_at))), sample: true };
  }
  let q = getSupabase().from("admin_company_reports").select("*")
    .order("measured_at", { ascending: false });
  if (companyId) q = q.eq("company_id", companyId).limit(60);
  else q = q.limit(COMPANY_REPORT_FETCH_CAP + 1);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message, sample: false };
  const rows = data || [];
  if (!companyId && rows.length > COMPANY_REPORT_FETCH_CAP) {
    return {
      rows: rows.slice(0, COMPANY_REPORT_FETCH_CAP),
      sample: false,
      truncated: `Only the ${COMPANY_REPORT_FETCH_CAP} newest scans were loaded, so an older firm's scan may not show on the rows below.`,
    };
  }
  return { rows, sample: false };
}

/* ---- writing a tag -------------------------------------------------- */

/**
 * PUT A TAG ON A LEAD, OR TAKE ONE OFF. The one function.
 *
 * It writes the event AND the line on the person's timeline in the same call, so
 * a tag change with no dated line next to it cannot happen. Four callers use it
 * — the row's tag menu, the drawer, the automatic sweep and the import — and
 * none of them writes anything itself.
 *
 * `action` is 'added' or 'removed'. A removal is a NEW ROW, never the deletion
 * of the row that added it: "quiet was added on the 24th and taken off on the
 * 25th because she replied" is the thing a rep needs to read a month later, and
 * deleting the first row would make it unreadable.
 *
 * `source` is 'auto', 'person' or 'import'. It is what makes the next automatic
 * sweep leave a tag alone: a 'person' removal is a decision, and the rules read
 * it rather than fighting it.
 *
 * IT REFUSES RATHER THAN GUESSING. No tag id, no lead id, or an action that is
 * not one of the two, and nothing is written — a tag event pointing at the wrong
 * tag is a record nobody can correct, because there is no update path.
 */
export async function setLeadTag({
  leadId, tagId, label = null, action = "added", actor = null, source = "person", why = null,
} = {}) {
  if (!leadId) return { ok: false, error: "No contact to tag." };
  if (!tagId) return { ok: false, error: "That tag is not in the list, so nothing was written." };
  if (!["added", "removed"].includes(action)) {
    return { ok: false, error: `"${action}" is not something that can happen to a tag.` };
  }
  if (!["auto", "person", "import"].includes(source)) {
    return { ok: false, error: `"${source}" is not a way a tag gets set.` };
  }
  /* An automatic change is filed as the system, never as the person who happened
   * to have the page open. Pretending a rule was a person is worse than saying
   * nobody, and it is the difference between "you removed this" and "the rule
   * stopped applying" on the history panel. */
  const by = source === "auto" || source === "import" ? null : (actor || null);
  const now = new Date().toISOString();
  const words = label || "a tag";

  if (!live()) {
    const row = {
      id: pid("te"), lead_id: leadId, tag_id: tagId, action, at: now, by, source, why: why || null,
    };
    previewStore.leadTagEvents.unshift(row);
    await addLeadActivity({
      leadId, actor: by || actor || null, type: "tag",
      body: `${words} ${action === "added" ? "added" : "removed"}${why ? ` — ${why}` : ""}.`,
    });
    return { ok: true, row, sample: true };
  }

  const supabase = getSupabase();
  const { data, error } = await supabase.from("admin_lead_tag_events")
    .insert({ lead_id: leadId, tag_id: tagId, action, by, source, why: why || null })
    .select().maybeSingle();
  if (error) return { ok: false, error: error.message };

  /* THE TIMELINE LINE IS BEST-EFFORT AND ITS FAILURE IS REPORTED.
   *
   * The event is the record and it is already written; refusing the whole act
   * because the timeline line failed would mean a rep pressing the button again
   * and writing a second event. So the tag stands, and the caller is told which
   * half did not happen — the same shape markLeadWon uses for the client link. */
  const line = await addLeadActivity({
    leadId, actor, type: "tag",
    body: `${words} ${action === "added" ? "added" : "removed"}${why ? ` — ${why}` : ""}.`,
  });
  return {
    ok: true,
    row: data,
    timelineFailed: line.ok ? null : (line.error || "the timeline line did not save"),
  };
}

/**
 * Bring one lead's automatic tags up to date.
 *
 * Works out the whole plan first (lib/lead-tags.js autoTagPlan) and then writes
 * it through setLeadTag, so every add and every remove gets its own dated line
 * with the reason on it. Nothing here decides anything — the rules are in
 * lib/sales-rules.js and they take `now` as an argument.
 *
 * A TAG A PERSON REMOVED BY HAND IS NEVER PUT BACK, and that is not a flag
 * anybody has to remember to set: autoTagPlan reads the newest event for the
 * tag, and a removal by a person is the answer.
 *
 * Returns what it actually did, including anything it could not do. `unknown` is
 * a slug the vocabulary does not hold — skipped rather than guessed at, because
 * writing an event needs a real tag id and inventing one points at the wrong
 * tag at best.
 */
export async function syncAutoTags(lead, {
  company = null, touchCount = 0, now = new Date().toISOString(),
  events = [], tagsBySlug = new Map(), tagsById = new Map(), actor = null,
} = {}) {
  /* THE ONE LEAD'S WHOLE HISTORY IS RE-READ HERE, and the board's copy is only a
   * fallback.
   *
   * The board reads `admin_lead_tags_now` under a row cap. A lead past that cap
   * arrives with an EMPTY event list — and autoTagPlan decides "never put back a
   * tag a person removed by hand" entirely from the events it is handed. So on a
   * big book, pressing this button re-added tags a rep had taken off and wrote a
   * fresh dated line claiming an automatic rule did it. Nothing on screen would
   * have said so. Found by an adversarial review, Aug 27 2026.
   *
   * One read of one lead is cheap, and it is the only way the hand-set rules can
   * be true regardless of what the board managed to load. A failed read falls
   * back to the board's copy AND is reported, rather than silently planning from
   * nothing — planning from nothing is the failure this exists to prevent. */
  let history = events;
  let historyError = null;
  const fresh = await listLeadTagEvents(lead.id);
  if (fresh.error) historyError = fresh.error;
  else history = fresh.rows || [];

  const plan = autoTagPlan(lead, { company, touchCount, now, events: history, tagsBySlug, tagsById });
  const done = { added: [], removed: [], failed: [], unknown: plan.unknown, historyError };
  for (const t of plan.add) {
    const res = await setLeadTag({
      leadId: lead.id, tagId: t.tag_id, label: tagsBySlug.get(t.slug)?.label || t.slug,
      action: "added", actor, source: "auto", why: t.why,
    });
    if (res.ok) done.added.push(t.slug); else done.failed.push({ slug: t.slug, error: res.error });
  }
  for (const t of plan.remove) {
    const res = await setLeadTag({
      leadId: lead.id, tagId: t.tag_id, label: tagsBySlug.get(t.slug)?.label || t.slug,
      action: "removed", actor, source: "auto", why: t.why,
    });
    if (res.ok) done.removed.push(t.slug); else done.failed.push({ slug: t.slug, error: res.error });
  }
  return done;
}

/* ---- closing a deal, with a reason --------------------------------- */

/**
 * MARK A DEAL LOST — the one path, with the reason in front of it.
 *
 * There was no Lost path at all before today. One button wrote
 * `lost_reason: "No reply after the full cadence."` hard-coded, and every other
 * way of reaching Lost recorded nothing. So the most useful question in sales —
 * why are we losing — had no answer in this database.
 *
 * THE REASON BOX IS IN FRONT OF THIS FUNCTION, NOT IN FRONT OF THE BUTTONS.
 * That is the lesson from Won: four buttons each holding their own version of an
 * act is four behaviours, and the reason box would have ended up on three of
 * them. checkCloseReason refuses an empty reason and a one-word note here, where
 * every caller meets it.
 *
 * It writes, in this order: the stage and the reason, the dated line saying what
 * happened in the person's own words, and the `lost` tag. The stage first and
 * separately, so a failure further down still leaves the close recorded and the
 * message says which half did not happen.
 */
export async function markLeadLost(lead, {
  actor, reason, note, tagsBySlug = new Map(),
} = {}) {
  const gate = checkCloseReason({ kind: "lost", reason, note });
  if (!gate.ok) return { ok: false, error: gate.error, stageMoved: false };

  const now = new Date().toISOString();
  const res = await upsertLead({
    id: lead.id,
    stage: "lost",
    lost_reason: gate.reason,
    lost_reason_note: gate.note,
    closed_at: lead.closed_at || now,
  });
  if (!res.ok) return { ok: false, error: res.error, stageMoved: false };

  const problems = [];
  const label = reasonLabel(gate.reason) || gate.reason;
  /* TWO LINES, NOT ONE, and they are different kinds of thing. The stage change
   * is a fact about the record; the note is what a person wrote. Blending them
   * would put somebody's words under the heading of a system event, and the
   * timeline's own rule is that logged, system and theirs never blend. */
  const moved = await addLeadActivity({
    leadId: lead.id, actor, type: "status_change",
    body: `${LEAD_STAGE_LABELS[lead.stage] || lead.stage} → Lost. Reason: ${label}.`,
  });
  if (!moved.ok) problems.push("the timeline line did not save");

  const written = await addLeadActivity({
    leadId: lead.id, actor, type: "note",
    body: `Lost — ${label}. ${gate.note}`,
  });
  if (!written.ok) problems.push("the note did not save");

  const tag = tagsBySlug.get(TAG.LOST);
  if (tag) {
    const tagged = await setLeadTag({
      leadId: lead.id, tagId: tag.id, label: tag.label, action: "added",
      actor, source: "auto", why: `Marked Lost — ${label}.`,
    });
    if (!tagged.ok) problems.push("the Lost tag did not save");
  } else {
    /* Named rather than skipped in silence: the tag vocabulary not being loaded
     * means migration 0018 has not been run, and a rep should be told that the
     * close IS recorded and the tag is not. */
    problems.push("the Lost tag was not applied, because the tag list has not been set up yet");
  }

  return { ok: true, stageMoved: true, reason: gate.reason, note: gate.note, problems };
}

/** The one sentence to show after markLeadLost, true in every case it can end
 *  in. Kept next to the function, like wonMessage, so the words and the states
 *  cannot drift. */
export function lostMessage(result) {
  if (!result?.ok) {
    return { tone: "error", title: "Not saved", body: result?.error || "Nothing was changed." };
  }
  if (result.problems?.length) {
    return {
      tone: "warn",
      title: "Marked Lost, with something missing",
      body: `The reason and the stage are saved. ${result.problems.join("; ")}.`,
    };
  }
  return {
    tone: "success",
    title: "Marked Lost",
    body: "The reason, your note and the dated line are all on the record. Six months of these is how we find the gap.",
  };
}

/* ---- a rep's own AI rules ------------------------------------------ */

/**
 * ONE PERSON'S RULES. `userId` is a hard requirement, not a filter: with a falsy
 * id the query has no `eq` on it and RLS is the only thing left standing between
 * a rep and every other rep's rules — and in preview mode there is no RLS at
 * all, so it would hand back everybody's. The same refusal askRepReport makes,
 * for the same reason.
 *
 * An owner or admin reading somebody else's is a real thing (a rule nobody can
 * audit rewrites what prospects get told) and it goes through this same function
 * with that person's id.
 */
export async function listUserBrain(userId) {
  if (!userId) {
    return {
      rows: [],
      error: "Nobody is signed in as far as this page can tell, so no rules were read. These are one person's own settings and reading them without knowing whose would show somebody else's.",
      sample: false,
    };
  }
  if (!live()) {
    return {
      rows: previewStore.userBrain
        .filter((r) => r.user_id === userId)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
      sample: true,
    };
  }
  const { data, error } = await getSupabase()
    .from("admin_user_brain").select("*").eq("user_id", userId)
    .order("created_at", { ascending: true }).limit(200);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/**
 * Save one rule or one setting.
 *
 * THE NO-NUMBERS CHECK RUNS HERE, not only on the screen. checkPersonalRule is
 * the same function the page calls before it lets the button light up, and it is
 * called again at the door for the reason every guard in this file is doubled: a
 * writer that trusts its caller is a writer that eventually gets called wrong.
 *
 * Why a number in a personal rule matters at all is written out in full above
 * checkPersonalRule in lib/sales-rules.js. Short version: these rules are shown
 * to the model AND to the honesty gate, so a number typed here becomes a number
 * the gate believes we measured.
 */
export async function upsertUserBrain(patch) {
  const gate = checkPersonalRule(patch?.body);
  if (!gate.ok) return { ok: false, error: gate.error };
  /* THE LABEL GOES THROUGH THE SAME GATE AS THE RULE.
   *
   * `title` was not checked, and BOTH prompt renderers print it —
   * `lib/ai.js buildSystemPrompt` and `lib/rep-report.js renderPersonalRules` —
   * so a number typed into a title reached the pool the honesty gate checks the
   * model's answers against. `{ title: "clients see a 40% lift", body: "keep it
   * short" }` passed every check and taught the gate that 40% was something we
   * measured. That is verbatim the failure the no-digits rule exists to prevent,
   * through the one field nobody was looking at. Found by an adversarial review,
   * Aug 27 2026. */
  /* ONLY WHEN THE LABEL IS BEING SET OR CHANGED — never on a patch that is only
   * turning a rule off.
   *
   * The first version checked any patch carrying a title, and repBrain re-sends
   * the whole row on every edit including the On/Off switch. So a row whose label
   * already held a digit — one written before this check existed, or through the
   * database directly — became un-editable AND un-toggleable: the one action you
   * want on a bad rule is to switch it off, and that was the action refused.
   * Found by the third review, Aug 27 2026.
   *
   * `enabledOnly` is the shape repBrain's toggle sends: an id, a body and
   * `enabled`. A patch like that is let through whatever the stored title says. */
  const enabledOnly = Boolean(patch?.id)
    && Object.prototype.hasOwnProperty.call(patch || {}, "enabled")
    && !Object.prototype.hasOwnProperty.call(patch || {}, "title");
  if (!enabledOnly && patch?.title !== null && patch?.title !== undefined && String(patch.title).trim() !== "") {
    const titleGate = checkPersonalRule(patch.title);
    if (!titleGate.ok) {
      return { ok: false, error: `The label on this rule cannot hold a number either. ${titleGate.error}` };
    }
  }
  const clean = { ...patch, body: gate.text };

  if (!live()) {
    const now = new Date().toISOString();
    if (clean.id) {
      const i = previewStore.userBrain.findIndex((r) => r.id === clean.id);
      if (i < 0) return { ok: false, error: "That rule is not on file any more." };
      /* AND IT HAS TO BE YOURS. RLS refuses this in the real database (0022) and
       * the preview branch happily rewrote somebody else's rule if a patch
       * carried their row id — which is precisely what the note below calls "a
       * preview looser than the query underneath it", the trap this repo has been
       * bitten by twice. Found by tests/user-brain, Aug 27 2026.
       *
       * `clean.user_id` is what the page believes it is editing for; when a
       * caller does not say, there is nothing to check against and the safe
       * answer is to refuse rather than to assume. */
      if (!clean.user_id || previewStore.userBrain[i].user_id !== clean.user_id) {
        return { ok: false, error: "That rule belongs to somebody else, so nothing was changed." };
      }
      /* THE OWNER OF A ROW IS NEVER CHANGED BY AN EDIT. Without this a patch
       * carrying somebody else's user_id would move the rule to them — which RLS
       * refuses in the real database (0022) and preview mode would happily do,
       * and a preview looser than the query underneath it is the trap this repo
       * has been bitten by twice. */
      previewStore.userBrain[i] = {
        ...previewStore.userBrain[i], ...clean,
        user_id: previewStore.userBrain[i].user_id,
        updated_at: now,
      };
      return { ok: true, row: previewStore.userBrain[i], sample: true };
    }
    if (!clean.user_id) return { ok: false, error: "A rule has to belong to somebody." };
    const row = {
      id: pid("ub"), kind: "rule", setting_key: null, title: null, enabled: true,
      created_at: now, updated_at: now, ...clean,
    };
    previewStore.userBrain.unshift(row);
    return { ok: true, row, sample: true };
  }

  const supabase = getSupabase();
  /* A FIXED SETTING IS ONE ROW PER PERSON, so picking "Formal" twice does not
   * leave two tone rules arguing in the prompt. The unique index in 0022 is what
   * enforces it; `onConflict` is what makes the second press an update instead
   * of an error a rep has to read. */
  if (!clean.id && clean.setting_key) {
    const { data, error } = await supabase.from("admin_user_brain")
      .upsert(clean, { onConflict: "user_id,setting_key" }).select().maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, row: data };
  }
  const q = clean.id
    ? supabase.from("admin_user_brain").update(clean).eq("id", clean.id).select().maybeSingle()
    : supabase.from("admin_user_brain").insert(clean).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

/**
 * `userId` IS REQUIRED, and it is checked in both branches.
 *
 * RLS refuses a delete on somebody else's rule in the real database (0022), and
 * the preview branch filtered on the id alone — so in sample mode a rep could
 * delete the owner's rule, which live mode would have refused. A preview looser
 * than the query underneath it is the trap this repo has been bitten by twice,
 * and it is worth the extra argument at every call site.
 *
 * The live branch carries the same `eq` rather than leaning on the policy: the
 * policy is the thing that works, and this is the thing that makes the failure
 * legible — a delete that quietly matched nothing looks identical to one that
 * succeeded.
 */
export async function deleteUserBrain(id, userId) {
  if (!id) return { ok: false, error: "Nothing to delete." };
  if (!userId) {
    return { ok: false, error: "Nobody is signed in as far as this page can tell, so nothing was deleted." };
  }
  if (!live()) {
    const row = previewStore.userBrain.find((r) => r.id === id);
    if (!row) return { ok: true, sample: true };
    if (row.user_id !== userId) {
      return { ok: false, error: "That rule belongs to somebody else, so nothing was deleted." };
    }
    previewStore.userBrain = previewStore.userBrain.filter((r) => r.id !== id);
    return { ok: true, sample: true };
  }
  const { error } = await getSupabase()
    .from("admin_user_brain").delete().eq("id", id).eq("user_id", userId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/* ---- the board, with tags and scans on it -------------------------- */

/**
 * Everything the Floor and the owner's Sales page need, in ONE read, so no page
 * can be counting a different snapshot from the tiles above it.
 *
 * THIS IS A WIDENING OF getSalesBoard, NOT A SECOND BOARD. Three reads are added
 * — the tag vocabulary, the current tag state, and the scans — and everything
 * that already read this function keeps working, because the new keys are extra
 * rather than instead. A page that fetched its own leads would be a page with
 * its own snapshot, and two snapshots of one pipeline is how a tile ends up
 * disagreeing with the list under it.
 *
 * ERRORS AND CAPS ARE CARRIED, NOT SWALLOWED, exactly as they already were: a
 * page that renders no tags because one fetch failed looks precisely like a page
 * whose leads have no tags.
 */
export async function getFloorBoard() {
  const [board, tags, tagState, reports] = await Promise.all([
    getSalesBoard(), listLeadTags(), listLeadTagState(), listCompanyReports(),
  ]);
  const { byId: tagsById, bySlug: tagsBySlug } = tagIndex(tags.rows);
  return {
    ...board,
    leadTags: tags.rows,
    tagsById,
    tagsBySlug,
    tagEvents: tagState.rows,
    tagsByLead: eventsByLead(tagState.rows),
    companyReports: reports.rows,
    reportByCompany: newestReportByCompany(reports.rows),
    sample: Boolean(board.sample || tags.sample),
    errors: [...board.errors, tags.error, tagState.error, reports.error].filter(Boolean),
    truncated: [...board.truncated, tagState.truncated, reports.truncated].filter(Boolean),
  };
}

/**
 * MARK A DEAL WON, WITH THE REASON IN FRONT OF IT — the one path.
 *
 * markLeadWon() above is already the one function that moves the stage and
 * creates the client record, and all four Won buttons were routed through it on
 * Aug 25. The reason box goes in front of THAT function, not in front of the
 * four buttons — so this wraps it rather than replacing it, and the four buttons
 * now call this.
 *
 * Order, and it matters: the reason is checked BEFORE anything is written, so a
 * refused reason changes nothing at all. Then the stage and the client link (one
 * call, its own rules, its own safe-to-press-twice guard). Then the note in the
 * person's own words, then the tag. Anything that fails after the close is
 * reported in `problems` and the close still stands — rolling back a recorded
 * sale because a tag did not save would be worse.
 */
export async function closeLeadWon(lead, {
  actor, reason, note, stage = "Onboarding", tagsBySlug = new Map(),
} = {}) {
  const gate = checkCloseReason({ kind: "won", reason, note });
  if (!gate.ok) return { ok: false, error: gate.error, stageMoved: false };

  const res = await markLeadWon(lead, {
    actor, stage,
    extraPatch: { won_reason: gate.reason, won_reason_note: gate.note },
  });
  if (!res.ok) return res;

  const problems = [];
  const label = reasonLabel(gate.reason) || gate.reason;

  const written = await addLeadActivity({
    leadId: lead.id, actor, type: "note",
    body: `Won — ${label}. ${gate.note}`,
  });
  if (!written.ok) problems.push("the note did not save");

  const tag = tagsBySlug.get(TAG.WON);
  if (tag) {
    const tagged = await setLeadTag({
      leadId: lead.id, tagId: tag.id, label: tag.label, action: "added",
      actor, source: "auto", why: `Marked Won — ${label}.`,
    });
    if (!tagged.ok) problems.push("the Won tag did not save");
  } else {
    problems.push("the Won tag was not applied, because the tag list has not been set up yet");
  }

  return { ...res, reason: gate.reason, note: gate.note, problems };
}
