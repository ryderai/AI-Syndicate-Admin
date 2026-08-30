# 2026-08-30 (evening) — internal — the sheet: click a row to open, click a chip to move

**Asked for (Ryder, in his words):** "now on the sales i want to work on the
actual leads and how the workflow is on the sheet. i want it so that its a
normal row that when you click anything that isnt a tag it opens the client
card. but on the tages, wgen you click it you get a set of premade tags and then
when you click a tag you can add a optional note. i dont want to be able to add
tags, i want everything simple, one click movement through the pipeline. also in
the pipeline i want to be able to drag the client over into new pipes and have
the tag update with it. and when you scroll down i still need to be able to see
the title of the row. and make sure the rows on the end dont get cut off"

**Settled with him first:** "the tags are any collumn that has pre set lead stage
like contacted or won or lost, all of that stuff. the goal is to make the
salesmans job as easy as possible … we have friggin 3000+ leads, we need to be
able to do this at scale." And the optional note goes **on the client card
timeline**, not into a cell.

---

## What a row does now

**Two kinds of thing on a row, and they look like two kinds of thing.**

- **Click anywhere that is not a chip → the person's card opens.** Name, title,
  email, company, the next step, the dates — all of it is now text you read, and
  the click passes through to the row.
- **Click the Sales Cycle Status chip → the premade list.** Every stage with a
  one-line plain-words meaning beside it, the current one ticked. **One click
  moves the lead.** The List chip works the same way.
- **Then, and only then, an optional note.** "Moved to Meeting. That is saved."
  with a box under it. Enter saves, Escape or clicking away skips, and skipping
  loses nothing because the move was written before the box appeared.
- **The Pipeline board takes drags.** Pick a card up, the column you are over
  lights, drop it and the status changes with it — the same note box follows.

**The order is the whole design.** The move is written the instant a chip is
clicked, not when the note is saved. At three thousand leads, asking for the
note first is the difference between a tool and a chore.

## Nothing became uneditable

Name, title, email, phone, city, the next step, the owner and the stage are all
still editable — on the client card, which is now one click from anywhere on the
row. This is a move, not a removal. `TextCell`, `PopoutCell`, `PersonCell` and
`SelectCell` are gone from the sheet entirely.

## No way to invent a status

"i dont want to be able to add tags." The picker renders a fixed list and has no
text input anywhere in it. The panel says so out loud — *"This list is fixed.
Everything the pipeline can count is already on it"* — because a menu with no
"new…" in it reads as broken until somebody tells you it is deliberate. A
free-text status column is what the Google sheet had, and it is why nothing in
it could be counted.

The **Tags** column is display-only for the same reason. Most of those tags are
applied by rules in `lib/sales-rules.js`; a rep hand-adding "Gone quiet" beside a
rule that counts it is two sources for one fact. The dated history is still one
click away in the row's ⋯ menu.

## Won and Lost do not ask twice

They open the reason box that has existed since Aug 27 and skip the note box —
that box **is** the note. Dragging a card onto Won still creates the client
record, because the board writes through the same `patchLead` the chip does. A
test asserts the board never calls `upsertLead` or `addLeadActivity` itself.

## The other two asks

**The header stays put.** A sticky `<th>` sticks to its nearest scrolling
ancestor, and this table's wrapper has always had `overflow-x: auto` — which
makes it that ancestor in *both* directions, so a header stuck to the page would
have stuck to nothing. The wrapper is now a bounded scroll box
(`max-height: calc(100vh - 330px)`), the headers stay, and 3,663 rows no longer
push the toolbar off the top of the screen.

**The last column was 46px wide.** The colgroup said `46` and the header said
`210`, and `table-layout: fixed` reads the colgroup — so Claim, Email, ⋯ and ⤢
were cut off the right edge of every row. One number in two places, disagreeing
for as long as the sheet has existed. It is one constant now.

## Two bugs found by clicking it, not by a test

1. **Picking a stage opened the client card on top of the menu, every time.** A
   React event bubbles through the **React** tree rather than the DOM one, so a
   click on an option inside the popover reached the `<tr>` underneath it. Both
   popovers stop their own clicks now, and there is a test for it.
2. **"In conversation" rendered as "In conversa".** Flexbox was shrinking the
   chip to make room for its own explanation. The chip is `flex: 0 0 auto` now.

## Files

| File | |
|---|---|
| `lib/stage-move.js` | new — the rules all three screens ask |
| `tests/stage-move/` | new — 29 checks, `bash tests/stage-move/run.sh` |
| `src/components/admin/chipPicker.jsx` | new — the fixed list and the note step |
| `src/components/admin/salesSheet.jsx` | reading cells, the row click, the two chips, the Do width, the scroll box |
| `src/components/admin/SalesPage.jsx` | the note rides with the move; the board takes drops |
| `src/admin.css` | appended block |
| `tests/sales/test.mjs` | two assertions updated — see below |

**Two existing tests were updated, not deleted.** One asserted a rep gets no
owner picker; nobody gets one on a row now, so it asserts the stronger thing
(the sheet has no `PersonCell` at all). The other pinned the exact text of the
Won/Lost line, which changed shape when `patchLead` started reporting whether it
wrote anything — the rule it protects is unchanged.

## Proof (Aug 30 2026, evening)

`npx eslint .` exits 0 · **stage-move 29, sales 112, sales-sheet 139, lead-tags
220, floor-scoping 231, rep-metrics 45, outreach-stats 177, rep-brief 57,
rep-report 54 — all passing, 0 failing.**

Driven in Chrome against the running dev server, on the real 3,663-contact
pipeline:

- Header row measured at the same `top` before and after scrolling 1,200px.
- Scrolled fully right: the Do cell ends at 1421px and the box ends at 1421px —
  Email, ⋯ and ⤢ all fully inside it.
- Opened the status menu: 12 stages, every chip rendering its full label, the
  current one ticked, no text input in the panel.
- **Moved a lead and read it back:** Dana Del'marmol Contacted → Researching,
  typed a note, and found both on her timeline — `Contacted → Researching` and
  the note as its own dated line. **Put back to Contacted afterwards**; the two
  timeline lines and one note stay as the record of the test.
- **Dragged a card:** Deborah Howell from New onto Researching. The column lit
  while the card was over it, the counts went 60/0 → 60/1, and the note box
  appeared. **Dragged back to New**; counts returned to 60/0.
- Clicked a plain cell — the card opened. Clicked a chip — the card did not.

**Nothing is pushed and nothing is deployed.**

## Still open

The **client card** still has a "+ add a tag…" dropdown on it. Ryder's "i dont
want to be able to add tags" was said about the sheet, and the card is the one
place a rep can mark something no rule can detect — so it was left alone rather
than removed on an assumption. It is a one-line change if he wants it gone.

## The strip above the table (same session)

**Ryder**, boxing it in a screenshot: *"remove this text"* — the
`3657 PEOPLE · Contacted? and Touches count the last 90 days` line on the left
of the toolbar.

Gone. Both halves were duplicates of something already on the screen:

- **the row count** is on the list tab above it (`Everybody 3663`) and stated in
  full on the summary card above that (`3657 people at 2765 firms`);
- **the 90-day window** is a real and important fact — Contacted? and Touches are
  counted from a window, not from the whole history, so somebody worked hard in
  the spring and quiet since reads "Yes, older" with a full timeline inside.

**That fact was not dropped, it moved.** It is the tooltip on the two column
headings it is actually about, which is where somebody wondering about that exact
column will look. A window left unsaid is what made those two columns read as
lifetime facts in the first place. `WINDOWED_COLUMNS` in `salesSheet.jsx` is the
list; adding a third windowed column is a one-word change.

The strip still carries everything on its right — the filter chips, Type of
business, Filters, Group by and Columns. `.adm-sh-count` and `.adm-sh-window`
were deleted from `admin.css` with the markup they styled.

**Checked after:** reloaded and read the live DOM — the sentence and the
`N PEOPLE` count are both absent from the page, the strip now begins with "Type
of business", and the CONTACTED? heading carries *"Counted from the last 90 days
of logged activity…"*. `npx eslint .` exits 0. stage-move 29 · sales 112 ·
sales-sheet 139 · lead-tags 220 · floor-scoping 231 · rep-metrics 45 ·
outreach-stats 177 · rep-brief 57 · rep-report 54 · overview 44 · brain 78 —
all passing, 0 failing.

**One thing worth writing down about testing this:** the first check said the
text was gone while the app was still on its splash screen, so it was testing an
empty page. Wait for a real element (`.adm-sh-table`) before asserting that
something is absent — "not present" is the one assertion an unloaded page always
passes.
