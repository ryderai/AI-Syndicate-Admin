-- ============================================================
-- 0018 — TAGS ON A LEAD, AND A DATED LINE FOR EVERY CHANGE
-- ============================================================
-- Aug 27 2026, Ryder. The Floor shows every lead in the company at once, so a
-- rep needs to be able to say "show me the medspas in Florida with no website
-- that nobody has touched" without reading 451 rows. That is what a tag is for.
--
-- THERE IS NO TAG ANYWHERE IN THE SYSTEM TODAY. No column, no table, nothing.
-- This is from scratch.
--
-- TWO TABLES, AND THE SECOND ONE IS THE POINT.
--   admin_lead_tags        — the vocabulary. What tags exist, what they look
--                            like, and (for the automatic ones) the rule name
--                            that produces them.
--   admin_lead_tag_events  — every add and every remove, with the day, the
--                            person and the reason. APPEND ONLY.
--
-- A LEAD'S TAGS RIGHT NOW = REPLAY ITS EVENTS. There is deliberately no `tags`
-- column on admin_leads and no `current` flag on an event. Two reasons, and the
-- second is the one that matters:
--
--   1. A current-state column and an event log are two copies of one fact, and
--      the day they disagree there is no way to tell which one is right. This
--      repo has already paid for that lesson twice — see §42 PART 2 on stored
--      totals, and the work-log rule that a record is never rewritten.
--   2. Ryder asked for the tag history to be visible on the lead. Replaying the
--      events IS that history. Storing current state would mean building the
--      history separately, which is a second copy again.
--
-- The cost is honest and small: reading a lead's tags is a read of its events.
-- The console already reads every lead's activity in one call (getSalesBoard),
-- so this is one more read of the same shape, not a read per row.
--
-- WHY AN EVENT CANNOT BE EDITED. There is no update policy and no update grant
-- on admin_lead_tag_events at all. An event you can edit is not a record. A
-- correction is a new event with `why` saying what it corrects — exactly the
-- rule the notes and the timeline already follow.
--
-- Safe to run twice. Every statement is guarded and only admin_-prefixed
-- objects are created.
--
-- ONE MIGRATION TRAP THIS FILE IS SHAPED AROUND: `create table if not exists`
-- does NOT update a CHECK constraint on a table that already exists, and
-- re-running a migration does not widen one either. So every CHECK below that
-- could ever need to grow is added by drop-and-re-add with EVERY existing value
-- re-listed. A past migration lost 'email' from a check exactly that way and
-- broke a button for days.

-- ============================================================
-- 1. THE VOCABULARY
-- ============================================================

create table if not exists public.admin_lead_tags (
  id uuid primary key default gen_random_uuid(),

  -- The stable name the code uses: 'no-website', 'size-small', 'hot'. Lower
  -- case, hyphens, no spaces. Unique, because two tags with one slug is two
  -- filters that look like one.
  slug text not null unique,

  -- The words a person reads. "No website" rather than "no-website".
  label text not null,

  -- One of the Notion-ish colour names opsCells.jsx already knows
  -- (default, gray, brown, orange, yellow, green, blue, purple, pink, red).
  -- Not constrained here on purpose: a colour that is not on that list renders
  -- as `default` in chipStyle(), which is a cosmetic fallback rather than a
  -- broken row, and constraining it would mean this file has to be re-run every
  -- time the palette grows.
  color text,

  -- Which family the tag belongs to, so the filter menu can group them. The five
  -- the seed below uses: 'website' | 'size' | 'score' | 'source' | 'state'
  -- (state as in the state of the deal, not a US state).
  --
  -- DELIBERATELY NOT A GROUP: the firm's line of business, and where it is.
  -- Both are real columns on admin_companies that arrive with the sheet, both
  -- are their own filter on the Floor, and both are OPEN sets — a new vertical
  -- or a new US state would need a new row in this table, which only an admin
  -- may write (see the policies below), so an import run by a rep would silently
  -- fail to tag half its rows. A tag is a thing we decided about a lead. A
  -- vertical is a field somebody typed.
  --
  -- Named tag_group, not group — `group` is a reserved word in SQL and a column
  -- called that has to be quoted at every single use site.
  tag_group text,

  -- For a tag a RULE produces rather than a person: the name of that rule, plus
  -- whatever it needs. `{"rule":"quiet","days":7}`. The rule itself lives in
  -- lib/sales-rules.js as a pure function — this column is a record of which
  -- rule made the tag, so a tag on screen can be traced back to the code that
  -- wrote it. It is NOT a rule engine: nothing reads this column and executes
  -- it, because a rule stored as data is a rule with no test around it.
  auto_rule jsonb,

  -- Display order in the filter menu. Nulls last.
  sort int,

  -- A tag switched off stops being offered and stops being auto-applied. It is
  -- never deleted, because the events pointing at it are records.
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_lead_tags_group_idx
  on public.admin_lead_tags (tag_group, sort) where active;

drop trigger if exists admin_lead_tags_updated_at on public.admin_lead_tags;
create trigger admin_lead_tags_updated_at before update on public.admin_lead_tags
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 2. THE EVENTS — APPEND ONLY, NEVER UPDATED, NEVER DELETED
-- ============================================================

create table if not exists public.admin_lead_tag_events (
  id uuid primary key default gen_random_uuid(),

  lead_id uuid not null references public.admin_leads on delete cascade,
  tag_id  uuid not null references public.admin_lead_tags,

  -- 'added' or 'removed'. A removal is its own row, not the deletion of the row
  -- that added it — that is what makes "quiet was added on the 24th and taken
  -- off on the 25th because she replied" readable a month later.
  action text not null,

  -- When it happened. Named `at` rather than `created_at` because for this table
  -- they are the same thing and one name is less to get wrong.
  at timestamptz not null default now(),

  -- Who did it. NULL means the system did — an automatic rule, or the import.
  -- Deliberately nullable: pretending a rule was a person is worse than saying
  -- nobody.
  by uuid references auth.users on delete set null,

  -- 'auto'   — a rule in lib/sales-rules.js produced it
  -- 'person' — somebody clicked
  -- 'import' — it came in with the sheet
  source text not null,

  -- Plain words, for the history panel. "7 days with no touch" · "removed by
  -- hand" · "on import, Medspas tab". An auto tag removed by hand records
  -- why:'removed by hand' so the next sweep can see it was a decision and not
  -- put it straight back.
  why text
);

-- The two checks, drop-and-re-add so a re-run really does update them, with
-- every existing value re-listed. See the trap note at the top of this file.
alter table public.admin_lead_tag_events
  drop constraint if exists admin_lead_tag_events_action_check;
alter table public.admin_lead_tag_events
  add constraint admin_lead_tag_events_action_check
  check (action in ('added','removed'));

alter table public.admin_lead_tag_events
  drop constraint if exists admin_lead_tag_events_source_check;
alter table public.admin_lead_tag_events
  add constraint admin_lead_tag_events_source_check
  check (source in ('auto','person','import'));

-- The one way this table is read: one lead, newest first.
create index if not exists admin_lead_tag_events_lead_idx
  on public.admin_lead_tag_events (lead_id, at desc);
-- And the one way it is swept: everything since a moment, for the board read.
create index if not exists admin_lead_tag_events_at_idx
  on public.admin_lead_tag_events (at desc);
-- Replaying one lead's one tag needs both columns.
create index if not exists admin_lead_tag_events_lead_tag_idx
  on public.admin_lead_tag_events (lead_id, tag_id, at desc);

-- ============================================================
-- 3. 'tag' IS A THING THAT CAN HAPPEN TO A LEAD
-- ============================================================
-- The timeline is one list per person and a tag change belongs on it, next to
-- the calls, rather than in a second panel a rep has to think to open.
--
-- Drop-and-re-add with EVERY existing value re-listed — the same pattern
-- 0015_sales_lifecycle.sql:97-104 used to add 'converted' and 'client_link'.
-- Missing one of these off the list is how a button stops working silently.
alter table public.admin_lead_activity drop constraint if exists admin_lead_activity_type_check;
alter table public.admin_lead_activity
  add constraint admin_lead_activity_type_check
  check (type in (
    'call','email','text','linkedin','note','status_change','assigned',
    'claim','unclaim','reopen','score','proposal','import','cadence','open',
    'converted','client_link','tag'
  ));

-- ============================================================
-- 3b. ONE FUNCTION THAT SAYS WHO MAY WORK A LEAD
-- ============================================================
-- The row-level lock — a rep may work a lead they hold or a lead nobody holds,
-- and an owner or admin may work any — is needed by the policies on FOUR tables
-- (admin_leads, admin_lead_activity, admin_proposals, admin_lead_tag_events).
-- Writing it out four times is four places for it to stop matching.
--
-- IT IS DEFINED HERE RATHER THAN IN 0020, WHERE THE REST OF THE LOCK LIVES, FOR
-- ONE REASON, AND IT IS AN IMPORTANT ONE.
--
-- 0018 and 0020 both define the tag-event insert policy. Every migration in this
-- repo is meant to be safe to run twice, and the first version of these two files
-- made that false in a way nothing would have noticed: 0018's policy was the wide
-- one ("any member may tag any lead") and 0020 replaced it with the scoped one —
-- so re-running 0018 AFTER 0020 silently put the hole back. A test caught it. A
-- person would not have.
--
-- So 0018 carries the real rule from the start, through this function, and 0020
-- re-states the identical policy. Run them in either order, or twice, and the
-- answer is the same.
--
-- `security invoker` (the default, stated because it matters): the function is
-- evaluated as whoever is asking, so the select policy on admin_leads still
-- applies inside it. `security definer` here would have been a way around the
-- policy it exists to enforce.
--
-- STILL TRUE, AND WRITTEN DOWN RATHER THAN HOPED AWAY: re-running an EARLIER
-- migration after a later one that tightened a policy of the same name reverts
-- the tightening. Re-running 0001 after 0020 puts back the wide
-- "members update leads" and the wide "members log own activity". That is a
-- property of drop-and-recreate, not of these two files, and the mitigation is
-- the note in SETUP.md: if you ever re-run 0001 or 0009, re-run 0020 after it.
create or replace function public.admin_can_work_lead(p_lead uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select public.admin_is_admin()
     or exists (
       select 1 from public.admin_leads l
       where l.id = p_lead
         and (l.owner_id = auth.uid() or l.owner_id is null)
     );
$$;

revoke execute on function public.admin_can_work_lead(uuid) from anon, public;
grant execute on function public.admin_can_work_lead(uuid) to authenticated;

-- ============================================================
-- 4. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- The vocabulary: every member reads it, admins write it. A rep adding a brand
-- new tag TYPE to the company vocabulary is a naming decision, not a piece of
-- lead work — 'medspa', 'med-spa' and 'MedSpa' as three tags is a filter menu
-- nobody can use. A rep can put any EXISTING tag on any lead they may edit.
--
-- The events: every member reads them (a rep has to see another rep's lead
-- read-only, tags included, or the Floor cannot stop two reps working one firm)
-- and every member inserts them. There is NO UPDATE POLICY AND NO UPDATE GRANT.
-- That absence is the feature.
--
-- WHERE THE ROW-LEVEL LOCK COMES FROM: the one function in 3b above. 0020 is
-- where the rest of the lock lives (admin_leads, admin_lead_activity,
-- admin_proposals, the mailbox), and it re-states the tag policy identically —
-- see the long note on 3b for why this file carries the rule too instead of
-- leaving it to 0020.

grant select on public.admin_lead_tags to authenticated;
grant insert, update, delete on public.admin_lead_tags to authenticated;
grant select, insert on public.admin_lead_tag_events to authenticated;

alter table public.admin_lead_tags enable row level security;
alter table public.admin_lead_tag_events enable row level security;

drop policy if exists "members read tags" on public.admin_lead_tags;
create policy "members read tags" on public.admin_lead_tags
  for select using (public.admin_is_member());

drop policy if exists "admins write tags" on public.admin_lead_tags;
create policy "admins write tags" on public.admin_lead_tags
  for insert with check (public.admin_is_admin());
drop policy if exists "admins update tags" on public.admin_lead_tags;
create policy "admins update tags" on public.admin_lead_tags
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());
drop policy if exists "admins delete tags" on public.admin_lead_tags;
create policy "admins delete tags" on public.admin_lead_tags
  for delete using (public.admin_is_admin());

drop policy if exists "members read tag events" on public.admin_lead_tag_events;
create policy "members read tag events" on public.admin_lead_tag_events
  for select using (public.admin_is_member());

-- TWO HALVES, and they answer different questions.
--
-- `by = auth.uid() or by is null` mirrors the activity-log policy in 0001: a
-- person may file a row as themselves or as the system, and never as somebody
-- else. Without the auth.uid() half a rep could write "removed by hand — CJ"
-- onto a record nobody can edit afterwards.
--
-- `admin_can_work_lead(lead_id)` is WHICH LEAD they may tag — the row-level lock,
-- from the one function above. 0020 states this policy again, identically, so
-- running either file twice or in either order gives the same rule.
drop policy if exists "members write tag events" on public.admin_lead_tag_events;
create policy "members write tag events" on public.admin_lead_tag_events
  for insert with check (
    public.admin_is_member()
    and (by = auth.uid() or by is null)
    and public.admin_can_work_lead(lead_id)
  );

-- NO UPDATE POLICY AND NO UPDATE GRANT ON admin_lead_tag_events, on purpose.
-- NO DELETE POLICY AND NO DELETE GRANT either — not even for an admin. A tag
-- history with a hole in it is worse than a tag history that records a mistake,
-- and the mistake is fixable by adding the opposite event.

-- ============================================================
-- 4b. READING THE LOG WITHOUT READING ALL OF IT
-- ============================================================
-- A lead's tags right now are the newest event per tag. Working that out in the
-- browser means reading EVERY event for every lead on the page — and the Floor
-- loads two thousand leads. A windowed read is not an option and it is worth
-- saying why: an `added` from three months ago that falls outside the window
-- makes a tag that IS on the lead look like a tag that is off. Quietly wrong
-- tags are worse than no tags, because a filter built on them looks like it
-- worked.
--
-- So the replay happens here, in one line of SQL, and the browser reads the
-- answer. This is NOT a stored copy: a view holds nothing. It is the same events
-- read a cheaper way, so there is still exactly one record and nothing to fall
-- out of step.
--
-- `distinct on (lead_id, tag_id) ... order by at desc, id desc` is the newest
-- event per tag, ties broken on id — an import writes several events inside one
-- statement and Postgres gives them all the same now(), so ties are ordinary
-- rather than rare, and without the id the answer could flip between two reads
-- of the same rows.
--
-- REMOVALS STAY IN THE VIEW. It is "the newest event per tag", not "the tags
-- that are on". The caller filters on `action = 'added'` for the chips, and the
-- automatic rules read the removals to see which tags a person took off by hand
-- so they never put them back. Filtering removals out here would have deleted
-- that, and there would be nothing in the shape of the data to say so.
create or replace view public.admin_lead_tags_now as
select distinct on (e.lead_id, e.tag_id)
  e.id, e.lead_id, e.tag_id, e.action, e.at, e.by, e.source, e.why
from public.admin_lead_tag_events e
order by e.lead_id, e.tag_id, e.at desc, e.id desc;

-- SECURITY INVOKER, so the view is read with the PERMISSIONS OF WHOEVER IS
-- ASKING and row-level security on admin_lead_tag_events still applies through
-- it. Without this a view is read as its owner, which is how a view becomes a
-- way around the policy on the table underneath it. Postgres 15 and up.
alter view public.admin_lead_tags_now set (security_invoker = on);

grant select on public.admin_lead_tags_now to authenticated;

-- ============================================================
-- 5. THE STARTING VOCABULARY
-- ============================================================
-- Seeded here rather than by hand, so a fresh database has the same tags as
-- every other one and the auto rules have something to point at on day one.
-- `on conflict (slug) do nothing` — a re-run must not overwrite a label or a
-- colour somebody has since changed on screen.
--
-- The score bands are written as four tags rather than one 'scored' tag with a
-- number, because a filter is a list of values you tick. `scored-90-plus` is
-- the same threshold as ROE.SKIP_SCORE_AT_OR_ABOVE in lib/sales-rules.js; if
-- that number ever moves, this label moves with it or the two disagree.

insert into public.admin_lead_tags (slug, label, color, tag_group, auto_rule, sort) values
  ('no-website',      'No website',        'red',     'website',  '{"rule":"website"}',            10),
  ('has-website',     'Has a website',     'gray',    'website',  '{"rule":"website"}',            11),

  ('size-solo',       'Solo (1)',          'gray',    'size',     '{"rule":"size","max":1}',       20),
  ('size-small',      'Small (2-10)',      'blue',    'size',     '{"rule":"size","max":10}',      21),
  ('size-mid',        'Mid (11-50)',       'purple',  'size',     '{"rule":"size","max":50}',      22),
  ('size-large',      'Large (51+)',       'brown',   'size',     '{"rule":"size","min":51}',      23),

  ('never-touched',   'Never touched',     'yellow',  'source',   '{"rule":"never-touched"}',      30),
  ('imported',        'Imported',          'gray',    'source',   '{"rule":"imported"}',           31),

  ('unscanned',       'Not scanned yet',   'yellow',  'score',    '{"rule":"score-band"}',         40),
  ('scored-under-60', 'Scored under 60',   'green',   'score',    '{"rule":"score-band","max":59}',41),
  ('scored-60s',      'Scored 60-79',      'blue',    'score',    '{"rule":"score-band","max":79}',42),
  ('scored-80s',      'Scored 80-89',      'orange',  'score',    '{"rule":"score-band","max":89}',43),
  ('scored-90-plus',  'Scored 90+',        'gray',    'score',    '{"rule":"score-band","min":90}',44),

  ('hot',             'Replied',           'green',   'state',    '{"rule":"replied"}',            50),
  ('quiet',           'Gone quiet (7d)',   'yellow',  'state',    '{"rule":"quiet","days":7}',     51),
  ('cold',            'Cold (14d)',        'red',     'state',    '{"rule":"cold","days":14}',     52),
  ('claim-expiring',  'Claim expiring',    'orange',  'state',    '{"rule":"claim-expiring"}',     53),
  ('bounced',         'Bad address',       'red',     'state',    '{"rule":"bounced"}',            54),
  ('skip-90',         'Not a prospect',    'gray',    'state',    '{"rule":"skip-90"}',            55),
  ('won',             'Won',               'green',   'state',    '{"rule":"closed"}',             56),
  ('lost',            'Lost',              'red',     'state',    '{"rule":"closed"}',             57)
on conflict (slug) do nothing;

-- ============================================================
-- 6. AFTER RUNNING THIS
-- ============================================================
--   1. The tags appear on the Floor's filter bar the next time the page loads.
--
--      NOTHING TAGS THE EXISTING BOOK. An earlier version of this line said
--      "every lead gets its automatic tags the next time a sweep or an import
--      runs", and that is not true of anything in the repo today: the only caller
--      of the automatic rules is the per-lead "Bring the automatic tags up to
--      date" button on the Floor. api/sales-sweep.js has no tag code in it and is
--      not scheduled anyway; lib/sales-import.js writes no tag events.
--
--      So on a fresh database every lead starts with no tags, and a filter like
--      "no website, never touched, in Florida" returns nothing until somebody has
--      pressed that button on those rows. That is a real gap and it is written
--      down rather than described away — the two places it belongs are the
--      overnight sweep and the import, and neither was done today.
--
--      Nothing is back-filled by this FILE either, and that part was always
--      deliberate: back-filling in SQL would write thousands of events dated today
--      for things that happened in July, and a dated line that lies about its date
--      is worse than no line.
--   2. Verify with:
--        select slug, label, tag_group from public.admin_lead_tags order by sort;
--        select count(*) from public.admin_lead_tag_events;   -- 0 on a fresh run
