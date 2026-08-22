-- ============================================================================
-- PIA 0003 -- VALIDATED STAGE TRANSITIONS
-- ============================================================================
-- Fixes:
--   * "hasTargetedGrant" bypass -- ang current_stage mismo ang ginagamit na
--     grant marker, pero ang BROWSER ng estudyante ang nagsusulat nito. Kaya
--     kayang bigyan ng kahit sinong estudyante ang sarili nila ng kahit anong
--     stage sa isang linya sa console. Pagkatapos ng 0001, ang current_stage
--     ay hindi na nila kayang sulatan nang direkta; dito na dumadaan lahat, at
--     may server-side prerequisite check.
--   * "Sarado na ang stage pero nasa loob pa rin sila" -- ang pag-close ng
--     stage ay HINDI dating nagpapaalis ng mga nakapasok na. Nagpapaalis na.
-- ============================================================================

-- Isang source of truth sa server para sa prerequisite chain -- eksaktong
-- katumbas ng canEnterStage() sa assets/js/function.js.
--
-- TANDAAN: SCALAR ang mga parameter, hindi `public.profiles`. Ang function na
-- ang unang argumento ay row type ng isang table ay itinuturing ng PostgREST na
-- COMPUTED COLUMN ng table na iyon -- at dahil dalawa ang kailangan nitong
-- argumento, bumabagsak ang `select=*` at nagiging 500 ang bawat REST read sa
-- profiles. Tingnan ang 0005 hotfix. Huwag itong ibalik sa row type.
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


-- ============================================================================
-- set_student_stage(p_stage)
--   Ini-anunsyo ng estudyante kung saang stage sila pumapasok. Sine-check ng
--   server ang prerequisite chain AT ang stage flag bago sumulat.
--   Kung hindi sila pwede doon, 'Waiting Room' ang naitatala at ibinabalik --
--   hindi ito error, ito ang normal na "sarado pa" na daloy.
--   Nagbabalik ng { stage, granted }.
-- ============================================================================
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

  -- (a) prerequisite chain  AT  (b) bukas na flag o naunang admin grant.
  if public.pia_can_enter_stage(v_profile.is_ocean_done, v_profile.group_type,
                                v_profile.selected_character, p_stage) then
    v_ok := v_flag is null
            or public.pia_stage_open(v_flag)
            or v_profile.current_stage is not distinct from p_stage;  -- targeted grant ng admin
  end if;

  if not v_ok then
    -- Hindi pinapayagan: itala silang nasa Waiting Room, huwag magtapon ng error.
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


-- ============================================================================
-- admin_set_stage_open(p_stage, p_open)
--   Pinapalitan ang direktang `settings` upsert ng admin dashboard.
--   Kapag NAGSASARA: ibinabalik sa Waiting Room ang lahat ng nasa stage na
--   iyon. Kung wala nito, ang mga nakapasok na ay nananatili doon dahil ang
--   sarili nilang current_stage ay nagsisilbing targeted grant.
--   Nagbabalik ng { stage, open, evicted }.
-- ============================================================================
create or replace function public.admin_set_stage_open(p_stage text, p_open boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label    text;
  v_evicted  int := 0;
  v_valtype  text;
begin
  if public.pia_caller_role() <> 'admin' then
    raise exception 'PIA: admin lang ang pwedeng magbukas/magsara ng stage.' using errcode = '42501';
  end if;

  if p_stage not in ('ocean', 'char', 'dash') then
    raise exception 'PIA: hindi kilalang stage key: %', coalesce(p_stage, '(null)') using errcode = '22023';
  end if;

  v_label := case p_stage when 'ocean' then 'OCEAN'
                          when 'char'  then 'Character Selection'
                          else 'Tutoring Dashboard' end;

  -- Ang settings.value ay maaaring jsonb o boolean depende sa kung paano ito
  -- unang nagawa. Dumadaan sa text cast para gumana sa dalawa.
  select atttypid::regtype::text into v_valtype
    from pg_attribute
   where attrelid = 'public.settings'::regclass and attname = 'value';

  execute format(
    'insert into public.settings (key, value) values ($1, $2::%s)
       on conflict (key) do update set value = excluded.value', v_valtype)
    using 'stage_' || p_stage, case when p_open then 'true' else 'false' end;

  if not p_open then
    with evicted as (
      update public.profiles
         set current_stage = 'Waiting Room', stage_started_at = now()
       where current_stage = v_label
         and lower(trim(coalesce(role, 'student'))) = 'student'
      returning 1)
    select count(*) into v_evicted from evicted;
  end if;

  return jsonb_build_object('stage', p_stage, 'open', p_open, 'evicted', v_evicted);
end;
$$;

revoke all on function public.admin_set_stage_open(text, boolean) from public, anon;
grant execute on function public.admin_set_stage_open(text, boolean) to authenticated;
