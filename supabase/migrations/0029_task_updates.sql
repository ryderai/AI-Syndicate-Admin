-- ============================================================
-- 0029 — A TASK KEEPS ITS UPDATES
-- ============================================================
-- Tue 2 Sep 2026. Ryder: "adding reports and all that needs to be seamless
-- through here so that the operations and all work all fit together
-- seamlessly. we can't have any gaps or missing info."
--
-- WHAT WAS MISSING.
--
-- `admin_tasks.latest_report` (0001) is one line — "12 of 26 pages done." It is
-- the sentence the Operations table and the Work page show under a task. It is
-- OVERWRITTEN every time the work moves, so the sentence from last week is gone
-- the moment this week's is typed. Every weekly report, every recap to CJ, and
-- every "what did we actually do on this" has therefore been rebuilt by hand
-- from memory and from chat history. That is the gap.
--
-- THE SHAPE, AND WHY latest_report STAYS.
--
-- Same rule as 0028. `latest_report` is read in the Operations table, the board
-- card, the Work page row, the client page, the AI Brain's context, the
-- assistant's tools and the report generators. Replacing it would mean
-- rewriting all of them in one go, and anything missed would show a blank where
-- the database has a sentence.
--
-- So `latest_report` STAYS and now means THE NEWEST UPDATE. A new table holds
-- every update with its date and its author, and a trigger keeps the task's one
-- line equal to the newest row. Every existing reader keeps working untouched
-- and simply shows the newest update; the screens that should show the history
-- read the table.
--
-- WRITING DIRECTLY TO latest_report STILL WORKS. A console running ahead of
-- this migration, the importer, the assistant and the AI Brain all set the
-- field directly, and they still can. Nothing here forbids it — the trigger
-- only fires when an UPDATE ROW is written, so a hand-set line is left exactly
-- as it was typed.
--
-- Safe to run twice. One guarded create, one backfill that only touches tasks
-- with no updates yet, one trigger, nothing dropped, no column removed.

-- ------------------------------------------------------------
-- THE TABLE
-- ------------------------------------------------------------
-- NO client_id ON PURPOSE. The task already carries the client, and the
-- cascade below reaches these rows through it. A second client_id here would
-- be a second place for "whose is this" to be wrong, and it would put this
-- table on the client-delete warning screen for no gain — `tests/client-delete`
-- reads the migrations and requires every table with a client_id to be named
-- there.
create table if not exists public.admin_task_updates (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.admin_tasks on delete cascade,
  author uuid references auth.users,                  -- null = written before we knew, or by a job
  body text not null,
  -- true = this row was made by the backfill below out of a latest_report that
  -- already existed. Its date is the task's updated_at, which is the only date
  -- that ever existed for it. The screen says so rather than showing a made-up
  -- posting time as if somebody typed it then.
  carried_over boolean not null default false,
  created_at timestamptz not null default now(),
  -- Set by a trigger whenever `body` changes after the row was written. An
  -- update is a record of what somebody said and a client report gets built on
  -- it; a sentence that can be rewritten with no trace is worse than none, so
  -- the screen shows "edited" beside any row that has been.
  edited_at timestamptz
);

-- `create table if not exists` above does nothing on a database that already
-- has the table, so a column added later needs its own guarded add or a second
-- run of this file would silently skip it. Same reason 0012 and 0028 are shaped
-- this way.
alter table public.admin_task_updates
  add column if not exists edited_at timestamptz;

comment on table public.admin_task_updates is
  'Every progress update ever written on a task, newest last. admin_tasks.latest_report is always the newest row body; a trigger keeps them in step.';
comment on column public.admin_task_updates.carried_over is
  'This update was made by migration 0029 from a latest_report that already existed. Its created_at is the task updated_at, not a real posting time.';

-- "The updates on this task, newest first" is the only query this table has.
create index if not exists admin_task_updates_task_idx
  on public.admin_task_updates(task_id, created_at desc);

-- ------------------------------------------------------------
-- THE BACKFILL — no task loses the line it already had
-- ------------------------------------------------------------
-- Every task that has a latest_report and no updates gets one carried-over row.
-- Without this, opening a task written before today would show an empty history
-- next to a status line, which reads as "nobody ever reported on this".
--
-- The date is the task's updated_at, NOT now(). A timestamp captured at a
-- different moment than the write it describes is a lie the screen would then
-- repeat, and `carried_over` is what lets the screen say which it is.
insert into public.admin_task_updates (task_id, author, body, carried_over, created_at)
select t.id, t.assigned_to, t.latest_report, true, t.updated_at
  from public.admin_tasks t
 where t.latest_report is not null
   and btrim(t.latest_report) <> ''
   and not exists (select 1 from public.admin_task_updates u where u.task_id = t.id);

-- ------------------------------------------------------------
-- THE ONE RULE, ENFORCED IN THE DATABASE
-- ------------------------------------------------------------
-- The task's one line is the newest update's body. Whichever of the five
-- writers posts an update, the table, the board, the Work page and every report
-- read the same sentence — none of them has to remember to also set the field.
--
-- SECURITY DEFINER, and the door it opens is closed by the policies below.
--
-- It exists so the write-back can never be filtered out by RLS and affect zero
-- rows WITHOUT an error, which would leave the task's one line quietly
-- disagreeing with its newest update — the exact two-places-to-be-wrong this
-- migration exists to prevent.
--
-- What it can do is set `latest_report`, on the one task an update names, to
-- the body of that task's newest update. Nothing else. And the only way to
-- reach it is to write a row into `admin_task_updates`, which the policies at
-- the bottom of this file allow to admins only — the same people `admin_tasks`
-- already lets write that field directly.
create or replace function public.admin_task_updates_sync_latest()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
begin
  -- On INSERT there is no OLD row, so read the one that exists.
  tid := case when tg_op = 'INSERT' then new.task_id else old.task_id end;
  perform public.admin_task_updates_resync(tid);

  -- BOTH TASKS, not just the new one. Moving an update from one task to another
  -- is one statement away for anybody who can edit it, and resyncing only the
  -- destination leaves the source task showing a sentence that is no longer on
  -- it. The rule is in the database so it cannot be gone around; a rule with a
  -- hole in it is a rule the next person will find by accident.
  if tg_op = 'UPDATE' and new.task_id is distinct from old.task_id then
    perform public.admin_task_updates_resync(new.task_id);
  end if;
  return coalesce(new, old);
end;
$$;

-- The write-back itself, for one task.
create or replace function public.admin_task_updates_resync(tid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  newest text;
begin
  if tid is null then return; end if;

  -- On a cascade delete the task row is already gone in this transaction, so
  -- there is nothing to write back to — and trying would touch a row Postgres
  -- is in the middle of deleting.
  if not exists (select 1 from public.admin_tasks where id = tid) then return; end if;

  select u.body into newest
    from public.admin_task_updates u
   where u.task_id = tid
   order by u.created_at desc, u.id desc
   limit 1;

  -- `is distinct from` and not `<>`: null and a sentence are different, and
  -- `null <> 'x'` is null, which would skip the write.
  update public.admin_tasks
     set latest_report = newest
   where id = tid
     and latest_report is distinct from newest;
end;
$$;

-- Rewriting a dated entry leaves a mark. The console sets nothing here; the
-- database does, so an edit made any other way is stamped too.
create or replace function public.admin_task_updates_stamp_edit()
returns trigger
language plpgsql
as $$
begin
  if new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists admin_task_updates_edit_stamp on public.admin_task_updates;
create trigger admin_task_updates_edit_stamp
  before update on public.admin_task_updates
  for each row execute function public.admin_task_updates_stamp_edit();

drop trigger if exists admin_task_updates_latest on public.admin_task_updates;
create trigger admin_task_updates_latest
  after insert or update or delete on public.admin_task_updates
  for each row execute function public.admin_task_updates_sync_latest();

-- ------------------------------------------------------------
-- GRANTS + ROW LEVEL SECURITY
-- ------------------------------------------------------------
-- ADMINS, exactly like `admin_tasks` itself.
--
-- 0001 gates admin_tasks with `admin_is_admin()` under the note "sales reps have
-- no business in client ops". These rows ARE client ops — they are the progress
-- text on those same tasks — so gating them on `admin_is_member()` would hand a
-- sales rep, through a side door, the reading and writing that the front door
-- refuses. A second door onto the same data is the rule this console keeps
-- having to relearn: count the doors.
--
-- On top of that, only the AUTHOR (or an owner) may change or remove an entry.
-- An update is a record of what somebody said and a client report is built on
-- it; a history anybody can rewrite is worse than none.
grant select, insert, update, delete on public.admin_task_updates to authenticated;

alter table public.admin_task_updates enable row level security;

drop policy if exists "members read task updates" on public.admin_task_updates;
create policy "members read task updates" on public.admin_task_updates
  for select using (public.admin_is_admin());

drop policy if exists "members write task updates" on public.admin_task_updates;
create policy "members write task updates" on public.admin_task_updates
  for insert with check (public.admin_is_admin() and author = auth.uid());

drop policy if exists "authors edit task updates" on public.admin_task_updates;
create policy "authors edit task updates" on public.admin_task_updates
  for update
  using (public.admin_is_admin() and (author = auth.uid() or public.admin_is_owner()))
  with check (public.admin_is_admin() and (author = auth.uid() or public.admin_is_owner()));

drop policy if exists "authors delete task updates" on public.admin_task_updates;
create policy "authors delete task updates" on public.admin_task_updates
  for delete using (public.admin_is_admin() and (author = auth.uid() or public.admin_is_owner()));

-- Re-assert what admin_tasks already had. A lost GRANT has broken two pages on
-- this project; a migration that adds a trigger writing to the table is a cheap
-- moment to be sure. Nothing here widens access — RLS still decides every row.
grant select, insert, update, delete on public.admin_tasks to authenticated;
