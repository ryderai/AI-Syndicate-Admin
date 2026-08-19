-- AI Syndicate ADMIN console — the shared team inbox.
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Run 0001_admin_init.sql and 0002_work_page.sql FIRST. This builds on both.
--   * Everything new is prefixed admin_. Nothing on the platform is touched.
--   * Run this whole file once in the Supabase SQL editor.
--
-- What this adds, in plain words:
--
--   1. A mailbox can be SHARED. One person connects growth@aisyndicate.com and
--      every owner/admin works the same mail. Sales never sees a shared mailbox.
--      The refresh token stays unreadable from the browser (column grants), so
--      "shared" means shared through our own server, never shared credentials.
--
--   2. Every email thread can carry a status, a client, a person, a priority,
--      and notes — admin_email_threads. Gmail has no idea what "waiting on them"
--      means, so we keep that ourselves.
--
--   3. Reminders and notes can now point at an email (link_type 'email'), so
--      "chase Dana on Thursday" is a real dated row, not a memory.

-- ============================================================
-- 1. SHARED MAILBOXES
-- ============================================================

alter table public.admin_gmail_accounts
  add column if not exists shared boolean not null default false;
alter table public.admin_gmail_accounts
  add column if not exists display_name text;
alter table public.admin_gmail_accounts
  add column if not exists last_synced_at timestamptz;

comment on column public.admin_gmail_accounts.shared is
  'true = every owner/admin in the console may read and send from this mailbox (a team address like growth@). false = private to the person who connected it.';

-- Column-level select, same as 0001: the browser may list mailboxes but can
-- NEVER read refresh_token. New columns need their own grant — a grant on a
-- table's columns does not stretch to columns added later.
grant select (user_id, email_address, scope, connected_at, shared, display_name, last_synced_at)
  on public.admin_gmail_accounts to authenticated;

-- Reading a SHARED mailbox row is open to owner/admin. This is the row only —
-- refresh_token is still ungranted, so the token itself never leaves the server.
-- Toggling `shared` happens server-side (PATCH /api/gmail-accounts, service
-- role); there is deliberately no update grant for the browser.
drop policy if exists "shared gmail read" on public.admin_gmail_accounts;
create policy "shared gmail read" on public.admin_gmail_accounts
  for select using (shared and public.admin_is_admin());

-- ============================================================
-- 2. EMAIL THREADS — our own bookkeeping on top of Gmail
-- ============================================================
-- One row per Gmail thread we have touched. Threads nobody has touched have no
-- row at all and read as status 'new' in the UI, so connecting a busy mailbox
-- does not write thousands of rows on the first load.
--
-- subject / from / snippet / last_message_at are CACHED copies of what Gmail
-- said. They exist so the Done and Waiting views can render a list without
-- calling Gmail — an archived thread is not in the inbox listing any more, but
-- it is still ours to track. Opening a thread always re-reads Gmail, so the
-- cache is never what anyone replies to.

create table if not exists public.admin_email_threads (
  id uuid primary key default gen_random_uuid(),
  mailbox text not null,                       -- which connected address this thread lives in
  thread_id text not null,                     -- Gmail's own thread id
  status text not null default 'new'
    check (status in ('new','needs_reply','waiting','scheduled','done','ignored')),
  client_id uuid references public.admin_clients on delete set null,
  lead_id uuid references public.admin_leads on delete set null,
  assigned_to uuid references auth.users on delete set null,
  priority text not null default 'normal' check (priority in ('high','normal','low')),
  -- cached from Gmail
  subject text,
  from_name text,
  from_email text,
  snippet text,
  last_message_at timestamptz,
  message_count int not null default 1,
  last_direction text check (last_direction in ('in','out')),
  -- ours
  notes text,
  status_changed_at timestamptz not null default now(),
  status_changed_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (mailbox, thread_id)
);

-- The three reads the page actually does.
create index if not exists admin_email_threads_box_idx
  on public.admin_email_threads(mailbox, status, last_message_at desc);
create index if not exists admin_email_threads_client_idx
  on public.admin_email_threads(client_id) where client_id is not null;
create index if not exists admin_email_threads_person_idx
  on public.admin_email_threads(assigned_to, status) where assigned_to is not null;

drop trigger if exists admin_email_threads_updated_at on public.admin_email_threads;
create trigger admin_email_threads_updated_at before update on public.admin_email_threads
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 3. REMINDERS + NOTES CAN POINT AT AN EMAIL
-- ============================================================
-- The original checks in 0001/0002 listed four link types. Both are replaced
-- here with the same list plus 'email'. Named constraints so a re-run is safe.
-- NULL stayed allowed in the original (an unlisted value fails, NULL does not),
-- so "link_type is null or ..." keeps the behaviour identical.

alter table public.admin_notes drop constraint if exists admin_notes_link_type_check;
alter table public.admin_notes add constraint admin_notes_link_type_check
  check (link_type is null or link_type in ('client','lead','task','ticket','email'));

alter table public.admin_reminders drop constraint if exists admin_reminders_link_type_check;
alter table public.admin_reminders add constraint admin_reminders_link_type_check
  check (link_type is null or link_type in ('client','lead','task','ticket','email'));

-- ============================================================
-- 4. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Same shape as tickets in 0001: admins only. Sales has no business in client
-- mail, and the shared mailbox read policy above already excludes them.

grant select, insert, update, delete on public.admin_email_threads to authenticated;

alter table public.admin_email_threads enable row level security;

drop policy if exists "admins all email threads" on public.admin_email_threads;
create policy "admins all email threads" on public.admin_email_threads
  for all using (public.admin_is_admin()) with check (public.admin_is_admin());

-- ============================================================
-- 5. AFTER RUNNING THIS
-- ============================================================
--   1. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (SETUP.md § Gmail).
--   2. Sign in to the console as an owner, open Inbox, click Connect a mailbox,
--      and pick growth@aisyndicate.com on Google's screen.
--   3. Back in the console, switch that mailbox's "Shared with the team" on.
--      That is the only step that makes it visible to the other owners/admins.
