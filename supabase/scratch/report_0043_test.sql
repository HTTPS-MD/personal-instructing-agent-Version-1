-- Scratch-only test of pia_admin_tutorial_report after 0043 (never run on a live database).
-- Seeds: s1 = one session, 3 game windows (2nd after a Try again), 4 finished questions;
--        s2 = student with no game records. Then checks the report as admin, student and teacher.
\set ON_ERROR_STOP on
begin;
insert into public.profiles(email, role, group_type) values
  ('admin@x.test','admin',null), ('s1@x.test','student','Assigned'), ('s2@x.test','student','Assigned'), ('t@x.test','teacher',null);
insert into public.game_windows(session_id, student_email, window_no, started_at, limit_seconds, deadline_at, ended_at, ended_reason) values
  ('11111111-1111-1111-1111-111111111111','s1@x.test',1, now()-interval '3 hours', 600, now()-interval '3 hours'+interval '10 minutes', now()-interval '3 hours'+interval '10 minutes','expired'),
  ('11111111-1111-1111-1111-111111111111','s1@x.test',2, now()-interval '2 hours', 600, now()-interval '2 hours'+interval '10 minutes', now()-interval '2 hours'+interval '10 minutes','expired'),
  ('11111111-1111-1111-1111-111111111111','s1@x.test',3, now()-interval '5 minutes', 600, now()+interval '5 minutes', null, null);
-- q1,q2 finish in window 1 (q1 clean, q2 had an error); q3 in window 2; q4 in window 3 (active)
insert into public.tutoring_attempts(session_id, student_email, problem_id, problem_number, level_before, level_after, attempts_used, hints_used, time_taken_ms, is_correct, classification) values
  ('11111111-1111-1111-1111-111111111111','s1@x.test','qb-1',1,1,1,1,0,20000,true,'smooth'),
  ('11111111-1111-1111-1111-111111111111','s1@x.test','qb-2',2,1,1,2,1,40000,false,'struggling'),
  ('11111111-1111-1111-1111-111111111111','s1@x.test','qb-3',3,2,2,1,0,30000,true,'smooth'),
  ('11111111-1111-1111-1111-111111111111','s1@x.test','qb-4',4,2,2,1,0,10000,true,'smooth');
insert into public.step_events(session_id, student_email, problem_id, step_index, stage, submitted, outcome, happened_at) values
  ('11111111-1111-1111-1111-111111111111','s1@x.test','qb-1',0,'work','1','question_done', now()-interval '3 hours'+interval '2 minutes'),
  ('11111111-1111-1111-1111-111111111111','s1@x.test','qb-2',0,'work','9','wrong',          now()-interval '3 hours'+interval '3 minutes'),
  ('11111111-1111-1111-1111-111111111111','s1@x.test','qb-2',0,'work','1','question_done', now()-interval '3 hours'+interval '4 minutes'),
  ('11111111-1111-1111-1111-111111111111','s1@x.test','qb-3',0,'work','1','question_done', now()-interval '2 hours'+interval '1 minute'),
  ('11111111-1111-1111-1111-111111111111','s1@x.test','qb-4',0,'work','1','question_done', now()-interval '1 minute');
insert into public.step_hints(session_id, student_email, problem_id, step_index, tier, tiers_total, taken_at) values
  ('11111111-1111-1111-1111-111111111111','s1@x.test','qb-2',0,1,3, now()-interval '3 hours'+interval '3 minutes');

create temp table res(label text, j jsonb);
grant all on res to authenticated;
select set_config('request.jwt.claims','{"email":"admin@x.test"}',true);
set local role authenticated;
insert into res select 's1', public.pia_admin_tutorial_report('s1@x.test');
insert into res select 's2', public.pia_admin_tutorial_report('s2@x.test');
reset role;
do $$
declare r jsonb; h jsonb;
begin
  select j into r from res where label='s1';
  assert (r->'summary'->>'sessions')::int = 3, 'windows';
  assert (r->'summary'->>'completed_questions')::int = 4, 'completed '||(r->'summary'->>'completed_questions');
  assert (r->'summary'->>'clean_questions')::int = 3, 'clean';
  assert (r->'summary'->>'errors')::int = 1, 'errors';
  assert (r->'summary'->>'hints')::int = 1, 'hints';
  assert (r->'summary'->>'accuracy_percent')::numeric = 75.0, 'accuracy';
  assert (r->'summary'->>'avg_speed_seconds')::numeric = 25.0, 'speed';
  -- history is newest first: window 3, 2, 1 with 1, 1, 2 questions
  assert (r->'history'->0->>'window_no')::int = 3 and (r->'history'->0->>'completed_questions')::int = 1 and r->'history'->0->>'status'='active', 'w3';
  assert (r->'history'->1->>'window_no')::int = 2 and (r->'history'->1->>'completed_questions')::int = 1, 'w2';
  assert (r->'history'->2->>'window_no')::int = 1 and (r->'history'->2->>'completed_questions')::int = 2
     and (r->'history'->2->>'errors')::int = 1 and (r->'history'->2->>'hints')::int = 1, 'w1';
  select j into r from res where label='s2';
  assert (r->'summary'->>'sessions')::int = 0 and (r->'summary'->>'completed_questions')::int = 0
     and r->'summary'->'avg_speed_seconds' = 'null'::jsonb and r->'history' = '[]'::jsonb, 'empty student';
  raise notice 'report assertions OK';
end $$;
-- access control
do $$ declare p text; begin
  foreach p in array array['s1@x.test','t@x.test'] loop
    perform set_config('request.jwt.claims', json_build_object('email', p)::text, true);
    execute 'set local role authenticated';
    begin
      perform public.pia_admin_tutorial_report('s1@x.test');
      raise exception 'NOT BLOCKED for %', p;
    exception when insufficient_privilege then raise notice 'blocked OK: %', p; end;
    execute 'reset role';
  end loop;
end $$;
-- no game records were changed by reading
select (select count(*) from public.tutoring_attempts) attempts, (select count(*) from public.step_events) events, (select count(*) from public.game_windows) windows;
rollback;
