-- ============================================================================
-- Ipinapakita ang mahahabang function body sa mga hati-hating 1500-char na row
-- para hindi ito putulin ng SQL Editor. Kopyahin ang buong `chunk` column mula
-- itaas pababa -- magkakadikit sila sa tamang pagkakasunod.
--
-- Mas mabilis pa: patakbuhin ito at pindutin ang Export -> Download CSV.
-- ============================================================================
with defs as (
  select t.tgname as obj, pg_get_functiondef(p.oid) as body
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.profiles'::regclass
     and not t.tgisinternal
  union all
  select p.proname, pg_get_functiondef(p.oid)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('check_math_answer', 'record_problem_result', 'start_game_session')
)
select d.obj,
       g.i                                     as part,
       ceil(length(d.body) / 1500.0)::int      as of_parts,
       substring(d.body from ((g.i - 1) * 1500) + 1 for 1500) as chunk
  from defs d
  cross join lateral generate_series(1, ceil(length(d.body) / 1500.0)::int) as g(i)
 order by d.obj, g.i;
