# 2026-08-30 — internal — the sheet import, one click, and four silent bugs

**Asked for (Ryder, in his words):** "all of our leads are dumped into this sheet
in google and already has the right rows and categories, so i want to make it
extremely easy to transfer everything and make it as few clicks as possible and
also use the exact same rows. so build the admin to be able to receieve this
file without asking any questions, deleteing any data, and filling in all the
rows, clients, and filters correctly … just fill in everything we have a row for
and leave out the rest. dont mess with the google sheet at all."

**Settled with him first:** the sheet is a one-time move — after this, CJ pulls
leads out of Apollo and drops the export straight into the admin. So the shape
of the drop stays for ever, and it will not be the same shape twice.

---

## What was found before any code was written

The importer trusted the heading row. On CJ's real workbook that is wrong on
three of the seven lead tabs and missing on a fourth — and the whole thing was
being read through an .xlsx reader that was losing most of every row.

| | |
|---|---|
| People the old importer took | **36** |
| People actually in the file | **3,663** |
| Errors it reported | **none** |

Four separate bugs, every one silent:

1. **`src/lib/sheet.js` cut every row at its first empty cell.** The row pattern
   ended at the first `/>`, and an empty cell is written `<c r="A2" s="7"/>`.
   The Jewelry tab came back as 3 rows instead of 71. Shipped Aug 20.
2. **`insertLeadsBatch` threw on every live import.** `const rows = data || []`
   in the same block as `rows.slice(...)` — temporal dead zone, first iteration.
   Preview mode returns before it, so every test passed; the throw surfaced as
   "Could not read that file", blaming the spreadsheet, after the firms and the
   batch record had already been written.
3. **`toInt` turned "1.0156E7" into 1.** Excel writes big round numbers in
   scientific notation. Ten million dollars of revenue was saved as one dollar.
   "N/A" was saved as 0 — and 0/100 is a real site score.
4. **A decimal number matched as a hostname.** "42.0" — and the reader returns
   every whole number with a ".0" — so the headcount column read as a website
   and took the field off the real one.

And the three tabs whose headings lie: **Jewelry** (heading says "Website" over
a LinkedIn address), **Car Dealership** (data slides three columns from 23, and
a second record block is pasted from column 45), **Luxury Agents** (no heading
row at all — 821 people skipped on every import since the tab was made).

## What was built

**`lib/sheet-columns.js` — a new reader.** Every column is scored on what is IN
it; the heading is a hint worth +0.55, less than the gap between a strong signal
and a weak one. So right data beats a wrong heading, and a heading still settles
what content genuinely cannot. The rules that carry the weight:

- A pair with content behind it beats an empty labelled column, always.
- City/state/country are decided by which **address run** they sit in, never by
  their own values. A street address opens the firm's block.
- The six hand-filled columns can only sit **left of the contact's name**.
- First name and last name only ever arrive **as a pair**.
- A second street address or location line ends the list. A second **email**
  does not — work plus personal is normal.
- When it cannot tell whether row 1 is a heading, **it is a person**. A heading
  read as a person is one junk row you can see; a person read as a heading is
  gone.
- Trust is relative to the tab: at least 5 values and 2% of the rows.

**One click.** Four screens became one: pick the file and it goes. No tabs to
tick, no columns to match, no plan to read. Everything the reader had to decide
is printed on the result screen afterwards, column by column, in plain words.

**Nothing is ever deleted.** `mergeLead` / `mergeCompany` fill what is blank and
refresh plain facts, and refuse to: blank a value, move a stage backwards,
reopen a closed deal, take a lead off its rep, or narrow a timer. A typed next
step is kept and the sheet's version goes on the timeline. And the match has a
**kind** — colleagues share a switchboard and a website, so on anything weaker
than an email match the fields that say who somebody IS are left alone.

**Five columns the sheet had and the console did not** (migration 0025): the
contact's own location line and country, and the firm's name-for-emails,
keywords and total funding. Each was being read and dropped on every import.

## Proof

- lint 0 across `lib src api tests` · build clean at 157 modules.
- `tests/sheet-columns` — **52 checks**, pinning all 200 columns of the seven
  real tabs plus every rule above and all four bugs.
- Every other suite unchanged: sales 110, sales-sheet 139, floor-scoping 231,
  ai-cost 324, lead-tags 220, outreach-stats 177, and the rest.
- **The real workbook driven through the built bundle, twice.**
  First run: **3,663 people, 2,764 firms, 8 seconds, one click.**
  Second run, same file on top of itself: **5 added, 0 new firms, 3,658
  unchanged, 0 deleted.**
- **Two adversarial agents found 26 defects in my own work**, all fixed —
  including the result screen printing "Every column matched its heading" on the
  three tabs where it did not, and a test of mine that asserted
  `undefined === undefined` and proved nothing.

`tests/auth-gate` and `tests/inbox` do not run on the Mac bridge (playwright
missing; a bad relative import in the inbox test). Both predate this work and
neither was touched.

## Blocked until

1. `0025_sheet_columns.sql` is run in Supabase. Without it the import still
   works — it leaves five columns out and says so on screen.
2. Deployed.

## Not done, and worth knowing

- Row 159 of Luxury Agents is a **second heading row** buried mid-tab. It comes
  in as one junk contact and is named on screen.
- The sheet has a rep called **Hunter Grant** (55 rows) with no console account,
  so those rows arrive unclaimed. Same for "Cameron" (47) and "Troy" (236).
- **Start over cannot undo a row that was filled in** — it deletes by import
  batch, and somebody already on file belongs to no batch. The screen says so.
- In sample mode a second import takes about 70 seconds. That is the sample
  store's own cost, not the live path, which skips unchanged rows entirely.

---

## Follow-up, same day — Start over said "permission denied"

Ryder ran the import before running migration 0025, so the five new columns came in empty. He then
ran 0025 and tried **Sales → Start over** to redo it cleanly, and got:

> This cannot be worked out. permission denied for function admin_clear_import

**It is a missing GRANT, not a bug in the function.** Every function the console calls has a
`grant execute … to authenticated` line in the migration that created it — checked all eleven, all
present in the files. So the files are right and the database is not: `admin_clear_import` got its
`revoke … from anon, public` and never got its `grant … to authenticated`.

**This is the second time in two days.** Aug 29 it was `admin_is_member`, and the whole console
said "you're not on the team". Filed as its own memory note, because the wording of the error is
the entire diagnosis: *permission denied* means the function exists and the grant is missing;
*could not find the function* means the function does not exist.

**`0026_grants_repair.sql`** re-asserts the grant on all eleven, prints a `can_execute` table
afterwards, and is guarded so a function that does not exist is skipped and named rather than
throwing — which is how the original grants were lost. It only grants: no revoke, no drop, no
table touched, safe to re-run.

Proved on a real Postgres in the container, not read: 11 of 11 flipped from denied to allowed, an
already-granted one was left alone, a missing one was skipped and reported, and a second run was a
clean no-op.

### He almost certainly does not need Start over

Dropping the same file in again fills the five blanks and touches nothing else. Run against his
exact row shape:

```
LEAD patch : {"address":"Aliso Viejo, California, United States","country":"United States"}
FIRM patch : {"alias":"Audi Mission Viejo","keywords":"Google Search Console, Akamai CDN, Adobe"}
```

The stage stayed `contacted` and did not fall back to `new`. The rep kept the lead. The typed next
step survived. The first-contact date was not blanked. The sheet's site score was refused in
favour of the one we measured. That is the merge doing exactly what it was built for, so the
recommendation is: **fix the grant, then re-drop the file — do not clear anything.**

Also worth noting from his screenshot: the run reads **"Planned 3673, landed 3663"**. That is the
10 rows that are the same person twice inside the workbook, which the result screen reports
separately. Not a loss.

---

## Follow-up 2 — "this says 999 leads, when i think we have 3000+"

He was right, and it was not a display bug.

**Supabase answers one request with at most 1,000 rows.** No error, no flag. Five readers in
`src/lib/data.js` asked for more and believed what came back.

The giveaway was on his screen: Medspas 299 · Car Dealership 544 · Jewelry 70 · Dental 87 —
**exactly 1,000**, and exactly the four tabs imported last. Sorted newest-first, stopped after one
page, so Luxury Agents, Real Estate and Law Firm all showed **0**.

### The part that made it invisible

Every one of those readers already had a warning for this:

```js
const res = await selectAll("admin_leads", { limit: LEAD_FETCH_CAP + 1 });   // 2001
if (res.rows.length > LEAD_FETCH_CAP) { …tell the user we capped… }          // > 2000
```

The server capped at 1,000. `1000 > 2000` is never true. **Five carefully worded sentences about
missing data were unreachable code**, in a codebase whose whole rule is that a page must say what
it could not see.

| reader | claimed cap | actually got | cost |
|---|---|---|---|
| `listLeads` | 2,000 | 1,000 | 1,000 of 3,663 on screen |
| **`listCompanies`** | 2,000 | 1,000 | **the importer's duplicate check** |
| `listAllLeadActivity` | 4,000 | 1,000 | cadence touch counts |
| `listLeadTagState` | 12,000 | 1,000 | tags and the tag filters |
| `listCompanyReports` | 2,000 | 1,000 | the Firms tab's scans |

**`listCompanies` was the dangerous one.** It is how the importer decides which firms it already
has. With 2,761 firms on file it could see 1,000 — so the re-import recommended in Follow-up 1
would have created a second copy of the other 1,761 and called them new. Caught before he ran it.

### The fix

`lib/paging.js#fetchPaged` — pages of 1,000 via `.range()` until a short page comes back, and
REPORTS its ceiling rather than silently applying it. `selectAll` pages automatically for any
`limit > 1000`, so every future caller is covered without having to remember. Also: `companies`
was missing from the Sales board's `truncated` list, so the one cap that mattered most was the one
cap the page could not have told him about. Added.

**Ordering is on the column AND then `id`.** `created_at` is not unique — one import statement
writes two hundred rows sharing a timestamp — and without the tiebreak a tie across a page
boundary makes page 2 return rows page 1 already had while others never come back at all. That
trades a visible undercount for an invisible one.

### Proof

`tests/paging` — 11 checks against a fake enforcing the 1,000 ceiling. Mutation-checked: remove
the `id` tiebreak, one test fails; stop after one page, seven fail.

Then end to end against the real thing — a live Postgres holding 3,663 rows (200 sharing one
timestamp), behind a server enforcing max-rows=1000, driven by the actual `@supabase/supabase-js`
client:

```
ONE REQUEST asking for 50,000 : 1000 rows   <- what the Sales page was doing
PAGED reader                  : 3663 rows
unique ids                    : 3663 (no repeats)
rows missing                  : none
```

Lint clean, build clean, all 21 suites pass (2,062 checks), the sheet import still runs end to end.

### Worth carrying

**A round number on a screen is a bug until proved otherwise.** And **a guard that has never once
fired is not a guard** — worth asking of any warning here: under what value would this print?

The Aug 26 note already said "six data.js readers cap rows and never say so" and left it as an open
trap. It was worse than that note thought: they could not say so, by construction.

---

## Follow-up 3 — the Sales page simplified, and Stats got a page of its own

*"everything seems really complex and jumbled, i want to simplify it all."*

Seven bands of chrome sat above the first row of data: six tiles (four reading 0), the summary,
two toolbar rows, eight list tabs, and fourteen filter dropdowns across two more rows.

Asked how far to go he picked **one single row of controls**, and separately said to keep the
**summary bar** and the **list tabs**, that *"its important to be abel to filter by type of
business, and the pipeline is basically where you can filter them by stage"*, and asked for a
**stats page** under a Sales dropdown for owner and admin.

**Those two answers conflicted** — the "one single row" option turned the list tabs into a
dropdown, and he also asked to keep the tabs. Kept the tabs and collapsed only the controls, and
said so rather than quietly picking one.

### The sheet

`summary → one row of controls → list tabs → table`

- Six tiles off the sheet; they stay on My Day, and the team's version of all six is on Stats.
- One control row: view tabs · search · stage · owner · `⋯` · Add a contact.
- Fourteen filter dropdowns became two: `Type of business` pinned, everything else behind
  `Filters · N`, which counts COLUMNS not values and clears them all.
- The SAMPLE/LIVE badge moved beside the numbers it describes — a duplicate of the header's, and
  the item pushing Add a contact onto a second line.

Four things not to break, each written into the code beside the thing it protects: the pressed-tile
chip (a filter with no control on screen is one nobody can turn off), the single two-level popover
(nesting closes itself instantly), `flex: 1 1 0` on the search (flex wraps from the basis), and
`PINNED_FILTERS`.

### Stats

`src/components/admin/SalesStats.jsx`, reached from a Sales dropdown built as a CHILD entry so
`parentOf()` and `pageIdsForRole()` work with no new mechanism. Owner/admin only, and the menu is
not the gate — `tests/sales` asserts a rep cannot open it even by URL.

**Not one number on it is new.** Same `repStats` / `outreachByRep` / `lossReasons`, same
`getSalesBoard()` read. `RepNumbersModal` is DELETED: two screens working the same answer out twice
is how they come to disagree. The team line is counted over every lead rather than by summing the
reps — 3,650 of 3,663 have no owner, and a deal won-then-released has none either.

### Proof

lint 0, build clean, **2,102 checks across 21 suites all passing**, and the whole thing driven in a
browser: sheet order read off the live DOM, control row measured at ONE line (66px) at 1440, the
Filters panel drilled into and backed out of, the `⋯` menu opened and Stats reached from it, the
other three views checked for the summary card, and three narrower widths checked for sideways
scroll. No console errors.

Measuring the toolbar by each child's `top` reported "4 rows" and was **wrong** —
`align-items: center` gives items of different heights different tops on the same line. Group by
vertical centre, or read the container's height.

### Said honestly rather than claimed

Below about 1440px the control row wraps to two lines. That is deliberate — the alternative is a
sideways scrollbar — and it is stated rather than described as "one row always".
