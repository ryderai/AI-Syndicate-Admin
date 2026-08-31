# START HERE — AI Syndicate admin console, handed over Sun 30 Aug 2026

> ⚠️ **SUPERSEDED BY `START-HERE-2026-08-31.md`.** This one says 0026 is not run. It IS run, and so
> is 0027. Everything below is the picture as it stood on the evening of 30 Aug; read the 31 Aug
> handover for the current one. Kept because its account of the 30 Aug work is still accurate.

Everything below was built on 30 Aug. It is all on disk, it all passes, and **none of it is
deployed and none of it is pushed.**

---

## Read these first, in this order

1. **`CONTEXT-FOR-AI.md` §49 and §50** — the whole of 30 Aug in the repo's own words.
2. **Project memory** (`project_memory_read`), these five files:
   - `sheet-import-one-click-and-4-silent-bugs_2026-08-30`
   - `supabase-returns-1000-rows-and-says-nothing`
   - `lost-grants-have-now-broken-two-pages`
   - `sales-page-simplified-and-stats-page_2026-08-30`
   - `append-only-never-rewrite-shared-files` ← read before writing anything shared
3. **`WORK-LOG/2026-08-30--internal--sheet-import-one-click-and-four-silent-bugs.md`** — the
   everything-that-happened record, including three follow-ups.

---

## The one thing to do before anything else

**Run `supabase/migrations/0026_grants_repair.sql`** in the Supabase SQL editor. Exact clicks are
in `SETUP.md` → "Migration 0026".

Without it **Sales → Start over and every "Undo this import" button are dead** with
`permission denied for function admin_clear_import`. It only grants — no revoke, no drop, no table
touched — and it is safe to run again any time.

`0025_sheet_columns.sql` **is already run.** 0026 is **not confirmed run** as of this handover.

---

## Where things stand

**The pipeline is real:** 3,663 contacts at 2,761 firms, imported from CJ's outreach workbook.

| | |
|---|---|
| Migrations | 0025 run · **0026 NOT run** |
| Deployed | **no** — everything is local |
| Pushed | **no** — 14 modified files, 8 new, nothing committed |
| Tests | 2,102 checks across 21 suites, all passing |
| Lint | clean across `lib src api tests` |
| Build | clean (must run in the cloud container — `npm run build` cannot run on the Mac bridge) |

`tests/auth-gate` and `tests/inbox` do not run on the Mac bridge — playwright is missing and the
inbox test has a bad relative import. **Both predate 30 Aug. Do not "fix" them by rewriting the
tests.**

---

## What changed on 30 Aug

### The sheet importer — one click (§49)
Drop the file and it goes: no tab ticking, no column matching, no plan screen. Columns are worked
out from their **values**, not the heading row, because three of the seven lead tabs disagree with
their own headings and one has none at all. Nobody is ever deleted and no filled-in value is ever
emptied.

Four silent bugs fixed on the way, each of which reported no error:
1. the `.xlsx` reader cut every row at its first empty cell — **36 of 3,663 people imported**
2. `insertLeadsBatch` threw on every live import (temporal dead zone) — **no live import ever worked**
3. `toInt` turned `"1.0156E7"` into `1`, and `"N/A"` into `0`
4. `42.0` matched as a hostname, so headcounts read as websites

### Reading more than 1,000 rows (§50)
**Supabase answers one request with at most 1,000 rows, with no error and no flag.** Five readers
asked for more and believed the answer, and their own "we capped" warnings were unreachable code.
Fixed with `lib/paging.js`. **Never write `.limit(n)` where n > 1000.**

### The Sales page simplified, and Stats (§50)
Seven bands of controls became four. `RepNumbersModal` is **deleted** — its content is now
`src/components/admin/SalesStats.jsx`, owner/admin only, under a Sales dropdown in the sidebar.

---

## New files, so nothing gets missed on the first commit

```
lib/paging.js                                  reading past 1,000 rows
lib/sheet-columns.js                           what a column holds, from its values
src/components/admin/SalesStats.jsx            the Stats page
supabase/migrations/0025_sheet_columns.sql     RUN
supabase/migrations/0026_grants_repair.sql     NOT RUN
tests/paging/test.mjs
tests/sheet-columns/test.mjs + workbook.json
WORK-LOG/2026-08-30--internal--…md
```

`git status` in Cursor shows them all as untracked. None is git-ignored — check before committing.

---

## Rules this console keeps having to relearn

- **A round number on a screen is a bug until proved otherwise.** 999, 1,000, 500 — if a count
  lands on a limit somebody typed, it is the limit talking, not the data.
- **A guard that has never once fired is not a guard.** Five had one. Ask of any warning: under
  what value would this actually print?
- **A migration file being correct is not evidence the database matches it.** Ask the database.
- **Count what went in against what is in the source.** Four bugs, no exception thrown, every
  number on screen plausible.
- **`null` and `0` are different sentences** — "not measured" and "measured, and it is zero".
- **A comment describing behaviour the code does not have is worse than no comment.**
- **Write the test against the behaviour you want, not the one you have.**

---

## Open, and worth picking up

1. **Run 0026, then deploy.** Nothing from 30 Aug is live.
2. **Ryder was mid-rearrange of the Sales page** and asked "what's next" — he had more in mind
   after the tiles, the filters and Stats.
3. **Below ~1440px the sheet's control row wraps to two lines.** Deliberate, not a bug. Only worth
   changing if he asks.
4. **Row 159 of the Luxury Agents tab is a second heading row** buried mid-sheet. It imports as one
   junk contact and is named on the result screen.
5. **Three names in the sheet have no console account** — Hunter Grant (55 rows), Cameron (47),
   Troy (236). Those rows arrive unclaimed. CJ decides whether they become accounts.
6. **Start over cannot undo a row that was FILLED IN** — it deletes by import batch, and somebody
   already on file belongs to no batch. The result screen says so.

---

## How to work here

- Build and run the browser in the **cloud container**, not on the Mac bridge — `npm run build`
  cannot run there, and it has no network.
- Test the app as a **built bundle** served from `dist/`, driven with Playwright. See
  `testing-a-vite-app-via-built-bundle` in memory.
- `.env.local` has `SUPABASE_DB_URL` and `SUPABASE_ACCESS_TOKEN` **empty**, so a session cannot run
  SQL itself. Ryder pastes it into the Supabase SQL editor.
- Never touch the git index — he runs several sessions at once. See
  `append-only-never-rewrite-shared-files`.
