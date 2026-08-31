-- ============================================================
-- 0028 — MORE THAN ONE PERSON ON A TASK
-- ============================================================
-- Mon 31 Aug 2026. Ryder: "make sure two people can be assigned to the same task."
--
-- Notion allowed several people on one task and this console allowed one, so the
-- 31 Aug import had to put the first person on the row and write the others into
-- the brief. That is a name silently demoted to prose, which is the same class of
-- problem as a task handed to somebody who cannot open it.
--
-- THE SHAPE, AND WHY IT IS NOT A JOIN TABLE.
--
-- `admin_tasks.assigned_to` is read in ~30 places — the Work page, the board's
-- grouping, the Operations filters, the AI Brain's context, the assistant's
-- tools, the person timeline, every report. Replacing it with a join table would
-- mean rewriting all of them in one go, and anything missed reads as
-- "Unassigned" while the database says otherwise. That is exactly how the Aug 30
-- dry run lost a task.
--
-- So `assigned_to` STAYS, and it means THE PRIMARY — the one name a single-slot
-- screen shows. A new `assignees` array holds everybody, primary first. Every
-- existing reader keeps working unchanged and simply shows the primary; the
-- screens that should show all of them read the array.
--
-- The two can never disagree, because a trigger below keeps them in step no
-- matter which one a writer sets. There are five writers already (the console,
-- the importer, the assistant's tools, the AI Brain, /api routes) and expecting
-- all five to remember a rule is how the rule gets broken.
--
-- Safe to run twice. One guarded column add, one backfill that only touches rows
-- it has not already touched, one trigger, nothing dropped.

alter table public.admin_tasks
  add column if not exists assignees uuid[] not null default '{}'::uuid[];

comment on column public.admin_tasks.assignees is
  'Everybody on this task, primary first. assigned_to is always assignees[1]; a trigger keeps them in step. Read this for "who is on it", read assigned_to for "whose is it".';

-- Backfill: every task that already has one person gets a one-name array.
-- `assignees = '{}'` guards it, so a second run changes nothing.
update public.admin_tasks
   set assignees = array[assigned_to]
 where assigned_to is not null
   and assignees = '{}'::uuid[];

-- Containment queries ("tasks where I am one of the people") need a GIN index,
-- or the Work page table-scans admin_tasks on every load.
create index if not exists admin_tasks_assignees_idx
  on public.admin_tasks using gin (assignees);

-- ------------------------------------------------------------
-- THE ONE RULE, ENFORCED IN THE DATABASE
-- ------------------------------------------------------------
-- Whichever field a writer touches, both end up true:
--   * the array is de-duplicated and has no nulls
--   * assigned_to is the first name in the array
--   * assigned_to always appears IN the array
--   * clearing assigned_to clears the array, and emptying the array clears
--     assigned_to — "unassigned" means the same thing on both.
create or replace function public.admin_tasks_sync_assignees()
returns trigger
language plpgsql
as $$
declare
  cleaned uuid[];
begin
  -- Strip nulls and duplicates while KEEPING ORDER. array_agg(distinct ...)
  -- would sort them, and the order is what decides who the primary is.
  select coalesce(array_agg(x order by ord), '{}'::uuid[])
    into cleaned
    from (
      select x, min(ord) as ord
        from unnest(coalesce(new.assignees, '{}'::uuid[])) with ordinality as t(x, ord)
       where x is not null
       group by x
    ) d;

  if tg_op = 'UPDATE'
     and new.assigned_to is distinct from old.assigned_to
     and new.assignees is not distinct from old.assignees then
    -- Somebody set the single field only (an old screen, or the assistant).
    -- The primary changes; anybody else already on the task stays on it.
    if new.assigned_to is null then
      cleaned := '{}'::uuid[];
    else
      cleaned := array[new.assigned_to] || array_remove(cleaned, new.assigned_to);
    end if;
  end if;

  new.assignees := cleaned;
  new.assigned_to := case when array_length(cleaned, 1) is null then null else cleaned[1] end;
  return new;
end;
$$;

drop trigger if exists admin_tasks_assignees_sync on public.admin_tasks;
create trigger admin_tasks_assignees_sync
  before insert or update on public.admin_tasks
  for each row execute function public.admin_tasks_sync_assignees();

-- Re-assert the grants this table already had. A lost GRANT has broken two
-- pages in two days on this project; adding a column is a cheap moment to be
-- sure. Nothing here widens access — RLS still decides every row.
grant select, insert, update, delete on public.admin_tasks to authenticated;
