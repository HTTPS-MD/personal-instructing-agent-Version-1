-- Scratch-only test of 0050 (Neutral as a research condition). Run after the chain and 0050.
\set ON_ERROR_STOP on
begin;
create function pg_temp.as_user(p text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims', json_build_object('email', p)::text, true); execute 'set local role authenticated'; end $$;
insert into profiles(email, full_name, role, group_type, section, parental_consent, student_assent) values
  ('admin@n.test','Admin','admin',null,'X',true,true);
insert into question_bank(difficulty, question, final_answer, hint) values
 ('EASY','What is 10% of 50?','5','{"defaultHint":"d","steps":[{"prompt":"p1","answer":"0.1","hint1":"a","hint2":"b","hint3":"c"},{"prompt":"p2","answer":"5","hint1":"m"}]}');
do $$
declare s jsonb; q jsonb; d jsonb; ok boolean;
begin
  -- 1. a NEW neutral row is accepted and always gets the Neutral tutor, whatever was sent
  insert into profiles(email, full_name, role, group_type, section, parental_consent, student_assent) values ('n1@n.test','N1','student','neutral','X',true,true);
  assert (select selected_character from profiles where email = 'n1@n.test') = 'pia-neutral', '1 neutral at registration gets pia-neutral';
  insert into profiles(email, full_name, role, group_type, section, parental_consent, student_assent, selected_character) values ('n2@n.test','N2','student','neutral','X',true,true,'pia-open');
  assert (select selected_character from profiles where email = 'n2@n.test') = 'pia-neutral', '1b a tutor sent with a neutral row is replaced';
  -- 2. other groups are untouched
  insert into profiles(email, full_name, role, group_type, section, parental_consent, student_assent) values
    ('a1@n.test','A1','student','assigned','X',true,true), ('f1@n.test','F1','student','non-assigned','X',true,true), ('c1@n.test','C1','student','control','X',true,true);
  assert (select count(*) from profiles where email in ('a1@n.test','f1@n.test','c1@n.test') and selected_character is not null) = 0, '2 assigned / free choice / control get no tutor at registration';
  -- 3. the admin moves a student INTO neutral, and out of it
  update profiles set group_type = 'neutral' where email = 'a1@n.test';
  assert (select selected_character from profiles where email = 'a1@n.test') = 'pia-neutral', '3 moved into neutral';
  update profiles set selected_character = 'pia-calm' where email = 'a1@n.test';
  assert (select selected_character from profiles where email = 'a1@n.test') = 'pia-neutral', '3b a neutral student cannot be given another tutor';
  update profiles set group_type = 'non-assigned' where email = 'a1@n.test';
  assert (select selected_character from profiles where email = 'a1@n.test') is null, '3c out of neutral: the group-given tutor is cleared (free choice then picks)';
  update profiles set group_type = 'assigned', selected_character = 'pia-open' where email = 'f1@n.test';
  assert (select selected_character from profiles where email = 'f1@n.test') = 'pia-open', '3d an assigned tutor is untouched by this rule';
  -- 4. a neutral student's own writes cannot change the tutor
  update profiles set is_ocean_done = true where email = 'n1@n.test';
  perform pg_temp.as_user('n1@n.test');
  begin update profiles set selected_character = 'pia-calm' where email = 'n1@n.test'; raise exception 'student changed the tutor';
  exception when others then if sqlerrm like 'student changed%' then raise; end if; end;
  reset role;
  assert (select selected_character from profiles where email = 'n1@n.test') = 'pia-neutral', '4 still neutral';
  -- 5. the workflow: after OCEAN straight to the Tutoring Dashboard (no Character Selection), then the game with the Neutral tutor
  assert public.pia_can_enter_stage(true, 'neutral', 'pia-neutral', 'Tutoring Dashboard'), '5 neutral enters the dashboard after OCEAN';
  assert not public.pia_can_enter_stage(true, 'neutral', 'pia-neutral', 'Character Selection'), '5b no Character Selection';
  assert not public.pia_can_enter_stage(false, 'neutral', 'pia-neutral', 'Tutoring Dashboard'), '5c not before OCEAN is done';
  perform pg_temp.as_user('n1@n.test');
  s := public.resume_or_start_game_session();
  assert (s->>'session_id') is not null, '5d a neutral student starts the game';
  q := public.serve_next_step_question((s->>'session_id')::uuid);
  assert q->>'problem_id' is not null, '5e and is served a question';
  reset role;
  assert (select selected_character from profiles where email = 'n1@n.test') = 'pia-neutral', '5f the tutor in the game is Neutral';
  -- 6. Control still cannot enter the dashboard; Assigned still needs its own tutor
  assert not public.pia_can_enter_stage(true, 'control', null, 'Tutoring Dashboard'), '6 control';
  -- the game itself refuses an account with no tutor (an assigned student before OCEAN assigns one)
  perform pg_temp.as_user('f1@n.test');
  begin perform public.resume_or_start_game_session(); raise exception 'game allowed without a tutor'; exception when insufficient_privilege then null; end;
  reset role;
  raise notice '0050 assertions OK';
end $$;
rollback;
