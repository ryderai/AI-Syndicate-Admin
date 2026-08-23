#!/usr/bin/env bash
# Date maths for the Overview snapshot (Aug 22 2026).
# No database, no keys, no network, no browser.
#
# Runs five times, once per timezone. The bugs this replaced were all invisible
# in a Chicago browser at midday, so one run would have proved nothing.
set -e
cd "$(dirname "$0")/../.."
for tz in America/Chicago America/New_York America/Los_Angeles UTC Pacific/Auckland; do
  TZ="$tz" node tests/overview/test.mjs
done
echo
echo "All five timezones passed."
