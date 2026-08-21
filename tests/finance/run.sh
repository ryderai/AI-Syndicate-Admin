#!/usr/bin/env bash
# Pure-logic tests for the Finance + Invoices build (Aug 20 2026).
# No database, no keys, no network.
set -e
cd "$(dirname "$0")/../.."
node tests/finance/test.mjs
