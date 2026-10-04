-- Scratch-only test of 0048. Run after run_chain.sh and 0045-0048.
\set ON_ERROR_STOP on
begin;
insert into profiles(email, full_name, role, group_type, is_ocean_done, selected_character, parental_consent, student_assent) values
 ('r1@t.test','R','student','assigned',true,'pia-open',true,true);
create function pg_temp.as_user(p text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims', json_build_object('email', p)::text, true); execute 'set local role authenticated'; end $$;
do $$
declare d jsonb;
begin
  update app_config set game_closes_at = null where id = 1;
  perform pg_temp.as_user('r1@t.test');
  d := public.tutoring_status(); assert d = '{"closed": false, "seconds_to_close": null}'::jsonb, 'no closing time: '||d::text;
  reset role; update app_config set game_closes_at = now() + interval '90 seconds' where id = 1;
  perform pg_temp.as_user('r1@t.test');
  d := public.tutoring_status(); assert (d->>'closed') = 'false' and (d->>'seconds_to_close')::int between 85 and 90, 'counting down: '||d::text;
  reset role; update app_config set game_closes_at = now() - interval '1 second' where id = 1;
  perform pg_temp.as_user('r1@t.test');
  d := public.tutoring_status(); assert d = '{"closed": true, "seconds_to_close": null}'::jsonb, 'closed: '||d::text;
  reset role;
  perform set_config('request.jwt.claims', '{}', true); execute 'set local role anon';
  begin perform public.tutoring_status(); raise exception 'anon NOT BLOCKED'; exception when insufficient_privilege then null; end;
  reset role;
  raise notice '0048 assertions OK';
end $$;
rollback;
