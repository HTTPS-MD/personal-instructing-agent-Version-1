-- ============================================================================
-- Compact na schema ng tutoring tables -- isang row bawat table, kaya hindi
-- ito naa-truncate. Ito ang kailangan para maderive server-side ang
-- classification / attempts / hints / timing (HIGH 1).
-- ============================================================================
select c.relname as table_name,
       string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod),
                  ', ' order by a.attnum) as columns
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
 where n.nspname = 'public'
   and c.relkind in ('r', 'v')
   and a.attnum > 0
   and not a.attisdropped
   and (c.relname ilike '%attempt%'
        or c.relname ilike '%session%'
        or c.relname ilike '%math%'
        or c.relname ilike '%tutoring%')
 group by c.relname
 order by c.relname;
