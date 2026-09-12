#!/usr/bin/env bash
# Recording meetings: lib/meetings.js, checked against migration 0034's own
# constraints. Pure logic, no browser and no database.
#
# FIVE TIMEZONES, NOT ONE. This file's whole job is turning what somebody typed
# into a DAY. A date parser tested in one timezone has not been tested — and
# this project has already shipped a UTC-vs-local bug that misfiled a month of
# costs. Chicago is the team's own; the other four are the ones that break
# naive code: a half-hour offset, one that is a full day ahead, and both sides
# of the prime meridian.
set -e
cd "$(dirname "$0")/../.."
for TZNAME in America/Chicago UTC Pacific/Kiritimati Asia/Kolkata Pacific/Honolulu; do
  TZ="$TZNAME" node tests/meetings/test.mjs
done
