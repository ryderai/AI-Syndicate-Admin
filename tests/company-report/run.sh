#!/usr/bin/env bash
# THE FIRM SCAN — api/sales-score.js.  Aug 27 2026
#
#   1. the pure half — the three readers, the score column rule, baseline vs
#      re-scan, the lead-id check, the row lock on the Skip, and the wording
#   2. five timezones, because the day a scan was read is printed on every
#      contact's timeline, and a Chicago browser at midday cannot see a single
#      one of the date bugs this repo has already shipped three times
#
# No database, no keys, no network, no browser. Nothing of ours is mocked.
set -e
cd "$(dirname "$0")/../.."
node tests/company-report/test.mjs

# NOT piped into tail. A pipeline's exit code is the LAST command's, so
# `node ... | tail -1` reports tail's success and a whole timezone could fail
# silently under `set -e`. The output goes to a file and the count is read back.
for TZ in America/Chicago America/New_York America/Los_Angeles UTC Pacific/Auckland; do
  if TZ=$TZ node tests/company-report/test.mjs > /tmp/company-report-tz.log 2>&1; then
    echo "  $(grep -E '^ +[0-9]+ passed' /tmp/company-report-tz.log)  (TZ=$TZ)"
  else
    echo "  FAILED under TZ=$TZ:"; grep -A2 FAIL /tmp/company-report-tz.log | sed 's/^/    /'; exit 1
  fi
done
