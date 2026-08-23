#!/usr/bin/env bash
# The sales system, Aug 21 2026: the Rules of Engagement engine and the sheet
# importer. Pure logic, then the database half. No keys, no network.
set -e
cd "$(dirname "$0")/../.."
node tests/sales/test.mjs

# The console has ONE date authority (src/lib/teamDay.js) and sales-rules.js
# cannot import it without making a cycle — so it has its own copy, and this
# proves the two still agree. Five timezones, because a Chicago browser at
# midday cannot see any of the bugs this catches.
for TZ in America/Chicago America/New_York America/Los_Angeles UTC Pacific/Auckland; do
  TZ=$TZ node tests/sales/teamday-crosscheck.mjs
done

# Applies every migration to a real Postgres and attacks the rules from a
# signed-in session. Skips itself with a message when there is no local
# Postgres, so this script stays runnable on any machine.
bash tests/sales/sql.sh
