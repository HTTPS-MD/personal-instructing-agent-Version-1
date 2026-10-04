-- Scratch-only test of 0047 (hints never give the answer). Run after run_chain.sh and 0045-0047.
\set ON_ERROR_STOP on
begin;
do $$
declare t text; ans text[] := array['140', '140'];
begin
  assert pia_mask_answers('0.4 * 350 = 140', ans) = '0.4 * 350 = ___', 'worked result masked: '||pia_mask_answers('0.4 * 350 = 140', ans);
  assert pia_mask_answers('So the answer is 140.', ans) = 'So the answer is ___.', 'answer is';
  assert pia_mask_answers('The result: 140', ans) = 'The result: ___', 'result:';
  assert pia_mask_answers('0.40 * 350 = 140.0', ans) = '0.40 * 350 = ___', 'equal value, other format: '||pia_mask_answers('0.40 * 350 = 140.0', ans);
  assert pia_mask_answers('Multiply 0.4 by 350', ans) = 'Multiply 0.4 by 350', 'guidance untouched';
  assert pia_mask_answers('Work out 0.4 * 350, then type the result.', ans) = 'Work out 0.4 * 350, then type the result.', 'no number after "result"';
  assert pia_mask_answers('Find 25% of 100', array['25','25']) = 'Find 25% of 100', 'a given equal to the answer is kept';
  assert pia_mask_answers('0.25 * 100 = 25%', array['25%','25%']) = '0.25 * 100 = ___%', 'percent answer';
  assert pia_mask_answers('40 / 100 = 0.4', array['0.4','140']) = '40 / 100 = ___', 'step answer masked';
  assert pia_mask_answers('40 / 100 = 0.4', array['140','140']) = '40 / 100 = 0.4', 'an earlier step result is not hidden when it is not this answer';
  assert pia_mask_answers('1,400 = 1,400', array['1400']) = '1,400 = ___', 'thousands separator';
  assert pia_mask_answers(null, ans) = '', 'null text';
  assert pia_mask_answers('x = 5', null) = 'x = 5', 'no answers';
  raise notice '0047 mask assertions OK';
end $$;
-- end to end: the hint a student receives is masked, the stored hint is not changed
insert into profiles(email, full_name, role, group_type, is_ocean_done, selected_character, parental_consent, student_assent) values
 ('k1@t.test','K','student','assigned',true,'pia-open',true,true);
insert into question_bank(difficulty, question, final_answer, hint) values
 ('EASY', 'What is 40% of 350?', '140',
  '{"defaultHint":"d","steps":[{"prompt":"p1","answer":"0.4","hint1":"Divide the percentage by 100.","hint2":"40 / 100","hint3":"40 / 100 = 0.4"},{"prompt":"p2","answer":"140","hint1":"Multiply.","hint2":"0.4 * 350","hint3":"0.4 * 350 = 140"}]}');
create function pg_temp.as_user(p text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims', json_build_object('email', p)::text, true); execute 'set local role authenticated'; end $$;
do $$
declare s jsonb; sid uuid; q jsonb; d jsonb; pid text;
begin
  perform pg_temp.as_user('k1@t.test');
  s := public.resume_or_start_game_session(); sid := (s->>'session_id')::uuid;
  q := public.serve_next_step_question(sid); pid := q->>'problem_id';
  d := public.check_step_answer(sid, pid, '9'); d := public.check_step_answer(sid, pid, '8');
  d := public.consume_step_hint(sid, pid); assert d->'hint'->>'text' = 'Divide the percentage by 100.', 'hint 1 unchanged';
  d := public.consume_step_hint(sid, pid); assert d->'hint'->>'text' = '40 / 100', 'hint 2 unchanged';
  d := public.consume_step_hint(sid, pid);
  assert d->'hint'->>'text' = '40 / 100 = ___', 'hint 3 of step 1 masked: '||(d->'hint')::text;
  assert d::text !~ '0\.4"', 'the step answer is not in the reply';
  reset role;
  assert (select hint from question_bank where question = 'What is 40% of 350?') like '%0.4 * 350 = 140%', 'the stored hint is untouched';
  raise notice '0047 end-to-end assertions OK';
end $$;
rollback;
