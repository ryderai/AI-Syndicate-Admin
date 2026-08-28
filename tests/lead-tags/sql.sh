#!/usr/bin/env bash
# THE DATABASE HALF OF "TAGS ON A LEAD".
#
# 0018 creates the vocabulary and the append-only event log; 0020 is where the
# row-level lock on tagging lives. Reading them and saying "that looks right" is
# not a test. This stands up a real Postgres, applies every migration in order,
# and attacks it:
#
#   · does every migration 0001-0022 apply, and is 0018 re-runnable
#   · does the seed land, and does a re-run leave a label somebody changed alone
#   · CAN AN EVENT BE EDITED OR DELETED BY ANYBODY, INCLUDING AN ADMIN
#     (it must not be — there is no update or delete grant at all)
#   · does admin_lead_tags_now return the NEWEST event per (lead, tag),
#     removals included
#   · is that view security_invoker, so the policy on the table still applies
#     through it
#   · can a rep tag their own lead and an unclaimed one, and NOT another rep's
#   · can a rep file an event under somebody else's name
#   · is 'tag' an allowed activity type, and is every value the old check
#     allowed still allowed (a past migration lost 'email' exactly this way)
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

# The Supabase shim: auth.users, auth.uid() and the three roles the migrations
# grant to. Same shape as tests/sales-sheet/sql.sh.
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
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/lt-mig.err; then
    echo "  FAIL migration $f did not apply:"; sed 's/^/       /' /tmp/lt-mig.err; exit 1
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
-- 44444444 is a real auth user with NO admin_users row: signed in, not a member.
SQL

OWNER='11111111-1111-1111-1111-111111111111'
REP='22222222-2222-2222-2222-222222222222'
OTHER='33333333-3333-3333-3333-333333333333'
STRANGER='44444444-4444-4444-4444-444444444444'

val()      { $PSQL -tAc "$1" | tail -n 1 | tr -d '[:space:]'; }
valraw()   { $PSQL -tAc "$1" | tail -n 1; }
as_val()   { $PSQL -tAc "set local role authenticated; set local request.jwt.claim.sub = '$1'; $2" | tail -n 1 | tr -d '[:space:]'; }
# Runs a statement as somebody and captures the ERROR, not the exit code of a
# pipeline. tests/sales-sheet/sql.sh learned this the hard way: piping psql into
# `tail` reads tail's exit code, so a refusal check passed no matter what.
as_try()   { $PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$1'; $2" >/dev/null 2>/tmp/lt-err.txt; }
refuses()  { # name, uid, sql, expected-message-regex
  as_try "$2" "$3"
  if grep -qiE "$4" /tmp/lt-err.txt; then ok "$1"
  else bad "$1 — expected /$4/; got: $(head -c 220 /tmp/lt-err.txt | tr '\n' ' ')"; fi
}

# ==================================================================
# 1. THE SEED, AND WHAT A RE-RUN MUST NOT DO
# ==================================================================
is "the starting vocabulary landed — twenty-one tags" \
  "$(val "select count(*) from public.admin_lead_tags;")" "21"
is "no two tags share a slug" \
  "$(val "select count(distinct slug) from public.admin_lead_tags;")" "21"
is "every tag is active on a fresh database" \
  "$(val "select count(*) from public.admin_lead_tags where active;")" "21"
is "the sort order the filter menu is built from has no gaps in its identity" \
  "$(val "select count(distinct sort) from public.admin_lead_tags;")" "21"
is "no tag was seeded without words a person can read" \
  "$(val "select count(*) from public.admin_lead_tags where label is null or btrim(label) = '';")" "0"

# THE ONE THAT MAKES A RE-RUN SAFE. `on conflict (slug) do nothing` — somebody
# renames a chip on screen, the migration runs again, and the rename survives.
$PSQL -c "update public.admin_lead_tags set label = 'No site at all', color = 'purple' where slug = 'no-website';" >/dev/null
if $PSQL -f supabase/migrations/0018_lead_tags.sql >/dev/null 2>/tmp/lt-mig.err; then
  ok "0018 can be run twice without breaking"
else
  bad "0018 is not re-runnable:"; sed 's/^/       /' /tmp/lt-mig.err
fi
is "...and a label somebody changed by hand is NOT overwritten by the re-run" \
  "$(valraw "select label from public.admin_lead_tags where slug='no-website';")" "No site at all"
is "...nor is the colour" \
  "$(val "select color from public.admin_lead_tags where slug='no-website';")" "purple"
is "...and no tag was duplicated" \
  "$(val "select count(*) from public.admin_lead_tags;")" "21"
$PSQL -c "update public.admin_lead_tags set label = 'No website', color = 'red' where slug = 'no-website';" >/dev/null

# ==================================================================
# 2. 'tag' IS A THING THAT CAN HAPPEN TO A LEAD — AND SO IS EVERYTHING ELSE
# ==================================================================
# A past migration lost 'email' from this check by re-adding it without
# re-listing every value, and a button broke for days. So: every value the old
# check allowed is asserted individually, not counted.
$PSQL -c "insert into public.admin_leads (id, name, stage) values ('aaaaaaa1-0000-0000-0000-00000000000a','Type Probe','new');" >/dev/null
for t in call email text linkedin note status_change assigned claim unclaim reopen score proposal import cadence open converted client_link tag; do
  if $PSQL -c "insert into public.admin_lead_activity (lead_id, actor, type, body) values ('aaaaaaa1-0000-0000-0000-00000000000a','$OWNER','$t','probe');" >/dev/null 2>&1; then
    ok "'$t' is still an allowed activity type"
  else
    bad "'$t' is NO LONGER an allowed activity type — 0018 dropped it off the re-added check"
  fi
done
refuses "an activity type nobody defined is still refused" "$OWNER" \
  "insert into public.admin_lead_activity (lead_id, type, body, actor) values ('aaaaaaa1-0000-0000-0000-00000000000a','telepathy','x','$OWNER');" \
  "type_check|violates check"

# ==================================================================
# 3. THE EVENT LOG IS APPEND ONLY — FOR EVERYBODY
# ==================================================================
$PSQL <<'SQL' >/dev/null
insert into public.admin_companies (id, name, domain)
  values ('cccccccc-0000-0000-0000-000000000001','Harborline Realty','harborline.com');
insert into public.admin_leads (id, name, company_id, stage, owner_id) values
  ('bbbbbbb1-0000-0000-0000-000000000001','Dana Whitfield','cccccccc-0000-0000-0000-000000000001','contacted','22222222-2222-2222-2222-222222222222'),
  ('bbbbbbb1-0000-0000-0000-000000000002','Nobody Holds Me','cccccccc-0000-0000-0000-000000000001','new',null),
  ('bbbbbbb1-0000-0000-0000-000000000003','Other Reps Lead','cccccccc-0000-0000-0000-000000000001','contacted','33333333-3333-3333-3333-333333333333');
SQL
QUIET_TAG="$(val "select id from public.admin_lead_tags where slug='quiet';")"
HOT_TAG="$(val "select id from public.admin_lead_tags where slug='hot';")"

$PSQL -c "insert into public.admin_lead_tag_events (id, lead_id, tag_id, action, at, source, why) values
  ('ffffff01-0000-0000-0000-000000000001','bbbbbbb1-0000-0000-0000-000000000001','$QUIET_TAG','added','2026-08-20T12:00:00Z','auto','7 days with no update');" >/dev/null

# NO UPDATE GRANT AND NO UPDATE POLICY AT ALL. Not for a rep, not for an owner.
# An event you can edit is not a record — a correction is a new event.
refuses "a rep CANNOT edit an event" "$REP" \
  "update public.admin_lead_tag_events set why = 'rewritten' where id = 'ffffff01-0000-0000-0000-000000000001';" \
  "permission denied"
refuses "AN OWNER CANNOT EDIT AN EVENT EITHER — there is no update grant to hold" "$OWNER" \
  "update public.admin_lead_tag_events set why = 'rewritten' where id = 'ffffff01-0000-0000-0000-000000000001';" \
  "permission denied"
refuses "a rep CANNOT delete an event" "$REP" \
  "delete from public.admin_lead_tag_events where id = 'ffffff01-0000-0000-0000-000000000001';" \
  "permission denied"
refuses "AN OWNER CANNOT DELETE AN EVENT EITHER" "$OWNER" \
  "delete from public.admin_lead_tag_events where id = 'ffffff01-0000-0000-0000-000000000001';" \
  "permission denied"
is "...and the row is untouched after all four attempts" \
  "$(valraw "select why from public.admin_lead_tag_events where id='ffffff01-0000-0000-0000-000000000001';")" "7 days with no update"
# Said the other way round, from the catalogue, so the reason is on record and
# not only the symptom: the grant itself does not exist.
is "there is no UPDATE privilege on the events table for authenticated" \
  "$(val "select has_table_privilege('authenticated','public.admin_lead_tag_events','UPDATE');")" "f"
is "there is no DELETE privilege on the events table for authenticated" \
  "$(val "select has_table_privilege('authenticated','public.admin_lead_tag_events','DELETE');")" "f"
is "...and no update or delete POLICY was written either, so nothing can grow one by accident" \
  "$(val "select count(*) from pg_policies where tablename='admin_lead_tag_events' and cmd in ('UPDATE','DELETE');")" "0"
is "insert and select ARE granted, so the log can still be written and read" \
  "$(val "select has_table_privilege('authenticated','public.admin_lead_tag_events','INSERT')::text || has_table_privilege('authenticated','public.admin_lead_tag_events','SELECT')::text;")" "truetrue"

# ==================================================================
# 4. THE VIEW IS "THE NEWEST EVENT PER TAG", REMOVALS INCLUDED
# ==================================================================
$PSQL -c "insert into public.admin_lead_tag_events (id, lead_id, tag_id, action, at, source, why) values
  ('ffffff01-0000-0000-0000-000000000002','bbbbbbb1-0000-0000-0000-000000000001','$QUIET_TAG','removed','2026-08-24T12:00:00Z','person','removed by hand — she replied'),
  ('ffffff01-0000-0000-0000-000000000003','bbbbbbb1-0000-0000-0000-000000000001','$HOT_TAG','added','2026-08-23T12:00:00Z','auto','they replied');" >/dev/null

is "one row per (lead, tag), not one per event" \
  "$(val "select count(*) from public.admin_lead_tags_now where lead_id='bbbbbbb1-0000-0000-0000-000000000001';")" "2"
is "the NEWEST event wins" \
  "$(val "select id from public.admin_lead_tags_now where lead_id='bbbbbbb1-0000-0000-0000-000000000001' and tag_id='$QUIET_TAG';")" \
  "ffffff01-0000-0000-0000-000000000002"
# REMOVALS STAY IN THE VIEW. It is "the newest event per tag", not "the tags that
# are on": currentTags() filters for 'added', and the automatic rules read the
# removals to see what a person took off by hand so they never put it back.
# Filtering removals out here would have deleted that silently.
is "A REMOVAL IS STILL IN THE VIEW — that is how the rules know not to put it back" \
  "$(val "select action from public.admin_lead_tags_now where lead_id='bbbbbbb1-0000-0000-0000-000000000001' and tag_id='$QUIET_TAG';")" "removed"
is "...and it carries who did it and why, not just that it happened" \
  "$(val "select (source = 'person') from public.admin_lead_tags_now where tag_id='$QUIET_TAG' and lead_id='bbbbbbb1-0000-0000-0000-000000000001';")" "t"
is "a tag whose newest event is an add is still an add" \
  "$(val "select action from public.admin_lead_tags_now where lead_id='bbbbbbb1-0000-0000-0000-000000000001' and tag_id='$HOT_TAG';")" "added"

# TIES ARE ORDINARY, NOT RARE: an import writes several events in one statement
# and Postgres gives them all the same now(). The view breaks the tie on id
# DESC, and lib/lead-tags.js inOrder() must break it the same way or the browser
# and the database disagree about which tag is on.
$PSQL -c "insert into public.admin_lead_tag_events (id, lead_id, tag_id, action, at, source) values
  ('ffffff01-0000-0000-0000-0000000000a1','bbbbbbb1-0000-0000-0000-000000000002','$QUIET_TAG','added','2026-08-26T12:00:00Z','import'),
  ('ffffff01-0000-0000-0000-0000000000a2','bbbbbbb1-0000-0000-0000-000000000002','$QUIET_TAG','removed','2026-08-26T12:00:00Z','import');" >/dev/null
is "with an identical timestamp the HIGHER id wins, deterministically" \
  "$(val "select id from public.admin_lead_tags_now where lead_id='bbbbbbb1-0000-0000-0000-000000000002' and tag_id='$QUIET_TAG';")" \
  "ffffff01-0000-0000-0000-0000000000a2"
is "...and it is the same answer on a second read, not a coin toss" \
  "$(val "select id from public.admin_lead_tags_now where lead_id='bbbbbbb1-0000-0000-0000-000000000002' and tag_id='$QUIET_TAG';")" \
  "ffffff01-0000-0000-0000-0000000000a2"

# ==================================================================
# 5. THE VIEW IS security_invoker, SO IT IS NOT A WAY ROUND THE POLICY
# ==================================================================
# Without this, a view is read with the PERMISSIONS OF ITS OWNER, which is how a
# view becomes a hole in the row-level security on the table underneath it.
is "the view is declared security_invoker" \
  "$(val "select count(*) from pg_class c where c.relname='admin_lead_tags_now' and c.reloptions::text like '%security_invoker=%on%';")" "1"
is "a member reads the log through the view" \
  "$(as_val "$REP" "select count(*) > 0 from public.admin_lead_tags_now;")" "t"
# THE PROOF THAT THE POLICY REALLY APPLIES THROUGH IT: somebody signed in who is
# not on the team. The table's select policy is admin_is_member(), so a
# security_definer view would hand them the whole log and this returns 0.
is "SOMEBODY SIGNED IN WHO IS NOT ON THE TEAM READS NOTHING THROUGH THE VIEW" \
  "$(as_val "$STRANGER" "select count(*) from public.admin_lead_tags_now;")" "0"
is "...and nothing from the table underneath either" \
  "$(as_val "$STRANGER" "select count(*) from public.admin_lead_tag_events;")" "0"
is "...while the rows really are there when read without a policy in the way" \
  "$(val "select count(*) > 0 from public.admin_lead_tag_events;")" "t"
$PSQL -c "set local role anon; select count(*) from public.admin_lead_tags_now;" >/dev/null 2>/tmp/lt-err.txt
if grep -qiE "permission denied" /tmp/lt-err.txt; then
  ok "a signed-out visitor is refused the view, for a permission reason"
else
  bad "expected a permission refusal for anon on the view; got: $(head -c 200 /tmp/lt-err.txt | tr '\n' ' ')"
fi
# admin_is_member() checks `active`, so somebody switched off is not a member.
$PSQL -c "update public.admin_users set active=false where user_id='$OTHER';" >/dev/null
is "a member somebody switched off reads nothing — the log closes to them" \
  "$(as_val "$OTHER" "select count(*) from public.admin_lead_tags_now;")" "0"
$PSQL -c "update public.admin_users set active=true where user_id='$OTHER';" >/dev/null

# ==================================================================
# 6. WHOSE LEAD MAY A REP TAG (0020)
# ==================================================================
# 0018 deliberately left this rule out and pointed at 0020, so the whole
# row-level lock reads in one file. This is that rule, proved.
TAGGED_OWN="$(as_val "$REP" "with i as (insert into public.admin_lead_tag_events (lead_id, tag_id, action, source, by)
  values ('bbbbbbb1-0000-0000-0000-000000000001','$HOT_TAG','added','person','$REP') returning 1) select count(*) from i;")"
is "a rep CAN tag a lead they hold" "$TAGGED_OWN" "1"

TAGGED_FLOOR="$(as_val "$REP" "with i as (insert into public.admin_lead_tag_events (lead_id, tag_id, action, source, by)
  values ('bbbbbbb1-0000-0000-0000-000000000002','$HOT_TAG','added','person','$REP') returning 1) select count(*) from i;")"
is "a rep CAN tag a lead nobody holds — that is how the floor works" "$TAGGED_FLOOR" "1"

refuses "A REP CANNOT TAG ANOTHER REP'S LEAD" "$REP" \
  "insert into public.admin_lead_tag_events (lead_id, tag_id, action, source, by)
     values ('bbbbbbb1-0000-0000-0000-000000000003','$HOT_TAG','added','person','$REP');" \
  "row-level security|violates row-level"
is "...and nothing was written on that lead" \
  "$(val "select count(*) from public.admin_lead_tag_events where lead_id='bbbbbbb1-0000-0000-0000-000000000003';")" "0"

TAGGED_ADMIN="$(as_val "$OWNER" "with i as (insert into public.admin_lead_tag_events (lead_id, tag_id, action, source, by)
  values ('bbbbbbb1-0000-0000-0000-000000000003','$HOT_TAG','added','person','$OWNER') returning 1) select count(*) from i;")"
is "an owner CAN tag anybody's lead — that is their job" "$TAGGED_ADMIN" "1"

# `by = auth.uid() or by is null`, mirroring the activity-log policy in 0001. A
# rep filing "removed by hand — CJ" onto a record nobody can edit afterwards is
# the thing this stops.
refuses "A REP CANNOT FILE AN EVENT UNDER SOMEBODY ELSE'S NAME" "$REP" \
  "insert into public.admin_lead_tag_events (lead_id, tag_id, action, source, by)
     values ('bbbbbbb1-0000-0000-0000-000000000001','$QUIET_TAG','added','person','$OTHER');" \
  "row-level security|violates row-level"
SYSTEM_ROW="$(as_val "$REP" "with i as (insert into public.admin_lead_tag_events (lead_id, tag_id, action, source, by)
  values ('bbbbbbb1-0000-0000-0000-000000000001','$QUIET_TAG','added','auto',null) returning 1) select count(*) from i;")"
is "...but MAY file one as the system, with by null — a rule is not a person" "$SYSTEM_ROW" "1"
refuses "an owner cannot file an event under a rep's name either" "$OWNER" \
  "insert into public.admin_lead_tag_events (lead_id, tag_id, action, source, by)
     values ('bbbbbbb1-0000-0000-0000-000000000003','$QUIET_TAG','added','person','$REP');" \
  "row-level security|violates row-level"
refuses "somebody signed in who is not on the team cannot tag anything" "$STRANGER" \
  "insert into public.admin_lead_tag_events (lead_id, tag_id, action, source, by)
     values ('bbbbbbb1-0000-0000-0000-000000000002','$HOT_TAG','added','person','$STRANGER');" \
  "row-level security|violates row-level"

# ==================================================================
# 7. THE VOCABULARY IS AN ADMIN'S TO NAME
# ==================================================================
# "medspa", "med-spa" and "MedSpa" as three tags is a filter menu nobody can
# use, so naming a NEW tag type is an admin decision. Putting an EXISTING tag on
# a lead is ordinary rep work, and section 6 proved a rep can do that.
refuses "a rep CANNOT invent a new tag type" "$REP" \
  "insert into public.admin_lead_tags (slug, label) values ('medspa','Medspa');" \
  "row-level security|violates row-level"
is "an admin CAN" \
  "$(as_val "$OWNER" "with i as (insert into public.admin_lead_tags (slug, label, tag_group, sort) values ('medspa','Medspa','state',80) returning 1) select count(*) from i;")" "1"
# AN UPDATE THE POLICY REFUSES RAISES NOTHING — the `using` clause makes the row
# invisible, so the statement succeeds and changes nothing. Counting the rows is
# the only honest check; a refuses() here would pass whatever happened.
is "a rep's rename of a tag touches NO rows" \
  "$(as_val "$REP" "with u as (update public.admin_lead_tags set label = 'Mine now' where slug = 'hot' returning 1) select count(*) from u;")" "0"
is "...and the label really is unchanged" "$(valraw "select label from public.admin_lead_tags where slug='hot';")" "Replied"
is "every member can READ the vocabulary, or no filter menu renders" \
  "$(as_val "$REP" "select count(*) > 0 from public.admin_lead_tags;")" "t"
# Two tags with one slug is two filters that look like one.
refuses "a second tag cannot take a slug that is already used" "$OWNER" \
  "insert into public.admin_lead_tags (slug, label) values ('hot','Warm');" \
  "duplicate key|unique"
# A switched-off tag is never deleted, because the events pointing at it are
# records — and a deleted tag row would break the foreign key on them.
refuses "a tag with events against it cannot be deleted out from under them" "$OWNER" \
  "delete from public.admin_lead_tags where slug = 'hot';" \
  "foreign key|violates foreign"

# ==================================================================
# 8. AN EVENT CANNOT BE HALF A RECORD
# ==================================================================
refuses "an action that is not added or removed is refused" "$OWNER" \
  "insert into public.admin_lead_tag_events (lead_id, tag_id, action, source) values ('bbbbbbb1-0000-0000-0000-000000000001','$HOT_TAG','maybe','auto');" \
  "action_check|violates check"
refuses "a source nobody defined is refused" "$OWNER" \
  "insert into public.admin_lead_tag_events (lead_id, tag_id, action, source) values ('bbbbbbb1-0000-0000-0000-000000000001','$HOT_TAG','added','telepathy');" \
  "source_check|violates check"
refuses "an event pointing at a tag that does not exist is refused" "$OWNER" \
  "insert into public.admin_lead_tag_events (lead_id, tag_id, action, source) values ('bbbbbbb1-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000ff','added','auto');" \
  "foreign key|violates foreign"
refuses "an event with no lead is refused" "$OWNER" \
  "insert into public.admin_lead_tag_events (tag_id, action, source) values ('$HOT_TAG','added','auto');" \
  "null value|not-null"
# The events belong to the lead. Deleting a lead takes its tag history with it —
# there is nothing left for the history to be about.
$PSQL -c "insert into public.admin_leads (id, name, stage) values ('bbbbbbb1-0000-0000-0000-00000000000f','Doomed','new');" >/dev/null
$PSQL -c "insert into public.admin_lead_tag_events (lead_id, tag_id, action, source) values ('bbbbbbb1-0000-0000-0000-00000000000f','$HOT_TAG','added','auto');" >/dev/null
$PSQL -c "delete from public.admin_leads where id='bbbbbbb1-0000-0000-0000-00000000000f';" >/dev/null
is "deleting a lead cascades its tag events away" \
  "$(val "select count(*) from public.admin_lead_tag_events where lead_id='bbbbbbb1-0000-0000-0000-00000000000f';")" "0"
# `by` is SET NULL rather than cascading: the event is a record of something that
# happened and has to survive the person leaving. A leaver is used who holds no
# leads, because admin_leads.owner_id has no on-delete clause of its own.
$PSQL <<SQL >/dev/null
insert into auth.users (id, email) values ('55555555-5555-5555-5555-555555555555','leaver@x.com');
insert into public.admin_users (user_id, email, full_name, role, active)
  values ('55555555-5555-5555-5555-555555555555','leaver@x.com','Leaver L','sales',true);
insert into public.admin_lead_tag_events (id, lead_id, tag_id, action, source, by, why)
  values ('ffffff01-0000-0000-0000-0000000000ff','bbbbbbb1-0000-0000-0000-000000000002','$HOT_TAG','added','person','55555555-5555-5555-5555-555555555555','they replied');
SQL
$PSQL -c "delete from auth.users where id='55555555-5555-5555-5555-555555555555';" >/dev/null
is "a person leaving does NOT delete the events they filed" \
  "$(val "select count(*) from public.admin_lead_tag_events where id='ffffff01-0000-0000-0000-0000000000ff';")" "1"
is "...their name just goes blank, and the reason they typed stays" \
  "$(valraw "select coalesce(by::text,'<null>') || '|' || why from public.admin_lead_tag_events where id='ffffff01-0000-0000-0000-0000000000ff';")" "<null>|they replied"

echo ""
if [ "$fails" = "0" ]; then echo "  all database checks passed"; else echo "  $fails FAILED"; fi
exit $fails
