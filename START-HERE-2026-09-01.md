# START HERE — AI Syndicate admin console, handed over Mon 31 Aug 2026, end of day

**This replaces `START-HERE-2026-08-31.md` and `START-HERE-2026-08-31-SECOND-SESSION.md`.**
Both are now wrong on the thing that matters most: they say nothing is deployed. Ryder
deployed on the morning of 31 Aug, and Notion has moved in since.

---

## Where things stand

| | |
|---|---|
| Migrations | 0001 – **0027 run**. **0028 is NOT run.** |
| Deployed | everything up to the 31 Aug morning push |
| NOT deployed | 31 Aug afternoon — client delete, multi-assign, the task panel |
| Tests | **2,925 checks across 35 running suites, all passing** |
| Lint | clean across `lib src api tests` |
| Build | clean, 174 modules — must run in the cloud container, not the Mac bridge |
| Clients | **7** (6 real + `ZZ TEST — Dry Run Realty`) |
| Operations | **111 tasks** (107 from Notion + the test client's 4) |
| Sales | 3,663 people at 2,765 firms |

`tests/auth-gate` and `tests/inbox` do not run on the Mac bridge — playwright is missing and
the inbox test has a bad relative import. **Both predate 30 Aug. Do not "fix" them by
rewriting them.**

---

## Read these first, in this order

1. **`CONTEXT-FOR-AI.md` §57, §58 and §59** — the Notion merge, the three things built on
   the afternoon of 31 Aug, and the state board.
2. **Project memory**, these three:
   - `notion-merge-and-sheet-reps_2026-08-31` — the merge and the reps
   - `delete-client-multi-assign-and-task-panel_2026-08-31` — READ BEFORE TOUCHING
     `assigned_to` ANYWHERE
   - `dry-run-defects-same-name-and-dates_2026-08-30` — why person pickers are dangerous here
3. **`append-only-never-rewrite-shared-files`** — before writing anything shared.

---

## Do these four things

1. **Run `supabase/migrations/0028_task_assignees.sql`** in the Supabase SQL editor. Safe to
   run twice. Adds `assignees uuid[]`, backfills every task that already has somebody, adds
   the index and the trigger, re-asserts the grants.
2. **Push and deploy.** Deploy order does not matter — the app falls back to one person and
   says so — but nothing multi-person works until the migration is in.
3. **Delete `ZZ TEST — Dry Run Realty`.** Clients → Open → Edit → the fold at the bottom →
   type the name.
4. **Sales → ⋯ → Reps on the sheet.** The last piece of the merge, and it has never been
   pressed. Seven accounts, about three thousand lead rows handed back to the reps who
   worked them. **It emails nobody.**

`DO-THIS-NEXT-notion-merge.md` is the same list, click by click.

---

## The three traps that cost the most time on 31 Aug

### 1. A clickable row whose cells are all buttons is unreachable

The Operations row was made clickable with a "click anywhere that is not a control" guard.
Measured on the built bundle: **all 11 cells were 100% filled by their own button.** There
was nowhere a click could land, while the cursor said otherwise. The task NAME is the way in
now. **Measure the cells before assuming a row has a lap to click on.**

### 2. A guard that fires on its own comment

Two new tests failed against prose — `array_agg(distinct …)` inside a SQL comment explaining
why it is *not* used, and `mine(t.assigned_to)` inside a JS comment explaining what the line
used to say. **Strip comments before matching source.** Sibling of the loose-regex rule.

### 3. Check what is actually listening before believing a browser

An hour went into a guard that "did not fire" in a headless run. The code was right the whole
time; a stale `npx serve` from a build two hours old still held the port, and with SPA
fallback even a missing asset answered 200. `pkill` the old server, then confirm the served
`index.html` names the asset hash you just built.

---

## Rules this console keeps having to relearn

- **A shared first name is not enough to hand somebody a pipeline.** Only `exact` and
  `initial` matchOwner hits may be acted on.
- **`assigned_to` IS `assignees[0]`.** Ask `isAssignedTo`, never `assigned_to === id`, or a
  second assignee's work is invisible to them.
- **Postgres rejects the WHOLE row over one unknown column.** Every new column needs a
  fallback, or the deploy order becomes load-bearing.
- **Count the doors.** A page, an AI context block, a tool the AI can call, an endpoint, a
  report. The service role opens all of them.
- **A count on a screen must be the count the button will do.**
- **A check screen that shows counts is asking somebody to agree to a number.** List the
  fields, old → new.
- **Repin a test to the rule; never delete it** because a literal correctly changed.
- **A timestamp captured before a write is not the timestamp of that write.**
- **A saved preference can hide a feature completely.** Twice now.
- **A round number on a screen is a bug until proved otherwise.**
- **`null` and `0` are different sentences.**
- **A comment that survives a reversal will reverse the reversal.**

---

## New files since 30 Aug, so nothing gets missed on the first commit

```
lib/notion-merge.js                            Notion rows -> admin_tasks, and the plan
lib/sales-owners.js                            Sales Owner names -> people -> accounts
lib/client-delete.js                           what a client delete costs, and the gate
lib/task-assignees.js                          who is on a task, and who is primary
api/sales-owners.js                            makes the rep accounts, emails nobody
src/components/admin/salesOwners.jsx           the Reps-on-the-sheet screen
src/components/admin/taskDrawer.jsx            the task, open
supabase/migrations/0028_task_assignees.sql    NOT RUN
tests/notion-merge/  tests/sales-owners/  tests/client-delete/  tests/task-assignees/
_merge/notion-tasks-2026-08-31.json            the 107 tasks, re-runnable
_merge/notion-clients-2026-08-31.json          the 6 clients, already imported
WORK-LOG/2026-08-31--internal--the-notion-merge-and-the-reps-on-the-sheet.md
WORK-LOG/2026-08-31--internal--the-107-notion-tasks-are-in.md
WORK-LOG/2026-08-31--internal--delete-a-client-two-people-on-a-task-and-the-side-panel.md
DO-THIS-NEXT-notion-merge.md
```

`git status` shows them all. None is git-ignored — check before committing.

---

## Two things only a person can do

1. **A GoDaddy customer number and password are sitting in plain text on a Notion page** —
   "Get access to Website and Google Tools", Jessica Mackrael. Deliberately not copied into
   the console. Bitwarden, then delete them off Notion.
2. **Justin Dyar has no start date**, so nobody can say which week he is on. His stage is a
   placeholder and his notes say so.
