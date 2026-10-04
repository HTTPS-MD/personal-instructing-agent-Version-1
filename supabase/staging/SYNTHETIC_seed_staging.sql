-- STAGING ONLY. Synthetic data for synthetic.student@example.com. No real student data.
-- Session ...0001: 8 correct answers, 10 s apart, no hints  -> expect 'outstanding'
-- Session ...0002: 7 wrong answers with a hint              -> expect 'struggling'
-- Session ...0004: a single answer                           -> expect 'average' (default, ML not called)
begin;

insert into public.profiles(email, role, group_type, is_ocean_done, selected_character, full_name)
values ('synthetic.student@example.com', 'student', 'Assigned', true, 'pia-open', 'Synthetic Student');

insert into public.step_events(session_id, student_email, problem_id, step_index, stage, submitted, outcome, happened_at)
select '10000000-0000-0000-0000-000000000001', 'synthetic.student@example.com', 'qb-' || (g/2 + 1), g % 2, 'work', '1',
       case when g % 2 = 1 then 'question_done' else 'step_done' end,
       now() - interval '10 minutes' + g * interval '10 seconds'
  from generate_series(0, 7) g;

insert into public.step_events(session_id, student_email, problem_id, step_index, stage, submitted, outcome, happened_at)
select '20000000-0000-0000-0000-000000000002', 'synthetic.student@example.com', 'qb-1', 0, 'work', '9',
       case when g % 2 = 0 then 'wrong' else 'format_error' end,
       now() - interval '10 minutes' + g * interval '20 seconds'
  from generate_series(0, 6) g;
insert into public.step_hints(session_id, student_email, problem_id, step_index, tier, tiers_total, taken_at)
values ('20000000-0000-0000-0000-000000000002', 'synthetic.student@example.com', 'qb-1', 0, 1, 3, now() - interval '9 minutes');

insert into public.step_events(session_id, student_email, problem_id, step_index, stage, submitted, outcome)
values ('40000000-0000-0000-0000-000000000004', 'synthetic.student@example.com', 'qb-1', 0, 'work', '1', 'step_done');

commit;
