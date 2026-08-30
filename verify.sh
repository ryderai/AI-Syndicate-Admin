#!/usr/bin/env bash
# READ-ONLY. Changes nothing, anywhere. Only looks and reports.
#
# Checks the deployed site, the code, your local settings and the database,
# then prints a plain PASS / FAIL list at the bottom.
# Prints no passwords or keys — only yes/no, counts and status codes.
set -u
cd "$(dirname "$0")"
SITE="https://ai-syndicate-admin.vercel.app"
BUNDLE=$(mktemp)
trap 'rm -f "$BUNDLE"' EXIT

PASS=0; FAIL=0; WARN=0
ok()   { printf "  \033[32mPASS\033[0m  %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  \033[31mFAIL\033[0m  %s\n" "$1"; FAIL=$((FAIL+1)); }
warn() { printf "  \033[33mWARN\033[0m  %s\n" "$1"; WARN=$((WARN+1)); }
info() { printf "        %s\n" "$1"; }
val()  { grep -m1 "^$1=" .env.local 2>/dev/null | cut -d= -f2- ; }

echo ""
echo "═══════════════════════════════════════════════════"
echo "  DOES EVERYTHING WORK?   $(date '+%a %b %-d, %-I:%M %p')"
echo "═══════════════════════════════════════════════════"

echo ""
echo "── THE DEPLOYED WEBSITE ─────────────────────────"
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$SITE/" 2>/dev/null || echo 000)
case "$CODE" in
  200) warn "anyone on the internet can load it (status 200)"
       info "not broken — but set Deployment Protection to 'All Deployments' to close it" ;;
  401|403|307) ok "strangers are blocked (status $CODE)" ;;
  000) bad "the site did not answer at all" ;;
  *)   warn "unexpected status $CODE" ;;
esac

JS=$(curl -s --max-time 15 "$SITE/" 2>/dev/null | grep -oE 'assets/[^"]+\.js' | head -1)
if [ -z "${JS:-}" ]; then
  bad "could not find the site's javascript file — everything below is unknown"
else
  curl -s --max-time 60 "$SITE/$JS" -o "$BUNDLE" 2>/dev/null
  SZ=$(wc -c < "$BUNDLE" | tr -d ' ')
  if [ "${SZ:-0}" -lt 200000 ]; then
    bad "only downloaded $SZ bytes of the app — the checks below cannot be trusted"
  else
    info "read the whole app bundle ($SZ bytes)"
    grep -q "xweueatikwvnahegeful" "$BUNDLE" \
      && ok "the database address is in the build   ← the thing you just fixed" \
      || bad "the database address is STILL missing — Type must be Config, then Redeploy with the cache OFF"
    grep -qE "sb_publishable|eyJhbGciOiJIUzI1NiIs" "$BUNDLE" \
      && ok "the database key is in the build" \
      || bad "the database key is missing from the build"
    grep -q "What a deliverable costs us" "$BUNDLE" \
      && ok "the new AI Cost page is deployed" \
      || bad "the AI Cost page is not in this build — it is an old deploy"
    grep -q "not the same as being turned away" "$BUNDLE" \
      && ok "the fixed login error screen is deployed" \
      || bad "the login fix is not in this build — it is an old deploy"
  fi
fi

echo ""
echo "── YOUR CODE ────────────────────────────────────"
H=$(git rev-parse HEAD 2>/dev/null); O=$(git rev-parse origin/main 2>/dev/null)
[ -n "$H" ] && info "on commit $(git rev-parse --short HEAD)"
[ "$H" = "$O" ] && ok "your code matches GitHub" || bad "your code and GitHub differ — something is unpushed"
N=$(git status --porcelain 2>/dev/null | grep -c '^ M' || true)
[ "${N:-0}" = "0" ] && ok "no uncommitted edits to tracked files" || warn "$N tracked files edited but not committed"

echo ""
echo "── YOUR LAPTOP ──────────────────────────────────"
[ "$(val VITE_NO_SIGNIN)" = "false" ] && ok "local sign-in is ON (real login, real data)" \
                                      || bad "VITE_NO_SIGNIN is '$(val VITE_NO_SIGNIN)' — should be false"
[ -n "$(val VITE_SUPABASE_URL)" ] && ok "local database address set" || bad "local database address missing"
[ -n "$(val ANTHROPIC_API_KEY)" ] && ok "local AI key set" \
                                 || warn "no local AI key — AI features are off on localhost only"

echo ""
echo "── THE DATABASE ─────────────────────────────────"
SB=$(val SUPABASE_URL); SK=$(val SUPABASE_SERVICE_ROLE_KEY)
if [ -z "$SB" ] || [ -z "$SK" ]; then
  bad "cannot reach the database — keys missing from .env.local"
else
  ask() { curl -s --max-time 20 "$SB/rest/v1/$1" -H "apikey: $SK" -H "Authorization: Bearer $SK" 2>/dev/null; }

  R=$(ask "admin_users?select=email,role,active&order=email")
  if printf '%s' "$R" | grep -q '"email"'; then
    NUM=$(printf '%s' "$R" | grep -o '"email"' | wc -l | tr -d ' ')
    ok "the team roster reads back ($NUM on it)"
    printf '%s' "$R" | python3 -c 'import sys,json
for r in json.load(sys.stdin): print("        -", r["email"], "·", r["role"], "·", "active" if r["active"] else "INACTIVE")' 2>/dev/null
    printf '%s' "$R" | grep -q "andrew@" && ok "Andrew can get in" || warn "Andrew is NOT on the roster yet"
    printf '%s' "$R" | grep -q '"cj@'    && ok "CJ can get in"     || warn "CJ is NOT on the roster yet"
  else
    bad "could not read the roster: $(printf '%s' "$R" | head -c 100)"
  fi

  P=$(ask "ai_model_prices?select=model,provider")
  NP=$(printf '%s' "$P" | grep -o '"model"' | wc -l | tr -d ' ')
  [ "${NP:-0}" -ge 9 ] && ok "migration 0024 is in ($NP prices loaded)" \
                       || bad "price book looks wrong ($NP rows): $(printf '%s' "$P" | head -c 80)"

  U=$(ask "admin_usage_events?select=id,cost_micros,feature,client_id&limit=1")
  printf '%s' "$U" | grep -qE 'cost_micros|^\[\]' && ok "the new cost columns exist" \
                                                  || bad "cost columns missing: $(printf '%s' "$U" | head -c 80)"

  CNT=$(curl -s --max-time 20 "$SB/rest/v1/admin_usage_events?select=id" \
        -H "apikey: $SK" -H "Authorization: Bearer $SK" \
        -H "Prefer: count=exact" -H "Range: 0-0" -D - -o /dev/null 2>/dev/null \
        | grep -i "^content-range" | sed 's|.*/||' | tr -d '\r ')
  info "AI calls recorded so far: ${CNT:-unknown}"
fi

echo ""
echo "═══════════════════════════════════════════════════"
printf "  %d passed   %d failed   %d worth a look\n" "$PASS" "$FAIL" "$WARN"
if [ "$FAIL" -eq 0 ]; then
  echo ""
  echo "  Everything that can be checked from here works."
  echo "  LAST STEP, by hand: open $SITE"
  echo "  in a private window. You should get a LOGIN SCREEN,"
  echo "  not the 'Who do you want to be?' picker."
else
  echo ""
  echo "  Read the FAIL lines above — each one says what to do."
fi
echo "═══════════════════════════════════════════════════"
echo ""
