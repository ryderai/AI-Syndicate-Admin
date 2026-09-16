-- 0037 — the Electrical landing page + two scan events (16 Sep 2026)
--
-- Ryder asked for a sixth trade so the home-services hub shows two rows of
-- three, and for the free scan to run instantly inside the page. Two things
-- follow for these tables:
--   * page_slug gains 'electrical'
--   * event gains 'scan_failed' (the audit could not read the site or timed
--     out) and 'scan_email' (the visitor typed an email to see the score)
-- Postgres cannot add a value to a check, so both constraints are dropped and
-- re-stated in full, on both tables that carry page_slug.
--
-- ⭐ lib/home-services.js PAGE_SLUGS and HS_EVENTS are the second copy of these
-- lists and MUST change in the same commit. tests/home-services reads the
-- newest migration that states each list and compares.

alter table public.hs_page_events
  drop constraint if exists hs_page_events_page_slug_check;
alter table public.hs_page_events
  add constraint hs_page_events_page_slug_check check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing',
    'restaurants','electrical'
  ));

alter table public.hs_page_events
  drop constraint if exists hs_page_events_event_check;
alter table public.hs_page_events
  add constraint hs_page_events_event_check check (event in (
    'view','scroll_50','scan_start','scan_step2','scan_complete','scan_failed','scan_email',
    'checkout_open','checkout_contact','checkout_paid',
    'call_open','call_booked','exit_shown','exit_captured','cta_click'
  ));

alter table public.hs_lead_sources
  drop constraint if exists hs_lead_sources_page_slug_check;
alter table public.hs_lead_sources
  add constraint hs_lead_sources_page_slug_check check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing',
    'restaurants','electrical'
  ));

-- Append a line to a lead's notes INSIDE the database, in one statement.
-- api/hs-lead.js used to read notes, add a line and write them back; two
-- submits from the same visitor a second apart (contact step, then the card
-- step) could each read the same old notes and the second write erased the
-- first line. Seen on the live console 16 Sep 2026. Service role only.
create or replace function public.hs_append_lead_note(p_lead uuid, p_note text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.admin_leads
     set notes = case when notes is null or btrim(notes) = '' then p_note
                      else notes || E'\n' || p_note end,
         last_activity_at = now()
   where id = p_lead;
$$;
revoke all on function public.hs_append_lead_note(uuid, text) from public, anon, authenticated;
