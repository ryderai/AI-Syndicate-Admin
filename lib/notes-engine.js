/* The Notes engine — turns real rows into notes, by counting.
 *
 * THE DESIGN DECISION THAT MATTERS
 * An AI could be handed the whole system and asked "write me some notes". It
 * would produce something that reads beautifully and is partly invented. So it
 * is not allowed to. This file COUNTS the notes; the AI's only job afterwards
 * is to say the counted thing in better words, and the page prints which of
 * the two happened on every single note.
 *
 * That means every note here can be checked. "Michelle has 3 tasks past their
 * date" is either true of the rows or it is not, and the evidence array names
 * the exact three so you can go and look.
 *
 * Pure — no clock, no database, no network. `now` is passed in. This is what
 * makes the whole thing testable, and it is tested in tests/brain/test.mjs.
 */

import { daysSince, relDays, parseWhen } from "./brain-context.js";

const DAY = 86400000;

/* How long something may sit before it counts as owed attention.
 * These are the numbers a person can argue with — which is the point of
 * gathering them here instead of burying them in the checks below. */
export const THRESHOLDS = {
  // A lead in this stage, untouched this many days, is owed a contact.
  // Copied deliberately from the Work page's STALE_AFTER_DAYS (src/lib/data.js)
  // so the two pages can never disagree about what "cold" means.
  leadStale: { new: 1, contacted: 3, follow_up: 5, meeting: 5, proposal: 4 },
  // What the Work page does with a stage that is not in that list. It uses
  // `?? 7`; this used to skip such leads entirely, so a lead in a stage
  // somebody added later was overdue on one screen and invisible on the other.
  leadStaleDefault: 7,
  emailNeedsReplyDays: 1,      // an email marked "needs reply" older than this
  emailWaitingDays: 5,         // we replied and heard nothing back
  ticketOpenDays: 3,
  weeklyLogSilentDays: 10,     // an active client with nothing logged
  siteNotLiveDays: 7,          // a site on the list, still not live
  unclaimedLeadPile: 5,        // this many unowned leads is a queue, not a gap
  recentWindowDays: 7,         // what "in circulation" means
};

function ev(table, id, label) { return { table, id, label }; }

/** A stable id for "this note is about this thing". Two runs a week apart
 * produce the same fingerprint for the same problem, which is how a re-run
 * supersedes instead of duplicating. It must NOT contain a count or a date —
 * "3 tasks late" becoming "4 tasks late" is the same note, updated. */
function fp(kind, ...parts) {
  return [kind, ...parts.map((p) => String(p ?? "").toLowerCase().replace(/\s+/g, "-"))].join(":");
}

function leadLabel(l) { return l.name || l.company || "unnamed lead"; }

/**
 * @param snap  a snapshot from loadSystemContext
 * @param now   epoch ms
 * @returns     notes[], newest concern first
 */
export function computeNotes(snap, now = Date.now()) {
  const notes = [];
  const clients = snap.clients || [];
  const cn = (id) => clients.find((c) => c.id === id)?.name || null;

  const add = (n) => {
    // A note with nothing behind it is an opinion. Refuse to make one.
    if (!n.evidence?.length) return;
    notes.push({ written_by: "counted", urgency: 2, status: "open", ...n });
  };

  /* ---------------------------------------------------------------- */
  /* NEEDS A FOLLOW-UP                                                 */
  /* ---------------------------------------------------------------- */

  // Cold leads, grouped by the rep who owns them. Grouped on purpose: eleven
  // separate notes saying "call this person" is a list nobody reads, and the
  // rep already has that list on the Leads page. One note per rep is a fact
  // about a person's week.
  const coldByOwner = new Map();
  for (const l of snap.leads || []) {
    if (["won", "lost"].includes(l.stage)) continue;
    // The Work page also excludes a lead that has become a customer. Chasing
    // somebody who already signed is the most embarrassing call a rep can make.
    if (l.became_customer) continue;
    // Matches the Work page: an unknown stage is not a free pass.
    const limit = THRESHOLDS.leadStale[l.stage] ?? THRESHOLDS.leadStaleDefault;
    const quiet = l.last_activity_at ? daysSince(l.last_activity_at, now) : daysSince(l.created_at, now);
    if (quiet === null || quiet < limit) continue;
    const key = l.owner_id || "__unclaimed";
    if (!coldByOwner.has(key)) coldByOwner.set(key, []);
    coldByOwner.get(key).push({ lead: l, quiet });
  }
  for (const [ownerKey, items] of coldByOwner) {
    items.sort((a, b) => b.quiet - a.quiet);
    const unclaimed = ownerKey === "__unclaimed";
    if (unclaimed) continue; // handled as its own note below
    const worst = items[0];
    add({
      category: "follow_up",
      owner_id: ownerKey,
      urgency: worst.quiet >= 7 ? 3 : 2,
      fingerprint: fp("lead-cold", ownerKey),
      title: `${items.length} lead${items.length === 1 ? "" : "s"} owed a contact`,
      body: `${items.length} lead${items.length === 1 ? " has" : "s have"} gone past the point where `
        + `a contact is due. The coldest is ${leadLabel(worst.lead)} — last touched ${relDays(worst.lead.last_activity_at || worst.lead.created_at, now)}, `
        + `sitting at "${worst.lead.stage}". `
        + items.slice(0, 5).map((i) => `${leadLabel(i.lead)} (${i.quiet}d)`).join(", ")
        + (items.length > 5 ? `, and ${items.length - 5} more.` : "."),
      evidence: items.slice(0, 12).map((i) => ev("admin_leads", i.lead.id, leadLabel(i.lead))),
    });
  }

  // Unclaimed leads sitting in the pool with nobody's name on them.
  const unclaimed = (snap.leads || []).filter(
    (l) => !l.owner_id && !["won", "lost"].includes(l.stage));
  if (unclaimed.length >= THRESHOLDS.unclaimedLeadPile) {
    /* A row with no created_at is unknown, not ancient. Date.parse(x || 0)
     * parses the string "0" as the year 2000, so a null date won every
     * oldest-first sort and the note then read "The oldest arrived unknown."
     * Unknown dates sort LAST here and are simply not called the oldest. */
    const dated = unclaimed.filter((l) => !Number.isNaN(parseWhen(l.created_at)));
    const oldest = [...dated].sort((a, b) => parseWhen(a.created_at) - parseWhen(b.created_at))[0];
    add({
      category: "attention",
      urgency: unclaimed.length >= 25 ? 3 : 2,
      fingerprint: fp("leads-unclaimed"),
      title: `${unclaimed.length} leads have no rep on them`,
      body: `${unclaimed.length} open leads are unclaimed.`
        + (oldest ? ` The oldest arrived ${relDays(oldest.created_at, now)}.` : " None of them has a date on it.")
        + ` `
        + `Nobody is counted as owing these a call, so they will not show on anyone's Work page.`,
      evidence: unclaimed.slice(0, 12).map((l) => ev("admin_leads", l.id, leadLabel(l))),
    });
  }

  // Email threads marked "needs reply" — someone wrote to us and is waiting.
  const needReply = (snap.emails || []).filter((e) =>
    e.status === "needs_reply" && daysSince(e.last_message_at, now) >= THRESHOLDS.emailNeedsReplyDays);
  if (needReply.length) {
    const worst = [...needReply].sort((a, b) =>
      parseWhen(a.last_message_at) - parseWhen(b.last_message_at))[0];
    const worstDays = daysSince(worst.last_message_at, now);
    add({
      category: "follow_up",
      urgency: worstDays >= 3 ? 3 : 2,
      fingerprint: fp("email-needs-reply"),
      title: `${needReply.length} email${needReply.length === 1 ? "" : "s"} waiting on us`,
      body: `${needReply.length} thread${needReply.length === 1 ? " is" : "s are"} marked "needs reply". `
        + `The one waiting longest is "${worst.subject || "no subject"}" from ${worst.from_name || worst.from_email || "someone"}, `
        + `${relDays(worst.last_message_at, now)}${worst.client_id ? ` (${cn(worst.client_id) || "a client"})` : ""}.`,
      evidence: needReply.slice(0, 12).map((e) =>
        ev("admin_email_threads", e.id, e.subject || e.from_email || "thread")),
    });
  }

  // Threads where WE replied and nothing came back. A different problem: not
  // our turn, but ours to chase.
  const goneQuiet = (snap.emails || []).filter((e) =>
    e.status === "waiting" && daysSince(e.last_message_at, now) >= THRESHOLDS.emailWaitingDays);
  if (goneQuiet.length) {
    add({
      category: "follow_up",
      urgency: 2,
      fingerprint: fp("email-gone-quiet"),
      title: `${goneQuiet.length} thread${goneQuiet.length === 1 ? "" : "s"} went quiet after we replied`,
      body: `We answered and heard nothing back for at least ${THRESHOLDS.emailWaitingDays} days on `
        + `${goneQuiet.length} thread${goneQuiet.length === 1 ? "" : "s"}: `
        + goneQuiet.slice(0, 4).map((e) => `"${e.subject || "no subject"}" (${relDays(e.last_message_at, now)})`).join(", ")
        + (goneQuiet.length > 4 ? `, and ${goneQuiet.length - 4} more.` : ".")
        + ` Marked "waiting", so nothing on the board says these are owed a nudge.`,
      evidence: goneQuiet.slice(0, 12).map((e) =>
        ev("admin_email_threads", e.id, e.subject || e.from_email || "thread")),
    });
  }

  // Reminders a person set for themselves that are now overdue.
  const overdueReminders = (snap.reminders || []).filter((r) => daysSince(r.due_at, now) > 0);
  const byOwner = new Map();
  for (const r of overdueReminders) {
    const k = r.owner_id || "__nobody";
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push(r);
  }
  for (const [ownerId, items] of byOwner) {
    const worst = Math.max(...items.map((r) => daysSince(r.due_at, now)));
    add({
      category: "follow_up",
      owner_id: ownerId === "__nobody" ? null : ownerId,
      urgency: worst >= 3 ? 3 : 2,
      fingerprint: fp("reminders-overdue", ownerId),
      title: `${items.length} follow-up${items.length === 1 ? "" : "s"} past the date they were set for`,
      body: items.slice(0, 5).map((r) => `${r.body} (${daysSince(r.due_at, now)}d late)`).join("; ")
        + (items.length > 5 ? `; and ${items.length - 5} more.` : "."),
      evidence: items.slice(0, 12).map((r) => ev("admin_reminders", r.id, r.body)),
    });
  }

  /* ---------------------------------------------------------------- */
  /* NEEDS ATTENTION                                                   */
  /* ---------------------------------------------------------------- */

  // Tasks past their date, per client. Per client rather than one big pile,
  // because "Shiner is behind" is a thing you can act on and "27 tasks are
  // late" is not.
  const lateByClient = new Map();
  for (const t of snap.tasks || []) {
    if (t.status === "done") continue;
    const late = t.due_date ? daysSince(t.due_date, now) : null;
    if (late === null || late <= 0) continue;
    const k = t.client_id || "__none";
    if (!lateByClient.has(k)) lateByClient.set(k, []);
    lateByClient.get(k).push({ task: t, late });
  }
  for (const [cid, items] of lateByClient) {
    items.sort((a, b) => b.late - a.late);
    const worst = items[0];
    const label = cid === "__none" ? "with no client on them" : `for ${cn(cid) || "a client"}`;
    add({
      category: "attention",
      client_id: cid === "__none" ? null : cid,
      urgency: worst.late >= 7 ? 3 : 2,
      fingerprint: fp("tasks-late", cid),
      title: `${items.length} task${items.length === 1 ? "" : "s"} ${label} past the date`,
      body: `The oldest is "${worst.task.name}" — ${worst.late} days past its date, still "${worst.task.status}". `
        + items.slice(0, 5).map((i) => `${i.task.name} (${i.late}d)`).join("; ")
        + (items.length > 5 ? `; and ${items.length - 5} more.` : "."),
      evidence: items.slice(0, 12).map((i) => ev("admin_tasks", i.task.id, i.task.name)),
    });
  }

  // Blocked tasks. Blocked is not late — it is stopped, and it stays stopped
  // until something outside the task changes.
  const blocked = (snap.tasks || []).filter((t) => t.status === "blocked");
  if (blocked.length) {
    add({
      category: "attention",
      urgency: 2,
      fingerprint: fp("tasks-blocked"),
      title: `${blocked.length} task${blocked.length === 1 ? " is" : "s are"} blocked`,
      body: blocked.slice(0, 6).map((t) => `${t.name}${t.client_id ? ` (${cn(t.client_id) || "?"})` : ""}`).join("; ")
        + (blocked.length > 6 ? `; and ${blocked.length - 6} more.` : ".")
        + ` A blocked task does not move on its own — each one is waiting on something that does not exist yet.`,
      evidence: blocked.slice(0, 12).map((t) => ev("admin_tasks", t.id, t.name)),
    });
  }

  // Active clients with nothing written in the weekly log for a while. This is
  // the one that catches a client quietly going unworked.
  const silent = [];
  for (const c of clients) {
    if (c.status !== "active") continue;
    const logs = (snap.weekly || []).filter((w) => w.client_id === c.id);
    const newest = logs.reduce((acc, w) => {
      const t = parseWhen(w.created_at);
      return Number.isNaN(t) ? acc : Math.max(acc, t);
    }, 0);
    const quiet = newest ? Math.floor((now - newest) / DAY) : null;
    if (quiet === null || quiet >= THRESHOLDS.weeklyLogSilentDays) {
      silent.push({ client: c, quiet });
    }
  }
  if (silent.length) {
    add({
      category: "attention",
      urgency: 2,
      fingerprint: fp("weekly-log-silent"),
      title: `${silent.length} active client${silent.length === 1 ? " has" : "s have"} nothing in the weekly log`,
      body: silent.slice(0, 6).map((s) =>
        `${s.client.name} (${s.quiet === null ? "never logged" : `${s.quiet}d since the last entry`})`).join("; ")
        + (silent.length > 6 ? `; and ${silent.length - 6} more.` : ".")
        + ` GEO work is paced weekly — a gap in the log is either a gap in the work or a gap in the record.`,
      evidence: silent.slice(0, 12).map((s) => ev("admin_clients", s.client.id, s.client.name)),
    });
  }

  // Sites on a client's list that have not gone live.
  const notLive = (snap.sites || []).filter((s) =>
    !s.live && daysSince(s.created_at, now) >= THRESHOLDS.siteNotLiveDays);
  if (notLive.length) {
    add({
      category: "attention",
      urgency: 2,
      fingerprint: fp("sites-not-live"),
      title: `${notLive.length} site${notLive.length === 1 ? " is" : "s are"} on the list but not live`,
      body: notLive.slice(0, 6).map((s) =>
        `${s.label}${s.client_id ? ` — ${cn(s.client_id) || "?"}` : ""} (added ${relDays(s.created_at, now)})`
        + (s.notes ? `: ${s.notes}` : "")).join("; ")
        + (notLive.length > 6 ? `; and ${notLive.length - 6} more.` : "."),
      evidence: notLive.slice(0, 12).map((s) => ev("admin_client_sites", s.id, s.label)),
    });
  }

  // Tickets sitting open.
  const staleTickets = (snap.tickets || []).filter((t) =>
    daysSince(t.updated_at, now) >= THRESHOLDS.ticketOpenDays);
  if (staleTickets.length) {
    add({
      category: "attention",
      urgency: staleTickets.some((t) => t.priority === "urgent") ? 3 : 2,
      fingerprint: fp("tickets-stale"),
      title: `${staleTickets.length} ticket${staleTickets.length === 1 ? " has" : "s have"} not moved in ${THRESHOLDS.ticketOpenDays}+ days`,
      body: staleTickets.slice(0, 6).map((t) =>
        `"${t.subject}" (${t.priority}, ${relDays(t.updated_at, now)})`).join("; ")
        + (staleTickets.length > 6 ? `; and ${staleTickets.length - 6} more.` : "."),
      evidence: staleTickets.slice(0, 12).map((t) => ev("admin_tickets", t.id, t.subject)),
    });
  }

  // A lead source whose last run failed. Silent failure here means the
  // pipeline looks calm because nothing is arriving.
  const brokenSources = (snap.leadSources || []).filter((s) => s.last_run_error);
  if (brokenSources.length) {
    add({
      category: "attention",
      urgency: 3,
      fingerprint: fp("lead-source-failing"),
      title: `${brokenSources.length} lead source${brokenSources.length === 1 ? "" : "s"} failed on the last run`,
      body: brokenSources.map((s) => `${s.label}: ${s.last_run_error}`).join("; ")
        + ` While a source is failing, no new leads arrive from it and the pipeline looks calm rather than empty.`,
      evidence: brokenSources.map((s) => ev("admin_lead_sources", s.id, s.label)),
    });
  }

  /* ---------------------------------------------------------------- */
  /* IN CIRCULATION — what is actually moving                          */
  /* ---------------------------------------------------------------- */

  const since = now - THRESHOLDS.recentWindowDays * DAY;
  const movedLeads = (snap.leadActivity || []).filter((a) => parseWhen(a.created_at) >= since);
  if (movedLeads.length) {
    const byType = movedLeads.reduce((acc, a) => {
      acc[a.type] = (acc[a.type] || 0) + 1;
      return acc;
    }, {});
    const touchedLeadIds = [...new Set(movedLeads.map((a) => a.lead_id))];
    add({
      category: "in_circulation",
      urgency: 1,
      fingerprint: fp("sales-moving"),
      title: `${touchedLeadIds.length} lead${touchedLeadIds.length === 1 ? "" : "s"} worked in the last ${THRESHOLDS.recentWindowDays} days`,
      body: Object.entries(byType).map(([t, n]) => `${n} ${t}${n === 1 ? "" : "s"}`).join(", ")
        + ` across ${touchedLeadIds.length} lead${touchedLeadIds.length === 1 ? "" : "s"}. `
        + `Counted from logged activity only — a call nobody logged is not in this number.`,
      evidence: movedLeads.slice(0, 12).map((a) =>
        ev("admin_lead_activity", a.id, `${a.type}${a.outcome ? ` (${a.outcome})` : ""}`)),
    });
  }

  const liveThreads = (snap.emails || []).filter((e) => parseWhen(e.last_message_at) >= since);
  if (liveThreads.length) {
    add({
      category: "in_circulation",
      urgency: 1,
      fingerprint: fp("email-moving"),
      title: `${liveThreads.length} email thread${liveThreads.length === 1 ? "" : "s"} moved this week`,
      body: liveThreads.slice(0, 6).map((e) =>
        `"${e.subject || "no subject"}" — ${e.status.replace("_", " ")}, ${relDays(e.last_message_at, now)}`).join("; ")
        + (liveThreads.length > 6 ? `; and ${liveThreads.length - 6} more.` : "."),
      evidence: liveThreads.slice(0, 12).map((e) =>
        ev("admin_email_threads", e.id, e.subject || "thread")),
    });
  }

  /* ---------------------------------------------------------------- */
  /* WINS — said out loud, because nothing else in here ever is        */
  /* ---------------------------------------------------------------- */

  const recentWins = (snap.leads || []).filter((l) =>
    l.stage === "won" && parseWhen(l.updated_at || l.created_at) >= since);
  if (recentWins.length) {
    add({
      category: "win",
      urgency: 1,
      fingerprint: fp("leads-won"),
      title: `${recentWins.length} lead${recentWins.length === 1 ? "" : "s"} marked won this week`,
      body: recentWins.map((l) => leadLabel(l)).join(", ") + ".",
      evidence: recentWins.slice(0, 12).map((l) => ev("admin_leads", l.id, leadLabel(l))),
    });
  }

  // Most urgent first; within a level, the category people act on first.
  const catRank = { follow_up: 0, attention: 1, in_circulation: 2, win: 3 };
  notes.sort((a, b) => (b.urgency - a.urgency) || (catRank[a.category] - catRank[b.category]));
  return notes;
}

/** One line per note, for handing the set to an AI to rewrite. Deliberately
 * lossless on the numbers: the AI is rewording, not recalculating. */
export function notesToPromptLines(notes) {
  return notes.map((n, i) =>
    `${i + 1}. [${n.category}/urgency ${n.urgency}] ${n.title}\n   FACTS: ${n.body}`).join("\n");
}
