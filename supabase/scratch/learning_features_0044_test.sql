-- Scratch-only test of get_learning_features (0044). Never run on a live database.
\set ON_ERROR_STOP on
begin;
insert into public.profiles(email, role, group_type, is_ocean_done, selected_character) values
  ('good@x.test','student','Assigned',true,'pia-open'), ('bad@x.test','student','Assigned',true,'pia-open'),
  ('new@x.test','student','Assigned',true,'pia-open'), ('one@x.test','student','Assigned',true,'pia-open'),
  ('ctl@x.test','student','Control',true,null), ('t@x.test','teacher',null,true,null);
-- good: 8 correct, 10 s apart, no hints
insert into public.step_events(session_id, student_email, problem_id, step_index, stage, submitted, outcome, happened_at)
select '10000000-0000-0000-0000-000000000001','good@x.test','qb-'||(g/2+1), g%2,'work','1',
       case when g%2=1 then 'question_done' else 'step_done' end, now()-interval '10 minutes'+g*interval '10 seconds'
  from generate_series(0,7) g;
-- bad: 7 wrong on one step, 20 s apart, one hint
insert into public.step_events(session_id, student_email, problem_id, step_index, stage, submitted, outcome, happened_at)
select '20000000-0000-0000-0000-000000000002','bad@x.test','qb-1',0,'work','9',
       case when g%2=0 then 'wrong' else 'format_error' end, now()-interval '10 minutes'+g*interval '20 seconds'
  from generate_series(0,6) g;
insert into public.step_hints(session_id, student_email, problem_id, step_index, tier, tiers_total, taken_at)
  values ('20000000-0000-0000-0000-000000000002','bad@x.test','qb-1',0,1,3, now()-interval '9 minutes');
insert into public.step_events(session_id, student_email, problem_id, step_index, stage, submitted, outcome)
  values ('40000000-0000-0000-0000-000000000004','one@x.test','qb-1',0,'work','1','step_done');

create temp table res(label text, j jsonb);
grant all on res to authenticated;
do $$ declare c record; begin
  for c in select * from (values ('good','good@x.test','10000000-0000-0000-0000-000000000001'),
      ('bad','bad@x.test','20000000-0000-0000-0000-000000000002'),
      ('new','new@x.test','50000000-0000-0000-0000-000000000005'),
      ('one','one@x.test','40000000-0000-0000-0000-000000000004'),
      ('cross','good@x.test','20000000-0000-0000-0000-000000000002')) v(l,e,s) loop
    perform set_config('request.jwt.claims', json_build_object('email', c.e)::text, true);
    execute 'set local role authenticated';
    insert into res select c.l, public.get_learning_features(c.s::uuid);
    execute 'reset role';
  end loop;
end $$;
select label, j::text from res order by label;
do $$ declare p text; f jsonb; begin
  f := (select j->'features' from res where label='good');
  assert (f->>'recent_accuracy')::numeric = 1 and (f->>'average_attempts')::numeric = 1 and (f->>'hint_rate')::numeric = 0
     and (f->>'consecutive_correct')::int = 8 and (f->>'consecutive_wrong')::int = 0, 'good '||f;
  assert (f->>'correct_response_efficiency')::numeric between 0.60 and 0.80, 'efficiency (first answer has no earlier record: 120 s fallback)';
  f := (select j->'features' from res where label='bad');
  assert (f->>'recent_accuracy')::numeric = 0 and (f->>'average_attempts')::numeric = 7 and (f->>'hint_rate')::numeric = 1
     and (f->>'consecutive_wrong')::int = 7 and (f->>'consecutive_correct')::int = 0
     and (f->>'correct_response_efficiency')::numeric = 0 and (f->>'average_response_time')::numeric = 120, 'bad '||f;
  assert (select (j->>'events')::int from res where label='good') = 8 and (select (j->>'events')::int from res where label='one') = 1, 'events';
  f := (select j->'features' from res where label='new');
  assert (f->>'recent_accuracy')::numeric = 0.5 and (select (j->>'events')::int from res where label='new') = 0, 'defaults';
  assert (select (j->>'events')::int from res where label='cross') = 0, 'cross-student read';
  -- exactly the seven numbers and the event count: no identity of any kind
  assert (select array(select jsonb_object_keys(j->'features') order by 1) from res where label='good') =
    array['average_attempts','average_response_time','consecutive_correct','consecutive_wrong','correct_response_efficiency','hint_rate','recent_accuracy'], 'keys';
  assert (select j::text from res where label='good') !~* 'x\.test|good|10000000', 'identity leaked';
  foreach p in array array['ctl@x.test','t@x.test'] loop
    perform set_config('request.jwt.claims', json_build_object('email', p)::text, true);
    execute 'set local role authenticated';
    begin perform public.get_learning_features('10000000-0000-0000-0000-000000000001'); raise exception 'NOT BLOCKED %', p;
    exception when insufficient_privilege then null; end;
    execute 'reset role';
  end loop;
  perform set_config('request.jwt.claims', '{}', true);
  execute 'set local role anon';
  begin perform public.get_learning_features('10000000-0000-0000-0000-000000000001'); raise exception 'anon NOT BLOCKED';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  raise notice 'learning-features assertions OK';
end $$;
select (select count(*) from public.step_events) events, (select count(*) from public.step_hints) hints;
rollback;
