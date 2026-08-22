-- ============================================================================
-- PIA -- BUONG BACKEND ATTACK SURFACE, isang run lang. READ-ONLY.
-- Isang row bawat item kaya hindi ito maaaring ma-truncate.
--
-- Basahin ang `verdict` column. Ang lahat ng may '***' ay kailangang ayusin.
-- ============================================================================

-- (A) BAWAT TABLE: naka-on ba ang RLS, at may policy ba talaga?
--     Ang RLS na naka-enable pero WALANG policy ay ganap na nakasara (mabuti).
--     Ang RLS na NAKA-OFF ay ganap na BUKAS sa kahit sinong may anon key.
select 'A. table' as section,
       c.relname  as object,
       case
         when not c.relrowsecurity then '*** RLS OFF -- bukas sa lahat ***'
         when (select count(*) from pg_policies p
                where p.schemaname='public' and p.tablename=c.relname) = 0
              then 'RLS on, 0 policy (naka-lock)'
         else 'RLS on, ' || (select count(*) from pg_policies p
                where p.schemaname='public' and p.tablename=c.relname)::text || ' policy'
       end as verdict,
       coalesce((select string_agg(distinct pr.privilege_type, ',')
                   from information_schema.role_table_grants pr
                  where pr.table_schema='public' and pr.table_name=c.relname
                    and pr.grantee='authenticated'), '(walang grant)') as authenticated_can
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r'

union all

-- (B) BAWAT FUNCTION na kayang tawagin ng `authenticated`.
--     Ang delikado: SECURITY DEFINER na WALANG role check sa loob -- ibig
--     sabihin, kahit sinong naka-login ay makakatawag nito bilang superuser.
select 'B. function',
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       case
         when not has_function_privilege('authenticated', p.oid, 'EXECUTE')
              then 'hindi matatawag ng authenticated (ligtas)'
         when not p.prosecdef then 'invoker (RLS ang bahala)'
         when p.proname like 'admin\_%' and
              pg_get_functiondef(p.oid) !~* '(is_admin|current_user_role|pia_caller_role|''admin'')'
              then '*** DEFINER + admin_* + WALANG role check ***'
         when pg_get_functiondef(p.oid) ~* '(is_admin|current_user_role|pia_caller_role)'
              then 'definer, may role check'
         else 'definer, walang nakitang role check -- suriin'
       end,
       case when has_function_privilege('authenticated', p.oid, 'EXECUTE')
            then 'EXECUTE' else '-' end
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prokind='f'
   and p.proname not like 'pg\_%'

union all

-- (C) May nakakabasa ba ang ANON (hindi naka-login) na hindi dapat?
select 'C. anon grant',
       table_name,
       '*** ' || string_agg(distinct privilege_type, ',') || ' para sa anon ***',
       '-'
  from information_schema.role_table_grants
 where table_schema='public' and grantee='anon'
 group by table_name

order by section, object;
