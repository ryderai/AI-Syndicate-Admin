-- AI Syndicate ADMIN console — remembering HOW a report was asked to read.
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Run 0001 through 0013 first.
--   * This is the smallest migration in the set: two columns and two comments.
--     It changes no data, drops nothing, and cannot fail on existing rows.
--
-- WHY IT EXISTS
--
-- The Generate report box now asks two questions instead of one:
--
--   1. WHAT TO COVER and how deep      → saved in `instruction` (already there)
--   2. WHO IT IS FOR and WHAT SHAPE    → saved here
--
-- The second one is what decides whether the answer comes back as something
-- you can paste straight into an email or as an internal write-up with our own
-- shorthand in it. Six weeks later, "why does this one read like an email?" has
-- an answer sitting on the row instead of being a mystery.
--
-- THE CONSOLE WORKS WITHOUT THIS MIGRATION. api/client-report.js notices the
-- column missing and saves the report anyway, minus the shape, with a line on
-- screen saying so. A report you cannot generate is a much worse outcome than
-- a report whose shape was not recorded.

alter table public.admin_client_reports
  add column if not exists shape text;

alter table public.admin_client_reports
  add column if not exists shape_preset text;

comment on column public.admin_client_reports.shape is
  'How the person asked it to read — who it is for and what shape to come back in. Their words, saved so an old report can be explained.';
comment on column public.admin_client_reports.shape_preset is
  'Which button filled that box in, if any: internal / forward / email / text / bullets. Free text, deliberately not constrained — the list in lib/client-report.js is expected to grow.';
