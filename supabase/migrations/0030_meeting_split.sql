-- ============================================================
-- 0030 — A MEETING IS TWO THINGS, AND ONE OF THEM HAS A DATE
-- ============================================================
-- Wed 2 Sep 2026. Ryder: "for the deal flow it needs to go … instead of meeting
-- make it meeting booked and have a date that they have the meeting, then
-- meeting complete, then the proposal stage."
--
-- WHAT WAS WRONG. One stage called `meeting` meant both "booked for Tuesday"
-- and "happened in June". The help text in the app admitted it out loud —
-- "A meeting is booked or has happened." — so no count taken from that stage
-- meant anything: a rep with four meetings on the board could have four in the
-- diary, four already sat through, or any mix.
--
-- THE SHAPE.
--
--   meeting_booked    it is in the diary. REQUIRES a future date.
--   meeting_complete  it happened. REQUIRES a date, and the app refuses one in
--                     the future (STAGE_REQUIRES.when = 'past'). The DATABASE
--                     does not enforce that direction — a check constraint
--                     comparing a column to now() is not immutable — so this
--                     line describes the app's rule, not Postgres's.
--   proposal          unchanged, and still after both.
--
-- WHY A NEW COLUMN AND NOT `next_follow_up_at`. That column already means
-- "the next thing owed on this lead", and a date in the past on it means
-- OVERDUE everywhere — the sweep, My Day, the "Follow-up was due N days ago"
-- line. Storing "the meeting happened in June" there would put every completed
-- meeting on the overdue list for ever. So the meeting gets its own column and
-- `next_follow_up_at` keeps its one meaning.
--
-- Safe to run twice. Widen, move the rows, narrow — the same order 0027 used,
-- and for the same reason: narrowing first would refuse the very update that
-- makes the rows legal.

-- ------------------------------------------------------------
-- 1. THE DATE OF THE MEETING
-- ------------------------------------------------------------
alter table public.admin_leads
  add column if not exists meeting_at timestamptz;

comment on column public.admin_leads.meeting_at is
  'When the meeting is, or was. Future while the stage is meeting_booked, past once it is meeting_complete. NOT next_follow_up_at: a past date on that column means overdue everywhere.';

-- "The meetings this week" and "who has a meeting coming up" are the only two
-- questions this column answers, and both are ranges over open leads.
create index if not exists admin_leads_meeting_at_idx
  on public.admin_leads (meeting_at)
  where meeting_at is not null;

-- ------------------------------------------------------------
-- 2. WIDEN — both new values become legal, the old one still is
-- ------------------------------------------------------------
alter table public.admin_leads drop constraint if exists admin_leads_stage_check;
alter table public.admin_leads
  add constraint admin_leads_stage_check
  check (stage in (
    'new','researching','contacted','in_conversation','follow_up',
    'meeting','meeting_booked','meeting_complete','proposal',
    'won','lost','reopened','not_a_fit'
  ));

-- ------------------------------------------------------------
-- 3. MOVE THE ROWS — and say on the timeline which one they became
-- ------------------------------------------------------------
-- Every lead sitting in `meeting` goes to `meeting_booked`, because that is the
-- honest reading of a lead somebody left there: the meeting was arranged. The
-- rep can move it on to `meeting_complete` themselves, which is the whole point
-- of splitting it.
--
-- The line goes on the timeline BEFORE the rewrite, so nobody has to guess
-- later which rows were moved by this file and which a person chose. `where not
-- exists` makes it idempotent alongside the rest.
insert into public.admin_lead_activity (lead_id, actor, type, outcome, body)
select l.id,
       coalesce(l.owner_id, (select user_id from public.admin_users where role = 'owner' and active order by created_at limit 1)),
       'status_change',
       l.stage,
       'Stage split: Meeting became Meeting booked. Move it to Meeting complete once it has happened.'
  from public.admin_leads l
 where l.stage = 'meeting'
   and not exists (
     select 1 from public.admin_lead_activity a
      where a.lead_id = l.id
        and a.type = 'status_change'
        and a.body like 'Stage split: Meeting became Meeting booked.%'
   );

update public.admin_leads
   set stage = 'meeting_booked'
 where stage = 'meeting';

-- CARRY THE DATE ACROSS, where there is one to carry. A lead in `meeting` was
-- only allowed there with a future `next_follow_up_at` — that gate is why the
-- column was overloaded in the first place — so that date IS the meeting.
--
-- Only where `meeting_at` is still empty, so a second run changes nothing, and
-- only where the follow-up is in the future: a past one is an overdue follow-up
-- that predates the gate, and calling it a meeting would be inventing a fact.
update public.admin_leads
   set meeting_at = next_follow_up_at
 where stage = 'meeting_booked'
   and meeting_at is null
   and next_follow_up_at is not null
   and next_follow_up_at > now();

-- ------------------------------------------------------------
-- 4. NARROW — `meeting` becomes unwritable
-- ------------------------------------------------------------
-- There is no lead left in it, and nothing in the app offers it any more. A
-- value that can still be written is a value that comes back.
alter table public.admin_leads drop constraint if exists admin_leads_stage_check;
alter table public.admin_leads
  add constraint admin_leads_stage_check
  check (stage in (
    'new','researching','contacted','in_conversation','follow_up',
    'meeting_booked','meeting_complete','proposal',
    'won','lost','reopened','not_a_fit'
  ));

-- `reopened` stays legal and is deliberately not rewritten, exactly as 0027
-- left it: nothing can set it, and the rows holding it are real history.

-- ------------------------------------------------------------
-- 5. RE-ASSERT THE GRANTS
-- ------------------------------------------------------------
-- A lost GRANT has broken two pages on this project. Adding a column is a cheap
-- moment to be sure. Nothing here widens access — RLS still decides every row.
grant select, insert, update, delete on public.admin_leads to authenticated;
