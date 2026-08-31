# The pipeline rebuilt to the spec — Sun 30 Aug 2026, late

**Internal · admin console · Sales.** Append-only record. Repo copy: `CONTEXT-FOR-AI.md` §54.
Follows the tag audit and the pipeline spec (two artifacts Ryder has), and the two builds earlier
the same evening.

## What Ryder asked for

> "build that into the sales on all sales on both admin owner and the actual rep page."

"That" is the six-stage / three-field pipeline from the spec. Owner and rep are one component, so
almost all of it lands on both at once.

## Built, and verified live in a browser

1. **A reply stops the cadence.** `cadenceState` returns `{active:false, stop:"replied"}` — checked
   BEFORE the touch count, so a reply beats the schedule rather than being ranked against it. A
   bounce stops it the same way. `CADENCE_STOPS` holds the words.
2. **A reply is the top card in My Day**, ranked above an expired claim, and it disappears once
   `answeredAfterReply()` is true.
3. **`canEmail()`** refuses a bounced address; the Contacted? picker greys the Email option and
   says why, alongside the one-text rule.
4. **"And next?"** — a third step on the touch picker: four presets, a date picker, an optional
   note. Writes `next_follow_up_at`, a column that has existed since 0002 and that no sales rule
   had ever read.
5. **The three lists** — `no_next`, `quiet` (rep-scoped) and `stuck` (owners only) — as chips above
   the numbers card, on every view. Pure filters over live columns: no new table, no cron, no
   stored flag.
6. **Twelve stages became seven pickable.** The four early ones are derived and cannot be set
   anywhere. `skip_90` + `bad_contact` read as one outcome with two reasons until 0027 merges them.
7. **The stage gate** — Follow up and Meeting need a future date, Proposal needs a proposal with an
   amount. It refuses and names the control that fixes it; it never books a date on the rep's behalf.
8. **The board** lost four columns and gained two read-only ones, `Working` and `Not a fit`, so
   nothing is drawn nowhere.
9. **Migration 0027** — written, idempotent, **NOT RUN**. Merges the two into `not_a_fit` and
   retires 20 tags for the 4 human ones.

## TWENTY DEFECTS A CHECKER FOUND IN MY OWN WORK

A separate agent, told to assume the build was broken. Nineteen were real. The four that mattered:

**The headline feature could never fire.** `logTouch` captured `now` before the write; the
database trigger then stamped `last_activity_at` from the row's own (later) `created_at`. So
`answeredAfterReply` was true the instant a reply was logged, and the top card in a rep's day —
the thing the whole rebuild is built around — was unreachable from the control built to feed it.
Fixed by stamping from the activity row's own timestamp, so the two are equal and a strict `>`
reads it as unanswered.

**Migration 0027 would have broken the app the moment it ran.** `not_a_fit` was in no app list, so
every merged lead would have come back as an OPEN stage — back on the cadence, back in My Day,
back in every count — with no label. The migration's own header said "nothing breaks when it runs".
Fixed by teaching the app the stage before the database can hold it: known, not offered.

**Three more doors into the stage.** I restricted the sheet's chip picker. The drawer's `<select>`
still offered all twelve and wrote through its own `upsertLead`, skipping the gate entirely; two
buttons in the drawer set Meeting and Follow up — the exact two stages that need a date — with no
date; and the assistant's `update_lead` kept its own hardcoded stage list. **Restricting one
control is not restricting the act.**

**A 90+ firm that replied vanished from My Day.** The score gate ran before the reply check, so a
person who wrote to us produced no card at all.

The rest: the chip counts came from a different set than the list behind them; My Day was the one
view the watch filter did not reach; the stage gate accepted a date in the past while the "No next
step" list correctly treated one as no plan; `api/sales-score.js` still parked leads on the stage
list `salesQueue` had abandoned the same day, so a website scan could Skip a live conversation;
`canEmail` had exactly one caller, its own test; the date presets used the browser's timezone while
every rule counts in Chicago; `WORKING_COLUMN`'s comment claimed to fix three invisible stages and
fixed one; and six stale comments.

**One finding was wrong** and I checked rather than accepted it: the checker said a rep's own
never-contacted expired claim appears on no list they can see. It appears on `no_next`. Verified by
running it.

## Lessons worth carrying

1. **Restricting one control is not restricting the act.** Count the writers, not the screens.
   Three doors were open within an hour of locking the fourth.
2. **A timestamp captured before a write is not the timestamp of that write.** One variable, and
   the flagship feature was dead on arrival with every test passing.
3. **Teach the app a value before the database can hold it.** Knowing a stage is not writing one,
   and the gap between the two is where a migration bites.
4. **A loose regex is a guard that cannot fire.** `/onPatch\(\{ stage:/` passed while the code
   said `onPatch(\n  { stage:` — the exact bypass it was written to catch.
5. **A test that pins an argument list fails every time an argument is added correctly**, which
   teaches people to delete the test. Pin the thing that matters.

## Proof

Lint clean across `lib src api tests`. **2,394 checks in 24 suites, all passing** —
`tests/pipeline-spec` is new at 96. `auth-gate` and `inbox` still do not run on the Mac bridge;
both predate today.

Driven live on the real 3,663-row pipeline as owner: the three chips render with counts; pressing
"No next step" filtered to exactly the three leads with nothing booked; the stage gate refused
Follow up and said what was missing; a touch logged → "and next?" → "In 3 days" → toast "Booked —
Back on this Wednesday, Sep 2" → the chip went 3 → 2 and the lead left the list live; the board
drew Working + Follow up + Meeting + Proposal + Won with 3,655 in Working when unfiltered; and the
chips stayed visible on the Pipeline view, which is the bug I found by clicking rather than by a
test.

**The rep Floor was NOT driven** — same blocker as earlier tonight: the dev server runs on live
keys and there is no sales-role account. It is the same component with the same code paths, and
`stuck` is hidden from reps by `isAdmin`, which `tests/pipeline-spec` asserts.

## Not committed, not deployed

Same as everything else from 30 Aug. **0026 and 0027 both still need running in Supabase.**
