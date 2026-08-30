-- ============================================================
-- 0026 — REPAIR THE FUNCTION GRANTS.  Aug 30 2026
-- ============================================================
-- Ryder, 30 Aug 2026, on the Start over screen:
--   "permission denied for function admin_clear_import"
--
-- WHAT HAPPENED
-- Every one of these functions has a `grant execute … to authenticated` line
-- in the migration that created it. The FILES are right. The DATABASE is not:
-- at least one of those grants never actually ran.
--
-- The shape of the failure says which half ran. Each migration does two
-- adjacent statements — `revoke execute … from anon, public`, then
-- `grant execute … to authenticated`. A missing FUNCTION gives "could not find
-- the function"; a missing GRANT gives "permission denied for function", which
-- is what the screen said. So the revoke landed and the grant did not, and the
-- console has been left holding a function nobody signed in is allowed to call.
--
-- This is the SECOND time this exact thing has broken a page. On 29 Aug it was
-- `admin_is_member`, and the whole console said "you are not on the team" for
-- an hour. One lost GRANT, twice, on two different functions. So this file does
-- not fix one function — it re-asserts every grant the console depends on, and
-- it is safe to run again any time a permission error turns up.
--
-- IT CANNOT BREAK ANYTHING.
--   · It grants. It does not revoke, drop, alter or delete.
--   · Granting a privilege that is already there is a no-op.
--   · Every statement is guarded by `to_regprocedure`, so a function that does
--     not exist on this database is SKIPPED and named at the end, instead of
--     throwing and stopping the file half way — which is the most likely way
--     the original grants were lost in the first place.
--   · It touches no table and no row. Your 3,663 contacts are not involved.

do $$
declare
  -- Every function the browser or an API route calls by name, with the exact
  -- argument types it is defined with. `to_regprocedure` returns null when the
  -- signature does not exist, which is how a missing one is skipped rather
  -- than fatal.
  fns text[] := array[
    'public.admin_is_member()',
    'public.admin_is_admin()',
    'public.admin_is_owner()',
    'public.admin_can_work_lead(uuid)',
    'public.admin_clear_import(uuid, uuid, boolean, boolean, int)',
    'public.admin_client_contacts(uuid)',
    'public.admin_company_name_key(text)',
    'public.admin_lead_claim_text(uuid, int)',
    'public.admin_lead_dedupe_key(text, text, text, text, text)',
    'public.admin_lead_is_imported(text)',
    'public.admin_lead_to_client(uuid, uuid, text)'
  ];
  fn text;
  missing text[] := '{}';
  fixed int := 0;
begin
  foreach fn in array fns loop
    if to_regprocedure(fn) is null then
      missing := missing || fn;
      continue;
    end if;
    execute format('grant execute on function %s to authenticated', fn);
    fixed := fixed + 1;
  end loop;

  raise notice 'Granted execute to authenticated on % function(s).', fixed;
  if array_length(missing, 1) is not null then
    raise notice 'NOT FOUND on this database (nothing was granted for these): %',
      array_to_string(missing, ', ');
  else
    raise notice 'Every function was found. Nothing is missing.';
  end if;
end $$;

-- ============================================================
-- WHAT IT LOOKS LIKE NOW
-- ============================================================
-- Run this on its own afterwards to see the answer in a table. Every row
-- should read `t` under can_execute. A row reading `f` is still broken; a
-- function missing from the list does not exist on this database.
select
  p.proname                                             as function,
  pg_get_function_identity_arguments(p.oid)             as arguments,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'admin_is_member', 'admin_is_admin', 'admin_is_owner',
    'admin_can_work_lead', 'admin_clear_import', 'admin_client_contacts',
    'admin_company_name_key', 'admin_lead_claim_text',
    'admin_lead_dedupe_key', 'admin_lead_is_imported', 'admin_lead_to_client'
  )
order by p.proname;
