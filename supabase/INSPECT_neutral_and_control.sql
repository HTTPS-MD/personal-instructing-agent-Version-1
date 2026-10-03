-- ============================================================================
-- INSPECT_neutral_and_control.sql  --  READ-ONLY. Run BEFORE migration 0038.
-- ============================================================================
-- Shows who the Neutral/Control policy change touches. It changes nothing: the
-- whole script runs in a read-only transaction. Paste the result sets back to
-- the project owner; docs/neutral-control-handling-plan.md says what each means.
-- ============================================================================
begin read only;

-- 1. Every group value in use (spot spellings the rule does not know).
select coalesce(group_type, '(null)') as group_type, count(*) as students
  from public.profiles
 where lower(trim(coalesce(role, 'student'))) = 'student'
 group by 1 order by 2 desc;

-- 2. Existing NEUTRAL records, one row each. None of these is changed by 0038.
select p.email, p.full_name, p.section, p.status,
       p.is_ocean_done, p.current_stage, p.is_in_game,
       p.selected_character,
       (p.pre_test_score is not null)  as has_pre_test,
       (p.post_test_score is not null) as has_post_test,
       t.tutoring_time                 as tutoring_seconds,
       t.last_heartbeat_timestamp
  from public.profiles p
  left join public.student_stage_time t on t.student_email = p.email
 where lower(trim(coalesce(p.group_type, ''))) = 'neutral'
 order by p.section nulls last, p.email;

-- 3. The same, summarised: where the neutral students are and how far they got.
select coalesce(section, '(none)') as section,
       count(*)                                              as neutral_students,
       count(*) filter (where is_ocean_done)                 as ocean_done,
       count(*) filter (where current_stage = 'Tutoring Dashboard' or is_in_game) as in_or_past_dashboard,
       count(*) filter (where selected_character = 'pia-neutral') as persona_pia_neutral,
       count(*) filter (where selected_character is null)    as no_persona
  from public.profiles
 where lower(trim(coalesce(group_type, ''))) = 'neutral'
 group by 1 order by 1;

-- 4. CONTROL students the new rule would lock out of the Tutoring Dashboard
--    who are there already, or have tutoring time on record.
select p.email, p.full_name, p.section, p.current_stage, p.is_in_game,
       t.tutoring_time as tutoring_seconds, t.last_heartbeat_timestamp
  from public.profiles p
  left join public.student_stage_time t on t.student_email = p.email
 where lower(trim(coalesce(p.group_type, ''))) = 'control'
   and (p.current_stage in ('Tutoring Dashboard', 'Character Selection')
        or coalesce(p.is_in_game, false)
        or coalesce(t.tutoring_time, 0) > 0)
 order by p.section nulls last, p.email;

-- 5. Who already holds the Neutral PERSONA, by group (free-choice picks and
--    assigned students). These are valid under the new policy and untouched.
select coalesce(group_type, '(null)') as group_type, count(*) as with_pia_neutral
  from public.profiles
 where selected_character = 'pia-neutral'
 group by 1 order by 2 desc;

-- 6. Any CHECK constraint on profiles.group_type (the migration adds none, but
--    a live one could reject a value the console offers).
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'public.profiles'::regclass and contype = 'c'
   and pg_get_constraintdef(oid) ilike '%group_type%';

-- 7. EVERY function that writes profiles.current_stage, and whether it defers to
--    the stage rule or checks the group. A function with updates_stage = true,
--    calls_stage_rule = false and checks_control = false is a path that can put
--    a Control student into the Tutoring Dashboard (0038's trigger
--    trg_pia_control_stage_guard blocks it regardless; this tells you which).
with f as (
  select p.oid, p.proname, p.prosecdef,
         case when p.prokind = 'f' then pg_get_functiondef(p.oid) end as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
)
select f.oid::regprocedure                       as signature,
       f.prosecdef                               as security_definer,
       f.def ~* 'current_stage\s*='              as updates_stage,
       f.def ~ 'pia_can_enter_stage'             as calls_stage_rule,
       f.def ~* 'group_type'                     as mentions_group_type,
       f.def ~* 'control'                        as checks_control
  from f
 where f.def ~* 'current_stage\s*='
    or f.proname in ('pia_can_enter_stage', 'submit_ocean_results', 'set_student_stage',
                     'admin_grant_stage', 'admin_grant_stage__inner', 'admin_revoke_stage')
 order by f.proname;

-- 8. THE definition of admin_grant_stage__inner, in full (the file the
--    repository does not have). Send this text back.
select p.oid::regprocedure as signature, pg_get_functiondef(p.oid) as definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('admin_grant_stage__inner', 'admin_grant_stage');

-- 9. Triggers on profiles (to see anything already acting on current_stage).
select tgname, pg_get_triggerdef(oid) as definition
  from pg_trigger
 where tgrelid = 'public.profiles'::regclass and not tgisinternal
 order by tgname;

rollback;
