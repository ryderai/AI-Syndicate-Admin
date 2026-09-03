#!/usr/bin/env bash
# WHAT 0030 ACTUALLY DOES, on a real Postgres — not on a reading of the file.
#
# Needs postgres 16 on the PATH. THERE IS NO POSTGRES ON THE MAC BRIDGE, so this
# was run in the cloud container, the same place the build has to run. It is here
# so the next person can re-run it rather than take the result on trust.
#
# It builds a throwaway database with the parts of 0009/0027 that 0030 leans on
# (admin_leads with the PRE-0030 stage constraint, admin_users, the activity
# log), runs the real migration file, then runs behaviour.sql — which puts four
# leads in, runs the migration AGAIN over them, and raises on the first wrong
# answer.
#
#   ./run.sh                 # starts its own postgres in /tmp
#   PGURL=... ./run.sh       # or point it at one you already have
set -euo pipefail
cd "$(dirname "$0")"
MIG="../../supabase/migrations/0030_meeting_split.sql"

if [ -z "${PGURL:-}" ]; then
  export PATH="$PATH:/usr/lib/postgresql/16/bin"
  export PGDATA=/tmp/pg-0030
  RUN=/tmp/pg-0030-run
  mkdir -p "$RUN"
  # initdb and postgres both refuse to run as root, and the cloud container IS
  # root. Drop to a `postgres` user there; run directly anywhere else.
  AS=""
  if [ "$(id -u)" = 0 ]; then
    id postgres >/dev/null 2>&1 || useradd postgres
    AS="su postgres -c"
  fi
  # `PG_VERSION`, NOT the directory. An empty /tmp/pg-* left behind by a failed
  # initdb passed the `-d` test, so initdb was skipped and every check below
  # died on a missing socket — a failure that reads like a broken database.
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    mkdir -p "$PGDATA"
    chown -R postgres "$PGDATA" "$RUN" 2>/dev/null || true
    if [ -n "$AS" ]; then $AS "PATH=$PATH initdb -D $PGDATA -U postgres" >/dev/null
    else initdb -D "$PGDATA" -U postgres >/dev/null; fi
  fi
  chown -R postgres "$RUN" 2>/dev/null || true
  START="pg_ctl -D $PGDATA -o \"-k $RUN -p 5433 -c listen_addresses=\" -l /tmp/pg-0030.log start"
  if [ -n "$AS" ]; then $AS "PATH=$PATH $START" >/dev/null 2>&1 || true
  else eval "$START" >/dev/null 2>&1 || true; fi
  sleep 2
  PSQL="psql -h $RUN -p 5433 -U postgres"
else
  PSQL="psql $PGURL"
fi

echo ""
echo "── a database shaped the way it was before 0030 ─────"
$PSQL -q -v ON_ERROR_STOP=1 -f stub.sql
echo "── the real 0030 ────────────────────────────────────"
$PSQL -q -v ON_ERROR_STOP=1 -f "$MIG"
echo "── what it does, including a second run over real rows"
$PSQL -q -t -v ON_ERROR_STOP=1 -v mig="$MIG" -f behaviour.sql 2>&1 | sed 's/^psql:[^ ]* NOTICE: //'
