#!/usr/bin/env bash
# OUTREACH, COUNTED — sent, replied, reply rate, and no open rate anywhere.
#   Aug 27 2026
#
#   1. one fixture, built by hand, and the assertion the module exists for: a
#      rep's own tile and the owner's cell for that rep must be the SAME numbers
#   2. five timezones. lib/outreach.js compares ISO strings on purpose, because
#      `new Date("2026-08-20")` is midnight UTC and therefore the evening before
#      in Chicago — a bug this repo has already shipped three times. The point of
#      this loop is that the COUNTS COME OUT IDENTICAL in all five zones; a
#      different number anywhere is a date bug even if nothing errors.
#
# There is no SQL half. Everything in lib/outreach.js is arithmetic on rows
# somebody else read; the rows themselves are covered by tests/floor-scoping.
#
# NO `set -e`, DELIBERATELY. The pure half currently ends with three failing
# assertions, all from ONE real defect it found and did not fix: `Number(null)`
# is 0 and passes `Number.isFinite`, so an unpriced proposal counts as priced and
# the total comes out as $0 over three proposals nobody priced — the exact number
# lib/outreach.js:200-201 says must never be produced. Under `set -e` that would
# abort before the timezone loop, which is the half that can only be run here. So
# each run's exit code is kept and the script exits non-zero at the end.
set -u
cd "$(dirname "$0")/../.."

rc=0

echo ""
echo "== one fixture, one rep, one set of numbers =="
node tests/outreach-stats/test.mjs || rc=1

echo ""
echo "== five timezones — the counts must be IDENTICAL, not merely non-erroring =="
# NOT piped into tail. A pipeline's exit code is the LAST command's, so
# `node ... | tail -1` reports tail's success and a whole timezone could fail
# silently. The output goes to a file and the count is read back.
BASE=""
for TZ in America/Chicago America/New_York America/Los_Angeles UTC Pacific/Auckland; do
  TZ=$TZ node tests/outreach-stats/test.mjs > /tmp/outreach-tz.log 2>&1
  LINE="$(grep -E '^[0-9]+ passed' /tmp/outreach-tz.log)"
  echo "  $LINE  (TZ=$TZ)"
  if [ -z "$BASE" ]; then
    BASE="$LINE"
  elif [ "$LINE" != "$BASE" ]; then
    echo "    DIFFERENT RESULT UNDER TZ=$TZ — that is a date bug, not a flake:"
    grep -E '^  FAIL' /tmp/outreach-tz.log | sed 's/^/      /'
    rc=1
  fi
done

echo ""
if [ "$rc" = "0" ]; then echo "  the numbers are the same in every timezone"; else echo "  something FAILED — read the FAIL lines above"; fi
exit $rc
