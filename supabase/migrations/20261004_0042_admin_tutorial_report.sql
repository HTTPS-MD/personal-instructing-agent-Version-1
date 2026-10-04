-- PIA 0042: Admin-only tutorial performance and time-window history.
-- 0039 keeps one resumable session_id across sign-ins. Each game_windows row
-- is one continuous timed play window, including a new row after Try again.
-- The report deliberately uses the server's attempt and event records rather
-- than browser counters. No student or teacher can call this function.
begin;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['game_windows', 'tutoring_attempts', 'step_states',
                               'step_events', 'step_hints'] loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'PIA 0042 requires public.% (apply 0039 first).', v_table;
    end if;
  end loop;
  if to_regprocedure('public.pia_caller_role()') is null
     or to_regprocedure('public.jwt_is_current()') is null then
    raise exception 'PIA 0042 requires the admin role/session guards.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'step_states'
                    and column_name = 'score') then
    raise exception 'PIA 0042 requires step_states.score (apply 0039 first).';
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
          left join public.step_states st
            on st.session_id = t.session_id and st.student_email = t.student_email
           and st.problem_id = t.problem_id
         where t.session_id = w.session_id and t.student_email = w.student_email
           and t.problem_id like 'qb-%'
           and t.created_at >= w.started_at and t.created_at < w.deadline_at
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
