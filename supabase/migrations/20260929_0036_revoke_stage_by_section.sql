-- ============================================================================
-- PIA 0036 -- REVOKE A STAGE FOR CHOSEN SECTIONS
-- ============================================================================
-- admin_grant_stage (0011/0033) lets a section into a closed stage. Until now
-- the only way back out was admin_set_stage_open(stage, false), which closes
-- the stage for EVERY section at once. This adds the missing half:
--
--   admin_revoke_stage(p_stage, p_sections text[])
--
-- For each named section, and only those:
--   * the section's record in stage_overrides is removed, and
--   * every student of the section who is in the stage now goes back to the
--     Waiting Room -- exactly what closing the stage does for everyone.
-- Sections not named are not touched, in either table.
--
-- DATA IS NEVER TOUCHED. The only columns written are profiles.current_stage
-- and profiles.stage_started_at on the students being moved -- the same two
-- columns admin_set_stage_open writes. OCEAN answers (ocean_submissions),
-- scores, the chosen character, tutoring sessions and their results, consent,
-- and the times in student_stage_time are all left exactly as they are.
--
-- A STUDENT WHO IS MID-WAY IS NOT CUT OFF FROM THEIR OWN WORK. Nothing that
-- saves work checks whether a stage is open: submit_ocean_results and the
-- tutoring functions look only at the student and their session. So a student
-- who is part-way through the questionnaire, or a tutoring session, can still
-- finish and save it after the revoke; what they cannot do is START again.
-- Entry is decided by the stage flag or by profiles.current_stage, and this
-- function clears both routes for the section. (The student page is told to
-- let them finish and to say why; see setupStudentRealtimeStageSync.)
--
-- A stage that is open for everyone (the old global switch) cannot be revoked
-- for some sections -- there is nothing section-specific to remove. It is
-- refused with a message rather than silently doing nothing; close it for
-- everyone first (admin_set_stage_open).
--
-- Requires 0003 (pia_stage_open users), 0033 (stage_overrides) and
-- 0020-0024 (pia_caller_role, jwt_is_current).
-- SAFE TO RE-RUN. The postflight rehearses it and rolls back.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.stage_overrides') is null then
    raise exception 'PIA 0036 ABORT (nothing changed): public.stage_overrides is missing -- apply 0033 first.' using errcode = 'P0001';
  end if;
  if to_regprocedure('public.pia_stage_open(text)') is null
     or to_regprocedure('public.pia_caller_role()') is null
     or to_regprocedure('public.jwt_is_current()') is null then
    raise exception 'PIA 0036 ABORT (nothing changed): pia_stage_open / pia_caller_role / jwt_is_current is missing.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.admin_revoke_stage(p_stage text, p_sections text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label    text;
  v_sections text[];
  v_moved    int := 0;
  v_cleared  int := 0;
begin
  if public.pia_caller_role() is distinct from 'admin' or not public.jwt_is_current() then
    raise exception 'PIA: only an administrator can revoke a stage.' using errcode = '42501';
  end if;

  if p_stage is null or p_stage not in ('ocean', 'char', 'dash') then
    raise exception 'PIA: unknown stage key: %', coalesce(p_stage, '(null)') using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct s), '{}') into v_sections
    from (select nullif(trim(x), '') as s from unnest(coalesce(p_sections, '{}')) x) t
   where s is not null;

  if coalesce(array_length(v_sections, 1), 0) = 0 then
    raise exception 'PIA: choose at least one section to revoke.' using errcode = '22023';
  end if;

  if public.pia_stage_open('stage_' || p_stage) then
    raise exception 'PIA: this stage is open for every section. Close it for everyone first; it cannot be revoked one section at a time.'
      using errcode = 'P0001';
  end if;

  v_label := case p_stage when 'ocean' then 'OCEAN'
                          when 'char'  then 'Character Selection'
                          else 'Tutoring Dashboard' end;

  with gone as (
    delete from public.stage_overrides
     where stage = p_stage and section = any (v_sections)
    returning 1)
  select count(*) into v_cleared from gone;

  with moved as (
    update public.profiles
       set current_stage = 'Waiting Room', stage_started_at = now()
     where current_stage = v_label
       and section = any (v_sections)
       and lower(trim(coalesce(role, 'student'))) = 'student'
    returning 1)
  select count(*) into v_moved from moved;

  return jsonb_build_object('stage', p_stage, 'sections', to_jsonb(v_sections),
                            'cleared', v_cleared, 'moved', v_moved);
end;
$$;

revoke all on function public.admin_revoke_stage(text, text[]) from public, anon;
grant execute on function public.admin_revoke_stage(text, text[]) to authenticated;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT -- rolled back.
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin   text;
  v_iat     bigint := extract(epoch from clock_timestamp())::bigint + 5;
  v_res     jsonb;
  v_n       int;
  v_before  bigint;
  v_fail    text := '';
begin
  if has_function_privilege('anon', 'public.admin_revoke_stage(text, text[])', 'EXECUTE') then
    raise exception 'PIA 0036 ABORT: anon can call admin_revoke_stage.' using errcode = 'P0001';
  end if;

  select email into v_admin from public.profiles where lower(trim(role)) = 'admin' order by email limit 1;
  if v_admin is null then
    raise notice 'PIA 0036: no administrator to rehearse with -- skipped.';
    return;
  end if;

  begin
    -- Two probe students in two probe sections, both inside the stage, with a
    -- recorded section grant each. The stage itself is closed.
    delete from public.settings where key = 'stage_dash';
    insert into public.settings (key, value) values ('stage_dash', to_jsonb(false));

    -- (Consent and assent recorded: 0037 refuses a student row without both.)
    insert into public.profiles (email, full_name, role, section, current_stage, is_ocean_done,
                                 parental_consent, student_assent)
    values ('probe-a@pia-0036.test', 'Probe A', 'student', 'PIA-0036-A', 'Tutoring Dashboard', true, true, true),
           ('probe-b@pia-0036.test', 'Probe B', 'student', 'PIA-0036-B', 'Tutoring Dashboard', true, true, true);
    insert into public.stage_overrides (stage, section, granted_count)
    values ('dash', 'PIA-0036-A', 1), ('dash', 'PIA-0036-B', 1);

    select count(*) into v_before from public.profiles where email like 'probe-%@pia-0036.test';

    perform set_config('request.jwt.claims', json_build_object(
      'email', v_admin, 'role', 'authenticated', 'iat', v_iat)::text, true);
    execute 'set local role authenticated';

    v_res := public.admin_revoke_stage('dash', array['PIA-0036-A']);
    execute 'reset role';

    -- A. section A is out; section B is exactly as it was
    if (select current_stage from public.profiles where email = 'probe-a@pia-0036.test') <> 'Waiting Room' then
      v_fail := v_fail || 'the named section was not moved; '; end if;
    if (select current_stage from public.profiles where email = 'probe-b@pia-0036.test') <> 'Tutoring Dashboard' then
      v_fail := v_fail || 'an unnamed section was moved; '; end if;
    select count(*) into v_n from public.stage_overrides where stage = 'dash' and section = 'PIA-0036-A';
    if v_n <> 0 then v_fail := v_fail || 'the named section''s record stayed; '; end if;
    select count(*) into v_n from public.stage_overrides where stage = 'dash' and section = 'PIA-0036-B';
    if v_n <> 1 then v_fail := v_fail || 'an unnamed section''s record was removed; '; end if;

    -- B. no student row was deleted or altered beyond the stage
    select count(*) into v_n from public.profiles where email like 'probe-%@pia-0036.test';
    if v_n <> v_before then v_fail := v_fail || 'a student row disappeared; '; end if;
    if not (select is_ocean_done from public.profiles where email = 'probe-a@pia-0036.test') then
      v_fail := v_fail || 'a student''s progress flag changed; '; end if;

    -- C. refused for a non-admin, for no sections, and for a globally open stage
    perform set_config('request.jwt.claims', json_build_object(
      'email', 'probe-b@pia-0036.test', 'role', 'authenticated', 'iat', v_iat)::text, true);
    execute 'set local role authenticated';
    begin
      perform public.admin_revoke_stage('dash', array['PIA-0036-B']);
      v_fail := v_fail || 'a student could revoke; ';
    exception when sqlstate '42501' then null;
    end;
    execute 'reset role';

    perform set_config('request.jwt.claims', json_build_object(
      'email', v_admin, 'role', 'authenticated', 'iat', v_iat)::text, true);
    execute 'set local role authenticated';
    begin
      perform public.admin_revoke_stage('dash', array[]::text[]);
      v_fail := v_fail || 'an empty section list was accepted; ';
    exception when sqlstate '22023' then null;
    end;
    execute 'reset role';

    update public.settings set value = to_jsonb(true) where key = 'stage_dash';
    execute 'set local role authenticated';
    begin
      perform public.admin_revoke_stage('dash', array['PIA-0036-B']);
      v_fail := v_fail || 'a globally open stage was revoked per section; ';
    exception when sqlstate 'P0001' then null;
    end;
    execute 'reset role';

    if v_fail <> '' then
      raise exception 'PIA 0036 ABORT: %', v_fail using errcode = 'P0001';
    end if;
    raise exception 'rehearsal done' using errcode = 'P0002';
  exception
    when sqlstate 'P0002' then
      raise notice 'PIA 0036 OK: only the named sections are revoked, their students return to the Waiting Room, nothing else changes, and only administrators can do it.';
  end;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';
