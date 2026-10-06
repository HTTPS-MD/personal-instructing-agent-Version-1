-- READ-ONLY. Safe on production: only SELECTs, and it prints COUNTS and dates only (no names, emails or ids).
-- Question it answers: is there enough real game data (step_events) to train the learning-profile
-- model (K-Means, k = 3, seven features from 0044) instead of using the hand-set centres?
-- Run in the Supabase SQL editor of the DEPLOYED project. "ok" is only a presence check; the numbers are the answer.
-- A training row = one answered submission (outcome wrong / format_error / needs_final / step_done / question_done),
-- the same events 0044 uses. 0044 looks at the last 8 per session, so sessions with >= 8 such events give
-- full-window feature vectors.
with ans as (
  select session_id, student_email, happened_at
    from public.step_events
   where outcome in ('wrong', 'format_error', 'needs_final', 'step_done', 'question_done')
), per_session as (
  select session_id, student_email, count(*) as n, min(happened_at) as first_at, max(happened_at) as last_at
    from ans group by session_id, student_email
)
select 'which project: number of auth accounts' as check_name, true as ok, (select count(*)::text from auth.users) as detail
union all
select 'tables from 0039 exist (step_events, step_hints, problem_serves)',
       to_regclass('public.step_events') is not null and to_regclass('public.step_hints') is not null
         and to_regclass('public.problem_serves') is not null, null
union all
select 'function 0044 exists (get_learning_features)', to_regprocedure('public.get_learning_features(uuid)') is not null, null
union all
select 'info: answered submissions in total', true, (select count(*)::text from ans)
union all
select 'info: sessions with at least one answer', true, (select count(*)::text from per_session)
union all
select 'info: distinct students with answers', true, (select count(distinct student_email)::text from per_session)
union all
select 'info: sessions with >= 8 answers (full 0044 window)', true, (select count(*)::text from per_session where n >= 8)
union all
select 'info: students with >= 8 answers in some session', true,
       (select count(distinct student_email)::text from per_session where n >= 8)
union all
select 'info: answers per session (min / median / max)', true,
       (select coalesce(min(n)::text, '-') || ' / ' || coalesce((percentile_cont(0.5) within group (order by n))::numeric(10,1)::text, '-')
               || ' / ' || coalesce(max(n)::text, '-') from per_session)
union all
select 'info: first and last answer', true,
       (select coalesce(min(first_at)::text, '-') || '  ->  ' || coalesce(max(last_at)::text, '-') from per_session)
union all
select 'info: answers by outcome', true,
       (select string_agg(outcome || '=' || n, ', ' order by outcome)
          from (select outcome, count(*) n from public.step_events group by outcome) o)
union all
select 'info: sessions with a hint taken', true,
       (select count(distinct session_id)::text from public.step_hints)
union all
select 'rule of thumb: >= 150 sessions with >= 8 answers is a defensible K-Means sample for k = 3 (fewer: report as pilot)',
       (select count(*) >= 150 from per_session where n >= 8), null
order by 1;
