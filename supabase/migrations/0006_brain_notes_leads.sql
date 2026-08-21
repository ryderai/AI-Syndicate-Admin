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
