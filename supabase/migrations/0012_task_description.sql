-- ============================================================
-- 0012 — A REAL DESCRIPTION ON EVERY TASK
-- ============================================================
-- Aug 23 2026. Ryder: "in operations i want to have a description for the project
-- that can go more in depth."
--
-- `latest_report` (0001) already exists and is NOT this. That field is the
-- one-line status you read in the table — "12 of 26 pages done." It gets
-- overwritten every time the work moves. A brief does not belong in a field
-- that is rewritten weekly, which is why this is its own column.
--
--   description   = the standing brief. What the work is, why, what "done"
--                   means, links, anything a person needs before starting.
--   latest_report = where it stands right now.
--
-- Safe to run twice. One guarded column add, nothing dropped, no data touched.

alter table public.admin_tasks
  add column if not exists description text;

comment on column public.admin_tasks.description is
  'The standing brief for this piece of work — what it is, why, what done means. Not the status; that is latest_report.';
