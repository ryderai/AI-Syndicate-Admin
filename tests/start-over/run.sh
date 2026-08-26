#!/usr/bin/env bash
# STARTING OVER — import batches, and the only bulk delete in this console.
#
# The database half only. The browser half needs a build:
#   npm run build && node tests/start-over/walkthrough.mjs
set -e
cd "$(dirname "$0")/../.."
bash tests/start-over/sql.sh
