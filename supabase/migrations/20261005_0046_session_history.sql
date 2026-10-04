-- PIA 0046: give a returning student back what the page used to forget on refresh:
-- the questions they have already solved (with their own working) and the last five
-- wrong entries (the error log). Until now both lived only in the browser's memory.
--
-- Read-only. Same guard as every game call; only the caller's own records of the given
-- session are read. The question's answer key is never returned: what comes back is what
-- the student typed and what the server accepted from them.
--   solved: every question of the session whose last step was accepted, in order:
--           { number, topic, question, steps: [{ title, text, confirmed }] }
--   errors: the last five wrong entries, oldest first, worded as the page words them:
--           'Step 2: Error on "x"' / 'Step 2: Final-answer error on "x"'
--   hints_total: hints taken in this session.
begin;

do $$
begin
  if to_regclass('public.served_questions') is null or to_regclass('public.step_states') is null
     or to_regclass('public.step_events') is null or to_regclass('public.step_hints') is null then
    raise exception 'PIA 0046 requires the 0039 game tables (apply 0039 first).';
  end if;
  if to_regprocedure('public.pia_game_email()') is null
     or to_regprocedure('public.pia_step_label(integer, integer)') is null then
    raise exception 'PIA 0046 requires the 0039 game functions (apply 0039 first).';
  end if;
end;
$$;

create or replace function public.get_session_history(p_session_id uuid)
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

  return jsonb_build_object(
    'solved', coalesce((
      select jsonb_agg(jsonb_build_object(
               'number',   sq.problem_number,
               'topic',    sq.topic,
               'question', sq.question,
               'steps',    (select coalesce(jsonb_agg(jsonb_build_object(
                                'title',     'Step ' || n.i || ': ' || public.pia_step_label(sq.topic, n.i - 1),
                                'text',      d.elem ->> 'text',
                                'confirmed', d.elem ->> 'confirmed') order by n.i), '[]'::jsonb)
                              from jsonb_array_elements(st.done_steps) with ordinality as d(elem, i)
                              cross join lateral (select d.i::int as i) n)) order by sq.problem_number)
        from public.served_questions sq
        join public.step_states st
          on st.session_id = sq.session_id and st.student_email = sq.student_email and st.problem_id = sq.problem_id
       where sq.session_id = p_session_id and sq.student_email = v_email and st.completed
    ), '[]'::jsonb),
    'errors', coalesce((
      select jsonb_agg(e.line order by e.id)
        from (select ev.id,
                     'Step ' || (ev.step_index + 1) || ': '
                       || case when ev.outcome = 'format_error' then 'Final-answer error on "' else 'Error on "' end
                       || ev.submitted || '"' as line
                from public.step_events ev
               where ev.session_id = p_session_id and ev.student_email = v_email
                 and ev.outcome in ('wrong', 'format_error')
               order by ev.id desc limit 5) e
    ), '[]'::jsonb),
    'hints_total', (select count(*)::int from public.step_hints h
                     where h.session_id = p_session_id and h.student_email = v_email));
end;
$$;

revoke all on function public.get_session_history(uuid) from public, anon;
grant execute on function public.get_session_history(uuid) to authenticated;

commit;
