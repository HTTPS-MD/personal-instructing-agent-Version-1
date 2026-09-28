-- ============================================================================
-- PIA 0026 -- TEACHER LIVE MONITOR, WITHIN THE CERC REDLINES
-- ============================================================================
-- The ethics protocol (CERC 2025-1-PTCS-231, p. 6) says teachers "will not
-- have access to individual personality labels", and every personality and
-- group detail stays with the research team. Until now a teacher could read
-- every column of every student row in their section (policy
-- profiles_select_teacher_section) -- ocean_*, group_type,
-- selected_character, pre/post-test scores -- and their dashboard's realtime
-- channel streamed those full rows on every change. Hiding columns in the page
-- does not help: the browser console can ask for them directly.
--
-- This replaces that access with ONE door that returns only what a teacher
-- running a 75-minute session needs:
--
--   teacher_class_status()   SECURITY DEFINER, teacher only, own section only.
--     Per student: display name, a status, problems finished this lesson, and
--     whether they need the teacher's attention (and why). Nothing else. The
--     function never selects a research column, so none can reach a teacher.
--
--   Statuses are deliberately GROUP-BLIND. "Character Selection" happens only
--   for the Non-Assigned group, so it is reported together with the OCEAN
--   questionnaire as one "Getting set up" -- a teacher cannot tell who chose
--   a tutor and who was given one.
--
--   "Needs attention" is BEHAVIOURAL, never a score: stuck on one problem 5+
--   minutes, idle 3+ minutes in the lesson, or dropped offline mid-lesson. It
--   asks the teacher to help with focus, access or navigation. Correctness
--   is deliberately not a trigger: it would invite math tutoring, which the
--   traditional-classroom comparison (H0c) must not get from a teacher
--   inside PIA sessions, and it would label children as weak in class.
--
-- ONLINE, HONESTLY. profiles had no reliable "is this student here" signal
-- (is_in_game is written by the student's own browser, and only during the
-- lesson). Student pages now call touch_presence() every 45 seconds; the
-- server stamps the time itself. It lives in its own small table so the
-- heartbeat does not churn profiles (every profiles change is broadcast to
-- the admin console). Its column is student_email, so "Delete participant"
-- (0021/0024) removes it with everything else.
--
-- REMOVED: profiles_select_teacher_section and
-- tutoring_attempts / attempts_select_teacher. Teachers keep their own
-- profile and faculty row; everything about students goes through the
-- function.
--
-- The postflight proves it with real accounts under the authenticated role:
-- a teacher can no longer read any student row directly, the function gives
-- them exactly their own section, a student cannot call it, and the result
-- carries no research column. Any failure rolls everything back.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Presence.
-- ---------------------------------------------------------------------------
create table if not exists public.student_presence (
  student_email text primary key,
  last_seen     timestamptz not null default now()
);

alter table public.student_presence enable row level security;
revoke all on public.student_presence from public, anon, authenticated;

create or replace function public.touch_presence(p_online boolean default true)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;

  -- Only students are monitored; a staff heartbeat is simply ignored.
  if public.pia_caller_role() is distinct from 'student' then
    return;
  end if;

  if p_online then
    insert into public.student_presence (student_email, last_seen)
    values (v_email, now())
    on conflict (student_email) do update set last_seen = excluded.last_seen;
  else
    delete from public.student_presence where student_email = v_email;
  end if;
end;
$$;

revoke all on function public.touch_presence(boolean) from public, anon;
grant execute on function public.touch_presence(boolean) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. The teacher's one door.
-- ---------------------------------------------------------------------------
create or replace function public.teacher_class_status()
returns table (
  student_key          text,     -- opaque row id (md5 of the email), not the email
  full_name            text,
  activity             text,     -- offline | waiting | setting_up | not_started
                                 -- | solving | idle | finished
  problems_done        int,
  problems_target      int,
  attention            text,     -- null | stuck | idle | dropped
  attention_minutes    int,
  seconds_since_active int,      -- since the last lesson action; null if none
  online               boolean
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_email    text := lower(auth.jwt() ->> 'email');
  v_section  text;
  -- Keep in step with SESSION_TARGET in student/js/student-dashboard.js.
  c_target   constant int      := 10;
  c_online   constant interval := '2 minutes';   -- heartbeat is every 45 s
  c_idle     constant interval := '3 minutes';
  c_stuck    constant interval := '5 minutes';
  c_dropped  constant interval := '15 minutes';
  c_window   constant interval := '3 hours';     -- "this class", generously
  r          record;
  v_seen     timestamptz;
  v_session  uuid;
  v_done     int;
  v_served   timestamptz;
  v_number   int;
  v_answered boolean;
  v_last     timestamptz;
begin
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;
  if public.pia_caller_role() is distinct from 'teacher' then
    raise exception 'PIA: only a teacher can view a class.' using errcode = '42501';
  end if;

  -- The same section the teacher dashboard shows: the teacher's profile,
  -- else the faculty record the admin assigned.
  select coalesce(
           nullif(trim(p.section), ''),
           (select nullif(trim(f.assigned_section), '') from public.professors f
             where lower(f.email) = v_email limit 1))
    into v_section
    from public.profiles p
   where lower(p.email) = v_email
   limit 1;

  if v_section is null then
    return;
  end if;

  for r in
    select p.email, p.full_name, p.current_stage
      from public.profiles p
     where p.section = v_section
       and lower(trim(coalesce(p.role, 'student'))) = 'student'
     order by p.full_name
  loop
    v_session := null; v_done := 0; v_served := null; v_number := null;
    v_answered := false; v_last := null;

    select sp.last_seen into v_seen
      from public.student_presence sp where sp.student_email = lower(r.email);

    -- This lesson: the student's most recent session in the class window.
    select ps.session_id into v_session
      from public.problem_serves ps
     where lower(ps.student_email) = lower(r.email) and ps.served_at > now() - c_window
     order by ps.served_at desc
     limit 1;

    if v_session is not null then
      select count(*) into v_done
        from public.tutoring_attempts t
       where t.session_id = v_session and lower(t.student_email) = lower(r.email);

      select ps.served_at, ps.problem_number into v_served, v_number
        from public.problem_serves ps
       where ps.session_id = v_session and lower(ps.student_email) = lower(r.email)
       order by ps.served_at desc
       limit 1;

      select exists (select 1 from public.tutoring_attempts t
                      where t.session_id = v_session and lower(t.student_email) = lower(r.email)
                        and t.problem_number = v_number)
        into v_answered;

      -- Any action counts: a new problem, an answer attempt, a hint.
      select greatest(
               v_served,
               (select max(a.attempted_at) from public.math_attempt_log a
                 where a.session_id = v_session and lower(a.student_email) = lower(r.email)),
               (select max(h.consumed_at) from public.hint_consumptions h
                 where h.session_id = v_session and lower(h.student_email) = lower(r.email)))
        into v_last;
    end if;

    student_key          := md5(lower(r.email));
    full_name            := coalesce(nullif(trim(r.full_name), ''), 'Unnamed student');
    problems_done        := least(v_done, c_target);
    problems_target      := c_target;
    online               := v_seen is not null and v_seen > now() - c_online;
    seconds_since_active := case when v_last is null then null
                                 else greatest(0, extract(epoch from now() - v_last))::int end;
    attention            := null;
    attention_minutes    := null;

    if not online then
      activity := 'offline';
      if v_session is not null and v_done < c_target and v_last > now() - c_dropped then
        attention := 'dropped';
        attention_minutes := floor(extract(epoch from now() - coalesce(v_seen, v_last)) / 60)::int;
      end if;
    elsif r.current_stage in ('OCEAN', 'Character Selection') then
      activity := 'setting_up';        -- one label for both: group-blind
    elsif r.current_stage is distinct from 'Tutoring Dashboard' then
      activity := 'waiting';
    elsif v_done >= c_target then
      activity := 'finished';
    elsif v_session is null then
      activity := 'not_started';
    elsif v_last > now() - c_idle then
      activity := 'solving';
    else
      activity := 'idle';
      attention := 'idle';
      attention_minutes := floor(extract(epoch from now() - v_last) / 60)::int;
    end if;

    -- On the same problem too long -- even while trying things, since hints
    -- and attempts keep "last action" fresh.
    if online and activity in ('solving', 'idle') and v_served is not null
       and not v_answered and v_served < now() - c_stuck then
      attention := 'stuck';
      attention_minutes := floor(extract(epoch from now() - v_served) / 60)::int;
    end if;

    return next;
  end loop;
end;
$$;

revoke all on function public.teacher_class_status() from public, anon;
grant execute on function public.teacher_class_status() to authenticated;


-- ---------------------------------------------------------------------------
-- 3. No more direct reads of student rows by teachers.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select_teacher_section on public.profiles;
drop policy if exists attempts_select_teacher          on public.tutoring_attempts;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT
-- ---------------------------------------------------------------------------
do $$
declare
  v_result   text := pg_get_function_result('public.teacher_class_status()'::regprocedure);
  v_teacher  text;
  v_section  text;
  v_student  text;
  v_expected int;
  v_seen     int;
begin
  if v_result ~* '(ocean|group|character|persona|pre_test|post_test|email|score)' then
    raise exception 'PIA 0026 ABORT: teacher_class_status returns a research column: %', v_result
      using errcode = 'P0001';
  end if;

  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename in ('profiles', 'tutoring_attempts')
                and coalesce(qual, '') ~ 'teacher') then
    raise exception 'PIA 0026 ABORT: a policy still grants teachers direct access to student rows.'
      using errcode = 'P0001';
  end if;

  -- A teacher with a section, resolved the same way the function does.
  select p.email,
         coalesce(nullif(trim(p.section), ''),
                  (select nullif(trim(f.assigned_section), '') from public.professors f
                    where lower(f.email) = lower(p.email) limit 1))
    into v_teacher, v_section
    from public.profiles p
   where lower(trim(p.role)) = 'teacher'
     and coalesce(nullif(trim(p.section), ''),
                  (select nullif(trim(f.assigned_section), '') from public.professors f
                    where lower(f.email) = lower(p.email) limit 1)) is not null
   order by p.email limit 1;

  select email into v_student from public.profiles
   where lower(trim(coalesce(role, 'student'))) = 'student' order by email limit 1;

  if v_teacher is null then
    raise notice 'PIA 0026: no teacher with a section to probe with -- skipped the teacher checks.';
  else
    select count(*) into v_expected from public.profiles
     where section = v_section and lower(trim(coalesce(role, 'student'))) = 'student';

    perform set_config('request.jwt.claims',
      json_build_object('email', v_teacher, 'role', 'authenticated',
                        'iat', extract(epoch from clock_timestamp())::bigint + 1)::text, true);
    execute 'set local role authenticated';
    select count(*) into v_seen from public.profiles
     where lower(trim(coalesce(role, 'student'))) = 'student';
    if v_seen <> 0 then
      execute 'reset role';
      raise exception 'PIA 0026 ABORT: teacher % can still read % student row(s) directly.', v_teacher, v_seen
        using errcode = 'P0001';
    end if;
    select count(*) into v_seen from public.teacher_class_status();
    execute 'reset role';

    if v_seen <> v_expected then
      raise exception 'PIA 0026 ABORT: teacher_class_status shows % of the % students in section %.',
        v_seen, v_expected, v_section using errcode = 'P0001';
    end if;
    raise notice 'PIA 0026 OK: teacher % sees all % students of section %, and no student row directly.',
      v_teacher, v_expected, v_section;
  end if;

  if v_student is not null then
    -- A student cannot open the class view.
    begin
      perform set_config('request.jwt.claims',
        json_build_object('email', v_student, 'role', 'authenticated',
                          'iat', extract(epoch from clock_timestamp())::bigint + 1)::text, true);
      execute 'set local role authenticated';
      perform count(*) from public.teacher_class_status();
      execute 'reset role';
      raise exception 'PIA 0026 ABORT: a student could open the class view.' using errcode = 'P0001';
    exception
      when insufficient_privilege then
        raise notice 'PIA 0026 OK: a student cannot open the class view.';
    end;

    -- A student's heartbeat is recorded by the server (rolled back).
    begin
      perform set_config('request.jwt.claims',
        json_build_object('email', v_student, 'role', 'authenticated',
                          'iat', extract(epoch from clock_timestamp())::bigint + 1)::text, true);
      execute 'set local role authenticated';
      perform public.touch_presence(true);
      execute 'reset role';
      if not exists (select 1 from public.student_presence where student_email = lower(v_student)) then
        raise exception 'PIA 0026 ABORT: touch_presence did not record the student.' using errcode = 'P0001';
      end if;
      raise exception 'probe done' using errcode = 'P0002';
    exception
      when sqlstate 'P0002' then
        raise notice 'PIA 0026 OK: a student''s heartbeat is recorded by the server.';
    end;
  end if;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';
