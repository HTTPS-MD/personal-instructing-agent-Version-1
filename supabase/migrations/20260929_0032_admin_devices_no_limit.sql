-- ============================================================================
-- PIA 0032 -- NO DEVICE LIMIT FOR ADMINISTRATORS; DEAD DEVICES ARE FORGOTTEN
-- ============================================================================
-- The admin console no longer offers a "maximum devices" setting. What an
-- administrator keeps is the list of browsers signed in to their account and
-- the power to end any of them (admin_revoke_device, 0030). This migration
-- makes the database match:
--
--   1. claim_device() never refuses an ADMINISTRATOR for being "full". The
--      limit still applies to everyone else exactly as before (teachers keep
--      their slots; students use one active session since 0027).
--
--   2. claim_device() forgets devices whose login no longer exists. A device
--      id lives in localStorage, so a cleared browser or a private window
--      becomes a new "device" and the old entry stays behind for ever --
--      without a limit the list would only ever grow, and a list of dead
--      entries is no use for spotting a device you do not recognise. An
--      entry is removed only when the auth session recorded for it (0030's
--      device_sessions) is gone: that token is already refused everywhere
--      by jwt_is_current(), so nothing that works is lost. An entry with no
--      recorded session (registered before 0030) is left for the owner to
--      revoke. This applies to every role, and for teachers it also frees
--      the slots that used to trigger "device limit reached" after a lab PC
--      was closed without signing out.
--
-- profiles.max_devices is kept (teachers use it; 0031 still holds an
-- administrator's value at 2..10) -- it is simply not consulted for admins.
--
-- The body is 0030's claim_device with those two additions; nothing else in
-- it changes. The postflight rehearses both as a real admin (and a real
-- teacher, if there is one) and rolls everything back.
--
-- Requires 0030 (device_sessions, the session-aware jwt_is_current).
-- ============================================================================

begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'device_sessions') then
    raise exception 'PIA 0032 ABORT (nothing changed): profiles.device_sessions is missing -- run 0030 first.'
      using errcode = 'P0001';
  end if;
end;
$$;


create or replace function public.claim_device(p_device_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_sid     text := nullif(auth.jwt() ->> 'session_id', '');
  v_role    text;
  v_max     int;
  v_devices text[];
  v_map     jsonb;
  v_dead    text[] := '{}';
  d         text;
  s         text;
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
  select lower(trim(coalesce(p.role, 'student'))), coalesce(p.max_devices, 1),
         coalesce(p.active_devices, '{}'), coalesce(p.device_sessions, '{}'::jsonb)
    into v_role, v_max, v_devices, v_map
    from public.profiles p
   where p.email = v_email
     for update;

  if not found then
    raise exception 'PIA: no profile found for this session.' using errcode = '42501';
  end if;

  -- 0032: forget devices whose recorded login no longer exists.
  foreach d in array v_devices loop
    s := v_map ->> d;
    if s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and not exists (select 1 from auth.sessions x where x.id = s::uuid) then
      v_dead := array_append(v_dead, d);
    end if;
  end loop;

  if coalesce(array_length(v_dead, 1), 0) > 0 then
    v_devices := array(select x from unnest(v_devices) x where not (x = any(v_dead)));
    foreach d in array v_dead loop
      v_map := v_map - d;
    end loop;
    update public.profiles
       set active_devices = v_devices, device_sessions = v_map
     where email = v_email;
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

  -- 0032: the limit does not apply to administrators.
  if v_role <> 'admin' and coalesce(array_length(v_devices, 1), 0) >= v_max then
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
-- POSTFLIGHT -- rolled back.
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin   text;
  v_teacher text;
  v_iat     bigint := extract(epoch from clock_timestamp())::bigint + 5;
  v_res     jsonb;
  v_left    text[];
  v_fail    text := '';
begin
  select email into v_admin from public.profiles where lower(trim(role)) = 'admin' order by email limit 1;
  select email into v_teacher from public.profiles where lower(trim(role)) = 'teacher' order by email limit 1;

  if v_admin is null then
    raise notice 'PIA 0032: no administrator to rehearse with -- skipped.';
    return;
  end if;

  begin
    -- As the owner: an admin at their limit (2), holding one dead device
    -- (its recorded session does not exist) and one unbound device.
    perform set_config('request.jwt.claims', '', true);
    update public.profiles
       set max_devices = 2,
           active_devices = array['pia-0032-dead', 'pia-0032-unbound'],
           device_sessions = jsonb_build_object('pia-0032-dead', gen_random_uuid()::text)
     where email = v_admin;

    -- As that admin, from a new browser.
    perform set_config('request.jwt.claims', json_build_object(
      'email', v_admin, 'role', 'authenticated', 'iat', v_iat)::text, true);
    execute 'set local role authenticated';
    v_res := public.claim_device('pia-0032-new');
    execute 'reset role';

    select active_devices into v_left from public.profiles where email = v_admin;
    if not (v_res ->> 'allowed')::boolean then
      v_fail := v_fail || 'an administrator was refused a device; ';
    end if;
    if 'pia-0032-dead' = any(v_left) then
      v_fail := v_fail || 'a device with a dead login was kept; ';
    end if;
    if not ('pia-0032-unbound' = any(v_left)) then
      v_fail := v_fail || 'a device with no recorded login was removed; ';
    end if;
    if not ('pia-0032-new' = any(v_left)) then
      v_fail := v_fail || 'the new device was not registered; ';
    end if;

    -- A teacher still has a limit.
    if v_teacher is not null then
      perform set_config('request.jwt.claims', '', true);
      update public.profiles
         set max_devices = 1, active_devices = array['pia-0032-teacher-pc'], device_sessions = '{}'::jsonb
       where email = v_teacher;

      perform set_config('request.jwt.claims', json_build_object(
        'email', v_teacher, 'role', 'authenticated', 'iat', v_iat)::text, true);
      execute 'set local role authenticated';
      v_res := public.claim_device('pia-0032-teacher-phone');
      execute 'reset role';
      if (v_res ->> 'allowed')::boolean then
        v_fail := v_fail || 'a teacher at their limit was given another device; ';
      end if;
    else
      raise notice 'PIA 0032: no teacher to rehearse with -- the teacher limit test is skipped.';
    end if;

    if v_fail <> '' then
      raise exception 'PIA 0032 ABORT: %', v_fail using errcode = 'P0001';
    end if;
    raise exception 'rehearsal done' using errcode = 'P0002';
  exception
    when sqlstate 'P0002' then
      raise notice 'PIA 0032 OK: administrators have no device limit; dead devices are forgotten, unbound ones kept; teachers keep their limit.';
  end;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';
