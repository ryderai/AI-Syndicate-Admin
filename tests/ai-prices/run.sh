#!/usr/bin/env bash
# THE NON-ANTHROPIC PRICE ROWS — both halves.
#
# The pure half reads migration 0033's own SQL and prices real calls through
# lib/ai-cost.js. The database half proves the file applies, is re-runnable,
# and changes nothing it should not.
#
# Five timezones like tests/ai-cost/run.sh, and for the same reason: a zone you
# have to remember to set is a zone nobody sets. Nothing in test.mjs reads a
# clock, so all five must report the SAME counts — if they do not, something in
# lib/ai-cost.js took a different branch and that is a date bug.
#
# No `set -e`: one red zone must not abort the others.
set -u
cd "$(dirname "$0")/../.."
rc=0

echo ""
echo "== five timezones =="
BASE=""
for TZ in America/Chicago America/New_York America/Los_Angeles UTC Pacific/Auckland; do
  # --no-warnings: Node 24 prints an ExperimentalWarning that lands in captured
  # stderr elsewhere in this repo. Environmental, not a real failure.
  TZ=$TZ node --no-warnings tests/ai-prices/test.mjs > /tmp/ai-prices-tz.log 2>&1
  zone_rc=$?
  COUNTS="$(grep -E '^[0-9]+ passed' /tmp/ai-prices-tz.log | tail -1)"
  echo "  ${COUNTS:-<no count line>}  (TZ=$TZ)"
  if [ "$zone_rc" != "0" ]; then
    grep -E '^  FAIL' /tmp/ai-prices-tz.log | sed 's/^/    /'
    rc=1
  fi
  if [ -z "$BASE" ]; then BASE="$COUNTS"
  elif [ "$COUNTS" != "$BASE" ]; then
    echo "    THE COUNTS DIFFER between timezones: '$BASE' first, '$COUNTS' under $TZ."
    rc=1
  fi
done

echo ""
echo "== the database half (migration 0033) =="
# EXIT 2 FROM sql.sh MEANS SKIPPED, NOT PASSED. Folding a skip into "everything
# passed" is how a suite reports success with half of itself never run — which
# is the normal state on Ryder's Mac, where there is no Postgres.
bash tests/ai-prices/sql.sh
db_rc=$?
skipped=0
if [ "$db_rc" = "2" ]; then skipped=1; elif [ "$db_rc" != "0" ]; then rc=1; fi

echo ""
if [ "$rc" != "0" ]; then
  echo "  something FAILED — read the FAIL lines above"
elif [ "$skipped" = "1" ]; then
  echo "  the pure half passed. THE DATABASE HALF DID NOT RUN on this machine —"
  echo "  run it where there is a Postgres before calling 0033 proven."
else
  echo "  everything passed"
fi
exit $rc
