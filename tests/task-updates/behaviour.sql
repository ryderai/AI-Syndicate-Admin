-- WHAT 0029 ACTUALLY DOES, run against a real Postgres.
-- Every check raises and stops the file if it is wrong. Silence is a pass.
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.want(label text, got text, expected text) returns void language plpgsql as $$
begin
  if got is distinct from expected then
    raise exception 'FAIL: % — got %, wanted %', label, coalesce(got,'<null>'), coalesce(expected,'<null>');
  end if;
  raise notice '  ok   %', label;
end; $$;

-- ---- fixtures -------------------------------------------------------
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');
insert into public.admin_clients (id, name) values ('cccccccc-0000-0000-0000-000000000001', 'Test Client');
insert into public.admin_tasks (id, client_id, name, latest_report, assigned_to, updated_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'Task A', 'a line typed straight on', '11111111-1111-1111-1111-111111111111', now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000001', 'Task B', null, null, now() - interval '30 days');

-- ---- 1. THE BACKFILL ------------------------------------------------
-- 0029 already ran before these rows existed, so run its backfill again the
-- way a second run of the file would.
insert into public.admin_task_updates (task_id, author, body, carried_over, created_at)
select t.id, t.assigned_to, t.latest_report, true, t.updated_at
  from public.admin_tasks t
 where t.latest_report is not null and btrim(t.latest_report) <> ''
   and not exists (select 1 from public.admin_task_updates u where u.task_id = t.id);

select pg_temp.want('the backfill carried the existing line over, once',
  (select count(*)::text from public.admin_task_updates where task_id = 'aaaaaaaa-0000-0000-0000-000000000001'), '1');
select pg_temp.want('...marked as carried over, not as something somebody posted',
  (select carried_over::text from public.admin_task_updates where task_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'true');
select pg_temp.want('...dated to the task, not to now',
  (select (created_at = (select updated_at from public.admin_tasks where id = 'aaaaaaaa-0000-0000-0000-000000000001'))::text
     from public.admin_task_updates where task_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'true');
select pg_temp.want('a task with no line got no row',
  (select count(*)::text from public.admin_task_updates where task_id = 'aaaaaaaa-0000-0000-0000-000000000002'), '0');

-- ---- 2. THE ONE LINE FOLLOWS THE NEWEST UPDATE ----------------------
insert into public.admin_task_updates (id, task_id, author, body, created_at) values
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'half of them are done', now() - interval '2 days');
select pg_temp.want('posting an update becomes the task''s one line',
  (select latest_report from public.admin_tasks where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'half of them are done');

insert into public.admin_task_updates (id, task_id, author, body, created_at) values
  ('dddddddd-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'all of them are done', now());
select pg_temp.want('a newer one replaces it',
  (select latest_report from public.admin_tasks where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'all of them are done');

delete from public.admin_task_updates where id = 'dddddddd-0000-0000-0000-000000000002';
select pg_temp.want('REMOVING THE NEWEST PUTS THE ONE BEFORE IT BACK — not a blank, not the deleted words',
  (select latest_report from public.admin_tasks where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'half of them are done');

-- ---- 3. AN UPDATE THAT MOVES TASK RESYNCS BOTH ----------------------
update public.admin_task_updates set task_id = 'aaaaaaaa-0000-0000-0000-000000000002'
 where id = 'dddddddd-0000-0000-0000-000000000001';
select pg_temp.want('the task it moved TO shows it',
  (select latest_report from public.admin_tasks where id = 'aaaaaaaa-0000-0000-0000-000000000002'), 'half of them are done');
select pg_temp.want('THE TASK IT LEFT falls back to what it still has, rather than keeping a line that moved away',
  (select latest_report from public.admin_tasks where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'a line typed straight on');
update public.admin_task_updates set task_id = 'aaaaaaaa-0000-0000-0000-000000000001'
 where id = 'dddddddd-0000-0000-0000-000000000001';

-- ---- 4. AN EDIT LEAVES A MARK ---------------------------------------
select pg_temp.want('a fresh update is not marked edited',
  (select (edited_at is null)::text from public.admin_task_updates where id = 'dddddddd-0000-0000-0000-000000000001'), 'true');
update public.admin_task_updates set body = 'most of them are done' where id = 'dddddddd-0000-0000-0000-000000000001';
select pg_temp.want('CHANGING THE WORDS STAMPS IT — a rewritten record cannot look untouched',
  (select (edited_at is not null)::text from public.admin_task_updates where id = 'dddddddd-0000-0000-0000-000000000001'), 'true');
select pg_temp.want('...and the task''s line follows the new words',
  (select latest_report from public.admin_tasks where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'most of them are done');
update public.admin_task_updates set edited_at = null where id = 'dddddddd-0000-0000-0000-000000000001';
update public.admin_task_updates set carried_over = false where id = 'dddddddd-0000-0000-0000-000000000001';
select pg_temp.want('touching something that is not the words does not claim an edit',
  (select (edited_at is null)::text from public.admin_task_updates where id = 'dddddddd-0000-0000-0000-000000000001'), 'true');

-- ---- 5. A SALES REP GETS NOTHING ------------------------------------
-- The whole point: admin_tasks is admin-only, so its progress text must be too,
-- or the console has two doors onto the same data with different locks.
insert into public.whoami (uid, role) values ('33333333-3333-3333-3333-333333333333', 'sales');
set role authenticated;
select pg_temp.want('a sales rep reads no tasks (as it always was)',
  (select count(*)::text from public.admin_tasks), '0');
select pg_temp.want('A SALES REP READS NO UPDATES EITHER — the side door is shut',
  (select count(*)::text from public.admin_task_updates), '0');
do $$
begin
  begin
    insert into public.admin_task_updates (task_id, author, body)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'a rep wrote this');
    raise exception 'FAIL: a sales rep was allowed to write an update';
  exception when insufficient_privilege then
    raise notice '  ok   A SALES REP CANNOT WRITE ONE, so cannot reach latest_report through the trigger';
  end;
end $$;
reset role;
select pg_temp.want('...and nothing of theirs landed',
  (select latest_report from public.admin_tasks where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'most of them are done');

-- ---- 6. AN ADMIN CAN, AND ONLY OVER THEIR OWN WORDS -----------------
update public.whoami set uid = '22222222-2222-2222-2222-222222222222', role = 'admin';
set role authenticated;
select pg_temp.want('an admin reads the history', (select count(*)::text from public.admin_task_updates), '2');
insert into public.admin_task_updates (task_id, author, body)
values ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'an admin wrote this');
select pg_temp.want('...and posting sets the line, through the definer function',
  (select latest_report from public.admin_tasks where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'an admin wrote this');
do $$
declare n int;
begin
  update public.admin_task_updates set body = 'rewritten by somebody else'
   where id = 'dddddddd-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: an admin rewrote another person''s update (% rows)', n; end if;
  raise notice '  ok   AN ADMIN CANNOT REWRITE SOMEBODY ELSE''S UPDATE';
end $$;
reset role;
update public.whoami set role = 'owner';
set role authenticated;
do $$
declare n int;
begin
  update public.admin_task_updates set body = 'tidied by an owner'
   where id = 'dddddddd-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: an owner could not tidy the history (% rows)', n; end if;
  raise notice '  ok   an owner can, because somebody has to be able to';
end $$;
reset role;

-- ---- 7. DELETES DO NOT BLOW UP --------------------------------------
delete from public.admin_tasks where id = 'aaaaaaaa-0000-0000-0000-000000000002';
select pg_temp.want('deleting a task takes its updates with it, without erroring on a row already gone',
  (select count(*)::text from public.admin_task_updates where task_id = 'aaaaaaaa-0000-0000-0000-000000000002'), '0');
delete from public.admin_clients where id = 'cccccccc-0000-0000-0000-000000000001';
select pg_temp.want('deleting the client takes the whole lot', (select count(*)::text from public.admin_task_updates), '0');
select pg_temp.want('...and its tasks', (select count(*)::text from public.admin_tasks), '0');

\echo ''
\echo 'ALL 0029 BEHAVIOUR CHECKS PASSED'
