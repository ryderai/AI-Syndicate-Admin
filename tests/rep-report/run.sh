#!/usr/bin/env bash
# The rep's Work-page answer box (Aug 26 2026). Pure logic: no database, no AI
# key, no network, no browser.
#
# Run in two timezones. "Going cold" and "the claim drops" are counted in the
# team's calendar days, and the whole point of that is that the machine's clock
# must not be able to change an answer.
set -e
cd "$(dirname "$0")/../.."
for tz in America/Chicago Pacific/Auckland; do
  echo "--- TZ=$tz ---"
  TZ="$tz" node tests/rep-report/test.mjs
done
