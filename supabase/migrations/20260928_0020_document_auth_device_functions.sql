-- ============================================================================
-- PIA 0020 -- DOCUMENT THE LIVE AUTH / DEVICE FUNCTIONS
-- ============================================================================
-- Four functions the app depends on were created directly in the Supabase
-- dashboard and never lived in this repo:
--
--   jwt_is_current()                     the revocation check inside the
--                                        profiles RLS policies (0009)
--   release_device(p_device_id)          frees a device slot on sign-out
--                                        (executeForceLogout, function.js)
--   admin_revoke_sessions__inner(email)  "Sign out everywhere", behind the
--                                        admin guard 0011 put in front of it
--   admin_delete_user__inner(email)      "Delete participant", same guard
--
-- The bodies are copied VERBATIM from production (pg_get_functiondef,
-- 2026-09-28), comments included. Against production this migration changes
-- no behaviour: CREATE OR REPLACE with an identical body keeps each
-- function's owner and privileges, columns are added only if missing, the
-- guarded wrappers are created only if missing, and the two explicit grants
-- to `authenticated` restate access that role already has. Against a fresh
-- database it rebuilds what production has.
--
-- WHAT THEY ACTUALLY DO -- read before relying on them:
--
--   * admin_delete_user__inner deletes the profiles row and the auth.users
--     row, and NOTHING else. The response tables (ocean_submissions,
--     hint_consumptions, problem_serves, ...) key their rows by email with no
--     cascading foreign key, so a deleted participant's answers stay in the
--     database, no longer linked to any account. The admin console's delete
--     dialog currently says every response is removed; it is not.
--
--   * admin_revoke_sessions__inner stamps profiles.sessions_revoked_at and
--     empties active_devices. jwt_is_current() then rejects every access
--     token issued BEFORE that stamp. It does not touch auth.sessions, so the
--     student's refresh token still works: the next automatic refresh issues
--     a token that passes. The browser checks in function.js
--     (requireStudentSession, validateDeviceOnLoad) are what sign the student
--     out, on their next page load.
--
--   * release_device only edits the CALLER's own list (email from the JWT),
--     so it cannot free another account's slot -- the concern 0017 raised
--     without having seen the body.
--
-- The postflight at the end aborts (and rolls everything back) if any of the
-- six functions is missing, if an __inner function is callable from the
-- browser, or if a wrapper has lost its admin guard.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Columns these functions read and write. Production already has them (they
-- were added outside the migrations too); IF NOT EXISTS makes these no-ops.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists max_devices         int         default 1;
alter table public.profiles add column if not exists active_devices      text[]      default '{}';
alter table public.profiles add column if not exists sessions_revoked_at timestamptz;


-- ---------------------------------------------------------------------------
-- 1. jwt_is_current -- verbatim
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jwt_is_current()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_revoked timestamptz; v_iat bigint;
begin
    v_iat := nullif(auth.jwt() ->> 'iat', '')::bigint;
    if v_iat is null then return false; end if;
    select sessions_revoked_at into v_revoked from public.profiles where email = auth.jwt() ->> 'email';
    return v_revoked is null or to_timestamp(v_iat) >= v_revoked;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 2. release_device -- verbatim
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_device(p_device_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_email text := auth.jwt() ->> 'email';
begin
    if v_email is null then return; end if;
    update public.profiles set active_devices = coalesce(array_remove(active_devices, p_device_id), '{}') where email = v_email;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 3. admin_revoke_sessions__inner -- verbatim
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
end;
$function$;


-- ---------------------------------------------------------------------------
-- 4. admin_delete_user__inner -- verbatim
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_user__inner(target_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  -- 1. Burahin muna sa profiles para maiwasan ang foreign key constraint block
  DELETE FROM public.profiles WHERE email = target_email;

  -- 2. Saka burahin sa mismong auth.users
  DELETE FROM auth.users WHERE email = target_email;
END;
$function$;


-- ---------------------------------------------------------------------------
-- Privileges. Production already has exactly these (0011 locked the __inner
-- functions); on a fresh database CREATE FUNCTION would otherwise leave them
-- executable by PUBLIC -- i.e. any signed-in student could delete any account.
-- release_device and jwt_is_current only need to be callable by signed-in
-- users; their PUBLIC grant is left as it is so production stays untouched.
-- ---------------------------------------------------------------------------
revoke all on function public.admin_delete_user__inner(text)     from public, anon, authenticated;
revoke all on function public.admin_revoke_sessions__inner(text) from public, anon, authenticated;
grant execute on function public.release_device(text) to authenticated;
grant execute on function public.jwt_is_current()     to authenticated;


-- ---------------------------------------------------------------------------
-- The guarded wrappers the browser calls. 0011 generated them and 0013
-- translated their message; this recreates them in that final form ONLY if
-- they are missing (a fresh database), and never touches production's.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.admin_delete_user(text)') is null then
    execute $w$
      create function public.admin_delete_user(target_email text)
      returns void
      language plpgsql
      security definer
      set search_path = public, extensions
      as $body$
      begin
        if public.pia_caller_role() is distinct from 'admin' then
          raise exception 'PIA: only an admin may call admin_delete_user().'
            using errcode = '42501';
        end if;
        perform public.admin_delete_user__inner(target_email);
      end;
      $body$;
    $w$;
    revoke all on function public.admin_delete_user(text) from public, anon;
    grant execute on function public.admin_delete_user(text) to authenticated;
    raise notice 'PIA 0020: created missing wrapper admin_delete_user(text).';
  end if;

  if to_regprocedure('public.admin_revoke_sessions(text)') is null then
    execute $w$
      create function public.admin_revoke_sessions(p_email text)
      returns void
      language plpgsql
      security definer
      set search_path = public, extensions
      as $body$
      begin
        if public.pia_caller_role() is distinct from 'admin' then
          raise exception 'PIA: only an admin may call admin_revoke_sessions().'
            using errcode = '42501';
        end if;
        perform public.admin_revoke_sessions__inner(p_email);
      end;
      $body$;
    $w$;
    revoke all on function public.admin_revoke_sessions(text) from public, anon;
    grant execute on function public.admin_revoke_sessions(text) to authenticated;
    raise notice 'PIA 0020: created missing wrapper admin_revoke_sessions(text).';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT -- abort and roll back rather than leave a hole.
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn       text;
  v_problems text := '';
begin
  foreach v_fn in array array[
    'public.jwt_is_current()',
    'public.release_device(text)',
    'public.admin_revoke_sessions__inner(text)',
    'public.admin_delete_user__inner(text)',
    'public.admin_revoke_sessions(text)',
    'public.admin_delete_user(text)'
  ] loop
    if to_regprocedure(v_fn) is null then
      v_problems := v_problems || v_fn || ' is missing; ';
    end if;
  end loop;

  if v_problems = '' then
    if has_function_privilege('authenticated', 'public.admin_delete_user__inner(text)', 'EXECUTE')
       or has_function_privilege('anon', 'public.admin_delete_user__inner(text)', 'EXECUTE') then
      v_problems := v_problems || 'admin_delete_user__inner is callable from the browser; ';
    end if;
    if has_function_privilege('authenticated', 'public.admin_revoke_sessions__inner(text)', 'EXECUTE')
       or has_function_privilege('anon', 'public.admin_revoke_sessions__inner(text)', 'EXECUTE') then
      v_problems := v_problems || 'admin_revoke_sessions__inner is callable from the browser; ';
    end if;
    if pg_get_functiondef('public.admin_delete_user(text)'::regprocedure) !~ 'pia_caller_role' then
      v_problems := v_problems || 'admin_delete_user has no admin guard; ';
    end if;
    if pg_get_functiondef('public.admin_revoke_sessions(text)'::regprocedure) !~ 'pia_caller_role' then
      v_problems := v_problems || 'admin_revoke_sessions has no admin guard; ';
    end if;
    if not has_function_privilege('authenticated', 'public.release_device(text)', 'EXECUTE') then
      v_problems := v_problems || 'signed-in users cannot call release_device; ';
    end if;
    if not has_function_privilege('authenticated', 'public.jwt_is_current()', 'EXECUTE') then
      v_problems := v_problems || 'signed-in users cannot call jwt_is_current (the profiles policies would fail); ';
    end if;
  end if;

  if v_problems <> '' then
    raise exception 'PIA 0020 ABORT: %', v_problems using errcode = 'P0001';
  end if;

  raise notice 'PIA 0020 OK: all six functions present, __inner locked, wrappers guarded.';
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Report -- what the SQL editor shows after running.
select p.oid::regprocedure::text as function,
       case when has_function_privilege('authenticated', p.oid, 'EXECUTE')
            then 'callable by signed-in users' else 'locked' end as browser_access,
       case when pg_get_functiondef(p.oid) ~ 'pia_caller_role' then 'admin guard'
            when p.proname like '%\_\_inner' then 'inner (behind wrapper)'
            else '-' end as guard
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('jwt_is_current', 'release_device',
                     'admin_revoke_sessions', 'admin_revoke_sessions__inner',
                     'admin_delete_user', 'admin_delete_user__inner')
 order by 1;
