#!/usr/bin/env bash
# CLIENT ECONOMICS — what a client pays, what they cost, what is left.
#
# Pure maths, no database, no browser. Run in three timezones because money is
# bucketed by date elsewhere on the page and a figure that changes with the
# machine's clock is the kind of bug that only shows up on somebody else's
# laptop.
#
# NO `set -e`: a failure in one zone and not another IS the finding, so every
# zone gets its turn.
set -u
cd "$(dirname "$0")/../.."
rc=0
for tz in UTC America/Chicago Pacific/Kiritimati; do
  echo ""
  echo "== TZ=$tz =="
  TZ="$tz" node --test tests/client-economics/test.mjs
  [ $? -eq 0 ] || rc=1
done
echo ""
[ $rc -eq 0 ] && echo "  client-economics: all zones green." || echo "  client-economics: FAILING."
exit $rc
