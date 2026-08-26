-- AI Syndicate ADMIN console — ONE RECORD, FROM LEAD TO PAYING CLIENT.  Aug 25 2026
-- SAFE TO RUN ON THE SHARED (PLATFORM) PROJECT.
--
--   * Run 0001 through 0014 first. This file is independent of 0010-0014 and
--     can be run before or after any of them. It DOES need 0009 (the sales
--     tables) to have run.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--   * Re-running this file is safe. Every statement is guarded, and the one
--     function that writes is idempotent by design — see section 3.
--
-- WHAT THIS FIXES
-- Ryder, Aug 21 2026, and it has been the plan since: "a lead IS a customer
-- profile from day one. One record its whole life." The tables were built for
-- that on Aug 22 — `admin_leads.became_customer` and `admin_companies.client_id`
-- both exist — and then NOTHING EVER WROTE EITHER OF THEM. Marking a deal Won
-- put a green pill on a row and did not create a client, did not link a firm,
-- and left the entire chase history on the far side of a gap nothing crossed.
-- The toast on the page said so out loud, which is honest, and useless.
--
-- Ryder, Aug 25 2026: "have everything connected and context saved to all
-- people in our system from the time there created as a lead all the way to a
-- paying client and beyond."
--
-- So this file does three things:
--   1. Gives a person a real first and last name, because the sheet has two
--      columns and we had one.
--   2. Adds the two links that were missing and were never going to fill
--      themselves in.
--   3. Adds ONE function that turns a won deal into a client — every person at
--      that firm attached to it, the whole timeline carried across, and safe to
--      call twice.

-- ============================================================
-- 1. THE PERSON'S NAME, IN TWO HALVES
-- ============================================================
-- CJ's sheet has First Name and Last Name. The importer read both columns and
-- then JOINED them into one `name`, so the sheet's own layout could not be
-- rebuilt from our data. Both halves are stored now. `name` stays as the
-- display name and as the record of what we were actually handed.

alter table public.admin_leads add column if not exists first_name text;
alter table public.admin_leads add column if not exists last_name text;

-- Backfill, ONCE, and only where both halves are empty.
--
-- First word first, the rest last. That is wrong for "Mary Jo Van Der Berg"
-- and there is no rule that is right for every name on earth. It is safe here
-- ONLY because `name` is not touched: the guess is visible in two cells that a
-- person can correct in one click, and the original is still underneath it. A
-- backfill that rewrote `name` from its own guess would be unrecoverable.
update public.admin_leads
  set first_name = nullif(split_part(btrim(regexp_replace(name, '\s+', ' ', 'g')), ' ', 1), ''),
      last_name  = nullif(btrim(substr(
                     btrim(regexp_replace(name, '\s+', ' ', 'g')),
                     length(split_part(btrim(regexp_replace(name, '\s+', ' ', 'g')), ' ', 1)) + 1
                   )), '')
  where first_name is null and last_name is null
    and name is not null and btrim(name) <> '';

create index if not exists admin_leads_lastname_idx on public.admin_leads (lower(last_name)) where last_name is not null;

-- ============================================================
-- 2. THE TWO LINKS THAT WERE MISSING
-- ============================================================

-- On the PERSON: which client they belong to once the firm starts paying.
-- Every contact at that firm gets it, not only the one whose deal closed —
-- that is what makes "context saved to all people" true rather than a phrase.
alter table public.admin_leads add column if not exists client_id uuid references public.admin_clients on delete set null;
alter table public.admin_leads add column if not exists became_customer_at timestamptz;
alter table public.admin_leads add column if not exists became_customer_by uuid references auth.users on delete set null;

create index if not exists admin_leads_client_idx on public.admin_leads (client_id) where client_id is not null;

-- On the CLIENT: which firm in the sales system they came from. The reverse
-- link already existed (admin_companies.client_id, added in 0009 and written by
-- nothing). Both directions are stored because both directions get asked:
-- the sales page asks "is this firm already a client", and the client page asks
-- "show me how this one started".
alter table public.admin_clients add column if not exists company_id uuid references public.admin_companies on delete set null;

-- How this client record came to exist. A client typed in by hand and a client
-- that came up through the pipeline are different facts, and blending them
-- makes the sales numbers unreadable — you cannot count conversions if half the
-- clients were never leads.
alter table public.admin_clients add column if not exists origin text;
alter table public.admin_clients drop constraint if exists admin_clients_origin_check;
alter table public.admin_clients
  add constraint admin_clients_origin_check
  check (origin is null or origin in ('sales','manual','import'));

create index if not exists admin_clients_company_idx on public.admin_clients (company_id) where company_id is not null;

-- 'converted' is a new kind of thing that can happen to a lead. It goes on the
-- same timeline as the calls, because a rep looking back should not have to
-- read a second panel to find the day it closed.
alter table public.admin_lead_activity drop constraint if exists admin_lead_activity_type_check;
alter table public.admin_lead_activity
  add constraint admin_lead_activity_type_check
  check (type in (
    'call','email','text','linkedin','note','status_change','assigned',
    'claim','unclaim','reopen','score','proposal','import','cadence','open',
    'converted','client_link'
  ));

-- ============================================================
-- 3. WON → CLIENT, IN ONE STATEMENT THAT IS SAFE TO CALL TWICE
-- ============================================================
-- Everything about this function is shaped by one rule: pressing Won twice, or
-- two reps pressing it in the same second, must not produce two clients with
-- the same name and half the history each. That is not a hypothetical — it is
-- exactly the failure the one-text rule already had to be moved into the
-- database to prevent (0009). A browser that reads "is there a client?" and
-- then writes one is a read-modify-write, and two tabs both win it.
--
-- So: one function, one transaction, an explicit row lock on the lead, and an
-- early return if the work is already done.
--
-- WHAT IT WILL NOT DO
--   * It never invents a client name. If there is no firm name and no person
--     name it raises, rather than filing a client called "Unknown".
--   * It never overwrites an existing client record's details. Linking to a
--     client somebody already set up must not quietly replace their contact
--     with a lead's.
--   * It never touches money. Whether they are actually paying is Stripe's
--     answer and Finance's page; this only records that the sale closed.

-- Returns JSONB, not a bare id, because the browser has to be able to tell
-- three different things apart and say the right one out loud:
--   created         — a new client record was made just now
--   already_customer— this exact person was already recorded as the closer
--   siblings        — how many other people at the firm were attached
-- Returning only a uuid made the page toast "they are now a client" every time,
-- including the times when nothing at all was created.
drop function if exists public.admin_lead_to_client(uuid, uuid, text);
create or replace function public.admin_lead_to_client(
  p_lead uuid,
  p_actor uuid default null,
  p_stage text default 'Onboarding'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead      public.admin_leads%rowtype;
  v_company   public.admin_companies%rowtype;
  v_client_id uuid;
  v_name      text;
  v_actor     uuid := coalesce(p_actor, auth.uid());
  v_siblings  int := 0;
  v_created   boolean := false;
  v_key       text;
begin
  if not public.admin_is_member() then
    raise exception 'not authorized';
  end if;

  -- FOR UPDATE, not a plain select. This is the lock that makes a second
  -- caller wait and then find the work already done, instead of racing.
  select * into v_lead from public.admin_leads where id = p_lead for update;
  if not found then
    raise exception 'no such lead: %', p_lead;
  end if;

  -- Already done. Return the same id rather than raising: pressing Won twice
  -- is an ordinary thing a person does, not an error, and an error here would
  -- show a red box for a thing that worked.
  --
  -- BOTH halves are checked on purpose. `client_id` alone was wrong and a test
  -- caught it: the moment ONE contact at a firm closes, every other contact
  -- there is attached to the same client — which is the whole point — so a
  -- client_id-only check made every one of THEIR deals return early and never
  -- get marked won. A firm with four contacts could record exactly one sale,
  -- ever, and the rep who closed the second one would watch the button do
  -- nothing. Being attached to a client and having closed a deal are two
  -- different facts about a person.
  if v_lead.client_id is not null and coalesce(v_lead.became_customer, false) then
    return jsonb_build_object(
      'client_id', v_lead.client_id, 'created', false,
      'already_customer', true, 'siblings', 0);
  end if;

  if v_lead.company_id is not null then
    select * into v_company from public.admin_companies where id = v_lead.company_id for update;
  end if;

  -- The firm may already be a client — another contact there closed first, or
  -- somebody set the client up by hand and linked it. Reuse it.
  v_client_id := coalesce(v_lead.client_id, v_company.client_id);

  if v_client_id is null then
    v_name := nullif(btrim(coalesce(v_company.name, v_lead.company, v_lead.name, '')), '');
    if v_name is null then
      raise exception 'this lead has no firm name and no person name, so there is nothing to call the client';
    end if;

    -- A CONTACT ADDED BY HAND HAS NO FIRM ROW, so there is nothing to lock and
    -- nothing to dedupe against. Two people typed in under the same firm name
    -- and both marked Won produced TWO clients with the same name, each holding
    -- half the history — deterministically, no race needed. That is verbatim
    -- the failure this file's header says it exists to prevent, and it was
    -- found by a reviewer rather than by the tests.
    --
    -- So: take a transaction-scoped advisory lock on the NAME KEY (so a real
    -- race also serialises here), then look for a client that already carries
    -- that name. Matched on the normalised name AND the domain when both sides
    -- have one — name alone would fold two same-named firms in different states
    -- onto one client.
    v_key := public.admin_company_name_key(v_name);
    if v_key is not null then
      perform pg_advisory_xact_lock(hashtext('admin_lead_to_client:' || v_key));

      select c.id into v_client_id
      from public.admin_clients c
      where public.admin_company_name_key(c.name) = v_key
        -- REFUSED ONLY WHEN BOTH SIDES NAME A WEBSITE AND THE WEBSITES DIFFER.
        --
        -- The first version demanded both-present-and-equal or both-absent,
        -- which sounded careful and was wrong: the sheet's Company column
        -- carries no website, and a hand-added contact has no firm row, so one
        -- contact at a firm having a website and the next one not having one is
        -- the ORDINARY case. Two contacts at "Olson Law PLLC" then produced two
        -- clients with the same name and half the history each — verbatim the
        -- failure this block exists to prevent. Proved against real Postgres by
        -- a reviewer.
        --
        -- A missing website is not evidence of a different firm; two different
        -- websites are. So a blank on either side does not block the match, and
        -- two names that differ (& vs and, a state suffix) still do — the name
        -- key above is unchanged and remains the strict half of the test.
        and (
          c.domain is null
          or nullif(btrim(coalesce(v_company.domain, v_lead.domain, '')), '') is null
          or lower(regexp_replace(c.domain, '^https?://(www\.)?|/$', '', 'g'))
            = lower(regexp_replace(coalesce(v_company.domain, v_lead.domain), '^https?://(www\.)?|/$', '', 'g'))
        )
      order by c.created_at
      limit 1;
    end if;
  end if;

  if v_client_id is null then
    v_created := true;
    insert into public.admin_clients (
      name, domain, vertical, stage, status, start_date,
      contact_name, contact_email, contact_phone, company_id, origin, notes
    ) values (
      v_name,
      nullif(btrim(coalesce(v_company.domain, v_lead.domain, '')), ''),
      nullif(btrim(coalesce(v_company.vertical, v_lead.vertical, '')), ''),
      coalesce(nullif(btrim(p_stage), ''), 'Onboarding'),
      'active',
      (now() at time zone 'America/Chicago')::date,
      nullif(btrim(coalesce(v_lead.name, '')), ''),
      nullif(btrim(coalesce(v_lead.email, '')), ''),
      nullif(btrim(coalesce(v_lead.phone, v_company.phone, '')), ''),
      v_company.id,
      'sales',
      'Came up through the sales pipeline. The whole chase — every call, email and note — is on this firm''s contacts in Sales.'
    )
    returning id into v_client_id;
  else
    -- Linking to a record that already exists. Fill in ONLY what is blank
    -- there. Somebody's typed-in contact is not replaced by a lead's.
    update public.admin_clients
      set company_id    = coalesce(company_id, v_company.id),
          contact_name  = coalesce(nullif(btrim(coalesce(contact_name, '')), ''), nullif(btrim(coalesce(v_lead.name, '')), '')),
          contact_email = coalesce(nullif(btrim(coalesce(contact_email, '')), ''), nullif(btrim(coalesce(v_lead.email, '')), '')),
          contact_phone = coalesce(nullif(btrim(coalesce(contact_phone, '')), ''), nullif(btrim(coalesce(v_lead.phone, '')), ''))
      where id = v_client_id;
  end if;

  if v_company.id is not null then
    update public.admin_companies set client_id = v_client_id where id = v_company.id;

    -- EVERY person we hold at that firm points at the client now. This is the
    -- half that makes the record continuous: three months later, the delivery
    -- team opens the client and can still read who was rung, when, and what
    -- was said — instead of a client record that begins on the day the money
    -- started.
    --
    -- `became_customer` is NOT set on the siblings. Whose deal it was is a
    -- different fact from who works there, and flattening the two would count
    -- one sale four times on the rep scoreboard.
    update public.admin_leads
      set client_id = v_client_id
      where company_id = v_company.id and id <> p_lead and client_id is null;
    get diagnostics v_siblings = row_count;
  end if;

  update public.admin_leads
    set client_id          = v_client_id,
        became_customer    = true,
        became_customer_at = now(),
        became_customer_by = v_actor,
        stage              = 'won',
        closed_at          = coalesce(closed_at, now())
    where id = p_lead;

  -- The timeline says it happened, on the record that already holds the chase.
  -- An event with nothing on the timeline is an event nobody can find later.
  if v_actor is not null then
    /* `where not exists` rather than a plain insert. A lead that was attached
     * to the client by a SIBLING'S conversion, and then closes its own deal,
     * runs this block for the first time — but a lead whose own conversion is
     * re-run after being un-flagged by hand would otherwise get a second
     * identical line. One conversion, one line. */
    insert into public.admin_lead_activity (lead_id, actor, type, body)
    select
      p_lead, v_actor, 'converted',
      'Won. Now a paying client'
        || case when v_siblings > 0
             then ' — and the other ' || v_siblings || ' contact'
                  || case when v_siblings = 1 then '' else 's' end
                  || ' at this firm are attached to the same client record.'
             else '.' end
    where not exists (
      select 1 from public.admin_lead_activity
      where lead_id = p_lead and type = 'converted'
    );

    if v_siblings > 0 then
      insert into public.admin_lead_activity (lead_id, actor, type, body)
      select id, v_actor, 'client_link',
             'This firm became a paying client. Everything logged here stays on the record.'
      from public.admin_leads l
      where l.company_id = v_company.id and l.id <> p_lead and l.client_id = v_client_id
        and not exists (
          select 1 from public.admin_lead_activity a
          where a.lead_id = l.id and a.type = 'client_link'
        );
    end if;
  end if;

  return jsonb_build_object(
    'client_id', v_client_id,
    'created', v_created,
    'already_customer', false,
    'siblings', v_siblings);
end;
$$;

revoke execute on function public.admin_lead_to_client(uuid, uuid, text) from anon, public;
grant execute on function public.admin_lead_to_client(uuid, uuid, text) to authenticated;

-- ============================================================
-- 4. THE OTHER DIRECTION — a client, back to their sales history
-- ============================================================
-- Read-only. Returns every contact we hold for a client, whether they were the
-- one who closed or not, newest activity first.

create or replace function public.admin_client_contacts(p_client uuid)
returns setof public.admin_leads
language sql
stable
security definer
set search_path = public
as $$
  select l.*
  from public.admin_leads l
  where public.admin_is_member()
    and (
      l.client_id = p_client
      or l.company_id in (select id from public.admin_companies where client_id = p_client)
    )
  order by l.became_customer desc nulls last, l.last_activity_at desc nulls last, l.created_at desc;
$$;

revoke execute on function public.admin_client_contacts(uuid) from anon, public;
grant execute on function public.admin_client_contacts(uuid) to authenticated;

-- ============================================================
-- 5. BACKFILL — link up what is already sitting there
-- ============================================================
-- Firms whose name matches a client we already have, where nothing is linked
-- yet. Matching on the NORMALISED name AND the domain together, never on name
-- alone: "Above & Beyond Real Estate" exists in more than one state, and a
-- name-only match would attach one state's sales history to the other state's
-- client. A firm with no domain is left alone for a person to link by hand.

update public.admin_companies co
  set client_id = c.id
  from public.admin_clients c
  where co.client_id is null
    and co.domain is not null and c.domain is not null
    and lower(regexp_replace(co.domain, '^https?://(www\.)?|/$', '', 'g'))
      = lower(regexp_replace(c.domain, '^https?://(www\.)?|/$', '', 'g'))
    and public.admin_company_name_key(co.name) = public.admin_company_name_key(c.name);

update public.admin_clients c
  set company_id = co.id
  from public.admin_companies co
  where c.company_id is null and co.client_id = c.id;

-- Their people follow the firm. `became_customer` is deliberately NOT set by
-- this backfill: nobody can say from here WHICH contact closed the deal, and
-- guessing would put a sale on somebody's scoreboard that they may not have
-- made.
update public.admin_leads l
  set client_id = co.client_id
  from public.admin_companies co
  where l.company_id = co.id and co.client_id is not null and l.client_id is null;

-- Anything already flagged as a customer before this file existed keeps a
-- truthful date rather than a made-up one: the day the record was last
-- touched is the closest thing we hold, and it is only used where the flag is
-- already true.
update public.admin_leads
  set became_customer_at = coalesce(became_customer_at, closed_at, updated_at)
  where became_customer = true and became_customer_at is null;

-- Clients that pre-date the origin column were all typed in by hand.
update public.admin_clients set origin = 'manual' where origin is null;
