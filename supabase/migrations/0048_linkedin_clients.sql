-- ============================================================
-- 0048 — LINKEDIN OUTREACH CLIENTS.  30 Oct 2026
-- ============================================================
-- Additive only. Five new linkedin_-prefixed tables, one function, one private
-- storage bucket. Nothing that exists is altered. Safe to run twice.
--
-- WHY. CJ, 29 Oct 2026 (email "Form and Tracker Needed for New LinkedIn
-- Marketing Clients"): AI Syndicate now runs LinkedIn Outreach for clients
-- Netwrks sends us, with a VA (Julie) launching the campaigns. Their sign-up
-- was a Google Form, and each client's work lived in its own Google Sheet with
-- five tabs. CJ: "We can keep doing this UNLESS there is a way to have this go
-- to our CRM instead." This is that way:
--
--   linkedin_clients          one row per client: the onboarding answers
--                             (the form at aisyndicate.com/onboarding/linkedin/)
--                             + where the campaign stands
--   linkedin_daily_activity   the sheet's "Daily Activity" tab
--   linkedin_searches         its "Search History" tab
--   linkedin_sequences        its "LinkedIn Outreach Copy" tab
--   linkedin_responses        its "Responses" tab
--   (its "General Info" tab   = linkedin_clients.answers)
--
-- WHO CAN SEE IT. One function, linkedin_can_work(), decides for every table
-- and the bucket. Today it is owners + admins. To let a sales-role login (a VA)
-- work it, change that ONE function to admin_is_member() — and add 'linkedin'
-- to the sales menu in src/components/admin/Sidebar.jsx.
--
-- THE FORM GETS NO KEY. The public form writes only through
-- aisyndicate.com/api/linkedin-onboarding/, which uses the service role. anon
-- has no policy on anything here. A client resumes a draft with a key whose
-- sha256 is edit_key_hash; the key itself is never stored.
-- ============================================================

create or replace function public.linkedin_can_work()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.admin_is_admin();
$$;
revoke execute on function public.linkedin_can_work() from anon, public;
grant execute on function public.linkedin_can_work() to authenticated;


-- ------------------------------------------------------------
-- 1. ONE ROW PER CLIENT
-- ------------------------------------------------------------
create table if not exists public.linkedin_clients (
  id uuid primary key default gen_random_uuid(),

  -- The form. status: draft (being filled in) | submitted.
  status text not null default 'draft' check (status in ('draft','submitted')),
  answers jsonb not null default '{}'::jsonb,
  files jsonb not null default '[]'::jsonb,       -- [{ field, name, path, size, type, uploaded_at }]
  edit_key_hash text,                              -- null for a row added by hand in the console
  source text not null default 'website',          -- website | console
  ref text,                                        -- ?ref= on the form link (e.g. netwrks)

  -- Copied out of answers on every save, so the list never parses JSON.
  contact_name text,
  contact_email text,
  company text,
  linkedin_url text,

  -- The campaign. stage: new | setting_up | live | paused | ended.
  stage text not null default 'new' check (stage in ('new','setting_up','live','paused','ended')),
  owner_id uuid references auth.users on delete set null,
  client_id uuid references public.admin_clients on delete set null,
  notes text,

  last_saved_at timestamptz,
  resume_sent_at timestamptz,
  submitted_at timestamptz,
  team_emailed_at timestamptz,                     -- null on a sent form = the team email failed; the console flags it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists linkedin_clients_status_idx on public.linkedin_clients (status, submitted_at desc);
create index if not exists linkedin_clients_email_idx on public.linkedin_clients (lower(contact_email));

drop trigger if exists linkedin_clients_updated on public.linkedin_clients;
create trigger linkedin_clients_updated before update on public.linkedin_clients
  for each row execute function public.admin_set_updated_at();


-- ------------------------------------------------------------
-- 2. THE FOUR TRACKER TABS
-- ------------------------------------------------------------
create table if not exists public.linkedin_daily_activity (
  id uuid primary key default gen_random_uuid(),
  li_client_id uuid not null references public.linkedin_clients on delete cascade,
  day date not null,
  connections_sent integer not null default 0 check (connections_sent >= 0),
  accepted integer not null default 0 check (accepted >= 0),
  replies integer not null default 0 check (replies >= 0),
  inmails integer not null default 0 check (inmails >= 0),
  leads integer not null default 0 check (leads >= 0),
  lead_names text,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (li_client_id, day)
);

create table if not exists public.linkedin_searches (
  id uuid primary key default gen_random_uuid(),
  li_client_id uuid not null references public.linkedin_clients on delete cascade,
  last_activity date,
  status text,
  campaign_title text,
  search_url text,
  current_page integer check (current_page is null or current_page >= 0),
  results integer check (results is null or results >= 0),
  job_titles text,
  geography text,
  industry text,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.linkedin_sequences (
  id uuid primary key default gen_random_uuid(),
  li_client_id uuid not null references public.linkedin_clients on delete cascade,
  day date,
  status text,
  sequence_url text,
  notes text,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.linkedin_responses (
  id uuid primary key default gen_random_uuid(),
  li_client_id uuid not null references public.linkedin_clients on delete cascade,
  day date,
  name text,
  inbox text,
  message text,
  classification text,
  reactivation_date date,
  status text,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['linkedin_daily_activity','linkedin_searches','linkedin_sequences','linkedin_responses'] loop
    execute format('create index if not exists %I on public.%I (li_client_id)', t || '_client_idx', t);
    execute format('drop trigger if exists %I on public.%I', t || '_updated', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.admin_set_updated_at()', t || '_updated', t);
  end loop;
end $$;


-- ------------------------------------------------------------
-- 3. ROW LEVEL SECURITY — linkedin_can_work() for everything
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['linkedin_clients','linkedin_daily_activity','linkedin_searches','linkedin_sequences','linkedin_responses'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.linkedin_can_work())', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.linkedin_can_work())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.linkedin_can_work()) with check (public.linkedin_can_work())', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.linkedin_can_work())', t || '_delete', t);
  end loop;
end $$;

-- edit_key_hash is a sha256 of the client's resume key, not the key, so a
-- console reader learns nothing from it. The console never selects it.


-- ------------------------------------------------------------
-- 4. THE UPLOADS — private bucket, readable by the same people
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('linkedin-onboarding', 'linkedin-onboarding', false, 3145728)
on conflict (id) do nothing;

drop policy if exists "linkedin_onboarding_read" on storage.objects;
create policy "linkedin_onboarding_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'linkedin-onboarding' and public.linkedin_can_work());

comment on table public.linkedin_clients is
  'LinkedIn Outreach clients: onboarding answers from aisyndicate.com/onboarding/linkedin/ plus campaign stage. '
  'Written by the website API (service role) and the admin console LinkedIn page. 0048.';
