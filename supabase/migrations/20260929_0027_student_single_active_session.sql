-- ============================================================================
-- PIA 0027 -- ONE ACTIVE SESSION PER STUDENT (THE LATEST SIGN-IN WINS)
-- ============================================================================
-- A student signed in on two devices at once can answer on one while reading
-- hints on the other, and both write to the same research rows. Until now a
-- second sign-in was REFUSED at the device limit (claim_device, max_devices),
-- which mostly punished the honest case: a lab PC closed without signing out.
--
-- Now, for STUDENTS ONLY, the newest sign-in takes over, like Spotify:
--
--   claim_student_session(p_device_id)
--     Called by the sign-in form (auth.js) right after the password check.
--     Records THIS auth session (the JWT's session_id claim) as the account's
--     only active one, and cuts every other device off at the database:
--       * sessions_revoked_at is stamped with this token's issue time, so
--         jwt_is_current() (0020-0024) refuses every older token at once --
--         in every RLS policy and every student function. A superseded device
--         cannot save one more answer, even before its page notices.
--       * the other devices' auth.sessions and refresh tokens are deleted, so
--         they cannot mint a fresh token that would pass that check.
--       * active_devices becomes this device alone, so the existing device
--         checks in function.js keep agreeing with the database.
--     This is the same cut reset_my_devices() (0025) makes, without the
--     email code: the password was just checked, and taking over your own
--     account is now the intended behaviour rather than an exception.
--
--   check_student_session()
--     The 10-second heartbeat asks this. It answers for the CALLER only:
--       'active'    carry on
--       'replaced'  another device signed in after this one
--       'revoked'   an admin used "Sign out everywhere"
--       'none'      no profile (account deleted) or no identity
--     Deliberately NOT refused for a stale token: a superseded device must
--     still be able to learn WHY it was cut off, so it can say so. It returns
--     nothing but that one word about the caller's own account.
--
-- TEACHERS AND ADMINS ARE UNTOUCHED. Both functions check the role on the
-- profile row and do nothing for staff: no stamp, no deleted sessions, and
-- check_student_session() always answers 'active'. Teachers keep the device
-- slots of claim_device(); admins keep no limit at all.
--
-- ACCOUNTS ALREADY SIGNED IN WHEN THIS RUNS have no active session yet. The
-- first heartbeat from such an account adopts its session as the active one,
-- so nobody is thrown out by the deploy itself; if a student happens to be on
-- two devices at that moment, the first to check in keeps the account.
--
-- A token without a session_id claim (only very old GoTrue versions issue
-- one) cannot be tracked, so it is never enforced against -- fail open for
-- availability. Every Supabase project today issues the claim.
--
-- STUDENTS CANNOT WRITE THE NEW COLUMNS. The profile write guard (0001) is a
-- whitelist, so a column added later is protected automatically. The
-- postflight proves it as a real student under RLS.
--
-- SAFE TO RE-RUN: columns are added only if missing, functions are replaced.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- PREFLIGHT -- the pieces this relies on.
-- ---------------------------------------------------------------------------
do $$
declare
  v_problems text := '';
begin
  if to_regprocedure('public.jwt_is_current()') is null then
    v_problems := v_problems || 'jwt_is_current() is missing (run 0020 first); ';
  end if;
  if to_regclass('auth.sessions') is null then
    v_problems := v_problems || 'auth.sessions is missing; ';
  end if;
  if to_regclass('auth.refresh_tokens') is null then
    v_problems := v_problems || 'auth.refresh_tokens is missing; ';
  end if;
  if v_problems = '' then
    if not has_table_privilege(current_user, 'auth.sessions', 'DELETE') then
      v_problems := v_problems || format('%s cannot DELETE from auth.sessions; ', current_user);
    end if;
    if not has_table_privilege(current_user, 'auth.refresh_tokens', 'DELETE') then
      v_problems := v_problems || format('%s cannot DELETE from auth.refresh_tokens; ', current_user);
    end if;
  end if;

  if v_problems <> '' then
    raise exception 'PIA 0027 ABORT (nothing changed): %', v_problems using errcode = 'P0001';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists active_session_id uuid;
alter table public.profiles add column if not exists active_session_at timestamptz;

comment on column public.profiles.active_session_id is
  'Students only: the auth session (JWT session_id) that may use this account. '
  'Written by claim_student_session(); a newer sign-in replaces it (0027).';
comment on column public.profiles.active_session_at is
  'When active_session_id was last claimed (0027).';


-- ---------------------------------------------------------------------------
-- 2. The claim -- the sign-in form calls this right after the password check.
-- ---------------------------------------------------------------------------
create or replace function public.claim_student_session(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email  text   := auth.jwt() ->> 'email';
  v_uid    uuid   := nullif(auth.jwt() ->> 'sub', '')::uuid;
  v_sid    uuid   := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_iat    bigint := nullif(auth.jwt() ->> 'iat', '')::bigint;
  v_device text   := trim(coalesce(p_device_id, ''));
  v_role   text;
  v_active uuid;
begin
  if v_email is null or v_uid is null or v_iat is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;

  -- A token an admin already revoked may not take the account back.
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;

  if v_device = '' or length(v_device) > 120 then
    raise exception 'PIA: a device id is required.' using errcode = '22023';
  end if;

  -- FOR UPDATE: two sign-ins racing on one account are served one after the
  -- other, so exactly one of them ends up active. The role is read from the
  -- row itself -- the claim must work before anything else on the page does.
  select lower(trim(coalesce(p.role, 'student'))), p.active_session_id
    into v_role, v_active
    from public.profiles p
   where p.email = v_email
     for update;

  if not found then
    raise exception 'PIA: no profile found for this session.' using errcode = '42501';
  end if;

  -- Staff are never limited to one session.
  if v_role in ('admin', 'teacher') then
    return jsonb_build_object('ok', true, 'enforced', false);
  end if;

  -- Cannot be tracked without the claim; let the sign-in through.
  if v_sid is null then
    return jsonb_build_object('ok', true, 'enforced', false);
  end if;

  -- Already the active session (a repeated call): nothing to cut off.
  if v_active is not distinct from v_sid then
    return jsonb_build_object('ok', true, 'enforced', true);
  end if;

  update public.profiles
     set active_session_id   = v_sid,
         active_session_at   = now(),
         -- Every token issued before this one is now stale; this one is not.
         sessions_revoked_at = greatest(coalesce(sessions_revoked_at, '-infinity'::timestamptz),
                                        to_timestamp(v_iat)),
         active_devices      = array[v_device]
   where email = v_email;

  -- The other devices lose their refresh tokens; this session stays.
  delete from auth.sessions
   where user_id = v_uid and id <> v_sid;
  delete from auth.refresh_tokens
   where user_id = v_uid::text and session_id is distinct from v_sid;

  return jsonb_build_object('ok', true, 'enforced', true);
end;
$$;

revoke all on function public.claim_student_session(text) from public, anon;
grant execute on function public.claim_student_session(text) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. The heartbeat check.
-- ---------------------------------------------------------------------------
create or replace function public.check_student_session()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email  text := auth.jwt() ->> 'email';
  v_sid    uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_role   text;
  v_active uuid;
begin
  if v_email is null then
    return jsonb_build_object('status', 'none');
  end if;

  select lower(trim(coalesce(p.role, 'student'))), p.active_session_id
    into v_role, v_active
    from public.profiles p
   where p.email = v_email;

  if not found then
    return jsonb_build_object('status', 'none');
  end if;

  if v_role in ('admin', 'teacher') then
    return jsonb_build_object('status', 'active');
  end if;

  -- Checked BEFORE the revocation test on purpose: a takeover also stamps
  -- sessions_revoked_at, and the student should be told the real reason.
  if v_active is not null and v_sid is not null and v_active <> v_sid then
    return jsonb_build_object('status', 'replaced');
  end if;

  if not public.jwt_is_current() then
    return jsonb_build_object('status', 'revoked');
  end if;

  -- Signed in before 0027 existed: adopt this session. "is null" in the
  -- WHERE keeps it first-come -- a second device checking in a moment later
  -- finds the slot taken and is told 'replaced' on its next beat.
  if v_active is null and v_sid is not null then
    update public.profiles
       set active_session_id = v_sid,
           active_session_at = now()
     where email = v_email and active_session_id is null;
  end if;

  return jsonb_build_object('status', 'active');
end;
$$;

revoke all on function public.check_student_session() from public, anon;
grant execute on function public.check_student_session() to authenticated;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT -- as a real student and a real teacher, under the
-- authenticated role. Every probe rolls back (P0002), including the session
-- deletes the claim performs.
-- ---------------------------------------------------------------------------
do $$
declare
  v_student text;
  v_uid     uuid;
  v_teacher text;
  v_tuid    uuid;
  v_iat     bigint := extract(epoch from clock_timestamp())::bigint + 1;
  v_sid_a   uuid   := gen_random_uuid();
  v_sid_b   uuid   := gen_random_uuid();
  v_res     jsonb;
  v_status  text;
  v_rows    int;
begin
  if has_function_privilege('anon', 'public.claim_student_session(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.check_student_session()', 'EXECUTE') then
    raise exception 'PIA 0027 ABORT: a session function is callable without signing in.' using errcode = 'P0001';
  end if;

  select p.email, u.id into v_student, v_uid
    from public.profiles p join auth.users u on lower(u.email) = lower(p.email)
   where lower(trim(coalesce(p.role, 'student'))) = 'student'
   order by p.email limit 1;

  if v_student is null then
    raise notice 'PIA 0027: no student with a sign-in account to probe with -- skipped.';
  else
    -- (a) Device A signs in, then device B: B is active, A is replaced, and
    --     A's older token is refused by jwt_is_current() everywhere.
    begin
      perform set_config('request.jwt.claims', json_build_object(
        'email', v_student, 'sub', v_uid, 'role', 'authenticated',
        'iat', v_iat, 'session_id', v_sid_a)::text, true);
      execute 'set local role authenticated';
      perform public.claim_student_session('pia-0027-device-a');

      perform set_config('request.jwt.claims', json_build_object(
        'email', v_student, 'sub', v_uid, 'role', 'authenticated',
        'iat', v_iat + 5, 'session_id', v_sid_b)::text, true);
      perform public.claim_student_session('pia-0027-device-b');
      v_status := public.check_student_session() ->> 'status';
      if v_status <> 'active' then
        raise exception 'PIA 0027 ABORT: the newest sign-in reads as %, not active. Rolling back.', v_status
          using errcode = 'P0001';
      end if;

      perform set_config('request.jwt.claims', json_build_object(
        'email', v_student, 'sub', v_uid, 'role', 'authenticated',
        'iat', v_iat, 'session_id', v_sid_a)::text, true);
      v_status := public.check_student_session() ->> 'status';
      if v_status <> 'replaced' then
        raise exception 'PIA 0027 ABORT: the superseded device reads as %, not replaced. Rolling back.', v_status
          using errcode = 'P0001';
      end if;
      if public.jwt_is_current() then
        raise exception 'PIA 0027 ABORT: the superseded device''s token is still accepted. Rolling back.'
          using errcode = 'P0001';
      end if;
      execute 'reset role';
      raise exception 'probe done' using errcode = 'P0002';
    exception
      when sqlstate 'P0002' then
        raise notice 'PIA 0027 OK: the latest sign-in is active; the earlier device is told "replaced" and its token is refused.';
    end;

    -- (b) A student cannot write the new columns from the browser.
    begin
      perform set_config('request.jwt.claims', json_build_object(
        'email', v_student, 'role', 'authenticated', 'iat', v_iat + 10)::text, true);
      execute 'set local role authenticated';
      update public.profiles
         set active_session_id = gen_random_uuid()
       where email = v_student;
      get diagnostics v_rows = row_count;
      execute 'reset role';
      if v_rows > 0 then
        raise exception 'PIA 0027 ABORT: a student can write active_session_id. Rolling back.'
          using errcode = 'P0001';
      end if;
      raise notice 'PIA 0027: the write probe matched no row (RLS hid it), so the guard could not be exercised.';
    exception
      when insufficient_privilege then
        raise notice 'PIA 0027 OK: a student writing active_session_id is refused (42501).';
    end;
  end if;

  -- (c) A teacher is never limited: the claim changes nothing and the check
  --     always answers active.
  select p.email, u.id into v_teacher, v_tuid
    from public.profiles p join auth.users u on lower(u.email) = lower(p.email)
   where lower(trim(p.role)) = 'teacher'
   order by p.email limit 1;

  if v_teacher is null then
    raise notice 'PIA 0027: no teacher with a sign-in account to probe with -- skipped.';
  else
    begin
      perform set_config('request.jwt.claims', json_build_object(
        'email', v_teacher, 'sub', v_tuid, 'role', 'authenticated',
        'iat', v_iat, 'session_id', v_sid_a)::text, true);
      execute 'set local role authenticated';
      v_res := public.claim_student_session('pia-0027-teacher');
      v_status := public.check_student_session() ->> 'status';
      execute 'reset role';
      if (v_res ->> 'enforced')::boolean or v_status <> 'active' then
        raise exception 'PIA 0027 ABORT: a teacher was put under the one-session rule. Rolling back.'
          using errcode = 'P0001';
      end if;
      raise exception 'probe done' using errcode = 'P0002';
    exception
      when sqlstate 'P0002' then
        raise notice 'PIA 0027 OK: teachers stay multi-device.';
    end;
  end if;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Report -- what the SQL editor shows after running.
select p.oid::regprocedure::text as function,
       case when has_function_privilege('authenticated', p.oid, 'EXECUTE')
            then 'callable by signed-in users' else 'locked' end as browser_access,
       case when has_function_privilege('anon', p.oid, 'EXECUTE')
            then 'OPEN TO ANON' else 'not anon' end as anon_access
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('claim_student_session', 'check_student_session')
 order by 1;
