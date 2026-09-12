# Most of a labelling diff was dead code

**9 September 2026.** Internal. Platform repo only. Follows
`2026-09-08d--internal--nothing-may-spend-without-recording-it.md`, which is
pushed (`c7e8309`).

**NOT pushed.** Commands at the bottom.

---

## The 30-second version

67% of platform AI calls landed on the AI Cost page as "not labelled yet", so I
set out to attribute the handlers driving it. First attempt labelled eleven.

**A checker found that four of the eleven were entirely dead code, three more
were pure renames of live rows, and one was actively destructive.** Reverted
those, kept the seven changes that close a real hole. The honest movement is
**8 → 15 of 109 handlers**, not the 8 → 19 the first attempt claimed.

---

## ⭐ WHY MOST OF IT WAS DEAD: spendPlanTokens ALREADY LABELS

`spendPlanTokens()` calls `fillAiMeterContext({ platformFeature: key, workspaceId })`
(`lib/plan-tokens.js:438`). So **any handler that charges plan tokens before its
paid call is already attributed at run time** — its plan key IS the job name on
the page. That is why `accuracy.correct`, `brand.probe`, `reviews.sources` and
`social.post` were already on the live page without anybody labelling them.

Adding `setAiMeterContext` to those handlers is dead code at best. At worst it
is a **silent rename**: the outer label wins over `fillAiMeterContext`, so a new
spelling replaces a live row and splits its history. The first attempt did that
six times — `social.planMonth` → `social.plan-month`, `content.planMonth` →
`content.plan-month`, `brand.probe` → `brand.confusion`/`brand.sources`, and so
on. Pure churn: same job, new name, two rows.

**Reverted entirely:** `api/review-sources.js` (a strict no-op — the label was
character-identical to the plan key that fires before every paid call),
`api/brand-confusion.js`, `api/brand-sources.js`, `api/accuracy-watch.js` (three
of its four additions set the identical string one line before
`spendPlanTokens` set it anyway).

## ⭐ AND ONE ADDITION WAS WORSE THAN THE BUG

`api/social-analytics.js` got one label for the whole handler. That file has
**three** distinct paid jobs: the analytics read, `feedProfile()` (plan key
`social.feedProfile`) and `contentDna()` (`social.dna`). Because the outer label
beats `fillAiMeterContext`, a handler-wide `social.analytics` would have meant
**`social.feedProfile` and `social.dna` could never appear on the cost page
again** — all three collapsing into one row.

That is exactly the defect logged on 8 Sep, inverted: not a charge renaming its
job, but a label erasing two. It is now three labels, one per branch, each using
the key that branch already charges under.

**The rule this produced: before adding a label, find out what is already
labelling that call.** A label is not additive — it overwrites.

---

## What actually changed — 9 files, 1 new test, +182

Seven handlers, each closing a hole nothing else covered:

- **`api/page-fixes.js`, `api/ai-access-identity.js` — a hoist, not a wrapper.**
  Both resolved `getUserWorkspace` only AFTER the paid call, inside the
  plan-token block, so every Claude call reached the meter with no tenant and
  no job. Lookup hoisted above the call; the later spend sites reuse it, so the
  charging is byte-identical (`ref`/`opRef` interpolation unchanged).
- **`api/content.js` — the draft RESUME passes.** A draft is written in several
  passes and only the first (`cursor === 0`) charges, so passes 2..n called
  `runEngines` unattributed. Labelled with the existing `content.draft` key, so
  a whole draft is one job rather than one labelled call and n silent ones.
- **`api/social.js` — the three actions nothing labels.** `generate-image`
  (`siteVisualIdentity()` is a billed vision read and runs in the `Promise.all`
  ABOVE the spend), `publish` (reaches the publishing vendor and charges no plan
  tokens at all), and the four market reads (no plan key exists). Everything
  else in that file was left alone.
- **`api/social-analytics.js`** — three per-branch labels, as above.
- **`api/cron/social-digest.js`, `api/cron/social-alerts.js`** — the two crons
  actually making the zernio calls seen on the live page. Neither calls
  `spendPlanTokens`, so nothing labelled them.

`scripts/check-ai-meter-context.mjs` — the seven finished entries deleted from
its TODO list. `scripts/check-ai-meter.mjs` — a documented weakness, below.

---

## ⭐ A DELIBERATE DEVIATION, MEASURED — AND ITS GUARD WAS USELESS FIRST

The standing rule is `withAiMeterContext` for anything looping over workspaces,
because `setAiMeterContext` is `enterWith` and concurrent siblings overwrite
each other. The two crons deviate: they use `setAiMeterContext` per iteration,
because their loops are sequential `for...of` and wrapping the body would turn
every `continue` in it into a `return` — a control-flow rewrite of a working
cron for no gain.

Measured, not argued: a probe over that exact shape (including the `continue`
skip paths) labelled every row with its own workspace and mislabelled none. A
checker then read `gatherSocialWeek`, `analyticsScope`, `fetchPostList`,
`zernioCall`, `sendEmail` and their callees end to end and confirmed there is no
unawaited promise, `.then`, `void` or cross-workspace batcher anywhere in the
chain — every paid call happens inside the loop.

⭐ **The guard on that deviation was worthless as first written.** It grepped for
one spelling, `/Promise\.all\s*\(\s*workspaces/`. The checker refactored the
cron into a genuine fan-out — body lifted into `async function runOne(workspace)`,
`pending.push(runOne(workspace))` inside the retained `for...of`,
`await Promise.all(pending)` after it — and **all three tests stayed green
against a concurrent cron.** So did `Promise.allSettled(workspaces.map(...))`
and aliasing the array first.

It now checks a SHAPE rather than a spelling, and the tell that catches the
refactor is `x.push(f(workspace))` — collecting per-workspace promises for a
later await. That exact bypass now fails. **A negative regex over source text
loses to a reformat**, for the third time this week.

Also fixed from the same pass:
- **`surface` was missing on both crons.** It defaults to `"api"`, and neither
  cron calls `spendPlanTokens` (which is what sets `"cron"` for the crons that
  do), so their zernio spend would have been filed as request traffic on the
  page whose whole job is saying where money went.
- **`JOBS[action]` answered prototype keys.** `action` is caller-supplied and a
  plain object literal returns truthy junk for `"constructor"`, `"toString"`
  and `"__proto__"` — the last serialising into the column the page groups by.
  `Object.hasOwn` now. No branch matched those, so nothing paid followed, but a
  lookup that is only safe because of what happens later is not a safe lookup.
- **A comment naming a provider hostname failed the build.**
  `scripts/check-ai-meter.mjs` greps RAW source for provider hosts, so
  explaining which vendor a job covered made `api/social.js` look like a direct
  caller. Fail-safe but noisy, and a noisy guard gets switched off. Reworded,
  and the weakness is now written into that script's own header — its two
  siblings strip comments and it should too.

---

## Two things I got wrong in yesterday's report, corrected

1. **`feature: other` on the zernio rows is NOT a defect.** `FEATURES` in
   `lib/ai-cost.js` is the ADMIN console's own list (assistant, notes,
   lead_scrape…). The platform's meter never sends `feature`, and the ingest
   coerces null to `"other"`. For a platform row that is the correct value. The
   job name lives in `platform_feature`, which is what "By job" groups on — and
   THAT was null for those calls, which is the real finding and still stands.
2. **`social.post` is not reused for three actions.** Only `generate` maps to
   it; `raise-score` and `next-post` share its plan key. The first attempt would
   have split them off into new rows, which is a rename, not a fix.

---

## Proof

- `npm run lint` → **exit 0**, all seven checks. `check:aimetercontext` reports
  **15 of 109 spending handlers attribute their spend (94 still on the TODO
  list)** — up from 8 of 109 / 101.
- `npm test` → **3,800 tests, 3,795 pass, 0 fail, 5 skipped**.
- `lib/ai-meter.sequential-context.test.js` (new, 3 tests) proves the
  sequential-loop property by measurement, proves the label does not leak past
  the loop, and its paired source check now fails on the checker's own fan-out
  refactor, on the label being removed, and on the cron surface being dropped.
- The diff shrank from 13 files / +217 to **9 files / +182** by deleting work
  that did nothing.

**Not verified:** nothing is deployed. What these labels do to the page cannot
be known until the handlers run in production. After deploying, the things to
look for on **By job** are `social.digest`, `social.alerts`, `social.publish`
and `social.marketRead` appearing at all, `social.feedProfile` and `social.dna`
still being present as separate rows, and no existing row disappearing.

Every figure remains **METERED**, never **BILLED**.

---

## ⭐ ONE NUMBER TO STOP TRUSTING

**"94 still on the TODO list" overstates the problem.** That guard's definition
of "attributed" is a source-text test for a literal `setAiMeterContext` or
`withAiMeterContext` call. It does not know that `spendPlanTokens` labels a call
through `fillAiMeterContext` — which, as above, is how most of the already-
labelled jobs on the live page got their names.

So an unknown share of those 94 handlers are attributed at run time and simply
do not say so in a way the guard can see. Teaching the guard to accept
`spendPlanTokens(admin, workspace, "<key>")` as attribution would shrink that
list honestly and stop the next person from writing the same dead code I did.
**That is the next piece of work on this, and it is worth more than labelling
the 94 one at a time.**

---

## To push — Ryder, from Cursor

Platform only. A branch off `origin/main`, never local `main`:

```
cd ~/aisyndicate/ai-syndicate-live
git fetch origin
git checkout -b fix/attribute-the-unlabelled-spend origin/main
git add api/page-fixes.js api/ai-access-identity.js api/content.js api/social.js \
        api/social-analytics.js api/cron/social-digest.js api/cron/social-alerts.js \
        scripts/check-ai-meter-context.mjs scripts/check-ai-meter.mjs \
        lib/ai-meter.sequential-context.test.js
git commit -m "Label the spend nothing else was labelling"
git push -u origin fix/attribute-the-unlabelled-spend
```

Open the PR, wait for `CI / Lint`, merge. **No database change.**

⚠️ Check after `git checkout`: `lib/ai-meter.js` must contain `searchapi.io` —
that proves the fetch picked up #2054. If it does not, stop rather than
committing on top of a stale base.

---

## Still open, in order

1. **Teach the context guard about `spendPlanTokens`** — see above. Biggest win.
2. **`per_call_micros`** in the price book. **Blocked on: which SerpApi plan we
   are on.**
3. **The AI Cost page does not split by kind** — still the blocker for metering
   Twilio, Resend, Instantly and X, and for pricing zernio.
4. **`SEARCHAPI_KEY` and `ENABLE_SOCIAL_MARKET` are unset in production**, so
   the market sweep spends nothing. `social.marketRead` is a label waiting for
   a decision about whether that feature should run at all.
5. `scripts/check-ai-meter.mjs` should strip comments like its two siblings.
6. Nothing has ever been checked against a provider's real bill — CJ or Andrew.
