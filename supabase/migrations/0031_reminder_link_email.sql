-- ============================================================
-- 0031 — A FOLLOW-UP CAN POINT AT AN EMAIL AGAIN
-- ============================================================
-- Wed 2 Sep 2026. Found by `tests/db-columns`, a guard written the same
-- afternoon after a form shipped with a column name the table did not have.
--
-- WHAT IS BROKEN, AND HAS BEEN SINCE 0006 RAN.
--
-- The Inbox's "remind me about this email" writes
--   upsertReminder({ …, link_type: "email", link_id: <the email row> })
-- and `admin_reminders_link_type_check` has not allowed 'email' since migration
-- 0006. So every one of those presses has been refused by Postgres and shown
-- "Could not save the follow-up". Nothing was lost and nothing was wrong on
-- screen — it simply never worked.
--
-- HOW IT HAPPENED, because it is worth writing down.
--
--   0003 added 'email' to the list, for exactly this button.
--   0006 REPLACED the whole constraint to add 'note' — and rebuilt the list
--        from the 0002 original, so 'email' fell out. The comment above that
--        statement says it is "widening the constraint rather than dropping the
--        link: knowing WHAT a follow-up came from is the reason the column is
--        there." The statement underneath it narrows the constraint. The
--        comment and the code have disagreed ever since.
--
-- A REPLACEMENT IS NOT A WIDENING. `drop constraint` then `add constraint` with
-- a hand-typed list silently discards every value somebody else added, and
-- nothing fails until a person presses the one button that used it.
--
-- Safe to run twice: one drop-if-exists and one add, nothing else touched, no
-- data rewritten. Every value any migration has ever allowed is in the list.

alter table public.admin_reminders drop constraint if exists admin_reminders_link_type_check;
alter table public.admin_reminders
  add constraint admin_reminders_link_type_check
  check (link_type is null or link_type in ('client','lead','task','ticket','note','email'));

comment on column public.admin_reminders.link_type is
  'What this follow-up came from. Every value here is written by some screen: client, lead, task and ticket since 0002; email since 0003 (dropped by 0006 and restored by 0031); note since 0006. Widen this list by ADDING to it — a hand-retyped replacement is how email was lost for months.';

-- `admin_notes.link_type` already carries 'email' (0003) and nothing has
-- replaced it since. Checked rather than assumed, and left alone.

-- Re-assert the grants. A lost GRANT has broken two pages on this project, and
-- touching a constraint is a cheap moment to be sure. Nothing here widens
-- access — RLS still decides every row.
grant select, insert, update, delete on public.admin_reminders to authenticated;
