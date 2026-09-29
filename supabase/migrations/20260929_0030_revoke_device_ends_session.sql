-- ============================================================================
-- PIA 0030 -- REVOKING A DEVICE ENDS ITS SESSION, ON THE SERVER
-- ============================================================================
-- Until now a "device" was only a label in profiles.active_devices. Revoking
-- one removed the label; the login on that device kept working, because
-- nothing tied the label to the auth session that registered it, and no
-- policy or function ever read the list. The admin console's Revoke button
-- said "That session has been signed out", which was not true.
--
-- WHAT CHANGES
--   profiles.device_sessions   jsonb, { "<device id>": "<auth session id>" }.
--                              Written by claim_device() from the JWT's
--                              session_id claim, dropped by release_device().
--                              reset_my_devices() (0025) and
--                              claim_student_session() (0027), which also
--                              write the device list, keep it in step.
--   admin_revoke_device()      now ends the session recorded for each device
--                              it removes: the row in auth.sessions and its
--                              refresh tokens are deleted, so that browser can
--                              no longer renew its login.
--   jwt_is_current()           now also refuses a token whose session no
--                              longer exists in auth.sessions. Without this
--                              the revoked browser would keep working until
--                              its access token expired on its own (up to an
--                              hour). It is the one test every policy and
--                              every protected function already runs, so a
--                              deleted session is refused everywhere at once.
--
-- WHAT IT CANNOT DO
--   A device registered BEFORE this migration has no recorded session, so
--   revoking it can only remove it from the list. admin_revoke_device()
--   reports how many devices were in that position ("unbound") and the
--   console says so instead of claiming a kill. "Sign out everywhere"
--   (admin_revoke_sessions) still ends every session of an account and is
--   the way to reach those. Each device registers its session the next time
--   it loads a page, so the gap closes by itself.
--
-- ORDER. Apply this AFTER 0027 and 0029 if they have not been run yet: their
-- postflights rehearse a lesson with an invented session_id that does not
-- exist in auth.sessions, which the check above (correctly) refuses. This
-- migration's own postflight uses real sessions and rolls everything back.
--
-- ROLLBACK, if jwt_is_current() ever has to be put back as it was (0020):
--   the body is  v_iat := ...; select sessions_revoked_at ...;
--   return v_revoked is null or to_timestamp(v_iat) >= v_revoked;
--   i.e. this function without the auth.sessions test. The added column and
--   the other functions are harmless to leave in place.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- PREFLIGHT
-- ---------------------------------------------------------------------------
do $$
declare
  v_problems text := '';
  v_fn       text;
begin
  foreach v_fn in array array['public.jwt_is_current()', 'public.pia_caller_role()',
                              'public.claim_device(text)', 'public.release_device(text)',
                              'public.admin_revoke_device(text,text)'] loop
    if to_regprocedure(v_fn) is null then
      v_problems := v_problems || v_fn || ' is missing; ';
    end if;
  end loop;

  if to_regclass('auth.sessions') is null or to_regclass('auth.refresh_tokens') is null then
    v_problems := v_problems || 'auth.sessions / auth.refresh_tokens is missing; ';
  else
    if not has_table_privilege(current_user, 'auth.sessions', 'DELETE') then
      v_problems := v_problems || format('%s cannot DELETE from auth.sessions; ', current_user);
    end if;
    if not has_table_privilege(current_user, 'auth.sessions', 'SELECT') then
      v_problems := v_problems || format('%s cannot SELECT from auth.sessions; ', current_user);
    end if;
  end if;

  if v_problems <> '' then
    raise exception 'PIA 0030 ABORT (nothing changed): %', v_problems using errcode = 'P0001';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 1. Which session registered which device.
--    Not on the student write whitelist (0001 is a whitelist), so a student
--    cannot edit it; the postflight proves that.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists device_sessions jsonb not null default '{}'::jsonb;

comment on column public.profiles.device_sessions is
  '{ device id: auth session id } for the devices in active_devices. Written by claim_device(); '
  'lets admin_revoke_device() end the session behind a device (0030).';


-- ---------------------------------------------------------------------------
-- 2. jwt_is_current -- the 0020 body, plus: the token's session must still
--    exist. A token without a session_id claim (very old tokens) is judged by
--    the revocation stamp alone, exactly as before.
-- ---------------------------------------------------------------------------
create or replace function public.jwt_is_current()
 returns boolean
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_revoked timestamptz;
  v_iat     bigint;
  v_sid     uuid;
begin
  v_iat := nullif(auth.jwt() ->> 'iat', '')::bigint;
  if v_iat is null then return false; end if;

  select sessions_revoked_at into v_revoked from public.profiles where email = auth.jwt() ->> 'email';
  if v_revoked is not null and to_timestamp(v_iat) < v_revoked then return false; end if;

  begin
    v_sid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    v_sid := null;
  end;

  -- The session was deleted (a device revoked, "Sign out everywhere", an
  -- account removed): this token is finished, whatever its expiry says.
  if v_sid is not null and not exists (select 1 from auth.sessions s where s.id = v_sid) then
    return false;
  end if;

  return true;
end;
$function$;

grant execute on function public.jwt_is_current() to authenticated;


-- ---------------------------------------------------------------------------
-- 3. claim_device -- the production body, plus recording the session.
--    An already-known device refreshes its recorded session (a device that
--    signs in again has a new one).
-- ---------------------------------------------------------------------------
create or replace function public.claim_device(p_device_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_sid     text := nullif(auth.jwt() ->> 'session_id', '');
  v_max     int;
  v_devices text[];
  v_map     jsonb;
begin
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.'
      using errcode = '42501';
  end if;

  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;

  if p_device_id is null or length(trim(p_device_id)) = 0 then
    raise exception 'PIA: a device id is required.' using errcode = '22023';
  end if;

  -- FOR UPDATE: two sign-ins racing on one account are served one after the other.
  select coalesce(p.max_devices, 1), coalesce(p.active_devices, '{}'), coalesce(p.device_sessions, '{}'::jsonb)
    into v_max, v_devices, v_map
    from public.profiles p
   where p.email = v_email
     for update;

  if not found then
    raise exception 'PIA: no profile found for this session.' using errcode = '42501';
  end if;

  -- Known device: nothing to add (idempotent), but keep its session current.
  if p_device_id = any(v_devices) then
    if v_sid is not null and (v_map ->> p_device_id) is distinct from v_sid then
      update public.profiles
         set device_sessions = v_map || jsonb_build_object(p_device_id, v_sid)
       where email = v_email;
    end if;
    return jsonb_build_object('allowed', true, 'devices', v_devices, 'max', v_max);
  end if;

  if coalesce(array_length(v_devices, 1), 0) >= v_max then
    return jsonb_build_object(
      'allowed', false,
      'reason', v_max || ' device limit reached. Please sign out on your other device first.',
      'devices', v_devices, 'max', v_max);
  end if;

  update public.profiles
     set active_devices  = array_append(v_devices, p_device_id),
         device_sessions = case when v_sid is null then v_map
                                else v_map || jsonb_build_object(p_device_id, v_sid) end
   where email = v_email;

  return jsonb_build_object('allowed', true,
                            'devices', array_append(v_devices, p_device_id),
                            'max', v_max);
end;
$function$;

revoke all on function public.claim_device(text) from public, anon;
grant execute on function public.claim_device(text) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. release_device (sign-out) -- the 0020 body, plus forgetting the session.
--    It is deliberately not behind jwt_is_current(): a device that is being
--    signed out must still be able to free its slot.
-- ---------------------------------------------------------------------------
create or replace function public.release_device(p_device_id text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_email text := auth.jwt() ->> 'email';
begin
    if v_email is null then return; end if;
    update public.profiles
       set active_devices  = coalesce(array_remove(active_devices, p_device_id), '{}'),
           device_sessions = coalesce(device_sessions, '{}'::jsonb) - p_device_id
     where email = v_email;
end;
$function$;

grant execute on function public.release_device(text) to authenticated;


-- ---------------------------------------------------------------------------
-- 5. admin_revoke_device -- removes the device AND ends its session.
--    p_device_id NULL removes every device of the account.
--    Returns { devices, removed, sessions_ended, unbound }.
-- ---------------------------------------------------------------------------
create or replace function public.admin_revoke_device(p_email text, p_device_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_devices text[];
  v_map     jsonb;
  v_new     text[];
  v_gone    text[];
  v_uid     uuid;
  v_sids    uuid[] := '{}';
  v_ended   int := 0;
  v_unbound int := 0;
  d         text;
  s         text;
begin
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;
  if public.pia_caller_role() is distinct from 'admin' then
    raise exception 'PIA: only an admin can revoke a device.' using errcode = '42501';
  end if;

  select coalesce(p.active_devices, '{}'), coalesce(p.device_sessions, '{}'::jsonb)
    into v_devices, v_map
    from public.profiles p
   where p.email = p_email
     for update;

  if not found then
    raise exception 'PIA: no profile for %', p_email using errcode = '22023';
  end if;

  if p_device_id is null then
    v_gone := v_devices;
    v_new  := '{}';
  else
    v_gone := array(select x from unnest(v_devices) x where x = p_device_id);
    v_new  := array(select x from unnest(v_devices) x where x is distinct from p_device_id);
  end if;

  -- The session behind each removed device, where one was recorded.
  foreach d in array v_gone loop
    s := v_map ->> d;
    if s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_sids := array_append(v_sids, s::uuid);
    else
      v_unbound := v_unbound + 1;
    end if;
    v_map := v_map - d;
  end loop;

  -- End them. Scoped to this account's own sessions, so a wrong id in the map
  -- can never sign anybody else out.
  select u.id into v_uid from auth.users u where lower(u.email) = lower(p_email) limit 1;

  if v_uid is not null and coalesce(array_length(v_sids, 1), 0) > 0 then
    with gone as (
      delete from auth.sessions where id = any(v_sids) and user_id = v_uid returning 1
    )
    select count(*) into v_ended from gone;

    delete from auth.refresh_tokens where session_id = any(v_sids) and user_id = v_uid::text;
  end if;

  update public.profiles
     set active_devices = v_new, device_sessions = v_map
   where email = p_email;

  return jsonb_build_object(
    'devices',        v_new,
    'removed',        coalesce(array_length(v_gone, 1), 0),
    'sessions_ended', v_ended,
    'unbound',        v_unbound);
end;
$$;

revoke all on function public.admin_revoke_device(text, text) from public, anon;
grant execute on function public.admin_revoke_device(text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 6. The two functions that write the device list themselves keep the map in
--    step. Edited IN PLACE from their live definitions (as 0022 did), so
--    nothing else in them changes; a function that is not installed is
--    skipped.
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig text;
  v_oid regprocedure;
  v_def text;
  v_new text;
begin
  foreach v_sig in array array['public.reset_my_devices(text)', 'public.claim_student_session(text)'] loop
    v_oid := to_regprocedure(v_sig);
    if v_oid is null then
      raise notice 'PIA 0030: % is not installed -- skipped.', v_sig;
      continue;
    end if;

    v_def := pg_get_functiondef(v_oid);
    if position('device_sessions' in v_def) > 0 then
      raise notice 'PIA 0030: % already records its session.', v_sig;
      continue;
    end if;

    v_new := regexp_replace(v_def,
      'active_devices\s*=\s*array\[v_device\]',
      'active_devices = array[v_device], device_sessions = jsonb_build_object(v_device, v_sid::text)');

    if v_new = v_def then
      raise exception 'PIA 0030 ABORT: could not add session tracking to % (its body has changed shape).', v_sig
        using errcode = 'P0001';
    end if;

    execute v_new;
    raise notice 'PIA 0030: % now records its session.', v_sig;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT -- with REAL sessions, as real users, all rolled back.
-- ---------------------------------------------------------------------------
do $$
declare
  v_sid     uuid;
  v_uid     uuid;
  v_target  text;
  v_admin   text;
  v_student text;
  v_iat     bigint := extract(epoch from clock_timestamp())::bigint + 5;
  v_res     jsonb;
  v_rows    int;
  v_left    text[];
  v_map     jsonb;
begin
  if has_function_privilege('anon', 'public.admin_revoke_device(text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.claim_device(text)', 'EXECUTE') then
    raise exception 'PIA 0030 ABORT: a device function is callable without signing in.' using errcode = 'P0001';
  end if;

  select p.email into v_admin from public.profiles p
   where lower(trim(p.role)) = 'admin' order by p.email limit 1;

  -- A real session, and the profile it belongs to.
  select s.id, s.user_id, p.email into v_sid, v_uid, v_target
    from auth.sessions s
    join auth.users u on u.id = s.user_id
    join public.profiles p on lower(p.email) = lower(u.email)
   order by s.created_at desc
   limit 1;

  if v_sid is null then
    raise notice 'PIA 0030: no live session to rehearse with -- the session tests are skipped.';
  else
    -- (a) A token is current while its session exists, and not after.
    begin
      perform set_config('request.jwt.claims', json_build_object(
        'email', v_target, 'sub', v_uid, 'role', 'authenticated',
        'iat', v_iat, 'session_id', v_sid)::text, true);

      if not public.jwt_is_current() then
        raise exception 'PIA 0030 ABORT: a live session is refused by jwt_is_current(). Rolling back.'
          using errcode = 'P0001';
      end if;

      delete from auth.sessions where id = v_sid;

      if public.jwt_is_current() then
        raise exception 'PIA 0030 ABORT: a deleted session is still accepted. Rolling back.'
          using errcode = 'P0001';
      end if;
      raise exception 'probe done' using errcode = 'P0002';
    exception
      when sqlstate 'P0002' then
        raise notice 'PIA 0030 OK: a token is refused the moment its session is deleted.';
    end;

    -- (b) Revoking a device ends the session recorded for it -- and ONLY that one.
    if v_admin is null then
      raise notice 'PIA 0030: no admin profile -- the revoke test is skipped.';
    else
      begin
        update public.profiles
           set active_devices  = array['pia-0030-probe', 'pia-0030-other'],
               device_sessions = jsonb_build_object('pia-0030-probe', v_sid::text)
         where lower(email) = lower(v_target);

        perform set_config('request.jwt.claims', json_build_object(
          'email', v_admin, 'role', 'authenticated', 'iat', v_iat)::text, true);
        execute 'set local role authenticated';
        v_res := public.admin_revoke_device(v_target, 'pia-0030-probe');
        execute 'reset role';

        if (v_res ->> 'sessions_ended')::int <> 1 or (v_res ->> 'removed')::int <> 1 then
          raise exception 'PIA 0030 ABORT: revoke reported %. Rolling back.', v_res using errcode = 'P0001';
        end if;
        if exists (select 1 from auth.sessions where id = v_sid) then
          raise exception 'PIA 0030 ABORT: the revoked device''s session is still alive. Rolling back.'
            using errcode = 'P0001';
        end if;

        select p.active_devices, p.device_sessions into v_left, v_map
          from public.profiles p where lower(p.email) = lower(v_target);
        if v_left is distinct from array['pia-0030-other'] or v_map <> '{}'::jsonb then
          raise exception 'PIA 0030 ABORT: the device list after revoke is % / %. Rolling back.', v_left, v_map
            using errcode = 'P0001';
        end if;

        -- A device with no recorded session is removed and reported, not
        -- silently counted as killed.
        execute 'set local role authenticated';
        v_res := public.admin_revoke_device(v_target, 'pia-0030-other');
        execute 'reset role';
        if (v_res ->> 'sessions_ended')::int <> 0 or (v_res ->> 'unbound')::int <> 1 then
          raise exception 'PIA 0030 ABORT: an unbound device was reported as %. Rolling back.', v_res
            using errcode = 'P0001';
        end if;

        raise exception 'probe done' using errcode = 'P0002';
      exception
        when sqlstate 'P0002' then
          raise notice 'PIA 0030 OK: revoking a device ends its own session only; an unbound device is reported as unbound.';
      end;
    end if;
  end if;

  -- (c) A student cannot write the new column.
  select p.email into v_student from public.profiles p
   where lower(trim(coalesce(p.role, 'student'))) = 'student' order by p.email limit 1;

  if v_student is null then
    raise notice 'PIA 0030: no student profile -- the write-guard test is skipped.';
  else
    begin
      perform set_config('request.jwt.claims', json_build_object(
        'email', v_student, 'role', 'authenticated', 'iat', v_iat)::text, true);
      execute 'set local role authenticated';
      update public.profiles set device_sessions = '{"x":"y"}'::jsonb where email = v_student;
      get diagnostics v_rows = row_count;
      execute 'reset role';
      if v_rows > 0 then
        raise exception 'PIA 0030 ABORT: a student can write device_sessions. Rolling back.'
          using errcode = 'P0001';
      end if;
      raise notice 'PIA 0030: the write probe matched no row (RLS hid it), so the guard could not be exercised.';
    exception
      when insufficient_privilege then
        raise notice 'PIA 0030 OK: a student writing device_sessions is refused (42501).';
    end;
  end if;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Report
select p.oid::regprocedure::text as function,
       case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'OPEN TO ANON' else 'not anon' end as anon_access,
       case when pg_get_functiondef(p.oid) ~ 'device_sessions|auth\.sessions' then 'tracks sessions' else '-' end as session_aware
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('jwt_is_current', 'claim_device', 'release_device', 'admin_revoke_device',
                     'reset_my_devices', 'claim_student_session')
 order by 1;
