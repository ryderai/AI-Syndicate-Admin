-- ============================================================
-- 0053 — LINKEDIN OUTREACH v2: sales-page sign-ups, the client's login
-- details, and a per-person prospect list.  6 Nov 2026
-- ============================================================
-- Needs 0051 + 0052 first. Adds columns, one table and settings. Removes
-- nothing; every live screen keeps working before and after. Safe to run
-- twice.
--
-- WHY (asks since 4 Nov 2026, quoted from email and texts):
--  - CJ, text 5 Nov: a page for the LinkedIn service where people "can fill
--    out a form, a stripe customer profile and pay". -> status 'signup' rows
--    made by /linkedin-outreach/, paid through CJ's Stripe link with
--    client_reference_id = the row id (the webhook already matches on that).
--  - Julie, email 5 Nov: "I need his password and email for LinkedIn. Also
--    the location so I can set my vpn"; WhatsApp "is usually more efficient"
--    for the codes. CJ, text 5 Nov: "we do need to collect the customers
--    email and password at some point". -> the client fills in their LinkedIn
--    login email, the city they log in from, a WhatsApp number, good times
--    and how they will pass the code, on their private login page.
--  - THE PASSWORD IS NEVER STORED (CJ's brief, Guardrails: "No passwords in
--    the form or the console ... Nothing we store can leak a client's
--    LinkedIn credentials"). It goes from the client to Julie through the
--    sharing tool named in settings (password_method); the console records
--    only that Julie has it, when, and who said so.
--  - Ryder's 4 Nov defaults to CJ (no objection): "next I build a
--    per-person prospect list so follow-ups are tracked". -> linkedin_prospects.
-- ============================================================

-- ------------------------------------------------------------
-- 1. A SALES-PAGE SIGN-UP IS A ROW TOO (status 'signup'), and is folded into
--    the client's onboarding-form row once that arrives (status 'merged').
-- ------------------------------------------------------------
do $$ begin
  alter table public.linkedin_clients drop constraint if exists linkedin_clients_status_check;
  alter table public.linkedin_clients add constraint linkedin_clients_status_check check (status in ('draft','submitted','signup','merged'));
end $$;
alter table public.linkedin_clients add column if not exists merged_into uuid references public.linkedin_clients on delete set null;
alter table public.linkedin_clients add column if not exists checkout_started_at timestamptz;   -- the sign-up went on to Stripe
alter table public.linkedin_clients add column if not exists signup_paid_drafted_at timestamptz; -- "payment received, here's your form" drafted once

-- ------------------------------------------------------------
-- 2. THE LOGIN DETAILS (filled in by the client on their private page)
-- ------------------------------------------------------------
alter table public.linkedin_clients add column if not exists login_email text;         -- the email they sign in to LinkedIn with
alter table public.linkedin_clients add column if not exists login_location text;      -- city + state/country they log in from (Julie's VPN)
alter table public.linkedin_clients add column if not exists whatsapp text;            -- digits with country code, e.g. +12055550100
alter table public.linkedin_clients add column if not exists login_times text;         -- times they're free for the 5-minute login
alter table public.linkedin_clients add column if not exists code_method text;
do $$ begin
  alter table public.linkedin_clients drop constraint if exists linkedin_clients_code_method_check;
  alter table public.linkedin_clients add constraint linkedin_clients_code_method_check check (code_method is null or code_method in ('page','whatsapp','email'));
end $$;
alter table public.linkedin_clients add column if not exists login_details_at timestamptz;
alter table public.linkedin_clients add column if not exists password_received_at timestamptz;   -- Julie has it (NOT the password)
alter table public.linkedin_clients add column if not exists password_received_by uuid references auth.users on delete set null;

-- A code typed on the page is also emailed to Julie at once (CJ, 4 Nov: "when
-- they submit their code, it will send via email to you immediately").
alter table public.linkedin_pins add column if not exists emailed_at timestamptz;

-- ------------------------------------------------------------
-- 3. PROSPECTS: one row per person who accepted, so follow-ups are tracked
--    per person (the brief's Build 5 queue: "follow-ups due today by step
--    and delay"). Written only through /api/linkedin-prospects.
-- ------------------------------------------------------------
create table if not exists public.linkedin_prospects (
  id uuid primary key default gen_random_uuid(),
  li_client_id uuid not null references public.linkedin_clients on delete cascade,
  name text not null check (length(name) between 1 and 200),
  profile_url text,
  list_id uuid references public.linkedin_searches on delete set null,
  accepted_on date not null,
  last_step integer not null default 0 check (last_step between 0 and 4),   -- 0 = none sent yet; 4 = the breakup
  last_sent_on date,
  prev_sent_on date,                         -- the send before last_sent_on, so "undo" puts the dates back
  status text not null default 'active' check (status in ('active','replied','done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users on delete set null
);
alter table public.linkedin_prospects add column if not exists prev_sent_on date;   -- in case an earlier copy of this file was run
create index if not exists linkedin_prospects_client_idx on public.linkedin_prospects (li_client_id, status);
create unique index if not exists linkedin_prospects_once on public.linkedin_prospects (li_client_id, lower(name), coalesce(profile_url, ''));
drop trigger if exists linkedin_prospects_updated on public.linkedin_prospects;
create trigger linkedin_prospects_updated before update on public.linkedin_prospects
  for each row execute function public.admin_set_updated_at();
alter table public.linkedin_prospects enable row level security;
drop policy if exists linkedin_prospects_select on public.linkedin_prospects;
create policy linkedin_prospects_select on public.linkedin_prospects for select to authenticated using (public.linkedin_can_work());
revoke insert, update, delete on public.linkedin_prospects from authenticated, anon;
grant select on public.linkedin_prospects to authenticated;

-- ------------------------------------------------------------
-- 4. SETTINGS CJ OWNS
-- ------------------------------------------------------------
insert into public.linkedin_settings (key, value) values
  ('julie_whatsapp', 'null'::jsonb),
  ('password_method', '"Julie will send you a secure NordPass link to share your LinkedIn password. Please don''t email or text your password."'::jsonb),
  ('code_alert_email', 'true'::jsonb),
  ('signup_notify', '["cj@aisyndicate.com","ryder@aisyndicate.com"]'::jsonb)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 5. THE NEW COLUMNS ARE WRITTEN ONLY BY THE API ROUTES (service role).
--    0052 section 4 limited direct console writes to stage, owner_id,
--    notes; nothing here widens that.
-- ------------------------------------------------------------
