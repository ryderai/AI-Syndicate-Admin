# Bringing Notion into the console, and giving the sheet's reps accounts
**Mon 31 Aug 2026, overnight.** Internal. Ryder asleep — built without questions.

Repo record: `CONTEXT-FOR-AI.md` **§57**.

## The ask, in his words

> "the new admin is ready to imput our clients and also merge our lead sheet so everything
> now runs off of the admin… pull from notion all of our clients, create a record for each
> one… and write the to dos in operations just like they are in notion. then we also need to
> create a sales rep with each of the people who are on the lead sheet."

## What is DONE, live, tonight

**Six clients are in the console.** Pulled from Notion 🏢 Clients (data source
`ff31a55e-1bca-48d0-bf84-94e2b4fbdcf5`), pasted through the Clients page's existing
Import button on the deployed console, verified on screen: 6 imported, 0 skipped, the list
went 1 → 7 (the 7th is `ZZ TEST — Dry Run Realty`, left from the Aug 30 dry run).

Shiner Law Group · Dahler Group (30A) · Justin Dyar · Michelle Creamer · Jessica Mackrael ·
Matt McCall.

Two Notion rows were NOT brought over and this is on purpose: one is completely empty, and
`Ryder Schilling LLC` is Ryder's own intake test of the form, not a client.

**Three clients carry a stage that is a PLACEHOLDER, said so in their own notes:**
- *Justin Dyar* — Notion says Month 2 with no week number and no start date. Reads "Ongoing".
- *Michelle Creamer* — Notion says "website build" / "waiting on IDX". Neither is a stage this
  console has. Reads "Onboarding".
- *Jessica Mackrael* — "website build" has no equivalent, so her Week 1 is what carried.

Contact phone and the Notion score fields do not exist on the client import, so Shiner's
phone is written into his notes rather than dropped.

## What is BUILT and waiting on a push

Everything below is on disk, lint-clean, and driven in a real browser. **None of it is
deployed and none of it is pushed.**

### 1. Bring the tasks over from Notion — Operations toolbar

There was no task import at all. Project memory has carried "No task-level JSON import —
that is what the real Notion rows need to come over" as an open item since 17 Aug.

`lib/notion-merge.js` + `src/components/admin/Operations.jsx` (`ImportTasksModal`) +
`tests/notion-merge` (73 checks).

Two steps on purpose: **Check it first** shows exactly what will happen — how many are new,
which fields change on each existing task with old → new, and every refusal by name — and
only then does **Bring them over** write anything.

Six rules, each with a test:
1. A task is matched on **(client, task name)**, so a second paste updates instead of doubling.
2. **A client is never invented.** A row whose client is not here is refused by name. Two
   clients answering to one name is also refused rather than picked between.
3. **An empty Notion cell never blanks a value here.**
4. **Done never reopens** — a stale export cannot drag a finished task back to To Do. Every
   other field on a done task still updates.
5. **A second assignee is written into the brief, never dropped.** `assigned_to` holds one
   person; the first named owns the row.
6. **A brief typed in the console is never overwritten** by the export's boilerplate link.

Plus: assignees match on **email**, never on a display name (two members are called "Ryder
Schilling"), and a **sales rep is never given an Operations task** — the rule in
`src/lib/people.js` that every picker already obeys, which this import was the one door left
open on.

### 2. The reps on the sheet — Sales → ⋯ → "Reps on the sheet"

`lib/sales-owners.js` + `api/sales-owners.js` + `src/components/admin/salesOwners.jsx` +
`tests/sales-owners` (79 checks).

The sheet went in on 30 Aug — 3,663 people — and the Sales Owner text was kept on every row.
The reps themselves were never created, so every claim the floor had built up reads as
nobody's. This screen makes the accounts and hands the rows back.

**Nine spellings are eight people.** "Brandon R" and "Brandon Roberts" are one man across 82
rows. Read off the workbook 31 Aug: Brandon Roberts 82 · Larry Pike 58 · Cameron 27 · Troy 7 ·
Hunter Grant 6 · Matt Brown 6 · Sawyer 1 · "Andrew" 1. (Row counts from CJ's workbook are a
FLOOR — Drive truncates the export. The screen counts off the real lead rows instead.)

**It sends nobody an email.** Most of these are one word in a spreadsheet column with no
address on record anywhere; guessing one and emailing it is a message sent to a stranger on
the agency's behalf. Accounts are created quietly with a placeholder address on
`sheet.aisyndicate.invalid` — a domain RFC 2606 guarantees resolves nowhere — so the claims
land back on the right rep today and a proper Team-page invite can go out whenever a real
address exists. `/api/invite` is untouched and is still the way a real person gets a login.

**"Andrew" is put in front of a person rather than decided.** It matches Andrew Soncini on the
first name alone, and a first name is not enough to hand somebody a pipeline.

### 3. Two smaller things the above needed

- `src/lib/data.js` gained `listAllTasksForImport()` — a paged read. `listTasks` caps at 500
  with no warning, and deciding "does this already exist" off a capped list is how one paste
  becomes two copies of 107 rows.
- `vercel.json` gained a 60s ceiling for `api/sales-owners.js`. It is the heaviest route here.

## The payload

`_merge/notion-tasks-2026-08-31.json` — 107 tasks, ready to paste.
Matt McCall 36 · Shiner 21 · Justin Dyar 18 · Jessica Mackrael 11 · Michelle Creamer 11 ·
Dahler 10. 68 carry a one-line status, 87 carry a due date, 31 carry the Notion page's own
body text. 92 are assigned to somebody who has an account here.

`_merge/notion-clients-2026-08-31.json` — the six, already imported.

**A password was found sitting in plain text in Notion.** The page "Get access to Website and
Google Tools" (Michelle Creamer) holds a GoDaddy customer number and password typed into the
page body. It is **deliberately not copied** into the payload — the description there says so
and points at Bitwarden instead. Two things still need doing by hand: put them in Bitwarden,
then delete them off the Notion page.

## Proof

- lint clean across `lib src api tests`.
- **2,829 checks across 33 suites, all passing.** Was 2,489 across 25. `tests/auth-gate` and
  `tests/inbox` still do not run on the Mac bridge; both predate this and were not touched.
- Build clean in the cloud container, 171 modules.
- Driven in a real browser (headless Chromium against the built bundle, preview mode):
  12 tasks → 15; a row for an unknown client refused by name; a row assigned to a sales rep
  created but left unassigned with the reason on screen; the same paste again = 0 new, 0
  updated; a re-paste that carried new text changed `latest_report` only and left a
  console-written brief alone, with the field listed old → new before anything ran; the real
  107-row payload against the wrong client list = 107 refused and the button dead.
- The client import verified on the **deployed** console, screenshotted.

## An adversarial checker found 15 defects in this work. All 15 are fixed.

Worth carrying, in the order they would have cost the most:

1. **`matchOwner`'s "first" rule is not safe to act on.** It fires on a shared first name
   alone, so a sheet name of "Andrew Miller" matched Andrew Soncini and 40 rows of one
   person's work would have landed on another. Only `exact` and `initial` are acted on now —
   `CONFIDENT` in `lib/sales-owners.js` names them, and a first-name-only hit is shown to a
   person and acted on in neither direction.
2. **The screen said "1" above a button that was about to move three thousand rows.** The
   claimable count was computed against the roster as it IS rather than as it WILL BE.
   `projectedTeam()` exists for exactly this.
3. **The claim wrote today's date.** `claimed_at` starts the 3-day first-contact clock and
   `cadence_started_at` the 5-touch cadence; writing one without the other gives a lead a
   cadence that began at the epoch, and stamping both with NOW would have had the sweep warn
   on three thousand leads three business days later. It now derives the date from
   `first_contact_at` exactly as `lib/sales-import.js` does, and writes an
   `admin_lead_activity` line so a row that changes hands says so on its own timeline.
4. **A half-finished run could strand a person for ever.** createUser + the roster upsert are
   two writes; dying between them left an auth account with no roster row, and the retry
   regenerated the same address and failed permanently. It now looks the address up first,
   paging, the way `api/invite.js` already did.
5. **`groupOwnerNames` and `matchOwner` genuinely disagreed** on any surname of more than one
   word: "Mary Jo B" folded into "Mary Jo Baker" on the screen and then claimed nothing.
   The grouping now reads the surname the same way `matchOwner` does — the second word only.
6. **The check screen showed counts, not changes**, so agreeing to it was agreeing to a
   number. It now lists every field with its old and new value.
7. Also fixed: the import could hand a task to a sales rep; the claim button was disabled in
   exactly the state its own error text told you to press it in; a partial lead read was
   swallowed; a typed email was never format-checked; the "which spelling do we show" rule
   picked the SHOUTING one; an activity log fired for an import of nothing.

**Eight rules had no test at all** — deleting them broke nothing. Two more were guards that
could not fire: one checked source-text ordering, and one looked for `"Access"` anywhere in a
5,000-line file, so `TASK_CATEGORIES` could have been deleted outright and it still passed.
All are pinned properly now.

**And one about method, which cost an hour:** every browser check ran green against a stale
`npx serve` still holding the port from a build two hours old, serving SPA fallbacks so even a
missing file answered 200. The rep-assignment guard "did not fire" and the code was correct
the whole time. **Check what is actually listening before believing a browser.**

## Still open

1. **Push and deploy.** The tasks and the reps both need the new code live. Nothing from
   30–31 Aug is deployed.
2. **Then paste `_merge/notion-tasks-2026-08-31.json`** into Operations → Bring tasks over.
3. **Then Sales → ⋯ → Reps on the sheet** → Make the accounts.
4. Real email addresses for the seven reps, so their placeholder accounts become real logins.
5. The GoDaddy credentials above, into Bitwarden and out of Notion.
6. Justin Dyar's start date — his week number follows from it.
