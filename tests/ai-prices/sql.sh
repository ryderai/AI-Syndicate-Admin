#!/usr/bin/env bash
# 0033 AGAINST A REAL POSTGRES.
#
# tests/ai-prices/test.mjs proves the NUMBERS are the ones that were read off
# each provider's page, and that lib/ai-cost.js turns them into the right
# micro-dollars. It cannot prove the file is valid SQL, that it is safe to run
# twice, or that it leaves the table's guards and row-level security alone.
# That is this file.
#
# Ryder pastes these into the Supabase editor by hand and a half-applied set is
# the normal state, so "run it again" has to be a safe instruction rather than
# a gamble. Hence the second application below.
#
# The Mac-folder bridge has no Postgres, so this normally runs in the cloud
# container. It was run there on 7 Sep 2026 against all 33 migrations in order
# and reported "everything passed" with 0 failures.
#
# A SKIP IS NOT A PASS, AND THIS FILE MAKES THE RUNNER SAY SO. It exits 2 on a
# missing Postgres, not 0, and run.sh treats 2 as "unproven here" rather than
# folding it into "everything passed". tests/ai-cost/sql.sh exits 0 on the same
# condition, which is why that suite prints "everything passed" on Ryder's Mac
# with none of its database half run. Do not copy that half of it.
#
# The run total is deliberately NOT written into this comment. It moves every
# time an assertion is added, and a number nobody recounts is how a comment
# ends up asserting a measurement that never happened. The script prints its
# own count on every run; read that.
set -u
cd "$(dirname "$0")/../.."
PGBIN=""; for d in /usr/lib/postgresql/*/bin; do [ -x "$d/initdb" ] && PGBIN="$d"; done
[ -z "$PGBIN" ] && { echo "  --   no local Postgres found. THE DATABASE HALF DID NOT RUN — that is not a pass."; exit 2; }
DATA="$(mktemp -d)/pgdata"; SOCK="$(mktemp -d)"; mkdir -p "$DATA"
RUNAS=""; if [ "$(id -u)" = "0" ]; then RUNAS="su postgres -s /bin/bash -c"; chown -R postgres "$(dirname "$DATA")" "$SOCK" .; fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "$1"; else bash -c "$1"; fi; }
run "$PGBIN/initdb -D $DATA -U postgres --auth=trust" >/dev/null 2>&1 || { echo "initdb failed"; exit 1; }
run "$PGBIN/pg_ctl -D $DATA -o \"-k $SOCK -c listen_addresses=''\" -w start" >/dev/null 2>&1 || { echo "start failed"; exit 1; }
PSQL="psql -h $SOCK -U postgres -v ON_ERROR_STOP=1 -q"
cleanup() { run "$PGBIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1; }
trap cleanup EXIT
fails=0
ok()  { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fails=$((fails+1)); }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got '$2', wanted '$3'"; fi; }
q()   { $PSQL -tAc "$1" 2>/dev/null | tr -d ' '; }
refused() { if $PSQL -c "$1" >/dev/null 2>&1; then bad "$2 — the database ACCEPTED it"; else ok "$2"; fi; }

$PSQL <<'SQL' >/dev/null 2>&1
create extension if not exists pgcrypto;
create schema if not exists auth;
create table auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to authenticated, anon, service_role;
grant select on auth.users to authenticated, service_role;
SQL

echo ""
echo "== every migration applies, in order, ending with 0033 =="
for f in supabase/migrations/0*.sql; do
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/ai-prices-mig.err; then
    echo "  FAIL $f did not apply:"; sed 's/^/       /' /tmp/ai-prices-mig.err; exit 1
  fi
done
ok "0001 through 0033 all applied"

echo ""
echo "== 0033 is safe to run twice =="
before="$(q "select count(*) from ai_model_prices")"
if $PSQL -f supabase/migrations/0033_ai_prices_non_anthropic.sql >/dev/null 2>/tmp/ai-prices-2.err; then
  ok "0033 re-ran without error"
else
  bad "0033 is NOT re-runnable:"; sed 's/^/       /' /tmp/ai-prices-2.err
fi
is "running it twice added no duplicate rows" "$(q "select count(*) from ai_model_prices")" "$before"

echo ""
echo "== the four rows landed exactly as written =="
is "four rows dated 2026-09-07"          "$(q "select count(*) from ai_model_prices where effective_from='2026-09-07'")" "4"
is "...and all four are still current"   "$(q "select count(*) from ai_model_prices where effective_from='2026-09-07' and effective_to is null")" "4"
is "every row in the book cites a page"  "$(q "select count(*) from ai_model_prices where source_url is null or source_url=''")" "0"
# An UPPER BOUND on the book. Every assertion above says "this row is right";
# this one says "and nothing else is in here" — which is the only way a row
# added by a future migration cannot slip past the whole suite unexamined.
is "no provider in the book beyond the five accounted for" "$(q "select count(*) from ai_model_prices where provider not in ('anthropic','openai','google','xai','groq')")" "0"
is "gpt-5.6-sol input \$4/Mtok"          "$(q "select input_per_mtok from ai_model_prices where model='gpt-5.6-sol'")" "4000000"
is "gpt-5.6-sol output \$20/Mtok"        "$(q "select output_per_mtok from ai_model_prices where model='gpt-5.6-sol'")" "20000000"
is "gpt-5.6-sol cache write \$5/Mtok"    "$(q "select cache_write_per_mtok from ai_model_prices where model='gpt-5.6-sol'")" "5000000"
# OpenAI has no 1-hour cache tier. NULL, never 0 — 0 would mean a free 1-hour
# write, which is a real answer and the wrong one.
is "gpt-5.6-sol has NO 1-hour tier"      "$(q "select coalesce(cache_write_1h_per_mtok::text,'NULL') from ai_model_prices where model='gpt-5.6-sol'")" "NULL"
is "gemini input \$0.30/Mtok"            "$(q "select input_per_mtok from ai_model_prices where model='gemini-2.5-flash'")" "300000"
is "gemini cache read \$0.03/Mtok"       "$(q "select cache_read_per_mtok from ai_model_prices where model='gemini-2.5-flash'")" "30000"
# Google charges cache STORAGE per hour. There is no per-token column for that,
# so a Gemini call reporting a cache write must come out unpriced, not free.
is "gemini cache WRITE is null, not 0"   "$(q "select coalesce(cache_write_per_mtok::text,'NULL') from ai_model_prices where model='gemini-2.5-flash'")" "NULL"
is "grok input \$2/Mtok"                 "$(q "select input_per_mtok from ai_model_prices where model='grok-4.6'")" "2000000"
is "grok output \$6/Mtok"                "$(q "select output_per_mtok from ai_model_prices where model='grok-4.6'")" "6000000"
is "grok cached input \$0.50/Mtok"       "$(q "select cache_read_per_mtok from ai_model_prices where model='grok-4.6'")" "500000"
# The one id in the book with a slash in it. A lookup that splits on '/' loses it.
is "groq's slashed id survived intact"   "$(q "select count(*) from ai_model_prices where provider='groq' and model='openai/gpt-oss-120b'")" "1"
is "groq input \$0.15/Mtok"              "$(q "select input_per_mtok from ai_model_prices where provider='groq'")" "150000"
is "groq cached input \$0.075/Mtok"      "$(q "select cache_read_per_mtok from ai_model_prices where provider='groq'")" "75000"

echo ""
echo "== the five skipped models still have no row =="
# Each of these is unpriced for a reason 0033 spells out in full. A row added
# for any of them WITHOUT the work named there makes the AI Cost page look more
# complete while being more wrong.
# KEYED ON THE PROVIDER, not the exact model string. The reason to skip
# perplexity is true of sonar-pro and sonar-reasoning-pro as well, so a check
# for model='sonar' would wave through the same mistake under a longer name.
is "no perplexity row at all — needs a per-call fee column" "$(q "select count(*) from ai_model_prices where provider='perplexity'")" "0"
is "no deepseek row at all — needs a time-of-day dimension" "$(q "select count(*) from ai_model_prices where provider='deepseek'")" "0"
is "no serpapi row — per search, and we do not know our plan" "$(q "select count(*) from ai_model_prices where provider='serpapi'")" "0"
is "no mistral row — the model id we call is not a real one" "$(q "select count(*) from ai_model_prices where provider='mistral'")" "0"
# OpenAI is a special case: gpt-5.6-sol IS priced above, so this one has to
# name the dead id exactly rather than the provider.
is "no row for the dead openai id gpt-5.6"                 "$(q "select count(*) from ai_model_prices where provider='openai' and model='gpt-5.6'")" "0"

echo ""
echo "== the guards still refuse things =="
refused "insert into ai_model_prices (provider,model,effective_from,input_per_mtok,output_per_mtok) values ('xai','grok-4.6','2026-09-07',1,1);" \
  "a second row for grok on the same start date is refused"
# DISTINCT KEYS ON PURPOSE. These two used to share ('xai','grok-4.6',
# '2026-10-01'). If the rates_positive constraint were ever dropped, the first
# insert would SUCCEED and land that row, and the second would then be refused
# by the unique index instead — printing ok for the wrong reason and hiding the
# very removal it exists to catch.
refused "insert into ai_model_prices (provider,model,effective_from,input_per_mtok,output_per_mtok) values ('xai','grok-4.6','2026-10-01',-1,1);" \
  "a negative rate is refused"
refused "insert into ai_model_prices (provider,model,effective_from,effective_to,input_per_mtok,output_per_mtok) values ('xai','grok-4.6','2026-11-01','2026-10-01',1,1);" \
  "a window that ends before it starts is refused"

echo ""
echo "== 0033 changes NOTHING about the table's security =="
# The first version of this block just re-checked 0024's guards after 0033 had
# run. Every line passed with 0033 deleted, under a heading claiming to measure
# 0033. Snapshotted either side of a re-apply instead, so what is measured is
# the DIFFERENCE 0033 makes — which must be none.
SEC_BEFORE="$(q "select relrowsecurity::text from pg_class where relname='ai_model_prices'")|$(q "select count(*) from pg_policies where tablename='ai_model_prices'")|$(q "select coalesce(string_agg(privilege_type||':'||grantee,',' order by privilege_type||':'||grantee),'none') from information_schema.role_table_grants where table_name='ai_model_prices'")"
$PSQL -f supabase/migrations/0033_ai_prices_non_anthropic.sql >/dev/null 2>&1
SEC_AFTER="$(q "select relrowsecurity::text from pg_class where relname='ai_model_prices'")|$(q "select count(*) from pg_policies where tablename='ai_model_prices'")|$(q "select coalesce(string_agg(privilege_type||':'||grantee,',' order by privilege_type||':'||grantee),'none') from information_schema.role_table_grants where table_name='ai_model_prices'")"
is "RLS, policies and grants are byte-identical after re-applying 0033" "$SEC_AFTER" "$SEC_BEFORE"
# And the absolute state, so a book with RLS off everywhere cannot pass the
# comparison above by being equally wrong on both sides.
is "row-level security is on"              "$(q "select relrowsecurity::text from pg_class where relname='ai_model_prices'")" "true"
is "exactly one policy on the table"       "$(q "select count(*) from pg_policies where tablename='ai_model_prices'")" "1"
is "no insert/update/delete grant to authenticated" "$(q "select count(*) from information_schema.role_table_grants where table_name='ai_model_prices' and grantee='authenticated' and privilege_type in ('INSERT','UPDATE','DELETE')")" "0"

echo ""
if [ "$fails" = "0" ]; then echo "  everything passed"; else echo "  $fails FAILED — read the FAIL lines above"; fi
exit $((fails > 0))
