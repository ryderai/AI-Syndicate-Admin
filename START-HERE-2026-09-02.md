# START HERE — AI Syndicate admin console, handed over Tue 2 Sep 2026

**This replaces `START-HERE-2026-09-01.md`.** That file is still right about everything it
says; this one adds the 2 Sep work and moves one more migration onto the list.

---

## Where things stand

| | |
|---|---|
| Migrations | 0001 – **0027 run**. **0028 NOT run. 0029 NOT run.** |
| Deployed | everything up to the 31 Aug morning push |
| NOT deployed | 31 Aug afternoon (client delete, multi-assign, the panel) and all of 2 Sep |
| Tests | **3,056 checks across 36 suites, 0 failing** (was 2,925) |
| Extra proof | `tests/task-updates/run.sh` — 24 SQL checks on a real Postgres 16 |
| | `tests/task-updates/walkthrough.mjs` — 30 browser checks, shots in `tests/task-updates/shots/` |
| Lint | clean across `lib src api tests` |
| Build | clean, 176 modules — **must run in the cloud container, not the Mac bridge** |
| Clients | **7** (6 real + `ZZ TEST — Dry Run Realty`, still not deleted) |
| Operations | 111 tasks |

---

## Do these four things, in this order

1. **Run `supabase/migrations/0028_task_assignees.sql`** in the Supabase SQL editor. Safe to
   run twice. From 31 Aug, still outstanding.
2. **Run `supabase/migrations/0029_task_updates.sql`.** Safe to run twice — proved on a real
   Postgres, not assumed. It creates `admin_task_updates`, turns every task's existing one
   line into a first update dated to that task's own last-changed date, adds the two
   triggers, and sets admin-only policies.
3. **Push and deploy.** Deploy order does not matter for either one: without 0028 a task
   saves with one person and says so, and without 0029 an update is kept on the task's own
   line and the panel names the file to run.
4. **Delete `ZZ TEST — Dry Run Realty`.** Clients → Open → Edit → the fold at the bottom →
   type the name. Note the warning now also names the progress updates it destroys.

Then, optional: **Sales → ⋯ → Reps on the sheet** — still never pressed, still emails nobody.

---

## Read these first

1. **`CONTEXT-FOR-AI.md` §57, §58, §59 and §60.**
2. **Project memory**, these four:
   - `task-panel-and-task-updates_2026-09-02` — the panel, the chips, the updates table
   - `notion-merge-and-sheet-reps_2026-08-31`
   - `delete-client-multi-assign-and-task-panel_2026-08-31` — before touching `assigned_to`
   - `dry-run-defects-same-name-and-dates_2026-08-30`
3. **`append-only-never-rewrite-shared-files`** — before writing anything shared.

---

## What is new on screen since 1 Sep

- **The task name on any Work page row opens the side panel** — the same one Operations uses,
  not a second one. Edit the name, the brief, the due date, the client, the category, the
  phase and who is on it.
- **Status is four chips everywhere**: To do · In progress · Blocked · Done, with the current
  one filled in. The Work row could previously only go forward — there was no way back to
  To do.
- **A task keeps every update ever written on it**, with who wrote it and when. The newest is
  the one line the Operations table, the board card, the Work row and every report already
  read, so nothing else had to change.
- **The panel says when the row's line did not come from an update** — the Operations report
  cell, the task edit box, the Notion importer, a note, and the assistant all still write it
  directly. One button keeps that line as an update and the two agree again.
- **A rewritten update is marked EDITED**, stamped by the database.

---

## Traps that cost time on 2 Sep

1. **A new table holding a field of an existing table must copy that table's gate.** 0029
   first gated itself on `admin_is_member()` while `admin_tasks` is `admin_is_admin()` —
   a sales rep could read and write every task's progress text. Count the doors.
2. **A comment saying "these two must not drift" does not stop them drifting.** Two copies of
   a rule need a test that COMPARES them.
3. **Three checks could not fail**, including the "is this the build under test" guard. Ask
   of every source-matching check what would have to be true for it to fail.
4. **`innerText` applies `text-transform`** — a browser check against an uppercase label
   needs a case-insensitive match.
5. **The build still cannot run on the Mac bridge.** Second session in a row.

---

## Still true, and still only a person can do it

1. **A GoDaddy customer number and password are sitting in plain text on a Notion page** —
   "Get access to Website and Google Tools", Jessica Mackrael. Bitwarden, then delete them
   off Notion.
2. **Justin Dyar has no start date**, so nobody can say which week he is on.
