-- ============================================================
-- 0027 — THE PIPELINE SPEC: one "not a fit" stage, and tags that
--        only hold what a person knows.
--
-- Written Sun 30 Aug 2026, after reading how HubSpot, Salesforce,
-- Pipedrive, Close and Attio structure a pipeline. The reasoning
-- lives in CONTEXT-FOR-AI.md §54 and in the two artifacts Ryder has.
--
-- ****  THIS FILE IS NOT YET RUN.  ****
--
-- SAFE TO RE-RUN. Every statement is idempotent: the constraint is
-- dropped before it is re-added, the stage rewrite only touches rows
-- that still hold the old values, and both tag statements are guarded
-- on what is already there. Running it twice changes nothing the
-- second time.
--
-- IT DELETES NOTHING. No row is removed anywhere in this file. Stages
-- are rewritten in place with their old value recorded on the lead's
-- own timeline; tags are marked inactive so they stop being offered
-- while every tag event ever written stays exactly where it is.
--
-- WHAT MUST HAPPEN FIRST: nothing. The application already treats
-- skip_90 and bad_contact as one outcome with two reasons, and already
-- ignores the derived tags. This migration is what lets the wording
-- catch up with the rule.
-- ============================================================


-- ============================================================
-- 1. skip_90 + bad_contact  ->  not_a_fit
-- ============================================================
-- They were never two outcomes. They are two REASONS for one outcome,
-- and the reason box that Won and Lost have used since Aug 27 already
-- holds a reason properly — where a stage cannot hold the two we have
-- not thought of yet ("wrong kind of business", "asked us to stop").
--
-- ORDER MATTERS: widen the constraint, move the rows, then narrow it.
-- Narrowing first would refuse the very update that makes the rows
-- legal.

alter table public.admin_leads drop constraint if exists admin_leads_stage_check;
alter table public.admin_leads
  add constraint admin_leads_stage_check
  check (stage in (
    'new','researching','contacted','in_conversation','follow_up',
    'meeting','proposal','won','lost','skip_90','bad_contact','reopened',
    'not_a_fit'
  ));

-- The old value goes on the timeline BEFORE the rewrite, so nobody has
-- to guess later which of the two a lead used to be. `where not exists`
-- makes the line idempotent alongside everything else here.
insert into public.admin_lead_activity (lead_id, actor, type, outcome, body)
select l.id,
       coalesce(l.owner_id, (select user_id from public.admin_users where role = 'owner' and active order by created_at limit 1)),
       'status_change',
       l.stage,
       case l.stage
         when 'skip_90' then 'Stage merged into Not a fit. The reason was: their site scores 90 or above.'
         else 'Stage merged into Not a fit. The reason was: the contact details are dead.'
       end
  from public.admin_leads l
 where l.stage in ('skip_90','bad_contact')
   and not exists (
     select 1 from public.admin_lead_activity a
      where a.lead_id = l.id
        and a.type = 'status_change'
        and a.body like 'Stage merged into Not a fit.%'
   );

update public.admin_leads
   set stage = 'not_a_fit'
 where stage in ('skip_90','bad_contact');

-- Now narrow it. The two old values become unwritable, which is the
-- point: there is one "not a fit" from here on.
alter table public.admin_leads drop constraint if exists admin_leads_stage_check;
alter table public.admin_leads
  add constraint admin_leads_stage_check
  check (stage in (
    'new','researching','contacted','in_conversation','follow_up',
    'meeting','proposal','won','lost','reopened','not_a_fit'
  ));

-- `reopened` stays legal and is deliberately NOT rewritten. Nothing can
-- set it any more (it is a derived stage in the app), but rows holding
-- it are real history and rewriting them would be inventing a fact.


-- ============================================================
-- 2. The seventeen derived tags stop being offered
-- ============================================================
-- Every one of these restates a column the sheet already prints, live,
-- from data that cannot drift — while a tag only changes when somebody
-- opens that one lead and presses a button. A stored copy of a live
-- column is a copy that is wrong most of the time.
--
-- INACTIVE, NOT DELETED. `active = false` takes them out of the pickers
-- and the filter menus. Every admin_lead_tag_events row survives, and
-- the history stays readable — that table has no delete path at all, by
-- design, and this migration does not add one.

update public.admin_lead_tags
   set active = false
 where slug in (
   -- restates the stage
   'won','lost','skip-90',
   -- restates the Claim column, and 'cold' measured quiet days by a
   -- different rule than claimState, so the two disagreed on any
   -- re-claimed lead
   'cold','quiet','claim-expiring',
   -- restates the Contacted? column
   'never-touched',
   -- restates the Website column
   'has-website','no-website',
   -- restates the Company size column, using the same four bands AND
   -- the same four labels
   'size-solo','size-small','size-mid','size-large',
   -- restates the Score column, same thresholds
   'unscanned','scored-under-60','scored-60s','scored-80s','scored-90-plus'
 )
   and active;

-- 'hot', 'bounced' and 'imported' are also derived and also come off:
-- first_reply_at, bounced_at and source are columns, and the rule is
-- that nothing derived gets stored twice.
update public.admin_lead_tags
   set active = false
 where slug in ('hot','bounced','imported')
   and active;


-- ============================================================
-- 3. The four that are left are things only a person knows
-- ============================================================
-- This is the line Pipedrive and Attio draw around labels: they sit
-- BESIDE the pipeline, never inside it. Nothing computes these, nothing
-- syncs them, so nothing can go stale.

insert into public.admin_lead_tags (slug, label, color, tag_group, auto_rule, sort, active) values
  ('gatekeeper',   'Gatekeeper',            'orange', 'human', null, 100, true),
  ('wrong-person', 'Wrong person',          'yellow', 'human', null, 101, true),
  ('competitor',   'Competitor already in', 'red',    'human', null, 102, true),
  ('call-later',   'Call back later',       'blue',   'human', null, 103, true)
on conflict (slug) do update
  set label  = excluded.label,
      color  = excluded.color,
      sort   = excluded.sort,
      active = true;
-- `do update` rather than `do nothing` so re-running repairs a tag
-- somebody has since switched off by hand, and so the four cannot drift
-- apart from this file.

-- auto_rule is null on all four ON PURPOSE. A tag with a rule is a tag
-- something will try to keep in sync, and the whole point of these is
-- that only a person sets them.
