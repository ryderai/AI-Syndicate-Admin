# Reps out of Operations, the Scan chip, and the scan wired to our own platform

Sun 30 Aug 2026, late evening · internal · admin console

Three asks from Ryder, in his words:
1. *"sales reps dont work with operations or anything."*
2. *"build the feature that allows people to scan the website and company online profile from
   the lead sheet and get the audit so they can better pitch."*
3. *"make the scan site for ones that you can more easy to see its available to scan."*

## 1. A sales rep can no longer be given delivery work

Not a preference — the same class of bug as the two-people-one-name one found earlier the
same evening. **A rep's console is four pages and Operations is not one of them.** A task
handed to a rep is a task nobody can open: not on their Work page, not on any page they
have, sitting on the board with their name on it looking perfectly assigned.

One rule, in `src/lib/people.js`: `canDoDeliveryWork()` — active, and owner or admin.
Applied to the assignee picker in the task modal and on the sheet. **Deactivated members are
out too**; Operations had been offering them while the Inbox already filtered them out.

Two things that make it safe rather than just narrower:

- **It never hides an existing assignment.** Filtering the list and dropping a task that is
  ALREADY on a rep would render the cell "Unassigned" while the database says otherwise —
  losing the work a second way while fixing the first. Whoever holds the row stays in the
  list, marked: *"Ryder Schilling (ryderschilling) · sales — cannot see this page"*. Driven
  in a browser; screenshot behaviour confirmed.
- **The Owner FILTER at the top keeps the whole roster, deliberately.** Filtering to a rep is
  how you FIND a task wrongly put on one before this rule existed. Narrowing it would hide
  exactly the rows somebody has to go and fix.

Tickets needed nothing: `TicketModal` never accepted the `team` prop it is passed, so there
is no assignee control there at all. (The dead `team={team}` prop and the `listTeam()` read
behind it are a wasted round trip on that page — noted, not touched.)

## 2. The Scan chip

Both states used to render `adm-db-empty`, the faint grey this sheet uses for "there is
nothing here". So **"Scan site" — a thing a rep can do right now — was drawn in the same
colour as "no site", which is a thing nobody can do anything about.** On 3,663 rows that is
the difference between a feature being used and never being noticed.

Now a tinted chip with an arrow when there is a website, faint grey when there is not. A
chip and not a full button on purpose: the DO column already carries the loud buttons.

## 3. THE SCAN — it was never waiting on Andrew

The modal said *"the address of our own scanner is not set on the server, and nobody has
written down what it sends back"*. Ryder has platform access, so instead of asking him to go
hunting, the platform repo was opened (`~/aisyndicate/ai-syndicate-live`, folder access
granted) and the answer was **read**, not guessed:

```
POST /v1/audit                        api/v1/audit.js
auth   X-Api-Key: <key with `write`>  (Authorization: Bearer also works)
body   { domain, pages, maxPages }
answer { domain, measured, score, gated, categories, measuredAt,
         measuredNow, stored, pages:{scored,requested}, notes }
```

`score` is the AI Access composite 0-100 — which `readAiAccess()` already accepts under the
name `score`. `categories` is worst-first and the platform's own comment calls it *"doubles
as a fix list"* — that is the pitch material.

**Then production was probed, live: `POST https://www.aisyndicate.com/api/v1/audit` answers
`401 Missing API key` — NOT `503 the public API isn't enabled`. So `ENABLE_PUBLIC_API` is
already true in production.** Nothing about this is blocked on Andrew. The one missing piece
is an API key with the write scope, and Ryder can make that himself in the platform's own
API console (`#/dashboard/api`, tick "Can verify (write)").

### What was changed on our side

- `PLATFORM_SCORE_URL` set in `.env.local`, **on the www host on purpose.**
  `aisyndicate.com` redirects to `www.aisyndicate.com`, and a redirect can turn a POST into
  a GET and drop the body. Measured: www answers directly; the bare host does not answer
  without following a redirect. The dashboard sign-in link elsewhere uses the BARE domain
  deliberately, because www has no session. Those two rules are opposites and both are right.
- **`pages: false` is now sent.** With pages on, /v1/audit crawls up to 20 pages; this fetch
  gives up at 55 seconds and a rep working 3,663 rows is not waiting a minute a row. The
  site-level pass is what the pitch is made of anyway — robots.txt blocking the AI crawlers,
  no llms.txt, no schema, no sitemap — and it returns in seconds.
- **`categories` is read as findings**, last in the list so a scanner sending real findings
  still wins. A category is a scored AREA, not a defect, so it becomes a finding that says
  exactly that: *"Schema · scored 12 out of 100"*. No threshold is invented to call one a
  problem and no remedy text is put in a rep's mouth.
- **`scoreReady()` now needs BOTH the URL and the key**, and so does `/api/health`.
  Filling in the URL alone would have flipped the health badge to "on", drawn a live
  "Scan now", and 401'd on every press — the exact state the modal's own comment calls worse
  than an off button. The 503 now names whichever half is missing.

### Two limits worth knowing before reps are turned loose on this

- **`AUDIT_RUNS_PER_HOUR = 6`** (`lib/audit-run.js` in the platform), per workspace — so six
  scans an hour for the whole team, sharing one key. That is a hard wall against a list of
  3,663 firms. It is a one-line constant on the platform side.
- **/v1/audit returns no SEO score and no buyer-question count.** Both will correctly show a
  dash rather than a zero — that discipline is already in `readReport`. Only the AI Access
  number and the category breakdown come back.
- Scans of a domain we do not own are **not** written into our own platform history
  (`stored: false`), which is what we want — our own audit trail stays ours.

### The half NOT built: "company online profile"

/v1/audit reads the WEBSITE. It says nothing about a firm's Google/AI presence. The platform
does have endpoints that look like the right shape — `brand-serp`, `brand-monitor`,
`brand-snapshot`, `brand-sentiment`, `reputation` — but none of them were read, wired or
tested tonight, so nothing is claimed about them. That is the next piece.

## Proved

- `tests/platform-scan` — 29 new checks, written against the REAL response shape read out of
  the platform repo, including that SEO and buyer questions come back null and never zero.
- `tests/people` widened to 63; `tests/company-report` widened to 64 (the both-halves rule).
- Everything re-run: people 63, time-ago 33, page-for-address 34, connect-problem 28,
  platform-scan 29, company-report 64, sales 112, sales-sheet 139, floor-scoping 291, ops 18,
  stage-move 30, sheet-columns 52, brain, overview, rep-report, console-report, vault,
  touch-log — all green. `npx eslint src lib api tests` clean.
- Driven in a browser: the assignee picker now lists only Ryder (owner), Andrew and CJ; the
  task already on the rep still shows them with *"· sales — cannot see this page"*; the
  Scan chip renders as a purple chip with an arrow beside NO SCORE.

## NOT proved

**No scan has been run.** There is no key yet, so the button is still correctly off. The
moment a write-scope key goes into `PLATFORM_SCORE_KEY` and `npm run dev` restarts, the
first press is the real test — and it is the first thing to check tomorrow, not something to
assume.
