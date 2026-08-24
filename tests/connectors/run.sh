#!/usr/bin/env bash
# The client's own connected accounts (Aug 24 2026).
# No database, no keys, no network, no browser.
#
# Run in five timezones. Every date bug this repo has had was invisible from a
# Chicago desk at midday, so one run would prove nothing.
set -e
cd "$(dirname "$0")/../.."
for tz in America/Chicago America/New_York America/Los_Angeles UTC Pacific/Auckland; do
  TZ="$tz" node tests/connectors/test.mjs
done
echo
echo "All five timezones passed."
