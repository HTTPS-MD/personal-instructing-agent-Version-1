-- ============================================================================
-- PIA 0016 -- RESUME AN INTERRUPTED TUTORING SESSION
-- ============================================================================
-- Today, tutoring-dashboard.js always calls start_game_session(), which opens a
-- fresh session and closes the previous one. So a student who taps Home and
-- comes back to Mission restarts from problem 1 -- and the partial session is
-- left behind as an abandoned record.
--
-- This returns the student's most recent UNFINISHED session together with
-- enough state for the client to pick up exactly where it stopped, and only
-- falls through to start_game_session() when there is nothing to resume.
--
-- It deliberately does NOT need the game-session table: everything is derived
-- from problem_serves and tutoring_attempts, which I can see.
-- ============================================================================

create or replace function public.resume_or_start_game_session()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_session uuid;
  v_answered int;
  v_correct  int;
  v_served   text[];
  v_pending  text;
  v_state    jsonb;
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;

  -- Most recent session this student was actually served a problem in.
  select ps.session_id into v_session
    from public.problem_serves ps
   where ps.student_email = v_email
   order by ps.served_at desc
   limit 1;

  if v_session is not null then
    select count(*), coalesce(count(*) filter (where is_correct), 0)
      into v_answered, v_correct
      from public.tutoring_attempts
     where session_id = v_session and student_email = v_email;

    -- Resumable only if started but not finished. 10 = SESSION_TARGET.
    if v_answered > 0 and v_answered < 10 then

      select coalesce(array_agg(ps.problem_id), '{}') into v_served
        from public.problem_serves ps
       where ps.session_id = v_session and ps.student_email = v_email;

      -- A problem that was served but never resolved: they left mid-question.
      select ps.problem_id into v_pending
        from public.problem_serves ps
       where ps.session_id = v_session
         and ps.student_email = v_email
         and not exists (select 1 from public.tutoring_attempts ta
                          where ta.session_id = ps.session_id
                            and ta.problem_id = ps.problem_id)
       order by ps.served_at desc
       limit 1;

      -- Restart that problem's clock. served_at drives time_taken_ms, and
      -- without this the minutes spent away would be counted as time on task
      -- and would misclassify the attempt as 'struggling'. We measure time
      -- solving, not time the tab sat closed.
      if v_pending is not null then
        update public.problem_serves
           set served_at = now()
         where session_id = v_session and problem_id = v_pending;
      end if;

      v_state := public.pia_session_state(v_session, v_email);

      return jsonb_build_object(
        'session_id',          v_session,
        'resumed',             true,
        'problems_answered',   v_answered,
        'correct_count',       v_correct,
        'level',               (v_state ->> 'level')::int,
        'consecutive_correct', (v_state ->> 'consecutive_correct')::int,
        'served_problem_ids',  to_jsonb(v_served),
        'pending_problem_id',  v_pending);
    end if;
  end if;

  -- Nothing to resume: normal fresh start.
  return jsonb_build_object(
    'session_id',          public.start_game_session(),
    'resumed',             false,
    'problems_answered',   0,
    'correct_count',       0,
    'level',               1,
    'consecutive_correct', 0,
    'served_problem_ids',  to_jsonb(array[]::text[]),
    'pending_problem_id',  null);
end;
$$;

revoke all on function public.resume_or_start_game_session() from public, anon;
grant execute on function public.resume_or_start_game_session() to authenticated;

notify pgrst, 'reload schema';
