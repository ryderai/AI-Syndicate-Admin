#!/usr/bin/env bash
# AI COST — the maths, in five timezones, plus the code-vs-database check.
#
# TZ IS SET HERE, IN THE RUNNER. tests/finance/run.sh is NOT the shape to copy:
# it has no timezone handling at all, and the four zones it is credited with in
# CONTEXT-FOR-AI.md were run by hand by whoever was at the keyboard. A zone you
# have to remember to set is a zone nobody sets. This follows
# tests/floor-scoping/run.sh instead.
#
# NO `set -e`. One failing assertion must not abort the run before the other
# zones have had their turn — a failure in one zone and not another IS the
# finding.
set -u
cd "$(dirname "$0")/../.."

rc=0

echo ""
echo "== five timezones =="
# Not piped into tail: a pipeline's exit code is the LAST command's, so a whole
# zone could fail silently behind a successful `tail`.
BASE=""
for TZ in America/Chicago America/New_York America/Los_Angeles UTC Pacific/Auckland; do
  TZ=$TZ node tests/ai-cost/test.mjs > /tmp/ai-cost-tz.log 2>&1
  zone_rc=$?
  COUNTS="$(grep -E '^[0-9]+ passed' /tmp/ai-cost-tz.log | tail -1)"
  echo "  ${COUNTS:-<no count line>}  (TZ=$TZ)"
  if [ "$zone_rc" != "0" ]; then
    grep -E '^  FAIL' /tmp/ai-cost-tz.log | sed 's/^/    /'
    rc=1
  fi
  if [ -z "$BASE" ]; then
    BASE="$COUNTS"
  elif [ "$COUNTS" != "$BASE" ]; then
    echo "    THE COUNTS DIFFER between timezones: '$BASE' first, '$COUNTS' under $TZ."
    echo "    A different number of assertions ran, which means a branch took a"
    echo "    different path. That is a date bug even if both lines say 0 failed."
    rc=1
  fi
done

echo ""
echo "== the database half (migration 0024) =="
# The pure half proves the maths agrees with itself. This half proves the
# DATABASE refuses what it is supposed to refuse — the dedupe key, the price
# window, the negative cost. A guard nobody has attacked is not a guard.
bash tests/ai-cost/sql.sh || rc=1

echo ""
if [ "$rc" = "0" ]; then echo "  everything passed"; else echo "  something FAILED — read the FAIL lines above"; fi
exit $rc
