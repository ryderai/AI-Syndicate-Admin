# START HERE — AI Syndicate admin console, handed over Wed 2 Sep 2026, evening

**This ADDS to `START-HERE-2026-09-02.md`.** That file is still right about everything it
says. This one covers the afternoon and evening: the nine Sales changes, the stage split,
and the send-email button. Nothing in the earlier file has been deleted.

---

## Where things stand

| | |
|---|---|
| Migrations | 0001 – 0027 run. **0028, 0029, 0030, 0031 NOT run.** 0030 must run BEFORE the deploy. |
| Deployed | everything up to the 31 Aug morning push |
| NOT deployed | 31 Aug afternoon and all of 2 Sep |
| Tests | **3,332 checks across 40 JS suites, 0 failing** |
| | plus 3 browser walkthroughs: sales-intake 49, email-send 43, task-updates 30 |
| | plus SQL on a real Postgres 16: 0029, 0030 and 0031 behaviour files |
| Known failing on purpose | `tests/inbox/test.mjs` — it imports `DB` from `lib/supabase-server.js`, which has never exported it. It is left failing loudly rather than guessed at; see the note at the top of that file. |
| Lint | clean across `lib src api tests` |
| Build | clean — **must run in the cloud container, not the Mac bridge** (rollup's native module is missing there) |

---

## Do these five things, in this order

1. **Run `supabase/migrations/0028_task_assignees.sql`** in the Supabase SQL editor.
2. **Run `0029_task_updates.sql`.**
3. **Run `0030_meeting_split.sql`. This one must go BEFORE the deploy** — the app stops
   offering `meeting` and starts writing `meeting_booked` / `meeting_complete`, and the
   database refuses those until this has run.
4. **Run `0031_reminder_link_email.sql`.** Small: it puts `'email'` back in the follow-up
   link list, which migration 0006 dropped by retyping the list instead of adding to it.
   Every "remind me about this email" press in the Inbox has been refused since.
5. **Push and deploy.**

All four are safe to run twice, and all four were run twice against a real Postgres 16 to
prove it rather than assumed.

---

## What is new on screen since this morning

### The record panel can now write AND SEND the email

Ryder, 2 Sep: *"add the send email button so you can easily get a draft, click what email to
send from and then send it. emails need to be able to be sent from the crm from the email
that is connected."*

- **Draft an email** sits in the record's What-to-do-next box whenever the next step is an
  email, and on an expired claim, where the next act is a first email.
- The panel that opens shows the email to read and edit, **names the mailbox it will go
  from** (a picker when more than one is connected, marked when one is the team's shared
  one), and puts **the recipient's address on the send button itself** — `Send to dana@…`.
- Send goes through `/api/gmail-send`, from the connected Gmail account.
- **Send first, log second.** If the send fails, nothing is written and the words are still
  on screen. If the send worked and the log did not, the panel says to treat it as sent,
  the send button is REMOVED, and it names the one button that puts it on the timeline.
- Once it has gone, the panel asks one question: when do you pick this back up — with the
  cadence's own day already chosen.
- **This reverses a rule that was written down.** The old panel said "Nothing is sent from
  here", and that was right for a console with no mailbox. A mailbox is connected now and
  Gmail hands back its own message id, so the console can honestly say an email left. The
  two assertions that pinned the old rule were repinned, not deleted; the reasoning is
  written above them in `tests/lead-email/test.mjs` § 6.

### Won and Lost save at 10 characters, not 15

"it was crazy" is 12 characters and would not save. The bar is 10 now, the countdown is on
the button itself, and the blocker is spelled out in the footer instead of only greying the
button out.

---

## Traps that cost time on the afternoon of 2 Sep

1. **`copyToClipboard` returns `{ ok, why }`, not a boolean.** `if (result)` is true for a
   refusal, so the panel said "Copied" when nothing had been copied and logged an email
   still sitting on screen. Two other callers in the repo had it right.
2. **A PostgREST query builder has no `.catch`.** `admin.from(x).insert(y).catch(() => {})`
   throws `TypeError` the moment it runs — and it only ever ran when something had already
   gone wrong, so a bookkeeping failure turned a sent email into a 502 and invited a second
   send. `await` inside a real try/catch.
3. **A permission check applied one block too late is not applied.** `leadWeMayWrite` guarded
   `first_email_at` and not the thread row beside it, so a rep could link a Gmail thread to
   another rep's lead — and the reply sweep then stamps `first_reply_at` on it, one-shot,
   with no screen that can undo it. Count the doors: there were four.
4. **A rule enforced in one screen is not enforced.** The drawer learned not to offer the
   pre-written outreach email to somebody who replied; the sheet's own button did not, and
   neither did the endpoint. All three now do.
5. **`load()` re-reads the touch you just wrote.** Adding one to the count on top of that
   prefilled a follow-up a whole cadence step late — day 9 where the rules said day 3 —
   under a line claiming it was "the cadence's own day".
6. **A retry is not free.** `logTouch` claims before it writes, so retrying with the same
   stale lead says "somebody got there first" about your own lead, and if the first write
   landed and only its answer was lost it double-counts the email. The retry was removed.
7. **A timeout is not a refusal.** `apiFetch` returns the same shape for both. Told "nothing
   was sent", a rep presses again — and a slow function has already delivered the first one.
8. **Two source-matching assertions could not fail.** A checker inverted the flag inside
   `api/gmail-send.js` so the Sales page double-logged every email and the Inbox logged
   none, and the whole suite stayed green: a regex cannot tell `x ?` from `!x ?`. The
   decision now lives in an exported pure function, `sendWritePlan`, which the test CALLS.
9. **A browser assertion that reads `innerText` can match a static label.** The
   cadence-prefill check matched the preset button "In 3 days" and passed with the prefill
   switched off. It reads the date box's value now and compares it against
   `nextCadenceDate` run inside the test — proved by breaking the source and watching it go
   red.
10. **An empty `/tmp/pg-*` directory passes `[ -d ]`.** A failed `initdb` leaves one, the
    next run skips initdb, and every SQL check dies on a missing socket — which reads like a
    broken database rather than a broken script. The three runners test for `PG_VERSION`
    now, and `tests/task-updates/run.sh` learned the run-as-postgres bootstrap the newer
    runners already had.

---

## Still true, and still only a person can do it

1. **A GoDaddy customer number and password are sitting in plain text on a Notion page** —
   "Get access to Website and Google Tools", Jessica Mackrael. Move to Bitwarden, then
   delete them off Notion.
2. **Justin Dyar has no start date**, so nobody can say which week he is on.
3. **`tests/inbox/test.mjs`** needs somebody who knows what the Inbox contract is meant to
   be. It has never run.
