# The price book, and the two model names that do not exist

**Date:** 2026-09-07 (evening — a second session; the morning one is
`2026-09-07--internal--streamed-answers-now-report-their-tokens.md`)
**Repo:** `ai-syndicate-admin`. Platform repo read only, nothing changed there.
**Status:** written, tested, **NOT pushed. Migration 0033 NOT run.**

---

## The 30-second version

The AI Cost page could not price nine of the ten models we call, so the "$1.53"
on it was the Anthropic bill, not the AI bill. I looked up every provider's
real published price in a browser and added the four that can be stored
honestly.

The other five stay blank on purpose, and two of those five are the more
interesting finding: **`openai/gpt-5.6` and `mistral/mistral-medium-3.5` are
not real model names.** Neither exists on its provider's own page. Between them
they are 106 of the 127 failed calls on that page. That was never a pricing
problem — we have been calling models that do not exist since whenever those
lines were written.

---

## What was measured, and when

Read off the live AI Cost page in a browser on the evening of 2026-09-07, last
30 days, "By model" grouping. **These numbers are roughly double the ones in
`DO-THIS-NEXT-ai-price-book-2026-09-07.md`, which was read earlier the same
day.** Neither is wrong — calls arrived in between. Both are dated for exactly
that reason.

| model | calls | failed | in | out | cached |
|---|---|---|---|---|---|
| anthropic/claude-sonnet-5 | 78 | 13 | 460k | 61k | — |
| mistral/mistral-medium-3.5 | 96 | **96** | 0 | 0 | — |
| serpapi/unknown | 25 | 2 | 0 | 0 | — |
| google/gemini-2.5-flash | 12 | — | 708 | 4.8k | 681 |
| openai/gpt-5.6 | 11 | **10** | 0 | 0 | — |
| openai/gpt-5.6-sol | 8 | — | 67k | 6.7k | 8.9k |
| groq/openai/gpt-oss-120b | 6 | **6** | 0 | 0 | — |
| perplexity/sonar | 6 | — | 78 | 2.4k | — |
| deepseek/deepseek-v4-flash | 6 | — | 576 | 8.6k | — |
| xai/grok-4.6 | 6 | — | 3.9k | 1.7k | 3.1k |

Page totals that day: 254 calls, 190 with no price, 127 failed, $1.53 metered.

---

## What was built

**`supabase/migrations/0033_ai_prices_non_anthropic.sql`** — four rows, each
carrying the URL of the page it was read from:

| provider / model | input | output | cache write | cache read |
|---|---|---|---|---|
| openai / gpt-5.6-sol | $4.00 | $20.00 | $5.00 | $0.40 |
| google / gemini-2.5-flash | $0.30 | $2.50 | — | $0.03 |
| xai / grok-4.6 | $2.00 | $6.00 | — | $0.50 |
| groq / openai/gpt-oss-120b | $0.15 | $0.60 | — | $0.075 |

All per 1M tokens, US dollars, stored as micro-dollars. `effective_from` is
**2026-09-07, not backdated** — see below.

**`tests/ai-prices/`** — test.mjs (70 checks, 5 timezones), sql.sh (real
Postgres), run.sh.

**`lib/ai-cost.js`** — one real bug fixed, found by the checker. See below.

**`tests/ai-cost/sql.sh`** — two assertions repaired that 0033 would have
turned red, plus two comments that were already stale.

---

## The five models left blank, and why each one

Every one of these would have been easy to fill in and wrong.

**perplexity/sonar.** Tokens are $1 in / $1 out — but Perplexity also bills a
search request fee of $5 / $8 / $12 per 1,000 requests by context size, and
that fee is the bigger half by roughly twenty to one at our volumes. A
token-only row would print a number about 5% of the truth and look complete.
Blocked on a per-call column. Separately, Perplexity's own page says Sonar chat
completions are supported only until **2026-09-27** — three weeks away.

**deepseek/deepseek-v4-flash.** DeepSeek charges two rates by the hour: peak is
01:00–04:00 and 06:00–10:00 UTC Monday–Friday, off-peak is everything else and
is exactly half. That is 35 of the 168 hours in a week. The table has one rate
per model per start date, so a peak row is 2x too high for 79% of the week and
an off-peak row is 2x too low for the other 21%. Blocked on a time-of-day
dimension.

**serpapi/unknown.** Billed per search, not per token — 25 calls, zero tokens.
`input_per_mtok` and `output_per_mtok` are `not null`, so there is no shape in
this table a per-call price can take. And the per-search cost depends on which
plan we are on ($25/1,000 up to $275/30,000), which is a fact about us that
nobody has written down. No overage rate is published at all.

**mistral/mistral-medium-3.5** and **openai/gpt-5.6.** Not real model ids. See
the next section.

---

## The finding: we are calling two models that do not exist

`mistral-medium-3.5` appears nowhere on Mistral's pricing page or model list.
The callable ids are `mistral-medium-latest` and `mistral-medium-3-5-26-04`.
It is failing **96 out of 96** calls.

`gpt-5.6` appears nowhere on OpenAI's pricing page. The ids that exist are
`gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-cyber`.
It is failing **10 of 11**.

**The proof it is the name and not the key** is sitting in the same table:
`openai/gpt-5.6-sol` made 8 calls on the same OpenAI key, through the same
endpoint, and failed **none** of them. One name works, the other does not.

Both are hardcoded fallbacks behind an environment variable, in four files in
the platform repo — `lib/brand-probe.js`, `lib/brand-sources.js`,
`lib/prompt-simulator.js`, `scripts/fingerprint-stability.mjs`. Every call site
reads `process.env.X || "<the dead name>"`, and `.env.example` has both
overrides commented out. So this is fixable **without touching code**, by
setting the variables in Vercel.

`OPENAI_RESPONSES_MODEL` is evidently already set to something that works —
that is where the gpt-5.6-sol rows come from — while `OPENAI_MODEL` is not.
That last sentence is an inference from which model ids appear, not something
read out of Vercel.

**groq/openai/gpt-oss-120b is 6 for 6 failed and its name is fine** — it is a
real Groq model id. The 29 Aug note already recorded Groq as an account-level
blocker, not a dead model. Nothing new here; it is priced anyway because the
rate is right whether or not the calls land.

That accounts for all 127 failures: 96 mistral + 10 openai + 6 groq = 112, plus
13 anthropic and 2 serpapi.

---

## The bug the checker found in code that already existed

`cacheSavingMicros()` in `lib/ai-cost.js` had no guard for a call that reported
no usage at all. It ran `normalizeUsage(null)` into an empty object, found no
cached tokens, and returned **0** — "the cache saved us nothing", stated as a
measurement, about a call that never told us its token counts.
`costMicros()` right beside it has had that guard from day one, with a long
comment about why 0 is the wrong answer.

**Be precise about the blast radius, because it is smaller than it looks.** The
one place that stores this value writes it as
`...(priced.savingMicros ? { cacheSavingMicros: … } : {})`, and `null` and `0`
are both falsy — so nothing different was ever written to the database and no
figure on the page moves. What was wrong was the function's answer, and the
next caller to treat 0 as a measurement would have inherited it. Fixed, with
three assertions including one that keeps a real zero a real zero.

---

## Why the rows are NOT backdated, and what that costs

0024 backdated Anthropic to 2026-01-01 so old rows would not sit in a price
gap. These do not, because what I read is what these models cost **today**, and
none of these providers publishes a price history. Backdating would assert that
the same rate applied in August, which nobody checked.

**The cost is real: every call made before today stays unpriced.** So running
0033 will move the AI Cost page less than it looks like it should — new calls
price from now on, the 30-day backlog does not. Changing `'2026-09-07'` to an
earlier date is a one-word edit, and the migration says in full what that would
be assuming.

---

## What the checker caught in MY work

A separate agent, told to assume everything was wrong, found 15 defects. The
ones worth carrying forward:

1. **The test's parser skipped rows it could not read, in silence.** It was one
   regex over the whole file. A row carrying an `effective_to` did not parse,
   so it never entered the list, so every "this model must stay unpriced" check
   passed by looking at a list the row was not in. **0033 explicitly tells the
   next person that a perplexity row "needs an effective_to"** — so the guard
   written to catch that exact change would have gone green on it. Rewritten to
   split into tuples and FAIL on any tuple it cannot read. Proved by adding
   that row to a copy and watching it go red.
2. **A skip was reading as a pass.** `tests/ai-cost/sql.sh` exits 0 when there
   is no Postgres, so `run.sh` prints "everything passed" with the entire
   database half unrun — which is the normal state on the Mac. The new sql.sh
   exits 2 and run.sh says so out loud.
3. **The five-timezone loop proved nothing.** Nothing in the first draft read a
   clock, so five identical runs compared a constant against itself. Added an
   assertion that goes through `priceCall()`, which calls `teamDate()`.
4. **A test asserted the wrong wire format.** The grok fixture used
   `cache_read_input_tokens` — Anthropic's field name. xAI is OpenAI-compatible
   and reports `prompt_tokens_details.cached_tokens`, a *subset* of the input
   that gets subtracted back out. Right total, wrong branch, live path untested.
5. **"0033 changes nothing" was a blocklist of verbs** that missed `grant`,
   `revoke` and `create or replace` while sitting under a header promising no
   grant is touched. Replaced with a positive assertion: exactly one statement,
   and it is an insert into that one table. On its first run it tore the file in
   half at a semicolon inside the grok row's own note — so the fix needed a
   quote-aware splitter, and the assertion found its own bug.
6. **Two `refused` inserts shared a key.** If the `rates_positive` constraint
   were dropped, the first insert would succeed and the second would be refused
   by the *unique index* instead — printing ok for the wrong reason and hiding
   the removal. Distinct keys now.
7. **A count in a comment was written, not counted.** "passed 27/27" against a
   file with 30 assertions. The number is gone; the script prints its own.
8. **My own edit to `tests/ai-cost/sql.sh` was weaker than what it replaced.**
   I deleted `count(distinct provider) = 1` — the assertion that nothing
   unexamined was in the price book — and put back a one-bit "some non-anthropic
   rows exist", which passes with 4 rows, 400 rows, or a garbage provider. Now
   an upper bound that names the five providers.
9. **The header overstated what the test can catch.** Two copies of the same
   numbers typed by the same person from the same reading catch a *later edit*,
   not a mistranscription on the day. The only defence against the original
   reading being wrong is the `source_url` and somebody opening it. Said so.

**One defect it raised was wrong**, and worth recording so the next reader does
not re-open it: it flagged every call count in 0033 as contradicting the
morning's handoff doc. They do contradict it — because they are a later reading
of the same page. Both are now dated in the file.

---

## Tests

- `tests/ai-prices/test.mjs` — **70 passed, 0 failed**, identical in all five
  timezones.
- `tests/ai-prices/sql.sh` — **everything passed, 0 failed**, real Postgres,
  all 33 migrations applied in order then 0033 applied a second time.
- `tests/ai-cost/` — **324 passed** (pure) and **everything passed** (SQL),
  after the two repaired assertions.
- `tests/cost-merge` 13, `tests/client-economics` 28, `tests/finance` 53 — all
  pass, unchanged.
- `npm run lint` clean.
- The database halves were run in the cloud container. **The Mac has no
  Postgres and skips them**, and now says so instead of printing "everything
  passed".

---

## Not done, and why

- **0033 has not been run.** It needs pasting into the Supabase editor.
- **Nothing is pushed.**
- **The per-call price column does not exist.** It is what perplexity and
  serpapi both need, and it is a real change: a new column, a change to
  `costMicros()` (which currently returns null for a call with no usage, and a
  per-call fee has to survive that), plus the AI Cost page. Not started
  deliberately — half of it would under-bill silently.
- **The streaming meter is not proven in production.** See the memory note for
  that day; the short version is that the meter's own status endpoint reports
  the path WORKING, a live Caite answer was sent, and no new row appeared on
  the console within four minutes. The counters that would name the reason are
  behind `AI_METER_STATUS_EMAILS`, which is unset.

---

# ADDENDUM — shipped, same evening

**Status changed from "written, not run" to: 0033 IS RUN, PR #2049 IS MERGED.**

## What shipped

- `0033_ai_prices_non_anthropic.sql` pasted into the Supabase SQL editor.
  "Success. No rows returned." The live price book now shows **13 rows**.
- The dead-model-name fix went out as **PR #2049**, merged as `3fb26ed` on
  `main` of `AISyndicateGEO/ai-syndicate`. Branch
  `fix/dead-model-name-defaults`. 8 checks green, one CodeQL still running,
  nothing red — and `CI / Lint` passing is the proof the new guard runs in CI.

## What the price book bought, measured on the live page

Anthropic went from 100% of the AI bill to 77.1%:

| model | calls | cost | before |
|---|---|---|---|
| anthropic/claude-sonnet-5 | 92 | $1.78 | $1.53 |
| openai/gpt-5.6-sol | 14 | **$0.51** | NOT PRICED |
| xai/grok-4.6 | 9 | **$0.01** | NOT PRICED |
| google/gemini-2.5-flash | 18 | **$0.0091** | NOT PRICED |

**OpenAI is 22% of the AI bill and was invisible before today.** "Saved by
caching" also moved from "not measured yet" to a real $0.03.

**A price row never repairs a call already logged** — the cost is frozen onto
the row at write time. Running the migration moved nothing already on the page,
by design. Say that out loud next time before somebody reads the flat number as
a failed migration.

## The env var was misspelled, and nothing said so

The first attempt set **`OPEN_AI_MODEL`**. Every call site reads
**`OPENAI_MODEL`**, and `OPEN_AI` appears nowhere in the platform repo — so the
variable did nothing and the code fell through to its dead default.

**A Vercel variable whose name no code reads looks, from every screen,
exactly like one that is working.** Grep the repo for the exact string before
believing a variable is wired up.

`OPENAI_RESPONSES_MODEL` was also needed and initially missed — there are two
separate OpenAI paths, each with its own variable and its own dead default.

Final: `OPENAI_MODEL=gpt-5.6-sol`, `OPENAI_RESPONSES_MODEL=gpt-5.6-sol`,
`MISTRAL_MODEL=mistral-medium-latest`, all Production on `ai-syndicate`.
**A variable only takes effect on a NEW deployment.**

## The code change, and its guard

12 fallbacks replaced across `lib/brand-probe.js`, `lib/brand-sources.js`,
`lib/prompt-simulator.js`, `scripts/fingerprint-stability.mjs` — only the
`|| "..."` strings, no comments, labels or logic. Plus
`scripts/check-model-defaults.mjs`, wired into `npm run lint`.

- Proved it can fail: dead name back in → exit 1 naming file and line;
  restored → green.
- It flagged its own header on the first run, because it has to name the dead
  ids to search for them. Same trap as the credential scanner on 2 Sep. Its own
  file is excluded by absolute path; the other 1,159 are still scanned.
- Lint clean. 3,682 tests, 3,677 pass, 0 fail under `--no-warnings`.

## Still open

- **The model fix is UNVERIFIED.** After the redeploy and the merge the AI Cost
  page is byte-identical — 348 calls, 263 unpriced, 183 failed, mistral still
  140 of 140. Nothing has called those providers since the deploy went live, so
  the counts are frozen. One Prompt simulator run settles it; that is real
  spend and was left as Ryder's call.
- `AI_METER_STATUS_EMAILS` still unset, so the streaming meter's miss counters
  are still redacted.
- No per-call price column, so perplexity, deepseek and serpapi stay unpriced.

## Two tool traps worth keeping

- **`git stash` silently did nothing** through the Mac mount — no error, empty
  `git stash list`, working tree unchanged. Check `git status` after any git
  command through the bridge. A stale `.git/index.lock` also has to be `mv`d
  aside; the mount cannot delete.
- **The admin console served a stale AI Cost page for ~20 minutes** across
  navigations, its own Refresh button and a plain reload — 254 calls when the
  truth was 348. Only Cmd+Shift+R cleared it.

---

# CORRECTIONS — a checker read this entry back against the sources

Appended, not rewritten. A separate agent was told to assume this entry was
false and found 16 things. The ones that change what a reader would do:

1. **The admin repo IS pushed.** The header says "NOT pushed. Migration 0033
   NOT run." Both are now false: 0033 ran in Supabase and Ryder pushed
   **`7f6fe75`** on `main`.

2. **"OpenAI is 22% of the AI bill" is wrong — it is 22% of PRICED spend.**
   263 of 348 calls are unpriced, and cost is frozen at write, so the
   non-Anthropic rows cover only post-migration calls while Anthropic is
   backdated to January. **OpenAI's real share is higher; 22% is a floor.**
   Separately, 77.1% is the page's SHARE column; the four printed costs
   recompute to 77.4%.

3. **The skip-is-not-a-pass claim was half true, and my own runner had the
   bug.** `tests/ai-cost/run.sh` was never fixed at the time. And
   `tests/ai-prices/run.sh` printed "THE DATABASE HALF DID NOT RUN" and then
   **exited 0** — the warning was for a human, every caller saw success. Both
   exit 2 on a skip now, and still exit 0 where Postgres exists. **A message is
   not an exit code.**

4. **`AI_METER_STATUS_EMAILS` probably will not answer it.** Those counters are
   per-lambda-instance and the endpoint's own comment says they are "almost
   always zeros and NOT evidence". Needs a warm instance, or Vercel logs.

5. **Smaller:** the guard fails `npm run lint`, not the build (`prebuild` does
   not run it); the 950-token figure is a chars÷4 estimate sitting under a
   "measured" heading; a Prompt simulator run fires **twelve** engines
   including Anthropic and SerpApi, not seven; "3,682 / 3,677 / 0 fail" was
   missing that the other **5 are skipped**; "all shaped `process.env.X || …`"
   is untrue of four of the twelve; and `lib/ai-cost.js`'s own comment
   contradicted this entry about the blast radius — the comment was wrong and
   is fixed.

6. **`c4ff484` / `3fb26ed` do not resolve in the local platform clone** — refs
   unfetched, `origin/main` far behind. Those SHAs came from GitHub in a
   browser. `git fetch` before quoting them from this machine.

**Follow-up commit outstanding** (fixes from this pass, made after `7f6fe75`):
`tests/ai-prices/run.sh`, `tests/ai-cost/run.sh`, `tests/ai-cost/sql.sh`,
`lib/ai-cost.js`, plus the two `DO-THIS-NEXT-*.md` files. Exact command in
`DO-THIS-NEXT-ai-price-book-2026-09-07-EVENING.md` §2.

---

# ⚠️ LATER THE SAME EVENING: HALF THIS ENTRY'S DIAGNOSIS IS WRONG

A sweep ran. The AI Cost page went 348 → **692 calls**, the first reading after
the corrected model names reached production, and it separates the two
providers:

| model | calls | failed |
|---|---|---|
| anthropic/claude-sonnet-5 | 127 | 29 |
| openai/gpt-5.6-sol | 40 | 10 |
| **openai/gpt-5.6** | **12** | 11 — **frozen, no longer called** |
| **mistral/mistral-medium-latest** | **188** | **188 — new name, still 100% failing** |
| mistral/mistral-medium-3.5 | 140 | 140 — frozen |
| groq/openai/gpt-oss-120b | 18 | 18 |

**OpenAI: right.** The dead name stopped being called and `gpt-5.6-sol` took
over. The control held.

**Mistral: WRONG.** The env var demonstrably took — the new row exists — and
`mistral-medium-latest`, a real documented id, fails 188 of 188. The name was
not the cause. It is the key or the account, like Groq.

**The reasoning error, stated plainly:** the gpt-5.6-sol control was evidence
about OpenAI and it was generalised to Mistral, where no control existed —
only an id that was absent from a docs page. "Not published" proves the id is
wrong. It does not prove the id is why the calls fail. One of those was
measured; the other was asserted, and Ryder was given the asserted one.

Next step is the key, not the name: run
`scripts/fingerprint-stability.mjs` in the platform repo — it already calls
`https://api.mistral.ai/v1/chat/completions` and prints what comes back.
401 = key, 403 = account or entitlement, 200 = the request body.

Also new and unexplained: `openai/gpt-5.6-sol` fails 10 of 40 now, against
0 of 14 this morning.
