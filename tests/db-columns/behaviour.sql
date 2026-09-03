\set ON_ERROR_STOP on
set client_min_messages = notice;
do $$ begin
  begin
    insert into public.admin_reminders (owner_id, body, due_at, link_type, link_id)
    values ('11111111-1111-1111-1111-111111111111','Follow up on the email: x', now()+interval '3 days','email',gen_random_uuid());
    raise exception 'FAIL: email was accepted BEFORE 0031 — the bug did not exist';
  exception when check_violation then
    raise notice '  ok   BEFORE 0031: a follow-up on an email is refused (this is the bug Ryder never saw)';
  end;
end $$;
\i :mig
insert into public.admin_reminders (owner_id, body, due_at, link_type, link_id)
values ('11111111-1111-1111-1111-111111111111','Follow up on the email: x', now()+interval '3 days','email',gen_random_uuid());
do $$ begin raise notice '  ok   AFTER 0031: it saves'; end $$;
insert into public.admin_reminders (owner_id, body, due_at, link_type)
values ('11111111-1111-1111-1111-111111111111','a note one', now(),'note');
insert into public.admin_reminders (owner_id, body, due_at, link_type)
values ('11111111-1111-1111-1111-111111111111','a lead one', now(),'lead');
insert into public.admin_reminders (owner_id, body, due_at, link_type)
values ('11111111-1111-1111-1111-111111111111','no link', now(), null);
do $$ begin raise notice '  ok   every value any migration ever allowed still saves, and null still saves'; end $$;
do $$ begin
  begin
    insert into public.admin_reminders (owner_id, body, due_at, link_type)
    values ('11111111-1111-1111-1111-111111111111','nonsense', now(),'banana');
    raise exception 'FAIL: the constraint now accepts anything';
  exception when check_violation then
    raise notice '  ok   ...and nothing else does — it was widened, not removed';
  end;
end $$;
\i :mig
do $$ begin raise notice '  ok   a second run changes nothing'; end $$;
\echo 'ALL 0031 CHECKS PASSED'
