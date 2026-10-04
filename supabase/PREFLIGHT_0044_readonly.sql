-- READ-ONLY. Safe to run on production: only SELECTs on catalog views; no data of any
-- student is read and nothing is written. Run it BEFORE applying 0044.
-- Every row should say ok = true, except "0044 not applied yet" which is true before
-- 0044 and false after.
with need_tables(t) as (values ('profiles'), ('tutoring_attempts'), ('step_events'), ('step_states'),
                               ('step_hints'), ('game_windows'), ('problem_serves')),
need_cols(t, c) as (values
  ('step_events','id'), ('step_events','session_id'), ('step_events','student_email'), ('step_events','problem_id'),
  ('step_events','step_index'), ('step_events','outcome'), ('step_events','happened_at'),
  ('step_hints','session_id'), ('step_hints','student_email'), ('step_hints','problem_id'),
  ('step_hints','step_index'), ('step_hints','taken_at'),
  ('problem_serves','session_id'), ('problem_serves','student_email'), ('problem_serves','problem_id'), ('problem_serves','served_at'),
  ('profiles','email'), ('profiles','role'), ('profiles','group_type'), ('profiles','selected_character'),
  ('profiles','is_ocean_done')),
need_funcs(f) as (values ('pia_game_email'), ('pia_caller_role'), ('jwt_is_current'), ('serve_next_step_question'), ('check_step_answer'))
select 'table ' || t as check_name, (to_regclass('public.' || t) is not null) as ok from need_tables
union all
select 'column ' || t || '.' || c, exists (select 1 from information_schema.columns
                                            where table_schema = 'public' and table_name = t and column_name = c) from need_cols
union all
select 'function ' || f, exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                  where n.nspname = 'public' and p.proname = f) from need_funcs
union all
select '0044 not applied yet', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                            where n.nspname = 'public' and p.proname = 'get_learning_features')
order by 1;
