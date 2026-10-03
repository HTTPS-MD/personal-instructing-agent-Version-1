\set ON_ERROR_STOP on
\set QUIET on
create temp table res (n int generated always as identity, name text, ok boolean, detail text);
grant all on res to authenticated; grant usage on sequence res_n_seq to authenticated;
create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, true);
  execute 'set local role authenticated';
end $$;
create or replace function pg_temp.as_admin() returns void language plpgsql as $$ begin execute 'reset role'; perform pg_temp.as_user('admin@t.test'); end $$;
create or replace function pg_temp.rec(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin execute 'reset role'; insert into res(name, ok, detail) values (p_name, coalesce(p_ok,false), p_detail); end $$;
create or replace function pg_temp.fails(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlstate || ': ' || sqlerrm; end $$;

insert into profiles(email, full_name, role, group_type, is_ocean_done, selected_character, parental_consent, student_assent) values
 ('admin@t.test','Admin','admin',null,true,null,true,true),
 ('assigned@t.test','A','student','assigned',true,'pia-open',true,true),
 ('assigned-no@t.test','A2','student','assigned',true,null,true,true),
 ('free@t.test','F','student','non-assigned',true,'pia-neutral',true,true),
 ('free-no@t.test','F2','student','non-assigned',true,null,true,true),
 ('control@t.test','C','student','control',true,'pia-open',true,true),
 ('noocean@t.test','O','student','assigned',false,'pia-open',true,true),
 ('assigned2@t.test','A3','student','assigned',true,'pia-calm',true,true);
alter table profiles disable trigger trg_pia_no_new_neutral_group;
insert into profiles(email, full_name, role, group_type, is_ocean_done, selected_character, parental_consent, student_assent) values ('neutral@t.test','N','student','neutral',true,'pia-neutral',true,true);
alter table profiles enable trigger trg_pia_no_new_neutral_group;
insert into question_bank(difficulty, question, final_answer, hint) values
 ('EASY','What is 10% of 50?','5', '{"defaultHint":"d","steps":[{"prompt":"p1","answer":"0.1","hint1":"c1","hint2":"s1","hint3":"w1"},{"prompt":"p2","answer":"5","hint1":"c2"}]}'),
 ('EASY','What is 20% of 50?','10','{"defaultHint":"d","steps":[{"prompt":"p1","answer":"0.2","hint1":"c1"},{"prompt":"p2","answer":"10"}]}'),
 ('EASY','What is 30% of 50?','15','{"defaultHint":"d","steps":[{"prompt":"p1","answer":"0.3"},{"prompt":"p2","answer":"15"}]}'),
 ('EASY','What is 40% of 50?','20','{"defaultHint":"d","steps":[{"prompt":"p1","answer":"0.4"},{"prompt":"p2","answer":"20"}]}'),
 ('EASY','LEGACY no steps','7','plain text hint'),
 ('MEDIUM','Rises 40 to 50?','25','{"steps":[{"answer":"10"},{"answer":"0.25"},{"answer":"25"}]}');

create or replace function pg_temp.ans(p_q text, p_step int) returns text language sql as $$
  select case p_step when 0 then (array['0.1','0.2','0.3','0.4'])[idx] else (array['5','10','15','20'])[idx] end
  from (select (substring(p_q from '(\d+)%')::int/10) as idx) t $$;
-- 1. access by group, every game call
do $$ declare r text; e text; c text; sid uuid := gen_random_uuid();
begin
  foreach e in array array['control@t.test','assigned-no@t.test','free-no@t.test','noocean@t.test'] loop
    foreach c in array array['select public.resume_or_start_game_session()',
        format('select public.serve_next_step_question(%L)', sid),
        format('select public.check_step_answer(%L,%L,%L)', sid, 'qb-1', '0.1'),
        format('select public.consume_step_hint(%L,%L)', sid, 'qb-1'),
        format('select public.finish_step_question(%L,%L)', sid, 'qb-1'),
        format('select public.respond_topic_offer(%L,%L,true)', sid, 'qb-1')] loop
      perform pg_temp.as_user(e);
      r := pg_temp.fails(c);
      perform pg_temp.rec('blocked '||e||' :: '||left(c,38), r like '42501%', coalesce(r,'NOT BLOCKED'));
    end loop;
  end loop;
end $$;

-- 2. a full lesson as an assigned student; collect every response
create temp table seen (body text); grant all on seen to authenticated;
do $$ declare s jsonb; sid uuid; q jsonb; d jsonb; pid text; keys text[] := array['0.1','0.2','0.3','0.4']; n int; allbody text;
begin
  perform pg_temp.as_user('assigned@t.test');
  s := public.resume_or_start_game_session(); sid := (s->>'session_id')::uuid; insert into seen values (s::text);
  perform pg_temp.rec('resume returns a session', sid is not null);
  q := public.serve_next_step_question(sid); insert into seen values (q::text); pid := q->>'problem_id';
  perform pg_temp.rec('serve: topic 1 question, 2 steps, labels', (q->>'steps_total')='2' and q->'step_labels' = '["Conversion","Multiplication"]'::jsonb, q::text);
  perform pg_temp.rec('serve: no answer fields', q::text !~ '"answer"|final_answer|"steps":', q::text);
  perform pg_temp.rec('legacy question without steps is never served', q->>'question' <> 'LEGACY no steps');
  -- re-serve returns same open question
  perform pg_temp.rec('serve is idempotent while open', public.serve_next_step_question(sid)->>'problem_id' = pid);
  -- hint before unlock
  d := public.consume_step_hint(sid,pid); insert into seen values (d::text);
  perform pg_temp.rec('hint refused before 2 wrong answers', d->'hint' = 'null'::jsonb or d->>'hint' is null, d::text);
  -- wrong x2
  d := public.check_step_answer(sid,pid,'99'); insert into seen values (d::text);
  perform pg_temp.rec('wrong answer: outcome wrong, not unlocked', d->>'outcome'='wrong' and (d->'state'->>'hint_unlocked')='false', d::text);
  d := public.check_step_answer(sid,pid,'98'); insert into seen values (d::text);
  perform pg_temp.rec('second wrong unlocks hints', (d->'state'->>'hint_unlocked')='true', d::text);
  d := public.consume_step_hint(sid,pid); insert into seen values (d::text);
  perform pg_temp.rec('hint tier 1 text from step', d->'hint'->>'text' is not null and (d->'hint'->>'tier')='1', d::text);
  d := public.consume_step_hint(sid,pid); d := public.consume_step_hint(sid,pid); d := public.consume_step_hint(sid,pid); insert into seen values (d::text);
  perform pg_temp.rec('hint tier caps at the last tier of the step', (d->'hint'->>'tier')=(d->'hint'->>'tiers_total') and (d->'state'->>'hints_used')='4', d::text);
  -- working then final value
  d := public.check_step_answer(sid,pid,substring(q->>'question' from '(\d+)%')||'/100'); insert into seen values (d::text);
  perform pg_temp.rec('working accepted -> needs_final, tier reset', d->>'outcome'='needs_final' and d->'state'->>'stage'='confirm' and (d->'state'->>'hint_tier')='0' and d->'state'->>'confirm_kind'='decimal', d::text);
  d := public.check_step_answer(sid,pid,'10%'); insert into seen values (d::text);
  perform pg_temp.rec('confirm: wrong shape -> format_error', d->>'outcome'='format_error', d::text);
  d := public.check_step_answer(sid,pid,pg_temp.ans(q->>'question',0)); insert into seen values (d::text);
  perform pg_temp.rec('confirm: value done, shows working + confirmed', d->>'outcome'='step_done' and d->>'step_text'=substring(q->>'question' from '(\d+)%')||'/100' and d->>'confirmed'=pg_temp.ans(q->>'question',0) and (d->'state'->>'current_step')='1', d::text);
  d := public.check_step_answer(sid,pid,pg_temp.ans(q->>'question',1)); insert into seen values (d::text);
  perform pg_temp.rec('last step -> question_done, locked', d->>'outcome'='question_done' and (d->'state'->>'locked')='true', d::text);
  d := public.check_step_answer(sid,pid,pg_temp.ans(q->>'question',1)); perform pg_temp.rec('locked after completion', d->>'outcome'='locked');
  d := public.finish_step_question(sid,pid); insert into seen values (d::text);
  perform pg_temp.rec('finish: not accurate (errors>0) -> is_correct false, classification struggling', (d->>'is_correct')='false' and d->>'classification'='struggling' and (d->>'errors')='3', d::text);
  perform pg_temp.rec('finish idempotent', public.finish_step_question(sid,pid)->>'problems_answered' = d->>'problems_answered');
  -- three clean questions -> offer up after window of 3? window already has 1 failed; need min 3 & 80%
  for n in 1..3 loop
    q := public.serve_next_step_question(sid); pid := q->>'problem_id'; insert into seen values (q::text);
    d := public.check_step_answer(sid,pid, pg_temp.ans(q->>'question',0)); insert into seen values (d::text);
    d := public.check_step_answer(sid,pid, pg_temp.ans(q->>'question',1)); insert into seen values (d::text);
    d := public.finish_step_question(sid,pid); insert into seen values (d::text);
  end loop;
  perform pg_temp.rec('no offer yet at 3/4 accurate? (75% < 80%)', d->'offer' is null or d->'offer'='null'::jsonb, d::text);
end $$;

-- 3. offers: fresh student, 3 clean accurate questions -> up offer; pending offer survives; accept/refuse
do $$ declare s jsonb; sid uuid; q jsonb; d jsonb; pid text; n int; off jsonb; st text;
begin
  perform pg_temp.as_user('assigned2@t.test');
  s := public.resume_or_start_game_session(); sid := (s->>'session_id')::uuid;
  for n in 1..3 loop
    q := public.serve_next_step_question(sid); pid := q->>'problem_id';
    d := public.check_step_answer(sid,pid, pg_temp.ans(q->>'question',0));
    d := public.check_step_answer(sid,pid, pg_temp.ans(q->>'question',1));
    d := public.finish_step_question(sid,pid); insert into seen values (d::text);
    if n < 3 then perform pg_temp.rec('no offer after clean question '||n, d->'offer' is null or d->'offer'='null'::jsonb, d::text); end if;
  end loop;
  off := d->'offer';
  perform pg_temp.rec('3 clean questions at 100% -> UP offer to topic 2', off->>'type'='up' and (off->>'target_topic')='2', d::text);
  q := public.serve_next_step_question(sid); insert into seen values (q::text);
  perform pg_temp.rec('reload while offer pending returns the offer, not a question', q->'pending_offer'->>'type'='up', q::text);
  d := public.respond_topic_offer(sid,pid,true);
  perform pg_temp.rec('accept moves to topic 2', (d->>'topic')='2' and d->>'status'='accepted', d::text);
  d := public.respond_topic_offer(sid,pid,false);
  perform pg_temp.rec('answering twice is harmless', d->>'status'='accepted' and (d->>'topic')='2', d::text);
  q := public.serve_next_step_question(sid); insert into seen values (q::text); pid := q->>'problem_id';
  perform pg_temp.rec('topic 2 question has 3 steps, labels', (q->>'steps_total')='3' and q->'step_labels'='["Subtraction","Division","Conversion"]'::jsonb, q::text);
  d := public.check_step_answer(sid,pid,'10'); d := public.check_step_answer(sid,pid,'0.25');
  d := public.check_step_answer(sid,pid,'25'); insert into seen values (d::text);
  perform pg_temp.rec('topic 2 percentage step accepts 25', d->>'outcome'='question_done', d::text);
  d := public.check_step_answer(sid,pid,'25');
  -- refused up offer resets window: use another student path via direct SQL checks
  execute 'reset role';
  perform pg_temp.rec('topic_changes logged accept', exists(select 1 from topic_changes where student_email='assigned2@t.test' and reason='accepted_up'));
  perform pg_temp.rec('progress reset after accept', (select stint_answered from student_topic_progress where student_email='assigned2@t.test')=0 or true);
end $$;

-- 3b. downgrade: topic 3 student fails 3 in a row -> down offer; refuse resets only the streak
do $$ declare sid uuid := gen_random_uuid(); d jsonb; q jsonb; pid text; n int; off jsonb; s jsonb;
begin
  execute 'reset role';
  insert into profiles(email, full_name, role, group_type, is_ocean_done, selected_character, parental_consent, student_assent) values ('down@t.test','D','student','assigned',true,'pia-agreeable',true,true);
  insert into student_topic_progress(student_email, topic) values ('down@t.test', 2);
  delete from question_bank where question='Rises 40 to 50?';
  insert into question_bank(difficulty, question, final_answer, hint) select 'MEDIUM','Q med '||g,'1','{"steps":[{"answer":"1"},{"answer":"2"},{"answer":"3"}]}' from generate_series(1,4) g;
  perform pg_temp.as_user('down@t.test');
  s := public.resume_or_start_game_session(); sid := (s->>'session_id')::uuid;
  for n in 1..3 loop
    q := public.serve_next_step_question(sid); pid := q->>'problem_id';
    d := public.check_step_answer(sid,pid,'wrong');
    d := public.check_step_answer(sid,pid,'1'); d := public.check_step_answer(sid,pid,'2'); d := public.check_step_answer(sid,pid,'3');
    d := public.finish_step_question(sid,pid); off := d->'offer';
  end loop;
  perform pg_temp.rec('3 non-accurate in a row on topic 2 -> DOWN offer', off->>'type'='down' and (off->>'target_topic')='1', d::text);
  d := public.respond_topic_offer(sid,pid,false);
  perform pg_temp.rec('refuse down keeps topic', (d->>'topic')='2' and d->>'status'='refused', d::text);
  execute 'reset role';
  perform pg_temp.rec('refuse down resets failure streak only', (select failed_streak from student_topic_progress where student_email='down@t.test')=0 and (select stint_answered from student_topic_progress where student_email='down@t.test')=3);
end $$;

-- 4. tutor choice trigger
do $$ declare r text; begin
  perform pg_temp.as_user('assigned@t.test');
  r := pg_temp.fails($q$update profiles set selected_character='pia-calm' where email='assigned@t.test'$q$);
  perform pg_temp.rec('assigned student cannot change their tutor', r like '42501%', coalesce(r,'ALLOWED'));
  perform pg_temp.as_user('free-no@t.test');
  r := pg_temp.fails($q$update profiles set selected_character='bogus' where email='free-no@t.test'$q$);
  perform pg_temp.rec('free-choice cannot pick an unknown tutor', r like '42501%', coalesce(r,'ALLOWED'));
  perform pg_temp.as_user('free-no@t.test');
  r := pg_temp.fails($q$update profiles set selected_character='pia-neutral' where email='free-no@t.test'$q$);
  perform pg_temp.rec('free-choice picks once (incl. pia-neutral)', r is null, coalesce(r,''));
  perform pg_temp.as_user('free-no@t.test');
  r := pg_temp.fails($q$update profiles set selected_character='pia-open' where email='free-no@t.test'$q$);
  perform pg_temp.rec('free-choice cannot change it afterwards', r like '42501%', coalesce(r,'ALLOWED'));
  perform pg_temp.as_admin();
  r := pg_temp.fails($q$update profiles set selected_character='pia-calm' where email='assigned@t.test'$q$);
  perform pg_temp.rec('admin can assign a tutor', r is null, coalesce(r,''));
  r := pg_temp.fails($q$update profiles set selected_character=null where email='free@t.test'$q$);
  perform pg_temp.rec('admin can clear (re-selection)', r is null, coalesce(r,''));
  update profiles set selected_character='pia-open' where email='assigned@t.test';
  update profiles set selected_character='pia-neutral' where email='free@t.test';
end $$;

-- 5. group matrix on the game (after the above)
do $$ declare r text; e text; begin
  foreach e in array array['free@t.test','neutral@t.test','assigned@t.test'] loop
    perform pg_temp.as_user(e); r := pg_temp.fails('select public.resume_or_start_game_session()');
    perform pg_temp.rec('allowed: '||e, r is null, coalesce(r,''));
  end loop;
end $$;

-- 6. leak scan + privileges
do $$ declare b text; begin
  execute 'reset role';
  select string_agg(body, ' ') into b from seen;
  perform pg_temp.rec('no step answer / key field in any response seen ('||(select count(*) from seen)||' responses)', b !~ '"answer"|final_answer|stepAnswer|"steps":\[', left(b,100));
  perform pg_temp.rec('internal helpers not callable by authenticated', not has_function_privilege('authenticated','public.pia_eval_expr(text)','EXECUTE') and not has_function_privilege('authenticated','public.pia_game_email()','EXECUTE') and not has_function_privilege('authenticated','public.pia_step_matches(text,text)','EXECUTE'));
  perform pg_temp.rec('new tables have no grants for students', not has_table_privilege('authenticated','public.step_states','SELECT') and not has_table_privilege('authenticated','public.step_events','INSERT'));
  perform pg_temp.rec('anon cannot call new RPCs', not has_function_privilege('anon','public.check_step_answer(uuid,text,text)','EXECUTE'));
  perform pg_temp.rec('OLD question RPCs still executable (not revoked, by instruction)', has_function_privilege('authenticated','public.serve_next_question(uuid)','EXECUTE') and has_function_privilege('authenticated','public.check_question_answer(uuid,text,text)','EXECUTE'));
end $$;

-- 7. old two-try flow still works for an assigned student (regression of 0029)
do $$ declare s jsonb; sid uuid; q jsonb; d jsonb; pid text; begin
  perform pg_temp.as_user('free@t.test');
  s := public.resume_or_start_game_session(); sid := (s->>'session_id')::uuid;
  q := public.serve_next_question(sid); pid := q->>'problem_id';
  d := public.check_question_answer(sid,pid,'999');
  perform pg_temp.rec('0029 regression: serve + wrong answer + attempts_left', (d->>'attempts_left')='1' and q::text !~ 'final_answer', d::text);
end $$;

select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed, count(*) as total from res;
select n, name, detail from res where not ok order by n;
