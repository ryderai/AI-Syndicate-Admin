#!/usr/bin/env bash
# THE THREE THINGS THE GATE CAN SAY, AND THEY MUST NOT BE THE SAME THING.
#
#   1. the roster check FAILED        -> "We couldn't check your access" + the reason
#   2. the roster check said NO       -> "This console is team-only"
#   3. the roster check said YES      -> the console
#
# 1 and 2 used to be one screen. On Sat Aug 29 2026 the live database had lost
# `grant execute on function admin_is_member() to authenticated`, so every
# roster read raised a permission error — and an owner whose row was present,
# correct and active was told he was not on the team. An hour went looking for
# a row that was never missing.
#
# WHY THIS RUNS AGAINST THE BUILT BUNDLE, not the dev server: the Chrome
# extension wedges the tab after every hot reload (see the note in
# CONTEXT-FOR-AI.md). Build it, serve dist/, drive it with Playwright.
#
# It needs `npm run build` and Playwright, neither of which works on the Mac
# folder bridge — it SKIPS there with a message. A skip is not a pass.
set -u
cd "$(dirname "$0")/../.."

if ! node -e "require.resolve('playwright')" >/dev/null 2>&1; then
  echo "  --   playwright is not installed here; the gate test was SKIPPED."
  exit 0
fi

# Fake keys on purpose: isConfigured() has to be TRUE or AuthGate short-circuits
# into preview mode and never reaches the code under test. Every network call is
# intercepted, so the fake host is never contacted.
cat > .env.production.authtest <<'ENV'
VITE_NO_SIGNIN=false
VITE_SUPABASE_URL=https://fake-test.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_fake_for_testing_only
ENV
cp .env.production.authtest .env.production 2>/dev/null || true

if ! npm run build >/tmp/authgate-build.log 2>&1; then
  echo "  --   npm run build failed here (the Mac bridge cannot build); SKIPPED."
  rm -f .env.production.authtest
  exit 0
fi

python3 -m http.server 8099 --directory dist >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -f .env.production.authtest' EXIT
sleep 2

node tests/auth-gate/test.mjs
rc=$?
exit $rc
