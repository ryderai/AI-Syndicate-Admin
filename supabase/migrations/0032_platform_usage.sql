-- ============================================================
-- 0032 — PLATFORM SPEND, AND WHOSE IT WAS.  6 Sep 2026
-- ============================================================
-- Additive only. Nothing that reads or writes admin_usage_events today
-- changes behaviour, and this file is safe to run twice.
--
-- WHAT CHANGED UPSTREAM, AND WHY THIS IS NEEDED
--
-- Until 6 Sep 2026 the PLATFORM had never measured a single real token. All 40
-- of its files that call a paid model API read the answer and threw the
-- provider's own `usage` object away. Every cost figure in the business was a
-- hand-typed estimate, which is how "$1,000 of credits in three days" (2 Sep)
-- was a surprise rather than a number somebody was already watching.
--
-- The platform now measures every call (lib/ai-meter.js there) and posts it to
-- this console's /api/usage-ingest, which already existed and had never
-- received an event. Those events carry two things this table has nowhere to
-- put them:
--
--   * the PLATFORM WORKSPACE the spend belongs to
--   * the platform's own feature key, e.g. "content.generate"
--
-- ============================================================
-- THE RULE THIS MIGRATION IS BUILT AROUND
-- ============================================================
--
-- A PLATFORM WORKSPACE ID IS NOT A CLIENT ID.
--
-- They are different things in different databases. It would be easy — and it
-- would make a lovely per-client cost chart tomorrow morning — to write the
-- workspace id into `client_id` and let everything downstream join on it. That
-- chart would be invented. Every number on it would be built on a join that
-- does not exist, and nothing on screen would say so.
--
-- So the workspace id gets its OWN column, and the link to a client is a row
-- in a mapping table that a person creates deliberately. Until somebody makes
-- that link the spend is real, visible, and honestly labelled "not mapped to a
-- client yet" — which is a state the screen can show and a person can fix,
-- rather than a wrong answer nobody can see.
--
-- The same reasoning is why `platform_feature` is free text and NOT folded
-- into the existing `feature` column: that column has a check constraint of
-- twelve console-shaped values, and forcing 33 platform keys through it would
-- turn all of them into 'other'. Two questions, two columns.
-- ============================================================


-- ============================================================
-- 1. THE EVENT LOG — TWO NEW NULLABLE COLUMNS
-- ============================================================

alter table public.admin_usage_events
  -- The platform's workspace id. Deliberately NOT a foreign key: it points
  -- into a different database. Storing it raw is honest; pretending it
  -- references admin_clients is not.
  add column if not exists workspace_id uuid,
  -- The platform's own feature key, e.g. 'content.generate', 'audit.run'.
  -- Free text on purpose — see the note above.
  add column if not exists platform_feature text;

-- Reading "what did this workspace cost us" must not scan the whole table.
create index if not exists admin_usage_events_workspace_idx
  on public.admin_usage_events (workspace_id, ts desc)
  where workspace_id is not null;

create index if not exists admin_usage_events_platform_feature_idx
  on public.admin_usage_events (platform_feature, ts desc)
  where platform_feature is not null;


-- ============================================================
-- 1b. "WE DO NOT KNOW" MUST BE EXPRESSIBLE FOR TOKENS TOO
-- ============================================================
-- Found on 6 Sep 2026 by seeding this table on a real Postgres and watching
-- the insert be REFUSED:
--
--     null value in column "input_tokens" violates not-null constraint
--
-- input_tokens, output_tokens and the three cache columns have been
-- `not null default 0` since 0001. 0024 wrote a rule at the top of itself —
-- "a cost we cannot work out honestly is NULL... it is never 0. Zero is a
-- real answer meaning the call was free" — and then applied that rule only to
-- cost_micros. The token columns kept the old shape and nobody noticed,
-- because until today nothing had ever tried to write a call whose token
-- count was genuinely unknown.
--
-- Now something does. A SerpApi search and a Firecrawl render are real money
-- with no tokens at all. A streamed answer has no usage object to read. A
-- provider that returns 200 with no `usage` key happens. Under the old shape
-- every one of those is stored as 0 input / 0 output — which on the AI Cost
-- page is indistinguishable from a call that was free, and there is no way to
-- tell the two apart afterwards, ever.
--
-- So: the columns become nullable, and their defaults are dropped.
--
-- DROPPING THE DEFAULT IS THE HALF THAT MATTERS. Leaving `default 0` in place
-- would mean a writer that simply omits the column still records "free"
-- rather than "unknown", which is the same bug wearing a different hat.
--
-- This is a WIDENING. Every existing row keeps its value, and every existing
-- writer — recordAiUsage() and api/usage-ingest.js both send all five
-- explicitly — carries on unchanged. Nothing that reads them breaks either;
-- what changes is that a reader can now tell "nothing was spent" from "we
-- could not see what was spent", which is the entire point.

alter table public.admin_usage_events
  alter column input_tokens          drop not null,
  alter column output_tokens         drop not null,
  alter column cache_write_tokens    drop not null,
  alter column cache_write_1h_tokens drop not null,
  alter column cache_read_tokens     drop not null;

-- AND cost_usd, WHICH IS THE ONE THAT WOULD HAVE TAKEN THE ENDPOINT DOWN.
--
-- api/usage-ingest.js has written `cost_usd: costMicros === null ? null : ...`
-- since 28 Aug 2026, and cost_usd is `not null default 0`. So the FIRST batch
-- containing a single unpriced model — a model with no price row for that day,
-- which is every non-Anthropic provider today — would have been refused whole
-- by the database and returned a 500. Not the one event: the entire batch of
-- up to 500.
--
-- It had never fired because nothing had ever posted to that endpoint. The
-- day the platform started sending, it would have looked like the meter was
-- broken; the meter would have been fine and this column would have been the
-- reason. Found by running a real event through the real endpoint into a real
-- Postgres, which is the only place a seam like this shows up.
alter table public.admin_usage_events
  alter column cost_usd drop not null,
  alter column cost_usd drop default;

alter table public.admin_usage_events
  alter column input_tokens          drop default,
  alter column output_tokens         drop default,
  alter column cache_write_tokens    drop default,
  alter column cache_write_1h_tokens drop default,
  alter column cache_read_tokens     drop default;


-- ============================================================
-- 2. THE MAPPING — WORKSPACE -> CLIENT
-- ============================================================
-- One row per platform workspace we have ever seen spend money.
--
-- Rows are created by /api/usage-ingest the first time a workspace appears,
-- with client_id NULL. That is the point: the console cannot guess the link,
-- but it CAN show you every workspace that is spending and is not yet
-- attached to anybody, so the gap is a short list on a screen instead of an
-- absence nobody notices.

create table if not exists public.admin_platform_workspaces (
  workspace_id  uuid primary key,

  -- Null = we have not said whose this is yet. On delete set null, never
  -- cascade: deleting a client must not delete the evidence that a workspace
  -- spent money. The same choice 0024 made for admin_usage_events.
  client_id     uuid references public.admin_clients on delete set null,

  -- Whatever we know to call it. Filled in by hand; the platform does not
  -- send a name.
  label         text,

  -- Bookkeeping about the mapping itself, so "who decided this, and when" is
  -- answerable later.
  mapped_by     uuid references auth.users on delete set null,
  mapped_at     timestamptz,

  -- Seen-window, maintained by the ingest endpoint. `first_seen_at` is how you
  -- tell a workspace that started spending yesterday from one that always has.
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),

  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists admin_platform_workspaces_client_idx
  on public.admin_platform_workspaces (client_id);

-- Unmapped-first is the order the screen wants: the whole job of that screen
-- is to empty this list.
create index if not exists admin_platform_workspaces_unmapped_idx
  on public.admin_platform_workspaces (last_seen_at desc)
  where client_id is null;


-- ============================================================
-- 3. WHO MAY SEE IT
-- ============================================================
-- Money is owner/admin only, exactly like the rest of Finance. A sales rep
-- has no business reading what the agency spends. 0029 shipped a migration
-- that gated an admin-only table on admin_is_member() and handed reps read
-- and write through a side door; the lesson written down at the time was
-- COUNT THE DOORS. There are two here — select and write — and both are
-- admin.

alter table public.admin_platform_workspaces enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'admin_platform_workspaces'
      and policyname = 'admins read platform workspaces'
  ) then
    create policy "admins read platform workspaces"
      on public.admin_platform_workspaces
      for select using (public.admin_is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'admin_platform_workspaces'
      and policyname = 'admins write platform workspaces'
  ) then
    create policy "admins write platform workspaces"
      on public.admin_platform_workspaces
      for all using (public.admin_is_admin()) with check (public.admin_is_admin());
  end if;
end $$;

-- The grants. This repo has lost a grant twice — once it broke every login
-- for an hour, once it broke a whole page — and both times the migration file
-- was right and the DATABASE was missing the grant. Stated explicitly, and
-- safe to re-run.
grant select, insert, update, delete on public.admin_platform_workspaces to authenticated;
grant usage on schema public to authenticated;


-- ============================================================
-- 4. THE COST OF SERVING ONE CLIENT
-- ============================================================
-- Everything needed to answer "what does this client cost us in AI" has
-- existed in pieces since 0024 and has never been joined up. This view does
-- the join once, in one place, so three screens cannot each invent their own
-- slightly different version of the number.
--
-- TWO ROADS TO A CLIENT, and the view keeps them apart:
--   direct   — a console call that already knew the client (client_id set)
--   mapped   — platform spend, reached through the workspace mapping
-- A screen that cannot tell those apart cannot explain its own total, and
-- "where did this figure come from" is the first question anybody asks.
--
-- PRECEDENCE, STATED: when a row carries BOTH its own client_id and a
-- workspace mapped to a DIFFERENT client, the row's own client_id wins. It was
-- written by the code that made the call and knows whose work it was; the
-- mapping is a person's later guess about a whole workspace.
-- lib/client-economics.js applies the same rule and additionally COUNTS the
-- disagreements, which is the part that stops a wrong mapping surviving.
--
-- THIS VIEW IS NOT WHAT THE SCREENS READ. lib/client-economics.js is, because
-- the page needs revenue and expenses on the same rows and cut to the same
-- window, which a view over one table cannot do. The view is kept for SQL-side
-- work and for the tests, and it differs from the JS in one way worth knowing:
-- it does NOT drop `billable = false` rows, so its totals can be higher. Use
-- one or the other for a given number, never both.
--
-- UNPRICED CALLS ARE COUNTED SEPARATELY AND NEVER AS ZERO. A row whose model
-- has no price on that day has cost_micros NULL. sum() ignores nulls, so the
-- money total stays honest, and `unpriced_calls` is what the screen prints
-- next to it so nobody reads a small number as a cheap month.

-- `security_invoker = true` IS LOAD-BEARING. See the note under the second
-- view — without it this hands every sales rep the whole agency's AI spend.
create or replace view public.admin_client_ai_cost
with (security_invoker = true) as
select
  coalesce(e.client_id, w.client_id)                             as client_id,
  case when e.client_id is not null then 'direct' else 'mapped' end as attribution,
  e.ts,
  e.provider,
  e.model,
  e.feature,
  e.platform_feature,
  e.workspace_id,
  e.status,
  e.billable,
  e.cost_micros,
  e.input_tokens,
  e.output_tokens,
  e.cache_read_tokens
from public.admin_usage_events e
left join public.admin_platform_workspaces w
  on w.workspace_id = e.workspace_id
where coalesce(e.client_id, w.client_id) is not null;

grant select on public.admin_client_ai_cost to authenticated;


-- ============================================================
-- 5. WHAT IS SPENDING AND BELONGS TO NOBODY
-- ============================================================
-- The screen this exists for. Unmapped workspaces, biggest spender first,
-- because that is the order in which fixing them is worth anything.

-- ------------------------------------------------------------------
-- `security_invoker = true` ON BOTH VIEWS, AND WHY.
--
-- The first draft of this file did not have it, and carried a comment
-- asserting the opposite: "a view runs as the caller, so admin_usage_events'
-- own RLS still applies". That is FALSE. A Postgres view runs with the
-- privileges of the role that OWNS it unless it is explicitly marked
-- security_invoker, so both views bypassed row-level security entirely.
--
-- It was caught by pointing a sales-rep session at them on a real Postgres:
-- the rep was correctly refused on the table and then read all the rows
-- straight back out through the view. The table was locked and the view was
-- a door standing open beside it — which is the same shape as the defect
-- 0029 shipped, and the reason the note written that day says COUNT THE
-- DOORS. There were three here: the table, and each view.
--
-- Do not remove these clauses. A test in tests/platform-usage/sql.sh reads
-- both views as a rep and fails if either returns a row.
-- ------------------------------------------------------------------
create or replace view public.admin_unmapped_workspace_spend
with (security_invoker = true) as
select
  w.workspace_id,
  w.label,
  w.first_seen_at,
  w.last_seen_at,
  count(e.id)                                as calls,
  sum(e.cost_micros)                         as cost_micros,
  /* count(e.id), NOT count(*).
   *
   * This is a LEFT JOIN, so a workspace with no events at all still produces
   * one null-padded row — and that row satisfies `e.cost_micros is null`.
   * With count(*) such a workspace reported `calls 0` beside
   * `unpriced_calls 1`: two contradictory facts on one line of a screen whose
   * whole job is being trustworthy about money. */
  count(e.id) filter (where e.cost_micros is null) as unpriced_calls,
  min(e.ts)                                  as first_call_at,
  max(e.ts)                                  as last_call_at
from public.admin_platform_workspaces w
left join public.admin_usage_events e on e.workspace_id = w.workspace_id
where w.client_id is null
group by w.workspace_id, w.label, w.first_seen_at, w.last_seen_at;

grant select on public.admin_unmapped_workspace_spend to authenticated;
