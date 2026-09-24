-- 0040 — THE AI REVENUE CALCULATOR. 24 Sep 2026.
--
-- The calculator at www.aisyndicate.com/ai-revenue-calculator/ (and its six
-- trade pages) had nowhere to put what people type into it. Its leads went to
-- the platform's own `leads` table, which this console does not read, and the
-- numbers of everybody who did NOT leave an email were not kept at all.
-- Ryder's ask: "a new leads table for the calculator just so the leads are
-- visible and never hidden … and save the numbers of businesses … so we can
-- see what the average someone would increase if they optimized with AI."
--
-- ONE TABLE, ONE ROW PER CALCULATION.
--   * A row is written the first time somebody uses the calculator on a page
--     visit, and UPDATED (same run_key) as they change numbers. It holds the
--     numbers and the result, and nothing that names a person. The scanned
--     website (scanned_domain) is only filled once they leave an email.
--   * When they fill the email box, the person becomes an ordinary admin_leads
--     row (so they are on the Sales page like every other inbound lead) and
--     this row's lead_id points at them. The Calculator page reads both.
--
-- NO BROWSER WRITE PATH, same wall as the Home Services tables (0035): select
-- for members, delete for admins, no insert/update grant or policy at all.
-- Every write comes from the service role in api/calc.js.

create table if not exists public.calc_runs (
  id uuid primary key default gen_random_uuid(),

  -- The page's own random id for one calculation (one visit's worth of
  -- slider-dragging). Upserted on, so a visitor who changes ten numbers is one
  -- row with the last numbers, not ten rows that would count them ten times.
  run_key text not null unique,
  session_id text,

  -- Which page: the main calculator or one trade page.
  page_path text not null,

  industry text not null check (industry in (
    'other','realestate','law','roofing','hvac','remodel','homeserv','health','finance','b2b'
  )),

  -- WHAT THEY TYPED. Numbers as numbers, so the page can average them.
  leads_per_month numeric check (leads_per_month is null or leads_per_month >= 0),
  close_rate numeric check (close_rate is null or (close_rate >= 0 and close_rate <= 100)),
  client_value numeric check (client_value is null or client_value >= 0),
  ai_share numeric check (ai_share is null or (ai_share >= 0 and ai_share <= 100)),
  ai_score integer check (ai_score is null or (ai_score >= 0 and ai_score <= 100)),
  -- TRUE only when the score came from our scan of their site, not a slider.
  score_measured boolean not null default false,
  scanned_domain text,
  target_score integer check (target_score is null or (target_score >= 0 and target_score <= 100)),
  -- The "more exact" section. Null means "not typed", never zero.
  yearly_revenue numeric check (yearly_revenue is null or yearly_revenue >= 0),
  clients_per_year numeric check (clients_per_year is null or clients_per_year >= 0),
  margin numeric check (margin is null or (margin >= 0 and margin <= 100)),
  repeat_buys numeric check (repeat_buys is null or repeat_buys >= 0),
  ad_spend numeric check (ad_spend is null or ad_spend >= 0),
  -- Did they change anything from the starting guesses? A row still on the
  -- defaults says nothing about a real business, and the averages leave it out.
  edited boolean not null default false,

  -- WHAT THE CALCULATOR SHOWED THEM. Computed on the page by the same
  -- calc-math.js the tests check; stored so the console never re-derives it.
  added_revenue numeric,
  added_revenue_year_one numeric,
  added_profit numeric,
  lifetime_revenue numeric,
  extra_leads_year numeric,
  extra_clients_year numeric,
  capped boolean not null default false,
  warnings integer not null default 0,
  plan_key text,

  -- Set once they leave an email. on delete set null: the calculation really
  -- happened whether or not the lead is later removed.
  lead_id uuid references public.admin_leads on delete set null,

  referrer_host text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  device text check (device is null or device in ('mobile','tablet','desktop')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists calc_runs_created_idx on public.calc_runs (created_at desc);
create index if not exists calc_runs_industry_idx on public.calc_runs (industry, created_at desc);
create index if not exists calc_runs_lead_idx on public.calc_runs (lead_id) where lead_id is not null;

grant select on public.calc_runs to authenticated;
alter table public.calc_runs enable row level security;

drop policy if exists "members read calc runs" on public.calc_runs;
create policy "members read calc runs" on public.calc_runs
  for select using (public.admin_is_member());

drop policy if exists "admins delete calc runs" on public.calc_runs;
create policy "admins delete calc runs" on public.calc_runs
  for delete using (public.admin_is_admin());
