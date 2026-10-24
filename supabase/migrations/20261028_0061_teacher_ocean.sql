-- PIA 0061: a teacher takes the OCEAN questionnaire once, right after signing in.
--
-- WHY. The professor of a section is part of the study, so each teacher answers the same 50
-- statements the students do, before their dashboard opens. There is no admin switch for
-- it: it is simply open for a teacher who has not done it yet.
--
-- WHAT. One function, submit_ocean_results_teacher(integer[]):
--   * only a TEACHER can call it (anyone else is refused);
--   * once only: a teacher who already finished is refused (an admin retake that sets
--     profiles.is_ocean_done back to false lets them answer again);
--   * same validation and the same scoring sheet as the students' (public.pia_bfpt_score);
--   * the answers and scores go to ocean_submissions, which only an admin can read, so the
--     teacher never sees a score and no student sees theirs;
--   * profiles.is_ocean_done becomes true. NOTHING ELSE on the profile changes: no stage, no
--     group, no tutor. (The tutor-assignment trigger of 0041 only touches rows whose
--     group_type is 'assigned', which a teacher never has.)
--
-- submit_ocean_results (the students' function) is not touched.
-- Requires 0018 (pia_bfpt_score, ocean_submissions.scoring_key/source) and 0001 (pia_caller_role).
-- Nothing is changed in any existing row. SAFE TO RE-RUN.
begin;

do $$
begin
  if to_regprocedure('public.pia_bfpt_score(integer[])') is null
     or to_regprocedure('public.pia_caller_role()') is null
     or to_regprocedure('public.jwt_is_current()') is null then
    raise exception 'PIA 0061 ABORT (nothing changed): apply 0001, 0018 and the auth helpers first.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.submit_ocean_results_teacher(p_responses integer[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_profile public.profiles%rowtype;
  r         integer[];
  k         record;
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;
  if public.pia_caller_role() is distinct from 'teacher' or not public.jwt_is_current() then
    raise exception 'PIA: only a teacher can use this questionnaire.' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles where email = v_email;
  if not found then
    raise exception 'PIA: no profile found for this session.' using errcode = '42501';
  end if;

  if coalesce(v_profile.is_ocean_done, false) then
    raise exception 'PIA: this questionnaire has already been submitted. Ask an admin for a retake.'
      using errcode = '42501';
  end if;

  if p_responses is null or array_length(p_responses, 1) is distinct from 50 then
    raise exception 'PIA: exactly 50 responses are required (received: %).',
      coalesce(array_length(p_responses, 1), 0) using errcode = '22023';
  end if;

  r := array(select x from unnest(p_responses) with ordinality as t(x, i) order by i);

  if exists (select 1 from unnest(r) v where v is null or v < 1 or v > 5) then
    raise exception 'PIA: every response must be between 1 and 5.' using errcode = '22023';
  end if;

  select * into k from public.pia_bfpt_score(r);

  insert into public.ocean_submissions
         (email, responses, ocean_e, ocean_a, ocean_c, ocean_n, ocean_o, scoring_key, source)
  values (v_email, r::smallint[], k.ocean_e, k.ocean_a, k.ocean_c, k.ocean_n, k.ocean_o,
          'bfpt-2026-07-22', 'questionnaire');

  update public.profiles set is_ocean_done = true where email = v_email;

  return jsonb_build_object('done', true);
end;
$$;

revoke all on function public.submit_ocean_results_teacher(integer[]) from public, anon;
grant execute on function public.submit_ocean_results_teacher(integer[]) to authenticated;

commit;
