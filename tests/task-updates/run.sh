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
  # AS ROOT, POSTGRES REFUSES TO START AT ALL — 2 Sep 2026. This file was
  # written on a machine that ran as a normal user; the cloud box runs as root,
  # where `initdb` exits with "cannot be run as root" and every check below is
  # then skipped with a connection error. A skip is not a pass, and this one
  # looked like a database problem rather than a script problem. Same bootstrap
  # as tests/db-columns/run.sh, which was written after this and got it right.
  AS=""
  if [ "$(id -u)" = 0 ]; then id postgres >/dev/null 2>&1 || useradd postgres; AS="su postgres -c"; fi
  # `PG_VERSION`, NOT the directory. An empty /tmp/pg-* left behind by a failed
  # initdb passed the `-d` test, so initdb was skipped and every check below
  # died on a missing socket — a failure that reads like a broken database.
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    mkdir -p "$PGDATA" "$RUN"; chown -R postgres "$PGDATA" "$RUN" 2>/dev/null || true
    if [ -n "$AS" ]; then $AS "PATH=$PATH initdb -D $PGDATA -U postgres" >/dev/null
    else initdb -D "$PGDATA" -U postgres >/dev/null; fi
  fi
  chown -R postgres "$RUN" 2>/dev/null || true
  START="pg_ctl -D $PGDATA -o \"-k $RUN -p 5433 -c listen_addresses=\" -l /tmp/pg-0029.log start"
  if [ -n "$AS" ]; then $AS "PATH=$PATH $START" >/dev/null 2>&1 || true
  else eval "$START" >/dev/null 2>&1 || true; fi
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
