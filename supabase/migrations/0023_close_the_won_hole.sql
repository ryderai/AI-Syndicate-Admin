-- ============================================================
-- 0023 — THE WON FUNCTION GETS THE ROW LOCK, AND STOPS LETTING
--        THE CALLER NAME SOMEBODY ELSE AS THE AUTHOR
-- ============================================================
-- Aug 27 2026. Found by an adversarial review of the Floor build, hours after
-- 0020 went in. It is not a defect in 0020 — it is the hole 0020 left open, and
-- it is the biggest one in this console.
--
-- WHAT IS WRONG. `admin_lead_to_client(p_lead, p_actor, p_stage)` in
-- 0015_sales_lifecycle.sql is `security definer`, which means it writes past
-- row-level security entirely, and its only guard was:
--
--     if not public.admin_is_member() then raise exception 'not authorized'; end if;
--
-- It is granted to `authenticated`. So one line typed into the browser console by
-- any signed-in sales rep:
--
--     supabase.rpc('admin_lead_to_client', { p_lead: '<any lead id>', p_actor: '<anybody>' })
--
-- marked somebody else's live deal Won, stamped `became_customer` on it, created
-- a client record for the agency, relinked every other contact at that firm, and
-- wrote a 'converted' line on the timeline whose `actor` was WHOEVER THE CALLER
-- NAMED. Two separate problems in one call:
--
--   1. NO ROW LOCK. 0021 went back and added the lock to the other
--      security-definer function (admin_lead_claim_text). The function that does
--      far more got nothing. Trap #6 in CONTEXT-FOR-AI.md §8 — "UI-only
--      permission guards are not guards" — for the fourth time in this repo.
--
--   2. A FORGED AUTHOR. `p_actor` is a parameter and `v_actor` was
--      `coalesce(p_actor, auth.uid())`, so the activity row could be filed under
--      any user id. Every other write path refuses this: 0001's activity policy
--      is `with check (… and actor = auth.uid())` and 0018's tag policy is
--      `(by = auth.uid() or by is null)`. `security definer` skips both. A dated
--      line naming the wrong person is worse than no line, because the whole
--      point of an append-only timeline is that it cannot be argued with.
--
-- WHY THIS IS A NEW FILE AND NOT AN EDIT TO 0015. 0015 has never been run, so
-- editing it would have worked — and it would have hidden the finding. A separate
-- file is a record of a hole that existed, which is what the next person needs.
-- It is also the only shape that is safe if 0015 HAS been run somewhere nobody
-- told us about.
--
-- THE BODY BELOW IS 0015's, LIFTED VERBATIM, with two guards added and one
-- declaration changed. It was extracted from the file by a script rather than
-- retyped, on purpose: a paraphrase of a 200-line function that creates client
-- records is a divergence waiting to happen. If 0015's logic ever changes, change
-- it here in the same commit — tests/sales-sheet/sql.sh drives the whole
-- lead-to-client behaviour through this one function, so a divergence fails there
-- rather than in production.
--
-- RE-RUN ORDER, SAID OUT LOUD: this file replaces a function 0015 defines, so
-- re-running 0015 after this puts the hole back. Same trap 0020 §6b and 0018 §3b
-- describe. If you ever re-run 0015 or 0009, run 0020 and then this file again,
-- and then `bash tests/floor-scoping/sql.sh`.
--
-- Safe to run twice. It replaces one function and changes nothing else.

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
  v_actor     uuid;
  v_siblings  int := 0;
  v_created   boolean := false;
  v_key       text;
begin
  if not public.admin_is_member() then
    raise exception 'not authorized';
  end if;

  /* ---- THE AUTHOR IS WHOEVER IS ASKING ----
   *
   * `p_actor` stays in the signature so every caller keeps working — src/lib/data.js
   * and all four Won buttons pass it — but a rep may now only ever pass their own
   * id. An owner or admin may still name somebody else, because recording a deal
   * on a rep's behalf is a real thing they do and they can already write anything.
   *
   * REFUSED RATHER THAN SILENTLY CORRECTED. Rewriting it would mean the browser
   * believes it filed the row under one person while the database filed it under
   * another, and nobody would ever find out which. */
  if p_actor is not null and p_actor <> auth.uid() and not public.admin_is_admin() then
    raise exception 'a deal can only be recorded under your own name';
  end if;
  v_actor := coalesce(p_actor, auth.uid());

  /* ---- THE ROW LOCK, in the one place a rep can otherwise write past it ----
   *
   * `security definer` means the policies on admin_leads do not run at all for
   * the writes below, so this is the only place the rule can be. It is the same
   * rule as everywhere else, through the same function (0018 section 3b), so it
   * cannot drift from the policies, the endpoint checks or canEditLead() on the
   * page. */
  /* "NO SUCH LEAD" AND "SOMEBODY ELSE'S LEAD" ARE DIFFERENT ANSWERS.
   * admin_can_work_lead returns false for a lead that does not exist, so checking
   * it first made a mistyped id read as a permission problem and left the
   * "no such lead" message below unreachable. Existence first, then permission.
   * Third review, Aug 27 2026. */
  if not exists (select 1 from public.admin_leads where id = p_lead) then
    raise exception 'no such lead';
  end if;
  if not public.admin_can_work_lead(p_lead) then
    raise exception 'that lead belongs to somebody else';
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
-- AFTER RUNNING THIS
-- ============================================================
--   1. Nothing on any screen changes. Every Won button already passes the
--      signed-in person as `p_actor` — which is now the only value a rep may
--      pass — and every one of them already only appears on a lead the rep may
--      work.
--   2. Prove it:  bash tests/floor-scoping/sql.sh
--      It asserts a rep cannot close another rep's deal through the function,
--      cannot file the timeline row under somebody else's name, and CAN still
--      close their own and an unclaimed one.
--   3. If you ever re-run 0015 or 0009, run 0020 and then this file again.
