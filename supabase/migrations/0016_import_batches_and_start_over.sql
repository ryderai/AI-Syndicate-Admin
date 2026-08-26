-- AI Syndicate ADMIN console — IMPORT BATCHES, AND STARTING OVER.  Aug 25 2026
-- SAFE TO RUN ON THE SHARED (PLATFORM) PROJECT.
--
--   * Needs 0009 (the sales tables). Independent of everything else.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--   * Re-running this file is safe. Every statement is guarded.
--
-- WHY THIS EXISTS
-- Ryder, Aug 25 2026: "i cant have the real google sheet messed up at all, then
-- when we actually start using the admin then i want to delete all that data and
-- import the list fresh again so that everything is up to date."
--
-- The first half is already true and always was: the importer reads a
-- DOWNLOADED copy of the spreadsheet and nothing in this console has ever
-- written a single cell back to Google. There is no code path to Google Sheets
-- at all.
--
-- The second half did not exist. There was no way to undo an import, so a test
-- run and the real thing would have piled up in the same pipeline.
--
-- THE RULE THIS WHOLE FILE IS SHAPED BY
-- This is the only thing in the console that deletes in bulk. So the count a
-- person is shown and the rows that actually go MUST come from the same
-- statement. On Aug 22 the importer printed "412 already in the pipeline · 412
-- rows dropped" and then imported all 412, because the screen read one value
-- and the write path read another. The same mistake here deletes somebody's
-- work. `admin_clear_import` therefore builds ONE list of ids and either counts
-- it or deletes it — the dry run and the real run cannot disagree.

-- ============================================================
-- 1. AN IMPORT IS A THING THAT HAPPENED
-- ============================================================
-- One row per press of Import. Without this, "undo that import" has nothing to
-- aim at: a list can be imported into twice, and rows can be added to it by
-- hand afterwards, so a list is not the same thing as an import run.

create table if not exists public.admin_import_batches (
  id uuid primary key default gen_random_uuid(),

  label text not null,                    -- what the person called it
  source_file text,                       -- the file name, exactly as it was picked
  tabs text[],                            -- which tabs of it were used
  -- What the import screen said it was going to do. Kept so a clear-out can be
  -- checked against what arrived, rather than against a memory of it.
  counts jsonb not null default '{}'::jsonb,

  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),

  -- Set when this batch is cleared. The batch row itself is NEVER deleted:
  -- "we imported 451 rows on Aug 25 and cleared them on Sep 2" is a fact worth
  -- keeping long after the rows are gone.
  cleared_at timestamptz,
  cleared_by uuid references auth.users on delete set null,
  cleared_counts jsonb
);

create index if not exists admin_import_batches_idx on public.admin_import_batches (created_at desc);

alter table public.admin_leads add column if not exists import_batch_id uuid references public.admin_import_batches on delete set null;
alter table public.admin_companies add column if not exists import_batch_id uuid references public.admin_import_batches on delete set null;
alter table public.admin_lead_lists add column if not exists import_batch_id uuid references public.admin_import_batches on delete set null;

create index if not exists admin_leads_batch_idx on public.admin_leads (import_batch_id) where import_batch_id is not null;
create index if not exists admin_companies_batch_idx on public.admin_companies (import_batch_id) where import_batch_id is not null;

-- ============================================================
-- 2. WHAT COUNTS AS "IMPORTED"
-- ============================================================
-- A contact somebody typed into the console by hand is NOT test data, even if
-- it sits in an imported list. `source` is set at insert and never changed, so
-- it is the honest test. 'manual', 'referral' and 'inbound' are people we met;
-- they are never cleared, whatever else is asked for.

create or replace function public.admin_lead_is_imported(p_source text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p_source, '') in ('sheet', 'csv', 'import', 'scraper');
$$;

revoke execute on function public.admin_lead_is_imported(text) from anon, public;
grant execute on function public.admin_lead_is_imported(text) to authenticated;

-- ============================================================
-- 3. STARTING OVER
-- ============================================================
-- Scope is exactly ONE of: a batch, a list, or everything that was imported.
-- Passing none, or more than one, raises — a delete that guesses its own scope
-- is the worst possible kind.
--
-- WHAT IT WILL NEVER DELETE, whatever it is asked:
--   1. A contact who is linked to a client, or flagged as a customer. The
--      whole point of migration 0015 is that their history follows them.
--   2. A contact carrying a proposal that is past draft. Somebody sent that.
--   3. A contact added by hand (source manual/referral/inbound).
--   4. A contact somebody has actually WORKED IN THE CONSOLE — a logged call,
--      email, text, LinkedIn touch or note. The import writes one 'import' row
--      per contact, and that one does not count; anything else means a person
--      did something here and it is not test data any more.
--   5. A firm that is a client, or that still has contacts after the delete.
--
-- Every one of those is COUNTED AND NAMED in the result, never dropped
-- silently. "Nothing happened" and "we refused to touch 12 of them" look
-- identical otherwise.

-- `p_expect_leads` is what the person was SHOWN. Pass it on the real run and
-- the function refuses if the answer has changed since the preview.
--
-- Without it the promise on the screen — "what you are reading is what will go"
-- — was false, and a reviewer proved it: the preview and the delete are two
-- separate transactions, so another session inserting rows between them meant
-- the button said "Delete 1 contact" and four went. The Aug 22 failure this
-- whole file is written against is exactly that, screen number != write number;
-- moving it from two code paths to two transactions does not make it not that.
create or replace function public.admin_clear_import(
  p_batch uuid default null,
  p_list uuid default null,
  p_all_imported boolean default false,
  p_dry_run boolean default true,
  p_expect_leads int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
-- Scoped to this call only. The `drop table if exists pg_temp.…` guards below
-- are correct and noisy; without this every clear-out prints five NOTICE lines
-- into the caller's log, which trains people to skim what a delete says.
set client_min_messages = 'warning'
as $$
declare
  v_scopes int := (case when p_batch is not null then 1 else 0 end)
                + (case when p_list  is not null then 1 else 0 end)
                + (case when p_all_imported then 1 else 0 end);
  v_actor uuid := auth.uid();
  v_del_leads int := 0;
  v_del_companies int := 0;
  v_del_lists int := 0;
  v_kept jsonb;
  v_result jsonb;
begin
  -- Only an owner or an admin. A rep who mis-clicks should lose an afternoon,
  -- not a list — the same rule the delete policies in 0009 already follow.
  if not public.admin_is_admin() then
    raise exception 'only an owner or admin can clear an import';
  end if;

  if v_scopes = 0 then
    raise exception 'nothing to clear: name an import, a list, or ask for everything imported';
  end if;
  if v_scopes > 1 then
    raise exception 'clear one thing at a time: an import, a list, or everything imported';
  end if;

  -- ---- ONE list of ids. Everything below reads from these tables, so the
  -- ---- number reported and the rows removed cannot come apart.
  --
  -- EVERY ONE OF THESE IS SCHEMA-QUALIFIED TO pg_temp, AND THAT IS NOT TIDINESS.
  --
  -- `search_path` on this function is `public`, and on the FIRST call in a
  -- session the temp schema does not exist yet — so a bare
  -- `drop table if exists _clear_candidates` resolved to
  -- `public._clear_candidates` and dropped it, as the definer, with the NOTICE
  -- suppressed by the setting above. A DRY RUN could destroy a real table in
  -- public, on a file whose header says it is safe to run on the shared
  -- project. Found by a reviewer who built the table and watched it disappear.
  --
  -- Dropped at all (rather than relying on `on commit drop`) because two calls
  -- inside ONE transaction must both work; PostgREST gives each RPC its own
  -- transaction, but tests/start-over/sql.sh calls it twice in one and so could
  -- any future caller.
  drop table if exists pg_temp._clear_candidates;
  drop table if exists pg_temp._clear_keep;
  drop table if exists pg_temp._clear_go;
  drop table if exists pg_temp._clear_companies;
  drop table if exists pg_temp._clear_companies_kept;
  drop table if exists pg_temp._clear_lists;

  create temporary table _clear_candidates on commit drop as
    select l.id, l.company_id, l.list_id, l.name, l.company, l.stage, l.source,
           l.client_id, l.became_customer
    from public.admin_leads l
    where (p_batch is null or l.import_batch_id = p_batch)
      and (p_list  is null or l.list_id = p_list)
      and (not p_all_imported or public.admin_lead_is_imported(l.source));

  create temporary table _clear_keep on commit drop as
    select c.id,
           case
             when c.client_id is not null or coalesce(c.became_customer, false)
               then 'they are a paying client'
             when not public.admin_lead_is_imported(c.source)
               then 'added by hand, not imported'
             when exists (
               select 1 from public.admin_proposals p
               where p.lead_id = c.id and p.status <> 'draft'
             ) then 'a proposal has gone out'
             -- ANYTHING THE IMPORT DID NOT WRITE ITSELF.
             --
             -- This used to list five types — call, email, text, linkedin,
             -- note — and it was close to theatre. Claiming a lead writes
             -- `claim`. Moving it to Meeting writes `status_change`, and the
             -- body of that row is where a rep types "booked Thursday 2pm,
             -- they want the GEO package". Neither was on the list, so a
             -- claimed lead at Meeting stage with the booking written on it was
             -- deleted while the dialog said "0 will be left exactly where they
             -- are". Found by a reviewer.
             --
             -- The import writes exactly ONE row per contact, of type 'import'
             -- (salesImport.jsx#stampImportNote). So the honest test is: is
             -- there anything else? Anything else means a person did something
             -- in here, whatever kind of something it was.
             when exists (
               select 1 from public.admin_lead_activity a
               where a.lead_id = c.id and a.type <> 'import'
             ) then 'somebody has worked them in here'
             else null
           end as why
    from _clear_candidates c;

  select coalesce(jsonb_object_agg(why, n), '{}'::jsonb) into v_kept
  from (
    select why, count(*) as n from _clear_keep where why is not null group by why
  ) k;

  create temporary table _clear_go on commit drop as
    select c.id, c.company_id, c.list_id
    from _clear_candidates c
    join _clear_keep k on k.id = c.id
    where k.why is null;

  -- Firms that would be left with nobody, are not clients, AND CAME IN ON AN
  -- IMPORT THEMSELVES.
  --
  -- That last condition was missing, and it meant a firm somebody built by hand
  -- — its typed address, its site score — was deleted the moment an import's
  -- contacts were cleared out of it. Inside the stated guarantee, which was the
  -- problem: the guarantee was narrower than the work it destroyed. A firm with
  -- no batch on it (built by hand, or imported before this migration existed)
  -- is now left standing with nobody at it, and COUNTED so the screen can say
  -- so rather than leaving it to be found.
  create temporary table _clear_companies on commit drop as
    select distinct co.id
    from public.admin_companies co
    where co.client_id is null
      and co.import_batch_id is not null
      and co.id in (select company_id from _clear_go where company_id is not null)
      and not exists (
        select 1 from public.admin_leads l
        where l.company_id = co.id
          and l.id not in (select id from _clear_go)
      );

  create temporary table _clear_companies_kept on commit drop as
    select distinct co.id
    from public.admin_companies co
    where co.id in (select company_id from _clear_go where company_id is not null)
      and co.id not in (select id from _clear_companies)
      and not exists (
        select 1 from public.admin_leads l
        where l.company_id = co.id
          and l.id not in (select id from _clear_go)
      );

  create temporary table _clear_lists on commit drop as
    select distinct li.id
    from public.admin_lead_lists li
    where li.id in (select list_id from _clear_go where list_id is not null)
      and not exists (
        select 1 from public.admin_leads l
        where l.list_id = li.id
          and l.id not in (select id from _clear_go)
      );

  select count(*) into v_del_leads from _clear_go;
  select count(*) into v_del_companies from _clear_companies;
  select count(*) into v_del_lists from _clear_lists;

  v_result := jsonb_build_object(
    'dry_run', p_dry_run,
    'leads', v_del_leads,
    'companies', v_del_companies,
    'lists', v_del_lists,
    'kept', coalesce(v_kept, '{}'::jsonb),
    'kept_total', (select count(*) from _clear_keep where why is not null),
    'considered', (select count(*) from _clear_candidates)
  );

  v_result := v_result || jsonb_build_object(
    'companies_kept', (select count(*) from _clear_companies_kept));

  if p_dry_run then
    return v_result;
  end if;

  -- The count the person was shown, checked against the count now. Refusing is
  -- the whole point: they agreed to delete a number, and this is no longer that
  -- number. Ask again and they can agree to the new one.
  if p_expect_leads is not null and p_expect_leads <> v_del_leads then
    raise exception 'this changed while you were looking at it: you were shown % contacts and there are now %. Nothing was deleted — look again.',
      p_expect_leads, v_del_leads;
  end if;

  -- Deleting a lead takes its timeline and its proposals with it (both cascade,
  -- 0001 and 0009). Anything a person can still reach afterwards — an inbox
  -- thread, an AI note — only loses the link, by design.
  delete from public.admin_leads where id in (select id from _clear_go);
  delete from public.admin_companies where id in (select id from _clear_companies);
  delete from public.admin_lead_lists where id in (select id from _clear_lists);

  if p_batch is not null then
    update public.admin_import_batches
      set cleared_at = now(), cleared_by = v_actor, cleared_counts = v_result
      where id = p_batch;
  elsif p_all_imported then
    -- Everything imported is gone, so every batch that still had rows is spent.
    update public.admin_import_batches
      set cleared_at = coalesce(cleared_at, now()),
          cleared_by = coalesce(cleared_by, v_actor)
      where cleared_at is null;
  end if;

  -- On the record, on the page everybody reads. A bulk delete with no trace is
  -- how a team stops trusting a tool.
  insert into public.admin_activity_log (actor, kind, title, body)
  values (
    v_actor, 'import_cleared',
    'Cleared ' || v_del_leads || ' imported contact' || case when v_del_leads = 1 then '' else 's' end,
    'Also removed ' || v_del_companies || ' firm' || case when v_del_companies = 1 then '' else 's' end
      || ' left with nobody and ' || v_del_lists || ' empty list'
      || case when v_del_lists = 1 then '' else 's' end || '. '
      || 'Kept ' || (select count(*) from _clear_keep where why is not null)
      || ' that were not test data.'
  );

  return v_result;
end;
$$;

-- The old four-argument shape is dropped, not left beside the new one: two
-- overloads means a caller that misses the new argument silently gets the
-- version with no safety check on it.
drop function if exists public.admin_clear_import(uuid, uuid, boolean, boolean);
revoke execute on function public.admin_clear_import(uuid, uuid, boolean, boolean, int) from anon, public;
grant execute on function public.admin_clear_import(uuid, uuid, boolean, boolean, int) to authenticated;

-- ============================================================
-- 4. A MEMORY SOMEBODY TYPED MUST OUTLIVE THE ROW IT WAS ABOUT
-- ============================================================
-- `admin_brain_memory.lead_id` was `on delete cascade` (0006). So clearing an
-- import silently destroyed confirmed, human-written memories attached to those
-- contacts — "never call before 10am, ask for Marta not Dan" — with nothing
-- counting them, nothing warning about them, and no way to get them back. The
-- comment in this very file said an AI note and an inbox thread only lose their
-- link "by design"; both of those were already `set null`, and the one that
-- actually cascaded was the one nobody had checked.
--
-- The memory keeps its text and loses its link, exactly like the other two. A
-- memory about a contact who is gone is still worth something; a deleted one is
-- worth nothing.
alter table public.admin_brain_memory drop constraint if exists admin_brain_memory_lead_id_fkey;
alter table public.admin_brain_memory
  add constraint admin_brain_memory_lead_id_fkey
  foreign key (lead_id) references public.admin_leads (id) on delete set null;

-- ============================================================
-- 5. GRANTS + ROW LEVEL SECURITY
-- ============================================================

grant select, insert, update on public.admin_import_batches to authenticated;
grant delete on public.admin_import_batches to authenticated;

alter table public.admin_import_batches enable row level security;

drop policy if exists "members read import batches" on public.admin_import_batches;
create policy "members read import batches" on public.admin_import_batches
  for select using (public.admin_is_member());
drop policy if exists "members write import batches" on public.admin_import_batches;
create policy "members write import batches" on public.admin_import_batches
  for insert with check (public.admin_is_member());
drop policy if exists "members update import batches" on public.admin_import_batches;
create policy "members update import batches" on public.admin_import_batches
  for update using (public.admin_is_member());
drop policy if exists "admins delete import batches" on public.admin_import_batches;
create policy "admins delete import batches" on public.admin_import_batches
  for delete using (public.admin_is_admin());
