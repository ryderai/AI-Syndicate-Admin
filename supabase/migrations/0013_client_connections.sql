-- AI Syndicate ADMIN console — the client's own accounts, connected.
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Run 0001 through 0012 first.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--
-- WHAT THIS IS FOR, IN PLAIN WORDS
--
-- Every client already has websites, logins and reports in this console. What
-- it did NOT have was a way to read their real numbers. So a report could say
-- what WE did and never what actually HAPPENED — no clicks, no calls, no
-- searches, no map views. Every one of those numbers lives in an account the
-- client already owns:
--
--   GSC  — Google Search Console: how many times their site showed up in
--          Google and how many people clicked it.
--   GBP  — Google Business Profile: the map listing. Calls, direction taps,
--          website taps, and how people found them.
--   GA4  — Google Analytics 4: what people did once they were on the site.
--   Bing — Bing Webmaster Tools: the same idea as GSC, for Bing and Copilot.
--
-- This adds two tables:
--
--   1. admin_client_connections — one row per account we are connected to.
--      For a Google account the row holds a refresh token, which is a long
--      pass that lets the console ask Google for fresh numbers without anybody
--      logging in again.
--
--   2. admin_connection_snapshots — the numbers we actually read, with the
--      date we read them and the exact dates they cover. A report quotes a
--      SNAPSHOT, never a live call, so the same report always shows the same
--      numbers and anybody can check them months later.
--
-- THE REFRESH TOKEN IS SCRAMBLED, exactly like a vault password: the database
-- holds gibberish, and the key (VAULT_KEY) lives only in Vercel. Whoever gets
-- a copy of this table gets no access to a single client account.

-- ============================================================
-- 1. THE CONNECTIONS
-- ============================================================

create table if not exists public.admin_client_connections (
  id uuid primary key default gen_random_uuid(),

  -- Always belongs to a client. Delete the client, the connection goes too.
  client_id uuid not null references public.admin_clients on delete cascade,

  -- Which service. Keep this list in step with PROVIDERS in lib/connectors.js;
  -- tests/connectors reads both and fails if they drift.
  provider text not null
    check (provider in ('gsc','gbp','ga4','bing','other')),

  -- How we get in. 'google' = we hold a refresh token and can read by ourselves.
  -- 'manual' = nobody has connected it; a person types the numbers in, or it is
  -- only a note of where the account lives.
  auth_kind text not null default 'manual'
    check (auth_kind in ('google','manual')),

  label text not null,                    -- "Shiner Law — Search Console"
  account_email text,                     -- the Google account that granted it

  -- The exact thing chosen inside that account. One connection = one property,
  -- because a Google login can see twenty sites and a report about "the site"
  -- must say WHICH.
  --   gsc  → sc-domain:example.com  or  https://example.com/
  --   ga4  → properties/123456789
  --   gbp  → locations/1234567890  (and accounts/… in meta)
  property text,
  property_label text,                    -- what to call it on screen

  -- The scrambled sign-in does NOT live on this row. It lives in
  -- admin_connection_secrets below, a table no signed-in browser has any
  -- permission on at all. See the long note above that table for why a
  -- column on this row would not have been good enough.
  scope text,                             -- what Google actually granted (not a secret)

  status text not null default 'manual'
    check (status in ('manual','connected','needs_reconnect','error')),

  last_synced_at timestamptz,
  last_error text,
  meta jsonb not null default '{}'::jsonb, -- account ids, site lists, notes
  notes text,

  active boolean not null default true,
  sort int not null default 0,

  connected_at timestamptz,
  connected_by uuid references auth.users on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  added_by uuid references auth.users on delete set null default auth.uid()
);

comment on table public.admin_client_connections is
  'One row per client account we can read numbers out of (Search Console, Business Profile, Analytics, Bing).';
comment on column public.admin_client_connections.property is
  'The one property this row reads. gsc: sc-domain:example.com. ga4: properties/123. gbp: locations/123.';

-- One connection per client per provider per PROPERTY. Connect the same
-- Search Console site twice and the second press updates the first row
-- instead of quietly making a duplicate that reports twice.
--
-- ROWS WITH NO PROPERTY YET ARE EXEMPT. That is what the WHERE does. A card
-- can exist before anybody has chosen which site it reads — a typed-in Bing
-- card, or a Google sign-in that came back before the person picked a
-- property — and a client with two shop locations needs two of them at once.
-- Keying those on an empty string made the second one fail with a database
-- error about a constraint, under a message telling the person to change a
-- property neither card had.
create unique index if not exists admin_client_connections_one_per_property
  on public.admin_client_connections (client_id, provider, property)
  where property is not null and property <> '';

create index if not exists admin_client_connections_client_idx
  on public.admin_client_connections (client_id, sort, created_at);

drop trigger if exists admin_client_connections_updated_at on public.admin_client_connections;
create trigger admin_client_connections_updated_at before update on public.admin_client_connections
  for each row execute function public.admin_set_updated_at();

-- Same rule as the platform login cards (0005): who added it is stamped from
-- the signed-in user and can never be rewritten afterwards.
create or replace function public.admin_client_connections_stamp_adder()
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

drop trigger if exists admin_client_connections_adder on public.admin_client_connections;
create trigger admin_client_connections_adder before insert or update on public.admin_client_connections
  for each row execute function public.admin_client_connections_stamp_adder();

-- ============================================================
-- 1a. WHERE THE SIGN-IN ITSELF LIVES
-- ============================================================
-- A separate table, with NO permissions granted to anybody who signs in to the
-- console. Not a column on the row above. The reason is worth writing down,
-- because the first version of this migration got it wrong:
--
--   Taking a permission away from ONE COLUMN does not work in PostgreSQL when
--   the whole table has already been granted. `grant select on t to r` covers
--   every column, and a later `revoke select (c) on t from r` does not carve
--   the column back out. Supabase also grants `authenticated` everything on a
--   new table in the public schema by default. So a column here would have
--   been readable — and writable — by any signed-in admin's browser, and by
--   anything that got hold of a session token.
--
--   It is only ever gibberish (scrambled with VAULT_KEY, which lives on the
--   server), so reading it would not by itself open a client's account. That
--   is not a reason to hand it out.
--
-- Only the service role reaches this table, and the service role runs on the
-- server only. Row level security is on with NO policies at all, which is a
-- deliberate belt-and-braces: even if a grant were added by mistake later,
-- every row would still be invisible.

create table if not exists public.admin_connection_secrets (
  connection_id uuid primary key
    references public.admin_client_connections on delete cascade,

  -- AES-256-GCM, from lib/vault-crypto.js, tied to the connection id.
  -- A blob copied onto another row in the SQL editor fails to unscramble
  -- rather than quietly opening the wrong client's account.
  refresh_token_enc text not null,

  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users on delete set null
);

comment on table public.admin_connection_secrets is
  'The scrambled Google sign-in for each connection. Service role only — no signed-in browser has any permission on this table.';

-- Nothing granted, and anything Supabase granted by default taken back.
revoke all on public.admin_connection_secrets from authenticated;
revoke all on public.admin_connection_secrets from anon;

alter table public.admin_connection_secrets enable row level security;
-- No policies, on purpose. See the note above.

-- ============================================================
-- 1b. THE SIGN-IN HAND-OFF NEEDS TO REMEMBER WHO IT IS FOR
-- ============================================================
-- admin_oauth_states already carries a one-time `state` string through a
-- Google sign-in (0001, built for Gmail). A client connection also has to
-- remember WHICH client and WHICH service the person pressed Connect on —
-- and that must not travel in the address bar, where anybody could edit it
-- and attach an account to the wrong client's record.

alter table public.admin_oauth_states
  add column if not exists payload jsonb;

comment on column public.admin_oauth_states.payload is
  'What the sign-in is for — { clientId, provider }. Kept here, never in the address bar, so the browser cannot change it mid-flow.';

-- ============================================================
-- 2. THE NUMBERS WE READ
-- ============================================================
-- One row per read. Never overwritten: last month's snapshot is what last
-- month's report was written from, and rewriting it would make that report
-- unprovable. Old rows are history, not clutter.

create table if not exists public.admin_connection_snapshots (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references public.admin_client_connections on delete set null,

  -- Kept even when the connection row is deleted, so a report written in March
  -- can still be checked in September. This is why connection_id is nullable
  -- and client_id is not.
  client_id uuid not null references public.admin_clients on delete cascade,
  provider text not null,
  -- NOT NULL with an empty default, unlike the connection row's nullable one.
  -- The uniqueness rule below has to be a plain list of columns for the server
  -- to be able to say "replace the row that matches these" — and a NULL never
  -- matches a NULL, so a nullable property would let the same read pile up all
  -- day. Empty string means "this provider has no property of its own".
  property text not null default '',

  -- The dates the numbers COVER — not the date we asked.
  period_start date not null,
  period_end date not null,

  -- When we asked. This is the date a report must print next to the numbers.
  taken_at timestamptz not null default now(),
  -- The same moment as a plain day, written by whoever inserts the row.
  -- It exists because "one read per window per day" has to be enforced by the
  -- database, and a day cannot be worked out from taken_at inside an index:
  -- turning a timestamp into a date depends on the time zone, and Postgres
  -- refuses to index anything whose answer can change.
  taken_on date not null default ((now() at time zone 'utc')::date),
  taken_by uuid references auth.users on delete set null,

  -- 'api' = read straight out of the client's account. 'manual' = a person
  -- typed it in. A report has to say which, so the two can never be blended.
  source text not null default 'api'
    check (source in ('api','manual')),

  -- The counted numbers, already normalised by lib/connector-fetch.js.
  metrics jsonb not null default '{}'::jsonb,
  -- The short plain-words lists (top searches, top pages). Capped when written.
  detail jsonb not null default '{}'::jsonb,

  note text,
  created_at timestamptz not null default now()
);

comment on table public.admin_connection_snapshots is
  'Numbers read out of a client account on a date. Append only in practice: a report quotes a snapshot, so rewriting one makes that report uncheckable.';
comment on column public.admin_connection_snapshots.source is
  'api = read from the account. manual = typed by a person. Never blend the two in a report.';

create index if not exists admin_connection_snapshots_client_idx
  on public.admin_connection_snapshots (client_id, provider, period_end desc, taken_at desc);

create index if not exists admin_connection_snapshots_conn_idx
  on public.admin_connection_snapshots (connection_id, taken_at desc);

-- A second read of the same window on the same day replaces the first rather
-- than piling up. Different windows, or a read on another day, are new rows.
--
-- PLAIN COLUMNS ONLY. The server names this exact list when it saves, and it
-- can only name real columns — an index over an expression would not be
-- something it could point at, and every read would insert instead of replace.
create unique index if not exists admin_connection_snapshots_one_per_day
  on public.admin_connection_snapshots
     (client_id, provider, property, period_start, period_end, taken_on);

-- ============================================================
-- 3. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Owners and admins only, same as the rest of Delivery. A sales rep cannot see
-- the tables at all.
--
-- DELETE ON CONNECTIONS IS OWNERS ONLY, for the same reason as 0005: this is
-- the record of which client accounts this console can read. Switching a
-- connection off is the everyday action and any admin can do it. Removing the
-- row is an owner's call.
--
-- SNAPSHOTS CANNOT BE CHANGED BY ANYBODY. There is no update policy and no
-- update grant. A measurement that can be edited after a report quoted it is
-- not a measurement.

grant select, insert, update on public.admin_client_connections to authenticated;
grant delete on public.admin_client_connections to authenticated;


alter table public.admin_client_connections enable row level security;

drop policy if exists "admins read connections" on public.admin_client_connections;
create policy "admins read connections" on public.admin_client_connections
  for select using (public.admin_is_admin());

drop policy if exists "admins add connections" on public.admin_client_connections;
create policy "admins add connections" on public.admin_client_connections
  for insert with check (public.admin_is_admin());

drop policy if exists "admins edit connections" on public.admin_client_connections;
create policy "admins edit connections" on public.admin_client_connections
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());

drop policy if exists "owners remove connections" on public.admin_client_connections;
create policy "owners remove connections" on public.admin_client_connections
  for delete using (public.admin_is_owner());

grant select, insert on public.admin_connection_snapshots to authenticated;
grant delete on public.admin_connection_snapshots to authenticated;

alter table public.admin_connection_snapshots enable row level security;

drop policy if exists "admins read snapshots" on public.admin_connection_snapshots;
create policy "admins read snapshots" on public.admin_connection_snapshots
  for select using (public.admin_is_admin());

-- Inserting by hand is how a typed-in number gets on the record. It is forced
-- to say source = 'manual': only the server (service role) may write 'api',
-- because only the server actually asked the account.
drop policy if exists "admins add manual snapshots" on public.admin_connection_snapshots;
create policy "admins add manual snapshots" on public.admin_connection_snapshots
  for insert with check (public.admin_is_admin() and source = 'manual');

drop policy if exists "owners remove snapshots" on public.admin_connection_snapshots;
create policy "owners remove snapshots" on public.admin_connection_snapshots
  for delete using (public.admin_is_owner());
