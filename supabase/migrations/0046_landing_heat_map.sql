-- ============================================================
-- 0046 — THE LANDING-PAGE HEAT MAP.  30 Sep 2026
-- ============================================================
-- Additive only. Two new tables and two functions, all hs_heat_-prefixed.
-- Nothing that already exists is altered. Running this file twice does nothing
-- the second time — every statement is guarded.
--
-- WHY. CJ, 30 Sep 2026: "Can we install some sort of heat map tracker on that
-- landing page? I want to see where clicks and all that go … where people drop
-- off, if we need to move stuff up or down and what we can delete."
-- hs_page_events (0035) already counts the funnel steps. It cannot say which
-- part of the page people read, skipped or tapped. These two tables can.
--
-- THE SAME THREE RULES AS 0035, restated because they matter just as much:
--
-- 1. THE PAGE GETS NO KEY. Every row arrives through /api/hs-heat, which calls
--    hs_heat_ingest() with the service role. authenticated gets SELECT only;
--    anon gets nothing; there is no insert policy, so there is no browser path
--    in, by construction.
--
-- 2. THE GATE IS COPIED. Members read, admins delete — hs_page_events' gate,
--    because a click on a page that produced a lead is sales data too.
--
-- 3. NOTHING HERE NAMES A PERSON BY ITSELF. view_id is a random string made
--    fresh on every page load, session_id is 0035's per-tab visit id. No
--    cookie, no IP, no user agent, and never anything a visitor typed: a click
--    on a form field is stored as "field:email", never as what was in it.
--    lib/heat-map.js replaces anything shaped like an email or a phone number
--    in a click label as a second guard.
--    BUT session_id is the same id hs_lead_sources keeps beside a lead. Once a
--    visitor fills in a form, their clicks CAN be matched to their lead. That
--    join is the "People who became leads" filter. Do not call this anonymous.
-- ============================================================


-- ============================================================
-- 1. ONE ROW PER PAGE LOAD
-- ============================================================
-- The page keeps running totals and re-sends them every ~15 seconds and when
-- the tab is hidden. `seq` counts those sends; a send is only applied when its
-- seq is higher than the one already stored, so a slow early send arriving
-- after a later one cannot wind the totals backwards.

create table if not exists public.hs_heat_sessions (
  view_id text primary key check (char_length(view_id) between 6 and 40),
  session_id text not null,

  page_slug text not null check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing',
    'restaurants','electrical','home-management'
  )),

  seq integer not null default 0,
  path text,
  device text check (device is null or device in ('mobile','tablet','desktop')),

  viewport_w integer,
  viewport_h integer,
  doc_h integer,

  -- How far down the page they got, 0–100, the bottom of the screen measured
  -- against the page's full height.
  max_scroll_pct smallint not null default 0 check (max_scroll_pct between 0 and 100),

  -- Time the tab was visible AND somebody was doing something in it in the
  -- last 30 seconds. A tab left open over lunch is not an hour of reading.
  active_ms integer not null default 0 check (active_ms >= 0),

  -- One entry per section of the page: { "offer": {"r":1,"ms":8200}, … }
  --   r   1 when they got to it (it came properly onto the screen)
  --   ms  how long it was on screen while they were active
  zones jsonb not null default '{}'::jsonb,

  click_count integer not null default 0,

  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,

  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hs_heat_sessions_page_ts_idx
  on public.hs_heat_sessions (page_slug, first_seen_at desc);
create index if not exists hs_heat_sessions_session_idx
  on public.hs_heat_sessions (session_id);


-- ============================================================
-- 2. ONE ROW PER CLICK
-- ============================================================
-- x_pm / y_pm are the click's place INSIDE its section, in thousandths of that
-- section's width and height. That is what lets a phone click and a laptop
-- click land on the same picture: a section is a different size on each, but
-- "two-thirds across the price card" is the same place on both.

create table if not exists public.hs_heat_clicks (
  id bigint generated always as identity primary key,
  view_id text not null references public.hs_heat_sessions (view_id) on delete cascade,
  -- The click's own number inside its page load (1, 2, 3 …). The page resends
  -- a click until a send carrying it is confirmed; (view_id, cid) is unique,
  -- so a click sent three times is stored once.
  cid integer not null check (cid between 1 and 100000),
  session_id text not null,
  page_slug text not null check (page_slug in (
    'home-services','lawn-care','painting','pool-cleaning','mobile-detailing','pressure-washing',
    'restaurants','electrical','home-management'
  )),
  device text check (device is null or device in ('mobile','tablet','desktop')),

  zone text not null check (char_length(zone) between 1 and 40),
  x_pm smallint not null check (x_pm between 0 and 1000),
  y_pm smallint not null check (y_pm between 0 and 1000),

  -- The page's own words for what was clicked: a data-cta name, a button's
  -- label, "field:email". Null for a click on nothing.
  target text,
  kind text not null default 'other' check (kind in ('link','button','field','text','image','other')),

  -- dead: the click landed on something that is not a link, button or field.
  -- rage: the third (or later) click in under 0.7 s in the same small spot.
  dead boolean not null default false,
  rage boolean not null default false,

  -- Milliseconds after the page loaded.
  t_ms integer,

  created_at timestamptz not null default now()
);

create unique index if not exists hs_heat_clicks_view_cid_idx
  on public.hs_heat_clicks (view_id, cid);
create index if not exists hs_heat_clicks_page_ts_idx
  on public.hs_heat_clicks (page_slug, created_at desc);


-- ============================================================
-- 3. THE GATE
-- ============================================================

grant select on public.hs_heat_sessions to authenticated;
grant select on public.hs_heat_clicks to authenticated;

alter table public.hs_heat_sessions enable row level security;
alter table public.hs_heat_clicks enable row level security;

drop policy if exists "members read hs heat sessions" on public.hs_heat_sessions;
create policy "members read hs heat sessions" on public.hs_heat_sessions
  for select using (public.admin_is_member());
drop policy if exists "admins delete hs heat sessions" on public.hs_heat_sessions;
create policy "admins delete hs heat sessions" on public.hs_heat_sessions
  for delete using (public.admin_is_admin());

drop policy if exists "members read hs heat clicks" on public.hs_heat_clicks;
create policy "members read hs heat clicks" on public.hs_heat_clicks
  for select using (public.admin_is_member());
drop policy if exists "admins delete hs heat clicks" on public.hs_heat_clicks;
create policy "admins delete hs heat clicks" on public.hs_heat_clicks
  for delete using (public.admin_is_admin());


-- ============================================================
-- 4. THE WRITE — called by /api/hs-heat, service role only
-- ============================================================
-- One call per send. Two separate jobs:
--
--   1. The running totals. Applied only when this send's seq is higher than
--      the one stored, so a slow early send landing after a later one cannot
--      wind the totals backwards.
--   2. The clicks. Stored WHATEVER the seq — a late send still carries real
--      clicks — and each (view_id, cid) at most once, so a resend adds
--      nothing. The page keeps resending a click until a send carrying it
--      comes back 204.
--
-- A view_id belongs to one session and one page for ever: a send naming the
-- same view_id with another session or page changes nothing and stores no
-- clicks.
--
-- The first send sets first_seen_at to now() minus the page's own stopwatch
-- (age_ms), so the visit is filed under when it started, not when it first
-- managed to report.
--
-- The body has already been cleaned by lib/heat-map.js (cleanHeatPost). The
-- casts here are a second line, not the first.

create or replace function public.hs_heat_ingest(p jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_applied integer;
  v_new integer;
  v_clicks jsonb := coalesce(p->'clicks', '[]'::jsonb);
begin
  insert into public.hs_heat_sessions as s (
    view_id, session_id, page_slug, seq, path, device,
    viewport_w, viewport_h, doc_h, max_scroll_pct, active_ms, zones, click_count,
    utm_source, utm_medium, utm_campaign, utm_content, first_seen_at
  ) values (
    p->>'view_id', p->>'session_id', p->>'page_slug', (p->>'seq')::integer, p->>'path', p->>'device',
    nullif(p->>'viewport_w','')::integer, nullif(p->>'viewport_h','')::integer, nullif(p->>'doc_h','')::integer,
    coalesce((p->>'max_scroll_pct')::smallint, 0), coalesce((p->>'active_ms')::integer, 0),
    coalesce(p->'zones', '{}'::jsonb), 0,
    p->>'utm_source', p->>'utm_medium', p->>'utm_campaign', p->>'utm_content',
    now() - make_interval(secs => least(86400000, greatest(0, coalesce((p->>'age_ms')::bigint, 0))) / 1000.0)
  )
  on conflict (view_id) do update set
    seq = excluded.seq,
    viewport_w = excluded.viewport_w,
    viewport_h = excluded.viewport_h,
    doc_h = excluded.doc_h,
    -- Running totals only ever grow. greatest() is belt and braces: the seq
    -- check already stops an older send landing on a newer one.
    max_scroll_pct = greatest(s.max_scroll_pct, excluded.max_scroll_pct),
    active_ms = greatest(s.active_ms, excluded.active_ms),
    zones = excluded.zones,
    updated_at = now()
  where excluded.seq > s.seq
    and s.session_id = excluded.session_id
    and s.page_slug = excluded.page_slug;
  get diagnostics v_applied = row_count;

  -- Clicks only for a page load that is really this session's on this page.
  perform 1 from public.hs_heat_sessions
   where view_id = p->>'view_id' and session_id = p->>'session_id' and page_slug = p->>'page_slug';
  if not found then
    return false;
  end if;

  insert into public.hs_heat_clicks (
    view_id, cid, session_id, page_slug, device, zone, x_pm, y_pm, target, kind, dead, rage, t_ms
  )
  select
    p->>'view_id', (c->>'cid')::integer, p->>'session_id', p->>'page_slug', p->>'device',
    c->>'zone', (c->>'x_pm')::smallint, (c->>'y_pm')::smallint,
    c->>'target', coalesce(c->>'kind', 'other'),
    coalesce((c->>'dead')::boolean, false), coalesce((c->>'rage')::boolean, false),
    nullif(c->>'t_ms','')::integer
  from jsonb_array_elements(v_clicks) as c
  on conflict (view_id, cid) do nothing;
  get diagnostics v_new = row_count;

  if v_new > 0 then
    update public.hs_heat_sessions set click_count = click_count + v_new where view_id = p->>'view_id';
  end if;

  return v_applied > 0 or v_new > 0;
end;
$$;

revoke all on function public.hs_heat_ingest(jsonb) from public;
revoke all on function public.hs_heat_ingest(jsonb) from anon, authenticated;
grant execute on function public.hs_heat_ingest(jsonb) to service_role;


-- ============================================================
-- 5. THE READ — one jsonb value, so no 1,000-row reply cap
-- ============================================================
-- SECURITY INVOKER: it reads through the policies above, so a signed-in
-- member sees the numbers and anybody else gets empty counts. The JS twin of
-- this function is rollupFromRows() in lib/heat-map.js; tests/heat-map/sql.sh
-- runs both on the same rows and fails if they disagree.
--
-- p_who: 'all' | 'leads' (visits whose session became a lead on this page)
--        | 'not' (the rest).
-- The date range filters on when the page load STARTED. A click belongs to its
-- page load, so a visit that crosses midnight is counted whole, once.

create or replace function public.hs_heat_rollup(
  p_slug text,
  p_from timestamptz,
  p_to timestamptz,
  p_device text default null,
  p_source text default null,
  p_content text default null,
  p_who text default 'all'
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with leads as (
    select distinct session_id
    from public.hs_lead_sources
    where page_slug = p_slug and session_id is not null
  ),
  dated as (
    select s.*, exists (select 1 from leads l where l.session_id = s.session_id) as is_lead
    from public.hs_heat_sessions s
    where s.page_slug = p_slug
      and (p_from is null or s.first_seen_at >= p_from)
      and (p_to is null or s.first_seen_at < p_to)
  ),
  v as (
    select * from dated
    where (p_device is null or device = p_device)
      and (p_source is null or coalesce(utm_source, '') = p_source)
      and (p_content is null or coalesce(utm_content, '') = p_content)
      and (coalesce(p_who, 'all') = 'all'
           or (p_who = 'leads' and is_lead)
           or (p_who = 'not' and not is_lead))
  ),
  c as (
    select k.view_id, k.zone, k.x_pm, k.y_pm, k.target, k.kind, k.dead, k.rage, v.is_lead
    from public.hs_heat_clicks k
    join v on v.view_id = k.view_id
  ),
  z as (
    select e.key as zone,
           count(*) filter (where (e.value->>'r')::integer = 1) as reached,
           coalesce(sum((e.value->>'ms')::bigint), 0) as ms_total
    from v, jsonb_each(v.zones) as e
    group by e.key
  ),
  zc as (
    select zone,
           count(*) as n,
           count(*) filter (where dead) as dead,
           count(distinct view_id) filter (where dead) as dead_views,
           count(*) filter (where is_lead) as by_leads
    from c
    group by 1
  ),
  g as (
    select zone,
           least(39, floor(x_pm / 25.0))::integer as xb,
           least(39, floor(y_pm / 25.0))::integer as yb,
           count(*) as n,
           count(*) filter (where dead) as dead
    from c
    group by 1, 2, 3
  ),
  t as (
    select zone, target, kind,
           count(*) as n,
           count(*) filter (where dead) as dead,
           count(*) filter (where rage) as rage,
           count(*) filter (where is_lead) as by_leads
    from c
    group by 1, 2, 3
    order by count(*) desc, zone collate "C", target collate "C" nulls first, kind collate "C"
    limit 200
  )
  select jsonb_build_object(
    'views', (select count(*) from v),
    'sessions', (select count(distinct session_id) from v),
    'lead_views', (select count(*) from v where is_lead),
    'median_active_ms', (select percentile_cont(0.5) within group (order by active_ms) from v),
    'scroll', (select jsonb_agg(q.n order by q.p)
               from (select p, (select count(*) from v where max_scroll_pct >= p) as n
                     from generate_series(10, 100, 10) as p) q),
    'zones', coalesce((select jsonb_agg(jsonb_build_object('zone', zone, 'reached', reached, 'ms_total', ms_total)
                                        order by zone collate "C") from z), '[]'::jsonb),
    'clicks', jsonb_build_object(
      'total', (select count(*) from c),
      'dead', (select count(*) from c where dead),
      'rage', (select count(*) from c where rage)),
    'zclicks', coalesce((select jsonb_agg(jsonb_build_object('zone', zone, 'n', n, 'dead', dead, 'dead_views', dead_views, 'by_leads', by_leads)
                                          order by zone collate "C") from zc), '[]'::jsonb),
    'grid', coalesce((select jsonb_agg(jsonb_build_object('zone', zone, 'xb', xb, 'yb', yb, 'n', n, 'dead', dead)
                                       order by zone collate "C", xb, yb) from g), '[]'::jsonb),
    'targets', coalesce((select jsonb_agg(jsonb_build_object('zone', zone, 'target', target, 'kind', kind,
                                                             'n', n, 'dead', dead, 'rage', rage, 'by_leads', by_leads)
                                          order by n desc, zone collate "C", target collate "C" nulls first, kind collate "C")
                         from t), '[]'::jsonb),
    'options', jsonb_build_object(
      'devices', coalesce((select jsonb_agg(jsonb_build_object('value', val, 'n', n) order by n desc, val collate "C")
                           from (select device as val, count(*) as n from dated where coalesce(device, '') <> '' group by 1) q), '[]'::jsonb),
      'sources', coalesce((select jsonb_agg(jsonb_build_object('value', val, 'n', n) order by n desc, val collate "C")
                           from (select utm_source as val, count(*) as n from dated where coalesce(utm_source, '') <> '' group by 1) q), '[]'::jsonb),
      'contents', coalesce((select jsonb_agg(jsonb_build_object('value', val, 'n', n) order by n desc, val collate "C")
                            from (select utm_content as val, count(*) as n from dated where coalesce(utm_content, '') <> '' group by 1) q), '[]'::jsonb)),
    'first_at', (select min(first_seen_at) from v),
    'last_at', (select max(first_seen_at) from v)
  );
$$;

revoke all on function public.hs_heat_rollup(text, timestamptz, timestamptz, text, text, text, text) from public, anon;
grant execute on function public.hs_heat_rollup(text, timestamptz, timestamptz, text, text, text, text) to authenticated;
