-- Scratch-only test of get_session_history (0046). Run after run_chain.sh and 0045/0046.
\set ON_ERROR_STOP on
begin;
insert into profiles(email, full_name, role, group_type, is_ocean_done, selected_character, parental_consent, student_assent) values
 ('h1@t.test','H One','student','assigned',true,'pia-open',true,true),
 ('h2@t.test','H Two','student','assigned',true,'pia-open',true,true);
insert into question_bank(difficulty, question, final_answer, hint)
select 'EASY', 'What is '||p||'% of 50?', (p*50/100)::text,
  '{"defaultHint":"d","steps":[{"prompt":"p1","answer":"'||(p/100.0)||'","hint1":"concept","hint2":"setup","hint3":"worked"},{"prompt":"p2","answer":"'||(p*50/100)||'","hint1":"multiply"}]}'
from (values (10),(20),(30),(40)) v(p);
create function pg_temp.as_user(p text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims', json_build_object('email', p)::text, true); execute 'set local role authenticated'; end $$;
do $$
declare s jsonb; sid uuid; q jsonb; d jsonb; h jsonb; pid text; pct int; i int; sid2 uuid;
begin
  perform pg_temp.as_user('h1@t.test');
  s := public.resume_or_start_game_session(); sid := (s->>'session_id')::uuid;
  h := public.get_session_history(sid);
  assert h = jsonb_build_object('solved', '[]'::jsonb, 'errors', '[]'::jsonb, 'hints_total', 0), 'empty at the start: '||h::text;
  -- solve two questions, with some wrong entries and a hint on the way
  for i in 1..2 loop
    q := public.serve_next_step_question(sid); pid := q->>'problem_id'; pct := substring(q->>'question' from '(\d+)%')::int;
    d := public.check_step_answer(sid, pid, 'x'||i);
    d := public.check_step_answer(sid, pid, 'y'||i);
    d := public.consume_step_hint(sid, pid);
    d := public.check_step_answer(sid, pid, (pct/100.0)::text);
    d := public.check_step_answer(sid, pid, (pct*50/100)::text);
    assert d->>'outcome' = 'question_done', 'solved '||i||': '||d::text;
    d := public.finish_step_question(sid, pid);
    if d->'offer' is not null and d->'offer' <> 'null'::jsonb then d := public.respond_topic_offer(sid, pid, false); end if;
  end loop;
  h := public.get_session_history(sid);
  assert jsonb_array_length(h->'solved') = 2, 'two solved: '||h::text;
  assert (h->'solved'->0->>'number')::int = 1 and (h->'solved'->1->>'number')::int = 2, 'in order';
  assert jsonb_array_length(h->'solved'->0->'steps') = 2, 'both steps kept';
  assert h->'solved'->0->'steps'->0->>'title' = 'Step 1: Conversion' and h->'solved'->0->'steps'->1->>'title' = 'Step 2: Multiplication', 'step titles: '||(h->'solved'->0->'steps')::text;
  assert (h->'solved'->0->'steps'->0->>'text') is not null, 'the working is kept';
  assert jsonb_array_length(h->'errors') = 4, 'four wrong entries: '||(h->'errors')::text;
  assert h->'errors'->>0 = 'Step 1: Error on "x1"' and h->'errors'->>3 = 'Step 1: Error on "y2"', 'oldest first: '||(h->'errors')::text;
  assert (h->>'hints_total')::int = 2, 'two hints';
  assert h::text !~ 'final_answer|"answer"', 'no answer key in the history';
  -- only the last five errors are kept, oldest first
  q := public.serve_next_step_question(sid); pid := q->>'problem_id';
  for i in 1..6 loop d := public.check_step_answer(sid, pid, 'z'||i); end loop;
  h := public.get_session_history(sid);
  assert jsonb_array_length(h->'errors') = 5 and h->'errors'->>4 = 'Step 1: Error on "z6"' and h->'errors'->>0 = 'Step 1: Error on "z2"', 'last five: '||(h->'errors')::text;
  -- another student's session id reveals nothing
  perform pg_temp.as_user('h2@t.test');
  h := public.get_session_history(sid);
  assert h = jsonb_build_object('solved', '[]'::jsonb, 'errors', '[]'::jsonb, 'hints_total', 0), 'cross-student read';
  -- anon is refused
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  execute 'set local role anon';
  begin perform public.get_session_history(sid); raise exception 'anon NOT BLOCKED';
  exception when insufficient_privilege then null; end;
  reset role;
  raise notice '0046 assertions OK';
end $$;
rollback;
