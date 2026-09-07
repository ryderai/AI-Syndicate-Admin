# DO THIS NEXT — one scan proves the model fix, and the admin repo is unpushed

**Written:** 2026-09-07, evening
**Supersedes:** `DO-THIS-NEXT-ai-price-book-2026-09-07.md` (marked at its top).
Its call counts (144 calls, 86 unpriced, $1.34) are the MORNING reading. The
same page read 254 by early evening and 348 later the same day. Do not quote
them as current — and note the three readings are of the same 30-day window,
just hours apart.
**Full record:** `WORK-LOG/2026-09-07b--internal--the-price-book-and-the-two-model-names-that-do-not-exist.md`
and `memory/price-book-and-two-dead-model-names_2026-09-07.md` (read the
addendum at the bottom of each — that is what actually shipped).

---

## Where things stand

**Done, live, and measured:**

- **Migration `0033` IS RUN.** The price book on the live AI Cost page shows 13
  rows: the nine Anthropic ones plus `google/gemini-2.5-flash`,
  `groq/openai/gpt-oss-120b`, `openai/gpt-5.6-sol` and `xai/grok-4.6`, all
  dated 2026-09-07, each with the page it was read from.
- **PR #2049 IS MERGED** — `3fb26ed` on `main` of `AISyndicateGEO/ai-syndicate`.
  The dead model-name defaults are gone and `npm run lint` now fails if either
  comes back.
- **The AI bill stopped being an Anthropic bill.** The page's own SHARE column
  went Anthropic 100% → 77.1%, with `openai/gpt-5.6-sol` at **$0.51**.
  "Saved by caching" went from "not measured yet" to a real $0.03.

  **Read that share honestly. 22% is a share of PRICED spend, not of the AI
  bill.** 263 of 348 calls are still unpriced, and because cost is frozen at
  write, the non-Anthropic rows only cover calls made after 0033 ran while
  Anthropic is backdated to 2026-01-01 by 0024 and priced for the whole 30
  days. So OpenAI's real share of the bill is HIGHER than 22% — this is a
  floor. (Recomputing from the four costs gives 77.4% / 22.2%; the page prints
  77.1%. Quote the page or quote the arithmetic, not a blend.)

**Environment, all Production on the `ai-syndicate` Vercel project:**
`OPENAI_MODEL=gpt-5.6-sol` · `OPENAI_RESPONSES_MODEL=gpt-5.6-sol` ·
`MISTRAL_MODEL=mistral-medium-latest`

---

## 1. THE ONE THING THAT IS NOT PROVEN

**The model-name fix has never been observed working.**

After the redeploy AND the merge, the AI Cost page is byte-identical: 348
calls, 263 unpriced, 183 failed, `mistral/mistral-medium-3.5` still 140 of 140
failed. **That is not the fix failing.** Nothing has called those providers
since the deploy went live, so the counts are frozen.

**To settle it:** open the platform dashboard → **Prompt simulator** (or
**Run prompts →** on Overview) and run one. That fires live calls to TWELVE engines, not
the seven providers you might expect: OpenAI, Mistral, Groq, xAI, DeepSeek,
Perplexity and Gemini, **plus Anthropic and SerpApi** (Claude, AI Overviews,
Copilot, Siri and Alexa are built on those two). Anthropic and SerpApi are the
two heaviest users on the cost page, so budget for them. Wait a minute,
then reload the AI Cost page (**Cmd+Shift+R** — see the caching note below) and
open **By model**.

**What success looks like:** a new row `mistral/mistral-medium-latest` with
failures at or near zero, and `openai/gpt-5.6` stops growing. The old
`mistral-medium-3.5` row does not disappear — it is history, and it will age
out of the 30-day window on its own.

This was left undone deliberately: a scan is real money, and this platform
burned $1,000 of credits in three days on 2 Sep. It is Ryder's call, not a
session's.

## 2. THE ADMIN REPO IS PUSHED — corrected

**An earlier version of this file said it was unpushed and gave a `git add`
block. That was wrong, and following it would have produced a branch containing
two markdown files under a commit message about pricing.**

Ryder committed and pushed it as **`7f6fe75` on `main`** — "The price book
learns four more models, and names the two that do not exist". Tracked and
pushed: `supabase/migrations/0033_ai_prices_non_anthropic.sql`,
`tests/ai-prices/`, `lib/ai-cost.js`, `tests/ai-cost/sql.sh` and the work-log
entry including its addendum. `git status` shows no modified tracked files as
of that commit.

**There IS a small follow-up commit to make.** After `7f6fe75`, a checker pass
found four more things and they are fixed but not committed:

- `tests/ai-prices/run.sh` — **it printed "THE DATABASE HALF DID NOT RUN" and
  then exited 0.** So the warning reached a human reading the terminal and
  every script, CI step and `&&` chain saw success. That is the exact defect
  this suite exists to close, one level up. It exits 2 on a skip now.
- `tests/ai-cost/sql.sh` + `run.sh` — same fix. That suite had been printing
  "everything passed" on the Mac with its whole database half unrun, and an
  earlier note claimed this was already fixed when only the new suite was.
- `lib/ai-cost.js` — the comment on the `cacheSavingMicros` fix claimed the
  bogus zero "went into the 'What caching saved' total". It did not; the single
  caller drops both 0 and null. The comment now says so.
- the two `DO-THIS-NEXT-*.md` files, still untracked.

Verified after the change: both suites exit **2** on the Mac (skip) and still
print "everything passed" and exit **0** in the cloud container where Postgres
exists. `npm run lint` clean, `tests/ai-prices` 70/0.

```
cd ~/Documents/AI-Syndicate/ai-syndicate-admin
git add tests/ai-prices/run.sh tests/ai-cost/run.sh tests/ai-cost/sql.sh lib/ai-cost.js \
        DO-THIS-NEXT-ai-price-book-2026-09-07.md DO-THIS-NEXT-ai-price-book-2026-09-07-EVENING.md
git commit -m "A skipped database half is not a pass, and it must not exit 0"
git push
```

Paths listed explicitly, never `git add -A` — that folder has a dozen loose
`COMMIT-MSG-*.txt` files untracked, and an untracked prompt file in a client
folder was one `git add -A` from being a public page on 2 Sep.

## 3. `AI_METER_STATUS_EMAILS` IS STILL UNSET

The streaming meter reports `WORKING` from `/api/ai-meter-status`, but a live
Caite answer produced no row in the console over four minutes and a hard
reload. The counters that would name the reason — including a `streamLate`
miss counter, which is exactly the "the row was not ready when the flush ran"
case — are redacted unless the caller's email is listed.

Vercel → `ai-syndicate` → Settings → Environment Variables → Add:
`AI_METER_STATUS_EMAILS` = `ryder@aisyndicate.com`, Production. **Then
redeploy** — a variable only takes effect on a new deployment.

Then, from the dashboard tab, call the endpoint with a bearer token (a plain
same-origin `fetch` returns 401 — it wants the Supabase `access_token` out of
`localStorage`, not cookies).

**TEMPER THE EXPECTATION, because the endpoint says so itself.** Those counters
are per-lambda-instance: *"A serverless invocation is a fresh module, so these
are almost always zeros and are NOT evidence that nothing has been sent."* A
cold instance will hand back `streamLate: 0` and prove nothing. To get a real
reading you have to hit a WARM instance — send Caite a message and call the
status endpoint immediately after, repeatedly, and hope to land on the same
container. If that does not produce a number, this is the wrong instrument and
the answer has to come from Vercel's runtime logs instead.

## 4. THE PER-CALL PRICE COLUMN

Five of the ten models are still unpriced, and three of them are blocked on the
same missing thing. **Do not add a token-only row for any of them** —
`tests/ai-prices/` goes red if you do, and the reason is in `0033`'s own
comments.

- **perplexity/sonar** — the $5/$8/$12 per 1,000 requests search fee is the
  bigger half by roughly 20:1. A token-only row prints ~5% of the truth. Also:
  Perplexity's page says Sonar chat completions are supported only until
  **2026-09-27**, so any row needs an `effective_to`.
- **serpapi** — per search, zero tokens, and the per-search cost depends on
  which plan we are on ($25/1,000 … $275/30,000). Nobody has written down our
  plan. That is a fact about us, not about SerpApi.
- **deepseek** — two rates by the hour (peak 01:00–04:00 and 06:00–10:00 UTC
  Mon–Fri, off-peak exactly half). Needs a time dimension, not a column.

The work is: a `per_call_micros` column, a change to `costMicros()` (which
returns null when a call reports no usage — a flat fee has to survive that),
and the AI Cost page. Half of it under-bills silently, which is why it was not
started.

---

## Four traps that cost time today

- **A price row never repairs a call already logged.** Cost is frozen onto the
  row at write time. Expect a price migration to look like it did nothing.
- **A Vercel variable whose name no code reads is indistinguishable, from every
  screen, from one that is working.** `OPEN_AI_MODEL` sat there doing nothing
  while the code read `OPENAI_MODEL`. Grep the repo for the exact string.
- **The admin console served a stale AI Cost page for ~20 minutes** across
  navigations, its own Refresh button and a plain reload — 254 calls when the
  truth was 348. Only **Cmd+Shift+R** cleared it. Two readings of "the live
  page" that disagree are a cache, not a contradiction in the data.
- **`git stash` through the Mac mount silently did nothing** — no error, empty
  `git stash list`, working tree unchanged. Check `git status` after any git
  command run through the bridge. A stale `.git/index.lock` also has to be
  `mv`d aside; the mount cannot delete.
