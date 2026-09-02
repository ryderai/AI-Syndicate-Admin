/* A TASK KEEPS ITS UPDATES.
 *
 * What is expensive here, in order:
 *   1. The task's one line disagreeing with its own newest update. Every
 *      report, the Operations table, the Work page row and the AI Brain read
 *      that line; if it is not the newest thing anybody said, all of them are
 *      quoting something that was replaced.
 *   2. Words lost because a migration has not been run. The console ships ahead
 *      of its migration every time, and a person typing a real update into a
 *      box that throws it away is the console's fault.
 *   3. A carried-over row shown as if somebody posted it. Its date is the
 *      task's updated_at — the only date that ever existed for it — and a
 *      screen that presents that as a posting time is a lie a report repeats.
 *   4. Two panels. "Any row" was the ask; a second panel on the Work page is a
 *      second set of rules for the same task, and they drift within a week.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MAX_UPDATE, cleanUpdateBody, canPost, sortUpdates, newestUpdate,
  latestLineFrom, lineAgrees, canEditUpdate, updateAuthorLabel, updateStamp,
  isMissingUpdatesTable,
} from "../../lib/task-updates.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, "..", "..", p), "utf8");

/* A GUARD THAT FIRES ON ITS OWN COMMENT is worthless — 31 Aug lost an hour to
 * two of them. Every source match below runs on the code with the prose taken
 * out, so a comment explaining a rule can never be mistaken for the rule. */
/* Two strippers, not one. `--` starts a comment in SQL and is the decrement
 * operator in JS, so a single stripper is either unsafe on one language or
 * useless on the other. */
function stripJs(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}
function stripSql(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}
ok("the JS stripper takes prose out and leaves code", (() => {
  const s = stripJs("/* latest_report here */\nconst a = 1; // latest_report\nconst u = 'http://x';\n");
  return !/latest_report/.test(s) && /const a = 1;/.test(s) && /http:/.test(s);
})());
ok("the SQL stripper takes a trailing -- comment out, not just a whole line", (() => {
  const s = stripSql("select 1; -- latest_report\n-- latest_report\n/* latest_report */\nselect 2;");
  return !/latest_report/.test(s) && /select 1;/.test(s) && /select 2;/.test(s);
})());

console.log("\nAN UPDATE IS EITHER WORDS OR IT IS NOTHING");
{
  eq("plain text survives", cleanUpdateBody(" 12 of 26 done. "), "12 of 26 done.");
  eq("whitespace is not an update", cleanUpdateBody("   \n\t "), null);
  eq("nothing is not an update", cleanUpdateBody(""), null);
  eq("null is not an update", cleanUpdateBody(null), null);
  eq("undefined is not an update", cleanUpdateBody(undefined), null);
  ok("a very long one is cut to the cap, not refused", cleanUpdateBody("x".repeat(MAX_UPDATE + 500))?.length === MAX_UPDATE);
  ok("the post button is dead on whitespace", !canPost("   "));
  ok("...and alive on words", canPost("shipped"));
}

console.log("\nNEWEST FIRST, AND TIES BREAK THE WAY THE TRIGGER BREAKS THEM");
{
  const rows = [
    { id: "a", body: "first", created_at: "2026-09-01T10:00:00Z" },
    { id: "c", body: "third", created_at: "2026-09-02T10:00:00Z" },
    { id: "b", body: "second", created_at: "2026-09-01T18:00:00Z" },
  ];
  eq("newest first", sortUpdates(rows).map((r) => r.id), ["c", "b", "a"]);
  eq("the newest is the newest", newestUpdate(rows).id, "c");
  eq("the task's one line is the newest body", latestLineFrom(rows), "third");
  ok("sorting does not mutate what it was given", rows[0].id === "a");

  /* Two updates can share a second — an import, or a fast double-post. The
   * trigger orders by `created_at desc, id desc`; if this file broke the tie
   * the other way, the panel's top row and the task's line would be different
   * sentences with nothing on screen to say why. */
  const tied = [
    { id: "aaa", body: "one", created_at: "2026-09-02T10:00:00Z" },
    { id: "zzz", body: "two", created_at: "2026-09-02T10:00:00Z" },
  ];
  eq("A TIE BREAKS ON THE HIGHER ID, exactly as the trigger does", sortUpdates(tied)[0].id, "zzz");
  eq("...so the line is that one's body", latestLineFrom(tied), "two");

  eq("no updates means no line", latestLineFrom([]), null);
  eq("no list at all is not a crash", latestLineFrom(undefined), null);
  eq("no rows means no newest", newestUpdate([]), null);
}

console.log("\nTHE LINE AND THE HISTORY AGREE, OR THE SCREEN IS WRONG");
{
  const rows = [{ id: "a", body: "12 of 26 done.", created_at: "2026-09-01T10:00:00Z" }];
  ok("they agree when the line is the newest body", lineAgrees({ latest_report: "12 of 26 done." }, rows));
  ok("THEY DISAGREE when the line is something else", !lineAgrees({ latest_report: "old news" }, rows));
  ok("...and when the line is empty but an update exists", !lineAgrees({ latest_report: null }, rows));
  /* A task whose line was typed straight into the field — the importer, the
   * assistant, a console older than 0029 — is not in disagreement with
   * anything. Calling that a conflict would put a warning on ~100 imported
   * tasks on day one and teach everybody to ignore the warning. */
  ok("a line with no updates at all is not a disagreement", lineAgrees({ latest_report: "from the importer" }, []));
  ok("nothing and nothing agree", lineAgrees({ latest_report: null }, []));
}

console.log("\nNOBODY REWRITES SOMEBODY ELSE'S WORDS");
{
  const mine = { id: "u1", author: "me", body: "x" };
  const theirs = { id: "u2", author: "them", body: "x" };
  const nobodys = { id: "u3", author: null, carried_over: true, body: "x" };
  ok("the author may edit their own", canEditUpdate(mine, "me", "admin"));
  ok("a plain member may NOT edit someone else's", !canEditUpdate(theirs, "me", "sales"));
  ok("an admin may tidy the history", canEditUpdate(theirs, "me", "admin"));
  ok("an owner may too", canEditUpdate(theirs, "me", "owner"));
  ok("a carried-over row belongs to nobody, so only an admin touches it", !canEditUpdate(nobodys, "me", "sales") && canEditUpdate(nobodys, "me", "owner"));
  ok("signed out edits nothing", !canEditUpdate(mine, null, "owner"));
  ok("no row edits nothing", !canEditUpdate(null, "me", "owner"));
}

console.log("\nA CARRIED-OVER ROW SAYS SO");
{
  const labelFor = (id) => (id === "u-ryder" ? "Ryder Schilling" : null);
  eq("a real author is named", updateAuthorLabel({ author: "u-ryder" }, labelFor), "Ryder Schilling");
  eq("an author nobody can name is 'someone', not a raw id",
    updateAuthorLabel({ author: "u-ghost" }, labelFor), "someone");
  eq("A CARRIED-OVER ROW WITH NO AUTHOR SAYS SO — it is not 'someone'",
    updateAuthorLabel({ author: null, carried_over: true }, labelFor), "carried over");

  const stamp = updateStamp({ created_at: "2026-08-20T15:04:00Z", carried_over: true }, Date.parse("2026-09-02T00:00:00Z"));
  ok("a carried-over stamp names the date for what it is, not a posting time",
    /last-changed date/.test(stamp), stamp);
  const posted = updateStamp({ created_at: "2026-08-20T15:04:00Z", carried_over: false }, Date.parse("2026-09-02T00:00:00Z"));
  ok("a posted stamp carries a time of day", /\d:\d\d/.test(posted), posted);
  ok("...and does NOT claim to be a last-changed date", !/last-changed/.test(posted), posted);
}

console.log("\nA MISSING TABLE IS RECOGNISED, AND NOTHING ELSE IS");
{
  ok("postgres 42P01 on this table", isMissingUpdatesTable('relation "public.admin_task_updates" does not exist (42P01)'));
  ok("postgrest's schema-cache miss on this table",
    isMissingUpdatesTable("Could not find the table 'public.admin_task_updates' in the schema cache"));
  ok("A DIFFERENT missing table is NOT this one — it must not send somebody to run 0029",
    !isMissingUpdatesTable('relation "public.admin_invoices" does not exist'));
  ok("a permission error is not a missing table",
    !isMissingUpdatesTable("permission denied for table admin_task_updates"));
  ok("nothing is not a missing table", !isMissingUpdatesTable(null) && !isMissingUpdatesTable(""));
}

console.log("\nTHE MIGRATION SAYS WHAT THIS FILE SAYS");
{
  const SQL = stripSql(src("supabase/migrations/0029_task_updates.sql"));
  ok("the table is created guarded, so a second run is safe",
    /create table if not exists public\.admin_task_updates/.test(SQL));
  ok("the task link cascades, so a deleted task takes its updates with it",
    /task_id uuid not null references public\.admin_tasks on delete cascade/.test(SQL));
  ok("NO client_id — the client-delete warning screen stays honest without a new entry",
    !/client_id/.test(SQL));
  ok("the trigger orders ties the same way this file does",
    /order by u\.created_at desc, u\.id desc/.test(SQL));
  ok("the write-back is security definer, or RLS silently drops it for non-admins",
    /security definer/.test(SQL));
  ok("a cascade delete does not try to write to a task that is already gone",
    /if not exists \(select 1 from public\.admin_tasks where id = tid\)/.test(SQL));
  {
    /* Only the INSERT matters here. `created_at ... default now()` in the table
     * definition above it is correct and must not be matched — a guard that
     * fires on the right code is the same defect as one that fires on a
     * comment. */
    const ins = SQL.slice(SQL.indexOf("insert into public.admin_task_updates"));
    const stmt = ins.slice(0, ins.indexOf(";") + 1);
    ok("the backfill dates carried-over rows to the task's updated_at",
      /true, t\.updated_at/.test(stmt), stmt.slice(0, 200));
    ok("...and NOT to now(), which would be a posting time nobody typed",
      !/now\(\)/.test(stmt), stmt.slice(0, 200));
    ok("...and marks them carried_over, so the screen can say which they are",
      /carried_over/.test(stmt));
  }
  ok("the backfill runs only where there are no updates yet, so a second run adds nothing",
    /not exists \(select 1 from public\.admin_task_updates u where u\.task_id = t\.id\)/.test(SQL));
  ok("`is distinct from` guards the write-back — `<> null` is null and would skip it",
    /latest_report is distinct from newest/.test(SQL));
  ok("the grants are stated rather than assumed",
    /grant select, insert, update, delete on public\.admin_task_updates to authenticated/.test(SQL));
  ok("row level security is on",
    /alter table public\.admin_task_updates enable row level security/.test(SQL));
  ok("an entry can only be written with its author's own name on it",
    /for insert with check \(public\.admin_is_admin\(\) and author = auth\.uid\(\)\)/.test(SQL));
  ok("latest_report is NOT dropped — ~10 readers still depend on it",
    !/drop column[\s\S]*latest_report/i.test(SQL));

  /* THE SIDE DOOR. 0001 gates admin_tasks on admin_is_admin() — "sales reps have
   * no business in client ops". These rows are the progress text on those same
   * tasks, so a member-level gate here would hand a rep, through a second door,
   * the reading and writing the front door refuses. It did, until this check. */
  ok("EVERY policy on the updates table is admin-gated, exactly like admin_tasks",
    !/on public\.admin_task_updates[\s\S]{0,200}admin_is_member\(\)/.test(SQL));
  ok("...and admin_is_member is not used anywhere in this migration",
    !/admin_is_member/.test(SQL.replace(/^[^\n]*--[^\n]*$/gm, "")));
  ok("only the author, or an owner, may change or remove an entry",
    /author = auth\.uid\(\) or public\.admin_is_owner\(\)/.test(SQL));

  ok("an update that MOVES between tasks resyncs the one it left, not only the one it joined",
    /tg_op = 'UPDATE' and new\.task_id is distinct from old\.task_id/.test(SQL));
  ok("rewriting the words is stamped by the database, so an edit cannot look untouched",
    /new\.edited_at := now\(\)/.test(SQL) && /before update on public\.admin_task_updates/.test(SQL));
  ok("...and the column is added guarded, so a re-run of this file still adds it",
    /add column if not exists edited_at/.test(SQL));

  /* The four statuses live in three places: the database check constraint, the
   * JS list, and the chips. A fifth added to one and not the others is a status
   * that saves and then cannot be selected again. */
  const INIT = stripSql(src("supabase/migrations/0001_admin_init.sql"));
  const DATA = stripJs(src("src/lib/data.js"));
  const inDb = (INIT.match(/status in \('todo','in_progress','done','blocked'\)/) || []).length;
  ok("the database still allows exactly these four statuses", inDb === 1);
  {
    /* 0001 is not the last word — a later migration can relax or replace the
     * constraint, and then the four buttons are no longer the four states. */
    const dir = join(HERE, "..", "..", "supabase", "migrations");
    const later = readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.startsWith("0001"));
    const touched = later.filter((f) => /admin_tasks[\s\S]{0,300}(status\b[\s\S]{0,80})?check \(status in/i.test(stripSql(readFileSync(join(dir, f), "utf8"))));
    ok(`no later migration changes the task status constraint (checked ${later.length} files)`,
      touched.length === 0, touched.join(", "));
  }
  ok("...and the JS list is the same four in the same words",
    /TASK_STATUSES = \["todo", "in_progress", "done", "blocked"\]/.test(DATA));
}

console.log("\nTHE BUTTONS ARE IN THE ORDER WORK MOVES, AND LOSE NOTHING");
{
  const DATA = stripJs(src("src/lib/data.js"));
  ok("the offered order is To do, In progress, Blocked, Done — what Ryder asked for",
    /\["todo", "in_progress", "blocked", "done"\]\.filter/.test(DATA));
  ok("...built from TASK_STATUSES, not typed out a second time",
    /TASK_STATUS_FLOW = \[[\s\S]{0,400}TASK_STATUSES\.includes/.test(DATA));
  ok("A STATUS THE DATABASE ALLOWS BUT THIS ORDER DOES NOT NAME IS APPENDED, never dropped",
    /TASK_STATUSES\.filter\(\(s\) => !\["todo", "in_progress", "blocked", "done"\]\.includes\(s\)\)/.test(DATA));

  /* Proved rather than asserted: run the same shape against a made-up fifth
   * status and check nothing is lost. */
  const flow = (all) => [
    ...["todo", "in_progress", "blocked", "done"].filter((s) => all.includes(s)),
    ...all.filter((s) => !["todo", "in_progress", "blocked", "done"].includes(s)),
  ];
  eq("today's four come out in the asked-for order",
    flow(["todo", "in_progress", "done", "blocked"]), ["todo", "in_progress", "blocked", "done"]);
  eq("a fifth status is kept, on the end",
    flow(["todo", "in_progress", "done", "blocked", "waiting_on_client"]),
    ["todo", "in_progress", "blocked", "done", "waiting_on_client"]);
  ok("nothing is ever lost", flow(["todo", "in_progress", "done", "blocked", "x"]).length === 5);
}

console.log("\nONE WRITER FOR THE TASK'S ONE LINE");
{
  const DATA = stripJs(src("src/lib/data.js"));
  const live = DATA.slice(DATA.indexOf("export async function addTaskUpdate"), DATA.indexOf("export async function editTaskUpdate"));
  ok("addTaskUpdate exists", live.length > 0);
  ok("THE LIVE PATH NEVER WRITES latest_report — the trigger owns it",
    !/from\("admin_tasks"\)[\s\S]{0,200}latest_report/.test(live));
  ok("...but preview mode does, because preview has no trigger",
    /previewStore\.tasks\[i\] = \{ \.\.\.previewStore\.tasks\[i\], latest_report: text \}/.test(live));
  ok("a missing table is handed back as `missing`, not as an error",
    /isMissingUpdatesTable\(error\.message\)\) return \{ ok: false, missing: true/.test(live));
  ok("listTaskUpdates says `missing` too, rather than showing a red error on a normal state",
    /return \{ rows: \[\], missing: true, sample: false \}/.test(DATA));
  ok("deleting the newest update puts the one before it back on the task",
    /function syncPreviewLatest[\s\S]{0,400}latestLineFrom\(rows\)/.test(DATA));
}

console.log("\nNOTHING TYPED IS LOST BEFORE THE MIGRATION IS RUN");
{
  const UPD = stripJs(src("src/components/admin/taskUpdates.jsx"));
  ok("a missing table keeps the words on the task's own line",
    /if \(res\.missing\)[\s\S]{0,400}onPatch\(task, \{ latest_report: body \}\)/.test(UPD));
  ok("...and names the migration that turns the history on",
    /0029_task_updates\.sql/.test(UPD));
  ok("...and does not call it an error", !/toast\.error\([\s\S]{0,60}0029/.test(UPD));
  ok("the row behind the panel is told the new line, with no second database write",
    /const tellTheRow = \(line\) => \{[\s\S]{0,120}onLine\(task, line\)/.test(UPD));
  ok("removing an update re-reads the line from what is left",
    /const next = \(rows \|\| \[\]\)\.filter[\s\S]{0,200}tellTheRow\(latestLineFrom\(next\)\)/.test(UPD));
  ok("a line nobody posted is shown as exactly that, with a way to keep it",
    /orphanLine/.test(UPD) && /Keep it as the first update/.test(UPD));

  /* FIVE LIVE WRITERS still set `latest_report` directly — the Operations
   * report cell, the task edit box, the Notion importer, a note turned into a
   * task line, and the assistant's create_task. They are not going away, so the
   * panel must CHECK whether the line on the row is one of its updates rather
   * than claim it. `lineAgrees` is that check; before this it was imported by
   * nothing but this test file. */
  ok("the panel actually checks whether the row's line is one of these updates",
    /lineAgrees/.test(UPD));
  ok("...and says the true thing either way, rather than one sentence for both",
    /The line on the row was set somewhere else/.test(UPD));
  ok("...and does not badge an update 'on the row' when something else is on the row",
    /r\.id === newestId && agrees && <span className="adm-upd-tag">on the row/.test(UPD));
  ok("...and offers the one button that makes the two agree again",
    /Keep it as an update/.test(UPD));
  ok("an update that was rewritten is marked as rewritten",
    /r\.edited_at && <span/.test(UPD));
  ok("posting with nobody signed in says so, instead of a raw permission error",
    /if \(!me\)[\s\S]{0,220}An update has to carry a name/.test(UPD));
  ok("the fallback box is seeded with the words just typed, not the previous line",
    /setMissing\(true\);[\s\S]{0,120}onFallbackChange\(body\)/.test(UPD));
  ok("...and a failed fallback write is not followed by a toast saying it saved",
    /saved\.ok === false[\s\S]{0,120}return;/.test(UPD));
}

console.log("\nONE PANEL, REACHED FROM ANY ROW");
{
  const WORK = stripJs(src("src/components/admin/WorkPage.jsx"));
  const OPS = stripJs(src("src/components/admin/Operations.jsx"));
  const DRAWER = stripJs(src("src/components/admin/taskDrawer.jsx"));

  ok("the Work page opens the SAME panel Operations does, not a second one",
    /import TaskDrawer from "\.\/taskDrawer\.jsx"/.test(WORK));
  {
    /* Both must import THE SAME FILE. Two files both exporting `TaskDrawer`
     * would have passed the old check while being two panels, which is the one
     * thing this whole change exists to avoid. */
    const path = (f) => (f.match(/import TaskDrawer from "([^"]+)"/) || [])[1];
    const w = path(WORK), o = path(OPS);
    ok(`...and it is the same file on both pages (${w} / ${o})`, Boolean(w) && w === o);
    ok("...resolving to a file that exists", w === "./taskDrawer.jsx");
  }
  ok("the Work page holds the open task BY ID, so the panel cannot go stale",
    /work\.tasks\.find\(\(x\) => x\.id === openTaskId\)/.test(WORK));
  {
    /* THE WHOLE BLOCK OF WORDS, not the title line. Ryder ringed the title, the
     * client line and the report line together: three lines that look like one
     * thing, of which only the first did anything. */
    ok("the way in is one target holding all three lines",
      /adm-work-openrow/.test(WORK) && /setOpenTaskId\(t\.id\)/.test(WORK));
    ok("...and the old name-only target is gone, not left beside it",
      !/adm-work-openname/.test(WORK));
    ok("...and it is a real button, so Tab and Enter reach it",
      /<button\s+type="button"\s+className="adm-work-openrow"/.test(WORK));
    ok("...named for the task it opens, for a screen reader",
      /aria-label=\{`Open \$\{t\.name\}`\}/.test(WORK));

    /* NOTHING INTERACTIVE INSIDE IT. A control nested in the target would eat
     * the click and put us back at the 31 Aug defect from the other side — and
     * a <button> inside a <button> is invalid HTML that React will not warn
     * about. The three lines are spans; the chips are outside. */
    const inside = (WORK.match(/className="adm-work-openrow"[\s\S]*?<\/button>\n/) || [""])[0];
    ok("nothing inside the target is itself a button, input or link",
      inside.length > 0 && !/<(button|a|input|select|textarea)\b/.test(inside.replace(/^[\s\S]*?>/, "")),
      inside.slice(0, 200));
    ok("...so there is no \"click anywhere that is not a control\" guess to get wrong",
      !/e\.target\.tagName/.test(WORK));
  }

  ok("the Work page carries the 0028 fallback, or no task edit saves at all",
    /MISSING_ASSIGNEES\.test/.test(WORK) && /assigned_to: \(assignees \|\| \[\]\)\[0\]/.test(WORK));
  ok("...and the 0012 one", /MISSING_DESCRIPTION\.test/.test(WORK));

  {
    /* THE GUARDS ARE COMPARED, NOT ASSERTED. A loose /assignees/i passes every
     * check that only looks for the name, and then fires on any error whose
     * text happens to contain the word — an RLS refusal, a check constraint —
     * silently dropping everybody but the first person while saying "Saved". */
    const guard = (f, name) => (f.match(new RegExp(`const ${name} = (/.*/[a-z]*);`)) || [])[1];
    for (const name of ["MISSING_ASSIGNEES", "MISSING_DESCRIPTION"]) {
      const a = guard(WORK, name), b = guard(OPS, name);
      ok(`${name} is character-for-character the same on both pages`, Boolean(a) && a === b,
        `Work: ${a}\n       Ops:  ${b}`);
      ok(`...and it is not the loose one that matches any error mentioning the word`,
        Boolean(a) && /column|schema cache|does not exist/.test(a), a);
    }
    /* Proved on real error text rather than by reading the regex. */
    const raw = guard(WORK, "MISSING_ASSIGNEES");
    const A = new RegExp(raw.slice(1, raw.lastIndexOf("/")), "i");
    ok("the real PostgREST miss is caught",
      A.test("Could not find the 'assignees' column of 'admin_tasks' in the schema cache"));
    ok("...and a permission error naming the same column is NOT treated as a missing migration",
      !A.test("new row violates row-level security policy for table admin_tasks (assignees)"));
  }

  ok("a failed save undoes only the fields it touched, not the whole page",
    /const undo = Object\.fromEntries\(Object\.keys\(patch\)/.test(WORK) && !/setWork\(before\)/.test(WORK));
  ok("...and hands the caller back whether it landed, so nothing reports a save that failed",
    /return \{ ok: false, error: res\.error \};/.test(WORK) && /return \{ ok: true \};/.test(WORK));
  ok("Operations' save says the same, or the panel's fallback can only be right on one page",
    /return \{ ok: false, error: res\.error \};/.test(OPS) && /return \{ ok: true \};/.test(OPS));

  {
    /* ONE SAVE PATH. The row's chips used to call their own function with no
     * optimistic write, no undo and no migration fallbacks — two ways to set
     * one field on one page, which differ in exactly the case nobody tries:
     * the failure. */
    ok("THE ROW CHIPS GO THROUGH patchTask, the same as the panel",
      /onClick=\{\(\) => \{ if \(t\.status !== v\) patchTask\(t, \{ status: v \}\); \}\}/.test(WORK));
    ok("...and the second save path is gone entirely", !/setTaskStatus/.test(WORK));
    ok("...leaving one call to upsertTask for a status, not two",
      (WORK.match(/upsertTask\(/g) || []).length === 2);   // the write and its fallback retry
  }

  {
    /* getMyWork() attaches `bucket`, `due_ms` and `client_name`; none is stored.
     * Merging a patch leaves them at their old values, so a due date moved from
     * last week to next month would sit under LATE still reading "6 days late"
     * with nothing to notice. */
    ok("a change to a field the row DERIVES from re-reads the page",
      /const DERIVED = \["status", "due_date", "client_id", "assignees", "assigned_to"\]/.test(WORK));
    ok("...and everything else does not, so the page does not flicker on every keystroke",
      /DERIVED\.some\(\(k\) => k in patch\)\) load\(\)/.test(WORK));
  }
  ok("marking one done re-reads the page, because this page only shows open work",
    /const DERIVED = \[[^\]]*"status"[^\]]*\][\s\S]{0,300}load\(\)/.test(WORK));
  /* `setOpenTaskId(null)` is also what the close button does, so its mere
   * presence proves nothing — the old check here could not fail. What matters
   * is that the DONE path closes it, and that the panel refuses to draw at all
   * when the task is no longer in the list. */
  ok("...and marking one done is what closes the panel, not just the X",
    /patch\.status === "done"[\s\S]{0,300}setOpenTaskId\(null\)/.test(WORK));
  ok("...and the panel draws nothing when the task has left the list",
    /work\.tasks\.find\(\(x\) => x\.id === openTaskId\);[\s\S]{0,80}if \(!t\) return null;/.test(WORK));

  ok("BOTH pages read the four statuses from the one list",
    /TASK_STATUS_FLOW\.map/.test(WORK) && /TASK_STATUS_FLOW\.map/.test(DRAWER));
  ok("the panel's status is chips, not a dropdown",
    /adm-status-chip/.test(DRAWER) && !/<select[\s\S]{0,120}task\.status/.test(DRAWER));
  ok("the chips say which one is on, for a screen reader too",
    /aria-pressed=\{task\.status === v\}/.test(DRAWER));
  ok("both pages tell the row behind the panel when the line changes",
    /onLine=/.test(WORK) && /onLine=/.test(OPS));
  ok("the panel is given who is looking, or it cannot say whose update is whose",
    /member=\{member\}/.test(WORK) && /member=\{member\}/.test(OPS));
}

console.log("\nWORK AND OPERATIONS ARE ONE GROUP IN THE MENU");
{
  /* Two views of ONE table. Ryder, 2 Sep 2026: "make work and operations right
   * next to each other, they both do a very similar task and work together on
   * all projects." They were two groups apart with SALES between them. */
  const SIDE = stripJs(src("src/components/admin/Sidebar.jsx"));

  const groups = [...SIDE.matchAll(/\{ group: "([^"]+)", roles: \[([^\]]*)\], items: \[([\s\S]*?)\n  \]\}/g)]
    .map((m) => ({
      group: m[1],
      roles: m[2].split(",").map((r) => r.trim().replace(/"/g, "")).filter(Boolean),
      ids: [...m[3].matchAll(/\["([a-z-]+)",/g)].map((x) => x[1]),
    }));
  ok(`the menu parsed (${groups.length} groups)`, groups.length >= 6, JSON.stringify(groups.map((g) => g.group)));

  const owner = groups.filter((g) => g.roles.includes("owner"));
  const flat = owner.flatMap((g) => g.ids);
  const iWork = flat.indexOf("work"), iOps = flat.indexOf("operations");
  ok("an owner has both pages", iWork >= 0 && iOps >= 0);
  ok("THEY ARE NEXT TO EACH OTHER, with nothing between them",
    iOps === iWork + 1, `work at ${iWork}, operations at ${iOps}, order: ${flat.join(" → ")}`);
  ok("...in the SAME group, not two groups that happen to touch",
    owner.filter((g) => g.ids.includes("work") || g.ids.includes("operations")).length === 1);
  ok("...with Work first, because it is the landing page",
    owner.find((g) => g.ids.includes("work")).ids[0] === "work");
  ok("...and Sales is no longer between them",
    !flat.slice(iWork, iOps).includes("sales"));
  ok("the empty group they came from is gone, not left drawing a heading",
    !owner.some((g) => g.ids.length === 0));

  /* A sales rep does not do delivery work (lib/people.js), so neither page is
   * theirs — and a hidden link was never the gate anyway. */
  const rep = groups.filter((g) => g.roles.includes("sales")).flatMap((g) => g.ids);
  ok("A SALES REP STILL HAS NEITHER PAGE", !rep.includes("work") && !rep.includes("operations"),
    rep.join(" → "));
}

console.log("\nTHE STYLES EXIST FOR WHAT THE MARKUP ASKS FOR");
{
  const CSS = src("src/admin.css").replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const c of ["adm-status-chips", "adm-status-chip", "adm-upd-list", "adm-upd-body",
    "adm-upd-tag", "adm-upd-orphan", "adm-work-openname", "adm-drawer-note", "adm-drawer-f-wide"]) {
    ok(`.${c} is styled`, new RegExp(`\\.${c}[\\s.,:{]`).test(CSS));
  }
  ok("every status has its own filled colour, so 'blocked' is not the same as 'done'",
    ["s-todo", "s-in_progress", "s-blocked", "s-done"].every((c) => CSS.includes(`.adm-status-chip.on.${c}`)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
