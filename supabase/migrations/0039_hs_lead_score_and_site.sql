-- 0039 — the free scan's score, kept as a number (18 Sep 2026)
--
-- Ryder's ask: a Leads page under Home Services, and the same hot leads on the
-- reps' page so somebody can ring the people who scanned, saw a bad score, left
-- an email and never bought.
--
-- That list has to be ORDERED by how bad the score was, and until now the score
-- existed only inside the lead's `notes` as the English sentence
-- "free GEO Score on the page: 38/100". Sorting a sales queue by a regular
-- expression over a free-text field is the kind of thing that works until
-- somebody edits a note. So the number gets a column.
--
-- Nothing is backfilled. Rows written before this migration have no score, and
-- the screens print "not measured" for them rather than a zero — a site that
-- was never scanned did not score nought.

alter table public.hs_lead_sources
  add column if not exists geo_score int;
alter table public.hs_lead_sources
  drop constraint if exists hs_lead_sources_geo_score_check;
alter table public.hs_lead_sources
  add constraint hs_lead_sources_geo_score_check
  check (geo_score is null or (geo_score >= 0 and geo_score <= 100));

-- The address the visitor actually typed into the scan box. `admin_leads.domain`
-- holds the same thing today, but that column is editable by a rep and this one
-- is the record of WHAT WAS MEASURED. When they differ, the report is wrong
-- about a different website, and we want to be able to see that.
alter table public.hs_lead_sources
  add column if not exists scanned_domain text;

-- When the score was taken, so "scored 38 in July" is never quoted as today.
alter table public.hs_lead_sources
  add column if not exists scored_at timestamptz;

-- The hot list is "no purchase, worst score first". This is the index for it.
create index if not exists hs_lead_sources_hot_idx
  on public.hs_lead_sources (geo_score asc nulls last, converted_at desc)
  where not paid;
