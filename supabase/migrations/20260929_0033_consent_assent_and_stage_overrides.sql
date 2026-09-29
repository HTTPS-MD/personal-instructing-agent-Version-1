-- ============================================================================
-- PIA 0033 -- CONSENT AND ASSENT, AN UNCAPPED PRE-TEST, VISIBLE SECTION OVERRIDES
-- ============================================================================
-- Three changes behind the admin console's research workflow:
--
--   1. CONSENT AND ASSENT ARE STORED. The Register dialog has always asked
--      for "Parental consent received", but only as a gate on the button --
--      nothing was saved. profiles gains two columns:
--
--        parental_consent  boolean   null = not recorded (registered before 0033)
--        student_assent    boolean   false = not received yet, true = received
--
--      Existing rows stay NULL ("not recorded"). Every student registered
--      through the console had to tick the parental-consent box, but this
--      migration does not claim consent on anyone's behalf -- only the signed
--      forms can. Once you have checked them, the backfill is one line:
--
--        update public.profiles set parental_consent = true
--         where parental_consent is null
--           and lower(trim(coalesce(role, 'student'))) = 'student';
--
--      Only an administrator can write either column: the profile write
--      guard (0001) is a whitelist, so a student's attempt to set their own
--      is refused like any other protected column. Neither is exposed on the
--      teacher surface, which reads profiles only through its own functions.
--
--   2. THE PRE-TEST HAS NO UPPER LIMIT, AND IS NEVER REQUIRED AT REGISTRATION.
--      Registration is admin_create_auth_user (email + temporary password)
--      followed by a plain profiles insert; neither needs a score, and the
--      console no longer sends one. This section makes sure the database
--      agrees: pre_test_score is nullable, any CHECK constraint on it is
--      replaced by "not negative", and a numeric(p,s) column is widened to
--      plain numeric so a large score cannot overflow. post_test_score is not
--      touched.
--
--   3. SECTION OVERRIDES ARE RECORDED. admin_grant_stage(p_stage, p_emails,
--      p_section) moves the eligible students of a section into a closed
--      stage, one row at a time, and keeps no record that it was a section
--      grant -- so the Stage Controls card could not say which sections it
--      had opened. stage_overrides keeps that record:
--
--        * admin_grant_stage writes a row when a section grant lets at least
--          one student in (the call is unchanged; the recording is added to
--          its existing wrapper, inside the same transaction);
--        * any write of the stage's settings row -- opening or closing it for
--          everyone through admin_set_stage_open -- clears that stage's rows.
--          Closing evicts every student in the stage, so the grants are gone;
--          opening makes them moot.
--
--      Administrators can read the table; nobody can write it through the API.
--      Individually granted students are not recorded here: the console
--      counts them live from each student's current stage.
--
-- SAFE TO RE-RUN. The postflight rehearses every rule as a real administrator
-- and a real student under RLS, and rolls everything back.
--
-- Requires 0011 (the admin_grant_stage wrapper), 0022/0030 (jwt_is_current).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- PREFLIGHT -- admin_grant_stage must be the wrapper this migration expects.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count int;
  v_args  text;
  v_ret   text;
begin
  if to_regprocedure('public.pia_caller_role()') is null or to_regprocedure('public.jwt_is_current()') is null then
    raise exception 'PIA 0033 ABORT (nothing changed): pia_caller_role() / jwt_is_current() are missing.'
      using errcode = 'P0001';
  end if;

  if to_regclass('public.settings') is null then
    raise exception 'PIA 0033 ABORT (nothing changed): public.settings is missing.' using errcode = 'P0001';
  end if;

  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_grant_stage';

  if v_count <> 1 then
    raise exception 'PIA 0033 ABORT (nothing changed): expected one public.admin_grant_stage, found %.', v_count
      using errcode = 'P0001';
  end if;

  select pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid)
    into v_args, v_ret
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_grant_stage';

  if v_args !~ '(^|, )p_stage text(,|$)'
     or v_args !~ '(^|, )p_emails text\[\](,|$)'
     or v_args !~ '(^|, )p_section text(,|$)'
     or array_length(string_to_array(v_args, ', '), 1) <> 3 then
    raise exception 'PIA 0033 ABORT (nothing changed): admin_grant_stage(%) is not (p_stage text, p_emails text[], p_section text).', v_args
      using errcode = 'P0001';
  end if;

  if v_ret not in ('json', 'jsonb') then
    raise exception 'PIA 0033 ABORT (nothing changed): admin_grant_stage returns %, expected json or jsonb.', v_ret
      using errcode = 'P0001';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 1. Consent and assent
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists parental_consent boolean;
alter table public.profiles add column if not exists student_assent boolean;

comment on column public.profiles.parental_consent is
  'Parental consent form received (0033). null = not recorded, false = not received, true = received. Admin-written.';
comment on column public.profiles.student_assent is
  'Student assent received (0033). null = not recorded, false = not received, true = received. Admin-written.';


-- ---------------------------------------------------------------------------
-- 2. pre_test_score: optional, not negative, no upper limit
-- ---------------------------------------------------------------------------
do $$
declare
  r      record;
  v_type text;
begin
  select format_type(a.atttypid, a.atttypmod) into v_type
    from pg_attribute a
   where a.attrelid = 'public.profiles'::regclass and a.attname = 'pre_test_score' and not a.attisdropped;

  if v_type is null then
    raise exception 'PIA 0033 ABORT (nothing changed): profiles.pre_test_score is missing.' using errcode = 'P0001';
  end if;

  alter table public.profiles alter column pre_test_score drop not null;

  for r in
    select c.conname, pg_get_constraintdef(c.oid) as def
      from pg_constraint c
     where c.conrelid = 'public.profiles'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ~ 'pre_test_score'
  loop
    if r.def ~ 'post_test_score' then
      raise exception 'PIA 0033 ABORT (nothing changed): constraint % also covers post_test_score (%). Split it by hand first.',
        r.conname, r.def using errcode = 'P0001';
    end if;
    execute format('alter table public.profiles drop constraint %I', r.conname);
    raise notice 'PIA 0033: dropped % -- %', r.conname, r.def;
  end loop;

  -- numeric(5,2) would still stop at 999.99; plain numeric has no ceiling.
  if v_type like 'numeric(%' then
    begin
      alter table public.profiles alter column pre_test_score type numeric;
      raise notice 'PIA 0033: pre_test_score widened from % to numeric.', v_type;
    exception when others then
      raise exception 'PIA 0033 ABORT (nothing changed): could not widen pre_test_score from % (%).', v_type, sqlerrm
        using errcode = 'P0001';
    end;
  elsif v_type not in ('numeric', 'real', 'double precision') then
    raise notice 'PIA 0033: pre_test_score is %, left as is (no upper limit to remove).', v_type;
  end if;

  if v_type !~ '^(numeric|real|double precision|integer|smallint|bigint)' then
    raise notice 'PIA 0033: pre_test_score is not a number column (%); the not-negative rule was not added.', v_type;
  elsif exists (select 1 from public.profiles where pre_test_score < 0) then
    raise notice 'PIA 0033: some pre_test_score values are negative; the not-negative rule was not added.';
  else
    alter table public.profiles
      add constraint profiles_pre_test_score_not_negative check (pre_test_score >= 0);
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. Section overrides
-- ---------------------------------------------------------------------------
create table if not exists public.stage_overrides (
  id            bigint generated always as identity primary key,
  stage         text not null check (stage in ('ocean', 'char', 'dash')),
  section       text not null,
  granted_count int  not null default 0,   -- students the last grant let in
  granted_by    text,                      -- null = the project owner
  granted_at    timestamptz not null default now(),
  unique (stage, section)
);

alter table public.stage_overrides enable row level security;
revoke all on public.stage_overrides from public, anon, authenticated;
grant select on public.stage_overrides to authenticated;

drop policy if exists stage_overrides_admin_read on public.stage_overrides;
create policy stage_overrides_admin_read on public.stage_overrides
  for select to authenticated
  using (public.pia_caller_role() = 'admin' and public.jwt_is_current());

comment on table public.stage_overrides is
  'Sections opened into a closed stage by admin_grant_stage (0033). Cleared when the stage is opened or closed for everyone.';


-- Called by admin_grant_stage with its own result, which it returns unchanged.
create or replace function public.pia_record_stage_grant(
  p_stage text, p_section text, p_emails text[], p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_section text := nullif(trim(coalesce(p_section, '')), '');
  v_granted int;
begin
  if v_section is null or p_stage is null or p_result is null then
    return p_result;
  end if;

  v_granted := case when jsonb_typeof(p_result -> 'granted') = 'array'
                    then jsonb_array_length(p_result -> 'granted') else 0 end;

  -- Nobody let in = no override to show. An earlier grant for the section,
  -- if any, is left as it was.
  if v_granted > 0 then
    insert into public.stage_overrides (stage, section, granted_count, granted_by, granted_at)
    values (p_stage, v_section, v_granted, lower(nullif(auth.jwt() ->> 'email', '')), now())
    on conflict (stage, section) do update
      set granted_count = excluded.granted_count,
          granted_by    = excluded.granted_by,
          granted_at    = excluded.granted_at;
  end if;

  return p_result;
end;
$$;

revoke all on function public.pia_record_stage_grant(text, text, text[], jsonb) from public, anon, authenticated;


-- admin_grant_stage is 0011's wrapper around admin_grant_stage__inner. Its
-- one call to the inner function becomes a call through the recorder; the
-- guard in front of it and everything else stay exactly as the database has
-- them.
do $$
declare
  v_oid     oid;
  v_ret     text;
  v_def     text;
  v_new     text;
  v_hits    int;
  v_pattern text := 'return\s+public\.admin_grant_stage__inner\s*\(([^;]*)\)\s*;';
begin
  select p.oid, pg_get_function_result(p.oid) into v_oid, v_ret
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_grant_stage';

  v_def := pg_get_functiondef(v_oid);

  if v_def ~ 'pia_record_stage_grant' then
    raise notice 'PIA 0033: admin_grant_stage already records section grants -- left as is.';
    return;
  end if;

  select count(*) into v_hits from regexp_matches(v_def, v_pattern, 'gi');
  if v_hits <> 1 then
    raise exception 'PIA 0033 ABORT (nothing changed): admin_grant_stage does not end in one "return public.admin_grant_stage__inner(...)" (found %). Send the output of: select pg_get_functiondef(''public.admin_grant_stage''::regproc);', v_hits
      using errcode = 'P0001';
  end if;

  v_new := regexp_replace(v_def, v_pattern,
    'return (public.pia_record_stage_grant(p_stage, p_section, p_emails, (public.admin_grant_stage__inner(\1))::jsonb))::'
      || v_ret || ';',
    'i');

  execute v_new;
  raise notice 'PIA 0033: admin_grant_stage now records section grants.';
end;
$$;


-- Opening or closing a stage for everyone ends its section overrides.
create or replace function public.pia_clear_stage_overrides()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.key like 'stage\_%' then
    delete from public.stage_overrides where stage = substr(new.key, 7);
  end if;
  return null;
end;
$$;

revoke all on function public.pia_clear_stage_overrides() from public, anon, authenticated;

drop trigger if exists trg_clear_stage_overrides on public.settings;
create trigger trg_clear_stage_overrides
  after insert or update on public.settings
  for each row execute function public.pia_clear_stage_overrides();


-- ---------------------------------------------------------------------------
-- POSTFLIGHT -- rolled back.
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin   text;
  v_student text;
  v_ret     text;
  v_iat     bigint := extract(epoch from clock_timestamp())::bigint + 5;
  v_open    boolean;
  v_n       int;
  v_val     text;
  v_fail    text := '';
begin
  select email into v_admin from public.profiles where lower(trim(role)) = 'admin' order by email limit 1;
  select email into v_student from public.profiles
   where lower(trim(coalesce(role, 'student'))) = 'student' order by email limit 1;
  select pg_get_function_result(p.oid) into v_ret
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_grant_stage';

  if v_admin is null then
    raise notice 'PIA 0033: no administrator to rehearse with -- skipped.';
    return;
  end if;

  begin
    perform set_config('request.jwt.claims', '', true);

    -- A. The recorder, fed the way the wrapper feeds it.
    execute format(
      'select (public.pia_record_stage_grant($1, $2, null, ($3::%s)::jsonb))::%s', v_ret, v_ret)
      using 'dash'::text, 'PIA-0033-probe'::text, '{"granted":["a@probe.test","b@probe.test"],"skipped":[]}'::text;
    perform public.pia_record_stage_grant('dash', 'PIA-0033-empty', null,
      '{"granted":[],"skipped":[{"email":"c@probe.test","reason":"probe"}]}'::jsonb);
    perform public.pia_record_stage_grant('char', 'PIA-0033-probe', null, '{"granted":["a@probe.test"]}'::jsonb);

    select granted_count into v_n from public.stage_overrides where stage = 'dash' and section = 'PIA-0033-probe';
    if coalesce(v_n, 0) <> 2 then
      v_fail := v_fail || 'a section grant was not recorded with its count; ';
    end if;
    if exists (select 1 from public.stage_overrides where section = 'PIA-0033-empty') then
      v_fail := v_fail || 'a grant that let nobody in was recorded; ';
    end if;

    -- B. The wrapper calls the recorder, and still runs as a whole.
    if pg_get_functiondef('public.admin_grant_stage'::regproc) !~ 'pia_record_stage_grant' then
      v_fail := v_fail || 'admin_grant_stage does not call the recorder; ';
    end if;

    perform set_config('request.jwt.claims', json_build_object(
      'email', v_admin, 'role', 'authenticated', 'iat', v_iat)::text, true);
    execute 'set local role authenticated';

    begin
      perform public.admin_grant_stage('dash', null, 'PIA-0033-no-such-section');
    exception when others then
      if sqlstate in ('42883', '42804', '42P13', '22P02', '42601') or sqlerrm ~* 'pia_record_stage_grant' then
        v_fail := v_fail || 'admin_grant_stage failed through the recorder (' || sqlerrm || '); ';
      else
        raise notice 'PIA 0033: the rehearsal grant was refused by admin_grant_stage itself (%); the recorder was tested directly.', sqlerrm;
      end if;
    end;

    -- C. An administrator reads the overrides and writes consent and assent.
    --    (No pre-test here: since 0034 a score is only written through its raw
    --    score, and 0034 rehearses that itself -- so this file stays safe to
    --    re-run after 0034.)
    select count(*) into v_n from public.stage_overrides where section = 'PIA-0033-probe';
    if v_n <> 2 then
      v_fail := v_fail || 'an administrator cannot read the overrides; ';
    end if;

    if v_student is not null then
      update public.profiles
         set parental_consent = true, student_assent = false
       where email = v_student;
      get diagnostics v_n = row_count;
      if v_n <> 1 then
        v_fail := v_fail || 'an administrator could not record consent and assent; ';
      end if;
    end if;

    -- D. Closing or opening a stage for everyone clears only that stage.
    --    Called with its current value, so nothing flips.
    select coalesce(bool_or(value::text in ('true', '"true"')), false) into v_open
      from public.settings where key = 'stage_dash';
    perform public.admin_set_stage_open('dash', v_open);

    execute 'reset role';

    if exists (select 1 from public.stage_overrides where stage = 'dash') then
      v_fail := v_fail || 'admin_set_stage_open did not clear the stage''s overrides; ';
    end if;
    if not exists (select 1 from public.stage_overrides where stage = 'char' and section = 'PIA-0033-probe') then
      v_fail := v_fail || 'admin_set_stage_open cleared another stage''s overrides; ';
    end if;

    -- E. A student sees no overrides and cannot record their own assent.
    if v_student is not null then
      perform set_config('request.jwt.claims', json_build_object(
        'email', v_student, 'role', 'authenticated', 'iat', v_iat)::text, true);
      execute 'set local role authenticated';

      select count(*) into v_n from public.stage_overrides;
      if v_n <> 0 then
        v_fail := v_fail || 'a student can read the overrides; ';
      end if;

      begin
        update public.profiles set student_assent = true where email = v_student;
      exception when sqlstate '42501' then
        null;   -- refused by the write guard, as it should be
      end;

      execute 'reset role';
      perform set_config('request.jwt.claims', '', true);

      select student_assent::text into v_val from public.profiles where email = v_student;
      if v_val is distinct from 'false' then
        v_fail := v_fail || 'a student changed their own assent; ';
      end if;
    else
      raise notice 'PIA 0033: no student to rehearse with -- the student checks are skipped.';
    end if;

    if v_fail <> '' then
      raise exception 'PIA 0033 ABORT: %', v_fail using errcode = 'P0001';
    end if;
    raise exception 'rehearsal done' using errcode = 'P0002';
  exception
    when sqlstate 'P0002' then
      raise notice 'PIA 0033 OK: consent and assent are admin-only columns; the pre-test has no upper limit; section grants are recorded, readable by admins only, and cleared when the stage is opened or closed.';
  end;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';
