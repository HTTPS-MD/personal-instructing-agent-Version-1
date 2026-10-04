-- PIA 0041: Save the Assigned group's tutor when the server records OCEAN.
-- This does not rewrite existing submissions or profiles. Apply after 0039
-- and the already deployed 0040 hint change; neither RPC is replaced here.
-- The student's RPC response still contains only next_stage, never scores.
begin;

create or replace function public.pia_choose_assigned_character(
  p_e integer, p_a integer, p_c integer, p_n integer, p_o integer)
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  v_choice text;
begin
  if num_nonnulls(p_e, p_a, p_c, p_n, p_o) <> 5
     or p_e not between 0 and 40 or p_a not between 0 and 40
     or p_c not between 0 and 40 or p_n not between 0 and 40
     or p_o not between 0 and 40 then
    raise exception 'PIA: invalid questionnaire scores.' using errcode = '22023';
  end if;

  -- The BFPT sheet's N formula runs opposite to its prose definition: a low
  -- stored N means more stress. Reverse N for character matching only. The
  -- existing pia-calm key points to the Neuroticism character in the artwork.
  select candidate.character_key into v_choice
    from (values
      ('pia-extravert',     p_e),
      ('pia-agreeable',     p_a),
      ('pia-conscientious', p_c),
      ('pia-calm',          40 - p_n),
      ('pia-open',          p_o)
    ) as candidate(character_key, score)
   where candidate.score = greatest(p_e, p_a, p_c, 40 - p_n, p_o)
   order by random()
   limit 1;

  return v_choice;
end;
$$;

revoke all on function public.pia_choose_assigned_character(integer, integer, integer, integer, integer)
  from public, anon, authenticated;

create or replace function public.pia_assign_tutor_from_ocean()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only a newly completed questionnaire for an Assigned student counts.
  -- The retake action resets is_ocean_done, so it also gets a new assignment.
  -- Existing manual choices are intentionally replaced by this result.
  if new.source = 'questionnaire' then
    update public.profiles p
       set selected_character = public.pia_choose_assigned_character(
         new.ocean_e, new.ocean_a, new.ocean_c, new.ocean_n, new.ocean_o)
     where p.email = new.email
       and lower(trim(coalesce(p.group_type, ''))) = 'assigned'
       and not coalesce(p.is_ocean_done, false);
  end if;
  return new;
end;
$$;

revoke all on function public.pia_assign_tutor_from_ocean() from public, anon, authenticated;

drop trigger if exists ocean_submission_assign_tutor on public.ocean_submissions;
create trigger ocean_submission_assign_tutor
  after insert on public.ocean_submissions
  for each row execute function public.pia_assign_tutor_from_ocean();

-- Pure-rule checks. Full submission/stage behavior is tested on a staging DB.
do $$
declare
  v_choice text;
begin
  assert public.pia_choose_assigned_character(35, 10, 9, 20, 7) = 'pia-extravert';
  assert public.pia_choose_assigned_character(9, 35, 8, 20, 6) = 'pia-agreeable';
  assert public.pia_choose_assigned_character(9, 8, 35, 20, 6) = 'pia-conscientious';
  assert public.pia_choose_assigned_character(9, 8, 7, 2, 6) = 'pia-calm';
  assert public.pia_choose_assigned_character(9, 8, 7, 20, 35) = 'pia-open';
  assert public.pia_choose_assigned_character(30, 10, 9, 40, 7) = 'pia-extravert',
    'a calm response pattern must not win the Neuroticism character';
  for v_choice in select public.pia_choose_assigned_character(30, 30, 9, 20, 7)
                    from generate_series(1, 30) loop
    assert v_choice in ('pia-extravert', 'pia-agreeable'),
      'a tie may choose only one of the highest traits';
  end loop;
end;
$$;

commit;
