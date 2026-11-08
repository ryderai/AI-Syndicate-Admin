-- ============================================================
-- 0054 — START PACKETS.  6 Nov 2026
-- ============================================================
-- Additive only. Two new start_-prefixed tables and one private storage
-- bucket. Nothing that exists is altered. Safe to run twice.
--
-- WHY. Andrew, call 6 Nov 2026: one email with one link instead of three
-- conversations (agreement, Stripe, onboarding form). Ryder, same day: one of
-- us fills it in, CJ signs it, we send it, the client fills it in and sends it
-- back, and every team member gets a copy of that email.
--
--   start_packets        one row per packet: proposal, agreement, both
--                        signatures, the client's answers, payment status
--   start_packet_events  the audit trail: created, CJ signed, link made,
--                        sent, opened, sent back — with time, IP and browser
--
-- WHO CAN SEE IT. Nobody directly. Both tables have row-level security ON and
-- NO policies, and no grant to anon or authenticated: every read and write
-- goes through /api/start-packets (console members, owner + admin) or
-- /api/start-public (the client, with the private link), which use the
-- service role. The private link's code is never stored, only its sha256.
-- ============================================================

create table if not exists public.start_packets (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.admin_leads on delete set null,
  status text not null default 'draft'
    check (status in ('draft','ready','sent','opened','returned','void')),

  business text not null,
  contact_name text,
  contact_email text,
  website text,
  form_kind text not null default 'geo' check (form_kind in ('geo','website_geo')),

  proposal jsonb not null default '{}'::jsonb,   -- {package, price, term, start_date, includes, notes, doc_url}

  contract_title text,
  contract_text text,                             -- pasted agreement, may hold {{blanks}}
  contract_pdf_path text,                         -- or an uploaded PDF in bucket start-packets
  contract_pdf_name text,
  contract_pdf_sha256 text,
  contract_sha256 text,                           -- fingerprint of everything CJ signed (lib/start-packet.js contentFingerprint)

  payment_url text,                               -- the Stripe link the client opens
  payment_note text,                              -- what the card will be charged, in words
  stripe_customer_id text,                        -- optional: lets us check Stripe (read-only) for a saved card

  ais_signer_name text,
  ais_signer_title text,
  ais_signer_email text,
  ais_signature jsonb,                            -- {kind:'typed'|'drawn', data}
  ais_signed_at timestamptz,
  ais_signed_by uuid references auth.users on delete set null,

  token_hash text unique,
  token_expires_at timestamptz,

  sent_at timestamptz,
  sent_by uuid references auth.users on delete set null,
  sent_by_email text,
  sent_via text,                                  -- 'gmail' | 'copied'
  opened_at timestamptz,
  returned_at timestamptz,

  client_sig jsonb,                               -- {name,title,email,signature:{kind,data},consent,ip,ua,signed_at}
  answers jsonb,
  payment_status jsonb,                           -- {client_says_done, note, stripe:{state,text,at}}
  team_email jsonb,                               -- {sent, reason, to[], at}

  created_by uuid references auth.users on delete set null,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists start_packets_status_idx on public.start_packets (status, updated_at desc);
create index if not exists start_packets_lead_idx on public.start_packets (lead_id);

create table if not exists public.start_packet_events (
  id bigserial primary key,
  packet_id uuid not null references public.start_packets on delete cascade,
  kind text not null,
  at timestamptz not null default now(),
  by_user uuid references auth.users on delete set null,
  by_email text,
  ip text,
  ua text,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists start_packet_events_packet_idx on public.start_packet_events (packet_id, at);

create or replace function public.start_packets_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists start_packets_updated on public.start_packets;
create trigger start_packets_updated before update on public.start_packets
  for each row execute function public.start_packets_touch();

alter table public.start_packets enable row level security;
alter table public.start_packet_events enable row level security;
revoke all on public.start_packets from anon, authenticated;
revoke all on public.start_packet_events from anon, authenticated;

-- ------------------------------------------------------------
-- The agreement PDFs — private bucket, service role only.
-- (Skipped on a plain Postgres with no storage schema, e.g. a local test.)
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('start-packets', 'start-packets', false, 10485760, array['application/pdf'])
    on conflict (id) do nothing;
  end if;
end $$;

comment on table public.start_packets is
  'Start packets: one link with the proposal, the agreement (signed by CJ, then the client), the onboarding questions and the Stripe link. '
  'Service role only, through /api/start-packets and /api/start-public. 0054.';
