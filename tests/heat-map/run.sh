#!/usr/bin/env bash
# The landing-page heat map — 30 Sep 2026. Pure logic, then the real-Postgres half.
set -e
cd "$(dirname "$0")/../.."
node tests/heat-map/test.mjs
bash tests/heat-map/sql.sh
