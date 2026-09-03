-- WHAT 0030 ACTUALLY DOES, run against a real Postgres 16 — not against a
-- reading of the file. Every check raises and stops on the first wrong answer.
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.want(label text, got text, expected text) returns void language plpgsql as $$
begin
  if got is distinct from expected then
    raise exception 'FAIL: % — got %, wanted %', label, coalesce(got,'<null>'), coalesce(expected,'<null>');
  end if;
  raise notice '  ok   %', label;
end; $$;

create or replace function pg_temp.constraint_has(needle text) returns boolean language sql stable as $$
  select pg_get_constraintdef(oid) like '%' || needle || '%'
    from pg_constraint where conname = 'admin_leads_stage_check';
$$;

-- ---- 1. WHAT THE CONSTRAINT HOLDS NOW ----------------------------
select pg_temp.want('meeting_booked is writable', pg_temp.constraint_has('meeting_booked')::text, 'true');
select pg_temp.want('meeting_complete is writable', pg_temp.constraint_has('meeting_complete')::text, 'true');
select pg_temp.want('THE OLD SINGLE `meeting` IS NOT — a value that can be written comes back',
  pg_temp.constraint_has('''meeting''')::text, 'false');
select pg_temp.want('the column for the date exists',
  (select count(*)::text from information_schema.columns
    where table_name = 'admin_leads' and column_name = 'meeting_at'), '1');

-- ---- 2. THE MOVE, AND THE DATE THAT CAME WITH IT ------------------
-- These rows are inserted with the constraint ALREADY narrowed, so `meeting` is
-- refused — which is the point. They are put in by dropping the constraint the
-- way a pre-0030 database would have been, then 0030 is run again over them.
insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');
insert into public.admin_users (user_id, role, active) values ('11111111-1111-1111-1111-111111111111', 'owner', true);
alter table public.admin_leads drop constraint admin_leads_stage_check;
insert into public.admin_leads (id, name, stage, owner_id, next_follow_up_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Booked for next week', 'meeting', '11111111-1111-1111-1111-111111111111', now() + interval '5 days'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Follow-up went stale',  'meeting', '11111111-1111-1111-1111-111111111111', now() - interval '9 days'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'No date at all',        'meeting', '11111111-1111-1111-1111-111111111111', null),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'Somewhere else',        'proposal', '11111111-1111-1111-1111-111111111111', now() + interval '2 days');
\i :mig

select pg_temp.want('every lead in the old stage moved',
  (select count(*)::text from public.admin_leads where stage = 'meeting'), '0');
select pg_temp.want('...to meeting_booked',
  (select count(*)::text from public.admin_leads where stage = 'meeting_booked'), '3');
select pg_temp.want('a lead at another stage was not touched',
  (select stage from public.admin_leads where id = 'aaaaaaaa-0000-0000-0000-000000000004'), 'proposal');

select pg_temp.want('A FUTURE FOLLOW-UP BECAME THE MEETING DATE',
  (select (meeting_at = next_follow_up_at)::text from public.admin_leads where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'true');
select pg_temp.want('A PAST ONE DID NOT — that is an overdue follow-up, not a meeting',
  (select (meeting_at is null)::text from public.admin_leads where id = 'aaaaaaaa-0000-0000-0000-000000000002'), 'true');
select pg_temp.want('...and neither did no date at all',
  (select (meeting_at is null)::text from public.admin_leads where id = 'aaaaaaaa-0000-0000-0000-000000000003'), 'true');
select pg_temp.want('next_follow_up_at was left exactly as it was',
  (select count(*)::text from public.admin_leads where next_follow_up_at is not null), '3');

select pg_temp.want('every moved lead got a line on its timeline',
  (select count(*)::text from public.admin_lead_activity where body like 'Stage split: Meeting became%'), '3');
select pg_temp.want('...that records the stage it was in before the rewrite',
  (select distinct outcome from public.admin_lead_activity where body like 'Stage split:%'), 'meeting');

-- ---- 3. A SECOND RUN CHANGES NOTHING ------------------------------
\i :mig
select pg_temp.want('a second run adds no second timeline line',
  (select count(*)::text from public.admin_lead_activity where body like 'Stage split: Meeting became%'), '3');
select pg_temp.want('...and moves nothing again',
  (select count(*)::text from public.admin_leads where stage = 'meeting_booked'), '3');

-- ---- 4. THE TWO NEW STAGES ACTUALLY WORK --------------------------
update public.admin_leads set stage = 'meeting_complete', meeting_at = now() - interval '2 days'
 where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.want('a meeting can be marked complete, with a date in the past',
  (select (stage = 'meeting_complete' and meeting_at < now())::text from public.admin_leads where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'true');
do $$
begin
  begin
    update public.admin_leads set stage = 'meeting' where id = 'aaaaaaaa-0000-0000-0000-000000000003';
    raise exception 'FAIL: the old `meeting` stage was still writable';
  exception when check_violation then
    raise notice '  ok   THE OLD STAGE IS REFUSED BY THE DATABASE, not merely unoffered by the app';
  end;
end $$;

\echo ''
\echo 'ALL 0030 BEHAVIOUR CHECKS PASSED'
