-- ============================================================
-- 0019 — WHY A DEAL CLOSED, AND WHAT A SCAN FOUND ON A FIRM
-- ============================================================
-- Aug 27 2026, Ryder. Two things, in one file because they are the same idea
-- twice: a number or an outcome is worth almost nothing without the reason
-- behind it, and today neither reason is stored anywhere.
--
-- PART 1 — WON AND LOST NEED A REASON.
-- `lost_reason` already exists (0009:217) and exactly ONE button writes it,
-- hard-coded to "No reply after the full cadence." Won records no reason at all.
-- So the single most useful sales question there is — "why are we losing?" —
-- has no answer in this database. Three columns fix that: a counted reason for
-- Won, and a free-text "what actually happened" for each.
--
-- WHY A DROPDOWN *AND* FREE TEXT, rather than one or the other. A dropdown can
-- be counted and a paragraph cannot; a paragraph carries the thing that is
-- actually useful and a dropdown never does. Both, or six months from now we
-- have eleven rows saying "no reply" and nothing that says what the emails
-- looked like.
--
-- PART 2 — WHAT A SCAN FOUND, KEYED ON THE FIRM.
-- `admin_companies.site_score` can hold exactly ONE number. Ryder wants three
-- — AI Access, SEO, and how often the firm gets named when a buyer asks an AI a
-- question — plus the findings behind them. That does not fit in a column, and
-- overwriting last month's score to store this month's throws away the most
-- useful sales line there is: "you were 65 in September and you are still 65."
--
-- So: a report table, one row per scan, never updated.
--
-- WHY NOT admin_client_reports (0008). Two reasons, both real:
--   1. It is keyed on `client_id NOT NULL`, and a prospect is not a client.
--      Relaxing that to nullable would break its cascade and its
--      one-report-one-client invariant.
--   2. Its RLS is admin-only. A REP HAS TO READ THIS — the whole point is that
--      a rep opens a lead and reads what we measured on their website. Widening
--      0008's policies to let a rep in would hand them every client report in
--      the company. That is trap #6 in §8 wearing a different hat.
--
-- Safe to run twice. Additive, admin_-prefixed, every statement guarded.

-- ============================================================
-- 1. WON AND LOST, WITH REASONS
-- ============================================================
-- Counted reasons, as free text columns rather than enums. Deliberate: 0006
-- taught this repo that `create table if not exists` leaves an older CHECK in
-- place for ever, so a constraint that has to widen the first time CJ says
-- "add 'went quiet after the proposal'" is a button that fails silently for a
-- day. The list of allowed reasons lives in ONE place in the code
-- (lib/sales-rules.js) where a test can read it, and the database stores what
-- it is given.
alter table public.admin_leads add column if not exists won_reason text;
alter table public.admin_leads add column if not exists won_reason_note text;
alter table public.admin_leads add column if not exists lost_reason_note text;

-- Counting losses by reason is the one query this exists for.
create index if not exists admin_leads_lost_reason_idx
  on public.admin_leads (lost_reason) where lost_reason is not null;
create index if not exists admin_leads_won_reason_idx
  on public.admin_leads (won_reason) where won_reason is not null;

-- ============================================================
-- 2. ONE ROW PER SCAN, ON THE FIRM
-- ============================================================

create table if not exists public.admin_company_reports (
  id uuid primary key default gen_random_uuid(),

  -- The FIRM, not the person. Four contacts at one dealership share one
  -- website, so they share one scan — scoring per person would mean four scans,
  -- four bills and four numbers that drift apart.
  company_id uuid not null references public.admin_companies on delete cascade,

  -- WHO RAN IT, as the lead they were looking at when they pressed the button.
  -- `on delete set null`, because deleting a contact must not delete the
  -- measurement of their firm's website. Nullable for a scan run from the Firms
  -- view, where there is no one contact.
  lead_id uuid references public.admin_leads on delete set null,

  -- 'baseline' is the first scan of a firm; a re-scan is 'rescan'. Free text for
  -- the same reason as the reasons above — a CHECK that has to widen is a button
  -- that breaks silently.
  kind text not null default 'baseline',

  -- THE THREE SCORES. Every one of them is nullable and every one of them is
  -- 0-100 or nothing. NULL means "the scan did not return this", which is not
  -- the same as zero and must never print as zero: a firm shown as 0 for AI
  -- Access is the widest possible gap and therefore the hardest a rep goes in.
  -- That is the single most dangerous wrong number this table could hold.
  ai_access_score int check (ai_access_score is null or (ai_access_score between 0 and 100)),
  seo_score       int check (seo_score is null or (seo_score between 0 and 100)),

  -- "Named in 2 of 10 buyer questions." TWO columns, not a percentage: 2/10 and
  -- 20% are the same number and only one of them says how big the sample was,
  -- and 1 of 2 printed as 50% is a claim nobody measured. Both nullable
  -- together — a hits count with no total is not a measurement.
  prompt_sim_hits  int check (prompt_sim_hits is null or prompt_sim_hits >= 0),
  prompt_sim_total int check (prompt_sim_total is null or prompt_sim_total > 0),

  -- [{title, detail, severity}] — the things that are actually wrong, in words a
  -- rep can read out loud. This is what the pitch is written from.
  findings jsonb,

  -- Exactly what the platform sent back, untouched. Kept because the field names
  -- readScore() looks for are a guess at a contract nobody has written down: the
  -- day the real shape is known, this column is what says whether the scans we
  -- already ran can be re-read or have to be re-run.
  raw jsonb,

  -- The AI-written pitch. It goes through the same honesty gate as everything
  -- else and may name only the scores and findings above. Nullable, because a
  -- scan with no AI key set still saves its numbers.
  pitch text,
  -- Why there is no pitch, when there is none. "No ANTHROPIC_API_KEY" and "the
  -- draft was thrown away for promising a result" are different sentences.
  pitch_gate_reason text,

  -- THE FOUR HALVES OF A MEASUREMENT (§42 PART 2 rule 2): the number, the thing
  -- it was measured against (the domain), the day it was read, and who read it.
  -- Anything short of all four is not a measurement and must not be printed as
  -- one. `domain` is stored on the row rather than read off the firm later,
  -- because a firm's website can be corrected afterwards and then the old
  -- measurement would silently re-attach itself to a different site.
  domain text,
  measured_at timestamptz not null,
  measured_by uuid not null references auth.users on delete restrict,

  created_at timestamptz not null default now()
);

-- The one way this is read: the newest scan of one firm.
create index if not exists admin_company_reports_company_idx
  on public.admin_company_reports (company_id, measured_at desc);

-- ============================================================
-- 3. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Every member reads, every member inserts. There is NO UPDATE POLICY and no
-- update grant: a measurement that can be edited after a rep has quoted it is
-- not a measurement. That is the same rule already enforced on
-- admin_connection_snapshots in 0013 (§39), and it is why a re-scan INSERTS a
-- new row instead of overwriting the old one.
--
-- Delete is admin-only, and it is worth being uneasy about: an old report may be
-- the thing a saved pitch was written from. It is allowed only because a scan
-- against the wrong domain is noise a rep would otherwise quote.

grant select, insert on public.admin_company_reports to authenticated;
grant delete on public.admin_company_reports to authenticated;

alter table public.admin_company_reports enable row level security;

drop policy if exists "members read company reports" on public.admin_company_reports;
create policy "members read company reports" on public.admin_company_reports
  for select using (public.admin_is_member());

-- `measured_by = auth.uid()` in the WITH CHECK is what stops a rep filing a
-- measurement under somebody else's name. The service key writes these in
-- practice (api/sales-score.js) and bypasses RLS entirely — this policy is for
-- the browser, and it exists so that the rule is written where it cannot be
-- skipped by a future page that writes directly.
drop policy if exists "members add company reports" on public.admin_company_reports;
create policy "members add company reports" on public.admin_company_reports
  for insert with check (
    public.admin_is_member() and measured_by = auth.uid()
  );

drop policy if exists "admins remove company reports" on public.admin_company_reports;
create policy "admins remove company reports" on public.admin_company_reports
  for delete using (public.admin_is_admin());

-- NO UPDATE POLICY, on purpose. See the note above.

-- ============================================================
-- 4. AFTER RUNNING THIS
-- ============================================================
--   1. Nothing on screen changes until PLATFORM_SCORE_URL exists — the scan
--      button still returns 503 naming the variable, and no score is invented.
--      This file is what the scan will have somewhere to write TO.
--   2. The Won/Lost reason box works the moment this file has run. Before it
--      runs, saving a Won reason fails and the screen says so rather than
--      quietly dropping it.
--   3. Verify with:
--        select column_name from information_schema.columns
--          where table_name = 'admin_leads' and column_name like '%reason%';
--        select count(*) from public.admin_company_reports;   -- 0 on a fresh run
