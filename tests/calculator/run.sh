#!/usr/bin/env bash
# The AI Revenue Calculator's console side — 24 Sep 2026.
# No database, no keys, no network.
set -e
cd "$(dirname "$0")/../.."
node tests/calculator/test.mjs
node tests/calculator/columns.mjs
