-- ============================================================
-- 0034 — A MEETING IS A RECORD, NOT A DATE ON THE LEAD
-- ============================================================
-- Sat 12 Sep 2026. Julia Craig, VP of Sales, in the Slack DM with Ryder, CJ and
-- Andrew: "how do i add in the meetings ive already had without having to
-- manually add each one lol".
--
-- Ryder's answer at the time was "I think everything has to be added manually",
-- and that was right — but it was not the whole problem. Reading the schema
-- first turned up something worse than slow.
--
-- WHAT WAS ACTUALLY WRONG.
--
-- 0030 gave the lead ONE date column, `admin_leads.meeting_at`, and two stages
-- either side of it. One date. Per lead. For ever.
--
-- So a rep who met somebody in June and again in July could not record both.
-- The second write OVERWROTE the first and the June meeting stopped existing.
-- Julia was not asking for a faster form; she was asking to put history into a
-- box that holds exactly one thing.
--
-- And there was no way to say WHEN something happened, either.
-- `admin_lead_activity.created_at` defaults to now() and nothing on any screen
-- has ever set it — so a June meeting logged in September reads as September.
-- lib/person-timeline.js has a written rule against precisely that (Rule 1: a
-- row with no readable date is dropped and counted, never dated "now" so it has
-- somewhere to sit). Backfilling through the activity log would have broken the
-- rule the timeline is built on.
--
-- THE SHAPE.
--
--   admin_meetings          many per person, each with its OWN occurred_at.
--   admin_meeting_batches   one row per "Save all", so a bad paste is undoable.
--
-- Every meeting ALSO writes one row into admin_lead_activity, backdated to
-- occurred_at, and keeps its id. That is deliberate and it is the cheapest part
-- of this file: it means the timeline, "last touched", the Contacted? column,
-- the rep scoreboard, the brain context and My Day all understand meetings
-- WITHOUT ONE LINE OF CHANGE. The meeting row holds the structured detail; the
-- activity row is the line on the timeline. One act, one line, no double entry.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--
-- IT DOES NOT TOUCH `admin_leads.meeting_at`, AND IT DOES NOT TOUCH `stage`.
--
-- That is the single most important sentence here, so it gets its own note.
-- `meeting_at` is the STAGE GATE — 0030 built it so meeting_booked can demand a
-- future date and meeting_complete can demand a past one (STAGE_REQUIRES in
-- lib/stage-move.js). It is not a history column and it must not become one.
-- If backfilling a June meeting rewrote it, then:
--   * a lead with a real meeting booked for next Tuesday would lose that date;
--   * a lead at Proposal would be dragged back down the pipeline by an act of
--     bookkeeping about something that happened three months ago.
-- History goes in admin_meetings. The gate keeps its one meaning. The person
-- card offers "also set this as the booked meeting" as a BUTTON on a future
-- date, so it happens because somebody chose it, never as a side effect.
--
-- IT ALSO DOES NOT TOUCH `next_follow_up_at`. Same reason 0030 gave: a past
-- date on that column means OVERDUE everywhere — the sweep, My Day, "Follow-up
-- was due N days ago" — so a backfilled meeting written there would put every
-- finished meeting on the overdue list for ever. Julia would have filed thirty
-- meetings and been handed thirty overdue follow-ups for her trouble.
--
-- Safe to run twice. Additive, admin_-prefixed, every statement guarded.

-- ============================================================
-- 1. THE BATCH — so a bad paste is one click to undo
-- ============================================================
-- A screen built for entering thirty rows fast needs an eraser that is just as
-- fast, or the first mis-paste turns into half an hour of hand-deleting. Same
-- reasoning as admin_import_batches (0016), and a separate table for the same
-- reason that one is separate: its columns are about importing LEADS.
--
-- THE BATCH ROW IS NEVER DELETED. Undoing sets `undone_at` and removes the
-- meetings. The record that somebody entered thirty meetings and took them back
-- is itself worth keeping — it is the only way to explain a gap later.
create table if not exists public.admin_meeting_batches (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users,
  -- How they got in: the grid, the assistant, or one at a time from a card.
  -- `entry` is free of the meeting's own `source` on purpose — a meeting typed
  -- into the grid and a meeting dictated to the assistant are both CLAIMED from
  -- memory, but they arrived by different doors and the difference matters when
  -- something looks wrong.
  entry text not null default 'grid' check (entry in ('grid','chat','card')),
  note text,
  -- How many meetings this batch actually wrote, stamped once the insert has
  -- come back. It is a RECORD OF WHAT LANDED, not an independent claim to check
  -- the rows against — an earlier version of this comment said the opposite and
  -- described a partial-delete check that nothing performs. Its real job is the
  -- undo message: "put back 3 of 4" needs to know there were 4.
  row_count int not null default 0,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);

create index if not exists admin_meeting_batches_idx
  on public.admin_meeting_batches (created_by, created_at desc);

-- ============================================================
-- 2. THE MEETING
-- ============================================================
create table if not exists public.admin_meetings (
  id uuid primary key default gen_random_uuid(),

  -- WHO IT WAS WITH. A meeting hangs off the lead, the client, or both — a won
  -- lead keeps its lead row and gains a client row (0015/0023), and a meeting
  -- held the week of the sale honestly belongs to both sides of that line.
  -- AT LEAST ONE IS REQUIRED. A meeting attached to nobody is a meeting nobody
  -- will ever find again, which is the same as not having recorded it.
  lead_id uuid references public.admin_leads on delete cascade,
  client_id uuid references public.admin_clients on delete cascade,

  -- THE WHOLE POINT OF THE FILE. When the meeting actually was — not when
  -- somebody got round to typing it in. That is `created_at`, further down, and
  -- the two being different is the feature.
  occurred_at timestamptz not null,

  -- WHAT KIND. A fixed list, not free text, for the reason the Google sheet
  -- failed: a column anybody can type into is a column nothing can count.
  kind text not null default 'discovery'
    check (kind in ('discovery','demo','follow_up','proposal','check_in','other')),

  -- HOW IT WENT. `happened` is the default because it is the honest answer for
  -- a backfilled meeting somebody half remembers, and a default of "went well"
  -- would manufacture thirty good meetings out of one paste.
  outcome text not null default 'happened'
    check (outcome in ('happened','went_well','no_show','rescheduled','they_passed','booked_next')),

  notes text,

  -- MEASURED OR CLAIMED, and never blended. The house rule, same as the Finance
  -- page and every report we send.
  --   typed     a person entered it from memory. CLAIMED.
  --   chat      a person told the assistant and approved what it read back.
  --             Still claimed — the assistant did not witness anything.
  --   import    came in with a batch of rows from a file.
  --   calendar  read out of a connected calendar. MEASURED.
  -- `calendar` IS IN THIS LIST AND NOTHING WRITES IT TODAY (12 Sep 2026). Ryder
  -- said no calendars yet. It is listed so that connecting one later is a
  -- feature, not a migration — and so nobody invents a second spelling for it.
  source text not null default 'typed'
    check (source in ('typed','chat','import','calendar')),

  -- WHO PUT IT IN THE SYSTEM. Not who attended — who typed it. A backfilled
  -- meeting is one person's memory, and three months from now the only way to
  -- weigh it is to know whose.
  entered_by uuid not null references auth.users,

  batch_id uuid references public.admin_meeting_batches on delete set null,

  -- The calendar event's own id, for the day a calendar is connected. Unique
  -- per source below, so re-running an import cannot file the same meeting
  -- twice. Null for everything typed.
  external_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint admin_meetings_has_subject
    check (lead_id is not null or client_id is not null)
);

comment on column public.admin_meetings.occurred_at is
  'When the meeting happened, or will happen. NOT created_at, which is when somebody typed it in. NOT admin_leads.meeting_at, which is the stage gate from 0030 and is deliberately left alone by everything in this file.';

comment on column public.admin_meetings.source is
  'typed/chat/import are CLAIMED — a person recalled it. calendar is MEASURED. Never mix the two in a count without saying which is which. Nothing writes calendar as of 12 Sep 2026.';

-- "Every meeting with this person, newest first" is what the card asks, and it
-- is the only query on the hot path.
create index if not exists admin_meetings_lead_idx
  on public.admin_meetings (lead_id, occurred_at desc) where lead_id is not null;
create index if not exists admin_meetings_client_idx
  on public.admin_meetings (client_id, occurred_at desc) where client_id is not null;

-- "What did we do last month" and "undo that batch".
create index if not exists admin_meetings_when_idx on public.admin_meetings (occurred_at desc);
create index if not exists admin_meetings_batch_idx
  on public.admin_meetings (batch_id) where batch_id is not null;

-- The dedupe guard for the day a calendar is connected. Per source, because two
-- systems can hand out the same string and mean different things.
create unique index if not exists admin_meetings_external_idx
  on public.admin_meetings (source, external_id) where external_id is not null;

drop trigger if exists admin_meetings_updated_at on public.admin_meetings;
create trigger admin_meetings_updated_at before update on public.admin_meetings
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 2b. THE LINK POINTS FROM THE TIMELINE TO THE MEETING
-- ============================================================
-- THE FIRST DRAFT OF THIS FILE HAD IT THE OTHER WAY ROUND — `admin_meetings`
-- carried an `activity_id` — and that single choice caused two separate
-- defects, both found by an adversarial review before any of it ran.
--
-- 1. IT FORCED POSITIONAL PAIRING. With the link on the meeting, the writer had
--    to insert an array of activity rows, read the ids back, and match them to
--    the rows it sent BY POSITION. The guard it used was "the lead_id at
--    position i matches the one I sent at position i" — which is no guard at
--    all when two meetings in one batch are with the SAME PERSON. That is not
--    an edge case here: this whole screen exists so somebody can enter their
--    history with a contact, which is by definition several meetings with one
--    person. A reordered result would have silently attached June's meeting to
--    July's timeline line, and then editing June would have rewritten July.
--
-- 2. IT MADE UNDO INCOMPLETE. Undo deleted timeline rows by joining through the
--    meetings, so a run that wrote the timeline rows and then failed on the
--    meetings left every one of those rows behind with nothing pointing at them
--    and no way to find them again.
--
-- Both vanish with the link on this side. The meetings are written FIRST with
-- ids we generate ourselves, and each timeline row carries the id of the
-- meeting it describes. Nothing is paired by position anywhere, and:
--
--   ON DELETE CASCADE means removing a meeting removes its line on the timeline
--   in the same statement, in the database, whoever does the removing — the
--   panel, the undo function, or somebody in the SQL editor. The application
--   does not have to remember, which is the only kind of rule that holds.
alter table public.admin_lead_activity
  add column if not exists meeting_id uuid references public.admin_meetings on delete cascade;

comment on column public.admin_lead_activity.meeting_id is
  'The meeting this line describes, when it describes one. ON DELETE CASCADE: deleting the meeting deletes this line. Never paired by position — see the note in 0034.';

create index if not exists admin_lead_activity_meeting_idx
  on public.admin_lead_activity (meeting_id) where meeting_id is not null;

-- ============================================================
-- 3. 'meeting' BECOMES A TYPE THE TIMELINE KNOWS
-- ============================================================
-- Drop and re-add with EVERY existing value re-listed — the pattern 0015:97 and
-- 0018:183 both used. Missing one off the list is how a button stops working
-- silently, and this constraint has now been rewritten three times.
alter table public.admin_lead_activity drop constraint if exists admin_lead_activity_type_check;
alter table public.admin_lead_activity
  add constraint admin_lead_activity_type_check
  check (type in (
    'call','email','text','linkedin','note','status_change','assigned',
    'claim','unclaim','reopen','score','proposal','import','cadence','open',
    'converted','client_link','tag','meeting'
  ));

-- ============================================================
-- 4. A MEETING COUNTS AS CONTACT
-- ============================================================
-- The touch trigger from 0009 moves last_touch_at, claim_contacted_at and
-- first_contact_at, but only for 'call','email','text','linkedin'. A meeting was
-- not in that list because a meeting was not a row.
--
-- IT BELONGS IN THE LIST. Sitting down with somebody is the strongest contact
-- there is; leaving it out would print "no contact in 12d" against a firm we met
-- on Tuesday, which is the kind of wrong number that gets read out loud.
--
-- THE THREE COLUMNS BEHAVE CORRECTLY ON A BACKFILL, and this is worth spelling
-- out because it is the reason no other code was needed:
--   * last_touch_at uses GREATEST — a meeting backdated to June cannot reset
--     the 14-day cold timer on a lead last touched in September. Backfilling
--     history does not make a cold lead look warm.
--   * first_contact_at uses LEAST — so filing a June meeting on a lead whose
--     first contact reads July CORRECTS it to June. June is the truer answer.
--     That behaviour was already here (0009 chose LEAST over coalesce precisely
--     so a replayed history dates from when it happened); this file only feeds
--     it.
--   * claim_contacted_at uses COALESCE — first one wins, later ones ignored.
--
-- `status_change` and the rest still do not count, for 0009's reason: a firm
-- that gets a fresh 14 days every time somebody re-picks a dropdown is a firm
-- nobody ever calls again.
create or replace function public.admin_lead_activity_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.type in ('call','email','text','linkedin','meeting') then
    update public.admin_leads
      set last_touch_at = greatest(coalesce(last_touch_at, new.created_at), new.created_at),
          claim_contacted_at = coalesce(claim_contacted_at, new.created_at),
          first_contact_at = least(coalesce(first_contact_at, new.created_at), new.created_at),
          last_activity_at = greatest(coalesce(last_activity_at, new.created_at), new.created_at)
      where id = new.lead_id;
  else
    update public.admin_leads
      set last_activity_at = greatest(coalesce(last_activity_at, new.created_at), new.created_at)
      where id = new.lead_id;
  end if;
  return new;
end;
$$;

drop trigger if exists admin_lead_activity_touch_trg on public.admin_lead_activity;
create trigger admin_lead_activity_touch_trg after insert on public.admin_lead_activity
  for each row execute function public.admin_lead_activity_touch();

-- ============================================================
-- 5. UNDO A BATCH — one statement, and it says what it did
-- ============================================================
-- Deletes the meetings a batch wrote AND the timeline rows they mirrored, marks
-- the batch spent, and returns how many went. A count that comes back smaller
-- than row_count means somebody had already removed some by hand, and the
-- caller is told rather than left to assume.
--
-- security definer, so it must check membership itself — and it checks the
-- ROW LOCK too: only the person who entered the batch, or an admin, may undo it.
-- Without that a rep could erase another rep's afternoon.
create or replace function public.admin_meetings_undo_batch(p_batch uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_gone int := 0;
begin
  if not public.admin_is_member() then
    raise exception 'not authorized';
  end if;

  select created_by into v_owner
    from public.admin_meeting_batches where id = p_batch;
  if v_owner is null then
    raise exception 'no such batch';
  end if;
  if not (public.admin_is_admin() or v_owner = auth.uid()) then
    raise exception 'not authorized';
  end if;

  -- NOTHING IS DONE ABOUT THE TIMELINE ROWS HERE, and that is the point of
  -- putting the link on them: `meeting_id ... on delete cascade` means deleting
  -- the meetings takes their lines with them, in the same statement. The first
  -- draft deleted them by hand, first, by joining through the meetings — which
  -- worked only when there WERE meetings to join through, so a half-written
  -- batch left every timeline row behind and told the person it had cleaned up.
  with gone as (
    delete from public.admin_meetings where batch_id = p_batch returning 1
  )
  select count(*) into v_gone from gone;

  update public.admin_meeting_batches
     set undone_at = now()
   where id = p_batch and undone_at is null;

  return v_gone;
end;
$$;

revoke execute on function public.admin_meetings_undo_batch(uuid) from anon, public;
grant execute on function public.admin_meetings_undo_batch(uuid) to authenticated;

-- ============================================================
-- 6. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- The lock is the one every other lead-shaped table uses:
-- public.admin_can_work_lead() from 0018 §3b. Written out again here would be a
-- fifth copy of a rule that has to match in five places.
--
-- A CLIENT-ONLY MEETING IS DIFFERENT AND IS DELIBERATELY WIDER. Clients are not
-- owned by a rep the way leads are — the whole team works them, and the Clients
-- page has always been readable by every member. So a meeting with no lead_id
-- is governed by membership, not by the lead lock.
grant select, insert, update, delete on public.admin_meetings to authenticated;
grant select, insert, update on public.admin_meeting_batches to authenticated;

alter table public.admin_meetings enable row level security;
alter table public.admin_meeting_batches enable row level security;

drop policy if exists "members read meetings" on public.admin_meetings;
create policy "members read meetings" on public.admin_meetings
  for select using (public.admin_is_member());

drop policy if exists "members write meetings" on public.admin_meetings;
create policy "members write meetings" on public.admin_meetings
  for insert with check (
    public.admin_is_member()
    -- You file it as yourself. Same half 0001 put on lead activity: a dated
    -- record of somebody else's meeting, entered under their name, is the one
    -- thing this table must not allow.
    and entered_by = auth.uid()
    and (
      lead_id is null
      or public.admin_can_work_lead(lead_id)
    )
  );

-- FIXING ONE IS NARROWER THAN WRITING ONE. A backfilled meeting is a memory and
-- memories get corrected — by the person whose memory it was, or by an admin.
-- A rep who can work a lead may still not rewrite another rep's account of a
-- meeting they were in.
drop policy if exists "owners fix their meetings" on public.admin_meetings;
create policy "owners fix their meetings" on public.admin_meetings
  for update using (public.admin_is_admin() or entered_by = auth.uid())
           with check (public.admin_is_admin() or entered_by = auth.uid());

drop policy if exists "owners remove their meetings" on public.admin_meetings;
create policy "owners remove their meetings" on public.admin_meetings
  for delete using (public.admin_is_admin() or entered_by = auth.uid());

drop policy if exists "members read meeting batches" on public.admin_meeting_batches;
create policy "members read meeting batches" on public.admin_meeting_batches
  for select using (public.admin_is_member());

drop policy if exists "members open meeting batches" on public.admin_meeting_batches;
create policy "members open meeting batches" on public.admin_meeting_batches
  for insert with check (public.admin_is_member() and created_by = auth.uid());

drop policy if exists "owners close meeting batches" on public.admin_meeting_batches;
create policy "owners close meeting batches" on public.admin_meeting_batches
  for update using (public.admin_is_admin() or created_by = auth.uid())
           with check (public.admin_is_admin() or created_by = auth.uid());

-- ============================================================
-- 6b. A MEETING'S LINE ON THE TIMELINE CAN BE CORRECTED
-- ============================================================
-- `admin_lead_activity` has been SELECT + INSERT only since 0001:339, and no
-- migration since has widened it. That is deliberate and it is right: the
-- timeline is a record, and a record that can be quietly rewritten is not one.
-- There is no UPDATE anywhere in the application against that table — this is
-- the first.
--
-- BUT A MEETING CAN BE CORRECTED, and its line has to follow. A meeting whose
-- date was fixed while its timeline line still reads the old day is two answers
-- to one question, and the timeline is the one people actually look at.
--
-- Without this the correction half simply fails: PostgREST answers 42501
-- "permission denied for table admin_lead_activity" on every single edit, the
-- meeting changes, the line does not, and the screen says so in red for ever.
-- Found by a review; nothing exercised the missing privilege because nothing
-- else has ever updated this table.
--
-- THE GRANT IS THE NARROWEST THING THAT WORKS. Update only — no delete, because
-- the cascade on `meeting_id` removes the line when its meeting goes and
-- nothing should be removing timeline rows any other way. And the policy allows
-- it ONLY on rows that belong to a meeting (`meeting_id is not null`) that this
-- person may work: a call, an email or a note stays exactly as unrewritable as
-- it has always been.
grant update on public.admin_lead_activity to authenticated;

drop policy if exists "members fix a meeting's own line" on public.admin_lead_activity;
create policy "members fix a meeting's own line" on public.admin_lead_activity
  for update
  using (
    meeting_id is not null
    and (
      public.admin_is_admin()
      or exists (
        select 1 from public.admin_meetings m
         where m.id = admin_lead_activity.meeting_id
           and m.entered_by = auth.uid()
      )
    )
  )
  with check (
    -- The line must still belong to the same meeting after the update. Without
    -- this, an allowed row could be repointed at somebody else's meeting and
    -- then edited freely.
    meeting_id is not null
    and (
      public.admin_is_admin()
      or exists (
        select 1 from public.admin_meetings m
         where m.id = admin_lead_activity.meeting_id
           and m.entered_by = auth.uid()
      )
    )
  );

-- ============================================================
-- 7. AFTER RUNNING THIS
-- ============================================================
--   1. NOTHING IS BACK-FILLED BY THIS FILE. The leads currently sitting at
--      meeting_booked or meeting_complete keep their `meeting_at` and gain no
--      meeting row. Inventing one would mean dating a meeting from a stage gate
--      and claiming somebody recorded it, and nobody did.
--   2. The Meetings section on a person's card reads empty until somebody
--      enters something. Empty means "nothing recorded", which is not the same
--      as "no meetings happened" — the screen says so in those words.
--   3. Check it landed:
--        select count(*) from public.admin_meetings;
--        select conname from pg_constraint
--         where conrelid = 'public.admin_lead_activity'::regclass
--           and conname = 'admin_lead_activity_type_check';
--      and confirm 'meeting' is in that constraint's definition.
--   4. Prove the correction path works, because it is the one that needed a new
--      privilege on a table that has been read-only since 0001:
--        select has_table_privilege('authenticated','public.admin_lead_activity','UPDATE');
--      It must be true. If it is false, editing a meeting will change the
--      meeting and leave its line on the timeline showing the old details.
