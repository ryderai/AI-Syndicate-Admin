# Nine changes on the Sales page · the Meeting stage split in two
**Tue 2 Sep 2026, afternoon.** Internal. Ryder, by voice, working through the Sales page.

**All nine are built, second-passed by a separate agent, fixed, and driven in a browser.
None is deployed, and `supabase/migrations/0030_meeting_split.sql` has to be run first.**

---

## What he asked for, and what each one turned out to be

### 1. Canada
> "when people are adding a contact, we need to make sure that they can add them as a
> Canadian as well."

`admin_leads.country` has existed since migration **0025** and `admin_companies.country`
since **0009**. Nothing in the console has ever read or written either one except the
spreadsheet importer — so a Canadian contact got a province typed into a box labelled
"FL". `lib/regions.js` is now the one list: 54 US regions, all 13 provinces and
territories, and the field renames itself — **State** in the US, **Province** in Canada.
Picking a country clears the old region rather than keeping a code from the other
country's list. The sheet has a **Country** column and its old **State** heading is now
**State / Province**, and the record can edit both.

**Nothing is guessed.** A blank country stays blank rather than becoming US: filling in
the country of every row already in the table would put a fact in the database that
nobody established.

### 2. It claims to whoever adds it
> "automatically claim it to them and not on the floor… people wanna be adding a contact
> for someone else."

The old form never set `owner_id` at all, so every hand-added contact landed unclaimed on
the Floor and the toast told the person to go and claim their own contact. It is theirs by
default now, with the same claim clock `claimLead` sets — a claim with no clock behind it
is the sheet's original failure mode. The owner is a **picker** with their own name
already in it, because he also asked to add one for somebody else.

### 3. Save actually saves
> "when they click save, make sure to save on every popup and contact… no button should
> ever be clicked and then it not actually work."

The survey found seven places where typed words were lost silently. Fixed:

- **A note box died on a scroll.** The stage chip's note lives in a popover that closed on
  any scroll, resize or outside click — so a rep typing a note on a table wide enough that
  half its columns are off screen only had to nudge the horizontal scrollbar to lose it.
  The popover now holds open while there are unsaved words in it. Escape still closes,
  because that is a person deciding to.
- **The firm's fields had no save at all** except a button at the bottom of the tab, so
  switching tabs or closing the record threw away the website, the phone, the industry and
  the revenue. They save on the way out of each field now.
- **A person's fields saved invisibly** — no button, no marker, identical before and
  after. They say `Not saved yet` / `Saving…` / nothing, and only go clean on a write that
  landed.
- **The next step** saves on blur, and a locked record shows text instead of a box that
  cannot save.
- **Assigning had two paths**, and the drawer's one skipped the permission check and the
  race guard that stops two reps claiming the same lead and both being told they got it.
  One path now.
- **An update that matched no row was reported as a save.** Postgres answers
  `{ data: null, error: null }` when the row is gone or a policy hides it, and every caller
  read `res.ok` only — so the console wrote a timeline line for a lead that no longer
  exists and said "saved". Found by the checker; this is the same complaint in the one
  direction nobody can see.

### 4. It stops starting over
> "someone goes to a different page as they're working on a client, and then they go to a
> different page, come back — it's gonna reset the whole thing. Even if they go to a
> different tab on their browser."

**Two causes, and the tab one was not on this page at all.** Supabase attaches its own
`visibilitychange` listener and refreshes the token whenever a tab comes back to the
front. Each refresh fired the console's auth callback for the person who was already
signed in, which set membership back to "still checking" — and the gate reads that as "not
known yet" and returns the loading splash **instead of the app**. So the entire console
unmounted and rebuilt: every page re-fetched, every drawer closed, every filter cleared,
every half-typed note gone. On a long-lived tab the token refresh did it with nobody
switching tabs at all. A refreshed token for the same user id is not new information about
who they are, so it no longer takes the screen away; a different person still gets a full
check, and their cached board is thrown away.

Navigating away was the second cause: the dashboard swaps pages on the route, and
`getFloorBoard()` is **eleven table reads**. The board is now kept for the life of the tab,
along with the search box, the three filters, the view and the open record. **`Reload
sales`** is on the toolbar and says the clock time the board was read.

**Module state, not localStorage, and the difference matters.** A filter saved to
localStorage comes back tomorrow morning when nobody remembers setting it, and the page
looks empty for a reason that is invisible — this console has been bitten by a saved
preference hiding a feature twice. Kept for the session, gone on a real page load.

### 5 and 6. An industry list, and a deal stage
There was **no industry list anywhere** in the console. `vertical` was free text in three
places with three different placeholders, which is why `realtor` and `real estate`,
`medspa` and `medical spa`, `lawyer` and `legal` all count as separate trades today.
`lib/business-types.js` is 57 trades in 9 groups, including the three he named, and **the
stored value is spelled the way the rows already in the data spell it** — a prettier slug
would have started a fifth spelling. A value the list does not know is shown as typed, not
blanked and not re-mapped.

The form also asks where the deal is, and collects whatever that stage needs on the same
form, because sending somebody to add a contact and then move it is two jobs.

### 7. Meeting became two stages
> "instead of meeting make it meeting booked and have a date that they have the meeting,
> then meeting complete, then the proposal stage."

One stage called `meeting` meant both "booked for Tuesday" and "happened in June" — its own
help text said so out loud — so no number taken from it meant anything. Migration **0030**
splits it, moves every row to **Meeting booked**, writes a line on each lead's timeline
saying so, and carries the follow-up date across **only where it is in the future**: a past
one is an overdue follow-up, and calling it a meeting would be inventing a fact.

**The meeting got its own column.** It used to share `next_follow_up_at`, which was wrong
the moment a meeting could be COMPLETE — a past date on that column means *overdue*
everywhere, so every finished meeting would have sat on the overdue list for ever.

Twelve files read the old stage: the constants, the board columns, both sort orders, the
rep scoreboard, Stats, the two pipeline tiles, the nightly sweep, the AI assistant's own
list, the sheet importer, the outreach report and the call queue's staleness map.

### 8 and 9. A move is never refused
> "in the editing sidebar you cant click the stage and change it because it requires the
> notes about it, but it should have the popup for that as well, no button should ever be
> clicked and then it not actually work and move the client." / "when I drag a client from
> like one stage to another it doesnt allow the move because it requires the info about the
> move, but make the popup come up when you drag it."

The gate refused and named the missing field. The note in that code argued that booking a
date on the rep's behalf would be inventing a fact — which is true — and then concluded
"so refuse", **which does not follow**. Asking is the third option. It now opens a box that
collects exactly what is missing and then makes the move. Three ways in — the sheet's chip,
the drawer's dropdown, a drag on the board — and all three get the same box. For Proposal
it **creates the proposal record** rather than telling somebody to go and add one.

---

## What the second pass found — eighteen findings, and the ones that mattered

A separate agent was told to assume something was false. Every one of these was real.

1. **The AI assistant bypassed the gate entirely**, and this batch had just widened what it
   could set. "Move Acme to meeting complete" in the chat box produced exactly the un-dated
   stage migration 0030 exists to abolish. **The gate moved into `lib/stage-move.js`** so the
   assistant can import it — it could not import from `src/`, which is why it had a
   hand-copied stage list and no copy of the requirement at all. A rule enforced in one of
   four writers is not a rule.
2. **The importer produced three stages it could never satisfy** — `meeting_booked`,
   `follow_up` and `proposal` all need something a spreadsheet does not contain, and the
   console will not let a *person* set them without it, so an import created a state nobody
   could fix from the screen. `landableStage` now lands the lead at the nearest stage the
   sheet's own words support and moves the fact into the note.
3. **`meeting_complete` accepted a date in the future.** Both this file and the migration
   claimed in prose that it "is in the past" while the code accepted next March.
4. **Sales and The Floor are the same component**, and both wrote the same session key —
   so the Floor's filters and open record seeded the owner's Sales page and back again.
5. **"loaded 2 minutes ago" froze after the first paint.** The one number that made the
   no-reload design safe was the one that lied. It shows the clock time now.
6. **The stage box re-read the board twice** per move, in the change whose point is not
   re-reading eleven tables — and replaced the accurate error with a vaguer one.
7. **A retried save created a second proposal** for the same deal.
8. **Both meeting stages fell out of the call queue's ranking**, because `STALE_AFTER_DAYS`
   was not renamed — an un-listed stage sorts to the bottom for ever, however long it has
   sat. A copy in `lib/notes-engine.js` had the same miss, under a comment promising the
   two could never disagree.
9. **The outreach ladder dropped `reopened` and `meeting`** — counted in the header, drawn
   in no rung, so the breakdown did not add up to its own total. The comment above that list
   says exactly this, and was written the same afternoon.
10. **The owner picker offered every rep**, and migration 0020 refuses a lead owned by
    somebody else unless you are an admin — so a rep picking a colleague got a raw
    row-level-security error.
11. **Add contact offered Lost**, which needs a written reason, so it could create a lead
    with `lost_reason` null — the column the whole Aug 27 reason box exists to fill.
12. **Three dead options in the stage filter**: `meeting`, `skip_90` and `bad_contact` are
    kept readable on purpose, and mapping them into the dropdown made three filters whose
    only possible outcome is an empty list.
13. **`api/sales-score.js` still wrote `skip_90`**, which 0027 made unwritable — a scan that
    scored a firm 90+ then failed to park it. Pre-existing, found because the checker audited
    stage **writers**, which the first pass did not.

### And the numbers were counted over the wrong set
"37 suites, 0 failing" was true of the suites that ran, and the folder holds 39.
`tests/auth-gate` needs playwright, which the Mac bridge does not have. **`tests/inbox` has
never run on any machine since it was written** — every import was `./lib/…`, resolving to
`tests/inbox/lib/…`. The paths are fixed; the named exports it wants (`DB`) do not exist in
`lib/supabase-server.js`, so it was written against an API that changed or was never built.
**It is left failing loudly and named here rather than guessed at** — a test whose intent is
invented passes and means nothing.

---

## And the one that no test could have caught

The build was clean, lint was clean and 3,214 checks passed — and the Sales page was a white
screen. `const seed = readView()` had been inserted **below** a `useState` that read it, so
the page threw `Cannot access 'seed' before initialization` on render. A source-matching test
cannot see a temporal dead zone. Only loading the page found it, which is the rule this repo
already has written down and I had not yet done at that point.

---

## Proof

- **lint clean** across `lib src api tests`
- **3,248 checks across 37 suites, 0 failing** — up from 3,069 across 36. `tests/auth-gate`
  and `tests/inbox` do not run; see above. Neither is counted in that total.
- **17 SQL behaviour checks against a real Postgres 16** — `tests/sales-intake/run.sh`. It
  builds a database shaped the way it was *before* 0030, puts four leads in it, runs the real
  migration **twice** over them, and raises on the first wrong answer: the rows move, the
  future follow-up becomes the meeting date and the past one does not, the timeline line is
  written once, and the old stage ends up refused by the constraint rather than merely
  unoffered by the app.
- **42 browser checks against the built bundle** — `tests/sales-intake/walkthrough.mjs`,
  screenshots in `tests/sales-intake/shots/`. It adds a Canadian contact at Meeting booked
  with a date, opens it, moves it to Proposal through the box, then **drags a card on the
  pipeline** and completes that move through the box too.
- Build clean, in the cloud container.

---

## Hand-over — four steps

1. **Run `supabase/migrations/0028_task_assignees.sql`** — still outstanding from 31 Aug.
2. **Run `supabase/migrations/0029_task_updates.sql`** — from this morning.
3. **Run `supabase/migrations/0030_meeting_split.sql`.** Safe to run twice, proved on a real
   Postgres. It moves every lead out of `meeting` and makes that value unwritable.
4. **Push and deploy.**

**0030 is the one that has to go in before the deploy.** The console will offer Meeting
booked and Meeting complete the moment it ships, and the database refuses both until the
migration has run.

---

# Addendum, same evening — four things Ryder found by using it

## 1. The layout mess was mine, and the cause was a class name

> "now the sidebar is too wide and the filters are off to the side and broken…
> everything has to stay contained. then when in sidebar and a popup appears make sure the
> popup always comes on top and not behind the sidebar."

**The task panel built on 31 Aug was called `.adm-drawer`, and that name was already taken.**
The lead record on the Sales page has used `.adm-drawer`, `.adm-drawer-head`,
`.adm-drawer-body` and `.adm-drawer-foot` since it was written. The task panel's stylesheet
redefined three of those four — the width (660 → 520), the header, the footer — so the
moment it shipped, the LEAD record squashed its name into a two-line column and ran its tab
bar off the right of the window. Every symptom Ryder listed came from that one thing.

Everything the task panel owns is `.adm-tp*` now. **A new component that reuses another
component's class names is not styling; it is editing that component from a distance.**

Then, measured rather than eyeballed, at 1440, 1280 and 1100:

- the record is **620px**, nothing inside it reaches past its own right edge, and the page
  grows no horizontal scrollbar
- the toolbar wraps instead of overflowing its card — `flex-shrink: 0` on a group that had
  just gained two items (Reload sales, and the time the board was read) is what pushed the
  stage and owner filters off screen
- the filters are 13.5px on a 38px target, up from 12.5px on 30px

**And the popup order is now written down as a ladder**, because this session broke it by
raising one layer without checking what it passed: toasts 9600 · popovers 1400 · modals
1300 · side panels 1260 · the page 20. A modal was at 1200 and the task panel went to 1260
this morning, which is why "Log an email" drew behind the record it was opened from.

## 2. The save that errored "for some reason"

> "when i fill in a contact and go to save it it errors for some reason and i cant even see
> why." … "it wasnt adding because i didnt put in am or pm."

`<input type="datetime-local">` has five sub-fields and **reports its value as the empty
string until every one of them is filled**. So a field reading `10/25/2026, 01:00 --` on
screen answered, to the code, as nothing at all — and the form refused with "when are you
picking this back up?" while the date sat plainly in front of him.

The fix is not a better message. It is a control that cannot be half-filled: a date input,
which has no AM/PM to forget, and a list of times where **every option says AM or PM in
words**. 30 times, 6am to 8pm, nothing typed. `lib/when.js` holds the rules;
`whenPicker.jsx` is the two controls; both the Add-contact form and the stage box use it.

**And the reason is now printed on the form**, under the buttons, alongside the toast — a
toast is the wrong home for the one sentence somebody has to act on. It names which half is
missing ("Pick a time"), and it says nothing typed is lost.

## 3. Two bugs that a clean build and a clean lint both allowed

Both were found by driving the form in a browser, and neither could have been found by
reading it.

**The picker threw away the date.** The first version derived both halves from `value` on
every render — and `value` is null until both are answered, which is the entire point of it
— so picking a date and then opening the time list re-read `null`, decided the date was
empty, and emitted a time with no date. The form then said "pick a date" about a date that
had just been chosen. **The same shape as the bug the component was written to kill, one
level down.** The halves live in the component now, and `value` is only adopted when the
caller is the one who changed it.

**`<TextInput>` was left in a file whose import of it had just been removed.** The box
crashed on open with `TextInput is not defined`. `npx eslint .` was clean, because base
eslint's `no-undef` reads plain identifiers and a JSX component reference is a
`JSXIdentifier` — only `eslint-plugin-react`'s `react/jsx-no-undef` looks at those, and
that plugin is not installed here. **The one rule that would have caught it is the one rule
this repo does not run.**

So `tests/jsx-imports` now is that rule: it reads all 59 JSX files, strips the comments
first, and fails if any `<Component>` is used without being imported or declared in that
file. It proves it can fail on the exact line that shipped, and it says in writing that it
can be deleted the day `eslint-plugin-react` is installed.

## Proof for the addendum

- lint clean · **3,302 checks across 38 suites, 0 failing** · build clean
- **49 browser checks** — `tests/sales-intake/walkthrough.mjs`. It fills the form with the
  time left unset and asserts the form STAYS OPEN and says *"Pick a time"*, then picks a
  time from the list and completes the save; and it measures the record and the toolbar for
  containment at three window widths.

---

# Second addendum — the proposal move failed, and what it turned up

## What Ryder saw

Moving the test contact to Proposal: **"Could not find the 'client_id' column of
'admin_proposals' in the schema cache."** The message was on the form, which is the one
good part of this — it shipped an hour earlier for exactly this reason.

## It is the mistake this repo already has a note about, made in the code the note is on

`admin_proposals` has `lead_id` and `company_id`. It has **no `client_id`**, and Postgres
rejects the WHOLE row over one unknown name. The same insert also omitted `title`, which is
`not null` with no default — so it would have failed a second time the moment the first was
fixed. The Add-contact form had the same missing `title`.

`src/lib/data.js` carries a note reading *"the first draft required `meeting_at` and
`proposal_amount`, and NEITHER IS A COLUMN — I invented both while writing the rule. That is
the exact failure this repo has a note about."* I wrote that note this morning and made the
same mistake this afternoon, four hours apart.

**A note is not a guard.** So: `tests/db-columns`.

## The guard

It reads the migrations for what each table really holds — `create table` plus every
`add column` — then reads every literal object handed to a writer (`upsertProposal`,
`upsertLead`, `upsertTask`, `upsertCompany`, `upsertClient`, …) across `src/`, `lib/` and
`api/`, and fails on:

- a key that is not a column on that table
- an INSERT missing a column that is `not null` with no default
- **a literal value a CHECK constraint does not allow**

It says what it cannot see — an object built in a variable and passed by name, or a spread —
and prints the count it checked, so a silent drop is visible.

### Two false alarms it produced first, both worth keeping written down

**A template literal is not an object.** `` `Follow up on the email: ${x}` `` contains
` email:`, which is exactly the shape of a key — so the first run reported that
`admin_reminders` has no column called `email`. Strings are stripped before keys are read
now. Same trap as a guard firing on its own comment, in a new outfit.

**`x === "" ? null : y` is not a key either.** A ternary puts ` null :` in front of the
reader. JS literals are excluded.

And a third, in its own parser: `check (link_type is null or link_type in (…))` is the shape
three of these constraints actually use, and the first regex demanded the column immediately
after `check (` — so it **silently matched nothing** for every nullable one, including the
constraint the guard was written to check. A parser that quietly matches nothing reads
exactly like a passing test.

## And it found a real one, months old

The Inbox writes `link_type: "email"` on a follow-up. `admin_reminders` stopped allowing
that value in **migration 0006**, which replaced the constraint to add `'note'` and rebuilt
the list by hand from the 0002 original — dropping the `'email'` that 0003 had added.

**The comment directly above that statement says it is "widening the constraint rather than
dropping the link: knowing WHAT a follow-up came from is the reason the column is there."
The statement underneath it narrows the constraint.** So "remind me about this email" has
been refused by Postgres ever since, with a red toast and no saved reminder.

`supabase/migrations/0031_reminder_link_email.sql` restores it, and carries the rule in
writing: **a replacement is not a widening** — `drop constraint` plus a hand-typed list
silently discards every value somebody else added, and nothing fails until a person presses
the one button that used it.

## Proof

- lint clean · **3,316 checks across 39 suites, 0 failing** · build clean
- **`tests/db-columns/run.sh`** — on a real Postgres 16: it builds the reminders table in
  the state 0006 left it, **proves the bug** (an email follow-up is refused), runs 0031,
  proves it saves, proves every other value any migration ever allowed still saves, proves
  nonsense is still refused, and runs 0031 again.
- 49 browser checks still pass. They could not have caught the column bug — preview mode has
  no schema — which is exactly the division of labour: the browser proves the flow, the
  migration guard proves the columns.

## Hand-over

Migrations to run, in order: **0028, 0029, 0030, 0031.** 0030 must go in before the deploy;
0031 fixes a button that has been quietly broken for months and can go in any time.
