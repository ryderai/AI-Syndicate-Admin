-- ==========================================================================
-- 0044 — ONE ACCOUNT, LOOKED AT CLOSELY. 25 Sep 2026.
--
-- Ryder: "so does this show more in depth why troy specifically spent more
-- tokens?" → "go ahead and build that layer."
--
-- admin_ai_account_detail(workspace, from, to) returns ONE jsonb value for
-- one platform workspace, read only when an owner opens that account on the
-- AI Cost page:
--   hours    AI requests per Chicago hour × job: calls, worked, didn't work,
--            tokens sent (input + cache writes) and written (output). The
--            page joins busy hours into work sessions.
--   sites    every website the workspace ran an AI Access audit on in the
--            window (public.audits), with the audit count, first and last
--            audit, and how many PAGES got fixes written in the window
--            (public.page_fixes_cache, matched on the page's domain — the
--            cache has no workspace column, so a page fixed by another
--            workspace on the same domain would also count; the page says so).
--   credits  plan-token charges by feature and by how they started
--            (manual = a person clicked, cron = scheduled).
--
-- Owners only (same guard as the rollup). Safe to run more than once. Reads
-- platform tables; if one is missing its part comes back empty.
-- ==========================================================================

create or replace function public.admin_ai_account_detail(p_workspace uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_hours jsonb := '[]'::jsonb;
  v_sites jsonb := '[]'::jsonb;
  v_credits jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.admin_is_owner() then
    raise exception 'owners only' using errcode = '42501';
  end if;
  -- Hours are only useful over a readable stretch; cap the window at 93 days.
  if p_to - p_from > interval '93 days' then
    p_from := p_to - interval '93 days';
  end if;

  select coalesce(jsonb_agg(h order by h.hour, h.job), '[]'::jsonb) into v_hours
  from (
    select
      to_char(e.ts at time zone 'America/Chicago', 'YYYY-MM-DD"T"HH24') as hour,
      coalesce(
        nullif(btrim(e.platform_feature), ''),
        nullif(btrim(e.meta->>'feature_name'), ''),
        nullif(btrim(e.meta->>'entry'), '')
      ) as job,
      count(*) as calls,
      count(*) filter (where e.status = 'ok' or e.status = 'legacy') as ok,
      count(*) filter (where e.status is not null and e.status not in ('ok', 'legacy')) as failed,
      coalesce(sum(coalesce(e.input_tokens, 0) + coalesce(e.cache_write_tokens, 0)), 0) as sent,
      coalesce(sum(e.output_tokens), 0) as written
    from public.admin_usage_events e
    where e.workspace_id = p_workspace and e.ts >= p_from and e.ts < p_to
    group by 1, 2
  ) h;

  if to_regclass('public.audits') is not null then
    execute $q$
      with a as (
        select lower(regexp_replace(domain, '^www\.', '')) as dom, created_at
        from public.audits
        where workspace_id = $1 and created_at >= $2 and created_at < $3 and domain is not null
      ), s as (
        select dom, count(*) as audits, min(created_at) as first_at, max(created_at) as last_at
        from a group by dom
      ), f as (
        select lower(regexp_replace(regexp_replace(url, '^https?://(www\.)?', ''), '[/?#].*$', '')) as dom,
               count(distinct url) as pages
        from public.page_fixes_cache
        where updated_at >= $2 and updated_at < $3
        group by 1
      )
      select coalesce(jsonb_agg(jsonb_build_object(
        'domain', s.dom, 'audits', s.audits, 'first_at', s.first_at, 'last_at', s.last_at,
        'fixed_pages', coalesce(f.pages, 0)
      ) order by coalesce(f.pages, 0) desc, s.audits desc, s.dom), '[]'::jsonb)
      from s left join f on f.dom = s.dom
    $q$ into v_sites using p_workspace, p_from, p_to;
  end if;

  if to_regclass('public.plan_token_ledger') is not null then
    execute $q$
      select coalesce(jsonb_agg(c order by c.units desc), '[]'::jsonb) from (
        select feature, coalesce(source, 'unknown') as source, count(*) as charges,
               coalesce(sum(-delta), 0) as units
        from public.plan_token_ledger
        where workspace_id = $1 and created_at >= $2 and created_at < $3
          and reason in ('spend', 'shadow_spend', 'refund')
        group by 1, 2
      ) c
    $q$ into v_credits using p_workspace, p_from, p_to;
  end if;

  return jsonb_build_object('hours', v_hours, 'sites', v_sites, 'credits', v_credits, 'from', p_from, 'to', p_to);
end;
$$;
revoke execute on function public.admin_ai_account_detail(uuid, timestamptz, timestamptz) from anon, public;
grant execute on function public.admin_ai_account_detail(uuid, timestamptz, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
