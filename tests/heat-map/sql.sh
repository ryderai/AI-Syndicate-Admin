#!/usr/bin/env bash
# THE DATABASE HALF OF THE HEAT MAP — 30 Sep 2026.
#
# Stands up a real Postgres, applies every migration in order, and checks:
#   · 0046 applies, and applies twice
#   · only the service role can write (hs_heat_ingest); a member, a stranger
#     and anon cannot, and nobody can insert into the tables directly
#   · a send that arrives twice, or late, adds no clicks and winds nothing back
#   · a view id cannot be re-filed under another session or page
#   · a member reads the rollup; a signed-in non-member gets zeroes
#   · hs_heat_rollup() and the JS rollupFromRows() agree (crosscheck.mjs)
#
# Skips itself with a message when there is no local Postgres.
set -u
cd "$(dirname "$0")/../.."

PGBIN=""
for d in /usr/lib/postgresql/*/bin; do [ -x "$d/initdb" ] && PGBIN="$d"; done
if [ -z "$PGBIN" ]; then
  echo "  --   no local Postgres found; the SQL half was SKIPPED."
  exit 0
fi

DATA="$(mktemp -d)/pgdata"
SOCK="$(mktemp -d)"
mkdir -p "$DATA"
RUNAS=""
if [ "$(id -u)" = "0" ]; then
  RUNAS="su postgres -s /bin/bash -c"
  chown -R postgres "$(dirname "$DATA")" "$SOCK"
fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "$1"; else bash -c "$1"; fi; }

run "$PGBIN/initdb -D $DATA -U postgres --auth=trust" >/dev/null 2>&1 || { echo "  --   Postgres would not start; SKIPPED."; exit 0; }
run "$PGBIN/pg_ctl -D $DATA -o \"-k $SOCK -c listen_addresses=''\" -w start" >/dev/null 2>&1 || { echo "  --   Postgres would not start; SKIPPED."; exit 0; }

export PGHOST="$SOCK" PGUSER=postgres
PSQL="psql -v ON_ERROR_STOP=1 -q"
cleanup() { run "$PGBIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1; }
trap cleanup EXIT

fails=0
ok()  { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fails=$((fails+1)); }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got '$2', wanted '$3'"; fi; }

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

for f in supabase/migrations/0*.sql; do
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/hm-mig.err; then
    echo "  FAIL migration $f did not apply:"; sed 's/^/       /' /tmp/hm-mig.err; exit 1
  fi
done
$PSQL -c "grant all on all tables in schema public to service_role;" >/dev/null
ok "every migration applies in order, 0046 included"
if $PSQL -f supabase/migrations/0046_landing_heat_map.sql >/dev/null 2>/tmp/hm-mig.err; then ok "0046 can be run twice"; else bad "0046 is not re-runnable"; sed 's/^/       /' /tmp/hm-mig.err; fi

OWNER='11111111-1111-1111-1111-111111111111'
STRANGER='44444444-4444-4444-4444-444444444444'
$PSQL <<SQL >/dev/null
insert into auth.users (id, email) values ('$OWNER','owner@x.com'), ('$STRANGER','stranger@x.com');
insert into public.admin_users (user_id, email, full_name, role, active) values ('$OWNER','owner@x.com','Owner O','owner',true);
SQL

val()    { $PSQL -tAc "$1" | tail -n 1 | tr -d '[:space:]'; }
as_val() { $PSQL -tAc "set local role $1; set local request.jwt.claim.sub = '$2'; $3" | tail -n 1 | tr -d '[:space:]'; }
tries()  { $PSQL -c "set local role $1; set local request.jwt.claim.sub = '$2'; $3" >/dev/null 2>/tmp/hm-err.txt; }
refused() { if tries "$2" "$3" "$4"; then bad "$1 — it was allowed"; elif grep -qi "permission denied\|violates row-level" /tmp/hm-err.txt; then ok "$1"; else bad "$1 — unexpected error: $(head -c 200 /tmp/hm-err.txt)"; fi; }

SEND() { # seq, clicks json array, [session], [age_ms]
  echo "select public.hs_heat_ingest('{\"view_id\":\"v-test01\",\"session_id\":\"${3:-sA}\",\"page_slug\":\"lawn-care\",\"seq\":$1,\"age_ms\":${4:-0},\"device\":\"mobile\",\"max_scroll_pct\":$((10*$1)),\"active_ms\":$((1000*$1)),\"zones\":{\"hero\":{\"r\":1,\"ms\":$((500*$1))}},\"clicks\":$2}'::jsonb);"
}
click() { echo "{\"cid\":$1,\"zone\":\"offer\",\"x_pm\":500,\"y_pm\":930,\"target\":\"price-buy\",\"kind\":\"link\",\"dead\":false,\"rage\":false,\"t_ms\":1000}"; }
C1="[$(click 1)]"
C12="[$(click 1),$(click 2)]"
C3="[$(click 3)]"

# --- who may write ---
is "the service role can send" "$(as_val service_role '' "$(SEND 1 "$C1" sA 3600000)")" "t"
is "...the visit is filed under when the page LOADED (age_ms back from now), not when it first reported" \
  "$(val "select (now() - first_seen_at between interval '59 minutes' and interval '61 minutes') from public.hs_heat_sessions where view_id='v-test01';")" "t"
refused "a signed-in member cannot call hs_heat_ingest" authenticated "$OWNER" "$(SEND 9 "$C1")"
refused "anon cannot call hs_heat_ingest" anon '' "$(SEND 9 "$C1")"
refused "a member cannot insert a page load straight into the table" authenticated "$OWNER" "insert into public.hs_heat_sessions (view_id, session_id, page_slug) values ('v-zzzzzz','x','lawn-care');"
refused "a member cannot insert a click straight into the table" authenticated "$OWNER" "insert into public.hs_heat_clicks (view_id, cid, session_id, page_slug, zone, x_pm, y_pm) values ('v-test01',99,'x','lawn-care','hero',1,1);"

# --- resends, late sends, and clicks that must not be lost ---
is "the same send again changes nothing" "$(as_val service_role '' "$(SEND 1 "$C1")")" "f"
is "...and its click is stored once" "$(val "select count(*) from public.hs_heat_clicks where view_id='v-test01';")" "1"
is "a newer send carrying click 1 again plus click 2 is applied" "$(as_val service_role '' "$(SEND 3 "$C12")")" "t"
is "...only click 2 is new" "$(val "select string_agg(cid::text, ',' order by cid) from public.hs_heat_clicks where view_id='v-test01';")" "1,2"
is "a LATE older send (seq 2 after 3) that carries a NEW click is still taken — for the click" "$(as_val service_role '' "$(SEND 2 "$C3")")" "t"
is "...the late send's click is stored" "$(val "select count(*) from public.hs_heat_clicks where view_id='v-test01' and cid=3;")" "1"
is "...but the totals were not wound back to seq 2" "$(val "select seq||'/'||active_ms||'/'||max_scroll_pct||'/'||(zones->'hero'->>'ms') from public.hs_heat_sessions where view_id='v-test01';")" "3/3000/30/1500"
is "...and click_count matches the click rows" "$(val "select click_count from public.hs_heat_sessions where view_id='v-test01';")" "3"
is "a view id cannot be re-filed under another session" "$(as_val service_role '' "$(SEND 9 "[$(click 4)]" sEVIL)")" "f"
is "...no click was added through it" "$(val "select count(*) from public.hs_heat_clicks where view_id='v-test01';")" "3"
is "...it still belongs to the first one" "$(val "select session_id from public.hs_heat_sessions where view_id='v-test01';")" "sA"

# --- who may read ---
is "a member reads the rollup" "$(as_val authenticated "$OWNER" "select public.hs_heat_rollup('lawn-care', null, null)->>'views';")" "1"
is "a signed-in NON-member reads zero page loads" "$(as_val authenticated "$STRANGER" "select public.hs_heat_rollup('lawn-care', null, null)->>'views';")" "0"
refused "anon cannot call the rollup" anon '' "select public.hs_heat_rollup('lawn-care', null, null);"
$PSQL -c "delete from public.hs_heat_sessions;" >/dev/null
is "deleting a page load deletes its clicks" "$(val "select count(*) from public.hs_heat_clicks;")" "0"

# --- the two copies of the counting ---
if node tests/heat-map/crosscheck.mjs "$OWNER" 2>/tmp/hm-cc.txt; then :; else bad "crosscheck: $(head -c 1500 /tmp/hm-cc.txt)"; fi

echo ""
if [ "$fails" -gt 0 ]; then echo "  $fails SQL check(s) failed"; exit 1; fi
echo "  SQL half: all checks passed"
