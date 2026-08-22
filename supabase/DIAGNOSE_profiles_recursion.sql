-- ============================================================================
-- Hanapin ang recursive na policy sa public.profiles.
-- Maikli ang mga policy expression kaya malamang hindi ito ma-truncate.
-- Kung ma-truncate man: Export -> Download CSV.
-- ============================================================================

-- (1) ANG MAHALAGA: lahat ng policy sa profiles.
--     Ang hinahanap natin ay isang policy na ang USING/WITH CHECK ay
--     bumabasa ULIT ng public.profiles -- iyon ang loop.
select policyname,
       cmd,
       roles::text                                as for_roles,
       coalesce(qual, '-')                        as using_expr,
       coalesce(with_check, '-')                  as check_expr,
       case when coalesce(qual,'') || coalesce(with_check,'') like '%profiles%'
            then '<<< BUMABASA NG PROFILES -- ITO ANG LOOP'
            else '' end                           as flag
  from pg_policies
 where schemaname = 'public' and tablename = 'profiles'
 order by cmd, policyname;


-- (2) Sino ang may-ari ng profiles, at naka-FORCE ba ang RLS?
--     Mahalaga ito: ang SECURITY DEFINER ay HINDI awtomatikong lumalampas sa
--     RLS -- ang may-ari lang ng table ang lumalampas, at hindi kahit siya
--     kung naka-FORCE ROW LEVEL SECURITY.
select c.relname,
       pg_get_userbyid(c.relowner) as table_owner,
       c.relrowsecurity            as rls_enabled,
       c.relforcerowsecurity       as rls_forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'profiles';


-- (3) Anong mga helper function ang tinatawag ng mga policy sa profiles,
--     at SECURITY DEFINER ba sila? (hal. jwt_is_current, is_admin, ...)
select p.proname,
       p.prosecdef                     as is_security_definer,
       pg_get_userbyid(p.proowner)     as fn_owner,
       pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and exists (
     select 1 from pg_policies pol
      where pol.schemaname = 'public' and pol.tablename = 'profiles'
        and (coalesce(pol.qual,'') || coalesce(pol.with_check,'')) like '%' || p.proname || '%')
 order by p.proname;
