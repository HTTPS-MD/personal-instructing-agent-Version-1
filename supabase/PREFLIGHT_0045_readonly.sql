-- READ-ONLY. Safe on production: only SELECTs on catalog views; no student data is read.
-- Run it BEFORE applying 0045. Every row must be ok = true ("0045 not applied yet" is true before 0045).
select 'table ' || t as check_name, (to_regclass('public.' || t) is not null) as ok
  from (values ('game_windows'), ('app_config'), ('step_events'), ('step_states'), ('served_questions')) v(t)
union all
select 'function ' || f, exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f)
  from (values ('pia_game_email'), ('serve_next_step_question'), ('check_step_answer'), ('consume_step_hint'),
               ('restart_after_expiry'), ('pia_game_window'), ('pia_window_expired'), ('pia_clock_json')) v(f)
union all
select 'column game_windows.' || c, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'game_windows' and column_name = c)
  from (values ('session_id'), ('student_email'), ('window_no'), ('started_at'), ('limit_seconds'), ('deadline_at'), ('ended_at'), ('ended_reason')) v(c)
union all
select 'app_config row id = 1 exists', exists (select 1 from public.app_config where id = 1)
union all
select '0045 not applied yet', not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'app_config' and column_name = 'game_closes_at')
order by 1;
