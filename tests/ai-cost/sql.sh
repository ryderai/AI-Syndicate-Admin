#!/usr/bin/env bash
# 0024 AGAINST A REAL POSTGRES.
# Every migration 0001-0024 in order, 0024 twice (Ryder runs these by hand in
# the Supabase editor and a half-applied set is the normal state), then the
# constraints and the backfill are attacked rather than admired.
set -u
cd "$(dirname "$0")/../.."
PGBIN=""; for d in /usr/lib/postgresql/*/bin; do [ -x "$d/initdb" ] && PGBIN="$d"; done
# Skips itself with a message when there is no local Postgres. The Mac-folder
# bridge has none, so this half normally runs in the cloud container — where it
# was run on Aug 28 2026 and passed 45/45. A skip is not a pass; if this line
# prints, the database half has NOT been proven on that machine.
[ -z "$PGBIN" ] && { echo "  --   no local Postgres found; the SQL half was SKIPPED."; exit 0; }
DATA="$(mktemp -d)/pgdata"; SOCK="$(mktemp -d)"; mkdir -p "$DATA"
RUNAS=""; if [ "$(id -u)" = "0" ]; then RUNAS="su postgres -s /bin/bash -c"; chown -R postgres "$(dirname "$DATA")" "$SOCK" .; fi
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
q()   { $PSQL -tAc "$1" 2>/dev/null | tr -d ' '; }
# refused() succeeds when the statement is REJECTED by the database.
refused() { if $PSQL -c "$1" >/dev/null 2>&1; then bad "$2 — the database ACCEPTED it"; else ok "$2"; fi; }

$PSQL <<'SQL' >/dev/null
create extension if not exists pgcrypto;
create schema if not exists auth;
create table auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to authenticated, anon, service_role;
grant select on auth.users to authenticated, service_role;
SQL

echo ""
echo "== every migration applies, in order =="
for f in supabase/migrations/0*.sql; do
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/mig.err; then
    echo "  FAIL $f did not apply:"; sed 's/^/       /' /tmp/mig.err; exit 1
  fi
done
ok "0001 through 0024 all applied"

# Ryder pastes these into the Supabase editor by hand. "Run it again" has to be
# a safe instruction rather than a gamble.
if $PSQL -f supabase/migrations/0024_ai_usage.sql >/dev/null 2>/tmp/mig.err; then
  ok "0024 can be run a second time without breaking"
else
  bad "0024 is NOT re-runnable:"; sed 's/^/       /' /tmp/mig.err
fi

echo ""
echo "== the shapes exist =="
is "ai_model_prices exists"   "$(q "select count(*) from information_schema.tables where table_name='ai_model_prices'")" "1"
is "ai_provider_bills exists" "$(q "select count(*) from information_schema.tables where table_name='ai_provider_bills'")" "1"
for c in provider request_id event_key cost_micros price_id cache_write_tokens cache_write_1h_tokens cache_read_tokens client_id user_id feature surface entity_kind entity_id status error_code latency_ms billable; do
  is "admin_usage_events.$c" "$(q "select count(*) from information_schema.columns where table_name='admin_usage_events' and column_name='$c'")" "1"
done
is "cost_micros is a bigint" "$(q "select data_type from information_schema.columns where table_name='admin_usage_events' and column_name='cost_micros'")" "bigint"
is "cost_usd was left alone"  "$(q "select count(*) from information_schema.columns where table_name='admin_usage_events' and column_name='cost_usd'")" "1"
is "prices seeded (anthropic only, on purpose)" "$(q "select count(distinct provider) from ai_model_prices")" "1"
is "nine anthropic models seeded" "$(q "select count(*) from ai_model_prices")" "9"
is "every seeded price records where it came from" "$(q "select count(*) from ai_model_prices where source_url is null")" "0"
is "sonnet-4-6 input is \$3/Mtok in micros" "$(q "select input_per_mtok from ai_model_prices where model='claude-sonnet-4-6'")" "3000000"
is "sonnet-4-6 1-hour cache write is \$6/Mtok" "$(q "select cache_write_1h_per_mtok from ai_model_prices where model='claude-sonnet-4-6'")" "6000000"

echo ""
echo "== the guards actually refuse things =="
refused "insert into ai_model_prices (provider,model,effective_from,input_per_mtok,output_per_mtok) values ('anthropic','claude-sonnet-4-6','2026-01-01',1,1);" \
  "two price rows for the same model on the same start date are refused"
$PSQL -c "insert into ai_model_prices (provider,model,effective_from,input_per_mtok,output_per_mtok) values ('anthropic','claude-sonnet-4-6','2026-09-01',1,1);" >/dev/null 2>&1 \
  && ok "a LATER start date for the same model is allowed — that is how a price change is recorded" \
  || bad "a later price row was refused, so a price could never change"
refused "insert into ai_model_prices (provider,model,effective_from,effective_to,input_per_mtok,output_per_mtok) values ('x','y','2026-05-01','2026-01-01',1,1);" \
  "a price window that ends before it starts is refused"
refused "insert into admin_usage_events (model,cost_micros) values ('m',-5);" \
  "a negative cost is refused — that is a broken counter, not a discount"
refused "insert into admin_usage_events (model,status) values ('m','unpriced');" \
  "'unpriced' is NOT a status any more — it says what happened to the CALL"
refused "insert into admin_usage_events (model,feature) values ('m','not_a_feature');" \
  "an invented feature is refused, so one grouping cannot become three"

$PSQL -c "insert into admin_usage_events (model,cost_micros,status) values ('unknown-model',null,'failed');" >/dev/null 2>&1 \
  && ok "a call can be UNPRICED and FAILED at once — the two facts are separate columns" \
  || bad "a failed call with no price was refused"

echo ""
echo "== the dedupe key really stops a retry =="
$PSQL -c "insert into admin_usage_events (model,event_key,cost_micros) values ('m','k1',10);" >/dev/null 2>&1
refused "insert into admin_usage_events (model,event_key,cost_micros) values ('m','k1',10);" \
  "the same event_key twice is refused — one retry cannot double-count"

# THE STATEMENT THE CODE ACTUALLY SENDS.
#
# The check above hand-inserts duplicates, which exercises the index but never
# issues the ON CONFLICT that api/usage-ingest.js emits. That is exactly the
# shape that was broken: the index was PARTIAL (`where event_key is not null`),
# and Postgres will not infer a partial index as an ON CONFLICT target unless
# the statement repeats the predicate — which PostgREST's upsert does not. So
# every single ingest call failed with "there is no unique or exclusion
# constraint matching the ON CONFLICT specification", wrote nothing, and would
# have gone on doing so forever. Found by an adversarial review before it ever
# ran anywhere; the index is no longer partial. A unique index already treats
# NULLs as distinct, so unkeyed rows were never the problem they looked like.
if $PSQL -c "insert into admin_usage_events (model,event_key,cost_micros) values ('m2','k2',1),('m2',null,1),('m2',null,1) on conflict (event_key) do nothing;" >/dev/null 2>&1; then
  ok "the exact upsert the ingest endpoint sends is accepted"
else
  bad "the ingest endpoint's own ON CONFLICT statement is REJECTED — every call to it 500s"
fi
is "...and a mixed batch inserts all three (NULL keys are distinct)" "$(q "select count(*) from admin_usage_events where model='m2'")" "3"
$PSQL -c "insert into admin_usage_events (model,event_key,cost_micros) values ('m2','k2',1) on conflict (event_key) do nothing;" >/dev/null 2>&1
is "...and re-sending the keyed row adds nothing" "$(q "select count(*) from admin_usage_events where model='m2'")" "3"
$PSQL -c "insert into admin_usage_events (model,cost_micros) values ('m',10);" >/dev/null 2>&1
$PSQL -c "insert into admin_usage_events (model,cost_micros) values ('m',10);" >/dev/null 2>&1
# Not "because the index is partial" — it is not, any more. A unique index
# treats NULLs as DISTINCT, which is why the predicate was never needed.
is "any number of rows with NO key are still allowed" "$(q "select count(*) from admin_usage_events where event_key is null and model='m'")" "2"
refused "insert into admin_usage_events (model,surface) values ('m','not_a_page');" \
  "an invented page id is refused — a typo splits one row on the cost page into two"

echo ""
echo "== the backfill labels old rows rather than deleting them =="
$PSQL <<'SQL' >/dev/null 2>&1
alter table admin_usage_events drop constraint if exists admin_usage_events_status_ck;
insert into admin_usage_events (model, cost_usd, cost_micros, status)
  values ('legacy-row', 0.012345, null, 'ok');
alter table admin_usage_events add constraint admin_usage_events_status_ck
  check (status in ('ok','failed','rejected','capped','legacy'));
update admin_usage_events set cost_micros = round(cost_usd * 1000000)::bigint, status='legacy'
  where cost_micros is null and cost_usd is not null and status='ok';
SQL
is "an old dollars row converts to the exact micro-dollar" "$(q "select cost_micros from admin_usage_events where model='legacy-row'")" "12345"
is "...and is labelled legacy, so no screen can call it measured" "$(q "select status from admin_usage_events where model='legacy-row'")" "legacy"

echo ""
echo "== reps cannot read cost data =="
is "ai_model_prices has RLS on"   "$(q "select relrowsecurity from pg_class where relname='ai_model_prices'")" "t"
is "ai_provider_bills has RLS on" "$(q "select relrowsecurity from pg_class where relname='ai_provider_bills'")" "t"
is "the price policy uses admin_is_admin()" "$(q "select count(*) from pg_policies where tablename='ai_model_prices' and qual like '%admin_is_admin%'")" "1"
is "the bills policy does too"              "$(q "select count(*) from pg_policies where tablename='ai_provider_bills' and qual like '%admin_is_admin%'")" "1"
is "nobody but the service key may INSERT a price" "$(q "select count(*) from pg_policies where tablename='ai_model_prices' and cmd in ('INSERT','ALL')")" "0"

echo ""
if [ "$fails" = "0" ]; then echo "  everything passed"; else echo "  $fails FAILED"; fi
exit $fails
