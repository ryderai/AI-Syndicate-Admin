/* ADDING A CONTACT, MOVING A STAGE, AND NOT STARTING OVER — 2 Sep 2026.
 *
 * The nine things Ryder asked for on the Sales page. What is expensive here, in
 * order:
 *
 *   1. A stage a picker offers that the database refuses. The board, the
 *      importer, the assistant and this form all name stages, and the one that
 *      is out of step is a button that fails after the person believes it
 *      worked.
 *   2. A contact added and left on the floor. It was the old form's behaviour,
 *      and it means the person who typed it in does not have it.
 *   3. A screen that throws away typed words. Escape, a backdrop click, a
 *      scroll — each one used to lose something, silently.
 *   4. A province typed into a box labelled State, and an industry typed four
 *      ways. Both make every count over those columns wrong, quietly.
 *   5. A cache that outlives the person it was read for.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BUSINESS_TYPES, BUSINESS_TYPE_GROUPS, businessTypeLabel,
  isKnownBusinessType, businessTypeOptions,
} from "../../lib/business-types.js";
import {
  COUNTRIES, US_REGIONS, CA_REGIONS, REGION_LABEL,
  regionsFor, normaliseCountry, normaliseRegion, regionLabel, placeLine,
} from "../../lib/regions.js";
import { boardAgeLabel, readBoardCache, writeBoardCache, clearBoardCache, readView, writeView } from "../../src/lib/salesSession.js";
import {
  BOARD_STAGES, OFF_BOARD_STAGES, WORKING_COLUMN,
  STAGE_REQUIRES as STAGE_REQUIRES_LIVE, stageRequirementMet as metRaw,
} from "../../lib/stage-move.js";
import * as importer from "../../lib/sales-import.js";
import * as W from "../../lib/when.js";

/** stageRequirementMet with a lead shaped from just the field under test. */
const metLive = (stage, lead) => metRaw(stage, { id: "l1", ...lead }, { proposals: [] });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, "..", "..", p), "utf8");
/* Prose is not code. The 31 Aug session lost an hour to two guards that fired
 * on their own explanatory comments. */
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

const MIGDIR = join(HERE, "..", "..", "supabase", "migrations");
const allMigrations = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(join(MIGDIR, f), "utf8")).join("\n");

/** What Postgres actually ends up holding: the LAST stage constraint written. */
function stagesTheDatabaseAccepts() {
  let last = null;
  for (const f of readdirSync(MIGDIR).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGDIR, f), "utf8");
    for (const m of sql.matchAll(/admin_leads_stage_check[\s\S]{0,200}?check \(stage in \(([\s\S]*?)\)\)/g)) last = m[1];
  }
  return new Set([...last.matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]));
}

console.log("\nEVERY PICKER AND THE DATABASE AGREE ON THE STAGES");
{
  const allowed = stagesTheDatabaseAccepts();
  const DATA = stripJs(src("src/lib/data.js"));
  const pickable = [...DATA.match(/export const PICKABLE_STAGES = \[([\s\S]*?)\];/)[1]
    .matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);

  ok("the constraint was found and is the 0030 one",
    allowed.has("meeting_booked") && allowed.has("meeting_complete"), [...allowed].join(","));
  ok("THE OLD SINGLE `meeting` IS NO LONGER WRITABLE", !allowed.has("meeting"));

  for (const s of pickable) ok(`a person may pick "${s}", and the database accepts it`, allowed.has(s));
  for (const s of BOARD_STAGES) ok(`a card may be dropped on "${s}", and the database accepts it`, allowed.has(s));

  /* THE BOARD AND THE PICKERS MUST OFFER THE SAME SET. Two lists is two
   * answers to "what can this deal be", and the drag would then allow what the
   * dropdown refuses. */
  eq("the board's columns are exactly the pickable stages, in the same order",
    BOARD_STAGES, pickable.filter((s) => s !== "not_a_fit"));

  /* Migration 0030 removed `meeting`, but a row can come back from a backup, so
   * it still has to be DRAWN. Declared-but-undrawn is the defect an audit found
   * in August: a lead matching no column appears nowhere at all. */
  ok("a pre-0030 `meeting` row is still drawn on the board", WORKING_COLUMN.stages.includes("meeting"));
  ok("...and it is not a drop target", !BOARD_STAGES.includes("meeting"));
  ok("...and it is named in a migration, so it is not a typo", allMigrations.includes("'meeting'"));
  ok("every off-board stage is drawn in a column",
    OFF_BOARD_STAGES.every((s) => WORKING_COLUMN.stages.includes(s) || allMigrations.includes(`'${s}'`)));
}

console.log("\nTHE MEETING SPLIT IS ONE FACT IN EVERY PLACE THAT COUNTS IT");
{
  const RULES = stripJs(src("lib/sales-rules.js"));
  const STATS = stripJs(src("src/components/admin/SalesStats.jsx"));
  const PAGE = stripJs(src("src/components/admin/SalesPage.jsx"));
  const SWEEP = stripJs(src("api/sales-sweep.js"));
  const OUT = stripJs(src("lib/outreach.js"));
  const ASSIST = stripJs(src("lib/assistant-tools.js"));

  /* A CUMULATIVE FUNNEL. "Got to a meeting or past it" has to include the half
   * that means the meeting HAPPENED, or a rep with four finished meetings shows
   * as having had none. */
  for (const [name, code] of [["the rep scoreboard", RULES], ["the Stats page", STATS], ["the pipeline tile", PAGE]]) {
    ok(`${name} counts both halves of a meeting`,
      /meeting_booked/.test(code) && /meeting_complete/.test(code));
  }
  ok("the tile's FILTER and its COUNT name the same stages",
    (PAGE.match(/\["meeting", "meeting_booked", "meeting_complete", "proposal"\]/g) || []).length === 2,
    "a tile that says 4 and opens a list of 2 is worse than no tile");
  ok("the nightly sweep still reclaims a lead sitting at either meeting stage",
    /meeting_booked/.test(SWEEP) && /meeting_complete/.test(SWEEP));
  ok("...and still reclaims a pre-0030 one", /"meeting"/.test(SWEEP));
  ok("the stage ladder in the outreach report draws both",
    /meeting_booked/.test(OUT) && /meeting_complete/.test(OUT));
  ok("the assistant may set both", /meeting_booked/.test(ASSIST) && /meeting_complete/.test(ASSIST));
  ok("...and may not set the stage that no longer exists", !/"meeting"/.test(ASSIST));
}

console.log("\nWHAT A STAGE NEEDS IS ASKED FOR, NEVER REFUSED");
{
  const PAGE = stripJs(src("src/components/admin/SalesPage.jsx"));
  const MODAL = stripJs(src("src/components/admin/stageNeed.jsx"));

  ok("the gate opens the box instead of warning",
    /setStaging\(\{ lead, stage: patch\.stage, note \}\)/.test(PAGE));
  {
    /* SCOPED TO THE GATE, not to the whole file. The Add-contact form warns with
     * the same words and is right to: it is validating a form BEFORE an insert,
     * not refusing a move that a person already made. A file-wide match here
     * failed on the correct code — the same shape as a guard firing on its own
     * comment, one level up. */
    const gate = PAGE.slice(PAGE.indexOf("const patchLead = useCallback"), PAGE.indexOf("const assignLead = useCallback"));
    ok("...and the gate's old refusal toast is gone",
      !/toast\.warn/.test(gate),
      "a button that is clicked and does nothing was the whole complaint");
    ok("...and it is the box that replaced it", /setStaging\(/.test(gate));
  }
  ok("the box is reached from the sheet chip, the drawer and a drag — one path, patchLead",
    /const patchLead = useCallback/.test(PAGE) && /<StageNeedModal/.test(PAGE));
  ok("a drag no longer passes its own composed sentence as a note",
    !/const moveNote = stageMoveBody/.test(PAGE),
    "patchLeadRaw composes the line; handing it the same sentence wrote it twice");

  ok("the box will not save a booked meeting in the past",
    /need\.when === "future" && at <= openedAt/.test(MODAL));
  ok("...and checks the clock again at save time, not only at open time",
    /Date\.parse\(when\) <= Date\.now\(\)/.test(MODAL));
  ok("a COMPLETED meeting is allowed to be in the past — that is what it means",
    /need\.when === "any"/.test(MODAL));
  ok("the proposal it is waiting for is CREATED, not complained about",
    /upsertProposal/.test(PAGE));
  ok("...and the stage does not move if that proposal fails to save",
    /if \(!res\.ok\) return \{ ok: false, error: res\.error \};/.test(PAGE));
  ok("a failed save keeps the typed words on screen", /if \(res && res\.ok === false\) setFailed/.test(MODAL));
  ok("the drawer's stage select no longer hand-writes the timeline line",
    !/\$\{LEAD_STAGE_LABELS\[lead\.stage\] \|\| lead\.stage\} → /.test(stripJs(src("src/components/admin/salesProfile.jsx"))));
}

console.log("\nA CONTACT IS CLAIMED BY WHOEVER ADDS IT");
{
  const PAGE = stripJs(src("src/components/admin/SalesPage.jsx"));
  const add = PAGE.slice(PAGE.indexOf("function AddContactModal"), PAGE.indexOf("function CloseReasonModal"));
  ok("the form has an owner, and it starts as the person filling it in",
    /owner_id: member\.user_id/.test(add));
  ok("...with the claim clock claimLead would have set",
    /claimed_at: now, cadence_started_at: now, claim_contacted_at: null/.test(add),
    "a claim with no clock behind it is the sheet's original failure mode");
  ok("...and it can still be left on the floor deliberately",
    /Nobody — leave it on the floor/.test(add));
  ok("...and it can be added FOR somebody else", /owners\.map/.test(add));
  ok("the old 'go and claim your own contact' message is gone",
    !/Claim it before you reach out/.test(add));

  ok("the form collects a country", /COUNTRIES\.map/.test(add));
  ok("...and the region list follows the country", /regionsFor\(f\.country\)/.test(add));
  ok("...and changing the country clears the old region, rather than keeping a wrong one",
    /country: e\.target\.value, state: ""/.test(add));
  ok("...and the region is stored as a code", /normaliseRegion\(f\.country, f\.state\)/.test(add));
  ok("the form collects an industry from the one list", /BUSINESS_TYPE_GROUPS\.map/.test(add));
  ok("the form collects a deal stage", /PICKABLE_STAGES/.test(add));
  /* WON, LOST AND NOT A FIT ARE ALL OFF THE FORM. The first pass excluded only
   * Won; a checker pointed out that Lost needs a written reason too
   * (`checkCloseReason`), so the form could create a lead at Lost with
   * `lost_reason` null — the column the whole Aug 27 reason box exists to
   * fill. Not a fit carries a reason for the same reason. */
  ok("...and none of the three stages that need a written reason are offered",
    /!\["won", "lost", "not_a_fit"\]\.includes\(v\)/.test(add));
  /* A rep may not hand a lead to a colleague — migration 0020's insert policy
   * refuses it, so offering the whole roster produced a raw Postgres error. */
  ok("the owner picker only offers other people to somebody who may assign",
    /canAssign \|\| m\.user_id === member\.user_id/.test(add));
  ok("...and whatever that stage needs is collected on the same form",
    /need\?\.kind === "date"/.test(add) && /need\?\.kind === "proposal"/.test(add));
  ok("a stage needing a date is refused BEFORE the insert, not after",
    add.indexOf("if (!Number.isFinite(at))") < add.indexOf("await upsertLead"));
}

console.log("\nNOTHING TYPED IS THROWN AWAY");
{
  const POP = stripJs(src("src/components/admin/opsCells.jsx"));
  const CHIP = stripJs(src("src/components/admin/chipPicker.jsx"));
  const TOUCH = stripJs(src("src/components/admin/touchPicker.jsx"));
  const PROF = stripJs(src("src/components/admin/salesProfile.jsx"));

  ok("a popover holding unsaved words ignores an outside click",
    /const held = \(\) => Boolean\(holdRef && holdRef\.current\)/.test(POP) && /if \(held\(\)\) return;/.test(POP));
  ok("...and a scroll, which is what actually lost the notes",
    /if \(armed && !held\(\)\) close\(\)/.test(POP));
  ok("...but Escape still closes it, because that is a decision",
    /e\.key === "Escape"[\s\S]{0,60}close\(\)/.test(POP));
  ok("the stage note box tells the popover when it has words", /holdRef\.current = Boolean\(text\.trim\(\)\)/.test(CHIP));
  ok("...and lets go on the way out, so the next popover is not stuck open",
    /return \(\) => \{ if \(holdRef\) holdRef\.current = false; \}/.test(CHIP));
  ok("the touch note box does the same, and counts a picked date as unsaved work",
    /holdRef\.current = Boolean\(text\.trim\(\) \|\| next\)/.test(TOUCH));

  ok("a firm's fields save on the way out of the field, like the person's do",
    /onBlur=\{\(\) => \{ if \(cDirty\) saveCompany\(\{ quiet: true \}\); \}\}/.test(PROF));
  ok("...and a failed firm save is never quiet", /if \(!quiet\) toast\.success/.test(PROF));
  ok("the next step saves on blur too", /if \(dirty && await onPatch\(\{ next_step:/.test(PROF));
  ok("a person's field says whether it is saved — the save is otherwise invisible",
    /Not saved yet — click away from the box to save it/.test(PROF));
  ok("...and only marks itself saved on a write that landed", /if \(ok\) setDirty\(false\)/.test(PROF));
  ok("a locked record's next step is text, not a box that cannot save",
    /if \(readOnly\) \{[\s\S]{0,300}lead\.next_step/.test(PROF));
  ok("assigning goes through the page's one claim path, with its race guard",
    /onAssign\?\.\(e\.target\.value \|\| null\)/.test(PROF));
  ok("...and the drawer no longer hand-writes the claim columns",
    !/cadence_started_at: stamp/.test(PROF));
}

console.log("\nTHE PAGE DOES NOT START OVER WHILE SOMEBODY IS WORKING");
{
  const AUTH = stripJs(src("src/lib/auth.js"));
  const PAGE = stripJs(src("src/components/admin/SalesPage.jsx"));

  /* THE REAL CAUSE WAS NOT ON THIS PAGE. Supabase refreshes the token when a
   * tab comes back to the front; the console read that as "who is this?" and
   * showed the splash instead of the app, so every page unmounted. */
  ok("a token refresh for the same person no longer unmounts the console",
    /const sameUser = u && sharedAuth\.state\.user && sharedAuth\.state\.user\.id === u\.id/.test(AUTH));
  ok("...and the roster is still re-read, quietly", /if \(u\) loadMembership\(u\)/.test(AUTH));
  ok("...but a DIFFERENT person still gets a full check",
    /membership: u \? \(sameUser && known \? sharedAuth\.state\.membership : undefined\) : null/.test(AUTH));
  ok("...and their cached board is thrown away", /if \(!sameUser\) clearBoardCache\(\)/.test(AUTH));

  ok("the page draws the board it already read instead of re-reading 11 tables",
    /const cached = readBoardCache\(\);[\s\S]{0,200}setBoard\(cached\.board\)/.test(PAGE));
  ok("...and every write still re-reads, so nothing is shown from a stale copy",
    /writeBoardCache\(b\)/.test(PAGE));
  ok("there is a Reload sales button", /Reload sales/.test(PAGE));
  /* THE TIME IT WAS READ, NOT HOW LONG AGO. The first pass printed a relative
   * age computed during render from module state, with nothing ticking and
   * nothing subscribed — so it froze after the first paint, and the one number
   * that makes the no-reload design safe was the one that lied. A checker
   * caught it. A clock time cannot go stale, and it comes from STATE so the
   * label re-renders with it. */
  ok("...and it says the CLOCK TIME the board was read", /read at \$\{new Date\(loadedAt\)/.test(PAGE));
  ok("...held in state, so the label cannot freeze",
    /const \[loadedAt, setLoadedAt\] = useState/.test(PAGE) && /setLoadedAt\(cached\.at\)/.test(PAGE));
  ok("the search box, the filters, the view and the open record all come back",
    ["q", "listFilter", "stageFilter", "ownerFilter", "openId", "view"]
      .every((k) => new RegExp(`seed\\.${k}`).test(PAGE)));
  ok("...and they are written back as they change",
    /writeView\(\{ q, listFilter, stageFilter, ownerFilter, openId, view \}, viewKey\)/.test(PAGE));
  /* SALES AND THE FLOOR ARE THE SAME COMPONENT with a different `mode`, and
   * both wrote the DEFAULT key — so the Floor's filters and open record seeded
   * the owner's Sales page and back again. The key parameter existed for
   * exactly this and was never passed. Found by a checker. */
  ok("...under a key of their own, so Sales and the Floor cannot poison each other",
    /const viewKey = mode === "floor" \? "floor" : "sales"/.test(PAGE) && /readView\(viewKey\)/.test(PAGE));

  /* Comments stripped, or this fires on the paragraph explaining the rule. */
  const SESS = stripJs(src("src/lib/salesSession.js"));
  ok("NONE OF IT IS IN localStorage — it dies with the tab",
    !/localStorage|sessionStorage/.test(SESS),
    "a filter that comes back tomorrow makes a page look empty for an invisible reason");

  /* Proved, not asserted. */
  clearBoardCache();
  eq("the cache starts empty", readBoardCache(), null);
  writeBoardCache({ leads: [1, 2, 3] });
  eq("what was written comes back", readBoardCache().board.leads.length, 3);
  ok("...with the time it was read on it", Number.isFinite(readBoardCache().at));
  writeView({ q: "chen" });
  writeView({ view: "pipeline" });
  eq("the view merges rather than replacing", readView(), { q: "chen", view: "pipeline" });
  clearBoardCache();
  eq("clearing takes the view with it", [readBoardCache(), readView()], [null, {}]);

  const now = Date.parse("2026-09-02T12:00:00Z");
  eq("just read", boardAgeLabel(now, now), "just now");
  eq("two minutes", boardAgeLabel(now - 120000, now), "2 minutes ago");
  eq("one minute is singular", boardAgeLabel(now - 60000, now), "1 minute ago");
  eq("never read", boardAgeLabel(null, now), "not loaded yet");
}

console.log("\nEVERY WRITER OF A STAGE, NOT JUST THE SCREENS");
{
  const ASSIST = stripJs(src("lib/assistant-tools.js"));
  const IMPORT = stripJs(src("lib/sales-import.js"));
  const GATE = stripJs(src("lib/stage-move.js"));
  const DATA = stripJs(src("src/lib/data.js"));

  /* THE GATE MOVED so the assistant could reach it. A rule enforced in one of
   * four writers is not a rule — the chat box could produce a lead at
   * meeting_complete with no date, which is what 0030 exists to abolish. */
  ok("the gate lives in a pure module both src/ and lib/ can import",
    /export const STAGE_REQUIRES/.test(GATE) && /export function stageRequirementMet/.test(GATE));
  ok("...and data.js re-exports it, so nothing that imported it broke",
    /export \{ STAGE_REQUIRES, stageRequirementMet \} from/.test(DATA));
  ok("...and there is only ONE definition of it",
    !/export const STAGE_REQUIRES = \{/.test(DATA));

  ok("THE ASSISTANT CHECKS THE REQUIREMENT before writing a stage",
    /const need = STAGE_REQUIRES\[input\.stage\]/.test(ASSIST) && /stageRequirementMet\(input\.stage/.test(ASSIST));
  ok("...reads the two date columns the gate needs, not a partial row",
    /meeting_at,next_follow_up_at/.test(ASSIST));
  ok("...reads the proposals only when a proposal is what is missing",
    /if \(need\.kind === "proposal"\)[\s\S]{0,200}admin_proposals/.test(ASSIST));
  ok("...refuses a completed meeting dated in the future",
    /cannot be marked complete/.test(ASSIST));
  ok("...and invents nothing — it asks for the date in the next message",
    /Say it in the same message/.test(ASSIST));

  ok("THE IMPORTER CANNOT LAND A LEAD IN A GATED STAGE",
    /export function landableStage/.test(IMPORT) && /landableStage\(stageFromSheet\(/.test(IMPORT));
  ok("...and the fact from the sheet moves into the note rather than being lost",
    /so it is sitting at \$\{down\} until somebody sets it/.test(IMPORT));

  /* PROVED, not asserted. */
  const { landableStage, stageFromSheet } = importer;
  for (const [status, want] of [["Meeting booked", "in_conversation"], ["Proposal sent", "in_conversation"],
    ["Following up", "contacted"], ["Won", "won"], ["Replied", "in_conversation"]]) {
    const out = landableStage(stageFromSheet("", status));
    ok(`a sheet saying "${status}" lands at ${out.stage}`, out.stage === want, JSON.stringify(out));
    ok(`...and ${out.stage} needs nothing the import cannot give`, !STAGE_REQUIRES_LIVE[out.stage]);
  }

  /* A completed meeting in the future is not complete, in the pure rule too. */
  const future = new Date(Date.now() + 5 * 86400000).toISOString();
  const past = new Date(Date.now() - 5 * 86400000).toISOString();
  ok("meeting_complete refuses a future date",
    !metLive("meeting_complete", { meeting_at: future }));
  ok("...and accepts a past one", metLive("meeting_complete", { meeting_at: past }));
  ok("meeting_booked refuses a past date", !metLive("meeting_booked", { meeting_at: past }));
  ok("...and accepts a future one", metLive("meeting_booked", { meeting_at: future }));
  ok("a follow-up still reads its own column, not the meeting's",
    metLive("follow_up", { next_follow_up_at: future }) && !metLive("follow_up", { meeting_at: future }));

  /* An update that matched no row is not a success. */
  ok("upsertLead refuses to call a zero-row update a save",
    /if \(patch\.id && !data\) \{/.test(DATA) && /that lead is gone, or it is not yours to change/.test(DATA));
}

console.log("\nA DATE AND A TIME THAT CANNOT BE HALF-ANSWERED");
{
  /* Ryder: "it wasnt adding because i didnt put in am or pm." A
   * `datetime-local` reports EMPTY until all five sub-fields are filled, so a
   * date plainly on screen read as no date and the form refused without ever
   * saying which piece was missing. */
  eq("a full answer becomes one ISO string", typeof W.joinWhen("2026-10-25", 780), "string");
  eq("a date with no time is NOT an answer", W.joinWhen("2026-10-25", null), null);
  eq("...nor is an empty time", W.joinWhen("2026-10-25", ""), null);
  eq("a time with no date is not an answer", W.joinWhen("", 780), null);
  eq("neither is nothing", W.joinWhen("", null), null);
  eq("a malformed date is not an answer", W.joinWhen("25/10/2026", 780), null);

  eq("it says BOTH halves are missing", W.whenProblem("", null), "Pick a date and a time.");
  eq("...or just the time — the half that actually caught Ryder", W.whenProblem("2026-10-25", null), "Pick a time.");
  eq("...or just the date", W.whenProblem("", 540), "Pick a date.");
  eq("...and nothing when it is complete", W.whenProblem("2026-10-25", 540), null);

  /* AM/PM IS IN THE LABEL, IN WORDS. There is nothing to type. */
  eq("midnight reads as 12 AM", W.clockLabel(0), "12:00 AM");
  eq("noon reads as 12 PM", W.clockLabel(720), "12:00 PM");
  eq("half past nine in the morning", W.clockLabel(570), "9:30 AM");
  eq("one in the afternoon", W.clockLabel(780), "1:00 PM");
  ok("every offered time says AM or PM", W.timeSlots().every((m) => /\b(AM|PM)$/.test(W.clockLabel(m))));
  ok(`the list is short enough to scan (${W.timeSlots().length} times, ${W.clockLabel(W.timeSlots()[0])} to ${W.clockLabel(W.timeSlots().at(-1))})`,
    W.timeSlots().length <= 40);

  /* A round trip must not move the answer. */
  const iso = W.joinWhen("2026-10-25", 807);
  eq("a time off the half-hour survives a round trip", W.splitWhen(iso).minutes, 807);
  eq("...and so does its date", W.splitWhen(iso).date, "2026-10-25");
  eq("an unreadable value splits to nothing rather than throwing", W.splitWhen("banana"), { date: "", minutes: null });
  eq("...and so does nothing at all", W.splitWhen(null), { date: "", minutes: null });

  /* localDate must not go through toISOString, which shifts the day in any
   * timezone behind UTC — this repo has already shipped that bug once. */
  eq("localDate is local, not UTC", W.localDate(new Date(2026, 0, 5, 23, 30)), "2026-01-05");

  const PICKER = stripJs(src("src/components/admin/whenPicker.jsx"));
  ok("the picker uses a date input, which has no AM/PM to forget", /type="date"/.test(PICKER));
  ok("...and a list of times rather than a typed field", /<Select/.test(PICKER) && /timeSlots/.test(PICKER));
  ok("...and keeps an odd time already on the record, marked",
    /\(as saved\)/.test(PICKER));
  /* IT HOLDS THE TWO HALVES ITSELF. The first version re-derived them from
   * `value` on every render — and `value` is null until BOTH are answered — so
   * picking a date and then opening the time list threw the date away and the
   * form said "pick a date". The same bug this component exists to kill, one
   * level down. Found by filling the form in a browser. */
  ok("the picker holds the half-answer in its own state",
    /const \[half, setHalf\] = useState/.test(PICKER));
  ok("...and only adopts `value` when the CALLER changed it",
    /if \(value === lastValue\.current\) return;/.test(PICKER));
  ok("...so a date survives choosing a time", /emit\(half\.date, e\.target\.value === "" \? null/.test(PICKER));
  ok("NO datetime-local IS LEFT IN THE SALES PAGE OR THE STAGE BOX",
    !/datetime-local/.test(stripJs(src("src/components/admin/SalesPage.jsx")))
    && !/datetime-local/.test(stripJs(src("src/components/admin/stageNeed.jsx"))));
  ok("both places use the one picker",
    /<WhenPicker/.test(stripJs(src("src/components/admin/SalesPage.jsx")))
    && /<WhenPicker/.test(stripJs(src("src/components/admin/stageNeed.jsx"))));
}

console.log("\nTHE REASON IT DID NOT SAVE IS ON THE FORM");
{
  const PAGE = stripJs(src("src/components/admin/SalesPage.jsx"));
  const add = PAGE.slice(PAGE.indexOf("function AddContactModal"), PAGE.indexOf("function CloseReasonModal"));
  /* Ryder: "it errors for some reason and i cant even see why." A toast is the
   * wrong home for the one sentence somebody has to act on. */
  ok("the form keeps the failure in state", /const \[failed, setFailed\]/.test(add));
  ok("...prints it under the buttons", /\{failed && \(/.test(add));
  ok("...says nothing typed is lost", /Nothing you typed is lost/.test(add));
  ok("...and a database refusal lands there too, not only in a toast",
    /setFailed\(res\.error \|\| "The database refused that\."\)/.test(add));
  ok("...and the missing HALF of the date is named",
    /setFailed\(`\$\{need\.ask\} \$\{half\}`\)/.test(add));
  /* IT READS THE TWO HALVES, NOT THE FINISHED ANSWER. `when` is null until both
   * are set, so asking the ISO which half is missing can only ever produce
   * "pick a date and a time" — the same unhelpful sentence, while a date sits
   * plainly on screen. Caught by driving it, not by reading it. */
  ok("...read from the two halves the picker reports, not from the ISO",
    /whenProblem\(f\.whenParts\.date, f\.whenParts\.minutes\)/.test(add));
  ok("...and the stage box does the same", /whenProblem\(parts\.date, parts\.minutes\)/.test(stripJs(src("src/components/admin/stageNeed.jsx"))));
  ok("the old warn-and-vanish path is gone", !/toast\.warn\("Give them a name/.test(add));
}

console.log("\nNOTHING BLEEDS OFF THE RIGHT, AND A POPUP IS ALWAYS ON TOP");
{
  const CSS = src("src/admin.css").replace(/\/\*[\s\S]*?\*\//g, " ");

  /* THE ROOT CAUSE OF THE WHOLE LAYOUT MESS: the task panel took class names
   * the lead record already used, and redefined its width, header and footer
   * from a distance. */
  ok("the task panel has its own class names", /\.adm-tp\b/.test(CSS) && /\.adm-tp-head/.test(CSS));
  ok("...and no longer redefines the lead record's",
    !/\.adm-tp[\s\S]*?\.adm-drawer-head \{/.test(CSS.slice(CSS.indexOf(".adm-tp"))));
  for (const f of ["src/components/admin/taskDrawer.jsx", "src/components/admin/taskUpdates.jsx"]) {
    ok(`${f} uses the renamed classes`, !/adm-drawer/.test(src(f)));
  }

  ok("the lead record is capped and never touches the edge on a narrow window",
    /\.adm-sl-drawer \{ width: min\(620px, calc\(100vw - 28px\)\); \}/.test(CSS));
  ok("...and nothing inside it may be wider than it is",
    /\.adm-sl-drawer, \.adm-sl-drawer \* \{ max-width: 100%; min-width: 0; \}/.test(CSS));
  ok("...and its tab bar wraps instead of running off", /\.adm-sl-tabs \{ flex-wrap: wrap/.test(CSS));

  ok("the toolbar wraps instead of overflowing its card",
    /\.adm-sl-baractions \{[^}]*flex-wrap: wrap/.test(CSS) && !/\.adm-sl-baractions \{[^}]*flex-shrink: 0/.test(CSS));
  ok("...and the filters are big enough to read and click",
    /\.adm-sl-sel \{[^}]*min-height: 38px/.test(CSS));

  /* A QUESTION ALWAYS SITS OVER WHAT ASKED IT. The task panel went to 1260 in
   * the morning and put every side panel above the modal layer, so "Log an
   * email" drew behind the record it was opened from. */
  const layer = (sel) => {
    const i = CSS.indexOf(sel);
    const z = /z-index:\s*(\d+)/.exec(CSS.slice(i, i + 400));
    return z ? Number(z[1]) : null;
  };
  const modal = layer(".adm-modal-backdrop");
  const panel = layer(".adm-tp {");
  const pop = layer(".adm-db-pop");
  ok(`a modal (${modal}) is above a side panel (${panel})`, modal > panel);
  ok(`a popover (${pop}) is above a modal (${modal})`, pop > modal);
  ok("...and the toaster is above all of them", /z-index: 9600/.test(CSS));
}

console.log("\nCANADA");
{
  eq("three countries are offered", COUNTRIES.map((c) => c.code), ["US", "CA", "other"]);
  eq("all ten provinces and all three territories", CA_REGIONS.length, 13);
  ok("the fifty states, DC and the ZIP territories", US_REGIONS.length === 54);
  eq("the field is called Province in Canada", REGION_LABEL.CA, "Province");
  eq("...and State in the US", REGION_LABEL.US, "State");

  eq("USA in any spelling is US", ["US", "usa", "United States", "U.S.A.", "america"].map(normaliseCountry), ["US", "US", "US", "US", "US"]);
  eq("Canada in any spelling is CA", ["CA", "canada", "Can"].map(normaliseCountry), ["CA", "CA", "CA"]);
  eq("NOTHING IS GUESSED — a country nobody established stays empty", normaliseCountry(""), null);
  eq("...and one this list does not know is not forced into it", normaliseCountry("Mexico"), null);

  eq("a full state name becomes its code", normaliseRegion("US", "California"), "CA");
  eq("a full province name becomes its code", normaliseRegion("CA", "Ontario"), "ON");
  eq("a lower-case code is still a code", normaliseRegion("CA", "on"), "ON");
  eq("a region the country does not have is kept as typed, not blanked",
    normaliseRegion("CA", "Florida"), "Florida");
  eq("nothing in, nothing out", normaliseRegion("US", ""), null);
  /* `Georgia` is a US state here and a country elsewhere. The region is only
   * ever resolved INSIDE a country that has already been established. */
  eq("Georgia inside the US is the state", normaliseRegion("US", "Georgia"), "GA");
  eq("...and with no country it is left exactly as typed", normaliseRegion(null, "Georgia"), "Georgia");

  eq("a code is shown as its name", regionLabel("CA", "ON"), "Ontario");
  eq("an unknown one is shown as typed", regionLabel("CA", "Atlantis"), "Atlantis");
  eq("the American line leaves the country off — it is on almost every row",
    placeLine({ city: "Destin", state: "FL", country: "US" }), "Destin, FL");
  eq("the Canadian line says so", placeLine({ city: "Toronto", state: "ON", country: "Canada" }), "Toronto, ON, Canada");
  eq("blank parts are dropped, not printed as commas", placeLine({ city: "Toronto" }), "Toronto");
  eq("nothing at all is an empty line", placeLine({}), "");

  ok("the country column the form writes is real, and predates today",
    /add column if not exists country text/.test(stripSql(allMigrations)));
  eq("regionsFor knows the two, and nothing else",
    [regionsFor("US").length, regionsFor("CA").length, regionsFor("other").length, regionsFor(null).length],
    [54, 13, 0, 0]);
}

console.log("\nONE INDUSTRY LIST");
{
  ok(`there are ${BUSINESS_TYPES.length} trades in ${BUSINESS_TYPE_GROUPS.length} groups`,
    BUSINESS_TYPES.length >= 40 && BUSINESS_TYPE_GROUPS.length >= 6);
  const values = BUSINESS_TYPES.map((t) => t.value);
  eq("no trade is listed twice", values.length, new Set(values).size);
  ok("every trade has a group that the group list knows",
    BUSINESS_TYPES.every((t) => BUSINESS_TYPE_GROUPS.includes(t.group)));

  /* The three Ryder named. */
  for (const v of ["tech", "finance", "construction"]) ok(`"${v}" is on the list`, isKnownBusinessType(v));

  /* THE STORED VALUE MATCHES WHAT IS ALREADY IN THE DATA. A prettier slug would
   * have started a fifth spelling of a trade that already has four. */
  for (const v of ["realtor", "medspa", "lawyer", "car dealership", "roofing"]) {
    ok(`"${v}" is spelled the way the existing rows spell it`, isKnownBusinessType(v));
  }

  eq("a known value reads as its label", businessTypeLabel("realtor"), "Realtor / real estate agent");
  eq("AN OLD FREE-TEXT VALUE IS SHOWN AS TYPED, not blanked and not re-mapped",
    businessTypeLabel("real estate"), "real estate");
  eq("nothing is an empty string, not the word undefined", businessTypeLabel(null), "");
  ok("a value not on the list is kept selectable, so the screen cannot contradict the record",
    businessTypeOptions("real estate")[0].value === "real estate");
  ok("...and a known one is not duplicated at the top",
    businessTypeOptions("realtor").filter((t) => t.value === "realtor").length === 1);
  ok("case does not decide whether a trade is known", isKnownBusinessType("Tech") && isKnownBusinessType("TECH"));

  ok("the picker can draw real groups", /<optgroup/.test(src("src/components/admin/shared.jsx")));
}

console.log("\nMIGRATION 0030 SAYS WHAT THIS FILE SAYS");
{
  const SQL = stripSql(src("supabase/migrations/0030_meeting_split.sql"));
  ok("the meeting date is its own column", /add column if not exists meeting_at timestamptz/.test(SQL));
  ok("...and NOT next_follow_up_at, where a past date means overdue everywhere",
    /set meeting_at = next_follow_up_at/.test(SQL));
  ok("the constraint is widened, the rows moved, then narrowed — in that order",
    SQL.indexOf("'meeting','meeting_booked','meeting_complete'") < SQL.indexOf("set stage = 'meeting_booked'")
    && SQL.indexOf("set stage = 'meeting_booked'") < SQL.lastIndexOf("add constraint"));
  ok("every lead in the old stage is moved", /update public\.admin_leads\s*set stage = 'meeting_booked'\s*where stage = 'meeting'/.test(SQL));
  ok("...and the timeline says which rows this file moved and why",
    /Stage split: Meeting became Meeting booked/.test(SQL));
  ok("...written BEFORE the rewrite, so the old value is still readable",
    SQL.indexOf("Stage split: Meeting became") < SQL.indexOf("set stage = 'meeting_booked'"));
  ok("the carried-over date is only taken when it is in the future",
    /next_follow_up_at > now\(\)/.test(SQL),
    "a past follow-up is an overdue follow-up, not a meeting");
  ok("...and only where the column is still empty, so a second run changes nothing",
    /meeting_at is null/.test(SQL));
  ok("the grants are re-asserted", /grant select, insert, update, delete on public\.admin_leads to authenticated/.test(SQL));
  ok("`meeting` ends up unwritable", !/'meeting','meeting_booked'/.test(SQL.slice(SQL.lastIndexOf("add constraint"))));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
