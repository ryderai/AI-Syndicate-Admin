drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade; create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid());
do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$;
grant usage on schema public to authenticated;
create table public.admin_users (user_id uuid primary key, role text, active boolean default true, created_at timestamptz default now());
create table public.admin_leads (
  id uuid primary key default gen_random_uuid(),
  name text, company text, owner_id uuid references auth.users,
  stage text not null default 'new',
  next_follow_up_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.admin_leads add constraint admin_leads_stage_check check (stage in (
  'new','researching','contacted','in_conversation','follow_up',
  'meeting','proposal','won','lost','reopened','not_a_fit'));
create table public.admin_lead_activity (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.admin_leads on delete cascade,
  actor uuid, type text, outcome text, body text,
  created_at timestamptz not null default now()
);
