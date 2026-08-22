-- Any other table holding session/telemetry data I may not know about --
-- start_game_session() writes somewhere, and I have never seen its body.
-- Anything listed here with rows should be wiped too.
select c.relname as table_name,
       string_agg(a.attname, ', ' order by a.attnum) as matching_columns,
       (xpath('/row/c/text()',
              query_to_xml(format('select count(*) as c from public.%I', c.relname),
                           false, true, '')))[1]::text::int as row_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
 where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
   and a.attname in ('session_id','student_email','started_at','ended_at','completed')
 group by c.relname
 order by c.relname;
