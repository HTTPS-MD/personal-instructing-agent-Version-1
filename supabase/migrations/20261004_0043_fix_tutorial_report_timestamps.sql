-- PIA 0043: corrective replacement of pia_admin_tutorial_report (from 0042).
-- 0042 filtered completed questions with tutoring_attempts.created_at, but that
-- table has no timestamp column (session_id, student_email, problem_id,
-- problem_number, level_before, level_after, attempts_used, hints_used,
-- time_taken_ms, is_correct, classification). A question's completion time is
-- now the server's 'question_done' record in step_events.happened_at, written
-- in the same transaction path as the final correct step. A question counts in
-- the game window whose [started_at, deadline_at) contains that moment, the
-- same boundaries already used for errors (step_events) and hints (step_hints).
-- Admin-only access, the JSON shape and all game records are unchanged: this
-- file only replaces one function (no table, row or policy is touched).
begin;

do $$
declare
  v_col text;
begin
  foreach v_col in array array['session_id', 'student_email', 'problem_id', 'level_before',
                               'time_taken_ms', 'is_correct'] loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'tutoring_attempts'
                      and column_name = v_col) then
      raise exception 'PIA 0043 requires public.tutoring_attempts.%', v_col;
    end if;
  end loop;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'step_events'
                    and column_name = 'happened_at') then
    raise exception 'PIA 0043 requires public.step_events.happened_at (apply 0039 first).';
  end if;
  if to_regprocedure('public.pia_admin_tutorial_report(text)') is null then
    raise exception 'PIA 0043 replaces the function from 0042 (apply 0042 first).';
  end if;
end;
$$;

create or replace function public.pia_admin_tutorial_report(p_student_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_student_email, '')));
  v_report jsonb;
begin
  if coalesce(public.pia_caller_role(), '') <> 'admin'
     or public.jwt_is_current() is not true then
    raise exception 'PIA: admin access required.' using errcode = '42501';
  end if;
  if v_email = '' then
    raise exception 'PIA: student email required.' using errcode = '22023';
  end if;

  with windows as (
    select w.session_id, w.student_email, w.window_no, w.started_at,
           w.deadline_at, w.ended_at,
           greatest(0, floor(extract(epoch from
             least(coalesce(w.ended_at, now()), w.deadline_at) - w.started_at)))::int
             as duration_seconds
      from public.game_windows w
     where lower(w.student_email) = v_email
  ), report_rows as (
    select w.*,
           coalesce(a.completed, 0) as completed,
           coalesce(a.clean, 0) as clean,
           a.best_topic,
           coalesce(a.time_sum_ms, 0) as time_sum_ms,
           coalesce(a.timed_count, 0) as timed_count,
           coalesce(a.score_sum, 0) as score_sum,
           coalesce(e.errors, 0) as errors,
           coalesce(h.hints, 0) as hints
      from windows w
      left join lateral (
        select count(*)::int as completed,
               count(*) filter (where t.is_correct)::int as clean,
               max(t.level_before) as best_topic,
               sum(t.time_taken_ms) as time_sum_ms,
               count(t.time_taken_ms)::int as timed_count,
               sum(coalesce(st.score, 0))::int as score_sum
          from public.tutoring_attempts t
          join lateral (
            select max(ev.happened_at) as done_at
              from public.step_events ev
             where ev.session_id = t.session_id and ev.student_email = t.student_email
               and ev.problem_id = t.problem_id and ev.outcome = 'question_done'
          ) c on c.done_at is not null
          left join public.step_states st
            on st.session_id = t.session_id and st.student_email = t.student_email
           and st.problem_id = t.problem_id
         where t.session_id = w.session_id and t.student_email = w.student_email
           and t.problem_id like 'qb-%'
           and c.done_at >= w.started_at and c.done_at < w.deadline_at
      ) a on true
      left join lateral (
        select count(*)::int as errors
          from public.step_events ev
         where ev.session_id = w.session_id and ev.student_email = w.student_email
           and ev.outcome in ('wrong', 'format_error')
           and ev.happened_at >= w.started_at and ev.happened_at < w.deadline_at
      ) e on true
      left join lateral (
        select count(*)::int as hints
          from public.step_hints sh
         where sh.session_id = w.session_id and sh.student_email = w.student_email
           and sh.taken_at >= w.started_at and sh.taken_at < w.deadline_at
      ) h on true
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'sessions', count(*)::int,
      'completed_questions', coalesce(sum(completed), 0)::int,
      'clean_questions', coalesce(sum(clean), 0)::int,
      'best_topic', max(best_topic),
      'avg_speed_seconds', case when coalesce(sum(timed_count), 0) > 0
        then round(sum(time_sum_ms)::numeric / sum(timed_count) / 1000, 1)
        else null end,
      'accuracy_percent', case when coalesce(sum(completed), 0) > 0
        then round(sum(clean)::numeric * 100 / sum(completed), 1)
        else null end,
      'score_sum', coalesce(sum(score_sum), 0)::int,
      'errors', coalesce(sum(errors), 0)::int,
      'hints', coalesce(sum(hints), 0)::int
    ),
    'history_total', count(*)::int,
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'started_at', r.started_at,
        'window_no', r.window_no,
        'status', case when r.ended_at is not null or r.deadline_at <= now()
          then 'ended' else 'active' end,
        'duration_seconds', r.duration_seconds,
        'best_topic', r.best_topic,
        'completed_questions', r.completed,
        'clean_questions', r.clean,
        'score_sum', r.score_sum,
        'errors', r.errors,
        'hints', r.hints
      ) order by r.started_at desc, r.window_no desc)
        from (select * from report_rows order by started_at desc, window_no desc limit 100) r
    ), '[]'::jsonb)
  ) into v_report
    from report_rows;

  return v_report;
end;
$$;

revoke all on function public.pia_admin_tutorial_report(text) from public, anon;
grant execute on function public.pia_admin_tutorial_report(text) to authenticated;

commit;
