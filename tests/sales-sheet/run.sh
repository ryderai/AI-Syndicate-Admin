#!/usr/bin/env bash
# THE SHEET + ONE RECORD FROM LEAD TO PAYING CLIENT.  Aug 25 2026
#
#   1. the pure half — the columns, the sort, the filters, the grouping, the
#      firm warning, and the lifetime timeline
#   2. five timezones, because a Chicago browser at midday cannot see a single
#      one of the date bugs this repo has already shipped three times
#   3. the database half — migration 0015 against a real Postgres
#
# The browser walkthrough is separate and needs a build:
#   npm run build && node tests/sales-sheet/walkthrough.mjs
set -e
cd "$(dirname "$0")/../.."
node tests/sales-sheet/test.mjs

# NOT piped into tail. A pipeline's exit code is the LAST command's, so
# `node ... | tail -1` reports tail's success and a whole timezone could fail
# silently under `set -e`. The output goes to a file and the count is read back.
for TZ in America/Chicago America/New_York America/Los_Angeles UTC Pacific/Auckland; do
  if TZ=$TZ node tests/sales-sheet/test.mjs > /tmp/sheet-tz.log 2>&1; then
    echo "  $(grep -E '^[0-9]+ passed' /tmp/sheet-tz.log)  (TZ=$TZ)"
  else
    echo "  FAILED under TZ=$TZ:"; grep -A2 FAIL /tmp/sheet-tz.log | sed 's/^/    /'; exit 1
  fi
done

bash tests/sales-sheet/sql.sh
