#!/usr/bin/env bash
# WHAT IS ACTUALLY TRUE RIGHT NOW — run it, paste the output back to Claude.
# v2: nothing is held in memory and every network call has a hard time limit,
# so it cannot hang. v1 tried to load the whole 1.4MB app bundle into a shell
# variable and sat there.
#
# IT PRINTS NO SECRETS — only yes/no, counts and status codes.
set -u
cd "$(dirname "$0")"
say() { printf "  %-42s %s\n" "$1" "$2"; }
SITE="https://ai-syndicate-admin.vercel.app"
C="curl -s --max-time 15"

echo ""
echo "==============================================="
echo " AI SYNDICATE — STATE CHECK  $(date '+%a %b %d %-I:%M %p')"
echo "==============================================="

echo ""
echo "1. THE DEPLOYED WEBSITE"
CODE=$($C -o /dev/null -w "%{http_code}" "$SITE/" 2>/dev/null || echo "no answer")
say "http status" "$CODE"
[ "$CODE" = "200" ] && say "locked to strangers?" "NO — anyone can load it" \
                    || say "locked to strangers?" "yes ($CODE)"

JS=$($C "$SITE/" 2>/dev/null | grep -oE 'assets/[^"]+\.js' | head -1)
say "javascript file" "${JS:-could not read}"

if [ -n "${JS:-}" ]; then
  # Streamed straight into grep. Never stored. 45s ceiling.
  HITS=$(curl -s --max-time 45 "$SITE/$JS" 2>/dev/null | grep -c "xweueatikwvnahegeful" || true)
  [ "${HITS:-0}" -gt 0 ] \
    && say "database keys inside the build?" "YES — real login should appear" \
    || say "database keys inside the build?" "NO — this is why it says SAMPLE DATA"
  COST=$(curl -s --max-time 45 "$SITE/$JS" 2>/dev/null | grep -c "What a deliverable costs us" || true)
  [ "${COST:-0}" -gt 0 ] && say "new AI Cost page in the build?" "yes" \
                         || say "new AI Cost page in the build?" "no — old build"
fi

echo ""
echo "2. THE CODE"
say "commit you are on" "$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
say "matches GitHub?" "$( [ "$(git rev-parse HEAD 2>/dev/null)" = "$(git rev-parse origin/main 2>/dev/null)" ] && echo yes || echo 'NO — something is unpushed' )"

echo ""
echo "3. YOUR LOCAL SETTINGS"
val() { grep -m1 "^$1=" .env.local 2>/dev/null | cut -d= -f2- ; }
say "sign-in switched off locally?" "$(val VITE_NO_SIGNIN)"
say "database address set?" "$( [ -n "$(val VITE_SUPABASE_URL)" ] && echo yes || echo NO )"
say "database key set?"     "$( [ -n "$(val VITE_SUPABASE_ANON_KEY)" ] && echo yes || echo NO )"
say "AI key set?"           "$( [ -n "$(val ANTHROPIC_API_KEY)" ] && echo yes || echo 'NO — AI is off locally' )"

echo ""
echo "4. THE DATABASE"
SB=$(val SUPABASE_URL); SK=$(val SUPABASE_SERVICE_ROLE_KEY)
if [ -z "$SB" ] || [ -z "$SK" ]; then
  say "database" "cannot reach it — keys missing from .env.local"
else
  ask() { curl -s --max-time 20 "$SB/rest/v1/$1" -H "apikey: $SK" -H "Authorization: Bearer $SK" 2>/dev/null; }
  R=$(ask "admin_users?select=email,role,active&order=email")
  if printf '%s' "$R" | grep -q '"email"'; then
    echo "  who can get into the console:"
    printf '%s' "$R" | python3 -c 'import sys,json
for r in json.load(sys.stdin): print("     -", r["email"], "·", r["role"], "·", "active" if r["active"] else "INACTIVE")' 2>/dev/null \
      || printf '     %s\n' "$R"
  else
    say "roster" "could not read: $(printf '%s' "$R" | head -c 110)"
  fi
  P=$(ask "ai_model_prices?select=model")
  N=$(printf '%s' "$P" | grep -o '"model"' | wc -l | tr -d ' ')
  printf '%s' "$P" | grep -q '"model"' && say "migration 0024 run?" "yes — $N prices loaded" \
                                       || say "migration 0024 run?" "NO: $(printf '%s' "$P" | head -c 90)"
  U=$(ask "admin_usage_events?select=id,cost_micros,feature&limit=1")
  printf '%s' "$U" | grep -q "cost_micros\|^\[\]$" && say "new cost columns exist?" "yes" \
                                                   || say "new cost columns exist?" "NO: $(printf '%s' "$U" | head -c 90)"
  CNT=$(curl -s --max-time 20 "$SB/rest/v1/admin_usage_events?select=id" -H "apikey: $SK" -H "Authorization: Bearer $SK" -H "Prefer: count=exact" -H "Range: 0-0" -D - -o /dev/null 2>/dev/null | grep -i "content-range" | sed 's|.*/||' | tr -d '\r')
  say "AI calls recorded so far" "${CNT:-unknown}"
fi

echo ""
echo "==============================================="
echo " Paste everything above back to Claude."
echo "==============================================="
echo ""
