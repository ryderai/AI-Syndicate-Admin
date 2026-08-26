#!/usr/bin/env bash
# The rep's Work page — the answer box and the pipeline numbers (Aug 26 2026).
# Pure logic: no database, no AI key, no network, no browser.
#
# Run in four timezones. "Going cold", "the claim drops" and "due today" are all
# counted in the team's calendar days, and the whole point of that is that the
# machine's clock must not be able to change an answer. Three date bugs shipped
# here in one day, every one of them invisible in a Chicago browser at midday.
set -e
cd "$(dirname "$0")/../.."
for tz in America/Chicago America/New_York UTC Pacific/Auckland; do
  TZ="$tz" node tests/rep-brief/test.mjs
done
echo
echo "All four timezones passed."
