-- ============================================================================
-- Ang mismong katawan ng anim na helper na ginagamit ng profiles policies.
-- Hinati sa 1200-char na chunk para hindi ma-truncate ng editor.
-- Mas mabilis: patakbuhin at pindutin ang Export -> Download CSV.
-- ============================================================================
with defs as (
  select p.proname as fn,
         pg_get_functiondef(p.oid) as body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('is_admin', 'current_user_role', 'jwt_is_current',
                       'current_email', 'is_teacher', 'current_user_section')
)
select d.fn,
       g.i as part,
       ceil(length(d.body) / 1200.0)::int as of_parts,
       substring(d.body from ((g.i - 1) * 1200) + 1 for 1200) as chunk
  from defs d
  cross join lateral generate_series(1, ceil(length(d.body) / 1200.0)::int) as g(i)
 order by d.fn, g.i;
