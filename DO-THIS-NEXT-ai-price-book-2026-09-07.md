> **SUPERSEDED — 2026-09-07, evening. Do not work from this file.**
>
> The price book work it describes is DONE: migration `0033` is run, PR #2049
> is merged, and the AI Cost page prices four of the ten models.
>
> **Read `DO-THIS-NEXT-ai-price-book-2026-09-07-EVENING.md` instead.**
>
> TWO things in here are actively misleading now:
>
> 1. Its call counts (144 calls, 86 unpriced, $1.34) are the MORNING reading.
>    The same page read 254 by early evening and 348 later that day. Quoting
>    them as current is how a report ends up wrong.
> 2. It says **"PR #2048 … NOT yet merged"**. It was merged as `c4ff484`
>    before the evening session began. Do not go looking for an open PR.
>
> Kept as history, which is what it is.

---

# DO THIS NEXT — the price book is the last thing between us and a real AI cost figure

**Written:** 2026-09-07
**Previous doc:** `DO-THIS-NEXT-token-metering-2026-09-06.md` (token metering — done)

---

## Where things stand right now

**Done and live:**
- Finance page: all invented Stripe data deleted, measured AI cost reaches every
  total. Pushed and verified live at
  `https://ai-syndicate-admin.vercel.app/#/dashboard/finance` on 2026-09-07.
- Token metering: built, deployed, key mismatch fixed, real rows landing.

**Done, in review, NOT yet merged:**
- **PR #2048** on `AISyndicateGEO/ai-syndicate`, branch
  `feat/ai-local-ticks-endpoint` → `main`. Two commits:
  - `51f32c7` — Meter streamed answers (the SSE clone read)
  - `cd6916e` — Hoist the page-audit column memos above the early return
  - 4 files, +1,002 / −35.
  - At time of writing: **CI / Lint green, CI / Migrations replay green**,
    CI / Build and two CodeQL javascript jobs still running.
  - Note the branch name is left over from a different feature. The two commits
    in the PR are only the meter work — nothing else rode along.

---

## The blocker

Measuring tokens exactly produces no cost figure unless the model has a price.
**`ai_model_prices` contains Anthropic models only.**

Read live from the AI Cost page, last 30 days to 2026-09-07:

| provider/model | calls | failed | in | out | cached | priced? |
|---|---|---|---|---|---|---|
| anthropic/claude-sonnet-5 | 67 | 8 | 389k | 56k | — | **yes — $1.34** |
| mistral/mistral-medium-3.5 | 32 | **32** | 0 | 0 | — | no |
| serpapi/unknown | 17 | 1 | 0 | 0 | — | no |
| openai/gpt-5.6 | 7 | 6 | 0 | 0 | — | no |
| google/gemini-2.5-flash | 6 | — | 354 | 2.3k | — | no |
| groq/openai/gpt-oss-120b | 3 | 3 | 0 | 0 | — | no |
| perplexity/sonar | 3 | — | 39 | 1.4k | — | no |
| deepseek/deepseek-v4-flash | 3 | — | 288 | 4.2k | — | no |
| xai/grok-4.6 | 3 | — | 1.9k | 697 | 1.5k | no |
| openai/gpt-5.6-sol | 3 | — | 1.8k | 2.3k | — | no |

The page's own words: *"86 calls have no price. 17k tokens went through a model
with no row in the price book, so whatever they cost is not in any number on
this page."*

So **$1.34 is the Anthropic bill, not the AI bill.** Nine of ten models in use
are counted, their tokens counted, and their cost blank.

## What needs to happen

Add dated, **sourced** rows to `public.ai_model_prices` for those providers.
The table already has what is needed: `provider`, `model`, `effective_from`,
`input_per_mtok`, `output_per_mtok`, cache write/read columns, and a **source**
column that the UI renders as "where this came from".

Rules the existing rows already follow, and the new ones must:
- One row per model per start date; a call is priced with the row in force on
  the day it ran, and that price is frozen onto the call.
- **NULL means "not priced yet". It is never 0.** Zero is a real answer that
  means free. Migration `0024_ai_usage.sql` says this at the top.
- Anthropic's cache write and cache read are priced separately, and the
  5-minute and 1-hour cache writes are different rates.

**Every price must be looked up on the provider's own pricing page and cited in
the source column. Do not estimate.** A wrong price is worse than a blank one,
because a blank one admits what it does not know and a wrong one does not.

`serpapi` has no tokens at all — it is priced per call, so it needs whatever
shape the table supports for that (check `0024_ai_usage.sql` before assuming
the per-mtok columns fit).

## Separate thing worth looking at

**51 of 144 calls failed before the model reported anything**, and 32 of those
are `mistral/mistral-medium-3.5` failing **32 out of 32**. A model that fails
every single time is not a pricing problem. `groq/openai/gpt-oss-120b` is 3 for
3 failed and `openai/gpt-5.6` is 6 of 7. Worth finding out whether those keys
are wrong, those model names are wrong, or those providers are not meant to be
called at all.

## Also still open

- `ai-syndicate-live` cannot run `npm run build` from the Mac bridge VM:
  `node_modules` is installed for macOS and the VM is Linux, so rolldown's
  native binding is missing. It fails before reading any source. Build on the
  Mac, or let Vercel do it.
- `lib/social-creative.reader.test.js` fails under plain `node --test` on the
  Mac because Node 24's ExperimentalWarning lands in the test's own
  `console.error` capture. `--no-warnings` makes it pass. Environmental. Left
  alone deliberately — muting warnings to green a test is how real problems get
  hidden.
- Cache **writes** still show "not measured yet" on the AI Cost page. That
  should change once PR #2048 is merged and deployed, because the 5m/1h split
  comes out of the `message_start` frame that the streaming reader now reads.
  **Worth re-checking after deploy** — it is the cheapest proof the streaming
  meter is actually working in production.
