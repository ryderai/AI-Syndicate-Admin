#!/usr/bin/env bash
# STARTING OVER — the only thing in this console that deletes in bulk.
#
# Ryder, Aug 25 2026: "when we actually start using the admin then i want to
# delete all that data and import the list fresh again."
#
# So this file's whole job is to prove the delete cannot take anything real:
#   · a contact who became a paying client
#   · a contact carrying a proposal that has gone out
#   · a contact somebody typed in by hand
#   · a contact somebody has actually worked in the console
#   · a firm that is a client, or that still has people at it
#
# And to prove the number on the screen is the number that goes: the dry run and
# the real run must agree exactly, every time. On Aug 22 the importer printed
# "412 rows dropped" and imported all 412, because the screen read one value and
# the write path read another. The same mistake here deletes somebody's work.
#
# Skips itself with a message when there is no local Postgres.
set -u
cd "$(dirname "$0")/../.."

PGBIN=""
for d in /usr/lib/postgresql/*/bin; do [ -x "$d/initdb" ] && PGBIN="$d"; done
if [ -z "$PGBIN" ]; then echo "  --   no local Postgres found; SKIPPED."; exit 0; fi

DATA="$(mktemp -d)/pgdata"; SOCK="$(mktemp -d)"; mkdir -p "$DATA"
RUNAS=""
if [ "$(id -u)" = "0" ]; then RUNAS="su postgres -s /bin/bash -c"; chown -R postgres "$(dirname "$DATA")" "$SOCK"; fi
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
  if ! $PSQL -f "$f" >/dev/null 2>/tmp/soerr.txt; then
    echo "  FAIL migration $f did not apply:"; sed 's/^/       /' /tmp/soerr.txt; exit 1
  fi
done
$PSQL -c "grant all on all tables in schema public to service_role;" >/dev/null
ok "every migration 0001-0016 applies in order"
if $PSQL -f supabase/migrations/0016_import_batches_and_start_over.sql >/dev/null 2>/tmp/soerr.txt; then
  ok "0016 can be run twice without breaking"
else
  bad "0016 is not re-runnable:"; sed 's/^/       /' /tmp/soerr.txt
fi

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
as_owner() { $PSQL -tAc "set local role authenticated; set local request.jwt.claim.sub = '$OWNER'; $1" | tail -n 1 | tr -d '[:space:]'; }
val()      { $PSQL -tAc "$1" | tail -n 1 | tr -d '[:space:]'; }
# NOT whitespace-stripped. The reasons this function returns are sentences a
# person reads ("they are a paying client"), and squashing the spaces out of
# them made a grep for the sentence quietly find nothing — a check that could
# only ever pass by accident.
as_owner_raw() { $PSQL -tAc "set local role authenticated; set local request.jwt.claim.sub = '$OWNER'; $1" | tail -n 1; }

# ------------------------------------------------------------------
# The fixture: ONE import of eight contacts at four firms, and one
# contact typed in by hand that happens to sit in the same list.
# ------------------------------------------------------------------
seed() {
# NOT >/dev/null on stderr, and CHECKED. The second call to this function used
# to fail half way — admin_brain_memory has a unique dedupe constraint, and the
# memory row from the first seed was still there — and because the whole thing
# is one heredoc under ON_ERROR_STOP, everything after that insert silently
# never ran. Section 4 was then asserting against a fixture that had no
# proposals, no activity and no client wiring, and the numbers it produced were
# nonsense that took a probe to explain. A fixture that fails quietly is worse
# than a test that fails loudly.
$PSQL <<'SQL' 2>/tmp/seederr.txt >/dev/null
delete from public.admin_brain_memory;
delete from public.admin_lead_activity;
delete from public.admin_proposals;
delete from public.admin_leads;
delete from public.admin_companies;
delete from public.admin_lead_lists;
delete from public.admin_clients;
delete from public.admin_import_batches;

insert into public.admin_import_batches (id, label, source_file, tabs, counts, created_by)
values ('ba000000-0000-0000-0000-000000000001','Outreach sheet','Sales Team Outreach Master List.xlsx',
        array['Luxury Agents','Medspas'], '{"rows":9}'::jsonb, '11111111-1111-1111-1111-111111111111');

insert into public.admin_lead_lists (id, name, sheet_tab, import_batch_id)
values ('11000000-0000-0000-0000-000000000001','Luxury Agents','Luxury Agents','ba000000-0000-0000-0000-000000000001');

insert into public.admin_companies (id, name, domain, import_batch_id) values
  ('c0000000-0000-0000-0000-000000000001','Harborline Realty','harborline.com','ba000000-0000-0000-0000-000000000001'),
  ('c0000000-0000-0000-0000-000000000002','Acme Serhant','acme.com','ba000000-0000-0000-0000-000000000001'),
  ('c0000000-0000-0000-0000-000000000003','Bright Coast Medspa','bright.com','ba000000-0000-0000-0000-000000000001'),
  ('c0000000-0000-0000-0000-000000000004','Mixed Firm','mixed.com','ba000000-0000-0000-0000-000000000001');

-- 1-3 plain imported rows nobody has touched   -> deletable
-- 4   became a client                          -> KEPT
-- 5   a proposal has gone out                  -> KEPT
-- 6   a rep logged a call in the console       -> KEPT
-- 7   typed in by hand                         -> KEPT
-- 8   imported, at the same firm as 7          -> deletable, but its firm stays
-- 9   imported, only an 'import' timeline row  -> deletable
insert into public.admin_leads (id, name, company_id, list_id, source, stage, import_batch_id) values
  ('1e000000-0000-0000-0000-000000000001','Plain One',  'c0000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000001','sheet','new','ba000000-0000-0000-0000-000000000001'),
  ('1e000000-0000-0000-0000-000000000002','Plain Two',  'c0000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000001','sheet','new','ba000000-0000-0000-0000-000000000001'),
  ('1e000000-0000-0000-0000-000000000003','Plain Three','c0000000-0000-0000-0000-000000000002','11000000-0000-0000-0000-000000000001','sheet','new','ba000000-0000-0000-0000-000000000001'),
  ('1e000000-0000-0000-0000-000000000004','Now A Client','c0000000-0000-0000-0000-000000000003','11000000-0000-0000-0000-000000000001','sheet','won','ba000000-0000-0000-0000-000000000001'),
  ('1e000000-0000-0000-0000-000000000005','Proposal Out','c0000000-0000-0000-0000-000000000002','11000000-0000-0000-0000-000000000001','sheet','proposal','ba000000-0000-0000-0000-000000000001'),
  ('1e000000-0000-0000-0000-000000000006','Been Worked', 'c0000000-0000-0000-0000-000000000002','11000000-0000-0000-0000-000000000001','sheet','contacted','ba000000-0000-0000-0000-000000000001'),
  ('1e000000-0000-0000-0000-000000000007','By Hand',     'c0000000-0000-0000-0000-000000000004','11000000-0000-0000-0000-000000000001','manual','new',null),
  ('1e000000-0000-0000-0000-000000000008','Same Firm',   'c0000000-0000-0000-0000-000000000004','11000000-0000-0000-0000-000000000001','sheet','new','ba000000-0000-0000-0000-000000000001'),
  ('1e000000-0000-0000-0000-000000000009','Import Note Only','c0000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000001','sheet','new','ba000000-0000-0000-0000-000000000001');

-- A firm that IS a client while none of its contacts is flagged. This is the
-- ordinary shape after 0015's backfill, which links a firm to a client by name
-- and deliberately flags nobody. Without it, the `co.client_id is null` guard on
-- company deletion could be removed with every test still green.
insert into public.admin_clients (id, name, origin) values ('c1000000-0000-0000-0000-000000000002','Acme Serhant','manual');
insert into public.admin_companies (id, name, domain, client_id, import_batch_id)
  values ('c0000000-0000-0000-0000-000000000005','Acme Client Firm','acmeclient.com','c1000000-0000-0000-0000-000000000002','ba000000-0000-0000-0000-000000000001');
insert into public.admin_leads (id, name, company_id, list_id, source, stage, import_batch_id)
  values ('1e000000-0000-0000-0000-000000000010','At A Client Firm','c0000000-0000-0000-0000-000000000005','11000000-0000-0000-0000-000000000001','sheet','new','ba000000-0000-0000-0000-000000000001');

-- A lead flagged became_customer with NO client_id. Pre-0015 rows look exactly
-- like this, and 0015's own header explains why the two halves are different
-- facts. Without it the `or coalesce(became_customer,false)` half of the client
-- guard could be deleted with every test still green.
insert into public.admin_leads (id, name, source, stage, became_customer, import_batch_id)
  values ('1e000000-0000-0000-0000-000000000011','Flagged No Link',  'sheet','won',true,'ba000000-0000-0000-0000-000000000001');

-- A firm built BY HAND, holding an imported contact. Its typed details are not
-- an import's to throw away.
insert into public.admin_companies (id, name, domain, import_batch_id)
  values ('c0000000-0000-0000-0000-000000000006','Hand Made Firm','handmade.com',null);
insert into public.admin_leads (id, name, company_id, list_id, source, stage, import_batch_id)
  values ('1e000000-0000-0000-0000-000000000012','In A Hand Made Firm','c0000000-0000-0000-0000-000000000006','11000000-0000-0000-0000-000000000001','sheet','new','ba000000-0000-0000-0000-000000000001');

-- A rep claimed this one and moved it to Meeting, typing the booking into the
-- status_change body. NOTHING of type call/email/text/linkedin/note exists on
-- it — which is why the old five-type guard deleted it and the dialog said it
-- was keeping nothing.
insert into public.admin_leads (id, name, source, stage, owner_id, import_batch_id)
  values ('1e000000-0000-0000-0000-000000000013','Claimed And Booked','sheet','meeting','22222222-2222-2222-2222-222222222222','ba000000-0000-0000-0000-000000000001');

-- A confirmed memory a person typed, hanging off an imported contact.
insert into public.admin_brain_memory (kind, subject, body, origin, lead_id)
  values ('gotcha','Plain One','Never call before 10am, ask for Marta not Dan.','person','1e000000-0000-0000-0000-000000000001');

-- The one that became a client, wired the way migration 0015 wires it.
insert into public.admin_clients (id, name, origin) values ('c1000000-0000-0000-0000-000000000001','Bright Coast Medspa','sales');
update public.admin_companies set client_id = 'c1000000-0000-0000-0000-000000000001' where id = 'c0000000-0000-0000-0000-000000000003';
update public.admin_leads set client_id = 'c1000000-0000-0000-0000-000000000001', became_customer = true where id = '1e000000-0000-0000-0000-000000000004';

insert into public.admin_proposals (lead_id, title, status) values
  ('1e000000-0000-0000-0000-000000000005','GEO package','sent');

insert into public.admin_lead_activity (lead_id, actor, type, body) values
  ('1e000000-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222','call','Spoke to them.'),
  -- every imported row gets ONE of these, and it must not protect anything
  ('1e000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','import','Imported from the outreach sheet, row 2.'),
  ('1e000000-0000-0000-0000-000000000009','11111111-1111-1111-1111-111111111111','import','Imported from the outreach sheet, row 10.'),
  ('1e000000-0000-0000-0000-000000000013','22222222-2222-2222-2222-222222222222','claim','Claimed by Rep R.'),
  ('1e000000-0000-0000-0000-000000000013','22222222-2222-2222-2222-222222222222','status_change','New → Meeting. Booked Thursday 2pm, they want the GEO package.');
SQL
  if [ -s /tmp/seederr.txt ]; then
    echo "  FAIL the fixture did not build:"; sed 's/^/       /' /tmp/seederr.txt; exit 1
  fi
  # Counted, not assumed. If the fixture is not the shape every assertion below
  # is written against, nothing after this point means anything.
  local n; n="$($PSQL -tAc 'select count(*) from public.admin_leads;' | tail -n 1 | tr -d '[:space:]')"
  if [ "$n" != "13" ]; then echo "  FAIL the fixture has $n contacts, not 13"; exit 1; fi
}
seed
ok "fixture: 13 contacts, 6 firms, 1 import — counted, and it rebuilds cleanly"

# ==================================================================
# 1. THE DRY RUN AND THE REAL RUN MUST AGREE
# ==================================================================
# Two reads of the same answer, on purpose. jsonb prints `"leads": 5` with a
# space, so the numbers are compared against the whitespace-stripped form; the
# REASONS are sentences and are compared against the raw one. Grepping a
# sentence in the stripped form finds nothing, every time, which is a check that
# can only pass by accident.
DRY="$(as_owner "select public.admin_clear_import('ba000000-0000-0000-0000-000000000001', null, false, true, null)::text;")"
DRY_RAW="$(as_owner_raw "select public.admin_clear_import('ba000000-0000-0000-0000-000000000001', null, false, true, null)::text;")"
is "the dry run says 7 contacts would go" "$(echo "$DRY" | grep -o '\"leads\":[0-9]*')" '"leads":7'
# THREE, not four. The hand-added contact carries no import batch, so a
# batch-scoped clear never even considers it — it is not "kept", it was never a
# candidate. Those are different facts and this number has to mean one of them.
is "...and it names how many of the batch it is refusing to touch" "$(echo "$DRY" | grep -o '\"kept_total\":[0-9]*')" '"kept_total":5'
is "...counted out of the 12 rows that batch actually holds" "$(echo "$DRY" | grep -o '\"considered\":[0-9]*')" '"considered":12'
is "...and it says WHY, in words, not just how many" "$(echo "$DRY_RAW" | grep -c 'they are a paying client')" "1"
is "the dry run changes nothing" "$(val "select count(*) from public.admin_leads;")" "13"

# Called TWICE in one transaction, which is exactly how the screen uses it:
# preview, then confirm. The temp tables must not collide.
TWICE="$($PSQL -tAc "set local role authenticated; set local request.jwt.claim.sub = '$OWNER';
  select public.admin_clear_import('ba000000-0000-0000-0000-000000000001', null, false, true);
  select public.admin_clear_import('ba000000-0000-0000-0000-000000000001', null, false, true, null)::text;" 2>&1 | tail -n 1 | tr -d '[:space:]')"
is "calling it twice in one transaction works" "$(echo "$TWICE" | grep -o '\"leads\":[0-9]*')" '"leads":7'

REAL="$(as_owner "select public.admin_clear_import('ba000000-0000-0000-0000-000000000001', null, false, false, null)::text;")"
is "the real run deletes exactly what the dry run promised" \
  "$(echo "$REAL" | grep -o '\"leads\":[0-9]*')" "$(echo "$DRY" | grep -o '\"leads\":[0-9]*')"
is "...firms too" "$(echo "$REAL" | grep -o '\"companies\":[0-9]*')" "$(echo "$DRY" | grep -o '\"companies\":[0-9]*')"
is "...and lists" "$(echo "$REAL" | grep -o '\"lists\":[0-9]*')" "$(echo "$DRY" | grep -o '\"lists\":[0-9]*')"

# ==================================================================
# 2. WHAT SURVIVED
# ==================================================================
is "6 contacts are left" "$(val "select count(*) from public.admin_leads;")" "6"
is "the paying client survived" "$(val "select count(*) from public.admin_leads where id='1e000000-0000-0000-0000-000000000004';")" "1"
is "the one with a proposal out survived" "$(val "select count(*) from public.admin_leads where id='1e000000-0000-0000-0000-000000000005';")" "1"
is "the one somebody logged a call on survived" "$(val "select count(*) from public.admin_leads where id='1e000000-0000-0000-0000-000000000006';")" "1"
is "the one typed in by hand survived" "$(val "select count(*) from public.admin_leads where id='1e000000-0000-0000-0000-000000000007';")" "1"
# The one that matters most: an imported row whose ONLY history is the import's
# own note must NOT be protected by it, or a clear-out deletes nothing at all.
is "an imported contact is NOT protected by its own import note" \
  "$(val "select count(*) from public.admin_leads where id='1e000000-0000-0000-0000-000000000009';")" "0"
is "the clients' own records are untouched" "$(val "select count(*) from public.admin_clients;")" "2"
is "the firm that is a client survived" \
  "$(val "select count(*) from public.admin_companies where id='c0000000-0000-0000-0000-000000000003';")" "1"
is "a firm still holding a hand-added contact survived" \
  "$(val "select count(*) from public.admin_companies where id='c0000000-0000-0000-0000-000000000004';")" "1"
is "...and that contact kept its firm" \
  "$(val "select company_id from public.admin_leads where id='1e000000-0000-0000-0000-000000000007';")" "c0000000-0000-0000-0000-000000000004"
is "an emptied firm was removed" \
  "$(val "select count(*) from public.admin_companies where id='c0000000-0000-0000-0000-000000000001';")" "0"
is "a list that still holds somebody was NOT removed" \
  "$(val "select count(*) from public.admin_lead_lists;")" "1"
is "the deleted contacts took their timelines with them" \
  "$(val "select count(*) from public.admin_lead_activity where lead_id='1e000000-0000-0000-0000-000000000001';")" "0"
is "the surviving contact kept its timeline" \
  "$(val "select count(*) from public.admin_lead_activity where lead_id='1e000000-0000-0000-0000-000000000006';")" "1"

# ==================================================================
# 2b. THE GUARANTEES THAT HAD NO TEST
# ==================================================================
# Each of these was proved removable by a reviewer: the guard could be deleted
# and all 44 checks still passed, because no fixture reached it.

# A firm that IS a client while none of its contacts carries the flag. That is
# the ordinary shape after 0015's backfill, which links a firm to a client by
# name and deliberately flags nobody.
is "a firm that is a client is never removed, even when its contacts are" \
  "$(val "select count(*) from public.admin_companies where id='c0000000-0000-0000-0000-000000000005';")" "1"
is "...and its imported contact still went" \
  "$(val "select count(*) from public.admin_leads where id='1e000000-0000-0000-0000-000000000010';")" "0"

# `became_customer` true with `client_id` NULL — every pre-0015 won deal.
is "a contact flagged as a customer with no client link is still refused" \
  "$(val "select count(*) from public.admin_leads where id='1e000000-0000-0000-0000-000000000011';")" "1"

# A rep claimed it and moved it to Meeting, typing the booking into the stage
# change. Nothing of type call/email/text/linkedin/note exists on it — which is
# exactly why the first version of this guard deleted it while the dialog said
# it was keeping nothing.
is "a claimed lead moved to Meeting is real work, and is kept" \
  "$(val "select count(*) from public.admin_leads where id='1e000000-0000-0000-0000-000000000013';")" "1"
is "...and the booking note written on the stage change survived with it" \
  "$(val "select count(*) from public.admin_lead_activity where lead_id='1e000000-0000-0000-0000-000000000013' and body like '%Thursday 2pm%';")" "1"

# A firm somebody BUILT, holding an imported contact. Its typed details and its
# site score are not an import's to throw away.
is "a firm built by hand is left standing, not deleted with the import" \
  "$(val "select count(*) from public.admin_companies where id='c0000000-0000-0000-0000-000000000006';")" "1"
is "...and the screen is told it was left standing with nobody at it" \
  "$(echo "$REAL" | grep -o '\"companies_kept\":[0-9]*')" '"companies_kept":2'

# A confirmed memory a person typed, hanging off a contact that was deleted.
# `admin_brain_memory.lead_id` was `on delete cascade`, so it used to be
# destroyed silently — counted by nothing, warned about by nothing.
is "a memory somebody typed outlives the contact it was about" \
  "$(val "select count(*) from public.admin_brain_memory where body like '%Marta%';")" "1"
is "...and it has simply lost its link" \
  "$(val "select (lead_id is null) from public.admin_brain_memory where body like '%Marta%';")" "t"

# ==================================================================
# 3. IT LEAVES A TRACE
# ==================================================================
is "the clear-out is on the activity log" \
  "$(val "select count(*) from public.admin_activity_log where kind='import_cleared';")" "1"
is "the import batch is marked cleared, not deleted" \
  "$(val "select (cleared_at is not null) from public.admin_import_batches where id='ba000000-0000-0000-0000-000000000001';")" "t"
is "...and the batch row itself is still there" \
  "$(val "select count(*) from public.admin_import_batches;")" "1"

# ==================================================================
# 4. SCOPE
# ==================================================================
seed
$PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$OWNER'; select public.admin_clear_import(null,null,false,true,null);" >/dev/null 2>/tmp/soerr.txt
if grep -q "nothing to clear" /tmp/soerr.txt; then ok "asking for nothing is refused, in plain words"; else bad "no scope was accepted; got: $(head -c 160 /tmp/soerr.txt)"; fi
$PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$OWNER'; select public.admin_clear_import('ba000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000001',false,true,null);" >/dev/null 2>/tmp/soerr.txt
if grep -q "one thing at a time" /tmp/soerr.txt; then ok "asking for two scopes at once is refused"; else bad "two scopes were accepted; got: $(head -c 160 /tmp/soerr.txt)"; fi

# EVERYTHING IMPORTED — the thing Ryder will actually press on go-live day.
ALL="$(as_owner "select public.admin_clear_import(null, null, true, true, null)::text;")"
is "'everything imported' finds the same 7" "$(echo "$ALL" | grep -o '\"leads\":[0-9]*')" '"leads":7'
# The source filter on the candidate list is defence in depth — the keep rules
# would refuse a hand-added contact anyway — so removing it changed no outcome
# and every test still passed. It IS observable here though: without it the
# hand-added contact becomes a candidate that is then kept, and both these
# numbers move by one. Pinned so the layer cannot be quietly removed.
is "...having considered only the 12 imported rows, not the hand-added one" \
  "$(echo "$ALL" | grep -o '\"considered\":[0-9]*')" '"considered":12'
is "...and refusing 5 of them" "$(echo "$ALL" | grep -o '\"kept_total\":[0-9]*')" '"kept_total":5'
as_owner "select public.admin_clear_import(null, null, true, false, null)::text;" >/dev/null
is "...and after it runs, only the 6 real ones are left" "$(val "select count(*) from public.admin_leads;")" "6"
is "...and nothing added by hand was touched" \
  "$(val "select count(*) from public.admin_leads where source='manual';")" "1"

# BY LIST.
seed
LIST="$(as_owner "select public.admin_clear_import(null, '11000000-0000-0000-0000-000000000001', false, true, null)::text;")"
LIST_RAW="$(as_owner_raw "select public.admin_clear_import(null, '11000000-0000-0000-0000-000000000001', false, true, null)::text;")"
# SEVEN, not the batch's seven-by-coincidence: the two rows that carry a batch
# but no list (the flagged-no-link one and the claimed-and-booked one) are out of
# a list scope entirely, and the hand-added row is in it and refused.
is "clearing one list finds 7" "$(echo "$LIST" | grep -o '\"leads\":[0-9]*')" '"leads":7'
# A LIST scope DOES see the hand-added contact sitting in it, and refuses it by
# name. This is the rule that stops "clear this list" meaning "clear this list".
is "...and a list scope sees all 11 rows in the list" "$(echo "$LIST" | grep -o '\"considered\":[0-9]*')" '"considered":11'
is "...refusing 4, including the one typed in by hand" "$(echo "$LIST" | grep -o '\"kept_total\":[0-9]*')" '"kept_total":4'
is "...and saying so in those words" "$(echo "$LIST_RAW" | grep -c 'added by hand, not imported')" "1"
as_owner "select public.admin_clear_import(null, '11000000-0000-0000-0000-000000000001', false, false, null)::text;" >/dev/null
is "...and after it runs the hand-added contact is still there" \
  "$(val "select count(*) from public.admin_leads where source='manual';")" "1"

# ==================================================================
# 5. WHO IS ALLOWED
# ==================================================================
# Re-seeded, because section 4 now performs a REAL delete. Without this the
# "nothing was deleted" check below was measuring the previous section's
# leftovers and would have passed with the permission guard removed.
seed
$PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$REP'; select public.admin_clear_import(null,null,true,true,null);" >/dev/null 2>/tmp/soerr.txt
if grep -qi "only an owner or admin" /tmp/soerr.txt; then ok "a sales rep cannot clear an import, even as a dry run"; else bad "a rep was allowed; got: $(head -c 160 /tmp/soerr.txt)"; fi
$PSQL -c "set local role anon; select public.admin_clear_import(null,null,true,false,null);" >/dev/null 2>/tmp/soerr.txt
if grep -qiE "only an owner or admin|permission denied" /tmp/soerr.txt; then ok "a signed-out visitor cannot clear anything"; else bad "anon was allowed; got: $(head -c 160 /tmp/soerr.txt)"; fi
is "and nothing was deleted by either attempt" "$(val "select count(*) from public.admin_leads;")" "13"

# ==================================================================
# 5b. THE PREVIEW AND THE DELETE ARE TWO TRANSACTIONS
# ==================================================================
# They are the same function, but not the same moment. A reviewer proved the
# gap: the preview said 1, another session inserted three rows, the delete took
# four, and the toast reported four while the button had said one. That is the
# Aug 22 failure — screen number != write number — moved from two code paths to
# two transactions. `p_expect_leads` closes it.
seed
BEFORE_N="$(val "select count(*) from public.admin_leads;")"
$PSQL -c "set local role authenticated; set local request.jwt.claim.sub = '$OWNER'; select public.admin_clear_import('ba000000-0000-0000-0000-000000000001',null,false,false,999);" >/dev/null 2>/tmp/soerr.txt
if grep -q "changed while you were looking at it" /tmp/soerr.txt; then
  ok "a delete whose count no longer matches the preview is REFUSED"
else
  bad "a stale count was accepted; got: $(head -c 200 /tmp/soerr.txt)"
fi
is "...and nothing at all was deleted" "$(val "select count(*) from public.admin_leads;")" "$BEFORE_N"
OKRUN="$(as_owner "select public.admin_clear_import('ba000000-0000-0000-0000-000000000001',null,false,false,7)::text;")"
is "...while the right count goes through" "$(echo "$OKRUN" | grep -o '\"leads\":[0-9]*')" '"leads":7'

# ==================================================================
# 6. AN EMPTY RUN IS NOT AN ERROR
# ==================================================================
EMPTY="$(as_owner "select public.admin_clear_import('ba000000-0000-0000-0000-000000000099', null, false, true, null)::text;")"
is "clearing an import that does not exist finds nothing, quietly" "$(echo "$EMPTY" | grep -o '\"leads\":[0-9]*')" '"leads":0'
is "...and says it considered nothing, rather than implying it looked" "$(echo "$EMPTY" | grep -o '\"considered\":[0-9]*')" '"considered":0'

# ==================================================================
# 7. WITHOUT 0016, IMPORTING MUST STILL WORK
# ==================================================================
# The importer stamps `import_batch_id` on leads, firms and lists, and those
# payloads go straight to .insert(). On a database WITHOUT this migration that
# column does not exist, and an unknown column fails the whole insert — so
# importing would break completely for anyone who has not run 0016.
#
# It does not, because the batch row is opened FIRST: with no
# admin_import_batches table that call fails, `batchId` stays null, and the
# spread adds nothing. The whole safety of that path rests on the table and the
# columns arriving together, which is what this checks.
NOCOL="$(val "select count(*) from information_schema.columns where table_name='admin_leads' and column_name='import_batch_id';")"
NOTBL="$(val "select count(*) from information_schema.tables where table_name='admin_import_batches';")"
is "the batch table and the batch column ship in the same migration" "$NOCOL$NOTBL" "11"

echo ""
if [ "$fails" = "0" ]; then echo "  all database checks passed"; else echo "  $fails FAILED"; fi
exit $fails
