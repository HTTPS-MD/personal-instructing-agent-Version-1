-- ============================================================================
-- PIA 0037 -- REGISTRATION RULES THE DATABASE ENFORCES
-- ============================================================================
-- Two rules that used to live only in the admin console's form, and so held
-- only for as long as nobody wrote to the API by another route:
--
--   1. A STUDENT CANNOT BE REGISTERED WITHOUT BOTH PARENTAL CONSENT AND
--      STUDENT ASSENT. The Register dialog already refuses to submit; this
--      refuses the row itself. It applies to NEW student rows only -- accounts
--      registered before 0033 carry "not recorded" (null) and stay as they are.
--
--   2. A STUDENT HAS ONE DEVICE. profiles.max_devices is forced to 1 for
--      students on every insert and update, and set to 1 for the rows that
--      exist. Combined with claim_student_session (0027) -- where the newest
--      sign-in becomes the only active session and every older session and
--      refresh token is deleted -- a second device signing in takes over and
--      the first is signed out. The console no longer offers a device limit
--      for students because there is nothing to choose.
--
-- Staff (admin, teacher) are not affected by either rule.
--
-- Requires 0033 (parental_consent, student_assent).
-- SAFE TO RE-RUN. The postflight rehearses both rules and rolls back.
-- ============================================================================

begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'parental_consent')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'profiles' and column_name = 'student_assent')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'profiles' and column_name = 'max_devices') then
    raise exception 'PIA 0037 ABORT (nothing changed): profiles.parental_consent / student_assent / max_devices is missing -- apply 0033 first.'
      using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.pia_registration_rules()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if lower(trim(coalesce(new.role, 'student'))) = 'student' then
    if tg_op = 'INSERT'
       and (new.parental_consent is not true or new.student_assent is not true) then
      raise exception 'PIA: a student cannot be registered without both parental consent and student assent.'
        using errcode = 'P0001';
    end if;
    new.max_devices := 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pia_registration_rules on public.profiles;
create trigger trg_pia_registration_rules
  before insert or update on public.profiles
  for each row execute function public.pia_registration_rules();

-- Existing students: one device. (The trigger above fires on this update and
-- leaves the consent columns alone, because it is not an insert.)
update public.profiles
   set max_devices = 1
 where lower(trim(coalesce(role, 'student'))) = 'student'
   and max_devices is distinct from 1;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT -- rolled back.
-- ---------------------------------------------------------------------------
do $$
declare
  v_fail text := '';
  v_dev  int;
begin
  begin
    begin
      insert into public.profiles (email, full_name, role, section, parental_consent, student_assent)
      values ('probe-none@pia-0037.test', 'Probe', 'student', 'X', true, false);
      v_fail := v_fail || 'a student with no assent was registered; ';
    exception when sqlstate 'P0001' then null;
    end;

    begin
      insert into public.profiles (email, full_name, role, section, parental_consent, student_assent)
      values ('probe-none2@pia-0037.test', 'Probe', 'student', 'X', null, null);
      v_fail := v_fail || 'a student with no consent was registered; ';
    exception when sqlstate 'P0001' then null;
    end;

    insert into public.profiles (email, full_name, role, section, parental_consent, student_assent, max_devices)
    values ('probe-ok@pia-0037.test', 'Probe', 'student', 'X', true, true, 5);
    select max_devices into v_dev from public.profiles where email = 'probe-ok@pia-0037.test';
    if v_dev is distinct from 1 then v_fail := v_fail || 'max_devices was not forced to 1 on insert (' || coalesce(v_dev::text, 'null') || '); '; end if;

    update public.profiles set max_devices = 4 where email = 'probe-ok@pia-0037.test';
    select max_devices into v_dev from public.profiles where email = 'probe-ok@pia-0037.test';
    if v_dev is distinct from 1 then v_fail := v_fail || 'max_devices was raised by an update; '; end if;

    -- staff are unaffected
    insert into public.profiles (email, full_name, role, max_devices)
    values ('probe-staff@pia-0037.test', 'Probe Teacher', 'teacher', 3);
    select max_devices into v_dev from public.profiles where email = 'probe-staff@pia-0037.test';
    if v_dev is distinct from 3 then v_fail := v_fail || 'a teacher''s device limit was changed; '; end if;

    raise exception 'rehearsal done' using errcode = 'P0002';
  exception
    when sqlstate 'P0002' then
      if v_fail <> '' then
        raise exception 'PIA 0037 ABORT: %', v_fail using errcode = 'P0001';
      end if;
      raise notice 'PIA 0037 OK: a student needs both consent and assent, students have exactly one device, staff are unaffected.';
  end;
end;
$$;

commit;

notify pgrst, 'reload schema';
