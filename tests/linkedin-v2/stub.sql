-- The bits of Supabase + earlier migrations that 0048-0053 lean on. Test only.
drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade; create schema auth;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
grant usage on schema public to authenticated, anon, service_role;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create extension if not exists pgcrypto;
create table public.admin_clients (id uuid primary key default gen_random_uuid(), name text);
create or replace function public.admin_is_admin() returns boolean language sql stable as $$ select coalesce(current_setting('test.admin', true), 'no') = 'yes' $$;
create or replace function public.admin_set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop schema if exists storage cascade; create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
