-- READ-ONLY. Safe on production: only SELECTs; no student data is read (one row counts accounts so you
-- can tell WHICH project you ran it on: production has many, staging has 2).
-- Run BEFORE applying 0047. Every ok must be true ("0047 not applied yet" is true before 0047).
select 'which project: number of auth accounts' as check_name, true as ok, (select count(*)::text from auth.users) as detail
union all
select 'function ' || f, exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f), null
  from (values ('consume_step_hint'), ('pia_step_hints'), ('pia_game_email'), ('pia_game_window'), ('pia_clock_json')) v(f)
union all
select 'column served_questions.steps / final_answer', (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'served_questions' and column_name in ('steps', 'final_answer')), null
union all
select '0045 applied (closing time)', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'app_config' and column_name = 'game_closes_at'), null
union all
select '0047 not applied yet', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'pia_mask_answers'), null
order by 1;
