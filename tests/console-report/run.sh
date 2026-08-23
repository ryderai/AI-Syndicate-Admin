#!/usr/bin/env bash
# The Overview generator (Aug 23 2026). Pure logic: no database, no AI key,
# no network, no browser.
#
# Run in two timezones. The counts are date-sensitive ("late", "overdue") and
# the whole point of src/lib/teamDay.js is that a browser's clock must not be
# able to change an answer.
set -e
cd "$(dirname "$0")/../.."
for tz in America/Chicago Pacific/Auckland; do
  echo "--- TZ=$tz ---"
  TZ="$tz" node tests/console-report/test.mjs
done
