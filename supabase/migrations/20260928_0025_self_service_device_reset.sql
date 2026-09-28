-- ============================================================================
-- PIA 0025 -- SELF-SERVICE "SIGN OUT OF OTHER DEVICES"
-- ============================================================================
-- A student or teacher who closed a browser without signing out used to be
-- stuck at "1 device limit reached" on every other computer until an admin
-- cleared their slot. Now the refused sign-in offers "Sign out of other
-- devices": the site emails a one-time code, and once it is entered on THIS
-- device, reset_my_devices() below
--   * ends every other session of the account -- their refresh tokens are
--     deleted, and every access token issued before this one is refused by
--     jwt_is_current() (0022-0024);
--   * keeps THIS session alive;
--   * makes this device the account's only registered device.
--
-- WHY THE EMAIL CODE, AND HOW IT IS ENFORCED HERE
-- The sign-in form already checked the password. The code adds proof that
-- the person also controls the mailbox, so a shared or leaked password is
-- not enough to push the real owner off their device. That proof is checked
-- HERE, not only in the browser: the caller's token must carry an email-based
-- authentication method (amr) -- a code, a magic link, a recovery or an
-- invite -- from the last 15 minutes. A session opened with only a password
-- cannot call this, even straight from the browser console.
--
-- KEEPING THIS SESSION
--   * sessions_revoked_at is stamped with THIS token's issue time, so every
--     token issued earlier (the other devices) is stale and this one is not.
--   * auth.sessions is emptied for the account EXCEPT this token's session
--     (the session_id claim), so only the other devices lose their refresh
--     tokens.
--
-- Emails are sent by Supabase Auth (signInWithOtp), not by this function.
-- The "Magic Link" email template must show the code -- {{ .Token }} -- for
-- the code to reach the student; see the notes that came with this change.
--
-- The postflight tries it as a real student under the authenticated role:
-- a password-only session is refused, an email-verified one succeeds and
-- leaves exactly this device registered with this session current. Every
-- probe rolls back.
-- ============================================================================

begin;

create or replace function public.reset_my_devices(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email   text   := auth.jwt() ->> 'email';
  v_uid     uuid   := nullif(auth.jwt() ->> 'sub', '')::uuid;
  v_sid     uuid   := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_iat     bigint := nullif(auth.jwt() ->> 'iat', '')::bigint;
  v_device  text   := trim(coalesce(p_device_id, ''));
  v_fresh   boolean;
begin
  if v_email is null or v_uid is null or v_iat is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;

  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;

  if v_device = '' or length(v_device) > 120 then
    raise exception 'PIA: a device id is required.' using errcode = '22023';
  end if;

  -- The mailbox proof: an email-based sign-in on this session, recently.
  select exists (
    select 1
      from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) as m
     where m ->> 'method' in ('otp', 'magiclink', 'recovery', 'invite', 'email/signup')
       and nullif(m ->> 'timestamp', '')::bigint >= extract(epoch from now())::bigint - 900
  ) into v_fresh;

  if not v_fresh then
    raise exception 'PIA: confirm it is you with the code from your email first.' using errcode = '42501';
  end if;

  -- Every token issued before this one is now stale; this one is not.
  update public.profiles
     set sessions_revoked_at = greatest(coalesce(sessions_revoked_at, '-infinity'::timestamptz),
                                        to_timestamp(v_iat)),
         active_devices      = array[v_device]
   where email = v_email;

  if not found then
    raise exception 'PIA: no profile found for this session.' using errcode = '42501';
  end if;

  -- The other devices' sessions and refresh tokens go; this session stays.
  -- (With no session_id claim there is nothing to spare, so all go -- this
  -- device then keeps working until its current token expires.)
  delete from auth.sessions
   where user_id = v_uid and (v_sid is null or id <> v_sid);
  delete from auth.refresh_tokens
   where user_id = v_uid::text and (v_sid is null or session_id is distinct from v_sid);

  return jsonb_build_object('ok', true, 'devices', array[v_device]);
end;
$$;

revoke all on function public.reset_my_devices(text) from public, anon;
grant execute on function public.reset_my_devices(text) to authenticated;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT
-- ---------------------------------------------------------------------------
do $$
declare
  v_student text;
  v_uid     uuid;
  v_iat     bigint := extract(epoch from clock_timestamp())::bigint + 1;
  v_sid     uuid   := gen_random_uuid();
  v_devices text[];
  v_current boolean;
begin
  if has_function_privilege('anon', 'public.reset_my_devices(text)', 'EXECUTE') then
    raise exception 'PIA 0025 ABORT: reset_my_devices is callable without signing in.' using errcode = 'P0001';
  end if;

  select p.email, u.id into v_student, v_uid
    from public.profiles p join auth.users u on lower(u.email) = lower(p.email)
   where lower(trim(coalesce(p.role, 'student'))) = 'student'
   order by p.email limit 1;

  if v_student is null then
    raise notice 'PIA 0025: no student with a sign-in account to probe with -- skipped.';
    return;
  end if;

  -- (a) A password-only session is refused.
  begin
    perform set_config('request.jwt.claims', json_build_object(
      'email', v_student, 'sub', v_uid, 'role', 'authenticated', 'iat', v_iat, 'session_id', v_sid,
      'amr', json_build_array(json_build_object('method', 'password', 'timestamp', v_iat)))::text, true);
    execute 'set local role authenticated';
    perform public.reset_my_devices('pia-0025-probe');
    execute 'reset role';
    raise exception 'PIA 0025 ABORT: a password-only session reset the devices. Rolling back.' using errcode = 'P0001';
  exception
    when insufficient_privilege then
      if sqlerrm not like '%code from your email%' then raise; end if;
      raise notice 'PIA 0025 OK: a password-only session is refused.';
  end;

  -- (b) An email-verified session succeeds: this device alone is registered,
  --     and this token is still current afterwards.
  begin
    perform set_config('request.jwt.claims', json_build_object(
      'email', v_student, 'sub', v_uid, 'role', 'authenticated', 'iat', v_iat, 'session_id', v_sid,
      'amr', json_build_array(json_build_object('method', 'otp', 'timestamp', v_iat)))::text, true);
    execute 'set local role authenticated';
    perform public.reset_my_devices('pia-0025-probe');
    v_current := public.jwt_is_current();
    execute 'reset role';

    select active_devices into v_devices from public.profiles where email = v_student;
    if v_devices is distinct from array['pia-0025-probe'] then
      raise exception 'PIA 0025 ABORT: the device list is % after a reset. Rolling back.', v_devices
        using errcode = 'P0001';
    end if;
    if not v_current then
      raise exception 'PIA 0025 ABORT: the reset signed out the very session that asked for it. Rolling back.'
        using errcode = 'P0001';
    end if;
    raise exception 'probe done' using errcode = 'P0002';
  exception
    when sqlstate 'P0002' then
      raise notice 'PIA 0025 OK: an email-verified reset keeps this session and registers only this device.';
  end;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';
