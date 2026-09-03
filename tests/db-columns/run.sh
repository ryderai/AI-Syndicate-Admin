#!/usr/bin/env bash
# WHAT 0031 ACTUALLY DOES, on a real Postgres — not on a reading of the file.
#
# Needs postgres 16 on the PATH. There is no Postgres on the Mac bridge, so this
# was run in the cloud container. It is here so the next person can re-run it.
#
# It builds a reminders table in the state migration 0006 left it, PROVES the
# bug (a follow-up pointing at an email is refused), runs 0031, proves it saves,
# proves every other value any migration ever allowed still saves, proves
# nonsense is still refused, and runs 0031 again.
set -euo pipefail
cd "$(dirname "$0")"
MIG="../../supabase/migrations/0031_reminder_link_email.sql"

if [ -z "${PGURL:-}" ]; then
  export PATH="$PATH:/usr/lib/postgresql/16/bin"
  export PGDATA=/tmp/pg-0031
  RUN=/tmp/pg-0031-run
  mkdir -p "$RUN"
  AS=""
  if [ "$(id -u)" = 0 ]; then id postgres >/dev/null 2>&1 || useradd postgres; AS="su postgres -c"; fi
  # `PG_VERSION`, NOT the directory. An empty /tmp/pg-* left behind by a failed
  # initdb passed the `-d` test, so initdb was skipped and every check below
  # died on a missing socket — a failure that reads like a broken database.
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    mkdir -p "$PGDATA"; chown -R postgres "$PGDATA" "$RUN" 2>/dev/null || true
    if [ -n "$AS" ]; then $AS "PATH=$PATH initdb -D $PGDATA -U postgres" >/dev/null
    else initdb -D "$PGDATA" -U postgres >/dev/null; fi
  fi
  chown -R postgres "$RUN" 2>/dev/null || true
  START="pg_ctl -D $PGDATA -o \"-k $RUN -p 5433 -c listen_addresses=\" -l /tmp/pg-0031.log start"
  if [ -n "$AS" ]; then $AS "PATH=$PATH $START" >/dev/null 2>&1 || true
  else eval "$START" >/dev/null 2>&1 || true; fi
  sleep 2
  PSQL="psql -h $RUN -p 5433 -U postgres"
else
  PSQL="psql $PGURL"
fi

echo ""
echo "── reminders, in the state migration 0006 left them ──"
$PSQL -q -v ON_ERROR_STOP=1 -f stub.sql
echo "── the bug, then 0031, then the bug again ────────────"
$PSQL -q -t -v ON_ERROR_STOP=1 -v mig="$MIG" -f behaviour.sql 2>&1 | sed 's/^psql:[^ ]* NOTICE: //'
