-- ============================================================================
-- Handa na ba ang stage toggles + targeted grants? READ-ONLY.
-- ============================================================================

-- (1) KRITIKAL: kaya bang basahin ng `authenticated` ang settings?
--     Binabasa ito ng loadSettings() (admin toggles) AT ng isStageOpen()
--     (bawat estudyante). Kung hinaharangan ito ng RLS, ang tatlong switch ay
--     laging "Closed" ang ipapakita, at ang BAWAT estudyante ay maiipit sa
--     waiting room -- kahit bukas ang stage sa database.
select '1. settings RLS' as check_item,
       c.relname as object,
       case when not c.relrowsecurity then '*** RLS OFF ***'
            when (select count(*) from pg_policies p
                   where p.schemaname='public' and p.tablename='settings') = 0
                 then '*** RLS ON, 0 POLICY -- walang makakabasa ***'
            else 'RLS on, ' || (select count(*) from pg_policies p
                   where p.schemaname='public' and p.tablename='settings')::text || ' policy'
       end as verdict
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='settings'

union all
select '1b. settings grant', 'authenticated',
       coalesce((select string_agg(distinct privilege_type, ',')
                   from information_schema.role_table_grants
                  where table_schema='public' and table_name='settings'
                    and grantee='authenticated'), '*** WALANG GRANT ***')

union all
-- (2) Nabalot ba ng guard ang admin_grant_stage at ang iba pang admin RPC?
--     Ito ang Part 4 na ulat ng 0011, muling pinatakbo.
select '2. admin RPC', p.proname,
       case when p.proname like '%\_\_inner' then
                 case when has_function_privilege('authenticated', p.oid, 'EXECUTE')
                      then '*** inner, tawagable pa ***' else 'inner, naka-lock (tama)' end
            when pg_get_functiondef(p.oid) ~* '(pia_caller_role|is_admin|current_user_role)'
                 then 'may guard (tama)'
            else '*** WALANG GUARD ***' end
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'admin\_%'

union all
-- (3) Ano ang kasalukuyang laman ng settings?
select '3. stage flag', s.key, s.value::text
  from public.settings s where s.key like 'stage\_%'

order by check_item, object;
