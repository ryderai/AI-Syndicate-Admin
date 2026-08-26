-- ============================================================
-- 0017 — SAVED ANSWERS FROM A REP'S WORK PAGE
-- ============================================================
-- Aug 26 2026, Ryder. CJ is giving the sales reps their own logins, so each rep
-- gets a box on their Work page: they type what they want to know and
-- /api/rep-report answers it from the records a rep is allowed to see. Every
-- press writes a row here.
--
-- WHY THIS IS NOT admin_console_reports (0010).
-- That table is owner/admin only, and its comment says why: one of those rows
-- can summarise every client, lead and invoice in one place. The rows were
-- written from an OWNER-SCOPED snapshot, so a rep who could read one would walk
-- straight around the role scoping in lib/brain-context.js. Widening 0010's
-- policies would undo that scoping in one line. So the rep's answers live in
-- their own table, written from a rep-scoped snapshot, and a rep never reads a
-- row from admin_console_reports.
--
-- Append-only, exactly like admin_console_reports (0010) and admin_client_reports
-- (0008), and for the same reason: what a rep was told last Tuesday is worth
-- keeping even when this Tuesday's answer disagrees. There is no update policy.
-- Delete is allowed, because a bad answer is noise and nobody should have to
-- keep it.
--
-- Safe to run twice. It only creates admin_-prefixed objects and every statement
-- is guarded.

create table if not exists public.admin_rep_reports (
  id uuid primary key default gen_random_uuid(),

  -- WHOSE ANSWER THIS IS. Every read policy below hangs off this column, so it
  -- is the whole access model of the table in one field. The server sets it from
  -- the bearer token, never from the request body — /api/rep-report reads
  -- member.membership.user_id. If a caller could pass it, a rep could file a row
  -- as somebody else and then read it back.
  owner_id uuid not null references auth.users on delete cascade default auth.uid(),

  -- The role that token carried, for the audit trail. No CHECK constraint on
  -- purpose: 0006 taught us that `create table if not exists` leaves an older
  -- check in place for ever, so a constraint that has to widen when a fourth
  -- role is added is a button that fails silently for a day. The three real
  -- roles are constrained where they are decided — admin_users.role in 0001.
  role text,

  -- What was asked for, verbatim. This is half the point of keeping the row: a
  -- good question is worth re-asking, and a bad answer is usually a bad ask.
  instruction text,

  title text not null default 'Your sales work',
  summary text not null default '',            -- the 30-second answer
  body text not null default '',               -- the whole answer

  -- true  = no AI wrote this. Either there is no ANTHROPIC_API_KEY, or the model
  --         refused, or its draft failed the honesty gate and was thrown away.
  -- false = the AI worded it AND its draft passed every check.
  counted_only boolean not null default true,
  -- Why a draft was thrown away, in plain words, so a rep is never left
  -- wondering why today's answer reads like a list.
  gate_reason text,

  -- The counted figures behind the answer, so a person can audit it later
  -- without re-reading the whole sales table. Kept small on purpose: counts and
  -- the cannot-answer list, never the lead rows themselves.
  facts jsonb,

  created_by_email text,
  created_at timestamptz not null default now()
);

-- Newest first, per person. Both ways this table is ever read.
create index if not exists admin_rep_reports_owner_idx
  on public.admin_rep_reports (owner_id, created_at desc);
create index if not exists admin_rep_reports_created_idx
  on public.admin_rep_reports (created_at desc);

-- ---- who can touch it -------------------------------------------------
-- In plain words:
--   * A rep can read their own rows and nobody else's.
--   * A rep can insert a row only with their own user id on it.
--   * Owner and admin can read every row, because somebody has to be able to
--     see what the reps are being told.
--   * Nobody can update a row. Correcting an answer means generating a new one.
--   * A person can delete their own; owner and admin can delete any.
--
-- admin_is_member() = an active row in admin_users, any role.
-- admin_is_admin()  = an active row whose role is owner or admin (0001).

alter table public.admin_rep_reports enable row level security;

grant select, insert, delete on public.admin_rep_reports to authenticated;

drop policy if exists admin_rep_reports_read_own on public.admin_rep_reports;
create policy admin_rep_reports_read_own on public.admin_rep_reports
  for select to authenticated
  using (public.admin_is_member() and owner_id = auth.uid());

drop policy if exists admin_rep_reports_read_all on public.admin_rep_reports;
create policy admin_rep_reports_read_all on public.admin_rep_reports
  for select to authenticated
  using (public.admin_is_admin());

-- `owner_id = auth.uid()` in the WITH CHECK is the line that stops a rep filing
-- a row under somebody else's name and then reading it back through the
-- read-own policy above.
drop policy if exists admin_rep_reports_insert_own on public.admin_rep_reports;
create policy admin_rep_reports_insert_own on public.admin_rep_reports
  for insert to authenticated
  with check (public.admin_is_member() and owner_id = auth.uid());

drop policy if exists admin_rep_reports_delete_own on public.admin_rep_reports;
create policy admin_rep_reports_delete_own on public.admin_rep_reports
  for delete to authenticated
  using (public.admin_is_admin() or (public.admin_is_member() and owner_id = auth.uid()));

-- No update policy, on purpose. A saved answer is a record of what a rep was
-- told at a moment, and the gate_reason on it is part of that record.
