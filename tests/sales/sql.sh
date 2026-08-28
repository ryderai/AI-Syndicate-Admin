#!/usr/bin/env bash
# The database half of the sales system.
#
# Stands up a real Postgres 16, applies migrations 0001 → 0009 in order, then
# attacks the rules this build depends on:
#   · does the stage ladder actually accept the new stages and refuse junk
#   · does logging a CALL reset the cold timer, and does a STATUS CHANGE not
#   · does the company key really fold "ACME | SERHANT." onto "Acme Serhant"
#   · can a sales rep read and write leads, companies, lists and proposals
#   · can a sales rep DELETE any of them (they must not)
#   · does the backfill leave first_contact_at NULL for a lead nobody has rung
#
# Reading the SQL and saying "that looks right" is not a test. This is.
#
# Skips itself with a message when there is no local Postgres, so
# tests/sales/run.sh stays runnable on any machine.
set -u
cd "$(dirname "$0")/../.."

PGBIN=""
for d in /usr/lib/postgresql/*/bin; do [ -x "$d/initdb" ] && PGBIN="$d"; done
if [ -z "$PGBIN" ]; then
  echo "  --   no local Postgres found; the SQL half of the sales tests was SKIPPED."
  echo "       (install postgresql-16 to run it, or read tests/sales/sql.sh to see what it checks)"
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

run() {
  if [ -n "$RUNAS" ]; then $RUNAS "$1"; else bash -c "$1"; fi
}

run "$PGBIN/initdb -D $DATA -U postgres --auth=trust" >/dev/null 2>&1 || {
  echo "  --   Postgres would not start; the SQL half was SKIPPED."; exit 0; }
run "$PGBIN/pg_ctl -D $DATA -o \"-k $SOCK -c listen_addresses=''\" -w start" >/dev/null 2>&1 || {
  echo "  --   Postgres would not start; the SQL half was SKIPPED."; exit 0; }

PSQL="psql -h $SOCK -U postgres -v ON_ERROR_STOP=1 -q"
cleanup() { run "$PGBIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1; }
trap cleanup EXIT

fails=0
ok()   { echo "  ok   $1"; }
bad()  { echo "  FAIL $1"; fails=$((fails+1)); }

# A mock of the bits of Supabase the migrations lean on.
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
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/salesmig.err; then
    echo "  FAIL migration $f did not apply:"; sed 's/^/       /' /tmp/salesmig.err; exit 1
  fi
done
$PSQL -c "grant all on all tables in schema public to service_role;" >/dev/null
ok "migrations 0001-0009 apply in order"

if $PSQL -f supabase/migrations/0009_sales.sql >/dev/null 2>/tmp/salesmig.err; then
  ok "0009 can be run twice without breaking"
else
  bad "0009 is not re-runnable:"; sed 's/^/       /' /tmp/salesmig.err
fi

# AND NOW PUT THE LATER MIGRATIONS BACK. Added Aug 28 2026, after a checker
# noticed this file was testing a rule the repo had already replaced.
#
# Re-applying 0009 above is a real check and stays. But 0009 contains
# `create or replace function public.admin_lead_claim_text(...)`, so running it
# a second time — AFTER 0021 — quietly REVERTS that function to 0009's version:
# the gate goes back to `email_opened_at is not null`, and 0020's row-lock line
# inside the function disappears. Nothing errors. Section 4b below then passed
# for a whole day while proving the OLD rule, and the two lines this build
# actually changed were not covered by anything here.
#
# This is the same hazard 0018_lead_tags.sql warns about in its own words, and
# the reason 0020 section 6b writes down a re-run ORDER. So: re-apply 0020 and
# 0021, in that order, and check the function really is the new one before any
# assertion leans on it.
for f in supabase/migrations/0020_rep_scoping.sql supabase/migrations/0021_outreach_tracking.sql; do
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/salesmig.err; then
    bad "could not re-apply $f after 0009:"; sed 's/^/       /' /tmp/salesmig.err
  fi
done
GATE=$($PSQL -tAc "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='admin_lead_claim_text';")
case "$GATE" in
  *first_reply_at*) ok "after 0009 was re-run, 0021's one-text gate is back (first_reply_at)" ;;
  *) bad "re-running 0009 left the OLD one-text gate in place — every assertion in 4b would be testing the replaced rule" ;;
esac
case "$GATE" in
  *"owner_id = auth.uid()"*) ok "...and 0020's row lock is back inside the function too" ;;
  *) bad "the row-lock line is missing from admin_lead_claim_text after the re-runs" ;;
esac

# ------------------------------------------------------------------
# People to act as.
# ------------------------------------------------------------------
$PSQL <<'SQL' >/dev/null
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','owner@x.com'),
  ('22222222-2222-2222-2222-222222222222','rep@x.com');
insert into public.admin_users (user_id, email, full_name, role, active) values
  ('11111111-1111-1111-1111-111111111111','owner@x.com','Owner O','owner',true),
  ('22222222-2222-2222-2222-222222222222','rep@x.com','Rep R','sales',true);
SQL

as_rep() {   $PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'; $1"; }
as_owner() { $PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111'; $1"; }
# One scalar, as the rep sees it. `psql -c` prints a line per statement and the
# role-switch statements count, so the value wanted is the LAST line.
as_rep_val() { $PSQL -tAc "set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'; $1" | tail -n 1 | tr -d '[:space:]'; }

# ------------------------------------------------------------------
# 1. THE STAGE LADDER
# ------------------------------------------------------------------
# The redeploy trap from the vault tests applies here too: `alter table … add
# column if not exists` does nothing to an existing CHECK, so a stage added to
# the constraint has to be proven to work on a database that already had the
# old one. Every migration above ran against a table created by 0001.
for s in new researching contacted in_conversation follow_up meeting proposal won lost skip_90 bad_contact reopened; do
  if ! $PSQL -c "insert into public.admin_leads (name, stage) values ('stage test', '$s');" >/dev/null 2>&1; then
    bad "stage '$s' was refused by the check constraint"
  fi
done
ok "all 12 stages are accepted"

if $PSQL -c "insert into public.admin_leads (name, stage) values ('junk','definitely_not_a_stage');" >/dev/null 2>&1; then
  bad "a made-up stage was accepted — the constraint is not doing anything"
else
  ok "a made-up stage is refused"
fi

# ------------------------------------------------------------------
# 2. THE COLD TIMER
# ------------------------------------------------------------------
# This is the rule the whole queue rests on. A logged CALL is a touch and
# resets the 14 days. A status change is NOT a touch — the sheet's failure mode
# is a row that looks alive because somebody re-picked a dropdown.
$PSQL <<'SQL' >/dev/null
insert into public.admin_leads (id, name, company, stage, owner_id, claimed_at)
values ('aaaaaaaa-0000-0000-0000-000000000001','Timer Test','Timer Co','contacted',
        '22222222-2222-2222-2222-222222222222', now() - interval '10 days');
SQL

$PSQL -c "insert into public.admin_lead_activity (lead_id, actor, type, outcome) values ('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','call','talked');" >/dev/null
TOUCH=$($PSQL -tAc "select last_touch_at is not null and first_contact_at is not null from public.admin_leads where id='aaaaaaaa-0000-0000-0000-000000000001';")
[ "$TOUCH" = "t" ] && ok "logging a call sets last_touch_at AND first_contact_at" || bad "a logged call did not reset the timers (got '$TOUCH')"

BEFORE=$($PSQL -tAc "select last_touch_at from public.admin_leads where id='aaaaaaaa-0000-0000-0000-000000000001';")
$PSQL -c "insert into public.admin_lead_activity (lead_id, actor, type, body) values ('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','status_change','contacted -> follow_up');" >/dev/null
AFTER=$($PSQL -tAc "select last_touch_at from public.admin_leads where id='aaaaaaaa-0000-0000-0000-000000000001';")
[ "$BEFORE" = "$AFTER" ] && ok "a status change does NOT reset the cold timer" || bad "a status change reset the cold timer — a dropdown must not buy 14 more days"

# first_contact_at must never move FORWARD when a later call is logged.
FIRST_BEFORE=$($PSQL -tAc "select first_contact_at from public.admin_leads where id='aaaaaaaa-0000-0000-0000-000000000001';")
$PSQL -c "insert into public.admin_lead_activity (lead_id, actor, type, outcome) values ('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','email','talked');" >/dev/null
FIRST_AFTER=$($PSQL -tAc "select first_contact_at from public.admin_leads where id='aaaaaaaa-0000-0000-0000-000000000001';")
[ "$FIRST_BEFORE" = "$FIRST_AFTER" ] && ok "a later touch does not move first_contact_at forward" || bad "a second touch overwrote first_contact_at"

# ...but an OLDER touch arriving late MUST pull it back. `coalesce` kept
# whichever row was INSERTED first rather than whichever HAPPENED first, so
# replaying a history out of order recorded first contact months late — and
# that number feeds speed-to-first-contact on the rep scoreboard.
$PSQL -c "insert into public.admin_lead_activity (lead_id, actor, type, outcome, created_at) values ('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','email','talked', now() - interval '120 days');" >/dev/null
BACKDATED=$($PSQL -tAc "select first_contact_at < (now() - interval '100 days') from public.admin_leads where id='aaaaaaaa-0000-0000-0000-000000000001';")
[ "$BACKDATED" = "t" ] && ok "a back-dated touch pulls first_contact_at BACK to the real date" \
  || bad "a back-dated touch did not correct first_contact_at (got '$BACKDATED')"

# ------------------------------------------------------------------
# 3. THE COMPANY KEY — four ACME rows must be one firm
# ------------------------------------------------------------------
K1=$($PSQL -tAc "select public.admin_company_name_key('ACME | SERHANT.');")
K2=$($PSQL -tAc "select public.admin_company_name_key('Acme Serhant');")
[ "$K1" = "$K2" ] && [ -n "$K1" ] && ok "'ACME | SERHANT.' and 'Acme Serhant' fold to the same key ($K1)" \
  || bad "the company key did not fold punctuation ('$K1' vs '$K2')"
KEMPTY=$($PSQL -tAc "select coalesce(public.admin_company_name_key('   '), 'NULL');")
[ "$KEMPTY" = "NULL" ] && ok "a blank company name gives NULL, not an empty key everything matches" \
  || bad "a blank company name produced '$KEMPTY' — every blank row would group together"

$PSQL -c "insert into public.admin_companies (name) values ('ACME | SERHANT.');" >/dev/null
STAMPED=$($PSQL -tAc "select name_key from public.admin_companies where name='ACME | SERHANT.';")
[ "$STAMPED" = "$K1" ] && ok "the trigger stamps name_key on insert" || bad "name_key was not stamped (got '$STAMPED')"

# ------------------------------------------------------------------
# 4. WHAT A SALES REP MAY DO
# ------------------------------------------------------------------
# Ryder's call: no locks between reps. A rep reads and writes everything in
# sales. What is still shut is DELETE, and everything outside sales.
as_rep "insert into public.admin_companies (name) values ('Rep Made This');" >/dev/null 2>&1 \
  && ok "a sales rep can add a company" || bad "a sales rep could not add a company"
as_rep "insert into public.admin_lead_lists (name) values ('Rep List');" >/dev/null 2>&1 \
  && ok "a sales rep can add a list" || bad "a sales rep could not add a list"
as_rep "insert into public.admin_proposals (lead_id, title, amount_cents) values ('aaaaaaaa-0000-0000-0000-000000000001','Rep Proposal', 250000);" >/dev/null 2>&1 \
  && ok "a sales rep can write a proposal" || bad "a sales rep could not write a proposal"
# LABEL CORRECTED Aug 28 2026. This used to read "a sales rep can move any
# lead's stage (no locks between reps)". That was true when it was written and is
# not true now: 0020 put the lock on the row. Lead ...0001 is owned by THIS rep,
# so what this line proves is that a rep can still work their OWN lead. The
# "another rep's lead is refused" half lives in tests/floor-scoping/sql.sh
# section 3, and is mutation-proved there.
as_rep "update public.admin_leads set stage='meeting' where id='aaaaaaaa-0000-0000-0000-000000000001';" >/dev/null 2>&1 \
  && ok "a sales rep can move the stage of a lead THEY OWN" || bad "a sales rep could not update their own lead"

# A DELETE that row-level security refuses does not raise an error — it
# deletes nothing and reports success. So this counts rows, not exit codes.
# Checking `if the command succeeded` passed while the rep was deleting things
# AND while they were not, which is the exact shape of a guard whose failure
# mode is silence.
as_rep "delete from public.admin_companies where name='Rep Made This';" >/dev/null 2>&1
STILL=$($PSQL -tAc "select count(*) from public.admin_companies where name='Rep Made This';")
[ "$STILL" = "1" ] && ok "a sales rep cannot delete a company (row survived)" \
  || bad "a sales rep DELETED a company — delete is supposed to be admin-only"

as_rep "delete from public.admin_proposals where title='Rep Proposal';" >/dev/null 2>&1
STILL=$($PSQL -tAc "select count(*) from public.admin_proposals where title='Rep Proposal';")
[ "$STILL" = "1" ] && ok "a sales rep cannot delete a proposal (row survived)" \
  || bad "a sales rep DELETED a proposal"

as_owner "delete from public.admin_proposals where title='Rep Proposal';" >/dev/null 2>&1
GONE=$($PSQL -tAc "select count(*) from public.admin_proposals where title='Rep Proposal';")
[ "$GONE" = "0" ] && ok "an owner CAN delete a proposal" || bad "an owner could not delete a proposal"

# Nothing here loosened what was already shut. Same trap: a SELECT that RLS
# refuses returns an empty set, not an error.
$PSQL -c "insert into public.admin_brain (title, body) values ('rule','body');" >/dev/null 2>&1 \
  || $PSQL -c "insert into public.admin_brain (name, body) values ('rule','body');" >/dev/null 2>&1
TOTAL=$($PSQL -tAc "select count(*) from public.admin_brain;")
SEEN=$(as_rep_val "select count(*) from public.admin_brain;")
if [ "$TOTAL" != "0" ] && [ "$SEEN" = "0" ]; then
  ok "the Brain is still closed to sales ($TOTAL rows exist, the rep sees 0)"
elif [ "$TOTAL" = "0" ]; then
  bad "could not seed the Brain, so 'sales cannot read it' was never actually tested"
else
  bad "a sales rep read $SEEN Brain rows — 0009 loosened something it should not have"
fi

# ------------------------------------------------------------------
# 4b. THE ONE-TEXT RULE, AGAINST TWO CALLERS
# ------------------------------------------------------------------
# The browser cannot enforce "exactly one" with read-modify-write: two tabs both
# read 0 and both write 1. This claims it in one statement, so exactly one
# caller wins.
$PSQL <<'SQL' >/dev/null
insert into public.admin_leads (id, name, stage, owner_id, phone, first_reply_at, texts_sent)
values ('aaaaaaaa-0000-0000-0000-000000000003','Text Test','contacted',
        '22222222-2222-2222-2222-222222222222','555-0100', now() - interval '1 day', 0);
SQL
FIRST=$(as_rep_val "select public.admin_lead_claim_text('aaaaaaaa-0000-0000-0000-000000000003');")
SECOND=$(as_rep_val "select public.admin_lead_claim_text('aaaaaaaa-0000-0000-0000-000000000003');")
COUNTER=$($PSQL -tAc "select texts_sent from public.admin_leads where id='aaaaaaaa-0000-0000-0000-000000000003';")
if [ "$FIRST" = "t" ] && [ "$SECOND" = "f" ] && [ "$COUNTER" = "1" ]; then
  ok "the first caller gets the one text and the second is refused (counter=1)"
else
  bad "the one-text rule did not hold (first=$FIRST second=$SECOND counter=$COUNTER)"
fi

# And with no email open on record, nobody gets one.
$PSQL <<'SQL' >/dev/null
insert into public.admin_leads (id, name, stage, owner_id, phone, first_reply_at, texts_sent)
values ('aaaaaaaa-0000-0000-0000-000000000004','Cold Text','contacted',
        '22222222-2222-2222-2222-222222222222','555-0101', null, 0);
SQL
COLD=$(as_rep_val "select public.admin_lead_claim_text('aaaaaaaa-0000-0000-0000-000000000004');")
[ "$COLD" = "f" ] && ok "no text is allowed before a REPLY is on record (Aug 27: this used to say 'an email open', which nothing has ever written)" \
  || bad "a contact who has not replied was allowed a text (got '$COLD')"

# The counter can never go negative, whatever writes it.
if $PSQL -c "insert into public.admin_leads (name, texts_sent) values ('bad counter', -5);" >/dev/null 2>&1; then
  bad "a negative text counter was accepted"
else
  ok "a negative text counter is refused by the database"
fi

# ------------------------------------------------------------------
# 4c. TWO FIRST-CONTACT COLUMNS, TWO QUESTIONS
# ------------------------------------------------------------------
# first_contact_at is the relationship's and is never cleared;
# claim_contacted_at is the current claim's three-day window.
$PSQL <<'SQL' >/dev/null
insert into public.admin_leads (id, name, stage, owner_id, claimed_at)
values ('aaaaaaaa-0000-0000-0000-000000000005','Recycled','proposal',
        '22222222-2222-2222-2222-222222222222', now() - interval '60 days');
insert into public.admin_lead_activity (lead_id, actor, type, created_at)
values ('aaaaaaaa-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222','email', now() - interval '59 days');
SQL
BOTH=$($PSQL -tAc "select first_contact_at is not null and claim_contacted_at is not null from public.admin_leads where id='aaaaaaaa-0000-0000-0000-000000000005';")
[ "$BOTH" = "t" ] && ok "a touch fills both first-contact columns" || bad "the trigger did not fill both (got '$BOTH')"

# Release: only the claim's clock goes.
$PSQL -c "update public.admin_leads set owner_id=null, claimed_at=null, cadence_started_at=null, claim_contacted_at=null where id='aaaaaaaa-0000-0000-0000-000000000005';" >/dev/null
KEPT=$($PSQL -tAc "select first_contact_at is not null and stage='proposal' from public.admin_leads where id='aaaaaaaa-0000-0000-0000-000000000005';")
[ "$KEPT" = "t" ] && ok "releasing a claim keeps the real first-contact date AND the pipeline stage" \
  || bad "releasing a claim destroyed history (got '$KEPT')"

# ------------------------------------------------------------------
# 5. THE BACKFILL DOES NOT INVENT DATES
# ------------------------------------------------------------------
# A lead nobody has ever rung must keep first_contact_at NULL. Inventing one
# starts a 14-day cold timer on a firm that has never been touched, and the
# rep loses it without ever having had a chance.
$PSQL <<'SQL' >/dev/null
insert into public.admin_leads (id, name, stage, owner_id)
values ('aaaaaaaa-0000-0000-0000-000000000002','Never Rung','new','22222222-2222-2222-2222-222222222222');
SQL
# 0009 is run again here ON PURPOSE — its backfill is what this section tests.
$PSQL -f supabase/migrations/0009_sales.sql >/dev/null 2>&1
NEVER=$($PSQL -tAc "select first_contact_at is null and claimed_at is not null from public.admin_leads where id='aaaaaaaa-0000-0000-0000-000000000002';")
[ "$NEVER" = "t" ] && ok "the backfill stamps a claim date but never invents a first contact" \
  || bad "the backfill invented a first-contact date for a lead nobody has rung (got '$NEVER')"

# AND PUT THE LATER MIGRATIONS BACK AGAIN. Added Aug 28 2026, same reason as the
# block near the top of this file: the line above re-ran 0009, which silently
# reverts admin_lead_claim_text() to 0009's version — the old `email_opened_at`
# gate, and 0020's row-lock line gone from inside it.
#
# NOTHING BELOW THIS POINT CURRENTLY READS THAT FUNCTION, so no assertion in this
# file is wrong today. This is here so that the NEXT assertion somebody appends
# is not wrong either, and so the file does not END with the database holding a
# rule the repo replaced. A trap that is only harmless because of where it sits
# in the file is still a trap.
for f in supabase/migrations/0020_rep_scoping.sql supabase/migrations/0021_outreach_tracking.sql; do
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/salesmig.err; then
    bad "could not re-apply $f after the backfill re-run:"; sed 's/^/       /' /tmp/salesmig.err
  fi
done
GATE2=$($PSQL -tAc "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='admin_lead_claim_text';")
case "$GATE2" in
  *first_reply_at*) ok "this file ends with 0021's one-text gate in place, not 0009's" ;;
  *) bad "this file ends with the OLD one-text gate in the database — the next assertion added below would test the replaced rule" ;;
esac

echo ""
if [ "$fails" -gt 0 ]; then
  echo "  $fails SQL check(s) FAILED"
  exit 1
fi
echo "  all SQL checks passed"
