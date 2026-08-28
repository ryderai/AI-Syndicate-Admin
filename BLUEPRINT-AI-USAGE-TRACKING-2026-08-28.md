# BLUEPRINT — AI usage + cost tracking, built to be provably right

**Written:** Fri Aug 28 2026 · **Status:** SPEC ONLY — nothing built, no migration run
**Checked:** every claim below about the existing code was verified against the repo by a second
agent told to assume the draft was wrong. It found 11 errors. They are corrected here, and §15
lists what it caught.
**Repo:** `ai-syndicate-admin` · **Next migration number:** `0024` · **Next context section:** `§48`

Plain words first: this is the plan for a system that records **every single time we ask an AI
anything**, what it cost, who asked, what page they were on, and which client it was for — and
then proves the total is right by checking it against the bill the AI company sends us.

---

## 0. THE ONE RULE THIS WHOLE THING RUNS ON

The Finance page already has an honesty rule: **money in is measured, money out is typed in, and
every number wears a badge saying which it is.** AI cost gets a third badge:

| Badge | Meaning |
|---|---|
| **METERED** | We counted it ourselves at the moment of the call. Token counts came from the AI company's own reply. |
| **BILLED** | The AI company's own figure, pulled from their admin API or typed off an invoice. |
| **UNPRICED** | We have the token count but no price for that model yet. Shown as "not priced", **never as $0**. |
| **DRIFT** | The gap between METERED and BILLED for the same month. This is the accuracy score. |

A number is never silently a zero. A missing price prints the reason.

---

## 1. WHAT IS ALREADY THERE (and what is wrong with it)

The console already logs AI spend. It is a real head start and it is also wrong in seven ways.
All seven are fixable and all seven are why the current number cannot be trusted.

**What exists:**

- Table `public.admin_usage_events` — `supabase/migrations/0001_admin_init.sql`, lines 276–286 (the index is 288).
- Feed-in endpoint `api/usage-ingest.js` — for Andrew's backend to POST events.
- Seven API files that already log their own spend:
  `api/ai-chat.js`, `api/console-report.js`, `api/client-report.js`, `api/notes-generate.js`,
  `api/ai-draft.js`, `api/rep-report.js`, `api/client-standing.js`.
- Two read paths, both via `listUsage()` in `src/lib/data.js:851` — `Overview.jsx:187`
  (`listUsage(40)`) and `Finance.jsx:6,168` (`listUsage(400)`).
- **Finance already shows a measured AI figure and already cross-checks it.**
  `Finance.jsx:340-346` computes `aiMeasuredThisMonth`; `Finance.jsx:695-702` prints
  *"Cross-check on the AI bill. The usage feed measured X … You typed Y"*. This blueprint
  replaces that block; it does not invent it.

**The seven defects — every one of these makes the total wrong, not just ugly:**

1. **The price is hardcoded seven times.** `const COST = { input: 3.0, output: 15.0 }` appears in
   all seven files. That is Claude Sonnet's price. Point one call at Haiku, Opus, GPT or Gemini
   and the cost recorded is a made-up number that still looks real. There is no way to notice.

2. **Cached tokens are not counted.** Anthropic bills cache-write tokens at a *higher* rate than
   normal input and cache-read tokens at a *much lower* one. The code only reads `input_tokens`
   and `output_tokens`. The moment anyone turns on prompt caching, every figure is wrong in
   both directions at once.

3. **The client is stored as a NAME, not an ID.** `meta: { client: client.name }`. Rename a client
   in the console and their spend history splits into two clients that never rejoin.

4. **Failed calls cost money and no cost is recorded.** Timeouts, rate limits, and answers the
   honesty gate rejected all skip the usage insert. We are billed for the input tokens on many
   of those. The *event* is not always invisible — `api/client-report.js:306` and
   `api/client-standing.js:118-123` do write a rejection line to `admin_activity_log` — but the
   **spend** is nowhere, and we cannot say how much of it there is.

5. **All seven swallow a failed write — but by two different mechanisms, and a fix that looks
   for only one will miss three of them.**
   - **Four are fire-and-forget:** `.then(() => {}, () => {})` —
     `ai-chat.js:154`, `console-report.js:156`, `notes-generate.js:183`, `rep-report.js:202`.
   - **Three `await` the insert and never read the result:**
     `client-report.js:293-298`, `ai-draft.js:100-107`, `client-standing.js:111-115`.
     This is worse, not better. `supabase-js` **does not throw** on a database error — it
     resolves with `{ error }`, and none of the three looks at it. And because all three sit
     inside the AI call's own `try`, a genuine throw there would be caught by the *AI-failure*
     handler and shown to the person as *"the AI did not answer"* — a bookkeeping fault
     reported as a product fault.
   Either way, nobody is ever told the books have a hole in them.

6. **No duplicate protection.** `api/usage-ingest.js` says in its own comment: *"Idempotency is
   the caller's problem (send once)."* One retry from Andrew's backend double-counts, silently.

7. **Dollars as decimals, in a page that runs on cents.** `cost_usd numeric(12,6)` is dollars.
   `lib/finance-math.js` runs everything in whole cents *on purpose*, because "dollars with
   decimal points drift a penny at a time". These two can never be added together safely as-is.

8. **The reader silently truncates, and throws away the only attribution there is.**
   `listUsage()` (`src/lib/data.js:855-856`) has a hard `.limit(5000)` and does **not** select
   the `meta` column. Two consequences, and the first is a live bug on the Finance page today:
   past 5,000 events in the window the measured AI figure is simply too low, with no warning, on
   the one page whose whole premise is that every number says where it came from. And every
   per-client or per-feature grouping is impossible through this reader, because the only
   attribution that exists today lives in `meta`, which is never fetched.

---

## 2. THE FIX, IN ONE PARAGRAPH

Prices stop being code and become **dated rows in a table**. Cost is worked out **once, in whole
millionths of a dollar, at the moment of the call**, and frozen — never recalculated later.
Every event carries the **AI company's own request ID**, so the monthly bill can be matched
line by line instead of just eyeballed as a total. Failed calls get logged too. Duplicates are
blocked by a unique key. And once a month we pull the real bill and print the gap.

---

## 3. THE SCHEMA — migration `0024_ai_usage.sql`

### 3a. The price book — `public.ai_model_prices`

Prices are **data, not code**. Dated, so an old event is never re-priced with a new price.

```sql
create table if not exists public.ai_model_prices (
  id                        uuid primary key default gen_random_uuid(),
  provider                  text not null,              -- anthropic | openai | google | perplexity
  model                     text not null,              -- exact model id as the API returns it
  effective_from            date not null,
  effective_to              date,                       -- null = still current
  -- Every price is MICRO-DOLLARS PER MILLION TOKENS, as a whole number.
  -- $3.00 / Mtok  ->  3000000
  input_per_mtok            bigint not null,
  output_per_mtok           bigint not null,
  cache_write_per_mtok      bigint,                     -- null = provider has no such charge
  cache_read_per_mtok       bigint,
  currency                  text not null default 'USD',
  source_url                text,                       -- the pricing page this was copied from
  entered_by                uuid references auth.users,
  note                      text,
  created_at                timestamptz not null default now()
);

-- One price per model per day. This is what stops two overlapping rows
-- quietly making cost depend on row order.
create unique index if not exists ai_model_prices_window_idx
  on public.ai_model_prices (provider, model, effective_from);
```

**Why micro-dollars as whole numbers:** a single cheap call can cost a fraction of a cent.
Floating-point dollars lose those fractions and the loss compounds over tens of thousands of
calls. Whole millionths never drift. Cents for display = `round(micros / 10000)`.

### 3b. The event log — extend `public.admin_usage_events`

**Additive only.** The existing table stays, the existing columns stay, and the eight places that
already write to it (the seven AI files plus `api/usage-ingest.js:60`) and the two that read it
all keep working. We add.

```sql
alter table public.admin_usage_events
  add column if not exists provider            text not null default 'anthropic',
  add column if not exists request_id          text,        -- the provider's OWN id. The true-up key.
  add column if not exists event_key           text,        -- our dedupe key
  add column if not exists cost_micros         bigint,      -- exact cost. null = UNPRICED
  add column if not exists price_id            uuid references public.ai_model_prices,
  add column if not exists cache_write_tokens  bigint not null default 0,
  add column if not exists cache_read_tokens   bigint not null default 0,
  add column if not exists client_id           uuid references public.admin_clients on delete set null,
  add column if not exists user_id             uuid references auth.users on delete set null,
  add column if not exists feature             text,        -- assistant | client_report | notes | ...
  add column if not exists surface             text,        -- the page: overview | clients | floor | ...
  add column if not exists entity_kind         text,        -- lead | task | ticket | email | company
  add column if not exists entity_id           uuid,
  add column if not exists status              text not null default 'ok',
                                                            -- ok | failed | rejected | capped | unpriced
  add column if not exists error_code          text,
  add column if not exists latency_ms          integer,
  add column if not exists billable            boolean not null default true;

-- No double counting. Ever.
create unique index if not exists admin_usage_event_key_idx
  on public.admin_usage_events (event_key) where event_key is not null;

-- The groupings the analytics actually run on.
create index if not exists admin_usage_client_ts_idx  on public.admin_usage_events (client_id, ts desc);
create index if not exists admin_usage_user_ts_idx    on public.admin_usage_events (user_id, ts desc);
create index if not exists admin_usage_feature_ts_idx on public.admin_usage_events (feature, ts desc);
create index if not exists admin_usage_model_ts_idx   on public.admin_usage_events (provider, model, ts desc);
create index if not exists admin_usage_request_id_idx on public.admin_usage_events (request_id)
  where request_id is not null;
```

`cost_usd` stays exactly as it is so nothing already reading it breaks. New code reads
`cost_micros`. A one-off backfill sets `cost_micros = round(cost_usd * 1000000)` for old rows and
marks them `status = 'legacy'` — old numbers stay visible and stay labelled as the estimates
they were.

### 3c. The bill — `public.ai_provider_bills`

This is the half that makes the whole thing provable.

```sql
create table if not exists public.ai_provider_bills (
  id                    uuid primary key default gen_random_uuid(),
  provider              text not null,
  period_start          date not null,          -- plain YYYY-MM-DD strings. Never new Date().
  period_end            date not null,
  model                 text,                   -- null = the provider's whole-account total
  billed_cost_micros    bigint not null,
  billed_input_tokens   bigint,
  billed_output_tokens  bigint,
  basis                 text not null,          -- admin_api | typed | csv
  pulled_at             timestamptz not null default now(),
  pulled_by             uuid references auth.users,
  raw                   jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

create unique index if not exists ai_provider_bills_period_idx
  on public.ai_provider_bills (provider, period_start, period_end, coalesce(model, '*'));
```

### 3d. Row-level security

Same shape as the existing `"admins read usage"` policy in `0001_admin_init.sql` line 432 — owners
and admins read; **reps see nothing**. Cost data is owner-level. Only the service key writes.

---

## 4. THE COST ENGINE — `lib/ai-cost.js`

One pure file. No database, no network, no clock of its own — the same discipline as
`lib/finance-math.js`, and for the same reason: it can be fully tested without a single key.

```js
/* Every price is micro-dollars per million tokens. Every count is whole tokens.
 * Every value that LEAVES this file is a whole number of micro-dollars — the one
 * division is rounded on the spot and nothing float-shaped is ever stored or summed.
 *
 * TRAP: supabase-js hands back a Postgres `bigint` as a STRING, not a number.
 * "3000000" * 1200 coerces and happens to work; "3000000" + 1200 concatenates.
 * Every price read out of the database goes through Number() once, at the edge. */

export function priceFor(prices, { provider, model, onDate }) { /* dated lookup */ }

export function costMicros(price, usage) {
  if (!price) return null;                    // UNPRICED. Never 0.
  const {
    input_tokens = 0,
    output_tokens = 0,
    cache_creation_input_tokens = 0,
    cache_read_input_tokens = 0,
  } = usage;
  const per = (tokens, rate) =>
    rate == null ? null : Math.round((tokens * rate) / 1_000_000);
  // A model with cached tokens but no cache price is UNPRICED, not "close enough".
  if (cache_creation_input_tokens && price.cache_write_per_mtok == null) return null;
  if (cache_read_input_tokens && price.cache_read_per_mtok == null) return null;
  return per(input_tokens,  price.input_per_mtok)
       + per(output_tokens, price.output_per_mtok)
       + per(cache_creation_input_tokens, price.cache_write_per_mtok ?? 0)
       + per(cache_read_input_tokens,     price.cache_read_per_mtok  ?? 0);
}
```

**The three rules inside it:**

1. **Frozen at write.** The price row used is saved as `price_id`. An old event is never
   re-costed. If Anthropic changes prices tomorrow, last month's total does not move.
2. **Unknown model = UNPRICED, not zero.** A model we have no price row for logs its tokens
   and a null cost, and the screen says *"3 calls to `claude-x-new` — not priced yet."*
   A wrong number that looks right is worse than a gap that says it is a gap.
3. **Cache tokens are first-class.** They are counted separately because they are billed
   separately.

---

## 5. ONE LOGGER, SEVEN CALL SITES DELETED — `lib/ai-usage.js`

Today seven files each do their own arithmetic and their own insert. That is seven chances to
drift apart. It becomes one function.

```js
await recordAiUsage(admin, {
  provider: "anthropic",
  model: AGENT_MODEL,
  requestId: out.requestId,            // from the provider's response headers
  usage: out.usage,                    // the FULL usage object, cache fields included
  status: "ok",
  latencyMs: out.latencyMs,
  feature: "assistant",
  surface: screen?.page,
  clientId: client?.id,                // the ID. Not the name.
  userId: member.membership.user_id,
  entity: { kind: "lead", id: leadId },
  eventKey: `assistant:${out.requestId}`,
});
```

**What it does that the current code does not:**

- Looks the price up by `(provider, model, ts)` and stores the `price_id` it used.
- Writes `cost_micros` **and** `cost_usd` (so the old Overview read keeps working).
- On a failed AI call, still writes a row with `status: 'failed'` and whatever tokens the
  provider reported. Spend we cannot see is spend we cannot control.
- On a write failure, it **records the miss** in `admin_activity_log` instead of swallowing it,
  and the Overview prints *"2 usage events could not be saved in the last 24h"*.
  A guard whose failure mode is silence is not a guard — that trap is already written up in
  `CONTEXT-FOR-AI.md §22`.
- Never throws. Bookkeeping must not be able to cost somebody their answer.

**Capturing the request ID** — this is the one code change in the transport layer. Anthropic
returns `request-id` in the response headers; OpenAI returns `x-request-id`. `lib/ai.js` and
`lib/ai-agent.js` currently read only `response.json()`. They must also read
`response.headers.get("request-id")` and pass it up. Without it, the true-up in §7 can only
compare totals. With it, we can find the exact call that does not match.

---

## 6. THE ATTRIBUTION MODEL — how "per client, per page, per everything" actually works

Six tags on every row. Every analytics view in §8 is just a `group by` over these.

| Tag | Column | Answers |
|---|---|---|
| **Who asked** | `user_id` | Which person burns the most AI. Cost per head. |
| **For which client** | `client_id` | Cost to serve. Feeds Finance's existing margin maths. |
| **What it was doing** | `feature` | Reports vs assistant vs notes vs outreach drafts. |
| **Where they were** | `surface` | Which page in the console. Finds the expensive screen. |
| **What it was about** | `entity_kind` + `entity_id` | The exact lead, task, ticket or email. |
| **Which brain** | `provider` + `model` | Cost per model. Proves whether a cheaper model would do. |

**Fixed vocabularies, in `src/lib/data.js` alongside the existing option lists** — free text here
turns into `Assistant` / `assistant` / `AI Assistant` inside a month and the grouping quietly
splits in three.

```
feature: assistant | client_report | console_report | rep_report | client_standing
       | notes | email_draft | outreach_draft | lead_scrape | audit | prompt_sim | other
surface: overview | clients | client_detail | operations | floor | sales | inbox
       | tickets | leads | notes | finance | invoices | brain | settings | api | cron
status:  ok | failed | rejected | capped | unpriced | legacy
```

**Filling in `client_id` is the biggest single piece of work in this plan, and the first draft of
this document badly underestimated it.** The real position, checked file by file:

| Call site | Has a client today? | What it needs |
|---|---|---|
| `api/client-report.js` | Yes (`client.name`, :297) | One line — swap the name for `client.id`. |
| `api/client-standing.js` | Yes (`client.name`, :114) | One line — same. |
| `api/console-report.js` | **No** | The report is company-wide. Attaches to **Internal**. |
| `api/rep-report.js` | **No** | Same — it is about a person, not a client. |
| `api/ai-draft.js` | **No** | Needs the client passed down from whatever is being drafted. |
| `api/ai-chat.js` (assistant) | **No** | See below. |
| `api/notes-generate.js` | **Cannot be attributed** | One AI call covers a whole batch of notes spanning many clients. It stays **Internal**, or the batch gets split per client — which changes what the feature costs. Decide before building, not during. |

**The assistant is not a one-liner either.** `src/lib/screenContext.js` exists (84 lines) but has
**no client concept at all** — it carries `{ page, label, record: { type, id, label }, visible }`
(`:41-52`). A client id is readable only when `record.type === "client"`. On a lead, a ticket or
an invoice page there is no client id to read, and mapping those back to a client is extra work
this plan has to budget for.

Anything with no client attaches to a bucket called **Internal**, shown as its own line and never
spread across clients as a guess.

---

## 7. THE TRUE-UP — the part that makes it *provably* accurate

Our own count is a claim. The AI company's bill is the check. Once a month, both go on the screen.

**`api/ai-bill-sync.js`** — a cron job, first of the month, runs for the month just finished:

| Provider | Pull | Needs |
|---|---|---|
| **Anthropic** | Usage & Cost API, grouped by model | An **Admin key** (`sk-ant-admin…`). Only an org owner can make one. |
| **OpenAI** | Usage API + Costs API, grouped by model | An **Admin key**. Org owner only. |
| **Google Gemini** | No usage API. Cloud Billing export → BigQuery, or read the console. | Someone with Google Cloud billing access. |
| **Perplexity** | No usage API found. | Type the invoice total in. `basis: 'typed'`. |

A plain `sk-…` API key **cannot** do any of this. It can spend money; it cannot read the bill.

**The drift report — the accuracy score:**

```
DRIFT = (billed_cost_micros - our_metered_micros) / billed_cost_micros
```

| Drift | What it means | What the screen shows |
|---|---|---|
| **under 1%** | Rounding and clock edges. Normal. | Green — "matches the bill" |
| **1–3%** | Watch it. Usually cache tokens or a stale price row. | Amber |
| **over 3%** | Something is calling an AI outside our logging. | Red — with the list of models where the gap is |

Three known reasons the two will never be exactly equal, all of which the screen states in plain
words rather than hiding:

1. **Different clocks.** Providers bill in UTC. We report in America/Chicago. Calls in the last
   five hours of a month land in different months. The report says which.
2. **Rounding.** Providers round per-invoice; we round per-call. Pennies, on thousands of calls.
3. **Credits, free tiers, batch discounts and minimum charges** appear on the bill and cannot be
   seen from a single call. They show as a named line, not as drift.

---

## 8. WHAT IT LOOKS LIKE — the **AI Cost** page

Sits under **Finance** in the sidebar, next to **Invoices**. `Sidebar.jsx` already supports
children (added Aug 20).

**Top — the honest header**

- This month so far, badged **METERED**, with `"18 of 31 days in"` beside it. The month you are
  standing in is not finished — that trap is already written up in `CONTEXT-FOR-AI.md §18`.
- Last finished month: **METERED** next to **BILLED**, and the **DRIFT** between them.
- Calls · tokens in · tokens out · cached · average cost per call · median and p95 latency.
- One red line if anything is UNPRICED or unsaved.

**Middle — six grouping tabs, one table each, every column click-to-sort**

`By client` · `By person` · `By feature` · `By page` · `By model` · `By day`

Every row: calls, input tokens, output tokens, cached tokens, cost, share of total, and the
change against the same length of time before it. Click any row → the raw events behind it.
**Every number on this page can be clicked down to the individual calls that make it.** A figure
you cannot open is a figure you have to take on faith.

**Bottom — the four analytics that are actually worth having**

1. **AI cost to serve a client.** Their AI spend ÷ their monthly fee. This does **not** drop
   straight into Finance's existing `costToServe` (`Finance.jsx:349-350`) — that one is
   business-wide delivery cost ÷ number of paying clients, not a per-client figure. The
   structure it fits is `clientCostRows`, built from expenses that carry a `client_id`. Two
   different numbers; wiring them together is real work, not a line.
2. **Cost per report.** Average spend for one client report, one console report, one rep report.
   Tells us what a deliverable costs us before we price the next one.
3. **Would a cheaper model do?** Same feature, cost by model, side by side, with output length
   and rejection rate next to it — because a cheap model that gets rejected twice is not cheap.
4. **Cache savings, measured.** Cache-read tokens × (normal input price − cache read price).
   Real money saved, not a claim.

**Two more places it shows up:**

- **Client page** — one line: *"AI cost this month: $X (Y calls)"*, linking through.
- **Finance page** — the existing measured-AI callout (`Finance.jsx:695-702`) gets replaced with
  the real thing: AI spend as a cost category badged METERED, broken down, and no longer capped
  at 5,000 events. It is not the *only* measured cost — Stripe card fees are measured too, and
  Finance already prints the same measured-vs-typed comparison for them at `Finance.jsx:685-693`.
  The AI block should look and behave exactly like that one, because the team already reads it.

---

## 9. THE ACCURACY PROOFS — how we know it is right

Seven checks. Each one closes one of the seven defects in §1.

| # | Proof | Closes |
|---|---|---|
| 1 | Cost frozen at write, from a dated price row, integer maths. | §1.1, §1.7 |
| 2 | Cache tokens counted and priced separately; missing cache price = UNPRICED. | §1.2 |
| 3 | Client stored as a foreign key. A rename cannot split a history. | §1.3 |
| 4 | Failed and rejected calls logged with `status`. Invisible spend becomes visible. | §1.4 |
| 5 | A failed insert is reported on Overview, not swallowed. | §1.5 |
| 6 | `event_key` unique index. A retry cannot double-count. | §1.6 |
| 7 | The reader takes a date range and paginates, with `meta` and the new columns selected. No silent 5,000-row cut. | §1.8 |
| 8 | Monthly drift against the provider's own bill, matched on `request_id`. | all of them |

**Test suite — `tests/ai-cost/`. Copy `tests/floor-scoping/run.sh`, NOT `tests/finance/run.sh`.**
This matters. `tests/finance/run.sh` is five lines with **no timezone handling at all** — the four
zones quoted in `CONTEXT-FOR-AI.md:1325-1326` were run by hand by whoever was at the keyboard, so
nobody re-running that suite gets the coverage. `tests/floor-scoping`, `tests/rep-brief`,
`tests/sales`, `tests/connectors` and `tests/outreach-stats` bake `TZ=` into the runner. Do that.

- The maths, on known inputs, checked to the exact micro-dollar.
- **`TZ=` inside `run.sh`, five zones** (UTC, Chicago, LA, Tokyo, Auckland). A zone you have to
  remember to set is a zone nobody sets.
- A `bigint` arriving from supabase-js as a **string** must not silently break the arithmetic.
- A test that reads the `create table` statements out of `0024_ai_usage.sql` and checks the
  column names the code writes actually exist. `CONTEXT-FOR-AI.md §22` records why: three files
  once wrote column names the tables did not have, and the tests missed it because the fixtures
  had invented the same wrong names. **A test that agrees with the code is not a test.**
- Idempotency: send the same event twice, assert one row.
- Unpriced: an unknown model logs tokens, null cost, and does **not** count as zero in any total.
- Drift: a synthetic bill and a synthetic log, assert the drift figure and the amber/red band.
- Dated prices: an event on the day a price changes uses the right row, both sides of midnight.

---

## 10. BUILD ORDER

Each step ships on its own and leaves the console working.

| # | Step | Blocked by |
|---|---|---|
| 1 | `lib/ai-cost.js` + `tests/ai-cost/` — the maths, proved, before any wiring. | nothing |
| 2 | Migration `0024_ai_usage.sql` + backfill of `cost_micros`. | nothing |
| 3 | Seed the price book. Copy today's real prices off each pricing page. | nothing |
| 4 | `lib/ai-usage.js`, and the seven `COST = {…}` blocks deleted. | 1, 2, 3 |
| 5 | Request IDs captured in `lib/ai.js` and `lib/ai-agent.js`. | 4 |
| 6 | Attribution filled in — `client_id`, `user_id`, `feature`, `surface` at all seven sites. | 4 |
| 7 | `api/usage-ingest.js` v2 — dedupe key, provider, attribution. Old shape still accepted. | 2 |
| 8 | The **AI Cost** page, six grouping tabs, drill-down. | 4, 6 |
| 9 | `api/ai-bill-sync.js` + the drift report. | **admin keys** |
| 10 | AI cost onto the Finance page and the client page. | 8 |

**Steps 1–8 are not blocked by anything or anyone.** Step 9 is the only one that needs someone
else, and until it lands the page is honest about it: it prints **METERED** and no **BILLED**
column, rather than pretending the two agree.

---

## 11. WHAT IS BLOCKED, AND ON WHAT

Written as state, not as jobs for anyone.

- **The Anthropic true-up** is blocked until an Anthropic **Admin key** exists. An org owner
  creates it. A normal API key cannot read usage or cost.
- **The OpenAI true-up** is blocked until an OpenAI **Admin key** exists. Same shape.
- **The Gemini true-up** is blocked until Cloud Billing export is switched on for the project.
- **Perplexity** has no usage API that could be found. Its figure will be typed in, badged
  **BILLED / typed**, every month.
- **Andrew's backend and the platform's own AI spend** stay outside these numbers until they POST
  to `/api/usage-ingest`. Until then the page says so out loud — *"console only; platform spend
  not included"* — because a total that silently covers half the spend is worse than no total.

---

## 12. THINGS THAT WILL GO WRONG (write these down before they do)

1. **A new model appears and nobody adds a price.** Handled: UNPRICED, loud, never zero.
2. **A price changes mid-month.** Handled: dated rows, cost frozen at write.
3. **Someone edits a price row to fix a typo** and silently re-prices nothing — because cost is
   frozen. That is correct, and it is also surprising. There must be a **"re-cost these events"**
   button that says exactly how many rows it will change and writes a note saying why.
4. **`new Date("2026-09-01")` is midnight UTC** = the evening of Aug 31 in Chicago. It has already
   caused two real bugs in this repo. Plain `YYYY-MM-DD` strings are read as strings. Never hand
   one to `Date()`.
5. **`numeric(12,6)` overflows at 999,999.999999.** `cost_micros` as `bigint` does not.
6. **Cost data leaking to reps.** RLS on the table, and the sidebar item hidden by role — the
   same two-layer check the context engine already uses.
7. **The logger becoming slow enough to be felt.** The price lookup must be a cached in-memory map
   refreshed on a timer, not a database round-trip per call.

---

## 13. FILE LIST

**New:**
```
supabase/migrations/0024_ai_usage.sql
lib/ai-cost.js
lib/ai-usage.js
api/ai-bill-sync.js
src/components/admin/AiCost.jsx
src/components/admin/aiCostParts.jsx
tests/ai-cost/test.mjs
tests/ai-cost/run.sh
```

**Changed:**
```
lib/ai.js                    request id + full usage object returned
lib/ai-agent.js              same
api/ai-chat.js               COST block deleted -> recordAiUsage
api/console-report.js        same
api/client-report.js         same
api/notes-generate.js        same
api/ai-draft.js              same
api/rep-report.js            same
api/client-standing.js       same
api/usage-ingest.js          v2: dedupe, provider, attribution
src/lib/data.js              listUsage() -> paginated, meta selected, grouped readers,
                             fixed vocabularies. Fixes the live 5,000-row undercount.
src/components/admin/Sidebar.jsx        AI Cost under Finance
src/components/AdminDashboard.jsx        route — NOT under admin/, it sits one level up
src/components/admin/Finance.jsx        AI spend as a measured cost line
src/components/admin/Overview.jsx       unsaved-events warning
src/admin.css                appended block
SETUP.md                     appended: Migration 0024 + seeding the price book
CONTEXT-FOR-AI.md            appended: §48
```

---

## 14. THE THIRTY-SECOND VERSION

Right now the console guesses AI cost with one hardcoded price copied into seven files, throws
away failed calls, and stores the client as a name that a rename can break. This plan makes
prices dated rows instead of code, works the cost out once in whole millionths of a dollar and
freezes it, tags every call with who / which client / which page / which model, and then once a
month checks our total against the real bill and prints the gap. Steps 1 through 8 need nobody.
Step 9 needs an admin key from an owner.

---

## 15. WHAT THE CHECK CAUGHT

A second agent was pointed at the repo and told to assume this document was lying. It read every
file named here. Eleven claims in the first draft were wrong or overstated; all eleven are
corrected above. They are recorded because most were the *optimistic* kind of wrong — the kind
that makes a plan look smaller than it is.

| # | The first draft said | The code says |
|---|---|---|
| 1 | `src/components/admin/AdminDashboard.jsx` | It is `src/components/AdminDashboard.jsx`, one level up. |
| 2 | All seven inserts are fire-and-forget | Four are. Three `await` and never read `{ error }` — a different bug needing a different fix. |
| 3 | "nine places write to it" | Eight write, two read. |
| 4 | Four call sites already have the client | **Two.** One of the others cannot be attributed at all without splitting the batch. |
| 5 | Finance would gain a measured AI figure | It **already has one**, plus a measured-vs-typed cross-check. This replaces it. |
| 6 | AI is the only cost we measure ourselves | Stripe card fees are measured too, and already displayed the same way. |
| 7 | Copy `tests/finance/`'s five-timezone shape | That runner has **no** TZ handling. Four zones, run by hand. Copy `tests/floor-scoping/run.sh`. |
| 8 | "Integer maths throughout, no floats" | One float division, rounded on the spot. And bigints arrive from supabase-js as **strings**. |
| 9 | Failed calls "log nothing" | Two of them do log a rejection. It is the **cost** that is missing. |
| 10 | AI cost drops into Finance's cost-to-serve | That metric is business-wide ÷ client count. Different structure. |
| 11 | `screenContext.js` can supply the client | It has no client concept. Only when `record.type === "client"`. |

**And one thing the first draft missed entirely, which is a live bug right now:** `listUsage()`
caps at 5,000 rows and never selects `meta`. Finance's AI figure is already capable of being
quietly too low, on the page whose entire premise is that every number says where it came from.
That is now defect §1.8 and proof §9.7.
