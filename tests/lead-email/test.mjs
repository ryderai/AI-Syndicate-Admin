/* DRAFT THE NEXT EMAIL — the rules half.
 *
 * The dangerous thing about this feature is not that the email is bad. It is
 * that the email is SENT, to a stranger, with our name on it. So this file
 * attacks the four things that keep it honest:
 *
 *   1. The fact sheet says "no score" out loud when nobody has scanned, and the
 *      gate refuses every way of implying one anyway.
 *   2. Nothing numeric, dated or promised survives unless the facts back it.
 *   3. It drafts. Nowhere in this feature is there a send.
 *   4. A bounced address is refused before any work is done.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  EMAIL_JOBS, emailJobFor, assembleEmailFacts, withTimelineText, emailFactsText,
  buildEmailInstruction, parseEmailDraft, checkEmailDraft, deterministicEmailDraft,
  emailPromisesIn, deadOpenersIn, cleanAngle, MAX_EMAIL_WORDS, MAX_ANGLE_CHARS,
} from "../../lib/lead-email.js";
import { canEmail } from "../../lib/sales-rules.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, "..", "..", p), "utf8");

const ME = { full_name: "Ryder Schilling", email: "ryder@aisyndicate.com" };
const LEAD = {
  id: "l1", name: "Dana Whitfield", title: "Marketing Director", email: "dana@harborline.com",
  stage: "new", city: "Destin", state: "FL", company_id: "co1",
};
const FIRM = { id: "co1", name: "Harborline Realty", domain: "harborline.com", vertical: "realtor", site_score: null };

const factsFor = (lead, opts = {}) => {
  let f = assembleEmailFacts(lead, { company: FIRM, me: ME, ...opts });
  f = withTimelineText(f, opts.activity || [], lead.id);
  return { facts: f, text: emailFactsText(f) };
};

console.log("\n1 · WHAT THE EMAIL IS FOR");
eq("no first contact on record means a first email", emailJobFor(LEAD).id, "__new");
/* THE STAGE CANNOT ANSWER THIS ANY MORE. The four early stages stopped being
 * settable on 30 Aug, so a lead worked for a month still reads `new`. The
 * timeline can: first_contact_at is written by a trigger from a real touch. */
eq("a lead with a first contact is a follow-up, whatever the stage says",
  emailJobFor({ ...LEAD, first_contact_at: "2026-08-01T00:00:00Z" }).id, "__working");
for (const st of ["follow_up", "meeting", "proposal", "won", "lost", "not_a_fit"]) {
  eq(`${st} has its own job`, emailJobFor({ ...LEAD, stage: st }).id, st);
}
ok("every job has one ask and a shape",
  Object.values(EMAIL_JOBS).every((j) => j.ask && j.shape && j.label));
/* ONE ASK. An email with two asks has none — so no job's ask may name two. */
ok("no job asks for two things at once",
  Object.values(EMAIL_JOBS).every((j) => !/ and then | and also /i.test(j.ask)));

console.log("\n2 · THE FACT SHEET");
{
  const { text } = factsFor(LEAD);
  ok("it names the person and the firm", text.includes("Dana Whitfield") && text.includes("Harborline Realty"));
  ok("it says NOBODY SCANNED in as many words", text.includes("There is NO score"));
  ok("...and tells the model not to imply one", /Do not state one, and do not imply one/.test(text));
  ok("it carries who it is from", text.includes("ryder@aisyndicate.com"));
  ok("an empty timeline says so rather than being missing", text.includes("Nothing has been logged."));

  const scored = factsFor(LEAD, { company: { ...FIRM, site_score: 42, site_score_at: "2026-08-20T00:00:00Z" } });
  ok("a real score is stated with the day it was measured",
    scored.text.includes("42") && scored.text.includes("2026-08-20"));
  ok("...and the no-score warning is gone", !scored.text.includes("There is NO score"));

  /* WHAT MUST NEVER BE IN AN EMAIL FACT SHEET. Our margins, other clients, and
   * anybody else at the firm — a cold email that names a colleague reads as
   * surveillance. */
  const withNoise = factsFor(
    { ...LEAD, notes: "Wants the audit first." },
    { proposals: [{ lead_id: "l1", title: "Radar Pro", amount_cents: 450000, status: "sent", created_at: "2026-08-10T00:00:00Z" },
      { lead_id: "OTHER", title: "Somebody else's deal", amount_cents: 999900, status: "sent" }],
    tags: [{ label: "Gatekeeper" }] },
  );
  ok("their own proposal is a fact", withNoise.text.includes("Radar Pro") && withNoise.text.includes("$4,500"));
  ok("SOMEBODY ELSE'S proposal is not", !withNoise.text.includes("Somebody else's deal") && !withNoise.text.includes("9,999"));
  ok("their notes are", withNoise.text.includes("Wants the audit first."));
  ok("their tags are", withNoise.text.includes("Gatekeeper"));

  const timed = factsFor(LEAD, {
    activity: [{ lead_id: "l1", type: "call", outcome: "voicemail", body: "Left a message about the audit.", created_at: "2026-08-28T15:00:00Z" }],
  });
  ok("the timeline lands with its date, kind and outcome",
    /2026-08-28 · call · voicemail/.test(timed.text) && timed.text.includes("Left a message about the audit."));
}

console.log("\n3 · THE GATE");
const { text: FACTS } = factsFor(LEAD);
const good = { subject: "harborline and ai search", body: "Hi Dana,\n\nI work with realtors on how they show up when buyers ask ChatGPT for an agent. Worth a short chat?\n\nRyder" };
eq("an honest short email passes", checkEmailDraft(good, FACTS).ok, true);

const refuse = (name, draft, expect) => {
  const v = checkEmailDraft(draft, FACTS);
  ok(name, v.ok === false && (!expect || v.why.includes(expect)), `verdict: ${JSON.stringify(v)}`);
};
refuse("an invented score is refused", { ...good, body: "Hi Dana, your site scores 42 out of 100. Ryder" });
refuse("...and so is implying one with no number at all",
  { ...good, body: "Hi Dana, we scanned your site and found some gaps. Ryder" }, "nobody has scanned");
refuse("...and 'falling behind'", { ...good, body: "Hi Dana, your site is falling behind competitors. Ryder" }, "nobody has scanned");
refuse("a promise is refused", { ...good, body: "Hi Dana, we guarantee you page one. Ryder" }, "promises");
refuse("...as is 'we will get you'", { ...good, body: "Hi Dana, we will get you to the top of google. Ryder" }, "promises");
refuse("a dead opener is refused", { ...good, body: "Hi Dana,\n\nI hope this email finds you well. Ryder" }, "deleted");
refuse("...including 'just following up'", { ...good, body: "Hi Dana, just following up on my last note. Ryder" }, "deleted");
refuse("a number nobody gave us is refused", { ...good, body: "Hi Dana, 73% of buyers now ask an AI first. Ryder" }, "numbers");
refuse("a date nobody gave us is refused", { ...good, body: "Hi Dana, following our chat on 2026-07-04. Ryder" }, "dates");
refuse("an empty body is refused", { subject: "hello", body: "   " });
refuse("no subject is refused", { subject: "", body: "Hi Dana. Ryder" });
refuse("nothing at all is refused", null);
refuse("a wall of text is refused", { ...good, body: `Hi Dana ${"word ".repeat(MAX_EMAIL_WORDS + 20)}` }, "the limit is");

/* QUOTING IS NOT CLAIMING. A note on the record that says something we could
 * not assert ourselves can still be quoted back — the same rule the other three
 * report gates use, via withoutQuotes. */
{
  const q = factsFor({ ...LEAD, notes: "She said they are falling behind on Google." });
  const v = checkEmailDraft(
    { subject: "picking this up", body: 'Hi Dana,\n\nYou mentioned "they are falling behind on Google" — worth a chat?\n\nRyder' },
    q.text,
  );
  ok("quoting a note back is allowed, because the note is a record", v.ok === true, JSON.stringify(v));
}
/* A REAL SCORE MAY BE STATED. The gate is about invention, not about caution. */
{
  const s = factsFor(LEAD, { company: { ...FIRM, site_score: 42, site_score_at: "2026-08-20T00:00:00Z" } });
  const v = checkEmailDraft({ subject: "42", body: "Hi Dana,\n\nYour site scores 42 out of 100 for AI search. Worth a chat?\n\nRyder" }, s.text);
  ok("a score we actually measured may be stated", v.ok === true, JSON.stringify(v));
}

console.log("\n4 · READING THE MODEL BACK");
eq("plain JSON parses", parseEmailDraft('{"subject":"a","body":"b"}'), { subject: "a", body: "b" });
eq("JSON wrapped in chatter still parses", parseEmailDraft('Sure!\n{"subject":"a","body":"b"}\nHope that helps'), { subject: "a", body: "b" });
eq("prose with no JSON is null, never a guess", parseEmailDraft("Here is your email: Hi Dana"), null);
eq("broken JSON is null", parseEmailDraft('{"subject":'), null);
eq("empty halves are null, not an empty email", parseEmailDraft('{"subject":"","body":"x"}'), null);
eq("an angle is trimmed and capped", cleanAngle(` ${"x".repeat(MAX_ANGLE_CHARS + 50)} `).length, MAX_ANGLE_CHARS);

console.log("\n5 · THE FALLBACK CANNOT FAIL ITS OWN CHECK");
{
  const { facts, text } = factsFor(LEAD);
  const d = deterministicEmailDraft(facts, { why: "no key" });
  ok("it says it was counted, not written", d.counted === true);
  eq("the skeleton passes the gate", checkEmailDraft(d, text).ok, true);
  ok("it greets them by their first name", d.body.startsWith("Hi Dana,"));
  ok("it signs off as the rep", d.body.includes("Ryder Schilling"));

  const f2 = factsFor({ ...LEAD, first_contact_at: "2026-08-01T00:00:00Z", last_touch_at: "2026-08-20T00:00:00Z" });
  const d2 = deterministicEmailDraft(f2.facts, {});
  eq("the follow-up skeleton passes too", checkEmailDraft(d2, f2.text).ok, true);
  ok("...and it leaves the new angle blank rather than inventing one", d2.body.includes("[One NEW angle"));
}

console.log("\n6 · IT DRAFTS. IT DOES NOT SEND.");
{
  const API = src("api/lead-email.js");
  const PANEL = src("src/components/admin/emailDraft.jsx");
  ok("the endpoint never sends mail", !/gmail-send|sendMessage|\bsend\(/.test(API));
  ok("...and says so where somebody would look to add it", /IT DRAFTS\. IT NEVER SENDS\./.test(API));
  ok("the panel has no send button", !/>\s*Send/.test(PANEL) && !/Send it<|>Send</.test(PANEL));
  ok("...and says why in the panel itself", /Nothing is sent from here/i.test(PANEL));
  /* THE PRIMARY BUTTON SAYS EXACTLY WHAT IT DOES — 31 Aug 2026. The console
   * cannot watch a mail client, so the nearest honest moment to a send is the
   * copy. The label claims the copy and the log, and nothing else; a bare
   * "Copy" would leave the rep to remember to log it, and they will not. */
  ok("the primary action copies AND logs, and says so", /Copy &amp; mark it sent/.test(PANEL));
  ok("...with a copy-only button beside it for grabbing the text", /Copy only/.test(PANEL));
  /* COPY FIRST, THEN LOG. A refused clipboard means the rep has not got the
   * email, so nothing may claim they sent it. */
  ok("a failed copy logs nothing", /Nothing was logged\./.test(PANEL));
  ok("the edited text is what gets logged, not the model's",
    /onSent\?\.\(\{ subject, body \}\)/.test(PANEL));
  /* LOGGING AND BOOKING ARE TWO CALLBACKS, not one with a flag — the same
   * mistake the Contacted? picker's third step was built to make impossible. */
  ok("booking the follow-up is its own callback", /await onNext\?\.\(next\);/.test(PANEL));
  ok("...and the panel says skipping it is safe", /No next step<\/strong> list instead/.test(PANEL));

  /* AND IT LOGS THROUGH THE ONE PATH. A second way to log an email is a second
   * way for the two to drift on claims, stamps and the cadence. */
  const PAGE2 = src("src/components/admin/SalesPage.jsx");
  /* TWO MISTAKES AT THE apiFetch BOUNDARY, both found by opening the panel and
   * seeing it blank rather than by any test:
   *   - apiFetch returns `{ ok, data }`, so spreading the response gave the
   *     panel no subject, no body and no job;
   *   - apiFetch stringifies `body` itself, so passing JSON.stringify() sent a
   *     JSON string of a JSON string. It survived locally because the dev
   *     plugin parses once and readJson parses again — which is worse than
   *     failing, since Vercel parses once. */
  ok("the draft is read out of res.data, not spread off the envelope",
    /setEmailDraft\(\{ \.\.\.res\.data, lead \}\)/.test(PAGE2));
  ok("...and the request body is an object, because apiFetch stringifies it",
    /body: \{ leadId: lead\.id/.test(PAGE2));
  ok("no apiFetch call in the sales page double-stringifies its body",
    !/apiFetch\([^)]*JSON\.stringify/.test(PAGE2));
  const sent = PAGE2.slice(PAGE2.indexOf("const doEmailSent"), PAGE2.indexOf("const doEmailNext"));
  ok("the send is logged through logTouch, like every other touch",
    /logTouch\(\{/.test(sent) && /channel: "email", outcome: "sent"/.test(sent));
  ok("...and carries the email itself as the note", /note: \[subject/.test(sent));
  ok("the follow-up reuses the touch picker's own writer",
    /await doTouchDone\(\{ lead \}, \{ next, note: null \}\)/.test(PAGE2));
  const DATA2 = src("src/lib/data.js");
  ok("logTouch puts the note ON the touch row, not a second one",
    /const body = note \? `\$\{write\.body\}/.test(DATA2));

  /* THE ROW LOCK, SERVER-SIDE. This runs on the service key, so row-level
   * security cannot help — the check has to be in the file. */
  ok("the endpoint checks whether this person may work the lead",
    /const mayWork = role !== "sales" \|\| lead\.owner_id === userId \|\| lead\.owner_id == null;/.test(API));
  ok("...and refuses with 403 rather than drafting anyway", /403[\s\S]{0,120}not yours to write to/.test(API));

  /* THE BOUNCE GATE RUNS BEFORE ANY WORK. */
  ok("the bounce gate is read from the shared rule", /const send = canEmail\(lead\);/.test(API));
  ok("...and it runs before the reads and the model",
    API.indexOf("const send = canEmail(lead)") < API.indexOf("admin_lead_activity"));
  eq("canEmail refuses a bounced address", canEmail({ email: "a@b.c", bounced_at: "2026-08-01" }).allowed, false);

  /* THE MODEL SEES THE FACT SHEET AND NOTHING ELSE, and the checker checks the
   * same string. A gate holding a different string is not a gate. */
  ok("the model is given the fact sheet", /system: \[[\s\S]{0,400}factsText,/.test(API));
  ok("the checker is given the same one", /checkEmailDraft\(parsed, factsText/.test(API));
  ok("no tools are handed to it", !/tools:/.test(API));

  /* A READ THAT FAILED IS NOT A LEAD WITH NOTHING ON IT. */
  ok("failed reads are named and carried back", /const missing = \[\];/.test(API) && /missing,/.test(API));
  ok("...and the panel says so", /Some of their record did not load/.test(PANEL));

  /* A SKELETON AND A WRITTEN DRAFT MUST NOT LOOK ALIKE. */
  ok("the panel flags a counted draft", /Nothing was written for you/.test(PANEL));

  /* THE COLUMN. */
  const SHEET = src("src/components/admin/salesSheet.jsx");
  ok("the cell refuses a bounced address rather than hiding", /eg\.bounced \? "bounced" : "cannot email"/.test(SHEET));
  ok("...and says nothing to write to when there is no address", /no email/.test(SHEET));
  ok("one draft at a time", /disabled=\{!onDraftEmail \|\| drafting === l\.id\}/.test(SHEET));
  const COLS = src("src/lib/salesSheet.js");
  ok("the column is an action, so it is neither sortable nor filterable",
    /key: "draft_email"[^}]*sortable: false, filterable: false, groupable: false/.test(COLS));
  /* AND THE HEADER HAS TO HONOUR THAT. It never read SORTABLE — every column got
   * a sort button — and it went unnoticed because every column was sortable
   * until this one. Clicking it sorted the table by a value that does not
   * exist, which is worse than no control: the person who pressed it now
   * distrusts the order. */
  ok("a column that declares itself unsortable gets no sort button",
    /const canSort = SORTABLE\.has\(col\.key\);/.test(SHEET) && /\{canSort \? \(/.test(SHEET));
  ok("...and renders a plain label rather than a dead button",
    /adm-db-th-plain/.test(SHEET));
  ok("and it is on by default", /"draft_email",/.test(COLS));
  /* A COLUMN ADDED AFTER SOMEBODY SAVED THEIR PREFERENCES HAS TO APPEAR ANYWAY.
   * It did not: a saved list from yesterday wins over today's defaults, so the
   * one control this whole rebuild points at was invisible to everybody who had
   * ever touched the column menu. Found by counting the columns on the page.
   * This repo already has a note about the shape — a saved preference deleted
   * the Claim button in August the same way. */
  ok("a saved preference cannot hide a column nobody has decided about",
    /function withNewColumns\(saved, seen\)/.test(SHEET));
  ok("...and the preference records what was on offer when it was saved",
    /savePrefs\(\{ columns, groupBy, seen: SHEET_COLUMN_KEYS \}\)/.test(SHEET));
  ok("...while a column somebody DID switch off stays off",
    /never overrules a decision somebody made/.test(SHEET));
}

console.log("\n7 · THE INSTRUCTION SAYS THE RULES THE GATE ENFORCES");
{
  const ins = buildEmailInstruction({ job: emailJobFor(LEAD) });
  ok("it bans unbacked numbers", /State NO number, date, score or statistic that is not in the facts/.test(ins));
  ok("it bans promises", /Promise NOTHING/.test(ins));
  ok("it bans the dead openers", /I hope this finds you well/.test(ins));
  ok("it names the word limit the gate uses", ins.includes(String(MAX_EMAIL_WORDS)));
  ok("it asks for JSON", /"subject"/.test(ins) && /"body"/.test(ins));
  ok("an angle from the rep is carried through",
    /lead with the meeting/.test(buildEmailInstruction({ job: emailJobFor(LEAD), angle: "lead with the meeting" })));
  /* A RULE IN A PROMPT IS NOT A CHECK — this repo's own note. Each ban above has
   * to have code behind it, and these are the three that do. */
  ok("and each ban has a check behind it",
    emailPromisesIn("we guarantee").length > 0
    && deadOpenersIn("i hope this finds you well").length > 0
    && checkEmailDraft({ subject: "x", body: "Hi. 73% of buyers. Ryder" }, FACTS).ok === false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
