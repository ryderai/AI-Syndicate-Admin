#!/usr/bin/env bash
# Turning a report into an email or a text (Aug 24 2026).
# No database, no keys, no network, no browser.
set -e
cd "$(dirname "$0")/../.."
node tests/share/test.mjs
