#!/usr/bin/env bash
# Prove the JavaScript and the SQL agree about what a duplicate lead is.
#
# WHY THIS EXISTS
# The rule lives in two places and has to: the browser needs it to say "12 of
# these 214 are already here" BEFORE an import saves, and the database needs it
# to stamp the key that check is made against. Two copies drift. On Aug 20 2026
# they already had: the SQL stripped "https://" case-sensitively, so a lead
# added by hand with "HTTPS://WWW.X.com" keyed as `d:https:` while the browser
# said `d:x.com` — the same business imported twice, and a rep phoning twice.
#
# NEEDS: a local Postgres (initdb/psql on the PATH). No Supabase, no network.
# Run it whenever you touch lib/lead-intake.js or the function in 0006.
set -euo pipefail
cd "$(dirname "$0")/../.."

PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | head -1 || true)"
[ -n "$PGBIN" ] && export PATH="$PGBIN:$PATH"
command -v initdb >/dev/null || { echo "SKIP: no local Postgres (initdb not found)."; exit 0; }

DATA=$(mktemp -d); SOCK=$(mktemp -d); PORT=${PGPORT:-5455}
cleanup() { pg_ctl -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DATA" "$SOCK"; }
trap cleanup EXIT

initdb -D "$DATA" -U postgres --auth=trust >/dev/null
pg_ctl -D "$DATA" -o "-k $SOCK -p $PORT -c listen_addresses=''" -l "$DATA/log" start >/dev/null
sleep 2
PSQL="psql -h $SOCK -p $PORT -U postgres -v ON_ERROR_STOP=1 -tA"

# Stand in for what Supabase provides. Only what the migrations reference.
$PSQL -q <<'SQL'
create extension if not exists pgcrypto;
create role anon; create role authenticated;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid());
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
SQL

# NOTICEs about "does not exist, skipping" are the guards doing their job.
for f in supabase/migrations/*.sql; do $PSQL -q -f "$f" >/dev/null 2>&1; done

node tests/brain/js-keys.mjs  > "$DATA/js.txt"
node tests/brain/sql-keys.mjs > "$DATA/q.sql"
$PSQL -f "$DATA/q.sql" > "$DATA/sql.txt"

if diff -u "$DATA/js.txt" "$DATA/sql.txt" > "$DATA/diff.txt"; then
  echo "ok — JavaScript and SQL agree on all $(wc -l < "$DATA/js.txt" | tr -d ' ') cases"
else
  echo "MISMATCH between lib/lead-intake.js and admin_lead_dedupe_key:"
  echo "  (- is JavaScript, + is SQL)"
  cat "$DATA/diff.txt"
  exit 1
fi
