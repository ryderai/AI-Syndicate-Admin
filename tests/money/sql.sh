#!/usr/bin/env bash
# 0041 AGAINST A REAL POSTGRES — 24 Sep 2026.
# Every migration in order, 0041 twice, then: money tables owner-only (an
# admin reads NOTHING, an owner reads everything), the AI rollup's numbers,
# its 1,000-row-proof shape, billable rows left out of spend, the credit
# rollup, and the assistant-log policy. Exit 2 = skipped (no Postgres), which
# is NOT a pass.
set -u
cd "$(dirname "$0")/../.."
PGBIN=""; for d in /usr/lib/postgresql/*/bin; do [ -x "$d/initdb" ] && PGBIN="$d"; done
[ -z "$PGBIN" ] && { echo "  --   no local Postgres found. THE SQL HALF DID NOT RUN — that is not a pass."; exit 2; }
DATA="$(mktemp -d)/pgdata"; SOCK="$(mktemp -d)"; mkdir -p "$DATA"
RUNAS=""; if [ "$(id -u)" = "0" ]; then id postgres >/dev/null 2>&1 || useradd -m postgres; RUNAS="su postgres -s /bin/bash -c"; chown -R postgres "$(dirname "$DATA")" "$SOCK"; fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "$1"; else bash -c "$1"; fi; }
run "$PGBIN/initdb -D $DATA -U postgres --auth=trust" >/dev/null 2>&1 || { echo "initdb failed"; exit 1; }
run "$PGBIN/pg_ctl -D $DATA -o \"-k $SOCK -c listen_addresses=''\" -w start" >/dev/null 2>&1 || { echo "start failed"; exit 1; }
PSQL="psql -h $SOCK -U postgres -v ON_ERROR_STOP=1 -q"
cleanup() { run "$PGBIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1; }
trap cleanup EXIT
fails=0
ok()  { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fails=$((fails+1)); }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got '$2', wanted '$3'"; fi; }
q()   { $PSQL -tAc "$1" 2>/tmp/money-q.err | tr -d ' '; }

OWNER=11111111-1111-1111-1111-111111111111
ADMIN=22222222-2222-2222-2222-222222222222
REP=33333333-3333-3333-3333-333333333333
as() { # as <uid> <sql>  — run as an authenticated user with that id
  $PSQL -tAc "set role authenticated; set request.jwt.claim.sub = '$1'; set request.jwt.claim.role = 'authenticated'; $2" 2>/tmp/money-as.err | tr -d ' '
}

$PSQL <<'SQL' >/dev/null
create extension if not exists pgcrypto;
create schema if not exists auth;
create table auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '');
$$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to authenticated, anon, service_role;
grant select on auth.users to authenticated, service_role;
grant execute on function auth.uid(), auth.role() to authenticated, anon, service_role;
-- The platform's own tables, as far as 0041 reads them (platform 0126).
create table public.workspaces (id uuid primary key, name text, domain text, owner_id uuid, stripe_customer_id text);
create table public.plan_token_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  delta int not null, reason text not null, feature text,
  created_at timestamptz not null default now());
SQL

echo ""
echo "== every migration applies, in order, and 0041 twice =="
for f in supabase/migrations/0*.sql; do
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/mig.err; then echo "  FAIL $f did not apply:"; sed 's/^/       /' /tmp/mig.err; exit 1; fi
done
ok "every migration applied"
if $PSQL -f supabase/migrations/0041_money_owner_only_and_fast_rollups.sql >/dev/null 2>/tmp/mig.err; then ok "0041 runs a second time"; else bad "0041 is not re-runnable"; sed 's/^/       /' /tmp/mig.err; fi

$PSQL <<SQL >/dev/null
insert into auth.users values ('$OWNER','ryder@x'),('$ADMIN','julia@x'),('$REP','cameron@x');
insert into public.admin_users (user_id, email, full_name, role, active) values
  ('$OWNER','ryder@x','Ryder','owner',true),('$ADMIN','julia@x','Julia','admin',true),('$REP','cameron@x','Cameron','sales',true);
insert into public.admin_expenses (incurred_on, category, amount_cents) values ('2026-09-01','Software',3000);
insert into public.admin_invoices (number, bill_to_name, issue_date, due_date, total_cents) values ('AIS-0001','Client','2026-09-01','2026-09-15',100000);
insert into public.admin_usage_events (ts, source, provider, model, cost_micros) values ('2026-08-15T12:00:00Z','admin','anthropic','m',7);
insert into public.admin_platform_workspaces (workspace_id) values ('bbbbbbbb-0000-0000-0000-000000000001') on conflict do nothing;
SQL
[ -s /tmp/money-q.err ] && true

echo ""
echo "== money is owners only, in the database =="
for t in admin_expenses admin_invoices admin_usage_events admin_finance_settings ai_model_prices admin_platform_workspaces; do
  is "admin reads 0 rows of $t" "$(as $ADMIN "select count(*) from public.$t")" "0"
  is "rep reads 0 rows of $t"   "$(as $REP "select count(*) from public.$t")" "0"
done
is "owner reads the expense"  "$(as $OWNER "select count(*) from public.admin_expenses")" "1"
is "owner reads the invoice"  "$(as $OWNER "select count(*) from public.admin_invoices")" "1"
# The 0-row checks above only mean something if the owner DOES see rows there.
for t in admin_usage_events admin_finance_settings ai_model_prices admin_platform_workspaces; do
  n=$(as $OWNER "select count(*) > 0 from public.$t"); is "owner sees rows in $t (so the admin 0 above is real)" "$n" "t"
done
if as $ADMIN "insert into public.admin_expenses (incurred_on, category, amount_cents) values ('2026-09-02','Software',1)" >/dev/null && [ ! -s /tmp/money-as.err ]; then bad "admin could ADD a cost"; else ok "admin cannot add a cost"; fi
is "no admin-level money policy is left" "$(q "select count(*) from pg_policies where tablename in ('admin_expenses','admin_invoices','admin_invoice_items','admin_invoice_payments','admin_finance_settings','admin_usage_events','ai_model_prices','ai_provider_bills','admin_platform_workspaces') and policyname like 'admins %'")" "0"
is "owner can set a customer's side" "$(as $OWNER "insert into public.admin_finance_departments (stripe_customer_id, department) values ('cus_1','agency') returning department")" "agency"
is "admin cannot see a customer's side" "$(as $ADMIN "select count(*) from public.admin_finance_departments")" "0"
if as $OWNER "insert into public.admin_finance_departments (stripe_customer_id, department) values ('cus_2','other')" >/dev/null && [ ! -s /tmp/money-as.err ]; then bad "a side other than platform/agency was accepted"; else ok "only platform or agency is a side"; fi
is "a typed cost can carry a side" "$(q "update public.admin_expenses set department='platform' returning department")" "platform"

echo ""
echo "== the AI rollup =="
$PSQL <<SQL >/dev/null
insert into public.workspaces values ('aaaaaaaa-0000-0000-0000-000000000001','Dahler','30a.com',null,'cus_1');
-- 23:30 Chicago on Sep 1 is 04:30Z on Sep 2: it must land on Sep 1.
insert into public.admin_usage_events (ts, source, provider, model, cost_micros, workspace_id, platform_feature, billable, status) values
  ('2026-09-02T04:30:00Z','platform','anthropic','m',1000,'aaaaaaaa-0000-0000-0000-000000000001','brand.scan',true,'ok'),
  ('2026-09-02T04:40:00Z','platform','anthropic','m',null,'aaaaaaaa-0000-0000-0000-000000000001','brand.scan',true,'ok'),
  ('2026-09-02T05:10:00Z','platform','anthropic','m',500,null,null,true,'ok'),
  ('2026-09-02T05:20:00Z','platform','anthropic','m',9999,null,null,false,'ok');
update public.admin_usage_events set meta = jsonb_build_object('feature_name','Lead capture') where cost_micros = 500;
insert into public.plan_token_ledger (workspace_id, delta, reason, feature, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', -30, 'spend', 'brand.scan', '2026-09-03'),
  ('aaaaaaaa-0000-0000-0000-000000000001', -10, 'shadow_spend', 'brand.scan', '2026-09-03'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 5, 'refund', 'brand.scan', '2026-09-03');
SQL
R="select public.admin_ai_cost_rollup('2026-09-01T05:00:00Z','2026-10-01T05:00:00Z')"
is "Sep 1 23:30 Chicago lands on Sep 1" "$(as $OWNER "select (e->>'calls') from jsonb_array_elements(($R)) e where e->>'day'='2026-09-01'")" "2"
is "an unpriced call is counted but not priced" "$(as $OWNER "select (e->>'priced_calls')||'/'||(e->>'cost_micros') from jsonb_array_elements(($R)) e where e->>'day'='2026-09-01'")" "1/1000"
$PSQL -c "update public.admin_usage_events set input_tokens=100, output_tokens=20, cache_write_tokens=30 where cost_micros=1000" >/dev/null
$PSQL -f supabase/migrations/0042_ai_rollup_cache_write_tokens.sql >/dev/null 2>/tmp/mig.err && ok "0042 applies on top of 0041" || { bad "0042 did not apply"; sed 's/^/       /' /tmp/mig.err; }
is "0042: cache-write tokens are summed" "$(as $OWNER "select (e->>'cache_write_tokens')||'/'||(e->>'input_tokens')||'/'||(e->>'output_tokens') from jsonb_array_elements(($R)) e where e->>'day'='2026-09-01'")" "30/100/20"
is "a non-billable call adds no spend" "$(as $OWNER "select sum((e->>'cost_micros')::bigint) from jsonb_array_elements(($R)) e where e->>'day'='2026-09-02'")" "500"
is "...and is counted as non-billable" "$(as $OWNER "select sum((e->>'nonbillable_calls')::int) from jsonb_array_elements(($R)) e")" "1"
is "the tool name is the job when there is no platform job" "$(as $OWNER "select e->>'job' from jsonb_array_elements(($R)) e where (e->>'cost_micros')::int=500")" "Leadcapture"
if as $ADMIN "$R" >/dev/null && [ ! -s /tmp/money-as.err ]; then bad "an ADMIN could call the rollup"; else ok "an admin calling the rollup is refused"; fi
is "the service key may call it" "$($PSQL -tAc "set role service_role; set request.jwt.claim.role='service_role'; select jsonb_array_length(($R))" | tr -d ' ')" "3"
$PSQL -c "insert into public.admin_usage_events (ts, source, provider, model, cost_micros) select '2026-09-10T12:00:00Z'::timestamptz, 'platform', 'p', 'model-'||g, 1 from generate_series(1,1500) g" >/dev/null
is "1,500 groups come back whole — one jsonb value, not rows the API caps at 1,000" "$(as $OWNER "select jsonb_array_length(($R))")" "1503"

echo ""
echo "== 0043: why a request failed, wait time, extras =="
$PSQL <<'SQL' >/dev/null
insert into public.admin_usage_events (ts, source, provider, model, status, latency_ms, input_tokens, output_tokens, meta) values
  ('2026-09-20T15:00:00Z','platform','mistral','mm','capped',100,0,0,'{"http_status":"429"}'),
  ('2026-09-20T15:01:00Z','platform','mistral','mm','capped',120,0,0,'{"http_status":"429"}'),
  ('2026-09-20T15:02:00Z','platform','mistral','mm','failed',30000,0,0,'{"error":"The operation was aborted due to timeout"}'),
  ('2026-09-20T15:03:00Z','platform','mistral','mm','failed',50,0,0,'{"wasted":"http_error"}'),
  ('2026-09-20T15:04:00Z','platform','mistral','mm','ok',2000,100,50,'{"reasoning_tokens":40,"web_search_requests":2}'),
  ('2026-09-20T15:05:00Z','platform','mistral','mm','ok',3000,10,5,'{"wasted":"cut_off","reasoning_tokens":"x"}');
SQL
$PSQL -f supabase/migrations/0043_ai_rollup_reasons_and_detail.sql >/dev/null 2>/tmp/mig.err && ok "0043 applies on top of 0042" || { bad "0043 did not apply"; sed 's/^/       /' /tmp/mig.err; }
R2="select public.admin_ai_cost_rollup('2026-09-20T05:00:00Z','2026-09-21T05:00:00Z')"
is "0043: failures split by reason, working calls stay one group" "$(as $OWNER "select string_agg((e->>'reason')||'='||(e->>'calls'), ',' order by e->>'reason') from jsonb_array_elements(($R2)) e")" "429=2,http_error=1,ok=2,timeout=1"
is "0043: wait time is summed" "$(as $OWNER "select sum((e->>'wait_ms')::bigint) from jsonb_array_elements(($R2)) e")" "35270"
is "0043: thinking tokens and web searches (junk values ignored)" "$(as $OWNER "select (e->>'reasoning_tokens')||'/'||(e->>'web_searches') from jsonb_array_elements(($R2)) e where e->>'reason'='ok'")" "40/2"
is "0043: cut-off answers counted with their tokens" "$(as $OWNER "select (e->>'cut_off_calls')||'/'||(e->>'cut_off_tokens') from jsonb_array_elements(($R2)) e where e->>'reason'='ok'")" "1/15"
$PSQL -f supabase/migrations/0043_ai_rollup_reasons_and_detail.sql >/dev/null 2>/tmp/mig.err && ok "0043 runs twice" || { bad "0043 re-run failed"; sed 's/^/       /' /tmp/mig.err; }

echo ""
echo "== credits =="
C="select public.admin_credit_rollup('2026-09-01T05:00:00Z','2026-10-01T05:00:00Z')"
is "credits: spend + shadow spend, refund apart" "$(as $OWNER "select (e->>'spent')||'/'||(e->>'refunded')||'/'||(e->>'spends') from jsonb_array_elements(($C)) e")" "40/5/2"
echo ""
[ $fails -eq 0 ] && echo "  money SQL: all checks passed." || echo "  money SQL: $fails FAILED."
exit $([ $fails -eq 0 ] && echo 0 || echo 1)
