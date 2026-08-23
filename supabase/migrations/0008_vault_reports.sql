-- AI Syndicate ADMIN console — the Vault, and saved client reports.
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Run 0001 through 0007 first.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--   * Re-runnable: every object is created with "if not exists" or dropped
--     and recreated.
--
-- WHAT THIS ADDS, IN PLAIN WORDS
--
--   admin_vault_items    — one row per saved login, card, key or secure note.
--                          The readable part (name, client, username, card
--                          brand and last 4) sits in normal columns. The secret
--                          part (password, full card number, security code)
--                          lives in ONE scrambled column and nowhere else.
--   admin_vault_reveals  — one row every time a person unscrambles a secret.
--                          Who, which item, which fields, when. Never the value.
--   admin_client_reports — one row per report someone generated about a client,
--                          with the exact counts it was written from. Append
--                          only: a new report never replaces an old one.
--
-- ============================================================
-- THE SECURITY POINT — read this before changing anything below
-- ============================================================
--
-- 1. THE SCRAMBLING KEY IS NOT IN THIS DATABASE. It lives in one Vercel
--    environment variable, VAULT_KEY, which only the server can read. So a
--    stolen copy of this database is a list of names and last-4s, not a list of
--    passwords. That is the entire reason secret_cipher is a text column of
--    gibberish instead of a password column.
--
-- 2. THE BROWSER CANNOT WRITE secret_cipher. A trigger below rejects any insert
--    or update that sets or changes it unless the request came in on the
--    service key (the server). Without that trigger, an admin could paste junk
--    over a ciphertext from the browser, or write a plaintext password into the
--    column and it would sit there in the clear looking encrypted.
--
-- 3. A CIPHERTEXT IS TIED TO ITS ROW. The server encrypts with the item's id
--    mixed in ("additional authenticated data"). Copy a ciphertext from the
--    Chase card row onto the Wells Fargo row in the SQL editor and the decrypt
--    fails loudly instead of revealing the wrong card under the wrong name.
--
-- 4. EVERY REVEAL IS WRITTEN DOWN, and the log cannot be edited or deleted by
--    anybody through this console — no update policy, no delete policy, and no
--    insert policy for a signed-in person either. Only the server writes it.
--
-- WHO CAN DO WHAT (Ryder's call, Aug 21 2026)
--   owner  → everything
--   admin  → everything, the same as an owner
--   sales  → nothing. Not the page, not the list, not the count, not the log.
--
-- Note this is deliberately looser than admin_platform_accounts (0005), where
-- delete is owners-only. Ryder chose "owners and admins, everything the same"
-- for the vault. The reveal log is what keeps that honest: an admin can delete
-- an item, but cannot erase the record of having read it, because the log rows
-- survive the item on purpose (item_id is set to null, the label is kept).

-- ============================================================
-- 1. THE VAULT ITEMS
-- ============================================================

create table if not exists public.admin_vault_items (
  id uuid primary key default gen_random_uuid(),

  -- null = ours (AI Syndicate's own account). Otherwise the client it belongs
  -- to. Deleting a client takes its vault items with it.
  client_id uuid references public.admin_clients on delete cascade,

  kind text not null default 'login'
    check (kind in ('login', 'card', 'api_key', 'note')),

  label text not null,                        -- "GoDaddy", "Chase business card"
  description text,                           -- what it is for, in plain words

  -- LOGIN fields (readable — these are not the secret)
  username text,                              -- the login name or email
  url text,                                   -- where you sign in

  -- CARD fields (readable — these are NOT the full number)
  card_brand text,                            -- Visa / Mastercard / Amex / ...
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  card_exp_month int check (card_exp_month is null or (card_exp_month between 1 and 12)),
  card_exp_year int check (card_exp_year is null or (card_exp_year between 2000 and 2100)),
  card_holder text,                           -- name printed on the card
  card_zip text,                              -- billing postcode (asked for at checkout)

  -- THE SECRET. One scrambled blob for every type: password, one-time-code
  -- seed, full card number, security code, PIN, API key, private note.
  -- Written ONLY by /api/vault-secret, on the server, with VAULT_KEY.
  -- Format: v1.<key fingerprint>.<iv>.<tag>.<ciphertext>, all base64url.
  secret_cipher text,
  secret_set_at timestamptz,                  -- when the secret was last written
  secret_by uuid references auth.users on delete set null,
  -- Which fields are inside the blob, e.g. {password} or {number,cvv}. Names
  -- only — this is what lets the card show "security code saved" without
  -- unscrambling anything.
  secret_fields text[] not null default '{}',

  vault_url text,                             -- Bitwarden link. Bitwarden stays the master copy.
  notes text,                                 -- anything else worth knowing. Not the password.
  tags text[] not null default '{}',

  favorite boolean not null default false,
  active boolean not null default true,       -- false = retired, kept for the record
  sort int not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Stamped by a trigger from the signed-in user and frozen afterwards. A
  -- column that says who added it, that the adder can rewrite, records nothing.
  added_by uuid references auth.users on delete set null default auth.uid(),

  -- A card row with no last 4 is a card nobody can tell apart in a list.
  constraint admin_vault_card_needs_last4
    check (kind <> 'card' or card_last4 is not null)
);

comment on table public.admin_vault_items is
  'Passwords, cards and keys. The readable half is in columns; the secret half is in secret_cipher, scrambled with VAULT_KEY which lives only on the server.';
comment on column public.admin_vault_items.secret_cipher is
  'AES-256-GCM, written only by /api/vault-secret. Never readable without VAULT_KEY. A trigger blocks the browser from writing this column.';
comment on column public.admin_vault_items.card_last4 is
  'The last four digits only. The full number lives inside secret_cipher.';
comment on column public.admin_vault_items.vault_url is
  'Bitwarden link. Bitwarden remains the master copy; this console is the index everyone can see.';

create index if not exists admin_vault_items_client_idx
  on public.admin_vault_items (client_id, sort, created_at);
create index if not exists admin_vault_items_kind_idx
  on public.admin_vault_items (kind, active);

drop trigger if exists admin_vault_items_updated_at on public.admin_vault_items;
create trigger admin_vault_items_updated_at before update on public.admin_vault_items
  for each row execute function public.admin_set_updated_at();

-- ------------------------------------------------------------
-- added_by: stamped on insert, frozen on update
-- ------------------------------------------------------------
create or replace function public.admin_vault_stamp_adder()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    new.added_by := coalesce(auth.uid(), new.added_by);
  else
    new.added_by := old.added_by;
  end if;
  return new;
end;
$$;

drop trigger if exists admin_vault_items_adder on public.admin_vault_items;
create trigger admin_vault_items_adder before insert or update on public.admin_vault_items
  for each row execute function public.admin_vault_stamp_adder();

-- ------------------------------------------------------------
-- THE GUARD: only the server may write the secret
-- ------------------------------------------------------------
-- TWO things have to be true, not one.
--
--   1. the database ROLE is service_role (SET ROLE, which PostgREST does for a
--      service-key request and which a signed-in person cannot do), AND
--   2. the JWT claim says service_role.
--
-- Checking only the claim was wrong, and a reviewer proved it: the claim is an
-- ordinary session setting, so `set request.jwt.claim.role='service_role'`
-- inside a normal session walked straight past the guard. PostgREST will not
-- relay an arbitrary setting from a browser, so it was never reachable from the
-- console — but it made the promise below false for anyone at a SQL prompt.
--
-- BE HONEST ABOUT THE LIMIT: a database SUPERUSER (the Supabase SQL editor runs
-- as one) can turn this trigger off and write whatever it likes. No trigger can
-- stop the owner of the database. What this DOES stop is every signed-in
-- console user, and every path the application itself can take.
--
-- It RAISES rather than silently ignoring the change. A guard whose failure
-- mode is silence is not a guard: quietly dropping the write would show
-- "Saved" over a secret that was never stored.
create or replace function public.admin_vault_request_role()
returns text
language plpgsql
stable
as $$
declare
  claims text;
  r text;
begin
  -- The single claim is set on newer PostgREST; the whole claims blob on older.
  r := nullif(current_setting('request.jwt.claim.role', true), '');
  if r is null then
    claims := nullif(current_setting('request.jwt.claims', true), '');
    if claims is not null then
      begin
        r := claims::json ->> 'role';
      exception when others then
        r := null;
      end;
    end if;
  end if;
  return coalesce(r, '');
end;
$$;

-- Is this request really the server? The claim ALONE is not enough — it is an
-- ordinary session setting anyone at a SQL prompt can assign. The current
-- database role is the half that cannot be faked from a PostgREST session.
create or replace function public.admin_vault_is_server()
returns boolean
language plpgsql
stable
as $$
begin
  return current_user = 'service_role'
     and public.admin_vault_request_role() = 'service_role';
end;
$$;

/* NOT security definer, deliberately. Inside a SECURITY DEFINER function
 * current_user is the function's OWNER, not the caller — so the role half of
 * the check would read 'postgres' for everybody and the guard would refuse the
 * real server as well. This function needs no extra privilege: it only inspects
 * the row and raises. */
create or replace function public.admin_vault_secret_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  is_server boolean := public.admin_vault_is_server();
begin
  if is_server then
    return new;
  end if;

  if (tg_op = 'INSERT') then
    if new.secret_cipher is not null then
      raise exception 'The secret has to be saved through the console, not written straight into the table. Add the item first, then press Save on the secret.'
        using errcode = 'check_violation';
    end if;
    /* Claiming a secret that is not there is its own lie: the list would read
     * "PASSWORD SAVED" over an empty row. This used to reset the three columns
     * quietly, which is the silent failure this file elsewhere argues against —
     * so it raises now, and says which fields to drop. */
    if new.secret_fields is not null and array_length(new.secret_fields, 1) > 0 then
      raise exception 'The secret has to be saved through the console. Add the item without secret_fields, then press Save on the secret.'
        using errcode = 'check_violation';
    end if;
    if new.secret_set_at is not null or new.secret_by is not null then
      raise exception 'The secret has to be saved through the console. secret_set_at and secret_by are stamped there, not typed in.'
        using errcode = 'check_violation';
    end if;
  else
    if (new.secret_cipher is distinct from old.secret_cipher)
       or (new.secret_fields is distinct from old.secret_fields)
       or (new.secret_set_at is distinct from old.secret_set_at)
       or (new.secret_by is distinct from old.secret_by) then
      raise exception 'The secret can only be changed through the console (/api/vault-secret), which is the only place that can scramble it.'
        using errcode = 'check_violation';
    end if;

    /* THE CARD FACE, when a number is stored. The last 4 and the brand are
     * worked out from the number by /api/vault-secret; letting anything else
     * write them means the list can point at a card that is not the one behind
     * it. The modal already disables both boxes — this is the half that also
     * holds for a future code path, and for the SQL editor. */
    if (old.secret_cipher is not null
        and old.secret_fields @> array['number']
        and ((new.card_last4 is distinct from old.card_last4)
             or (new.card_brand is distinct from old.card_brand))) then
      raise exception 'The last 4 digits and the card company are read from the stored card number. Change the number to change them.'
        using errcode = 'check_violation';
    end if;

    /* The KIND decides which secret fields the item can hold. Change a card
     * that holds {number, cvv} into a login and the reveal buttons vanish —
     * a login has no "card number" to show — while the card still reads
     * "CARD NUMBER SAVED". The number becomes unreachable through every path
     * in the console, and the last 4 that identified it is wiped on the way
     * out. So: clear the secret first, then change what kind of thing it is. */
    if new.kind is distinct from old.kind and old.secret_cipher is not null then
      raise exception 'This item holds a stored secret, so its kind cannot be changed. Remove what is stored first, then change it.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists admin_vault_items_secret_guard on public.admin_vault_items;
create trigger admin_vault_items_secret_guard before insert or update on public.admin_vault_items
  for each row execute function public.admin_vault_secret_guard();

-- ============================================================
-- 2. THE REVEAL LOG
-- ============================================================
-- One row per unscramble. It outlives the item on purpose: item_id goes null
-- when an item is deleted, and item_label keeps the name, so deleting an item
-- cannot erase the record that somebody read it.

create table if not exists public.admin_vault_reveals (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.admin_vault_items on delete set null,
  item_label text not null,                   -- kept so a deleted item still reads
  client_id uuid references public.admin_clients on delete set null,
  actor uuid references auth.users on delete set null,
  actor_email text,                           -- kept for the same reason
  action text not null default 'reveal',   -- the allowed values are set below,
                                           -- as an ALTER, so a re-run updates them
  fields text[] not null default '{}',        -- WHICH fields. Never the values.
  created_at timestamptz not null default now()
);

comment on table public.admin_vault_reveals is
  'Who unscrambled which secret, and when. Field NAMES only — no value from the vault is ever written here.';

/* `create table if not exists` does NOT update a constraint on a table that is
 * already there. 'delete' and 'copy' were added to this list after the first
 * version of 0008 had already been run on the real project, so re-running the
 * file left the OLD constraint in place — and every press of Remove failed,
 * because the endpoint writes its log row before deleting and the log row was
 * refused. Re-stated explicitly so a redeploy actually applies it.
 * Caught by a reviewer, Aug 21 2026. */
alter table public.admin_vault_reveals
  drop constraint if exists admin_vault_reveals_action_check;
alter table public.admin_vault_reveals
  add constraint admin_vault_reveals_action_check
  check (action in ('reveal', 'copy', 'save', 'clear', 'delete', 'delete_failed'));

create index if not exists admin_vault_reveals_item_idx
  on public.admin_vault_reveals (item_id, created_at desc);
create index if not exists admin_vault_reveals_actor_idx
  on public.admin_vault_reveals (actor, created_at desc);

-- ============================================================
-- 3. SAVED CLIENT REPORTS
-- ============================================================
-- Every "Generate report" press writes a new row. Nothing is ever overwritten,
-- so the history of what we told ourselves about a client is readable in order.

create table if not exists public.admin_client_reports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.admin_clients on delete cascade,

  instruction text,                           -- exactly what the person typed
  preset text,                                -- which button they started from, if any

  title text not null default 'Client report',
  summary text not null default '',           -- the 30-second version
  body text not null default '',              -- the full version
  cannot_check text,                          -- what the records could not answer

  -- 'written' = the AI worded it from the counts. 'counted' = plain code did,
  -- because there is no AI key or the AI's answer failed the check.
  source text not null default 'counted'
    check (source in ('written', 'counted')),
  rejected_why text,                          -- why an AI draft was thrown away

  facts jsonb,                                -- the exact counts it was built from
  counts_at timestamptz,                      -- the moment those counts were taken

  created_by uuid references auth.users on delete set null default auth.uid(),
  created_by_email text,
  created_at timestamptz not null default now()
);

comment on table public.admin_client_reports is
  'Append only. One row per generated report, with the counts it was written from stored beside it.';

create index if not exists admin_client_reports_client_idx
  on public.admin_client_reports (client_id, created_at desc);

-- ============================================================
-- 3b. A REPAIR THAT BELONGS HERE — admin_reminders.link_type
-- ============================================================
-- Not part of the vault. Fixed here because this is the next migration and the
-- report's follow-up count is wrong until it is fixed.
--
-- 0003_inbox.sql set the allowed link types to
--   ('client','lead','task','ticket','email')
-- and 0006_brain_notes_leads.sql dropped and re-added the constraint as
--   ('client','lead','task','ticket','note')
-- — 'note' was added and 'email' was lost in the same statement. Since then any
-- insert with link_type = 'email' has been refused by the database, which means
-- the Inbox's "Remind me" button has failed on every press, and
-- /api/client-report's follow-up query can never match a row.
--
-- Found by a reviewer against a real Postgres, Aug 21 2026.

alter table public.admin_reminders
  drop constraint if exists admin_reminders_link_type_check;
alter table public.admin_reminders
  add constraint admin_reminders_link_type_check
  check (link_type is null or link_type in ('client', 'lead', 'task', 'ticket', 'note', 'email'));

-- ============================================================
-- 4. GRANTS + ROW LEVEL SECURITY
-- ============================================================

-- ---- vault items: owners and admins, everything the same ----
grant select, insert, update, delete on public.admin_vault_items to authenticated;
alter table public.admin_vault_items enable row level security;

drop policy if exists "admins read vault" on public.admin_vault_items;
create policy "admins read vault" on public.admin_vault_items
  for select using (public.admin_is_admin());

drop policy if exists "admins add vault" on public.admin_vault_items;
create policy "admins add vault" on public.admin_vault_items
  for insert with check (public.admin_is_admin());

drop policy if exists "admins edit vault" on public.admin_vault_items;
create policy "admins edit vault" on public.admin_vault_items
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());

drop policy if exists "admins remove vault" on public.admin_vault_items;
create policy "admins remove vault" on public.admin_vault_items
  for delete using (public.admin_is_admin());

-- ---- the reveal log: readable by owners and admins, written by nobody ----
-- No insert, update or delete policy for `authenticated` on purpose. Only the
-- server (service key, which ignores row-level security) writes this table.
-- Nobody can edit their way out of the log from inside the console.
grant select on public.admin_vault_reveals to authenticated;
alter table public.admin_vault_reveals enable row level security;

drop policy if exists "admins read vault log" on public.admin_vault_reveals;
create policy "admins read vault log" on public.admin_vault_reveals
  for select using (public.admin_is_admin());

-- ---- client reports: owners and admins ----
-- Update is never granted at all: a report is a record of what we said at a
-- moment, and editing one in place would make the history a lie. Delete IS
-- granted, so a mistaken press can be cleared away.
grant select, insert, delete on public.admin_client_reports to authenticated;
alter table public.admin_client_reports enable row level security;

drop policy if exists "admins read client reports" on public.admin_client_reports;
create policy "admins read client reports" on public.admin_client_reports
  for select using (public.admin_is_admin());

drop policy if exists "admins add client reports" on public.admin_client_reports;
create policy "admins add client reports" on public.admin_client_reports
  for insert with check (public.admin_is_admin());

drop policy if exists "admins remove client reports" on public.admin_client_reports;
create policy "admins remove client reports" on public.admin_client_reports
  for delete using (public.admin_is_admin());
