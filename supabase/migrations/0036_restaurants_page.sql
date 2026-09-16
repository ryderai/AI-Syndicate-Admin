-- 0036 — the Restaurants landing page (16 Sep 2026)
--
-- CJ asked for a landing page for restaurants next to the home-services ones
-- (text to Ryder, 15 Sep 2026). Same funnel, same tables, one more legal
-- page_slug. Both check constraints are re-stated in full because Postgres
-- cannot add a value to an existing check — it has to be dropped and made again.
--
-- ⭐ lib/home-services.js PAGE_SLUGS is the second copy of this list and MUST
-- change in the same commit. tests/home-services reads the newest page_slug
-- list out of the migrations and compares.

alter table public.hs_page_events
  drop constraint if exists hs_page_events_page_slug_check;
alter table public.hs_page_events
  add constraint hs_page_events_page_slug_check check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing',
    'restaurants'
  ));

alter table public.hs_lead_sources
  drop constraint if exists hs_lead_sources_page_slug_check;
alter table public.hs_lead_sources
  add constraint hs_lead_sources_page_slug_check check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing',
    'restaurants'
  ));
