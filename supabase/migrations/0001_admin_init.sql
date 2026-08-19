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
