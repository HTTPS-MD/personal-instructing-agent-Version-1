-- Full student game flow per research group on a SCRATCH database (run after run_chain.sh).
-- Assigned, Free choice, Control: answering, hints, resume, time expiry + Try again.
\set ON_ERROR_STOP on
\set QUIET on
create temp table res (n int generated always as identity, name text, ok boolean, detail text);
create or replace function pg_temp.as_user(p text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims', json_build_object('email', p)::text, true); execute 'set local role authenticated'; end $$;
create or replace function pg_temp.rec(p text, ok boolean, d text default '') returns void language plpgsql as $$ begin execute 'reset role'; insert into res(name, ok, detail) values (p, coalesce(ok,false), left(d,300)); end $$;
create or replace function pg_temp.fails(p text) returns text language plpgsql as $$ begin execute p; return null; exception when others then return sqlstate||': '||sqlerrm; end $$;
create or replace function pg_temp.ans(q text, st int) returns text language sql as $$
  select case st when 0 then (array['0.1','0.2','0.3','0.4'])[i] else (array['5','10','15','20'])[i] end from (select (substring(q from '(\d+)%')::int/10) as i) t $$;

insert into profiles(email, full_name, role, group_type, is_ocean_done, selected_character, parental_consent, student_assent) values
 ('admin@f.test','Admin','admin',null,true,null,true,true),
 ('asg@f.test','Assigned','student','assigned',true,'pia-calm',true,true),
 ('free@f.test','Free','student','non-assigned',true,null,true,true),
 ('ctl@f.test','Control','student','control',true,null,true,true);
insert into question_bank(difficulty, question, final_answer, hint)
select 'EASY','What is '||p||'% of 50?', (p*50/100)::text,
  '{"defaultHint":"d","steps":[{"prompt":"p1","answer":"'||(p/100.0)||'","hint1":"concept","hint2":"setup","hint3":"worked"},{"prompt":"p2","answer":"'||(p*50/100)||'","hint1":"multiply"}]}'
from (values (10),(20),(30),(40)) v(p);

create or replace function pg_temp.play(p_email text, p_label text) returns void language plpgsql as $$
declare s jsonb; sid uuid; q jsonb; d jsonb; pid text; qtext text; sid2 uuid;
begin
  perform pg_temp.as_user(p_email);
  s := public.resume_or_start_game_session(); sid := (s->>'session_id')::uuid;
  perform pg_temp.rec(p_label||': first start is a new session', (s->>'resumed')='false' and sid is not null, s::text);
  q := public.serve_next_step_question(sid); pid := q->>'problem_id'; qtext := q->>'question';
  perform pg_temp.rec(p_label||': question served with a live clock and no key', (q->'clock'->>'expired')='false' and q::text !~ '"answer"|final_answer', (q->'clock')::text);
  -- answering: wrong, wrong -> hint unlocks -> hint tiers
  d := public.check_step_answer(sid,pid,'999'); d := public.check_step_answer(sid,pid,'998');
  perform pg_temp.rec(p_label||': two wrong answers unlock the hint', (d->'state'->>'hint_unlocked')='true' and (d->'state'->>'errors')='2', d::text);
  d := public.consume_step_hint(sid,pid);
  perform pg_temp.rec(p_label||': hint 1 = concept', d->'hint'->>'text'='concept' and (d->'hint'->>'tier')='1', d::text);
  d := public.consume_step_hint(sid,pid); d := public.consume_step_hint(sid,pid);
  perform pg_temp.rec(p_label||': hint 3 = worked, then stays at the last tier', d->'hint'->>'text'='worked' and (public.consume_step_hint(sid,pid)->'hint'->>'tier')='3');
  -- working, then the value
  d := public.check_step_answer(sid,pid, substring(qtext from '(\d+)%')||'/100');
  perform pg_temp.rec(p_label||': working accepted, final value requested', d->>'outcome'='needs_final' and d->'state'->>'confirm_kind'='decimal', d::text);
  -- RESUME mid-question (page reload): same session, same question, same progress, same confirm box
  s := public.resume_or_start_game_session();
  perform pg_temp.rec(p_label||': resume returns the same session', (s->>'session_id')::uuid = sid and (s->>'resumed')='true' and s->>'pending_problem_id'=pid, s::text);
  q := public.serve_next_step_question(sid);
  perform pg_temp.rec(p_label||': resume restores the open question exactly (confirm box, hint unlocked)', q->>'problem_id'=pid and q->>'stage'='confirm' and (q->>'hint_unlocked')='true' and q->>'work_text' = substring(qtext from '(\d+)%')||'/100' and (q->'clock'->>'expired')='false', q::text);
  d := public.check_step_answer(sid,pid,pg_temp.ans(qtext,0));
  perform pg_temp.rec(p_label||': step 1 done after resume', d->>'outcome'='step_done' and (d->'state'->>'current_step')='1', d::text);
  -- TIME EXPIRY mid-question
  execute 'reset role';
  update game_windows set deadline_at = now() - interval '3 seconds', started_at = now() - interval '600 seconds' where session_id = sid;
  perform pg_temp.as_user(p_email);
  d := public.check_step_answer(sid,pid,pg_temp.ans(qtext,1));
  perform pg_temp.rec(p_label||': after the limit the answer is refused', d->>'outcome'='time_expired', d::text);
  d := public.consume_step_hint(sid,pid);
  perform pg_temp.rec(p_label||': after the limit hints are refused', d->'hint'='null'::jsonb and (d->'clock'->>'expired')='true');
  s := public.resume_or_start_game_session(); q := public.serve_next_step_question(sid);
  perform pg_temp.rec(p_label||': reload while expired still reports expiry, same question', (q->'clock'->>'expired')='true' and q->>'problem_id'=pid);
  d := public.restart_after_expiry(sid);
  perform pg_temp.rec(p_label||': Try again = same problem from step 1, counts reset, new window', d->>'restarted'='true' and d->>'problem_id'=pid and (d->>'current_step')='0' and (d->>'errors')='0' and (d->>'hints_used')='0' and (d->'clock'->>'window')='2' and (d->'clock'->>'expired')='false', d::text);
  -- finish the question cleanly, then the result
  d := public.check_step_answer(sid,pid,pg_temp.ans(qtext,0)); d := public.check_step_answer(sid,pid,pg_temp.ans(qtext,1));
  perform pg_temp.rec(p_label||': question completed after Try again', d->>'outcome'='question_done', d::text);
  d := public.finish_step_question(sid,pid);
  perform pg_temp.rec(p_label||': result recorded server-side (accurate, no errors after restart)', (d->>'is_correct')='true' and (d->>'problems_answered')='1' and d->>'classification'='smooth', d::text);
  q := public.serve_next_step_question(sid);
  perform pg_temp.rec(p_label||': next question is a different one', q->>'problem_id' <> pid and (q->>'problem_number')='2', left(q::text,120));
end $$;

-- ASSIGNED: admin set the tutor
select pg_temp.play('asg@f.test','Assigned');

-- FREE CHOICE: blocked until the student saves a tutor (once), then the same full flow
do $$ declare r text; begin
  perform pg_temp.as_user('free@f.test'); r := pg_temp.fails('select public.resume_or_start_game_session()');
  perform pg_temp.rec('Free choice: no game before a tutor is chosen', r like '42501%', coalesce(r,'ALLOWED'));
  perform pg_temp.as_user('free@f.test'); r := pg_temp.fails($q$update profiles set selected_character='pia-neutral' where email='free@f.test'$q$);
  perform pg_temp.rec('Free choice: saves PIA Neutral through the profile (allowed once)', r is null, coalesce(r,''));
  perform pg_temp.as_user('free@f.test'); r := pg_temp.fails($q$update profiles set selected_character='pia-open' where email='free@f.test'$q$);
  perform pg_temp.rec('Free choice: cannot change it afterwards', r like '42501%', coalesce(r,'ALLOWED'));
end $$;
select pg_temp.play('free@f.test','Free choice');

-- CONTROL: every game call refused, including Try again, with a tutor set by force
do $$ declare e text := 'ctl@f.test'; c text; r text; sid uuid := gen_random_uuid(); begin
  execute 'reset role'; update profiles set selected_character='pia-open' where email=e;
  foreach c in array array['select public.resume_or_start_game_session()', format('select public.serve_next_step_question(%L)',sid),
     format('select public.check_step_answer(%L,%L,%L)',sid,'qb-1','0.1'), format('select public.consume_step_hint(%L,%L)',sid,'qb-1'),
     format('select public.finish_step_question(%L,%L)',sid,'qb-1'), format('select public.respond_topic_offer(%L,%L,true)',sid,'qb-1'),
     format('select public.restart_after_expiry(%L)',sid)] loop
    perform pg_temp.as_user(e); r := pg_temp.fails(c);
    perform pg_temp.rec('Control blocked: '||left(c,46), r like '42501%', coalesce(r,'NOT BLOCKED'));
  end loop;
  perform pg_temp.rec('Control: nothing was written (no sessions, states or windows)', not exists(select 1 from served_questions where student_email=e) and not exists(select 1 from step_states where student_email=e) and not exists(select 1 from game_windows where student_email=e));
end $$;

-- cross-student isolation: one student cannot touch another's question
do $$ declare sid uuid; pid text; r text; begin
  execute 'reset role'; select session_id, problem_id into sid, pid from served_questions where student_email='asg@f.test' limit 1;
  perform pg_temp.as_user('free@f.test'); r := pg_temp.fails(format('select public.check_step_answer(%L,%L,%L)',sid,pid,'1'));
  perform pg_temp.rec('Isolation: another student cannot answer someone else''s question', r like '42501%', coalesce(r,'ALLOWED'));
end $$;

select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed, count(*) as total from res;
select n, name, detail from res where not ok order by n;
