-- ============================================================
-- 0035 — THE HOME SERVICES LANDING PAGES.  14 Sep 2026
-- ============================================================
-- Additive only. Two new tables, both hs_-prefixed. Nothing that already
-- exists is altered, and running this file twice does nothing the second
-- time — every statement is guarded.
--
-- WHAT THIS IS FOR
--
-- AI Syndicate is putting up one overarching HOME SERVICES page and one page
-- per trade (lawn care, painting, pool cleaning, mobile detailing, pressure
-- washing). The question Ryder actually wants answered is a comparison: does
-- the trade page beat the general page, and which trade converts? Nothing in
-- this console can answer that today because nothing counts a visit.
--
-- So: one row per tracked thing a visitor does (hs_page_events), and one row
-- per lead those pages produce saying which page produced it
-- (hs_lead_sources).
--
-- ============================================================
-- THE THREE RULES THIS FILE IS BUILT AROUND
-- ============================================================
--
-- 1. A LANDING PAGE IS A STRANGER. It is on another domain, it has no login,
--    and anybody can open the browser console on it. It therefore gets NO
--    database credentials at all. Every write here arrives at
--    /api/hs-event or /api/hs-lead and is written with the service role,
--    server side. That is why neither table below grants insert, update or
--    delete to `authenticated` and neither has an insert policy: there is no
--    browser path in, by construction, and a missing grant is a wall rather
--    than a note asking people to be careful.
--
-- 2. THE GATE IS COPIED, NOT CHOSEN. hs_lead_sources holds facts about a row
--    in admin_leads, so it gets admin_leads' gate — members read, admins
--    delete. Picking a looser gate for a table that holds another table's
--    fields is how a sales rep ends up reading something the parent table
--    would have refused them (0029 did exactly that in its first draft; see
--    CONTEXT §60). hs_page_events is the same reading: a visit that produced
--    a lead is sales data.
--
-- 3. A SESSION ID IS NOT A PERSON. `session_id` is a random string the page
--    makes in memory for one visit. No cookie, no fingerprint, no IP, no
--    user agent string is stored — `device` is a three-value bucket and
--    that is deliberately all. Nothing here identifies a human being until
--    they type their own name into a form, and at that moment they become a
--    row in admin_leads like every other lead.
-- ============================================================


-- ============================================================
-- 1. THE EVENTS — one row per tracked thing a visitor did
-- ============================================================

create table if not exists public.hs_page_events (
  id uuid primary key default gen_random_uuid(),

  -- Which page. The overarching one, or one trade. Free text with a check,
  -- not a foreign key to a pages table: there are six of them, they are
  -- decided in a file, and a lookup table would be a join for nothing.
  page_slug text not null check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing'
  )),

  -- WHAT HAPPENED. This list is the whole vocabulary of the funnel and it is
  -- duplicated, on purpose, in lib/home-services.js — the endpoint validates
  -- against that copy before the database ever sees the row, so a bad name
  -- comes back as a rejection we can read instead of a 500 nobody sees.
  -- tests/home-services compares the two lists and fails if they drift.
  event text not null check (event in (
    'view','scroll_50','scan_start','scan_step2','scan_complete',
    'checkout_open','checkout_contact','checkout_paid',
    'call_open','call_booked','exit_shown','exit_captured','cta_click'
  )),

  -- The random id the page generates for one visit. First-party, in memory,
  -- no cookie. It is how six rows become one funnel.
  session_id text not null,

  -- Filled in once that visitor becomes a lead, so the events BEFORE the form
  -- can be read back against the person. Null for every visit that never
  -- converts, which is most of them.
  lead_id uuid references public.admin_leads on delete set null,

  -- Which button, when event = 'cta_click'. Null otherwise.
  cta text,

  path text,
  referrer text,

  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,

  -- Three buckets, not a user-agent string. A bucket answers "does the trade
  -- page work on a phone"; a user-agent string answers that too and also
  -- follows people around.
  device text check (device is null or device in ('mobile','tablet','desktop')),

  created_at timestamptz not null default now()
);

-- The page's own question: this page, newest first, inside a date range.
create index if not exists hs_page_events_page_ts_idx
  on public.hs_page_events (page_slug, created_at desc);
-- One visit's whole funnel.
create index if not exists hs_page_events_session_idx
  on public.hs_page_events (session_id);
-- "How many scans started in September", across every page.
create index if not exists hs_page_events_event_ts_idx
  on public.hs_page_events (event, created_at desc);
-- Only the rows that converted, which is a small slice of a big table.
create index if not exists hs_page_events_lead_idx
  on public.hs_page_events (lead_id) where lead_id is not null;


-- ============================================================
-- 2. THE LEAD'S ORIGIN — one row per lead these pages produced
-- ============================================================
-- lead_id is the PRIMARY KEY, not just a reference: a lead came from one
-- page, once. Making it the key means the endpoint can upsert without
-- deciding anything, and means a second capture from the same person cannot
-- quietly file them under two pages.
--
-- ON DELETE CASCADE, unlike the events table's SET NULL: an event is a real
-- thing that happened whether or not the lead row survives, and this row is
-- nothing but a fact ABOUT that lead.

create table if not exists public.hs_lead_sources (
  lead_id uuid primary key references public.admin_leads on delete cascade,

  page_slug text not null check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing'
  )),
  session_id text,

  -- The first event we ever saw from that session, so "how long did they read
  -- before they filled the form" is answerable. Null when the form was filled
  -- by somebody whose earlier events we never received.
  first_seen_at timestamptz,
  converted_at timestamptz not null default now(),

  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,

  -- TWO SEPARATE FACTS, and they are not the same one.
  --   reached_checkout — they opened the checkout.
  --   paid             — money actually changed hands.
  -- A single "status" column would force a guess about the person who opened
  -- the checkout and stopped, which is the single most useful row on the page.
  reached_checkout boolean not null default false,
  paid boolean not null default false
);

create index if not exists hs_lead_sources_page_idx
  on public.hs_lead_sources (page_slug, converted_at desc);
create index if not exists hs_lead_sources_session_idx
  on public.hs_lead_sources (session_id) where session_id is not null;
create index if not exists hs_lead_sources_paid_idx
  on public.hs_lead_sources (paid) where paid;


-- ============================================================
-- 3. GRANTS AND RLS
-- ============================================================
-- SELECT only. No insert, no update, no delete, for anybody signed in.
-- Every write on both tables comes from the service role through
-- /api/hs-event and /api/hs-lead, which bypasses RLS entirely.
--
-- A landing page never holds a key of any kind, so there is nothing for
-- `anon` here either — and `anon` is deliberately not mentioned below, so it
-- keeps whatever the database's default is (nothing).

grant select on public.hs_page_events to authenticated;
grant select on public.hs_lead_sources to authenticated;

alter table public.hs_page_events enable row level security;
alter table public.hs_lead_sources enable row level security;

-- Members read, matching admin_leads. Admins delete, matching admin_leads.
-- There is no insert or update policy on either table on purpose.
drop policy if exists "members read hs events" on public.hs_page_events;
create policy "members read hs events" on public.hs_page_events
  for select using (public.admin_is_member());

drop policy if exists "admins delete hs events" on public.hs_page_events;
create policy "admins delete hs events" on public.hs_page_events
  for delete using (public.admin_is_admin());

drop policy if exists "members read hs lead sources" on public.hs_lead_sources;
create policy "members read hs lead sources" on public.hs_lead_sources
  for select using (public.admin_is_member());

drop policy if exists "admins delete hs lead sources" on public.hs_lead_sources;
create policy "admins delete hs lead sources" on public.hs_lead_sources
  for delete using (public.admin_is_admin());


-- ============================================================
-- 4. WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ============================================================
--
-- It does not touch admin_leads. Everything the capture endpoint writes onto
-- a lead — source 'inbound', vertical = the page slug, stage 'new' — is
-- already legal on the columns and check constraints that exist:
--
--   source  in ('platform','csv','sheet','scraper','manual','referral','inbound','import')   -- 0009
--   stage   in ('new','researching','contacted','in_conversation','follow_up',
--               'meeting_booked','meeting_complete','proposal','won','lost',
--               'reopened','not_a_fit')                                                       -- 0030
--
-- It does not add a `zip` or a `website` column to admin_leads. The landing
-- form collects both; admin_leads has `domain` (the website's host, which is
-- what the console already reads everywhere) and no postcode column at all.
-- Rather than invent two columns on a 3,600-row table for a page that has
-- never been deployed, /api/hs-lead puts the website in `domain` and writes
-- the postcode into the lead's `notes` line where a person can read it. If
-- postcodes turn out to matter, a later migration adds a real column and the
-- endpoint moves one line.
--
-- It does not write to admin_lead_activity. That table's `actor` is
-- `uuid not null references auth.users` (0001:203) and its insert policy is
-- `actor = auth.uid()` (0001:415). A service-role write has no auth.uid() and
-- a visitor on a landing page is not a user of this console, so there is no
-- honest value to put in it. Making one up — the owner's id, a shared
-- "system" account — would file a stranger's form fill under a person who was
-- asleep. Left out on purpose. See CONTEXT §61.
