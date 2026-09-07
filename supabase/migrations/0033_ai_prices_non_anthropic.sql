-- ============================================================
-- 0033 — PRICES FOR THE MODELS THAT ARE NOT ANTHROPIC.  7 Sep 2026
-- ============================================================
-- Additive. Inserts rows only. Safe to run twice (on conflict do nothing).
-- No table, column, index, policy or grant is touched.
--
-- WHY THIS EXISTS
--
-- 0024 seeded Anthropic and nothing else, on purpose: nothing else was being
-- called. That changed. On 7 Sep 2026 the AI Cost page read, live, over the
-- last 30 days: 254 calls across ten models, and 190 of them with no price.
-- The $1.53 on that page was the Anthropic share, not the AI bill.
--
-- EVERY COUNT IN THIS FILE COMES FROM THAT ONE READING, taken off the live
-- page in a browser on the evening of 7 Sep 2026 with the "By model" grouping
-- open. It is deliberately dated because it does NOT agree with the table in
-- DO-THIS-NEXT-ai-price-book-2026-09-07.md, which was read earlier the same
-- day and shows roughly half of everything (144 calls, 86 unpriced, $1.34).
-- Neither is wrong; calls kept arriving between the two readings. If a third
-- reading disagrees with both, that is expected and not a defect — what must
-- never happen is a count in this file being quoted as current without a date
-- attached to it.
--
-- Every rate below was read on 7 Sep 2026 in a real browser on the provider's
-- own pricing page — not from a summary, not from memory, not from a fetcher
-- that flattens a wide table. That distinction is not pedantry. A text
-- fetcher misread the Gemini cache cell as $0.075 on one pass and $0.30 on
-- another; the page itself says $0.03. The browser is the source of record
-- and the source_url column carries the page.
--
-- ============================================================
-- WHAT IS DELIBERATELY NOT IN HERE, AND WHY
-- ============================================================
-- FIVE of the ten models get no row here, and each is a deliberate refusal
-- rather than an oversight, because this table's whole contract is that NULL
-- means "not priced yet" and a wrong number is worse than a blank one.
-- (A sixth model, anthropic/claude-sonnet-5, also gets no row in this file —
-- but only because 0024 already priced it. That one is not a refusal, and an
-- earlier draft of this comment counted it as one.)
--
--   perplexity/sonar   — SKIPPED. The token rate is $1 in / $1 out, but
--       Perplexity also bills a SEARCH REQUEST FEE, priced per 1,000 requests
--       at $5 / $8 / $12 depending on search context size, and that fee is the
--       bigger half by a long way: our 6 calls used 78 input + 2.4k output
--       tokens (~$0.0025) against roughly $0.03-$0.07 of request fees. A
--       token-only row would print a confident number about a twentieth of the
--       truth. This table has no per-call column. Blocked on that column, not
--       on the price.
--       Also: Perplexity's own page says Sonar chat completions are supported
--       only until 2026-09-27, so any row added here needs an effective_to.
--
--   deepseek/deepseek-v4-flash — SKIPPED. DeepSeek charges two different
--       rates by the hour of the call: peak is 01:00-04:00 and 06:00-10:00
--       UTC Monday-Friday, off-peak is everything else and is exactly half.
--       That is 35 of the 168 hours in a week at peak. This table has one rate
--       per model per start date and no hour dimension, so a peak row
--       overstates by 2x for 79% of the week and an off-peak row understates
--       by 2x for the other 21%. Both are wrong often enough to matter.
--       Blocked on a time-of-day dimension.
--
--   serpapi/unknown    — SKIPPED. Billed per SEARCH, not per token: 25 calls
--       and zero tokens. input_per_mtok and output_per_mtok are `not null`, so
--       there is no shape in this table a per-call price can take. The plan
--       tiers are $25/1,000, $75/5,000, $150/15,000, $275/30,000, and no
--       per-search overage rate is published — so even the per-search figure
--       depends on which plan we are on, which is a fact about us and not
--       about SerpApi. Blocked on a per-call column AND on knowing our plan.
--
--   mistral/mistral-medium-3.5 — NOT A REAL MODEL ID. It does not appear
--       anywhere on Mistral's pricing page or model list. The callable ids are
--       `mistral-medium-latest` and `mistral-medium-3-5-26-04`, at $1.50 in /
--       $7.50 out. This model is failing 96 out of 96 calls. It is not a
--       pricing problem and pricing a name that cannot be called would only
--       hide it. Fix the id in lib/brand-probe.js, lib/brand-sources.js,
--       lib/prompt-simulator.js and scripts/fingerprint-stability.mjs in the
--       platform repo, then add the row.
--
--   openai/gpt-5.6     — NOT A REAL MODEL ID either. OpenAI's pricing page
--       lists gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna and
--       gpt-5.6-cyber. There is no bare `gpt-5.6`. It is failing 10 of 11
--       calls. Same fix, same four files.
--
--   groq is priced below even though it is failing 6 of 6 calls, because
--       `openai/gpt-oss-120b` IS a real Groq model id — whatever is wrong
--       there is not the name, and the rate is right either way.
--
-- ============================================================
-- effective_from IS TODAY, NOT BACKDATED, AND THAT IS A CHOICE
-- ============================================================
-- 0024 backdated Anthropic to 2026-01-01 so old rows would not sit in a gap.
-- These rows do not do that, because what was read is what these models cost
-- TODAY and no provider here publishes a price history. Backdating would
-- assert that the same rate applied in August, which nobody checked.
--
-- The cost of that choice is real and worth saying out loud: the calls already
-- in the table from before today stay UNPRICED. If that trade is not wanted,
-- change '2026-09-07' to an earlier date in one edit — but understand that
-- doing so prices August calls at September rates on an assumption, and this
-- comment is the only place that would ever say so.
--
-- ============================================================
-- MICRO-DOLLARS PER MILLION TOKENS, AS WHOLE NUMBERS
-- ============================================================
--   $4.00 / Mtok -> 4000000        $0.30 / Mtok ->  300000
--   $0.075 / Mtok -> 75000         $0.03 / Mtok ->   30000
--
-- A NULL cache column means the provider has no such charge in this shape.
-- lib/ai-cost.js returns null — unpriced, not free — for any call that USED
-- those tokens against a null rate, which is the correct failure.

insert into public.ai_model_prices
  (provider, model, effective_from, input_per_mtok, output_per_mtok,
   cache_write_per_mtok, cache_write_1h_per_mtok, cache_read_per_mtok,
   source_url, note)
values

  -- OPENAI · gpt-5.6-sol
  -- Standard service tier, SHORT context. Read in-browser 7 Sep 2026: the page
  -- has four tier tabs (Standard / Batch / Flex / Fast mode) and Batch and Flex
  -- show HALF these numbers for the same model, so a row taken off the wrong
  -- tab would be exactly 2x wrong and look completely plausible.
  -- The table's own column headers, left to right, are: Model | Input |
  -- Cached input | Cache writes | Output, twice over (short then long). The
  -- short-context row for gpt-5.6-sol reads $4.00 | $0.40 | $5.00 | $20.00.
  -- The $5.00 cache-write figure is READ OFF THAT COLUMN, not derived — worth
  -- saying because it happens to be 1.25x the input rate, which is the same
  -- ratio Anthropic uses in 0024, and a number that looks derived invites
  -- somebody to assume it was.
  -- LONG context is double ($8.00 / $0.80 / $10.00 / $30.00). This row is the
  -- short-context rate. Our 8 calls averaged ~8.4k input tokens, nowhere near
  -- the long-context threshold, so short is right today — but a call that ever
  -- crosses it is priced at half what it cost, and nothing on screen would say.
  -- OpenAI has no 1-hour cache tier, so cache_write_1h is null.
  -- Two dated things on the same page: "GPT-5.6 Sol's promotional pricing is
  -- available at least through November 21, 2026", and regional-processing
  -- (data residency) endpoints carry a 10% uplift that this row does not model.
  ('openai','gpt-5.6-sol','2026-09-07', 4000000, 20000000, 5000000, null, 400000,
   'https://developers.openai.com/api/docs/pricing',
   'read in-browser 7 Sep 2026 — Standard tier, short context. Long context is 2x. Promo rate at least to 21 Nov 2026. +10% for regional processing, not modelled.'),

  -- GOOGLE · gemini-2.5-flash
  -- Paid tier, per 1M tokens. Read in-browser 7 Sep 2026 off the model's own
  -- table: input $0.30 (text / image / video), output $2.50 "(including
  -- thinking tokens)", context caching $0.03 (text / image / video).
  -- AUDIO IS A DIFFERENT RATE — $1.00 in, $0.10 cached — and this row is the
  -- text rate. No audio call site was found in the platform repo, but that was
  -- a grep, not an audit: if audio ever goes to Gemini, this row underprices
  -- its input by 3.3x and nothing on screen would say so.
  -- Google's cache charge is a STORAGE price, $1.00 per 1M tokens per hour,
  -- not a per-token write. There is no honest place for an hourly rate in a
  -- per-token column, so both cache_write columns are null.
  -- BE CLEAR ABOUT WHAT THAT DOES AND DOES NOT BUY. The null protects us if a
  -- Gemini call ever arrives carrying our own cache_write_tokens column — that
  -- call comes out unpriced rather than free. It does NOT protect us on the
  -- live path, because lib/ai-cost.js normalizeUsage() maps Google's only
  -- cache field (cachedContentTokenCount) to a cache READ, and no Gemini
  -- response field maps to a write at all. So context-cache STORAGE on Gemini
  -- is not unpriced — it is INVISIBLE, and it is not in any number on the AI
  -- Cost page. Small today (12 calls, 681 cached tokens) and worth revisiting
  -- before anything leans on Gemini caching.
  -- Gemini 2.5 Flash is a legacy model on that page now (Google is shipping
  -- 3.x) — worth re-reading the row if it disappears.
  ('google','gemini-2.5-flash','2026-09-07', 300000, 2500000, null, null, 30000,
   'https://ai.google.dev/gemini-api/docs/pricing',
   'read in-browser 7 Sep 2026 — paid tier, TEXT rate. Audio input is $1.00/Mtok. Output includes thinking tokens. Cache storage is $1.00/Mtok/hour, which has no per-token column, so cache writes are left unpriced.'),

  -- XAI · grok-4.6
  -- Read in-browser 7 Sep 2026: $2.00 input, $0.50 cached input, $6.00 output
  -- per 1M tokens, 500,000-token context window.
  -- xAI states there are "different rates for requests which exceed the 200K
  -- context window" and DOES NOT PUBLISH THEM. This row is the under-200K
  -- rate. A long request is underpriced by an unknown amount; that is xAI's
  -- gap, not ours, and it is recorded here rather than guessed at.
  -- No cache-write rate is published, so both write columns are null.
  ('xai','grok-4.6','2026-09-07', 2000000, 6000000, null, null, 500000,
   'https://docs.x.ai/docs/models/grok-4.6',
   'read in-browser 7 Sep 2026. Under-200K-context rate; xAI says requests above 200K are charged differently and publishes no figure.'),

  -- GROQ · openai/gpt-oss-120b
  -- provider is groq; the model id itself contains a slash. Read in-browser
  -- 7 Sep 2026 off Groq's own model page, which prints all three as figures:
  -- Input $0.15, Cached Input $0.075, Output $0.60 per 1M tokens.
  -- Worth knowing: Groq's caching docs describe this as "a 50% discount for
  -- cached input tokens" and say "cache hits are not guaranteed" — the $0.075
  -- is published as a number on the model page, not inferred from the
  -- discount, which is why it is safe to store.
  -- This model is currently failing 6 of 6 calls. The rate is still correct.
  ('groq','openai/gpt-oss-120b','2026-09-07', 150000, 600000, null, null, 75000,
   'https://console.groq.com/docs/model/openai/gpt-oss-120b',
   'read in-browser 7 Sep 2026. Model is failing every call as at this date — that is a key or wiring problem, not a pricing one.')

on conflict (provider, model, effective_from) do nothing;

-- ============================================================
-- WHAT THIS DOES NOT CLAIM
-- ============================================================
-- After this runs, the AI Cost page still shows "not priced" for perplexity,
-- deepseek, serpapi, mistral and the bare openai/gpt-5.6 — five of the ten
-- models. That is the honest state, and the page already says so in its own
-- words. Do not read a fuller-looking number as a complete AI bill until the
-- per-call column exists and the two dead model ids are fixed.
