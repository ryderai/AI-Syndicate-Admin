-- AI Syndicate ADMIN console — platform accounts (one login card per account).
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Run 0001 through 0004 first.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--
-- What this adds, in plain words:
--
--   admin_platform_accounts — one row for every login we hold on the customer
--   platform. One for our own agency account, one for each client whose
--   workspace we work inside. The console uses the row to mint a one-time
--   sign-in link, so a click opens that account with no password typed.
--
-- WHY THE LIST EXISTS AT ALL (this is the security point, not bookkeeping):
--   the sign-in endpoint will only ever make a link for an email that is
--   ALREADY IN THIS TABLE. It never takes an email from the browser. Adding a
--   row is an owner/admin action, on the record, with a name next to it — so
--   "which accounts can this console become" is a list you can read, not
--   whatever the front end happened to post.
--
-- PASSWORDS NEVER GO IN THIS TABLE. vault_url holds a Bitwarden link only.

-- ============================================================
-- 1. THE TABLE
-- ============================================================

create table if not exists public.admin_platform_accounts (
  id uuid primary key default gen_random_uuid(),

  -- null = one of ours (the agency's own account). Otherwise the client it
  -- belongs to. Deleting a client removes its login card with it.
  client_id uuid references public.admin_clients on delete cascade,

  label text not null,                         -- "AI Syndicate (us)", "Shiner Law Group"
  email text not null,                         -- the platform login address
  site text,                                   -- what YOUR SITE is set to in that workspace
  plan text,                                   -- whatever plan it is on, in plain words
  vault_url text,                              -- Bitwarden link. NEVER a password.
  notes text,
  active boolean not null default true,        -- false = we no longer work in it
  sort int not null default 0,

  last_opened_at timestamptz,
  last_opened_by uuid references auth.users on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Who put this login on the list. Defaulted AND forced by a trigger below,
  -- because "an owner or admin added it" is only worth saying if the name is
  -- actually written down. The browser cannot set this to someone else.
  added_by uuid references auth.users on delete set null default auth.uid(),

  -- The same shape the console checks in lib/platform-accounts.js: one @, a
  -- dot after it, no spaces. The database is the third place this gets
  -- checked, so it must not be the loosest of the three — a row seeded in the
  -- SQL editor as 'ops@' would render a normal-looking card whose button can
  -- only ever fail. The real test is still whether Supabase finds a login for
  -- the address, and that answer comes back on the button.
  constraint admin_platform_accounts_email_shape
    check (email ~ '^[^[:space:]@]+@[^[:space:]@.]+\.[^[:space:]@]+$')
);

comment on table public.admin_platform_accounts is
  'Platform logins the console can open. The sign-in endpoint only mints links for emails listed here.';
comment on column public.admin_platform_accounts.client_id is
  'null = the agency''s own platform account. Otherwise the client this login belongs to.';
comment on column public.admin_platform_accounts.vault_url is
  'Bitwarden link only. A password must never be stored here.';

-- One card per login. Case-insensitive, because Login@x.com and login@x.com
-- are the same account to Supabase.
create unique index if not exists admin_platform_accounts_email_key
  on public.admin_platform_accounts (lower(email));

create index if not exists admin_platform_accounts_client_idx
  on public.admin_platform_accounts (client_id, sort, created_at);

drop trigger if exists admin_platform_accounts_updated_at on public.admin_platform_accounts;
create trigger admin_platform_accounts_updated_at before update on public.admin_platform_accounts
  for each row execute function public.admin_set_updated_at();

-- added_by is stamped from the signed-in user on insert and can never be
-- rewritten afterwards. A row that says who added it, that the adder can
-- change, records nothing.
create or replace function public.admin_platform_accounts_stamp_adder()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    new.added_by := auth.uid();
  else
    new.added_by := old.added_by;
  end if;
  return new;
end;
$$;

drop trigger if exists admin_platform_accounts_adder on public.admin_platform_accounts;
create trigger admin_platform_accounts_adder before insert or update on public.admin_platform_accounts
  for each row execute function public.admin_platform_accounts_stamp_adder();

-- ============================================================
-- 2. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Owners and admins can read, add and edit. A sales rep cannot see the table
-- at all — not the list, not the count.
--
-- DELETE IS OWNERS ONLY, on purpose. This table is the record of which logins
-- the console can become and who put them there. If an admin can add a card,
-- use it, and then delete the row, the record erases itself and the list stops
-- being evidence of anything. Switching a card off ("We still work in this
-- account") is the everyday action and any admin can do it; removing the row
-- outright is an owner's call.

grant select, insert, update on public.admin_platform_accounts to authenticated;
grant delete on public.admin_platform_accounts to authenticated;

alter table public.admin_platform_accounts enable row level security;

drop policy if exists "admins all platform accounts" on public.admin_platform_accounts;

drop policy if exists "admins read platform accounts" on public.admin_platform_accounts;
create policy "admins read platform accounts" on public.admin_platform_accounts
  for select using (public.admin_is_admin());

drop policy if exists "admins add platform accounts" on public.admin_platform_accounts;
create policy "admins add platform accounts" on public.admin_platform_accounts
  for insert with check (public.admin_is_admin());

drop policy if exists "admins edit platform accounts" on public.admin_platform_accounts;
create policy "admins edit platform accounts" on public.admin_platform_accounts
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());

drop policy if exists "owners remove platform accounts" on public.admin_platform_accounts;
create policy "owners remove platform accounts" on public.admin_platform_accounts
  for delete using (public.admin_is_owner());
