-- 0047 — the all-owners landing page, /free-ai-score/ (7 Oct 2026)
--
-- Ryder, 7 Oct 2026: one phone-first landing page for ANY local business owner, for
-- the Meta ads (Meta cannot target lawn care owners — measured 7 Oct: the job title
-- "Lawn Care Specialist" reaches 3,400–4,100 US people). It lives at its own root,
-- /free-ai-score/, like /restaurants/ and /home-management/, and sends page_slug
-- 'free-ai-score'. Every table that checks page_slug refuses it until this runs, so
-- RUN THIS BEFORE THE PAGE GOES LIVE or its views, scans and leads are refused.
--
-- Postgres cannot add a value to a check, so each constraint is dropped and
-- re-stated in full. The heat-map tables (0046) declared theirs inline, so their
-- names were picked by Postgres; the DO block finds every page_slug check on the
-- four tables by what it says, not by a guessed name.
--
-- ⭐ lib/home-services.js PAGE_SLUGS is the second copy of this list and changes in
-- the same commit. tests/home-services and tests/heat-map read this file and compare.

do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
      from pg_constraint c
     where c.contype = 'c'
       and c.conrelid in ('public.hs_page_events'::regclass, 'public.hs_lead_sources'::regclass,
                          'public.hs_heat_sessions'::regclass, 'public.hs_heat_clicks'::regclass)
       and pg_get_constraintdef(c.oid) ilike '%page_slug%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

alter table public.hs_page_events
  add constraint hs_page_events_page_slug_check check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing',
    'restaurants','electrical','home-management','free-ai-score'
  ));

alter table public.hs_lead_sources
  add constraint hs_lead_sources_page_slug_check check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing',
    'restaurants','electrical','home-management','free-ai-score'
  ));

alter table public.hs_heat_sessions
  add constraint hs_heat_sessions_page_slug_check check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing',
    'restaurants','electrical','home-management','free-ai-score'
  ));

alter table public.hs_heat_clicks
  add constraint hs_heat_clicks_page_slug_check check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing',
    'restaurants','electrical','home-management','free-ai-score'
  ));

-- Read-back: four rows, each naming free-ai-score.
select conrelid::regclass as table_name, conname
  from pg_constraint
 where contype = 'c' and pg_get_constraintdef(oid) ilike '%free-ai-score%'
 order by 1;
