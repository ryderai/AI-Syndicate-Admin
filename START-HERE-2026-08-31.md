# START HERE (SUPERSEDED — read START-HERE-2026-09-01.md first)

> Superseded on the evening of 31 Aug 2026. Its "nothing is deployed" line is wrong: Ryder
> deployed that morning and Notion has moved in since. Kept for its traps and its history.

# START HERE — AI Syndicate admin console, handed over Mon 31 Aug 2026

**This replaces `START-HERE-2026-08-30.md`, which is now wrong on the one thing that mattered most:
it says 0026 is not run. It is. So is 0027.**

Everything below is on disk, it all passes, and **none of it is deployed and none of it is pushed.**

---

## Where things stand

| | |
|---|---|
| Migrations | **0025, 0026 and 0027 all RUN** |
| Deployed | **no** — everything is local |
| Pushed | **no** — 18 modified files, 10 new, nothing committed |
| Tests | **2,489 checks across 25 suites, all passing** |
| Lint | clean across `lib src api tests` |
| Build | must run in the cloud container — `npm run build` cannot run on the Mac bridge |
| Pipeline | 3,663 contacts at 2,765 firms |

`tests/auth-gate` and `tests/inbox` do not run on the Mac bridge — playwright is missing and the
inbox test has a bad relative import. **Both predate 30 Aug. Do not "fix" them by rewriting them.**

---

## Read these first, in this order

1. **`CONTEXT-FOR-AI.md` §52 – §55** — the whole of 30–31 Aug in the repo's own words.
2. **Project memory** (`project_memory_read`), these four:
   - `email-drafter-and-migrations-run_2026-08-31` ← the newest, and the two traps below
   - `pipeline-rebuilt-to-spec_2026-08-30`
   - `log-a-touch-from-the-row_2026-08-30`
   - `floor-hides-other-reps-leads_2026-08-30`
3. **`append-only-never-rewrite-shared-files`** — before writing anything shared.

---

## What the sales pipeline is now

**The rule: if the system can work it out, the rep is never asked.** A rep answers three questions
and no others — *what did you do · how did it go · what's next.*

| | |
|---|---|
| Stages a person can pick | **6** — Follow up · Meeting · Proposal · Won · Lost · Not a fit |
| Stages the system derives | New · Researching · Contacted · In conversation · Reopened — **settable nowhere** |
| What a rep sees | their own leads plus the unclaimed ones. Nothing else. |
| A reply | stops the cadence, and is the top card in My Day until answered |
| A bounce | stops the cadence, refuses the email option, refuses a draft |
| Logging a touch | two clicks on the Contacted? cell, then "and next?" for a date |
| The safety net | three saved filters: No next step · Gone quiet · Claims nobody is working (owners) |
| The gate | Follow up + Meeting need a FUTURE date; Proposal needs a proposal with an amount |
| Email | Draft email on every row → **Copy & mark it sent** logs it and asks for the date |

---

## The three traps that cost the most time, so nobody pays twice

### 1. Adding an export to a `lib/` file is invisible to a running dev server

A new `api/` route 500'd on every request with the reason only in the terminal. Node imported it
fine. Cause: `canEmail` had just been added to `lib/sales-rules.js`, the dev server had already
loaded that module, and **Node's ESM loader caches a module by URL for the life of the process**.
The vite dev plugin cache-busts the `api/` file on its mtime and **nothing else**.

**Restart `npm run dev`.** Vercel deploys a fresh process, so it never arises there.
Found with a probe route that imported each dependency and printed its export list.

### 2. `apiFetch` returns `{ ok, data }` and stringifies the body itself

Spreading the response gives you an object with none of your fields. Passing `JSON.stringify()` as
`body` sends a JSON string of a JSON string — which *survives locally* (two things parse it) and
breaks on Vercel.

### 3. Restricting one control is not restricting the act

The stage picker was cut to six on the sheet, and three other doors were still open within the hour:
the drawer's `<select>` (which also bypassed the gate entirely), two drawer buttons, and the AI
Brain's own stage list. **Count the writers, not the screens.** Same lesson as the AI-Brain leak in
§52.

---

## New files, so nothing gets missed on the first commit

```
lib/touch-log.js                               what a (channel, outcome) pick means
lib/lead-email.js                              the drafter's rules, fact sheet and gate
api/lead-email.js                              writes one draft, never sends
src/components/admin/touchPicker.jsx           the two-level Contacted? popover
src/components/admin/emailDraft.jsx            the draft panel
supabase/migrations/0027_pipeline_spec.sql     RUN
tests/touch-log/  tests/pipeline-spec/  tests/lead-email/
WORK-LOG/2026-08-30--internal--floor-stops-showing-another-reps-leads.md
WORK-LOG/2026-08-30--internal--log-a-touch-from-the-contacted-cell.md
WORK-LOG/2026-08-30--internal--the-pipeline-rebuilt-to-the-spec.md
WORK-LOG/2026-08-31--internal--draft-the-next-email-from-the-row.md
```

`git status` shows them all as untracked. None is git-ignored — check before committing.

---

## Rules this console keeps having to relearn

- **Count the doors.** A page, an AI context block, a tool the AI can call, an endpoint, a report.
  The service role opens all of them.
- **A timestamp captured before a write is not the timestamp of that write.** One variable killed
  the flagship feature with every test passing.
- **Teach the app a value before the database can hold it.** Knowing a stage is not writing one.
- **A saved preference can hide a feature completely.** Twice now.
- **A loose regex is a guard that cannot fire.** `/onPatch\(\{ stage:/` passed while the code said
  `onPatch(\n  { stage:`.
- **A test pinned to a literal fails every time the literal is correctly extended**, which teaches
  people to delete the test. Pin the thing that matters.
- **A round number on a screen is a bug until proved otherwise.**
- **`null` and `0` are different sentences.**
- **A comment that survives a reversal will reverse the reversal.**

---

## Open, and worth picking up

1. **Deploy.** Nothing from 30–31 Aug is live, and all three migrations are now in.
2. **An `ANTHROPIC_API_KEY`.** Without it the email drafter returns a skeleton rather than a written
   draft. The panel says which one it is. `/api/rep-report` confirms the key is absent.
3. **The rep Floor has never been driven end to end.** The dev server runs on live keys and there is
   no sales-role account. It needs one `VITE_NO_SIGNIN=true` run — four steps at the bottom of
   `WORK-LOG/2026-08-30--internal--floor-stops-showing-another-reps-leads.md`.
4. **A reply does not pause the cadence's clock.** `last_touch_at` still means "when did WE last
   touch them", which is correct, but a lead that wrote back still reads as owed a touch on the old
   clock. A decision, not a bug.
5. **Test rows left in the pipeline on purpose.** `Christina Schmotolocha` (Lin Realty Group) carries
   a voicemail, an email and a booked follow-up from verifying this work, and is claimed by Ryder.
   The touches were not undone — handing a lead back writes a second timeline line, so undoing a
   test leaves more noise than the test did.
