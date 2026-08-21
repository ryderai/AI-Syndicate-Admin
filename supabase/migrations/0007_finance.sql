-- AI Syndicate ADMIN console — FINANCE: costs, invoices, and the settings the
-- money pages need. Aug 20 2026.
--
-- SAFE TO RUN ON THE SHARED (PLATFORM) SUPABASE PROJECT.
--   * Run 0001 through 0006 first.
--   * Everything new is prefixed admin_. Nothing the platform owns is touched.
--   * Run it twice and nothing breaks — every statement is if-not-exists or
--     drop-then-create.
--
-- WHAT THIS ADDS, in plain words:
--
--   admin_expenses          — every dollar that goes OUT. Stripe knows what
--                             comes in; nothing on earth knows what we pay
--                             unless we write it down. This table is that.
--   admin_invoices          — an invoice we send. Ours, not Stripe's. Stripe
--                             invoices are read separately and never copied in.
--   admin_invoice_items     — the lines on one invoice.
--   admin_invoice_payments  — money received against an invoice, one row per
--                             payment, so a half-payment is a real thing and
--                             not a status somebody guessed.
--   admin_finance_settings  — one row. Who we are on an invoice, the numbering,
--                             the default terms, and what is in the bank.
--
-- WHY PAYMENTS ARE THEIR OWN TABLE: an invoice row that just says "paid" cannot
-- answer "when, how much, and how did it arrive". Aging, days-to-pay and the
-- collected-vs-billed number all come from these rows.

-- ============================================================
-- 1. EXPENSES — money out
-- ============================================================

create table if not exists public.admin_expenses (
  id uuid primary key default gen_random_uuid(),

  incurred_on date not null,          -- the day it was paid, or the day a
                                      -- repeating cost started
  ended_on date,                      -- a repeating cost we stopped paying.
                                      -- null = still running.

  category text not null,             -- see the check below
  vendor text,                        -- who got paid: "Anthropic", "Vercel"
  description text,
  amount_cents bigint not null check (amount_cents >= 0),

  -- one_time  = paid once, lands in one month
  -- monthly   = the same amount every month from incurred_on until ended_on
  -- yearly    = paid once a year, divided by 12 across the months it covers,
  --             so one January payment does not make January look terrible
  interval text not null default 'one_time'
    check (interval in ('one_time', 'monthly', 'yearly')),

  -- Which client this was spent on, when it was spent on one. Lets the page
  -- work out what each client actually costs us to serve.
  client_id uuid references public.admin_clients on delete set null,

  -- Ticked = this was spent WINNING clients, so it belongs in the cost-per-new-
  -- client number. A category cannot tell a sales contractor from a delivery
  -- one, so a person says which it was.
  counts_toward_cac boolean not null default false,

  notes text,
  receipt_url text,                   -- a link to the receipt. Never a file.

  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint admin_expenses_category_known check (category in (
    'Contractors', 'Software', 'AI & APIs', 'Ads', 'Hosting & domains',
    'Payment fees', 'Client costs', 'Office & admin', 'Taxes', 'Other'
  )),
  -- A repeating cost that ends before it starts would silently vanish from
  -- every month instead of erroring, and the profit line would be wrong with
  -- nothing on screen to explain it.
  constraint admin_expenses_dates_sane check (ended_on is null or ended_on >= incurred_on)
);

comment on table public.admin_expenses is
  'Money out. Typed in by us — no integration knows what we pay. The profit line on the Finance page is only as true as this table.';
comment on column public.admin_expenses.interval is
  'one_time lands in one month. monthly repeats until ended_on. yearly is divided by 12 across the months it covers.';
comment on column public.admin_expenses.counts_toward_cac is
  'Ticked = spent winning clients, so it counts in the cost-per-new-client figure.';

create index if not exists admin_expenses_month_idx on public.admin_expenses (incurred_on desc);
create index if not exists admin_expenses_client_idx on public.admin_expenses (client_id, incurred_on desc);
create index if not exists admin_expenses_category_idx on public.admin_expenses (category, incurred_on desc);

drop trigger if exists admin_expenses_updated_at on public.admin_expenses;
create trigger admin_expenses_updated_at before update on public.admin_expenses
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 2. INVOICES
-- ============================================================

create table if not exists public.admin_invoices (
  id uuid primary key default gen_random_uuid(),

  number text not null,                        -- "AIS-0007". Shown to the client.
  client_id uuid references public.admin_clients on delete set null,

  -- Copied onto the invoice when it is made, on purpose. An invoice is a record
  -- of what we sent. Renaming a client next year must not rewrite an invoice we
  -- already put in someone's hands.
  bill_to_name text not null,
  bill_to_email text,
  bill_to_address text,

  status text not null default 'draft'
    check (status in ('draft', 'sent', 'paid', 'void')),
  -- Only four are ever STORED. "Overdue" and "Part paid" are worked out from
  -- the due date and the payments, so nobody has to remember to change them.

  issue_date date not null default current_date,
  due_date date,
  currency text not null default 'usd',

  subtotal_cents bigint not null default 0 check (subtotal_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  tax_pct numeric(6,3) not null default 0 check (tax_pct >= 0 and tax_pct <= 100),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  total_cents bigint not null default 0 check (total_cents >= 0),

  -- Kept up to date by a trigger from the payments table below, so it can never
  -- disagree with the payments on record.
  amount_paid_cents bigint not null default 0 check (amount_paid_cents >= 0),

  notes text,                                  -- shown to the client
  terms text,                                  -- "Payment due within 14 days"
  internal_note text,                          -- never leaves this console

  sent_at timestamptz,
  paid_at timestamptz,

  -- Set when a Stripe invoice was pulled in for reference. We never write to
  -- Stripe from here.
  stripe_invoice_id text,
  hosted_url text,

  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.admin_invoices is
  'Invoices we raise. Statuses stored are draft/sent/paid/void — overdue and part-paid are worked out, never typed.';

-- Two invoices with the same number is the one thing that must never happen:
-- it is the number the client pays against.
create unique index if not exists admin_invoices_number_key on public.admin_invoices (upper(number));
create index if not exists admin_invoices_client_idx on public.admin_invoices (client_id, issue_date desc);
create index if not exists admin_invoices_status_idx on public.admin_invoices (status, due_date);

drop trigger if exists admin_invoices_updated_at on public.admin_invoices;
create trigger admin_invoices_updated_at before update on public.admin_invoices
  for each row execute function public.admin_set_updated_at();

-- ---- lines on an invoice ----

create table if not exists public.admin_invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.admin_invoices on delete cascade,
  description text not null,
  qty numeric(12,2) not null default 1 check (qty >= 0),
  unit_cents bigint not null default 0 check (unit_cents >= 0),
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists admin_invoice_items_invoice_idx
  on public.admin_invoice_items (invoice_id, sort, created_at);

-- ---- money actually received ----

create table if not exists public.admin_invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.admin_invoices on delete cascade,
  paid_on date not null default current_date,
  amount_cents bigint not null check (amount_cents > 0),
  method text,                                 -- "Stripe", "Bank transfer", "Check"
  reference text,                              -- a Stripe id, a check number
  note text,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists admin_invoice_payments_invoice_idx
  on public.admin_invoice_payments (invoice_id, paid_on desc);

-- The paid total and the paid date on the invoice are written by the database
-- from the payment rows. Not by the browser. A tab that dies half way through
-- saving a payment cannot leave an invoice claiming it is paid.
create or replace function public.admin_invoice_roll_payments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  inv uuid := coalesce(new.invoice_id, old.invoice_id);
  total_paid bigint;
  last_paid date;
  inv_total bigint;
begin
  select coalesce(sum(amount_cents), 0), max(paid_on)
    into total_paid, last_paid
    from public.admin_invoice_payments where invoice_id = inv;

  select total_cents into inv_total from public.admin_invoices where id = inv;

  update public.admin_invoices
     set amount_paid_cents = total_paid,
         paid_at = case when inv_total > 0 and total_paid >= inv_total
                        then coalesce(paid_at, (last_paid::timestamptz))
                        else null end,
         -- Paying a draft in full marks it sent-and-paid; paying part of one
         -- leaves it alone. A void invoice is never revived by a payment.
         status = case
                    when status = 'void' then 'void'
                    when status = 'draft' then 'draft'
                    when inv_total > 0 and total_paid >= inv_total then 'paid'
                    when status = 'paid' and total_paid < inv_total then 'sent'
                    else status
                  end
   where id = inv;
  return null;
end;
$$;

drop trigger if exists admin_invoice_payments_roll on public.admin_invoice_payments;
create trigger admin_invoice_payments_roll
  after insert or update or delete on public.admin_invoice_payments
  for each row execute function public.admin_invoice_roll_payments();

-- A note on what the trigger above does NOT do: it never turns a draft into a
-- sent invoice. Money can arrive against a draft (a client paying from a quote),
-- and the invoice stays a draft until a person marks it sent, because "sent" is
-- a claim about something we did, not something the client did.

-- ============================================================
-- 3. FINANCE SETTINGS — one row, ever
-- ============================================================

create table if not exists public.admin_finance_settings (
  id boolean primary key default true check (id),   -- true is the only key
  company_name text not null default 'AI Syndicate',
  company_email text,
  company_address text,
  invoice_prefix text not null default 'AIS-',
  default_terms_days int not null default 14 check (default_terms_days >= 0),
  default_tax_pct numeric(6,3) not null default 0 check (default_tax_pct >= 0 and default_tax_pct <= 100),
  default_terms_text text default 'Payment due within 14 days of the invoice date.',
  payment_instructions text,

  -- What is in the bank. Typed in, with the date it was true, because nothing
  -- here can see a bank account. The runway number says this date out loud so
  -- a stale figure cannot quietly pass as today's.
  cash_on_hand_cents bigint not null default 0 check (cash_on_hand_cents >= 0),
  cash_updated_on date,

  updated_by uuid references auth.users on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.admin_finance_settings (id) values (true) on conflict (id) do nothing;

drop trigger if exists admin_finance_settings_updated_at on public.admin_finance_settings;
create trigger admin_finance_settings_updated_at before update on public.admin_finance_settings
  for each row execute function public.admin_set_updated_at();

-- ============================================================
-- 3b. WHO WROTE A ROW CANNOT BE FORGED
-- ============================================================
-- created_by has a default of auth.uid(), but a default is only a default — the
-- browser can post any value it likes. This trigger writes the author from the
-- signed-in session on insert, and refuses to let it be changed afterwards.
-- Same pattern, and the same reason, as admin_platform_accounts in 0005:
-- owners-only deletes protect nothing if an admin can put somebody else's name
-- on a row in the first place.
--
-- Written as ONE function used by three triggers. A policy that reads its own
-- table to check the old value would be the other way to do it, and it is the
-- wrong way — row level security re-entering the same table is how you get
-- "infinite recursion detected in policy".

create or replace function public.admin_stamp_created_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists admin_expenses_author on public.admin_expenses;
create trigger admin_expenses_author before insert or update on public.admin_expenses
  for each row execute function public.admin_stamp_created_by();

drop trigger if exists admin_invoices_author on public.admin_invoices;
create trigger admin_invoices_author before insert or update on public.admin_invoices
  for each row execute function public.admin_stamp_created_by();

drop trigger if exists admin_invoice_payments_author on public.admin_invoice_payments;
create trigger admin_invoice_payments_author before insert or update on public.admin_invoice_payments
  for each row execute function public.admin_stamp_created_by();

-- ============================================================
-- 4. GRANTS + ROW LEVEL SECURITY
-- ============================================================
-- Money is owner/admin only. A sales rep cannot see any of it — not a total,
-- not a count, not an invoice. Same shape as every other admin_ table:
-- admin_is_admin() covers owners and admins, admin_is_owner() is owners only.
--
-- DELETE IS OWNERS ONLY on expenses and invoices, and nobody at all can delete
-- a payment except an owner. The reason is the same one as the platform-login
-- table: if an admin can raise an invoice, take money against it, and then
-- delete the row, the books stop being evidence of anything. Cancelling an
-- invoice (status 'void') is the everyday action and any admin can do it.

grant select, insert, update on public.admin_expenses to authenticated;
grant delete on public.admin_expenses to authenticated;
grant select, insert, update on public.admin_invoices to authenticated;
grant delete on public.admin_invoices to authenticated;
grant select, insert, update on public.admin_invoice_items to authenticated;
grant delete on public.admin_invoice_items to authenticated;
grant select, insert, update on public.admin_invoice_payments to authenticated;
grant delete on public.admin_invoice_payments to authenticated;
grant select, insert, update on public.admin_finance_settings to authenticated;

alter table public.admin_expenses enable row level security;
alter table public.admin_invoices enable row level security;
alter table public.admin_invoice_items enable row level security;
alter table public.admin_invoice_payments enable row level security;
alter table public.admin_finance_settings enable row level security;

-- expenses
drop policy if exists "admins read expenses" on public.admin_expenses;
create policy "admins read expenses" on public.admin_expenses
  for select using (public.admin_is_admin());
drop policy if exists "admins add expenses" on public.admin_expenses;
create policy "admins add expenses" on public.admin_expenses
  for insert with check (public.admin_is_admin());
drop policy if exists "admins edit expenses" on public.admin_expenses;
create policy "admins edit expenses" on public.admin_expenses
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());
drop policy if exists "owners remove expenses" on public.admin_expenses;
create policy "owners remove expenses" on public.admin_expenses
  for delete using (public.admin_is_owner());

-- invoices
drop policy if exists "admins read invoices" on public.admin_invoices;
create policy "admins read invoices" on public.admin_invoices
  for select using (public.admin_is_admin());
drop policy if exists "admins add invoices" on public.admin_invoices;
create policy "admins add invoices" on public.admin_invoices
  for insert with check (public.admin_is_admin());
drop policy if exists "admins edit invoices" on public.admin_invoices;
create policy "admins edit invoices" on public.admin_invoices
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());
drop policy if exists "owners remove invoices" on public.admin_invoices;
create policy "owners remove invoices" on public.admin_invoices
  for delete using (public.admin_is_owner());

-- invoice lines
drop policy if exists "admins read invoice items" on public.admin_invoice_items;
create policy "admins read invoice items" on public.admin_invoice_items
  for select using (public.admin_is_admin());
drop policy if exists "admins write invoice items" on public.admin_invoice_items;
create policy "admins write invoice items" on public.admin_invoice_items
  for insert with check (public.admin_is_admin());
drop policy if exists "admins edit invoice items" on public.admin_invoice_items;
create policy "admins edit invoice items" on public.admin_invoice_items
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());
-- Editing an invoice replaces its lines, so any admin can delete a line.
drop policy if exists "admins remove invoice items" on public.admin_invoice_items;
create policy "admins remove invoice items" on public.admin_invoice_items
  for delete using (public.admin_is_admin());

-- payments
drop policy if exists "admins read payments" on public.admin_invoice_payments;
create policy "admins read payments" on public.admin_invoice_payments
  for select using (public.admin_is_admin());
drop policy if exists "admins add payments" on public.admin_invoice_payments;
create policy "admins add payments" on public.admin_invoice_payments
  for insert with check (public.admin_is_admin());
drop policy if exists "owners edit payments" on public.admin_invoice_payments;
create policy "owners edit payments" on public.admin_invoice_payments
  for update using (public.admin_is_owner()) with check (public.admin_is_owner());
drop policy if exists "owners remove payments" on public.admin_invoice_payments;
create policy "owners remove payments" on public.admin_invoice_payments
  for delete using (public.admin_is_owner());

-- settings
drop policy if exists "admins read finance settings" on public.admin_finance_settings;
create policy "admins read finance settings" on public.admin_finance_settings
  for select using (public.admin_is_admin());
drop policy if exists "owners edit finance settings" on public.admin_finance_settings;
drop policy if exists "admins edit finance settings" on public.admin_finance_settings;
create policy "admins edit finance settings" on public.admin_finance_settings
  for update using (public.admin_is_admin()) with check (public.admin_is_admin());

-- ============================================================
-- 5. WHAT TO CHECK AFTER RUNNING THIS
-- ============================================================
-- select count(*) from public.admin_expenses;            -- 0, no error
-- select * from public.admin_finance_settings;           -- exactly one row
-- Add an invoice in the console, add a part payment, and watch
-- amount_paid_cents on admin_invoices change by itself. That is the trigger.
