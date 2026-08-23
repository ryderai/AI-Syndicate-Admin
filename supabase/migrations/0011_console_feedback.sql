-- ============================================================
-- 0011 — RATING THE OVERVIEW GENERATOR, AND LEARNING FROM IT
-- ============================================================
-- Aug 23 2026. Two things.
--
-- 1. The generator's "free draft" mode is GONE. Ryder: "i want it to always
--    come from real stats, it should never be free or make up anything. thats
--    just a way for it to hallucinate." Every answer is now checked against the
--    counts, so the mode column only ever holds 'records'. Any older row is
--    moved over and the check is tightened, because a column that still allows
--    a value the code can no longer produce is a trap for the next person.
--
-- 2. A star rating and an optional note, per answer. The notes are read back on
--    the NEXT run and put into the instruction, so telling it "too long, lead
--    with the money" actually changes the next one.
--
-- Append-only, like every other record table here. Rating the same answer twice
-- writes a second row; the newest wins when it is read. Nothing is overwritten,
-- so "I hated it, then I re-read it and it was fine" is a history, not a
-- correction.
--
-- Safe to run twice. Only admin_-prefixed objects, every statement guarded.

-- ---- 1. one mode, enforced ------------------------------------------------

update public.admin_console_reports set mode = 'records' where mode <> 'records';

alter table public.admin_console_reports drop constraint if exists admin_console_reports_mode_check;
alter table public.admin_console_reports
  add constraint admin_console_reports_mode_check
  check (mode in ('records'));

-- ---- 2. the feedback ------------------------------------------------------

create table if not exists public.admin_console_feedback (
  id uuid primary key default gen_random_uuid(),

  -- Cascade: if the answer is deleted, the note about it is meaningless.
  report_id uuid not null references public.admin_console_reports on delete cascade,

  -- 1 = useless, 5 = exactly right. Required — a note with no rating gives the
  -- next run no idea how strongly to weight it.
  rating int not null check (rating between 1 and 5),

  -- Optional, and this is the part that actually teaches it something.
  -- "Too long." "Lead with the money." "Stop repeating the client's name."
  note text,

  created_by uuid references auth.users on delete set null default auth.uid(),
  created_by_email text,
  created_at timestamptz not null default now()
);

-- The read is always "the newest notes, worst rating first".
create index if not exists admin_console_feedback_recent_idx
  on public.admin_console_feedback (created_at desc);
create index if not exists admin_console_feedback_report_idx
  on public.admin_console_feedback (report_id, created_at desc);

-- ---- who can touch it ----------------------------------------------------
-- Same gate as the answers themselves: owner and admin. A note can quote the
-- content of an answer, and an answer can summarise every client and invoice at
-- once, so this table inherits that sensitivity.

alter table public.admin_console_feedback enable row level security;

grant select, insert, delete on public.admin_console_feedback to authenticated;

drop policy if exists admin_console_feedback_read on public.admin_console_feedback;
create policy admin_console_feedback_read on public.admin_console_feedback
  for select to authenticated using (public.admin_is_admin());

drop policy if exists admin_console_feedback_write on public.admin_console_feedback;
create policy admin_console_feedback_write on public.admin_console_feedback
  for insert to authenticated with check (public.admin_is_admin());

drop policy if exists admin_console_feedback_delete on public.admin_console_feedback;
create policy admin_console_feedback_delete on public.admin_console_feedback
  for delete to authenticated using (public.admin_is_admin());

-- No update policy, on purpose. Changing your mind writes a new row.
