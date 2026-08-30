-- ============================================================
-- 0025 — EVERYTHING THE SHEET HOLDS.  Aug 30 2026
-- ============================================================
-- Ryder, 30 Aug 2026: "use the exact same rows … fill in everything we have a
-- row for and leave out the rest."
--
-- Five columns the outreach sheet has and the console had nowhere to put. Each
-- was being read off the spreadsheet and then dropped on the floor:
--
--   admin_leads.address        the contact's own "Walnut Creek, California,
--                              United States" line. NOT the firm's address —
--                              they are different places on most rows, and the
--                              firm's already has a column.
--   admin_leads.country        the contact's country.
--   admin_companies.alias      Apollo's "Company Name for Emails" — the tidied
--                              name CJ's mail merge uses. Losing it means the
--                              console cannot reproduce an email he sent.
--   admin_companies.keywords   the long comma list of what the firm does and
--                              what its website runs on. Not shown on a lead
--                              row (it is a paragraph), but it is the raw
--                              material for scoring and for a first email, and
--                              Ryder's standing rule is to keep every piece of
--                              data we ever touch.
--   admin_companies.total_funding  as the export gives it: whole dollars.
--
-- ADDITIVE ONLY. Every statement is `add column if not exists`. Nothing is
-- dropped, nothing is renamed, no constraint changes, no data is rewritten.
-- Running it twice does nothing the second time. Every page that reads these
-- two tables today keeps working unchanged, because nothing it reads moved.
--
-- WHY total_funding IS bigint AND NOT numeric: same call as annual_revenue
-- right above it in 0009 — this codebase's money pages run on whole integers
-- (lib/finance-math.js), and a decimal type here would be the only one.
--
-- NULL MEANS "the sheet did not say". It never means zero. A firm with
-- total_funding = 0 has raised nothing and told us so; a firm with NULL has
-- not been asked. The import writes NULL, never 0, when a cell is empty.

alter table public.admin_leads add column if not exists address text;
alter table public.admin_leads add column if not exists country text;

alter table public.admin_companies add column if not exists alias text;
alter table public.admin_companies add column if not exists keywords text;
alter table public.admin_companies add column if not exists total_funding bigint;

comment on column public.admin_leads.address is
  'The CONTACT''s own location line from the export ("Walnut Creek, California, United States"). Not the firm''s street address — that is admin_companies.address.';
comment on column public.admin_companies.alias is
  'Apollo''s "Company Name for Emails": the tidied firm name used in mail merges. Kept so a sent email can be reproduced.';
comment on column public.admin_companies.keywords is
  'The export''s Keywords / Technologies list, verbatim. A paragraph, not a label — never render it on a row.';
comment on column public.admin_companies.total_funding is
  'Whole dollars, as the export gives it. NULL means the sheet did not say; 0 means it said zero.';
