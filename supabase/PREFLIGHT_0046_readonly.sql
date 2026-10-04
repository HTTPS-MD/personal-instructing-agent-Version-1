-- READ-ONLY. Safe on production: only SELECTs; no student data is read (one row counts accounts so
-- you can tell WHICH project you ran it on: production has many, staging has 2).
-- Run BEFORE applying 0046. Every ok must be true ("0046 not applied yet" is true before 0046).
select 'which project: number of auth accounts' as check_name, true as ok, (select count(*)::text from auth.users) as detail
union all
select 'table ' || t, (to_regclass('public.' || t) is not null), null
  from (values ('served_questions'), ('step_states'), ('step_events'), ('step_hints')) v(t)
union all
select 'function ' || f, exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f), null
  from (values ('pia_game_email'), ('pia_step_label')) v(f)
union all
select 'column step_states.done_steps / completed', (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'step_states' and column_name in ('done_steps', 'completed')), null
union all
select 'column step_events.submitted / outcome / step_index', (select count(*) = 3 from information_schema.columns where table_schema = 'public' and table_name = 'step_events' and column_name in ('submitted', 'outcome', 'step_index')), null
union all
select '0046 not applied yet', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_session_history'), null
order by 1;
