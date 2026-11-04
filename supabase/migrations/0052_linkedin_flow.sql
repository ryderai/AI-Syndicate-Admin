-- ============================================================
-- 0052 — LINKEDIN OUTREACH: THE CLIENT FLOW (Builds 3, 4, 5, 2).  4 Nov 2026
-- ============================================================
-- New columns on four existing linkedin_ tables, four new tables, one
-- trigger, and one tightening: console logins may write only the columns the
-- live LinkedIn page edits (section 4). Nothing is removed; the live LinkedIn
-- page keeps working before and after. Safe to run twice.
-- NOT RUN YET. Needs 0051 first.
--
-- WHY. CJ's "LinkedIn Outreach — Build Brief for Ryder" (3 Nov 2026):
--  - Build 3: an Engagement with stages Form received → Paid → Building →
--    In review → Approved → Access scheduled → Live → Report due → Renewed
--    (+ Paused, Churned), dates that compute (build due = paid + 48 h,
--    report due = launch + 30 days), target lists, daily activity, replies.
--  - Build 4: a tokenized approval page (no login) and a booked login slot.
--  - Build 5: Julie's daily log, her queue, the mid-month and day-30 reports.
--  - Build 2: replies classified by Claude, leads alerted to the client.
-- Plus ONE thing the brief doesn't have: a PIN page. CJ, by phone (4 Nov
-- 2026): when Julie logs in, LinkedIn sends a verification PIN to the
-- account owner, and today CJ has to be the go-between. The client now types
-- the PIN into a one-use page and it appears on Julie's screen.
--
-- THE NEW STAGE IS A NEW COLUMN (flow_stage), not the old `stage`
-- (new/setting_up/live/paused/ended), which the live page edits. The old
-- column is left alone, so nothing breaks before the new screens ship.
--
-- WHO. Reads: linkedin_can_work() like every linkedin_ table. The NEW
-- tables are written only by the API routes (service role); console logins
-- get SELECT. The three older tables keep the grants 0049 gave them (the
-- live page writes daily rows and searches directly).
-- ============================================================

-- ------------------------------------------------------------
-- 1. THE ENGAGEMENT (Build 3): stage + dates + one-use links
-- ------------------------------------------------------------
alter table public.linkedin_clients add column if not exists flow_stage text not null default 'form_received';
do $$ begin
  alter table public.linkedin_clients drop constraint if exists linkedin_clients_flow_stage_check;
  alter table public.linkedin_clients add constraint linkedin_clients_flow_stage_check check (flow_stage in
    ('form_received','paid','building','in_review','approved','access_scheduled','live','report_due','renewed','paused','churned'));
end $$;
alter table public.linkedin_clients add column if not exists stage_changed_at timestamptz;
alter table public.linkedin_clients add column if not exists stage_history jsonb not null default '[]'::jsonb;  -- [{ stage, at }]
alter table public.linkedin_clients add column if not exists build_due_at timestamptz;     -- paid + 48 h (the client's promise)
alter table public.linkedin_clients add column if not exists booking_at timestamptz;       -- Julie's 5-minute login slot
alter table public.linkedin_clients add column if not exists launch_date date;             -- set when Julie confirms login (stage Live)
alter table public.linkedin_clients add column if not exists midmonth_due date;            -- launch + 14 (the brief)
alter table public.linkedin_clients add column if not exists report_due date;              -- launch + 29: the day before Stripe renews (the brief)
alter table public.linkedin_clients add column if not exists renewed_at timestamptz;
-- The CURRENT month: starts at launch, moves on 30 days at each renewal, so
-- month 2's reports come due too (3 Nov check: one launch date meant reports
-- stopped after month 1). midmonth_due / report_due follow it.
alter table public.linkedin_clients add column if not exists period_start date;
alter table public.linkedin_clients add column if not exists payment_failed_at timestamptz;   -- Stripe invoice.payment_failed; Paused after 3 days unpaid (the brief)
-- One-use links. Only a sha256 of each token is stored; the token itself is
-- in the link we hand the client, never in the database.
alter table public.linkedin_clients add column if not exists approval_token_hash text;
alter table public.linkedin_clients add column if not exists approval_token_expires_at timestamptz;
alter table public.linkedin_clients add column if not exists pin_token_hash text;
alter table public.linkedin_clients add column if not exists pin_token_expires_at timestamptz;
create index if not exists linkedin_clients_flow_idx on public.linkedin_clients (flow_stage);
create index if not exists linkedin_clients_approval_tok_idx on public.linkedin_clients (approval_token_hash);
create index if not exists linkedin_clients_pin_tok_idx on public.linkedin_clients (pin_token_hash);

-- Rows that already exist, BEFORE the trigger below exists (so no date is
-- invented for them): the old stage maps across; nothing is marked late on
-- day one (3 Nov check: a paid backfill set "copy due" 48 h in the past).
-- Only on the FIRST run (before the trigger exists), so running twice is safe.
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'linkedin_clients_flow') then
    update public.linkedin_clients set flow_stage = case stage
        when 'live' then 'live' when 'paused' then 'paused' when 'ended' then 'churned'
        else case when paid_at is not null then 'paid' else 'form_received' end end;
  end if;
end $$;

-- The dates compute themselves and every stage change is written down
-- (the brief: "Stage changes write a timestamp; the dates feed the Late /
-- Due today cards").
create or replace function public.linkedin_clients_flow()
returns trigger
language plpgsql
as $$
begin
  -- Paid (Stripe webhook, or an owner's "mark paid") moves a waiting form on.
  if new.paid_at is not null and new.flow_stage = 'form_received' then
    new.flow_stage := 'paid';
  end if;
  -- The 48 hours run from when BOTH are true: form sent and first month
  -- paid (the brief's trigger), never from a payment made before the form.
  if new.paid_at is not null and new.submitted_at is not null and new.build_due_at is null
     and new.flow_stage in ('paid','building') then
    new.build_due_at := greatest(new.paid_at, new.submitted_at) + interval '48 hours';
  end if;
  -- MOVING to live sets the launch date (if a person didn't already). Only
  -- the move: a row that was already 'live' before this file (the backfill
  -- below gives no dates) must not get today's date on its next notes edit,
  -- or the reports job would start writing reports for it (4 Nov check).
  if new.flow_stage = 'live' and new.launch_date is null
     and (tg_op = 'INSERT' or old.flow_stage is distinct from 'live') then
    new.launch_date := (now() at time zone 'America/Chicago')::date;
  end if;
  if new.launch_date is not null and new.period_start is null then
    new.period_start := new.launch_date;
  end if;
  if tg_op = 'UPDATE' and new.launch_date is distinct from old.launch_date and old.period_start = old.launch_date then
    new.period_start := new.launch_date;    -- a person corrected the launch date in month 1
  end if;
  if new.period_start is not null and (tg_op = 'INSERT' or new.period_start is distinct from old.period_start or new.midmonth_due is null) then
    new.midmonth_due := new.period_start + 14;   -- the brief: launch + 14
    new.report_due := new.period_start + 29;     -- the brief: launch + 29, the day before Stripe renews
  end if;
  if tg_op = 'INSERT' or new.flow_stage is distinct from old.flow_stage then
    new.stage_changed_at := now();
    new.stage_history := coalesce(new.stage_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('stage', new.flow_stage, 'at', now()));
  end if;
  return new;
end;
$$;
drop trigger if exists linkedin_clients_flow on public.linkedin_clients;
create trigger linkedin_clients_flow before insert or update on public.linkedin_clients
  for each row execute function public.linkedin_clients_flow();



-- ------------------------------------------------------------
-- 2. TARGET LISTS, DAILY ROWS, REPLIES (Build 3 fields on the old tabs)
-- ------------------------------------------------------------
alter table public.linkedin_searches add column if not exists headcount text;
alter table public.linkedin_searches add column if not exists keywords text;
alter table public.linkedin_searches add column if not exists exclusions text;
alter table public.linkedin_searches add column if not exists list_status text;
do $$ begin
  alter table public.linkedin_searches drop constraint if exists linkedin_searches_list_status_check;
  alter table public.linkedin_searches add constraint linkedin_searches_list_status_check check (list_status is null or list_status in ('draft','client_review','approved','exhausted'));
end $$;
alter table public.linkedin_searches add column if not exists source_version_id uuid references public.linkedin_sequence_versions on delete set null;

alter table public.linkedin_daily_activity add column if not exists list_id uuid references public.linkedin_searches on delete set null;  -- "which list was worked"

alter table public.linkedin_responses add column if not exists prospect_url text;
alter table public.linkedin_responses add column if not exists confidence numeric(3,2);
alter table public.linkedin_responses add column if not exists suggested_reply text;
alter table public.linkedin_responses add column if not exists summary text;
alter table public.linkedin_responses add column if not exists referred_name text;
alter table public.linkedin_responses add column if not exists reply_status text;
do $$ begin
  alter table public.linkedin_responses drop constraint if exists linkedin_responses_reply_status_check;
  alter table public.linkedin_responses add constraint linkedin_responses_reply_status_check check (reply_status is null or reply_status in ('lead','nurture','closed'));
end $$;
alter table public.linkedin_responses add column if not exists needs_review boolean not null default false;   -- under 0.6 confidence: Julie decides
alter table public.linkedin_responses add column if not exists classified_at timestamptz;
alter table public.linkedin_responses add column if not exists client_notified_at timestamptz;
alter table public.linkedin_responses add column if not exists override_note text;
alter table public.linkedin_responses add column if not exists alert_outbox_id uuid;     -- the drafted lead alert, so an override can withdraw it
alter table public.linkedin_responses add column if not exists message_hash text;        -- the same reply pasted twice is one row
create index if not exists linkedin_responses_hash_idx on public.linkedin_responses (li_client_id, message_hash);


-- ------------------------------------------------------------
-- 3. NEW TABLES
-- ------------------------------------------------------------
-- The PIN the client types on the one-use page. Lives 15 minutes.
create table if not exists public.linkedin_pins (
  id uuid primary key default gen_random_uuid(),
  li_client_id uuid not null references public.linkedin_clients on delete cascade,
  code text not null check (code ~ '^[0-9]{4,8}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  seen_at timestamptz
);
create index if not exists linkedin_pins_client_idx on public.linkedin_pins (li_client_id, created_at desc);

-- Mid-month and day-30 reports, written from the rows (Build 5).
create table if not exists public.linkedin_reports (
  id uuid primary key default gen_random_uuid(),
  li_client_id uuid not null references public.linkedin_clients on delete cascade,
  kind text not null check (kind in ('midmonth','day30')),
  period_start date not null,
  period_end date not null,
  numbers jsonb not null default '{}'::jsonb,
  lead_names text[] not null default '{}',
  summary text,
  recommendations jsonb not null default '[]'::jsonb,
  internal_note text,                -- for whoever sends it (e.g. "no activity logged"); never in the client's email
  status text not null default 'draft' check (status in ('draft','sent','skipped')),
  outbox_id uuid,
  created_at timestamptz not null default now(),
  unique (li_client_id, kind, period_start)
);

-- Every email the flow wants to send. NOTHING is sent from here: a draft
-- waits for a person (copy into Gmail, then "Mark sent") — Ryder's rule that
-- nothing reaches a client without a person's yes.
create table if not exists public.linkedin_outbox (
  id uuid primary key default gen_random_uuid(),
  li_client_id uuid references public.linkedin_clients on delete cascade,
  kind text not null,                -- resources_ready | revision_coming | revised_ready | approved_book | live | lead_alert | report_midmonth | report_day30
  to_email text,
  cc text[] not null default '{}',
  subject text not null,
  body_text text not null,
  internal_note text,                -- for the person sending it only; shown on the console, never copied into the email (4 Nov check)
  status text not null default 'draft' check (status in ('draft','sent','skipped')),
  created_at timestamptz not null default now(),
  done_at timestamptz,
  done_by uuid references auth.users on delete set null
);
alter table public.linkedin_outbox add column if not exists internal_note text;  -- in case an earlier copy of this file was run
create index if not exists linkedin_outbox_status_idx on public.linkedin_outbox (status, created_at desc);

-- Settings CJ owns (the brief: "CJ sets the numbers and they live in one
-- config, not in code").
create table if not exists public.linkedin_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users on delete set null
);
insert into public.linkedin_settings (key, value) values
  ('daily_caps', '{"connections": 20, "inmails": 10}'::jsonb),
  ('booking_url', 'null'::jsonb),
  ('report_cc', '["cj@aisyndicate.com"]'::jsonb)
on conflict (key) do nothing;

do $$
declare t text;
begin
  foreach t in array array['linkedin_pins','linkedin_reports','linkedin_outbox','linkedin_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.linkedin_can_work())', t || '_select', t);
    execute format('revoke insert, update, delete on public.%I from authenticated, anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;


-- ------------------------------------------------------------
-- 4. WHAT A CONSOLE LOGIN MAY WRITE ON linkedin_clients DIRECTLY
-- ------------------------------------------------------------
-- 0049 let any linkedin_can_work() login (since 0050 that includes Julie's
-- 'linkedin' role) update EVERY column straight through the database. With
-- the flow, that would let a login write its own approval-token hash and
-- approve as the client, or set the stage and paid date (3 Nov check). From
-- here, direct writes are limited to what the live LinkedIn page edits; the
-- flow columns change only through the API routes (service role).
revoke update on public.linkedin_clients from authenticated;
grant update (stage, owner_id, notes) on public.linkedin_clients to authenticated;
revoke insert on public.linkedin_clients from authenticated;
grant insert (company, contact_name, contact_email, answers, source, status, submitted_at) on public.linkedin_clients to authenticated;
