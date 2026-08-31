-- ============================================================
-- 0020 — THE LOCK MOVES FROM THE LIST TO THE ROW
-- ============================================================
-- Aug 27 2026, Ryder. This is the migration the whole Floor rebuild depends on,
-- and it closes a hole that is open right now.
--
-- WHAT IS OPEN RIGHT NOW. `admin_leads` UPDATE is, verbatim from
-- 0001_admin_init.sql:403-405:
--
--     create policy "members update leads" on public.admin_leads
--       for update using (public.admin_is_member());
--
-- One `using` clause and NO `with check`. In Postgres, `using` decides which
-- rows you may attempt to change and `with check` decides what a row is allowed
-- to look like AFTER you change it. With no `with check`, any active member may
-- set any lead's `owner_id` to their own id. In plain words: any sales rep can
-- already reassign any lead to themselves by talking to the database directly,
-- today. Nobody has noticed because the website has never offered a button for
-- it.
--
-- The Floor starts showing every rep every row. That gap has to be closed for
-- real before it does, and "for real" means here, not on the page. This is
-- trap #6 of §8 — "UI-only permission guards are not guards" — for the third
-- time in this repo.
--
-- THE RULE, IN ONE SENTENCE PER ROLE:
--   * An owner or admin may do anything to any lead, including handing it to
--     somebody else. That is their job.
--   * A rep may take a lead nobody holds, may edit a lead they hold, and may
--     hand their own lead back to the floor.
--   * A rep may NOT touch a lead somebody else holds, and may NOT hand a lead
--     to anybody else.
--
-- THE THIRD PLACE THE SAME RULE HAS TO LIVE. Every file in `api/` runs on the
-- Supabase service key, which bypasses RLS completely. So this file is one of
-- THREE copies of the rule and all three must agree:
--   1. here, for anything the browser writes directly;
--   2. a JavaScript check inside every endpoint that writes a lead;
--   3. the disabled button on screen, which is politeness, not security.
-- If you change this file, change `canEditLead()` in src/lib/salesSheet.js and
-- the endpoint checks in api/sales-score.js and lib/assistant-tools.js in the
-- same commit.
--
-- Safe to run twice. Every policy is dropped by name and recreated.

-- ============================================================
-- 1. admin_leads — SELECT stays wide, UPDATE gets a with check
-- ============================================================
-- SELECT is deliberately untouched and deliberately wide: every member reads
-- every lead.
--
-- ****  COMMENT-ONLY UPDATE, 30 AUG 2026. NO SQL BELOW THIS FILE'S HEADER HAS  ****
-- ****  CHANGED. Re-running this file is as safe as it was.                    ****
--
-- The sentence that used to be here said the wide SELECT was "not an oversight,
-- it is the requirement — a rep who cannot see another rep's row cannot be
-- stopped from working the same firm". THAT PRODUCT RULE WAS REVERSED by Ryder
-- on 30 Aug 2026: a rep no longer sees a lead somebody else holds. The firm
-- collision it was protecting is now carried by a mark on the FIRM that names
-- nobody (firmsHeldByOthers in src/lib/salesSheet.js).
--
-- The wide SELECT here is now a DELIBERATE GAP, not the requirement. Ryder's
-- call that day was screen-only enforcement, so the narrowing lives in three
-- places on the application side and none in the database:
--   src/lib/salesSheet.js   visibleToMember()    the Sales page
--   lib/brain-context.js    repLeadFilter        the AI's context block
--   lib/assistant-tools.js  the search tool      the AI's own lookups
-- A rep's browser can therefore still fetch another rep's lead by hand. If that
-- stops being acceptable, the fix is a NEW migration adding a select policy of
-- `public.admin_is_admin() or owner_id = auth.uid() or owner_id is null`, not an
-- edit to this file. Do not read the wide policy as evidence that reps are
-- meant to see everything.
--
-- WHY `owner_id is null` IS IN THE WITH CHECK AS WELL AS THE USING.
--
-- The plan for this build specified the tighter pair:
--     using      ( admin_is_admin() or owner_id = auth.uid() or owner_id is null )
--     with check ( admin_is_admin() or owner_id = auth.uid() )
--
-- That version is wrong, in two ways that both break ordinary work, and it is
-- written out here so nobody "tightens" it back:
--
--   a. A REP COULD NEVER HAND A LEAD BACK. `releaseLead()` in src/lib/data.js
--      writes `owner_id: null`, so the resulting row has a null owner and the
--      tighter WITH CHECK refuses it. Handing a lead back to the floor is a
--      thing the Rules of Engagement expect a rep to do.
--   b. LOGGING A TOUCH ON AN UNCLAIMED LEAD WOULD FAIL. `admin_lead_activity_touch`
--      (0009) is a plain trigger — not `security definer` — so its UPDATE on
--      admin_leads runs as the person who inserted the activity row and IS
--      subject to this policy. On an unclaimed lead the row after the update
--      still has `owner_id is null`, so the tighter WITH CHECK would refuse the
--      whole insert. A rep logging a call on a lead they have not claimed yet is
--      the ordinary first move, and it would have failed with a permission error
--      nobody could read.
--
-- Allowing a null owner in the WITH CHECK gives away nothing, because the USING
-- clause is what stops a rep reaching another rep's row in the first place:
--   * take an unclaimed lead        → USING passes (null), CHECK passes (self)  ✓
--   * edit their own                → both pass                                 ✓
--   * hand their own back           → USING passes (self), CHECK passes (null)   ✓
--   * touch another rep's           → USING FAILS                                ✗
--   * hand a lead to another rep    → CHECK FAILS (not self, not null)           ✗
--   * strip another rep's claim     → USING FAILS                                ✗
-- The only thing a rep gains is the ability to edit a lead nobody holds without
-- claiming it first, which is what the page has always allowed and what
-- canEditLead() says on screen.

drop policy if exists "members update leads" on public.admin_leads;
create policy "members update leads" on public.admin_leads
  for update
  using (
    public.admin_is_admin()
    or owner_id = auth.uid()
    or owner_id is null
  )
  with check (
    public.admin_is_admin()
    or owner_id = auth.uid()
    or owner_id is null
  );

-- INSERT: 0001's policy was `with check (admin_is_member())` and said nothing
-- about the owner, so a rep could add a contact already owned by another rep.
-- Not much of an attack — but it is a row that belongs to somebody who never
-- took it, and the Floor would draw it as theirs, locked, with their name on it.
drop policy if exists "members insert leads" on public.admin_leads;
create policy "members insert leads" on public.admin_leads
  for insert
  with check (
    public.admin_is_member()
    and (
      public.admin_is_admin()
      or owner_id = auth.uid()
      or owner_id is null
    )
  );

-- ============================================================
-- 2. admin_lead_activity — log against a lead you may work
-- ============================================================
-- 0001:410-412 is `with check (admin_is_member() and actor = auth.uid())`: you
-- may only file a row as yourself, and that half stays. What it does not say is
-- WHICH lead you may file it against, so a rep could log a call on another
-- rep's lead — a dated line, on a record nobody can edit afterwards, about a
-- conversation the lead's owner knows nothing about.
--
-- On the old pages that was unreachable (a rep only ever saw their own leads and
-- the floor). The Floor shows everything, so it stops being unreachable.

-- `admin_can_work_lead()` comes from 0018 section 3b. One function for a rule
-- that four tables need: written out four times, it is four places for it to
-- stop matching.
drop policy if exists "members log own activity" on public.admin_lead_activity;
create policy "members log own activity" on public.admin_lead_activity
  for insert
  with check (
    public.admin_is_member()
    and actor = auth.uid()
    and public.admin_can_work_lead(lead_id)
  );

-- SELECT on activity stays wide, from 0001. The reason given here was that a rep
-- opening somebody else's row read-only has to be able to read its timeline.
-- After 30 Aug 2026 a rep is not shown that row at all, so this is the same
-- deliberate gap as the one on admin_leads above — see that note. The
-- application side prunes lead activity to the leads a rep may see
-- (lib/brain-context.js). Comment-only update; the SQL is untouched.

-- ============================================================
-- 3. admin_proposals — the same shape, through the lead
-- ============================================================
-- 0009:457-459 gave proposals the identical too-wide policy:
--     for update using (public.admin_is_member())
-- and a proposal carries the only figure of money a rep can see, so it is worth
-- closing at the same time.
--
-- A proposal has no `owner_id` of its own — it has `lead_id` and `created_by`.
-- So the scope is the LEAD's owner, read with a subquery. Deliberately NOT
-- `created_by = auth.uid()`: a proposal drafted by CJ on a rep's lead is still
-- that rep's proposal to send, and scoping on the author would lock them out.
--
-- `lead_id` is nullable on this table, so a proposal attached to no lead is
-- editable by any member — there is nobody it could belong to. Written as an
-- explicit `lead_id is null` branch rather than left to fall out of the
-- subquery, because an EXISTS over no rows is false and would have quietly made
-- every unattached proposal uneditable by everybody.

drop policy if exists "members update proposals" on public.admin_proposals;
create policy "members update proposals" on public.admin_proposals
  for update
  using (
    public.admin_is_admin()
    or lead_id is null
    or exists (
      select 1 from public.admin_leads l
      where l.id = admin_proposals.lead_id
        and (l.owner_id = auth.uid() or l.owner_id is null)
    )
  )
  with check (
    public.admin_is_admin()
    or lead_id is null
    or exists (
      select 1 from public.admin_leads l
      where l.id = admin_proposals.lead_id
        and (l.owner_id = auth.uid() or l.owner_id is null)
    )
  );

-- ============================================================
-- 4. admin_lead_tag_events — a rep may only tag a lead they may work
-- ============================================================
-- 0018 deliberately left this rule out and pointed here, so the whole row-level
-- lock reads in one file. Same shape as the two above.

-- IDENTICAL TO 0018's, ON PURPOSE. Both files state it, through the same
-- function, so running either one twice or in either order leaves the same rule
-- standing. The first version had 0018 create the WIDE policy and this file
-- replace it, which meant re-running 0018 after this file silently reopened the
-- hole — nothing on any screen would have changed. A test caught it; a person
-- would not have.
drop policy if exists "members write tag events" on public.admin_lead_tag_events;
create policy "members write tag events" on public.admin_lead_tag_events
  for insert
  with check (
    public.admin_is_member()
    and (by = auth.uid() or by is null)
    and public.admin_can_work_lead(lead_id)
  );

-- ============================================================
-- 5. admin_email_threads — a rep works their OWN mailbox
-- ============================================================
-- 0003:128-130 made this table admin-only:
--     create policy "admins all email threads" ... for all using (admin_is_admin())
--
-- and src/components/admin/Inbox.jsx reads and writes it STRAIGHT FROM THE
-- BROWSER. There is no endpoint in between, so there is nowhere else to put this
-- rule. Without a policy here a rep's Gmail page renders an empty list with no
-- error, which reads exactly like an empty inbox.
--
-- THE EXISTING ADMIN POLICY IS NOT TOUCHED AND MUST NOT BE LOOSENED. Client
-- billing lives in growth@aisyndicate.com. Two policies for one command are
-- OR'd together in Postgres, so adding this one widens nothing for an admin and
-- takes nothing away.
--
-- A rep gets a thread if its mailbox is one THEY THEMSELVES connected.
-- `admin_gmail_accounts` is keyed (user_id, email_address), so this subquery
-- means "the addresses I connected" and never "an address somebody shared".
-- resolveMailbox() in lib/gmail-mailbox.js already refuses a rep a shared
-- mailbox server-side; this is the same refusal in the database.
--
-- `for all` rather than four policies: the Inbox reads, inserts and updates
-- these rows (status, links, notes, follow-ups) from the browser on the same
-- screen, and splitting one predicate across four policies is four places to
-- get one rule wrong.

drop policy if exists "reps work their own mailbox threads" on public.admin_email_threads;
create policy "reps work their own mailbox threads" on public.admin_email_threads
  for all
  using (
    public.admin_is_member()
    and mailbox in (
      select g.email_address from public.admin_gmail_accounts g
      where g.user_id = auth.uid()
    )
  )
  with check (
    public.admin_is_member()
    and mailbox in (
      select g.email_address from public.admin_gmail_accounts g
      where g.user_id = auth.uid()
    )
  );

-- The browser has to be able to READ the address list for the policy above to
-- be usable at all — a rep's Gmail page asks which mailboxes are theirs. 0001
-- already grants a column-level select on admin_gmail_accounts that deliberately
-- EXCLUDES refresh_token, and its "own gmail read" policy is already
-- `user_id = auth.uid()`. Nothing to change: said here so the next reader does
-- not go looking for a missing grant.

-- ============================================================
-- 6. THE SILENT BREAK WAITING TO HAPPEN
-- ============================================================
-- api/rep-report.js inserts `counted_cause` (line 236 as of Aug 27 2026 — the
-- number moves, the row does not), and 0017_rep_reports.sql never
-- defined that column. 0017 has never been run, so nothing is broken today —
-- but the moment somebody runs it, every rep answer fails to save, silently,
-- because the endpoint logs the error and returns the words anyway (which is the
-- right behaviour for the rep and the wrong behaviour for whoever has to notice).
--
-- One line, here, so running 0017 and 0020 in either order is safe.
alter table public.admin_rep_reports add column if not exists counted_cause text;

-- No CHECK on it, matching the deliberate absence of one on `role` in the same
-- table (0017:42) and for the same reason: the values the endpoint writes are
-- decided in lib/rep-report.js where a test can read them, and a CHECK that has
-- to widen inside a `create table if not exists` is a button that fails silently
-- for a day.

-- ============================================================
-- 6b. THE ONE WAY TO UNDO ALL OF THIS BY ACCIDENT
-- ============================================================
-- RE-RUNNING AN EARLIER MIGRATION AFTER THIS ONE REVERTS THE TIGHTENING.
--
-- 0001 creates "members update leads" (one `using`, no `with check`) and
-- "members log own activity" (no lead scope). This file replaces both by name.
-- Postgres has no idea one is newer than the other, so `psql -f 0001` a month
-- from now puts the wide versions back and every screen keeps looking identical.
--
-- There is no way to make that impossible from inside a file. What there is:
--   * 0018's tag policy carries the same rule this file does, through one shared
--     function, so THAT pair is safe in either order (see 0018 section 3b);
--   * SETUP.md says, in the section for this migration, that re-running 0001 or
--     0009 means re-running 0020 afterwards;
--   * tests/floor-scoping/sql.sh proves the lock by BREAKING it on purpose —
--     it reinstalls 0001's one-clause policy, watches the "cannot steal another
--     rep's lead" assertions start passing when they should fail, re-applies this
--     file, and checks the refusals come back. A test that keeps passing while
--     the feature is broken is worse than no test.
--
-- If you have just re-run an older migration and you are reading this: run this
-- file again, then `bash tests/floor-scoping/sql.sh`.

-- ============================================================
-- 7. AFTER RUNNING THIS
-- ============================================================
--   1. Prove the lock. You cannot sign in as a rep in the SQL editor, so prove
--      it with the test instead:
--        bash tests/floor-scoping/sql.sh
--      It stands up a real Postgres, applies every migration in order, and
--      asserts a rep CANNOT update another rep's lead, CANNOT reassign one,
--      CANNOT tag or log against one, CANNOT read another rep's email threads,
--      CAN take an unclaimed one, and CAN hand their own back.
--   2. Nothing on screen changes. The page already draws another rep's row
--      greyed with its controls off; this is the half that works when somebody
--      skips the page.
--   3. Verify the policies landed:
--        select policyname, cmd from pg_policies
--         where tablename in ('admin_leads','admin_proposals','admin_email_threads',
--                             'admin_lead_activity','admin_lead_tag_events')
--         order by tablename, policyname;
