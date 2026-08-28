-- ALL ADMIN CONSOLE MIGRATIONS, 0001 through 0023, in order.
-- Built Fri Aug 28 2026. Paste this whole file into Supabase SQL Editor and press Run.
-- Safe to run more than once: every statement is guarded.


-- ============================================================
-- 0001_admin_init.sql
-- ============================================================
-- AI Syndicate ADMIN console — initial schema.
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Every object is new and prefixed admin_ — nothing existing is altered.
--   * Platform customers get NO access: every policy checks membership in
--     admin_users first. A customer signing in at admin.aisyndicate.com
--     authenticates fine but sees zero rows and the app shows "not authorized".
--   * Run this whole file once in the Supabase SQL editor.
--
-- Roles:
--   owner / admin  → everything
--   sales          → leads pages only (enforced here in RLS, mirrored in the UI)

-- ============================================================
-- 0. HELPERS
-- ============================================================

-- Console-owned trigger helper. Deliberately NOT the platform's
-- set_updated_at() — the shared project's existing function is left
-- untouched.
create or replace function public.admin_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- (membership helper functions are created in section 1, after admin_users exists)

-- ============================================================
-- 1. TEAM (allow-list + roles)
-- ============================================================

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'admin' check (role in ('owner','admin','sales')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists admin_users_updated_at on public.admin_users;
create trigger admin_users_updated_at before update on public.admin_users
  for each row execute function public.admin_set_updated_at();

-- Membership helpers — created here because their SQL bodies reference
-- admin_users (Postgres validates function bodies at creation time).
create or replace function public.admin_is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users au
    where au.user_id = auth.uid() and au.active
  );
$$;

create or replace function public.admin_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users au
    where au.user_id = auth.uid() and au.active and au.role in ('owner','admin')
  );
$$;

revoke execute on function public.admin_is_member() from anon, public;
revoke execute on function public.admin_is_admin() from anon, public;
grant execute on function public.admin_is_member() to authenticated;
grant execute on function public.admin_is_admin() to authenticated;

create or replace function public.admin_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users au
    where au.user_id = auth.uid() and au.active and au.role = 'owner'
  );
$$;
revoke execute on function public.admin_is_owner() from anon, public;
grant execute on function public.admin_is_owner() to authenticated;

-- Pending invites (row created by /api/invite before the person accepts).
create table if not exists public.admin_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role text not null default 'sales' check (role in ('owner','admin','sales')),
  invited_by uuid references auth.users,
  status text not null default 'sent' check (status in ('sent','accepted','revoked')),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2. OPERATIONS (the Notion replacement)
-- ============================================================

create table if not exists public.admin_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text,
  stage text not null default 'Onboarding',          -- Onboarding / Week 1..8 / Ongoing / Holding / Closed
  status text not null default 'active' check (status in ('active','holding','prospect','closed')),
  vertical text,
  start_date date,
  contact_name text,
  contact_email text,
  contact_phone text,
  notes text,
  links jsonb not null default '{}'::jsonb,           -- {"site":"...","notion":"...","bitwarden":"..."}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.admin_clients on delete cascade,
  name text not null,
  status text not null default 'todo' check (status in ('todo','in_progress','done','blocked')),
  category text,                                      -- Access / Technical / Content / Reporting / ...
  priority text not null default 'medium' check (priority in ('high','medium','low')),
  phase text,                                         -- Onboarding / Month 1-3 / Ongoing
  assigned_to uuid references auth.users,
  due_date date,
  latest_report text,                                 -- 1-3 sentence summary shown in the table
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_weekly_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.admin_clients on delete cascade,
  week_no int not null,
  target_date date,
  week_status text not null default 'not_logged' check (week_status in ('not_logged','in_progress','complete','complete_late')),
  readiness text not null default 'draft' check (readiness in ('draft','verified','client_ready')),
  what_we_did text,
  what_moved text,
  whats_next text,
  talking_points text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_tasks_client_idx on public.admin_tasks(client_id, status);
create index if not exists admin_weekly_client_idx on public.admin_weekly_log(client_id, week_no);

drop trigger if exists admin_clients_updated_at on public.admin_clients;
create trigger admin_clients_updated_at before update on public.admin_clients
  for each row execute function public.admin_set_updated_at();
drop trigger if exists admin_tasks_updated_at on public.admin_tasks;
create trigger admin_tasks_updated_at before update on public.admin_tasks
  for each row execute function public.admin_set_updated_at();
drop trigger if exists admin_weekly_updated_at on public.admin_weekly_log;
create trigger admin_weekly_updated_at before update on public.admin_weekly_log
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 3. LEADS + SALES ACTIVITY
-- ============================================================

create table if not exists public.admin_leads (
  id uuid primary key default gen_random_uuid(),
  name text,
  company text,
  domain text,
  email text,
  phone text,
  city text,
  state text,
  vertical text,
  source text not null default 'manual' check (source in ('platform','csv','manual','referral','inbound')),
  stage text not null default 'new' check (stage in ('new','contacted','follow_up','meeting','proposal','won','lost')),
  owner_id uuid references auth.users,                -- the sales rep working it
  score int,                                          -- optional fit score 0-100
  notes text,
  became_customer boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz
);

create table if not exists public.admin_lead_activity (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.admin_leads on delete cascade,
  actor uuid not null references auth.users,
  type text not null check (type in ('call','email','text','note','status_change','assigned')),
  outcome text,                                       -- no_answer / voicemail / talked / booked / ...
  body text,
  created_at timestamptz not null default now()
);

create index if not exists admin_leads_stage_idx on public.admin_leads(stage, owner_id);
create index if not exists admin_leads_email_idx on public.admin_leads(lower(email)) where email is not null;
create index if not exists admin_lead_activity_idx on public.admin_lead_activity(lead_id, created_at desc);

drop trigger if exists admin_leads_updated_at on public.admin_leads;
create trigger admin_leads_updated_at before update on public.admin_leads
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 4. TICKETS (internal support desk)
-- ============================================================

create table if not exists public.admin_tickets (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  requester_name text,
  requester_email text,
  status text not null default 'open' check (status in ('open','pending','solved','closed')),
  priority text not null default 'normal' check (priority in ('urgent','high','normal','low')),
  source text not null default 'manual' check (source in ('manual','email','platform','api')),
  assigned_to uuid references auth.users,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.admin_tickets on delete cascade,
  author_kind text not null default 'agent' check (author_kind in ('agent','requester','ai_draft')),
  author uuid references auth.users,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists admin_tickets_status_idx on public.admin_tickets(status, updated_at desc);
create index if not exists admin_ticket_msgs_idx on public.admin_ticket_messages(ticket_id, created_at);

drop trigger if exists admin_tickets_updated_at on public.admin_tickets;
create trigger admin_tickets_updated_at before update on public.admin_tickets
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 5. AI BRAIN (editable knowledge the AI endpoints read)
-- ============================================================

create table if not exists public.admin_brain (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'fact' check (kind in ('rule','fact','voice','snippet')),
  title text not null,
  body text not null,
  enabled boolean not null default true,
  updated_by uuid references auth.users,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists admin_brain_updated_at on public.admin_brain;
create trigger admin_brain_updated_at before update on public.admin_brain
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 6. TOKEN / USAGE EVENTS (fed by the platform backend)
-- ============================================================
-- POST /api/usage-ingest with header  x-ingest-key: $USAGE_INGEST_KEY
-- body: { events: [{ ts, source, model, input_tokens, output_tokens, cost_usd, meta }] }

create table if not exists public.admin_usage_events (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  source text not null default 'platform',            -- platform / caite / audits / admin
  model text,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd numeric(12,6) not null default 0,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_usage_ts_idx on public.admin_usage_events(ts desc);

-- ============================================================
-- 7. GMAIL CONNECTIONS (per admin user) + OAUTH STATES
-- ============================================================

create table if not exists public.admin_gmail_accounts (
  user_id uuid not null references auth.users on delete cascade,
  email_address text not null,
  refresh_token text not null,
  scope text,
  connected_at timestamptz not null default now(),
  primary key (user_id, email_address)
);

create table if not exists public.admin_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users on delete cascade,
  purpose text not null default 'gmail',
  created_at timestamptz not null default now()
);

-- ============================================================
-- 8. ACTIVITY LOG (what happened in the console, for the feed)
-- ============================================================

create table if not exists public.admin_activity_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references auth.users,
  kind text not null,                                 -- lead_call / task_done / client_added / ...
  title text not null,
  body text,
  created_at timestamptz not null default now()
);

create index if not exists admin_activity_idx on public.admin_activity_log(created_at desc);

-- ============================================================
-- 9. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Matches the platform's opt-in pattern: explicit grants per table,
-- RLS filters rows, anon gets nothing.

grant usage on schema public to anon, authenticated;

grant select on public.admin_users to authenticated;
grant update on public.admin_users to authenticated;
grant select, insert, update, delete on public.admin_clients to authenticated;
grant select, insert, update, delete on public.admin_tasks to authenticated;
grant select, insert, update, delete on public.admin_weekly_log to authenticated;
grant select, insert, update, delete on public.admin_leads to authenticated;
grant select, insert on public.admin_lead_activity to authenticated;
grant select, insert, update, delete on public.admin_tickets to authenticated;
grant select, insert on public.admin_ticket_messages to authenticated;
grant select, insert, update, delete on public.admin_brain to authenticated;
grant select on public.admin_usage_events to authenticated;
-- Column-level select: the browser may list its own connections but can
-- NEVER read refresh_token — only the server (service role) touches tokens.
grant select (user_id, email_address, scope, connected_at) on public.admin_gmail_accounts to authenticated;
grant delete on public.admin_gmail_accounts to authenticated;
grant select, insert on public.admin_activity_log to authenticated;
grant select on public.admin_invites to authenticated;

alter table public.admin_users enable row level security;
alter table public.admin_invites enable row level security;
alter table public.admin_clients enable row level security;
alter table public.admin_tasks enable row level security;
alter table public.admin_weekly_log enable row level security;
alter table public.admin_leads enable row level security;
alter table public.admin_lead_activity enable row level security;
alter table public.admin_tickets enable row level security;
alter table public.admin_ticket_messages enable row level security;
alter table public.admin_brain enable row level security;
alter table public.admin_usage_events enable row level security;
alter table public.admin_gmail_accounts enable row level security;
alter table public.admin_oauth_states enable row level security;
alter table public.admin_activity_log enable row level security;

-- admin_users: any member can read the roster (names are needed for
-- assignment pickers); only admins can change it. Inserts happen
-- server-side via /api/invite (service role).
drop policy if exists "members read roster" on public.admin_users;
create policy "members read roster" on public.admin_users
  for select using (public.admin_is_member());
drop policy if exists "admins update roster" on public.admin_users;
create policy "admins update roster" on public.admin_users
  for update
  using (public.admin_is_owner() or (public.admin_is_admin() and role <> 'owner'))
  with check (public.admin_is_owner() or (public.admin_is_admin() and role <> 'owner'));
-- ^ admins can manage admin/sales rows but can neither touch an owner's row
--   nor set anyone (including themselves) to owner. Owners can do both.

drop policy if exists "admins read invites" on public.admin_invites;
create policy "admins read invites" on public.admin_invites
  for select using (public.admin_is_admin());

-- Operations: admins only (sales reps have no business in client ops).
drop policy if exists "admins all clients" on public.admin_clients;
create policy "admins all clients" on public.admin_clients
  for all using (public.admin_is_admin()) with check (public.admin_is_admin());
drop policy if exists "admins all tasks" on public.admin_tasks;
create policy "admins all tasks" on public.admin_tasks
  for all using (public.admin_is_admin()) with check (public.admin_is_admin());
drop policy if exists "admins all weekly" on public.admin_weekly_log;
create policy "admins all weekly" on public.admin_weekly_log
  for all using (public.admin_is_admin()) with check (public.admin_is_admin());

-- Leads: every active member (sales included) reads and works leads.
-- Deleting is admin-only.
drop policy if exists "members read leads" on public.admin_leads;
create policy "members read leads" on public.admin_leads
  for select using (public.admin_is_member());
drop policy if exists "members insert leads" on public.admin_leads;
create policy "members insert leads" on public.admin_leads
  for insert with check (public.admin_is_member());
drop policy if exists "members update leads" on public.admin_leads;
create policy "members update leads" on public.admin_leads
  for update using (public.admin_is_member());
drop policy if exists "admins delete leads" on public.admin_leads;
create policy "admins delete leads" on public.admin_leads
  for delete using (public.admin_is_admin());

drop policy if exists "members read lead activity" on public.admin_lead_activity;
create policy "members read lead activity" on public.admin_lead_activity
  for select using (public.admin_is_member());
drop policy if exists "members log own activity" on public.admin_lead_activity;
create policy "members log own activity" on public.admin_lead_activity
  for insert with check (public.admin_is_member() and actor = auth.uid());

-- Tickets + Brain: admins only in v1.
drop policy if exists "admins all tickets" on public.admin_tickets;
create policy "admins all tickets" on public.admin_tickets
  for all using (public.admin_is_admin()) with check (public.admin_is_admin());
drop policy if exists "admins read ticket msgs" on public.admin_ticket_messages;
create policy "admins read ticket msgs" on public.admin_ticket_messages
  for select using (public.admin_is_admin());
drop policy if exists "admins write ticket msgs" on public.admin_ticket_messages;
create policy "admins write ticket msgs" on public.admin_ticket_messages
  for insert with check (public.admin_is_admin());
drop policy if exists "admins all brain" on public.admin_brain;
create policy "admins all brain" on public.admin_brain
  for all using (public.admin_is_admin()) with check (public.admin_is_admin());

-- Usage: admins read; writes come from the service role (bypasses RLS).
drop policy if exists "admins read usage" on public.admin_usage_events;
create policy "admins read usage" on public.admin_usage_events
  for select using (public.admin_is_admin());

-- Gmail: strictly your own connection. Nobody reads anyone else's tokens.
drop policy if exists "own gmail read" on public.admin_gmail_accounts;
create policy "own gmail read" on public.admin_gmail_accounts
  for select using (user_id = auth.uid() and public.admin_is_member());
drop policy if exists "own gmail delete" on public.admin_gmail_accounts;
create policy "own gmail delete" on public.admin_gmail_accounts
  for delete using (user_id = auth.uid());

-- OAuth states: service-role only. No client policies at all.

-- Activity log: members write their own rows, members read the feed.
drop policy if exists "members read activity" on public.admin_activity_log;
create policy "members read activity" on public.admin_activity_log
  for select using (public.admin_is_member());
drop policy if exists "members log activity" on public.admin_activity_log;
create policy "members log activity" on public.admin_activity_log
  for insert with check (public.admin_is_member() and actor = auth.uid());

-- ============================================================
-- 10. SEED THE FIRST ADMINS
-- ============================================================
-- Run AFTER each person has signed in once at the admin URL (their
-- auth.users row must exist). Repeat per email as people join:
--
--   insert into public.admin_users (user_id, email, full_name, role)
--   select id, email, coalesce(raw_user_meta_data->>'full_name', email), 'owner'
--   from auth.users where email = 'ryder@aisyndicate.com'
--   on conflict (user_id) do update set active = true, role = excluded.role;


-- ============================================================
-- 0002_work_page.sql
-- ============================================================
-- AI Syndicate ADMIN console — the Work page.
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Run 0001_admin_init.sql FIRST. This file builds on it.
--   * Everything new is prefixed admin_ and nothing on the platform is touched.
--   * Notes are PRIVATE to whoever wrote them — not even an owner reads them.
--     A shared scratchpad would stop people writing honestly in it.
--   * Reminders belong to one person too, but an owner/admin can see the team's
--     so nothing quietly rots.
--
-- What this adds:
--   admin_notes         a personal notepad
--   admin_reminders     "chase this on Thursday", optionally pinned to a record
--   admin_leads.next_follow_up_at + follow_up_note
--                       so "people to contact" is a real date, not a guess

-- ============================================================
-- 1. NOTES — private per person
-- ============================================================

create table if not exists public.admin_notes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users on delete cascade,
  title text,
  body text not null default '',
  pinned boolean not null default false,
  -- optional link to the thing the note is about
  link_type text check (link_type in ('client','lead','task','ticket')),
  link_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_notes_author_idx
  on public.admin_notes(author_id, pinned desc, updated_at desc);

drop trigger if exists admin_notes_updated_at on public.admin_notes;
create trigger admin_notes_updated_at before update on public.admin_notes
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 2. REMINDERS — a due date and a line of text
-- ============================================================

create table if not exists public.admin_reminders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,
  body text not null,
  due_at timestamptz not null,
  done_at timestamptz,
  link_type text check (link_type in ('client','lead','task','ticket')),
  link_id uuid,
  created_by uuid references auth.users,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The Work page's main read: my open reminders, soonest first.
create index if not exists admin_reminders_open_idx
  on public.admin_reminders(owner_id, due_at) where done_at is null;

drop trigger if exists admin_reminders_updated_at on public.admin_reminders;
create trigger admin_reminders_updated_at before update on public.admin_reminders
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 3. LEADS — a real follow-up date
-- ============================================================

alter table public.admin_leads
  add column if not exists next_follow_up_at timestamptz;
alter table public.admin_leads
  add column if not exists follow_up_note text;

-- "Who do I need to contact" sorts on this constantly.
create index if not exists admin_leads_followup_idx
  on public.admin_leads(owner_id, next_follow_up_at)
  where next_follow_up_at is not null;

-- ============================================================
-- 4. GRANTS  (opt-in per table, matching 0001)
-- ============================================================

grant select, insert, update, delete on public.admin_notes to authenticated;
grant select, insert, update, delete on public.admin_reminders to authenticated;

-- ============================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================

alter table public.admin_notes enable row level security;
alter table public.admin_reminders enable row level security;

-- ---- Notes: yours and only yours, in every direction. ----
-- admin_is_member() is checked as well as author_id so that a departed
-- teammate whose roster row is switched off loses access immediately,
-- even though their auth user still exists.
drop policy if exists "own notes read" on public.admin_notes;
create policy "own notes read" on public.admin_notes
  for select using (public.admin_is_member() and author_id = auth.uid());
drop policy if exists "own notes insert" on public.admin_notes;
create policy "own notes insert" on public.admin_notes
  for insert with check (public.admin_is_member() and author_id = auth.uid());
drop policy if exists "own notes update" on public.admin_notes;
create policy "own notes update" on public.admin_notes
  for update using (public.admin_is_member() and author_id = auth.uid())
  with check (author_id = auth.uid());
drop policy if exists "own notes delete" on public.admin_notes;
create policy "own notes delete" on public.admin_notes
  for delete using (public.admin_is_member() and author_id = auth.uid());

-- ---- Reminders: yours, plus owners/admins can see the team's. ----
-- Read is wider than write on purpose: an owner should be able to see that a
-- follow-up is three weeks overdue, but not silently tick it off or reword it.
drop policy if exists "reminders read" on public.admin_reminders;
create policy "reminders read" on public.admin_reminders
  for select using (
    public.admin_is_member() and (owner_id = auth.uid() or public.admin_is_admin())
  );
-- Anyone on the roster can set a reminder for a teammate (that is the point of
-- a shared console), but created_by must be honest about who did it.
drop policy if exists "reminders insert" on public.admin_reminders;
create policy "reminders insert" on public.admin_reminders
  for insert with check (
    public.admin_is_member() and (created_by is null or created_by = auth.uid())
  );
drop policy if exists "reminders update own" on public.admin_reminders;
create policy "reminders update own" on public.admin_reminders
  for update using (public.admin_is_member() and owner_id = auth.uid())
  with check (owner_id = auth.uid());
drop policy if exists "reminders delete own" on public.admin_reminders;
create policy "reminders delete own" on public.admin_reminders
  for delete using (public.admin_is_member() and owner_id = auth.uid());


-- ============================================================
-- 0003_inbox.sql
-- ============================================================
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


-- ============================================================
-- 0004_client_page.sql
-- ============================================================
-- AI Syndicate ADMIN console — the client page: websites + where it stands.
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Run 0001, 0002 and 0003 first.
--   * Everything new is prefixed admin_. Nothing on the platform is touched.
--
-- What this adds, in plain words:
--
--   1. admin_client_sites — every web address that belongs to a client: the main
--      website, the ranking sites we build for them, their Google Business
--      Profile, directory listings. One row per link, so it is a real list that
--      can be sorted and checked, not one text box nobody updates.
--
--   2. Four columns on admin_clients that hold the written "where this client
--      stands" summary: the text, the facts it was built from, when it was
--      written, and who pressed the button. The facts are stored WITH the text
--      on purpose — a summary you cannot check against its own inputs is a
--      rumour.

-- ============================================================
-- 1. CLIENT WEBSITES
-- ============================================================

create table if not exists public.admin_client_sites (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.admin_clients on delete cascade,
  kind text not null default 'authority'
    check (kind in ('main','authority','landing','gbp','directory','review','social','other')),
  label text not null,                       -- what to call it: "Main site", "Florida Injury Claim Guide"
  url text not null,
  live boolean not null default true,        -- false = built but not published yet
  notes text,
  sort int not null default 0,               -- hand order; main site usually 0
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  added_by uuid references auth.users on delete set null
);

comment on column public.admin_client_sites.kind is
  'main = the client''s own website. authority = a ranking site we built. gbp = Google Business Profile. The rest are listings and profiles we do not own.';

create index if not exists admin_client_sites_client_idx
  on public.admin_client_sites(client_id, sort, created_at);

drop trigger if exists admin_client_sites_updated_at on public.admin_client_sites;
create trigger admin_client_sites_updated_at before update on public.admin_client_sites
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 2. WHERE THIS CLIENT STANDS
-- ============================================================
-- standing_summary holds the short write-up shown at the top of the client page.
-- standing_facts holds the counted facts it was written from (tasks done, weeks
-- logged, emails waiting, and so on) so anyone can check the write-up against
-- the same numbers it saw. standing_source records whether a person's AI key
-- wrote it or whether it was counted straight from the database.

alter table public.admin_clients
  add column if not exists standing_summary text;
alter table public.admin_clients
  add column if not exists standing_facts jsonb;
alter table public.admin_clients
  add column if not exists standing_at timestamptz;
alter table public.admin_clients
  add column if not exists standing_by uuid references auth.users on delete set null;
alter table public.admin_clients
  add column if not exists standing_source text
    check (standing_source is null or standing_source in ('written','counted'));

-- ============================================================
-- 3. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Same as the rest of Operations: owners and admins only. Sales works Leads.

grant select, insert, update, delete on public.admin_client_sites to authenticated;

alter table public.admin_client_sites enable row level security;

drop policy if exists "admins all client sites" on public.admin_client_sites;
create policy "admins all client sites" on public.admin_client_sites
  for all using (public.admin_is_admin()) with check (public.admin_is_admin());


-- ============================================================
-- 0005_platform_accounts.sql
-- ============================================================
-- AI Syndicate ADMIN console — platform accounts (one login card per account).
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Run 0001 through 0004 first.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--
-- What this adds, in plain words:
--
--   admin_platform_accounts — one row for every login we hold on the customer
--   platform. One for our own agency account, one for each client whose
--   workspace we work inside. The console uses the row to mint a one-time
--   sign-in link, so a click opens that account with no password typed.
--
-- WHY THE LIST EXISTS AT ALL (this is the security point, not bookkeeping):
--   the sign-in endpoint will only ever make a link for an email that is
--   ALREADY IN THIS TABLE. It never takes an email from the browser. Adding a
--   row is an owner/admin action, on the record, with a name next to it — so
--   "which accounts can this console become" is a list you can read, not
--   whatever the front end happened to post.
--
-- PASSWORDS NEVER GO IN THIS TABLE. vault_url holds a Bitwarden link only.

-- ============================================================
-- 1. THE TABLE
-- ============================================================

create table if not exists public.admin_platform_accounts (
  id uuid primary key default gen_random_uuid(),

  -- null = one of ours (the agency's own account). Otherwise the client it
  -- belongs to. Deleting a client removes its login card with it.
  client_id uuid references public.admin_clients on delete cascade,

  label text not null,                         -- "AI Syndicate (us)", "Shiner Law Group"
  email text not null,                         -- the platform login address
  site text,                                   -- what YOUR SITE is set to in that workspace
  plan text,                                   -- whatever plan it is on, in plain words
  vault_url text,                              -- Bitwarden link. NEVER a password.
  notes text,
  active boolean not null default true,        -- false = we no longer work in it
  sort int not null default 0,

  last_opened_at timestamptz,
  last_opened_by uuid references auth.users on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Who put this login on the list. Defaulted AND forced by a trigger below,
  -- because "an owner or admin added it" is only worth saying if the name is
  -- actually written down. The browser cannot set this to someone else.
  added_by uuid references auth.users on delete set null default auth.uid(),

  -- The same shape the console checks in lib/platform-accounts.js: one @, a
  -- dot after it, no spaces. The database is the third place this gets
  -- checked, so it must not be the loosest of the three — a row seeded in the
  -- SQL editor as 'ops@' would render a normal-looking card whose button can
  -- only ever fail. The real test is still whether Supabase finds a login for
  -- the address, and that answer comes back on the button.
  constraint admin_platform_accounts_email_shape
    check (email ~ '^[^[:space:]@]+@[^[:space:]@.]+\.[^[:space:]@]+$')
);

comment on table public.admin_platform_accounts is
  'Platform logins the console can open. The sign-in endpoint only mints links for emails listed here.';
comment on column public.admin_platform_accounts.client_id is
  'null = the agency''s own platform account. Otherwise the client this login belongs to.';
comment on column public.admin_platform_accounts.vault_url is
  'Bitwarden link only. A password must never be stored here.';

-- One card per login. Case-insensitive, because Login@x.com and login@x.com
-- are the same account to Supabase.
create unique index if not exists admin_platform_accounts_email_key
  on public.admin_platform_accounts (lower(email));

create index if not exists admin_platform_accounts_client_idx
  on public.admin_platform_accounts (client_id, sort, created_at);

drop trigger if exists admin_platform_accounts_updated_at on public.admin_platform_accounts;
create trigger admin_platform_accounts_updated_at before update on public.admin_platform_accounts
  for each row execute function public.admin_set_updated_at();

-- added_by is stamped from the signed-in user on insert and can never be
-- rewritten afterwards. A row that says who added it, that the adder can
-- change, records nothing.
create or replace function public.admin_platform_accounts_stamp_adder()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    new.added_by := auth.uid();
  else
    new.added_by := old.added_by;
  end if;
  return new;
end;
$$;

drop trigger if exists admin_platform_accounts_adder on public.admin_platform_accounts;
create trigger admin_platform_accounts_adder before insert or update on public.admin_platform_accounts
  for each row execute function public.admin_platform_accounts_stamp_adder();

-- ============================================================
-- 2. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Owners and admins can read, add and edit. A sales rep cannot see the table
-- at all — not the list, not the count.
--
-- DELETE IS OWNERS ONLY, on purpose. This table is the record of which logins
-- the console can become and who put them there. If an admin can add a card,
-- use it, and then delete the row, the record erases itself and the list stops
-- being evidence of anything. Switching a card off ("We still work in this
-- account") is the everyday action and any admin can do it; removing the row
-- outright is an owner's call.

grant select, insert, update on public.admin_platform_accounts to authenticated;
grant delete on public.admin_platform_accounts to authenticated;

alter table public.admin_platform_accounts enable row level security;

drop policy if exists "admins all platform accounts" on public.admin_platform_accounts;

drop policy if exists "admins read platform accounts" on public.admin_platform_accounts;
create policy "admins read platform accounts" on public.admin_platform_accounts
  for select using (public.admin_is_admin());

drop policy if exists "admins add platform accounts" on public.admin_platform_accounts;
create policy "admins add platform accounts" on public.admin_platform_accounts
  for insert with check (public.admin_is_admin());

drop policy if exists "admins edit platform accounts" on public.admin_platform_accounts;
create policy "admins edit platform accounts" on public.admin_platform_accounts
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());

drop policy if exists "owners remove platform accounts" on public.admin_platform_accounts;
create policy "owners remove platform accounts" on public.admin_platform_accounts
  for delete using (public.admin_is_owner());


-- ============================================================
-- 0006_brain_notes_leads.sql
-- ============================================================
-- AI Syndicate ADMIN console — the AI memory, the auto-written notes, and the
-- lead intake that feeds both. SAFE TO RUN ON THE SHARED (PLATFORM) PROJECT.
--
--   * Run 0001 through 0005 first.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--   * Re-running this file is safe. Every statement is guarded.
--
-- What this adds, in plain words:
--
--   admin_brain_memory   — things the AI has learned and kept. The Brain page
--                          holds rules a person wrote; this holds facts the
--                          assistant picked up while working, each one with
--                          where it came from and when it was last useful.
--
--   admin_ai_notes       — the Notes page. A note is written by the system
--                          from real rows (a lead nobody called, a task past
--                          its date, an email waiting on us) and says which
--                          rows it came from. Notes are never silently
--                          replaced: a fresh run supersedes the old note and
--                          the old one is kept.
--
--   admin_lead_sources   — one row per place leads come in from: a spreadsheet
--                          somebody imported, or a saved search the scraper
--                          runs. Holds the search, not the results.
--
--   admin_leads          — gains a dedupe key, a link back to its source, and
--                          the raw row it arrived as.
--
--   admin_assistant_log  — every action the assistant took on someone's behalf.
--                          An AI that can change rows is only acceptable if
--                          what it changed is readable afterwards.

-- ============================================================
-- 1. BRAIN MEMORY — what the AI has learned
-- ============================================================
-- The difference from admin_brain, and why both exist:
--   admin_brain        = standing instructions a PERSON wrote. Small, curated,
--                        every row is read on every AI call.
--   admin_brain_memory = facts the assistant LEARNED. Can grow large. Only the
--                        rows that match the question get read, ranked by
--                        weight and recency.
-- Mixing them would mean a mistake the AI remembered outranks a rule Ryder
-- typed. They stay separate for that reason.

create table if not exists public.admin_brain_memory (
  id uuid primary key default gen_random_uuid(),

  -- What kind of thing this is. 'fact' is a true statement about the business.
  -- 'preference' is how we like things done. 'event' is something that
  -- happened. 'person' is about a human. 'decision' is a call we made and why.
  kind text not null default 'fact'
    check (kind in ('fact','preference','event','person','decision','gotcha')),

  subject text not null,                 -- what it is about: a client, a tool, a person
  body text not null,                    -- the memory itself, in plain words

  -- Where this came from, so a wrong memory can be traced back. 'assistant' =
  -- the chat learned it. 'note' = a generated note produced it. 'person' = a
  -- human typed it in. 'import' = it arrived with a data import.
  origin text not null default 'assistant'
    check (origin in ('assistant','note','person','import')),
  origin_ref text,                       -- a row id, a thread id, whatever names the source

  -- What it is attached to, when it is attached to something.
  client_id uuid references public.admin_clients on delete cascade,
  lead_id uuid references public.admin_leads on delete cascade,

  -- Ranking. weight is how much it matters (1 low, 5 high). confirmed means a
  -- person read it and said yes. Unconfirmed memories are still used but are
  -- labelled as unconfirmed in the prompt, which is the honest thing to do.
  weight int not null default 3 check (weight between 1 and 5),
  confirmed boolean not null default false,
  confirmed_by uuid references auth.users on delete set null,

  -- Recency without a rewrite race: last_used_at is only ever moved forward.
  last_used_at timestamptz,
  use_count int not null default 0,

  -- false = kept for the record but no longer fed to the AI. Deleting is also
  -- allowed, but switching off is the everyday action — a memory that turned
  -- out wrong is worth being able to read later.
  active boolean not null default true,

  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.admin_brain_memory is
  'Facts the assistant learned while working. Curated rules live in admin_brain; these are earned, not typed.';

-- The same memory must not be stored twice. Case- and space-insensitive on the
-- pair that identifies it. Two memories about the same subject with different
-- wording are two memories; the identical one is one.
create unique index if not exists admin_brain_memory_dedupe
  on public.admin_brain_memory (lower(btrim(subject)), md5(lower(btrim(body))));

create index if not exists admin_brain_memory_rank_idx
  on public.admin_brain_memory (active, weight desc, last_used_at desc nulls last);
create index if not exists admin_brain_memory_client_idx
  on public.admin_brain_memory (client_id) where client_id is not null;
create index if not exists admin_brain_memory_lead_idx
  on public.admin_brain_memory (lead_id) where lead_id is not null;

drop trigger if exists admin_brain_memory_updated_at on public.admin_brain_memory;
create trigger admin_brain_memory_updated_at before update on public.admin_brain_memory
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 2. AI NOTES — the Notes page
-- ============================================================
-- A note answers one of three questions and says which one:
--   in_circulation — this is moving right now and here is where it stands
--   follow_up      — somebody is owed a reply or a call, and by when
--   attention      — this is going wrong or has stopped moving
--   win            — this went well and is worth saying out loud
--
-- evidence is the honesty mechanism, and it is the reason this table exists
-- rather than the note being a paragraph in a chat. It holds the exact rows
-- the note was built from: [{table, id, label}]. A note whose evidence array
-- is empty is a note with nothing behind it, and the page says so out loud.

create table if not exists public.admin_ai_notes (
  id uuid primary key default gen_random_uuid(),

  category text not null default 'attention'
    check (category in ('in_circulation','follow_up','attention','win')),

  title text not null,
  body text not null,

  -- Which rows this was built from. Never empty for a generated note.
  evidence jsonb not null default '[]'::jsonb,

  -- COUNTED = every word came from counting rows, no AI involved.
  -- AI_WRITTEN = an AI wrote the prose from counted facts.
  -- The page prints this badge on every note. Same rule as the client page.
  written_by text not null default 'counted'
    check (written_by in ('counted','ai_written','person')),

  client_id uuid references public.admin_clients on delete cascade,
  lead_id uuid references public.admin_leads on delete set null,
  owner_id uuid references auth.users on delete set null,   -- whose plate this sits on

  urgency int not null default 2 check (urgency between 1 and 3), -- 3 = today

  -- Lifecycle. 'open' is live. 'done' is handled. 'dismissed' is "not a thing".
  -- 'superseded' means a later run replaced it — the row stays, because a note
  -- that was true last Tuesday is history, not clutter.
  status text not null default 'open'
    check (status in ('open','done','dismissed','superseded')),
  status_changed_at timestamptz,
  status_changed_by uuid references auth.users on delete set null,

  -- Two notes about the same thing across two runs share a fingerprint, so a
  -- re-run supersedes rather than duplicates.
  fingerprint text,

  -- What a person did about it, if anything.
  linked_task_id uuid references public.admin_tasks on delete set null,
  linked_reminder_id uuid references public.admin_reminders on delete set null,

  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.admin_ai_notes.evidence is
  'The exact rows this note was built from: [{table,id,label}]. Empty means the note is unsupported.';

-- One OPEN note per fingerprint. Superseded and done rows are excluded from
-- the constraint on purpose — history is allowed to repeat, the live list is not.
create unique index if not exists admin_ai_notes_open_fingerprint
  on public.admin_ai_notes (fingerprint) where status = 'open' and fingerprint is not null;

create index if not exists admin_ai_notes_live_idx
  on public.admin_ai_notes (status, urgency desc, generated_at desc);
create index if not exists admin_ai_notes_owner_idx
  on public.admin_ai_notes (owner_id, status) where owner_id is not null;
create index if not exists admin_ai_notes_client_idx
  on public.admin_ai_notes (client_id) where client_id is not null;

drop trigger if exists admin_ai_notes_updated_at on public.admin_ai_notes;
create trigger admin_ai_notes_updated_at before update on public.admin_ai_notes
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 3. LEAD SOURCES — where leads come in from
-- ============================================================
-- A source is a spreadsheet somebody imported, or a saved search the scraper
-- re-runs. It stores the SEARCH, never the results — the results are leads.

create table if not exists public.admin_lead_sources (
  id uuid primary key default gen_random_uuid(),

  label text not null,                   -- "CJ's realtor sheet", "Destin medspas"
  kind text not null default 'import'
    check (kind in ('import','scraper','manual','inbound')),

  -- For a scraper source: the search, as plain fields. Kept as jsonb because
  -- which fields a provider accepts is the provider's business, not ours.
  --   { vertical, city, state, radius_miles, employees, keywords, limit }
  query jsonb not null default '{}'::jsonb,

  -- Which provider answers it. Set when the row is made, so a source cannot
  -- silently change where its leads came from.
  provider text check (provider in ('platform','apollo')),

  -- Runs on its own each day when true. Off by default: a scraper nobody
  -- asked for is a bill nobody asked for.
  auto_daily boolean not null default false,
  daily_cap int not null default 50 check (daily_cap between 1 and 500),

  -- Round-robin: leads from this source get handed to these reps in turn.
  -- Empty means they land unclaimed in the pool.
  assign_to uuid[] not null default '{}',

  last_run_at timestamptz,
  last_run_found int,
  last_run_new int,
  last_run_error text,

  active boolean not null default true,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_lead_sources_due_idx
  on public.admin_lead_sources (auto_daily, active, last_run_at);

drop trigger if exists admin_lead_sources_updated_at on public.admin_lead_sources;
create trigger admin_lead_sources_updated_at before update on public.admin_lead_sources
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 4. LEADS — dedupe key, source link, the row as it arrived
-- ============================================================
-- Every column is added with IF NOT EXISTS, so this section is safe on a
-- table that already holds leads.

alter table public.admin_leads
  add column if not exists source_id uuid references public.admin_lead_sources on delete set null;

alter table public.admin_leads
  add column if not exists raw jsonb;                 -- the row exactly as it arrived

alter table public.admin_leads
  add column if not exists dedupe_key text;           -- see the function below

alter table public.admin_leads
  add column if not exists last_import_at timestamptz;

-- The scraper's own name has to be allowed in `source`, and the old check
-- constraint does not know about it. Replace the constraint rather than the
-- column, so no data moves.
alter table public.admin_leads drop constraint if exists admin_leads_source_check;
alter table public.admin_leads
  add constraint admin_leads_source_check
  check (source in ('platform','csv','sheet','scraper','manual','referral','inbound'));

-- The dedupe key, decided in ONE place so the browser, the importer and the
-- scraper can never disagree about what counts as the same lead.
--
-- Order matters and is deliberate: email is the strongest signal, then the
-- phone's digits, then the bare domain, and only then the company name in a
-- city. A lead with none of those is not deduped at all (returns null) —
-- guessing that two blank rows are the same lead loses real leads, and losing
-- a real lead is worse than dialling one twice.
create or replace function public.admin_lead_dedupe_key(
  p_email text, p_phone text, p_domain text, p_company text, p_city text
) returns text
language sql
immutable
set search_path = public
as $$
  -- Each field is cleaned FIRST, then the strongest surviving one wins. The
  -- earlier version tested the raw field and cleaned it inside the branch,
  -- which meant a value that failed its own cleaning (a domain with no dot,
  -- an email with no @) still swallowed the branch and stopped weaker fields
  -- being tried. A test comparing this against cleanPhone/cleanDomain in
  -- lib/lead-intake.js caught it on 'HTTPS://WWW.X.com/about?q=1', which this
  -- function keyed as 'd:https:' because '^https?://' does not match 'HTTPS://'.
  --
  -- Read alongside lib/lead-intake.js. The two must agree exactly: the browser
  -- uses the JavaScript to say "12 of these are already here" before an import
  -- saves, and this stamps the key that the check is made against.
  with cleaned as (
    select
      -- email: one @, a dot after it, no spaces
      case when lower(btrim(coalesce(p_email,''))) ~ '^[^[:space:]@]+@[^[:space:]@.]+\.[^[:space:]@]+$'
           then lower(btrim(p_email)) end as e,

      -- phone: digits only, drop a leading country-code 1, take the first ten
      case when length(regexp_replace(coalesce(p_phone,''), '\D', '', 'g')) >= 10
           then left(
             case
               when length(regexp_replace(p_phone, '\D', '', 'g')) > 10
                and left(regexp_replace(p_phone, '\D', '', 'g'), 1) = '1'
               then substr(regexp_replace(p_phone, '\D', '', 'g'), 2)
               else regexp_replace(p_phone, '\D', '', 'g')
             end, 10) end as p,

      -- domain: lowercase FIRST, then drop the scheme, www., the path, the
      -- query and any trailing dot. Must still contain a dot afterwards.
      nullif(regexp_replace(
        regexp_replace(
          split_part(split_part(
            regexp_replace(lower(btrim(coalesce(p_domain,''))), '^[a-z]+://', ''),
          '/', 1), '?', 1),
        '^www\.', ''), '\.$', ''), '') as d,

      nullif(lower(regexp_replace(btrim(coalesce(p_company,'')), '[^a-z0-9]', '', 'gi')), '') as c,
      lower(btrim(coalesce(p_city,''))) as ct
  )
  select case
    when e is not null then 'e:' || e
    when p is not null then 'p:' || p
    when d is not null and d ~ '\.' and d !~ '[[:space:]]' then 'd:' || d
    when c is not null then 'c:' || c || ':' || ct
    else null
  end
  from cleaned
$$;

revoke execute on function public.admin_lead_dedupe_key(text,text,text,text,text) from anon, public;
grant execute on function public.admin_lead_dedupe_key(text,text,text,text,text) to authenticated;

-- Stamped by the database on every write, so a lead added by hand, by import,
-- or by the scraper all get the same key. A key computed in the browser is a
-- key that stops being computed the day someone writes a script.
create or replace function public.admin_leads_stamp_dedupe()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.dedupe_key := public.admin_lead_dedupe_key(
    new.email, new.phone, new.domain, new.company, new.city);
  return new;
end;
$$;

drop trigger if exists admin_leads_dedupe on public.admin_leads;
create trigger admin_leads_dedupe before insert or update on public.admin_leads
  for each row execute function public.admin_leads_stamp_dedupe();

-- Backfill anything already in the table.
update public.admin_leads
  set dedupe_key = public.admin_lead_dedupe_key(email, phone, domain, company, city)
  where dedupe_key is null;

-- Not unique, on purpose. Two real businesses can share a switchboard number,
-- and a hard constraint would reject the second one at 3am with no human
-- watching. Duplicates are caught and SHOWN at import time instead, where a
-- person decides. This index is what makes that check fast.
create index if not exists admin_leads_dedupe_idx
  on public.admin_leads (dedupe_key) where dedupe_key is not null;

create index if not exists admin_leads_source_idx
  on public.admin_leads (source_id, created_at desc) where source_id is not null;

-- ============================================================
-- 4b. REMINDERS MAY POINT AT A NOTE
-- ============================================================
-- admin_reminders.link_type was written before the Notes page existed, so its
-- check constraint allows client / lead / task / ticket and nothing else. The
-- "Remind me" button on a note sets link_type = 'note', which the old
-- constraint rejected outright — the button failed every single time. Widen
-- the constraint rather than dropping the link: knowing WHAT a follow-up came
-- from is the reason the column is there.

alter table public.admin_reminders drop constraint if exists admin_reminders_link_type_check;
alter table public.admin_reminders
  add constraint admin_reminders_link_type_check
  check (link_type in ('client','lead','task','ticket','note'));

-- ============================================================
-- 5. ASSISTANT ACTION LOG
-- ============================================================
-- The assistant can change rows. That is only acceptable if every change it
-- made is readable afterwards, by name, with what it did and whether it worked.

create table if not exists public.admin_assistant_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references auth.users on delete set null,   -- the person who asked
  tool text not null,                                    -- which action it ran
  args jsonb not null default '{}'::jsonb,
  result text,                                           -- 'ok' or the error
  ok boolean not null default true,
  target_table text,
  target_id uuid,
  screen text,                                           -- what page they were on
  created_at timestamptz not null default now()
);

create index if not exists admin_assistant_log_idx
  on public.admin_assistant_log (created_at desc);
create index if not exists admin_assistant_log_actor_idx
  on public.admin_assistant_log (actor, created_at desc);

-- ============================================================
-- 6. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- The rule inherited from 0001 and never loosened: a sales rep works leads and
-- nothing else. The Brain is closed to sales at the database (0001), so its
-- memory must be too — otherwise the memory becomes the leak the Brain isn't.
-- Notes are closed to sales for the same reason: a note can quote a client
-- email, a bill, or a ticket.

grant select, insert, update, delete on public.admin_brain_memory to authenticated;
grant select, insert, update, delete on public.admin_ai_notes to authenticated;
grant select, insert, update, delete on public.admin_lead_sources to authenticated;
grant select, insert on public.admin_assistant_log to authenticated;

alter table public.admin_brain_memory  enable row level security;
alter table public.admin_ai_notes      enable row level security;
alter table public.admin_lead_sources  enable row level security;
alter table public.admin_assistant_log enable row level security;

-- Brain memory — owners and admins only, all four verbs.
drop policy if exists "admins all brain memory" on public.admin_brain_memory;
create policy "admins all brain memory" on public.admin_brain_memory
  for all using (public.admin_is_admin()) with check (public.admin_is_admin());

-- Notes — owners and admins only.
drop policy if exists "admins all ai notes" on public.admin_ai_notes;
create policy "admins all ai notes" on public.admin_ai_notes
  for all using (public.admin_is_admin()) with check (public.admin_is_admin());

-- Lead sources — every member may READ them (a rep needs to know where a lead
-- in front of them came from) but only an admin may create, change or remove
-- one. A source is a spend decision: it runs searches that cost money.
drop policy if exists "members read lead sources" on public.admin_lead_sources;
create policy "members read lead sources" on public.admin_lead_sources
  for select using (public.admin_is_member());

drop policy if exists "admins add lead sources" on public.admin_lead_sources;
create policy "admins add lead sources" on public.admin_lead_sources
  for insert with check (public.admin_is_admin());

drop policy if exists "admins edit lead sources" on public.admin_lead_sources;
create policy "admins edit lead sources" on public.admin_lead_sources
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());

drop policy if exists "owners remove lead sources" on public.admin_lead_sources;
create policy "owners remove lead sources" on public.admin_lead_sources
  for delete using (public.admin_is_owner());

-- Assistant log — an admin reads the whole log; anyone reads their own. Nobody
-- edits or deletes it from the browser at all: there is no update or delete
-- grant above, so a bad row can only be removed by someone with the service
-- key. A log the logged party can edit is not a log.
drop policy if exists "read assistant log" on public.admin_assistant_log;
create policy "read assistant log" on public.admin_assistant_log
  for select using (public.admin_is_admin() or actor = auth.uid());

drop policy if exists "write own assistant log" on public.admin_assistant_log;
create policy "write own assistant log" on public.admin_assistant_log
  for insert with check (public.admin_is_member() and actor = auth.uid());


-- ============================================================
-- 0007_finance.sql
-- ============================================================
-- AI Syndicate ADMIN console — FINANCE: costs, invoices, and the settings the
-- money pages need. Aug 20 2026.
--
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--   * Run 0001 through 0006 first.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--   * Run it twice and nothing breaks — every statement is if-not-exists or
--     drop-then-create.
--
-- WHAT THIS ADDS, in plain words:
--
--   admin_expenses          — every dollar that goes OUT. Stripe knows what
--                             comes in; nothing on earth knows what we pay
--                             unless we write it down. This table is that.
--   admin_invoices          — an invoice we send. Ours, not Stripe's. Stripe
--                             invoices are read separately and never copied in.
--   admin_invoice_items     — the lines on one invoice.
--   admin_invoice_payments  — money received against an invoice, one row per
--                             payment, so a half-payment is a real thing and
--                             not a status somebody guessed.
--   admin_finance_settings  — one row. Who we are on an invoice, the numbering,
--                             the default terms, and what is in the bank.
--
-- WHY PAYMENTS ARE THEIR OWN TABLE: an invoice row that just says "paid" cannot
-- answer "when, how much, and how did it arrive". Aging, days-to-pay and the
-- collected-vs-billed number all come from these rows.

-- ============================================================
-- 1. EXPENSES — money out
-- ============================================================

create table if not exists public.admin_expenses (
  id uuid primary key default gen_random_uuid(),

  incurred_on date not null,          -- the day it was paid, or the day a
                                      -- repeating cost started
  ended_on date,                      -- a repeating cost we stopped paying.
                                      -- null = still running.

  category text not null,             -- see the check below
  vendor text,                        -- who got paid: "Anthropic", "Vercel"
  description text,
  amount_cents bigint not null check (amount_cents >= 0),

  -- one_time  = paid once, lands in one month
  -- monthly   = the same amount every month from incurred_on until ended_on
  -- yearly    = paid once a year, divided by 12 across the months it covers,
  --             so one January payment does not make January look terrible
  interval text not null default 'one_time'
    check (interval in ('one_time', 'monthly', 'yearly')),

  -- Which client this was spent on, when it was spent on one. Lets the page
  -- work out what each client actually costs us to serve.
  client_id uuid references public.admin_clients on delete set null,

  -- Ticked = this was spent WINNING clients, so it belongs in the cost-per-new-
  -- client number. A category cannot tell a sales contractor from a delivery
  -- one, so a person says which it was.
  counts_toward_cac boolean not null default false,

  notes text,
  receipt_url text,                   -- a link to the receipt. Never a file.

  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint admin_expenses_category_known check (category in (
    'Contractors', 'Software', 'AI & APIs', 'Ads', 'Hosting & domains',
    'Payment fees', 'Client costs', 'Office & admin', 'Taxes', 'Other'
  )),
  -- A repeating cost that ends before it starts would silently vanish from
  -- every month instead of erroring, and the profit line would be wrong with
  -- nothing on screen to explain it.
  constraint admin_expenses_dates_sane check (ended_on is null or ended_on >= incurred_on)
);

comment on table public.admin_expenses is
  'Money out. Typed in by us — no integration knows what we pay. The profit line on the Finance page is only as true as this table.';
comment on column public.admin_expenses.interval is
  'one_time lands in one month. monthly repeats until ended_on. yearly is divided by 12 across the months it covers.';
comment on column public.admin_expenses.counts_toward_cac is
  'Ticked = spent winning clients, so it counts in the cost-per-new-client figure.';

create index if not exists admin_expenses_month_idx on public.admin_expenses (incurred_on desc);
create index if not exists admin_expenses_client_idx on public.admin_expenses (client_id, incurred_on desc);
create index if not exists admin_expenses_category_idx on public.admin_expenses (category, incurred_on desc);

drop trigger if exists admin_expenses_updated_at on public.admin_expenses;
create trigger admin_expenses_updated_at before update on public.admin_expenses
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 2. INVOICES
-- ============================================================

create table if not exists public.admin_invoices (
  id uuid primary key default gen_random_uuid(),

  number text not null,                        -- "AIS-0007". Shown to the client.
  client_id uuid references public.admin_clients on delete set null,

  -- Copied onto the invoice when it is made, on purpose. An invoice is a record
  -- of what we sent. Renaming a client next year must not rewrite an invoice we
  -- already put in someone's hands.
  bill_to_name text not null,
  bill_to_email text,
  bill_to_address text,

  status text not null default 'draft'
    check (status in ('draft', 'sent', 'paid', 'void')),
  -- Only four are ever STORED. "Overdue" and "Part paid" are worked out from
  -- the due date and the payments, so nobody has to remember to change them.

  issue_date date not null default current_date,
  due_date date,
  currency text not null default 'usd',

  subtotal_cents bigint not null default 0 check (subtotal_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  tax_pct numeric(6,3) not null default 0 check (tax_pct >= 0 and tax_pct <= 100),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  total_cents bigint not null default 0 check (total_cents >= 0),

  -- Kept up to date by a trigger from the payments table below, so it can never
  -- disagree with the payments on record.
  amount_paid_cents bigint not null default 0 check (amount_paid_cents >= 0),

  notes text,                                  -- shown to the client
  terms text,                                  -- "Payment due within 14 days"
  internal_note text,                          -- never leaves this console

  sent_at timestamptz,
  paid_at timestamptz,

  -- Set when a Stripe invoice was pulled in for reference. We never write to
  -- Stripe from here.
  stripe_invoice_id text,
  hosted_url text,

  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.admin_invoices is
  'Invoices we raise. Statuses stored are draft/sent/paid/void — overdue and part-paid are worked out, never typed.';

-- Two invoices with the same number is the one thing that must never happen:
-- it is the number the client pays against.
create unique index if not exists admin_invoices_number_key on public.admin_invoices (upper(number));
create index if not exists admin_invoices_client_idx on public.admin_invoices (client_id, issue_date desc);
create index if not exists admin_invoices_status_idx on public.admin_invoices (status, due_date);

drop trigger if exists admin_invoices_updated_at on public.admin_invoices;
create trigger admin_invoices_updated_at before update on public.admin_invoices
  for each row execute function public.admin_set_updated_at();

-- ---- lines on an invoice ----

create table if not exists public.admin_invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.admin_invoices on delete cascade,
  description text not null,
  qty numeric(12,2) not null default 1 check (qty >= 0),
  unit_cents bigint not null default 0 check (unit_cents >= 0),
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists admin_invoice_items_invoice_idx
  on public.admin_invoice_items (invoice_id, sort, created_at);

-- ---- money actually received ----

create table if not exists public.admin_invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.admin_invoices on delete cascade,
  paid_on date not null default current_date,
  amount_cents bigint not null check (amount_cents > 0),
  method text,                                 -- "Stripe", "Bank transfer", "Check"
  reference text,                              -- a Stripe id, a check number
  note text,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists admin_invoice_payments_invoice_idx
  on public.admin_invoice_payments (invoice_id, paid_on desc);

-- The paid total and the paid date on the invoice are written by the database
-- from the payment rows. Not by the browser. A tab that dies half way through
-- saving a payment cannot leave an invoice claiming it is paid.
create or replace function public.admin_invoice_roll_payments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  inv uuid := coalesce(new.invoice_id, old.invoice_id);
  total_paid bigint;
  last_paid date;
  inv_total bigint;
begin
  select coalesce(sum(amount_cents), 0), max(paid_on)
    into total_paid, last_paid
    from public.admin_invoice_payments where invoice_id = inv;

  select total_cents into inv_total from public.admin_invoices where id = inv;

  update public.admin_invoices
     set amount_paid_cents = total_paid,
         paid_at = case when inv_total > 0 and total_paid >= inv_total
                        then coalesce(paid_at, (last_paid::timestamptz))
                        else null end,
         -- Paying a draft in full marks it sent-and-paid; paying part of one
         -- leaves it alone. A void invoice is never revived by a payment.
         status = case
                    when status = 'void' then 'void'
                    when status = 'draft' then 'draft'
                    when inv_total > 0 and total_paid >= inv_total then 'paid'
                    when status = 'paid' and total_paid < inv_total then 'sent'
                    else status
                  end
   where id = inv;
  return null;
end;
$$;

drop trigger if exists admin_invoice_payments_roll on public.admin_invoice_payments;
create trigger admin_invoice_payments_roll
  after insert or update or delete on public.admin_invoice_payments
  for each row execute function public.admin_invoice_roll_payments();

-- A note on what the trigger above does NOT do: it never turns a draft into a
-- sent invoice. Money can arrive against a draft (a client paying from a quote),
-- and the invoice stays a draft until a person marks it sent, because "sent" is
-- a claim about something we did, not something the client did.

-- ============================================================
-- 3. FINANCE SETTINGS — one row, ever
-- ============================================================

create table if not exists public.admin_finance_settings (
  id boolean primary key default true check (id),   -- true is the only key
  company_name text not null default 'AI Syndicate',
  company_email text,
  company_address text,
  invoice_prefix text not null default 'AIS-',
  default_terms_days int not null default 14 check (default_terms_days >= 0),
  default_tax_pct numeric(6,3) not null default 0 check (default_tax_pct >= 0 and default_tax_pct <= 100),
  default_terms_text text default 'Payment due within 14 days of the invoice date.',
  payment_instructions text,

  -- What is in the bank. Typed in, with the date it was true, because nothing
  -- here can see a bank account. The runway number says this date out loud so
  -- a stale figure cannot quietly pass as today's.
  cash_on_hand_cents bigint not null default 0 check (cash_on_hand_cents >= 0),
  cash_updated_on date,

  updated_by uuid references auth.users on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.admin_finance_settings (id) values (true) on conflict (id) do nothing;

drop trigger if exists admin_finance_settings_updated_at on public.admin_finance_settings;
create trigger admin_finance_settings_updated_at before update on public.admin_finance_settings
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 3b. WHO WROTE A ROW CANNOT BE FORGED
-- ============================================================
-- created_by has a default of auth.uid(), but a default is only a default — the
-- browser can post any value it likes. This trigger writes the author from the
-- signed-in session on insert, and refuses to let it be changed afterwards.
-- Same pattern, and the same reason, as admin_platform_accounts in 0005:
-- owners-only deletes protect nothing if an admin can put somebody else's name
-- on a row in the first place.
--
-- Written as ONE function used by three triggers. A policy that reads its own
-- table to check the old value would be the other way to do it, and it is the
-- wrong way — row level security re-entering the same table is how you get
-- "infinite recursion detected in policy".

create or replace function public.admin_stamp_created_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists admin_expenses_author on public.admin_expenses;
create trigger admin_expenses_author before insert or update on public.admin_expenses
  for each row execute function public.admin_stamp_created_by();

drop trigger if exists admin_invoices_author on public.admin_invoices;
create trigger admin_invoices_author before insert or update on public.admin_invoices
  for each row execute function public.admin_stamp_created_by();

drop trigger if exists admin_invoice_payments_author on public.admin_invoice_payments;
create trigger admin_invoice_payments_author before insert or update on public.admin_invoice_payments
  for each row execute function public.admin_stamp_created_by();

-- ============================================================
-- 4. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Money is owner/admin only. A sales rep cannot see any of it — not a total,
-- not a count, not an invoice. Same shape as every other admin_ table:
-- admin_is_admin() covers owners and admins, admin_is_owner() is owners only.
--
-- DELETE IS OWNERS ONLY on expenses and invoices, and nobody at all can delete
-- a payment except an owner. The reason is the same one as the platform-login
-- table: if an admin can raise an invoice, take money against it, and then
-- delete the row, the books stop being evidence of anything. Cancelling an
-- invoice (status 'void') is the everyday action and any admin can do it.

grant select, insert, update on public.admin_expenses to authenticated;
grant delete on public.admin_expenses to authenticated;
grant select, insert, update on public.admin_invoices to authenticated;
grant delete on public.admin_invoices to authenticated;
grant select, insert, update on public.admin_invoice_items to authenticated;
grant delete on public.admin_invoice_items to authenticated;
grant select, insert, update on public.admin_invoice_payments to authenticated;
grant delete on public.admin_invoice_payments to authenticated;
grant select, insert, update on public.admin_finance_settings to authenticated;

alter table public.admin_expenses enable row level security;
alter table public.admin_invoices enable row level security;
alter table public.admin_invoice_items enable row level security;
alter table public.admin_invoice_payments enable row level security;
alter table public.admin_finance_settings enable row level security;

-- expenses
drop policy if exists "admins read expenses" on public.admin_expenses;
create policy "admins read expenses" on public.admin_expenses
  for select using (public.admin_is_admin());
drop policy if exists "admins add expenses" on public.admin_expenses;
create policy "admins add expenses" on public.admin_expenses
  for insert with check (public.admin_is_admin());
drop policy if exists "admins edit expenses" on public.admin_expenses;
create policy "admins edit expenses" on public.admin_expenses
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());
drop policy if exists "owners remove expenses" on public.admin_expenses;
create policy "owners remove expenses" on public.admin_expenses
  for delete using (public.admin_is_owner());

-- invoices
drop policy if exists "admins read invoices" on public.admin_invoices;
create policy "admins read invoices" on public.admin_invoices
  for select using (public.admin_is_admin());
drop policy if exists "admins add invoices" on public.admin_invoices;
create policy "admins add invoices" on public.admin_invoices
  for insert with check (public.admin_is_admin());
drop policy if exists "admins edit invoices" on public.admin_invoices;
create policy "admins edit invoices" on public.admin_invoices
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());
drop policy if exists "owners remove invoices" on public.admin_invoices;
create policy "owners remove invoices" on public.admin_invoices
  for delete using (public.admin_is_owner());

-- invoice lines
drop policy if exists "admins read invoice items" on public.admin_invoice_items;
create policy "admins read invoice items" on public.admin_invoice_items
  for select using (public.admin_is_admin());
drop policy if exists "admins write invoice items" on public.admin_invoice_items;
create policy "admins write invoice items" on public.admin_invoice_items
  for insert with check (public.admin_is_admin());
drop policy if exists "admins edit invoice items" on public.admin_invoice_items;
create policy "admins edit invoice items" on public.admin_invoice_items
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());
-- Editing an invoice replaces its lines, so any admin can delete a line.
drop policy if exists "admins remove invoice items" on public.admin_invoice_items;
create policy "admins remove invoice items" on public.admin_invoice_items
  for delete using (public.admin_is_admin());

-- payments
drop policy if exists "admins read payments" on public.admin_invoice_payments;
create policy "admins read payments" on public.admin_invoice_payments
  for select using (public.admin_is_admin());
drop policy if exists "admins add payments" on public.admin_invoice_payments;
create policy "admins add payments" on public.admin_invoice_payments
  for insert with check (public.admin_is_admin());
drop policy if exists "owners edit payments" on public.admin_invoice_payments;
create policy "owners edit payments" on public.admin_invoice_payments
  for update using (public.admin_is_owner()) with check (public.admin_is_owner());
drop policy if exists "owners remove payments" on public.admin_invoice_payments;
create policy "owners remove payments" on public.admin_invoice_payments
  for delete using (public.admin_is_owner());

-- settings
drop policy if exists "admins read finance settings" on public.admin_finance_settings;
create policy "admins read finance settings" on public.admin_finance_settings
  for select using (public.admin_is_admin());
drop policy if exists "owners edit finance settings" on public.admin_finance_settings;
drop policy if exists "admins edit finance settings" on public.admin_finance_settings;
create policy "admins edit finance settings" on public.admin_finance_settings
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());

-- ============================================================
-- 5. WHAT TO CHECK AFTER RUNNING THIS
-- ============================================================
-- select count(*) from public.admin_expenses;            -- 0, no error
-- select * from public.admin_finance_settings;           -- exactly one row
-- Add an invoice in the console, add a part payment, and watch
-- amount_paid_cents on admin_invoices change by itself. That is the trigger.


-- ============================================================
-- 0008_vault_reports.sql
-- ============================================================
-- AI Syndicate ADMIN console — the Vault, and saved client reports.
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Run 0001 through 0007 first.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--   * Re-runnable: every object is created with "if not exists" or dropped
--     and recreated.
--
-- WHAT THIS ADDS, IN PLAIN WORDS
--
--   admin_vault_items    — one row per saved login, card, key or secure note.
--                          The readable part (name, client, username, card
--                          brand and last 4) sits in normal columns. The secret
--                          part (password, full card number, security code)
--                          lives in ONE scrambled column and nowhere else.
--   admin_vault_reveals  — one row every time a person unscrambles a secret.
--                          Who, which item, which fields, when. Never the value.
--   admin_client_reports — one row per report someone generated about a client,
--                          with the exact counts it was written from. Append
--                          only: a new report never replaces an old one.
--
-- ============================================================
-- THE SECURITY POINT — read this before changing anything below
-- ============================================================
--
-- 1. THE SCRAMBLING KEY IS NOT IN THIS DATABASE. It lives in one Vercel
--    environment variable, VAULT_KEY, which only the server can read. So a
--    stolen copy of this database is a list of names and last-4s, not a list of
--    passwords. That is the entire reason secret_cipher is a text column of
--    gibberish instead of a password column.
--
-- 2. THE BROWSER CANNOT WRITE secret_cipher. A trigger below rejects any insert
--    or update that sets or changes it unless the request came in on the
--    service key (the server). Without that trigger, an admin could paste junk
--    over a ciphertext from the browser, or write a plaintext password into the
--    column and it would sit there in the clear looking encrypted.
--
-- 3. A CIPHERTEXT IS TIED TO ITS ROW. The server encrypts with the item's id
--    mixed in ("additional authenticated data"). Copy a ciphertext from the
--    Chase card row onto the Wells Fargo row in the SQL editor and the decrypt
--    fails loudly instead of revealing the wrong card under the wrong name.
--
-- 4. EVERY REVEAL IS WRITTEN DOWN, and the log cannot be edited or deleted by
--    anybody through this console — no update policy, no delete policy, and no
--    insert policy for a signed-in person either. Only the server writes it.
--
-- WHO CAN DO WHAT (Ryder's call, Aug 21 2026)
--   owner  → everything
--   admin  → everything, the same as an owner
--   sales  → nothing. Not the page, not the list, not the count, not the log.
--
-- Note this is deliberately looser than admin_platform_accounts (0005), where
-- delete is owners-only. Ryder chose "owners and admins, everything the same"
-- for the vault. The reveal log is what keeps that honest: an admin can delete
-- an item, but cannot erase the record of having read it, because the log rows
-- survive the item on purpose (item_id is set to null, the label is kept).

-- ============================================================
-- 1. THE VAULT ITEMS
-- ============================================================

create table if not exists public.admin_vault_items (
  id uuid primary key default gen_random_uuid(),

  -- null = ours (AI Syndicate's own account). Otherwise the client it belongs
  -- to. Deleting a client takes its vault items with it.
  client_id uuid references public.admin_clients on delete cascade,

  kind text not null default 'login'
    check (kind in ('login', 'card', 'api_key', 'note')),

  label text not null,                        -- "GoDaddy", "Chase business card"
  description text,                           -- what it is for, in plain words

  -- LOGIN fields (readable — these are not the secret)
  username text,                              -- the login name or email
  url text,                                   -- where you sign in

  -- CARD fields (readable — these are NOT the full number)
  card_brand text,                            -- Visa / Mastercard / Amex / ...
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  card_exp_month int check (card_exp_month is null or (card_exp_month between 1 and 12)),
  card_exp_year int check (card_exp_year is null or (card_exp_year between 2000 and 2100)),
  card_holder text,                           -- name printed on the card
  card_zip text,                              -- billing postcode (asked for at checkout)

  -- THE SECRET. One scrambled blob for every type: password, one-time-code
  -- seed, full card number, security code, PIN, API key, private note.
  -- Written ONLY by /api/vault-secret, on the server, with VAULT_KEY.
  -- Format: v1.<key fingerprint>.<iv>.<tag>.<ciphertext>, all base64url.
  secret_cipher text,
  secret_set_at timestamptz,                  -- when the secret was last written
  secret_by uuid references auth.users on delete set null,
  -- Which fields are inside the blob, e.g. {password} or {number,cvv}. Names
  -- only — this is what lets the card show "security code saved" without
  -- unscrambling anything.
  secret_fields text[] not null default '{}',

  vault_url text,                             -- Bitwarden link. Bitwarden stays the master copy.
  notes text,                                 -- anything else worth knowing. Not the password.
  tags text[] not null default '{}',

  favorite boolean not null default false,
  active boolean not null default true,       -- false = retired, kept for the record
  sort int not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Stamped by a trigger from the signed-in user and frozen afterwards. A
  -- column that says who added it, that the adder can rewrite, records nothing.
  added_by uuid references auth.users on delete set null default auth.uid(),

  -- A card row with no last 4 is a card nobody can tell apart in a list.
  constraint admin_vault_card_needs_last4
    check (kind <> 'card' or card_last4 is not null)
);

comment on table public.admin_vault_items is
  'Passwords, cards and keys. The readable half is in columns; the secret half is in secret_cipher, scrambled with VAULT_KEY which lives only on the server.';
comment on column public.admin_vault_items.secret_cipher is
  'AES-256-GCM, written only by /api/vault-secret. Never readable without VAULT_KEY. A trigger blocks the browser from writing this column.';
comment on column public.admin_vault_items.card_last4 is
  'The last four digits only. The full number lives inside secret_cipher.';
comment on column public.admin_vault_items.vault_url is
  'Bitwarden link. Bitwarden remains the master copy; this console is the index everyone can see.';

create index if not exists admin_vault_items_client_idx
  on public.admin_vault_items (client_id, sort, created_at);
create index if not exists admin_vault_items_kind_idx
  on public.admin_vault_items (kind, active);

drop trigger if exists admin_vault_items_updated_at on public.admin_vault_items;
create trigger admin_vault_items_updated_at before update on public.admin_vault_items
  for each row execute function public.admin_set_updated_at();

-- ------------------------------------------------------------
-- added_by: stamped on insert, frozen on update
-- ------------------------------------------------------------
create or replace function public.admin_vault_stamp_adder()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    new.added_by := coalesce(auth.uid(), new.added_by);
  else
    new.added_by := old.added_by;
  end if;
  return new;
end;
$$;

drop trigger if exists admin_vault_items_adder on public.admin_vault_items;
create trigger admin_vault_items_adder before insert or update on public.admin_vault_items
  for each row execute function public.admin_vault_stamp_adder();

-- ------------------------------------------------------------
-- THE GUARD: only the server may write the secret
-- ------------------------------------------------------------
-- TWO things have to be true, not one.
--
--   1. the database ROLE is service_role (SET ROLE, which PostgREST does for a
--      service-key request and which a signed-in person cannot do), AND
--   2. the JWT claim says service_role.
--
-- Checking only the claim was wrong, and a reviewer proved it: the claim is an
-- ordinary session setting, so `set request.jwt.claim.role='service_role'`
-- inside a normal session walked straight past the guard. PostgREST will not
-- relay an arbitrary setting from a browser, so it was never reachable from the
-- console — but it made the promise below false for anyone at a SQL prompt.
--
-- BE HONEST ABOUT THE LIMIT: a database SUPERUSER (the Supabase SQL editor runs
-- as one) can turn this trigger off and write whatever it likes. No trigger can
-- stop the owner of the database. What this DOES stop is every signed-in
-- console user, and every path the application itself can take.
--
-- It RAISES rather than silently ignoring the change. A guard whose failure
-- mode is silence is not a guard: quietly dropping the write would show
-- "Saved" over a secret that was never stored.
create or replace function public.admin_vault_request_role()
returns text
language plpgsql
stable
as $$
declare
  claims text;
  r text;
begin
  -- The single claim is set on newer PostgREST; the whole claims blob on older.
  r := nullif(current_setting('request.jwt.claim.role', true), '');
  if r is null then
    claims := nullif(current_setting('request.jwt.claims', true), '');
    if claims is not null then
      begin
        r := claims::json ->> 'role';
      exception when others then
        r := null;
      end;
    end if;
  end if;
  return coalesce(r, '');
end;
$$;

-- Is this request really the server? The claim ALONE is not enough — it is an
-- ordinary session setting anyone at a SQL prompt can assign. The current
-- database role is the half that cannot be faked from a PostgREST session.
create or replace function public.admin_vault_is_server()
returns boolean
language plpgsql
stable
as $$
begin
  return current_user = 'service_role'
     and public.admin_vault_request_role() = 'service_role';
end;
$$;

/* NOT security definer, deliberately. Inside a SECURITY DEFINER function
 * current_user is the function's OWNER, not the caller — so the role half of
 * the check would read 'postgres' for everybody and the guard would refuse the
 * real server as well. This function needs no extra privilege: it only inspects
 * the row and raises. */
create or replace function public.admin_vault_secret_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  is_server boolean := public.admin_vault_is_server();
begin
  if is_server then
    return new;
  end if;

  if (tg_op = 'INSERT') then
    if new.secret_cipher is not null then
      raise exception 'The secret has to be saved through the console, not written straight into the table. Add the item first, then press Save on the secret.'
        using errcode = 'check_violation';
    end if;
    /* Claiming a secret that is not there is its own lie: the list would read
     * "PASSWORD SAVED" over an empty row. This used to reset the three columns
     * quietly, which is the silent failure this file elsewhere argues against —
     * so it raises now, and says which fields to drop. */
    if new.secret_fields is not null and array_length(new.secret_fields, 1) > 0 then
      raise exception 'The secret has to be saved through the console. Add the item without secret_fields, then press Save on the secret.'
        using errcode = 'check_violation';
    end if;
    if new.secret_set_at is not null or new.secret_by is not null then
      raise exception 'The secret has to be saved through the console. secret_set_at and secret_by are stamped there, not typed in.'
        using errcode = 'check_violation';
    end if;
  else
    if (new.secret_cipher is distinct from old.secret_cipher)
       or (new.secret_fields is distinct from old.secret_fields)
       or (new.secret_set_at is distinct from old.secret_set_at)
       or (new.secret_by is distinct from old.secret_by) then
      raise exception 'The secret can only be changed through the console (/api/vault-secret), which is the only place that can scramble it.'
        using errcode = 'check_violation';
    end if;

    /* THE CARD FACE, when a number is stored. The last 4 and the brand are
     * worked out from the number by /api/vault-secret; letting anything else
     * write them means the list can point at a card that is not the one behind
     * it. The modal already disables both boxes — this is the half that also
     * holds for a future code path, and for the SQL editor. */
    if (old.secret_cipher is not null
        and old.secret_fields @> array['number']
        and ((new.card_last4 is distinct from old.card_last4)
             or (new.card_brand is distinct from old.card_brand))) then
      raise exception 'The last 4 digits and the card company are read from the stored card number. Change the number to change them.'
        using errcode = 'check_violation';
    end if;

    /* The KIND decides which secret fields the item can hold. Change a card
     * that holds {number, cvv} into a login and the reveal buttons vanish —
     * a login has no "card number" to show — while the card still reads
     * "CARD NUMBER SAVED". The number becomes unreachable through every path
     * in the console, and the last 4 that identified it is wiped on the way
     * out. So: clear the secret first, then change what kind of thing it is. */
    if new.kind is distinct from old.kind and old.secret_cipher is not null then
      raise exception 'This item holds a stored secret, so its kind cannot be changed. Remove what is stored first, then change it.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists admin_vault_items_secret_guard on public.admin_vault_items;
create trigger admin_vault_items_secret_guard before insert or update on public.admin_vault_items
  for each row execute function public.admin_vault_secret_guard();

-- ============================================================
-- 2. THE REVEAL LOG
-- ============================================================
-- One row per unscramble. It outlives the item on purpose: item_id goes null
-- when an item is deleted, and item_label keeps the name, so deleting an item
-- cannot erase the record that somebody read it.

create table if not exists public.admin_vault_reveals (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.admin_vault_items on delete set null,
  item_label text not null,                   -- kept so a deleted item still reads
  client_id uuid references public.admin_clients on delete set null,
  actor uuid references auth.users on delete set null,
  actor_email text,                           -- kept for the same reason
  action text not null default 'reveal',   -- the allowed values are set below,
                                           -- as an ALTER, so a re-run updates them
  fields text[] not null default '{}',        -- WHICH fields. Never the values.
  created_at timestamptz not null default now()
);

comment on table public.admin_vault_reveals is
  'Who unscrambled which secret, and when. Field NAMES only — no value from the vault is ever written here.';

/* `create table if not exists` does NOT update a constraint on a table that is
 * already there. 'delete' and 'copy' were added to this list after the first
 * version of 0008 had already been run on the real project, so re-running the
 * file left the OLD constraint in place — and every press of Remove failed,
 * because the endpoint writes its log row before deleting and the log row was
 * refused. Re-stated explicitly so a redeploy actually applies it.
 * Caught by a reviewer, Aug 21 2026. */
alter table public.admin_vault_reveals
  drop constraint if exists admin_vault_reveals_action_check;
alter table public.admin_vault_reveals
  add constraint admin_vault_reveals_action_check
  check (action in ('reveal', 'copy', 'save', 'clear', 'delete', 'delete_failed'));

create index if not exists admin_vault_reveals_item_idx
  on public.admin_vault_reveals (item_id, created_at desc);
create index if not exists admin_vault_reveals_actor_idx
  on public.admin_vault_reveals (actor, created_at desc);

-- ============================================================
-- 3. SAVED CLIENT REPORTS
-- ============================================================
-- Every "Generate report" press writes a new row. Nothing is ever overwritten,
-- so the history of what we told ourselves about a client is readable in order.

create table if not exists public.admin_client_reports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.admin_clients on delete cascade,

  instruction text,                           -- exactly what the person typed
  preset text,                                -- which button they started from, if any

  title text not null default 'Client report',
  summary text not null default '',           -- the 30-second version
  body text not null default '',              -- the full version
  cannot_check text,                          -- what the records could not answer

  -- 'written' = the AI worded it from the counts. 'counted' = plain code did,
  -- because there is no AI key or the AI's answer failed the check.
  source text not null default 'counted'
    check (source in ('written', 'counted')),
  rejected_why text,                          -- why an AI draft was thrown away

  facts jsonb,                                -- the exact counts it was built from
  counts_at timestamptz,                      -- the moment those counts were taken

  created_by uuid references auth.users on delete set null default auth.uid(),
  created_by_email text,
  created_at timestamptz not null default now()
);

comment on table public.admin_client_reports is
  'Append only. One row per generated report, with the counts it was written from stored beside it.';

create index if not exists admin_client_reports_client_idx
  on public.admin_client_reports (client_id, created_at desc);

-- ============================================================
-- 3b. A REPAIR THAT BELONGS HERE — admin_reminders.link_type
-- ============================================================
-- Not part of the vault. Fixed here because this is the next migration and the
-- report's follow-up count is wrong until it is fixed.
--
-- 0003_inbox.sql set the allowed link types to
--   ('client','lead','task','ticket','email')
-- and 0006_brain_notes_leads.sql dropped and re-added the constraint as
--   ('client','lead','task','ticket','note')
-- — 'note' was added and 'email' was lost in the same statement. Since then any
-- insert with link_type = 'email' has been refused by the database, which means
-- the Inbox's "Remind me" button has failed on every press, and
-- /api/client-report's follow-up query can never match a row.
--
-- Found by a reviewer against a real Postgres, Aug 21 2026.

alter table public.admin_reminders
  drop constraint if exists admin_reminders_link_type_check;
alter table public.admin_reminders
  add constraint admin_reminders_link_type_check
  check (link_type is null or link_type in ('client', 'lead', 'task', 'ticket', 'note', 'email'));

-- ============================================================
-- 4. GRANTS + ROW LEVEL SECURITY
-- ============================================================

-- ---- vault items: owners and admins, everything the same ----
grant select, insert, update, delete on public.admin_vault_items to authenticated;
alter table public.admin_vault_items enable row level security;

drop policy if exists "admins read vault" on public.admin_vault_items;
create policy "admins read vault" on public.admin_vault_items
  for select using (public.admin_is_admin());

drop policy if exists "admins add vault" on public.admin_vault_items;
create policy "admins add vault" on public.admin_vault_items
  for insert with check (public.admin_is_admin());

drop policy if exists "admins edit vault" on public.admin_vault_items;
create policy "admins edit vault" on public.admin_vault_items
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());

drop policy if exists "admins remove vault" on public.admin_vault_items;
create policy "admins remove vault" on public.admin_vault_items
  for delete using (public.admin_is_admin());

-- ---- the reveal log: readable by owners and admins, written by nobody ----
-- No insert, update or delete policy for `authenticated` on purpose. Only the
-- server (service key, which ignores row-level security) writes this table.
-- Nobody can edit their way out of the log from inside the console.
grant select on public.admin_vault_reveals to authenticated;
alter table public.admin_vault_reveals enable row level security;

drop policy if exists "admins read vault log" on public.admin_vault_reveals;
create policy "admins read vault log" on public.admin_vault_reveals
  for select using (public.admin_is_admin());

-- ---- client reports: owners and admins ----
-- Update is never granted at all: a report is a record of what we said at a
-- moment, and editing one in place would make the history a lie. Delete IS
-- granted, so a mistaken press can be cleared away.
grant select, insert, delete on public.admin_client_reports to authenticated;
alter table public.admin_client_reports enable row level security;

drop policy if exists "admins read client reports" on public.admin_client_reports;
create policy "admins read client reports" on public.admin_client_reports
  for select using (public.admin_is_admin());

drop policy if exists "admins add client reports" on public.admin_client_reports;
create policy "admins add client reports" on public.admin_client_reports
  for insert with check (public.admin_is_admin());

drop policy if exists "admins remove client reports" on public.admin_client_reports;
create policy "admins remove client reports" on public.admin_client_reports
  for delete using (public.admin_is_admin());


-- ============================================================
-- 0009_sales.sql
-- ============================================================
-- AI Syndicate ADMIN console — THE SALES SYSTEM.  Aug 21 2026
-- SAFE TO RUN ON THE SHARED (PLATFORM) PROJECT.
--
--   * Run 0001 through 0008 first. 0008 (the Vault) and this file are
--     independent and can be run in either order.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--   * Re-running this file is safe. Every statement is guarded.
--
-- WHAT THIS REPLACES
-- CJ's "Sales Team Outreach Master List" in Google Sheets: one tab per business
-- type, six hand-filled columns, and a Rules of Engagement tab that the sheet
-- has no way to enforce. Everything below exists to make one of those rules
-- true in software. Where a table looks over-built, it is usually holding a
-- fact the sheet had nowhere to put.
--
-- THE ONE DECISION EVERYTHING HANGS ON (Ryder, Aug 21 2026)
-- The record a rep works is the PERSON. Each row of CJ's sheet becomes one
-- lead — a customer profile from the day it arrives — and it stays that same
-- row for its whole life. It does not become a paying client by being copied
-- somewhere else; `became_customer` flips on the row that already holds every
-- call, email and note from the chase. A second row would orphan all of it.
--
-- The COMPANY is a link on that person, not a wrapper around them. It exists
-- for the facts that belong to the firm rather than the human — the website,
-- the site score, the revenue, the head count — so that scoring ACME once
-- scores it for all four ACME contacts, and so the sheet's habit of copying
-- the same website onto four rows (where three then go stale) stops.
--
--   admin_companies     — the firm. Shared facts + the site score.
--   admin_lead_lists    — the sheet's tabs: Luxury Agents, Medspas, and so on.
--   admin_leads         — gains the sales columns: claim dates, cadence,
--                         first contact, the text counter, company + list.
--   admin_proposals     — what was sent, for how much, and what happened.
--   admin_lead_activity — widened: a claim, a score run and a proposal are all
--                         things that happened to a lead and belong on its
--                         timeline next to the calls.

-- ============================================================
-- 1. COMPANIES — the firm behind the contact
-- ============================================================

create table if not exists public.admin_companies (
  id uuid primary key default gen_random_uuid(),

  name text not null,
  -- Lower-cased, punctuation stripped. "ACME | SERHANT." and "Acme Serhant"
  -- land on the same key, which is how four sheet rows become one firm. Not a
  -- unique constraint: see the note above the index below.
  name_key text,
  domain text,

  -- Where they are. City/state are the firm's, which is NOT always the
  -- contact's — the sheet has reps in San Rafael working a San Francisco
  -- dealership, and mixing the two sends somebody to the wrong place.
  address text,
  city text,
  state text,
  country text,
  phone text,

  vertical text,                       -- realtor / lawyer / medspa / dealership…
  employees int,
  annual_revenue bigint,               -- as the export gives it: whole dollars
  linkedin_url text,
  facebook_url text,
  twitter_url text,

  -- THE SCORE GATE. The Rules of Engagement say run a score first and skip
  -- anyone at 90+. The sheet's own Site Score column does not exist on a single
  -- tab, so this has never once happened. Storing it on the firm (not the
  -- person) is what makes it cheap enough to actually do.
  site_score int check (site_score is null or (site_score between 0 and 100)),
  site_score_at timestamptz,
  site_score_by uuid references auth.users on delete set null,
  site_score_note text,

  -- Set when this firm becomes a paying client, so the sales history and the
  -- delivery record point at each other instead of being two islands.
  client_id uuid references public.admin_clients on delete set null,

  notes text,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Deliberately NOT unique, for the same reason the lead dedupe key is not:
-- two genuinely different firms share a name ("Above & Beyond Real Estate"
-- exists in more than one state), and a hard constraint would reject the
-- second one mid-import with nobody watching. Near-duplicates are SHOWN at
-- import, where a person decides.
create index if not exists admin_companies_key_idx on public.admin_companies (name_key);
create index if not exists admin_companies_domain_idx on public.admin_companies (lower(domain)) where domain is not null;
create index if not exists admin_companies_score_idx on public.admin_companies (site_score) where site_score is not null;

create or replace function public.admin_company_name_key(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]', '', 'g'), '');
$$;

revoke execute on function public.admin_company_name_key(text) from anon, public;
grant execute on function public.admin_company_name_key(text) to authenticated;

create or replace function public.admin_companies_stamp_key()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.name_key := public.admin_company_name_key(new.name);
  return new;
end;
$$;

drop trigger if exists admin_companies_key on public.admin_companies;
create trigger admin_companies_key before insert or update on public.admin_companies
  for each row execute function public.admin_companies_stamp_key();

update public.admin_companies
  set name_key = public.admin_company_name_key(name)
  where name_key is null;

drop trigger if exists admin_companies_updated_at on public.admin_companies;
create trigger admin_companies_updated_at before update on public.admin_companies
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 2. LISTS — the sheet's tabs
-- ============================================================
-- Luxury Agents, Law Firm Marketing Directors, Medspas, Car Dealership,
-- Jewelry, Dental Practices. In the sheet a tab is a place a row LIVES, so
-- moving somebody between tabs means cut, paste, and lose their history. Here
-- it is a label on the lead, so a contact can be moved — or sit in two lists —
-- and keep every call ever logged.

create table if not exists public.admin_lead_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  vertical text,
  description text,
  source_id uuid references public.admin_lead_sources on delete set null,
  -- The tab this came from, kept exactly as the spreadsheet spelled it, so an
  -- import that runs twice updates the same list instead of making a second one.
  sheet_tab text,
  active boolean not null default true,
  sort int not null default 0,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_lead_lists_active_idx on public.admin_lead_lists (active, sort, name);

drop trigger if exists admin_lead_lists_updated_at on public.admin_lead_lists;
create trigger admin_lead_lists_updated_at before update on public.admin_lead_lists
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 3. LEADS — the sales columns
-- ============================================================

alter table public.admin_leads add column if not exists company_id uuid references public.admin_companies on delete set null;
alter table public.admin_leads add column if not exists list_id uuid references public.admin_lead_lists on delete set null;

-- The person, as the Apollo export describes them.
alter table public.admin_leads add column if not exists title text;
alter table public.admin_leads add column if not exists seniority text;
alter table public.admin_leads add column if not exists department text;
alter table public.admin_leads add column if not exists linkedin_url text;

-- THE CLAIM. Three separate dates, because the Rules of Engagement ask three
-- different questions of them and one column cannot answer all three:
--   claimed_at        → is first contact late? (3 business days)
--   first_contact_at  → has the claim been honoured at all?
--   last_touch_at     → has it gone cold? (14 days)
-- The sheet has "First Contact" and "Last Touch" as free text, so they hold
-- "8/11/26" and "8/11/2026" and cannot be counted. These are real timestamps.
alter table public.admin_leads add column if not exists claimed_at timestamptz;

-- TWO first-contact columns, because they answer two different questions and
-- one column answering both was a real bug.
--
--   first_contact_at    — the FIRST time we ever spoke to this person. A fact
--                         about the relationship. Set once, never cleared.
--   claim_contacted_at  — has the CURRENT claim been honoured? A fact about
--                         one rep's three-day window. Cleared every time the
--                         lead is claimed, reassigned or handed back.
--
-- Sharing one column meant a released-and-re-claimed lead had to have its
-- first-contact date wiped to stop the 3-day timer firing instantly — which
-- deleted the real date, took the lead out of the speed-to-first-contact
-- sample, and made a lead at proposal stage with nine logged touches report as
-- "never contacted" on the list-health bar.
alter table public.admin_leads add column if not exists first_contact_at timestamptz;
alter table public.admin_leads add column if not exists claim_contacted_at timestamptz;
alter table public.admin_leads add column if not exists last_touch_at timestamptz;
alter table public.admin_leads add column if not exists next_step text;

-- THE CADENCE. 5 touches over ~2 weeks. `cadence_started_at` is normally the
-- claim; it is its own column so a rep who picks an old lead back up can
-- restart the sequence without the dates lying about when the claim happened.
alter table public.admin_leads add column if not exists cadence_started_at timestamptz;
alter table public.admin_leads add column if not exists cadence_paused boolean not null default false;

-- THE TEXT GATE. "Send only if you KNOW they opened. Send ONE."
-- Both halves have to be stored or the rule cannot be checked: whether an open
-- was ever recorded, and how many texts have gone out.
alter table public.admin_leads add column if not exists email_opened_at timestamptz;
alter table public.admin_leads add column if not exists texts_sent int not null default 0;
alter table public.admin_leads add column if not exists last_text_at timestamptz;

-- Closing.
alter table public.admin_leads add column if not exists lost_reason text;
alter table public.admin_leads add column if not exists closed_at timestamptz;

-- The owner's name EXACTLY as the spreadsheet spelled it — "Brandon R" as well
-- as "Brandon Roberts". Kept next to the matched owner_id rather than instead
-- of it, so a wrong match can be found and undone later. Throwing the raw
-- string away is how an import becomes impossible to audit.
alter table public.admin_leads add column if not exists imported_owner_name text;

-- ---- The stage ladder -------------------------------------------------
-- One ladder replaces the sheet's two overlapping columns ("Contacted?" says
-- Yes-Email / No; "Sales Cycle Status" says Contacted / Closed – Lost / Bad
-- contact info). Reps fill one or the other, so neither can be trusted.
--
-- The three added at the end are not failures and are not the same as Lost:
--   skip_90     — scored 90+. Already doing well. Not a prospect. (Rule 5.)
--   bad_contact — the email bounces or the number is dead. Nobody's fault.
--   reopened    — was claimed, went stale, came back to the floor.
alter table public.admin_leads drop constraint if exists admin_leads_stage_check;
alter table public.admin_leads
  add constraint admin_leads_stage_check
  check (stage in (
    'new','researching','contacted','in_conversation','follow_up',
    'meeting','proposal','won','lost','skip_90','bad_contact','reopened'
  ));

-- 0006 widened this once already; 'sheet' is in there. Adding the two ways a
-- lead can arrive that did not exist then.
alter table public.admin_leads drop constraint if exists admin_leads_source_check;
alter table public.admin_leads
  add constraint admin_leads_source_check
  check (source in ('platform','csv','sheet','scraper','manual','referral','inbound','import'));

create index if not exists admin_leads_company_idx on public.admin_leads (company_id) where company_id is not null;
create index if not exists admin_leads_list_idx on public.admin_leads (list_id) where list_id is not null;
-- The index the queue actually reads: whose is it, is it open, when was it touched.
create index if not exists admin_leads_claim_idx on public.admin_leads (owner_id, stage, last_touch_at);
create index if not exists admin_leads_firstcontact_idx on public.admin_leads (claimed_at) where first_contact_at is null;

-- ---- Keeping last_touch_at honest -------------------------------------
-- A rep logs a call and the cold timer should reset. Doing that in the browser
-- means it stops happening the day anything else writes an activity row — the
-- assistant, a script, the overnight sweep. So the database does it.
--
-- A call, an email, a text or a LinkedIn touch counts. A status change does
-- NOT: the sheet's whole failure mode is a row that looks alive because
-- somebody fiddled with a dropdown, and a firm that gets a fresh 14 days every
-- time somebody re-picks a status is a firm nobody ever calls again.
--
-- HONEST LIMIT: this table has no direction column, so an INBOUND email logged
-- by hand as type 'email' counts exactly like an outbound one — it resets the
-- 14-day timer and advances the cadence. Saying "outbound only" here would be
-- describing a column that does not exist.
create or replace function public.admin_lead_activity_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.type in ('call','email','text','linkedin') then
    update public.admin_leads
      set last_touch_at = greatest(coalesce(last_touch_at, new.created_at), new.created_at),
          -- The current claim's window: set by the first touch after a claim,
          -- and left alone by every touch after that.
          claim_contacted_at = coalesce(claim_contacted_at, new.created_at),
          -- LEAST, not coalesce. `coalesce(first_contact_at, new.created_at)`
          -- keeps whichever touch was INSERTED first, not whichever HAPPENED
          -- first: replay a history out of order — an import, a batch insert
          -- whose order Postgres does not promise — and a firm first emailed in
          -- May records first contact in August. That number then feeds
          -- speed-to-first-contact on the rep scoreboard.
          first_contact_at = least(coalesce(first_contact_at, new.created_at), new.created_at),
          last_activity_at = greatest(coalesce(last_activity_at, new.created_at), new.created_at)
      where id = new.lead_id;
  else
    update public.admin_leads
      set last_activity_at = greatest(coalesce(last_activity_at, new.created_at), new.created_at)
      where id = new.lead_id;
  end if;
  return new;
end;
$$;

drop trigger if exists admin_lead_activity_touch_trg on public.admin_lead_activity;
create trigger admin_lead_activity_touch_trg after insert on public.admin_lead_activity
  for each row execute function public.admin_lead_activity_touch();

-- The timeline can hold more kinds of event now. Everything that happens to a
-- lead belongs in one list — a rep should not have to read three panels to
-- find out what has been done.
alter table public.admin_lead_activity drop constraint if exists admin_lead_activity_type_check;
alter table public.admin_lead_activity
  add constraint admin_lead_activity_type_check
  check (type in (
    'call','email','text','linkedin','note','status_change','assigned',
    'claim','unclaim','reopen','score','proposal','import','cadence','open'
  ));

-- ---- THE ONE-TEXT RULE, ENFORCED BY THE DATABASE ----------------------
-- "Send ONE text. One. Not a sequence."
--
-- The browser was doing `texts_sent = texts_sent + 1` as a read-modify-write:
-- read 0, add 1, write 1. Two open tabs — or two reps — both read 0, both
-- write 1, and two texts go out under a counter that says one. The rule that
-- exists to stop our numbers being flagged was beatable by a second tab.
--
-- This claims the text instead: it increments ONLY if the lead is under the
-- limit, in one statement, and returns whether it won. A second caller gets
-- false and the page says so.
create or replace function public.admin_lead_claim_text(p_lead uuid, p_max int default 1)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated int;
begin
  if not public.admin_is_member() then
    raise exception 'not authorized';
  end if;
  update public.admin_leads
    set texts_sent = coalesce(texts_sent, 0) + 1,
        last_text_at = now()
    where id = p_lead
      and coalesce(texts_sent, 0) < p_max
      -- The open is checked here too. A gate enforced only in the browser is
      -- not a gate; this is the same rule in the one place it cannot be
      -- skipped by an old tab or a script.
      and email_opened_at is not null;
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

revoke execute on function public.admin_lead_claim_text(uuid, int) from anon, public;
grant execute on function public.admin_lead_claim_text(uuid, int) to authenticated;

-- A counter can never be negative or absurd, whatever writes it.
alter table public.admin_leads drop constraint if exists admin_leads_texts_sent_check;
alter table public.admin_leads
  add constraint admin_leads_texts_sent_check check (texts_sent >= 0 and texts_sent <= 50);
update public.admin_leads set texts_sent = 0 where texts_sent is null or texts_sent < 0;

-- ============================================================
-- 4. PROPOSALS — what the sheet had nowhere to put
-- ============================================================
-- The sheet's pipeline stops at "meeting held". There is no record of what was
-- proposed, for how much, or why it was lost — which is exactly the half that
-- would tell CJ what to do differently.

create table if not exists public.admin_proposals (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.admin_leads on delete cascade,
  company_id uuid references public.admin_companies on delete set null,

  title text not null,
  package text,                                   -- which of our plans
  amount_cents bigint,                            -- cents, like everything else in Finance
  currency text not null default 'usd',
  term text,                                      -- 'monthly' / 'one-off' / free text

  status text not null default 'draft'
    check (status in ('draft','sent','viewed','won','lost','withdrawn')),
  sent_at timestamptz,
  viewed_at timestamptz,
  decided_at timestamptz,
  lost_reason text,

  doc_url text,                                   -- the deck or the PDF
  notes text,

  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_proposals_lead_idx on public.admin_proposals (lead_id, created_at desc);
create index if not exists admin_proposals_status_idx on public.admin_proposals (status, sent_at desc);

drop trigger if exists admin_proposals_updated_at on public.admin_proposals;
create trigger admin_proposals_updated_at before update on public.admin_proposals
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 5. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Ryder's call, Aug 21 2026: reps do not step on each other, so there is NO
-- lock between them. Any member — owner, admin or sales — reads and writes the
-- sales tables. The "one firm, one rep" rule is enforced as a warning the
-- person reads before they send, in lib/sales-rules.js, not as a wall here.
--
-- What is still closed: only an admin or owner may DELETE. A rep who mis-clicks
-- should lose an afternoon, not a list. And the money tables, the vault, the
-- shared inbox and the Brain remain closed to sales exactly as before — this
-- file loosens nothing that was already shut.

grant select, insert, update on public.admin_companies to authenticated;
grant delete on public.admin_companies to authenticated;
grant select, insert, update on public.admin_lead_lists to authenticated;
grant delete on public.admin_lead_lists to authenticated;
grant select, insert, update on public.admin_proposals to authenticated;
grant delete on public.admin_proposals to authenticated;

alter table public.admin_companies enable row level security;
alter table public.admin_lead_lists enable row level security;
alter table public.admin_proposals enable row level security;

drop policy if exists "members read companies" on public.admin_companies;
create policy "members read companies" on public.admin_companies
  for select using (public.admin_is_member());
drop policy if exists "members write companies" on public.admin_companies;
create policy "members write companies" on public.admin_companies
  for insert with check (public.admin_is_member());
drop policy if exists "members update companies" on public.admin_companies;
create policy "members update companies" on public.admin_companies
  for update using (public.admin_is_member());
drop policy if exists "admins delete companies" on public.admin_companies;
create policy "admins delete companies" on public.admin_companies
  for delete using (public.admin_is_admin());

drop policy if exists "members read lead lists" on public.admin_lead_lists;
create policy "members read lead lists" on public.admin_lead_lists
  for select using (public.admin_is_member());
drop policy if exists "members write lead lists" on public.admin_lead_lists;
create policy "members write lead lists" on public.admin_lead_lists
  for insert with check (public.admin_is_member());
drop policy if exists "members update lead lists" on public.admin_lead_lists;
create policy "members update lead lists" on public.admin_lead_lists
  for update using (public.admin_is_member());
drop policy if exists "admins delete lead lists" on public.admin_lead_lists;
create policy "admins delete lead lists" on public.admin_lead_lists
  for delete using (public.admin_is_admin());

drop policy if exists "members read proposals" on public.admin_proposals;
create policy "members read proposals" on public.admin_proposals
  for select using (public.admin_is_member());
drop policy if exists "members write proposals" on public.admin_proposals;
create policy "members write proposals" on public.admin_proposals
  for insert with check (public.admin_is_member());
drop policy if exists "members update proposals" on public.admin_proposals;
create policy "members update proposals" on public.admin_proposals
  for update using (public.admin_is_member());
drop policy if exists "admins delete proposals" on public.admin_proposals;
create policy "admins delete proposals" on public.admin_proposals
  for delete using (public.admin_is_admin());

-- ============================================================
-- 6. BACKFILL — nothing that already exists is left behind
-- ============================================================
-- Leads that pre-date this file have an owner but no claim date, so every
-- timer would read them as "claimed at the beginning of time" and hand the
-- whole pipeline back to the floor on the first sweep. Stamp the claim from
-- what is already known, oldest sensible date first.

-- The claim date is stamped from what is already known so the page can SHOW
-- something true. It does NOT arm the overnight sweep: api/sales-sweep.js
-- refuses to release any claim it has not already warned about, so the first
-- run after this migration warns and the second acts. Without that rule this
-- one statement would have handed the entire legacy pipeline back to the floor
-- overnight, from a job with nobody watching — the exact opposite of what it
-- was written to prevent.
update public.admin_leads
  set claimed_at = coalesce(claimed_at, last_activity_at, created_at)
  where owner_id is not null and claimed_at is null;

-- A lead that has logged activity has plainly been contacted. Anything with no
-- activity at all is left NULL — "we do not know" is a true answer and an
-- invented first-contact date would start a 14-day cold timer on a lead nobody
-- has ever rung.
update public.admin_leads l
  set first_contact_at = a.first_at,
      claim_contacted_at = coalesce(l.claim_contacted_at, a.first_at),
      last_touch_at = coalesce(l.last_touch_at, a.last_at)
  from (
    select lead_id, min(created_at) as first_at, max(created_at) as last_at
    from public.admin_lead_activity
    where type in ('call','email','text','linkedin')
    group by lead_id
  ) a
  where a.lead_id = l.id and l.first_contact_at is null;


-- ============================================================
-- 0010_console_reports.sql
-- ============================================================
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


-- ============================================================
-- 0011_console_feedback.sql
-- ============================================================
-- ============================================================
-- 0011 — RATING THE OVERVIEW GENERATOR, AND LEARNING FROM IT
-- ============================================================
-- Aug 23 2026. Two things.
--
-- 1. The generator's "free draft" mode is GONE. Ryder: "i want it to always
--    come from real stats, it should never be free or make up anything. thats
--    just a way for it to hallucinate." Every answer is now checked against the
--    counts, so the mode column only ever holds 'records'. Any older row is
--    moved over and the check is tightened, because a column that still allows
--    a value the code can no longer produce is a trap for the next person.
--
-- 2. A star rating and an optional note, per answer. The notes are read back on
--    the NEXT run and put into the instruction, so telling it "too long, lead
--    with the money" actually changes the next one.
--
-- Append-only, like every other record table here. Rating the same answer twice
-- writes a second row; the newest wins when it is read. Nothing is overwritten,
-- so "I hated it, then I re-read it and it was fine" is a history, not a
-- correction.
--
-- Safe to run twice. Only admin_-prefixed objects, every statement guarded.

-- ---- 1. one mode, enforced ------------------------------------------------

update public.admin_console_reports set mode = 'records' where mode <> 'records';

alter table public.admin_console_reports drop constraint if exists admin_console_reports_mode_check;
alter table public.admin_console_reports
  add constraint admin_console_reports_mode_check
  check (mode in ('records'));

-- ---- 2. the feedback ------------------------------------------------------

create table if not exists public.admin_console_feedback (
  id uuid primary key default gen_random_uuid(),

  -- Cascade: if the answer is deleted, the note about it is meaningless.
  report_id uuid not null references public.admin_console_reports on delete cascade,

  -- 1 = useless, 5 = exactly right. Required — a note with no rating gives the
  -- next run no idea how strongly to weight it.
  rating int not null check (rating between 1 and 5),

  -- Optional, and this is the part that actually teaches it something.
  -- "Too long." "Lead with the money." "Stop repeating the client's name."
  note text,

  created_by uuid references auth.users on delete set null default auth.uid(),
  created_by_email text,
  created_at timestamptz not null default now()
);

-- The read is always "the newest notes, worst rating first".
create index if not exists admin_console_feedback_recent_idx
  on public.admin_console_feedback (created_at desc);
create index if not exists admin_console_feedback_report_idx
  on public.admin_console_feedback (report_id, created_at desc);

-- ---- who can touch it ----------------------------------------------------
-- Same gate as the answers themselves: owner and admin. A note can quote the
-- content of an answer, and an answer can summarise every client and invoice at
-- once, so this table inherits that sensitivity.

alter table public.admin_console_feedback enable row level security;

grant select, insert, delete on public.admin_console_feedback to authenticated;

drop policy if exists admin_console_feedback_read on public.admin_console_feedback;
create policy admin_console_feedback_read on public.admin_console_feedback
  for select to authenticated using (public.admin_is_admin());

drop policy if exists admin_console_feedback_write on public.admin_console_feedback;
create policy admin_console_feedback_write on public.admin_console_feedback
  for insert to authenticated with check (public.admin_is_admin());

drop policy if exists admin_console_feedback_delete on public.admin_console_feedback;
create policy admin_console_feedback_delete on public.admin_console_feedback
  for delete to authenticated using (public.admin_is_admin());

-- No update policy, on purpose. Changing your mind writes a new row.


-- ============================================================
-- 0012_task_description.sql
-- ============================================================
-- ============================================================
-- 0012 — A REAL DESCRIPTION ON EVERY TASK
-- ============================================================
-- Aug 23 2026. Ryder: "in operations i want to have a description for the project
-- that can go more in depth."
--
-- `latest_report` (0001) already exists and is NOT this. That field is the
-- one-line status you read in the table — "12 of 26 pages done." It gets
-- overwritten every time the work moves. A brief does not belong in a field
-- that is rewritten weekly, which is why this is its own column.
--
--   description   = the standing brief. What the work is, why, what "done"
--                   means, links, anything a person needs before starting.
--   latest_report = where it stands right now.
--
-- Safe to run twice. One guarded column add, nothing dropped, no data touched.

alter table public.admin_tasks
  add column if not exists description text;

comment on column public.admin_tasks.description is
  'The standing brief for this piece of work — what it is, why, what done means. Not the status; that is latest_report.';


-- ============================================================
-- 0013_client_connections.sql
-- ============================================================
-- AI Syndicate ADMIN console — the client's own accounts, connected.
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Run 0001 through 0012 first.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--
-- WHAT THIS IS FOR, IN PLAIN WORDS
--
-- Every client already has websites, logins and reports in this console. What
-- it did NOT have was a way to read their real numbers. So a report could say
-- what WE did and never what actually HAPPENED — no clicks, no calls, no
-- searches, no map views. Every one of those numbers lives in an account the
-- client already owns:
--
--   GSC  — Google Search Console: how many times their site showed up in
--          Google and how many people clicked it.
--   GBP  — Google Business Profile: the map listing. Calls, direction taps,
--          website taps, and how people found them.
--   GA4  — Google Analytics 4: what people did once they were on the site.
--   Bing — Bing Webmaster Tools: the same idea as GSC, for Bing and Copilot.
--
-- This adds two tables:
--
--   1. admin_client_connections — one row per account we are connected to.
--      For a Google account the row holds a refresh token, which is a long
--      pass that lets the console ask Google for fresh numbers without anybody
--      logging in again.
--
--   2. admin_connection_snapshots — the numbers we actually read, with the
--      date we read them and the exact dates they cover. A report quotes a
--      SNAPSHOT, never a live call, so the same report always shows the same
--      numbers and anybody can check them months later.
--
-- THE REFRESH TOKEN IS SCRAMBLED, exactly like a vault password: the database
-- holds gibberish, and the key (VAULT_KEY) lives only in Vercel. Whoever gets
-- a copy of this table gets no access to a single client account.

-- ============================================================
-- 1. THE CONNECTIONS
-- ============================================================

create table if not exists public.admin_client_connections (
  id uuid primary key default gen_random_uuid(),

  -- Always belongs to a client. Delete the client, the connection goes too.
  client_id uuid not null references public.admin_clients on delete cascade,

  -- Which service. Keep this list in step with PROVIDERS in lib/connectors.js;
  -- tests/connectors reads both and fails if they drift.
  provider text not null
    check (provider in ('gsc','gbp','ga4','bing','other')),

  -- How we get in. 'google' = we hold a refresh token and can read by ourselves.
  -- 'manual' = nobody has connected it; a person types the numbers in, or it is
  -- only a note of where the account lives.
  auth_kind text not null default 'manual'
    check (auth_kind in ('google','manual')),

  label text not null,                    -- "Shiner Law — Search Console"
  account_email text,                     -- the Google account that granted it

  -- The exact thing chosen inside that account. One connection = one property,
  -- because a Google login can see twenty sites and a report about "the site"
  -- must say WHICH.
  --   gsc  → sc-domain:example.com  or  https://example.com/
  --   ga4  → properties/123456789
  --   gbp  → locations/1234567890  (and accounts/… in meta)
  property text,
  property_label text,                    -- what to call it on screen

  -- The scrambled sign-in does NOT live on this row. It lives in
  -- admin_connection_secrets below, a table no signed-in browser has any
  -- permission on at all. See the long note above that table for why a
  -- column on this row would not have been good enough.
  scope text,                             -- what Google actually granted (not a secret)

  status text not null default 'manual'
    check (status in ('manual','connected','needs_reconnect','error')),

  last_synced_at timestamptz,
  last_error text,
  meta jsonb not null default '{}'::jsonb, -- account ids, site lists, notes
  notes text,

  active boolean not null default true,
  sort int not null default 0,

  connected_at timestamptz,
  connected_by uuid references auth.users on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  added_by uuid references auth.users on delete set null default auth.uid()
);

comment on table public.admin_client_connections is
  'One row per client account we can read numbers out of (Search Console, Business Profile, Analytics, Bing).';
comment on column public.admin_client_connections.property is
  'The one property this row reads. gsc: sc-domain:example.com. ga4: properties/123. gbp: locations/123.';

-- One connection per client per provider per PROPERTY. Connect the same
-- Search Console site twice and the second press updates the first row
-- instead of quietly making a duplicate that reports twice.
--
-- ROWS WITH NO PROPERTY YET ARE EXEMPT. That is what the WHERE does. A card
-- can exist before anybody has chosen which site it reads — a typed-in Bing
-- card, or a Google sign-in that came back before the person picked a
-- property — and a client with two shop locations needs two of them at once.
-- Keying those on an empty string made the second one fail with a database
-- error about a constraint, under a message telling the person to change a
-- property neither card had.
create unique index if not exists admin_client_connections_one_per_property
  on public.admin_client_connections (client_id, provider, property)
  where property is not null and property <> '';

create index if not exists admin_client_connections_client_idx
  on public.admin_client_connections (client_id, sort, created_at);

drop trigger if exists admin_client_connections_updated_at on public.admin_client_connections;
create trigger admin_client_connections_updated_at before update on public.admin_client_connections
  for each row execute function public.admin_set_updated_at();

-- Same rule as the platform login cards (0005): who added it is stamped from
-- the signed-in user and can never be rewritten afterwards.
create or replace function public.admin_client_connections_stamp_adder()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    new.added_by := coalesce(auth.uid(), new.added_by);
  else
    new.added_by := old.added_by;
  end if;
  return new;
end;
$$;

drop trigger if exists admin_client_connections_adder on public.admin_client_connections;
create trigger admin_client_connections_adder before insert or update on public.admin_client_connections
  for each row execute function public.admin_client_connections_stamp_adder();

-- ============================================================
-- 1a. WHERE THE SIGN-IN ITSELF LIVES
-- ============================================================
-- A separate table, with NO permissions granted to anybody who signs in to the
-- console. Not a column on the row above. The reason is worth writing down,
-- because the first version of this migration got it wrong:
--
--   Taking a permission away from ONE COLUMN does not work in PostgreSQL when
--   the whole table has already been granted. `grant select on t to r` covers
--   every column, and a later `revoke select (c) on t from r` does not carve
--   the column back out. Supabase also grants `authenticated` everything on a
--   new table in the public schema by default. So a column here would have
--   been readable — and writable — by any signed-in admin's browser, and by
--   anything that got hold of a session token.
--
--   It is only ever gibberish (scrambled with VAULT_KEY, which lives on the
--   server), so reading it would not by itself open a client's account. That
--   is not a reason to hand it out.
--
-- Only the service role reaches this table, and the service role runs on the
-- server only. Row level security is on with NO policies at all, which is a
-- deliberate belt-and-braces: even if a grant were added by mistake later,
-- every row would still be invisible.

create table if not exists public.admin_connection_secrets (
  connection_id uuid primary key
    references public.admin_client_connections on delete cascade,

  -- AES-256-GCM, from lib/vault-crypto.js, tied to the connection id.
  -- A blob copied onto another row in the SQL editor fails to unscramble
  -- rather than quietly opening the wrong client's account.
  refresh_token_enc text not null,

  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users on delete set null
);

comment on table public.admin_connection_secrets is
  'The scrambled Google sign-in for each connection. Service role only — no signed-in browser has any permission on this table.';

-- Nothing granted, and anything Supabase granted by default taken back.
revoke all on public.admin_connection_secrets from authenticated;
revoke all on public.admin_connection_secrets from anon;

alter table public.admin_connection_secrets enable row level security;
-- No policies, on purpose. See the note above.

-- ============================================================
-- 1b. THE SIGN-IN HAND-OFF NEEDS TO REMEMBER WHO IT IS FOR
-- ============================================================
-- admin_oauth_states already carries a one-time `state` string through a
-- Google sign-in (0001, built for Gmail). A client connection also has to
-- remember WHICH client and WHICH service the person pressed Connect on —
-- and that must not travel in the address bar, where anybody could edit it
-- and attach an account to the wrong client's record.

alter table public.admin_oauth_states
  add column if not exists payload jsonb;

comment on column public.admin_oauth_states.payload is
  'What the sign-in is for — { clientId, provider }. Kept here, never in the address bar, so the browser cannot change it mid-flow.';

-- ============================================================
-- 2. THE NUMBERS WE READ
-- ============================================================
-- One row per read. Never overwritten: last month's snapshot is what last
-- month's report was written from, and rewriting it would make that report
-- unprovable. Old rows are history, not clutter.

create table if not exists public.admin_connection_snapshots (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references public.admin_client_connections on delete set null,

  -- Kept even when the connection row is deleted, so a report written in March
  -- can still be checked in September. This is why connection_id is nullable
  -- and client_id is not.
  client_id uuid not null references public.admin_clients on delete cascade,
  provider text not null,
  -- NOT NULL with an empty default, unlike the connection row's nullable one.
  -- The uniqueness rule below has to be a plain list of columns for the server
  -- to be able to say "replace the row that matches these" — and a NULL never
  -- matches a NULL, so a nullable property would let the same read pile up all
  -- day. Empty string means "this provider has no property of its own".
  property text not null default '',

  -- The dates the numbers COVER — not the date we asked.
  period_start date not null,
  period_end date not null,

  -- When we asked. This is the date a report must print next to the numbers.
  taken_at timestamptz not null default now(),
  -- The same moment as a plain day, written by whoever inserts the row.
  -- It exists because "one read per window per day" has to be enforced by the
  -- database, and a day cannot be worked out from taken_at inside an index:
  -- turning a timestamp into a date depends on the time zone, and Postgres
  -- refuses to index anything whose answer can change.
  taken_on date not null default ((now() at time zone 'utc')::date),
  taken_by uuid references auth.users on delete set null,

  -- 'api' = read straight out of the client's account. 'manual' = a person
  -- typed it in. A report has to say which, so the two can never be blended.
  source text not null default 'api'
    check (source in ('api','manual')),

  -- The counted numbers, already normalised by lib/connector-fetch.js.
  metrics jsonb not null default '{}'::jsonb,
  -- The short plain-words lists (top searches, top pages). Capped when written.
  detail jsonb not null default '{}'::jsonb,

  note text,
  created_at timestamptz not null default now()
);

comment on table public.admin_connection_snapshots is
  'Numbers read out of a client account on a date. Append only in practice: a report quotes a snapshot, so rewriting one makes that report uncheckable.';
comment on column public.admin_connection_snapshots.source is
  'api = read from the account. manual = typed by a person. Never blend the two in a report.';

create index if not exists admin_connection_snapshots_client_idx
  on public.admin_connection_snapshots (client_id, provider, period_end desc, taken_at desc);

create index if not exists admin_connection_snapshots_conn_idx
  on public.admin_connection_snapshots (connection_id, taken_at desc);

-- A second read of the same window on the same day replaces the first rather
-- than piling up. Different windows, or a read on another day, are new rows.
--
-- PLAIN COLUMNS ONLY. The server names this exact list when it saves, and it
-- can only name real columns — an index over an expression would not be
-- something it could point at, and every read would insert instead of replace.
create unique index if not exists admin_connection_snapshots_one_per_day
  on public.admin_connection_snapshots
     (client_id, provider, property, period_start, period_end, taken_on);

-- ============================================================
-- 3. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Owners and admins only, same as the rest of Delivery. A sales rep cannot see
-- the tables at all.
--
-- DELETE ON CONNECTIONS IS OWNERS ONLY, for the same reason as 0005: this is
-- the record of which client accounts this console can read. Switching a
-- connection off is the everyday action and any admin can do it. Removing the
-- row is an owner's call.
--
-- SNAPSHOTS CANNOT BE CHANGED BY ANYBODY. There is no update policy and no
-- update grant. A measurement that can be edited after a report quoted it is
-- not a measurement.

grant select, insert, update on public.admin_client_connections to authenticated;
grant delete on public.admin_client_connections to authenticated;


alter table public.admin_client_connections enable row level security;

drop policy if exists "admins read connections" on public.admin_client_connections;
create policy "admins read connections" on public.admin_client_connections
  for select using (public.admin_is_admin());

drop policy if exists "admins add connections" on public.admin_client_connections;
create policy "admins add connections" on public.admin_client_connections
  for insert with check (public.admin_is_admin());

drop policy if exists "admins edit connections" on public.admin_client_connections;
create policy "admins edit connections" on public.admin_client_connections
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());

drop policy if exists "owners remove connections" on public.admin_client_connections;
create policy "owners remove connections" on public.admin_client_connections
  for delete using (public.admin_is_owner());

grant select, insert on public.admin_connection_snapshots to authenticated;
grant delete on public.admin_connection_snapshots to authenticated;

alter table public.admin_connection_snapshots enable row level security;

drop policy if exists "admins read snapshots" on public.admin_connection_snapshots;
create policy "admins read snapshots" on public.admin_connection_snapshots
  for select using (public.admin_is_admin());

-- Inserting by hand is how a typed-in number gets on the record. It is forced
-- to say source = 'manual': only the server (service role) may write 'api',
-- because only the server actually asked the account.
drop policy if exists "admins add manual snapshots" on public.admin_connection_snapshots;
create policy "admins add manual snapshots" on public.admin_connection_snapshots
  for insert with check (public.admin_is_admin() and source = 'manual');

drop policy if exists "owners remove snapshots" on public.admin_connection_snapshots;
create policy "owners remove snapshots" on public.admin_connection_snapshots
  for delete using (public.admin_is_owner());


-- ============================================================
-- 0014_report_shape.sql
-- ============================================================
-- AI Syndicate ADMIN console — remembering HOW a report was asked to read.
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Run 0001 through 0013 first.
--   * This is the smallest migration in the set: two columns and two comments.
--     It changes no data, drops nothing, and cannot fail on existing rows.
--
-- WHY IT EXISTS
--
-- The Generate report box now asks two questions instead of one:
--
--   1. WHAT TO COVER and how deep      → saved in `instruction` (already there)
--   2. WHO IT IS FOR and WHAT SHAPE    → saved here
--
-- The second one is what decides whether the answer comes back as something
-- you can paste straight into an email or as an internal write-up with our own
-- shorthand in it. Six weeks later, "why does this one read like an email?" has
-- an answer sitting on the row instead of being a mystery.
--
-- THE CONSOLE WORKS WITHOUT THIS MIGRATION. api/client-report.js notices the
-- column missing and saves the report anyway, minus the shape, with a line on
-- screen saying so. A report you cannot generate is a much worse outcome than
-- a report whose shape was not recorded.

alter table public.admin_client_reports
  add column if not exists shape text;

alter table public.admin_client_reports
  add column if not exists shape_preset text;

comment on column public.admin_client_reports.shape is
  'How the person asked it to read — who it is for and what shape to come back in. Their words, saved so an old report can be explained.';
comment on column public.admin_client_reports.shape_preset is
  'Which button filled that box in, if any: internal / forward / email / text / bullets. Free text, deliberately not constrained — the list in lib/client-report.js is expected to grow.';


-- ============================================================
-- 0015_sales_lifecycle.sql
-- ============================================================
-- AI Syndicate ADMIN console — ONE RECORD, FROM LEAD TO PAYING CLIENT.  Aug 25 2026
-- SAFE TO RUN ON THE SHARED (PLATFORM) PROJECT.
--
--   * Run 0001 through 0014 first. This file is independent of 0010-0014 and
--     can be run before or after any of them. It DOES need 0009 (the sales
--     tables) to have run.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--   * Re-running this file is safe. Every statement is guarded, and the one
--     function that writes is idempotent by design — see section 3.
--
-- WHAT THIS FIXES
-- Ryder, Aug 21 2026, and it has been the plan since: "a lead IS a customer
-- profile from day one. One record its whole life." The tables were built for
-- that on Aug 22 — `admin_leads.became_customer` and `admin_companies.client_id`
-- both exist — and then NOTHING EVER WROTE EITHER OF THEM. Marking a deal Won
-- put a green pill on a row and did not create a client, did not link a firm,
-- and left the entire chase history on the far side of a gap nothing crossed.
-- The toast on the page said so out loud, which is honest, and useless.
--
-- Ryder, Aug 25 2026: "have everything connected and context saved to all
-- people in our system from the time there created as a lead all the way to a
-- paying client and beyond."
--
-- So this file does three things:
--   1. Gives a person a real first and last name, because the sheet has two
--      columns and we had one.
--   2. Adds the two links that were missing and were never going to fill
--      themselves in.
--   3. Adds ONE function that turns a won deal into a client — every person at
--      that firm attached to it, the whole timeline carried across, and safe to
--      call twice.

-- ============================================================
-- 1. THE PERSON'S NAME, IN TWO HALVES
-- ============================================================
-- CJ's sheet has First Name and Last Name. The importer read both columns and
-- then JOINED them into one `name`, so the sheet's own layout could not be
-- rebuilt from our data. Both halves are stored now. `name` stays as the
-- display name and as the record of what we were actually handed.

alter table public.admin_leads add column if not exists first_name text;
alter table public.admin_leads add column if not exists last_name text;

-- Backfill, ONCE, and only where both halves are empty.
--
-- First word first, the rest last. That is wrong for "Mary Jo Van Der Berg"
-- and there is no rule that is right for every name on earth. It is safe here
-- ONLY because `name` is not touched: the guess is visible in two cells that a
-- person can correct in one click, and the original is still underneath it. A
-- backfill that rewrote `name` from its own guess would be unrecoverable.
update public.admin_leads
  set first_name = nullif(split_part(btrim(regexp_replace(name, '\s+', ' ', 'g')), ' ', 1), ''),
      last_name  = nullif(btrim(substr(
                     btrim(regexp_replace(name, '\s+', ' ', 'g')),
                     length(split_part(btrim(regexp_replace(name, '\s+', ' ', 'g')), ' ', 1)) + 1
                   )), '')
  where first_name is null and last_name is null
    and name is not null and btrim(name) <> '';

create index if not exists admin_leads_lastname_idx on public.admin_leads (lower(last_name)) where last_name is not null;

-- ============================================================
-- 2. THE TWO LINKS THAT WERE MISSING
-- ============================================================

-- On the PERSON: which client they belong to once the firm starts paying.
-- Every contact at that firm gets it, not only the one whose deal closed —
-- that is what makes "context saved to all people" true rather than a phrase.
alter table public.admin_leads add column if not exists client_id uuid references public.admin_clients on delete set null;
alter table public.admin_leads add column if not exists became_customer_at timestamptz;
alter table public.admin_leads add column if not exists became_customer_by uuid references auth.users on delete set null;

create index if not exists admin_leads_client_idx on public.admin_leads (client_id) where client_id is not null;

-- On the CLIENT: which firm in the sales system they came from. The reverse
-- link already existed (admin_companies.client_id, added in 0009 and written by
-- nothing). Both directions are stored because both directions get asked:
-- the sales page asks "is this firm already a client", and the client page asks
-- "show me how this one started".
alter table public.admin_clients add column if not exists company_id uuid references public.admin_companies on delete set null;

-- How this client record came to exist. A client typed in by hand and a client
-- that came up through the pipeline are different facts, and blending them
-- makes the sales numbers unreadable — you cannot count conversions if half the
-- clients were never leads.
alter table public.admin_clients add column if not exists origin text;
alter table public.admin_clients drop constraint if exists admin_clients_origin_check;
alter table public.admin_clients
  add constraint admin_clients_origin_check
  check (origin is null or origin in ('sales','manual','import'));

create index if not exists admin_clients_company_idx on public.admin_clients (company_id) where company_id is not null;

-- 'converted' is a new kind of thing that can happen to a lead. It goes on the
-- same timeline as the calls, because a rep looking back should not have to
-- read a second panel to find the day it closed.
alter table public.admin_lead_activity drop constraint if exists admin_lead_activity_type_check;
alter table public.admin_lead_activity
  add constraint admin_lead_activity_type_check
  check (type in (
    'call','email','text','linkedin','note','status_change','assigned',
    'claim','unclaim','reopen','score','proposal','import','cadence','open',
    'converted','client_link'
  ));

-- ============================================================
-- 3. WON → CLIENT, IN ONE STATEMENT THAT IS SAFE TO CALL TWICE
-- ============================================================
-- Everything about this function is shaped by one rule: pressing Won twice, or
-- two reps pressing it in the same second, must not produce two clients with
-- the same name and half the history each. That is not a hypothetical — it is
-- exactly the failure the one-text rule already had to be moved into the
-- database to prevent (0009). A browser that reads "is there a client?" and
-- then writes one is a read-modify-write, and two tabs both win it.
--
-- So: one function, one transaction, an explicit row lock on the lead, and an
-- early return if the work is already done.
--
-- WHAT IT WILL NOT DO
--   * It never invents a client name. If there is no firm name and no person
--     name it raises, rather than filing a client called "Unknown".
--   * It never overwrites an existing client record's details. Linking to a
--     client somebody already set up must not quietly replace their contact
--     with a lead's.
--   * It never touches money. Whether they are actually paying is Stripe's
--     answer and Finance's page; this only records that the sale closed.

-- Returns JSONB, not a bare id, because the browser has to be able to tell
-- three different things apart and say the right one out loud:
--   created         — a new client record was made just now
--   already_customer— this exact person was already recorded as the closer
--   siblings        — how many other people at the firm were attached
-- Returning only a uuid made the page toast "they are now a client" every time,
-- including the times when nothing at all was created.
drop function if exists public.admin_lead_to_client(uuid, uuid, text);
create or replace function public.admin_lead_to_client(
  p_lead uuid,
  p_actor uuid default null,
  p_stage text default 'Onboarding'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead      public.admin_leads%rowtype;
  v_company   public.admin_companies%rowtype;
  v_client_id uuid;
  v_name      text;
  v_actor     uuid := coalesce(p_actor, auth.uid());
  v_siblings  int := 0;
  v_created   boolean := false;
  v_key       text;
begin
  if not public.admin_is_member() then
    raise exception 'not authorized';
  end if;

  -- FOR UPDATE, not a plain select. This is the lock that makes a second
  -- caller wait and then find the work already done, instead of racing.
  select * into v_lead from public.admin_leads where id = p_lead for update;
  if not found then
    raise exception 'no such lead: %', p_lead;
  end if;

  -- Already done. Return the same id rather than raising: pressing Won twice
  -- is an ordinary thing a person does, not an error, and an error here would
  -- show a red box for a thing that worked.
  --
  -- BOTH halves are checked on purpose. `client_id` alone was wrong and a test
  -- caught it: the moment ONE contact at a firm closes, every other contact
  -- there is attached to the same client — which is the whole point — so a
  -- client_id-only check made every one of THEIR deals return early and never
  -- get marked won. A firm with four contacts could record exactly one sale,
  -- ever, and the rep who closed the second one would watch the button do
  -- nothing. Being attached to a client and having closed a deal are two
  -- different facts about a person.
  if v_lead.client_id is not null and coalesce(v_lead.became_customer, false) then
    return jsonb_build_object(
      'client_id', v_lead.client_id, 'created', false,
      'already_customer', true, 'siblings', 0);
  end if;

  if v_lead.company_id is not null then
    select * into v_company from public.admin_companies where id = v_lead.company_id for update;
  end if;

  -- The firm may already be a client — another contact there closed first, or
  -- somebody set the client up by hand and linked it. Reuse it.
  v_client_id := coalesce(v_lead.client_id, v_company.client_id);

  if v_client_id is null then
    v_name := nullif(btrim(coalesce(v_company.name, v_lead.company, v_lead.name, '')), '');
    if v_name is null then
      raise exception 'this lead has no firm name and no person name, so there is nothing to call the client';
    end if;

    -- A CONTACT ADDED BY HAND HAS NO FIRM ROW, so there is nothing to lock and
    -- nothing to dedupe against. Two people typed in under the same firm name
    -- and both marked Won produced TWO clients with the same name, each holding
    -- half the history — deterministically, no race needed. That is verbatim
    -- the failure this file's header says it exists to prevent, and it was
    -- found by a reviewer rather than by the tests.
    --
    -- So: take a transaction-scoped advisory lock on the NAME KEY (so a real
    -- race also serialises here), then look for a client that already carries
    -- that name. Matched on the normalised name AND the domain when both sides
    -- have one — name alone would fold two same-named firms in different states
    -- onto one client.
    v_key := public.admin_company_name_key(v_name);
    if v_key is not null then
      perform pg_advisory_xact_lock(hashtext('admin_lead_to_client:' || v_key));

      select c.id into v_client_id
      from public.admin_clients c
      where public.admin_company_name_key(c.name) = v_key
        -- REFUSED ONLY WHEN BOTH SIDES NAME A WEBSITE AND THE WEBSITES DIFFER.
        --
        -- The first version demanded both-present-and-equal or both-absent,
        -- which sounded careful and was wrong: the sheet's Company column
        -- carries no website, and a hand-added contact has no firm row, so one
        -- contact at a firm having a website and the next one not having one is
        -- the ORDINARY case. Two contacts at "Olson Law PLLC" then produced two
        -- clients with the same name and half the history each — verbatim the
        -- failure this block exists to prevent. Proved against real Postgres by
        -- a reviewer.
        --
        -- A missing website is not evidence of a different firm; two different
        -- websites are. So a blank on either side does not block the match, and
        -- two names that differ (& vs and, a state suffix) still do — the name
        -- key above is unchanged and remains the strict half of the test.
        and (
          c.domain is null
          or nullif(btrim(coalesce(v_company.domain, v_lead.domain, '')), '') is null
          or lower(regexp_replace(c.domain, '^https?://(www\.)?|/$', '', 'g'))
            = lower(regexp_replace(coalesce(v_company.domain, v_lead.domain), '^https?://(www\.)?|/$', '', 'g'))
        )
      order by c.created_at
      limit 1;
    end if;
  end if;

  if v_client_id is null then
    v_created := true;
    insert into public.admin_clients (
      name, domain, vertical, stage, status, start_date,
      contact_name, contact_email, contact_phone, company_id, origin, notes
    ) values (
      v_name,
      nullif(btrim(coalesce(v_company.domain, v_lead.domain, '')), ''),
      nullif(btrim(coalesce(v_company.vertical, v_lead.vertical, '')), ''),
      coalesce(nullif(btrim(p_stage), ''), 'Onboarding'),
      'active',
      (now() at time zone 'America/Chicago')::date,
      nullif(btrim(coalesce(v_lead.name, '')), ''),
      nullif(btrim(coalesce(v_lead.email, '')), ''),
      nullif(btrim(coalesce(v_lead.phone, v_company.phone, '')), ''),
      v_company.id,
      'sales',
      'Came up through the sales pipeline. The whole chase — every call, email and note — is on this firm''s contacts in Sales.'
    )
    returning id into v_client_id;
  else
    -- Linking to a record that already exists. Fill in ONLY what is blank
    -- there. Somebody's typed-in contact is not replaced by a lead's.
    update public.admin_clients
      set company_id    = coalesce(company_id, v_company.id),
          contact_name  = coalesce(nullif(btrim(coalesce(contact_name, '')), ''), nullif(btrim(coalesce(v_lead.name, '')), '')),
          contact_email = coalesce(nullif(btrim(coalesce(contact_email, '')), ''), nullif(btrim(coalesce(v_lead.email, '')), '')),
          contact_phone = coalesce(nullif(btrim(coalesce(contact_phone, '')), ''), nullif(btrim(coalesce(v_lead.phone, '')), ''))
      where id = v_client_id;
  end if;

  if v_company.id is not null then
    update public.admin_companies set client_id = v_client_id where id = v_company.id;

    -- EVERY person we hold at that firm points at the client now. This is the
    -- half that makes the record continuous: three months later, the delivery
    -- team opens the client and can still read who was rung, when, and what
    -- was said — instead of a client record that begins on the day the money
    -- started.
    --
    -- `became_customer` is NOT set on the siblings. Whose deal it was is a
    -- different fact from who works there, and flattening the two would count
    -- one sale four times on the rep scoreboard.
    update public.admin_leads
      set client_id = v_client_id
      where company_id = v_company.id and id <> p_lead and client_id is null;
    get diagnostics v_siblings = row_count;
  end if;

  update public.admin_leads
    set client_id          = v_client_id,
        became_customer    = true,
        became_customer_at = now(),
        became_customer_by = v_actor,
        stage              = 'won',
        closed_at          = coalesce(closed_at, now())
    where id = p_lead;

  -- The timeline says it happened, on the record that already holds the chase.
  -- An event with nothing on the timeline is an event nobody can find later.
  if v_actor is not null then
    /* `where not exists` rather than a plain insert. A lead that was attached
     * to the client by a SIBLING'S conversion, and then closes its own deal,
     * runs this block for the first time — but a lead whose own conversion is
     * re-run after being un-flagged by hand would otherwise get a second
     * identical line. One conversion, one line. */
    insert into public.admin_lead_activity (lead_id, actor, type, body)
    select
      p_lead, v_actor, 'converted',
      'Won. Now a paying client'
        || case when v_siblings > 0
             then ' — and the other ' || v_siblings || ' contact'
                  || case when v_siblings = 1 then '' else 's' end
                  || ' at this firm are attached to the same client record.'
             else '.' end
    where not exists (
      select 1 from public.admin_lead_activity
      where lead_id = p_lead and type = 'converted'
    );

    if v_siblings > 0 then
      insert into public.admin_lead_activity (lead_id, actor, type, body)
      select id, v_actor, 'client_link',
             'This firm became a paying client. Everything logged here stays on the record.'
      from public.admin_leads l
      where l.company_id = v_company.id and l.id <> p_lead and l.client_id = v_client_id
        and not exists (
          select 1 from public.admin_lead_activity a
          where a.lead_id = l.id and a.type = 'client_link'
        );
    end if;
  end if;

  return jsonb_build_object(
    'client_id', v_client_id,
    'created', v_created,
    'already_customer', false,
    'siblings', v_siblings);
end;
$$;

revoke execute on function public.admin_lead_to_client(uuid, uuid, text) from anon, public;
grant execute on function public.admin_lead_to_client(uuid, uuid, text) to authenticated;

-- ============================================================
-- 4. THE OTHER DIRECTION — a client, back to their sales history
-- ============================================================
-- Read-only. Returns every contact we hold for a client, whether they were the
-- one who closed or not, newest activity first.

create or replace function public.admin_client_contacts(p_client uuid)
returns setof public.admin_leads
language sql
stable
security definer
set search_path = public
as $$
  select l.*
  from public.admin_leads l
  where public.admin_is_member()
    and (
      l.client_id = p_client
      or l.company_id in (select id from public.admin_companies where client_id = p_client)
    )
  order by l.became_customer desc nulls last, l.last_activity_at desc nulls last, l.created_at desc;
$$;

revoke execute on function public.admin_client_contacts(uuid) from anon, public;
grant execute on function public.admin_client_contacts(uuid) to authenticated;

-- ============================================================
-- 5. BACKFILL — link up what is already sitting there
-- ============================================================
-- Firms whose name matches a client we already have, where nothing is linked
-- yet. Matching on the NORMALISED name AND the domain together, never on name
-- alone: "Above & Beyond Real Estate" exists in more than one state, and a
-- name-only match would attach one state's sales history to the other state's
-- client. A firm with no domain is left alone for a person to link by hand.

update public.admin_companies co
  set client_id = c.id
  from public.admin_clients c
  where co.client_id is null
    and co.domain is not null and c.domain is not null
    and lower(regexp_replace(co.domain, '^https?://(www\.)?|/$', '', 'g'))
      = lower(regexp_replace(c.domain, '^https?://(www\.)?|/$', '', 'g'))
    and public.admin_company_name_key(co.name) = public.admin_company_name_key(c.name);

update public.admin_clients c
  set company_id = co.id
  from public.admin_companies co
  where c.company_id is null and co.client_id = c.id;

-- Their people follow the firm. `became_customer` is deliberately NOT set by
-- this backfill: nobody can say from here WHICH contact closed the deal, and
-- guessing would put a sale on somebody's scoreboard that they may not have
-- made.
update public.admin_leads l
  set client_id = co.client_id
  from public.admin_companies co
  where l.company_id = co.id and co.client_id is not null and l.client_id is null;

-- Anything already flagged as a customer before this file existed keeps a
-- truthful date rather than a made-up one: the day the record was last
-- touched is the closest thing we hold, and it is only used where the flag is
-- already true.
update public.admin_leads
  set became_customer_at = coalesce(became_customer_at, closed_at, updated_at)
  where became_customer = true and became_customer_at is null;

-- Clients that pre-date the origin column were all typed in by hand.
update public.admin_clients set origin = 'manual' where origin is null;


-- ============================================================
-- 0016_import_batches_and_start_over.sql
-- ============================================================
-- AI Syndicate ADMIN console — IMPORT BATCHES, AND STARTING OVER.  Aug 25 2026
-- SAFE TO RUN ON THE SHARED (PLATFORM) PROJECT.
--
--   * Needs 0009 (the sales tables). Independent of everything else.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--   * Re-running this file is safe. Every statement is guarded.
--
-- WHY THIS EXISTS
-- Ryder, Aug 25 2026: "i cant have the real google sheet messed up at all, then
-- when we actually start using the admin then i want to delete all that data and
-- import the list fresh again so that everything is up to date."
--
-- The first half is already true and always was: the importer reads a
-- DOWNLOADED copy of the spreadsheet and nothing in this console has ever
-- written a single cell back to Google. There is no code path to Google Sheets
-- at all.
--
-- The second half did not exist. There was no way to undo an import, so a test
-- run and the real thing would have piled up in the same pipeline.
--
-- THE RULE THIS WHOLE FILE IS SHAPED BY
-- This is the only thing in the console that deletes in bulk. So the count a
-- person is shown and the rows that actually go MUST come from the same
-- statement. On Aug 22 the importer printed "412 already in the pipeline · 412
-- rows dropped" and then imported all 412, because the screen read one value
-- and the write path read another. The same mistake here deletes somebody's
-- work. `admin_clear_import` therefore builds ONE list of ids and either counts
-- it or deletes it — the dry run and the real run cannot disagree.

-- ============================================================
-- 1. AN IMPORT IS A THING THAT HAPPENED
-- ============================================================
-- One row per press of Import. Without this, "undo that import" has nothing to
-- aim at: a list can be imported into twice, and rows can be added to it by
-- hand afterwards, so a list is not the same thing as an import run.

create table if not exists public.admin_import_batches (
  id uuid primary key default gen_random_uuid(),

  label text not null,                    -- what the person called it
  source_file text,                       -- the file name, exactly as it was picked
  tabs text[],                            -- which tabs of it were used
  -- What the import screen said it was going to do. Kept so a clear-out can be
  -- checked against what arrived, rather than against a memory of it.
  counts jsonb not null default '{}'::jsonb,

  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),

  -- Set when this batch is cleared. The batch row itself is NEVER deleted:
  -- "we imported 451 rows on Aug 25 and cleared them on Sep 2" is a fact worth
  -- keeping long after the rows are gone.
  cleared_at timestamptz,
  cleared_by uuid references auth.users on delete set null,
  cleared_counts jsonb
);

create index if not exists admin_import_batches_idx on public.admin_import_batches (created_at desc);

alter table public.admin_leads add column if not exists import_batch_id uuid references public.admin_import_batches on delete set null;
alter table public.admin_companies add column if not exists import_batch_id uuid references public.admin_import_batches on delete set null;
alter table public.admin_lead_lists add column if not exists import_batch_id uuid references public.admin_import_batches on delete set null;

create index if not exists admin_leads_batch_idx on public.admin_leads (import_batch_id) where import_batch_id is not null;
create index if not exists admin_companies_batch_idx on public.admin_companies (import_batch_id) where import_batch_id is not null;

-- ============================================================
-- 2. WHAT COUNTS AS "IMPORTED"
-- ============================================================
-- A contact somebody typed into the console by hand is NOT test data, even if
-- it sits in an imported list. `source` is set at insert and never changed, so
-- it is the honest test. 'manual', 'referral' and 'inbound' are people we met;
-- they are never cleared, whatever else is asked for.

create or replace function public.admin_lead_is_imported(p_source text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p_source, '') in ('sheet', 'csv', 'import', 'scraper');
$$;

revoke execute on function public.admin_lead_is_imported(text) from anon, public;
grant execute on function public.admin_lead_is_imported(text) to authenticated;

-- ============================================================
-- 3. STARTING OVER
-- ============================================================
-- Scope is exactly ONE of: a batch, a list, or everything that was imported.
-- Passing none, or more than one, raises — a delete that guesses its own scope
-- is the worst possible kind.
--
-- WHAT IT WILL NEVER DELETE, whatever it is asked:
--   1. A contact who is linked to a client, or flagged as a customer. The
--      whole point of migration 0015 is that their history follows them.
--   2. A contact carrying a proposal that is past draft. Somebody sent that.
--   3. A contact added by hand (source manual/referral/inbound).
--   4. A contact somebody has actually WORKED IN THE CONSOLE — a logged call,
--      email, text, LinkedIn touch or note. The import writes one 'import' row
--      per contact, and that one does not count; anything else means a person
--      did something here and it is not test data any more.
--   5. A firm that is a client, or that still has contacts after the delete.
--
-- Every one of those is COUNTED AND NAMED in the result, never dropped
-- silently. "Nothing happened" and "we refused to touch 12 of them" look
-- identical otherwise.

-- `p_expect_leads` is what the person was SHOWN. Pass it on the real run and
-- the function refuses if the answer has changed since the preview.
--
-- Without it the promise on the screen — "what you are reading is what will go"
-- — was false, and a reviewer proved it: the preview and the delete are two
-- separate transactions, so another session inserting rows between them meant
-- the button said "Delete 1 contact" and four went. The Aug 22 failure this
-- whole file is written against is exactly that, screen number != write number;
-- moving it from two code paths to two transactions does not make it not that.
create or replace function public.admin_clear_import(
  p_batch uuid default null,
  p_list uuid default null,
  p_all_imported boolean default false,
  p_dry_run boolean default true,
  p_expect_leads int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
-- Scoped to this call only. The `drop table if exists pg_temp.…` guards below
-- are correct and noisy; without this every clear-out prints five NOTICE lines
-- into the caller's log, which trains people to skim what a delete says.
set client_min_messages = 'warning'
as $$
declare
  v_scopes int := (case when p_batch is not null then 1 else 0 end)
                + (case when p_list  is not null then 1 else 0 end)
                + (case when p_all_imported then 1 else 0 end);
  v_actor uuid := auth.uid();
  v_del_leads int := 0;
  v_del_companies int := 0;
  v_del_lists int := 0;
  v_kept jsonb;
  v_result jsonb;
begin
  -- Only an owner or an admin. A rep who mis-clicks should lose an afternoon,
  -- not a list — the same rule the delete policies in 0009 already follow.
  if not public.admin_is_admin() then
    raise exception 'only an owner or admin can clear an import';
  end if;

  if v_scopes = 0 then
    raise exception 'nothing to clear: name an import, a list, or ask for everything imported';
  end if;
  if v_scopes > 1 then
    raise exception 'clear one thing at a time: an import, a list, or everything imported';
  end if;

  -- ---- ONE list of ids. Everything below reads from these tables, so the
  -- ---- number reported and the rows removed cannot come apart.
  --
  -- EVERY ONE OF THESE IS SCHEMA-QUALIFIED TO pg_temp, AND THAT IS NOT TIDINESS.
  --
  -- `search_path` on this function is `public`, and on the FIRST call in a
  -- session the temp schema does not exist yet — so a bare
  -- `drop table if exists _clear_candidates` resolved to
  -- `public._clear_candidates` and dropped it, as the definer, with the NOTICE
  -- suppressed by the setting above. A DRY RUN could destroy a real table in
  -- public, on a file whose header says it is safe to run on the shared
  -- project. Found by a reviewer who built the table and watched it disappear.
  --
  -- Dropped at all (rather than relying on `on commit drop`) because two calls
  -- inside ONE transaction must both work; PostgREST gives each RPC its own
  -- transaction, but tests/start-over/sql.sh calls it twice in one and so could
  -- any future caller.
  drop table if exists pg_temp._clear_candidates;
  drop table if exists pg_temp._clear_keep;
  drop table if exists pg_temp._clear_go;
  drop table if exists pg_temp._clear_companies;
  drop table if exists pg_temp._clear_companies_kept;
  drop table if exists pg_temp._clear_lists;

  create temporary table _clear_candidates on commit drop as
    select l.id, l.company_id, l.list_id, l.name, l.company, l.stage, l.source,
           l.client_id, l.became_customer
    from public.admin_leads l
    where (p_batch is null or l.import_batch_id = p_batch)
      and (p_list  is null or l.list_id = p_list)
      and (not p_all_imported or public.admin_lead_is_imported(l.source));

  create temporary table _clear_keep on commit drop as
    select c.id,
           case
             when c.client_id is not null or coalesce(c.became_customer, false)
               then 'they are a paying client'
             when not public.admin_lead_is_imported(c.source)
               then 'added by hand, not imported'
             when exists (
               select 1 from public.admin_proposals p
               where p.lead_id = c.id and p.status <> 'draft'
             ) then 'a proposal has gone out'
             -- ANYTHING THE IMPORT DID NOT WRITE ITSELF.
             --
             -- This used to list five types — call, email, text, linkedin,
             -- note — and it was close to theatre. Claiming a lead writes
             -- `claim`. Moving it to Meeting writes `status_change`, and the
             -- body of that row is where a rep types "booked Thursday 2pm,
             -- they want the GEO package". Neither was on the list, so a
             -- claimed lead at Meeting stage with the booking written on it was
             -- deleted while the dialog said "0 will be left exactly where they
             -- are". Found by a reviewer.
             --
             -- The import writes exactly ONE row per contact, of type 'import'
             -- (salesImport.jsx#stampImportNote). So the honest test is: is
             -- there anything else? Anything else means a person did something
             -- in here, whatever kind of something it was.
             when exists (
               select 1 from public.admin_lead_activity a
               where a.lead_id = c.id and a.type <> 'import'
             ) then 'somebody has worked them in here'
             else null
           end as why
    from _clear_candidates c;

  select coalesce(jsonb_object_agg(why, n), '{}'::jsonb) into v_kept
  from (
    select why, count(*) as n from _clear_keep where why is not null group by why
  ) k;

  create temporary table _clear_go on commit drop as
    select c.id, c.company_id, c.list_id
    from _clear_candidates c
    join _clear_keep k on k.id = c.id
    where k.why is null;

  -- Firms that would be left with nobody, are not clients, AND CAME IN ON AN
  -- IMPORT THEMSELVES.
  --
  -- That last condition was missing, and it meant a firm somebody built by hand
  -- — its typed address, its site score — was deleted the moment an import's
  -- contacts were cleared out of it. Inside the stated guarantee, which was the
  -- problem: the guarantee was narrower than the work it destroyed. A firm with
  -- no batch on it (built by hand, or imported before this migration existed)
  -- is now left standing with nobody at it, and COUNTED so the screen can say
  -- so rather than leaving it to be found.
  create temporary table _clear_companies on commit drop as
    select distinct co.id
    from public.admin_companies co
    where co.client_id is null
      and co.import_batch_id is not null
      and co.id in (select company_id from _clear_go where company_id is not null)
      and not exists (
        select 1 from public.admin_leads l
        where l.company_id = co.id
          and l.id not in (select id from _clear_go)
      );

  create temporary table _clear_companies_kept on commit drop as
    select distinct co.id
    from public.admin_companies co
    where co.id in (select company_id from _clear_go where company_id is not null)
      and co.id not in (select id from _clear_companies)
      and not exists (
        select 1 from public.admin_leads l
        where l.company_id = co.id
          and l.id not in (select id from _clear_go)
      );

  create temporary table _clear_lists on commit drop as
    select distinct li.id
    from public.admin_lead_lists li
    where li.id in (select list_id from _clear_go where list_id is not null)
      and not exists (
        select 1 from public.admin_leads l
        where l.list_id = li.id
          and l.id not in (select id from _clear_go)
      );

  select count(*) into v_del_leads from _clear_go;
  select count(*) into v_del_companies from _clear_companies;
  select count(*) into v_del_lists from _clear_lists;

  v_result := jsonb_build_object(
    'dry_run', p_dry_run,
    'leads', v_del_leads,
    'companies', v_del_companies,
    'lists', v_del_lists,
    'kept', coalesce(v_kept, '{}'::jsonb),
    'kept_total', (select count(*) from _clear_keep where why is not null),
    'considered', (select count(*) from _clear_candidates)
  );

  v_result := v_result || jsonb_build_object(
    'companies_kept', (select count(*) from _clear_companies_kept));

  if p_dry_run then
    return v_result;
  end if;

  -- The count the person was shown, checked against the count now. Refusing is
  -- the whole point: they agreed to delete a number, and this is no longer that
  -- number. Ask again and they can agree to the new one.
  if p_expect_leads is not null and p_expect_leads <> v_del_leads then
    raise exception 'this changed while you were looking at it: you were shown % contacts and there are now %. Nothing was deleted — look again.',
      p_expect_leads, v_del_leads;
  end if;

  -- Deleting a lead takes its timeline and its proposals with it (both cascade,
  -- 0001 and 0009). Anything a person can still reach afterwards — an inbox
  -- thread, an AI note — only loses the link, by design.
  delete from public.admin_leads where id in (select id from _clear_go);
  delete from public.admin_companies where id in (select id from _clear_companies);
  delete from public.admin_lead_lists where id in (select id from _clear_lists);

  if p_batch is not null then
    update public.admin_import_batches
      set cleared_at = now(), cleared_by = v_actor, cleared_counts = v_result
      where id = p_batch;
  elsif p_all_imported then
    -- Everything imported is gone, so every batch that still had rows is spent.
    update public.admin_import_batches
      set cleared_at = coalesce(cleared_at, now()),
          cleared_by = coalesce(cleared_by, v_actor)
      where cleared_at is null;
  end if;

  -- On the record, on the page everybody reads. A bulk delete with no trace is
  -- how a team stops trusting a tool.
  insert into public.admin_activity_log (actor, kind, title, body)
  values (
    v_actor, 'import_cleared',
    'Cleared ' || v_del_leads || ' imported contact' || case when v_del_leads = 1 then '' else 's' end,
    'Also removed ' || v_del_companies || ' firm' || case when v_del_companies = 1 then '' else 's' end
      || ' left with nobody and ' || v_del_lists || ' empty list'
      || case when v_del_lists = 1 then '' else 's' end || '. '
      || 'Kept ' || (select count(*) from _clear_keep where why is not null)
      || ' that were not test data.'
  );

  return v_result;
end;
$$;

-- The old four-argument shape is dropped, not left beside the new one: two
-- overloads means a caller that misses the new argument silently gets the
-- version with no safety check on it.
drop function if exists public.admin_clear_import(uuid, uuid, boolean, boolean);
revoke execute on function public.admin_clear_import(uuid, uuid, boolean, boolean, int) from anon, public;
grant execute on function public.admin_clear_import(uuid, uuid, boolean, boolean, int) to authenticated;

-- ============================================================
-- 4. A MEMORY SOMEBODY TYPED MUST OUTLIVE THE ROW IT WAS ABOUT
-- ============================================================
-- `admin_brain_memory.lead_id` was `on delete cascade` (0006). So clearing an
-- import silently destroyed confirmed, human-written memories attached to those
-- contacts — "never call before 10am, ask for Marta not Dan" — with nothing
-- counting them, nothing warning about them, and no way to get them back. The
-- comment in this very file said an AI note and an inbox thread only lose their
-- link "by design"; both of those were already `set null`, and the one that
-- actually cascaded was the one nobody had checked.
--
-- The memory keeps its text and loses its link, exactly like the other two. A
-- memory about a contact who is gone is still worth something; a deleted one is
-- worth nothing.
alter table public.admin_brain_memory drop constraint if exists admin_brain_memory_lead_id_fkey;
alter table public.admin_brain_memory
  add constraint admin_brain_memory_lead_id_fkey
  foreign key (lead_id) references public.admin_leads (id) on delete set null;

-- ============================================================
-- 5. GRANTS + ROW LEVEL SECURITY
-- ============================================================

grant select, insert, update on public.admin_import_batches to authenticated;
grant delete on public.admin_import_batches to authenticated;

alter table public.admin_import_batches enable row level security;

drop policy if exists "members read import batches" on public.admin_import_batches;
create policy "members read import batches" on public.admin_import_batches
  for select using (public.admin_is_member());
drop policy if exists "members write import batches" on public.admin_import_batches;
create policy "members write import batches" on public.admin_import_batches
  for insert with check (public.admin_is_member());
drop policy if exists "members update import batches" on public.admin_import_batches;
create policy "members update import batches" on public.admin_import_batches
  for update using (public.admin_is_member());
drop policy if exists "admins delete import batches" on public.admin_import_batches;
create policy "admins delete import batches" on public.admin_import_batches
  for delete using (public.admin_is_admin());


-- ============================================================
-- 0017_rep_reports.sql
-- ============================================================
-- ============================================================
-- 0017 — SAVED ANSWERS FROM A REP'S WORK PAGE
-- ============================================================
-- Aug 26 2026, Ryder. CJ is giving the sales reps their own logins, so each rep
-- gets a box on their Work page: they type what they want to know and
-- /api/rep-report answers it from the records a rep is allowed to see. Every
-- press writes a row here.
--
-- WHY THIS IS NOT admin_console_reports (0010).
-- That table is owner/admin only, and its comment says why: one of those rows
-- can summarise every client, lead and invoice in one place. The rows were
-- written from an OWNER-SCOPED snapshot, so a rep who could read one would walk
-- straight around the role scoping in lib/brain-context.js. Widening 0010's
-- policies would undo that scoping in one line. So the rep's answers live in
-- their own table, written from a rep-scoped snapshot, and a rep never reads a
-- row from admin_console_reports.
--
-- Append-only, exactly like admin_console_reports (0010) and admin_client_reports
-- (0008), and for the same reason: what a rep was told last Tuesday is worth
-- keeping even when this Tuesday's answer disagrees. There is no update policy.
-- Delete is allowed, because a bad answer is noise and nobody should have to
-- keep it.
--
-- Safe to run twice. It only creates admin_-prefixed objects and every statement
-- is guarded.

create table if not exists public.admin_rep_reports (
  id uuid primary key default gen_random_uuid(),

  -- WHOSE ANSWER THIS IS. Every read policy below hangs off this column, so it
  -- is the whole access model of the table in one field. The server sets it from
  -- the bearer token, never from the request body — /api/rep-report reads
  -- member.membership.user_id. If a caller could pass it, a rep could file a row
  -- as somebody else and then read it back.
  owner_id uuid not null references auth.users on delete cascade default auth.uid(),

  -- The role that token carried, for the audit trail. No CHECK constraint on
  -- purpose: 0006 taught us that `create table if not exists` leaves an older
  -- check in place for ever, so a constraint that has to widen when a fourth
  -- role is added is a button that fails silently for a day. The three real
  -- roles are constrained where they are decided — admin_users.role in 0001.
  role text,

  -- What was asked for, verbatim. This is half the point of keeping the row: a
  -- good question is worth re-asking, and a bad answer is usually a bad ask.
  instruction text,

  title text not null default 'Your sales work',
  summary text not null default '',            -- the 30-second answer
  body text not null default '',               -- the whole answer

  -- true  = no AI wrote this. Either there is no ANTHROPIC_API_KEY, or the model
  --         refused, or its draft failed the honesty gate and was thrown away.
  -- false = the AI worded it AND its draft passed every check.
  counted_only boolean not null default true,
  -- Why a draft was thrown away, in plain words, so a rep is never left
  -- wondering why today's answer reads like a list.
  gate_reason text,

  -- The counted figures behind the answer, so a person can audit it later
  -- without re-reading the whole sales table. Kept small on purpose: counts and
  -- the cannot-answer list, never the lead rows themselves.
  facts jsonb,

  created_by_email text,
  created_at timestamptz not null default now()
);

-- Newest first, per person. Both ways this table is ever read.
create index if not exists admin_rep_reports_owner_idx
  on public.admin_rep_reports (owner_id, created_at desc);
create index if not exists admin_rep_reports_created_idx
  on public.admin_rep_reports (created_at desc);

-- ---- who can touch it -------------------------------------------------
-- In plain words:
--   * A rep can read their own rows and nobody else's.
--   * A rep can insert a row only with their own user id on it.
--   * Owner and admin can read every row, because somebody has to be able to
--     see what the reps are being told.
--   * Nobody can update a row. Correcting an answer means generating a new one.
--   * A person can delete their own; owner and admin can delete any.
--
-- admin_is_member() = an active row in admin_users, any role.
-- admin_is_admin()  = an active row whose role is owner or admin (0001).

alter table public.admin_rep_reports enable row level security;

grant select, insert, delete on public.admin_rep_reports to authenticated;

drop policy if exists admin_rep_reports_read_own on public.admin_rep_reports;
create policy admin_rep_reports_read_own on public.admin_rep_reports
  for select to authenticated
  using (public.admin_is_member() and owner_id = auth.uid());

drop policy if exists admin_rep_reports_read_all on public.admin_rep_reports;
create policy admin_rep_reports_read_all on public.admin_rep_reports
  for select to authenticated
  using (public.admin_is_admin());

-- `owner_id = auth.uid()` in the WITH CHECK is the line that stops a rep filing
-- a row under somebody else's name and then reading it back through the
-- read-own policy above.
drop policy if exists admin_rep_reports_insert_own on public.admin_rep_reports;
create policy admin_rep_reports_insert_own on public.admin_rep_reports
  for insert to authenticated
  with check (public.admin_is_member() and owner_id = auth.uid());

drop policy if exists admin_rep_reports_delete_own on public.admin_rep_reports;
create policy admin_rep_reports_delete_own on public.admin_rep_reports
  for delete to authenticated
  using (public.admin_is_admin() or (public.admin_is_member() and owner_id = auth.uid()));

-- No update policy, on purpose. A saved answer is a record of what a rep was
-- told at a moment, and the gate_reason on it is part of that record.


-- ============================================================
-- 0018_lead_tags.sql
-- ============================================================
-- ============================================================
-- 0018 — TAGS ON A LEAD, AND A DATED LINE FOR EVERY CHANGE
-- ============================================================
-- Aug 27 2026, Ryder. The Floor shows every lead in the company at once, so a
-- rep needs to be able to say "show me the medspas in Florida with no website
-- that nobody has touched" without reading 451 rows. That is what a tag is for.
--
-- THERE IS NO TAG ANYWHERE IN THE SYSTEM TODAY. No column, no table, nothing.
-- This is from scratch.
--
-- TWO TABLES, AND THE SECOND ONE IS THE POINT.
--   admin_lead_tags        — the vocabulary. What tags exist, what they look
--                            like, and (for the automatic ones) the rule name
--                            that produces them.
--   admin_lead_tag_events  — every add and every remove, with the day, the
--                            person and the reason. APPEND ONLY.
--
-- A LEAD'S TAGS RIGHT NOW = REPLAY ITS EVENTS. There is deliberately no `tags`
-- column on admin_leads and no `current` flag on an event. Two reasons, and the
-- second is the one that matters:
--
--   1. A current-state column and an event log are two copies of one fact, and
--      the day they disagree there is no way to tell which one is right. This
--      repo has already paid for that lesson twice — see §42 PART 2 on stored
--      totals, and the work-log rule that a record is never rewritten.
--   2. Ryder asked for the tag history to be visible on the lead. Replaying the
--      events IS that history. Storing current state would mean building the
--      history separately, which is a second copy again.
--
-- The cost is honest and small: reading a lead's tags is a read of its events.
-- The console already reads every lead's activity in one call (getSalesBoard),
-- so this is one more read of the same shape, not a read per row.
--
-- WHY AN EVENT CANNOT BE EDITED. There is no update policy and no update grant
-- on admin_lead_tag_events at all. An event you can edit is not a record. A
-- correction is a new event with `why` saying what it corrects — exactly the
-- rule the notes and the timeline already follow.
--
-- Safe to run twice. Every statement is guarded and only admin_-prefixed
-- objects are created.
--
-- ONE MIGRATION TRAP THIS FILE IS SHAPED AROUND: `create table if not exists`
-- does NOT update a CHECK constraint on a table that already exists, and
-- re-running a migration does not widen one either. So every CHECK below that
-- could ever need to grow is added by drop-and-re-add with EVERY existing value
-- re-listed. A past migration lost 'email' from a check exactly that way and
-- broke a button for days.

-- ============================================================
-- 1. THE VOCABULARY
-- ============================================================

create table if not exists public.admin_lead_tags (
  id uuid primary key default gen_random_uuid(),

  -- The stable name the code uses: 'no-website', 'size-small', 'hot'. Lower
  -- case, hyphens, no spaces. Unique, because two tags with one slug is two
  -- filters that look like one.
  slug text not null unique,

  -- The words a person reads. "No website" rather than "no-website".
  label text not null,

  -- One of the Notion-ish colour names opsCells.jsx already knows
  -- (default, gray, brown, orange, yellow, green, blue, purple, pink, red).
  -- Not constrained here on purpose: a colour that is not on that list renders
  -- as `default` in chipStyle(), which is a cosmetic fallback rather than a
  -- broken row, and constraining it would mean this file has to be re-run every
  -- time the palette grows.
  color text,

  -- Which family the tag belongs to, so the filter menu can group them. The five
  -- the seed below uses: 'website' | 'size' | 'score' | 'source' | 'state'
  -- (state as in the state of the deal, not a US state).
  --
  -- DELIBERATELY NOT A GROUP: the firm's line of business, and where it is.
  -- Both are real columns on admin_companies that arrive with the sheet, both
  -- are their own filter on the Floor, and both are OPEN sets — a new vertical
  -- or a new US state would need a new row in this table, which only an admin
  -- may write (see the policies below), so an import run by a rep would silently
  -- fail to tag half its rows. A tag is a thing we decided about a lead. A
  -- vertical is a field somebody typed.
  --
  -- Named tag_group, not group — `group` is a reserved word in SQL and a column
  -- called that has to be quoted at every single use site.
  tag_group text,

  -- For a tag a RULE produces rather than a person: the name of that rule, plus
  -- whatever it needs. `{"rule":"quiet","days":7}`. The rule itself lives in
  -- lib/sales-rules.js as a pure function — this column is a record of which
  -- rule made the tag, so a tag on screen can be traced back to the code that
  -- wrote it. It is NOT a rule engine: nothing reads this column and executes
  -- it, because a rule stored as data is a rule with no test around it.
  auto_rule jsonb,

  -- Display order in the filter menu. Nulls last.
  sort int,

  -- A tag switched off stops being offered and stops being auto-applied. It is
  -- never deleted, because the events pointing at it are records.
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_lead_tags_group_idx
  on public.admin_lead_tags (tag_group, sort) where active;

drop trigger if exists admin_lead_tags_updated_at on public.admin_lead_tags;
create trigger admin_lead_tags_updated_at before update on public.admin_lead_tags
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 2. THE EVENTS — APPEND ONLY, NEVER UPDATED, NEVER DELETED
-- ============================================================

create table if not exists public.admin_lead_tag_events (
  id uuid primary key default gen_random_uuid(),

  lead_id uuid not null references public.admin_leads on delete cascade,
  tag_id  uuid not null references public.admin_lead_tags,

  -- 'added' or 'removed'. A removal is its own row, not the deletion of the row
  -- that added it — that is what makes "quiet was added on the 24th and taken
  -- off on the 25th because she replied" readable a month later.
  action text not null,

  -- When it happened. Named `at` rather than `created_at` because for this table
  -- they are the same thing and one name is less to get wrong.
  at timestamptz not null default now(),

  -- Who did it. NULL means the system did — an automatic rule, or the import.
  -- Deliberately nullable: pretending a rule was a person is worse than saying
  -- nobody.
  by uuid references auth.users on delete set null,

  -- 'auto'   — a rule in lib/sales-rules.js produced it
  -- 'person' — somebody clicked
  -- 'import' — it came in with the sheet
  source text not null,

  -- Plain words, for the history panel. "7 days with no touch" · "removed by
  -- hand" · "on import, Medspas tab". An auto tag removed by hand records
  -- why:'removed by hand' so the next sweep can see it was a decision and not
  -- put it straight back.
  why text
);

-- The two checks, drop-and-re-add so a re-run really does update them, with
-- every existing value re-listed. See the trap note at the top of this file.
alter table public.admin_lead_tag_events
  drop constraint if exists admin_lead_tag_events_action_check;
alter table public.admin_lead_tag_events
  add constraint admin_lead_tag_events_action_check
  check (action in ('added','removed'));

alter table public.admin_lead_tag_events
  drop constraint if exists admin_lead_tag_events_source_check;
alter table public.admin_lead_tag_events
  add constraint admin_lead_tag_events_source_check
  check (source in ('auto','person','import'));

-- The one way this table is read: one lead, newest first.
create index if not exists admin_lead_tag_events_lead_idx
  on public.admin_lead_tag_events (lead_id, at desc);
-- And the one way it is swept: everything since a moment, for the board read.
create index if not exists admin_lead_tag_events_at_idx
  on public.admin_lead_tag_events (at desc);
-- Replaying one lead's one tag needs both columns.
create index if not exists admin_lead_tag_events_lead_tag_idx
  on public.admin_lead_tag_events (lead_id, tag_id, at desc);

-- ============================================================
-- 3. 'tag' IS A THING THAT CAN HAPPEN TO A LEAD
-- ============================================================
-- The timeline is one list per person and a tag change belongs on it, next to
-- the calls, rather than in a second panel a rep has to think to open.
--
-- Drop-and-re-add with EVERY existing value re-listed — the same pattern
-- 0015_sales_lifecycle.sql:97-104 used to add 'converted' and 'client_link'.
-- Missing one of these off the list is how a button stops working silently.
alter table public.admin_lead_activity drop constraint if exists admin_lead_activity_type_check;
alter table public.admin_lead_activity
  add constraint admin_lead_activity_type_check
  check (type in (
    'call','email','text','linkedin','note','status_change','assigned',
    'claim','unclaim','reopen','score','proposal','import','cadence','open',
    'converted','client_link','tag'
  ));

-- ============================================================
-- 3b. ONE FUNCTION THAT SAYS WHO MAY WORK A LEAD
-- ============================================================
-- The row-level lock — a rep may work a lead they hold or a lead nobody holds,
-- and an owner or admin may work any — is needed by the policies on FOUR tables
-- (admin_leads, admin_lead_activity, admin_proposals, admin_lead_tag_events).
-- Writing it out four times is four places for it to stop matching.
--
-- IT IS DEFINED HERE RATHER THAN IN 0020, WHERE THE REST OF THE LOCK LIVES, FOR
-- ONE REASON, AND IT IS AN IMPORTANT ONE.
--
-- 0018 and 0020 both define the tag-event insert policy. Every migration in this
-- repo is meant to be safe to run twice, and the first version of these two files
-- made that false in a way nothing would have noticed: 0018's policy was the wide
-- one ("any member may tag any lead") and 0020 replaced it with the scoped one —
-- so re-running 0018 AFTER 0020 silently put the hole back. A test caught it. A
-- person would not have.
--
-- So 0018 carries the real rule from the start, through this function, and 0020
-- re-states the identical policy. Run them in either order, or twice, and the
-- answer is the same.
--
-- `security invoker` (the default, stated because it matters): the function is
-- evaluated as whoever is asking, so the select policy on admin_leads still
-- applies inside it. `security definer` here would have been a way around the
-- policy it exists to enforce.
--
-- STILL TRUE, AND WRITTEN DOWN RATHER THAN HOPED AWAY: re-running an EARLIER
-- migration after a later one that tightened a policy of the same name reverts
-- the tightening. Re-running 0001 after 0020 puts back the wide
-- "members update leads" and the wide "members log own activity". That is a
-- property of drop-and-recreate, not of these two files, and the mitigation is
-- the note in SETUP.md: if you ever re-run 0001 or 0009, re-run 0020 after it.
create or replace function public.admin_can_work_lead(p_lead uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select public.admin_is_admin()
     or exists (
       select 1 from public.admin_leads l
       where l.id = p_lead
         and (l.owner_id = auth.uid() or l.owner_id is null)
     );
$$;

revoke execute on function public.admin_can_work_lead(uuid) from anon, public;
grant execute on function public.admin_can_work_lead(uuid) to authenticated;

-- ============================================================
-- 4. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- The vocabulary: every member reads it, admins write it. A rep adding a brand
-- new tag TYPE to the company vocabulary is a naming decision, not a piece of
-- lead work — 'medspa', 'med-spa' and 'MedSpa' as three tags is a filter menu
-- nobody can use. A rep can put any EXISTING tag on any lead they may edit.
--
-- The events: every member reads them (a rep has to see another rep's lead
-- read-only, tags included, or the Floor cannot stop two reps working one firm)
-- and every member inserts them. There is NO UPDATE POLICY AND NO UPDATE GRANT.
-- That absence is the feature.
--
-- WHERE THE ROW-LEVEL LOCK COMES FROM: the one function in 3b above. 0020 is
-- where the rest of the lock lives (admin_leads, admin_lead_activity,
-- admin_proposals, the mailbox), and it re-states the tag policy identically —
-- see the long note on 3b for why this file carries the rule too instead of
-- leaving it to 0020.

grant select on public.admin_lead_tags to authenticated;
grant insert, update, delete on public.admin_lead_tags to authenticated;
grant select, insert on public.admin_lead_tag_events to authenticated;

alter table public.admin_lead_tags enable row level security;
alter table public.admin_lead_tag_events enable row level security;

drop policy if exists "members read tags" on public.admin_lead_tags;
create policy "members read tags" on public.admin_lead_tags
  for select using (public.admin_is_member());

drop policy if exists "admins write tags" on public.admin_lead_tags;
create policy "admins write tags" on public.admin_lead_tags
  for insert with check (public.admin_is_admin());
drop policy if exists "admins update tags" on public.admin_lead_tags;
create policy "admins update tags" on public.admin_lead_tags
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());
drop policy if exists "admins delete tags" on public.admin_lead_tags;
create policy "admins delete tags" on public.admin_lead_tags
  for delete using (public.admin_is_admin());

drop policy if exists "members read tag events" on public.admin_lead_tag_events;
create policy "members read tag events" on public.admin_lead_tag_events
  for select using (public.admin_is_member());

-- TWO HALVES, and they answer different questions.
--
-- `by = auth.uid() or by is null` mirrors the activity-log policy in 0001: a
-- person may file a row as themselves or as the system, and never as somebody
-- else. Without the auth.uid() half a rep could write "removed by hand — CJ"
-- onto a record nobody can edit afterwards.
--
-- `admin_can_work_lead(lead_id)` is WHICH LEAD they may tag — the row-level lock,
-- from the one function above. 0020 states this policy again, identically, so
-- running either file twice or in either order gives the same rule.
drop policy if exists "members write tag events" on public.admin_lead_tag_events;
create policy "members write tag events" on public.admin_lead_tag_events
  for insert with check (
    public.admin_is_member()
    and (by = auth.uid() or by is null)
    and public.admin_can_work_lead(lead_id)
  );

-- NO UPDATE POLICY AND NO UPDATE GRANT ON admin_lead_tag_events, on purpose.
-- NO DELETE POLICY AND NO DELETE GRANT either — not even for an admin. A tag
-- history with a hole in it is worse than a tag history that records a mistake,
-- and the mistake is fixable by adding the opposite event.

-- ============================================================
-- 4b. READING THE LOG WITHOUT READING ALL OF IT
-- ============================================================
-- A lead's tags right now are the newest event per tag. Working that out in the
-- browser means reading EVERY event for every lead on the page — and the Floor
-- loads two thousand leads. A windowed read is not an option and it is worth
-- saying why: an `added` from three months ago that falls outside the window
-- makes a tag that IS on the lead look like a tag that is off. Quietly wrong
-- tags are worse than no tags, because a filter built on them looks like it
-- worked.
--
-- So the replay happens here, in one line of SQL, and the browser reads the
-- answer. This is NOT a stored copy: a view holds nothing. It is the same events
-- read a cheaper way, so there is still exactly one record and nothing to fall
-- out of step.
--
-- `distinct on (lead_id, tag_id) ... order by at desc, id desc` is the newest
-- event per tag, ties broken on id — an import writes several events inside one
-- statement and Postgres gives them all the same now(), so ties are ordinary
-- rather than rare, and without the id the answer could flip between two reads
-- of the same rows.
--
-- REMOVALS STAY IN THE VIEW. It is "the newest event per tag", not "the tags
-- that are on". The caller filters on `action = 'added'` for the chips, and the
-- automatic rules read the removals to see which tags a person took off by hand
-- so they never put them back. Filtering removals out here would have deleted
-- that, and there would be nothing in the shape of the data to say so.
create or replace view public.admin_lead_tags_now as
select distinct on (e.lead_id, e.tag_id)
  e.id, e.lead_id, e.tag_id, e.action, e.at, e.by, e.source, e.why
from public.admin_lead_tag_events e
order by e.lead_id, e.tag_id, e.at desc, e.id desc;

-- SECURITY INVOKER, so the view is read with the PERMISSIONS OF WHOEVER IS
-- ASKING and row-level security on admin_lead_tag_events still applies through
-- it. Without this a view is read as its owner, which is how a view becomes a
-- way around the policy on the table underneath it. Postgres 15 and up.
alter view public.admin_lead_tags_now set (security_invoker = on);

grant select on public.admin_lead_tags_now to authenticated;

-- ============================================================
-- 5. THE STARTING VOCABULARY
-- ============================================================
-- Seeded here rather than by hand, so a fresh database has the same tags as
-- every other one and the auto rules have something to point at on day one.
-- `on conflict (slug) do nothing` — a re-run must not overwrite a label or a
-- colour somebody has since changed on screen.
--
-- The score bands are written as four tags rather than one 'scored' tag with a
-- number, because a filter is a list of values you tick. `scored-90-plus` is
-- the same threshold as ROE.SKIP_SCORE_AT_OR_ABOVE in lib/sales-rules.js; if
-- that number ever moves, this label moves with it or the two disagree.

insert into public.admin_lead_tags (slug, label, color, tag_group, auto_rule, sort) values
  ('no-website',      'No website',        'red',     'website',  '{"rule":"website"}',            10),
  ('has-website',     'Has a website',     'gray',    'website',  '{"rule":"website"}',            11),

  ('size-solo',       'Solo (1)',          'gray',    'size',     '{"rule":"size","max":1}',       20),
  ('size-small',      'Small (2-10)',      'blue',    'size',     '{"rule":"size","max":10}',      21),
  ('size-mid',        'Mid (11-50)',       'purple',  'size',     '{"rule":"size","max":50}',      22),
  ('size-large',      'Large (51+)',       'brown',   'size',     '{"rule":"size","min":51}',      23),

  ('never-touched',   'Never touched',     'yellow',  'source',   '{"rule":"never-touched"}',      30),
  ('imported',        'Imported',          'gray',    'source',   '{"rule":"imported"}',           31),

  ('unscanned',       'Not scanned yet',   'yellow',  'score',    '{"rule":"score-band"}',         40),
  ('scored-under-60', 'Scored under 60',   'green',   'score',    '{"rule":"score-band","max":59}',41),
  ('scored-60s',      'Scored 60-79',      'blue',    'score',    '{"rule":"score-band","max":79}',42),
  ('scored-80s',      'Scored 80-89',      'orange',  'score',    '{"rule":"score-band","max":89}',43),
  ('scored-90-plus',  'Scored 90+',        'gray',    'score',    '{"rule":"score-band","min":90}',44),

  ('hot',             'Replied',           'green',   'state',    '{"rule":"replied"}',            50),
  ('quiet',           'Gone quiet (7d)',   'yellow',  'state',    '{"rule":"quiet","days":7}',     51),
  ('cold',            'Cold (14d)',        'red',     'state',    '{"rule":"cold","days":14}',     52),
  ('claim-expiring',  'Claim expiring',    'orange',  'state',    '{"rule":"claim-expiring"}',     53),
  ('bounced',         'Bad address',       'red',     'state',    '{"rule":"bounced"}',            54),
  ('skip-90',         'Not a prospect',    'gray',    'state',    '{"rule":"skip-90"}',            55),
  ('won',             'Won',               'green',   'state',    '{"rule":"closed"}',             56),
  ('lost',            'Lost',              'red',     'state',    '{"rule":"closed"}',             57)
on conflict (slug) do nothing;

-- ============================================================
-- 6. AFTER RUNNING THIS
-- ============================================================
--   1. The tags appear on the Floor's filter bar the next time the page loads.
--
--      NOTHING TAGS THE EXISTING BOOK. An earlier version of this line said
--      "every lead gets its automatic tags the next time a sweep or an import
--      runs", and that is not true of anything in the repo today: the only caller
--      of the automatic rules is the per-lead "Bring the automatic tags up to
--      date" button on the Floor. api/sales-sweep.js has no tag code in it and is
--      not scheduled anyway; lib/sales-import.js writes no tag events.
--
--      So on a fresh database every lead starts with no tags, and a filter like
--      "no website, never touched, in Florida" returns nothing until somebody has
--      pressed that button on those rows. That is a real gap and it is written
--      down rather than described away — the two places it belongs are the
--      overnight sweep and the import, and neither was done today.
--
--      Nothing is back-filled by this FILE either, and that part was always
--      deliberate: back-filling in SQL would write thousands of events dated today
--      for things that happened in July, and a dated line that lies about its date
--      is worse than no line.
--   2. Verify with:
--        select slug, label, tag_group from public.admin_lead_tags order by sort;
--        select count(*) from public.admin_lead_tag_events;   -- 0 on a fresh run


-- ============================================================
-- 0019_reasons_and_company_reports.sql
-- ============================================================
-- ============================================================
-- 0019 — WHY A DEAL CLOSED, AND WHAT A SCAN FOUND ON A FIRM
-- ============================================================
-- Aug 27 2026, Ryder. Two things, in one file because they are the same idea
-- twice: a number or an outcome is worth almost nothing without the reason
-- behind it, and today neither reason is stored anywhere.
--
-- PART 1 — WON AND LOST NEED A REASON.
-- `lost_reason` already exists (0009:217) and exactly ONE button writes it,
-- hard-coded to "No reply after the full cadence." Won records no reason at all.
-- So the single most useful sales question there is — "why are we losing?" —
-- has no answer in this database. Three columns fix that: a counted reason for
-- Won, and a free-text "what actually happened" for each.
--
-- WHY A DROPDOWN *AND* FREE TEXT, rather than one or the other. A dropdown can
-- be counted and a paragraph cannot; a paragraph carries the thing that is
-- actually useful and a dropdown never does. Both, or six months from now we
-- have eleven rows saying "no reply" and nothing that says what the emails
-- looked like.
--
-- PART 2 — WHAT A SCAN FOUND, KEYED ON THE FIRM.
-- `admin_companies.site_score` can hold exactly ONE number. Ryder wants three
-- — AI Access, SEO, and how often the firm gets named when a buyer asks an AI a
-- question — plus the findings behind them. That does not fit in a column, and
-- overwriting last month's score to store this month's throws away the most
-- useful sales line there is: "you were 65 in September and you are still 65."
--
-- So: a report table, one row per scan, never updated.
--
-- WHY NOT admin_client_reports (0008). Two reasons, both real:
--   1. It is keyed on `client_id NOT NULL`, and a prospect is not a client.
--      Relaxing that to nullable would break its cascade and its
--      one-report-one-client invariant.
--   2. Its RLS is admin-only. A REP HAS TO READ THIS — the whole point is that
--      a rep opens a lead and reads what we measured on their website. Widening
--      0008's policies to let a rep in would hand them every client report in
--      the company. That is trap #6 in §8 wearing a different hat.
--
-- Safe to run twice. Additive, admin_-prefixed, every statement guarded.

-- ============================================================
-- 1. WON AND LOST, WITH REASONS
-- ============================================================
-- Counted reasons, as free text columns rather than enums. Deliberate: 0006
-- taught this repo that `create table if not exists` leaves an older CHECK in
-- place for ever, so a constraint that has to widen the first time CJ says
-- "add 'went quiet after the proposal'" is a button that fails silently for a
-- day. The list of allowed reasons lives in ONE place in the code
-- (lib/sales-rules.js) where a test can read it, and the database stores what
-- it is given.
alter table public.admin_leads add column if not exists won_reason text;
alter table public.admin_leads add column if not exists won_reason_note text;
alter table public.admin_leads add column if not exists lost_reason_note text;

-- Counting losses by reason is the one query this exists for.
create index if not exists admin_leads_lost_reason_idx
  on public.admin_leads (lost_reason) where lost_reason is not null;
create index if not exists admin_leads_won_reason_idx
  on public.admin_leads (won_reason) where won_reason is not null;

-- ============================================================
-- 2. ONE ROW PER SCAN, ON THE FIRM
-- ============================================================

create table if not exists public.admin_company_reports (
  id uuid primary key default gen_random_uuid(),

  -- The FIRM, not the person. Four contacts at one dealership share one
  -- website, so they share one scan — scoring per person would mean four scans,
  -- four bills and four numbers that drift apart.
  company_id uuid not null references public.admin_companies on delete cascade,

  -- WHO RAN IT, as the lead they were looking at when they pressed the button.
  -- `on delete set null`, because deleting a contact must not delete the
  -- measurement of their firm's website. Nullable for a scan run from the Firms
  -- view, where there is no one contact.
  lead_id uuid references public.admin_leads on delete set null,

  -- 'baseline' is the first scan of a firm; a re-scan is 'rescan'. Free text for
  -- the same reason as the reasons above — a CHECK that has to widen is a button
  -- that breaks silently.
  kind text not null default 'baseline',

  -- THE THREE SCORES. Every one of them is nullable and every one of them is
  -- 0-100 or nothing. NULL means "the scan did not return this", which is not
  -- the same as zero and must never print as zero: a firm shown as 0 for AI
  -- Access is the widest possible gap and therefore the hardest a rep goes in.
  -- That is the single most dangerous wrong number this table could hold.
  ai_access_score int check (ai_access_score is null or (ai_access_score between 0 and 100)),
  seo_score       int check (seo_score is null or (seo_score between 0 and 100)),

  -- "Named in 2 of 10 buyer questions." TWO columns, not a percentage: 2/10 and
  -- 20% are the same number and only one of them says how big the sample was,
  -- and 1 of 2 printed as 50% is a claim nobody measured. Both nullable
  -- together — a hits count with no total is not a measurement.
  prompt_sim_hits  int check (prompt_sim_hits is null or prompt_sim_hits >= 0),
  prompt_sim_total int check (prompt_sim_total is null or prompt_sim_total > 0),

  -- [{title, detail, severity}] — the things that are actually wrong, in words a
  -- rep can read out loud. This is what the pitch is written from.
  findings jsonb,

  -- Exactly what the platform sent back, untouched. Kept because the field names
  -- readScore() looks for are a guess at a contract nobody has written down: the
  -- day the real shape is known, this column is what says whether the scans we
  -- already ran can be re-read or have to be re-run.
  raw jsonb,

  -- The AI-written pitch. It goes through the same honesty gate as everything
  -- else and may name only the scores and findings above. Nullable, because a
  -- scan with no AI key set still saves its numbers.
  pitch text,
  -- Why there is no pitch, when there is none. "No ANTHROPIC_API_KEY" and "the
  -- draft was thrown away for promising a result" are different sentences.
  pitch_gate_reason text,

  -- THE FOUR HALVES OF A MEASUREMENT (§42 PART 2 rule 2): the number, the thing
  -- it was measured against (the domain), the day it was read, and who read it.
  -- Anything short of all four is not a measurement and must not be printed as
  -- one. `domain` is stored on the row rather than read off the firm later,
  -- because a firm's website can be corrected afterwards and then the old
  -- measurement would silently re-attach itself to a different site.
  domain text,
  measured_at timestamptz not null,
  measured_by uuid not null references auth.users on delete restrict,

  created_at timestamptz not null default now()
);

-- The one way this is read: the newest scan of one firm.
create index if not exists admin_company_reports_company_idx
  on public.admin_company_reports (company_id, measured_at desc);

-- ============================================================
-- 3. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Every member reads, every member inserts. There is NO UPDATE POLICY and no
-- update grant: a measurement that can be edited after a rep has quoted it is
-- not a measurement. That is the same rule already enforced on
-- admin_connection_snapshots in 0013 (§39), and it is why a re-scan INSERTS a
-- new row instead of overwriting the old one.
--
-- Delete is admin-only, and it is worth being uneasy about: an old report may be
-- the thing a saved pitch was written from. It is allowed only because a scan
-- against the wrong domain is noise a rep would otherwise quote.

grant select, insert on public.admin_company_reports to authenticated;
grant delete on public.admin_company_reports to authenticated;

alter table public.admin_company_reports enable row level security;

drop policy if exists "members read company reports" on public.admin_company_reports;
create policy "members read company reports" on public.admin_company_reports
  for select using (public.admin_is_member());

-- `measured_by = auth.uid()` in the WITH CHECK is what stops a rep filing a
-- measurement under somebody else's name. The service key writes these in
-- practice (api/sales-score.js) and bypasses RLS entirely — this policy is for
-- the browser, and it exists so that the rule is written where it cannot be
-- skipped by a future page that writes directly.
drop policy if exists "members add company reports" on public.admin_company_reports;
create policy "members add company reports" on public.admin_company_reports
  for insert with check (
    public.admin_is_member() and measured_by = auth.uid()
  );

drop policy if exists "admins remove company reports" on public.admin_company_reports;
create policy "admins remove company reports" on public.admin_company_reports
  for delete using (public.admin_is_admin());

-- NO UPDATE POLICY, on purpose. See the note above.

-- ============================================================
-- 4. AFTER RUNNING THIS
-- ============================================================
--   1. Nothing on screen changes until PLATFORM_SCORE_URL exists — the scan
--      button still returns 503 naming the variable, and no score is invented.
--      This file is what the scan will have somewhere to write TO.
--   2. The Won/Lost reason box works the moment this file has run. Before it
--      runs, saving a Won reason fails and the screen says so rather than
--      quietly dropping it.
--   3. Verify with:
--        select column_name from information_schema.columns
--          where table_name = 'admin_leads' and column_name like '%reason%';
--        select count(*) from public.admin_company_reports;   -- 0 on a fresh run


-- ============================================================
-- 0020_rep_scoping.sql
-- ============================================================
-- ============================================================
-- 0020 — THE LOCK MOVES FROM THE LIST TO THE ROW
-- ============================================================
-- Aug 27 2026, Ryder. This is the migration the whole Floor rebuild depends on,
-- and it closes a hole that is open right now.
--
-- WHAT IS OPEN RIGHT NOW. `admin_leads` UPDATE is, verbatim from
-- 0001_admin_init.sql:403-405:
--
--     create policy "members update leads" on public.admin_leads
--       for update using (public.admin_is_member());
--
-- One `using` clause and NO `with check`. In Postgres, `using` decides which
-- rows you may attempt to change and `with check` decides what a row is allowed
-- to look like AFTER you change it. With no `with check`, any active member may
-- set any lead's `owner_id` to their own id. In plain words: any sales rep can
-- already reassign any lead to themselves by talking to the database directly,
-- today. Nobody has noticed because the website has never offered a button for
-- it.
--
-- The Floor starts showing every rep every row. That gap has to be closed for
-- real before it does, and "for real" means here, not on the page. This is
-- trap #6 of §8 — "UI-only permission guards are not guards" — for the third
-- time in this repo.
--
-- THE RULE, IN ONE SENTENCE PER ROLE:
--   * An owner or admin may do anything to any lead, including handing it to
--     somebody else. That is their job.
--   * A rep may take a lead nobody holds, may edit a lead they hold, and may
--     hand their own lead back to the floor.
--   * A rep may NOT touch a lead somebody else holds, and may NOT hand a lead
--     to anybody else.
--
-- THE THIRD PLACE THE SAME RULE HAS TO LIVE. Every file in `api/` runs on the
-- Supabase service key, which bypasses RLS completely. So this file is one of
-- THREE copies of the rule and all three must agree:
--   1. here, for anything the browser writes directly;
--   2. a JavaScript check inside every endpoint that writes a lead;
--   3. the disabled button on screen, which is politeness, not security.
-- If you change this file, change `canEditLead()` in src/lib/salesSheet.js and
-- the endpoint checks in api/sales-score.js and lib/assistant-tools.js in the
-- same commit.
--
-- Safe to run twice. Every policy is dropped by name and recreated.

-- ============================================================
-- 1. admin_leads — SELECT stays wide, UPDATE gets a with check
-- ============================================================
-- SELECT is deliberately untouched and deliberately wide: every member reads
-- every lead. That is not an oversight, it is the requirement — a rep who
-- cannot see another rep's row cannot be stopped from working the same firm,
-- which is the loudest rule on the Rules of Engagement tab.
--
-- WHY `owner_id is null` IS IN THE WITH CHECK AS WELL AS THE USING.
--
-- The plan for this build specified the tighter pair:
--     using      ( admin_is_admin() or owner_id = auth.uid() or owner_id is null )
--     with check ( admin_is_admin() or owner_id = auth.uid() )
--
-- That version is wrong, in two ways that both break ordinary work, and it is
-- written out here so nobody "tightens" it back:
--
--   a. A REP COULD NEVER HAND A LEAD BACK. `releaseLead()` in src/lib/data.js
--      writes `owner_id: null`, so the resulting row has a null owner and the
--      tighter WITH CHECK refuses it. Handing a lead back to the floor is a
--      thing the Rules of Engagement expect a rep to do.
--   b. LOGGING A TOUCH ON AN UNCLAIMED LEAD WOULD FAIL. `admin_lead_activity_touch`
--      (0009) is a plain trigger — not `security definer` — so its UPDATE on
--      admin_leads runs as the person who inserted the activity row and IS
--      subject to this policy. On an unclaimed lead the row after the update
--      still has `owner_id is null`, so the tighter WITH CHECK would refuse the
--      whole insert. A rep logging a call on a lead they have not claimed yet is
--      the ordinary first move, and it would have failed with a permission error
--      nobody could read.
--
-- Allowing a null owner in the WITH CHECK gives away nothing, because the USING
-- clause is what stops a rep reaching another rep's row in the first place:
--   * take an unclaimed lead        → USING passes (null), CHECK passes (self)  ✓
--   * edit their own                → both pass                                 ✓
--   * hand their own back           → USING passes (self), CHECK passes (null)   ✓
--   * touch another rep's           → USING FAILS                                ✗
--   * hand a lead to another rep    → CHECK FAILS (not self, not null)           ✗
--   * strip another rep's claim     → USING FAILS                                ✗
-- The only thing a rep gains is the ability to edit a lead nobody holds without
-- claiming it first, which is what the page has always allowed and what
-- canEditLead() says on screen.

drop policy if exists "members update leads" on public.admin_leads;
create policy "members update leads" on public.admin_leads
  for update
  using (
    public.admin_is_admin()
    or owner_id = auth.uid()
    or owner_id is null
  )
  with check (
    public.admin_is_admin()
    or owner_id = auth.uid()
    or owner_id is null
  );

-- INSERT: 0001's policy was `with check (admin_is_member())` and said nothing
-- about the owner, so a rep could add a contact already owned by another rep.
-- Not much of an attack — but it is a row that belongs to somebody who never
-- took it, and the Floor would draw it as theirs, locked, with their name on it.
drop policy if exists "members insert leads" on public.admin_leads;
create policy "members insert leads" on public.admin_leads
  for insert
  with check (
    public.admin_is_member()
    and (
      public.admin_is_admin()
      or owner_id = auth.uid()
      or owner_id is null
    )
  );

-- ============================================================
-- 2. admin_lead_activity — log against a lead you may work
-- ============================================================
-- 0001:410-412 is `with check (admin_is_member() and actor = auth.uid())`: you
-- may only file a row as yourself, and that half stays. What it does not say is
-- WHICH lead you may file it against, so a rep could log a call on another
-- rep's lead — a dated line, on a record nobody can edit afterwards, about a
-- conversation the lead's owner knows nothing about.
--
-- On the old pages that was unreachable (a rep only ever saw their own leads and
-- the floor). The Floor shows everything, so it stops being unreachable.

-- `admin_can_work_lead()` comes from 0018 section 3b. One function for a rule
-- that four tables need: written out four times, it is four places for it to
-- stop matching.
drop policy if exists "members log own activity" on public.admin_lead_activity;
create policy "members log own activity" on public.admin_lead_activity
  for insert
  with check (
    public.admin_is_member()
    and actor = auth.uid()
    and public.admin_can_work_lead(lead_id)
  );

-- SELECT on activity stays wide, from 0001. A rep opening somebody else's row
-- read-only has to be able to read its timeline, or "so nobody doubles up on
-- this firm" does not work.

-- ============================================================
-- 3. admin_proposals — the same shape, through the lead
-- ============================================================
-- 0009:457-459 gave proposals the identical too-wide policy:
--     for update using (public.admin_is_member())
-- and a proposal carries the only figure of money a rep can see, so it is worth
-- closing at the same time.
--
-- A proposal has no `owner_id` of its own — it has `lead_id` and `created_by`.
-- So the scope is the LEAD's owner, read with a subquery. Deliberately NOT
-- `created_by = auth.uid()`: a proposal drafted by CJ on a rep's lead is still
-- that rep's proposal to send, and scoping on the author would lock them out.
--
-- `lead_id` is nullable on this table, so a proposal attached to no lead is
-- editable by any member — there is nobody it could belong to. Written as an
-- explicit `lead_id is null` branch rather than left to fall out of the
-- subquery, because an EXISTS over no rows is false and would have quietly made
-- every unattached proposal uneditable by everybody.

drop policy if exists "members update proposals" on public.admin_proposals;
create policy "members update proposals" on public.admin_proposals
  for update
  using (
    public.admin_is_admin()
    or lead_id is null
    or exists (
      select 1 from public.admin_leads l
      where l.id = admin_proposals.lead_id
        and (l.owner_id = auth.uid() or l.owner_id is null)
    )
  )
  with check (
    public.admin_is_admin()
    or lead_id is null
    or exists (
      select 1 from public.admin_leads l
      where l.id = admin_proposals.lead_id
        and (l.owner_id = auth.uid() or l.owner_id is null)
    )
  );

-- ============================================================
-- 4. admin_lead_tag_events — a rep may only tag a lead they may work
-- ============================================================
-- 0018 deliberately left this rule out and pointed here, so the whole row-level
-- lock reads in one file. Same shape as the two above.

-- IDENTICAL TO 0018's, ON PURPOSE. Both files state it, through the same
-- function, so running either one twice or in either order leaves the same rule
-- standing. The first version had 0018 create the WIDE policy and this file
-- replace it, which meant re-running 0018 after this file silently reopened the
-- hole — nothing on any screen would have changed. A test caught it; a person
-- would not have.
drop policy if exists "members write tag events" on public.admin_lead_tag_events;
create policy "members write tag events" on public.admin_lead_tag_events
  for insert
  with check (
    public.admin_is_member()
    and (by = auth.uid() or by is null)
    and public.admin_can_work_lead(lead_id)
  );

-- ============================================================
-- 5. admin_email_threads — a rep works their OWN mailbox
-- ============================================================
-- 0003:128-130 made this table admin-only:
--     create policy "admins all email threads" ... for all using (admin_is_admin())
--
-- and src/components/admin/Inbox.jsx reads and writes it STRAIGHT FROM THE
-- BROWSER. There is no endpoint in between, so there is nowhere else to put this
-- rule. Without a policy here a rep's Gmail page renders an empty list with no
-- error, which reads exactly like an empty inbox.
--
-- THE EXISTING ADMIN POLICY IS NOT TOUCHED AND MUST NOT BE LOOSENED. Client
-- billing lives in growth@aisyndicate.com. Two policies for one command are
-- OR'd together in Postgres, so adding this one widens nothing for an admin and
-- takes nothing away.
--
-- A rep gets a thread if its mailbox is one THEY THEMSELVES connected.
-- `admin_gmail_accounts` is keyed (user_id, email_address), so this subquery
-- means "the addresses I connected" and never "an address somebody shared".
-- resolveMailbox() in lib/gmail-mailbox.js already refuses a rep a shared
-- mailbox server-side; this is the same refusal in the database.
--
-- `for all` rather than four policies: the Inbox reads, inserts and updates
-- these rows (status, links, notes, follow-ups) from the browser on the same
-- screen, and splitting one predicate across four policies is four places to
-- get one rule wrong.

drop policy if exists "reps work their own mailbox threads" on public.admin_email_threads;
create policy "reps work their own mailbox threads" on public.admin_email_threads
  for all
  using (
    public.admin_is_member()
    and mailbox in (
      select g.email_address from public.admin_gmail_accounts g
      where g.user_id = auth.uid()
    )
  )
  with check (
    public.admin_is_member()
    and mailbox in (
      select g.email_address from public.admin_gmail_accounts g
      where g.user_id = auth.uid()
    )
  );

-- The browser has to be able to READ the address list for the policy above to
-- be usable at all — a rep's Gmail page asks which mailboxes are theirs. 0001
-- already grants a column-level select on admin_gmail_accounts that deliberately
-- EXCLUDES refresh_token, and its "own gmail read" policy is already
-- `user_id = auth.uid()`. Nothing to change: said here so the next reader does
-- not go looking for a missing grant.

-- ============================================================
-- 6. THE SILENT BREAK WAITING TO HAPPEN
-- ============================================================
-- api/rep-report.js inserts `counted_cause` (line 236 as of Aug 27 2026 — the
-- number moves, the row does not), and 0017_rep_reports.sql never
-- defined that column. 0017 has never been run, so nothing is broken today —
-- but the moment somebody runs it, every rep answer fails to save, silently,
-- because the endpoint logs the error and returns the words anyway (which is the
-- right behaviour for the rep and the wrong behaviour for whoever has to notice).
--
-- One line, here, so running 0017 and 0020 in either order is safe.
alter table public.admin_rep_reports add column if not exists counted_cause text;

-- No CHECK on it, matching the deliberate absence of one on `role` in the same
-- table (0017:42) and for the same reason: the values the endpoint writes are
-- decided in lib/rep-report.js where a test can read them, and a CHECK that has
-- to widen inside a `create table if not exists` is a button that fails silently
-- for a day.

-- ============================================================
-- 6b. THE ONE WAY TO UNDO ALL OF THIS BY ACCIDENT
-- ============================================================
-- RE-RUNNING AN EARLIER MIGRATION AFTER THIS ONE REVERTS THE TIGHTENING.
--
-- 0001 creates "members update leads" (one `using`, no `with check`) and
-- "members log own activity" (no lead scope). This file replaces both by name.
-- Postgres has no idea one is newer than the other, so `psql -f 0001` a month
-- from now puts the wide versions back and every screen keeps looking identical.
--
-- There is no way to make that impossible from inside a file. What there is:
--   * 0018's tag policy carries the same rule this file does, through one shared
--     function, so THAT pair is safe in either order (see 0018 section 3b);
--   * SETUP.md says, in the section for this migration, that re-running 0001 or
--     0009 means re-running 0020 afterwards;
--   * tests/floor-scoping/sql.sh proves the lock by BREAKING it on purpose —
--     it reinstalls 0001's one-clause policy, watches the "cannot steal another
--     rep's lead" assertions start passing when they should fail, re-applies this
--     file, and checks the refusals come back. A test that keeps passing while
--     the feature is broken is worse than no test.
--
-- If you have just re-run an older migration and you are reading this: run this
-- file again, then `bash tests/floor-scoping/sql.sh`.

-- ============================================================
-- 7. AFTER RUNNING THIS
-- ============================================================
--   1. Prove the lock. You cannot sign in as a rep in the SQL editor, so prove
--      it with the test instead:
--        bash tests/floor-scoping/sql.sh
--      It stands up a real Postgres, applies every migration in order, and
--      asserts a rep CANNOT update another rep's lead, CANNOT reassign one,
--      CANNOT tag or log against one, CANNOT read another rep's email threads,
--      CAN take an unclaimed one, and CAN hand their own back.
--   2. Nothing on screen changes. The page already draws another rep's row
--      greyed with its controls off; this is the half that works when somebody
--      skips the page.
--   3. Verify the policies landed:
--        select policyname, cmd from pg_policies
--         where tablename in ('admin_leads','admin_proposals','admin_email_threads',
--                             'admin_lead_activity','admin_lead_tag_events')
--         order by tablename, policyname;


-- ============================================================
-- 0021_outreach_tracking.sql
-- ============================================================
-- ============================================================
-- 0021 — WHAT WENT OUT, WHAT CAME BACK, AND NO OPEN RATE
-- ============================================================
-- Aug 27 2026, Ryder. Four separate things, all about the same page.
--
-- 1. WHAT WE CAN HONESTLY MEASURE ABOUT OUTREACH.
--
-- Gmail cannot tell anybody whether a person opened an email. There is no
-- recipient-side open signal in the Gmail API and there is not one in anybody
-- else's either. The only way an "open rate" is ever produced is a tracking
-- pixel — a 1x1 invisible image that phones home when the mail is displayed —
-- and Apple Mail Privacy Protection loads that pixel for everybody whether they
-- read the mail or not, while Gmail proxies images through Google. So a
-- pixel-based open rate is somewhere between inflated and meaningless. The
-- "under 3% open rate" figure that gets quoted in the industry is measured with
-- that same broken pixel.
--
-- Ryder agreed on Aug 27 to drop it. THERE IS NO OPEN RATE IN THIS SYSTEM AND
-- NO PIXEL IS BUILT. What is measured instead, all of it real:
--   sent · replied · reply rate · time to first reply · bounced.
--
-- If anybody ever adds a pixel, it is labelled "guessed" and never mixed with
-- these. Written here because a column is the place a bad number gets in.
--
-- 2. THE THING THAT IS ALREADY BROKEN AND NOBODY KNEW.
--
-- `admin_leads.email_opened_at` exists (0009:212) and NOTHING HAS EVER WRITTEN
-- IT. It is the hard gate on the one-text-per-lead rule, inside the SQL function
-- `admin_lead_claim_text` (0009:346). So texting is switched off permanently and
-- the screen says "They have not opened an email yet" for ever. Section 4 below
-- repoints that gate at "they replied", which we can actually measure.
--
-- 3. THE REFRESH TOKEN IS PLAINTEXT.
--
-- `admin_gmail_accounts.refresh_token` is a `text not null` column holding, in
-- clear, the thing that grants read-and-send access to a person's mailbox. The
-- browser cannot read it — 0001:346 and 0003:39 grant select on a COLUMN LIST
-- that excludes it — so this is not urgent. But the row count is about to
-- multiply from one shared inbox to one per rep, and lib/vault-crypto.js already
-- does AES-256-GCM for the client connections. Section 3 makes room for the
-- encrypted version.
--
-- 4. ASKING GMAIL WHAT CHANGED INSTEAD OF RE-READING THE INBOX.
--
-- `history_id` is Gmail's own cursor: give it back and Gmail says what has
-- happened since. Today api/gmail-threads.js lists the inbox and then fetches
-- every thread's metadata six at a time, on every single page load.
--
-- Safe to run twice. Additive, admin_-prefixed, every statement guarded.

-- ============================================================
-- 1. THE MAILBOX — a cursor, and room for an encrypted token
-- ============================================================

-- Gmail's incremental change cursor. Text, not a number: Gmail documents it as
-- an opaque value and it is already bigger than a 32-bit int on busy accounts.
alter table public.admin_gmail_accounts add column if not exists history_id text;

-- AES-256-GCM from lib/vault-crypto.js, tied to the row's email address, exactly
-- the way admin_connection_secrets does it in 0013. A blob copied onto another
-- row by hand in the SQL editor fails to unscramble rather than quietly opening
-- somebody else's mailbox.
alter table public.admin_gmail_accounts add column if not exists refresh_token_enc text;

-- WHY THE PLAINTEXT COLUMN STOPS BEING `not null` RATHER THAN BEING DROPPED.
--
-- This file cannot do the encryption: the key lives in VAULT_KEY on the server
-- and SQL has no access to it. So the move is in two steps and this is the first
-- one — make room. The second step happens in the server code
-- (lib/gmail-mailbox.js): on every read, if a row still has a plaintext token
-- and no encrypted one, it encrypts it, writes `refresh_token_enc`, and NULLS
-- `refresh_token`. That cannot happen while the column is `not null`.
--
-- The column is kept rather than dropped so that a row written by an older
-- deploy — one still running gmail-callback.js from before this change — is
-- still readable and still gets migrated on its next read. Dropping it would
-- mean a mid-deploy connect silently loses its token.
alter table public.admin_gmail_accounts alter column refresh_token drop not null;

-- Column-level select, RESTATED with the new columns deliberately left out. A
-- grant on a table's columns does not stretch to columns added later — that is
-- why 0003 had to restate it, and it is why `refresh_token_enc` and
-- `history_id` are simply absent below. `refresh_token_enc` must never appear
-- in a column grant. `history_id` is left out too: it is a server-side cursor,
-- nothing on screen reads it, and a grant nobody needs is a grant nobody
-- notices.
--
-- NOTE FOR WHOEVER READS ROWS FROM THE BROWSER: `select *` on this table now
-- fails for `authenticated`, because a star needs privileges on every column.
-- Nothing does that today (checked Aug 27: every reader in lib/ and api/ runs on
-- the service key, and the two browser paths go through /api/gmail-accounts).
-- Name your columns.
grant select (user_id, email_address, scope, connected_at, shared, display_name, last_synced_at)
  on public.admin_gmail_accounts to authenticated;

-- ============================================================
-- 2. THE THREAD — what actually happened on it
-- ============================================================

-- The id Gmail hands back from messages.send. Returned today and thrown away at
-- api/gmail-send.js:78. Without it there is no way to tell OUR send apart from
-- any other message on the thread, which is what a reply is measured against.
alter table public.admin_email_threads add column if not exists gmail_message_id text;

-- THE FIRST time we wrote to them, and the FIRST time they wrote back. First,
-- not last, and both nullable:
--   * time-to-reply is reply-minus-send, and the LAST send would give a
--     negative number on any thread with a follow-up;
--   * null means "has not happened", which is not a zero and must never print
--     as one.
alter table public.admin_email_threads add column if not exists first_out_at timestamptz;
alter table public.admin_email_threads add column if not exists first_reply_at timestamptz;

-- A bounce. Not a reply, and it has to come OUT of the reply-rate denominator:
-- an address that does not exist was never given the chance to answer, and
-- leaving it in makes a clean list look like a bad one.
alter table public.admin_email_threads add column if not exists bounced_at timestamptz;

-- WHO READS THIS INDEX, honestly: nothing on the Overview does.
--
-- An earlier version of this line said "counting sent and replied per mailbox is
-- the one query the Overview tiles run", and that is the opposite of what was
-- built. lib/outreach.js counts LEAD columns, for a reason it explains at length:
-- a thread is keyed on a mailbox, and admin_gmail_accounts is readable only by the
-- person who connected it (0001), so nothing in the browser can say which mailbox
-- belongs to which rep — which is exactly what the owner's rep-numbers table
-- needs to do.
--
-- The index is kept because api/gmail-threads.js does read threads by mailbox on
-- every page load, and because a per-mailbox count is the natural query the day
-- somebody wants "what went out of growth@ last month".
create index if not exists admin_email_threads_outreach_idx
  on public.admin_email_threads (mailbox, first_out_at desc)
  where first_out_at is not null;
create index if not exists admin_email_threads_lead_idx
  on public.admin_email_threads (lead_id) where lead_id is not null;

-- ============================================================
-- 3. THE LEAD — the same two moments, on the person
-- ============================================================
-- The thread has these too, and that is not a duplicate. A lead can have several
-- threads (a new email months later, a different rep, a forwarded chain), and
-- "when did we first reach this person" is a question about the PERSON. The
-- thread columns are the record; these two are the answer.
--
-- THEY ARE TWO STATEMENTS, NOT ONE, and an earlier version of this line claimed
-- otherwise ("written by the same one function, so they cannot drift"). They are
-- written in the same function and in the same breath, but a database has no idea
-- of that: either can fail while the other succeeds. So both call sites read the
-- result and say so — api/gmail-threads.js collects them into `problems` and
-- answers 207, and api/gmail-send.js and api/gmail-drafts.js log the failure
-- against the person who sent the mail. They CAN drift; what is guaranteed is
-- that a drift is recorded somewhere a person can find it.
alter table public.admin_leads add column if not exists first_email_at timestamptz;
alter table public.admin_leads add column if not exists first_reply_at timestamptz;

-- A bounce, ON THE PERSON. The thread column above is the record of which
-- message bounced; this is the answer to "can we email this person at all",
-- which is a fact about them and not about one thread.
--
-- IT HAS TO BE HERE FOR THE REPLY RATE TO BE HONEST. Reply rate is counted per
-- PERSON — of the people we emailed, how many wrote back — and an address that
-- does not exist was never given the chance to answer. Leaving a bounce in the
-- denominator makes a clean list look like a bad one, and it is the one number
-- on the Overview a rep would be judged on.
alter table public.admin_leads add column if not exists bounced_at timestamptz;

create index if not exists admin_leads_reply_idx
  on public.admin_leads (first_reply_at) where first_reply_at is not null;

-- ============================================================
-- 4. REPOINT THE TEXT GATE — from "they opened" to "they replied"
-- ============================================================
-- `admin_lead_claim_text` (0009:326-350) is the only thing that may increment
-- `texts_sent`, and it refuses unless `email_opened_at is not null`. Nothing has
-- ever written that column, so the function has never once returned true and the
-- Text button has never once been usable.
--
-- A reply is a STRONGER signal than an open, not a weaker one. An open can be an
-- image proxy; a reply is a person typing. So the rule the Rules of Engagement
-- tab is reaching for — "only text somebody who has shown interest" — is better
-- served by this than by the thing it asked for.
--
-- `email_opened_at` IS DELIBERATELY LEFT IN PLACE AND UNUSED. Dropping a column
-- is not reversible and somebody may yet wire an honest open signal to it — but
-- if they do, it must be labelled "guessed" and it must NOT be put back in this
-- gate. The comment on the column says so, in the database, where the next
-- person will actually read it.
comment on column public.admin_leads.email_opened_at is
  'UNUSED ON PURPOSE (Aug 27 2026). Nothing writes this. Gmail has no recipient-side open signal; only a tracking pixel gives one, and that number is loaded by Apple Mail for everybody and proxied by Google, so it is not a measurement. The one-text gate runs on first_reply_at in BOTH places it exists: admin_lead_claim_text() here, and textGate() in lib/sales-rules.js which draws the button. (For a few hours on Aug 27 this comment said nothing read the column while textGate still did, so the rule was live in the database and dead in the browser.) If anyone ever fills this column, label the number GUESSED and never mix it with the measured ones.';

create or replace function public.admin_lead_claim_text(p_lead uuid, p_max int default 1)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated int;
begin
  if not public.admin_is_member() then
    raise exception 'not authorized';
  end if;
  update public.admin_leads
    set texts_sent = coalesce(texts_sent, 0) + 1,
        last_text_at = now()
    where id = p_lead
      and coalesce(texts_sent, 0) < p_max
      -- THE CHANGED LINE. Was `email_opened_at is not null`, which nothing has
      -- ever written, so this function could never return true. A reply is the
      -- signal we can actually measure — see the note above this function.
      and first_reply_at is not null
      -- AND THE ROW-LEVEL LOCK, added Aug 27 with 0020. This function is
      -- `security definer`, so it writes past RLS: without this line a rep could
      -- spend another rep's one text on their lead by calling the function
      -- directly. The claim-text gate exists to protect our phone numbers; it
      -- should not be a hole in the row lock at the same time.
      and (public.admin_is_admin() or owner_id = auth.uid() or owner_id is null);
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

revoke execute on function public.admin_lead_claim_text(uuid, int) from anon, public;
grant execute on function public.admin_lead_claim_text(uuid, int) to authenticated;

-- ============================================================
-- 5. AFTER RUNNING THIS
-- ============================================================
--   1. Nothing back-fills. `first_out_at`, `first_reply_at` and the two lead
--      columns start filling from the next email sent and the next reply read.
--      Back-filling from the mailbox would mean dating today's read as if it
--      were the day the mail arrived, and the Overview tiles say the window they
--      cover — a back-fill would make that sentence false.
--   2. The reply-rate tiles read "0 of 0" until real mail moves through. That is
--      the true answer and it says so; it is not the same as "nobody replies".
--   3. Existing Gmail connections keep working. The first server-side read of
--      each one encrypts its token and clears the plaintext. Verify with:
--        select email_address,
--               (refresh_token is null) as plaintext_cleared,
--               (refresh_token_enc is not null) as encrypted
--          from public.admin_gmail_accounts;
--      Both true on every row means the move is done. VAULT_KEY has to be set in
--      Vercel for that to happen at all — with no key the server keeps using the
--      plaintext and says so in the log rather than losing anybody's mailbox.


-- ============================================================
-- 0022_personal_brain.sql
-- ============================================================
-- ============================================================
-- 0022 — A REP'S OWN AI RULES
-- ============================================================
-- Aug 27 2026, Ryder. Every rep writes differently and sells differently, and
-- today the AI writes every draft the same way.
--
-- WHAT EXISTS TODAY. `admin_brain` is the COMPANY brain: one global list of
-- standing rules and facts, owner/admin only, and api/ai-draft.js:37-47
-- deliberately refuses to load it for a sales rep so a rep cannot get the AI to
-- recite it back (that is trap #8 in §8 — a sales-blocked table leaking through
-- an AI endpoint). A rep therefore has no way to teach the AI anything at all.
--
-- WHY THIS IS A NEW TABLE AND NOT A `user_id` COLUMN ON admin_brain.
-- `admin_brain`'s policy is a single `for all using (admin_is_admin())` covering
-- all four commands (0001:428-430). To let a rep read their own rows there, that
-- policy would have to be widened — and the moment it is, the company Brain is
-- one mistake away from a rep's prompt. A separate table cannot leak the company
-- one, whatever anybody writes next.
--
-- THE HARD RULE, AND IT IS ON THE SCREEN AS WELL AS IN HERE:
--
--   A PERSONAL RULE SETS TONE, LENGTH, FORMAT AND SIGN-OFF. NEVER A FACT AND
--   NEVER A NUMBER.
--
-- The reason is mechanical, not stylistic. The honesty gate works by checking
-- every number in a draft against the fact sheet the model was shown, and the
-- personal rules have to be part of that fact sheet or the gate throws away
-- honest answers for using words it was never given. Which means: a fact typed
-- into a personal rule ENTERS THE POOL THE GATE CHECKS AGAINST. Type "our
-- clients see a 40% lift" into your own rules and the gate will happily let the
-- AI write it to a prospect, because as far as the gate can tell, we told it
-- that. One rep's typo becomes a claim we made.
--
-- So the save path refuses a rule containing ANY DIGIT AT ALL, and says why on
-- screen. That check is checkPersonalRule() in lib/sales-rules.js, where a test
-- can read it, and it is a character class: `/[0-9]/`.
--
-- STRICTER THAN IT SOUNDS, AND DELIBERATELY SO. "Keep it to 4 sentences" is
-- refused, and so is "Rule 3:". An earlier draft of this comment said a digit-run
-- or a percentage was the rule and that "Rule 3:" was fine — both untrue of the
-- code. The reason for the stricter line: allow a single digit and "if their score
-- is under 6, name it" walks through, and a bare 6 in the pool is a number the
-- model may then attach to a firm. Length, tone and subject style are fixed
-- settings on the page rather than sentences, so nothing a rule needs to say
-- requires a digit, and a phone number belongs in a Gmail signature where it is
-- attached to the mailbox that sends the mail.
--
-- WHAT IT DOES NOT CATCH, on record rather than claimed away: "a forty percent
-- lift" written in words, and non-ASCII digits. Both are pinned in
-- tests/user-brain as known limits rather than as intended behaviour.
--
-- It is NOT enforced here as a CHECK constraint, on purpose: the same digit that
-- is wrong in a rule is right in a title somebody types by accident and then
-- fixes, and a refusal a person can read beats a Postgres error they cannot.
-- The label on a rule goes through the same check — see upsertUserBrain.
--
-- AN ADMIN CAN READ ANY REP'S RULES. A rule nobody can audit quietly rewrites
-- what clients get told. Same own/all split admin_rep_reports uses in 0017.
--
-- Safe to run twice.

create table if not exists public.admin_user_brain (
  id uuid primary key default gen_random_uuid(),

  -- WHOSE RULE THIS IS. Every policy below hangs off this column, so it is the
  -- whole access model of the table in one field. It defaults to auth.uid() and
  -- the insert policy forces it to match, so a rep cannot file a rule under
  -- somebody else's name and change how THEIR drafts get written.
  user_id uuid not null references auth.users on delete cascade default auth.uid(),

  -- 'voice'     — one of the fixed settings: tone, length, subject-line style
  -- 'rule'      — a sentence the rep typed ("one question per email, at the end")
  -- 'snippet'   — a reusable opener or paragraph
  -- 'signature' — the sign-off
  kind text not null default 'rule',

  -- For a 'voice' row, which setting it is ('tone', 'length', 'subject',
  -- 'never_say'). Null on the others. A key rather than a column per setting, so
  -- adding "how I talk about price" is a row and not a migration.
  setting_key text,

  title text,
  body text not null,

  -- Switched off rather than deleted, so a rep can try a rule, turn it off, and
  -- still find it next week.
  enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Drop-and-re-add with every existing value re-listed, because `create table if
-- not exists` leaves an older CHECK in place for ever and re-running this file
-- would not widen one. See the trap note in 0018.
alter table public.admin_user_brain drop constraint if exists admin_user_brain_kind_check;
alter table public.admin_user_brain
  add constraint admin_user_brain_kind_check
  check (kind in ('voice','rule','snippet','signature'));

-- A rule with no words in it is not a rule, and an empty row renders as a blank
-- bullet on the page and as a blank line in the prompt.
alter table public.admin_user_brain drop constraint if exists admin_user_brain_body_check;
-- `btrim(body)` WITH NO SECOND ARGUMENT ONLY TRIMS SPACES. A body of one newline
-- or one tab walked straight through it and saved as a rule with no words in it,
-- which renders as a blank bullet on the page and as a blank line in every draft's
-- prompt. The character set has to be spelled out. Found by tests/user-brain,
-- Aug 27 2026.
alter table public.admin_user_brain
  add constraint admin_user_brain_body_check
  check (length(btrim(body, E' \t\r\n')) > 0);

-- A cap, so one paste cannot put a whole document into every draft's system
-- prompt. 2,000 characters is about a page — far more than any tone rule needs
-- and far less than anything that would push the facts out of the prompt.
alter table public.admin_user_brain drop constraint if exists admin_user_brain_body_len_check;
alter table public.admin_user_brain
  add constraint admin_user_brain_body_len_check
  check (length(body) <= 2000);

-- One row per setting per person for the fixed settings, so picking "Formal"
-- twice does not leave two tone rules fighting each other in the prompt.
--
-- NOT PARTIAL, AND THAT IS THE WHOLE POINT OF THIS COMMENT.
--
-- The first version carried `where setting_key is not null`, which reads as the
-- careful choice: 'rule' and 'snippet' rows have a null setting_key and there can
-- be many of them per person. It would have broken every save.
--
-- Postgres will only use a PARTIAL unique index as an ON CONFLICT arbiter when
-- the statement repeats the index's own predicate. The browser saves a setting
-- with PostgREST's `upsert(..., { onConflict: "user_id,setting_key" })`, which
-- emits a bare `on conflict (user_id, setting_key)` and cannot express a WHERE at
-- all. With no arbiter, Postgres raises 42P10 — "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification" — so Tone, Length, Subject
-- lines, Sign-off and Never say would every one of them have failed with a raw
-- database error the moment this file was run. Preview mode never touches that
-- branch, which is why nothing would have caught it until the day somebody ran
-- the migration. Found by tests/user-brain, Aug 27 2026, before it ever ran.
--
-- Dropping the predicate is safe: Postgres treats NULLs as DISTINCT in a unique
-- index by default, so any number of rows with a null setting_key still coexist
-- for one person. The index does exactly what it did, and PostgREST can now name
-- it.
--
-- The `drop index` is here because `create unique index if not exists` would
-- leave the older PARTIAL index in place on any database where the first version
-- had already been run — the same class of trap as a CHECK that never widens.
drop index if exists public.admin_user_brain_setting_idx;
create unique index if not exists admin_user_brain_setting_idx
  on public.admin_user_brain (user_id, setting_key);

create index if not exists admin_user_brain_user_idx
  on public.admin_user_brain (user_id, created_at);

drop trigger if exists admin_user_brain_updated_at on public.admin_user_brain;
create trigger admin_user_brain_updated_at before update on public.admin_user_brain
  for each row execute function public.admin_set_updated_at();

-- ---- who can touch it -------------------------------------------------
-- In plain words:
--   * A person reads, writes, edits and deletes their OWN rules and nobody
--     else's.
--   * Owner and admin can READ every rep's rules, because a rule nobody can
--     audit rewrites what prospects get told.
--   * Owner and admin CANNOT edit somebody else's rules. Correcting how another
--     person writes is a conversation, not a database write — and a rep whose
--     own settings changed under them with no explanation stops using the page.
--
-- Unlike the tag events, update and delete ARE allowed here. These are settings,
-- not records: "my sign-off is X" is a current preference, and its history is
-- worth nothing. Contrast admin_lead_tag_events, where the history IS the point.

alter table public.admin_user_brain enable row level security;

grant select, insert, update, delete on public.admin_user_brain to authenticated;

drop policy if exists admin_user_brain_own on public.admin_user_brain;
create policy admin_user_brain_own on public.admin_user_brain
  for all to authenticated
  using (public.admin_is_member() and user_id = auth.uid())
  with check (public.admin_is_member() and user_id = auth.uid());

drop policy if exists admin_user_brain_admin_read on public.admin_user_brain;
create policy admin_user_brain_admin_read on public.admin_user_brain
  for select to authenticated
  using (public.admin_is_admin());

-- ============================================================
-- AFTER RUNNING THIS
-- ============================================================
--   1. The AI Brain page in a rep's sidebar starts saving. Before this file has
--      run it loads, shows the settings, and says in plain words that nothing
--      can be saved yet.
--   2. Personal rules reach the model through lib/ai.js buildSystemPrompt(),
--      placed AFTER the company rules and BEFORE the job instruction, in a block
--      that states in words that the company rules override them. That order is
--      the same shape the feedback loop already uses (§32/§33: correction above,
--      constraint below, and the constraint saying it wins).
--   3. Verify:
--        select user_id, kind, setting_key, left(body, 40) from public.admin_user_brain;
--      and check that an admin reading it sees every rep's rows while a rep sees
--      only their own — bash tests/user-brain/sql.sh proves both.


-- ============================================================
-- 0023_close_the_won_hole.sql
-- ============================================================
-- ============================================================
-- 0023 — THE WON FUNCTION GETS THE ROW LOCK, AND STOPS LETTING
--        THE CALLER NAME SOMEBODY ELSE AS THE AUTHOR
-- ============================================================
-- Aug 27 2026. Found by an adversarial review of the Floor build, hours after
-- 0020 went in. It is not a defect in 0020 — it is the hole 0020 left open, and
-- it is the biggest one in this console.
--
-- WHAT IS WRONG. `admin_lead_to_client(p_lead, p_actor, p_stage)` in
-- 0015_sales_lifecycle.sql is `security definer`, which means it writes past
-- row-level security entirely, and its only guard was:
--
--     if not public.admin_is_member() then raise exception 'not authorized'; end if;
--
-- It is granted to `authenticated`. So one line typed into the browser console by
-- any signed-in sales rep:
--
--     supabase.rpc('admin_lead_to_client', { p_lead: '<any lead id>', p_actor: '<anybody>' })
--
-- marked somebody else's live deal Won, stamped `became_customer` on it, created
-- a client record for the agency, relinked every other contact at that firm, and
-- wrote a 'converted' line on the timeline whose `actor` was WHOEVER THE CALLER
-- NAMED. Two separate problems in one call:
--
--   1. NO ROW LOCK. 0021 went back and added the lock to the other
--      security-definer function (admin_lead_claim_text). The function that does
--      far more got nothing. Trap #6 in CONTEXT-FOR-AI.md §8 — "UI-only
--      permission guards are not guards" — for the fourth time in this repo.
--
--   2. A FORGED AUTHOR. `p_actor` is a parameter and `v_actor` was
--      `coalesce(p_actor, auth.uid())`, so the activity row could be filed under
--      any user id. Every other write path refuses this: 0001's activity policy
--      is `with check (… and actor = auth.uid())` and 0018's tag policy is
--      `(by = auth.uid() or by is null)`. `security definer` skips both. A dated
--      line naming the wrong person is worse than no line, because the whole
--      point of an append-only timeline is that it cannot be argued with.
--
-- WHY THIS IS A NEW FILE AND NOT AN EDIT TO 0015. 0015 has never been run, so
-- editing it would have worked — and it would have hidden the finding. A separate
-- file is a record of a hole that existed, which is what the next person needs.
-- It is also the only shape that is safe if 0015 HAS been run somewhere nobody
-- told us about.
--
-- THE BODY BELOW IS 0015's, LIFTED VERBATIM, with two guards added and one
-- declaration changed. It was extracted from the file by a script rather than
-- retyped, on purpose: a paraphrase of a 200-line function that creates client
-- records is a divergence waiting to happen. If 0015's logic ever changes, change
-- it here in the same commit — tests/sales-sheet/sql.sh drives the whole
-- lead-to-client behaviour through this one function, so a divergence fails there
-- rather than in production.
--
-- RE-RUN ORDER, SAID OUT LOUD: this file replaces a function 0015 defines, so
-- re-running 0015 after this puts the hole back. Same trap 0020 §6b and 0018 §3b
-- describe. If you ever re-run 0015 or 0009, run 0020 and then this file again,
-- and then `bash tests/floor-scoping/sql.sh`.
--
-- Safe to run twice. It replaces one function and changes nothing else.

create or replace function public.admin_lead_to_client(
  p_lead uuid,
  p_actor uuid default null,
  p_stage text default 'Onboarding'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead      public.admin_leads%rowtype;
  v_company   public.admin_companies%rowtype;
  v_client_id uuid;
  v_name      text;
  v_actor     uuid;
  v_siblings  int := 0;
  v_created   boolean := false;
  v_key       text;
begin
  if not public.admin_is_member() then
    raise exception 'not authorized';
  end if;

  /* ---- THE AUTHOR IS WHOEVER IS ASKING ----
   *
   * `p_actor` stays in the signature so every caller keeps working — src/lib/data.js
   * and all four Won buttons pass it — but a rep may now only ever pass their own
   * id. An owner or admin may still name somebody else, because recording a deal
   * on a rep's behalf is a real thing they do and they can already write anything.
   *
   * REFUSED RATHER THAN SILENTLY CORRECTED. Rewriting it would mean the browser
   * believes it filed the row under one person while the database filed it under
   * another, and nobody would ever find out which. */
  if p_actor is not null and p_actor <> auth.uid() and not public.admin_is_admin() then
    raise exception 'a deal can only be recorded under your own name';
  end if;
  v_actor := coalesce(p_actor, auth.uid());

  /* ---- THE ROW LOCK, in the one place a rep can otherwise write past it ----
   *
   * `security definer` means the policies on admin_leads do not run at all for
   * the writes below, so this is the only place the rule can be. It is the same
   * rule as everywhere else, through the same function (0018 section 3b), so it
   * cannot drift from the policies, the endpoint checks or canEditLead() on the
   * page. */
  /* "NO SUCH LEAD" AND "SOMEBODY ELSE'S LEAD" ARE DIFFERENT ANSWERS.
   * admin_can_work_lead returns false for a lead that does not exist, so checking
   * it first made a mistyped id read as a permission problem and left the
   * "no such lead" message below unreachable. Existence first, then permission.
   * Third review, Aug 27 2026. */
  if not exists (select 1 from public.admin_leads where id = p_lead) then
    raise exception 'no such lead';
  end if;
  if not public.admin_can_work_lead(p_lead) then
    raise exception 'that lead belongs to somebody else';
  end if;

  -- FOR UPDATE, not a plain select. This is the lock that makes a second
  -- caller wait and then find the work already done, instead of racing.
  select * into v_lead from public.admin_leads where id = p_lead for update;
  if not found then
    raise exception 'no such lead: %', p_lead;
  end if;

  -- Already done. Return the same id rather than raising: pressing Won twice
  -- is an ordinary thing a person does, not an error, and an error here would
  -- show a red box for a thing that worked.
  --
  -- BOTH halves are checked on purpose. `client_id` alone was wrong and a test
  -- caught it: the moment ONE contact at a firm closes, every other contact
  -- there is attached to the same client — which is the whole point — so a
  -- client_id-only check made every one of THEIR deals return early and never
  -- get marked won. A firm with four contacts could record exactly one sale,
  -- ever, and the rep who closed the second one would watch the button do
  -- nothing. Being attached to a client and having closed a deal are two
  -- different facts about a person.
  if v_lead.client_id is not null and coalesce(v_lead.became_customer, false) then
    return jsonb_build_object(
      'client_id', v_lead.client_id, 'created', false,
      'already_customer', true, 'siblings', 0);
  end if;

  if v_lead.company_id is not null then
    select * into v_company from public.admin_companies where id = v_lead.company_id for update;
  end if;

  -- The firm may already be a client — another contact there closed first, or
  -- somebody set the client up by hand and linked it. Reuse it.
  v_client_id := coalesce(v_lead.client_id, v_company.client_id);

  if v_client_id is null then
    v_name := nullif(btrim(coalesce(v_company.name, v_lead.company, v_lead.name, '')), '');
    if v_name is null then
      raise exception 'this lead has no firm name and no person name, so there is nothing to call the client';
    end if;

    -- A CONTACT ADDED BY HAND HAS NO FIRM ROW, so there is nothing to lock and
    -- nothing to dedupe against. Two people typed in under the same firm name
    -- and both marked Won produced TWO clients with the same name, each holding
    -- half the history — deterministically, no race needed. That is verbatim
    -- the failure this file's header says it exists to prevent, and it was
    -- found by a reviewer rather than by the tests.
    --
    -- So: take a transaction-scoped advisory lock on the NAME KEY (so a real
    -- race also serialises here), then look for a client that already carries
    -- that name. Matched on the normalised name AND the domain when both sides
    -- have one — name alone would fold two same-named firms in different states
    -- onto one client.
    v_key := public.admin_company_name_key(v_name);
    if v_key is not null then
      perform pg_advisory_xact_lock(hashtext('admin_lead_to_client:' || v_key));

      select c.id into v_client_id
      from public.admin_clients c
      where public.admin_company_name_key(c.name) = v_key
        -- REFUSED ONLY WHEN BOTH SIDES NAME A WEBSITE AND THE WEBSITES DIFFER.
        --
        -- The first version demanded both-present-and-equal or both-absent,
        -- which sounded careful and was wrong: the sheet's Company column
        -- carries no website, and a hand-added contact has no firm row, so one
        -- contact at a firm having a website and the next one not having one is
        -- the ORDINARY case. Two contacts at "Olson Law PLLC" then produced two
        -- clients with the same name and half the history each — verbatim the
        -- failure this block exists to prevent. Proved against real Postgres by
        -- a reviewer.
        --
        -- A missing website is not evidence of a different firm; two different
        -- websites are. So a blank on either side does not block the match, and
        -- two names that differ (& vs and, a state suffix) still do — the name
        -- key above is unchanged and remains the strict half of the test.
        and (
          c.domain is null
          or nullif(btrim(coalesce(v_company.domain, v_lead.domain, '')), '') is null
          or lower(regexp_replace(c.domain, '^https?://(www\.)?|/$', '', 'g'))
            = lower(regexp_replace(coalesce(v_company.domain, v_lead.domain), '^https?://(www\.)?|/$', '', 'g'))
        )
      order by c.created_at
      limit 1;
    end if;
  end if;

  if v_client_id is null then
    v_created := true;
    insert into public.admin_clients (
      name, domain, vertical, stage, status, start_date,
      contact_name, contact_email, contact_phone, company_id, origin, notes
    ) values (
      v_name,
      nullif(btrim(coalesce(v_company.domain, v_lead.domain, '')), ''),
      nullif(btrim(coalesce(v_company.vertical, v_lead.vertical, '')), ''),
      coalesce(nullif(btrim(p_stage), ''), 'Onboarding'),
      'active',
      (now() at time zone 'America/Chicago')::date,
      nullif(btrim(coalesce(v_lead.name, '')), ''),
      nullif(btrim(coalesce(v_lead.email, '')), ''),
      nullif(btrim(coalesce(v_lead.phone, v_company.phone, '')), ''),
      v_company.id,
      'sales',
      'Came up through the sales pipeline. The whole chase — every call, email and note — is on this firm''s contacts in Sales.'
    )
    returning id into v_client_id;
  else
    -- Linking to a record that already exists. Fill in ONLY what is blank
    -- there. Somebody's typed-in contact is not replaced by a lead's.
    update public.admin_clients
      set company_id    = coalesce(company_id, v_company.id),
          contact_name  = coalesce(nullif(btrim(coalesce(contact_name, '')), ''), nullif(btrim(coalesce(v_lead.name, '')), '')),
          contact_email = coalesce(nullif(btrim(coalesce(contact_email, '')), ''), nullif(btrim(coalesce(v_lead.email, '')), '')),
          contact_phone = coalesce(nullif(btrim(coalesce(contact_phone, '')), ''), nullif(btrim(coalesce(v_lead.phone, '')), ''))
      where id = v_client_id;
  end if;

  if v_company.id is not null then
    update public.admin_companies set client_id = v_client_id where id = v_company.id;

    -- EVERY person we hold at that firm points at the client now. This is the
    -- half that makes the record continuous: three months later, the delivery
    -- team opens the client and can still read who was rung, when, and what
    -- was said — instead of a client record that begins on the day the money
    -- started.
    --
    -- `became_customer` is NOT set on the siblings. Whose deal it was is a
    -- different fact from who works there, and flattening the two would count
    -- one sale four times on the rep scoreboard.
    update public.admin_leads
      set client_id = v_client_id
      where company_id = v_company.id and id <> p_lead and client_id is null;
    get diagnostics v_siblings = row_count;
  end if;

  update public.admin_leads
    set client_id          = v_client_id,
        became_customer    = true,
        became_customer_at = now(),
        became_customer_by = v_actor,
        stage              = 'won',
        closed_at          = coalesce(closed_at, now())
    where id = p_lead;

  -- The timeline says it happened, on the record that already holds the chase.
  -- An event with nothing on the timeline is an event nobody can find later.
  if v_actor is not null then
    /* `where not exists` rather than a plain insert. A lead that was attached
     * to the client by a SIBLING'S conversion, and then closes its own deal,
     * runs this block for the first time — but a lead whose own conversion is
     * re-run after being un-flagged by hand would otherwise get a second
     * identical line. One conversion, one line. */
    insert into public.admin_lead_activity (lead_id, actor, type, body)
    select
      p_lead, v_actor, 'converted',
      'Won. Now a paying client'
        || case when v_siblings > 0
             then ' — and the other ' || v_siblings || ' contact'
                  || case when v_siblings = 1 then '' else 's' end
                  || ' at this firm are attached to the same client record.'
             else '.' end
    where not exists (
      select 1 from public.admin_lead_activity
      where lead_id = p_lead and type = 'converted'
    );

    if v_siblings > 0 then
      insert into public.admin_lead_activity (lead_id, actor, type, body)
      select id, v_actor, 'client_link',
             'This firm became a paying client. Everything logged here stays on the record.'
      from public.admin_leads l
      where l.company_id = v_company.id and l.id <> p_lead and l.client_id = v_client_id
        and not exists (
          select 1 from public.admin_lead_activity a
          where a.lead_id = l.id and a.type = 'client_link'
        );
    end if;
  end if;

  return jsonb_build_object(
    'client_id', v_client_id,
    'created', v_created,
    'already_customer', false,
    'siblings', v_siblings);
end;
$$;
revoke execute on function public.admin_lead_to_client(uuid, uuid, text) from anon, public;
grant execute on function public.admin_lead_to_client(uuid, uuid, text) to authenticated;

-- ============================================================
-- AFTER RUNNING THIS
-- ============================================================
--   1. Nothing on any screen changes. Every Won button already passes the
--      signed-in person as `p_actor` — which is now the only value a rep may
--      pass — and every one of them already only appears on a lead the rep may
--      work.
--   2. Prove it:  bash tests/floor-scoping/sql.sh
--      It asserts a rep cannot close another rep's deal through the function,
--      cannot file the timeline row under somebody else's name, and CAN still
--      close their own and an unclaimed one.
--   3. If you ever re-run 0015 or 0009, run 0020 and then this file again.

