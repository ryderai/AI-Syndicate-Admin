# Two clicks on the Contacted? cell logs the touch — Sun 30 Aug 2026, evening

**Internal · admin console · Sales.** Append-only record. Repo copy of the reasoning is
`CONTEXT-FOR-AI.md` §53. Follows the Floor scoping work earlier the same evening.

## What Ryder asked for

> "now i want to work on the functionality of these rows for effeciency as a rep and when goign
> through sales. starting with when you click contacted i want a popup with the available options
> that you went through and the questions required very simply so its a couple clicks and all the
> data is there. similar to sales cycle status"

## The three calls he made before the build

1. **Two levels, not one.** Click 1 is the channel, click 2 is the outcome, and the second list
   changes with the first.
2. **An outbound touch claims an unclaimed lead. The Sales Cycle Status is left alone.**
3. **"They replied" is one of the options,** and it stamps the reply date.

## What was built

- **`lib/touch-log.js`** — pure. The menu, and what a `(channel, outcome)` pick MEANS.
- **`logTouch()` in `src/lib/data.js`** — one function, because the ORDER of the five writes is the
  design: the text counter, the claim, the timeline row, the first-* stamps, the console feed.
- **`src/components/admin/touchPicker.jsx`** — the two-level popover, plus an optional note.
- The Contacted? cell in `salesSheet.jsx` opens it. **The cell's VALUE is still derived** — nothing
  writes a "contacted" field, because there is none, and that was the whole point of the column.

## THE THING THIS FIXED THAT NOBODY ASKED ABOUT

**Nothing in this console has ever written `first_reply_at` or `bounced_at`.** Both columns have
existed since migration 0021. The Stats page computes reply rate and time-to-reply from them. So
every reply figure the console has ever shown could only read zero or null. This control is the
first thing that fills them.

## THE TRAP THAT WOULD HAVE CORRUPTED THE TIMERS

`admin_lead_activity_touch()` (migration 0009) fires on every activity row of type
`call`/`email`/`text`/`linkedin` and sets `last_touch_at`, `first_contact_at` and
`claim_contacted_at`. **It has no direction column** — the migration says so itself and calls it an
honest limit.

So logging "they replied" as type `email` would tell the database WE reached out. The cold timer
would reset, the cadence would advance, and `first_contact_at` could be stamped by a message the
prospect sent us. A rep marking twenty replies would quietly reset twenty cold timers.

**Every inbound outcome is therefore written as type `note`** — the one type that trigger ignores —
and the meaning is carried by the stamps and the timeline wording instead. No migration needed, and
no count in this console reads activity direction.

## A bug I wrote and caught before it shipped

The first wiring gave the note step `onNote(channel, outcome, note)` and pointed it back at
`onTouch`. That is the shape `ChipPicker` uses, where it is harmless — setting a stage twice is
setting it once. **Two touches are two touches:** two timeline rows, two entries in the rep's
count, and a cadence advanced twice for one phone call. `onNote` now takes the TEXT ONLY, so the
call site cannot re-log, and `tests/touch-log` asserts that signature.

## A test that had to change, and why the new one is better

`tests/sales` asserted `toast.error("Somebody got there first")` appeared **exactly twice** — a
count of the code. A third claim path (this one) broke it while being correct. It now counts the
toasts against the `if (res.taken)` branches: every path that can lose a race must say so, and the
number is read from the code rather than typed into the test.

## Proof — driven live in a browser, not described

On the local dev server against the real 3,663-row pipeline, as owner:

1. Contacted? cell → the four channels render, **Texted greyed out** carrying the real one-text
   reason from `textGate`.
2. Called → the six call outcomes, with a `‹ Called` back link.
3. Left a voicemail → toast **"Logged · On their timeline · claimed for you."**
4. The row moved from the `On the floor` group into `Ryder Schilling`; Contacted? went **No → Yes**;
   Claim went **On the floor → Being worked**; First contact and Last touch both stamped 8/30/26;
   the header went to `Claimed by somebody 1 of 3` and `0 have no first-contact date`.
5. **Sales Cycle Status stayed `New`** — the rule Ryder asked for, holding.
6. The drawer's cadence read **"1 of 5 logged"** with touch #1 ticked — the database trigger firing.
7. The Timeline showed two rows, both JUST NOW: `Call · Left a voicemail — "Called · left a
   voicemail."` and `Claimed — "Claimed by Ryder Schilling."`

**Written to one real row, deliberately:** `Christina Schmotolocha` at `Lin Realty Group at EXP
Realty` — one of three junk `Schmo` test rows already in the sheet. It is now claimed by Ryder with
a voicemail on its timeline. **Not released afterwards on purpose:** handing it back writes a
SECOND timeline line, so undoing the test would leave more noise on the record than leaving it.

## Proof, the rest

Lint clean across `lib src api tests`. **2,294 checks in 23 suites, all passing** — `tests/touch-log`
is new at 58. `auth-gate` and `inbox` still do not run on the Mac bridge; both predate this work.

Files: `lib/touch-log.js` (new) · `src/components/admin/touchPicker.jsx` (new) ·
`tests/touch-log/test.mjs` (new) · `src/lib/data.js` · `src/components/admin/salesSheet.jsx` ·
`src/components/admin/SalesPage.jsx` · `src/admin.css` · `tests/sales/test.mjs`.

## Nothing is committed and nothing is deployed

Same as everything else from 30 Aug.

## Open

- **No migration was needed and none was written.** `admin_lead_activity.outcome` is free text
  (0001, no check constraint), so the new outcome values need nothing. A FIFTH channel would need
  one — `type` IS constrained (0018).
- A reply does not pause the cadence. `last_touch_at` still means "when did WE last touch them",
  which is correct, but a lead that has written back still shows as owed a touch on the old clock.
  Worth a decision, not a bug.
