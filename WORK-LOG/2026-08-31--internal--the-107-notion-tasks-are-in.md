# The 107 Notion tasks are IN the console — live, verified
**Mon 31 Aug 2026, ~1:00 PM CT.** Internal. Follows
`WORK-LOG/2026-08-31--internal--the-notion-merge-and-the-reps-on-the-sheet.md`,
which built the importer overnight. Ryder deployed it this morning.

Ryder: *"now can you bring over all of the operations from notion and put them in exactly
how they are in notion so we can start working in our platform and leave notion, dont
delete anything from notion, only copy."*

## Done

**107 tasks created. 0 refused. 0 failures.** Operations went 4 → 111 rows (the other 4 are
`ZZ TEST — Dry Run Realty`).

| Client | In Notion | In the console | Still open |
|---|---|---|---|
| Matt McCall | 36 | **36** | 36 |
| Shiner Law Group | 21 | **21** | 12 |
| Justin Dyar | 18 | **18** | 12 |
| Jessica Mackrael | 11 | **11** | 7 |
| Michelle Creamer | 11 | **11** | 4 |
| Dahler Group (30A) | 10 | **10** | 3 |

Every group count matches Notion exactly.

**Nothing in Notion was touched.** Only read calls were made — `notion-search`,
`notion-fetch` and `notion-query-data-sources`. No create, update, move or delete.

## What came across on each task

Task name · status · priority · category · phase · due date · the one-line status
(`latest_report`) · the assignee · and **the Notion page's own body text** as the standing
brief.

- 68 rows carry a one-line status, 87 carry a due date, 92 are assigned to somebody.
- **31 rows carry the full page body** — the long write-ups. Proved live by searching the
  console for "Rosemary Beach farmers market", a phrase that exists only inside one Notion
  page body: 1 result.
- 15 rows are unassigned, which is what Notion says. Nothing was invented.

## The one thing deliberately NOT copied

The Notion page "Get access to Website and Google Tools" (Jessica Mackrael) has a **GoDaddy
customer number and password typed into the page body in plain text**. That task is in the
console, and where the password was it now reads: *"They are DELIBERATELY NOT COPIED HERE. A
password never goes in a note, in Notion, or in the console — a Bitwarden link only. Put both
in Bitwarden, then delete them off the Notion page."*

Two things still to do by hand: put them in Bitwarden, then delete them off Notion.

## Proof

- Check screen before writing: **107 new · 0 updated · 0 already right · 0 refused.**
- Result screen: **107 created · 0 updated**, no failures.
- Row count on the page afterwards: **111 shown · 78 open · 31 late.**
- Group counts read off the live page, listed above.
- **The same 107 pasted a second time: `0 new · 0 updated · 107 already right`.** The
  idempotency rule holds against the real database, not just in a test.
- One page-body phrase searched for and found.

## Two notes for whoever reads this next

**The payload could not be typed into the box in one go from a cloud session.** The file is
211 KB. It was loaded in fourteen pieces through the browser's own console into a buffer, then
written into the textarea in one action with React's native value setter — a plain
`.value =` assignment does not reach React state. Worth knowing before anyone tries to paste
a large import from a session that is not sitting at the Mac.

**The payload on disk is `_merge/notion-tasks-2026-08-31.json`.** It is the same 107 rows and
it stays there, so the import can be re-run at any time without going back to Notion.

## Still open

1. **The reps on the sheet.** Sales → ⋯ → Reps on the sheet. 7 accounts to make, and about
   three thousand lead rows to hand back to them. Not run yet.
2. Notion itself is untouched and still the source of truth until somebody decides to stop
   updating it. Nothing here deletes or archives anything there.
3. The GoDaddy credentials above.
