-- ============================================================================
-- PIA 0021 -- TRUE HARD DELETE, INSTANT SESSION REVOCATION, NO DEVICE BYPASS
-- ============================================================================
-- Three fixes to the functions 0020 documented. Each closes a gap between
-- what the admin console promises and what the database did.
--
-- 1. DELETE PARTICIPANT REMOVES EVERYTHING
--    admin_delete_user__inner removed only the profiles row and the auth.users
--    row. Every answer the participant gave stayed behind, keyed by an email
--    that no longer belonged to anyone -- while the console's dialog promised
--    "every collected response for this participant is removed". For a
--    participant who withdraws consent, the data must go too. It now deletes,
--    children before parents:
--      hint_consumptions, problem_serves, math_attempt_log, tutoring_attempts,
--      ocean_submissions,
--      then ANY other public table with a student_email, user_email or
--      participant_email column (and session_start_log by its email) -- this
--      covers session_start_log and the tutoring-session table
--      start_game_session() writes, both created outside this repo, and any
--      such table added later,
--      then the profile, then the sign-in account.
--    Matching is case-insensitive: GoTrue stores auth emails lower-cased, and
--    the telemetry rows carry the JWT's email, so a profile typed as
--    "Juan@School.edu" used to leave both its auth user and its answers.
--
-- 2. "SIGN OUT EVERYWHERE" ENDS THE SESSIONS THEMSELVES
--    admin_revoke_sessions__inner stamped sessions_revoked_at, which makes
--    jwt_is_current() reject older access tokens -- but the refresh tokens
--    lived on, and the next automatic refresh minted a token that passed. It
--    now also deletes the account's auth.sessions (their refresh tokens go
--    with them) and any legacy refresh token not tied to a session. The
--    revoked browser can no longer renew; its current access token is
--    refused by every RLS policy at once and simply runs out.
--
-- 3. STUDENTS CAN NO LONGER EDIT THEIR OWN DEVICE LIST
--    0001's write guard let a student UPDATE their own active_devices, so the
--    browser console could empty the list and walk past the device limit. No
--    page ever needed that: every device change goes through claim_device,
--    release_device or admin_revoke_device, which are SECURITY DEFINER and
--    pass the guard's trusted path. 'active_devices' is removed from the
--    guard's student whitelist. The guard is edited IN PLACE from its live
--    definition (the way 0013 translated it), so nothing else in it changes.
--
-- SAFE TO RE-RUN: CREATE OR REPLACE keeps each function's owner and
-- privileges, and step 3 skips itself once the column is gone.
--
-- The preflight aborts before changing anything if a table or column this
-- relies on is missing, or if the functions' owner lacks DELETE on the auth
-- tables. The postflight proves the device bypass is closed by attempting it
-- as a real student under RLS, and rolls everything back if it succeeds.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- PREFLIGHT
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner    text;
  v_problems text := '';
  r          record;
begin
  -- The response tables and the column each is keyed by.
  for r in
    select * from (values
      ('hint_consumptions', 'student_email'),
      ('problem_serves',    'student_email'),
      ('math_attempt_log',  'student_email'),
      ('tutoring_attempts', 'student_email'),
      ('ocean_submissions', 'email')
    ) as t(tbl, col)
  loop
    if not exists (
      select 1
        from pg_attribute a
        join pg_class c     on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = r.tbl
         and a.attname = r.col and not a.attisdropped
    ) then
      v_problems := v_problems || format('public.%s.%s is missing; ', r.tbl, r.col);
    end if;
  end loop;

  if to_regclass('auth.sessions') is null then
    v_problems := v_problems || 'auth.sessions is missing; ';
  end if;
  if to_regclass('auth.refresh_tokens') is null then
    v_problems := v_problems || 'auth.refresh_tokens is missing; ';
  end if;

  -- CREATE OR REPLACE keeps the current owner, so THAT role must be able to
  -- delete from the auth tables.
  select pg_get_userbyid(p.proowner) into v_owner
    from pg_proc p where p.oid = 'public.admin_revoke_sessions__inner(text)'::regprocedure;

  if v_problems = '' then
    if not has_table_privilege(v_owner, 'auth.sessions', 'DELETE') then
      v_problems := v_problems || format('%s cannot DELETE from auth.sessions; ', v_owner);
    end if;
    if not has_table_privilege(v_owner, 'auth.refresh_tokens', 'DELETE') then
      v_problems := v_problems || format('%s cannot DELETE from auth.refresh_tokens; ', v_owner);
    end if;
    if not has_table_privilege(v_owner, 'auth.users', 'DELETE') then
      v_problems := v_problems || format('%s cannot DELETE from auth.users; ', v_owner);
    end if;
  end if;

  if v_problems <> '' then
    raise exception 'PIA 0021 ABORT (nothing changed): %', v_problems using errcode = 'P0001';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 1. Hard delete
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_user__inner(target_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_email text := lower(trim(target_email));
  r       record;
begin
  if v_email is null or v_email = '' then
    raise exception 'PIA: an email address is required.' using errcode = '22023';
  end if;

  -- 1. Every collected response, children before parents (the same order as
  --    WIPE_test_data.sql, so any foreign key between them stays satisfied).
  delete from public.hint_consumptions where lower(student_email) = v_email;
  delete from public.problem_serves    where lower(student_email) = v_email;
  delete from public.math_attempt_log  where lower(student_email) = v_email;
  delete from public.tutoring_attempts where lower(student_email) = v_email;
  delete from public.ocean_submissions where lower(email)         = v_email;

  -- 2. Any other per-participant table, found by its owner column the way
  --    0017 found them: student_email / user_email / participant_email, plus
  --    session_start_log's plain `email` (0017 allowed any of the four for
  --    it). This covers session_start_log and whatever table
  --    start_game_session() writes -- both created outside this repo -- and
  --    anything added later. Runs after step 1, so the tables above that
  --    point at a session are already empty for this participant.
  for r in
    select c.relname, a.attname
      from pg_attribute a
      join pg_class c     on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and not a.attisdropped
       and (a.attname in ('student_email', 'user_email', 'participant_email')
            or (c.relname = 'session_start_log' and a.attname = 'email'))
       and c.relname not in ('hint_consumptions', 'problem_serves',
                             'math_attempt_log', 'tutoring_attempts')
  loop
    execute format('delete from public.%I where lower(%I) = $1', r.relname, r.attname)
      using v_email;
  end loop;

  -- 3. The profile, then the sign-in account. Deleting the auth user also
  --    removes its sessions and refresh tokens.
  delete from public.profiles where lower(email) = v_email;
  delete from auth.users      where lower(email) = v_email;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 2. Instant session revocation
--    The original admin check and profile update are unchanged; the two
--    deletes at the end are new.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_revoke_sessions__inner(p_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
    if not exists (select 1 from public.profiles where email = auth.jwt() ->> 'email' and lower(trim(role)) = 'admin') then
        raise exception 'Only an admin may revoke sessions.';
    end if;
    update public.profiles set sessions_revoked_at = now(), active_devices = '{}' where email = p_email;

    -- End the sessions themselves, not just the tokens' standing: without a
    -- refresh token the revoked browser cannot mint a new access token that
    -- would pass jwt_is_current(). Refresh tokens cascade with their session;
    -- the second delete catches any legacy token that was never tied to one.
    delete from auth.sessions
     where user_id in (select u.id from auth.users u where lower(u.email) = lower(p_email));
    delete from auth.refresh_tokens
     where user_id in (select u.id::text from auth.users u where lower(u.email) = lower(p_email));
end;
$function$;


-- ---------------------------------------------------------------------------
-- 3. Take active_devices off the student whitelist, in place.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.enforce_profile_write_scope()'::regprocedure);

  if position('''active_devices''' in v_def) = 0 then
    raise notice 'PIA 0021: active_devices is already off the student whitelist.';
    return;
  end if;

  v_new := regexp_replace(v_def, '''active_devices'',\s*', '');

  if v_new = v_def or position('''active_devices''' in v_new) > 0 then
    raise exception
      'PIA 0021 ABORT: the whitelist in enforce_profile_write_scope() is not in the expected form; edit it by hand.'
      using errcode = 'P0001';
  end if;

  execute v_new;
  raise notice 'PIA 0021: active_devices removed from the student whitelist.';
end;
$$;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT
-- ---------------------------------------------------------------------------
do $$
declare
  v_def      text;
  v_problems text := '';
  v_student  text;
  v_rows     int;
begin
  v_def := pg_get_functiondef('public.admin_delete_user__inner(text)'::regprocedure);
  if v_def !~ 'ocean_submissions' or v_def !~ 'tutoring_attempts' or v_def !~ 'student_email' then
    v_problems := v_problems || 'admin_delete_user__inner does not clear the response tables; ';
  end if;

  v_def := pg_get_functiondef('public.admin_revoke_sessions__inner(text)'::regprocedure);
  if v_def !~ 'auth\.sessions' then
    v_problems := v_problems || 'admin_revoke_sessions__inner does not end auth.sessions; ';
  end if;

  if has_function_privilege('authenticated', 'public.admin_delete_user__inner(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.admin_revoke_sessions__inner(text)', 'EXECUTE') then
    v_problems := v_problems || 'an __inner function is callable from the browser; ';
  end if;

  if v_problems <> '' then
    raise exception 'PIA 0021 ABORT: %', v_problems using errcode = 'P0001';
  end if;

  -- Prove the device bypass is closed: act as a real student, under RLS, and
  -- try to add a device to their own list. The write guard must refuse with
  -- 42501. Every change is rolled back either way.
  select email into v_student
    from public.profiles
   where lower(trim(coalesce(role, 'student'))) = 'student'
   order by email limit 1;

  if v_student is null then
    raise notice 'PIA 0021: no student profile to test the device guard with -- skipped.';
  else
    perform set_config('request.jwt.claims',
      json_build_object('email', v_student, 'role', 'authenticated',
                        'iat', extract(epoch from now())::bigint)::text, true);
    begin
      execute 'set local role authenticated';
      update public.profiles
         set active_devices = coalesce(active_devices, '{}') || 'pia-0021-probe'::text
       where email = v_student;
      get diagnostics v_rows = row_count;
      execute 'reset role';

      if v_rows > 0 then
        raise exception
          'PIA 0021 ABORT: a student can still write active_devices -- rolling everything back.'
          using errcode = 'P0001';
      end if;
      raise notice 'PIA 0021: the probe matched no row (RLS hid it), so the guard could not be exercised.';
    exception
      when insufficient_privilege then
        raise notice 'PIA 0021 OK: a student writing active_devices is refused (42501).';
    end;
    perform set_config('request.jwt.claims', '', true);
  end if;
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Report -- what "Delete participant" now clears, in order.
select 1 as step, 'public.' || t.tbl || ' (' || t.col || ')' as deletes_from
  from (values ('hint_consumptions', 'student_email'), ('problem_serves', 'student_email'),
               ('math_attempt_log', 'student_email'), ('tutoring_attempts', 'student_email'),
               ('ocean_submissions', 'email')) as t(tbl, col)
union all
select 2, 'public.' || c.relname || ' (' || a.attname || ', found automatically)'
  from pg_attribute a
  join pg_class c     on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p') and not a.attisdropped
   and (a.attname in ('student_email', 'user_email', 'participant_email')
        or (c.relname = 'session_start_log' and a.attname = 'email'))
   and c.relname not in ('hint_consumptions', 'problem_serves', 'math_attempt_log', 'tutoring_attempts')
union all
select 3, 'public.profiles, then auth.users (with its sessions)'
 order by 1, 2;
