#!/usr/bin/env bash
# END TO END: the real landing page → the real /api/hs-heat handler → a real
# Postgres with every migration → hs_heat_rollup(). 30 Sep 2026.
#
#   LP=../Home-Services-LP PW_MODULE=<folder with playwright> bash tests/heat-map/e2e.sh
#
# Heavy (a browser, a database, two servers), so run.sh does not call it.
set -u
cd "$(dirname "$0")/../.."
LP="${LP:-../Home-Services-LP}"
PGBIN=""; for d in /usr/lib/postgresql/*/bin; do [ -x "$d/initdb" ] && PGBIN="$d"; done
[ -z "$PGBIN" ] && { echo "no Postgres; skipped"; exit 0; }
DATA="$(mktemp -d)/pgdata"; SOCK="$(mktemp -d)"; mkdir -p "$DATA"
RUNAS=""; if [ "$(id -u)" = "0" ]; then RUNAS="su postgres -s /bin/bash -c"; chown -R postgres "$(dirname "$DATA")" "$SOCK"; fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "$1"; else bash -c "$1"; fi; }
run "$PGBIN/initdb -D $DATA -U postgres --auth=trust" >/dev/null 2>&1
run "$PGBIN/pg_ctl -D $DATA -o \"-k $SOCK -c listen_addresses=''\" -w start" >/dev/null 2>&1
export PGHOST="$SOCK" PGUSER=postgres PGOPTIONS="-c client_min_messages=warning"
PIDS=""
cleanup() { for p in $PIDS; do kill $p 2>/dev/null; done; run "$PGBIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1; }
trap cleanup EXIT
psql -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create extension if not exists pgcrypto;
create schema if not exists auth;
create table auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to authenticated, anon, service_role;
SQL
for f in supabase/migrations/0*.sql; do psql -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "migration $f failed"; exit 1; }; done
psql -q -c "grant all on all tables in schema public to service_role; insert into auth.users values ('11111111-1111-1111-1111-111111111111','o@x.com'); insert into public.admin_users (user_id,email,full_name,role,active) values ('11111111-1111-1111-1111-111111111111','o@x.com','O','owner',true);" >/dev/null

HS_ALLOWED_ORIGINS="http://localhost:8101" node --experimental-test-module-mocks --no-warnings tests/heat-map/e2e-server.mjs 3999 > /tmp/hm-e2e-server.log 2>&1 & PIDS="$PIDS $!"
node -e "require('$LP/_build/serve.js').serve(8101, '$LP', null)" > /tmp/hm-e2e-lp.log 2>&1 & PIDS="$PIDS $!"
sleep 2
node tests/heat-map/e2e-browser.mjs http://localhost:8101 http://localhost:3999
sleep 2
echo "--- sends the handler passed to the database:"
curl -s localhost:3999/_calls > /tmp/hm-calls.json; node -e "const c=JSON.parse(require('fs').readFileSync('/tmp/hm-calls.json'));const t0=c.length?c[0].at:0;console.log(c.length+' sends. per view [seq @ seconds after first send, clicks carried]:');const m={};for(const x of c)(m[x.view_id]=m[x.view_id]||[]).push(x.seq+'@'+((x.at-t0)/1000).toFixed(1)+'s/'+x.clicks.length);console.log(JSON.stringify(m,null,1))"
echo "--- rows in the database:"
psql -tAc "select view_id, device, seq, max_scroll_pct, active_ms, click_count, utm_source, utm_content, (select string_agg(key||'='||(value->>'r')||'/'||(value->>'ms'), ' ' order by key) from jsonb_each(zones)) from public.hs_heat_sessions order by first_seen_at;"
psql -tAc "select zone, x_pm, y_pm, coalesce(target,'∅'), kind, dead, rage from public.hs_heat_clicks order by id;"
echo "--- hs_heat_rollup('lawn-care') as the owner:"
psql -tAc "set role authenticated; set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111'; select jsonb_pretty(public.hs_heat_rollup('lawn-care', null, null) - 'grid' - 'options');"
