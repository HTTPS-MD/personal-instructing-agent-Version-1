-- ============================================================================
-- PIA 0012 -- (A) AYUSIN ANG gen_salt SEARCH_PATH   (B) ATOMIC DEVICE SLOTS
-- ============================================================================

begin;

-- ===========================================================================
-- PART A -- search_path regression mula sa 0011
--
-- Ang wrapper na ginawa ng 0011 ay may `set search_path = public`. Ang isang
-- SECURITY DEFINER function na WALANG sariling SET clause ay minamana ang
-- search_path na umiiral sa oras ng pagtawag -- kaya nang paliitin ito ng
-- wrapper tungo sa `public` lang, nawala sa __inner ang `extensions`, kung
-- saan naka-install ng Supabase ang pgcrypto. Doon nakatira ang gen_salt().
--
-- Gumagana ang admin_create_auth_user bago ang 0011; ang wrapper ko ang
-- sumira nito. Ang pag-aalis ng SET clause ay magsasaayos nito pero magbubukas
-- ng search_path injection sa isang definer function -- kaya PINAPALAWAK natin
-- ito, hindi inaalis.
--
-- Nilalapatan ang PAREHONG wrapper at __inner: kapag may sariling SET ang
-- __inner, hindi ito naaabot ng pagbabago sa wrapper.
-- ===========================================================================
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
     where n2.nspname = 'public'
       and p.prokind = 'f'
       and p.proname like 'admin\_%'
       and p.prosecdef
  loop
    execute format('alter function %s set search_path = public, extensions', r.sig);
    n := n + 1;
  end loop;
  raise notice 'PIA: % admin function ang naitakda sa search_path = public, extensions', n;
end;
$$;


-- ===========================================================================
-- PART B -- ATOMIC DEVICE SLOTS
--
-- Ang enforceDeviceLimit() sa assets/js/function.js ay read-then-write:
--     basahin ang active_devices -> tingnan ang haba -> i-push -> isulat
-- Walang locking sa pagitan. Sa isang computer lab kung saan sabay-sabay
-- naglo-log in ang 76 estudyante, dalawang magkasabay na login ng IISANG
-- account ay parehong nakakabasa ng lumang array, parehong nagpu-push, at ang
-- huling sumulat ang mananaig -- kaya may device na tahimik na nawawala sa
-- listahan, o nakakalusot ang dalawang device sa limit na isa.
--
-- Ang parehong pattern ay nasa tatlong revoke path ng admin: kung mag-login
-- ang estudyante habang binabawi ng admin ang device nila, may mawawala sa
-- dalawang operasyon.
--
-- Ang SELECT ... FOR UPDATE ay nagse-seryalisa ng magkasabay na tawag sa
-- IISANG row: naghihintay ang pangalawa hanggang matapos ang una, kaya
-- nakikita nito ang na-update nang listahan.
-- ===========================================================================

create or replace function public.claim_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_max     int;
  v_devices text[];
begin
  if v_email is null then
    raise exception 'PIA: walang authenticated session.' using errcode = '42501';
  end if;

  if p_device_id is null or length(trim(p_device_id)) = 0 then
    raise exception 'PIA: kailangan ng device id.' using errcode = '22023';
  end if;

  -- FOR UPDATE: dito nagseseryalisa ang magkasabay na login.
  select coalesce(p.max_devices, 1), coalesce(p.active_devices, '{}')
    into v_max, v_devices
    from public.profiles p
   where p.email = v_email
     for update;

  if not found then
    raise exception 'PIA: walang profile para sa session na ito.' using errcode = '42501';
  end if;

  -- Kilala na ang device na ito -- walang gagawin (idempotent).
  if p_device_id = any(v_devices) then
    return jsonb_build_object('allowed', true, 'devices', v_devices, 'max', v_max);
  end if;

  if coalesce(array_length(v_devices, 1), 0) >= v_max then
    return jsonb_build_object(
      'allowed', false,
      'reason', v_max || ' device limit lang. Mag-sign out muna sa kabilang device.',
      'devices', v_devices, 'max', v_max);
  end if;

  update public.profiles
     set active_devices = array_append(v_devices, p_device_id)
   where email = v_email;

  return jsonb_build_object('allowed', true,
                            'devices', array_append(v_devices, p_device_id),
                            'max', v_max);
end;
$$;

revoke all on function public.claim_device(text) from public, anon;
grant execute on function public.claim_device(text) to authenticated;


-- Atomic na revoke para sa admin. Ang p_device_id na NULL ay nag-aalis ng
-- LAHAT ng device ng account na iyon.
create or replace function public.admin_revoke_device(p_email text, p_device_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_devices text[];
  v_new     text[];
begin
  if public.pia_caller_role() is distinct from 'admin' then
    raise exception 'PIA: admin lang ang pwedeng mag-revoke ng device.' using errcode = '42501';
  end if;

  select coalesce(p.active_devices, '{}') into v_devices
    from public.profiles p where p.email = p_email
     for update;

  if not found then
    raise exception 'PIA: walang profile na %', p_email using errcode = '22023';
  end if;

  if p_device_id is null then
    v_new := '{}';
  else
    select coalesce(array_agg(d), '{}') into v_new
      from unnest(v_devices) d where d is distinct from p_device_id;
  end if;

  update public.profiles set active_devices = v_new where email = p_email;

  return jsonb_build_object('devices', v_new,
                            'removed', coalesce(array_length(v_devices,1),0) - coalesce(array_length(v_new,1),0));
end;
$$;

revoke all on function public.admin_revoke_device(text, text) from public, anon;
grant execute on function public.admin_revoke_device(text, text) to authenticated;

commit;

notify pgrst, 'reload schema';


-- Ulat: dapat may `public, extensions` na lahat ng admin function.
select p.proname as fn,
       coalesce(array_to_string(p.proconfig, ', '), '*** WALANG search_path ***') as config
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and (p.proname like 'admin\_%' or p.proname in ('claim_device'))
 order by p.proname;
