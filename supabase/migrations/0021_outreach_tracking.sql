-- ============================================================
-- 0021 — WHAT WENT OUT, WHAT CAME BACK, AND NO OPEN RATE
-- ============================================================
-- Aug 27 2026, Ryder. Four separate things, all about the same page.
--
-- 1. WHAT WE CAN HONESTLY MEASURE ABOUT OUTREACH.
--
-- Gmail cannot tell anybody whether a person opened an email. There is no
-- recipient-side open signal in the Gmail API and there is not one in anybody
-- else's either. The only way an "open rate" is ever produced is a tracking
-- pixel — a 1x1 invisible image that phones home when the mail is displayed —
-- and Apple Mail Privacy Protection loads that pixel for everybody whether they
-- read the mail or not, while Gmail proxies images through Google. So a
-- pixel-based open rate is somewhere between inflated and meaningless. The
-- "under 3% open rate" figure that gets quoted in the industry is measured with
-- that same broken pixel.
--
-- Ryder agreed on Aug 27 to drop it. THERE IS NO OPEN RATE IN THIS SYSTEM AND
-- NO PIXEL IS BUILT. What is measured instead, all of it real:
--   sent · replied · reply rate · time to first reply · bounced.
--
-- If anybody ever adds a pixel, it is labelled "guessed" and never mixed with
-- these. Written here because a column is the place a bad number gets in.
--
-- 2. THE THING THAT IS ALREADY BROKEN AND NOBODY KNEW.
--
-- `admin_leads.email_opened_at` exists (0009:212) and NOTHING HAS EVER WRITTEN
-- IT. It is the hard gate on the one-text-per-lead rule, inside the SQL function
-- `admin_lead_claim_text` (0009:346). So texting is switched off permanently and
-- the screen says "They have not opened an email yet" for ever. Section 4 below
-- repoints that gate at "they replied", which we can actually measure.
--
-- 3. THE REFRESH TOKEN IS PLAINTEXT.
--
-- `admin_gmail_accounts.refresh_token` is a `text not null` column holding, in
-- clear, the thing that grants read-and-send access to a person's mailbox. The
-- browser cannot read it — 0001:346 and 0003:39 grant select on a COLUMN LIST
-- that excludes it — so this is not urgent. But the row count is about to
-- multiply from one shared inbox to one per rep, and lib/vault-crypto.js already
-- does AES-256-GCM for the client connections. Section 3 makes room for the
-- encrypted version.
--
-- 4. ASKING GMAIL WHAT CHANGED INSTEAD OF RE-READING THE INBOX.
--
-- `history_id` is Gmail's own cursor: give it back and Gmail says what has
-- happened since. Today api/gmail-threads.js lists the inbox and then fetches
-- every thread's metadata six at a time, on every single page load.
--
-- Safe to run twice. Additive, admin_-prefixed, every statement guarded.

-- ============================================================
-- 1. THE MAILBOX — a cursor, and room for an encrypted token
-- ============================================================

-- Gmail's incremental change cursor. Text, not a number: Gmail documents it as
-- an opaque value and it is already bigger than a 32-bit int on busy accounts.
alter table public.admin_gmail_accounts add column if not exists history_id text;

-- AES-256-GCM from lib/vault-crypto.js, tied to the row's email address, exactly
-- the way admin_connection_secrets does it in 0013. A blob copied onto another
-- row by hand in the SQL editor fails to unscramble rather than quietly opening
-- somebody else's mailbox.
alter table public.admin_gmail_accounts add column if not exists refresh_token_enc text;

-- WHY THE PLAINTEXT COLUMN STOPS BEING `not null` RATHER THAN BEING DROPPED.
--
-- This file cannot do the encryption: the key lives in VAULT_KEY on the server
-- and SQL has no access to it. So the move is in two steps and this is the first
-- one — make room. The second step happens in the server code
-- (lib/gmail-mailbox.js): on every read, if a row still has a plaintext token
-- and no encrypted one, it encrypts it, writes `refresh_token_enc`, and NULLS
-- `refresh_token`. That cannot happen while the column is `not null`.
--
-- The column is kept rather than dropped so that a row written by an older
-- deploy — one still running gmail-callback.js from before this change — is
-- still readable and still gets migrated on its next read. Dropping it would
-- mean a mid-deploy connect silently loses its token.
alter table public.admin_gmail_accounts alter column refresh_token drop not null;

-- Column-level select, RESTATED with the new columns deliberately left out. A
-- grant on a table's columns does not stretch to columns added later — that is
-- why 0003 had to restate it, and it is why `refresh_token_enc` and
-- `history_id` are simply absent below. `refresh_token_enc` must never appear
-- in a column grant. `history_id` is left out too: it is a server-side cursor,
-- nothing on screen reads it, and a grant nobody needs is a grant nobody
-- notices.
--
-- NOTE FOR WHOEVER READS ROWS FROM THE BROWSER: `select *` on this table now
-- fails for `authenticated`, because a star needs privileges on every column.
-- Nothing does that today (checked Aug 27: every reader in lib/ and api/ runs on
-- the service key, and the two browser paths go through /api/gmail-accounts).
-- Name your columns.
grant select (user_id, email_address, scope, connected_at, shared, display_name, last_synced_at)
  on public.admin_gmail_accounts to authenticated;

-- ============================================================
-- 2. THE THREAD — what actually happened on it
-- ============================================================

-- The id Gmail hands back from messages.send. Returned today and thrown away at
-- api/gmail-send.js:78. Without it there is no way to tell OUR send apart from
-- any other message on the thread, which is what a reply is measured against.
alter table public.admin_email_threads add column if not exists gmail_message_id text;

-- THE FIRST time we wrote to them, and the FIRST time they wrote back. First,
-- not last, and both nullable:
--   * time-to-reply is reply-minus-send, and the LAST send would give a
--     negative number on any thread with a follow-up;
--   * null means "has not happened", which is not a zero and must never print
--     as one.
alter table public.admin_email_threads add column if not exists first_out_at timestamptz;
alter table public.admin_email_threads add column if not exists first_reply_at timestamptz;

-- A bounce. Not a reply, and it has to come OUT of the reply-rate denominator:
-- an address that does not exist was never given the chance to answer, and
-- leaving it in makes a clean list look like a bad one.
alter table public.admin_email_threads add column if not exists bounced_at timestamptz;

-- WHO READS THIS INDEX, honestly: nothing on the Overview does.
--
-- An earlier version of this line said "counting sent and replied per mailbox is
-- the one query the Overview tiles run", and that is the opposite of what was
-- built. lib/outreach.js counts LEAD columns, for a reason it explains at length:
-- a thread is keyed on a mailbox, and admin_gmail_accounts is readable only by the
-- person who connected it (0001), so nothing in the browser can say which mailbox
-- belongs to which rep — which is exactly what the owner's rep-numbers table
-- needs to do.
--
-- The index is kept because api/gmail-threads.js does read threads by mailbox on
-- every page load, and because a per-mailbox count is the natural query the day
-- somebody wants "what went out of growth@ last month".
create index if not exists admin_email_threads_outreach_idx
  on public.admin_email_threads (mailbox, first_out_at desc)
  where first_out_at is not null;
create index if not exists admin_email_threads_lead_idx
  on public.admin_email_threads (lead_id) where lead_id is not null;

-- ============================================================
-- 3. THE LEAD — the same two moments, on the person
-- ============================================================
-- The thread has these too, and that is not a duplicate. A lead can have several
-- threads (a new email months later, a different rep, a forwarded chain), and
-- "when did we first reach this person" is a question about the PERSON. The
-- thread columns are the record; these two are the answer.
--
-- THEY ARE TWO STATEMENTS, NOT ONE, and an earlier version of this line claimed
-- otherwise ("written by the same one function, so they cannot drift"). They are
-- written in the same function and in the same breath, but a database has no idea
-- of that: either can fail while the other succeeds. So both call sites read the
-- result and say so — api/gmail-threads.js collects them into `problems` and
-- answers 207, and api/gmail-send.js and api/gmail-drafts.js log the failure
-- against the person who sent the mail. They CAN drift; what is guaranteed is
-- that a drift is recorded somewhere a person can find it.
alter table public.admin_leads add column if not exists first_email_at timestamptz;
alter table public.admin_leads add column if not exists first_reply_at timestamptz;

-- A bounce, ON THE PERSON. The thread column above is the record of which
-- message bounced; this is the answer to "can we email this person at all",
-- which is a fact about them and not about one thread.
--
-- IT HAS TO BE HERE FOR THE REPLY RATE TO BE HONEST. Reply rate is counted per
-- PERSON — of the people we emailed, how many wrote back — and an address that
-- does not exist was never given the chance to answer. Leaving a bounce in the
-- denominator makes a clean list look like a bad one, and it is the one number
-- on the Overview a rep would be judged on.
alter table public.admin_leads add column if not exists bounced_at timestamptz;

create index if not exists admin_leads_reply_idx
  on public.admin_leads (first_reply_at) where first_reply_at is not null;

-- ============================================================
-- 4. REPOINT THE TEXT GATE — from "they opened" to "they replied"
-- ============================================================
-- `admin_lead_claim_text` (0009:326-350) is the only thing that may increment
-- `texts_sent`, and it refuses unless `email_opened_at is not null`. Nothing has
-- ever written that column, so the function has never once returned true and the
-- Text button has never once been usable.
--
-- A reply is a STRONGER signal than an open, not a weaker one. An open can be an
-- image proxy; a reply is a person typing. So the rule the Rules of Engagement
-- tab is reaching for — "only text somebody who has shown interest" — is better
-- served by this than by the thing it asked for.
--
-- `email_opened_at` IS DELIBERATELY LEFT IN PLACE AND UNUSED. Dropping a column
-- is not reversible and somebody may yet wire an honest open signal to it — but
-- if they do, it must be labelled "guessed" and it must NOT be put back in this
-- gate. The comment on the column says so, in the database, where the next
-- person will actually read it.
comment on column public.admin_leads.email_opened_at is
  'UNUSED ON PURPOSE (Aug 27 2026). Nothing writes this. Gmail has no recipient-side open signal; only a tracking pixel gives one, and that number is loaded by Apple Mail for everybody and proxied by Google, so it is not a measurement. The one-text gate runs on first_reply_at in BOTH places it exists: admin_lead_claim_text() here, and textGate() in lib/sales-rules.js which draws the button. (For a few hours on Aug 27 this comment said nothing read the column while textGate still did, so the rule was live in the database and dead in the browser.) If anyone ever fills this column, label the number GUESSED and never mix it with the measured ones.';

create or replace function public.admin_lead_claim_text(p_lead uuid, p_max int default 1)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated int;
begin
  if not public.admin_is_member() then
    raise exception 'not authorized';
  end if;
  update public.admin_leads
    set texts_sent = coalesce(texts_sent, 0) + 1,
        last_text_at = now()
    where id = p_lead
      and coalesce(texts_sent, 0) < p_max
      -- THE CHANGED LINE. Was `email_opened_at is not null`, which nothing has
      -- ever written, so this function could never return true. A reply is the
      -- signal we can actually measure — see the note above this function.
      and first_reply_at is not null
      -- AND THE ROW-LEVEL LOCK, added Aug 27 with 0020. This function is
      -- `security definer`, so it writes past RLS: without this line a rep could
      -- spend another rep's one text on their lead by calling the function
      -- directly. The claim-text gate exists to protect our phone numbers; it
      -- should not be a hole in the row lock at the same time.
      and (public.admin_is_admin() or owner_id = auth.uid() or owner_id is null);
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

revoke execute on function public.admin_lead_claim_text(uuid, int) from anon, public;
grant execute on function public.admin_lead_claim_text(uuid, int) to authenticated;

-- ============================================================
-- 5. AFTER RUNNING THIS
-- ============================================================
--   1. Nothing back-fills. `first_out_at`, `first_reply_at` and the two lead
--      columns start filling from the next email sent and the next reply read.
--      Back-filling from the mailbox would mean dating today's read as if it
--      were the day the mail arrived, and the Overview tiles say the window they
--      cover — a back-fill would make that sentence false.
--   2. The reply-rate tiles read "0 of 0" until real mail moves through. That is
--      the true answer and it says so; it is not the same as "nobody replies".
--   3. Existing Gmail connections keep working. The first server-side read of
--      each one encrypts its token and clears the plaintext. Verify with:
--        select email_address,
--               (refresh_token is null) as plaintext_cleared,
--               (refresh_token_enc is not null) as encrypted
--          from public.admin_gmail_accounts;
--      Both true on every row means the move is done. VAULT_KEY has to be set in
--      Vercel for that to happen at all — with no key the server keeps using the
--      plaintext and says so in the log rather than losing anybody's mailbox.
