-- ============================================================
-- 0049 — LINKEDIN TABLES: the table-level grants 0048 left out.  30 Oct 2026
-- ============================================================
-- This project does not hand new tables to `authenticated` by default (every
-- console table carries its own GRANT — 0001 onward). 0048 created the five
-- linkedin_ tables with row-level security but no GRANT, so the console's
-- LinkedIn page read "permission denied for table linkedin_clients" the
-- moment it went live (found on the live page, 30 Oct 2026, 9:35 AM CT).
-- Row-level security still decides WHO: linkedin_can_work() = owners + admins.
-- The website writes with the service role, which already has every privilege.
-- Safe to run twice.
-- ============================================================

grant select, insert, update, delete on public.linkedin_clients to authenticated;
grant select, insert, update, delete on public.linkedin_daily_activity to authenticated;
grant select, insert, update, delete on public.linkedin_searches to authenticated;
grant select, insert, update, delete on public.linkedin_sequences to authenticated;
grant select, insert, update, delete on public.linkedin_responses to authenticated;
