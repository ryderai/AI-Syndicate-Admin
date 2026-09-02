drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade; create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid());
do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$;
grant usage on schema public to authenticated;
-- who am I, for the test
create table public.whoami (uid uuid, role text);
grant select on public.whoami to authenticated;
create or replace function auth.uid() returns uuid language sql stable as $$ select uid from public.whoami limit 1 $$;
create or replace function public.admin_is_member() returns boolean language sql stable as $$ select exists(select 1 from public.whoami) $$;
create or replace function public.admin_is_admin() returns boolean language sql stable as $$ select exists(select 1 from public.whoami where role in ('owner','admin')) $$;
create or replace function public.admin_is_owner() returns boolean language sql stable as $$ select exists(select 1 from public.whoami where role = 'owner') $$;
create table public.admin_clients (id uuid primary key default gen_random_uuid(), name text);
create table public.admin_tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.admin_clients on delete cascade,
  name text not null,
  status text not null default 'todo' check (status in ('todo','in_progress','done','blocked')),
  assigned_to uuid references auth.users,
  latest_report text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.admin_tasks to authenticated;
alter table public.admin_tasks enable row level security;
create policy "admins all tasks" on public.admin_tasks for all using (public.admin_is_admin()) with check (public.admin_is_admin());
