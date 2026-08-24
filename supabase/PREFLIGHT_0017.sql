-- ============================================================================
-- PREFLIGHT for 0017 -- READ-ONLY. Changes nothing.
-- ============================================================================
-- Run this ALONE (select all, Run). It returns ONE result set on purpose:
-- the Supabase SQL editor only displays the LAST statement's output, which is
-- why the previous four-query batch showed only the view options.
--
-- Send the whole grid back. Every row is a fact 0017 needs.
-- ============================================================================

select 'A_rls' as section, c.relname as name,
       case when c.relrowsecurity then 'RLS ON' else '*** RLS OFF ***' end as detail,
       case when c.relforcerowsecurity then 'forced' else '' end as extra
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'

union all
select 'B_policy', p.tablename || '.' || p.policyname,
       p.cmd || ' to ' || array_to_string(p.roles, ',') ||
       case when p.permissive = 'RESTRICTIVE' then ' [RESTRICTIVE]' else '' end,
       coalesce('USING ' || p.qual, '') || coalesce('  CHECK ' || p.with_check, '')
  from pg_policies p where p.schemaname = 'public'

union all
select 'C_function', p.proname,
       case when not p.prosecdef then 'invoker'
            when pg_get_functiondef(p.oid) ~* 'pia_caller_role|is_admin' then 'definer + guard'
            else '*** DEFINER, NO GUARD ***' end,
       case when has_function_privilege('authenticated', p.oid, 'EXECUTE')
            then 'authenticated CAN call' else 'locked' end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'

union all
select 'D_viewdef', c.relname, array_to_string(c.reloptions, ','),
       regexp_replace(pg_get_viewdef(c.oid, true), '\s+', ' ', 'g')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'v'

union all
select 'E_column', c.table_name, c.column_name, c.data_type
  from information_schema.columns c
 where c.table_schema = 'public'
   and c.table_name in ('tutoring_attempts','math_attempt_log',
                        'session_start_log','professors','sections')

order by 1, 2, 3;
