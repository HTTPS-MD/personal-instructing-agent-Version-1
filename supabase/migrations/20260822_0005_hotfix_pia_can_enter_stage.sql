-- ============================================================================
-- PIA 0005 -- HOTFIX: 500 sa GET /rest/v1/profiles?select=*
-- ============================================================================
-- SINTOMAS: pagkatapos ng 0003, ang bawat SELECT sa profiles sa pamamagitan ng
-- PostgREST ay nagbabalik ng 500 Internal Server Error. Kasama rito ang
-- profile fetch pagkatapos ng sign-in, kaya walang sinuman ang makakapasok --
-- pati ang admin.
--
-- SANHI: sa 0003 ay ginawa ko itong may composite-type na unang parameter:
--
--     pia_can_enter_stage(p_profile public.profiles, p_stage text)
--
-- Ang isang function na ang UNANG argumento ay ang row type ng isang table ay
-- itinuturing ng PostgREST na COMPUTED COLUMN ng table na iyon. Kapag
-- pinalawak nito ang `select=*`, sinusubukan nitong tawagin ang
-- `pia_can_enter_stage(profiles)` -- na kulang ng pangalawang argumento. Ang
-- na-generate na SQL ay bumabagsak, at 500 ang ibinabalik ng PostgREST.
--
-- Dahil ang profiles lang ang table na may ganitong function, ang profiles lang
-- ang naapektuhan -- kaya tumutugma ito nang eksakto sa nakitang sintomas.
--
-- AKING PAGKAKAMALI: ang pagpasa ng buong row ay mas malinis basahin, pero sa
-- isang schema na ini-expose ng PostgREST, ang composite-type na parameter ay
-- hindi lang basta istilo -- nagbabago ito ng hugis ng REST API. Scalar na
-- lang ang parameter dito. Hindi nagbabago ang lohika ni katiting.
-- ============================================================================

-- Kailangang i-drop muna: ibang signature = bagong overload, at mananatili ang
-- sirang luma bilang computed column.
drop function if exists public.pia_can_enter_stage(public.profiles, text);


create or replace function public.pia_can_enter_stage(
  p_is_ocean_done      boolean,
  p_group_type         text,
  p_selected_character text,
  p_stage              text)
returns boolean
language sql
immutable
as $$
  select case p_stage
    when 'OCEAN' then
      not coalesce(p_is_ocean_done, false)
    when 'Character Selection' then
      coalesce(p_is_ocean_done, false)
      and lower(trim(coalesce(p_group_type, ''))) in ('non-assigned', 'non_assigned')
      and p_selected_character is null
    when 'Tutoring Dashboard' then
      coalesce(p_is_ocean_done, false)
      and not (lower(trim(coalesce(p_group_type, ''))) in ('non-assigned', 'non_assigned')
               and p_selected_character is null)
    when 'Waiting Room' then
      true
    else false
  end;
$$;


-- Muling itinatakda ang set_student_stage para sa bagong signature. Wala nang
-- ibang pagbabago -- pareho pa rin ang bawat tuntunin.
create or replace function public.set_student_stage(p_stage text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_profile public.profiles%rowtype;
  v_flag    text;
  v_ok      boolean := false;
begin
  if v_email is null then
    raise exception 'PIA: walang authenticated session.' using errcode = '42501';
  end if;

  if p_stage is null or p_stage not in ('OCEAN', 'Character Selection', 'Tutoring Dashboard', 'Waiting Room') then
    raise exception 'PIA: hindi kilalang stage: %', coalesce(p_stage, '(null)') using errcode = '22023';
  end if;

  select * into v_profile from public.profiles where email = v_email;
  if not found then
    raise exception 'PIA: walang profile para sa session na ito.' using errcode = '42501';
  end if;

  v_flag := case p_stage
              when 'OCEAN'              then 'stage_ocean'
              when 'Character Selection' then 'stage_char'
              when 'Tutoring Dashboard' then 'stage_dash'
              else null
            end;

  if public.pia_can_enter_stage(v_profile.is_ocean_done, v_profile.group_type,
                                v_profile.selected_character, p_stage) then
    v_ok := v_flag is null
            or public.pia_stage_open(v_flag)
            or v_profile.current_stage is not distinct from p_stage;  -- targeted grant ng admin
  end if;

  if not v_ok then
    if v_profile.current_stage is distinct from 'Waiting Room' then
      update public.profiles
         set current_stage = 'Waiting Room', stage_started_at = now()
       where email = v_email;
    end if;
    return jsonb_build_object('stage', 'Waiting Room', 'granted', false);
  end if;

  if v_profile.current_stage is distinct from p_stage then
    update public.profiles
       set current_stage = p_stage, stage_started_at = now()
     where email = v_email;
  end if;

  return jsonb_build_object('stage', p_stage, 'granted', true);
end;
$$;

revoke all on function public.set_student_stage(text) from public, anon;
grant execute on function public.set_student_stage(text) to authenticated;

-- Pilitin ang PostgREST na i-reload ang schema cache agad.
notify pgrst, 'reload schema';
