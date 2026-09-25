-- ============================================================================
-- 0042 — THE AI ROLLUP ALSO COUNTS CACHE-WRITE TOKENS. 24 Sep 2026.
--
-- Ryder: "for ai cost can we make it all based off of token usage. no need
-- for ai cost yet in dollars." The AI Cost page now leads with tokens:
--   tokens in  = input_tokens + cache_write_tokens  (a cache write is new
--                input the model read in full, stored for later)
--   tokens out = output_tokens
-- 0041's admin_ai_cost_rollup summed input, output and cache READS but not
-- cache WRITES, so heavily cached Anthropic calls would read short.
--
-- Same name, same arguments, same one-jsonb-value return (so PostgREST's
-- 1,000-row cap still cannot cut it) — only one field is added. Safe to run
-- more than once; safe to run before or after the new code is deployed (the
-- page treats a missing cache_write_tokens as 0).
-- ============================================================================

create or replace function public.admin_ai_cost_rollup(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  -- The service key has no auth.uid(); it is only ever used by the server,
  -- which has already checked the caller is an owner.
  if coalesce(auth.role(), '') <> 'service_role' and not public.admin_is_owner() then
    raise exception 'owners only' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(g), '[]'::jsonb) into result
  from (
    select
      (e.ts at time zone 'America/Chicago')::date as day,
      e.provider as provider,
      e.model as model,
      e.workspace_id as workspace_id,
      e.client_id as client_id,
      coalesce(
        nullif(btrim(e.platform_feature), ''),
        nullif(btrim(e.meta->>'feature_name'), ''),
        nullif(btrim(e.meta->>'entry'), ''),
        case when e.feature is not null and e.feature <> 'other' then 'console · ' || e.feature end
      ) as job,
      e.surface as surface,
      e.status as status,
      e.source as source,
      count(*) as calls,
      count(e.cost_micros) filter (where e.billable) as priced_calls,
      coalesce(sum(e.cost_micros) filter (where e.billable), 0) as cost_micros,
      count(*) filter (where not e.billable) as nonbillable_calls,
      coalesce(sum(e.input_tokens), 0) as input_tokens,
      coalesce(sum(e.output_tokens), 0) as output_tokens,
      coalesce(sum(e.cache_write_tokens), 0) as cache_write_tokens,
      coalesce(sum(e.cache_read_tokens), 0) as cache_read_tokens,
      min(e.ts) as first_ts,
      max(e.ts) as last_ts
    from public.admin_usage_events e
    where e.ts >= p_from and e.ts < p_to
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9
  ) g;
  return result;
end;
$$;
revoke execute on function public.admin_ai_cost_rollup(timestamptz, timestamptz) from anon, public;
grant execute on function public.admin_ai_cost_rollup(timestamptz, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
