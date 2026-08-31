# Draft the next email from the row — Mon 31 Aug 2026

**Internal · admin console · Sales.** Append-only. Repo copy: `CONTEXT-FOR-AI.md` §55.

## What Ryder asked for

> "add a row for email that drafts up an email based on stage, notes, timeline and everything else
> thats known about the client."
>
> "i ran both migrations."

## 0026 and 0027 are RUN

Confirmed on the live board: the stage picker now offers **six** — Follow up · Meeting · Proposal ·
Won · Lost · **Not a fit**. `skip_90` and `bad_contact` are merged and no longer offered.

Code caught up in three places: `PICKABLE_STAGES` is the six; the two-reason workaround labels in
`salesSheet.jsx` are gone; `lib/assistant-tools.js`'s hand-kept copy matches. The two old values
stay in `LEAD_STAGES` and `CLOSED_STAGES` deliberately — 0027 rewrote every row, but a value that
sat in the database for a week can still turn up in an old timeline line or a backup, and reading
one must not produce a blank label. **Known, not offered.**

## The email drafter

A **Draft email** column on every row, on by default. It asks the server to write the next email to
that person from their stage, notes, timeline, tags, proposals and the newest scan of their site,
and opens it in a panel to read, edit and copy.

- `lib/lead-email.js` — pure: the job per stage, the fact sheet, the instruction, the gate, the
  fallback.
- `api/lead-email.js` — reads the facts server-side, shows the model that and nothing else, checks
  the draft back against the same string.
- `src/components/admin/emailDraft.jsx` — the panel, with a disclosure showing exactly what it was
  written from.

**IT DRAFTS. IT NEVER SENDS.** There is no send path in the endpoint and no send button in the
panel, and both say so where somebody would look to add one. This console has had that rule written
down since Aug 24 about the Gmail button; this is the same rule about a new door. A model wrote the
text and a person has to read it before it goes to a prospect with our name on it.

**A bounced address is refused** before any work is done — `canEmail`, the same rule the Contacted?
picker uses. The cell shows "bounced" with the date rather than a button.

### The gate, which matters more here than on a report

A report that overstates is read by us. An email that overstates is read by the prospect. The two
things a model reaches for first are the two we cannot back: a number about their website nobody
scanned, and a promise. So a draft is thrown away — never edited — if it states a number or date
not in the facts, promises anything, or opens with a line that gets emails deleted.

The score check is a phrase list, not a number check, because the dangerous version has no digits
in it: *"your site is falling behind"*. When nobody has scanned, the fact sheet says **"There is NO
score"** in as many words and the gate refuses every way of implying one.

Quoting is not claiming — a note on the record can be quoted back, through the shared
`withoutQuotes` the other three report gates use.

## Two defects found by using it

**The column was invisible to everybody who had ever touched the column menu.** A saved preference
from yesterday beats today's defaults, so the one control this whole rebuild points at did not
appear. Found by counting the columns on the page — it read 14, not 15. `withNewColumns` now adds
any default column that did not exist when the preference was saved, in its proper place, and the
preference records `seen` so the next column added does not need a hard-coded list. A column
somebody actually switched off stays off: this restores columns nobody has had the chance to decide
about, and never overrules a decision. **This repo already had a note about the shape — a saved
preference deleted the Claim button the same way in August.**

**`admin_lead_tag_events` orders by `at`, not `created_at`.** 0018 named it `at` on purpose. Getting
it wrong is a 500 from PostgREST, not an empty list.

## THE 500 THAT WAS NOT A BUG

The route returned 500 on every request, including with an invalid id that should have been
refused before any work. Node imported the file fine. A probe route that imported each dependency
and printed its export list named it in one request:

**`sales-rules canEmail: undefined`.**

`canEmail` was added to `lib/sales-rules.js` the same evening. The dev server had already loaded
that module, and **Node's ESM loader caches a module by URL for the life of the process** — so the
named import threw "does not provide an export named" every time. The vite dev plugin cache-busts
the `api/` file on its mtime **and nothing else**, so editing the route does not reload its
dependencies.

Nothing is wrong with the code. **`npm run dev` has to be restarted** before the drafter can be
seen locally. On Vercel every deploy is a fresh process, so it does not arise there.

The route now catches its own failures and returns the reason. The first version of that catch
started *below* the auth and body reads, so the real crash happened above it and still fell through
to the plugin's "the reason is in the terminal". **A catch that does not cover the whole route is a
catch that reports the failures you already understand.**

## Lessons

1. **Adding an export to a lib/ file is invisible to a running dev server.** Restart it. The probe
   trick — a route that imports each dependency and prints its exports — found it in one request.
2. **A saved preference can hide a new feature completely.** Second time this console has been bitten
   by it.
3. **A test pinned to a literal fails every time the literal is extended correctly**, which teaches
   people to delete the test. `savePrefs({ columns, groupBy })` was pinned exactly; it grew a third
   field for a good reason.

## Proof

Lint clean across `lib src api tests`. **2,475 checks in 25 suites, all passing** —
`tests/lead-email` is new at 81. Verified live: 0027's six stages in the picker; the Draft email
column present with a button on every row (Columns · 15). **The drafter itself could not be driven**
— the dev server is holding the stale module, and only a restart fixes that.

There is **no ANTHROPIC_API_KEY on this machine** (confirmed: `/api/rep-report` answers with its
counted version and says so), so locally the drafter will return the skeleton until a key is set.
The panel says which one it is rather than letting the two look alike.

## Not committed, not deployed

Same as everything else. 0025, 0026 and 0027 are all run.

---

# Follow-up, same day: sending a draft logs it

**Ryder:** *"i want to make sure that when i send a draft that was made for me that it marks them as
contacted by email with the date and notes, then the rep just clicks the follow up date."*

## What the console can honestly know

Nothing here sends, so nothing here can observe a send. The nearest honest moment is the one where
the rep takes the words away to send them — **the copy**. So the primary button says exactly that:

**Copy & mark it sent** — copies, logs an email touch dated now with the full edited email as the
note, and switches the panel to the follow-up date row. One more click and the rep is done.

**Copy only** sits beside it for grabbing the text without claiming anything happened. Neither label
is a guess dressed up as a fact, which matters on a screen this console is built on trusting.

**Copy first, then log.** A refused clipboard means the rep has not got the email, so nothing claims
they sent it — proven in the browser, where a scripted click could not reach the clipboard and
nothing was written.

It logs **through `logTouch`**, the same path the Contacted? cell uses, so the claim, the trigger's
date stamps, the cadence step and the timeline line behave identically whichever control was
pressed. `logTouch` gained an optional `note` that goes **on the touch row**, not a second one — one
act, one timeline entry.

Booking the date is **its own callback**, not `onSent` with a flag: one callback that does two things
depending on an argument is how the second press logs a second email.

## Four defects found by using it

1. **`apiFetch` returns `{ ok, data }`.** Spreading the response gave the panel no subject, no body
   and no job — it opened blank.
2. **`apiFetch` stringifies `body` itself.** Passing `JSON.stringify()` sent a JSON string of a JSON
   string. It survived locally because the dev plugin parses once and `readJson` parses again —
   **worse than failing**, since Vercel parses once.
3. **`.adm-cp-foot` is defined twice** in `admin.css` — one a flex row with `space-between`, one a
   plain caption. In a modal the flex one wins, so "Skip it and they land on your No next step list"
   rendered as three chunks pushed to the edges. Its own class now.
4. **The sheet header never read `SORTABLE`.** Every column got a sort button, and it went unnoticed
   because every column was sortable until this one. Clicking Draft email's header sorted the table
   by a value that does not exist. A column that declares itself unsortable now renders a plain
   label — not a dead button, which is the shape that teaches people the header is broken.

Also: the counted warning ran two sentences together ("nothing could be written What is below"),
because the reason string does not end in a full stop.

## Proof — driven end to end on the live board

Christina Schmotolocha (a junk `Schmo` test row): Draft email → panel with the follow-up job named,
the counted-skeleton warning, subject and body → **Copy & mark it sent** → "Logged as emailed, dated
today" with the four date presets → **In 3 days** → Book it.

Her timeline now reads:

> **Email · sent** — "Emailed · sent it. Subject: Lin Realty Group at EXP Realty and AI search — Hi
> Christina, Following up on my last message on 2026-08-30. …" · Ryder Schilling · 2m ago

The email drafted as a **follow-up** rather than a first contact, because she has a first-contact
date from the earlier voicemail test — the job comes from the timeline, not the stage.

Lint clean. **2,489 checks in 25 suites.**
