-- PIA 0047: a hint guides; it never gives the answer.
--
-- The admin's sentence generator used to write Hint 3 as a "worked calculation" that ENDS
-- in the result ("0.4 * 350 = 140"), so the third hint handed the student the final answer
-- (and the step answers). The admin editor now writes and checks guidance-only hints; this
-- migration is the safety net for every question already in the bank: before a hint leaves
-- the server, a number that is the step's answer (or the question's final answer) and is
-- written as a result is replaced by "___":
--     "0.4 * 350 = 140"          ->  "0.4 * 350 = ___"
--     "So the answer is 140."    ->  "So the answer is ___."
--     "Multiply 0.4 by 350"      ->  unchanged (no result is shown)
--     "Find 25% of 100"          ->  unchanged (25 is a given here, not written as a result)
-- Only the hint text returned to the student changes. Nothing stored is edited or deleted;
-- consume_step_hint is otherwise exactly as in 0039.
begin;

do $$
begin
  if to_regprocedure('public.consume_step_hint(uuid, text)') is null
     or to_regprocedure('public.pia_step_hints(jsonb, text)') is null then
    raise exception 'PIA 0047 requires the 0039 game functions (apply 0039 first).';
  end if;
end;
$$;

-- p_answers: the step's answer and the question's final answer (either may be null).
create or replace function public.pia_mask_answers(p_text text, p_answers text[])
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_out   text := coalesce(p_text, '');
  v_nums  numeric[] := '{}';
  a       text;
  n       text;
  m       text[];
  v_val   numeric;
begin
  foreach a in array coalesce(p_answers, '{}') loop
    n := substring(replace(coalesce(a, ''), ',', '') from '-?\d+(?:\.\d+)?');
    if n is not null then v_nums := v_nums || n::numeric; end if;
  end loop;
  if cardinality(v_nums) = 0 then return v_out; end if;

  -- a number written as a result: after "=", "answer", "result", "equals", "gives", "get(s)"
  for m in
    select regexp_matches(p_text,
      '((?:=|\m(?:answers?|results?|equals?|gives?|gets?)\M)\s*(?:is|are|:|=)?\s*)(-?\d[\d,]*(?:\.\d+)?)(\s*%?)', 'gi')
  loop
    v_val := replace(m[2], ',', '')::numeric;
    if v_val = any (v_nums) then
      v_out := replace(v_out, m[1] || m[2] || m[3], m[1] || '___' || m[3]);
    end if;
  end loop;
  return v_out;
end;
$$;

revoke all on function public.pia_mask_answers(text, text[]) from public, anon, authenticated;

create or replace function public.consume_step_hint(p_session_id uuid, p_problem_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text;
  v_sq    public.served_questions%rowtype;
  v_st    public.step_states%rowtype;
  v_list  text[];
  v_tier  int;
  v_w     public.game_windows%rowtype;
begin
  v_email := public.pia_game_email();
  perform pg_advisory_xact_lock(hashtext('pia-lesson:' || v_email));

  select * into v_sq from public.served_questions
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;
  select * into v_st from public.step_states
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id
   for update;
  if v_sq.problem_id is null or v_st.problem_id is null then
    raise exception 'PIA: this question was not served to you.' using errcode = '42501';
  end if;

  v_w := public.pia_game_window(p_session_id, v_email);
  if v_st.completed or not v_st.hint_unlocked or public.pia_window_expired(v_w) then
    return jsonb_build_object('hint', null, 'state', public.pia_step_state_json(v_sq, v_st),
                              'clock', public.pia_clock_json(v_w));
  end if;

  v_list := public.pia_step_hints(v_sq.steps -> v_st.step_index, v_sq.default_hint);
  v_tier := least(v_st.hint_tier + 1, cardinality(v_list));

  insert into public.step_hints (session_id, student_email, problem_id, step_index, tier, tiers_total)
  values (p_session_id, v_email, p_problem_id, v_st.step_index, v_tier, cardinality(v_list));

  update public.step_states
     set hint_tier = v_tier, hints = hints + 1, updated_at = now()
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id
   returning * into v_st;

  return jsonb_build_object(
    'hint', jsonb_build_object(
      'text', public.pia_mask_answers(v_list[v_tier],
                array[v_sq.steps -> v_st.step_index ->> 'answer', v_sq.final_answer]),
      'tier', v_tier, 'tiers_total', cardinality(v_list),
      'step', v_st.step_index + 1),
    'state', public.pia_step_state_json(v_sq, v_st),
    'clock', public.pia_clock_json(v_w));
end;
$$;

revoke all on function public.consume_step_hint(uuid, text) from public, anon;
grant execute on function public.consume_step_hint(uuid, text) to authenticated;

commit;
