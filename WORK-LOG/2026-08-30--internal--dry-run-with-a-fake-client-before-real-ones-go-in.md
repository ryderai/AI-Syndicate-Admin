# Dry run: one fake client, four tasks, worked start to finish

Sun 30 Aug 2026, evening · internal · admin console

Ryder's ask, in his words: *"create a client and some tasks, run it as if we were working on
the tasks and managing the client through everything, and make sure everything is working
how it should so when we get real clients in there and working on them that nothing goes
missing, doesn't work, or is broke."*

So this is not a code review. Every line below was done in a browser against the live
database, as the owner, and every defect was seen on a screen before it was looked for in
the source.

## What was done

Created **ZZ TEST — Dry Run Realty** (client id `9ac5fdef-850c-4e73-81c4-8b7a85760a55`),
website, contact, industry, start date, notes. Then four tasks against it, deliberately
covering different shapes:

| Task | Owner | State it ended in |
|---|---|---|
| Baseline AI Access scan and record the score | Ryder (owner) | In progress, due tomorrow |
| Ship llms.txt and agents.md to the site root | Ryder (**the rep login**) | To do, due 02 Sep |
| Add Organization and LocalBusiness schema to every page | CJ | In progress, **overdue** |
| Send the welcome email and book the kickoff call | Ryder (owner) | Blocked, no due date |

Worked through: the New task modal, the inline "+ New task" row, the status chip, the
assignee popover, drag-and-drop on the Board, Done and un-Done, then the client page's
"where this client stands", Generate report, the Work page, Overview and the Team page.

## What WORKED, and was watched working

- Client create → the row, the toast, the deep link `?id=`, and every field read back.
- Both ways of adding a task. The inline row inherits the client from the group it is
  added under.
- Status from the chip, assignee from the popover, drag between board columns — all three
  wrote, and all three survived a full page reload.
- `4 shown · 4 open · 1 late` matched the rows every time it changed.
- The overdue task drew red with a ⚠ on the board; a task due tomorrow did not.
- Work page said "tomorrow" for the 31 Aug task — the team clock is right there.
- **"Where this client stands"** counted correctly: "0 done, 4 open (1 blocked)", named the
  blocked one, named the overdue one and its date, and said no weekly log existed.
- **Generate report** works with no Anthropic key: it says so and ships the counted version
  rather than an empty page.
- Overview: "Active clients 1 of 1", and the new client and the completed task both
  appeared in "What changed lately".

## THE ONE THAT LOSES WORK — found, reproduced, fixed

**Two members are called "Ryder Schilling"** — `ryder@aisyndicate.com` (owner) and
`ryderschilling@gmail.com` (the sales-rep test login made this afternoon). Every person
picker in the console drew `full_name || email`, so **both rows read "Ryder Schilling" with
nothing to tell them apart.**

Assigned "Ship llms.txt" to the second one. It looks completely normal on Operations. It is
**not on Ryder's Work page** and nothing anywhere says so. That is a task that silently
belongs to nobody who is looking for it.

Two people called Chris at a growing agency is a Tuesday, so this is fixed as a rule rather
than as a data accident. `src/lib/people.js`: a name is drawn alone only while it is unique
in the list being drawn; the moment it is not, **every** copy of it carries the part of the
email that tells them apart — "Ryder Schilling (ryder)" and "Ryder Schilling
(ryderschilling)". Applied in all four files that had the old line: Operations, opsTable,
Inbox, SalesPage.

Two details that matter more than they look:

- **The shortening must not create a new collision.** Two people on the same domain differ
  before the @, so the local part is enough and it FITS IN A TABLE CELL. Two people whose
  local parts also match get the whole address. Pinned by a test.
- **The first version appended the full address and that was half a fix**: in the sheet it
  truncated to "Ryder Schilling (ry…" and the two looked identical again. Half a fix is the
  dangerous kind, because it looks disambiguated. The cell also carries a `title` now.

## The date bugs — an evening is when they show

Local time during this run was **Sunday 30 Aug, 8–9pm Chicago**, which is already 31 Aug in
UTC. Everything below was invisible at midday and obvious at 9pm.

**1. "With us" read a client who starts TOMORROW as "1h ago".**
`Clients.jsx` parsed the start date as `Date.parse("2026-08-31T00:00:00Z")` — midnight in
London, 7pm the previous evening in Chicago. And `timeAgo()` had no guard for the future at
all: its first line was `if (s < 60) return "just now"`, and **every negative number is less
than 60**, so a client starting next month read "just now". An onboarding client with a
future start date is the normal case here.
Fixed: `teamDayStartOf()` for the date, and `timeAgo` moved to `src/lib/timeAgo.js` — it
now says "in 2h" / "in 21d", and returns "—" instead of printing the words "Invalid Date".
It left `shared.jsx` because node cannot import `.jsx`, so the function every page uses to
say *when* had no test at all.

**2. A client report was HEADED WITH TOMORROW'S DATE.**
`api/client-report.js` had `new Date().toISOString().slice(0, 10)`. The identical copied
line was fixed in `api/console-report.js` and `api/rep-report.js` on 26 Aug, each with a
comment explaining the trap — and this one, the one that gets forwarded to a client, was
missed. **A bug fixed by hand in two files is not fixed.**
Also `api/ai-chat.js`, which told the assistant "Today is <tomorrow>" and then asked it to
work "Friday" out from that date, and the two preview-mode copies in `src/lib/data.js`.

**3. The same report said it twice, and disagreed with itself.**
After the title was fixed the body still read "counted … on 2026-08-31" — a second UTC date
from `facts.takenAt.slice(0, 10)` in `lib/client-report.js`. Two dates for one moment, in
one document, going to a client. Fixed with a `teamDayOf()` helper. The line that prints
"02:06 UTC" is left alone deliberately: it SAYS UTC, so it is not claiming to be the team's
day. A date with no timezone beside it is.

## Found and NOT fixed — deliberately, tonight

- **There is no way to delete a client.** `deleteClient()` exists in `src/lib/data.js` and
  **nothing in the console calls it**. A client added by mistake is permanent. Tasks can be
  deleted from the task modal; clients cannot.
- **Overview takes about 30 seconds to load**, the Work page about 15. They finish and the
  numbers are right, but Overview is the landing page and this is with one client and four
  tasks on the books.
- The Chrome extension wedges a tab after enough hot reloads — a known environment quirk,
  not the app. Opening a fresh tab clears it.

## Proved

- `tests/people` (41), `tests/time-ago` (33) — both new, both written against the exact
  values seen on screen.
- `tests/sales` repointed to `src/lib/pageForAddress.js` and green again (112).
- Every other suite re-run: ai-cost 324, brain 78, client-timeline 40, company-report 63,
  connectors 165, console-report 46, finance 53, floor-scoping 291, lead-email 95,
  lead-tags 220, ops 18, outreach-stats 177, overview 44, paging 11, pipeline-spec 98,
  rep-brief 57, rep-metrics 45, rep-report 54, sales-sheet 139, share 48, sheet-columns 52,
  stage-move 30, touch-log 59, user-brain 64, vault 106, page-for-address 34,
  connect-problem 28. **Nothing failed.** `npx eslint src lib api tests` clean.
- Re-driven in the browser after the fixes: "With us" now reads **"in 2h"**, the assignee
  picker and the Owner filter both read **"Ryder Schilling (ryder)"** and **"Ryder
  Schilling (ryderschilling)"**, and the report title now reads **2026-08-30**.

## NOT proved — and why

The **body** of the report still printed "on 2026-08-31" after the fix. The change is in
`lib/client-report.js`, and **a running dev server does not see a new function in a `lib/`
file** — Node caches the module for the life of the process, and the vite plugin only
cache-busts `api/`. That is trap #1 in `START-HERE-2026-08-31.md`, hit again. `npm run dev`
has to be restarted before that line can be checked. The api/ half of the same fix WAS
picked up and verified, which is why the title changed and the body did not.

`api/ai-chat.js` was not driven either — same reason, and the assistant needs a key.

## Left in the database

One client, `ZZ TEST — Dry Run Realty`, and four tasks. All obviously named. The tasks can
be deleted from the task modal. **The client cannot be deleted from the console at all** —
see above.
