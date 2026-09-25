-- 0045 — PROOF OF CONSENT FOR EVERY CALL, TEXT AND EMAIL. 25 Sep 2026.
--
-- The revenue calculator popup on the landing pages (and the calculator page
-- itself) asks for a phone number under a line that says the person agrees
-- AI Syndicate "may call, text or email you about your results and our
-- services". Until now the page sent that agreement and the console threw it
-- away, so a rep had a phone number and no proof the person said yes. Ryder,
-- 25 Sep 2026: "we do need to add this so we know we have consent."
--
-- ONE ROW PER TIME SOMEBODY AGREED. Append-only. A row is evidence of what a
-- person was shown and when they agreed to it, so it is never updated: a
-- second agreement is a second row. What is stored:
--   * the exact wording they saw, by version. The console keeps the canonical
--     text for each version (lib/lead-consent.js); `text_matches` says whether
--     the page sent that same wording, so a forged post cannot write its own.
--   * which channels it covers (call / text / email), the page, the time the
--     page recorded and the time we received it.
--   * the IP address and browser the request came from — the usual proof that
--     the agreement came from that visit. Nothing else about the person.
--
-- NO BROWSER WRITE PATH, same wall as calc_runs (0040): members read, admins
-- delete, every write from the service role in api/hs-lead.js and api/calc.js.

create table if not exists public.admin_lead_consents (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.admin_leads(id) on delete cascade,
  consent_version text not null,
  consent_text text not null,
  text_matches boolean not null default false,
  channels text[] not null default array['call','text','email'],
  source text not null check (source in ('hs-lead','calc')),
  page_path text,
  page_slug text,
  captured_at timestamptz,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists admin_lead_consents_lead_idx on public.admin_lead_consents (lead_id, created_at desc);

grant select on public.admin_lead_consents to authenticated;
alter table public.admin_lead_consents enable row level security;

drop policy if exists "members read lead consents" on public.admin_lead_consents;
create policy "members read lead consents" on public.admin_lead_consents
  for select using (public.admin_is_member());

drop policy if exists "admins delete lead consents" on public.admin_lead_consents;
create policy "admins delete lead consents" on public.admin_lead_consents
  for delete using (public.admin_is_admin());
