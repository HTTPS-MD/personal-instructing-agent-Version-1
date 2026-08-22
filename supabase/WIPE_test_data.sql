-- ============================================================================
-- WIPE PRE-STUDY TEST TELEMETRY
-- ============================================================================
-- Deletes ROWS ONLY. No table, column, constraint, index, policy, or function
-- is touched -- schemas and relationships are untouched.
--
-- Children are deleted before parents so any foreign key stays satisfied.
--
-- SAFETY GUARD: this refuses to run once your real cohort is enrolled. If more
-- than 10 student profiles exist, it aborts and rolls back. That makes the
-- script safe to leave in the repo -- running it by accident on study day
-- cannot destroy real research data.
--
-- Run PREVIEW_test_data.sql first and confirm every row belongs to a test
-- account. This is not reversible.
-- ============================================================================

begin;

do $$
declare
  n_students int;
begin
  select count(*) into n_students
    from public.profiles where lower(trim(coalesce(role,'student'))) = 'student';

  if n_students > 10 then
    raise exception
      'PIA ABORT: % student profiles exist -- this looks like the real cohort, not test data. Nothing was deleted.',
      n_students using errcode = 'P0001';
  end if;

  raise notice 'PIA: % student profile(s) present -- proceeding.', n_students;
end;
$$;

-- Children first.
delete from public.hint_consumptions;
delete from public.problem_serves;
delete from public.math_attempt_log;
delete from public.tutoring_attempts;
delete from public.ocean_submissions;

-- Clear the live-view fields on profiles so the admin dashboard does not show
-- ghost "Active Game" state left over from testing.
update public.profiles
   set is_in_game = false,
       current_problem = 0,
       current_difficulty = null,
       hints_used = 0,
       consecutive_correct = 0
 where is_in_game is true
    or coalesce(current_problem, 0) <> 0
    or coalesce(hints_used, 0) <> 0
    or coalesce(consecutive_correct, 0) <> 0;

commit;


-- Confirm everything is at zero.
select 'tutoring_attempts' as t, count(*) from public.tutoring_attempts
union all select 'math_attempt_log',  count(*) from public.math_attempt_log
union all select 'problem_serves',    count(*) from public.problem_serves
union all select 'hint_consumptions', count(*) from public.hint_consumptions
union all select 'ocean_submissions', count(*) from public.ocean_submissions
order by t;
