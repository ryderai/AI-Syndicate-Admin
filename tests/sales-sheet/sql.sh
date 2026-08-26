#!/usr/bin/env bash
# THE DATABASE HALF OF "ONE RECORD, LEAD → PAYING CLIENT".
#
# Migration 0015 is the file that finally writes the two links that have
# existed and stayed empty since Aug 22. Reading it and saying "that looks
# right" is not a test. This stands up a real Postgres 16, applies every
# migration in order, and attacks it:
#
#   · does the name backfill fill both halves and leave `name` alone
#   · does Won actually create a client, link the firm, and write a timeline row
#   · is it SAFE TO PRESS TWICE — one client, not two, and no error
#   · do the OTHER contacts at that firm get attached, without being credited
#     with a sale they did not make
#   · does it reuse a client that already exists instead of making a second one
#   · does it refuse rather than file a client called nothing
#   · does it leave a typed-in contact alone
#   · can a sales rep run it, and can a signed-out visitor not
#
# Skips itself with a message when there is no local Postgres.
set -u
cd "$(dirname "$0")/../.."

PGBIN=""
for d in /usr/lib/postgresql/*/bin; do [ -x "$d/initdb" ] && PGBIN="$d"; done
if [ -z "$PGBIN" ]; then
  echo "  --   no local Postgres found; the SQL half was SKIPPED."
  exit 0
fi

DATA="$(mktemp -d)/pgdata"
SOCK="$(mktemp -d)"
mkdir -p "$DATA"
RUNAS=""
if [ "$(id -u)" = "0" ]; then
  RUNAS="su postgres -s /bin/bash -c"
  chown -R postgres "$(dirname "$DATA")" "$SOCK"
fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "$1"; else bash -c "$1"; fi; }

run "$PGBIN/initdb -D $DATA -U postgres --auth=trust" >/dev/null 2>&1 || { echo "  --   Postgres would not start; SKIPPED."; exit 0; }
run "$PGBIN/pg_ctl -D $DATA -o \"-k $SOCK -c listen_addresses=''\" -w start" >/dev/null 2>&1 || { echo "  --   Postgres would not start; SKIPPED."; exit 0; }

PSQL="psql -h $SOCK -U postgres -v ON_ERROR_STOP=1 -q"
cleanup() { run "$PGBIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1; }
trap cleanup EXIT

fails=0
ok()  { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fails=$((fails+1)); }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got '$2', wanted '$3'"; fi; }

$PSQL <<'SQL' >/dev/null
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

for f in supabase/migrations/0*.sql; do
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/lcmig.err; then
    echo "  FAIL migration $f did not apply:"; sed 's/^/       /' /tmp/lcmig.err; exit 1
  fi
done
$PSQL -c "grant all on all tables in schema public to service_role;" >/dev/null
ok "every migration 0001-0015 applies in order"

$PSQL <<'SQL' >/dev/null
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','owner@x.com'),
  ('22222222-2222-2222-2222-222222222222','rep@x.com');
insert into public.admin_users (user_id, email, full_name, role, active) values
  ('11111111-1111-1111-1111-111111111111','owner@x.com','Owner O','owner',true),
  ('22222222-2222-2222-2222-222222222222','rep@x.com','Rep R','sales',true);
SQL

OWNER='11111111-1111-1111-1111-111111111111'
REP='22222222-2222-2222-2222-222222222222'
as_rep_val()   { $PSQL -tAc "set local role authenticated; set local request.jwt.claim.sub = '$REP'; $1"   | tail -n 1 | tr -d '[:space:]'; }
as_owner_val() { $PSQL -tAc "set local role authenticated; set local request.jwt.claim.sub = '$OWNER'; $1" | tail -n 1 | tr -d '[:space:]'; }
val()          { $PSQL -tAc "$1" | tail -n 1 | tr -d '[:space:]'; }
valraw()       { $PSQL -tAc "$1" | tail -n 1; }

# ==================================================================
# 1. THE NAME BACKFILL
# ==================================================================
# Rows written BEFORE 0015 existed have no first/last. Simulated by inserting
# with both null and re-running the file — which also proves it is re-runnable.
$PSQL <<'SQL' >/dev/null
insert into public.admin_leads (id, name, stage) values
  ('aaaaaaa1-0000-0000-0000-000000000001','Anna Jones','new'),
  ('aaaaaaa1-0000-0000-0000-000000000002','Mary Jo Van Der Berg','new'),
  ('aaaaaaa1-0000-0000-0000-000000000003','Cher','new'),
  ('aaaaaaa1-0000-0000-0000-000000000004','   ','new');
SQL

if $PSQL -f supabase/migrations/0015_sales_lifecycle.sql >/dev/null 2>/tmp/lcmig.err; then
  ok "0015 can be run twice without breaking"
else
  bad "0015 is not re-runnable:"; sed 's/^/       /' /tmp/lcmig.err
fi

is "a two-word name fills both halves" \
  "$(val "select first_name||'|'||last_name from public.admin_leads where id='aaaaaaa1-0000-0000-0000-000000000001';")" "Anna|Jones"
is "a long name keeps everything after the first word" \
  "$(val "select first_name||'|'||last_name from public.admin_leads where id='aaaaaaa1-0000-0000-0000-000000000002';")" "Mary|JoVanDerBerg"
is "one word is a first name and the last stays empty" \
  "$(val "select first_name||'|'||coalesce(last_name,'<null>') from public.admin_leads where id='aaaaaaa1-0000-0000-0000-000000000003';")" "Cher|<null>"
is "a blank name is not turned into a blank first name" \
  "$(val "select coalesce(first_name,'<null>') from public.admin_leads where id='aaaaaaa1-0000-0000-0000-000000000004';")" "<null>"
# THE ONE THAT MAKES THE GUESS SAFE: the original is never overwritten, so a
# wrong split is visible and fixable rather than destructive.
is "the display name is left exactly as it was" \
  "$(valraw "select name from public.admin_leads where id='aaaaaaa1-0000-0000-0000-000000000002';" | tr -d '[:space:]')" "MaryJoVanDerBerg"

# A row that already has halves is not re-guessed by a second run.
$PSQL -c "update public.admin_leads set first_name='Corrected', last_name='ByHand' where id='aaaaaaa1-0000-0000-0000-000000000001';" >/dev/null
$PSQL -f supabase/migrations/0015_sales_lifecycle.sql >/dev/null 2>&1
is "a correction typed by a person survives another run of the migration" \
  "$(val "select first_name from public.admin_leads where id='aaaaaaa1-0000-0000-0000-000000000001';")" "Corrected"

# ==================================================================
# 2. WON → CLIENT
# ==================================================================
$PSQL <<'SQL' >/dev/null
insert into public.admin_companies (id, name, domain, vertical, phone)
  values ('cccccccc-0000-0000-0000-000000000001','Harborline Realty Group','harborline.com','realtor','(555) 000-1111');
insert into public.admin_leads (id, name, email, phone, company_id, stage, owner_id) values
  ('bbbbbbb1-0000-0000-0000-000000000001','Dana Whitfield','dana@harborline.com','(555) 310-5461','cccccccc-0000-0000-0000-000000000001','proposal','22222222-2222-2222-2222-222222222222'),
  ('bbbbbbb1-0000-0000-0000-000000000002','Priya Patel','priya@harborline.com',null,'cccccccc-0000-0000-0000-000000000001','new',null),
  ('bbbbbbb1-0000-0000-0000-000000000003','Marcus Webb','marcus@harborline.com',null,'cccccccc-0000-0000-0000-000000000001','new',null);
SQL

RES="$(as_rep_val "select public.admin_lead_to_client('bbbbbbb1-0000-0000-0000-000000000001','$REP')::text;")"
CID="$(as_rep_val "select (public.admin_lead_to_client('bbbbbbb1-0000-0000-0000-000000000001','$REP'))->>'client_id';")"
if [ -n "$CID" ]; then ok "a sales rep can turn a won deal into a client"; else bad "the rep could not run it"; fi
# The three states have to come back separately, or the page cannot say a true
# sentence. Returning a bare id made it toast "they are now a client" every
# time, including the times when nothing at all was created.
is "the first call reports that it CREATED the client" \
  "$(echo "$RES" | grep -c '"created":true')" "1"

is "the client is named after the FIRM, not the person" \
  "$(val "select name from public.admin_clients where id='$CID';")" "HarborlineRealtyGroup"
is "the website came across" "$(val "select domain from public.admin_clients where id='$CID';")" "harborline.com"
is "it is marked as having come from sales" "$(val "select origin from public.admin_clients where id='$CID';")" "sales"
is "the firm now points at the client" \
  "$(val "select client_id from public.admin_companies where id='cccccccc-0000-0000-0000-000000000001';")" "$CID"
is "the client points back at the firm" \
  "$(val "select company_id from public.admin_clients where id='$CID';")" "cccccccc-0000-0000-0000-000000000001"
is "the person who closed it is marked as the customer" \
  "$(val "select became_customer from public.admin_leads where id='bbbbbbb1-0000-0000-0000-000000000001';")" "t"
is "the stage moved to won" \
  "$(val "select stage from public.admin_leads where id='bbbbbbb1-0000-0000-0000-000000000001';")" "won"
is "the day it happened is recorded, not left blank" \
  "$(val "select (became_customer_at is not null) from public.admin_leads where id='bbbbbbb1-0000-0000-0000-000000000001';")" "t"
is "it is on the timeline, where a rep will actually find it" \
  "$(val "select count(*) from public.admin_lead_activity where lead_id='bbbbbbb1-0000-0000-0000-000000000001' and type='converted';")" "1"

# THE HALF THAT MAKES THE RECORD CONTINUOUS.
is "every other person at that firm is attached to the same client" \
  "$(val "select count(*) from public.admin_leads where company_id='cccccccc-0000-0000-0000-000000000001' and client_id='$CID';")" "3"
# ...WITHOUT being credited with a sale they did not make. Flattening the two
# would count one sale three times on the rep scoreboard.
is "the other two are NOT credited with the sale" \
  "$(val "select count(*) from public.admin_leads where company_id='cccccccc-0000-0000-0000-000000000001' and became_customer;")" "1"
is "the other two are told on their own timeline" \
  "$(val "select count(*) from public.admin_lead_activity where type='client_link';")" "2"
is "their stage is untouched — whose deal it was and how far they got are different facts" \
  "$(val "select stage from public.admin_leads where id='bbbbbbb1-0000-0000-0000-000000000002';")" "new"

# ==================================================================
# 3. PRESSING IT TWICE
# ==================================================================
CID2="$(as_rep_val "select (public.admin_lead_to_client('bbbbbbb1-0000-0000-0000-000000000001','$REP'))->>'client_id';")"
RES2="$(as_rep_val "select public.admin_lead_to_client('bbbbbbb1-0000-0000-0000-000000000001','$REP')::text;")"
is "a second press says it created NOTHING and that they were already a customer" \
  "$(echo "$RES2" | grep -c '"created":false.*"already_customer":true')" "1"
is "pressing Won twice returns the SAME client, and does not raise" "$CID2" "$CID"
is "...and does not make a second client" \
  "$(val "select count(*) from public.admin_clients where name='Harborline Realty Group';")" "1"
is "...and does not write a second timeline entry" \
  "$(val "select count(*) from public.admin_lead_activity where lead_id='bbbbbbb1-0000-0000-0000-000000000001' and type='converted';")" "1"

# A SECOND person at the same firm closing later reuses the same client.
RES3="$(as_rep_val "select public.admin_lead_to_client('bbbbbbb1-0000-0000-0000-000000000002','$REP')::text;")"
CID3="$(as_rep_val "select client_id from public.admin_leads where id='bbbbbbb1-0000-0000-0000-000000000002';")"
is "a second deal at the same firm reports that it created nothing new" \
  "$(echo "$RES3" | grep -c '"created":false')" "1"
is "a second contact at the same firm lands on the same client" "$CID3" "$CID"
is "...and now two people are credited, because two deals really closed" \
  "$(val "select count(*) from public.admin_leads where company_id='cccccccc-0000-0000-0000-000000000001' and became_customer;")" "2"

# ==================================================================
# 4. IT WILL NOT INVENT, AND IT WILL NOT OVERWRITE
# ==================================================================
$PSQL -c "insert into public.admin_leads (id, name, stage) values ('bbbbbbb1-0000-0000-0000-000000000009', null, 'proposal');" >/dev/null
# NOT through as_rep_val: that pipes psql into `tail`, so the exit code read is
# tail's and this check passed no matter what the function did. Caught the first
# time it ran, which is the only reason it is written this way.
BEFORE_N="$(val "select count(*) from public.admin_clients;")"
# THE MESSAGE IS CHECKED, NOT JUST THE EXIT CODE. A non-zero exit for an
# unrelated reason — a renamed column, a bad cast — would otherwise print `ok`
# for a refusal that never happened.
$PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$REP'; select public.admin_lead_to_client('bbbbbbb1-0000-0000-0000-000000000009','$REP');" >/dev/null 2>/tmp/lcerr.txt
if grep -q "nothing to call the client" /tmp/lcerr.txt; then
  ok "a lead with nothing to call it is refused, for that exact reason"
else
  bad "expected a 'nothing to call the client' refusal; got: $(head -c 200 /tmp/lcerr.txt)"
fi
is "...and no half-made client row was left behind" "$(val "select count(*) from public.admin_clients;")" "$BEFORE_N"

$PSQL <<'SQL' >/dev/null
insert into public.admin_clients (id, name, contact_email, contact_name, origin)
  values ('dddddddd-0000-0000-0000-000000000001','Acme Serhant','typed@byhand.com','Typed By Hand','manual');
insert into public.admin_companies (id, name, domain, client_id)
  values ('cccccccc-0000-0000-0000-000000000002','Acme Serhant','acme.com','dddddddd-0000-0000-0000-000000000001');
insert into public.admin_leads (id, name, email, company_id, stage)
  values ('bbbbbbb1-0000-0000-0000-000000000010','Someone Else','someone@acme.com','cccccccc-0000-0000-0000-000000000002','proposal');
SQL
LINKED="$(as_rep_val "select (public.admin_lead_to_client('bbbbbbb1-0000-0000-0000-000000000010','$REP'))->>'client_id';")"
is "a firm that is already a client is reused, not duplicated" "$LINKED" "dddddddd-0000-0000-0000-000000000001"
is "a contact somebody typed in by hand is NOT replaced by the lead's" \
  "$(val "select contact_email from public.admin_clients where id='dddddddd-0000-0000-0000-000000000001';")" "typed@byhand.com"
is "...and the record still says it was set up by hand" \
  "$(val "select origin from public.admin_clients where id='dddddddd-0000-0000-0000-000000000001';")" "manual"

# ==================================================================
# 5. WHO IS ALLOWED
# ==================================================================
$PSQL -c "set local role anon; select public.admin_lead_to_client('bbbbbbb1-0000-0000-0000-000000000003');" >/dev/null 2>/tmp/lcerr.txt
if grep -qiE "not authorized|permission denied" /tmp/lcerr.txt; then
  ok "a signed-out visitor is refused, for an authorisation reason"
else
  bad "expected an authorisation refusal; got: $(head -c 200 /tmp/lcerr.txt)"
fi
$PSQL -c "set local role anon; select * from public.admin_client_contacts('$CID');" >/dev/null 2>/tmp/lcerr.txt
if grep -qiE "permission denied|not authorized" /tmp/lcerr.txt; then
  ok "a signed-out visitor is refused a client's sales history"
else
  bad "expected a permission refusal; got: $(head -c 200 /tmp/lcerr.txt)"
fi

# ==================================================================
# 6. THE OTHER DIRECTION
# ==================================================================
is "a client can find every person at its firm" \
  "$(as_owner_val "select count(*) from public.admin_client_contacts('$CID');")" "3"
# Both Dana and Priya closed a deal by now, so the check is that the people who
# CLOSED sort above the person who did not — not which of the two is first.
is "the people whose deals closed sort above the ones who did not" \
  "$(as_owner_val "select bool_and(became_customer) from (select became_customer from public.admin_client_contacts('$CID') limit 2) x;")" "t"
is "...and the contact who never closed is last" \
  "$(as_owner_val "select became_customer from public.admin_client_contacts('$CID') offset 2 limit 1;")" "f"

# ==================================================================
# 7. THE BACKFILL MATCHES ON DOMAIN AND NAME TOGETHER, NEVER NAME ALONE
# ==================================================================
# "Above & Beyond Real Estate" genuinely exists in more than one state. A
# name-only match would hang one state's sales history on the other state's
# client record.
$PSQL <<'SQL' >/dev/null
insert into public.admin_clients (id, name, domain, origin)
  values ('dddddddd-0000-0000-0000-000000000002','Above & Beyond Real Estate','abovebeyond-fl.com','manual');
insert into public.admin_companies (id, name, domain)
  values ('cccccccc-0000-0000-0000-000000000003','Above & Beyond Real Estate','abovebeyond-tx.com');
SQL
$PSQL -f supabase/migrations/0015_sales_lifecycle.sql >/dev/null 2>&1
is "a same-named firm on a DIFFERENT website is not linked" \
  "$(val "select coalesce(client_id::text,'<null>') from public.admin_companies where id='cccccccc-0000-0000-0000-000000000003';")" "<null>"

$PSQL -c "update public.admin_companies set domain='https://www.abovebeyond-fl.com/' where id='cccccccc-0000-0000-0000-000000000003';" >/dev/null
$PSQL -f supabase/migrations/0015_sales_lifecycle.sql >/dev/null 2>&1
is "the SAME website is linked, http/www/trailing-slash and all" \
  "$(val "select client_id from public.admin_companies where id='cccccccc-0000-0000-0000-000000000003';")" "dddddddd-0000-0000-0000-000000000002"

$PSQL <<'SQL' >/dev/null
insert into public.admin_clients (id, name, domain, origin)
  values ('dddddddd-0000-0000-0000-000000000003','Coast & Key Realty','coastkey.com','manual');
insert into public.admin_companies (id, name, domain)
  values ('cccccccc-0000-0000-0000-000000000004','Coast and Key Realty','coastkey.com');
SQL
$PSQL -f supabase/migrations/0015_sales_lifecycle.sql >/dev/null 2>&1
# HONEST LIMIT, pinned rather than hidden: "&" and "and" produce different name
# keys, so a firm spelled both ways on ONE website is not auto-linked. The rule
# is deliberately conservative — a wrong automatic link is worse than one a
# person joins by hand — and this exists so the limit is a decision on record
# rather than a surprise found later.
is "a firm spelled '&' one side and 'and' the other is left for a person to join" \
  "$(val "select coalesce(client_id::text,'<null>') from public.admin_companies where id='cccccccc-0000-0000-0000-000000000004';")" "<null>"

# ==================================================================
# 8. A CONTACT ADDED BY HAND HAS NO FIRM ROW
# ==================================================================
# "+ Add a contact" stores the firm as free text and sets no company_id, so
# there was nothing to lock and nothing to dedupe against: two people typed in
# under one firm name and both marked Won produced TWO clients with the same
# name, each holding half the history. Deterministic, no race needed — verbatim
# the failure this file's header says it exists to prevent. Found by a reviewer.
$PSQL <<'SQL' >/dev/null
insert into public.admin_leads (id, name, company, email, stage) values
  ('eeeeeee1-0000-0000-0000-000000000001','Sarah Ng','Chen Dental Studio','sarah@chendental.com','proposal'),
  ('eeeeeee1-0000-0000-0000-000000000002','Mark Chen','Chen Dental Studio','mark@chendental.com','proposal');
SQL
HAND1="$(as_rep_val "select (public.admin_lead_to_client('eeeeeee1-0000-0000-0000-000000000001','$REP'))->>'client_id';")"
HAND2="$(as_rep_val "select (public.admin_lead_to_client('eeeeeee1-0000-0000-0000-000000000002','$REP'))->>'client_id';")"
is "two hand-added contacts at one firm land on the SAME client" "$HAND2" "$HAND1"
is "...and exactly one client record exists for that firm" \
  "$(val "select count(*) from public.admin_clients where name='Chen Dental Studio';")" "1"
is "...and both are credited, because both deals really closed" \
  "$(val "select count(*) from public.admin_leads where company='Chen Dental Studio' and became_customer;")" "2"

# THE CASE THAT MADE THE FIRST VERSION OF THIS RULE WRONG.
# The sheet's Company column carries no website, and a hand-added contact has no
# firm row — so one contact at a firm having a website and the next one not
# having one is the ORDINARY case, not an edge case. Demanding both sides agree
# on a website meant "Ann at Olson Law (olsonlaw.com)" and "Ben at Olson Law (no
# website)" produced TWO clients with the same name and half the history each.
$PSQL <<'SQL' >/dev/null
insert into public.admin_leads (id, name, company, domain, stage) values
  ('eeeeeee1-0000-0000-0000-000000000011','Ann A','Olson Law PLLC','olsonlaw.com','proposal'),
  ('eeeeeee1-0000-0000-0000-000000000012','Ben B','Olson Law PLLC',null,'proposal');
SQL
OL1="$(as_rep_val "select (public.admin_lead_to_client('eeeeeee1-0000-0000-0000-000000000011','$REP'))->>'client_id';")"
OL2="$(as_rep_val "select (public.admin_lead_to_client('eeeeeee1-0000-0000-0000-000000000012','$REP'))->>'client_id';")"
is "one contact WITH a website and one WITHOUT still land on the same client" "$OL2" "$OL1"
is "...and exactly one client exists for that firm" \
  "$(val "select count(*) from public.admin_clients where name='Olson Law PLLC';")" "1"

# TWO DIFFERENT WEBSITES still means two different firms. That is the half of
# the rule that does the work — a missing website is not evidence of a
# different firm, but two named and differing ones are.
$PSQL -c "insert into public.admin_leads (id, name, company, domain, stage) values ('eeeeeee1-0000-0000-0000-000000000013','Tex Olson','Olson Law PLLC','olsonlaw-tx.com','proposal');" >/dev/null
OL3="$(as_rep_val "select (public.admin_lead_to_client('eeeeeee1-0000-0000-0000-000000000013','$REP'))->>'client_id';")"
if [ "$OL3" = "$OL1" ]; then
  bad "a same-named firm on a DIFFERENT website was folded onto the first client"
else
  ok "a same-named firm on a DIFFERENT website gets its own client"
fi

# THE TRADE-OFF, ON RECORD. A same-named firm whose website we have never
# recorded DOES fold into an existing client. That is deliberate: splitting one
# client into two records, each holding half the history, is both commoner and
# more damaging than merging two genuinely different firms that share a
# normalised name and have no website between them.
$PSQL -c "insert into public.admin_leads (id, name, company, stage) values ('eeeeeee1-0000-0000-0000-000000000014','No Site Olson','Olson Law PLLC','proposal');" >/dev/null
OL4="$(as_rep_val "select (public.admin_lead_to_client('eeeeeee1-0000-0000-0000-000000000014','$REP'))->>'client_id';")"
is "a same-named firm with no website folds into the existing client (deliberate)" "$OL4" "$OL1"

echo ""
if [ "$fails" = "0" ]; then echo "  all database checks passed"; else echo "  $fails FAILED"; fi
exit $fails
