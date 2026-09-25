-- ==========================================================================
-- 0043 — THE AI ROLLUP SAYS WHY A REQUEST FAILED, HOW LONG IT TOOK, AND THE
-- EXTRAS ANDREW'S METER NOW RECORDS. 25 Sep 2026.
--
-- Andrew (25 Sep): "Let's see if we can go in even more detail." Ryder: go a
-- little deeper, still understandable, "so we can hone in on usage and see
-- exactly what the issues are."
--
-- Added to every group:
--   reason          'ok' for a request that worked; otherwise the AI company's
--                   answer code ('429', '401', '400', '403', '5xx'…), or
--                   'timeout' (we stopped waiting), or the meter's own label
--                   (meta.wasted), or 'unknown'. The page turns these into
--                   plain English. It is a GROUP column, so failed requests
--                   split by cause; working requests stay one group.
--   wait_ms         total time spent waiting on the AI company (latency_ms)
--   reasoning_tokens hidden "thinking" tokens, where the company reports them
--                   (meta.reasoning_tokens, recorded since 23 Sep)
--   web_searches    web searches the AI ran for us (meta.web_search_requests)
--   cut_off_calls / cut_off_tokens  answers that were cut off mid-way
--                   (meta.wasted = 'cut_off') — tokens paid for, answer lost
--
-- Same name, same arguments, same one-jsonb-value return (PostgREST's
-- 1,000-row cap still cannot cut it). Safe to run more than once, and before
-- or after the new page is deployed (the page treats missing fields as 0).
-- ==========================================================================

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
      case
        when e.status = 'ok' or e.status = 'legacy' then 'ok'
        when nullif(btrim(e.meta->>'http_status'), '') is not null then btrim(e.meta->>'http_status')
        when e.meta->>'wasted' = 'network_error' or e.meta->>'error' ilike '%timeout%' or e.meta->>'error' ilike '%abort%' then 'timeout'
        when nullif(btrim(e.meta->>'wasted'), '') is not null then btrim(e.meta->>'wasted')
        else 'unknown'
      end as reason,
      count(*) as calls,
      count(e.cost_micros) filter (where e.billable) as priced_calls,
      coalesce(sum(e.cost_micros) filter (where e.billable), 0) as cost_micros,
      count(*) filter (where not e.billable) as nonbillable_calls,
      coalesce(sum(e.input_tokens), 0) as input_tokens,
      coalesce(sum(e.output_tokens), 0) as output_tokens,
      coalesce(sum(e.cache_write_tokens), 0) as cache_write_tokens,
      coalesce(sum(e.cache_read_tokens), 0) as cache_read_tokens,
      coalesce(sum(e.latency_ms), 0) as wait_ms,
      coalesce(sum(case when e.meta->>'reasoning_tokens' ~ '^[0-9]+$' then (e.meta->>'reasoning_tokens')::bigint end), 0) as reasoning_tokens,
      coalesce(sum(case when e.meta->>'web_search_requests' ~ '^[0-9]+$' then (e.meta->>'web_search_requests')::bigint end), 0) as web_searches,
      count(*) filter (where e.meta->>'wasted' = 'cut_off') as cut_off_calls,
      coalesce(sum(coalesce(e.input_tokens, 0) + coalesce(e.cache_write_tokens, 0) + coalesce(e.output_tokens, 0)) filter (where e.meta->>'wasted' = 'cut_off'), 0) as cut_off_tokens,
      min(e.ts) as first_ts,
      max(e.ts) as last_ts
    from public.admin_usage_events e
    where e.ts >= p_from and e.ts < p_to
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
  ) g;
  return result;
end;
$$;
revoke execute on function public.admin_ai_cost_rollup(timestamptz, timestamptz) from anon, public;
grant execute on function public.admin_ai_cost_rollup(timestamptz, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
