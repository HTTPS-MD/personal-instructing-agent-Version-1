-- ============================================================================
-- What is actually in the telemetry tables, and who does it belong to?
-- READ-ONLY. Run this BEFORE the wipe and read the output.
-- ============================================================================

-- (1) Rows per table, per student.
select 'tutoring_attempts' as source, student_email, count(*) as rows
  from public.tutoring_attempts group by student_email
union all
select 'math_attempt_log', student_email, count(*)
  from public.math_attempt_log group by student_email
union all
select 'problem_serves', student_email, count(*)
  from public.problem_serves group by student_email
union all
select 'hint_consumptions', student_email, count(*)
  from public.hint_consumptions group by student_email
union all
select 'ocean_submissions', email, count(*)
  from public.ocean_submissions group by email
order by source, student_email;
