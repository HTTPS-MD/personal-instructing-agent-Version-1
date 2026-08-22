-- ============================================================================
-- Handa na ba ang test student para sa 10-problem playthrough?
-- Sinasalamin nito ang canEnterStage(profile,'dash') + enforceStudentStage()
-- sa assets/js/function.js. READ-ONLY.
-- ============================================================================
select p.email,
       p.status,
       case when p.status = 'active' then 'ok'
            else 'HINDI PA AKTIBO -- kailangan ng activation link bago makapag-login'
       end                                                            as login_ready,

       p.is_ocean_done,
       case when coalesce(p.is_ocean_done, false) then 'ok'
            else 'HINDI -- ita-tapon sa OCEAN test, hindi sa laro'
       end                                                            as ocean_gate,

       p.group_type,
       p.selected_character,
       case when lower(trim(coalesce(p.group_type,''))) in ('non-assigned','non_assigned')
                 and p.selected_character is null
            then 'HINDI -- non-assigned na walang character: sa Character Selection mapupunta'
            else 'ok'
       end                                                            as character_gate,

       p.current_stage,
       public.pia_stage_open('stage_dash')                            as stage_dash_open,
       case when public.pia_stage_open('stage_dash')
                 or p.current_stage = 'Tutoring Dashboard'
            then 'ok'
            else 'SARADO -- buksan ang Tutoring Dashboard stage sa admin, o mag-grant'
       end                                                            as stage_gate,

       coalesce(array_length(p.active_devices,1),0) || ' / ' || coalesce(p.max_devices,1) as devices_used,
       case when coalesce(array_length(p.active_devices,1),0) >= coalesce(p.max_devices,1)
            then 'PUNO -- i-revoke ang device sa admin bago mag-login sa bagong PC'
            else 'ok'
       end                                                            as device_gate
  from public.profiles p
 where lower(trim(coalesce(p.role,'student'))) = 'student'
 order by p.email;
