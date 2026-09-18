-- 0038 — the Home Management landing page, and which plan a lead chose (17 Sep 2026)
--
-- Two changes, both driven by Ryder's 17 Sep asks:
--   * page_slug gains 'home-management' — a ninth page, for companies that look
--     after second homes. Like 'restaurants' it is NOT a home-services trade and
--     is not on the hub; it lives at its own root, /home-management/.
--   * hs_lead_sources gains `plan` — the checkout now offers yearly (2 months
--     free, chosen by default) or monthly, and Sales needs to know which one the
--     person picked before they were called.
-- Postgres cannot add a value to a check, so each constraint is dropped and
-- re-stated in full, on both tables that carry page_slug.
--
-- ⭐ lib/home-services.js PAGE_SLUGS is the second copy of this list and MUST
-- change in the same commit. tests/home-services reads the newest migration that
-- states the list and compares.

alter table public.hs_page_events
  drop constraint if exists hs_page_events_page_slug_check;
alter table public.hs_page_events
  add constraint hs_page_events_page_slug_check check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing',
    'restaurants','electrical','home-management'
  ));

alter table public.hs_lead_sources
  drop constraint if exists hs_lead_sources_page_slug_check;
alter table public.hs_lead_sources
  add constraint hs_lead_sources_page_slug_check check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing',
    'restaurants','electrical','home-management'
  ));

-- Which plan they chose at the checkout. Null means they never got that far.
alter table public.hs_lead_sources
  add column if not exists plan text;
alter table public.hs_lead_sources
  drop constraint if exists hs_lead_sources_plan_check;
alter table public.hs_lead_sources
  add constraint hs_lead_sources_plan_check check (plan is null or plan in ('year','month'));

-- Sales opens the landing-page leads far more often than anything else here.
create index if not exists hs_lead_sources_converted_idx
  on public.hs_lead_sources (converted_at desc nulls last)
  where lead_id is not null;
