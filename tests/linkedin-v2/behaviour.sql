-- What 0053 does on a real Postgres. Each line prints PASS or FAIL.
\set ON_ERROR_STOP 0
\pset tuples_only on
create or replace function pg_temp.t(name text, ok boolean) returns text language sql as $$ select case when ok then 'PASS ' else 'FAIL ' end || name $$;

-- 1. a sales-page sign-up row is allowed, and pays like any row
insert into public.linkedin_clients (id, status, source, company, contact_email) values ('00000000-0000-4000-8000-000000000001', 'signup', 'sales_page', 'Signup Co', 'a@x.com');
select pg_temp.t('signup status allowed', exists (select 1 from public.linkedin_clients where status = 'signup'));
update public.linkedin_clients set paid_at = now() where id = '00000000-0000-4000-8000-000000000001';
select pg_temp.t('a paid sign-up moves to stage paid (0052 trigger)', (select flow_stage from public.linkedin_clients where id = '00000000-0000-4000-8000-000000000001') = 'paid');
select pg_temp.t('no 48 h clock until the form is in', (select build_due_at from public.linkedin_clients where id = '00000000-0000-4000-8000-000000000001') is null);

-- 2. merging onto the form row starts the clock there
insert into public.linkedin_clients (id, status, company, contact_email, submitted_at) values ('00000000-0000-4000-8000-000000000002', 'submitted', 'Signup Co', 'a@x.com', now());
update public.linkedin_clients set status = 'merged', merged_into = '00000000-0000-4000-8000-000000000002' where id = '00000000-0000-4000-8000-000000000001';
update public.linkedin_clients set paid_at = now(), paid_source = 'stripe_checkout' where id = '00000000-0000-4000-8000-000000000002';
select pg_temp.t('merged status allowed', (select status from public.linkedin_clients where id = '00000000-0000-4000-8000-000000000001') = 'merged');
select pg_temp.t('form row: paid + 48 h clock set', (select flow_stage = 'paid' and build_due_at is not null from public.linkedin_clients where id = '00000000-0000-4000-8000-000000000002'));

-- 3. nonsense is still refused
do $$ begin insert into public.linkedin_clients (status) values ('bogus'); raise notice 'FAIL bogus status accepted'; exception when check_violation then raise notice 'PASS bogus status refused'; end $$;
do $$ begin update public.linkedin_clients set code_method = 'pigeon' where id = '00000000-0000-4000-8000-000000000002'; raise notice 'FAIL bad code_method accepted'; exception when check_violation then raise notice 'PASS bad code_method refused'; end $$;
update public.linkedin_clients set code_method = 'whatsapp', login_email = 'a@x.com', login_location = 'Birmingham, AL', whatsapp = '+12055550100', login_details_at = now() where id = '00000000-0000-4000-8000-000000000002';
select pg_temp.t('login details save', (select code_method = 'whatsapp' and login_location is not null from public.linkedin_clients where id = '00000000-0000-4000-8000-000000000002'));
select pg_temp.t('there is NO password column', not exists (select 1 from information_schema.columns where table_name = 'linkedin_clients' and column_name ilike '%password%' and column_name not in ('password_received_at','password_received_by')));

-- 4. prospects
insert into public.linkedin_prospects (li_client_id, name, accepted_on) values ('00000000-0000-4000-8000-000000000002', 'Jane Smith', current_date);
do $$ begin insert into public.linkedin_prospects (li_client_id, name, accepted_on) values ('00000000-0000-4000-8000-000000000002', 'JANE SMITH', current_date); raise notice 'FAIL duplicate prospect accepted'; exception when unique_violation then raise notice 'PASS same person twice refused (case-insensitive)'; end $$;
do $$ begin update public.linkedin_prospects set last_step = 5; raise notice 'FAIL step 5 accepted'; exception when check_violation then raise notice 'PASS step above 4 refused'; end $$;

-- 5. who may write: console logins read prospects, never write them
set test.admin = 'yes';
set role authenticated;
select pg_temp.t('admin login can read prospects', (select count(*) from public.linkedin_prospects) = 1);
do $$ begin insert into public.linkedin_prospects (li_client_id, name, accepted_on) values ('00000000-0000-4000-8000-000000000002', 'X', current_date); raise notice 'FAIL a console login wrote a prospect directly'; exception when insufficient_privilege then raise notice 'PASS console logins cannot write prospects directly (API only)'; end $$;
do $$ begin update public.linkedin_clients set login_email = 'evil@x.com' where id = '00000000-0000-4000-8000-000000000002'; raise notice 'FAIL a console login wrote login_email directly'; exception when insufficient_privilege then raise notice 'PASS console logins cannot write login details directly (API only)'; end $$;
reset role;
set test.admin = 'no';
set role authenticated;
select pg_temp.t('a non-admin login sees no prospects', (select count(*) from public.linkedin_prospects) = 0);
reset role;

-- 6. settings
select pg_temp.t('4 new settings present', (select count(*) from public.linkedin_settings where key in ('julie_whatsapp','password_method','code_alert_email','signup_notify')) = 4);
select pg_temp.t('the password setting says never by email', (select value::text from public.linkedin_settings where key = 'password_method') ilike '%don''t email%');
delete from public.linkedin_clients where id = '00000000-0000-4000-8000-000000000002';
select pg_temp.t('deleting a client removes its prospects', (select count(*) from public.linkedin_prospects) = 0);
select pg_temp.t('deleting the form row leaves the merged sign-up with merged_into null', (select merged_into is null from public.linkedin_clients where id = '00000000-0000-4000-8000-000000000001'));
