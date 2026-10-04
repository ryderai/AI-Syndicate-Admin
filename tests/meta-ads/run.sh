#!/usr/bin/env bash
# The Meta page — 4 Oct 2026. No network, no keys.
set -e
cd "$(dirname "$0")/../.."
node tests/meta-ads/test.mjs
node tests/meta-ads/handler.mjs
