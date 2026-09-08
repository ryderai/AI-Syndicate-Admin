# The cost page learns what the money bought

**8 September 2026, second session.** Internal. Follows
`2026-09-08--internal--a-rate-limit-is-not-a-failure-and-a-dead-engine-is-not-a-lost-client.md`,
which is shipped and live.

**Nothing here is pushed.** Commands at the bottom.

---

## The 30-second version

The AI Cost page could tell you the bill was $11.08 and could not tell you what
any of it bought. Four of its six views were a single row:

```
By feature → other · 1,655 calls · $11.08
By page    → api   · 1,655 calls · $11.08
```

Two causes, and the first one was nearly free to fix.

1. **A column was collected and never shown.** `platform_feature` has been
   written by `api/usage-ingest.js` since migration 0032 and grouped on by
   nothing. Added a **By job** view that reads it. ~15 lines.
2. **Almost nothing sets it.** 103 handlers in the platform can spend money;
   **one** file said what it was doing. Fixed the mechanism that made labelling
   impossible, labelled the two worst offenders, and added a lint guard with a
   101-line TODO list so the rest gets done and no new handler ships unlabelled.

---

## ⭐ THE ONE THAT MATTERS: A CHARGE WAS OVERWRITING THE LABEL

This was my own design error and a checker caught it after I had already
written the wrong version into two crons, three comments and a lint script.

`spendPlanTokens` (`lib/plan-tokens.js`) sets the meter context from all 69
spend sites:

```js
setAiMeterContext({ platformFeature: key, workspaceId: workspace?.id || null, ... });
```

`setAiMeterContext` is `enterWith`. The charge runs **inside** whatever scope a
caller opened, so it replaced that caller's labels for the rest of the chain.
Measured on the device, Node 22:

```
wsA BEFORE charge: { workspaceId: "wsA", platformFeature: "brand.scan" }
wsA AT PAID CALL : { workspaceId: null,  platformFeature: "brand.probe" }
```

Every paid call in those crons happens **after** the charge. So a cron that
carefully wrapped itself in `withAiMeterContext({ platformFeature: "brand.scan",
workspaceId })` produced rows labelled `brand.probe`, owned by nobody. **The
wrapper looked right, read right, and labelled nothing.** All three of my new
job names would have appeared on the cost page exactly zero times.

`workspaceId` was nulled for a second reason: `workspaceRowsForMetering`
returns an empty map while `ENABLE_PLAN_TOKENS` is off — its state today — so
`workspace` is `null` at the charge and `null` is written over a real id.

**The fix, in one place, covering all 69 sites:** a new `fillAiMeterContext` in
`lib/ai-meter.js` that only fills blanks. The outer, more specific label always
wins. `spendPlanTokens` now calls that instead. `surface` is the awkward field —
it has a real default of `"api"`, so "already set" for it means "set to
something other than the default", or a cron could never be labelled a cron.

---

## What actually changed

### Admin (`ai-syndicate-admin`)

- `lib/ai-cost.js` — new `GROUPINGS.job`, `UNLABELLED`, `CONSOLE_PREFIX`.
  Keys on `platform_feature`; a console call becomes `console · <feature>` so
  it can never be added to a platform job of the same name; anything else is
  `— not labelled yet —`, which is a gap named as a gap rather than hidden in a
  bucket called "other".
- `src/components/admin/AiCost.jsx` — `"job"` added to `TABS`, first after
  client, because it is the question the page is most often opened to answer.
- `tests/ai-cost/test.mjs` — section 8. **367 passed, 0 failed**, five zones.

### Platform (`ai-syndicate`)

- `lib/ai-meter.js` — **`fillAiMeterContext`**, the fix above.
- `lib/plan-tokens.js` — uses it. One line, 69 call sites.
- `api/cron/brand-alerts.js`, `api/cron/sentiment-alerts.js` — the three
  `scanOne` bodies wrapped in `withAiMeterContext`, naming `brand.scan`,
  `sentiment.scan`, `sentiment.refresh` and their workspace.
- **`scripts/check-ai-meter-context.mjs`** — new guard, wired into
  `npm run lint` as `check:aimetercontext`.
- `lib/ai-meter.context-fill.test.js` — new, 8 tests.

---

## The guard, and why its TODO list starts at 101

Every spending handler must call `setAiMeterContext` or `withAiMeterContext`.
It reuses the sister check's real import-graph walk, so "spending handler"
means the same thing in both.

**The allowlist is a TODO list, not an exemption.** A guard that only arrives
once the work is finished never guards the work being done. Today it prints:

```
✓ ai-meter: 2 of 103 spending handlers attribute their spend (101 still on the TODO list).
```

Every line in it is a handler whose spend is unattributed. Deleting a line is
the unit of progress. A **new** handler is never allowed in — it fails the day
it is written, which is the only cheap moment to add one line to it. And a
handler that IS done but is still listed fails too, as a stale exemption, so
the list has to shrink on its own.

The list is ordered as the work should be done: the three handlers that resolve
their workspace **after** they have already spent (`page-fixes.js`,
`ai-access-identity.js`, `accuracy-watch.js` — those need a small hoist, not a
wrapper), then the 24 crons, then the request handlers.

---

## What the checkers found

One adversarial pass, told to assume the work was wrong. **11 defects.** The
ones worth keeping:

1. **The charge overwrote the label** — above. It made 100% of the platform
   diff a no-op while every test and lint check stayed green.
2. **My "billing to a real, wrong customer" justification was false** — said
   three times in the diff and once in the lint script. With
   `ENABLE_PLAN_TOKENS` off, the pre-fix `enterWith` set `workspaceId: null`,
   so spend was **unattributed, not misattributed**. The cross-customer leak is
   real only in `runWeeklyRefresh` today, and becomes real in the other two the
   day that flag is turned on. The comments now say latent, not happening.
   **A defect that is one config change away is worth fixing and is not worth
   overstating.**
3. ⭐ **The lint guard false-greened three ways**, two of them the sister
   script's own bug class. It stripped only whole-line `//` comments, so
   ```js
   await brandSerp(domain);   // TODO: setAiMeterContext({ workspaceId })
   ```
   satisfied it — and a trailing TODO note is the single most likely way for
   somebody to write the exact reminder that should have failed the build.
   `console.log("call setAiMeterContext(")` passed too. Both closed by
   stripping trailing comments and string literals. `if (false)
   setAiMeterContext(...)` still passes; that needs real reachability analysis
   and the script now **says so in its own header** rather than implying more
   than it can do.
4. **`HOSTS` matched env var NAMES, not hosts.** I put `ENV_HOSTS` into the
   host list; its first element is `PLATFORM_SCORE_URL`, so any file whose text
   merely mentioned that variable — including in a comment — counted as a
   spending handler, while catching nothing real. The sister script imports
   `ENV_HOSTS` and pointedly never uses it. Removed, with a note saying why, so
   the two scripts agree on what a spender is.
5. **A whitespace job name was its own group.** `usage-ingest` slices this
   field but never trims it, so `"   "` is truthy and rendered as a **visually
   blank table row with a dollar figure beside it** — which reads as a
   rendering bug and hides an unlabelled call. Trimmed, and whitespace now
   counts as absent.
6. **The stale-TODO check had the order backwards.** A file that was already
   done and still listed was silently accepted — the one case that check exists
   for. Caught by putting a finished file back on the list and watching it stay
   green.
7. **A TODO entry that stops being a spender was silently forgiven**, so a
   refactor could leave a line there forever with nothing to flag it.
8. **The `wsByDomain` comment was wrong.** It claimed the map can miss; `list`
   and `wsByDomain` are built from the same array, so it cannot. The `|| null`
   is still correct for a different reason (a null `workspace_id`, and a
   changed `opRef` dedupe key), and the comment now says that reason.

---

## ⭐ The lesson, and it is the same one twice in one day

**A test that reimplements the code under test proves the reimplementation.**

The first `lib/ai-meter.context-fill.test.js` defined a local `charge` helper
that called `fillAiMeterContext` directly — "what spendPlanTokens does, reduced
to the one line that mattered." All six tests passed. Then I put the
**clobbering `setAiMeterContext` back into `lib/plan-tokens.js`** and they went
on passing, because nothing in the file ever touched that file.

It now calls the real `spendPlanTokens`. With the bug reinstated: **5 of 8
fail.** Restored: 8 of 8 pass.

This is the same shape as this morning's finding — seven source-regex guards
surviving a one-line revert of `denomOf`. Different mechanism, identical
failure: **the test was measuring something adjacent to the thing that could
break.**

---

## Proof

- **Platform:** `npm test` → **3,773 tests, 3,768 pass, 0 fail, 5 skipped**
  (the 5 are the documented Node-24 skips). `npm run lint` exit 0.
- **Admin:** `tests/ai-cost` → **367 passed, 0 failed** in five timezones.
  `npm run lint` exit 0. `run.sh` exits **2** on the Mac — the SQL half
  SKIPPED, which is not a pass.
- **Every new guard was proved to fail** by reintroducing the defect it exists
  to catch, then restored, with `git status` checked afterwards: the clobbering
  charge (5 of 8 tests red), a handler dropped off the TODO list without being
  done, a finished handler left on it, and the three lint false-greens.
- **The `enterWith`-inside-`run()` containment claim was measured**, not
  assumed: the outer store reads back unchanged after the `Promise.all`
  resolves.

**Not verified, and it cannot be from here:** nothing is deployed. What the
**By job** view will actually show depends on how many rows already carry a
`platform_feature` — `spendPlanTokens` has been setting it at 69 sites, but
several handlers spend *before* they charge, so coverage is partial and
unknown until the page is live. **That number is the thing to look at first
after deploying, because it sizes the remaining 101-handler job.**

---

## To push — Ryder, from Cursor

Two repos again. Admin first.

**1. `ai-syndicate-admin` — on `main`:**

```
cd ~/Documents/AI-Syndicate/ai-syndicate-admin
git add lib/ai-cost.js src/components/admin/AiCost.jsx tests/ai-cost/test.mjs \
        WORK-LOG/2026-09-08--internal--a-rate-limit-is-not-a-failure-and-a-dead-engine-is-not-a-lost-client.md \
        WORK-LOG/2026-09-08b--internal--the-cost-page-learns-what-the-money-bought.md
git commit -m "The cost page can say what the money bought"
git push origin main
```

The first work-log file is in that list on purpose — it has the "verified in
production" section appended to it and is currently uncommitted. Do **not**
`git add .`; that repo is full of scratch files.

**2. `ai-syndicate` — a branch off `origin/main`, never local `main`:**

```
cd ~/aisyndicate/ai-syndicate-live
git fetch origin
git checkout -b fix/ai-meter-attribution origin/main
git add lib/ai-meter.js lib/plan-tokens.js lib/ai-meter.context-fill.test.js \
        api/cron/brand-alerts.js api/cron/sentiment-alerts.js \
        scripts/check-ai-meter-context.mjs package.json
git commit -m "A charge must not rename the job it was charged for"
git push -u origin fix/ai-meter-attribution
```

Open the PR, wait for `CI / Lint` to go green, merge.

**3. No database change this time.** Nothing to run in Supabase.

**4. To check it worked:** open the AI Cost page, **Cmd+Shift+R** (that page
served a stale copy for 20 minutes on 7 Sep), and click the new **By job** tab.
Whatever appears there is the honest starting point — and the size of the
`— not labelled yet —` row is the size of the remaining work.

---

## What is still not fixed, in order

1. **101 handlers still unattributed.** The TODO list in
   `scripts/check-ai-meter-context.mjs` is the work queue, ordered. Start with
   the three that spend before they know the tenant.
2. **Three workspaces are spending money and are attached to no client**
   ($1.92), and **$9.16 across 1,313 calls arrived with no workspace at all.**
   The first is dropdowns on the cost page. The second is item 1.
3. **SerpApi, Perplexity and DeepSeek are unpriced** — they charge per search,
   not per token, and the price book has only per-token columns. Needs a
   `per_call_micros` column, plus one fact nobody has written down: which
   SerpApi plan we are on.
4. ⭐ **Zernio and SearchApi are not metered at all.** `lib/zernio.js` and
   `lib/social-reads.js` (`searchapi.io`) name no host in `PROVIDERS`, so the
   social crons spend real money that appears on no page and in no total. This
   was found while mapping the handlers and is not in any earlier record.
5. **Nothing has ever been checked against a provider's real bill.** Needs an
   Anthropic Admin key, which only an org owner can create — CJ or Andrew.
