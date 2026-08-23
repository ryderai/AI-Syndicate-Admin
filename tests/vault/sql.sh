#!/usr/bin/env bash
# The database half of the Vault tests.
#
# Stands up a real Postgres 16, applies migrations 0001 → 0008 in order, then
# attacks the vault's rules from a signed-in session: can a person write a
# secret straight into the table, can a sales rep see anything, can an admin
# delete their way out of the reveal log.
#
# Reading the SQL and saying "that looks right" is not a test. This is.
#
# Skips itself with a message when there is no local Postgres, so
# tests/vault/run.sh stays runnable on any machine.
set -u
cd "$(dirname "$0")/../.."

PGBIN=""
for d in /usr/lib/postgresql/*/bin; do [ -x "$d/initdb" ] && PGBIN="$d"; done
if [ -z "$PGBIN" ]; then
  echo "  --   no local Postgres found; the SQL half of the vault tests was SKIPPED."
  echo "       (install postgresql-16 to run it, or read tests/vault/sql.sh to see what it checks)"
  exit 0
fi

DATA="$(mktemp -d)/pgdata"
SOCK="$(mktemp -d)"
mkdir -p "$DATA"

# initdb refuses to run as root, so everything runs as the postgres user.
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

# ------------------------------------------------------------------
# A mock of the bits of Supabase the migrations lean on.
# ------------------------------------------------------------------
$PSQL <<'SQL' >/dev/null
create extension if not exists pgcrypto;
create schema if not exists auth;
create table auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
do $$ begin
  create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin
  create role anon; exception when duplicate_object then null; end $$;
-- BYPASSRLS is what the real service key has: it ignores row-level security.
-- Without it here, the "server" in these tests would be weaker than the real
-- one and the guard tests would pass for the wrong reason.
do $$ begin
  create role service_role bypassrls; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to authenticated, anon, service_role;
grant select on auth.users to authenticated, service_role;
SQL

for f in supabase/migrations/0*.sql; do
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/mig.err; then
    echo "  FAIL migration $f did not apply:"; sed 's/^/       /' /tmp/mig.err; exit 1
  fi
done
# Supabase grants the service role table access as part of its own setup, so
# the mock has to as well — otherwise "the server can write a secret" fails on
# a missing grant and looks like the guard working.
$PSQL -c "grant all on all tables in schema public to service_role;" >/dev/null
echo "  ok   migrations 0001-0008 apply in order"

# Re-runnable? Applying 0008 twice must not break anything.
if $PSQL -f supabase/migrations/0008_vault_reports.sql >/dev/null 2>/tmp/mig.err; then
  echo "  ok   0008 can be run twice without breaking"
else
  echo "  FAIL 0008 is not re-runnable:"; sed 's/^/       /' /tmp/mig.err; exit 1
fi

# THE REDEPLOY TRAP. `create table if not exists` does not update a constraint
# on a table that already exists, so a value added to a CHECK after the first
# run would never take effect — and the vault's Remove button would fail for
# ever, because it writes a 'delete' log row before deleting.
$PSQL <<'SQL' >/dev/null
alter table public.admin_vault_reveals drop constraint if exists admin_vault_reveals_action_check;
alter table public.admin_vault_reveals add constraint admin_vault_reveals_action_check
  check (action in ('reveal', 'save', 'clear'));
SQL
if $PSQL -f supabase/migrations/0008_vault_reports.sql >/dev/null 2>/tmp/mig.err; then
  got=$(psql -h "$SOCK" -U postgres -t -A -c "insert into public.admin_vault_reveals (item_label, action) values ('x','delete') returning 1;" 2>&1 \
    | grep -Ev '^(INSERT|SET) ' | grep -Ev '^[[:space:]]*$' | head -1 | tr -d ' ')
  if [ "$got" = "1" ]; then
    echo "  ok   re-running 0008 updates the reveal-log CHECK on an existing table"
  else
    echo "  FAIL re-running 0008 left the old CHECK in place — Remove would fail for ever"; echo "       $got"; exit 1
  fi
  psql -h "$SOCK" -U postgres -q -c "delete from public.admin_vault_reveals where item_label = 'x';" >/dev/null
else
  echo "  FAIL 0008 would not re-apply over an older version:"; sed 's/^/       /' /tmp/mig.err; exit 1
fi

# ------------------------------------------------------------------
# People
# ------------------------------------------------------------------
$PSQL <<'SQL' >/dev/null
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@aisyndicate.com'),
  ('22222222-2222-2222-2222-222222222222', 'admin@aisyndicate.com'),
  ('33333333-3333-3333-3333-333333333333', 'rep@aisyndicate.com');
insert into public.admin_users (user_id, email, full_name, role, active) values
  ('11111111-1111-1111-1111-111111111111', 'owner@aisyndicate.com', 'Owner', 'owner', true),
  ('22222222-2222-2222-2222-222222222222', 'admin@aisyndicate.com', 'Admin', 'admin', true),
  ('33333333-3333-3333-3333-333333333333', 'rep@aisyndicate.com', 'Rep', 'sales', true);
insert into public.admin_clients (id, name) values
  ('44444444-4444-4444-4444-444444444444', 'Harbor Injury Law');
SQL

pass=0; fail=0
# Runs the SQL and looks at the LAST meaningful line of output. The last line
# matters because every statement is prefixed with "set role …", which prints
# SET — reading the FIRST line means every test passes or fails on the word SET
# and none of them test anything. (It did exactly that on the first run.)
# A `want` that starts with ERROR is matched as a prefix, because psql pads its
# error text and the point is which error, not its punctuation.
check() { # check <name> <sql> <expected>
  local name="$1" sql="$2" want="$3" out got
  out=$(psql -h "$SOCK" -U postgres -t -A -c "$sql" 2>&1)
  # Drop everything that is noise: the SET lines, psql's command tags
  # (INSERT 0 1), and the CONTEXT/DETAIL/HINT lines that follow an error. What
  # is left is the answer or the error itself. Getting this wrong is how a
  # suite passes 26 tests on the word "SET".
  got=$(printf '%s\n' "$out" \
    | grep -Ev '^(SET|BEGIN|COMMIT)$' \
    | grep -Ev '^(INSERT|UPDATE|DELETE|SELECT|CREATE|DROP|ALTER|GRANT) ' \
    | grep -Ev '^(CONTEXT|DETAIL|HINT|LINE|STATEMENT|QUERY|PL/pgSQL)' \
    | grep -Ev '^[[:space:]]*$' \
    | tail -1 | tr -d ' ')
  if [ "$got" = "$want" ] || { [ -n "$want" ] && case "$got" in "$want"*) true;; *) false;; esac; }; then
    echo "  ok   $name"; pass=$((pass+1))
  else
    echo "  FAIL $name"; echo "       wanted [$want], got [$got]"; fail=$((fail+1))
  fi
}

as_owner="set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111'; set request.jwt.claim.role = 'authenticated';"
as_admin="set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'; set request.jwt.claim.role = 'authenticated';"
as_rep="set role authenticated;   set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333'; set request.jwt.claim.role = 'authenticated';"
as_server="set role service_role;  set request.jwt.claim.role = 'service_role';"

# ------------------------------------------------------------------
# 1. Adding items
# ------------------------------------------------------------------
check "an admin can add a vault item" \
  "$as_admin insert into public.admin_vault_items (client_id, kind, label, username) values ('44444444-4444-4444-4444-444444444444','login','WordPress','ais') returning 1;" "1"

check "added_by is stamped from the signed-in user, not from the row" \
  "$as_admin insert into public.admin_vault_items (kind, label, added_by) values ('login','Stamped','11111111-1111-1111-1111-111111111111') returning added_by = '22222222-2222-2222-2222-222222222222';" "t"

check "a card with no last 4 is refused" \
  "$as_admin insert into public.admin_vault_items (kind, label) values ('card','No digits') returning 1;" "ERROR:newrow"

check "a card with last 4 is allowed" \
  "$as_admin insert into public.admin_vault_items (kind, label, card_last4) values ('card','Chase','4242') returning 1;" "1"

# ------------------------------------------------------------------
# 2. THE GUARD — only the server may write a secret
# ------------------------------------------------------------------
check "a signed-in admin CANNOT write a secret straight into the table" \
  "$as_admin insert into public.admin_vault_items (kind, label, secret_cipher) values ('login','Sneaky','v1.deadbeef.a.b.c') returning 1;" "ERROR:Thesecret"

check "a signed-in admin CANNOT update a secret onto an existing row" \
  "$as_admin update public.admin_vault_items set secret_cipher = 'v1.deadbeef.a.b.c' where label = 'WordPress' returning 1;" "ERROR:Thesecret"

check "a signed-in admin CANNOT fake secret_set_at to make an empty item look full" \
  "$as_admin update public.admin_vault_items set secret_set_at = now() where label = 'WordPress' returning 1;" "ERROR:Thesecret"

check "a signed-in admin CANNOT fake the stored field names either" \
  "$as_admin update public.admin_vault_items set secret_fields = array['password'] where label = 'WordPress' returning 1;" "ERROR:Thesecret"

# The claim on its own is a session setting anyone at a SQL prompt can assign.
# Before the role check was added, this one line walked straight past the guard.
check "SETTING the jwt role claim by hand does NOT get past the guard" \
  "$as_admin set request.jwt.claim.role = 'service_role'; update public.admin_vault_items set secret_cipher = 'PLAINTEXT-hunter2' where label = 'WordPress' returning 1;" "ERROR:Thesecret"

check "an authenticated insert claiming a secret is refused, not quietly reset" \
  "$as_admin insert into public.admin_vault_items (kind, label, secret_fields) values ('login','Claims a secret',array['password']) returning 1;" "ERROR:Thesecret"

check "an authenticated insert stamping secret_set_at is refused too" \
  "$as_admin insert into public.admin_vault_items (kind, label, secret_set_at) values ('login','Claims a date', now()) returning 1;" "ERROR:Thesecret"

check "the server CAN write a secret" \
  "$as_server update public.admin_vault_items set secret_cipher='v1.deadbeef.a.b.c', secret_fields=array['password'], secret_set_at=now() where label='WordPress' returning 1;" "1"

check "an admin can still edit the readable half of that same row" \
  "$as_admin update public.admin_vault_items set notes = 'Editor rights only' where label = 'WordPress' returning 1;" "1"

check "...and the secret survived that edit untouched" \
  "$as_admin select secret_cipher = 'v1.deadbeef.a.b.c' from public.admin_vault_items where label = 'WordPress';" "t"

# A card holding a number must not be turned into a login: a login has no
# "card number" to reveal, so the number would be stuck in the row forever
# while the card still read "CARD NUMBER SAVED".
$PSQL -c "$as_server update public.admin_vault_items set secret_cipher='v1.deadbeef.a.b.c', secret_fields=array['number'], secret_set_at=now() where label='Chase';" >/dev/null
check "a card holding a stored number cannot be turned into a login" \
  "$as_admin update public.admin_vault_items set kind = 'login' where label = 'Chase' returning 1;" "ERROR:Thisitem"

check "...but the kind CAN be changed once the secret is cleared" \
  "$as_server update public.admin_vault_items set secret_cipher=null, secret_fields='{}', secret_set_at=null where label='Chase'; $as_admin update public.admin_vault_items set kind='login', card_last4=null where label='Chase' returning 1;" "1"

# The card face must not drift away from the number sitting behind it.
$PSQL -c "$as_server update public.admin_vault_items set secret_cipher='v1.deadbeef.a.b.c', secret_fields=array['number'], secret_set_at=now() where label='Chase';" >/dev/null
check "the last 4 cannot be rewritten while a card number is stored" \
  "$as_admin update public.admin_vault_items set card_last4 = '9999' where label = 'Chase' returning 1;" "ERROR:Thelast4"

check "nor can the card company" \
  "$as_admin update public.admin_vault_items set card_brand = 'Visa' where label = 'Chase' returning 1;" "ERROR:Thelast4"

check "...but the rest of the card row still edits fine" \
  "$as_admin update public.admin_vault_items set notes = 'the subscriptions card' where label = 'Chase' returning 1;" "1"

# ------------------------------------------------------------------
# 3. Sales sees nothing
# ------------------------------------------------------------------
check "a sales rep sees zero vault items" \
  "$as_rep select count(*) from public.admin_vault_items;" "0"

check "a sales rep cannot add one" \
  "$as_rep insert into public.admin_vault_items (kind, label) values ('login','Rep sneaking in') returning 1;" "ERROR:newrow"

check "a sales rep cannot delete one" \
  "$as_rep delete from public.admin_vault_items where label = 'WordPress' returning 1;" ""

check "a sales rep sees zero rows of the reveal log" \
  "$as_rep select count(*) from public.admin_vault_reveals;" "0"

check "a sales rep sees zero client reports" \
  "$as_rep select count(*) from public.admin_client_reports;" "0"

# ------------------------------------------------------------------
# 4. The reveal log cannot be written or erased from inside the console
# ------------------------------------------------------------------
$PSQL -c "$as_server insert into public.admin_vault_reveals (item_id, item_label, actor, actor_email, action, fields) select id, label, '22222222-2222-2222-2222-222222222222', 'admin@aisyndicate.com', 'reveal', array['password'] from public.admin_vault_items where label = 'WordPress';" >/dev/null

check "an owner can READ the reveal log" \
  "$as_owner select count(*) from public.admin_vault_reveals;" "1"

check "an admin cannot ADD a line to the reveal log" \
  "$as_admin insert into public.admin_vault_reveals (item_label, action) values ('made up','reveal') returning 1;" "ERROR:permissiondenied"

check "an admin cannot DELETE a line from the reveal log" \
  "$as_admin delete from public.admin_vault_reveals returning 1;" "ERROR:permissiondenied"

check "an admin cannot EDIT a line in the reveal log" \
  "$as_admin update public.admin_vault_reveals set actor_email = 'someone.else@x.com' returning 1;" "ERROR:permissiondenied"

# Deleting the ITEM must not delete the record that somebody read it.
check "deleting the item leaves the log line standing, with its name" \
  "$as_admin delete from public.admin_vault_items where label = 'WordPress'; select item_label from public.admin_vault_reveals;" "WordPress"

check "...and the link is cleared rather than the row vanishing" \
  "$as_owner select item_id is null from public.admin_vault_reveals;" "t"

# The repair carried in 0008: 0006 dropped 'email' from the allowed reminder
# link types, which broke the Inbox reminder button and the report's follow-up
# count on every database built from these migrations.
check "a reminder can be linked to an email again" \
  "$as_admin insert into public.admin_reminders (owner_id, body, due_at, link_type, link_id) values ('22222222-2222-2222-2222-222222222222','chase it',now(),'email',gen_random_uuid()) returning 1;" "1"

check "...and 'note' still works, which is what 0006 was adding" \
  "$as_admin insert into public.admin_reminders (owner_id, body, due_at, link_type, link_id) values ('22222222-2222-2222-2222-222222222222','read it',now(),'note',gen_random_uuid()) returning 1;" "1"

# ------------------------------------------------------------------
# 5. Client reports
# ------------------------------------------------------------------
check "an admin can file a report" \
  "$as_admin insert into public.admin_client_reports (client_id, title, summary, body, source) values ('44444444-4444-4444-4444-444444444444','R','s','b','counted') returning 1;" "1"

check "a filed report cannot be edited afterwards — the history stays true" \
  "$as_admin update public.admin_client_reports set summary = 'rewritten' returning 1;" "ERROR:permissiondenied"

check "an admin can delete a report they filed by mistake" \
  "$as_admin delete from public.admin_client_reports returning 1;" "1"

# ------------------------------------------------------------------
# 6. Deleting a client takes its vault items with it
# ------------------------------------------------------------------
$PSQL -c "$as_admin insert into public.admin_vault_items (client_id, kind, label) values ('44444444-4444-4444-4444-444444444444','login','Goes with the client');" >/dev/null
check "removing a client removes its vault items" \
  "$as_admin delete from public.admin_clients where id = '44444444-4444-4444-4444-444444444444'; select count(*) from public.admin_vault_items where label = 'Goes with the client';" "0"

echo ""
echo "  $pass passed, $fail failed (database)"
[ "$fail" -eq 0 ] || exit 1
