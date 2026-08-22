-- ============================================================================
-- Extract every STRING LITERAL in a public function that looks Tagalog.
-- These are the only ones that can reach a user. Whatever this returns is the
-- exact, complete list left to translate -- including the messages inside the
-- admin_* functions I have never seen.
--
-- Run this and paste the output; I will map each one precisely.
-- ============================================================================
select p.proname as function_name,
       m[1]      as tagalog_string
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral regexp_matches(
        pg_get_functiondef(p.oid),
        '''([^'']{4,200}?(?:walang|Walang|hindi|Hindi|bawal|Bawal|kailangan|Kailangan|pwede|Pwede|dapat|Dapat|ang |ng |mga |naka|Naka|Ang |Ito|ito )[^'']{0,200}?)''',
        'g') as m
 where n.nspname = 'public'
   and p.prokind = 'f'
   -- exclude SQL keywords that the pattern can brush against
   and m[1] !~* '^(select|insert|update|delete|set |alter|revoke|grant|create)'
 order by p.proname, m[1];
