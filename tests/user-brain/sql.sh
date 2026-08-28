#!/usr/bin/env bash
# THE DATABASE HALF OF "A REP'S OWN AI RULES".
#
# 0022 is a whole access model hanging off one column. Reading it and saying
# "that looks right" is not a test. This stands up a real Postgres, applies every
# migration in order, and attacks it:
#
#   · does 0022 apply, and is it re-runnable
#   · does a rep read and write ONLY their own rows
#   · can an OWNER read every rep's rows — and is an owner still unable to WRITE
#     somebody else's (correcting how a person writes is a conversation, not a
#     database write)
#   · can a rep file a rule under another person's id
#   · does the unique index on (user_id, setting_key) hold, and does a second
#     'tone' for one person UPDATE rather than duplicate
#   · are the body checks real — empty, whitespace-only, and over the cap
#   · does deleting the auth user take their rules with them
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
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/ub-mig.err; then
    echo "  FAIL migration $f did not apply:"; sed 's/^/       /' /tmp/ub-mig.err; exit 1
  fi
done
$PSQL -c "grant all on all tables in schema public to service_role;" >/dev/null
ok "every migration 0001-0022 applies in order"

$PSQL <<'SQL' >/dev/null
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','owner@x.com'),
  ('22222222-2222-2222-2222-222222222222','rep@x.com'),
  ('33333333-3333-3333-3333-333333333333','other@x.com'),
  ('44444444-4444-4444-4444-444444444444','stranger@x.com');
insert into public.admin_users (user_id, email, full_name, role, active) values
  ('11111111-1111-1111-1111-111111111111','owner@x.com','Owner O','owner',true),
  ('22222222-2222-2222-2222-222222222222','rep@x.com','Rep R','sales',true),
  ('33333333-3333-3333-3333-333333333333','other@x.com','Other Rep','sales',true);
-- 44444444 is signed in and is NOT on the team.
SQL

OWNER='11111111-1111-1111-1111-111111111111'
REP='22222222-2222-2222-2222-222222222222'
OTHER='33333333-3333-3333-3333-333333333333'
STRANGER='44444444-4444-4444-4444-444444444444'

val()      { $PSQL -tAc "$1" | tail -n 1 | tr -d '[:space:]'; }
valraw()   { $PSQL -tAc "$1" | tail -n 1; }
as_val()   { $PSQL -tAc "set local role authenticated; set local request.jwt.claim.sub = '$1'; $2" | tail -n 1 | tr -d '[:space:]'; }
# Captures the ERROR, not the exit code of a pipeline. Piping psql into `tail`
# reads tail's exit code, so a refusal check would pass no matter what happened —
# tests/sales-sheet/sql.sh learned that the first time it ran.
as_try()   { $PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$1'; $2" >/dev/null 2>/tmp/ub-err.txt; }
refuses()  { # name, uid, sql, expected-message-regex
  as_try "$2" "$3"
  if grep -qiE "$4" /tmp/ub-err.txt; then ok "$1"
  else bad "$1 — expected /$4/; got: $(head -c 220 /tmp/ub-err.txt | tr '\n' ' ')"; fi
}

# ==================================================================
# 1. IT IS RE-RUNNABLE, AND THE TABLE IS THE SHAPE THE CODE WRITES
# ==================================================================
if $PSQL -f supabase/migrations/0022_personal_brain.sql >/dev/null 2>/tmp/ub-mig.err; then
  ok "0022 can be run twice without breaking"
else
  bad "0022 is not re-runnable:"; sed 's/^/       /' /tmp/ub-mig.err
fi
# Every column src/lib/data.js and repBrain.jsx actually write. Three files in
# this repo once wrote column names the tables did not have, and the fixtures had
# invented the same wrong names — so the CREATE TABLE is read, not assumed.
for c in id user_id kind setting_key title body enabled created_at updated_at; do
  is "admin_user_brain has a '$c' column" \
    "$(val "select count(*) from information_schema.columns where table_name='admin_user_brain' and column_name='$c';")" "1"
done
is "user_id defaults to whoever is asking, so a row cannot be filed nameless" \
  "$(val "select column_default like '%auth.uid()%' from information_schema.columns where table_name='admin_user_brain' and column_name='user_id';")" "t"
is "kind defaults to 'rule'" \
  "$(val "select column_default like '%rule%' from information_schema.columns where table_name='admin_user_brain' and column_name='kind';")" "t"
is "row level security is ON — everything below depends on it" \
  "$(val "select relrowsecurity from pg_class where relname='admin_user_brain';")" "t"

# ==================================================================
# 2. A PERSON'S RULES ARE THEIR OWN
# ==================================================================
MINE="$(as_val "$REP" "with i as (insert into public.admin_user_brain (user_id, kind, body)
  values ('$REP','rule','One question per email, at the end.') returning id) select count(*) from i;")"
is "a rep can write their own rule" "$MINE" "1"
# The column defaults to auth.uid(), so a rep who does not send one still ends up
# owning their own row rather than one with no owner.
DEFAULTED="$(as_val "$REP" "with i as (insert into public.admin_user_brain (kind, body)
  values ('rule','Open with something about their business.') returning user_id) select user_id from i;")"
is "...and a rule written with no user_id is filed under THEM, not nobody" "$DEFAULTED" "$REP"
$PSQL -c "insert into public.admin_user_brain (user_id, kind, body) values ('$OTHER','rule','Always name the firm in the first line.');" >/dev/null

is "a rep reads their own rules" "$(as_val "$REP" "select count(*) from public.admin_user_brain;")" "2"
is "...AND NOT ANOTHER REP'S — that is the whole point of the separate table" \
  "$(as_val "$REP" "select count(*) from public.admin_user_brain where user_id='$OTHER';")" "0"
is "the other rep reads only theirs" "$(as_val "$OTHER" "select count(*) from public.admin_user_brain;")" "1"
is "somebody signed in who is not on the team reads nothing" \
  "$(as_val "$STRANGER" "select count(*) from public.admin_user_brain;")" "0"
is "...and the rows really are there when read without a policy in the way" \
  "$(val "select count(*) from public.admin_user_brain;")" "3"

$PSQL -c "set local role anon; select count(*) from public.admin_user_brain;" >/dev/null 2>/tmp/ub-err.txt
if grep -qiE "permission denied" /tmp/ub-err.txt; then
  ok "a signed-out visitor is refused outright, for a permission reason"
else
  bad "expected a permission refusal for anon; got: $(head -c 200 /tmp/ub-err.txt | tr '\n' ' ')"
fi

REPS_OWN="$(as_val "$REP" "select id from public.admin_user_brain where user_id='$REP' and kind='rule' limit 1;")"
OTHERS="$(val "select id from public.admin_user_brain where user_id='$OTHER';")"

is "a rep can edit their own rule" \
  "$(as_val "$REP" "with u as (update public.admin_user_brain set body='One question per email.' where id='$REPS_OWN' returning 1) select count(*) from u;")" "1"
# AN UPDATE THE POLICY REFUSES RAISES NOTHING — the `using` clause makes the row
# invisible, so the statement succeeds and changes nothing. Counting the rows is
# the only honest check here; looking for an error would pass whatever happened.
is "A REP'S EDIT OF ANOTHER REP'S RULE TOUCHES NO ROWS" \
  "$(as_val "$REP" "with u as (update public.admin_user_brain set body='Mine now' where id='$OTHERS' returning 1) select count(*) from u;")" "0"
is "...and the other rep's words are exactly as they left them" \
  "$(valraw "select body from public.admin_user_brain where id='$OTHERS';")" "Always name the firm in the first line."
is "a rep's delete of another rep's rule takes nothing" \
  "$(as_val "$REP" "with d as (delete from public.admin_user_brain where id='$OTHERS' returning 1) select count(*) from d;")" "0"
is "...and the row is still there" "$(val "select count(*) from public.admin_user_brain where id='$OTHERS';")" "1"
is "a rep CAN delete their own rule" \
  "$(as_val "$REP" "with d as (delete from public.admin_user_brain where id='$REPS_OWN' returning 1) select count(*) from d;")" "1"

# `user_id` is the whole access model in one field, so writing somebody else's
# into it is the one attack this table has.
refuses "A REP CANNOT FILE A RULE UNDER ANOTHER PERSON'S ID" "$REP" \
  "insert into public.admin_user_brain (user_id, kind, body) values ('$OTHER','rule','Sign off with my name.');" \
  "row-level security|violates row-level"
refuses "...not even under the owner's" "$REP" \
  "insert into public.admin_user_brain (user_id, kind, body) values ('$OWNER','rule','Sign off with my name.');" \
  "row-level security|violates row-level"
refuses "somebody not on the team cannot write a rule at all, even their own" "$STRANGER" \
  "insert into public.admin_user_brain (user_id, kind, body) values ('$STRANGER','rule','Let me in.');" \
  "row-level security|violates row-level"
# And a rep cannot MOVE their own row to somebody else, which the `with check`
# half of the policy is what stops.
refuses "a rep cannot hand their own rule to somebody else by editing the id on it" "$REP" \
  "update public.admin_user_brain set user_id='$OTHER' where user_id='$REP';" \
  "row-level security|violates row-level"

# ==================================================================
# 3. AN OWNER MAY READ EVERYTHING AND WRITE NOTHING
# ==================================================================
# A rule nobody can audit quietly rewrites what clients get told, so an owner
# reads every rep's. But correcting how another person writes is a conversation,
# not a database write — and a rep whose own settings changed under them with no
# explanation stops using the page.
is "AN OWNER READS EVERY REP'S RULES" \
  "$(as_val "$OWNER" "select count(*) from public.admin_user_brain;")" "$(val "select count(*) from public.admin_user_brain;")"
is "...including a rep's, by name" \
  "$(as_val "$OWNER" "select count(*) from public.admin_user_brain where user_id='$OTHER';")" "1"
is "AN OWNER'S EDIT OF A REP'S RULE TOUCHES NO ROWS" \
  "$(as_val "$OWNER" "with u as (update public.admin_user_brain set body='Do it my way' where id='$OTHERS' returning 1) select count(*) from u;")" "0"
is "...and the rep's words are untouched" \
  "$(valraw "select body from public.admin_user_brain where id='$OTHERS';")" "Always name the firm in the first line."
is "AN OWNER'S DELETE OF A REP'S RULE TAKES NOTHING" \
  "$(as_val "$OWNER" "with d as (delete from public.admin_user_brain where id='$OTHERS' returning 1) select count(*) from d;")" "0"
refuses "an owner cannot write a NEW rule into a rep's name either" "$OWNER" \
  "insert into public.admin_user_brain (user_id, kind, body) values ('$OTHER','rule','Say it like this.');" \
  "row-level security|violates row-level"
is "an owner can still write their OWN rules" \
  "$(as_val "$OWNER" "with i as (insert into public.admin_user_brain (user_id, kind, body) values ('$OWNER','rule','Lead with the finding.') returning 1) select count(*) from i;")" "1"
# The company Brain stays shut to a rep — that is why this is a separate table
# rather than a user_id column on admin_brain (0022's own header).
is "the company Brain is still closed to a rep, which is why this table exists at all" \
  "$(as_val "$REP" "select count(*) from public.admin_brain;")" "0"

# ==================================================================
# 4. ONE ROW PER SETTING PER PERSON
# ==================================================================
# Picking "Formal" twice must not leave two tone rules arguing in the prompt.
# THE INDEX IS NOT PARTIAL, AND THAT IS THE FIX RATHER THAN THE BUG.
#
# This assertion used to demand `where (setting_key IS NOT NULL)`, which reads as
# the careful choice and would have broken every save. Postgres only accepts a
# PARTIAL unique index as an ON CONFLICT arbiter when the statement repeats the
# index's predicate, and PostgREST's upsert emits a bare
# `on conflict (user_id, setting_key)` and cannot express a WHERE at all — so
# every "How I write" setting would have failed with 42P10, "there is no unique or
# exclusion constraint matching the ON CONFLICT specification". Preview mode never
# reaches that branch, so nothing would have caught it until the day somebody ran
# the migration.
#
# Dropping the predicate costs nothing: Postgres treats NULLs as DISTINCT in a
# unique index by default, so any number of null-setting_key rules still coexist
# for one person — which the assertion two below this one proves rather than
# assumes. Aug 27 2026.
is "the unique index exists on (user_id, setting_key) and is NOT partial, so PostgREST can name it" \
  "$(val "select count(*) from pg_indexes where indexname='admin_user_brain_setting_idx' and indexdef ilike '%(user_id, setting_key)%' and indexdef not ilike '%where%';")" "1"
$PSQL -c "insert into public.admin_user_brain (user_id, kind, setting_key, title, body) values ('$REP','voice','tone','Tone','Plain and direct');" >/dev/null
refuses "a second 'tone' for one person is refused by the index" "$REP" \
  "insert into public.admin_user_brain (user_id, kind, setting_key, title, body) values ('$REP','voice','tone','Tone','Formal');" \
  "duplicate key|unique"
is "the SAME setting key for a DIFFERENT person is fine — it is one row per person" \
  "$(as_val "$OTHER" "with i as (insert into public.admin_user_brain (user_id, kind, setting_key, title, body) values ('$OTHER','voice','tone','Tone','Warm') returning 1) select count(*) from i;")" "1"
is "MANY plain rules with a null setting_key are fine — Postgres counts NULLs as distinct" \
  "$(as_val "$REP" "with i as (insert into public.admin_user_brain (user_id, kind, body) values ('$REP','rule','A'),('$REP','rule','B'),('$REP','rule','C') returning 1) select count(*) from i;")" "3"

# THE WRITE THE CONSOLE ACTUALLY MAKES. upsertUserBrain in src/lib/data.js:3929
# sends `.upsert(clean, { onConflict: "user_id,setting_key" })`, which PostgREST
# turns into a bare `on conflict (user_id, setting_key) do update`. Postgres can
# only infer a PARTIAL unique index when the statement repeats the index's own
# predicate, so the bare form has no arbiter to match and raises. This asserts
# what the page needs to happen — picking "Formal" after "Plain and direct"
# UPDATES the one tone row — using the exact statement the page sends.
$PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$REP';
  insert into public.admin_user_brain (user_id, kind, setting_key, title, body)
  values ('$REP','voice','tone','Tone','Formal')
  on conflict (user_id, setting_key) do update set body = excluded.body;" >/dev/null 2>/tmp/ub-err.txt
if [ -s /tmp/ub-err.txt ]; then
  bad "picking a setting twice RAISES instead of updating — $(head -c 200 /tmp/ub-err.txt | tr '\n' ' ')"
else
  ok "picking a setting a second time updates the one row"
fi
is "...and there is still exactly one tone row for that person" \
  "$(val "select count(*) from public.admin_user_brain where user_id='$REP' and setting_key='tone';")" "1"
# BOTH FORMS WORK NOW, AND THAT IS WHAT MAKES THE PAGE SAFE.
#
# Pinned rather than assumed, because it is the whole reason the index stopped
# being partial and it is not obvious which way round it goes:
#
#   plain    `on conflict (user_id, setting_key)`  — what PostgREST emits, and the
#            only form it CAN emit. It needs a non-partial index and it now has
#            one. Asserted above.
#   with a   `... where setting_key is not null`   — a narrower ask. Postgres is
#   predicate happy to infer a NON-partial index for it too, which was worth
#            checking rather than reasoning about: a partial index would satisfy
#            this one and NOT the plain one, so a future edit that reinstates the
#            predicate on the index would break the page while leaving this line
#            green. The plain assertion above is the one that guards the page.
#
# Measured against a real Postgres 16 on Aug 27 2026, not deduced.
$PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$REP';
  insert into public.admin_user_brain (user_id, kind, setting_key, title, body)
  values ('$REP','voice','tone','Tone','Formal and short')
  on conflict (user_id, setting_key) where setting_key is not null do update set body = excluded.body;" >/dev/null 2>/tmp/ub-err.txt
if [ -s /tmp/ub-err.txt ]; then
  bad "the narrower, predicate-carrying upsert failed — $(head -c 200 /tmp/ub-err.txt | tr '\n' ' ')"
else
  ok "a narrower upsert that also names the predicate updates the same one row"
fi
is "...and the update really landed" \
  "$(valraw "select body from public.admin_user_brain where user_id='$REP' and setting_key='tone';")" "Formal and short"

# ==================================================================
# 5. THE BODY CHECKS ARE REAL, NOT COMMENTS
# ==================================================================
# A rule with no words in it renders as a blank bullet on the page and a blank
# line in the prompt.
refuses "an empty body is refused" "$REP" \
  "insert into public.admin_user_brain (user_id, kind, body) values ('$REP','rule','');" \
  "body_check|violates check"
refuses "a whitespace-only body is refused — btrim, not length" "$REP" \
  "insert into public.admin_user_brain (user_id, kind, body) values ('$REP','rule','   ');" \
  "body_check|violates check"
refuses "a newline-and-tab body is refused too" "$REP" \
  "insert into public.admin_user_brain (user_id, kind, body) values ('$REP','rule',E'\\n\\t ');" \
  "body_check|violates check"
refuses "a null body is refused" "$REP" \
  "insert into public.admin_user_brain (user_id, kind, body) values ('$REP','rule',null);" \
  "null value|not-null"
is "exactly two thousand characters is allowed" \
  "$(as_val "$REP" "with i as (insert into public.admin_user_brain (user_id, kind, body) values ('$REP','rule',repeat('a',2000)) returning 1) select count(*) from i;")" "1"
refuses "two thousand and one is refused, so one paste cannot fill every draft's prompt" "$REP" \
  "insert into public.admin_user_brain (user_id, kind, body) values ('$REP','rule',repeat('a',2001));" \
  "body_len_check|violates check"
# An UPDATE has to be checked too: a CHECK constraint applies to both, but a
# migration that added it as NOT VALID would pass the insert tests and let an
# edit through.
refuses "an EDIT cannot blank a body either" "$REP" \
  "update public.admin_user_brain set body = '' where user_id='$REP' and setting_key='tone';" \
  "body_check|violates check"
refuses "a kind nobody defined is refused" "$REP" \
  "insert into public.admin_user_brain (user_id, kind, body) values ('$REP','telepathy','Read my mind.');" \
  "kind_check|violates check"
for k in voice rule snippet signature; do
  is "'$k' is an allowed kind" \
    "$(as_val "$REP" "with i as (insert into public.admin_user_brain (user_id, kind, body) values ('$REP','$k','A rule.') returning 1) select count(*) from i;")" "1"
done
# NOT enforced in the database on purpose (0022's own header): "— Cam, AI
# Syndicate" is fine and "Rule 3:" is fine, so the no-numbers rule is a judgement
# about shape rather than a character class, and a judgement in a CHECK
# constraint is a judgement nobody can change without a migration. Pinned so the
# absence is a decision on record rather than something found later.
is "the database deliberately does NOT refuse a number — that gate is checkPersonalRule's job" \
  "$(as_val "$REP" "with i as (insert into public.admin_user_brain (user_id, kind, body) values ('$REP','rule','Our clients see a 40% lift.') returning 1) select count(*) from i;")" "1"
$PSQL -c "delete from public.admin_user_brain where body = 'Our clients see a 40% lift.';" >/dev/null

# ==================================================================
# 6. updated_at MOVES ON ITS OWN
# ==================================================================
BEFORE_TS="$(val "select updated_at from public.admin_user_brain where user_id='$OTHER' limit 1;")"
$PSQL -c "select pg_sleep(0.05);" >/dev/null
$PSQL -c "update public.admin_user_brain set body = 'Name the firm in the first line.' where user_id='$OTHER';" >/dev/null
AFTER_TS="$(val "select updated_at from public.admin_user_brain where user_id='$OTHER' limit 1;")"
if [ "$BEFORE_TS" != "$AFTER_TS" ]; then ok "updated_at is written by the trigger, not by the caller"; else bad "updated_at did not move on an edit"; fi

# ==================================================================
# 7. A PERSON LEAVING TAKES THEIR RULES WITH THEM
# ==================================================================
# These are settings, not records. Contrast admin_lead_tag_events, where the
# history IS the point and `by` is only set null. "My sign-off is X" is a current
# preference with no value once the person is gone.
$PSQL <<SQL >/dev/null
insert into auth.users (id, email) values ('55555555-5555-5555-5555-555555555555','leaver@x.com');
insert into public.admin_user_brain (id, user_id, kind, body)
  values ('99999999-0000-0000-0000-000000000001','55555555-5555-5555-5555-555555555555','rule','Sign off with just my first name.');
SQL
is "the leaver's rule is on file first" \
  "$(val "select count(*) from public.admin_user_brain where id='99999999-0000-0000-0000-000000000001';")" "1"
$PSQL -c "delete from auth.users where id='55555555-5555-5555-5555-555555555555';" >/dev/null
is "DELETING THE AUTH USER CASCADES THEIR RULES AWAY" \
  "$(val "select count(*) from public.admin_user_brain where id='99999999-0000-0000-0000-000000000001';")" "0"
is "...and takes nobody else's with it" \
  "$(val "select count(*) > 0 from public.admin_user_brain where user_id='$OTHER';")" "t"

echo ""
if [ "$fails" = "0" ]; then echo "  all database checks passed"; else echo "  $fails FAILED"; fi
exit $fails
