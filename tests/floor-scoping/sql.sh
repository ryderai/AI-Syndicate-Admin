#!/usr/bin/env bash
# THE WORKING HALF OF THE ROW-LEVEL LOCK — migration 0020's own proof.
#
# 0020_rep_scoping.sql § 7 names this file: "You cannot sign in as a rep in the
# SQL editor, so prove it with the test instead: bash tests/floor-scoping/sql.sh".
# This is that file.
#
# WHY IT HAS TO EXIST AT ALL. The Floor shows every rep every row in the company.
# Until 0020, `admin_leads` UPDATE was one clause — `using (admin_is_member())`,
# no `with check` — so any active member could set any lead's owner_id to their
# own id by talking to the database directly. The disabled button on the page is
# politeness; `canEditLead()` in src/lib/salesSheet.js is politeness; every file
# in api/ runs on the service key and ignores RLS completely. THIS is the half
# that works when somebody skips the page.
#
# What it stands up and attacks:
#   · every migration 0001-0022, in order, then the last five again
#   · a rep CAN take an unclaimed lead, edit their own, and hand their own back
#   · a rep CANNOT take, edit, or strip the claim on another rep's lead
#   · a rep CANNOT hand a lead to a third person, and CANNOT insert one already
#     owned by somebody else
#   · an owner CAN do all of it
#   · THE TRIGGER CASE — logging a touch on an UNCLAIMED lead must succeed. That
#     is the assertion which proves the reasoning in 0020 § 1, and it is the whole
#     reason `owner_id is null` is in the WITH CHECK as well as the USING.
#   · proposals scoped through the lead, including the unattached-proposal branch
#   · email threads scoped to the mailbox a rep connected THEMSELVES
#   · tag events scoped the same way
#   · admin_rep_reports.counted_cause exists (api/rep-report.js:215 writes it)
#   · admin_lead_claim_text gates on first_reply_at AND on the row lock
#   · SECTION 10: THE MUTATION SECTION. It puts 0001's too-wide policy back,
#     proves the "cannot steal a lead" assertions then FAIL, and restores 0020.
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

# The Supabase shim: auth.uid(), the three roles, and the grants Supabase makes
# for you. Identical to tests/sales-sheet/sql.sh — one shim, one shape.
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
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/fsmig.err; then
    echo "  FAIL migration $f did not apply:"; sed 's/^/       /' /tmp/fsmig.err; exit 1
  fi
done
$PSQL -c "grant all on all tables in schema public to service_role;" >/dev/null
ok "every migration 0001-0022 applies in order"

# EVERY ONE OF THE LAST FIVE IS SAFE TO RUN TWICE. Ryder runs these by hand in
# the Supabase SQL editor and a half-applied set is the normal state of this
# project, so "run it again" has to be a safe instruction rather than a gamble.
# 0020 says so in its own header; this is the check.
for f in 0018_lead_tags 0019_reasons_and_company_reports 0020_rep_scoping \
         0021_outreach_tracking 0022_personal_brain; do
  if $PSQL -f "supabase/migrations/$f.sql" >/dev/null 2>/tmp/fsmig.err; then
    ok "$f can be run a second time without breaking"
  else
    bad "$f is not re-runnable:"; sed 's/^/       /' /tmp/fsmig.err
  fi
done

# ------------------------------------------------------------------
# Three people: an owner and two sales reps.
# ------------------------------------------------------------------
OWNER='11111111-1111-1111-1111-111111111111'
REPA='22222222-2222-2222-2222-222222222222'
REPB='33333333-3333-3333-3333-333333333333'

$PSQL <<SQL >/dev/null
insert into auth.users (id, email) values
  ('$OWNER','cj@aisyndicate.com'),
  ('$REPA','larry@aisyndicate.com'),
  ('$REPB','brandon@aisyndicate.com');
insert into public.admin_users (user_id, email, full_name, role, active) values
  ('$OWNER','cj@aisyndicate.com','CJ Britton','owner',true),
  ('$REPA','larry@aisyndicate.com','Larry Pike','sales',true),
  ('$REPB','brandon@aisyndicate.com','Brandon Roberts','sales',true);
SQL

# ------------------------------------------------------------------
# The helpers. Read the comments — two of them exist because of a bug.
# ------------------------------------------------------------------
# One statement, run as a signed-in member, last line of output returned.
# `set local` needs a transaction, and psql's simple query protocol wraps a
# multi-statement -c in one, which is why both statements live in one call.
as() { $PSQL -tAc "set local role authenticated; set local request.jwt.claim.sub = '$1'; $2" 2>/tmp/fserr.txt | tail -n 1 | tr -d '[:space:]'; }
val() { $PSQL -tAc "$1" | tail -n 1 | tr -d '[:space:]'; }

# NOT piped into anything. `as` above pipes psql into tail, so the exit code it
# reports is TAIL's — a refusal would read as a success. Every "this must be
# refused" check goes through the two functions below instead. tests/sales-sheet
# learned this the first time it ran and it is worth repeating here.
try_as() { $PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$1'; $2" >/dev/null 2>/tmp/fserr.txt; }

# THE MESSAGE IS CHECKED, NOT JUST THE EXIT CODE. A non-zero exit for an
# unrelated reason — a renamed column, a bad cast — would otherwise print `ok`
# for a refusal that never happened.
denied() { # name, uid, sql, expected-message-pattern
  if try_as "$2" "$3"; then
    bad "$1 — the statement SUCCEEDED when it should have been refused"
  elif grep -qiE "$4" /tmp/fserr.txt; then
    ok "$1"
  else
    bad "$1 — refused, but not for the expected reason: $(head -c 200 /tmp/fserr.txt | tr '\n' ' ')"
  fi
}

# HOW MANY ROWS AN UPDATE ACTUALLY CHANGED, run as one person.
#
# THIS IS THE WHOLE REASON THE FILE IS WRITTEN THIS WAY. In Postgres a USING
# clause does not raise — it makes the row invisible to the statement — so a
# refused UPDATE is a SUCCESSFUL statement that changed nothing. Checking the
# exit code proves nothing at all here; the row count is the assertion. A WITH
# CHECK failure, by contrast, DOES raise, and those go through denied() above.
upd() { as "$1" "with u as ($2 returning 1) select count(*) from u;"; }

seed_leads() {
  $PSQL <<SQL >/dev/null
delete from public.admin_lead_tag_events;
delete from public.admin_lead_activity;
delete from public.admin_proposals;
delete from public.admin_leads;
insert into public.admin_leads (id, name, company, stage, owner_id, claimed_at, notes, first_reply_at, texts_sent) values
  ('a1000000-0000-0000-0000-000000000001','Larry''s lead','Harborline Realty','contacted','$REPA', now() - interval '3 days','mine',null,0),
  ('a1000000-0000-0000-0000-000000000002','Brandon''s lead','Westpoint Auto','contacted','$REPB', now() - interval '3 days','theirs',null,0),
  ('a1000000-0000-0000-0000-000000000003','On the floor','Bright Coast Medspa','new',null,null,null,null,0),
  ('a1000000-0000-0000-0000-000000000004','Also on the floor','Coast and Key Realty','new',null,null,null,null,0),
  ('a1000000-0000-0000-0000-000000000005','Larry''s second','Olson Law PLLC','contacted','$REPA', now() - interval '1 day',null,null,0),
  ('a1000000-0000-0000-0000-000000000006','Larry''s replier','Acme Serhant','contacted','$REPA', now() - interval '2 days',null, now() - interval '1 day',0),
  ('a1000000-0000-0000-0000-000000000007','Brandon''s replier','Summit Roofing','contacted','$REPB', now() - interval '2 days',null, now() - interval '1 day',0);
SQL
}
LA='a1000000-0000-0000-0000-000000000001'
LB='a1000000-0000-0000-0000-000000000002'
LF='a1000000-0000-0000-0000-000000000003'
LF2='a1000000-0000-0000-0000-000000000004'
LA2='a1000000-0000-0000-0000-000000000005'
LA3='a1000000-0000-0000-0000-000000000006'
LB2='a1000000-0000-0000-0000-000000000007'
seed_leads

# ==================================================================
# 1. THE POLICIES ARE ACTUALLY THERE
# ==================================================================
# 0020 § 7 step 3 is a `select policyname, cmd from pg_policies` a person is
# meant to eyeball. This is that query, asserted.
is "admin_leads UPDATE has BOTH a using and a with check — one clause is the hole 0020 closed" \
  "$(val "select (qual is not null)::text||(with_check is not null)::text from pg_policies where tablename='admin_leads' and policyname='members update leads';")" "truetrue"
is "admin_leads INSERT names the owner, so a rep cannot file a row as somebody else" \
  "$(val "select (with_check like '%owner_id%')::text from pg_policies where tablename='admin_leads' and policyname='members insert leads';")" "true"
is "the rep mailbox policy exists on admin_email_threads" \
  "$(val "select count(*) from pg_policies where tablename='admin_email_threads' and policyname='reps work their own mailbox threads';")" "1"
# 0020 § 5: "THE EXISTING ADMIN POLICY IS NOT TOUCHED AND MUST NOT BE LOOSENED."
# Client billing lives in growth@. Two policies for one command are OR'd, so
# adding the rep one widens nothing for an admin — but only if the admin one is
# still there, by name.
is "...and 0003's admin policy is still there, untouched" \
  "$(val "select count(*) from pg_policies where tablename='admin_email_threads' and policyname='admins all email threads';")" "1"

# ==================================================================
# 2. WHAT A REP MAY DO
# ==================================================================
is "a rep CAN take a lead nobody holds" "$(upd "$REPA" "update public.admin_leads set owner_id='$REPA', claimed_at=now() where id='$LF'")" "1"
is "...and it really is theirs afterwards" "$(val "select owner_id from public.admin_leads where id='$LF';")" "$REPA"
is "a rep CAN edit a lead they hold" "$(upd "$REPA" "update public.admin_leads set notes='worked it' where id='$LA'")" "1"
is "...and the edit landed" "$(val "select notes from public.admin_leads where id='$LA';")" "workedit"
is "a rep CAN edit a lead nobody holds without claiming it first — which is what the page has always allowed" \
  "$(upd "$REPA" "update public.admin_leads set notes='left a note' where id='$LF2'")" "1"

# THE RELEASE. This is case (a) of 0020 § 1: the tighter WITH CHECK the build
# plan specified would have refused this outright, because the row AFTER the
# update has a null owner. Handing a lead back to the floor is something the
# Rules of Engagement expect a rep to do.
is "a rep CAN hand their own lead back to the floor" "$(upd "$REPA" "update public.admin_leads set owner_id=null, claimed_at=null where id='$LA2'")" "1"
is "...and it really is unclaimed afterwards" "$(val "select coalesce(owner_id::text,'<null>') from public.admin_leads where id='$LA2';")" "<null>"

# ==================================================================
# 3. WHAT A REP MAY NOT DO
# ==================================================================
# All three of these fail on the USING clause, so they raise NOTHING and change
# NOTHING. The row count is the assertion — see the note on upd().
is "a rep CANNOT take a lead another rep holds" "$(upd "$REPA" "update public.admin_leads set owner_id='$REPA' where id='$LB'")" "0"
is "a rep CANNOT edit a lead another rep holds" "$(upd "$REPA" "update public.admin_leads set notes='not mine to touch' where id='$LB'")" "0"
is "a rep CANNOT strip another rep's claim and dump the lead back on the floor" "$(upd "$REPA" "update public.admin_leads set owner_id=null, claimed_at=null where id='$LB'")" "0"
is "...and none of those three changed anything at all" \
  "$(val "select owner_id::text||'|'||coalesce(notes,'<null>') from public.admin_leads where id='$LB';")" "$REPB|theirs"

# THIS ONE FAILS ON THE WITH CHECK, so it DOES raise. That asymmetry is why both
# halves of the policy exist: the using clause stops a rep reaching another rep's
# row, and the with check stops them pushing their own row into somebody else's
# hands.
denied "a rep CANNOT hand their own lead to a third person" "$REPA" \
  "update public.admin_leads set owner_id='$REPB' where id='$LA'" "row-level security"
is "...and their lead is still theirs" "$(val "select owner_id from public.admin_leads where id='$LA';")" "$REPA"
denied "a rep CANNOT hand a lead nobody holds to a third person either" "$REPA" \
  "update public.admin_leads set owner_id='$OWNER' where id='$LF2'" "row-level security"

# 0001's INSERT policy was `with check (admin_is_member())` and said nothing
# about the owner. A rep could add a contact already owned by another rep — a row
# that belongs to somebody who never took it, which the Floor would draw as
# theirs, locked, with their name on it.
denied "a rep CANNOT insert a lead already owned by somebody else" "$REPA" \
  "insert into public.admin_leads (name, stage, owner_id) values ('Smuggled in','new','$REPB')" "row-level security"
is "a rep CAN insert a lead owned by themselves" \
  "$(as "$REPA" "with i as (insert into public.admin_leads (name, stage, owner_id) values ('Mine from the start','new','$REPA') returning 1) select count(*) from i;")" "1"
is "a rep CAN insert a lead owned by nobody, straight onto the floor" \
  "$(as "$REPA" "with i as (insert into public.admin_leads (name, stage) values ('Straight to the floor','new') returning 1) select count(*) from i;")" "1"

# SELECT STAYS WIDE, and that is the requirement rather than an oversight: a rep
# who cannot see another rep's row cannot be stopped from working the same firm,
# which is the loudest rule on the Rules of Engagement tab.
is "a rep can still SEE every lead in the company, including the ones they cannot touch" \
  "$(as "$REPA" "select count(*) from public.admin_leads;")" "$(val "select count(*) from public.admin_leads;")"

# ==================================================================
# 4. THE OWNER CAN DO ALL OF IT
# ==================================================================
seed_leads
is "an owner CAN edit a rep's lead" "$(upd "$OWNER" "update public.admin_leads set notes='reviewed' where id='$LB'")" "1"
is "an owner CAN hand one rep's lead to another rep — that is their job" \
  "$(upd "$OWNER" "update public.admin_leads set owner_id='$REPA' where id='$LB'")" "1"
is "...and it moved" "$(val "select owner_id from public.admin_leads where id='$LB';")" "$REPA"
is "an owner CAN strip a claim" "$(upd "$OWNER" "update public.admin_leads set owner_id=null where id='$LB'")" "1"
is "an owner CAN insert a lead owned by a rep" \
  "$(as "$OWNER" "with i as (insert into public.admin_leads (name, stage, owner_id) values ('Assigned by CJ','new','$REPB') returning 1) select count(*) from i;")" "1"

# A DEACTIVATED MEMBER IS NOT A MEMBER. admin_is_member() checks `active`, so
# somebody who has left must not still be able to write — not even to the lead
# that is still on their name.
$PSQL -c "update public.admin_users set active=false where user_id='$REPB';" >/dev/null
seed_leads
is "a deactivated rep cannot even edit the lead they still own" "$(upd "$REPB" "update public.admin_leads set notes='still here' where id='$LB'")" "0"
denied "...and cannot insert one" "$REPB" \
  "insert into public.admin_leads (name, stage, owner_id) values ('Ghost','new','$REPB')" "row-level security"
$PSQL -c "update public.admin_users set active=true where user_id='$REPB';" >/dev/null

# A SIGNED-OUT VISITOR GETS NOTHING AT ALL.
$PSQL -c "set local role anon; select count(*) from public.admin_leads;" >/dev/null 2>/tmp/fserr.txt
if grep -qiE "permission denied" /tmp/fserr.txt; then
  ok "a signed-out visitor cannot read the pipeline at all"
else
  bad "expected a permission refusal for anon; got: $(head -c 200 /tmp/fserr.txt | tr '\n' ' ')"
fi

# ==================================================================
# 5. THE TRIGGER CASE — THE ASSERTION 0020 § 1 (b) WAS WRITTEN FOR
# ==================================================================
# THIS IS THE SECTION THAT PROVES THE REASONING, so the reasoning comes first.
#
# `admin_lead_activity_touch` (0009:270) is a PLAIN trigger — NOT
# `security definer`. So the UPDATE it runs on admin_leads runs as the person who
# inserted the activity row, and IS subject to the admin_leads update policy.
#
# On an UNCLAIMED lead the row AFTER that update still has `owner_id is null`. So
# the tighter WITH CHECK the build plan specified —
#     with check ( admin_is_admin() or owner_id = auth.uid() )
# — would have refused the trigger's update and taken the WHOLE INSERT down with
# it. A rep logging a call on a lead they have not claimed yet is the ordinary
# first move in this business, and it would have failed with a permission error
# nobody could read.
#
# That is why `owner_id is null` is in the WITH CHECK as well as the USING, and
# these three assertions are the evidence for it. If somebody ever "tightens"
# that clause, this is the section that goes red — and the words above are why it
# must not be tightened.
seed_leads
is "logging a call on an UNCLAIMED lead SUCCEEDS — the trigger's own UPDATE has to pass the with check too" \
  "$(as "$REPA" "with i as (insert into public.admin_lead_activity (lead_id, actor, type, outcome, body) values ('$LF','$REPA','call','talked','Cold call, first move') returning 1) select count(*) from i;")" "1"
is "...and the trigger really did run: the unclaimed lead now has a last-touch date" \
  "$(val "select (last_touch_at is not null) from public.admin_leads where id='$LF';")" "t"
is "...and a first-contact date, which is what the 3-business-day timer counts from" \
  "$(val "select (first_contact_at is not null) from public.admin_leads where id='$LF';")" "t"
is "logging a call on YOUR OWN lead succeeds too" \
  "$(as "$REPA" "with i as (insert into public.admin_lead_activity (lead_id, actor, type, body) values ('$LA','$REPA','email','Email #1') returning 1) select count(*) from i;")" "1"
# A dated line, on a record nobody can edit afterwards, about a conversation the
# lead's owner knows nothing about. Unreachable on the old pages because a rep
# only ever saw their own leads; the Floor shows everything, so it stops being
# unreachable.
denied "a rep CANNOT log an activity row against another rep's lead" "$REPA" \
  "insert into public.admin_lead_activity (lead_id, actor, type, body) values ('$LB','$REPA','call','Went behind their back')" "row-level security"
denied "a rep CANNOT file an activity row under somebody else's name" "$REPA" \
  "insert into public.admin_lead_activity (lead_id, actor, type, body) values ('$LA','$REPB','call','Not me')" "row-level security"
# Activity SELECT stays wide, from 0001: a rep opening somebody else's row
# read-only has to be able to read its timeline, or "so nobody doubles up on this
# firm" does not work.
is "a rep can still READ the timeline of a lead they cannot touch" \
  "$(as "$REPB" "select count(*) from public.admin_lead_activity where lead_id='$LA';")" "1"

# ==================================================================
# 6. PROPOSALS — THE SAME SHAPE, THROUGH THE LEAD
# ==================================================================
# A proposal carries the only figure of money a rep can see, and 0009:457 gave it
# the identical too-wide `for update using (admin_is_member())`.
#
# Scoped on the LEAD's owner, deliberately NOT on `created_by`: a proposal
# drafted by CJ on a rep's lead is still that rep's proposal to send, and scoping
# on the author would lock them out. That is what the first assertion checks.
$PSQL <<SQL >/dev/null
insert into public.admin_proposals (id, lead_id, title, amount_cents, status, created_by) values
  ('b2000000-0000-0000-0000-000000000001','$LA','GEO for Harborline',250000,'draft','$OWNER'),
  ('b2000000-0000-0000-0000-000000000002','$LB','GEO for Westpoint',250000,'draft','$OWNER'),
  ('b2000000-0000-0000-0000-000000000003',null,'A template nobody has attached yet',null,'draft','$OWNER');
SQL
is "a rep CAN edit a proposal on their own lead, even one CJ drafted" \
  "$(upd "$REPA" "update public.admin_proposals set status='sent', sent_at=now() where id='b2000000-0000-0000-0000-000000000001'")" "1"
is "a rep CANNOT edit a proposal on another rep's lead" \
  "$(upd "$REPA" "update public.admin_proposals set amount_cents=1 where id='b2000000-0000-0000-0000-000000000002'")" "0"
is "...and the money on it is untouched" \
  "$(val "select amount_cents from public.admin_proposals where id='b2000000-0000-0000-0000-000000000002';")" "250000"
# THE EXPLICIT `lead_id is null` BRANCH. 0020 § 3 says why it is written out
# rather than left to fall out of the subquery: an EXISTS over no rows is FALSE,
# so without this branch every unattached proposal would have been uneditable by
# EVERYBODY — including the person who had just created it. Silently.
is "a proposal attached to no lead is editable by any member — there is nobody it could belong to" \
  "$(upd "$REPA" "update public.admin_proposals set title='Now it has a name' where id='b2000000-0000-0000-0000-000000000003'")" "1"
is "...by the other rep as well, which is what an EXISTS over no rows would have broken" \
  "$(upd "$REPB" "update public.admin_proposals set notes='mine too' where id='b2000000-0000-0000-0000-000000000003'")" "1"
is "a proposal on a lead nobody holds is editable by any rep" \
  "$(as "$REPA" "with i as (insert into public.admin_proposals (lead_id, title, status, created_by) values ('$LF','On a floor lead','draft','$REPA') returning 1) select count(*) from i;")" "1"
is "an owner CAN edit any proposal" \
  "$(upd "$OWNER" "update public.admin_proposals set amount_cents=300000 where id='b2000000-0000-0000-0000-000000000002'")" "1"

# ==================================================================
# 7. EMAIL THREADS — A REP WORKS THEIR OWN MAILBOX
# ==================================================================
# src/components/admin/Inbox.jsx reads and writes this table STRAIGHT FROM THE
# BROWSER. There is no endpoint in between, so there is nowhere else to put the
# rule. Without a policy here a rep's Gmail page renders an empty list with no
# error, which reads exactly like an empty inbox.
#
# A rep gets a thread if its mailbox is one THEY THEMSELVES connected.
# admin_gmail_accounts is keyed (user_id, email_address), so the subquery means
# "the addresses I connected" and never "an address somebody shared with me".
$PSQL <<SQL >/dev/null
insert into public.admin_gmail_accounts (user_id, email_address, refresh_token) values
  ('$REPA','larry@aisyndicate.com','tok-a'),
  ('$OWNER','growth@aisyndicate.com','tok-g');
update public.admin_gmail_accounts set shared = true where email_address = 'growth@aisyndicate.com';
insert into public.admin_email_threads (id, mailbox, thread_id, subject) values
  ('c3000000-0000-0000-0000-000000000001','larry@aisyndicate.com','t-larry','A reply from a prospect'),
  ('c3000000-0000-0000-0000-000000000002','growth@aisyndicate.com','t-growth','A client invoice');
SQL
is "a rep sees ONLY the threads in the mailbox they connected themselves" \
  "$(as "$REPA" "select count(*) from public.admin_email_threads;")" "1"
is "...and it is the right one" \
  "$(as "$REPA" "select mailbox from public.admin_email_threads;")" "larry@aisyndicate.com"
# THE ONE THAT MATTERS FOR PRIVACY. growth@ is marked shared so the other OWNERS
# work one mailbox — that must not leak client billing to sales. 0020 notes that
# resolveMailbox() in lib/gmail-mailbox.js already refuses a rep a shared mailbox
# server-side; this is the same refusal in the database, where it cannot be
# skipped by an old tab or a script.
is "a SHARED mailbox is still not a rep's mailbox — client billing does not leak to sales" \
  "$(as "$REPA" "select count(*) from public.admin_email_threads where mailbox='growth@aisyndicate.com';")" "0"
is "a rep CAN work a thread in their own mailbox" \
  "$(upd "$REPA" "update public.admin_email_threads set status='needs_reply', notes='chasing' where id='c3000000-0000-0000-0000-000000000001'")" "1"
is "a rep CANNOT work a thread in a mailbox that is not theirs" \
  "$(upd "$REPA" "update public.admin_email_threads set status='done' where id='c3000000-0000-0000-0000-000000000002'")" "0"
is "...and its status is untouched" \
  "$(val "select status from public.admin_email_threads where id='c3000000-0000-0000-0000-000000000002';")" "new"
denied "a rep CANNOT file a new thread under somebody else's mailbox" "$REPA" \
  "insert into public.admin_email_threads (mailbox, thread_id) values ('growth@aisyndicate.com','t-forged')" "row-level security"
is "a rep CAN file a thread under their own" \
  "$(as "$REPA" "with i as (insert into public.admin_email_threads (mailbox, thread_id) values ('larry@aisyndicate.com','t-new') returning 1) select count(*) from i;")" "1"
# THE ADMIN POLICY IS UNTOUCHED. Two policies for one command are OR'd in
# Postgres, so the rep policy widens nothing for an owner and takes nothing away.
is "an owner still sees EVERY thread, in every mailbox" \
  "$(as "$OWNER" "select count(*) from public.admin_email_threads;")" "3"
is "an owner can still work a thread in a mailbox they did not connect" \
  "$(upd "$OWNER" "update public.admin_email_threads set status='done' where id='c3000000-0000-0000-0000-000000000001'")" "1"

# ==================================================================
# 8. TAG EVENTS — 0018 LEFT THIS RULE OUT AND POINTED HERE
# ==================================================================
$PSQL <<SQL >/dev/null
insert into public.admin_lead_tags (id, slug, label) values
  ('d4000000-0000-0000-0000-000000000001','hot','Hot')
  on conflict (slug) do nothing;
SQL
TAG="$(val "select id from public.admin_lead_tags where slug='hot';")"
is "a rep CAN tag a lead they hold" \
  "$(as "$REPA" "with i as (insert into public.admin_lead_tag_events (lead_id, tag_id, action, by, source, why) values ('$LA','$TAG','added','$REPA','person','Replied same day') returning 1) select count(*) from i;")" "1"
is "a rep CAN tag a lead nobody holds" \
  "$(as "$REPA" "with i as (insert into public.admin_lead_tag_events (lead_id, tag_id, action, by, source, why) values ('$LF','$TAG','added','$REPA','person','On the floor') returning 1) select count(*) from i;")" "1"
denied "a rep CANNOT tag another rep's lead" "$REPA" \
  "insert into public.admin_lead_tag_events (lead_id, tag_id, action, by, source) values ('$LB','$TAG','added','$REPA','person')" "row-level security"
denied "a rep CANNOT file a tag event under somebody else's name" "$REPA" \
  "insert into public.admin_lead_tag_events (lead_id, tag_id, action, by, source) values ('$LA','$TAG','removed','$REPB','person')" "row-level security"
# `by` is nullable on purpose — NULL means the system did it, and pretending a
# rule was a person is worse than saying nobody. So a null `by` has to be allowed
# on a lead the caller may work, and refused on one they may not.
is "an automatic tag with no person on it is allowed on a lead the caller may work" \
  "$(as "$REPA" "with i as (insert into public.admin_lead_tag_events (lead_id, tag_id, action, by, source, why) values ('$LA','$TAG','removed',null,'auto','7 days with no touch') returning 1) select count(*) from i;")" "1"
denied "...but not on another rep's lead" "$REPA" \
  "insert into public.admin_lead_tag_events (lead_id, tag_id, action, by, source) values ('$LB','$TAG','added',null,'auto')" "row-level security"
is "an owner CAN tag anybody's lead" \
  "$(as "$OWNER" "with i as (insert into public.admin_lead_tag_events (lead_id, tag_id, action, by, source) values ('$LB','$TAG','added','$OWNER','person') returning 1) select count(*) from i;")" "1"

# ==================================================================
# 9. THE TWO SMALL THINGS 0020 ALSO FIXES
# ==================================================================
# api/rep-report.js:215 inserts `counted_cause` and 0017 never defined it. 0017
# has never been run, so nothing is broken TODAY — but the moment somebody runs
# it, every rep answer fails to save, SILENTLY, because the endpoint logs the
# error and returns the words anyway (right for the rep, wrong for whoever has to
# notice). One line in 0020 makes running the two in either order safe.
is "admin_rep_reports.counted_cause exists — the column api/rep-report.js:215 already writes" \
  "$(val "select count(*) from information_schema.columns where table_schema='public' and table_name='admin_rep_reports' and column_name='counted_cause';")" "1"

# admin_lead_claim_text: 0021 repointed the gate from `email_opened_at` — which
# nothing has ever written, so the Text button has never once been usable — to
# `first_reply_at`. And 0020's row lock had to go INSIDE the function, because it
# is `security definer` and therefore writes past RLS: without that line a rep
# could spend another rep's one text on their lead by calling it directly.
seed_leads
is "a rep CAN claim the one text on their own lead once somebody has replied" \
  "$(as "$REPA" "select public.admin_lead_claim_text('$LA3');")" "t"
is "...and only once. One text. One." \
  "$(as "$REPA" "select public.admin_lead_claim_text('$LA3');")" "f"
is "...and the counter says one" "$(val "select texts_sent from public.admin_leads where id='$LA3';")" "1"
is "a lead nobody has replied to cannot be texted at all — the gate is first_reply_at, never an 'open'" \
  "$(as "$REPA" "select public.admin_lead_claim_text('$LA');")" "f"
is "...and no text was counted against it" "$(val "select texts_sent from public.admin_leads where id='$LA';")" "0"
# THE ROW LOCK INSIDE A SECURITY DEFINER FUNCTION. RLS does not apply in here, so
# the rule has to be written into the WHERE clause by hand — and this is the
# assertion that proves somebody did.
is "a rep CANNOT spend another rep's one text, even by calling the function directly" \
  "$(as "$REPA" "select public.admin_lead_claim_text('$LB2');")" "f"
is "...and that lead's counter is untouched" "$(val "select texts_sent from public.admin_leads where id='$LB2';")" "0"
is "an owner CAN text anybody's lead" "$(as "$OWNER" "select public.admin_lead_claim_text('$LB2');")" "t"
$PSQL -c "set local role anon; select public.admin_lead_claim_text('$LA3');" >/dev/null 2>/tmp/fserr.txt
if grep -qiE "not authorized|permission denied" /tmp/fserr.txt; then
  ok "a signed-out visitor cannot claim a text"
else
  bad "expected an authorisation refusal; got: $(head -c 200 /tmp/fserr.txt | tr '\n' ' ')"
fi

# ==================================================================
# 10. THE MUTATION SECTION — DOES THIS FILE NOTICE WHEN THE LOCK IS GONE?
# ==================================================================
# A TEST THAT KEEPS PASSING WHILE THE FEATURE IS BROKEN IS WORSE THAN NO TEST. It
# is not neutral — it is a green tick standing in front of an open door. So this
# section puts 0001's policy back, verbatim: one `using (admin_is_member())`
# clause and no `with check`. It re-runs the two assertions that matter most and
# asserts THEY NOW FAIL. Then it restores 0020 and asserts they pass again.
#
# WHY 0001'S SHAPE AND NOT "0020 WITH THE WITH CHECK DELETED". Because deleting
# the with check from 0020 would NOT open the hole: with no with-check clause,
# Postgres uses the USING clause as the check, and 0020's USING already refuses a
# row whose new owner is somebody else. The hole is specifically the WIDE SINGLE
# CLAUSE, which is exactly what 0001 had. Getting this wrong would produce a
# mutation section that proves nothing, so it is written down here rather than
# left to be rediscovered.
seed_leads
$PSQL <<'SQL' >/dev/null
drop policy if exists "members update leads" on public.admin_leads;
create policy "members update leads" on public.admin_leads
  for update using (public.admin_is_member());
SQL

MUT_REASSIGN="$(upd "$REPA" "update public.admin_leads set owner_id='$REPA' where id='$LB'")"
seed_leads
MUT_EDIT="$(upd "$REPA" "update public.admin_leads set notes='I should not be able to do this' where id='$LB'")"

# Note the direction. Under the broken policy these MUST succeed. If they still
# come back 0, the probes in section 3 are not sensitive to the policy at all and
# every green tick there is meaningless.
if [ "$MUT_REASSIGN" = "1" ]; then
  ok "MUTATION: with 0001's one-clause policy back, a rep CAN steal another rep's lead — so section 3 really is testing the policy"
else
  bad "MUTATION: the hole was reopened and 'a rep cannot take another rep's lead' STILL passed (got '$MUT_REASSIGN'). Section 3 is not sensitive to the policy — the green ticks there mean nothing."
fi
if [ "$MUT_EDIT" = "1" ]; then
  ok "MUTATION: ...and CAN edit it, which is the second thing section 3 claims to stop"
else
  bad "MUTATION: editing another rep's lead was still refused with the lock removed (got '$MUT_EDIT'). Section 3 is not sensitive to the policy."
fi

# PUT IT BACK, AND PROVE IT WENT BACK. A mutation section that leaves the
# database open makes every assertion after it a lie, so 0020 is re-applied and
# the same probes are re-run.
seed_leads
if $PSQL -f supabase/migrations/0020_rep_scoping.sql >/dev/null 2>/tmp/fsmig.err; then
  ok "MUTATION: 0020 re-applied cleanly, putting the lock back"
else
  bad "MUTATION: 0020 would not re-apply — THE DATABASE IS LEFT OPEN:"; sed 's/^/       /' /tmp/fsmig.err
fi
is "MUTATION: with the lock back, a rep cannot take another rep's lead again" \
  "$(upd "$REPA" "update public.admin_leads set owner_id='$REPA' where id='$LB'")" "0"
is "MUTATION: ...and cannot edit it again" \
  "$(upd "$REPA" "update public.admin_leads set notes='nope' where id='$LB'")" "0"
denied "MUTATION: ...and cannot hand their own away again" "$REPA" \
  "update public.admin_leads set owner_id='$REPB' where id='$LA'" "row-level security"
is "MUTATION: the with check really is back on the policy" \
  "$(val "select (with_check is not null)::text from pg_policies where tablename='admin_leads' and policyname='members update leads';")" "true"

# ==================================================================
# 11. MIGRATION 0023 — THE WON FUNCTION, WHICH WRITES PAST RLS BY DESIGN
# ==================================================================
# `admin_lead_to_client` is `security definer`, so NONE of the policies proved
# above apply to anything it writes. Until 0023 its only guard was
# `admin_is_member()`, and it took the author's id as a PARAMETER — so one rpc
# call from a rep's browser console closed another rep's deal, created a client
# record, relinked every contact at that firm, and filed the timeline row under
# whatever user id the caller typed.
#
# Everything in sections 1-10 could be green with this wide open, which is
# exactly why it needs its own section.
seed_leads
$PSQL <<SQL >/dev/null
delete from public.admin_clients;
insert into public.admin_companies (id, name, domain)
  values ('cf000000-0000-0000-0000-000000000001','Westpoint Auto Group','westpoint-floor.com')
  on conflict (id) do nothing;
update public.admin_leads set company_id='cf000000-0000-0000-0000-000000000001' where id='$LB';
SQL

# A REP CANNOT CLOSE ANOTHER REP'S DEAL.
$PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$REPA';
  select public.admin_lead_to_client('$LB', '$REPA');" >/dev/null 2>/tmp/fs23.err
if grep -qi "belongs to somebody else" /tmp/fs23.err; then
  ok "0023: A REP CANNOT MARK ANOTHER REP'S DEAL WON, and is told why"
else
  bad "0023: closing another rep's deal was not refused for the right reason — got: $(head -c 200 /tmp/fs23.err | tr '\n' ' ')"
fi
is "0023: ...and nothing was written on that lead" \
  "$(val "select became_customer::text from public.admin_leads where id='$LB';")" "false"
is "0023: ...and no client record was created" \
  "$(val "select count(*) from public.admin_clients;")" "0"

# A REP CANNOT FILE THE RECORD UNDER SOMEBODY ELSE'S NAME.
$PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$REPA';
  select public.admin_lead_to_client('$LA', '$REPB');" >/dev/null 2>/tmp/fs23.err
if grep -qi "under your own name" /tmp/fs23.err; then
  ok "0023: A REP CANNOT NAME SOMEBODY ELSE AS THE PERSON WHO CLOSED IT"
else
  bad "0023: the forged author was not refused — got: $(head -c 200 /tmp/fs23.err | tr '\n' ' ')"
fi
is "0023: ...and their own lead is untouched by the attempt" \
  "$(val "select became_customer::text from public.admin_leads where id='$LA';")" "false"

# AND THE LEGITIMATE PATHS STILL WORK, which is the half a guard usually breaks.
OWN_CLIENT="$(as "$REPA" "select (public.admin_lead_to_client('$LA', '$REPA'))->>'client_id';")"
if [ -n "$OWN_CLIENT" ]; then
  ok "0023: a rep CAN still close their OWN deal"
else
  bad "0023: a rep could not close their own deal — the guard is too tight"
fi
is "0023: ...and the timeline row is filed under THEM" \
  "$(val "select actor from public.admin_lead_activity where lead_id='$LA' and type='converted';")" "$REPA"

FREE_CLIENT="$(as "$REPA" "select (public.admin_lead_to_client('$LF', '$REPA'))->>'client_id';")"
if [ -n "$FREE_CLIENT" ]; then
  ok "0023: a rep CAN still close a lead nobody holds"
else
  bad "0023: a rep could not close an unclaimed lead — the guard is too tight"
fi

OWNER_CLIENT="$(as "$OWNER" "select (public.admin_lead_to_client('$LB', '$REPB'))->>'client_id';")"
if [ -n "$OWNER_CLIENT" ]; then
  ok "0023: an OWNER can still close anybody's deal, and name that rep as the closer"
else
  bad "0023: an owner could not close a rep's deal — the guard is too tight"
fi

# MUTATION-PROVED, like section 10: put 0015's unguarded version back and watch
# the two refusals above start passing when they should fail.
seed_leads
$PSQL -c "update public.admin_leads set company_id='cf000000-0000-0000-0000-000000000001' where id='$LB';" >/dev/null
$PSQL -f supabase/migrations/0015_sales_lifecycle.sql >/dev/null 2>&1
MUT23="$(as "$REPA" "select (public.admin_lead_to_client('$LB', '$REPB'))->>'client_id';")"
if [ -n "$MUT23" ]; then
  ok "MUTATION: with 0015's version back, a rep CAN close another rep's deal — so section 11 really is testing 0023"
else
  bad "MUTATION: closing another rep's deal was still refused with 0015's version back (got '$MUT23'). Section 11 is not sensitive to 0023 and its green ticks mean nothing."
fi
if $PSQL -f supabase/migrations/0023_close_the_won_hole.sql >/dev/null 2>/tmp/fs23.err; then
  ok "MUTATION: 0023 re-applied cleanly, closing the hole again"
else
  bad "MUTATION: 0023 would not re-apply — THE HOLE IS LEFT OPEN:"; sed 's/^/       /' /tmp/fs23.err
fi
seed_leads
$PSQL -c "delete from public.admin_clients;" >/dev/null
$PSQL -c "update public.admin_leads set company_id='cf000000-0000-0000-0000-000000000001' where id='$LB';" >/dev/null
$PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$REPA';
  select public.admin_lead_to_client('$LB', '$REPA');" >/dev/null 2>/tmp/fs23.err
if grep -qi "belongs to somebody else" /tmp/fs23.err; then
  ok "MUTATION: with 0023 back, another rep's deal is refused again"
else
  bad "MUTATION: 0023 was re-applied and the refusal did NOT come back — got: $(head -c 200 /tmp/fs23.err | tr '\n' ' ')"
fi

echo ""
if [ "$fails" = "0" ]; then echo "  all database checks passed"; else echo "  $fails FAILED"; fi
exit $fails
