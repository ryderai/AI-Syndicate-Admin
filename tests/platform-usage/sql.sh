#!/usr/bin/env bash
# 0032 AGAINST A REAL POSTGRES.
#
# Every migration 0001-0032 in order, 0032 twice (Ryder runs these by hand in
# the Supabase editor and a half-applied set is the normal state), then the
# behaviour is ATTACKED rather than admired.
#
# Three defects were found by writing this file, and every one of them was
# found by running it, not by reading the migration:
#
#  1. admin_usage_events.input_tokens was `not null default 0`, so a call
#     whose token count we cannot read — a SerpApi search, a streamed answer,
#     a 200 with no usage object — could not be stored at all. The insert was
#     REFUSED. Storing it as 0 instead would have been worse: on the cost page
#     that is indistinguishable from a call that was free.
#  2. Both views bypassed row-level security. A Postgres view runs as its
#     OWNER unless marked security_invoker, so the table was locked and the
#     two views beside it were open. A sales rep read the whole agency's AI
#     spend through them. The migration even carried a comment asserting the
#     opposite.
#  3. The first version of the seed here printed "ok seeded" over a failed
#     INSERT, which made four later checks fail for the wrong reason. A setup
#     step that cannot fail loudly wastes the run.
#
# The Mac-folder bridge has no Postgres, so this normally runs in the cloud
# container. A SKIP IS NOT A PASS — if the skip line prints, the database half
# has NOT been proven on that machine.
set -u
cd "$(dirname "$0")/../.."
PGBIN=""; for d in /usr/lib/postgresql/*/bin; do [ -x "$d/initdb" ] && PGBIN="$d"; done
# A SKIP EXITS 77, NOT 0.
#
# This file's own header says "A SKIP IS NOT A PASS" — and the first version
# then exited 0, so any CI gate reading the exit code went green on a machine
# that ran none of these checks. 77 is the conventional "skipped" code and is
# not 0, so a gate has to decide about it on purpose. Set ALLOW_SQL_SKIP=1 to
# opt into treating it as fine.
[ -z "$PGBIN" ] && {
  echo "  --   no local Postgres found; the SQL half was SKIPPED. A skip is not a pass."
  [ "${ALLOW_SQL_SKIP:-}" = "1" ] && exit 0
  exit 77
}

DATA="$(mktemp -d)/pgdata"; SOCK="$(mktemp -d)"; mkdir -p "$DATA"
RUNAS=""; if [ "$(id -u)" = "0" ]; then RUNAS="su postgres -s /bin/bash -c"; chown -R postgres "$(dirname "$DATA")" "$SOCK" .; fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "$1"; else bash -c "$1"; fi; }
run "$PGBIN/initdb -D $DATA -U postgres --auth=trust" >/dev/null 2>&1
# An empty /tmp/pg-* directory passes `[ -d ]`. A failed initdb leaves one, the
# next run skips initdb, and every check dies on a missing socket — which reads
# like a broken database rather than a broken script. Test for PG_VERSION.
[ -f "$DATA/PG_VERSION" ] || { echo "  FAIL initdb produced no database"; exit 1; }
run "$PGBIN/pg_ctl -D $DATA -o \"-k $SOCK -c listen_addresses=''\" -w start" >/dev/null 2>&1 || { echo "start failed"; exit 1; }
PSQL="psql -h $SOCK -U postgres -v ON_ERROR_STOP=1 -q"
cleanup() { run "$PGBIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1; }
trap cleanup EXIT

fails=0
ok()  { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fails=$((fails+1)); }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got '$2', wanted '$3'"; fi; }
q()   { $PSQL -tAc "$1" 2>/dev/null | tr -d ' '; }
# Run a statement as a signed-in console user, with RLS applied.
asuser() { $PSQL -tAc "set local role authenticated; set local request.jwt.claim.sub = '$1'; $2" 2>&1 | tr -d ' ' | tail -1; }

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
ok "0001 through 0032 all applied"

if $PSQL -f supabase/migrations/0032_platform_usage.sql >/dev/null 2>/tmp/mig.err; then
  ok "0032 can be run a second time without breaking"
else
  bad "0032 is NOT re-runnable:"; sed 's/^/       /' /tmp/mig.err
fi

echo ""
echo "== a workspace id is not a client id =="
is "workspace_id has NO foreign key (it points at another database)" \
  "$(q "select count(*) from information_schema.table_constraints tc join information_schema.key_column_usage k on k.constraint_name=tc.constraint_name where tc.table_name='admin_usage_events' and tc.constraint_type='FOREIGN KEY' and k.column_name='workspace_id'")" "0"

echo ""
echo "== 'we could not measure it' must be storable, and must not read as free =="
is "input_tokens is nullable"  "$(q "select is_nullable from information_schema.columns where table_name='admin_usage_events' and column_name='input_tokens'")"  "YES"
is "output_tokens is nullable" "$(q "select is_nullable from information_schema.columns where table_name='admin_usage_events' and column_name='output_tokens'")" "YES"
# The default matters as much as the constraint: with `default 0` still in
# place, a writer that omits the column records "free" rather than "unknown".
is "input_tokens has NO default"  "$(q "select count(column_default) from information_schema.columns where table_name='admin_usage_events' and column_name='input_tokens'")"  "0"
is "output_tokens has NO default" "$(q "select count(column_default) from information_schema.columns where table_name='admin_usage_events' and column_name='output_tokens'")" "0"

# cost_usd IS THE ONE THAT WOULD HAVE TAKEN THE ENDPOINT DOWN, and the first
# version of this file did not check it at all — it tested the two columns the
# migration mentions first and skipped the one the migration shouts about.
# api/usage-ingest.js writes NULL there for any unpriced call, so under the old
# `not null default 0` the first batch containing one non-Anthropic model would
# have been refused WHOLE, as a 500.
is "cost_usd is nullable"        "$(q "select is_nullable from information_schema.columns where table_name='admin_usage_events' and column_name='cost_usd'")" "YES"
is "cost_usd has NO default"     "$(q "select count(column_default) from information_schema.columns where table_name='admin_usage_events' and column_name='cost_usd'")" "0"
for c in cache_write_tokens cache_write_1h_tokens cache_read_tokens; do
  is "$c is nullable"    "$(q "select is_nullable from information_schema.columns where table_name='admin_usage_events' and column_name='$c'")" "YES"
  is "$c has NO default" "$(q "select count(column_default) from information_schema.columns where table_name='admin_usage_events' and column_name='$c'")" "0"
done

# And the shape the endpoint actually sends must be ACCEPTED, not merely
# permitted by the column types.
if $PSQL -c "insert into public.admin_usage_events (source,provider,model,input_tokens,output_tokens,cost_usd,cost_micros) values ('platform','serpapi','search',null,null,null,null)" >/dev/null 2>&1; then
  ok "a fully unpriced, unmeasured row inserts — the shape api/usage-ingest.js sends"
  $PSQL -c "delete from public.admin_usage_events where provider='serpapi' and model='search'" >/dev/null 2>&1
else
  bad "the row api/usage-ingest.js sends for an unpriced call is REFUSED by the database"
fi

echo ""
echo "== seed =="
if $PSQL >/dev/null 2>/tmp/seed.err <<'SQL'
insert into auth.users (id,email) values
  ('00000000-0000-0000-0000-0000000000aa','owner@example.com'),
  ('00000000-0000-0000-0000-0000000000bb','rep@example.com');
insert into public.admin_users (user_id,email,role,active) values
  ('00000000-0000-0000-0000-0000000000aa','owner@example.com','owner',true),
  ('00000000-0000-0000-0000-0000000000bb','rep@example.com','sales',true);
insert into public.admin_clients (id,name) values ('11111111-1111-1111-1111-111111111111','A Client');
insert into public.admin_platform_workspaces (workspace_id, client_id, label)
  values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','their workspace');
insert into public.admin_platform_workspaces (workspace_id, label)
  values ('33333333-3333-3333-3333-333333333333','claimed by nobody');
insert into public.admin_usage_events (source,provider,model,input_tokens,output_tokens,cost_micros,client_id,feature)
  values ('console','anthropic','claude-sonnet-4-6',100,10,5000,'11111111-1111-1111-1111-111111111111','client_report');
insert into public.admin_usage_events (source,provider,model,input_tokens,output_tokens,cost_micros,workspace_id,platform_feature)
  values ('platform','anthropic','claude-sonnet-4-6',900,90,7000,'22222222-2222-2222-2222-222222222222','content.generate');
insert into public.admin_usage_events (source,provider,model,input_tokens,output_tokens,cost_micros,workspace_id,platform_feature)
  values ('platform','serpapi','search',null,null,null,'22222222-2222-2222-2222-222222222222','audit.run');
insert into public.admin_usage_events (source,provider,model,input_tokens,output_tokens,cost_micros,workspace_id,platform_feature)
  values ('platform','openai','gpt-5',400,40,9000,'33333333-3333-3333-3333-333333333333','social.post');
SQL
then ok "seeded, including a paid call with no token count at all"
else bad "the seed itself failed — every check below is meaningless:"; sed 's/^/       /' /tmp/seed.err; exit 1
fi

is "the unmeasured call kept NULL tokens, not zeros" "$(q "select input_tokens is null and output_tokens is null from admin_usage_events where provider='serpapi'")" "t"

echo ""
echo "== cost per client, across the console AND the platform =="
is "3 rows for the client (1 direct + 2 through the workspace)" "$(q "select count(*) from admin_client_ai_cost where client_id='11111111-1111-1111-1111-111111111111'")" "3"
is "the console call is labelled 'direct'" "$(q "select count(*) from admin_client_ai_cost where attribution='direct'")" "1"
is "the platform calls are labelled 'mapped'" "$(q "select count(*) from admin_client_ai_cost where attribution='mapped'")" "2"
is "an UNMAPPED workspace's spend is credited to nobody" "$(q "select count(*) from admin_client_ai_cost where workspace_id='33333333-3333-3333-3333-333333333333'")" "0"
is "the money adds up and the unpriced row adds nothing to it" "$(q "select sum(cost_micros) from admin_client_ai_cost where client_id='11111111-1111-1111-1111-111111111111'")" "12000"
is "and the unpriced call is still COUNTED" "$(q "select count(*) from admin_client_ai_cost where client_id='11111111-1111-1111-1111-111111111111' and cost_micros is null")" "1"

echo ""
echo "== the unmapped-spend screen =="
is "one workspace is unmapped" "$(q "select count(*) from admin_unmapped_workspace_spend")" "1"
is "and it carries its real spend" "$(q "select cost_micros from admin_unmapped_workspace_spend")" "9000"
is "its unpriced count is right" "$(q "select unpriced_calls from admin_unmapped_workspace_spend")" "0"

# A workspace with NO events at all. The LEFT JOIN pads it with one null row,
# and `count(*) filter (where e.cost_micros is null)` counted that padding —
# so the screen printed "calls 0" next to "not priced 1", two contradictory
# facts on one line. count(e.id) is the fix and this is what pins it.
$PSQL -c "insert into public.admin_platform_workspaces (workspace_id,label) values ('55555555-5555-5555-5555-555555555555','never spent anything')" >/dev/null 2>&1
is "a workspace with no calls reports 0 calls"        "$(q "select calls from admin_unmapped_workspace_spend where workspace_id='55555555-5555-5555-5555-555555555555'")" "0"
is "and 0 unpriced calls, not 1 from the empty join"  "$(q "select unpriced_calls from admin_unmapped_workspace_spend where workspace_id='55555555-5555-5555-5555-555555555555'")" "0"
$PSQL -c "delete from public.admin_platform_workspaces where workspace_id='55555555-5555-5555-5555-555555555555'" >/dev/null 2>&1

echo ""
echo "== COUNT THE DOORS: the table AND both views =="
# The first version of 0032 locked the table and left both views wide open.
is "a sales rep reads nothing from the table" "$(asuser 00000000-0000-0000-0000-0000000000bb 'select count(*) from public.admin_platform_workspaces;')" "0"
is "a sales rep reads nothing from admin_client_ai_cost" "$(asuser 00000000-0000-0000-0000-0000000000bb 'select count(*) from public.admin_client_ai_cost;')" "0"
is "a sales rep reads nothing from admin_unmapped_workspace_spend" "$(asuser 00000000-0000-0000-0000-0000000000bb 'select count(*) from public.admin_unmapped_workspace_spend;')" "0"
W=$(asuser 00000000-0000-0000-0000-0000000000bb "insert into public.admin_platform_workspaces (workspace_id) values ('44444444-4444-4444-4444-444444444444');")
case "$W" in *ERROR*|*violates*|*denied*) ok "a sales rep cannot write to it";; *) bad "a sales rep WROTE to it";; esac
# And the lock must not lock out the person the screen is for.
is "the OWNER still sees the mapping table" "$(asuser 00000000-0000-0000-0000-0000000000aa 'select count(*) from public.admin_platform_workspaces;')" "2"
is "the OWNER still sees the unmapped view" "$(asuser 00000000-0000-0000-0000-0000000000aa 'select count(*) from public.admin_unmapped_workspace_spend;')" "1"

echo ""
echo "== deleting a client must not destroy the evidence that money was spent =="
$PSQL -c "delete from public.admin_clients where id='11111111-1111-1111-1111-111111111111'" >/dev/null 2>&1
is "the workspace row survives" "$(q "select count(*) from admin_platform_workspaces where workspace_id='22222222-2222-2222-2222-222222222222'")" "1"
is "its client link is CLEARED, not cascaded" "$(q "select client_id is null from admin_platform_workspaces where workspace_id='22222222-2222-2222-2222-222222222222'")" "t"
is "all four usage events survive" "$(q "select count(*) from admin_usage_events")" "4"
is "the orphaned workspace surfaces on the unmapped screen" "$(q "select count(*) from admin_unmapped_workspace_spend")" "2"

echo ""
if [ "$fails" = "0" ]; then echo "  platform-usage SQL: all checks passed."; else echo "  platform-usage SQL: $fails FAILING."; fi
exit $fails
