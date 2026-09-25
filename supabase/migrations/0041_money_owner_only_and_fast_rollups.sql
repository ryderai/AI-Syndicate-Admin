-- ============================================================================
-- 0041 — MONEY IS OWNERS ONLY, AND THE TWO MONEY PAGES STOP DOWNLOADING
--        EVERY ROW. 24 Sep 2026.
--
-- Ryder, 24 Sep 2026: "gate the finances page from admin and only to owner …
-- only me andrew and cj should be owners and have access. julia and cameron
-- cannot see this." And: "the loading for these pages is way too long."
--
-- Four things, all safe to run more than once:
--
--   1. Every money table becomes OWNER-only at the database. Until now they
--      were admin_is_admin() (owner OR admin), so an admin could read every
--      invoice and every cost straight out of the browser even with the menu
--      item hidden. A hidden button is not a lock; this is the lock.
--
--   2. admin_finance_departments — which side of the business a Stripe
--      customer belongs to (platform or agency), for the few the automatic
--      rule gets wrong. Plus admin_expenses.department.
--
--   3. admin_ai_cost_rollup(from, to) — the AI usage log, GROUPED IN THE
--      DATABASE. The pages used to pull all 51,230 rows (measured 24 Sep)
--      into the browser 1,000 at a time, one request after another: 20–30
--      seconds, and past the 50,000-row cap the totals were silently short.
--      This returns a few hundred grouped rows in well under a second.
--
--   4. admin_credit_rollup(from, to) — plan-token (credit) use per platform
--      workspace, from the platform's own plan_token_ledger, which lives in
--      this same database.
--
-- Both functions are SECURITY DEFINER and check admin_is_owner() themselves,
-- so they are exactly as locked as the tables. The server endpoint calls them
-- with the service key; if this file has not been run yet the endpoint falls
-- back to reading the rows itself (slower, still correct) — nothing breaks in
-- the meantime.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. OWNER-ONLY POLICIES ON EVERY MONEY TABLE
-- ---------------------------------------------------------------------------

-- Expenses
drop policy if exists "admins read expenses" on public.admin_expenses;
drop policy if exists "admins add expenses" on public.admin_expenses;
drop policy if exists "admins edit expenses" on public.admin_expenses;
drop policy if exists "owners read expenses" on public.admin_expenses;
drop policy if exists "owners add expenses" on public.admin_expenses;
drop policy if exists "owners edit expenses" on public.admin_expenses;
create policy "owners read expenses" on public.admin_expenses
  for select using (public.admin_is_owner());
create policy "owners add expenses" on public.admin_expenses
  for insert with check (public.admin_is_owner());
create policy "owners edit expenses" on public.admin_expenses
  for update using (public.admin_is_owner()) with check (public.admin_is_owner());
-- "owners remove expenses" (0007) is already owner-only and stays.

-- Invoices
drop policy if exists "admins read invoices" on public.admin_invoices;
drop policy if exists "admins add invoices" on public.admin_invoices;
drop policy if exists "admins edit invoices" on public.admin_invoices;
drop policy if exists "owners read invoices" on public.admin_invoices;
drop policy if exists "owners add invoices" on public.admin_invoices;
drop policy if exists "owners edit invoices" on public.admin_invoices;
create policy "owners read invoices" on public.admin_invoices
  for select using (public.admin_is_owner());
create policy "owners add invoices" on public.admin_invoices
  for insert with check (public.admin_is_owner());
create policy "owners edit invoices" on public.admin_invoices
  for update using (public.admin_is_owner()) with check (public.admin_is_owner());

-- Invoice lines
drop policy if exists "admins read invoice items" on public.admin_invoice_items;
drop policy if exists "admins write invoice items" on public.admin_invoice_items;
drop policy if exists "admins edit invoice items" on public.admin_invoice_items;
drop policy if exists "admins remove invoice items" on public.admin_invoice_items;
drop policy if exists "owners read invoice items" on public.admin_invoice_items;
drop policy if exists "owners write invoice items" on public.admin_invoice_items;
drop policy if exists "owners edit invoice items" on public.admin_invoice_items;
drop policy if exists "owners remove invoice items" on public.admin_invoice_items;
create policy "owners read invoice items" on public.admin_invoice_items
  for select using (public.admin_is_owner());
create policy "owners write invoice items" on public.admin_invoice_items
  for insert with check (public.admin_is_owner());
create policy "owners edit invoice items" on public.admin_invoice_items
  for update using (public.admin_is_owner()) with check (public.admin_is_owner());
create policy "owners remove invoice items" on public.admin_invoice_items
  for delete using (public.admin_is_owner());

-- Payments
drop policy if exists "admins read payments" on public.admin_invoice_payments;
drop policy if exists "admins add payments" on public.admin_invoice_payments;
drop policy if exists "owners read payments" on public.admin_invoice_payments;
drop policy if exists "owners add payments" on public.admin_invoice_payments;
create policy "owners read payments" on public.admin_invoice_payments
  for select using (public.admin_is_owner());
create policy "owners add payments" on public.admin_invoice_payments
  for insert with check (public.admin_is_owner());
-- "owners edit payments" / "owners remove payments" (0007) stay.

-- Finance settings (company details, bank balance)
drop policy if exists "admins read finance settings" on public.admin_finance_settings;
drop policy if exists "admins edit finance settings" on public.admin_finance_settings;
drop policy if exists "owners read finance settings" on public.admin_finance_settings;
drop policy if exists "owners edit finance settings" on public.admin_finance_settings;
create policy "owners read finance settings" on public.admin_finance_settings
  for select using (public.admin_is_owner());
create policy "owners edit finance settings" on public.admin_finance_settings
  for update using (public.admin_is_owner()) with check (public.admin_is_owner());

-- AI usage log, price book, provider bills
drop policy if exists "admins read usage" on public.admin_usage_events;
drop policy if exists "owners read usage" on public.admin_usage_events;
create policy "owners read usage" on public.admin_usage_events
  for select using (public.admin_is_owner());

drop policy if exists "admins read prices" on public.ai_model_prices;
drop policy if exists "owners read prices" on public.ai_model_prices;
create policy "owners read prices" on public.ai_model_prices
  for select to authenticated using (public.admin_is_owner());

drop policy if exists "admins read bills" on public.ai_provider_bills;
drop policy if exists "owners read bills" on public.ai_provider_bills;
create policy "owners read bills" on public.ai_provider_bills
  for select to authenticated using (public.admin_is_owner());

-- Platform workspace -> client links (the AI Cost page's mapping)
drop policy if exists "admins read platform workspaces" on public.admin_platform_workspaces;
drop policy if exists "admins write platform workspaces" on public.admin_platform_workspaces;
drop policy if exists "owners read platform workspaces" on public.admin_platform_workspaces;
drop policy if exists "owners write platform workspaces" on public.admin_platform_workspaces;
create policy "owners read platform workspaces" on public.admin_platform_workspaces
  for select using (public.admin_is_owner());
create policy "owners write platform workspaces" on public.admin_platform_workspaces
  for all using (public.admin_is_owner()) with check (public.admin_is_owner());
-- admin_client_ai_cost and admin_unmapped_workspace_spend are
-- security_invoker views (0032), so they now follow these policies too.

-- ---------------------------------------------------------------------------
-- 2. WHICH SIDE OF THE BUSINESS — platform or agency
-- ---------------------------------------------------------------------------
-- The automatic rule (api/finance-summary.js): a subscription payment is
-- PLATFORM, a one-off invoice is AGENCY. This table is only for the customers
-- that rule gets wrong. One row per Stripe customer; delete the row to go back
-- to the automatic rule.

create table if not exists public.admin_finance_departments (
  stripe_customer_id text primary key,
  department text not null check (department in ('platform', 'agency')),
  note text,
  set_by uuid references auth.users on delete set null default auth.uid(),
  set_at timestamptz not null default now()
);
comment on table public.admin_finance_departments is
  'Owner override: which side (platform or agency) a Stripe customer''s money counts on. No row = the automatic rule.';

alter table public.admin_finance_departments enable row level security;
grant select, insert, update, delete on public.admin_finance_departments to authenticated;
drop policy if exists "owners run departments" on public.admin_finance_departments;
create policy "owners run departments" on public.admin_finance_departments
  for all using (public.admin_is_owner()) with check (public.admin_is_owner());

-- Which side a typed cost belongs to. null = shared (rent, software used by
-- both sides) — it counts in the company total, and on neither side alone.
alter table public.admin_expenses
  add column if not exists department text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'admin_expenses_department_ck') then
    alter table public.admin_expenses add constraint admin_expenses_department_ck
      check (department is null or department in ('platform', 'agency'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. AI COST, GROUPED IN THE DATABASE
-- ---------------------------------------------------------------------------
-- One row per (day in Chicago, provider, model, workspace, client, job,
-- surface, status, source). `job` is the first label the row carries:
--   platform_feature (e.g. brand.scan)  → the platform's own job name
--   meta.feature_name                    → the tool that made the call
--   meta.entry                           → the endpoint or cron it ran under
--   feature (console)                    → "console · <feature>"
--   nothing at all                       → null (the page names these rows)
-- The platform began stamping feature_name / entry on EVERY call on
-- 23 Sep 2026 (commit b20d1134), so a null job is an older row.

-- RETURNS ONE jsonb VALUE, NOT A TABLE. PostgREST caps every response at
-- 1,000 rows (max-rows), set-returning functions included, and a grouped
-- month can pass 1,000 groups (day × model × account × job). A table result
-- would be cut short with no error — the very bug this migration removes. One
-- jsonb array is one "row", so nothing is cut. (Caught by the review pass,
-- 24 Sep 2026.)
--
-- NON-BILLABLE CALLS ARE NOT SPEND. lib/ai-cost.js and client-economics
-- always left `billable = false` rows out of the dollar total; this does the
-- same, and counts them separately.

drop function if exists public.admin_ai_cost_rollup(timestamptz, timestamptz);
create or replace function public.admin_ai_cost_rollup(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  -- The service key has no auth.uid(); it is only ever used by the server,
  -- which has already checked the caller is an owner.
  if coalesce(auth.role(), '') <> 'service_role' and not public.admin_is_owner() then
    raise exception 'owners only' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(g), '[]'::jsonb) into result
  from (
    select
      (e.ts at time zone 'America/Chicago')::date as day,
      e.provider as provider,
      e.model as model,
      e.workspace_id as workspace_id,
      e.client_id as client_id,
      coalesce(
        nullif(btrim(e.platform_feature), ''),
        nullif(btrim(e.meta->>'feature_name'), ''),
        nullif(btrim(e.meta->>'entry'), ''),
        case when e.feature is not null and e.feature <> 'other' then 'console · ' || e.feature end
      ) as job,
      e.surface as surface,
      e.status as status,
      e.source as source,
      count(*) as calls,
      count(e.cost_micros) filter (where e.billable) as priced_calls,
      coalesce(sum(e.cost_micros) filter (where e.billable), 0) as cost_micros,
      count(*) filter (where not e.billable) as nonbillable_calls,
      coalesce(sum(e.input_tokens), 0) as input_tokens,
      coalesce(sum(e.output_tokens), 0) as output_tokens,
      coalesce(sum(e.cache_read_tokens), 0) as cache_read_tokens,
      min(e.ts) as first_ts,
      max(e.ts) as last_ts
    from public.admin_usage_events e
    where e.ts >= p_from and e.ts < p_to
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9
  ) g;
  return result;
end;
$$;
revoke execute on function public.admin_ai_cost_rollup(timestamptz, timestamptz) from anon, public;
grant execute on function public.admin_ai_cost_rollup(timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. CREDITS (PLAN TOKENS) USED, PER WORKSPACE
-- ---------------------------------------------------------------------------
-- plan_token_ledger is the platform's table (platform migration 0126), in this
-- same database. A spend row carries a negative delta; shadow_spend is what a
-- workspace WOULD have been charged while enforcement is switched off. Both
-- are use. Refunds come back positive.

do $$
begin
  if to_regclass('public.plan_token_ledger') is not null then
    execute 'drop function if exists public.admin_credit_rollup(timestamptz, timestamptz)';
    execute $f$
      create or replace function public.admin_credit_rollup(p_from timestamptz, p_to timestamptz)
      returns jsonb
      language plpgsql stable security definer set search_path = public as $b$
      declare
        result jsonb;
      begin
        if coalesce(auth.role(), '') <> 'service_role' and not public.admin_is_owner() then
          raise exception 'owners only' using errcode = '42501';
        end if;
        select coalesce(jsonb_agg(g), '[]'::jsonb) into result
        from (
          select l.workspace_id::text as workspace_id, l.feature::text as feature,
            coalesce(sum(case when l.reason in ('spend', 'shadow_spend') then -l.delta else 0 end), 0) as spent,
            coalesce(sum(case when l.reason = 'refund' then l.delta else 0 end), 0) as refunded,
            count(*) filter (where l.reason in ('spend', 'shadow_spend')) as spends
          from public.plan_token_ledger l
          where l.created_at >= p_from and l.created_at < p_to
            and l.reason in ('spend', 'shadow_spend', 'refund')
          group by 1, 2
        ) g;
        return result;
      end;
      $b$;
    $f$;
    execute 'revoke execute on function public.admin_credit_rollup(timestamptz, timestamptz) from anon, public';
    execute 'grant execute on function public.admin_credit_rollup(timestamptz, timestamptz) to authenticated, service_role';
  end if;
end $$;

-- Ask PostgREST to pick up the two new functions straight away.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- CHECK — run after, expect: 0 rows where an admin-level money policy remains.
-- ---------------------------------------------------------------------------
-- select tablename, policyname from pg_policies
--  where tablename in ('admin_expenses','admin_invoices','admin_invoice_items',
--    'admin_invoice_payments','admin_finance_settings','admin_usage_events',
--    'ai_model_prices','ai_provider_bills','admin_platform_workspaces')
--    and policyname like 'admins %';
