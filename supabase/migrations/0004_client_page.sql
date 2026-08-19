-- AI Syndicate ADMIN console — the client page: websites + where it stands.
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--
--   * Run 0001, 0002 and 0003 first.
--   * Everything new is prefixed admin_. Nothing on the platform is touched.
--
-- What this adds, in plain words:
--
--   1. admin_client_sites — every web address that belongs to a client: the main
--      website, the ranking sites we build for them, their Google Business
--      Profile, directory listings. One row per link, so it is a real list that
--      can be sorted and checked, not one text box nobody updates.
--
--   2. Four columns on admin_clients that hold the written "where this client
--      stands" summary: the text, the facts it was built from, when it was
--      written, and who pressed the button. The facts are stored WITH the text
--      on purpose — a summary you cannot check against its own inputs is a
--      rumour.

-- ============================================================
-- 1. CLIENT WEBSITES
-- ============================================================

create table if not exists public.admin_client_sites (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.admin_clients on delete cascade,
  kind text not null default 'authority'
    check (kind in ('main','authority','landing','gbp','directory','review','social','other')),
  label text not null,                       -- what to call it: "Main site", "Florida Injury Claim Guide"
  url text not null,
  live boolean not null default true,        -- false = built but not published yet
  notes text,
  sort int not null default 0,               -- hand order; main site usually 0
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  added_by uuid references auth.users on delete set null
);

comment on column public.admin_client_sites.kind is
  'main = the client''s own website. authority = a ranking site we built. gbp = Google Business Profile. The rest are listings and profiles we do not own.';

create index if not exists admin_client_sites_client_idx
  on public.admin_client_sites(client_id, sort, created_at);

drop trigger if exists admin_client_sites_updated_at on public.admin_client_sites;
create trigger admin_client_sites_updated_at before update on public.admin_client_sites
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 2. WHERE THIS CLIENT STANDS
-- ============================================================
-- standing_summary holds the short write-up shown at the top of the client page.
-- standing_facts holds the counted facts it was written from (tasks done, weeks
-- logged, emails waiting, and so on) so anyone can check the write-up against
-- the same numbers it saw. standing_source records whether a person's AI key
-- wrote it or whether it was counted straight from the database.

alter table public.admin_clients
  add column if not exists standing_summary text;
alter table public.admin_clients
  add column if not exists standing_facts jsonb;
alter table public.admin_clients
  add column if not exists standing_at timestamptz;
alter table public.admin_clients
  add column if not exists standing_by uuid references auth.users on delete set null;
alter table public.admin_clients
  add column if not exists standing_source text
    check (standing_source is null or standing_source in ('written','counted'));

-- ============================================================
-- 3. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Same as the rest of Operations: owners and admins only. Sales works Leads.

grant select, insert, update, delete on public.admin_client_sites to authenticated;

alter table public.admin_client_sites enable row level security;

drop policy if exists "admins all client sites" on public.admin_client_sites;
create policy "admins all client sites" on public.admin_client_sites
  for all using (public.admin_is_admin()) with check (public.admin_is_admin());
