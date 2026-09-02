#!/usr/bin/env bash
# WHAT 0029 ACTUALLY DOES, on a real Postgres — not on a reading of the file.
#
# Needs postgres 16 on the PATH. THERE IS NO POSTGRES ON THE MAC BRIDGE, so this
# was run in the cloud container, the same place the build has to run. It is here
# so the next person can re-run it rather than take the result on trust. It builds a throwaway database with the parts
# of 0001 that 0029 leans on (the auth stubs, admin_is_member/admin/owner,
# admin_clients, admin_tasks and its admin-only policy), runs the real migration
# file TWICE, then runs behaviour.sql, which raises and stops on the first wrong
# answer. Nothing here touches Supabase.
#
#   ./run.sh                 # starts its own postgres in /tmp
#   PGURL=... ./run.sh       # or point it at one you already have
set -euo pipefail
cd "$(dirname "$0")"
ROOT="../.."
MIG="$ROOT/supabase/migrations/0029_task_updates.sql"

if [ -z "${PGURL:-}" ]; then
  export PATH="$PATH:/usr/lib/postgresql/16/bin"
  export PGDATA=/tmp/pg-0029
  RUN=/tmp/pg-0029-run
  if [ ! -d "$PGDATA" ]; then
    mkdir -p "$PGDATA" "$RUN"
    initdb -D "$PGDATA" -U postgres >/dev/null
  fi
  pg_ctl -D "$PGDATA" -o "-k $RUN -p 5433 -c listen_addresses=" -l /tmp/pg-0029.log start >/dev/null 2>&1 || true
  sleep 2
  PSQL="psql -h $RUN -p 5433 -U postgres"
else
  PSQL="psql $PGURL"
fi

echo ""
echo "── the parts of 0001 that 0029 leans on ─────────────"
$PSQL -q -v ON_ERROR_STOP=1 -f stub.sql
echo "── the real 0029, twice (it must be safe to re-run) ──"
$PSQL -q -v ON_ERROR_STOP=1 -f "$MIG"
$PSQL -q -v ON_ERROR_STOP=1 -f "$MIG"
echo "── what it does ─────────────────────────────────────"
$PSQL -q -t -v ON_ERROR_STOP=1 -f behaviour.sql 2>&1 | sed 's/^psql:[^ ]* NOTICE: //'
