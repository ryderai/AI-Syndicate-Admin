#!/usr/bin/env bash
# The Home Services landing-page build — 14 Sep 2026.
# No database, no keys, no network. Pure logic plus two readers that check the
# code against the real CREATE TABLE in supabase/migrations/.
set -e
cd "$(dirname "$0")/../.."
node tests/home-services/test.mjs

# The column guard. It reads the migrations for what the tables really hold and
# every Supabase call in the new files for what the code says they hold, and
# fails on any name that is not a column. Separate file because it is a
# different kind of check from the maths above — and because a guard that lives
# next to the tests it protects gets read.
node tests/home-services/columns.mjs
