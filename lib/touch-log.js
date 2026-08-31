/* LOGGING A TOUCH FROM THE ROW — two clicks, and the data is already there.
 *
 * Ryder, 30 Aug 2026: "when you click contacted i want a popup with the
 * available options that you went through and the questions required very
 * simply so its a couple clicks and all the data is there. similar to sales
 * cycle status."
 *
 * WHY THIS FILE EXISTS AT ALL. The Contacted? column is DERIVED — contactedState
 * in src/lib/salesSheet.js reads the touch count and first_contact_at. There is
 * no "contacted" field to set, and there must not be: the sheet's whole failure
 * mode was columns somebody typed into that nothing could count. So clicking
 * that cell cannot set a value. It logs a real touch, and the column follows.
 *
 * TWO LEVELS, NOT ONE, and the second one changes with the first. A call can go
 * six ways and an email cannot go any of them. One flat list would have to ask
 * every channel the same question, which is how the drawer's Log box ended up
 * defaulting every email to "Talked to them" — every email logged through it
 * carries an outcome that describes a phone call.
 *
 * THIS FILE IS PURE. It decides WHAT a pick means; src/components/admin/
 * touchPicker.jsx draws it and src/lib/data.js writes it. tests/touch-log
 * attacks it. The rules below are the ones that have to hold:
 *
 *   1. AN INBOUND EVENT IS NOT ONE OF OUR TOUCHES. See the note on `inbound`.
 *   2. A FIRST-* STAMP IS WRITTEN ONCE. `stampIfEmpty` never overwrites.
 *   3. NOTHING HERE MOVES THE SALES CYCLE STATUS. Ryder's call, 30 Aug: the
 *      status is a thing the rep decides, not a thing the system infers from a
 *      voicemail. Claiming is different — see `claims` below.
 */

/* ------------------------------------------------------------------ */
/* Level one — what you did                                            */
/* ------------------------------------------------------------------ */

/**
 * The four channels, in the order a rep actually uses them.
 *
 * `type` is the value that goes in admin_lead_activity.type, which is a CHECK
 * constraint (0018) — 'call','email','text','linkedin' are all in it. Do not
 * invent a fifth without a migration.
 */
export const TOUCH_CHANNELS = [
  { id: "call", type: "call", label: "Called", why: "You picked up the phone." },
  { id: "email", type: "email", label: "Emailed", why: "You sent them an email." },
  { id: "linkedin", type: "linkedin", label: "LinkedIn", why: "A connection request or a message." },
  /* LAST, and often disabled. The one-text rule (ROE.MAX_TEXTS + textGate) is
   * the strictest thing on this page, so the control that can break it is the
   * one furthest from the thumb. */
  { id: "text", type: "text", label: "Texted", why: "One text, and only after they have written back." },
];

/* ------------------------------------------------------------------ */
/* Level two — how it went                                             */
/* ------------------------------------------------------------------ */

/**
 * Every outcome, per channel.
 *
 * `outcome` is what lands in admin_lead_activity.outcome, which is FREE TEXT
 * (0001, no check constraint) — so new values here need no migration. It is
 * still a fixed list on purpose: a free-text outcome column is a column nothing
 * can count, which is the sheet all over again.
 *
 * `inbound: true` means THEY did it, not us. That flag is the whole reason this
 * table needs care — read the note on touchWrite().
 *
 * `stampIfEmpty` names the columns on admin_leads this outcome fills in, and
 * only when they are still null. Those three columns (0021) are the entire
 * denominator and numerator of the reply rate on the Stats page, and until
 * today NOTHING ON ANY SCREEN WROTE first_reply_at or bounced_at — so every
 * reply-rate figure the console has ever shown could only read zero or null.
 * This control is what makes them real.
 */
export const TOUCH_OUTCOMES = {
  call: [
    { id: "talked", label: "Talked to them", why: "A real conversation." },
    { id: "voicemail", label: "Left a voicemail", why: "Rang out, message left." },
    { id: "no_answer", label: "No answer", why: "Rang out, no message." },
    { id: "booked", label: "Booked a meeting", why: "There is a time in the diary." },
    { id: "not_interested", label: "Not interested", why: "They said no on the call." },
    { id: "bad_number", label: "Bad number", why: "Wrong person, or the line is dead." },
  ],
  email: [
    { id: "sent", label: "Sent it", why: "It went out. No answer yet.", stampIfEmpty: ["first_email_at"] },
    /* THE ONE THAT CHANGES THE MOST. It fills first_reply_at, which is the
     * numerator of the reply rate AND the gate on the text button — textGate in
     * lib/sales-rules.js refuses every text until a reply is on record. Marking
     * a reply here is therefore also what unlocks the single text. */
    { id: "replied", label: "They replied", why: "They wrote back. This also unlocks your one text.", inbound: true, stampIfEmpty: ["first_email_at", "first_reply_at"] },
    { id: "bounced", label: "It bounced", why: "The address is dead.", inbound: true, stampIfEmpty: ["first_email_at", "bounced_at"] },
  ],
  linkedin: [
    { id: "sent", label: "Sent it", why: "A request or a message went out." },
    { id: "accepted", label: "They accepted", why: "You are connected. Nothing said yet.", inbound: true },
    { id: "replied", label: "They replied", why: "They wrote back.", inbound: true, stampIfEmpty: ["first_reply_at"] },
  ],
  text: [
    { id: "sent", label: "Sent it", why: "Your one text. The button locks after this." },
    { id: "replied", label: "They replied", why: "They wrote back.", inbound: true, stampIfEmpty: ["first_reply_at"] },
  ],
};

export function channelById(id) {
  return TOUCH_CHANNELS.find((c) => c.id === id) || null;
}

export function outcomesFor(channelId) {
  return TOUCH_OUTCOMES[channelId] || [];
}

export function outcomeById(channelId, outcomeId) {
  return outcomesFor(channelId).find((o) => o.id === outcomeId) || null;
}

/* ------------------------------------------------------------------ */
/* What a pick actually writes                                         */
/* ------------------------------------------------------------------ */

/**
 * Turn a (channel, outcome) pair into everything the writer needs. One function,
 * so the row, the drawer and any future control cannot come to disagree about
 * what "they replied" means.
 *
 * ---- THE INBOUND PROBLEM, AND WHY A REPLY IS LOGGED AS A NOTE ----
 *
 * The database resets the timers itself: admin_lead_activity_touch() in
 * migration 0009 fires on every row of type call/email/text/linkedin and sets
 * last_touch_at, claim_contacted_at and first_contact_at. That trigger has no
 * way to tell an outbound email from an inbound one — the migration says so in
 * as many words, and calls it an honest limit.
 *
 * So logging "they replied" as type 'email' would tell the database WE reached
 * out. The cold-lead timer would reset, the cadence would advance, and
 * first_contact_at could be stamped by a message the prospect sent us. A rep
 * marking twenty replies would quietly reset twenty cold timers.
 *
 * Inbound events therefore go in as type 'note', which the trigger's else branch
 * handles: last_activity_at moves (something did happen) and no touch timer
 * does (we did not touch them). The stamps in `patch` carry the real meaning,
 * and the timeline line says what it was in words.
 *
 * The alternative was a direction column and a new migration. Not needed: no
 * count in this console reads activity direction, and three of them read the
 * columns this already fills.
 *
 * @returns null for an unknown pair — callers must treat that as "write
 *          nothing", never as a default. A silent fallback here would file a
 *          call as an email.
 */
export function touchWrite(channelId, outcomeId) {
  const channel = channelById(channelId);
  const outcome = outcomeById(channelId, outcomeId);
  if (!channel || !outcome) return null;
  const inbound = Boolean(outcome.inbound);
  return {
    channel: channel.id,
    outcome: outcome.id,
    inbound,
    /* The one line above: an inbound event is not one of our touches. */
    activityType: inbound ? "note" : channel.type,
    /* Kept even on a note, so the timeline and any later count can still tell a
     * bounced email from an accepted connection request. */
    activityOutcome: outcome.id,
    /* What the timeline line reads. Written here rather than at the call site so
     * the sentence cannot drift from the flag that decided the type. */
    body: inbound
      ? `${outcome.label} — ${channel.label.toLowerCase()}.`
      : `${channel.label} · ${outcome.label.toLowerCase()}.`,
    stampIfEmpty: outcome.stampIfEmpty || [],
    /* Whether this pick should also take the lead off the floor. Every outbound
     * touch does; an inbound one does not, because a reply arriving is not the
     * rep deciding to work the firm. See claimPatch(). */
    claims: !inbound,
  };
}

/**
 * The columns to write on admin_leads for this pick, given the lead as it
 * stands. Empty object means nothing needs writing.
 *
 * `stampIfEmpty` is applied HERE, against the real row, rather than with a
 * database-side coalesce, because the writer is a PostgREST update and a
 * coalesce would need a function. The cost is a lost race between two tabs
 * marking the same reply, and the loser overwrites an identical timestamp a few
 * milliseconds apart. That is the whole downside, and it is acceptable; nothing
 * else here is order-sensitive.
 *
 * A NULL CHECK, NOT A TRUTHINESS CHECK. An empty string in one of these columns
 * would be falsy and would get overwritten; `== null` catches null and undefined
 * and nothing else, which is what "has never been stamped" actually means.
 */
export function stampPatch(write, lead, nowIso) {
  if (!write || !lead) return {};
  const patch = {};
  for (const col of write.stampIfEmpty) {
    if (lead[col] == null) patch[col] = nowIso;
  }
  return patch;
}

/**
 * Should this pick claim the lead, and for whom.
 *
 * Ryder's call, 30 Aug: an outbound touch on an unclaimed lead claims it, and
 * the sales cycle status is left alone. The reason for the first half is the
 * ⚠ this console was rebuilt around the same day — a rep who calls somebody
 * without claiming them leaves that firm on everybody else's floor as free, and
 * two reps ring the same office on the same morning.
 *
 * Never re-claims: a lead somebody already holds is left exactly as it is, so
 * logging a touch can never move a firm between reps.
 */
export function claimsOnTouch(write, lead, userId) {
  if (!write || !write.claims) return false;
  if (!lead || !userId) return false;
  return lead.owner_id == null;
}
