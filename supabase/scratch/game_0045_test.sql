-- Scratch-only test of 0045 (tutoring closes at a time the admin sets). Run after run_chain.sh and 0045.
\set ON_ERROR_STOP on
begin;
insert into profiles(email, full_name, role, group_type, is_ocean_done, selected_character, parental_consent, student_assent) values
 ('c1@t.test','C One','student','assigned',true,'pia-open',true,true),
 ('c2@t.test','C Two','student','assigned',true,'pia-open',true,true);
insert into question_bank(difficulty, question, final_answer, hint)
select 'EASY', 'What is '||p||'% of 50?', (p*50/100)::text,
  '{"defaultHint":"d","steps":[{"prompt":"p1","answer":"'||(p/100.0)||'","hint1":"concept","hint2":"setup","hint3":"worked"},{"prompt":"p2","answer":"'||(p*50/100)||'","hint1":"multiply"}]}'
from (values (10),(20),(30),(40)) v(p);

create function pg_temp.as_user(p text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims', json_build_object('email', p)::text, true); execute 'set local role authenticated'; end $$;

do $$
declare
  s jsonb; sid uuid; q jsonb; d jsonb; pid text; pid2 text; n_events int; n_events2 int; w record; step0 int;
begin
  -- 1. open by default (no closing time set)
  update app_config set game_closes_at = null where id = 1;
  perform pg_temp.as_user('c1@t.test');
  assert (public.tutoring_status()->>'closed') = 'false', 'open by default';
  s := public.resume_or_start_game_session(); sid := (s->>'session_id')::uuid;
  q := public.serve_next_step_question(sid); pid := q->>'problem_id';
  assert (q->'clock'->>'expired') = 'false' and (q->'clock'->>'closed') = 'false', 'clock open: '||(q->'clock')::text;
  assert q::text !~ '"answer"|final_answer', 'no key in the question';
  d := public.check_step_answer(sid, pid, '999');
  assert d->>'outcome' = 'wrong', 'a wrong answer is judged normally while open';
  step0 := (d->'state'->>'current_step')::int;

  -- 2. the admin sets a closing time in the PAST: closed for everyone
  reset role;
  select count(*) into n_events from public.step_events where student_email = 'c1@t.test';
  update app_config set game_closes_at = now() - interval '1 minute' where id = 1;
  perform pg_temp.as_user('c1@t.test');
  assert (public.tutoring_status()->>'closed') = 'true', 'closed';
  d := public.check_step_answer(sid, pid, '0.1');
  assert d->>'outcome' = 'time_expired', 'answer refused when closed: '||d::text;
  d := public.consume_step_hint(sid, pid);
  assert d->'hint' is null or (d->'hint') = 'null'::jsonb, 'no hint when closed: '||d::text;
  d := public.restart_after_expiry(sid);
  assert (d->>'closed') = 'true' and (d->>'restarted') = 'false', 'Try again does not restart: '||d::text;
  -- the student quits and comes back: still the same session, still closed
  s := public.resume_or_start_game_session();
  assert (s->>'session_id')::uuid = sid and (s->>'resumed') = 'true', 'same session after coming back';
  q := public.serve_next_step_question(sid);
  assert (q->'clock'->>'expired') = 'true', 'still closed after coming back';
  reset role;
  select count(*) into n_events2 from public.step_events where student_email = 'c1@t.test';
  assert n_events2 = n_events, 'no answer was recorded while closed';
  select * into w from public.game_windows where session_id = sid order by window_no desc limit 1;
  assert w.ended_at is not null and w.ended_reason = 'closed' and w.window_no = 1, 'window ended by the closing time: '||w::text;

  -- 3. the admin moves the closing time to the future: open again, same question, no restart
  update app_config set game_closes_at = now() + interval '2 hours' where id = 1;
  perform pg_temp.as_user('c1@t.test');
  assert (public.tutoring_status()->>'closed') = 'false', 'open again';
  q := public.serve_next_step_question(sid);
  assert q->>'problem_id' = pid and (q->>'current_step')::int = step0, 'same question, same step after reopening: '||q::text;
  assert (q->'clock'->>'expired') = 'false', 'clock open again';
  d := public.check_step_answer(sid, pid, ((substring(q->>'question' from '(\d+)%')::int) / 100.0)::text);
  assert d->>'outcome' in ('step_done', 'needs_final'), 'answers are accepted again: '||d::text;
  reset role;
  select count(*) into n_events from public.game_windows where session_id = sid;
  assert n_events = 2, 'a second window was opened';
  select * into w from public.game_windows where session_id = sid order by window_no desc limit 1;
  assert w.window_no = 2 and w.ended_at is null, 'window 2 is live';

  -- 4. never closed again: setting NULL keeps it open; the other student is never affected
  update app_config set game_closes_at = null where id = 1;
  perform pg_temp.as_user('c2@t.test');
  assert (public.tutoring_status()->>'closed') = 'false', 'open with no closing time';

  -- 5. access control: no anon, and tutoring_status needs a student the game admits
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  execute 'set local role anon';
  begin perform public.tutoring_status(); raise exception 'anon NOT BLOCKED';
  exception when insufficient_privilege then null; end;
  reset role;
  raise notice '0045 assertions OK';
end $$;
rollback;
