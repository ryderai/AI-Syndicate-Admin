#!/usr/bin/env bash
# The Sales · Stats bar chart — which number it draws, how it sorts, and who it
# is allowed to call best. Pure logic. No keys, no network, no browser.
set -e
cd "$(dirname "$0")/../.."
node tests/rep-metrics/test.mjs
