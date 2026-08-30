# 2026-08-30 (evening) — internal — Stats · By rep is now a bar chart

**Asked for (Ryder, in his words):** "alright i need to launch the admin tonight
so lets work on getting it looking and functioning so it can be published.
starting with the sales page on the admin and owner side. remember everything
thats built that affects the sales sifde as well needs built properly so sales
and owner page tlk to each other properly. begining with stats. i want it to be
more like bar graphs for each rep with filters at the top to click to show
different stats to see who performed the best."

---

## What the page looks like now

`team tiles → pipeline health → BY REP → filter chips → bar chart → the full table`

- **13 filter chips in one band above the chart**, grouped Results / Effort /
  Watch. Click one and the chart redraws on that stat.
- **One horizontal bar per rep**, sorted best-first, the number printed at the
  end of every row, and a `BEST` chip on whoever is top.
- **The table underneath is unchanged.** It was relabelled "Every number, side by
  side" so it reads as the full version rather than as a second chart.

The chips, in order:

| Results | Effort | Watch (fewer is better) |
|---|---|---|
| Deals won · Conversations reached · Close rate · Proposals out | Leads claimed · Open right now · People emailed · Replies · Reply rate · Calls logged | Speed to first touch · At risk · Lost |

## How the owner side and the sales side stay in agreement

**Not one number on this chart is new.** Everything it draws is a field that
`repStats` (lib/sales-rules.js) or `outreachFor` (lib/outreach.js) already
produced, out of the one `getSalesBoard()` read the page already ran. Those are
the same two functions a rep's own Work page and their rep brief call.

So there is one set of maths and both ends read it. A test asserts the page calls
`getSalesBoard(` exactly once, and asserts the chart is handed the same `rows`
the table renders — two reads of the same team is how a chart and the table under
it come to disagree.

Owner and admin only. The menu leaves Stats out for a rep, and the dashboard
refuses to route there — `tests/sales` still asserts a rep cannot open it.

## The three rules the new file enforces

New file: **`lib/rep-metrics.js`** — pure, no React, no reads, no clock of its
own, which is the only reason a page that names a top performer in front of two
owners is safe to ship.

1. **Three stats sort the other way.** Speed to first touch, At risk and Lost are
   lower-is-better. One sort direction for everything would have put the slowest
   rep at the top of the leaderboard with a BEST chip on them.
2. **Null is not zero.** A number that could not be read is held out of the
   ranking, sorted to the bottom with no bar, and never crowned. On "At risk"
   that stops a rep we could not read from coming out as the safest person on the
   team.
3. **Nobody is crowned unless the comparison is real.** At least two reps have to
   have the number — best of one is not a comparison. On a more-is-better stat the
   winner must be above zero; a team who all won nothing has no top performer. On
   a fewer-is-better stat zero DOES win, because nobody at risk is the best
   possible result. Ties all carry the mark rather than one being picked.

## Two things that were wrong, and were caught by loading the page

Neither was caught by a test. Both now have one.

1. The no-winner sentence read **"only no reps have this number, and best of one
   is not a comparison"** whenever nobody had the stat. Three states need three
   sentences, not two.
2. The footer called every unmeasured row *"a number this page could not read for
   them"*. A rate is null **both** when the read failed and when nothing has been
   sent yet — no denominator. On a quiet week that sentence is a false claim about
   our own systems. It now says the honest version: either there is nothing to
   count yet, or the read came back empty.

## Colour

One hue at two depths, not one colour per rep. The chart draws one measure, so a
colour per rep would spend the only free channel on identity the name already
carries. Leader is `var(--accent-deep)`, everybody else `#a5b4fc`. Colour is
never the only signal — the leader is also first in the list, also carries the
BEST chip, and every bar prints its own number.

## Fixed on the way past

`_to_delete/__gatecheck.jsx` — untracked, left over from Aug 26, a deliberately
broken JSX file — was making **`npm run lint` fail for the whole repo**.
`_to_delete` is now in `eslint.config.js`'s ignore list. `npx eslint .` exits 0.

## Files

| File | |
|---|---|
| `lib/rep-metrics.js` | new — the metric list and the ranking |
| `tests/rep-metrics/` | new — 34 checks, `bash tests/rep-metrics/run.sh` |
| `src/components/admin/SalesStats.jsx` | the chips + the chart + the RepBars component |
| `src/admin.css` | new `.adm-st-*` block at the end |
| `eslint.config.js` | `_to_delete` added to ignores |

## Proof

- `npx eslint .` exits **0**.
- **21 test suites run, 2,060+ checks passing, 0 failing.** (auth-gate skips
  without Playwright; start-over and the SQL half of tests/sales skip without a
  local Postgres.)
- Driven in Chrome against the running dev server at
  `localhost:5173/#/dashboard/sales-stats`: every chip clicked, bar widths read
  straight out of the DOM — `Open right now` gives Ryder 100% / 2 and Andrew
  50% / 1; `At risk` crowns both at 0; `Deals won` draws both at 0% and crowns
  nobody. One chip pressed at a time. No horizontal page scroll. No console
  errors.

**Nothing is pushed and nothing is deployed.** `npm run build` still cannot run
on the Mac bridge (rollup's native module is missing there) — that has to happen
in Cursor.

Two notes for whoever is next: a long JS loop clicking all 13 chips **wedged the
renderer** (the known Chrome-extension trap) — one short call per question
instead. And a source-check test that counts `getSalesBoard(` has to strip
comments first, because the page's own comments name the function in prose.

---

# Second pass — what a separate checker found, and what changed

A separate agent was told to assume the work above was wrong and to report only
what was broken. It found six real defects. All six are fixed and every one now
has a test. The suite went from 34 checks to **45**.

## 1. The page could not tell you a number was short — the worst one

`getSalesBoard()` **does not fail loudly.** When a read breaks it returns an
empty list and records the failure in `board.errors` / `board.failed`. The
`catch` on this page only fires if the whole promise rejects, which is not what
happens.

So on a broken read the page would have rendered `Contacts loaded 0 · Won 0`,
said *"that is an empty list, not a missing one"*, and signed off with *"every
figure here is counted from real rows"* — every one of those sentences false,
with nothing on screen to contradict them. It would also have ranked the reps and
put a BEST chip on somebody.

The Sales page and a rep's own Overview have carried a pair of warning banners
for this since Aug 27. This page shipped without them. It has them now, and the
two sentences above are written differently when something did not load.

## 2. A failed read now arrives as `null`, not as an empty list

`lib/outreach.js` was built on a rule — `emailed: null` means *could not read*,
`emailed: 0` means *sent none* — and that rule was unreachable here, because the
page handed it `[]` either way. `board.failed` is what makes it reachable, and
the page now passes `null` for a reader that failed.

## 3. A rep who did NOTHING was being crowned BEST on "Lost" and "At risk"

The real one. Those two were ranked as plain counts, smallest first. A rep who
emailed forty people and claimed nothing has **lost 0** and holds **0 at risk**,
so the page put a BEST chip on them above a rep with 200 claims and 3 losses.
Even between two working reps it was wrong: 5 claims / 4 lost beat 200 claims /
5 lost.

A count with no denominator is not a performance. Those two, plus **"Open right
now"** (where crowning the biggest number rewards hoarding leads and never
working them), are now `crown: false`: they still draw a bar and a number,
because they are worth looking at, but the page will not name a winner on them
and says why. Each of the three now prints the book its number came out of —
"3 of 200 they have claimed" rather than a bare "3". Close rate is the version of
that question that has a denominator, and it is still winnable.

## 4. The chart heading said "all time". It is not

`PERIOD_ALL` means every row the page managed to **read**, which is a different
sentence — and on a short read, very different. The heading now says
**"over everything loaded"**, which is what the table's footnote has always said.
`periodWords` also no longer has a silent default, so a typo in a future metric's
period prints nothing instead of labelling an all-time figure "right now".

## 5. Three of the 34 tests were not testing anything

- One assertion was `!A || B` where `B` was unconditionally true. It could never
  fail. It now checks the actual imports and counts the loops over `leads`.
- The chips test grepped the whole file for `<button` and `aria-pressed`
  separately — it would have passed with the chips as `<div>`s. It is now scoped
  to the chip element itself.
- The "does not mutate" test only re-checked the input array's order, which
  `.map()` cannot change anyway. It now compares the whole structure.

## 6. Two accessibility gaps in the chips

Each band (Results / Effort / Watch) is now its own named group, so a screen
reader gets the same split the eye gets — it was thirteen buttons under one flat
label. And each chip's explanation lived only in a hover `title`, which does not
exist on a keyboard or a touch screen; it is on the button itself now.

Also: the row `key` fell back to the display name, so two reps both resolving to
"Unnamed" would have shared a key and React would have reused the wrong row.

## Two things the checker raised that were left alone, on purpose

- **On the three lower-is-better stats the longest bar is the worst rep.** That
  is what the data is. The caption says "Fewer is better — shortest bar wins",
  the number is printed on every row, and the two where zero was meaningless no
  longer crown anybody. Inverting the bars would make "9 days" look like a small
  number, which is worse.
- **The rep gate is client-side only.** The router refuses to open this page for
  a rep and `tests/sales` proves it, but there is no server-side block. What is
  being protected is one rep seeing another rep's comparison, and the underlying
  reads are ones a rep's own Floor already performs. Worth knowing; not something
  to fix quietly tonight.

## Proof, second pass

`npx eslint .` exits 0 · **tests/rep-metrics 45 passed, 0 failed** · the suites
that touch this code re-run clean: sales 112, outreach-stats 177, rep-brief 57,
rep-report 54, sales-sheet 139 · reloaded in Chrome and read out of the live DOM:
0 warning banners on a healthy read, heading reads `Lost · over everything
loaded`, both rows print "of 1 / of 2 they have claimed", no BEST chip on Lost,
and the footer gives the on-purpose reason.

---

# Third pass — spacing

**Ryder:** *"add a little bit of space around all the borders and cards so that it
doesnt look so crowsded."*

Measured before → after, on the Stats page: tile gap 12 → 16px, tile padding
14/16 → 18/20px, the pipeline card 14/16 → 20/22px, the chart card 16/18 →
22/24px, chart rows 7/8 → 11/12px (44px tall), table cells 9/14 → 13/18px, and
every section heading now has 34px above it instead of 24px.

**Scoped to this page on purpose**, through a new `adm-st-page` class on the page
root. `.adm-sl-tiles`, `.adm-sl-health` and `.adm-sl-table` are shared with the
Sales sheet, and the sheet is a screen somebody *works* — tight rows mean more
leads on screen, which is the point there. Stats is a screen somebody *reads*.
Same components, different job, so the padding lives in a scoped block rather
than in the shared rules. Loosening the sheet too is a one-line change if he
wants it.

Checked after: no sideways page scroll, the chip band is still one band (67px),
45 checks pass, `npx eslint .` exits 0.

## The outer margin (same session)

**Ryder:** *"make the space around the outside border of the box larger so it
doesnt feel pinched in."*

`.dash-content` went **28/36/56 → 40/48/80**, and `.dash-header` moved with it
(**28/36/24 → 34/48/26**) so the page title still sits on the same left edge as
the cards underneath it. A new 1400px step keeps the old-ish numbers on smaller
screens, and the 1080px step was raised slightly to match.

**Set in `src/admin.css`, not in `src/index.css`** — index.css is the platform's
design system copied in verbatim and the two are deliberately kept identical.

**Applied to every page, not just Stats.** A page whose cards start 48px from the
edge, next to one whose cards start 36px from the edge, reads as a broken layout
the moment you click between them.

**The side padding was the risk, and it was checked.** Every pixel added there is
a pixel taken off the Sales sheet and the Operations table, both of which wrap to
a second row of controls when they run out of width. Measured on the Sales page
afterwards at Ryder's own window (1470px): `.adm-sl-bar` is **67px — still one
line**, matching the 66px recorded on Aug 30 before the change. No sideways page
scroll on either page. Nothing on the Stats page is clipped (checked by zooming
the left edge: "BY REP", "RESULTS" and "EFFORT" all render whole).

Re-measure that toolbar if these numbers ever move again.
