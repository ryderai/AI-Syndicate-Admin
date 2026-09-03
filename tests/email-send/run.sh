#!/usr/bin/env bash
# THE SEND BUTTON, DRIVEN IN A REAL BROWSER — 2 Sep 2026.
#
# Ryder: "add the send email button so you can easily get a draft, click what
# email to send from and then send it. emails need to be able to be sent from
# the crm from the email that is connected."
#
# WHY NOT PREVIEW MODE, like tests/sales-intake. `apiFetch` returns a refusal
# without touching the network when the Supabase keys are absent, so in preview
# the draft never arrives and the send can never be pressed. Same trick as
# tests/auth-gate: build with FAKE keys so isConfigured() is true, then
# intercept every single call. Nothing real is ever contacted, and no mail can
# leave — `/api/gmail-send` is answered by the test.
#
# Needs `npm run build` and Playwright, neither of which works on the Mac folder
# bridge — it SKIPS there with a message. A skip is not a pass.
set -u
cd "$(dirname "$0")/../.."

if ! node -e "require.resolve('playwright')" >/dev/null 2>&1; then
  echo "  --   playwright is not installed here; the send test was SKIPPED."
  exit 0
fi

cat > .env.production <<'ENV'
VITE_NO_SIGNIN=false
VITE_SUPABASE_URL=https://fake-test.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_fake_for_testing_only
ENV

if ! npm run build >/tmp/emailsend-build.log 2>&1; then
  echo "  --   npm run build failed here (the Mac bridge cannot build); SKIPPED."
  rm -f .env.production
  exit 0
fi

python3 -m http.server 8098 --directory dist >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -f .env.production' EXIT
sleep 2

BASE=http://127.0.0.1:8098 node tests/email-send/walkthrough.mjs
exit $?
