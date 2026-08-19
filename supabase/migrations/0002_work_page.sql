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
