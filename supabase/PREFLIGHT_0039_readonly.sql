-- ============================================================================
-- PREFLIGHT for migration 0039 (step-based game). READ-ONLY: one SELECT, writes nothing.
-- Paste into the Supabase SQL Editor. Run PREFLIGHT_0039_questions_readonly.sql second (it needs 0029's pia_parse_hint). BLOCKER rows must be fixed first; WARN rows need
-- a decision; INFO rows are facts. Safe to run on production at any time.
-- ============================================================================
with
fn(name, sig) as (values
  ('pia_caller_role','public.pia_caller_role()'), ('jwt_is_current','public.jwt_is_current()'),
  ('pia_can_enter_stage','public.pia_can_enter_stage(boolean,text,text,text)'),
  ('pia_parse_hint','public.pia_parse_hint(text)'), ('pia_student_topic','public.pia_student_topic(text)'),
  ('pia_result_payload','public.pia_result_payload(uuid,text,text)'), ('start_game_session','public.start_game_session()'),
  ('teacher_class_status','public.teacher_class_status()'), ('serve_next_question (old flow)','public.serve_next_question(uuid)'),
  ('resume_or_start_game_session','public.resume_or_start_game_session()')),
tb(name) as (values ('profiles'),('question_bank'),('app_config'),('served_questions'),('student_topic_progress'),
  ('topic_changes'),('tutoring_attempts'),('problem_serves'),('hint_consumptions'),('question_attempts')),
col(tbl, c) as (values ('tutoring_attempts','session_id'),('tutoring_attempts','student_email'),('tutoring_attempts','problem_id'),
  ('tutoring_attempts','problem_number'),('tutoring_attempts','level_before'),('tutoring_attempts','level_after'),
  ('tutoring_attempts','attempts_used'),('tutoring_attempts','hints_used'),('tutoring_attempts','time_taken_ms'),
  ('tutoring_attempts','is_correct'),('tutoring_attempts','classification'),('profiles','selected_character'),
  ('profiles','group_type'),('profiles','is_ocean_done'),('app_config','easy_mastery'),('app_config','hard_max_errors')),
need as (
  select 'function ' || name as chk, case when to_regprocedure(sig) is null then 'BLOCKER' else 'OK' end as status,
         case when to_regprocedure(sig) is null then 'missing: ' || sig else 'present' end as detail from fn
  union all
  select 'table ' || name, case when to_regclass('public.'||name) is null then 'BLOCKER' else 'OK' end,
         case when to_regclass('public.'||name) is null then 'missing' else 'present' end from tb
  union all
  select 'column ' || tbl || '.' || c,
         case when exists (select 1 from information_schema.columns where table_schema='public' and table_name=tbl and column_name=c) then 'OK' else 'BLOCKER' end,
         'needed by 0039' from col
  union all
  select 'PostgreSQL >= 13 (trim_scale)', case when current_setting('server_version_num')::int >= 130000 then 'OK' else 'BLOCKER' end, current_setting('server_version')
  union all
  select '0038 applied: Control guard trigger', case when exists (select 1 from pg_trigger where tgname='trg_pia_control_stage_guard') then 'OK' else 'BLOCKER' end, 'trg_pia_control_stage_guard'
  union all
  select '0038 applied: stage rule refuses Control',
         case when to_regprocedure('public.pia_can_enter_stage(boolean,text,text,text)') is not null
                   and public.pia_can_enter_stage(true,'control',null,'Tutoring Dashboard') = false then 'OK' else 'BLOCKER' end,
         'pia_can_enter_stage(true,control,...) must be false'
  union all
  select '0038 applied: Assigned may enter the dashboard',
         case when to_regprocedure('public.pia_can_enter_stage(boolean,text,text,text)') is not null
                   and public.pia_can_enter_stage(true,'assigned','pia-open','Tutoring Dashboard') then 'OK' else 'BLOCKER' end, ''
  union all
  select '0038 leftover snapshot table', case when to_regclass('public.pia_0038_snapshot') is null then 'OK' else 'WARN' end,
         'drop table public.pia_0038_snapshot; is safe (fingerprint only)'
  union all
  select 'app_config has the single config row (id = 1)',
         case when to_regclass('public.app_config') is not null
                   and (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.app_config where id = 1', false, true, '')))[1]::text::int = 1
              then 'OK' else 'BLOCKER' end, 'rules and time limit read from it'
  union all
  select '0039 not applied yet', case when to_regclass('public.step_states') is null and to_regclass('public.game_windows') is null then 'OK' else 'WARN' end,
         case when to_regclass('public.step_states') is null then 'clean: nothing of 0039 exists' else 'step_states/game_windows already exist: partially applied? (0039 is re-runnable)' end
  union all
  select 'app_config.time_limit', case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='app_config' and column_name='time_limit') then 'INFO' else 'INFO' end,
         case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='app_config' and column_name='time_limit') then 'already exists' else 'absent: 0039 adds it (default 10 minutes)' end
),
data as (
  select 'students by group', 'INFO', coalesce(string_agg(g || '=' || n, ', ' order by g), 'none')
    from (select coalesce(lower(trim(group_type)),'(none)') g, count(*) n from public.profiles where lower(coalesce(role,'student'))='student' group by 1) s
  union all
  select 'Assigned/legacy-neutral students with NO tutor (cannot play until Admin assigns one)', case when c = 0 then 'OK' else 'WARN' end, c::text
    from (select count(*) c from public.profiles where lower(coalesce(role,'student'))='student' and lower(trim(group_type)) in ('assigned','neutral') and selected_character is null) a
  union all
  select 'Free-choice students who have chosen a tutor (can play now)', 'INFO', count(*)::text
    from public.profiles where lower(trim(group_type)) in ('non-assigned','non_assigned') and selected_character is not null
  union all
  select 'tutor values outside the six known keys', case when c = 0 then 'OK' else 'WARN' end, c::text || ' (the game refuses an unknown tutor)'
    from (select count(*) c from public.profiles where selected_character is not null and selected_character not in ('pia-open','pia-conscientious','pia-extravert','pia-agreeable','pia-calm','pia-neutral')) a
  union all
  select 'LIVE USE: students flagged in a game session now (is_in_game)', case when c = 0 then 'OK' else 'WARN' end,
         c::text || ' - 0039 replaces resume_or_start_game_session; the OLD page ends a session at 10 questions and this changes how it resumes. Apply when nobody is mid-session, or deploy the new page at the same time.'
    from (select count(*) c from public.profiles where coalesce(is_in_game,false)) a
  union all
  select 'LIVE USE: open questions (served, not recorded)', case when c = 0 then 'OK' else 'WARN' end, c::text
    from (select case when to_regclass('public.served_questions') is null or to_regclass('public.tutoring_attempts') is null then -1
                      else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.served_questions sq where not exists (select 1 from public.tutoring_attempts t where t.session_id=sq.session_id and t.student_email=sq.student_email and t.problem_id=sq.problem_id)', false, true, '')))[1]::text::int end as c) a
  union all
  select 'triggers already on profiles (0039 adds profiles_guard_tutor_choice)', 'INFO',
         coalesce(string_agg(tgname, ', ' order by tgname), 'none') from pg_trigger where tgrelid = 'public.profiles'::regclass and not tgisinternal
  union all
  select 'tutoring_attempts CHECK constraints (0039 writes attempts_used/hints_used <= 10, classification smooth|struggling)', 'INFO',
         coalesce(string_agg(pg_get_constraintdef(oid), ' | '), 'none') from pg_constraint where conrelid = to_regclass('public.tutoring_attempts') and contype = 'c'
  union all
  select 'old two-try RPCs still executable by signed-in users (0039 does NOT revoke them)', 'INFO',
         case when to_regprocedure('public.serve_next_question(uuid)') is not null and has_function_privilege('authenticated','public.serve_next_question(uuid)','EXECUTE') then 'yes' else 'no' end
)
select * from (select * from need union all select * from data) r
order by case status when 'BLOCKER' then 0 when 'WARN' then 1 when 'INFO' then 2 else 3 end, chk;
