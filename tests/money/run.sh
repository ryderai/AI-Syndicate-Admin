#!/usr/bin/env bash
# Money pages — the range, the split, the maths — in four timezones.
set -u
cd "$(dirname "$0")/../.."
rc=0
for tz in America/Chicago UTC Asia/Tokyo Pacific/Honolulu; do
  TZ=$tz node tests/money/test.mjs > /tmp/money-$$.log 2>&1 || { rc=1; cat /tmp/money-$$.log; }
  tail -1 /tmp/money-$$.log
done
rm -f /tmp/money-$$.log
echo ""
echo "== 0041 against a real Postgres =="
bash tests/money/sql.sh; src=$?
if [ $src -eq 2 ]; then echo "  (SQL half SKIPPED — not a pass)"; [ $rc -eq 0 ] && rc=2; elif [ $src -ne 0 ]; then rc=1; fi
exit $rc
