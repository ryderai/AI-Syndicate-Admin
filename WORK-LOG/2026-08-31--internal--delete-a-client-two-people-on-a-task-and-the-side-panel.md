# Delete a client · two people on a task · the task opens in a side panel
**Mon 31 Aug 2026, afternoon.** Internal. Built after the 107 Notion tasks landed
(`WORK-LOG/2026-08-31--internal--the-107-notion-tasks-are-in.md`).

Three asks from Ryder, in the order they arrived:

> "can you delete the test client"
> "and make sure two people can be assigned to the same task."
> "and when i click a row i want it to open a sidebar with the actual to do item and all
> the info and edit the text and all that there."

**All three are built, tested and driven in a browser. None is deployed.** One of them
needs a migration run in Supabase before the deploy — see the hand-over at the bottom.

---

## 1. A client can be deleted — the console has never been able to

`lib/client-delete.js` · `ClientModal` in `src/components/admin/Operations.jsx` ·
`tests/client-delete` (28 checks).

Edit a client → a fold at the bottom → type the client's name → **Delete for good**.
Owner only, and hidden behind the fold rather than sitting next to Save.

**The screen says what it costs, in words.** A delete here is not one row: **ten tables**
carry `on delete cascade` on `client_id` and **seven** carry `on delete set null`. So the
panel names both lists — what goes (every task, the 8-week log, their websites, platform
logins, reports, connections and the readings from them, Vault items, AI notes, Brain
memory) and what survives with the link cleared (the lead they came from stays on the sales
sheet, emails stay in the inbox, invoices and expenses stay in Finance, AI cost history
stays). The task count is read from the database at the moment the fold opens, not from a
page load that could be minutes old.

**A test reads the migrations and derives both lists.** If a new table gains a `client_id`
and is not named on the screen, it fails. That is the only thing that stops this going
stale and the screen lying by omission.

The gate forgives case and outside spacing — the name is retyped, not pasted from the row
you are about to destroy — and refuses everything else, including a near miss in either
direction.

**I did not delete `ZZ TEST — Dry Run Realty` myself.** It cascades across ten tables and
there is no undo; that press is Ryder's.

## 2. Two or more people on one task

`supabase/migrations/0028_task_assignees.sql` · `lib/task-assignees.js` ·
`tests/task-assignees` (62 checks).

**The shape, and why it is not a join table.** `assigned_to` is read in about thirty places
— the Work page, the board's grouping, the Operations filters, the AI Brain's context, the
assistant's tools, the person timeline, every report. Replacing it wholesale would mean
rewriting all of them at once, and anything missed reads as "Unassigned" while the database
says otherwise. That is exactly how the Aug 30 dry run lost a task.

So `assigned_to` **stays** and now means **the primary** — the one name a single-slot screen
shows. A new `assignees uuid[]` holds everybody, primary first. Every existing reader keeps
working untouched.

**A trigger keeps the two in step**, whichever one a writer sets, because there are five
writers already (the console, the importer, the assistant's tools, the AI Brain, the api/
routes) and expecting all five to remember a rule is how the rule gets broken. Setting only
`assigned_to` changes who is primary and leaves everybody else on the task. De-duplication
keeps first-seen order — `array_agg(distinct …)` sorts, and the order is what decides who
the primary is.

**The Work page now asks "is this person ON it", not "is it theirs".** That one line is the
whole feature: without it a second assignee's task is on their row and on none of their
pages. The Owner filter on Operations asks the same question.

**Nobody can be put on a task they cannot open.** The picker is `deliveryPeopleOptions` —
a sales rep's console has four pages and Operations is not one of them — and whoever
already holds the task stays in the list so the screen never contradicts the database.

**The Notion importer now writes the whole list.** The 12 multi-assignee Notion rows had
their second person written into the brief as prose; re-pasting
`_merge/notion-tasks-2026-08-31.json` after the migration puts them on the task properly.
Re-pasting is still safe — arrays are compared as lists, in order, so an unchanged pair is
not a change.

## 3. Click a task, it opens in a side panel

`src/components/admin/taskDrawer.jsx` · styles appended to `src/admin.css`.

The whole to-do on one screen: the name as a big editable heading, status, priority, due
date, client, category, phase, who is on it, the one-line status, and the full brief in a
box with room to read it. Everything saves as you go. Delete the task from the bottom.

**It owns no data.** Every change goes out through the page's own `patchTask` — the same
path the inline cells use, optimistic write, undo only the fields it touched. A panel with
its own copy would drift from the table behind it within one edit.

**Typing is not saving.** Text fields hold their keystrokes and commit on blur, and the
draft is keyed on the task id so a row coming back from the database mid-edit does not wipe
what is being typed.

### The defect this turned up in my own work, found by measuring

The row was made clickable with a "click anywhere that is not a control" guard. Measured on
the built bundle: **all 11 cells were 100% filled by their own button.** There was nowhere
on the row a click could land — a row that says clickable with the cursor and is
unreachable is worse than one that is neither.

Fixed by making **the task name** the way in, which is the widest column and where a person
aims anyway. Renaming moved into the panel, which is what was asked for. The chips in the
row still do their own thing; the guard is `closest()`, not `e.target.tagName`, because
React events bubble through the React tree — the same trap the sales sheet hit in August.

## Proof

lint clean · **2,925 checks across 36 suites, 0 failing** (was 2,829) · build clean at 174
modules · driven in a real browser against the built bundle:

- clicking a task name opens the panel showing that task; renaming in the panel renames the
  row behind it
- a second person added in the panel → the row cell reads **"Sample Admin +1"**, the panel
  names the primary, and **make primary** moves it without taking anybody off
- the same two-level pick works from the row's own cell, and the menu stays open while
  picking
- clicking a chip in the row opens that chip's popover and does **not** open the panel
- the client delete: the warning names the client and its 4 tasks, the button is dead before
  the name is typed and dead on a wrong name, and once typed the client list went 3 → 2 with
  the client gone from it

`tests/auth-gate` and `tests/inbox` still do not run on the Mac bridge; both predate this.

## One thing that would have broken the deploy

Postgres rejects the **whole row** when sent a column the table does not have. So a console
deployed before 0028 runs could not save **any** task edit — a due-date change would die on
`assignees`, a field nobody touched. Migration 0012 set this exact trap once already.

Both write paths now fall back to the single field, save the rest, and say why. **Deploy
order does not matter**, and there is a test that fails if that fallback is removed.

## Hand-over — two steps

1. **Run `supabase/migrations/0028_task_assignees.sql`** in the Supabase SQL editor. Safe to
   run twice. It adds the column, backfills every existing task with a one-name list, adds
   the index and the trigger, and re-asserts the grants.
2. **Push and deploy.**

Then: Edit a client → the fold at the bottom → type `ZZ TEST — Dry Run Realty` → delete it.

Optional, once 0028 is in: re-paste `_merge/notion-tasks-2026-08-31.json` to put the second
person onto the 12 Notion tasks that had two.
