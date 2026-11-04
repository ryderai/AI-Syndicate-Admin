-- ============================================================
-- 0051 — LINKEDIN OUTREACH: SEQUENCE VERSIONS + FIRST PAYMENT.  3 Nov 2026
-- ============================================================
-- Additive only. Two new tables and ten new columns on linkedin_clients.
-- Nothing that exists is changed or removed. Safe to run twice.
-- NOT RUN YET. Run in Supabase before api/linkedin-messages.js,
-- api/linkedin-build-due.js and api/linkedin-stripe-webhook.js are deployed.
--
-- WHY. CJ's "LinkedIn Outreach — Build Brief for Ryder" (3 Nov 2026):
--  - Build 1 stores its output "on a Sequence record".
--  - Build 3 defines that record: "versioned per engagement. Version number,
--    source (Claude draft / revision / manual), the JSON from Build 1, the
--    client's feedback text that produced the next version, status (Draft /
--    Client review / Approved / Retired), the variant the client chose. Only
--    one Approved version at a time."
--  - Build 1's trigger: "onboarding form submitted ... and Stripe
--    invoice.paid for the first month. Do not generate on form submission
--    alone." So the engagement needs to know it was paid.
-- The rest of Build 3 (the new stage list, dates, target lists, replies)
-- ships with Build 3's screens, in its own migration, so the live LinkedIn
-- page never meets a stage name it doesn't know.
--
-- NAME. linkedin_sequences (0048) is the old sheet's "Outreach Copy" tab (a
-- date, a status, a URL) and the live page reads it, so the brief's Sequence
-- record is linkedin_sequence_versions.
--
-- WHO. Reads: linkedin_can_work() (0048), like every linkedin_ table.
-- Writes: the service role only (the API routes, which check the role). The
-- console login gets SELECT and nothing else (3 Nov check: with INSERT, any
-- linkedin_can_work() user could add unchecked copy as a draft; with DELETE,
-- erase approved history). A trigger is the second lock.
-- ============================================================

-- ------------------------------------------------------------
-- 1. THE ENGAGEMENT KNOWS IT WAS PAID
-- ------------------------------------------------------------
alter table public.linkedin_clients add column if not exists paid_at timestamptz;              -- first month paid (Stripe), or marked by an owner
alter table public.linkedin_clients add column if not exists paid_source text;                 -- stripe_checkout | stripe_invoice | manual
alter table public.linkedin_clients add column if not exists stripe_customer_id text;
alter table public.linkedin_clients add column if not exists stripe_subscription_id text;
alter table public.linkedin_clients add column if not exists last_invoice_paid_at timestamptz; -- every invoice.paid, renewals included (Build 5 reads it)
-- One writer at a time per client: the route claims this BEFORE the model is
-- called and clears it after, so a double click is refused before anything
-- is billed (3 Nov second check).
alter table public.linkedin_clients add column if not exists messages_generating_at timestamptz;
-- Failed automatic runs in a row; the hourly job skips a client at 3 so one
-- broken client can't block newer ones. Reset by any successful run.
alter table public.linkedin_clients add column if not exists messages_attempts integer not null default 0;
alter table public.linkedin_clients add column if not exists messages_last_error text;
alter table public.linkedin_clients add column if not exists paid_marked_by uuid references auth.users on delete set null; -- who marked it paid by hand
alter table public.linkedin_clients add column if not exists renewal_date date;                -- end of the paid period, from Stripe's invoice
create index if not exists linkedin_clients_stripe_sub_idx on public.linkedin_clients (stripe_subscription_id);
create index if not exists linkedin_clients_stripe_cus_idx on public.linkedin_clients (stripe_customer_id);


-- ------------------------------------------------------------
-- 2. THE SEQUENCE RECORD (versioned)
-- ------------------------------------------------------------
create table if not exists public.linkedin_sequence_versions (
  id uuid primary key default gen_random_uuid(),
  li_client_id uuid not null references public.linkedin_clients on delete cascade,
  version integer not null check (version >= 1),
  source text not null default 'claude' check (source in ('claude','revision','manual')),
  status text not null default 'draft' check (status in ('draft','client_review','approved','retired')),

  content jsonb,                                -- the Build 1 JSON, parsed: variants, target_lists, reply_templates, notes_for_reviewer
  raw_response text,                            -- exactly what the model returned (the brief: store it)
  prompt_version text not null,                 -- lib/linkedin-messages.js PROMPT_VERSION
  model text,
  request_ids text[] not null default '{}',     -- the provider's id for every billed call (1 or 2)
  issues jsonb not null default '[]'::jsonb,    -- checkOutput(): [{ where, level, code, message }]
  risk jsonb not null default '{}'::jsonb,      -- riskReview()
  expires_on date,                              -- LAST date the copy names: after it the whole version is out of date
  first_dated_on date,                          -- FIRST date: from it, stop sending the dated messages
  retried text,                                 -- null | parse | repair | repair_discarded

  from_version_id uuid references public.linkedin_sequence_versions on delete set null,
  feedback text,                                -- the client's change request on THIS version (it produced the next one)
  made_from_feedback text,                      -- the feedback that produced THIS version (a copy, so a second revision's words are never lost)
  chosen_variant text check (chosen_variant is null or chosen_variant in ('Value-led','Direct')),

  created_by uuid references auth.users on delete set null,
  reviewed_by uuid references auth.users on delete set null,   -- Julie's copy review: draft -> client_review
  reviewed_at timestamptz,
  approved_at timestamptz,
  approved_via text check (approved_via is null or approved_via in ('console','client_page')),
  approved_by uuid references auth.users on delete set null,   -- null when the client approved on the page
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (li_client_id, version),
  check (status <> 'approved' or (approved_at is not null and approved_via is not null and chosen_variant is not null))
);
create index if not exists linkedin_sequence_versions_client_idx on public.linkedin_sequence_versions (li_client_id, version desc);
-- "Only one Approved version at a time."
create unique index if not exists linkedin_sequence_versions_one_approved on public.linkedin_sequence_versions (li_client_id) where status = 'approved';

drop trigger if exists linkedin_sequence_versions_updated on public.linkedin_sequence_versions;
create trigger linkedin_sequence_versions_updated before update on public.linkedin_sequence_versions
  for each row execute function public.admin_set_updated_at();

-- THE GATE. Runs for every writer, the service role included.
create or replace function public.linkedin_sequence_versions_gate()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A new sequence version always starts as a draft.';
    end if;
    return new;
  end if;

  -- What was generated and checked never changes. A different text = a new version.
  if new.content is distinct from old.content or new.raw_response is distinct from old.raw_response
     or new.issues is distinct from old.issues or new.risk is distinct from old.risk
     or new.version is distinct from old.version or new.li_client_id is distinct from old.li_client_id
     or new.prompt_version is distinct from old.prompt_version or new.model is distinct from old.model
     or new.request_ids is distinct from old.request_ids or new.expires_on is distinct from old.expires_on
     or new.source is distinct from old.source or new.from_version_id is distinct from old.from_version_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
     or new.retried is distinct from old.retried or new.first_dated_on is distinct from old.first_dated_on
     or new.made_from_feedback is distinct from old.made_from_feedback then
    raise exception 'A sequence version''s copy cannot be edited. Make a new version.';
  end if;
  if old.feedback is not null and new.feedback is distinct from old.feedback then
    raise exception 'Feedback on a version is written once.';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'A retired version stays retired.';
  end if;
  if old.status = 'approved' and new.chosen_variant is distinct from old.chosen_variant then
    raise exception 'The chosen variant of an approved version cannot change.';
  end if;

  if new.status is distinct from old.status then
    -- Julie's review: draft -> client_review, only when nothing blocks.
    if new.status = 'client_review' then
      if old.status <> 'draft' then
        raise exception 'Only a draft can go to the client (this one is %).', old.status;
      end if;
      if new.content is null or exists (select 1 from jsonb_array_elements(new.issues) i where i->>'level' = 'block') then
        raise exception 'This version has blocking problems.';
      end if;
      -- Refused from the FIRST date the copy names: a dated message ("I'm in
      -- New York Nov 16") must never reach the client or Julie's paste after
      -- that day (3 Nov fourth check).
      if coalesce(new.first_dated_on, new.expires_on) is not null and coalesce(new.first_dated_on, new.expires_on) <= current_date then
        raise exception 'This version names a date that has come or passed. Make a new version.';
      end if;
    elsif new.status = 'approved' then
      if old.status <> 'client_review' then
        raise exception 'Only a version the client is reviewing can be approved (this one is %).', old.status;
      end if;
      -- Refused from the FIRST date the copy names: a dated message ("I'm in
      -- New York Nov 16") must never reach the client or Julie's paste after
      -- that day (3 Nov fourth check).
      if coalesce(new.first_dated_on, new.expires_on) is not null and coalesce(new.first_dated_on, new.expires_on) <= current_date then
        raise exception 'This version names a date that has come or passed. Make a new version.';
      end if;
      -- A signed-in approver is recorded as themselves, and must be an owner or admin.
      if auth.uid() is not null then
        if not public.admin_is_admin() then
          raise exception 'Only an owner or admin can approve in the console.';
        end if;
        new.approved_by := auth.uid();
        new.approved_via := 'console';
      end if;
      new.approved_at := coalesce(new.approved_at, now());
      -- "Only one Approved version at a time": the old one retires.
      update public.linkedin_sequence_versions set status = 'retired'
        where li_client_id = new.li_client_id and status = 'approved' and id <> new.id;
    elsif new.status = 'draft' then
      raise exception 'A version never goes back to draft. Make a new version.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists linkedin_sequence_versions_gate on public.linkedin_sequence_versions;
create trigger linkedin_sequence_versions_gate before insert or update on public.linkedin_sequence_versions
  for each row execute function public.linkedin_sequence_versions_gate();

alter table public.linkedin_sequence_versions enable row level security;
drop policy if exists linkedin_sequence_versions_select on public.linkedin_sequence_versions;
create policy linkedin_sequence_versions_select on public.linkedin_sequence_versions for select to authenticated using (public.linkedin_can_work());
revoke insert, update, delete on public.linkedin_sequence_versions from authenticated, anon;
grant select on public.linkedin_sequence_versions to authenticated;


-- ------------------------------------------------------------
-- 3. STRIPE EVENTS WE RECEIVED (each handled once)
-- ------------------------------------------------------------
-- Stripe retries a webhook until it gets a 2xx and can send the same event
-- twice. The event id is the key, so a repeat does nothing.
create table if not exists public.linkedin_stripe_events (
  id text primary key,                         -- Stripe's evt_...
  type text not null,
  li_client_id uuid references public.linkedin_clients on delete set null,
  result text not null,                        -- e.g. paid, renewal, no_match, ignored
  received_at timestamptz not null default now()
);
alter table public.linkedin_stripe_events enable row level security;
drop policy if exists linkedin_stripe_events_select on public.linkedin_stripe_events;
create policy linkedin_stripe_events_select on public.linkedin_stripe_events for select to authenticated using (public.linkedin_can_work());
revoke insert, update, delete on public.linkedin_stripe_events from authenticated, anon;
grant select on public.linkedin_stripe_events to authenticated;
