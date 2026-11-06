#!/usr/bin/env bash
# 0053 on a real Postgres 16: run 0048 → 0053 on a stub, run 0053 TWICE,
# then behaviour.sql prints PASS/FAIL. Needs postgres 16 on the PATH (the Mac
# bridge has none; run in the cloud container). 6 Nov 2026.
set -euo pipefail
cd "$(dirname "$0")"
M=../../supabase/migrations
export PATH="$PATH:/usr/lib/postgresql/16/bin"
export PGDATA=/tmp/pg-li-v2; RUN=/tmp/pg-li-v2-run; mkdir -p "$RUN"
AS=""; if [ "$(id -u)" = 0 ]; then id postgres >/dev/null 2>&1 || useradd postgres; AS="su postgres -c"; fi
if [ ! -f "$PGDATA/PG_VERSION" ]; then mkdir -p "$PGDATA"; chown -R postgres "$PGDATA" "$RUN" 2>/dev/null || true
  if [ -n "$AS" ]; then $AS "PATH=$PATH initdb -D $PGDATA -U postgres" >/dev/null; else initdb -D "$PGDATA" -U postgres >/dev/null; fi; fi
chown -R postgres "$RUN" 2>/dev/null || true
START="pg_ctl -D $PGDATA -o \"-k $RUN -p 5434 -c listen_addresses=\" -l /tmp/pg-li-v2.log start"
if [ -n "$AS" ]; then $AS "PATH=$PATH $START" >/dev/null 2>&1 || true; else eval "$START" >/dev/null 2>&1 || true; fi
sleep 2
P="psql -h $RUN -p 5434 -U postgres -q -v ON_ERROR_STOP=1"
$P -f stub.sql >/dev/null
for f in 0048_linkedin_clients.sql 0049_linkedin_grants.sql 0051_linkedin_sequences_and_payment.sql 0052_linkedin_flow.sql 0053_linkedin_v2.sql 0053_linkedin_v2.sql; do
  $P -f "$M/$f" >/dev/null 2>/tmp/li-v2-mig.err || { echo "FAIL running $f"; cat /tmp/li-v2-mig.err; exit 1; }
  echo "ran $f"
done
psql -h $RUN -p 5434 -U postgres -q -f behaviour.sql 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //; s/^NOTICE:  //' | grep -E "PASS|FAIL|ERROR" | sed 's/^ *//'
