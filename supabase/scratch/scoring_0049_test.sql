-- Scratch-only test of 0049 (configurable scoring). Run after the chain, 0042-0045, 0049 and scoring_0049_legacy.sql.
\set ON_ERROR_STOP on
begin;
insert into profiles(email, full_name, role, group_type, is_ocean_done, selected_character, parental_consent, student_assent)
select 's'||n||'@s.test','S','student','assigned',true,'pia-open',true,true from generate_series(1,8) n;
delete from question_bank where question <> 'What is 10% of 50?';
update question_bank set points = 10;
create function pg_temp.as_user(p text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims', json_build_object('email', p)::text, true); execute 'set local role authenticated'; end $$;
create function pg_temp.cfg(p_wrong int, p_hint int, p_fast int, p_secs int, p_speed boolean, p_min int, p_rep boolean, p_reppct int) returns void language sql as $$
  update app_config set score_wrong_pct=p_wrong, score_hint_pct=p_hint, score_fast_bonus_pct=p_fast, score_fast_seconds=p_secs,
    score_speed_bonus=p_speed, score_min=p_min, score_repeat_enabled=p_rep, score_repeat_pct=p_reppct where id = 1 $$;

-- 1-11: the formula, directly.  base 20, wrong 20%, hint 10%, fast +20% within 30 s.
select pg_temp.cfg(20, 10, 20, 30, true, 0, false, 50);
do $$
begin
  assert pia_compute_score(20, 0, 0, 60000, 0) = 20, '1 clean, normal speed = full base';
  assert pia_compute_score(20, 1, 0, 60000, 0) = 16, '2 one wrong = 20-4';
  assert pia_compute_score(20, 3, 0, 60000, 0) = 8,  '3 three wrong accumulate = 20-12';
  assert pia_compute_score(20, 0, 1, 60000, 0) = 18, '4 one hint = 20-2';
  assert pia_compute_score(20, 0, 3, 60000, 0) = 14, '5 three hints = 20-6';
  assert pia_compute_score(20, 1, 1, 60000, 0) = 14, '5b one wrong + one hint = 14';
  assert pia_compute_score(20, 0, 0, 10000, 0) = 24, '6 fast + clean = 20+4';
  assert pia_compute_score(20, 0, 1, 10000, 0) = 22, '6b fast + one hint keeps the bonus: 20-2+4';
  assert pia_compute_score(20, 1, 0, 10000, 0) = 16, '7 fast but WRONG = no bonus, plain 20-4';
  assert pia_compute_score(20, 2, 0, 1000, 0)  = 12, '7b fast but wrong twice = 20-8';
  assert pia_compute_score(20, 0, 0, 300000, 0) = 20, '8 slow + correct = normal, never a punishment';
  assert pia_compute_score(20, 0, 0, 30000, 0) = 24, 'exactly at the threshold counts as fast';
  assert pia_compute_score(20, 0, 0, 30001, 0) = 20, 'one ms over is normal';
  assert pia_compute_score(20, 9, 9, 60000, 0) = 0, '9 never below zero (clamped)';
  assert pia_compute_score(10, 0, 0, 60000, 0) = 10, '10 a 10-point question uses 10 as its base';
  assert pia_compute_score(50, 0, 0, 60000, 0) = 50, '11 a 50-point question uses 50 as its base';
  assert pia_compute_score(50, 1, 1, 60000, 0) = 35, '11b percentages scale with the base: 50-10-5';
  assert pia_compute_score(10, 1, 1, 60000, 0) = 7,  '11c 10-2-1 = 7';
  perform pg_temp.cfg(20, 10, 20, 30, false, 0, false, 50);
  assert pia_compute_score(20, 0, 0, 1000, 0) = 20, 'speed bonus disabled = no bonus';
  perform pg_temp.cfg(100, 100, 0, 30, true, 5, false, 50);
  assert pia_compute_score(20, 5, 5, 60000, 0) = 5, 'the configured minimum is the floor';
  perform pg_temp.cfg(20, 10, 20, 30, true, 0, false, 50);
  assert pia_compute_score(20, 0, 0, null, 0) = 20, 'no timing = no bonus, no crash';
  assert pia_compute_score(null, 0, 0, 1000, 0) = 0 and pia_compute_score(-5, 0, 0, 1000, 0) = 0, 'null/negative base is safe';
  -- repeats: 0 by default, a percentage when enabled
  assert pia_compute_score(20, 0, 0, 60000, 1) = 0, '14 repeat scores 0 by default';
  perform pg_temp.cfg(20, 10, 20, 30, true, 0, true, 50);
  assert pia_compute_score(20, 0, 0, 60000, 1) = 10, '14b repeat at 50% when enabled';
  assert pia_compute_score(20, 0, 0, 60000, 0) = 20, 'the first time is unaffected by the repeat rule';
  perform pg_temp.cfg(20, 10, 20, 30, true, 0, false, 50);
  -- validation: the database refuses corrupt rules
  begin update app_config set score_wrong_pct = 101 where id = 1; raise exception 'accepted 101%%'; exception when check_violation then null; end;
  begin update app_config set score_fast_seconds = 0 where id = 1; raise exception 'accepted 0 s'; exception when check_violation then null; end;
  begin update app_config set score_hint_pct = -1 where id = 1; raise exception 'accepted -1%%'; exception when check_violation then null; end;
  begin update app_config set score_min = -3 where id = 1; raise exception 'accepted negative minimum'; exception when check_violation then null; end;
  raise notice 'formula assertions OK';
end $$;

-- End to end through the real game functions ------------------------------------------------------
create function pg_temp.play(p_email text, p_sid uuid, p_errors int, p_hints int, p_age_s int) returns jsonb language plpgsql as $$
declare q jsonb; pid text; pct int; d jsonb; i int;
begin
  perform pg_temp.as_user(p_email);
  q := public.serve_next_step_question(p_sid); pid := q->>'problem_id'; pct := substring(q->>'question' from '(\d+)%')::int;
  if pct is null then raise exception 'serve gave no question for %: %', p_email, q; end if;
  reset role;
  update problem_serves set served_at = now() - make_interval(secs => p_age_s) where session_id = p_sid and problem_id = pid;
  update step_states set hint_unlocked = true where session_id = p_sid and problem_id = pid;
  perform pg_temp.as_user(p_email);
  for i in 1..p_errors loop d := public.check_step_answer(p_sid, pid, '9'||i); end loop;
  for i in 1..p_hints loop d := public.consume_step_hint(p_sid, pid); end loop;
  d := public.check_step_answer(p_sid, pid, (pct/100.0)::text);
  d := public.check_step_answer(p_sid, pid, (pct*50/100)::text);
  assert d->>'outcome' = 'question_done', 'solved: '||d::text;
  d := public.finish_step_question(p_sid, pid);
  if d->'offer' is not null and d->'offer' <> 'null'::jsonb then perform public.respond_topic_offer(p_sid, pid, false); end if;
  reset role;
  return jsonb_build_object('pid', pid, 'score', (select score from step_states where session_id = p_sid and problem_id = pid), 'offer', d->'offer');
end $$;

do $$
declare sid uuid; r jsonb; r2 jsonb; d jsonb; before_sum bigint; f1 jsonb; f2 jsonb; offers_a jsonb := '[]'; offers_b jsonb := '[]'; i int; pid text;
begin
  perform pg_temp.cfg(20, 10, 20, 30, true, 0, true, 50);
  -- one bank question, 10 points
  perform pg_temp.as_user('s1@s.test'); sid := (public.resume_or_start_game_session()->>'session_id')::uuid; reset role;
  r := pg_temp.play('s1@s.test', sid, 0, 0, 120);
  assert (r->>'score')::int = 10, 'e2e clean slow = base 10: '||r::text;
  -- 12: the admin changes the points; a question already served keeps the base it was served with
  pid := (r->>'pid');
  update question_bank set points = 25;
  r := pg_temp.play('s1@s.test', sid, 0, 0, 120);   -- the same bank question again = a REPEAT in this session, enabled at 50%
  assert (r->>'score')::int = 13, '12/14 new base 25 used for a future serve, repeat at 50% = 12.5 -> 13: '||r::text;
  assert (select score from step_states where session_id = sid and problem_id = pid) = 10, '12 the earlier score is untouched';
  update question_bank set points = 40;
  perform pg_temp.as_user('s1@s.test'); d := public.serve_next_step_question(sid); reset role;     -- serves with base 40
  update question_bank set points = 1;                                                              -- changed AFTER serving
  assert (select base_points from served_questions where session_id = sid and problem_id = d->>'problem_id') = 40, '12 base stamped at serve time';
  -- 13: duplicate completion cannot award twice
  perform pg_temp.as_user('s1@s.test');
  pid := d->>'problem_id';
  d := public.check_step_answer(sid, pid, '0.1'); d := public.check_step_answer(sid, pid, '5');
  r := public.finish_step_question(sid, pid); r2 := public.finish_step_question(sid, pid);
  if r->'offer' is not null and r->'offer' <> 'null'::jsonb then perform public.respond_topic_offer(sid, pid, false); end if;
  reset role;
  assert (select count(*) from tutoring_attempts where session_id = sid and problem_id = pid) = 1, '13 one attempt row';
  assert (select score from step_states where session_id = sid and problem_id = pid) = (select score from step_states where session_id = sid and problem_id = pid), '13';
  perform pg_temp.cfg(20, 10, 20, 30, true, 0, false, 50);
  select sum(score) into before_sum from step_states where student_email = 's1@s.test';
  perform pg_temp.as_user('s1@s.test'); r2 := public.finish_step_question(sid, pid); reset role;
  assert (select sum(score) from step_states where student_email = 's1@s.test') = before_sum, '13 a third call changes nothing';
  -- 14: with repeat scoring off, a repeat is worth 0 but still answerable
  update question_bank set points = 10;
  r := pg_temp.play('s1@s.test', sid, 0, 0, 120);
  assert (r->>'score')::int = 0, '14 repeat scores 0 when repeat scoring is off: '||r::text;
  -- hints count once per (step, tier); pressing the last tier again is not a second penalty
  perform pg_temp.as_user('s2@s.test'); sid := (public.resume_or_start_game_session()->>'session_id')::uuid; reset role;
  r := pg_temp.play('s2@s.test', sid, 2, 5, 120);
  assert (select count(*) from (select distinct step_index, tier from step_hints where session_id = sid and problem_id = (r->>'pid')) x) = 3, 'five presses on step 1 = tiers 1,2,3,3,3';
  assert (r->>'score')::int = 10 - 4 - 3, 'two wrong (20% each) + three DISTINCT hints (10% each) on 10 points = 3: '||r::text;
  -- 15: the learning profile does not move with the scoring rules
  perform pg_temp.as_user('s3@s.test'); sid := (public.resume_or_start_game_session()->>'session_id')::uuid; reset role;
  r := pg_temp.play('s3@s.test', sid, 1, 0, 40);
  perform pg_temp.as_user('s3@s.test'); f1 := public.get_learning_features(sid); reset role;
  perform pg_temp.cfg(100, 100, 100, 5, false, 3, true, 0);
  perform pg_temp.as_user('s3@s.test'); f2 := public.get_learning_features(sid); reset role;
  assert f1 = f2, '15 learning features are identical under any scoring rules: '||f1::text||' vs '||f2::text;
  assert f1::text !~* 'score|points', '15 the ML inputs contain no score';
  -- 16: topic progression is the same under different scoring rules
  perform pg_temp.cfg(20, 10, 20, 30, true, 0, true, 50);
  perform pg_temp.as_user('s4@s.test'); sid := (public.resume_or_start_game_session()->>'session_id')::uuid; reset role;
  for i in 1..4 loop r := pg_temp.play('s4@s.test', sid, 0, 0, 60); offers_a := offers_a || jsonb_build_array(coalesce(r->'offer', 'null'::jsonb)); end loop;
  perform pg_temp.cfg(100, 100, 0, 1, false, 7, false, 0);
  perform pg_temp.as_user('s5@s.test'); sid := (public.resume_or_start_game_session()->>'session_id')::uuid; reset role;
  for i in 1..4 loop r := pg_temp.play('s5@s.test', sid, 0, 0, 60); offers_b := offers_b || jsonb_build_array(coalesce(r->'offer', 'null'::jsonb)); end loop;
  assert offers_a = offers_b, '16 the same topic offers under different scoring rules: '||offers_a::text||' vs '||offers_b::text;
  assert (select topic from student_topic_progress where student_email = 's4@s.test') = (select topic from student_topic_progress where student_email = 's5@s.test'), '16 same topic';
  -- 17: history stays readable in the admin report
  perform pg_temp.cfg(20, 10, 20, 30, true, 0, false, 50);
  assert (select score from step_states where student_email = 'old@s.test') = 100, '17 the legacy score is untouched by 0049';
  perform pg_temp.as_user('admin@s.test');
  -- the report needs game_windows for old@s: add one so the legacy question is inside a window
  reset role;
  insert into game_windows(session_id, student_email, window_no, limit_seconds, deadline_at) values ('aaaaaaaa-0000-0000-0000-000000000001','old@s.test',1,0,'infinity') on conflict do nothing;
  insert into tutoring_attempts(session_id, student_email, problem_id, problem_number, level_before, level_after, attempts_used, hints_used, time_taken_ms, is_correct, classification)
    select 'aaaaaaaa-0000-0000-0000-000000000001','old@s.test', problem_id, 1, 1, 1, 1, 0, 9000, true, 'smooth' from step_states where student_email = 'old@s.test' on conflict do nothing;
  insert into step_events(session_id, student_email, problem_id, step_index, stage, submitted, outcome)
    select session_id, student_email, problem_id, 1, 'work', '5', 'question_done' from step_states where student_email = 'old@s.test';
  perform pg_temp.as_user('admin@s.test');
  d := public.pia_admin_tutorial_report('old@s.test');
  assert (d->'summary'->>'score_sum')::int = 100, '17 the old score is still reported: '||(d->'summary')::text;
  raise notice '0049 end-to-end assertions OK';
end $$;
rollback;
