/* TWO CLICKS ON THE CONTACTED? CELL — the rules half.
 *
 * lib/touch-log.js decides what a (channel, outcome) pick MEANS. Everything
 * dangerous about this feature is in that decision, so this file attacks it:
 *
 *   1. An inbound event must never be written as one of our touches. The
 *      database trigger (0009) resets last_touch_at, first_contact_at and
 *      claim_contacted_at off the back of any call/email/text/linkedin row, and
 *      it cannot tell direction. Get this wrong and marking twenty replies
 *      quietly resets twenty cold timers.
 *   2. A first-* stamp is written ONCE and never overwritten.
 *   3. An unknown pick writes nothing at all — never a default.
 *   4. Logging a touch claims an unclaimed lead, and NEVER re-claims one.
 *   5. Nothing here moves the sales cycle status.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  TOUCH_CHANNELS, TOUCH_OUTCOMES, channelById, outcomesFor, outcomeById,
  touchWrite, stampPatch, claimsOnTouch,
} from "../../lib/touch-log.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, "..", "..", p), "utf8");
const NOW = "2026-08-30T20:00:00.000Z";

console.log("\nTHE MENU ITSELF");

eq("four channels, in the order a rep uses them",
  TOUCH_CHANNELS.map((c) => c.id), ["call", "email", "linkedin", "text"]);
ok("text is LAST — it is the one that can break the one-text rule",
  TOUCH_CHANNELS[TOUCH_CHANNELS.length - 1].id === "text");
ok("every channel has a plain-words explanation", TOUCH_CHANNELS.every((c) => c.why && c.why.length > 8));
ok("every channel has at least two outcomes — a second level with one row is not a level",
  TOUCH_CHANNELS.every((c) => outcomesFor(c.id).length >= 2));
ok("every outcome has a label and an explanation",
  TOUCH_CHANNELS.every((c) => outcomesFor(c.id).every((o) => o.label && o.why)));
ok("no channel offers the same outcome id twice",
  TOUCH_CHANNELS.every((c) => new Set(outcomesFor(c.id).map((o) => o.id)).size === outcomesFor(c.id).length));

/* THE TYPE COLUMN IS A CHECK CONSTRAINT (0018). A fifth channel needs a
 * migration, and this is what notices. */
{
  const SQL = src("supabase/migrations/0018_lead_tags.sql");
  ok("every channel's activity type is in the database's check constraint",
    TOUCH_CHANNELS.every((c) => new RegExp(`'${c.type}'`).test(SQL)));
  ok("...and so is 'note', which every inbound event uses", /'note'/.test(SQL));
}

eq("an unknown channel has no outcomes, rather than throwing", outcomesFor("carrier_pigeon"), []);
eq("an unknown channel id is null, not a guess", channelById("nope"), null);
eq("an unknown outcome id is null, not a guess", outcomeById("call", "nope"), null);

console.log("\nAN INBOUND EVENT IS NOT ONE OF OUR TOUCHES");
/* THE ONE THAT MATTERS MOST. See the trigger in 0009: it fires on
 * call/email/text/linkedin and has no direction column. */
{
  const inbound = [];
  for (const c of TOUCH_CHANNELS) {
    for (const o of outcomesFor(c.id)) {
      if (o.inbound) inbound.push([c.id, o.id]);
    }
  }
  ok("there are inbound outcomes to worry about", inbound.length >= 4);
  ok("EVERY inbound pick is written as a note, never as a touch type",
    inbound.every(([c, o]) => touchWrite(c, o).activityType === "note"),
    JSON.stringify(inbound.filter(([c, o]) => touchWrite(c, o).activityType !== "note")));
  ok("...and every OUTBOUND pick keeps its real channel type",
    TOUCH_CHANNELS.every((c) => outcomesFor(c.id)
      .filter((o) => !o.inbound)
      .every((o) => touchWrite(c.id, o.id).activityType === c.type)));
  ok("the outcome is kept on an inbound row, so a bounce is still tellable from a reply",
    touchWrite("email", "bounced").activityOutcome === "bounced"
    && touchWrite("email", "replied").activityOutcome === "replied");

  /* The trigger's own list, read out of the SQL rather than trusted. If somebody
   * adds 'note' to it, this feature silently starts resetting cold timers. */
  const SQL = src("supabase/migrations/0009_sales.sql");
  ok("the timers trigger still ignores 'note' — the whole inbound design rests on it",
    /if new\.type in \('call','email','text','linkedin'\) then/.test(SQL));
}

console.log("\nWHAT A PICK WRITES");
eq("an unknown pair writes NOTHING — never a default", touchWrite("call", "invented"), null);
eq("an unknown channel writes nothing either", touchWrite("smoke_signal", "sent"), null);
{
  const w = touchWrite("call", "voicemail");
  eq("a voicemail is a call", w.activityType, "call");
  eq("...with its outcome", w.activityOutcome, "voicemail");
  eq("...and it claims", w.claims, true);
  eq("...and stamps nothing — a call has no first-* column", w.stampIfEmpty, []);
  ok("its timeline line says both halves", /Called/.test(w.body) && /voicemail/i.test(w.body));
}
{
  const w = touchWrite("email", "replied");
  eq("a reply does NOT claim — a reply arriving is not the rep deciding to work the firm", w.claims, false);
  eq("...and it stamps both ends, so a rate has a numerator AND a denominator",
    w.stampIfEmpty, ["first_email_at", "first_reply_at"]);
}
eq("a bounce stamps the send as well — you cannot bounce what was never sent",
  touchWrite("email", "bounced").stampIfEmpty, ["first_email_at", "bounced_at"]);
eq("a plain sent email stamps only the send", touchWrite("email", "sent").stampIfEmpty, ["first_email_at"]);

/* first_email_at IS THE DENOMINATOR. lib/outreach.js counts replies only among
 * leads whose first_email_at is in the same window, so an outcome that stamps a
 * reply without a send would be uncountable. */
{
  const OUT = src("lib/outreach.js");
  ok("outreach.js counts replies only among leads that were emailed",
    /const emailedRows = mine \? mine\.filter\(\(l\) => inWindow\(l\.first_email_at/.test(OUT));
  const emailOutcomes = outcomesFor("email");
  ok("so every email outcome that stamps a reply also stamps the send",
    emailOutcomes.every((o) => {
      const st = o.stampIfEmpty || [];
      return !st.includes("first_reply_at") || st.includes("first_email_at");
    }));
}

console.log("\nA FIRST-* STAMP IS WRITTEN ONCE");
{
  const w = touchWrite("email", "replied");
  eq("both columns are stamped on a lead that has neither",
    stampPatch(w, { first_email_at: null, first_reply_at: null }, NOW),
    { first_email_at: NOW, first_reply_at: NOW });
  eq("a column already set is left exactly as it was",
    stampPatch(w, { first_email_at: "2026-01-01T00:00:00.000Z", first_reply_at: null }, NOW),
    { first_reply_at: NOW });
  eq("nothing to do is an empty object, not a patch of nulls",
    stampPatch(w, { first_email_at: "2026-01-01T00:00:00.000Z", first_reply_at: "2026-02-01T00:00:00.000Z" }, NOW),
    {});
  /* A NULL CHECK, NOT A TRUTHINESS CHECK. An empty string is falsy, and a
   * truthiness check would overwrite it — which reads as "we emailed them
   * today" about a lead emailed in May. */
  eq("an empty string counts as ALREADY SET and is not overwritten",
    stampPatch(w, { first_email_at: "", first_reply_at: "" }, NOW), {});
  eq("an undefined column IS stamped — it has never been written",
    stampPatch(touchWrite("email", "sent"), {}, NOW), { first_email_at: NOW });
  eq("no write and no lead is an empty object, not a throw", stampPatch(null, null, NOW), {});
  eq("a call stamps nothing at all", stampPatch(touchWrite("call", "talked"), {}, NOW), {});
}

console.log("\nCLAIMING, AND NEVER RE-CLAIMING");
const FREE = { id: "l1", owner_id: null };
const MINE = { id: "l2", owner_id: "u-rep" };
const THEIRS = { id: "l3", owner_id: "u-rep2" };
eq("an outbound touch claims a lead nobody holds",
  claimsOnTouch(touchWrite("call", "talked"), FREE, "u-rep"), true);
eq("...it does not re-claim one you already hold",
  claimsOnTouch(touchWrite("call", "talked"), MINE, "u-rep"), false);
/* THE ONE THAT WOULD MOVE A FIRM BETWEEN REPS. Logging a touch must never take
 * a lead off the person holding it. */
eq("...and it NEVER takes a lead off somebody else",
  claimsOnTouch(touchWrite("call", "talked"), THEIRS, "u-rep"), false);
eq("an inbound event never claims, even on a free lead",
  claimsOnTouch(touchWrite("email", "replied"), FREE, "u-rep"), false);
eq("no signed-in user claims nothing", claimsOnTouch(touchWrite("call", "talked"), FREE, null), false);
eq("no lead claims nothing", claimsOnTouch(touchWrite("call", "talked"), null, "u-rep"), false);
eq("no write claims nothing", claimsOnTouch(null, FREE, "u-rep"), false);

console.log("\nNOTHING HERE MOVES THE SALES CYCLE STATUS");
/* Ryder's call, 30 Aug: claim it, leave the status alone. The status is a thing
 * the rep decides, not a thing the system infers from a voicemail. */
{
  const LIB = src("lib/touch-log.js");
  ok("the rules module never mentions the stage column", !/\bstage\b\s*:/.test(LIB));
  const DATA = src("src/lib/data.js");
  const fn = DATA.slice(DATA.indexOf("export async function logTouch"), DATA.indexOf("/* TICKETS"));
  ok("and the writer never patches a stage", !/stage/.test(fn));
  ok("the writer claims the lead through the ONE claim path, with expectUnclaimed",
    /claimLead\(lead\.id, userId, \{ name: actorName, expectUnclaimed: true \}\)/.test(fn));
  ok("the text counter is claimed BEFORE anything is logged",
    fn.indexOf("claimTextSend") < fn.indexOf("addLeadActivity"));
  ok("the stamps are written AFTER the timeline row exists",
    fn.indexOf("addLeadActivity") < fn.indexOf("stampPatch"));
  ok("an unknown pick returns before it can write anything",
    fn.indexOf("if (!write)") < fn.indexOf("claimTextSend"));
}

console.log("\nTHE PICKER CANNOT LOG THE SAME TOUCH TWICE");
/* The note step re-calling the write is the mistake ChipPicker's shape invites:
 * there, onNote re-calls onPick with the same stage, which is harmless because
 * setting a stage twice is setting it once. Two touches are two touches. */
{
  const P = src("src/components/admin/touchPicker.jsx");
  /* The third step became "and next?" on 30 Aug — a date AND an optional note.
   * It still may not carry the channel and outcome, for the same reason. */
  ok("the third step is handed a payload, never the channel and outcome",
    /await onDone\(payload\);/.test(P) && !/onDone\(step\.channel/.test(P));
  ok("...and it is documented as acting on a touch that is already written",
    /on a touch that is already\s*\n?\s*\*?\s*written/.test(P) || /already\s+written/.test(P));
  const SH = src("src/components/admin/salesSheet.jsx");
  ok("the sheet wires it to its own handler, not to onTouch",
    /onDone=\{onTouchDone \? \(payload\) => onTouchDone\(row, payload\) : null\}/.test(SH));
  const PAGE = src("src/components/admin/SalesPage.jsx");
  const from = PAGE.indexOf("const doTouchDone");
  const note = PAGE.slice(from, from + 2200);
  ok("and that handler writes a date and a plain note, never a touch",
    /next_follow_up_at/.test(note) && /type: "note"/.test(note) && !/logTouch/.test(note));
}

console.log("\nTHE CELL STAYS DERIVED, AND THE TEXT RULE STAYS VISIBLE");
{
  const SH = src("src/components/admin/salesSheet.jsx");
  /* Sliced FORWARD from the case label, not to the next `case "stage"` —
   * that string appears earlier in the file (the sort switch, line ~324), so
   * slicing to it produced an EMPTY string and four assertions passed and then
   * failed for a reason that had nothing to do with the code. A guard whose
   * range is wrong is a guard that cannot fire. */
  const from = SH.indexOf('case "contacted"');
  const cell = SH.slice(from, SH.indexOf('case "stage":', from));
  ok("nothing writes a contacted field — there is none", !/contacted:/.test(cell));
  ok("the chip still comes from the derived row value", /row\.contacted/.test(cell));
  ok("a row you may not edit gets the old read-only button", /locked\(row\)/.test(cell));
  /* A DISABLED ROW WITH ITS REASON, not a hidden one. A rule you cannot see is
   * a rule nobody learns. */
  /* BOTH send rules are passed in as reasons now — the text gate and the bounce
   * gate. `canEmail` was written the same evening and wired nowhere; a checker
   * found its only caller was its own test. */
  ok("the one-text gate is passed in as a reason, not by hiding the row",
    /blocked\.text = tGate\.reason;/.test(cell));
  ok("the bounce gate is too — a dead address must refuse the email option",
    /blocked\.email = eGate\.reason;/.test(cell));
  ok("and both gates are READ from lib/sales-rules.js, never re-implemented",
    /const tGate = textGate\(l\);/.test(cell) && /const eGate = canEmail\(l\);/.test(cell));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
