#!/usr/bin/env bash
# TAGS ON A LEAD.  Aug 27 2026
#
#   1. the pure half — the vocabulary, the bands, the automatic rules, the
#      "never put back what a person took off" rule, and the close reasons
#   2. five timezones, because a Chicago browser at midday cannot see a single
#      one of the date bugs this repo has already shipped three times
#   3. the database half — migrations 0018 and 0020 against a real Postgres
set -e
cd "$(dirname "$0")/../.."
node tests/lead-tags/test.mjs

# NOT piped into tail. A pipeline's exit code is the LAST command's, so
# `node ... | tail -1` reports tail's success and a whole timezone could fail
# silently under `set -e`. The output goes to a file and the count is read back.
for TZ in America/Chicago America/New_York America/Los_Angeles UTC Pacific/Auckland; do
  if TZ=$TZ node tests/lead-tags/test.mjs > /tmp/lead-tags-tz.log 2>&1; then
    echo "  $(grep -E '^[0-9]+ passed' /tmp/lead-tags-tz.log)  (TZ=$TZ)"
  else
    echo "  FAILED under TZ=$TZ:"; grep -A2 FAIL /tmp/lead-tags-tz.log | sed 's/^/    /'; exit 1
  fi
done

bash tests/lead-tags/sql.sh
