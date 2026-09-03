drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade; create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid());
-- 0031 re-asserts a grant, so the role has to exist here.
do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$;
create table public.admin_reminders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null, body text not null, due_at timestamptz not null,
  done_at timestamptz, link_type text, link_id uuid, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- the state 0006 left behind
alter table public.admin_reminders add constraint admin_reminders_link_type_check
  check (link_type in ('client','lead','task','ticket','note'));
insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');
