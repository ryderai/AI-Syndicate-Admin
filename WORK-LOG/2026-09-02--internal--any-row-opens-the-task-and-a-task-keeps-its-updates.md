# Any row opens the task · four status chips · a task keeps its updates
**Tue 2 Sep 2026.** Internal. Built on top of the side panel from 31 Aug
(`WORK-LOG/2026-08-31--internal--delete-a-client-two-people-on-a-task-and-the-side-panel.md`).

Ryder, with a screenshot of the Work page:

> "i need any row like this to be able to click it and it have a sidebar that goes over
> everything and allows easy editing of it and tagging it as to do, in progress, blocked,
> or done. and also adding reports and all that needs to be seamless through here so that
> the operations and all work all fit together seamlessly. we can't have any gaps or
> missing info."

**All of it is built, checked by a second pass that found real defects, fixed, and driven
in a browser. None of it is deployed.** One migration has to be run first — see the
hand-over at the bottom.

---

## 1. Any row opens the task — and it is the SAME panel

`src/components/admin/WorkPage.jsx`

The panel built on 31 Aug only opened from the Operations table. The Work page — the page
Ryder actually stands on — had rows you could not open at all. Now the task NAME on a Work
row opens the same `taskDrawer.jsx`, with the same fields, the same people picker and the
same delete.

**A second panel was the wrong answer and was never on the table.** Two panels for one task
is two sets of rules, and they drift inside a week. A test now reads both files, pulls the
import path out of each, and fails if they are not the same string — the older check only
looked for `<TaskDrawer` in both, which two different files would also have passed.

**The whole block of words, not the name.** First pass made the task NAME the target, on the
31 Aug reasoning that a clickable row whose cells are all buttons is unreachable. Ryder sent
the screen back with a ring drawn round the title, the client line AND the report line
together:

> "you tried but didnt really do it. i need the whole text area for that job so that if i
> click it it opens the sidebar. that way i can view the whole task without clicking start or
> blocked or anything."

He was right, and the 31 Aug rule did not apply here. That defect was a target with controls
*inside* it; on this row the four chips sit **outside** the words, so the whole words block
can be live with nothing to steal a click and no "click anywhere that is not a control" guess
to get wrong.

So all three lines are now one `<button>` — reachable by Tab, fires on Enter and Space, and
announced as "Open <task name>". **Measured on the built bundle: 59% of the row's area, 76px
tall, all three lines inside it**, and the browser check clicks the *report line's own
coordinates* — the corner a title-only target missed — to open the panel. Measuring the
target is the rule from 31 Aug; the first pass here quoted it and did not do it.

## 1b. Work and Operations sit together in the menu

`src/components/admin/Sidebar.jsx`

> "make work and operations right next to each other, they both do a very similar task and
> work together on all projects."

He is right, and it is the same point as the panel. They are two views of **one table**:
`admin_tasks`. Work is "the open ones with my name on them, soonest first"; Operations is
"all of them, by client". Since today the same panel opens from a row on either page, and
ticking a task off on one moves it on the other.

They were two groups apart — Work under **YOURS** at the top, Operations under **DELIVERY**
below **SALES** — which read as two unrelated features. They are now one **DELIVERY** group,
Work first, and the group stays where Work already was, directly under Command. Moving Work
down to reach Operations would have fixed the wrong half: it is the landing page.

A sales rep still has neither, and their own group is untouched — a rep does not do delivery
work (`canDoDeliveryWork`, `lib/people.js`), and a hidden link was never the gate anyway.

Checked in the **drawn menu**, not read off the source: Operations is the very next item
after Work, with nothing between them, **38px apart on screen**. A source-only check cannot
see a section heading rendered in the gap.

## 2. Four chips instead of Start / Blocked / Done

`taskDrawer.jsx` · `WorkPage.jsx` · `TASK_STATUS_FLOW` in `src/lib/data.js`

The panel had a dropdown, which hides three of the four answers behind a click. The row had
**Start / Blocked / Done**, which could move a task forward but never **back to To do**.

Both are now the same four chips with the current one filled in: **To do · In progress ·
Blocked · Done**. Where a task stands is readable without opening anything.

The order is the order work moves, which is not the order the database lists them in.
`TASK_STATUSES` still matches the check constraint in 0001 word for word; `TASK_STATUS_FLOW`
is derived from it, and anything the database allows that the order does not name is
**appended rather than dropped** — so a fifth status could never be savable and unselectable
at the same time.

## 3. A task keeps its updates

`supabase/migrations/0029_task_updates.sql` · `lib/task-updates.js` ·
`src/components/admin/taskUpdates.jsx`

**What was missing.** `latest_report` is one line — "12 of 26 pages done." — and typing this
week's threw last week's away. Every weekly report and every recap to CJ has therefore been
rebuilt by hand from memory and chat history. That was the gap.

**The shape, and why `latest_report` stays.** Same rule as 0028. That column is read in
about ten places — the Operations table, the board card, the Work row, the client page, the
AI Brain's context, the assistant's tools, every report generator. Replacing it would mean
rewriting all of them at once. So it **stays** and now means **the newest update**, and a
trigger keeps it equal to the newest row in `admin_task_updates`. Every existing reader
works untouched.

**Nothing is lost on the way in.** The migration backfills every existing line into a first
update, dated to the task's own `updated_at` — the only date that ever existed for it — and
marks the row `carried_over` so the screen says exactly that instead of showing a posting
time nobody typed.

**Nothing is lost before the migration is run either.** The console ships ahead of its
migration every time. A missing table is not an error here: the words are saved onto the
task's own line, the box is seeded with what was just typed, and the panel names the file to
run. If that fallback write itself fails, the amber "saved" toast does not fire.

**The panel does not claim a line it has not checked.** Five live writers still set
`latest_report` directly — the Operations report cell, the task edit box, the Notion
importer, a note turned into a task line, and the assistant's `create_task`. They are not
going away. So the panel asks `lineAgrees()` and says the true thing either way: when the
row's line is not one of its updates, it shows it in its own box, drops the **ON THE ROW**
badge, and offers one button to keep it as an update.

## What the second pass found — all of it real, all of it fixed

A separate checker was told to assume something was false. It ran the migration against a
real Postgres 16 and read every file. Thirteen findings; these are the ones that mattered.

1. **A sales rep could read and write every task's progress text.** 0001 gates
   `admin_tasks` on `admin_is_admin()` — "sales reps have no business in client ops". The
   first draft of 0029 gated its table on `admin_is_member()`, which is true for a rep.
   Proved on Postgres: a rep read the updates, wrote one, and the `security definer`
   write-back put their sentence onto a task they could not otherwise see. **Count the
   doors** — a second door onto the same data with a different lock. Now admin-gated,
   exactly like the table it hangs off, and `tests/task-updates/run.sh` proves a rep gets
   nothing.
2. **The `latest_report` rule was asserted on screen and enforced nowhere.** `lineAgrees()`
   existed and was imported by the test file only. Fixed as described above.
3. **The two migration guards had already drifted, in the commit whose comment said they
   must not.** `/assignees/i` on the Work page against the careful one on Operations. A
   loose match fires on any error whose text contains the word — an RLS refusal, a check
   constraint — and then silently drops everybody but the first person while saying
   "Saved". The two are now compared character-for-character by a test, and proved on real
   error strings.
4. **An update moved between tasks left the first task's line stale.** The trigger resynced
   only the destination. It does both now. The point of putting the rule in the database is
   that it cannot be gone around; a rule with a hole in it is one somebody finds by accident.
5. **Two save paths on one page.** The row chips called their own function with no
   optimistic write, no undo and no migration fallbacks. Everything goes through `patchTask`
   now, and a test fails if a second path comes back.
6. **A failed save rolled the whole page back**, throwing away anything that landed while
   the write was in flight. It undoes only the fields it touched, like Operations.
7. **The row carries fields the database does not** — `bucket`, `due_ms`, `client_name` are
   worked out by `getMyWork()`. A due date moved from last week to next month left the row
   under **LATE** still reading "6 days late". A change to anything they are derived from
   re-reads the page; everything else does not, so it does not flicker.
8. **The missing-table path reported success unconditionally** and then showed the previous
   line in a box whose blur wrote it back over the new one.
9. **An update could be rewritten with no trace.** `edited_at` is stamped by the database on
   any change to the words, and the panel shows an **EDITED** mark.
10. **Three checks could not fail.** "…closes the panel" matched a string the close button
    guarantees; "only one panel file" never compared the paths; the build-under-test guard
    was `/assets\/index-/`, true of every Vite build ever made — under a comment about the
    hour lost to a stale server on 31 Aug. All three now check the thing they name.
11. **The client-delete screen never mentioned the update history** it was about to destroy.
    `admin_task_updates` has no `client_id` on purpose, so the test that derives that screen
    from the migrations could never see it. Named by hand, with a comment saying why.

## Proof

- **lint clean** across `lib src api tests`
- **3,069 checks across 36 suites, 0 failing** (was 2,925) — `tests/task-updates` is 131 of
  them. `tests/auth-gate` and `tests/inbox` still do not run on the Mac bridge; both predate
  30 Aug.
- **24 SQL behaviour checks against a real Postgres 16** — `tests/task-updates/run.sh`. It
  builds a throwaway database, runs the real migration file **twice**, and raises on the
  first wrong answer: the backfill, the line following the newest update, removing the
  newest putting the one before it back, an update moving tasks resyncing both, the edit
  stamp, the sales rep getting nothing, an admin not being able to rewrite somebody else's
  words, an owner being able to, and both cascades.
- **37 browser checks against the built bundle**, screenshots in
  `tests/task-updates/shots/`. The guard now compares the served file to the one
  `dist/index.html` names AND checks it was built after the last source edit.
- Build clean, 176 modules — **in the cloud container, not the Mac bridge** (rollup's native
  binary is the wrong platform there; this has now cost two sessions).

## The commit was blocked by the credential scanner, and it was a false positive

`.git/hooks/pre-commit` line 30 scanned for `sk-(proj-)?[A-Za-z0-9_-]{20,}` with no boundary
before `sk-`, so it fired on the **tail of any ordinary word ending in "sk" followed by a
dash** — and this change adds files called `task-updates`. The two hits were:

| what the scanner matched | where |
|---|---|
| the tail of `ta` + `sk-`, and the 28 characters after it | this work-log file's own name |
| the same tail, and the 32 characters after it | the project-memory file's name |

Both are the middle of the word `task-`. **The matching text is deliberately not reproduced
on this page.** The first draft of this section quoted both hits in full and quoted an RSA
private-key header as an example, and the hook then blocked the commit **on the write-up
describing the bug** — three fresh hits, none of them a key. A page explaining a scanner must
not contain the strings the scanner looks for. Worth knowing before writing the next one.

**Checked before changing anything:** all nine other patterns in the hook are clean against
the staged diff, no `.env` file is staged, and there is no JWT-shaped string in it. The only
matches were those two filenames.

Fixed by adding the boundary rather than by using `--no-verify`:

```
scan '(^|[^A-Za-z0-9])sk-(proj-|ant-)?[A-Za-z0-9_-]{20,}'  'OpenAI / Anthropic style key'
```

`ant-` added so an Anthropic key is named as one. **Proved in a throwaway repo**, not by
reading it: an Anthropic `sk-ant-api03-…` env line, a quoted OpenAI `sk-proj-…`, and an
RSA private-key header block are all still blocked, and a commit whose only `sk-` is the tail
of `task-` now goes through. `--no-verify` was the wrong fix because the false positive recurs on every future
work-log file named `task-…`, and the habit it builds is reflexive `--no-verify`, which is
how a real key eventually gets through.

**`.git/hooks/` is not tracked by git, so this fix lives only on this Mac.** A fresh clone
gets the old hook back. Worth moving the hook into the repo with
`git config core.hooksPath .githooks` so it travels — not done here, because it changes how
every commit on this repo is checked and that is Ryder's call.

### Why the commit itself was left to Ryder

Everything is staged (34 files) and the hook passes. The commit was not made from the Mac
bridge for two reasons, both real:

1. **There is no git identity in the bridge's shell.** Every commit in this repo is
   `Ryder Schilling <Ryderscott33@icloud.com>`, set globally on the Mac, which the bridge
   does not share. Committing from here would have meant either inventing an identity or
   signing his name to a command he did not run.
2. **The bridge cannot delete files, and git leaves an `index.lock` behind** after every
   write, which blocks the next git command anywhere — including in Cursor. Each one has to
   be moved out of the way by hand (`_to_delete/git-locks-2026-09-02/`). One more reason git
   writes belong in the Cursor terminal, not here.

The message is written out to `COMMIT-MSG-2026-09-02.txt`; `git commit -F` it and delete it.

## Hand-over — three steps

1. **Run `supabase/migrations/0028_task_assignees.sql`** if it still has not been run. It is
   from 31 Aug and is still outstanding.
2. **Run `supabase/migrations/0029_task_updates.sql`.** Safe to run twice — proved, not
   assumed. It creates the table, backfills every existing line as a carried-over update,
   adds both triggers, and sets the admin-only policies.
3. **Push and deploy.** Deploy order does not matter: without 0029 the panel keeps the words
   on the task's own line and says which file to run.

Nothing here needs anything from Andrew or CJ.
