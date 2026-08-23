-- ============================================================
-- 0010 — SAVED OVERVIEW GENERATOR OUTPUT
-- ============================================================
-- Aug 23 2026. The Overview page gained a box: you type what you want, it reads
-- the whole console and writes it. Every press writes a row here.
--
-- Append-only, exactly like admin_client_reports (0008) and for the same
-- reason: what we told ourselves last Tuesday is worth keeping even when this
-- Tuesday's version disagrees. There is no update policy. Delete is allowed,
-- because a bad draft is noise and nobody should have to keep it.
--
-- Safe to run twice. It only creates admin_-prefixed objects, and every
-- statement is guarded.

create table if not exists public.admin_console_reports (
  id uuid primary key default gen_random_uuid(),

  -- What was asked for, verbatim. This is the whole point of keeping the row:
  -- a good prompt is worth re-running, and a bad answer is usually a bad ask.
  instruction text,
  preset text,                                -- which button seeded the box, if any

  -- 'records' = the strict gate ran: every number had to appear in the counts,
  -- and a draft that invented one was thrown away. Safe to forward.
  -- 'free'    = a draft. Numbers were NOT checked. Never forward it unread.
  mode text not null default 'records'
    check (mode in ('records', 'free')),

  title text not null default 'Overview',
  summary text not null default '',            -- the 30-second version
  body text not null default '',               -- the full version
  watch text,                                  -- anything in the rows that looks wrong
  cannot_check text,                           -- what the records cannot answer

  -- 'written' = the AI worded it. 'counted' = plain code did, because there is
  -- no AI key, or the AI refused, or its answer failed the check.
  source text not null default 'counted'
    check (source in ('written', 'counted')),
  rejected_why text,                           -- why a draft was thrown away

  -- The counted figures behind the answer, so a person can audit it later
  -- without re-reading the whole console. Kept small on purpose: counts and the
  -- cannot-answer list, never the row bodies.
  facts jsonb,
  counts_at timestamptz,

  created_by uuid references auth.users on delete set null default auth.uid(),
  created_by_email text,
  created_at timestamptz not null default now()
);

-- Re-running this file must actually widen the constraints, not skip them.
-- Migration 0006 taught us that the hard way: a `create table if not exists`
-- leaves an older check in place for ever, and a button fails silently for a
-- day. So the checks are dropped and re-added every run.
alter table public.admin_console_reports drop constraint if exists admin_console_reports_mode_check;
alter table public.admin_console_reports
  add constraint admin_console_reports_mode_check
  check (mode in ('records', 'free'));

alter table public.admin_console_reports drop constraint if exists admin_console_reports_source_check;
alter table public.admin_console_reports
  add constraint admin_console_reports_source_check
  check (source in ('written', 'counted'));

-- Newest first is the only way this table is ever read.
create index if not exists admin_console_reports_created_idx
  on public.admin_console_reports (created_at desc);
-- And "show me mine" on a shared console.
create index if not exists admin_console_reports_author_idx
  on public.admin_console_reports (created_by, created_at desc);

-- ---- who can touch it -------------------------------------------------
-- Owner and admin only. This row can contain a summary of every client, every
-- lead and every invoice in one place, so a sales rep must not be able to read
-- one — the whole point of the role scoping in lib/brain-context.js would be
-- undone by a saved report that had already crossed the line.

alter table public.admin_console_reports enable row level security;

grant select, insert, delete on public.admin_console_reports to authenticated;

drop policy if exists admin_console_reports_read on public.admin_console_reports;
create policy admin_console_reports_read on public.admin_console_reports
  for select to authenticated using (public.admin_is_admin());

drop policy if exists admin_console_reports_write on public.admin_console_reports;
create policy admin_console_reports_write on public.admin_console_reports
  for insert to authenticated with check (public.admin_is_admin());

drop policy if exists admin_console_reports_delete on public.admin_console_reports;
create policy admin_console_reports_delete on public.admin_console_reports
  for delete to authenticated using (public.admin_is_admin());

-- No update policy, on purpose. A saved answer is a record of what we believed
-- at a moment. Correcting it means generating a new one.
