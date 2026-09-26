-- ============================================================================
-- PIA -- WRITE PATH VERIFICATION HARNESS
-- ============================================================================
-- LIGTAS ITO SA PRODUCTION. Lahat ay nasa loob ng isang transaction na
-- nagtatapos sa ROLLBACK -- walang natitirang pagbabago. I-paste ang BUONG
-- file nang sabay-sabay at pindutin ang Run.
--
-- Layunin: sagutin nang EMPIRICAL ang tanong na hindi kayang sagutin ng
-- pagbabasa ng code -- magkasundo ba ang bagong trg_enforce_profile_write_scope
-- at ang lumang profiles_guard_privileged_columns, at dumadaan ba ang mga
-- bagong SECURITY DEFINER RPC sa dalawa nilang harang?
--
-- PATAKBUHIN ITO NANG DALAWANG BESES:
--   (1) BAGO i-apply ang 0001  -- makikita mo ang kasalukuyang butas
--                                 (dapat ALLOWED ang mga forge test = masama)
--   (2) PAGKATAPOS i-apply      -- dapat BLOCKED na lahat ng forge test,
--                                 at nanatiling ALLOWED lahat ng lehitimo.
--
-- Kung may lehitimong path na naging BLOCKED pagkatapos ng 0001, iyon ang
-- eksaktong conflict sa lumang trigger -- ipakita mo sa akin ang row na iyon.
-- ============================================================================

begin;

create temp table pia_verify (
  seq     int generated always as identity,
  label   text,
  expect  text,
  actual  text
) on commit drop;

create temp table pia_cfg on commit drop as
select
  (select email from public.profiles
    where lower(trim(coalesce(role, 'student'))) = 'student' order by email limit 1) as student_email,
  (select email from public.profiles
    where lower(trim(coalesce(role, 'student'))) = 'student' order by email desc limit 1) as other_email,
  (select email from public.profiles
    where lower(trim(coalesce(role, ''))) = 'admin' order by email limit 1)            as admin_email;


-- Pinapatakbo ang isang statement bilang `authenticated` na may pekeng JWT,
-- at itinatala kung ALLOWED o BLOCKED. Nasa pg_temp kaya session-local lang.
create function pg_temp.pia_try(p_label text, p_expect text, p_email text, p_sql text)
returns void
language plpgsql
as $fn$
declare
  v_rows bigint;
begin
  begin
    -- MAHALAGA ang `iat`: idinagdag ng 0009 ang jwt_is_current() sa
    -- profiles_update_self, at ang jwt_is_current() ay naghahambing ng iat
    -- laban sa sessions_revoked_at. Kung walang iat, false ito -- at bawat
    -- student UPDATE ay tahimik na sinasala ng RLS tungo sa 0 row. Ang lumang
    -- harness ay walang iat, kaya "pumapasa" ang mga legit na test sa
    -- pamamagitan ng paggawa ng WALA.
    perform set_config('request.jwt.claims',
      json_build_object('email', p_email, 'role', 'authenticated',
                        'iat', extract(epoch from now())::bigint)::text, true);
    execute 'set local role authenticated';
    execute p_sql;
    get diagnostics v_rows = row_count;
    execute 'reset role';

    -- Ang RLS ay HINDI nagtatapon ng error sa UPDATE -- sinasala lang nito ang
    -- row. Kaya ang 0 row ay ibig sabihin HINARANG, hindi PUMASA.
    if v_rows = 0 then
      insert into pia_verify (label, expect, actual)
      values (p_label, p_expect, 'NO-OP (0 row -- sinala ng RLS)');
    else
      insert into pia_verify (label, expect, actual)
      values (p_label, p_expect, 'ALLOWED (' || v_rows || ' row)');
    end if;

  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    insert into pia_verify (label, expect, actual)
    values (p_label, p_expect, 'BLOCKED -- ' || left(replace(sqlerrm, E'\n', ' '), 110));
  end;
end;
$fn$;


do $$
declare
  s text; o text; a text;
begin
  select student_email, other_email, admin_email into s, o, a from pia_cfg;

  if s is null then
    insert into pia_verify (label, expect, actual)
    values ('SETUP', '-', 'WALANG student profile na nahanap -- hindi matatakbo ang harness.');
    return;
  end if;

  -- Para matestingan ang submit_ocean_results, kailangang hindi pa tapos.
  update public.profiles set is_ocean_done = false where email = s;

  -- ---------- LEHITIMONG STUDENT WRITES (dapat ALLOWED lahat) ----------
  perform pg_temp.pia_try('student: game telemetry', 'ALLOWED', s, format(
    $q$update public.profiles set is_in_game = true, hints_used = 2, current_problem = 3,
        consecutive_correct = 1, current_difficulty = 'Level 2' where email = %L$q$, s));

  perform pg_temp.pia_try('student: selected_character', 'ALLOWED', s, format(
    $q$update public.profiles set selected_character = 'pia-calm' where email = %L$q$, s));

  perform pg_temp.pia_try('student: active_devices', 'ALLOWED', s, format(
    $q$update public.profiles set active_devices = array['test [Windows PC]'] where email = %L$q$, s));

  perform pg_temp.pia_try('student: status=active (activation flow)', 'ALLOWED', s, format(
    $q$update public.profiles set status = 'active' where email = %L$q$, s));

  -- ---------- FORGERY (dapat BLOCKED lahat pagkatapos ng 0001) ----------
  perform pg_temp.pia_try('FORGE: role = admin', 'BLOCKED', s, format(
    $q$update public.profiles set role = 'admin' where email = %L$q$, s));

  perform pg_temp.pia_try('FORGE: ocean_o = 40', 'BLOCKED', s, format(
    $q$update public.profiles set ocean_o = 40 where email = %L$q$, s));

  perform pg_temp.pia_try('FORGE: is_ocean_done = true', 'BLOCKED', s, format(
    $q$update public.profiles set is_ocean_done = true where email = %L$q$, s));

  perform pg_temp.pia_try('FORGE: current_stage (stage bypass)', 'BLOCKED', s, format(
    $q$update public.profiles set current_stage = 'Tutoring Dashboard' where email = %L$q$, s));

  perform pg_temp.pia_try('FORGE: pre_test_score = 100', 'BLOCKED', s, format(
    $q$update public.profiles set pre_test_score = 100 where email = %L$q$, s));

  perform pg_temp.pia_try('FORGE: group_type = control', 'BLOCKED', s, format(
    $q$update public.profiles set group_type = 'control' where email = %L$q$, s));

  if o is not null and o is distinct from s then
    perform pg_temp.pia_try('FORGE: ibang student ang row', 'BLOCKED', s, format(
      $q$update public.profiles set consecutive_correct = 99 where email = %L$q$, o));
  end if;

  perform pg_temp.pia_try('FORGE: gumawa ng bagong profile row', 'BLOCKED', s,
    $q$insert into public.profiles (email, role) values ('pwned@example.com', 'admin')$q$);

  -- PATUNAY, hindi haka-haka: basahin ang halaga ng KABILANG estudyante
  -- pagkatapos ng cross-user update sa itaas. Kung hindi ito 99, talagang
  -- walang naisulat -- anuman ang iulat ng row-count.
  if o is not null and o is distinct from s then
    declare v_val int;
    begin
      select consecutive_correct into v_val from public.profiles where email = o;
      insert into pia_verify (label, expect, actual)
      values ('PATUNAY: hindi nabago ang row ng iba', 'BLOCKED',
              case when coalesce(v_val, 0) = 99
                   then 'ALLOWED (nabago talaga -- TOTOONG BUTAS)'
                   else 'NO-OP (halaga = ' || coalesce(v_val::text, 'null') || ', hindi 99)' end);
    end;
  end if;

  -- ---------- BAGONG RPC (dapat ALLOWED -- ito ang tunay na tanong) ----------
  perform pg_temp.pia_try('RPC: set_student_stage(Waiting Room)', 'ALLOWED', s,
    $q$select public.set_student_stage('Waiting Room')$q$);

  perform pg_temp.pia_try('RPC: submit_ocean_results(50 sagot)', 'ALLOWED', s,
    $q$select public.submit_ocean_results(array_fill(3, array[50]))$q$);

  -- ---------- ADMIN (dapat ALLOWED -- huwag masira ang dashboard) ----------
  if a is not null then
    -- Ang retake ng admin: completion flag + stage lang. Mula 0018, WALA nang
    -- score sa profiles, kaya hindi na ito nagsusulat ng ocean_*.
    perform pg_temp.pia_try('admin: retake OCEAN (flag + stage)', 'ALLOWED', a, format(
      $q$update public.profiles set is_ocean_done = false,
          current_stage = 'OCEAN' where email = %L$q$, s));

    -- 0018: bawal na ang score sa profiles para sa LAHAT, pati admin -- ang
    -- resulta ay nasa ocean_submissions lang (admin-only ang pagbasa).
    perform pg_temp.pia_try('admin: score sa profiles (0018: dapat BLOCKED)', 'BLOCKED', a, format(
      $q$update public.profiles set ocean_o = 21 where email = %L$q$, s));

    perform pg_temp.pia_try('admin: batch scores', 'ALLOWED', a, format(
      $q$update public.profiles set pre_test_score = 55, post_test_score = 77 where email = %L$q$, s));

    perform pg_temp.pia_try('admin: retake character', 'ALLOWED', a, format(
      $q$update public.profiles set selected_character = null,
          current_stage = 'Character Selection' where email = %L$q$, s));

    perform pg_temp.pia_try('RPC: admin_set_stage_open(dash, false)', 'ALLOWED', a,
      $q$select public.admin_set_stage_open('dash', false)$q$);
  else
    insert into pia_verify (label, expect, actual)
    values ('admin tests', '-', 'LAKTAW -- walang admin profile na nahanap');
  end if;
end;
$$;


select seq,
       label,
       expect,
       actual,
       case
         when expect = '-'                                          then '--'
         when expect = 'BLOCKED' and (actual like 'BLOCKED%'
                                   or actual like 'NO-OP%')         then 'OK'
         when expect = 'ALLOWED' and actual like 'ALLOWED%'          then 'OK'
         else '*** FAIL ***'
       end as verdict
  from pia_verify
 order by seq;

rollback;
