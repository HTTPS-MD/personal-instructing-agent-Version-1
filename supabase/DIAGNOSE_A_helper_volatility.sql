-- ============================================================================
-- SCRIPT A -- Patakbuhin ito MAG-ISA. Isang SELECT lang kaya siguradong
-- makikita mo ang resulta sa editor.
--
-- Ang hinahanap: volatility = 'VOLATILE' sa isang function na ginagamit sa RLS
-- policy. Ang VOLATILE ay tinatawag KADA ROW; ang STABLE ay isang beses lang
-- sa buong query. Sa 76 na row, ang VOLATILE na is_admin() na bumabasa ng
-- profiles ay nagiging quadratic -- gumagana sa isang row (login), pero
-- umaabot sa statement_timeout sa buong roster.
-- ============================================================================
select p.proname                                   as helper,
       case p.provolatile when 'i' then 'IMMUTABLE'
                          when 's' then 'STABLE'
                          when 'v' then 'VOLATILE  <<< tinatawag KADA ROW'
       end                                         as volatility,
       p.prosecdef                                 as security_definer,
       pg_get_userbyid(p.proowner)                 as owner,
       coalesce(array_to_string(p.proconfig, ', '), '(walang search_path)') as config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('is_admin', 'current_user_role', 'jwt_is_current',
                     'current_email', 'is_teacher', 'current_user_section',
                     'pia_caller_role')
 order by p.provolatile desc, p.proname;
