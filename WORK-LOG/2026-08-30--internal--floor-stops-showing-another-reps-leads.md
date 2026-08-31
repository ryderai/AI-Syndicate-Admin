# The Floor stops showing another rep's leads — Sun 30 Aug 2026, evening

**Internal · admin console · Sales.** Append-only record. Repo copy of the reasoning is
`CONTEXT-FOR-AI.md` §52, which supersedes §45.3 on visibility.

## What Ryder asked for

> "first is the floor needs to be synced with both rep and owner and admin. they should all have
> the same lead list and display all the same stuff. same with if any or claimed that needs to be
> seen everywhere. but on the reps page if something becomes claimed by someone else then it gets
> removed from the floor and the rep doesnt see those leads, only the claimed rep and the
> owner/admin see it. that way the reps never comingle."

## What the two screenshots actually showed

Not two lead lists. One list, two filters, on two different servers.

- The rep Floor opened on **Mine**. Ryder holds 0 leads there, so every list tab counted 0 and the
  table was empty. The owner page opened on **Everybody**, so it showed 3,663.
- **3,657 vs 3,663 was never a bug.** 3,657 is "Open only"; 3,663 is every stage. Six leads are
  closed.
- The real gap: a rep's page had no My Day, no Pipeline board and no Firms view. The availability
  switch was sitting where the owner's four view tabs sit.

The Floor and the owner's Sales page were already one component (`SalesPage.jsx`) reading one call
(`getFloorBoard`), which is why "sync them" needed no new plumbing.

## Two decisions Ryder made before the build

1. **Hide the row, warn on the firm.** A rep never sees another rep's row. An unclaimed row at a
   firm somebody else has an open claim at carries a ⚠ that names nobody.
2. **Screen-only enforcement, for now.** No migration. Written down as a deliberate gap in
   `0020_rep_scoping.sql` (comment-only edit; no SQL changed) and in §52.

## What was built

- `visibleToMember(leads, member)` — the rule, in `src/lib/salesSheet.js`. Applied in exactly one
  place, `scopeLeads`, before any filter. The deep-link guard, the `?lead=` pre-check, the drawer,
  My Day, the tiles, the list tabs and the Firms view all read that one set.
- `firmsHeldByOthers(leads, member)` — the ⚠, computed from the **whole** board before the
  narrowing, open stages only. `FIRM_BUSY_LABEL` / `FIRM_BUSY_WHY` hold the words.
- The rep's Floor gained the owner's four views, four tiles, and now **opens on All** (yours plus
  unclaimed) rather than Mine.
- The AI's two doors into the same rows were shut — see below.

## THE THING THAT WOULD HAVE SHIPPED

A separate checker agent, told to assume the change was wrong, found **twelve** defects. The one
that matters most:

**Hiding rows on a page is not hiding rows.** A rep could open **AI Brain**, ask "which leads are
going cold", and `lib/brain-context.js` handed the model every other rep's open leads *with the
holder's name on each line* — while the panel's own caption read "Reads your leads, your firms and
your own follow-ups. Nothing else." `lib/assistant-tools.js`'s `search` tool was a second route to
the same rows. Both run on the service role, which ignores row-level security, so the code is the
guard.

The rule now lives in three files and each names the other two; `tests/floor-scoping` asserts that
they point at each other.

The other eleven, briefly: the ⚠ ignored stage (a Lost contact marked a firm busy for ever, while
the drawer on the same firm said nothing) · the sheet told a rep "we hold 4 people at this firm,
group by Company to see them" over one visible row · the firm popover said "their contacts are not
on your floor" about a list containing the reader · the Floor's hint still promised greyed
read-only rows **and a test asserted it** · the four restored tiles counted through the
availability switch and the list under them did not · My Day ignored that switch and offered "Free
to claim" cards while it said Mine · the Firms view said "Working it: nobody" about a firm the
sheet marked ⚠ · the empty screen told a rep with a fully-claimed book that nothing had been
imported, over 3,663 rows · eleven stale comments across five files still asserting the Aug 27
rule · `heldByLabel` printing "Held by another rep" on an *unclaimed* row · and two fail-opens
predating today (`ownerFilter` seeded to `undefined`, and `MODES[mode] || MODES.mine` falling back
to *unlocked* because there is no `mine` mode).

All twelve are fixed. Every one that could be pinned has a test.

## Proof, and what is NOT proven

- Lint clean across `lib src api tests`.
- **2,136 checks in 22 suites, all passing.** `floor-scoping` 291 (was 231), `sales` 112.
  `auth-gate` and `inbox` still do not run on the Mac bridge; both predate this work.
- **Driven live in a browser as the OWNER** on the local dev server after the change: the sheet
  (3,657 people at 2,765 firms, Everybody 3,663, list tabs intact, grouped by Sales Owner), the
  four view tabs, and the Firms view all render correctly.
- **NOT driven as a rep.** The dev server runs against live keys, and there is no sales-role
  account to sign in as. Testing the rep view needs preview mode, and Vite only reads `.env` at
  start-up, so it needs a restart nobody but Ryder can do from Cursor. `.env.local` was flipped and
  **restored byte-identical** — verified with `diff`.

### The four steps to see the rep view

1. In Cursor, stop the dev server (`Ctrl+C` in the terminal running `npm run dev`).
2. Open `.env.local` and change **line 7** from `VITE_NO_SIGNIN=false` to `VITE_NO_SIGNIN=true`.
   (Note: appending a second `VITE_NO_SIGNIN` line at the bottom does nothing — the first one wins.)
3. Run `npm run dev` again and open `http://localhost:5173`. The "Who do you want to be?" screen
   appears. Click **Sales rep**.
4. Open a second tab and click **Owner** there, to compare the two side by side. The choice is per
   tab.

Put line 7 back to `false` and restart when finished.

## Nothing is committed and nothing is deployed

`git status` shows 8 modified files. Same as §49-§51 — none of that is pushed either.
