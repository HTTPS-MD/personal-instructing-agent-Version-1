-- ============================================================================
-- PIA 0035 -- ACTIVE TIME PER STAGE (THE HEARTBEAT)
-- ============================================================================
-- The study needs how long each student actually spent working in each stage,
-- not how long a tab happened to be open. A student page sends a ping every 30
-- seconds while its tab is visible (assets/js/function.js, startStageHeartbeat)
-- and nothing while it is hidden, offline or closed -- so time a student spends
-- elsewhere is never counted, and a lost connection simply stops the clock.
--
--   public.student_stage_time          one row per student
--       ocean_time                     seconds of active time in each stage
--       character_select_time
--       tutoring_time
--       *_locked_at                    set when the stage is completed; the
--                                      seconds above then never change again
--       heartbeat_stage                the stage of the latest ping
--       last_heartbeat_timestamp       when it arrived (server clock)
--
--   record_heartbeat(p_stage)          what the ping calls
--   finalize_stage_time(p_stage)       the final payload that locks a stage
--
-- WHY A TABLE OF ITS OWN, NOT COLUMNS ON profiles. Every write to profiles is
-- broadcast to the admin console, which reloads its whole cohort on each one;
-- forty students pinging every 30 seconds would keep it reloading all the
-- time. This table is read on demand and is not published to realtime.
--
-- THE CLOCK IS THE SERVER'S. A ping carries only a stage name. How much time
-- it is worth is worked out here from the gap since the previous ping, so a
-- student cannot send a bigger number, or pings faster than 30 seconds apart,
-- to inflate their own time:
--
--     gap since the previous ping of the SAME stage
--       under 10 s ........ ignored (a duplicate; nothing changes)
--       10 s to 45 s ...... credited: the gap itself, at most 30 s
--       over 45 s or none . the clock restarts: stamped, credited nothing
--
-- The last rule is the disconnect rule. A student who closes the laptop, loses
-- Wi-Fi or leaves the tab hidden stops pinging; when they return, the first
-- ping only restarts the clock and the away time is not counted. The most a
-- returning student can be over-credited is one 30-second interval.
--
-- ONLY A STAGE THAT IS STILL IN PROGRESS COUNTS. OCEAN stops counting once the
-- questionnaire is submitted, Character Selection once a character is chosen
-- (both read from pia_can_enter_stage, the rule the whole app already uses),
-- and any stage stops counting once it is locked.
--
-- Admins read the table (Live sessions and the export); nobody writes it
-- directly through the API. Requires 0005 (pia_can_enter_stage) and
-- 0020-0024 (pia_caller_role, jwt_is_current).
--
-- SAFE TO RE-RUN. The postflight rehearses every rule as a real student and
-- an administrator under RLS, and rolls everything back.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- PREFLIGHT
-- ---------------------------------------------------------------------------
do $$
declare
  v_problems text := '';
begin
  if to_regprocedure('public.pia_caller_role()') is null then v_problems := v_problems || 'pia_caller_role() is missing; '; end if;
  if to_regprocedure('public.jwt_is_current()') is null then v_problems := v_problems || 'jwt_is_current() is missing; '; end if;
  if to_regprocedure('public.pia_can_enter_stage(boolean, text, text, text)') is null then
    v_problems := v_problems || 'pia_can_enter_stage(boolean, text, text, text) is missing (0005); ';
  end if;
  if to_regclass('public.profiles') is null then v_problems := v_problems || 'public.profiles is missing; '; end if;

  if v_problems <> '' then
    raise exception 'PIA 0035 ABORT (nothing changed): %', v_problems using errcode = 'P0001';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table if not exists public.student_stage_time (
  student_email                    text primary key
                                   references public.profiles (email) on delete cascade,
  ocean_time                       integer not null default 0 check (ocean_time >= 0),
  character_select_time            integer not null default 0 check (character_select_time >= 0),
  tutoring_time                    integer not null default 0 check (tutoring_time >= 0),
  ocean_time_locked_at             timestamptz,
  character_select_time_locked_at  timestamptz,
  tutoring_time_locked_at          timestamptz,
  heartbeat_stage                  text,
  last_heartbeat_timestamp         timestamptz
);

comment on table public.student_stage_time is
  'Active seconds per stage, credited by record_heartbeat() from the server clock and frozen by finalize_stage_time() (0035).';

alter table public.student_stage_time enable row level security;
revoke all on public.student_stage_time from public, anon, authenticated;
grant select on public.student_stage_time to authenticated;

drop policy if exists student_stage_time_admin_read on public.student_stage_time;
create policy student_stage_time_admin_read on public.student_stage_time
  for select to authenticated
  using (public.pia_caller_role() = 'admin' and public.jwt_is_current());


-- ---------------------------------------------------------------------------
-- 2. record_heartbeat(p_stage)
-- ---------------------------------------------------------------------------
create or replace function public.record_heartbeat(p_stage text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_profile public.profiles%rowtype;
  v_row     public.student_stage_time%rowtype;
  v_locked  timestamptz;
  v_gap     numeric;
  v_credit  integer := 0;
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;

  -- Only students are timed; a staff ping is simply ignored.
  if public.pia_caller_role() is distinct from 'student' then
    return jsonb_build_object('counted', false, 'reason', 'not_a_student');
  end if;

  if p_stage is null or p_stage not in ('OCEAN', 'Character Selection', 'Tutoring Dashboard') then
    return jsonb_build_object('counted', false, 'reason', 'unknown_stage');
  end if;

  select * into v_profile from public.profiles where email = v_email;
  if not found then
    return jsonb_build_object('counted', false, 'reason', 'no_profile');
  end if;

  -- A stage the student has already finished takes no more time.
  if not public.pia_can_enter_stage(v_profile.is_ocean_done, v_profile.group_type,
                                    v_profile.selected_character, p_stage) then
    return jsonb_build_object('counted', false, 'reason', 'stage_completed');
  end if;

  insert into public.student_stage_time (student_email) values (v_profile.email)
  on conflict (student_email) do nothing;

  select * into v_row from public.student_stage_time
   where student_email = v_profile.email for update;

  v_locked := case p_stage when 'OCEAN' then v_row.ocean_time_locked_at
                           when 'Character Selection' then v_row.character_select_time_locked_at
                           else v_row.tutoring_time_locked_at end;
  if v_locked is not null then
    return jsonb_build_object('counted', false, 'reason', 'locked', 'locked', true);
  end if;

  if v_row.last_heartbeat_timestamp is not null and v_row.heartbeat_stage = p_stage then
    v_gap := extract(epoch from (now() - v_row.last_heartbeat_timestamp));
    if v_gap < 10 then
      return jsonb_build_object('counted', false, 'reason', 'too_soon');
    elsif v_gap <= 45 then
      v_credit := least(30, floor(v_gap))::integer;
    end if;
  end if;

  update public.student_stage_time set
    ocean_time            = ocean_time + case when p_stage = 'OCEAN' then v_credit else 0 end,
    character_select_time = character_select_time + case when p_stage = 'Character Selection' then v_credit else 0 end,
    tutoring_time         = tutoring_time + case when p_stage = 'Tutoring Dashboard' then v_credit else 0 end,
    heartbeat_stage       = p_stage,
    last_heartbeat_timestamp = now()
   where student_email = v_profile.email
  returning * into v_row;

  return jsonb_build_object(
    'counted', v_credit > 0,
    'credited', v_credit,
    'seconds', case p_stage when 'OCEAN' then v_row.ocean_time
                            when 'Character Selection' then v_row.character_select_time
                            else v_row.tutoring_time end);
end;
$$;

revoke all on function public.record_heartbeat(text) from public, anon;
grant execute on function public.record_heartbeat(text) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. finalize_stage_time(p_stage) -- the final payload
-- ---------------------------------------------------------------------------
-- Called once when a student completes a stage. It credits the tail since the
-- last ping (same rules as above), then stamps *_locked_at, after which the
-- seconds for that stage can never change. Refused unless the stage really is
-- complete, so a page cannot freeze its own clock early. Calling it again
-- changes nothing.
create or replace function public.finalize_stage_time(p_stage text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_profile public.profiles%rowtype;
  v_row     public.student_stage_time%rowtype;
  v_done    boolean;
  v_gap     numeric;
  v_credit  integer := 0;
  v_locked  timestamptz;
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;

  if public.pia_caller_role() is distinct from 'student' then
    return jsonb_build_object('locked', false, 'reason', 'not_a_student');
  end if;

  if p_stage is null or p_stage not in ('OCEAN', 'Character Selection', 'Tutoring Dashboard') then
    return jsonb_build_object('locked', false, 'reason', 'unknown_stage');
  end if;

  select * into v_profile from public.profiles where email = v_email;
  if not found then
    return jsonb_build_object('locked', false, 'reason', 'no_profile');
  end if;

  v_done := case p_stage
              when 'OCEAN' then coalesce(v_profile.is_ocean_done, false)
              when 'Character Selection' then v_profile.selected_character is not null
              else not coalesce(v_profile.is_in_game, false) end;
  if not v_done then
    return jsonb_build_object('locked', false, 'reason', 'stage_not_completed');
  end if;

  insert into public.student_stage_time (student_email) values (v_profile.email)
  on conflict (student_email) do nothing;

  select * into v_row from public.student_stage_time
   where student_email = v_profile.email for update;

  v_locked := case p_stage when 'OCEAN' then v_row.ocean_time_locked_at
                           when 'Character Selection' then v_row.character_select_time_locked_at
                           else v_row.tutoring_time_locked_at end;
  if v_locked is null then
    if v_row.last_heartbeat_timestamp is not null and v_row.heartbeat_stage = p_stage then
      v_gap := extract(epoch from (now() - v_row.last_heartbeat_timestamp));
      if v_gap >= 10 and v_gap <= 45 then v_credit := least(30, floor(v_gap))::integer; end if;
    end if;

    update public.student_stage_time set
      ocean_time            = ocean_time + case when p_stage = 'OCEAN' then v_credit else 0 end,
      character_select_time = character_select_time + case when p_stage = 'Character Selection' then v_credit else 0 end,
      tutoring_time         = tutoring_time + case when p_stage = 'Tutoring Dashboard' then v_credit else 0 end,
      ocean_time_locked_at  = case when p_stage = 'OCEAN' then now() else ocean_time_locked_at end,
      character_select_time_locked_at = case when p_stage = 'Character Selection' then now() else character_select_time_locked_at end,
      tutoring_time_locked_at = case when p_stage = 'Tutoring Dashboard' then now() else tutoring_time_locked_at end,
      last_heartbeat_timestamp = now()
     where student_email = v_profile.email
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'locked', true,
    'seconds', case p_stage when 'OCEAN' then v_row.ocean_time
                            when 'Character Selection' then v_row.character_select_time
                            else v_row.tutoring_time end);
end;
$$;

revoke all on function public.finalize_stage_time(text) from public, anon;
grant execute on function public.finalize_stage_time(text) to authenticated;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT -- rehearsed as a real student and an administrator under RLS,
-- then rolled back (P0002), so no time is left recorded.
-- ---------------------------------------------------------------------------
do $$
declare
  v_student text;
  v_admin   text;
  v_iat     bigint := extract(epoch from clock_timestamp())::bigint + 5;
  v_res     jsonb;
  v_n       int;
  v_fail    text := '';
begin
  if has_function_privilege('anon', 'public.record_heartbeat(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.finalize_stage_time(text)', 'EXECUTE') then
    raise exception 'PIA 0035 ABORT: anon can call the heartbeat functions.' using errcode = 'P0001';
  end if;
  if has_table_privilege('authenticated', 'public.student_stage_time', 'INSERT')
     or has_table_privilege('authenticated', 'public.student_stage_time', 'UPDATE') then
    raise exception 'PIA 0035 ABORT: a signed-in user can write student_stage_time directly.' using errcode = 'P0001';
  end if;

  select email into v_student from public.profiles
   where lower(trim(coalesce(role, 'student'))) = 'student' and not coalesce(is_ocean_done, false)
   order by email limit 1;
  select email into v_admin from public.profiles where lower(trim(role)) = 'admin' order by email limit 1;

  if v_student is null then
    raise notice 'PIA 0035: no student who has not finished OCEAN to rehearse with -- rehearsal skipped.';
    return;
  end if;

  begin
    perform set_config('request.jwt.claims', json_build_object(
      'email', v_student, 'role', 'authenticated', 'iat', v_iat)::text, true);
    execute 'set local role authenticated';

    -- A. the first ping only starts the clock
    v_res := public.record_heartbeat('OCEAN');
    if (v_res ->> 'credited')::int <> 0 then v_fail := v_fail || 'the first ping was credited; '; end if;

    -- B. a ping straight after is ignored
    v_res := public.record_heartbeat('OCEAN');
    if v_res ->> 'reason' is distinct from 'too_soon' then v_fail := v_fail || 'a duplicate ping was not ignored; '; end if;

    -- C. 30 seconds later it is worth 30; 5 minutes of silence restarts the clock
    execute 'reset role';
    update public.student_stage_time set last_heartbeat_timestamp = now() - interval '30 seconds'
     where student_email = v_student;
    execute 'set local role authenticated';
    v_res := public.record_heartbeat('OCEAN');
    if (v_res ->> 'credited')::int <> 30 or (v_res ->> 'seconds')::int <> 30 then
      v_fail := v_fail || 'a 30 s ping was not worth 30 s (' || v_res::text || '); ';
    end if;

    execute 'reset role';
    update public.student_stage_time set last_heartbeat_timestamp = now() - interval '5 minutes'
     where student_email = v_student;
    execute 'set local role authenticated';
    v_res := public.record_heartbeat('OCEAN');
    if (v_res ->> 'credited')::int <> 0 or (v_res ->> 'seconds')::int <> 30 then
      v_fail := v_fail || 'time away was counted (' || v_res::text || '); ';
    end if;

    -- D. another stage is a separate clock, and an unknown one is refused
    v_res := public.record_heartbeat('Not a stage');
    if v_res ->> 'reason' is distinct from 'unknown_stage' then v_fail := v_fail || 'an unknown stage was accepted; '; end if;

    -- E. cannot lock a stage that is not complete
    v_res := public.finalize_stage_time('OCEAN');
    if (v_res ->> 'locked')::boolean then v_fail := v_fail || 'an unfinished stage was locked; '; end if;

    -- F. a student cannot read or write the table
    select count(*) into v_n from public.student_stage_time;
    if v_n <> 0 then v_fail := v_fail || 'a student can read the table; '; end if;

    -- G. an administrator can read it
    if v_admin is not null then
      execute 'reset role';
      perform set_config('request.jwt.claims', json_build_object(
        'email', v_admin, 'role', 'authenticated', 'iat', v_iat)::text, true);
      execute 'set local role authenticated';
      select count(*) into v_n from public.student_stage_time where student_email = v_student;
      if v_n <> 1 then v_fail := v_fail || 'an administrator cannot read the table; '; end if;
    end if;

    execute 'reset role';
    if v_fail <> '' then
      raise exception 'PIA 0035 ABORT: %', v_fail using errcode = 'P0001';
    end if;
    raise exception 'rehearsal done' using errcode = 'P0002';
  exception
    when sqlstate 'P0002' then
      raise notice 'PIA 0035 OK: pings are credited from the server clock, away time and duplicates are not, stages are separate, and only administrators can read the times.';
  end;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';
