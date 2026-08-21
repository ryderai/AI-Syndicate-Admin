#!/usr/bin/env bash
# Pure-logic tests for the Aug 20 2026 build. No database, no keys, no network.
set -e
cd "$(dirname "$0")/../.."
node tests/brain/test.mjs

# The SQL half of the duplicate rule. Skips itself with a message when there is
# no local Postgres, so this script stays runnable on any machine.
bash tests/brain/sql-crosscheck.sh
