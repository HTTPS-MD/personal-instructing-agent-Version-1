-- READ-ONLY. Run in the Supabase SQL Editor BEFORE and AFTER 0043. Changes nothing.
-- 1) The real columns of the four tables (tutoring_attempts must NOT list created_at).
select table_name, string_agg(column_name, ', ' order by ordinal_position) as columns
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('tutoring_attempts', 'step_events', 'step_states', 'game_windows')
 group by table_name order by table_name;

-- 2) Does the function still reference the missing column? (true before 0043, false after)
select pg_get_functiondef('public.pia_admin_tutorial_report(text)'::regprocedure) like '%t.created_at%'
       as still_uses_created_at;

-- 3) Completed questions that 0043 will count: attempts that have a question_done event.
select (select count(*) from public.tutoring_attempts where problem_id like 'qb-%') as attempts,
       (select count(distinct (session_id, student_email, problem_id)) from public.step_events
         where outcome = 'question_done') as questions_with_done_event,
       (select count(*) from public.game_windows) as windows;
