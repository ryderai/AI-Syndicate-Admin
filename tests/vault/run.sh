#!/usr/bin/env bash
# The Aug 21 2026 build: the Vault and the client Report.
# Pure logic plus the real scrambling. No database, no network, no AI key.
set -e
cd "$(dirname "$0")/../.."
node tests/vault/test.mjs

# The database half: applies every migration to a real Postgres and attacks the
# vault's rules from a signed-in session. Skips itself with a message when there
# is no local Postgres, so this script stays runnable on any machine.
bash tests/vault/sql.sh
