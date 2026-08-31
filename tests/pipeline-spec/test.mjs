/* THE PIPELINE SPEC — the rules half.
 *
 * Built 30 Aug 2026 from what HubSpot, Salesforce, Pipedrive, Close and Attio
 * actually do. This file attacks the five rules the whole thing rests on:
 *
 *   1. A reply STOPS the sequence, before the schedule gets a say.
 *   2. A bounce stops it too, and blocks the send.
 *   3. A reply outranks every other card in a rep's day — until it is answered.
 *   4. The three lists are computed from live columns and overlap on purpose.
 *   5. Nothing derived is settable: the early stages come out of the picker,
 *      and nothing on the board can put one back.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  cadenceState, CADENCE_STOPS, CADENCE, canEmail, textGate,
  salesQueue, answeredAfterReply, claimState, ROE,
  LEAD_LISTS, LEAD_LIST_IDS, onLeadList, leadListCounts,
} from "../../lib/sales-rules.js";
import { BOARD_STAGES, WORKING_COLUMN, dropCheck } from "../../lib/stage-move.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, "..", "..", p), "utf8");
const DATA = src("src/lib/data.js");
const NOW = "2026-08-30T20:00:00.000Z";
const ago = (d) => new Date(Date.parse(NOW) - d * 864e5).toISOString();
const soon = (d) => new Date(Date.parse(NOW) + d * 864e5).toISOString();

/* A lead mid-cadence: claimed 5 days ago, first contact made, one touch in. */
const WORKING = {
  id: "w", owner_id: "u-rep", stage: "contacted",
  claimed_at: ago(5), claim_contacted_at: ago(4), last_touch_at: ago(1),
};

console.log("\n1 · A REPLY STOPS THE SEQUENCE");
eq("a normal lead is still on the cadence", cadenceState(WORKING, NOW, 1).active, true);
eq("...and is owed its next step", cadenceState(WORKING, NOW, 1).step.n, 2);
eq("a lead that replied is OFF the cadence", cadenceState({ ...WORKING, first_reply_at: ago(1) }, NOW, 1).active, false);
eq("...and says why in words a rep can act on", cadenceState({ ...WORKING, first_reply_at: ago(1) }, NOW, 1).stop, "replied");
eq("...with no step owed at all", cadenceState({ ...WORKING, first_reply_at: ago(1) }, NOW, 1).step, null);
/* THE ORDER IS THE RULE. The reply has to beat the schedule, not be ranked
 * against it — checking the touch count first would leave a lead who replied
 * after two emails still showing step 3 as due. */
ok("a reply beats the schedule even mid-sequence",
  [0, 1, 2, 3, 4].every((n) => cadenceState({ ...WORKING, first_reply_at: ago(1) }, NOW, n).stop === "replied"));
ok("...and even after all five touches are done",
  cadenceState({ ...WORKING, first_reply_at: ago(1) }, NOW, CADENCE.length).finished !== true);
ok("every stop has words to print", LEAD_LIST_IDS.length > 0
  && ["unclaimed", "closed", "replied", "bounced", "undated"].every((k) => typeof CADENCE_STOPS[k] === "string" && CADENCE_STOPS[k].length > 20));
eq("an unclaimed lead stops for its own reason, not the reply one", cadenceState({ ...WORKING, owner_id: null }, NOW, 1).stop, "unclaimed");
eq("a closed lead likewise", cadenceState({ ...WORKING, stage: "won" }, NOW, 1).stop, "closed");
eq("an unreadable claim date is named rather than silently 'working'",
  cadenceState({ ...WORKING, cadence_started_at: "not a date", claimed_at: null, created_at: null }, NOW, 1).stop, "undated");
/* A lead that replied is NOT abandoned — it keeps its claim and its cold
 * clock. What stops is the pre-written sequence, which was the only automatic
 * part of it. */
eq("a replied lead keeps its claim state", claimState({ ...WORKING, first_reply_at: ago(1) }, NOW).state, "working");

console.log("\n2 · A BOUNCE STOPS IT, AND BLOCKS THE SEND");
eq("a bounced lead is off the cadence", cadenceState({ ...WORKING, bounced_at: ago(2) }, NOW, 1).stop, "bounced");
eq("canEmail refuses a bounced address", canEmail({ email: "a@b.c", bounced_at: ago(2) }).allowed, false);
ok("...and names the date so the refusal is checkable", /2026-08-28/.test(canEmail({ email: "a@b.c", bounced_at: ago(2) }).reason));
eq("...and flags it as a bounce, not a generic refusal", canEmail({ email: "a@b.c", bounced_at: ago(2) }).bounced, true);
eq("a normal address is fine", canEmail({ email: "a@b.c" }).allowed, true);
eq("no address at all is refused", canEmail({ email: null }).allowed, false);
eq("no lead at all is refused — fails closed", canEmail(null).allowed, false);
/* A REPLY OUTRANKS A BOUNCE. Both can be on one lead — they replied from one
 * address and a later send bounced — and "answer them" is the more useful
 * instruction than "that address is dead". */
eq("a lead that replied AND bounced reads as replied", cadenceState({ ...WORKING, first_reply_at: ago(1), bounced_at: ago(2) }, NOW, 1).stop, "replied");

console.log("\n3 · A REPLY IS THE TOP CARD IN THE DAY");
{
  const waiting = { ...WORKING, id: "waiting", first_reply_at: ago(2), last_touch_at: ago(5) };
  const answered = { ...WORKING, id: "answered", first_reply_at: ago(9), last_touch_at: ago(1) };
  const expired = { id: "expired", owner_id: "u-rep", stage: "new", claimed_at: ago(20) };
  const q = salesQueue([expired, waiting, answered], { userId: "u-rep", now: NOW, touchCounts: {} });
  eq("the replied lead is first, above an expired claim", q[0].lead.id, "waiting");
  eq("...and it says what it is", q[0].reason, "replied");
  ok("...and how long they have been waiting", /2 days/.test(q[0].detail));
  ok("a reply that has been ANSWERED is not a card any more",
    !q.some((c) => c.reason === "replied" && c.lead.id === "answered"));
  eq("answeredAfterReply: touched since the reply", answeredAfterReply(answered), true);
  eq("answeredAfterReply: not touched since", answeredAfterReply(waiting), false);
  eq("no reply at all is not 'answered'", answeredAfterReply(expired), false);
  /* Fails towards SHOWING the card. A visible card about a lead nobody
   * answered is recoverable; a lead silently dropped out of the day is not. */
  eq("an unreadable touch date keeps the card on screen",
    answeredAfterReply({ first_reply_at: ago(2), last_touch_at: "nonsense" }), false);
  eq("a note counts as answering — last_activity_at is read too",
    answeredAfterReply({ first_reply_at: ago(2), last_activity_at: ago(1) }), true);
}

console.log("\n4 · THE THREE LISTS");
eq("three of them, and only one is for owners", LEAD_LIST_IDS.length, 3);
eq("...and it is the stuck one", LEAD_LIST_IDS.filter((id) => LEAD_LISTS[id].owners), ["stuck"]);
ok("every list says what it means and what an empty one means",
  LEAD_LIST_IDS.every((id) => LEAD_LISTS[id].label && LEAD_LISTS[id].hint && LEAD_LISTS[id].empty));
{
  const noPlan = { ...WORKING, id: "noplan" };
  const planned = { ...WORKING, id: "planned", next_follow_up_at: soon(3) };
  const stale = { ...WORKING, id: "stale", next_follow_up_at: ago(3) };
  const quiet = { id: "quiet", owner_id: "u-rep", stage: "contacted", claimed_at: ago(40), claim_contacted_at: ago(39), last_touch_at: ago(20), next_follow_up_at: soon(3) };
  const stuck = { id: "stuck", owner_id: "u-other", stage: "new", claimed_at: ago(20) };
  const closed = { ...WORKING, id: "closed", stage: "lost" };
  const args = { userId: "u-rep", now: NOW };

  eq("no next step: nothing booked", onLeadList("no_next", noPlan, args), true);
  eq("no next step: something booked is not on it", onLeadList("no_next", planned, args), false);
  /* A DATE IN THE PAST IS NOT A PLAN. A follow-up booked for last Tuesday that
   * nobody kept is exactly the lead this list is for. */
  eq("no next step: a date that has been and gone still counts as no plan", onLeadList("no_next", stale, args), true);
  eq("gone quiet: 20 days with nothing logged", onLeadList("quiet", quiet, args), true);
  /* THE TWO OVERLAP ON PURPOSE and neither contains the other — Pipedrive's
   * rotting clock ignores whether a next step is booked, and it looks like a
   * bug until you have both. */
  eq("...even though it HAS a next step booked", onLeadList("no_next", quiet, args), false);
  eq("...and a lead with no plan is not automatically quiet", onLeadList("quiet", noPlan, args), false);
  eq("stuck: somebody else's untouched, expired claim", onLeadList("stuck", stuck, { now: NOW }), true);
  eq("...and it is NOT narrowed to the reader, or it would find nothing",
    onLeadList("stuck", stuck, args), true);
  eq("a closed lead is on no list, ever",
    LEAD_LIST_IDS.some((id) => onLeadList(id, closed, args)), false);
  eq("an unclaimed lead owes nobody anything", onLeadList("no_next", { ...noPlan, owner_id: null }, args), false);
  eq("another rep's lead is not on YOUR no-next list", onLeadList("no_next", { ...noPlan, owner_id: "u-other" }, args), false);
  eq("an unknown list id is false, not a throw", onLeadList("invented", noPlan, args), false);
  eq("counts come from one pass over one array",
    leadListCounts([noPlan, planned, stale, quiet, stuck, closed], args), { no_next: 2, quiet: 1, stuck: 1 });
  /* The quiet list must agree with the Claim column about what quiet MEANS.
   * The old `cold` tag measured it differently and the two disagreed on any
   * re-claimed lead — the defect the 30 Aug audit opened with. */
  eq("gone quiet is claimState's own answer, not a second opinion",
    onLeadList("quiet", quiet, args), claimState(quiet, NOW).state === "cold");
}

console.log("\n5 · NOTHING DERIVED IS SETTABLE");
{
  const pickable = (() => {
    const m = DATA.match(/export const PICKABLE_STAGES = \[([\s\S]*?)\];/);
    return m ? [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]) : null;
  })();
  const derived = (() => {
    const m = DATA.match(/export const DERIVED_STAGES = \[([\s\S]*?)\];/);
    return m ? [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]) : null;
  })();
  ok("both lists are readable out of data.js", Boolean(pickable && derived));
  ok("no stage is both pickable and derived",
    pickable.every((s) => !derived.includes(s)), JSON.stringify(pickable.filter((s) => derived.includes(s))));
  for (const s of ["new", "researching", "contacted", "in_conversation"]) {
    ok(`${s} cannot be chosen by a person`, !pickable.includes(s));
  }
  for (const s of ["follow_up", "meeting", "proposal", "won", "lost"]) {
    ok(`${s} still can`, pickable.includes(s));
  }
  /* THE BOARD IS THE OTHER DOOR. A drop target for a derived stage would put
   * it back within reach, and dropCheck is the only thing standing there. */
  for (const s of derived) {
    ok(`the board cannot put a lead back to ${s}`, dropCheck({ editable: true, from: "follow_up", to: s }).ok === false);
    ok(`...but ${s} is still drawn somewhere`, WORKING_COLUMN.stages.includes(s));
  }
  ok("the Working column is not a drop target itself",
    !BOARD_STAGES.includes(WORKING_COLUMN.id) && dropCheck({ editable: true, from: "won", to: WORKING_COLUMN.id }).ok === false);

  /* THE GATE. Written against columns that exist — the first draft required
   * `meeting_at` and `proposal_amount` and NEITHER IS A COLUMN. */
  const SQL = src("supabase/migrations/0002_work_page.sql") + src("supabase/migrations/0009_sales.sql");
  ok("the gate's date column is real", /next_follow_up_at/.test(SQL));
  ok("the gate's proposal amount is real", /amount_cents/.test(SQL));
  /* The two invented names may appear ONLY in the comment that records the
   * mistake — never in a line of code. Stripping comment lines rather than one
   * hand-matched block, so the check cannot be defeated by rewording it. */
  const codeOnly = DATA.split("\n").filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join("\n");
  ok("no invented column survived into actual code",
    !/meeting_at|proposal_amount/.test(codeOnly),
    codeOnly.split("\n").filter((ln) => /meeting_at|proposal_amount/.test(ln)).join(" | "));
  ok("...and the mistake is still written down where the next person will read it",
    /NEITHER IS A COLUMN/.test(DATA));
  for (const s of ["follow_up", "meeting", "proposal"]) {
    ok(`${s} is gated`, new RegExp(`\\b${s}: \\{`).test(DATA.slice(DATA.indexOf("export const STAGE_REQUIRES"))));
  }
  /* Won and Lost are deliberately NOT in the gate table — they have the richer
   * reason box, and gating them twice would ask for the same sentence twice. */
  const gate = DATA.slice(DATA.indexOf("export const STAGE_REQUIRES"), DATA.indexOf("export function stageRequirementMet"));
  ok("won and lost are not double-gated", !/\bwon: \{/.test(gate) && !/\blost: \{/.test(gate));
}

console.log("\n5c · EVERY DOOR INTO THE STAGE IS THE SAME DOOR");
{
  /* Restricting one control is not restricting the act. A checker found three
   * more writers within an hour of the sheet being changed. */
  const PROF = src("src/components/admin/salesProfile.jsx");
  ok("the drawer's stage select offers PICKABLE_STAGES, not all twelve",
    /\[\.\.\.new Set\(\[\.\.\.PICKABLE_STAGES, lead\.stage\]/.test(PROF));
  ok("...and it writes through the page's gate, not its own upsert",
    /onStage\([\s\S]{0,40}e\.target\.value,/.test(PROF));
  ok("the drawer's two stage buttons go through the gate too",
    (PROF.match(/onStage\("(meeting|follow_up)"/g) || []).length === 2);
  /* A LOOSE PATTERN IS A GUARD THAT CANNOT FIRE. This was `/onPatch\(\{ stage:/`
   * and it PASSED while the select was still writing
   * `onPatch(\n  { stage: ... })` — the exact bypass it was written to catch.
   * Whitespace-tolerant now. */
  ok("...and NOTHING in the drawer writes a stage through onPatch any more",
    !/onPatch\(\s*\{?\s*\{?\s*stage:/.test(PROF), (PROF.match(/onPatch\([\s\S]{0,30}stage:/) || [""])[0]);
  const PAGE = src("src/components/admin/SalesPage.jsx");
  ok("the page hands the drawer its gated path", /onStage=\{\(stage, note, extra = \{\}\) => patchLead\(/.test(PAGE));

  /* THE ASSISTANT IS A CONTROL TOO. Its list is a hand-kept copy — it cannot
   * import from src/ — so this is what stops the two drifting. */
  const AT = src("lib/assistant-tools.js");
  const toolStages = (() => {
    const m = AT.match(/const LEAD_STAGES = \[([^\]]*)\]/);
    return m ? [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]) : [];
  })();
  const pickable = (() => {
    const m = DATA.match(/export const PICKABLE_STAGES = \[([\s\S]*?)\];/);
    return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
  })();
  eq("the assistant's stage list matches PICKABLE_STAGES exactly",
    [...toolStages].sort(), [...pickable].sort());

  /* AND THE SCORE ENDPOINT, which parks 90+ firms. It used the stage list that
   * was abandoned the same day, so a lead worked for a month — still reading
   * `new`, because nothing sets the early stages any more — would have been
   * parked by a website scan. */
  const SCORE = src("api/sales-score.js");
  ok("the score endpoint parks on first_contact_at, not on a stage list",
    /\.is\("first_contact_at", null\)/.test(SCORE) && !/\.in\("stage", \["new", "researching"\]\)/.test(SCORE));
  ok("and the drawer's 90+ banner uses the same test",
    /gate\.skip && !lead\.first_contact_at/.test(PROF));
}

console.log("\n5b · A FILTER THAT IS ON IS ALWAYS VISIBLE");
{
  /* The rule this file's own author wrote about the tile chip, applied to the
   * watch lists: "a filter that is ON with no control on screen showing it is a
   * filter nobody can find or turn off". The chips were gated to the sheet while
   * the filter ran on every view, so switching to Pipeline showed 2 of 3 cards
   * and nothing said why. Found by clicking it. */
  const P = src("src/components/admin/SalesPage.jsx");
  ok("the watch chips are not gated to one view",
    !/\{shownView === "lists" && \(\s*\n\s*<div className="adm-sl-watch"/.test(P));
  ok("...and the filter they control runs on the page's one filter chain",
    /if \(listWatch && !skipWatch\) \{/.test(P));
  /* THE COUNT AND THE LIST COME FROM THE SAME CHAIN. It counted raw scopeLeads,
   * so a rep on "Available" read "No next step · 4" and got an empty table. */
  ok("the chip counts run through the same filters, minus the watch itself",
    /leadListCounts\(filterLeads\(scopeLeads, \{ skipWatch: true, skipList: true \}\)/.test(P));
  ok("My Day obeys the watch list too", /const base = listWatch/.test(P));
  ok("clearing the filters clears the watch too", /setListWatch\(null\);/.test(P));
  ok("the watch is part of what makes Clear offerable", /\|\| listWatch !== null/.test(P));
  ok("only owners are offered the stuck list",
    /LEAD_LIST_IDS\.filter\(\(id\) => !LEAD_LISTS\[id\]\.owners \|\| isAdmin\)/.test(P));
}

console.log("\n6 · THE MIGRATION THAT IS NOT RUN YET");
{
  const M = src("supabase/migrations/0027_pipeline_spec.sql");
  ok("it says out loud that it has not been run", /NOT YET RUN/.test(M));
  ok("it says it is safe to re-run", /SAFE TO RE-RUN/i.test(M));
  ok("it deletes nothing", !/\bdelete\s+from\b/i.test(M) && !/\bdrop\s+table\b/i.test(M));
  ok("tags are retired, never removed", /set active = false/.test(M));
  ok("the stage constraint is widened BEFORE the rows move",
    M.indexOf("'not_a_fit'\n  ));") < M.indexOf("set stage = 'not_a_fit'"));
  ok("the old stage is recorded on the timeline before the rewrite",
    M.indexOf("insert into public.admin_lead_activity") < M.indexOf("set stage = 'not_a_fit'"));
  ok("the four human tags carry no auto rule", /auto_rule is null on all four/i.test(M));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
