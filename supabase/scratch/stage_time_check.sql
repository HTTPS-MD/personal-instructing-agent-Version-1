-- Does the heartbeat accumulate tutoring time across repeated game sessions? (scratch DB; run after run_chain + 0035)
\set ON_ERROR_STOP on
create temp table res (n int generated always as identity, name text, ok boolean, detail text);
create or replace function pg_temp.as_user(p text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims', json_build_object('email', p)::text, true); execute 'set local role authenticated'; end $$;
create or replace function pg_temp.rec(p text, ok boolean, d text default '') returns void language plpgsql as $$ begin execute 'reset role'; insert into res(name, ok, detail) values (p, coalesce(ok,false), d); end $$;
insert into profiles(email, full_name, role, group_type, is_ocean_done, selected_character, parental_consent, student_assent)
values ('hb@t.test','H','student','assigned',true,'pia-open',true,true);
do $$ declare d jsonb; t int; begin
  perform pg_temp.as_user('hb@t.test');
  d := public.record_heartbeat('Tutoring Dashboard');                       -- visit 1: first ping stamps only
  perform pg_temp.rec('first ping credits nothing', (d->>'credited')::int = 0, d::text);
  execute 'reset role'; update student_stage_time set last_heartbeat_timestamp = now() - interval '30 seconds' where student_email='hb@t.test';
  perform pg_temp.as_user('hb@t.test'); d := public.record_heartbeat('Tutoring Dashboard');
  perform pg_temp.rec('30 s later credits 30 s', (d->>'credited')::int = 30 and (d->>'seconds')::int = 30, d::text);
  -- the student leaves (gap over 45 s), comes back for a second session
  execute 'reset role'; update student_stage_time set last_heartbeat_timestamp = now() - interval '2 hours' where student_email='hb@t.test';
  perform pg_temp.as_user('hb@t.test'); d := public.record_heartbeat('Tutoring Dashboard');
  perform pg_temp.rec('away time is not counted; clock restarts', (d->>'credited')::int = 0 and (d->>'seconds')::int = 30, d::text);
  execute 'reset role'; update student_stage_time set last_heartbeat_timestamp = now() - interval '30 seconds' where student_email='hb@t.test';
  perform pg_temp.as_user('hb@t.test'); d := public.record_heartbeat('Tutoring Dashboard');
  perform pg_temp.rec('second visit adds to the same total (cumulative: 60 s)', (d->>'seconds')::int = 60, d::text);
  -- an expiry / Try again does not call finalize; the stage stays open
  execute 'reset role'; select tutoring_time into t from student_stage_time where student_email='hb@t.test';
  perform pg_temp.rec('no lock without finalize_stage_time', (select tutoring_time_locked_at is null from student_stage_time where student_email='hb@t.test'));
  -- what finalize WOULD do (the old end-of-session call): lock for good
  update profiles set is_in_game=false where email='hb@t.test';
  perform pg_temp.as_user('hb@t.test'); d := public.finalize_stage_time('Tutoring Dashboard');
  perform pg_temp.rec('finalize locks tutoring_time', (d->>'locked')='true', d::text);
  execute 'reset role'; update student_stage_time set last_heartbeat_timestamp = now() - interval '30 seconds' where student_email='hb@t.test';
  perform pg_temp.as_user('hb@t.test'); d := public.record_heartbeat('Tutoring Dashboard');
  perform pg_temp.rec('after finalize, later sessions add NOTHING (the lock the page must never trigger)', (d->>'counted')='false' and d->>'reason'='locked', d::text);
end $$;
select name, ok, detail from res order by n;
