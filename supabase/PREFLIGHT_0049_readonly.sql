-- READ-ONLY. Safe on production: only SELECTs; no student data is read (one row counts accounts so you
-- can tell WHICH project you ran it on: production has many, staging has 2).
-- Run BEFORE applying 0049. Every ok must be true ("0049 not applied yet" is true before 0049).
select 'which project: number of auth accounts' as check_name, true as ok, (select count(*)::text from auth.users) as detail
union all
select 'function ' || f, exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f), null
  from (values ('finish_step_question'), ('pia_game_email'), ('pia_topic_rules')) v(f)
union all
select 'table ' || t, to_regclass('public.' || t) is not null, null
  from (values ('app_config'), ('served_questions'), ('step_states'), ('step_hints'), ('tutoring_attempts'), ('question_bank')) v(t)
union all
select 'column question_bank.points', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'question_bank' and column_name = 'points'), null
union all
select 'column step_states.score', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'step_states' and column_name = 'score'), null
union all
select '0049 not applied yet', not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'app_config' and column_name = 'score_wrong_pct'), null
union all
-- information only: how scores look today (counts, no student data)
select 'info: completed questions scored 100 / 50 / other', true,
       (select count(*) filter (where score = 100) || ' / ' || count(*) filter (where score = 50) || ' / ' || count(*) filter (where score is not null and score not in (50, 100))
          from public.step_states)
order by 1;
