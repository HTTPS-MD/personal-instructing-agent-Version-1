-- ============================================================================
-- PIA 0038 -- CONTROL IS OCEAN-ONLY; NEUTRAL IS A TUTOR PERSONA, NOT A CONDITION
-- ============================================================================
-- Research policy confirmed by the project owner:
--
--   * CONTROL students take OCEAN and nothing else. They cannot enter
--     Character Selection or the Tutoring Dashboard, whatever a stage's
--     open/closed flag or a section grant says.
--   * NEUTRAL ('pia-neutral') is a tutor persona. Free Choice students may
--     pick it in Character Selection; Assigned students may be given it. It is
--     no longer a research condition, so profiles.group_type = 'neutral' must
--     not be given to anyone NEW.
--
-- WHAT THIS MIGRATION CHANGES
--   1. pia_can_enter_stage(boolean, text, text, text): a Control student is
--      refused 'Tutoring Dashboard' (Character Selection was already refused:
--      it is for the free-choice group only). Every other group is evaluated
--      exactly as in 0005. set_student_stage, the stage-time heartbeat (0035)
--      and the student route guards all read this one function.
--   2. submit_ocean_results(integer[]): redefined from 0018 with ONE change,
--      the next-stage block. A Control student is sent to 'Waiting Room'
--      instead of 'Tutoring Dashboard'. The scoring, validation, storage and
--      grants are the 0018 text unchanged.
--   3. A trigger that refuses to ASSIGN group_type 'neutral' to a new row or
--      to change an existing row TO neutral.
--
--   4. A row-level guard, trg_pia_control_stage_guard: no writer at all, a
--      SECURITY DEFINER admin RPC included, can move a Control student INTO
--      'Character Selection' or 'Tutoring Dashboard', and a Control student's
--      own browser cannot start a tutoring session (is_in_game). The body of
--      admin_grant_stage__inner is not in this repository (it was created
--      outside the migration files), so whether a section grant defers to
--      pia_can_enter_stage could not be established from source; this guard
--      makes the answer irrelevant. The write is kept at the student's
--      current stage (stage_started_at and is_in_game too) instead of
--      raising, so a section grant still completes for the section's other
--      students. Limitation: such a grant's "granted" list may still name the
--      Control student; the stage did not change.

-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * It does NOT update any profile. Existing group_type = 'neutral' rows keep
--     their group, section, stage, persona and scores. They keep behaving as
--     they do today (OCEAN, then the Tutoring Dashboard; no Character
--     Selection), because the stage rule gives 'neutral' no special case. The
--     trigger lets such a row be edited for any other reason and lets an admin
--     move it OUT of neutral; it only blocks moving anyone INTO it.
--   * It does NOT move Control students who are already in the Tutoring
--     Dashboard. Review them with supabase/INSPECT_neutral_and_control.sql
--     and decide per student (docs/neutral-control-handling-plan.md).
--   * It does not touch question_bank, settings, stage_overrides or any RPC
--     other than the two named above.
--
-- Requires 0005 (pia_can_enter_stage), 0018 (submit_ocean_results), 0037.
-- SAFE TO RE-RUN. The postflight proves no profile row was changed by the
-- migration itself, rehearses the new rules on probe rows, and rolls those
-- back.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- PREFLIGHT
-- ---------------------------------------------------------------------------
do $$
declare
  v_problems text := '';
begin
  if to_regprocedure('public.pia_can_enter_stage(boolean, text, text, text)') is null then
    v_problems := v_problems || 'pia_can_enter_stage(boolean, text, text, text) is missing (0005); ';
  end if;
  if to_regprocedure('public.submit_ocean_results(integer[])') is null then
    v_problems := v_problems || 'submit_ocean_results(integer[]) is missing (0018); ';
  end if;
  if to_regprocedure('public.pia_stage_open(text)') is null then
    v_problems := v_problems || 'pia_stage_open(text) is missing (0002); ';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'group_type') then
    v_problems := v_problems || 'profiles.group_type is missing; ';
  end if;
  if v_problems <> '' then
    raise exception 'PIA 0038 ABORT (nothing changed): %', v_problems using errcode = 'P0001';
  end if;
end;
$$;

-- A snapshot of every row this migration must leave alone. Compared at the end.
create temporary table pia_0038_before on commit drop as
  select email, group_type, section, current_stage, selected_character, is_ocean_done
    from public.profiles;


-- ---------------------------------------------------------------------------
-- PART 1 -- the stage rule. Same signature and attributes as 0005.
-- ---------------------------------------------------------------------------
create or replace function public.pia_can_enter_stage(
  p_is_ocean_done      boolean,
  p_group_type         text,
  p_selected_character text,
  p_stage              text)
returns boolean
language sql
immutable
as $$
  select case p_stage
    when 'OCEAN' then
      not coalesce(p_is_ocean_done, false)
    when 'Character Selection' then
      coalesce(p_is_ocean_done, false)
      and lower(trim(coalesce(p_group_type, ''))) in ('non-assigned', 'non_assigned')
      and p_selected_character is null
    when 'Tutoring Dashboard' then
      coalesce(p_is_ocean_done, false)
      and lower(trim(coalesce(p_group_type, ''))) <> 'control'
      and not (lower(trim(coalesce(p_group_type, ''))) in ('non-assigned', 'non_assigned')
               and p_selected_character is null)
    when 'Waiting Room' then
      true
    else false
  end;
$$;


-- ---------------------------------------------------------------------------
-- PART 2 -- submit_ocean_results: 0018 text, next-stage block changed.
-- ---------------------------------------------------------------------------
create or replace function public.submit_ocean_results(p_responses integer[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_profile public.profiles%rowtype;
  r         integer[];
  k         record;
  v_needs_character boolean;
  v_is_control boolean;
  v_next_stage text;
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles where email = v_email;
  if not found then
    raise exception 'PIA: no profile found for this session.' using errcode = '42501';
  end if;

  -- Once only. The admin retake action sets is_ocean_done back to false.
  if coalesce(v_profile.is_ocean_done, false) then
    raise exception 'PIA: this questionnaire has already been submitted. Ask an admin for a retake.'
      using errcode = '42501';
  end if;

  if p_responses is null or array_length(p_responses, 1) is distinct from 50 then
    raise exception 'PIA: exactly 50 responses are required (received: %).',
      coalesce(array_length(p_responses, 1), 0) using errcode = '22023';
  end if;

  -- Re-based to 1..50 in order, so r[n] is item n even if a caller crafts an
  -- array with a different lower bound.
  r := array(select x from unnest(p_responses) with ordinality as t(x, i) order by i);

  if exists (select 1 from unnest(r) v where v is null or v < 1 or v > 5) then
    raise exception 'PIA: every response must be between 1 and 5.' using errcode = '22023';
  end if;

  select * into k from public.pia_bfpt_score(r);

  -- Next stage -- decided here, never in the browser. 0038: a Control student
  -- has no stage after OCEAN, so they are parked in the Waiting Room (always
  -- permitted); the student pages show them the thank-you screen there.
  v_is_control := lower(trim(coalesce(v_profile.group_type, ''))) = 'control';
  v_needs_character :=
    lower(trim(coalesce(v_profile.group_type, ''))) in ('non-assigned', 'non_assigned')
    and v_profile.selected_character is null;

  if v_is_control then
    v_next_stage := 'Waiting Room';
  elsif v_needs_character then
    v_next_stage := case when public.pia_stage_open('stage_char')
                         then 'Character Selection' else 'Waiting Room' end;
  else
    v_next_stage := case when public.pia_stage_open('stage_dash')
                         then 'Tutoring Dashboard' else 'Waiting Room' end;
  end if;

  insert into public.ocean_submissions
         (email, responses, ocean_e, ocean_a, ocean_c, ocean_n, ocean_o, scoring_key, source)
  values (v_email, r::smallint[], k.ocean_e, k.ocean_a, k.ocean_c, k.ocean_n, k.ocean_o,
          'bfpt-2026-07-22', 'questionnaire');

  -- The completion flag and the stage. Deliberately no score.
  update public.profiles set
    is_ocean_done    = true,
    current_stage    = v_next_stage,
    stage_started_at = now()
  where email = v_email;

  return jsonb_build_object('next_stage', v_next_stage);
end;
$$;

revoke all on function public.submit_ocean_results(integer[]) from public, anon;
grant execute on function public.submit_ocean_results(integer[]) to authenticated;


-- ---------------------------------------------------------------------------
-- PART 3 -- no NEW neutral assignments. Existing neutral rows are untouched.
-- ---------------------------------------------------------------------------
create or replace function public.pia_no_new_neutral_group()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if lower(trim(coalesce(new.group_type, ''))) = 'neutral'
     and (tg_op = 'INSERT'
          or lower(trim(coalesce(old.group_type, ''))) is distinct from 'neutral') then
    raise exception 'PIA: "neutral" is a tutor persona, not a research condition. Use the assigned or free-choice group, and give the persona instead.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pia_no_new_neutral_group on public.profiles;
create trigger trg_pia_no_new_neutral_group
  before insert or update of group_type on public.profiles
  for each row execute function public.pia_no_new_neutral_group();


-- ---------------------------------------------------------------------------
-- PART 4 -- no writer can move a Control student into a closed-to-Control stage
-- ---------------------------------------------------------------------------
create or replace function public.pia_control_stage_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if lower(trim(coalesce(new.group_type, ''))) = 'control'
     and new.current_stage in ('Character Selection', 'Tutoring Dashboard')
     and (tg_op = 'INSERT' or new.current_stage is distinct from old.current_stage) then
    if tg_op = 'INSERT' then
      new.current_stage := 'Waiting Room';
    else
      -- Keep the student where they are. A Control student already in the
      -- dashboard before this migration is not moved by it either.
      new.current_stage    := old.current_stage;
      new.stage_started_at := old.stage_started_at;
      new.is_in_game       := old.is_in_game;
    end if;
  end if;

  -- "In a tutoring session" is written by the student's own browser
  -- (is_in_game is student-writable). A Control student has no session, so a
  -- write that would start one is dropped. A row that already says true is
  -- left as it is (not cleared by this migration).
  if lower(trim(coalesce(new.group_type, ''))) = 'control'
     and coalesce(new.is_in_game, false)
     and (tg_op = 'INSERT' or not coalesce(old.is_in_game, false)) then
    new.is_in_game := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pia_control_stage_guard on public.profiles;
create trigger trg_pia_control_stage_guard
  before insert or update of current_stage, is_in_game, group_type on public.profiles
  for each row execute function public.pia_control_stage_guard();


-- ---------------------------------------------------------------------------
-- POSTFLIGHT
-- ---------------------------------------------------------------------------
do $$
declare
  v_fail   text := '';
  v_n      int;
  v_legacy int;
  v_ctl    int;
  v_def    text;
begin
  -- (1) The rule, group by group (pure function, no data).
  if public.pia_can_enter_stage(true,  'control',      null,  'Tutoring Dashboard')   then v_fail := v_fail || 'control can enter the dashboard; '; end if;
  if public.pia_can_enter_stage(true,  ' Control ',    null,  'Tutoring Dashboard')   then v_fail := v_fail || 'control (padded/cased) can enter the dashboard; '; end if;
  if public.pia_can_enter_stage(true,  'control',      null,  'Character Selection')  then v_fail := v_fail || 'control can enter character selection; '; end if;
  if not public.pia_can_enter_stage(false, 'control',  null,  'OCEAN')                then v_fail := v_fail || 'control cannot take OCEAN; '; end if;
  if public.pia_can_enter_stage(true,  'control',      null,  'OCEAN')                then v_fail := v_fail || 'control can retake OCEAN without a reset; '; end if;
  if not public.pia_can_enter_stage(true, 'control',   null,  'Waiting Room')         then v_fail := v_fail || 'control cannot wait; '; end if;
  if not public.pia_can_enter_stage(true, 'assigned',  null,  'Tutoring Dashboard')   then v_fail := v_fail || 'assigned lost the dashboard; '; end if;
  if public.pia_can_enter_stage(true,  'assigned',     null,  'Character Selection')  then v_fail := v_fail || 'assigned gained character selection; '; end if;
  if not public.pia_can_enter_stage(true, 'non-assigned', null, 'Character Selection') then v_fail := v_fail || 'free choice lost character selection; '; end if;
  if public.pia_can_enter_stage(true,  'non-assigned', null,  'Tutoring Dashboard')   then v_fail := v_fail || 'free choice reached the dashboard before choosing; '; end if;
  if not public.pia_can_enter_stage(true, 'non-assigned', 'pia-neutral', 'Tutoring Dashboard') then v_fail := v_fail || 'free choice who picked pia-neutral cannot enter the dashboard; '; end if;
  if not public.pia_can_enter_stage(true, 'neutral',   null,  'Tutoring Dashboard')   then v_fail := v_fail || 'existing neutral rows lost the dashboard; '; end if;
  if public.pia_can_enter_stage(true,  'neutral',      null,  'Character Selection')  then v_fail := v_fail || 'existing neutral rows gained character selection; '; end if;

  -- (2) The new next-stage block is in place and the rest of 0018 is intact.
  select pg_get_functiondef('public.submit_ocean_results(integer[])'::regprocedure) into v_def;
  if v_def !~ 'v_is_control' or v_def !~ 'pia_bfpt_score' or v_def !~ 'ocean_submissions' then
    v_fail := v_fail || 'submit_ocean_results is not the expected text; ';
  end if;

  -- (3) Nothing was written to any profile by this migration.
  select count(*) into v_n from (
    select email, group_type, section, current_stage, selected_character, is_ocean_done from public.profiles
    except
    select email, group_type, section, current_stage, selected_character, is_ocean_done from pia_0038_before) d;
  if v_n <> 0 then v_fail := v_fail || v_n || ' profile row(s) changed during the migration; '; end if;
  select count(*) into v_n from pia_0038_before b
   where not exists (select 1 from public.profiles p where p.email = b.email);
  if v_n <> 0 then v_fail := v_fail || v_n || ' profile row(s) disappeared; '; end if;

  -- (4) The no-new-neutral trigger, rehearsed on probe rows and rolled back.
  begin
    begin
      begin
        insert into public.profiles (email, full_name, role, section, group_type, parental_consent, student_assent)
        values ('probe-neutral-new@pia-0038.test', 'Probe', 'student', 'X', 'neutral', true, true);
        v_fail := v_fail || 'a NEW neutral student was accepted; ';
      exception when sqlstate 'P0001' then null;
      end;

      insert into public.profiles (email, full_name, role, section, group_type, parental_consent, student_assent)
      values ('probe-assigned@pia-0038.test', 'Probe', 'student', 'X', 'assigned', true, true);

      begin
        update public.profiles set group_type = 'neutral' where email = 'probe-assigned@pia-0038.test';
        v_fail := v_fail || 'an existing student could be moved INTO neutral; ';
      exception when sqlstate 'P0001' then null;
      end;

      -- A legacy neutral row (made by switching the trigger off for the probe
      -- only) can still be edited and can leave neutral.
      alter table public.profiles disable trigger trg_pia_no_new_neutral_group;
      update public.profiles set group_type = 'neutral' where email = 'probe-assigned@pia-0038.test';
      alter table public.profiles enable trigger trg_pia_no_new_neutral_group;

      update public.profiles set section = 'Y' where email = 'probe-assigned@pia-0038.test';
      update public.profiles set group_type = 'neutral', section = 'Z' where email = 'probe-assigned@pia-0038.test';
      select count(*) into v_n from public.profiles
       where email = 'probe-assigned@pia-0038.test' and group_type = 'neutral' and section = 'Z';
      if v_n <> 1 then v_fail := v_fail || 'a legacy neutral row could not be edited; '; end if;

      update public.profiles set group_type = 'assigned' where email = 'probe-assigned@pia-0038.test';
      select count(*) into v_n from public.profiles
       where email = 'probe-assigned@pia-0038.test' and group_type = 'assigned';
      if v_n <> 1 then v_fail := v_fail || 'a legacy neutral row could not leave neutral; '; end if;

      -- The Control stage guard, through a plain update (no RPC needed).
      insert into public.profiles (email, full_name, role, section, group_type, current_stage, parental_consent, student_assent)
      values ('probe-control@pia-0038.test', 'Probe', 'student', 'X', 'control', 'Tutoring Dashboard', true, true);
      select count(*) into v_n from public.profiles
       where email = 'probe-control@pia-0038.test' and current_stage = 'Waiting Room';
      if v_n <> 1 then v_fail := v_fail || 'a Control student was inserted straight into the dashboard; '; end if;
      update public.profiles set current_stage = 'Tutoring Dashboard' where email = 'probe-control@pia-0038.test';
      update public.profiles set current_stage = 'Character Selection' where email = 'probe-control@pia-0038.test';
      select count(*) into v_n from public.profiles
       where email = 'probe-control@pia-0038.test' and current_stage = 'Waiting Room';
      if v_n <> 1 then v_fail := v_fail || 'a Control student could be moved into the dashboard / character selection; '; end if;
      update public.profiles set current_stage = 'OCEAN' where email = 'probe-control@pia-0038.test';
      select count(*) into v_n from public.profiles
       where email = 'probe-control@pia-0038.test' and current_stage = 'OCEAN';
      if v_n <> 1 then v_fail := v_fail || 'a Control student could not be moved to OCEAN; '; end if;
      -- A Control student cannot start a tutoring session; others can.
      update public.profiles set is_in_game = true where email = 'probe-control@pia-0038.test';
      select count(*) into v_n from public.profiles
       where email = 'probe-control@pia-0038.test' and is_in_game = false;
      if v_n <> 1 then v_fail := v_fail || 'a Control student could start a tutoring session; '; end if;
      update public.profiles set is_in_game = true where email = 'probe-assigned@pia-0038.test';
      select count(*) into v_n from public.profiles
       where email = 'probe-assigned@pia-0038.test' and is_in_game = true;
      if v_n <> 1 then v_fail := v_fail || 'the Control guard blocked an Assigned student starting a session; '; end if;
      update public.profiles set is_in_game = false where email = 'probe-assigned@pia-0038.test';
      update public.profiles set current_stage = 'Tutoring Dashboard' where email = 'probe-assigned@pia-0038.test';
      select count(*) into v_n from public.profiles
       where email = 'probe-assigned@pia-0038.test' and current_stage = 'Tutoring Dashboard';
      if v_n <> 1 then v_fail := v_fail || 'the Control guard blocked an Assigned student; '; end if;

      raise exception 'rehearsal done' using errcode = 'P0002';
    exception when sqlstate 'P0002' then null;
    end;
  end;

  -- (5) Report, never change: how many existing rows the plan has to cover.
  select count(*) into v_legacy from public.profiles where lower(trim(coalesce(group_type, ''))) = 'neutral';
  select count(*) into v_ctl from public.profiles
   where lower(trim(coalesce(group_type, ''))) = 'control'
     and (current_stage = 'Tutoring Dashboard' or coalesce(is_in_game, false));
  raise notice 'PIA 0038: % existing neutral student(s) left exactly as they were; % control student(s) currently in the Tutoring Dashboard need a decision (see the handling plan).', v_legacy, v_ctl;

  -- admin_grant_stage__inner is not in this repository; say so if it does not
  -- defer to the stage rule, because then a section grant could still move a
  -- Control student into the dashboard.
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_grant_stage__inner' limit 1;
  if v_def is null then
    raise notice 'PIA 0038 REVIEW: admin_grant_stage__inner was not found; confirm how admin_grant_stage decides who is eligible.';
  elsif v_def !~ 'pia_can_enter_stage' then
    raise notice 'PIA 0038 REVIEW: admin_grant_stage__inner does not call pia_can_enter_stage; confirm a section grant cannot move a Control student into the Tutoring Dashboard.';
  end if;

  if v_fail <> '' then
    raise exception 'PIA 0038 ABORT: %', v_fail using errcode = 'P0001';
  end if;
  raise notice 'PIA 0038 OK: Control is OCEAN-only; Neutral can no longer be assigned as a condition; no profile was changed.';
end;
$$;

commit;

notify pgrst, 'reload schema';
