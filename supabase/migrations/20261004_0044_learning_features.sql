-- PIA 0044: the numbers the tutor's wording profile is worked out from, taken
-- from the server's OWN records. The profile itself is NOT decided here: it is
-- decided by the pia-ml-api service (its model and inference are used unchanged),
-- called by the Edge Function `learning-profile`, never by the browser.
--
-- Flow:  student's browser -> Edge Function learning-profile -> pia-ml-api
-- This function gives the Edge Function the same seven rolling numbers the
-- attached game computed in the browser (last 8 submissions): accuracy, attempts
-- per step, hint rate, response time and efficiency on correct answers, and the
-- current right/wrong streaks. The server measures them, so the browser cannot
-- shape what the model sees. They contain no name, email, student id or session
-- id. Read-only: nothing is written.
-- Differences from the browser version, because the server measures: a response
-- time is the gap since the previous recorded event or hint of the session (else
-- since the question was served), capped at 300 s; a revisited step counts once.
begin;

do $$
begin
  if to_regclass('public.step_events') is null or to_regclass('public.step_hints') is null
     or to_regclass('public.problem_serves') is null then
    raise exception 'PIA 0044 requires the 0039 game tables (apply 0039 first).';
  end if;
  if to_regprocedure('public.pia_game_email()') is null then
    raise exception 'PIA 0044 requires public.pia_game_email() (apply 0039 first).';
  end if;
end;
$$;

create or replace function public.pia_learning_features_calc(p_session_id uuid, p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_n int; v_correct int; v_steps int; v_hinted int; v_streak int; v_last boolean;
  v_acc numeric; v_attempts numeric; v_hint_rate numeric; v_eff numeric; v_time numeric;
  v_cc int := 0; v_cw int := 0;
begin
  -- The last eight submissions of the session, newest first (rn = 1).
  with recent as (
    select row_number() over (order by e.id desc)::int as rn,
           e.outcome in ('needs_final', 'step_done', 'question_done') as correct,
           least(300, greatest(0, extract(epoch from (e.happened_at - coalesce(
             (select max(p.at) from (
                select pe.happened_at as at from public.step_events pe
                 where pe.session_id = e.session_id and pe.student_email = e.student_email
                   and pe.id < e.id
                 union all
                select sh.taken_at from public.step_hints sh
                 where sh.session_id = e.session_id and sh.student_email = e.student_email
                   and sh.taken_at < e.happened_at) p),
             (select ps.served_at from public.problem_serves ps
               where ps.session_id = e.session_id and ps.student_email = e.student_email
                 and ps.problem_id = e.problem_id
               order by ps.served_at desc limit 1),
             e.happened_at - interval '120 seconds')))))::numeric as rt,
           e.problem_id, e.step_index,
           (select count(*)::int from public.step_events x
             where x.session_id = e.session_id and x.student_email = e.student_email
               and x.problem_id = e.problem_id and x.step_index = e.step_index and x.id <= e.id
               and x.outcome in ('wrong', 'format_error', 'needs_final', 'step_done', 'question_done'))
             as attempt_no,
           exists (select 1 from public.step_hints h
                    where h.session_id = e.session_id and h.student_email = e.student_email
                      and h.problem_id = e.problem_id and h.step_index = e.step_index) as hinted
      from public.step_events e
     where e.session_id = p_session_id and e.student_email = p_email
       and e.outcome in ('wrong', 'format_error', 'needs_final', 'step_done', 'question_done')
     order by e.id desc
     limit 8
  ), steps as (
    select problem_id, step_index, bool_or(hinted) as hinted, max(attempt_no) as m
      from recent group by problem_id, step_index
  )
  select (select count(*) from recent),
         (select count(*) filter (where correct) from recent),
         (select correct from recent where rn = 1),
         coalesce((select min(rn) from recent
                    where correct is distinct from (select correct from recent where rn = 1)),
                  (select count(*) + 1 from recent)) - 1,
         coalesce((select avg(1.0 / (1.0 + rt / 30.0)) filter (where correct) from recent), 0),
         coalesce((select avg(rt) filter (where correct) from recent), 120),
         (select count(*) from steps),
         (select count(*) filter (where hinted) from steps),
         (select avg(m) from steps)
    into v_n, v_correct, v_last, v_streak, v_eff, v_time, v_steps, v_hinted, v_attempts;

  -- Nothing answered yet: the attached game's own starting values.
  if coalesce(v_n, 0) = 0 then
    return jsonb_build_object('events', 0, 'features', jsonb_build_object(
      'recent_accuracy', 0.5, 'average_attempts', 1, 'hint_rate', 0,
      'average_response_time', 120, 'correct_response_efficiency', 0,
      'consecutive_correct', 0, 'consecutive_wrong', 0));
  end if;

  v_acc := v_correct::numeric / v_n;
  v_attempts := greatest(1, coalesce(v_attempts, 1));
  v_hint_rate := case when v_steps > 0 then v_hinted::numeric / v_steps else 0 end;
  if v_last then v_cc := v_streak; else v_cw := v_streak; end if;

  return jsonb_build_object('events', v_n, 'features', jsonb_build_object(
    'recent_accuracy', round(v_acc, 4),
    'average_attempts', round(v_attempts, 4),
    'hint_rate', round(v_hint_rate, 4),
    'average_response_time', round(v_time, 2),
    'correct_response_efficiency', round(v_eff, 4),
    'consecutive_correct', v_cc,
    'consecutive_wrong', v_cw));
end;
$$;

-- The student's call (made by the Edge Function with the student's own token).
-- Same guard as every game call; only the caller's own records are read.
create or replace function public.get_learning_features(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text := public.pia_game_email();
begin
  if p_session_id is null then
    raise exception 'PIA: a session is required.' using errcode = '22023';
  end if;
  return public.pia_learning_features_calc(p_session_id, v_email);
end;
$$;

revoke all on function public.pia_learning_features_calc(uuid, text) from public, anon, authenticated;
revoke all on function public.get_learning_features(uuid) from public, anon;
grant execute on function public.get_learning_features(uuid) to authenticated;

commit;
