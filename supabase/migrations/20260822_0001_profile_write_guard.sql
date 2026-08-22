-- ============================================================================
-- PIA 0001 -- PROFILE WRITE GUARD  (fixes CRITICAL 3: privilege escalation)
-- ============================================================================
-- Bakit trigger at hindi column-level GRANT:
--   Ang admin at ang estudyante ay PAREHONG gumagamit ng `authenticated` na
--   database role -- ang "admin" ay isang VALUE lang sa profiles.role, hindi
--   isang DB role. Kaya ang REVOKE UPDATE (role, ocean_e, ...) ay sabay na
--   sumisira sa admin score entry, retake flows, at student registration.
--   Isang trigger lang ang nakakakita ng pagkakaiba ng dalawa.
--
-- Paano nakakalusot ang mga lehitimong RPC:
--   Ang PostgREST ay tumatakbo bilang `authenticated` kapag direktang table
--   write mula sa browser. Ang SECURITY DEFINER na function na pag-aari ng
--   postgres ay tumatakbo na may current_user = 'postgres'. Kaya ang tseke
--   na `current_user <> 'authenticated'` ang siyang nagbubukas ng pinto para
--   sa LAHAT ng definer RPC -- pati ang mga umiiral na (admin_grant_stage,
--   release_device, admin_delete_user) -- nang hindi ko sila hinahawakan.
-- ============================================================================

-- Ang sariling role ng caller, RLS-bypassing para hindi mag-recurse ang
-- SELECT policy ng profiles sa loob ng trigger na nasa profiles din.
create or replace function public.pia_caller_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(trim(coalesce(p.role, 'student')))
  from public.profiles p
  where p.email = (auth.jwt() ->> 'email')
  limit 1;
$$;

revoke all on function public.pia_caller_role() from public, anon;
grant execute on function public.pia_caller_role() to authenticated;


create or replace function public.enforce_profile_write_scope()
returns trigger
language plpgsql
security invoker              -- MAHALAGA: invoker, para totoo ang current_user
set search_path = public
as $$
declare
  -- Ang TANGING mga column na kayang baguhin ng estudyante sa SARILING row.
  -- Lahat ng iba (role, email, group_type, is_ocean_done, ocean_*,
  -- current_stage, stage_started_at, pre_test_score, post_test_score,
  -- max_devices, section, full_name) ay protektado by default -- pati na ang
  -- anumang bagong column na idadagdag mo sa hinaharap.
  v_student_writable constant text[] := array[
    'selected_character',
    'is_in_game', 'current_problem', 'current_difficulty',
    'hints_used', 'consecutive_correct',
    'active_devices',
    'status',
    'last_seen', 'updated_at'
  ];
  v_caller_email text := auth.jwt() ->> 'email';
  v_caller_role  text;
begin
  -- (1) Hindi galing sa browser: SECURITY DEFINER RPC o service_role. Trusted.
  if current_user <> 'authenticated' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  v_caller_role := public.pia_caller_role();

  -- (2) Admin: walang pagbabago sa dating asal.
  if v_caller_role = 'admin' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- (3) Estudyante/teacher na direktang sumusulat mula sa browser.
  if tg_op = 'INSERT' then
    raise exception 'PIA: hindi ka pwedeng gumawa ng profile row (role=%).', coalesce(v_caller_role, 'unknown')
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    raise exception 'PIA: hindi ka pwedeng magbura ng profile row (role=%).', coalesce(v_caller_role, 'unknown')
      using errcode = '42501';
  end if;

  -- Sariling row lang, at hindi pwedeng ilipat ang row sa ibang email.
  if v_caller_email is null
     or old.email is distinct from v_caller_email
     or new.email is distinct from old.email then
    raise exception 'PIA: hindi ka pwedeng magbago ng profile na hindi sa iyo.'
      using errcode = '42501';
  end if;

  -- Ihambing ang lahat ng column MALIBAN sa whitelist. Kung may naiba doon,
  -- may sinusubukang i-forge -- ibagsak ang buong statement.
  if (to_jsonb(old) - v_student_writable) is distinct from (to_jsonb(new) - v_student_writable) then
    raise exception
      'PIA: bawal ang direktang pagsulat sa protektadong profile column. Gamitin ang submit_ocean_results() / set_student_stage().'
      using errcode = '42501';
  end if;

  return new;
end;
$$;


-- ============================================================================
-- RECONCILIATION -- profiles_guard_privileged_columns
-- ============================================================================
-- May umiiral nang BEFORE-trigger sa profiles. Ito ang buong katawan nito:
--
--   begin
--     if exists (select 1 from public.profiles
--                 where email = auth.jwt() ->> 'email'
--                   and lower(trim(role)) = 'admin') then
--       return new;
--     end if;
--     new.role            := old.role;
--     new.group_type      := old.group_type;
--     new.pre_test_score  := old.pre_test_score;
--     new.post_test_score := old.post_test_score;
--     new.max_devices     := old.max_devices;
--     new.email           := old.email;
--     new.section         := old.section;
--     return new;
--   end;
--
-- Tatlong bagay ang mahalaga dito:
--
-- (1) TAHIMIK ITONG NAGBABALIK, hindi nagtatapon ng error. Ang
--     update({role:'admin'}) ng estudyante ay nagbabalik ng HTTP 200 na parang
--     nagtagumpay -- pero walang nangyayari. Protektado nga, pero walang
--     nakakaalam na may sumubok.
--
-- (2) PITONG column lang ang binabantayan nito. WALA rito ang is_ocean_done,
--     ocean_e/a/c/n/o, at current_stage -- kaya bukas na bukas pa rin ang
--     pagpepeke ng OCEAN scores at ang stage bypass. Iyon ang CRITICAL 2 at 3.
--
-- (3) KUNG PAGSASABAYIN SILA, magkakamali ang resulta. Ang mga BEFORE row
--     trigger ay tumatakbo nang ALPABETIKO ayon sa pangalan, kaya
--     'profiles_guard_...' (p) ang mauuna sa 'trg_enforce_...' (t). Isasauli
--     muna nito ang NEW pabalik sa OLD, tapos ang akin naman ay ikukumpara ang
--     OLD sa NEW -- pareho na sila, kaya PAPAYAGAN ko ang forge attempt sa
--     halip na i-403 ito. Pareho pa rin ang seguridad, pero mali ang mensahe
--     at mali ang mababasa sa VERIFY_write_paths.sql.
--
-- Ang whitelist sa ibaba ay STRICT SUPERSET ng pitong column nito (wala ni isa
-- sa role/group_type/pre_test_score/post_test_score/max_devices/email/section
-- ang student-writable), kaya walang proteksyong nawawala sa pagpapalit.
--
-- PARA IBALIK ITO (rollback):
--   create trigger profiles_guard_privileged_columns
--     before update on public.profiles
--     for each row execute function public.profiles_guard_privileged_columns();
--   drop trigger trg_enforce_profile_write_scope on public.profiles;
--
-- Ang FUNCTION ay sinasadyang hindi binubura -- ang restore ay isang statement
-- lang. Ang trigger lang ang tinatanggal.
-- ============================================================================

drop trigger if exists profiles_guard_privileged_columns on public.profiles;

drop trigger if exists trg_enforce_profile_write_scope on public.profiles;

create trigger trg_enforce_profile_write_scope
  before insert or update or delete on public.profiles
  for each row execute function public.enforce_profile_write_scope();
