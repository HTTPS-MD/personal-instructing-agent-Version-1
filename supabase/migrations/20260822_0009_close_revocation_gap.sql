-- ============================================================================
-- PIA 0009 -- ISARA ANG REVOCATION GAP SA PROFILES POLICIES
-- ============================================================================
-- May DALAWANG henerasyon ng policy sa profiles. Ang mas luma ay walang
-- jwt_is_current(), at dahil ang mga PERMISSIVE policy ay pinagsasama sa
-- pamamagitan ng OR, ang luma ang NANANAIG -- kaya walang epekto ang
-- revocation check ng mas bago:
--
--   profiles_select_own   : email = auth.jwt()->>'email' AND jwt_is_current()
--   profiles_select_self   : email = current_email()            <-- WALANG check
--   profiles_admin_all     : is_admin()                          <-- WALANG check
--   profiles_update_self   : email = current_email()             <-- WALANG check
--
-- Ibig sabihin: hindi gumagana ang "Revoke Sessions" ng admin. Umaasa ang
-- requireStudentSession() sa assets/js/function.js na haharangin ng
-- jwt_is_current() ang SELECT para matukoy ang na-revoke na session -- at
-- nilalampasan ito ng mga lumang policy. Sa isang lab na 76 estudyante ang
-- naghahati sa mga PC, ang revocation ang paraan mo ng pagkontrol sa device
-- slots, kaya mahalaga ito.
--
-- ANG GINAGAWA:
--   1. TANGGALIN ang profiles_select_self -- eksaktong dobleng-kopya ng
--      profiles_select_own, maliban sa walang revocation check.
--   2. PALITAN ang profiles_admin_all -- HINDI ito basta tinatanggal: FOR ALL
--      ito, kaya ito rin ang write path ng admin (scores, retake, register).
--      Dinadagdagan lang ng jwt_is_current().
--   3. PALITAN ang profiles_update_self -- dinagdagan ng jwt_is_current() at
--      ng WITH CHECK, para hindi mailipat ang row sa ibang email.
--
-- PARA IBALIK (rollback):
--   create policy profiles_select_self on public.profiles
--     for select using (email = current_email());
--   drop policy profiles_admin_all on public.profiles;
--   create policy profiles_admin_all on public.profiles for all using (is_admin());
--   drop policy profiles_update_self on public.profiles;
--   create policy profiles_update_self on public.profiles
--     for update using (email = current_email());
-- ============================================================================

begin;

drop policy if exists profiles_select_self on public.profiles;

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
  for all to authenticated
  using       (public.is_admin() and public.jwt_is_current())
  with check  (public.is_admin() and public.jwt_is_current());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using       (email = (auth.jwt() ->> 'email') and public.jwt_is_current())
  with check  (email = (auth.jwt() ->> 'email') and public.jwt_is_current());


-- ============================================================================
-- SELF-VERIFICATION -- tumatakbo BAGO ang commit.
-- Kung mali ang naging resulta, nagtatapon ito ng exception at IBINABALIK ang
-- BUONG transaction -- kaya imposibleng ma-lock out ka ng migration na ito.
-- ============================================================================
do $$
declare
  v_admin   text;
  v_student text;
  v_total   int;
  n         int;
begin
  select count(*) into v_total from public.profiles;
  select email into v_admin   from public.profiles where lower(trim(role)) = 'admin'   order by email limit 1;
  select email into v_student from public.profiles where lower(trim(role)) = 'student' order by email limit 1;

  -- (1) Dapat pa ring makita ng admin ang LAHAT ng row.
  perform set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role', 'authenticated',
                      'iat', extract(epoch from now())::bigint)::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.profiles;
  execute 'reset role';

  if n <> v_total then
    raise exception
      'PIA ABORT: ang admin (%) ay % row lang ang nakikita sa % -- ibinabalik ang lahat.',
      v_admin, n, v_total using errcode = 'P0001';
  end if;

  -- (2) Dapat SARILI lang ang nakikita ng estudyante.
  if v_student is not null then
    perform set_config('request.jwt.claims',
      json_build_object('email', v_student, 'role', 'authenticated',
                        'iat', extract(epoch from now())::bigint)::text, true);
    execute 'set local role authenticated';
    select count(*) into n from public.profiles;
    execute 'reset role';

    if n <> 1 then
      raise exception
        'PIA ABORT: ang estudyante (%) ay % row ang nakikita, dapat 1 -- ibinabalik ang lahat.',
        v_student, n using errcode = 'P0001';
    end if;
  end if;

  raise notice 'PIA OK: admin nakakakita ng % row; estudyante nakakakita ng sarili lang.', v_total;
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Huling ulat -- ito ang ipapakita ng editor.
select policyname,
       cmd,
       case when coalesce(qual, '') like '%jwt_is_current%'
                 or cmd = 'INSERT' then 'may revocation check'
            else '*** WALANG CHECK ***' end as revocation
  from pg_policies
 where schemaname = 'public' and tablename = 'profiles'
 order by cmd, policyname;
