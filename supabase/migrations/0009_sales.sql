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
