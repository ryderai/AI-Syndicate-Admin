#!/bin/bash
# Runs the inbox access tests against the REAL lib/ and api/ code, with Gmail and
# Supabase stubbed out. No keys, no network, no database.
#
#   bash tests/inbox/run.sh
#
# It works by copying the real files next to the stubs in a temp folder, so the
# real imports ("./supabase-server.js") resolve to the fakes. Node's ESM loader
# has no simple way to swap a module at runtime, and a copy is easier to reason
# about than a custom loader.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
mkdir -p "$TMP/lib" "$TMP/api"
# vault-crypto.js joined the list on Aug 27 2026: gmail-mailbox.js now encrypts a
# refresh token on its first read (migration 0021), so the real file has to travel
# with it. It imports nothing but node:crypto, so a plain copy is enough.
cp "$ROOT/lib/gmail-mailbox.js" "$ROOT/lib/client-standing.js" "$ROOT/lib/vault-crypto.js" "$TMP/lib/"
cp "$ROOT/api/gmail-modify.js" "$ROOT/api/gmail-send.js" "$ROOT/api/gmail-accounts.js" "$ROOT/api/gmail-threads.js" "$TMP/api/"
cp "$(dirname "$0")/stubs/supabase-server.js" "$(dirname "$0")/stubs/google-oauth.js" "$TMP/lib/"
cp "$(dirname "$0")/test.mjs" "$TMP/"
echo '{ "type": "module", "private": true, "name": "inbox-tests" }' > "$TMP/package.json"
cd "$TMP" && node test.mjs
STATUS=$?
rm -rf "$TMP"
exit $STATUS
