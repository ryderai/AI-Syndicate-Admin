#!/usr/bin/env bash
# A REP'S OWN AI RULES.  Aug 27 2026
#
#   1. the pure half — the no-numbers gate, the limits, and every sample row
#      passing the check the real save path makes
#   2. five timezones. There is no date arithmetic in this half, and that is
#      exactly why it is worth running: a suite that only ever runs in one zone
#      is a suite that stops catching the day somebody adds one.
#   3. the database half — migration 0022 against a real Postgres
set -e
cd "$(dirname "$0")/../.."
node tests/user-brain/test.mjs

# NOT piped into tail. A pipeline's exit code is the LAST command's, so
# `node ... | tail -1` reports tail's success and a whole timezone could fail
# silently under `set -e`.
for TZ in America/Chicago America/New_York America/Los_Angeles UTC Pacific/Auckland; do
  if TZ=$TZ node tests/user-brain/test.mjs > /tmp/user-brain-tz.log 2>&1; then
    echo "  $(grep -E '^[0-9]+ passed' /tmp/user-brain-tz.log)  (TZ=$TZ)"
  else
    echo "  FAILED under TZ=$TZ:"; grep -A2 FAIL /tmp/user-brain-tz.log | sed 's/^/    /'; exit 1
  fi
done

bash tests/user-brain/sql.sh
