-- ============================================================
-- 0024 — AI USAGE + COST.  Aug 28 2026
-- ============================================================
-- Three things:
--   1. ai_model_prices     — a DATED price book. Prices become data, not code.
--   2. admin_usage_events  — additive columns only. Nothing already reading or
--                            writing that table breaks.
--   3. ai_provider_bills   — where a provider's own bill goes, for the monthly
--                            true-up. NOTHING WRITES TO IT YET: that needs an
--                            Admin key, which only an org owner can create.
--                            The table exists so the page can never invent the
--                            comparison later.
--
-- THE RULE THIS MIGRATION ENFORCES: a cost we cannot work out honestly is
-- NULL, and null means "not priced yet". It is never 0. Zero is a real answer
-- meaning the call was free, and it must never be the shape "we don't know"
-- takes. Every not-null default below was chosen with that in mind.
--
-- MONEY IS MICRO-DOLLARS AS bigint. One micro-dollar is a millionth of a
-- dollar. `numeric(12,6)` — what cost_usd already is — overflows at
-- 999,999.999999 and is a decimal type in a codebase whose money pages run on
-- whole integers (lib/finance-math.js). bigint has neither problem.
--
-- DATES ARE `date`, READ AS PLAIN 'YYYY-MM-DD' STRINGS IN JS. Never hand one
-- to new Date(): '2026-09-01' parses as midnight UTC, which is the evening of
-- Aug 31 in Chicago, and this repo has shipped that bug twice.

-- ============================================================
-- 1. THE PRICE BOOK
-- ============================================================

create table if not exists public.ai_model_prices (
  id                       uuid primary key default gen_random_uuid(),
  provider                 text not null,          -- anthropic | openai | google | perplexity
  model                    text not null,          -- the EXACT model id the API returns
  effective_from           date not null,
  effective_to             date,                   -- null = still current
  -- Micro-dollars per MILLION tokens, as whole numbers.
  --   $3.00 / Mtok  ->  3000000
  --   $0.30 / Mtok  ->   300000
  input_per_mtok           bigint not null,
  output_per_mtok          bigint not null,
  -- Nullable on purpose. NULL means "this provider has no such charge", and a
  -- call that used those tokens against a null rate is UNPRICED, not free.
  -- Anthropic charges a different rate for a cache write that lives 5 minutes
  -- and one that lives an hour; pricing an hour-long write at the 5-minute
  -- rate understates it by 60% and nothing on the bill would show which it was.
  cache_write_per_mtok     bigint,                 -- 5-minute cache write
  cache_write_1h_per_mtok  bigint,                 -- 1-hour cache write
  cache_read_per_mtok      bigint,
  currency                 text not null default 'USD',
  source_url               text,                   -- the pricing page this was copied from
  entered_by               uuid references auth.users,
  note                     text,
  created_at               timestamptz not null default now(),
  constraint ai_model_prices_window_sane check (effective_to is null or effective_to >= effective_from),
  constraint ai_model_prices_rates_positive check (input_per_mtok >= 0 and output_per_mtok >= 0)
);

-- ONE price row per model per start date. Without this, two rows can cover the
-- same day and the cost of a call depends on which row Postgres happened to
-- return first. lib/ai-cost.js also breaks that tie deterministically (latest
-- effective_from wins) so a bad row can never make the maths non-repeatable,
-- but the index is what stops the bad row existing.
create unique index if not exists ai_model_prices_window_idx
  on public.ai_model_prices (provider, model, effective_from);

create index if not exists ai_model_prices_lookup_idx
  on public.ai_model_prices (provider, model, effective_from desc);

-- ============================================================
-- 2. THE EVENT LOG — ADDITIVE ONLY
-- ============================================================
-- The table already exists (0001_admin_init.sql:276). Eight places write to it
-- and two read it. Every one of them keeps working: cost_usd is untouched and
-- every column below is nullable or defaulted.

alter table public.admin_usage_events
  add column if not exists provider            text not null default 'anthropic',
  -- The provider's OWN id for the request, off the response headers
  -- (`request-id` on Anthropic, `x-request-id` on OpenAI). This is the only
  -- thing that could ever match one of our rows to one line on their bill.
  add column if not exists request_id          text,
  -- Our dedupe key. api/usage-ingest.js used to say in its own comment that
  -- "idempotency is the caller's problem"; one retry double-counted, silently.
  add column if not exists event_key           text,
  -- NULL = UNPRICED. Never 0. See the header.
  add column if not exists cost_micros         bigint,
  -- WHICH price row was used. The cost is frozen at write; changing a price
  -- later must not move last month's total.
  add column if not exists price_id            uuid references public.ai_model_prices,
  add column if not exists cache_write_tokens     bigint not null default 0,
  add column if not exists cache_write_1h_tokens  bigint not null default 0,
  add column if not exists cache_read_tokens      bigint not null default 0,
  -- The ID, not the name. `meta: { client: client.name }` meant a rename split
  -- a client's spend history into two clients that never rejoined.
  add column if not exists client_id           uuid references public.admin_clients on delete set null,
  add column if not exists user_id             uuid references auth.users on delete set null,
  add column if not exists feature             text,
  add column if not exists surface             text,
  add column if not exists entity_kind         text,
  add column if not exists entity_id           uuid,
  add column if not exists status              text not null default 'ok',
  add column if not exists error_code          text,
  add column if not exists latency_ms          integer,
  add column if not exists billable            boolean not null default true;

-- The vocabularies are fixed HERE as well as in lib/ai-cost.js. Free text turns
-- into Assistant / assistant / AI Assistant inside a month and the grouping
-- quietly splits in three. tests/ai-cost/test.mjs reads this file and checks
-- the two lists have not drifted apart.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'admin_usage_events_status_ck') then
    alter table public.admin_usage_events add constraint admin_usage_events_status_ck
      check (status in ('ok','failed','rejected','capped','legacy'));
  end if;
  -- The surface list was documented as enforced here and was not. A page id
  -- that is not in the list is a typo, and a typo splits one row on the cost
  -- page into two that never rejoin.
  if not exists (select 1 from pg_constraint where conname = 'admin_usage_events_surface_ck') then
    alter table public.admin_usage_events add constraint admin_usage_events_surface_ck
      check (surface is null or surface in (
        'overview','clients','client_detail','operations','floor','sales','inbox',
        'tickets','leads','notes','finance','invoices','brain','settings',
        'api','cron','ai-cost','unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'admin_usage_events_feature_ck') then
    alter table public.admin_usage_events add constraint admin_usage_events_feature_ck
      check (feature is null or feature in (
        'assistant','client_report','console_report','rep_report','client_standing',
        'notes','email_draft','outreach_draft','lead_scrape','audit','prompt_sim','other'));
  end if;
  -- THERE IS NO 'unpriced' STATUS. `status` says what happened to the CALL;
  -- whether we could price it is cost_micros IS NULL. An earlier draft of this
  -- migration made one column answer both questions, and a failed call to an
  -- unknown model came out labelled 'unpriced' with the failure lost.
  --
  -- What IS enforced: a cost is either unknown or it is a real, non-negative
  -- number. A negative cost is not a discount, it is a broken counter.
  if not exists (select 1 from pg_constraint where conname = 'admin_usage_events_cost_ck') then
    alter table public.admin_usage_events add constraint admin_usage_events_cost_ck
      check (cost_micros is null or cost_micros >= 0);
  end if;
end $$;

-- A retry cannot double-count.
--
-- NOT PARTIAL, and that is load-bearing. A `where event_key is not null` index
-- cannot be used as an ON CONFLICT target unless the statement repeats the same
-- predicate, and PostgREST's upsert never does — so api/usage-ingest.js failed
-- with "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" on EVERY call, wrote nothing, and would have done so forever.
-- Reproduced against a real Postgres by the review on Aug 28 2026, before this
-- ever ran anywhere.
--
-- A plain unique index is what was wanted all along: Postgres treats NULLs as
-- DISTINCT, so any number of rows with no key are allowed, which is the whole
-- reason the predicate looked necessary.
drop index if exists admin_usage_event_key_idx;
create unique index if not exists admin_usage_event_key_idx
  on public.admin_usage_events (event_key);

-- The groupings the AI Cost page actually runs.
create index if not exists admin_usage_client_ts_idx  on public.admin_usage_events (client_id, ts desc);
create index if not exists admin_usage_user_ts_idx    on public.admin_usage_events (user_id, ts desc);
create index if not exists admin_usage_feature_ts_idx on public.admin_usage_events (feature, ts desc);
create index if not exists admin_usage_model_ts_idx   on public.admin_usage_events (provider, model, ts desc);
create index if not exists admin_usage_status_ts_idx  on public.admin_usage_events (status, ts desc);
create index if not exists admin_usage_request_id_idx on public.admin_usage_events (request_id)
  where request_id is not null;

-- ============================================================
-- 3. BACKFILL — old rows keep their numbers, and keep their label
-- ============================================================
-- Every row written before today was costed with a price hardcoded in seven
-- separate files as Claude Sonnet's rate, whatever model actually ran. Those
-- numbers are estimates. They are converted rather than deleted — they are the
-- history of what we believed at the time — and marked `legacy` so no screen
-- can present them as measured.

update public.admin_usage_events
   set cost_micros = round(cost_usd * 1000000)::bigint,
       status = 'legacy'
 where cost_micros is null
   and cost_usd is not null
   and status = 'ok';

-- ============================================================
-- 4. THE PROVIDER'S OWN BILL — the true-up. Nothing writes here yet.
-- ============================================================

create table if not exists public.ai_provider_bills (
  id                    uuid primary key default gen_random_uuid(),
  provider              text not null,
  period_start          date not null,
  period_end            date not null,
  model                 text,                   -- null = the whole account for that period
  billed_cost_micros    bigint not null,
  billed_input_tokens   bigint,
  billed_output_tokens  bigint,
  -- admin_api = pulled from the provider. typed = read off an invoice by a
  -- person. csv = an export they gave us. The page prints which.
  basis                 text not null default 'typed'
                        check (basis in ('admin_api','typed','csv')),
  note                  text,
  pulled_at             timestamptz not null default now(),
  pulled_by             uuid references auth.users,
  raw                   jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  constraint ai_provider_bills_period_sane check (period_end >= period_start)
);

create unique index if not exists ai_provider_bills_period_idx
  on public.ai_provider_bills (provider, period_start, period_end, coalesce(model, '*'));

-- ============================================================
-- 5. WHO CAN SEE ANY OF THIS
-- ============================================================
-- Cost is owner-and-admin level; reps see nothing. (An earlier draft of this
-- comment said "owner-level", which is wrong — admin_is_admin() is
-- role in ('owner','admin'). The effect is right; the sentence was not.)
-- Same shape as the existing
-- "admins read usage" policy in 0001_admin_init.sql:432. Only the service key
-- writes — no client-side insert path exists or should.

alter table public.ai_model_prices enable row level security;
alter table public.ai_provider_bills enable row level security;

grant select on public.ai_model_prices to authenticated;
grant select on public.ai_provider_bills to authenticated;

drop policy if exists "admins read prices" on public.ai_model_prices;
create policy "admins read prices" on public.ai_model_prices
  for select to authenticated using (public.admin_is_admin());

drop policy if exists "admins read bills" on public.ai_provider_bills;
create policy "admins read bills" on public.ai_provider_bills
  for select to authenticated using (public.admin_is_admin());

-- ============================================================
-- 6. SEED — ONLY prices copied off the provider's own page, on this date
-- ============================================================
-- Read from https://platform.claude.com/docs/en/about-claude/pricing on
-- Fri Aug 28 2026. The source URL is stored on every row so a wrong price can
-- be traced rather than argued about.
--
-- ONLY ANTHROPIC IS SEEDED, and deliberately. Nothing in this console calls
-- OpenAI, Google or Perplexity today. Inventing rows for them would put
-- numbers in the database that nobody checked, which is the exact failure this
-- whole migration exists to remove. When one of them is wired up, add a row —
-- until then a call to it logs its tokens and prints "not priced yet", which
-- is the honest answer.
--
-- `effective_from` is deliberately early: these are the rates the existing rows
-- were charged at too, and a price book with a gap in it prices those UNPRICED.

insert into public.ai_model_prices
  (provider, model, effective_from, input_per_mtok, output_per_mtok,
   cache_write_per_mtok, cache_write_1h_per_mtok, cache_read_per_mtok, source_url, note)
values
  ('anthropic','claude-sonnet-4-6','2026-01-01', 3000000, 15000000, 3750000, 6000000,  300000,
   'https://platform.claude.com/docs/en/about-claude/pricing','read Aug 28 2026 — the model this console runs on'),
  ('anthropic','claude-sonnet-4-5','2026-01-01', 3000000, 15000000, 3750000, 6000000,  300000,
   'https://platform.claude.com/docs/en/about-claude/pricing','read Aug 28 2026'),
  ('anthropic','claude-sonnet-4',  '2026-01-01', 3000000, 15000000, 3750000, 6000000,  300000,
   'https://platform.claude.com/docs/en/about-claude/pricing','read Aug 28 2026'),
  ('anthropic','claude-sonnet-5',  '2026-01-01', 2000000, 10000000, 2500000, 4000000,  200000,
   'https://platform.claude.com/docs/en/about-claude/pricing','read Aug 28 2026'),
  ('anthropic','claude-opus-5',    '2026-01-01', 5000000, 25000000, 6250000,10000000,  500000,
   'https://platform.claude.com/docs/en/about-claude/pricing','read Aug 28 2026'),
  ('anthropic','claude-opus-4-5',  '2026-01-01', 5000000, 25000000, 6250000,10000000,  500000,
   'https://platform.claude.com/docs/en/about-claude/pricing','read Aug 28 2026'),
  ('anthropic','claude-opus-4-1',  '2026-01-01',15000000, 75000000,18750000,30000000, 1500000,
   'https://platform.claude.com/docs/en/about-claude/pricing','read Aug 28 2026'),
  ('anthropic','claude-haiku-4-5', '2026-01-01', 1000000,  5000000, 1250000, 2000000,  100000,
   'https://platform.claude.com/docs/en/about-claude/pricing','read Aug 28 2026'),
  ('anthropic','claude-haiku-3-5', '2026-01-01',  800000,  4000000, 1000000, 1600000,   80000,
   'https://platform.claude.com/docs/en/about-claude/pricing','read Aug 28 2026')
on conflict (provider, model, effective_from) do nothing;

-- ============================================================
-- WHAT IS DELIBERATELY NOT HERE
-- ============================================================
-- No cron, no bill sync, no OpenAI/Google/Perplexity prices. The bill sync
-- needs an Anthropic Admin key and an OpenAI Admin key, and neither exists.
-- Until one does, the AI Cost page shows METERED with no BILLED column and
-- says on screen that the comparison has not been made — rather than printing
-- a green tick it has not earned.
