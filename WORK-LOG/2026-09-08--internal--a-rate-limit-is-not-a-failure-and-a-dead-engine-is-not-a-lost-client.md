# A rate limit is not a failure, and an engine that never answered is not a client the AI declined to name

**8 September 2026.** Internal. Two fixes, both ours, neither needing Andrew,
neither needing an account or a key. Both come from the same finding on 7 Sep:
`admin_usage_events.meta->>'http_status'` showed Mistral returning **429** on
both model names — rate limited, not broken — and Groq **403**.

**Nothing here is pushed.** Exact commands at the bottom. Ryder pushes from
Cursor; the Mac bridge has no network.

---

## The 30-second version

**Fix 2 — the AI Cost page called rate limits failures.** One column, "Failed",
counted three different things. On 7 Sep it read 398 while 384 of those were
Mistral being rate limited: a quota to raise, not an integration to fix, and
no screen could tell them apart. There are now four buckets and three columns.

**Fix 1 — an engine that never answered was recorded as "the AI did not
mention this client."** The Prompt Simulator divided by engines we *asked*, not
engines that *replied*. With 2 of 12 engines down, a client cited by 3 of the
10 that answered read as **3/12** — on their dashboard, in their PDF, in their
.xlsx, and in their compiled report. A false negative in a number a client
receives on paper. It now divides by the engines that answered, everywhere, and
says so on the page.

**No money was ever at stake.** 429s and 403s are not billed. The `$4.79` figure
is unaffected. This was two screens lying, not two bills.

---

## FIX 2 — `ai-syndicate-admin`

### What was wrong

`lib/ai-cost.js` `addEvent()`:

```js
if (status === "ok" || status === "legacy") t.ok += 1;
else t.failed += 1;
```

`capped` and `rejected` were both in the exported `STATUSES` and appeared
**nowhere** in the UI. The meter had recorded the difference correctly all
along; the page threw it away.

### What it is now

Four buckets, and each one says in words what it means:

| status | what it is | billed? |
|---|---|---|
| `ok` | the call worked | yes |
| `capped` | **stopped at a cap** — see the correction below | **it depends** |
| `rejected` | the AI answered and we discarded the answer | **yes** — tokens were generated |
| `failed` | timeout, dropped connection, or a provider error that was not a rate limit | cannot tell from the row |

`failed` narrowed from "anything not ok" to `status === "failed"`. The old
superset is on `finishTotals().notOk` so the next person asks for it by name
instead of reading `failed` and being wrong by 384 calls.

On screen: three figures instead of one ("Calls that errored" / "Stopped at a
cap" / "Answers thrown away"), three table columns (Errored / Capped / Thrown
away), a new "Rate limited" sort, and the drill row prints **"rate limited"**
only when a 429 is actually on the row and **"hit a cap"** otherwise.

### ⭐ THE CORRECTION THAT MATTERS — `capped` does NOT mean "rate limited" here

The first draft of this work put the words *"nothing was generated and nothing
was billed"* on the capped figure, and wrote a test that enforced them.

**That is true of a provider rate limit and false of the other thing that lands
in `capped`.** `lib/ai-agent.js` sets `cappedOut` when the agent runs out of
rounds, and `api/ai-chat.js`, `api/console-report.js` and `api/rep-report.js`
all record that as `capped` **with the usage it accrued**. A conversation is
several separately billed requests, so a cappedOut row is among the most
expensive calls in the system — and the page was about to declare its spend to
be zero, on a screen whose whole job is money. Worse than the mislabelling it
replaced.

Found by an adversarial checker. The copy now names both caps, claims neither
billing outcome, and points the reader at the Cost column — which is the only
thing on the row that knows.

### Smaller, all found by the same pass

- The "calls that reported no token counts" sentence used to assert that rate
  limits were the most common cause. That was hardcoded prose, true for one
  window on 7 Sep and false the moment Mistral's quota is raised. It now
  **computes** the breakdown (`calc.blindBy`), including a bucket for the
  successful-but-unmeasured platform rows (the SerpApi searches behind every AI
  Local edition), which the old wording had also described wrongly.
- "Spent on rejects" is now "Spent on attempts that produced nothing." It was
  always the superset, and `rejected` now names one specific status two blocks
  up the same page. Two meanings for one word on one page is exactly how the
  old "Failed" column hid 384 rate limits.
- `.adm-aic-state.warn` was used by the `legacy` badge and had **never been
  defined**, so legacy rendered in the body colour. Defined now.

### Tests

`tests/ai-cost/test.mjs` gained section 7. **353 passed, 0 failed** in all five
timezones. The SQL half exits 2 on the Mac (no Postgres) — it was run in the
cloud container against real Postgres 16, all 33 migrations in order:
**everything passed, exit 0.**

---

## FIX 1 — `ai-syndicate-live`

### What was wrong

`lib/prompt-simulator.js` returned, on any engine error,
`{ cited:false, linked:false, mentioned:false, mentions:0 }` — **the identical
shape to an engine that answered and did not name the client.** The numerators
were honest, because a failed engine contributes 0. The denominator was the
whole problem: `src/components/dash/Simulator.jsx` measured coverage against
`summary.total` (engines attempted).

`summary.answered` already existed and was already correct. It had been correct
for months while three screens went on dividing by `total`.

### What it is now

**One source of truth: `src/lib/simulatorDenominator.js`.** The dashboard, the
client export and the compiled client report each had their own hand-written
copy of this arithmetic, and the copies had drifted. Two client-facing
documents printing different numbers for the same run is worse than both being
wrong together.

It keeps three states apart, and this is the whole design:

- **a number** — we know how many engines replied. Divide by it.
- **`0`** — we asked and not one replied. **UNMEASURED, not 0%.** Nothing is
  scored, coloured, plotted or ranked from it; the score prints "not measured".
- **`null`** — a row from before we recorded `answered`. Falls back to `total`
  and prints a `*`, explained in a footnote.

`lib/prompt-simulator.js` now states `answered: true/false` on every per-engine
result at all four construction sites, so nothing has to infer it from
`response !== ""` — which most consumers simply did not.

Changed: the game-plan gate and headline, the tracked-prompt chip and its
colour and its sort key, the run-history rows and trend line, the by-engine
quick view, `RunStatusBar`, the PDF and XLSX score column, and the compiled
client report's per-prompt table, weekly trend and headline citation rate.
`trendFor` and `Sparkline` now **drop** unmeasurable runs instead of plotting
them as 0 — plotting them drew a cliff on a client's chart on a day nothing was
measured.

### The fix stopped at the database, twice

Migration `0103` added `answered` to `tracked_prompt_runs` in the platform. It
was **written and read by almost nobody**:

1. `api/tracked-prompts.js` dropped it on three of its four read paths, so the
   fallback ladder already in the page was dead code against every stored run.
   All four now carry it, each with a degrade ladder.
2. `tracked_prompts` — the snapshot table the Simulator actually reads — had no
   such column at all, so `api/tracked-prompts.js` dropped `summary.answered`
   on the floor at write time. **New migration `0138`.**

### ⭐ THE WORST BUG IN THIS SESSION WAS MINE, AND IT WAS ONE LINE

```js
const a = Number(run?.answered);          // Number(null) === 0
return Number.isFinite(a) && a >= 0 ? a : null;
```

**`Number(null)` is `0`.** Finite, `>= 0`. And every producer in this system
emits an *explicit null* for "we never recorded it" — all four API read paths,
`loadAllPayloads`, `report-compile.js`, and the page's own fallback summary.
Only a genuinely absent key took the intended path.

So the module written to stop "unknown" collapsing into "none" collapsed
"unknown" into "none", in its first function. With 0138 not yet applied —
which is the state right now — the effect would have been: **every** score chip
"not measured" in grey, **every** sparkline and trend line gone, and **every**
line of the client PDF reading "not measured" under a tooltip asserting we
asked twelve engines and none of them answered. A worse lie than the one being
fixed.

Found by the second checker. `answeredOf()` now tests the value before coercing
it, and rejects `null`, `undefined`, `""`, booleans, arrays and objects.

**The rule: `Number()` is not a type check. Test the value, then coerce it.**

---

## What was NOT fixed, and why

**About forty other files still divide `cited` by `total`.** They were mapped
deliberately, not missed. The list includes `lib/v1-api.js` (the **public API's
citation rate**, which paying integrators consume), `lib/search-console.js`,
`src/lib/aiRank.js` (a fully-failed run scores **0/100, not null**),
`src/components/dash/Tracker.jsx`, `WarRoom.jsx`, `Overview.jsx`,
`Competitors.jsx`, `Displacement.jsx`, `src/lib/citationIntel.js` (one engine
failing flips a battle to "at-risk"), `api/cron/intel-sweep.js`,
`lib/renewal-forecast.js`, `lib/content-proof.js`, `lib/social-ai-impact.js`,
`lib/social-autopilot.js`, `lib/markets.js` and `lib/goal-recommend.js`.

**This creates a real inconsistency and it should be said out loud:** before
this change all of those screens agreed with each other and were all wrong
together. Now the Simulator page, its exports and the compiled client report are
right and the rest are not, so two screens can print different numbers for the
same prompt. That is a net improvement on the documents a client receives and a
net regression in internal consistency, and the second half is not finished
until that list is worked through. **It is the next task, not an oversight.**

Also untouched: `tracked_prompts` has no `answered` column until 0138 is
applied, so `Tracker`, `WarRoom`, `Competitors` and `Displacement` are
structurally unable to use it even after this.

---

## How it was checked

Two adversarial checker agents, each told to assume the work was wrong and to
report only defects.

- **First pass: 11 defects.** Including the `capped` billing claim above, and
  `denomOf` returning `total` when `answered === 0` — which reintroduced the
  exact bug, directly under a comment claiming it did not.
- **Second pass, over the corrections: 9 more.** Including the `Number(null)`
  bug, the compiled report printing "Cited 3 / Engines that answered 0", and
  three test guards that **survived a complete revert of the fix**.

### ⭐ The lesson: a guard that reads source text is checking spelling

`src/lib/simulatorDenominator.test.js` shipped its first version as seven
`readFileSync` + regex assertions. A checker replaced `denomOf`'s body with
`return total` — a one-line, complete undo of the entire fix — and **all seven
stayed green**, because they asserted that the *string* `denomOf(summary)`
appeared, never that `denomOf` computed anything.

Three more slipped past in the same way:

- the gate was reverted to `summary.total * 0.30` and the negative regex,
  anchored on the literal `* 0.3)`, let `0.30)` through;
- `scoreFootnote()` was made to return `""` — no footnote in the client's PDF
  or XLSX at all — and the guard, which only checked the identifier appeared,
  passed;
- the entire "Capped" table column was deleted from the admin page and
  `tests/ai-cost` stayed at 352/352, because `r.capped` also appears in the
  sorts array.

All four now go red, proved by breaking and restoring each one. The arithmetic
was moved out of the JSX into a module so it could be tested for real, and the
source-reading assertions were demoted to a second line that checks the call
sites were not left behind. **Every negative guard was paired with a positive
one:** a list of forbidden spellings loses to a reformat.

One more: the assertion `answered + failed === total` was **tautological** —
the file defines `failed = total - answered` — and was replaced with a count
taken independently off the results array.

---

## Proof

- **Platform:** `npm test` → **3,765 tests, 3,760 pass, 0 fail, 5 skipped**
  (the 5 are the documented Node-24 skips). `npm run lint` exit 0.
- **Admin:** `tests/ai-cost` → **353 passed, 0 failed** in five timezones.
  `npm run lint` exit 0. `run.sh` exits **2** on the Mac — that is the SQL half
  SKIPPED, which is not a pass.
- **The SQL half was run in the cloud container** on real Postgres 16, all 33
  migrations in order, 0024 applied twice: **"everything passed", exit 0.**
- **Migration 0138 was run against real Postgres 16**, twice (idempotent), over
  seven deliberately awkward rows. Results: `summary.answered` used when
  numeric; prose counted when absent; a row with `answered: "lots"` falls
  through instead of aborting; a non-object inside `results` is skipped; rows
  with no readable payload stay **NULL**; and a genuine `answered: 0` is stored
  as **0, not NULL**.
- **The unguarded 0103-style cast was proved to abort** on that same row:
  `ERROR: invalid input syntax for type integer: "lots"`. That is why 0138's
  cast is guarded with `~ '^[0-9]+$'` — a deliberate difference from 0103,
  written into the file.
- Every new guard was proved to FAIL by reintroducing the defect it exists to
  catch, then restored; `git status` verified unchanged afterwards.

**Not verified, and it cannot be from here:** nothing has been run in
production. The numbers on the live AI Cost page and in a live Prompt Simulator
run are unchanged until this is deployed, and a simulator run fires **twelve**
engines and costs real money.

---

## To push — Ryder, from Cursor

Two repos, two separate commits. `git` through the Mac bridge leaves
`.git/index.lock` behind; one was moved aside during this session as
`.git/index.lock.stale-2026-09-08`. If Cursor complains about a lock, delete
that file. **`git stash` silently does nothing through the bridge** — check
`git status` after any git command.

**1. `ai-syndicate-admin` — on `main`:**

```
cd ~/Documents/AI-Syndicate/ai-syndicate-admin
git add lib/ai-cost.js src/components/admin/AiCost.jsx src/admin.css \
        tests/ai-cost/test.mjs \
        WORK-LOG/2026-09-08--internal--a-rate-limit-is-not-a-failure-and-a-dead-engine-is-not-a-lost-client.md
git commit -m "A rate limit is not a failure, and a capped call is not free"
git push origin main
```

Do **not** `git add .` — there are dozens of untracked scratch files and a
`_to_delete/` folder sitting in that repo.

**2. `ai-syndicate` (the platform) — on a branch, cut from `origin/main`, never
local `main`:**

```
cd ~/aisyndicate/ai-syndicate-live
git fetch origin
git checkout -b fix/simulator-answered-denominator origin/main
git add lib/prompt-simulator.js lib/report-compile.js lib/caite-signals.js \
        api/tracked-prompts.js \
        src/components/dash/Simulator.jsx \
        src/lib/simulatorDenominator.js src/lib/simulatorDenominator.test.js \
        src/lib/promptSimulatorClient.js src/lib/simulatorExport.js src/lib/reportExport.js \
        lib/prompt-simulator-answered.test.js \
        supabase/migrations/0138_tracked_prompts_answered.sql
git commit -m "An engine that never answered is not a client the AI declined to name"
git push -u origin fix/simulator-answered-denominator
```

Then open the PR and wait for `CI / Lint` to go green.

**3. AFTER the PR merges — apply `0138` by hand.** Paste
`supabase/migrations/0138_tracked_prompts_answered.sql` into the Supabase SQL
editor and run it. Until then the code degrades on purpose: the API drops the
column, `answered` reads as unknown, and scores print `3/12*` with a footnote —
the old number, marked as the old number. Deploy order does not matter.

**4. To verify it actually worked**, which nothing above does:
- AI Cost page: **Cmd+Shift+R** (that page served a stale copy for 20 minutes on
  7 Sep across navigations and its own Refresh button). The Mistral rows should
  move out of "Calls that errored" and into "Stopped at a cap".
- Prompt Simulator: one run, on one prompt. It fires twelve engines and costs
  real money — this platform burned $1,000 of credits in three days on 2 Sep —
  so run one, not a sweep.

---

## Still open, and NOT for a session to decide

**Do we tell clients we cover Mistral and Meta AI?** CJ's and Ryder's call. If
yes, it is one batched ask to Andrew — Mistral quota, Groq entitlement. If no,
switch both engines off rather than keep firing hundreds of guaranteed-rejected
requests a day. Nothing above needs Andrew.

And the forty-file list under "What was NOT fixed" is the next real task.
