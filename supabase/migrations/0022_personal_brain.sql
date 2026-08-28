-- ============================================================
-- 0022 — A REP'S OWN AI RULES
-- ============================================================
-- Aug 27 2026, Ryder. Every rep writes differently and sells differently, and
-- today the AI writes every draft the same way.
--
-- WHAT EXISTS TODAY. `admin_brain` is the COMPANY brain: one global list of
-- standing rules and facts, owner/admin only, and api/ai-draft.js:37-47
-- deliberately refuses to load it for a sales rep so a rep cannot get the AI to
-- recite it back (that is trap #8 in §8 — a sales-blocked table leaking through
-- an AI endpoint). A rep therefore has no way to teach the AI anything at all.
--
-- WHY THIS IS A NEW TABLE AND NOT A `user_id` COLUMN ON admin_brain.
-- `admin_brain`'s policy is a single `for all using (admin_is_admin())` covering
-- all four commands (0001:428-430). To let a rep read their own rows there, that
-- policy would have to be widened — and the moment it is, the company Brain is
-- one mistake away from a rep's prompt. A separate table cannot leak the company
-- one, whatever anybody writes next.
--
-- THE HARD RULE, AND IT IS ON THE SCREEN AS WELL AS IN HERE:
--
--   A PERSONAL RULE SETS TONE, LENGTH, FORMAT AND SIGN-OFF. NEVER A FACT AND
--   NEVER A NUMBER.
--
-- The reason is mechanical, not stylistic. The honesty gate works by checking
-- every number in a draft against the fact sheet the model was shown, and the
-- personal rules have to be part of that fact sheet or the gate throws away
-- honest answers for using words it was never given. Which means: a fact typed
-- into a personal rule ENTERS THE POOL THE GATE CHECKS AGAINST. Type "our
-- clients see a 40% lift" into your own rules and the gate will happily let the
-- AI write it to a prospect, because as far as the gate can tell, we told it
-- that. One rep's typo becomes a claim we made.
--
-- So the save path refuses a rule containing ANY DIGIT AT ALL, and says why on
-- screen. That check is checkPersonalRule() in lib/sales-rules.js, where a test
-- can read it, and it is a character class: `/[0-9]/`.
--
-- STRICTER THAN IT SOUNDS, AND DELIBERATELY SO. "Keep it to 4 sentences" is
-- refused, and so is "Rule 3:". An earlier draft of this comment said a digit-run
-- or a percentage was the rule and that "Rule 3:" was fine — both untrue of the
-- code. The reason for the stricter line: allow a single digit and "if their score
-- is under 6, name it" walks through, and a bare 6 in the pool is a number the
-- model may then attach to a firm. Length, tone and subject style are fixed
-- settings on the page rather than sentences, so nothing a rule needs to say
-- requires a digit, and a phone number belongs in a Gmail signature where it is
-- attached to the mailbox that sends the mail.
--
-- WHAT IT DOES NOT CATCH, on record rather than claimed away: "a forty percent
-- lift" written in words, and non-ASCII digits. Both are pinned in
-- tests/user-brain as known limits rather than as intended behaviour.
--
-- It is NOT enforced here as a CHECK constraint, on purpose: the same digit that
-- is wrong in a rule is right in a title somebody types by accident and then
-- fixes, and a refusal a person can read beats a Postgres error they cannot.
-- The label on a rule goes through the same check — see upsertUserBrain.
--
-- AN ADMIN CAN READ ANY REP'S RULES. A rule nobody can audit quietly rewrites
-- what clients get told. Same own/all split admin_rep_reports uses in 0017.
--
-- Safe to run twice.

create table if not exists public.admin_user_brain (
  id uuid primary key default gen_random_uuid(),

  -- WHOSE RULE THIS IS. Every policy below hangs off this column, so it is the
  -- whole access model of the table in one field. It defaults to auth.uid() and
  -- the insert policy forces it to match, so a rep cannot file a rule under
  -- somebody else's name and change how THEIR drafts get written.
  user_id uuid not null references auth.users on delete cascade default auth.uid(),

  -- 'voice'     — one of the fixed settings: tone, length, subject-line style
  -- 'rule'      — a sentence the rep typed ("one question per email, at the end")
  -- 'snippet'   — a reusable opener or paragraph
  -- 'signature' — the sign-off
  kind text not null default 'rule',

  -- For a 'voice' row, which setting it is ('tone', 'length', 'subject',
  -- 'never_say'). Null on the others. A key rather than a column per setting, so
  -- adding "how I talk about price" is a row and not a migration.
  setting_key text,

  title text,
  body text not null,

  -- Switched off rather than deleted, so a rep can try a rule, turn it off, and
  -- still find it next week.
  enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Drop-and-re-add with every existing value re-listed, because `create table if
-- not exists` leaves an older CHECK in place for ever and re-running this file
-- would not widen one. See the trap note in 0018.
alter table public.admin_user_brain drop constraint if exists admin_user_brain_kind_check;
alter table public.admin_user_brain
  add constraint admin_user_brain_kind_check
  check (kind in ('voice','rule','snippet','signature'));

-- A rule with no words in it is not a rule, and an empty row renders as a blank
-- bullet on the page and as a blank line in the prompt.
alter table public.admin_user_brain drop constraint if exists admin_user_brain_body_check;
-- `btrim(body)` WITH NO SECOND ARGUMENT ONLY TRIMS SPACES. A body of one newline
-- or one tab walked straight through it and saved as a rule with no words in it,
-- which renders as a blank bullet on the page and as a blank line in every draft's
-- prompt. The character set has to be spelled out. Found by tests/user-brain,
-- Aug 27 2026.
alter table public.admin_user_brain
  add constraint admin_user_brain_body_check
  check (length(btrim(body, E' \t\r\n')) > 0);

-- A cap, so one paste cannot put a whole document into every draft's system
-- prompt. 2,000 characters is about a page — far more than any tone rule needs
-- and far less than anything that would push the facts out of the prompt.
alter table public.admin_user_brain drop constraint if exists admin_user_brain_body_len_check;
alter table public.admin_user_brain
  add constraint admin_user_brain_body_len_check
  check (length(body) <= 2000);

-- One row per setting per person for the fixed settings, so picking "Formal"
-- twice does not leave two tone rules fighting each other in the prompt.
--
-- NOT PARTIAL, AND THAT IS THE WHOLE POINT OF THIS COMMENT.
--
-- The first version carried `where setting_key is not null`, which reads as the
-- careful choice: 'rule' and 'snippet' rows have a null setting_key and there can
-- be many of them per person. It would have broken every save.
--
-- Postgres will only use a PARTIAL unique index as an ON CONFLICT arbiter when
-- the statement repeats the index's own predicate. The browser saves a setting
-- with PostgREST's `upsert(..., { onConflict: "user_id,setting_key" })`, which
-- emits a bare `on conflict (user_id, setting_key)` and cannot express a WHERE at
-- all. With no arbiter, Postgres raises 42P10 — "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification" — so Tone, Length, Subject
-- lines, Sign-off and Never say would every one of them have failed with a raw
-- database error the moment this file was run. Preview mode never touches that
-- branch, which is why nothing would have caught it until the day somebody ran
-- the migration. Found by tests/user-brain, Aug 27 2026, before it ever ran.
--
-- Dropping the predicate is safe: Postgres treats NULLs as DISTINCT in a unique
-- index by default, so any number of rows with a null setting_key still coexist
-- for one person. The index does exactly what it did, and PostgREST can now name
-- it.
--
-- The `drop index` is here because `create unique index if not exists` would
-- leave the older PARTIAL index in place on any database where the first version
-- had already been run — the same class of trap as a CHECK that never widens.
drop index if exists public.admin_user_brain_setting_idx;
create unique index if not exists admin_user_brain_setting_idx
  on public.admin_user_brain (user_id, setting_key);

create index if not exists admin_user_brain_user_idx
  on public.admin_user_brain (user_id, created_at);

drop trigger if exists admin_user_brain_updated_at on public.admin_user_brain;
create trigger admin_user_brain_updated_at before update on public.admin_user_brain
  for each row execute function public.admin_set_updated_at();

-- ---- who can touch it -------------------------------------------------
-- In plain words:
--   * A person reads, writes, edits and deletes their OWN rules and nobody
--     else's.
--   * Owner and admin can READ every rep's rules, because a rule nobody can
--     audit rewrites what prospects get told.
--   * Owner and admin CANNOT edit somebody else's rules. Correcting how another
--     person writes is a conversation, not a database write — and a rep whose
--     own settings changed under them with no explanation stops using the page.
--
-- Unlike the tag events, update and delete ARE allowed here. These are settings,
-- not records: "my sign-off is X" is a current preference, and its history is
-- worth nothing. Contrast admin_lead_tag_events, where the history IS the point.

alter table public.admin_user_brain enable row level security;

grant select, insert, update, delete on public.admin_user_brain to authenticated;

drop policy if exists admin_user_brain_own on public.admin_user_brain;
create policy admin_user_brain_own on public.admin_user_brain
  for all to authenticated
  using (public.admin_is_member() and user_id = auth.uid())
  with check (public.admin_is_member() and user_id = auth.uid());

drop policy if exists admin_user_brain_admin_read on public.admin_user_brain;
create policy admin_user_brain_admin_read on public.admin_user_brain
  for select to authenticated
  using (public.admin_is_admin());

-- ============================================================
-- AFTER RUNNING THIS
-- ============================================================
--   1. The AI Brain page in a rep's sidebar starts saving. Before this file has
--      run it loads, shows the settings, and says in plain words that nothing
--      can be saved yet.
--   2. Personal rules reach the model through lib/ai.js buildSystemPrompt(),
--      placed AFTER the company rules and BEFORE the job instruction, in a block
--      that states in words that the company rules override them. That order is
--      the same shape the feedback loop already uses (§32/§33: correction above,
--      constraint below, and the constraint saying it wins).
--   3. Verify:
--        select user_id, kind, setting_key, left(body, 40) from public.admin_user_brain;
--      and check that an admin reading it sees every rep's rows while a rep sees
--      only their own — bash tests/user-brain/sql.sh proves both.
