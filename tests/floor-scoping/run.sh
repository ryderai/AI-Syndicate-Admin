#!/usr/bin/env bash
# THE FLOOR — ONE READ, THREE LAYOUTS, AND THE LOCK ON THE ROW.  Aug 27 2026
#
#   1. the pure half — canEditLead, the availability switch, the stacking
#      filters, every band, the scan report, the four new sort columns, and the
#      structural check that only ONE thing in the page fetches leads
#   2. five timezones, because a Chicago browser at midday cannot see a single
#      one of the date bugs this repo has already shipped three times
#   3. the database half — migration 0020 against a real Postgres. That is the
#      WORKING half of the lock; everything in step 1 is the polite half.
#
# NO `set -e`, DELIBERATELY, and this is the one place this suite departs from
# tests/sales-sheet/run.sh. Under `set -e` one failing assertion in the pure half
# aborts the script, and the DATABASE half — the part that actually proves
# migration 0020 — never runs at all. That is exactly backwards: a failure in the
# polite half is the moment you most want the working half's answer. So each
# half's exit code is kept and the script exits non-zero at the end if anything
# failed.
#
# (An earlier version of this note said the pure half "currently ends with ONE
# failing assertion". It did, for about an hour: a member object with no `role`
# was handed every lead. Both halves of that were fixed the same day, and the
# suite is green. The note is corrected rather than deleted because the REASON
# for skipping `set -e` has nothing to do with that one failure.)
set -u
cd "$(dirname "$0")/../.."

rc=0

echo ""
echo "== the pure half =="
node tests/floor-scoping/test.mjs || rc=1

echo ""
echo "== five timezones =="
# NOT piped into tail. A pipeline's exit code is the LAST command's, so
# `node ... | tail -1` reports tail's success and a whole timezone could fail
# silently. The output goes to a file and the count is read back.
# THE COUNTS ARE REALLY COMPARED, not just printed. The first version of this
# loop said so in a comment and did not do it: both branches grepped the count and
# echoed it, and nothing ever held one zone's numbers against another's. A
# timezone that passes a DIFFERENT number of assertions is a date bug — some
# branch took a different path — and it would have printed as a green line.
# Found by a review, Aug 27 2026.
BASE=""
for TZ in America/Chicago America/New_York America/Los_Angeles UTC Pacific/Auckland; do
  TZ=$TZ node tests/floor-scoping/test.mjs > /tmp/floor-tz.log 2>&1
  zone_rc=$?
  COUNTS="$(grep -E '^[0-9]+ passed' /tmp/floor-tz.log | tail -1)"
  echo "  ${COUNTS:-<no count line>}  (TZ=$TZ)"
  if [ "$zone_rc" != "0" ]; then
    grep -E '^  FAIL' /tmp/floor-tz.log | sed 's/^/    /'
    rc=1
  fi
  if [ -z "$BASE" ]; then
    BASE="$COUNTS"
  elif [ "$COUNTS" != "$BASE" ]; then
    echo "    THE COUNTS DIFFER between timezones: '$BASE' under the first zone, '$COUNTS' under $TZ."
    echo "    A different number of assertions ran or passed, which means a branch took a"
    echo "    different path — that is a date bug even if both lines say 0 failed."
    rc=1
  fi
done

echo ""
echo "== the database half (migration 0020) =="
bash tests/floor-scoping/sql.sh || rc=1

echo ""
if [ "$rc" = "0" ]; then echo "  everything passed"; else echo "  something FAILED — read the FAIL lines above"; fi
exit $rc
