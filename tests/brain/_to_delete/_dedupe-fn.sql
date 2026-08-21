create or replace function public.admin_lead_dedupe_key(
  p_email text, p_phone text, p_domain text, p_company text, p_city text
) returns text
language sql
immutable
set search_path = public
as $$
  -- Each field is cleaned FIRST, then the strongest surviving one wins. The
  -- earlier version tested the raw field and cleaned it inside the branch,
  -- which meant a value that failed its own cleaning (a domain with no dot,
  -- an email with no @) still swallowed the branch and stopped weaker fields
  -- being tried. A test comparing this against cleanPhone/cleanDomain in
  -- lib/lead-intake.js caught it on 'HTTPS://WWW.X.com/about?q=1', which this
  -- function keyed as 'd:https:' because '^https?://' does not match 'HTTPS://'.
  --
  -- Read alongside lib/lead-intake.js. The two must agree exactly: the browser
  -- uses the JavaScript to say "12 of these are already here" before an import
  -- saves, and this stamps the key that the check is made against.
  with cleaned as (
    select
      -- email: one @, a dot after it, no spaces
      case when lower(btrim(coalesce(p_email,''))) ~ '^[^[:space:]@]+@[^[:space:]@.]+\.[^[:space:]@]+$'
           then lower(btrim(p_email)) end as e,

      -- phone: digits only, drop a leading country-code 1, take the first ten
      case when length(regexp_replace(coalesce(p_phone,''), '\D', '', 'g')) >= 10
           then left(
             case
               when length(regexp_replace(p_phone, '\D', '', 'g')) > 10
                and left(regexp_replace(p_phone, '\D', '', 'g'), 1) = '1'
               then substr(regexp_replace(p_phone, '\D', '', 'g'), 2)
               else regexp_replace(p_phone, '\D', '', 'g')
             end, 10) end as p,

      -- domain: lowercase FIRST, then drop the scheme, www., the path, the
      -- query and any trailing dot. Must still contain a dot afterwards.
      nullif(regexp_replace(
        regexp_replace(
          split_part(split_part(
            regexp_replace(lower(btrim(coalesce(p_domain,''))), '^[a-z]+://', ''),
          '/', 1), '?', 1),
        '^www\.', ''), '\.$', ''), '') as d,

      nullif(lower(regexp_replace(btrim(coalesce(p_company,'')), '[^a-z0-9]', '', 'gi')), '') as c,
      lower(btrim(coalesce(p_city,''))) as ct
  )
  select case
    when e is not null then 'e:' || e
    when p is not null then 'p:' || p
    when d is not null and d ~ '\.' and d !~ '[[:space:]]' then 'd:' || d
    when c is not null then 'c:' || c || ':' || ct
    else null
  end
  from cleaned
$$;
