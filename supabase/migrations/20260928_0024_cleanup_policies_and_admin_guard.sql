-- ============================================================================
-- PIA 0024 -- ADMIN GUARD, POLICY CLEANUP, AND THE REST OF 0017
-- ============================================================================
-- Written from 0023's report of every policy in production. Three parts.
--
-- 1. ADMIN GUARD. admin_delete_user refuses to remove the caller's own
--    account, or the last administrator. Every admin row is locked first, so
--    two admins removing each other at the same moment are serialised: the
--    second one waits, then sees the first removal and is refused.
--
-- 2. POLICY CLEANUP. Permissive policies are OR-ed, so the broadest one on a
--    table decides. From the report:
--      sections / "Allow public access to sections"   FOR ALL, USING (true)
--          Any signed-in user -- every student -- could insert, rename or
--          delete sections. DROPPED. sections_read_auth (everyone signed in
--          reads) and sections_admin_write (admins write) remain.
--      settings / "Enable read access for all users"  SELECT, USING (true)
--          A second copy of settings_read_all. DROPPED. settings_read_all is
--          narrowed to `authenticated` (anon has no table grants since 0011,
--          so this changes nothing today; it stops the policy relying on that).
--      profiles / profiles_select_self    = profiles_select_own, twice
--      profiles / profiles_select_admin   inside profiles_admin_all
--          Duplicates. DROPPED -- and the postflight checks EVERY account:
--          admins still read every profile, everyone else still reads their
--          own (teachers' section view comes from a policy left untouched).
--
-- 3. THE REST OF 0017. 0017 aborted at its own "pre-existing policies" check
--    (it found the policies listed above), so none of it reached production.
--    With those policies now reviewed, its intent is applied here:
--      * TRUNCATE, REFERENCES and TRIGGER are revoked from signed-in users on
--        every public table, now and for future tables. TRUNCATE ignores RLS
--        entirely; none of the three has a caller in the app.
--      * The research log tables (tutoring_attempts, math_attempt_log,
--        session_start_log, game_sessions, math_attempts) and professors lose
--        INSERT / UPDATE / DELETE for signed-in users: the browser never
--        writes them -- the SECURITY DEFINER functions do, and those do not
--        need the grants. SELECT stays where 0017 kept it (the tutoring
--        summary view reads as the caller; teachers read their faculty row).
--      * sections gets INSERT for signed-in users (and its id sequence) --
--        0017's fix for "Add section" -- with RLS limiting it to admins.
--      * ROW LEVEL SECURITY IS SWITCHED ON for every public table. A policy
--        does nothing while RLS is off, and production's RLS state for the
--        tables created in the dashboard was never visible. Every table the
--        app reads directly (profiles, settings, sections, professors,
--        ocean_submissions) already has the policies it needs -- the
--        postflight proves it for every account. Tables read only through
--        SECURITY DEFINER functions (the answer keys, the logs) need none:
--        those functions bypass RLS as the table owner.
--      * Deliberately NO new "students read their own log rows" policies.
--        AUDIT_answer_key_reachability.sql treats a student reading
--        math_attempt_log as a leak risk, and nothing in the app reads the
--        logs directly. tutoring_attempts already lets a student read their
--        own rows, which is what the tutoring summary view needs; if that
--        view ever returns nothing, the dashboard already falls back to the
--        numbers it has on screen.
--
-- SAFE TO RE-RUN. The postflight, run after everything above, checks every
-- account under the authenticated role and rolls the WHOLE migration back on
-- any failure:
--   * every admin still reads every row of profiles, settings, sections,
--     professors and ocean_submissions;
--   * every student and teacher still reads their own profile, every stage
--     flag and every section; every teacher still reads their faculty row;
--   * an admin can still add a section, and a student cannot;
--   * an admin cannot remove their own account, and the last admin cannot
--     be removed.
-- Every probe is itself rolled back, so no data changes.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Admin guard. The 0021 body, with the new checks before any delete.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_user__inner(target_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_email    text := lower(trim(target_email));
  v_caller   text := lower(auth.jwt() ->> 'email');
  v_is_admin boolean;
  v_admins   int;
  r          record;
begin
  if v_email is null or v_email = '' then
    raise exception 'PIA: an email address is required.' using errcode = '22023';
  end if;

  -- 0024: never the caller's own account. (No JWT -- the SQL editor -- has no
  -- caller, so this check does not apply there; the last-admin one does.)
  if v_caller is not null and v_email = v_caller then
    raise exception 'PIA: you cannot remove your own account. Ask another administrator to do it.';
  end if;

  -- 0024: lock every admin row before counting, so two admins removing each
  -- other at once are serialised -- the second waits for the first, then
  -- sees its removal.
  perform 1 from public.profiles where lower(trim(role)) = 'admin' for update;

  select exists (select 1 from public.profiles
                  where lower(email) = v_email and lower(trim(role)) = 'admin')
    into v_is_admin;

  if v_is_admin then
    select count(*) into v_admins from public.profiles where lower(trim(role)) = 'admin';
    if v_admins <= 1 then
      raise exception 'PIA: % is the last administrator and cannot be removed.', v_email;
    end if;
  end if;

  -- The caller may have been removed by another admin while this waited.
  if v_caller is not null and not exists (
       select 1 from public.profiles where lower(email) = v_caller and lower(trim(role)) = 'admin') then
    raise exception 'PIA: your administrator account no longer exists.' using errcode = '42501';
  end if;

  -- From here on, unchanged from 0021.
  delete from public.hint_consumptions where lower(student_email) = v_email;
  delete from public.problem_serves    where lower(student_email) = v_email;
  delete from public.math_attempt_log  where lower(student_email) = v_email;
  delete from public.tutoring_attempts where lower(student_email) = v_email;
  delete from public.ocean_submissions where lower(email)         = v_email;

  for r in
    select c.relname, a.attname
      from pg_attribute a
      join pg_class c     on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and not a.attisdropped
       and (a.attname in ('student_email', 'user_email', 'participant_email')
            or (c.relname = 'session_start_log' and a.attname = 'email'))
       and c.relname not in ('hint_consumptions', 'problem_serves',
                             'math_attempt_log', 'tutoring_attempts')
  loop
    execute format('delete from public.%I where lower(%I) = $1', r.relname, r.attname)
      using v_email;
  end loop;

  delete from public.profiles where lower(email) = v_email;
  delete from auth.users      where lower(email) = v_email;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 2. Policy cleanup.
-- ---------------------------------------------------------------------------
drop policy if exists "Allow public access to sections"  on public.sections;
drop policy if exists "Enable read access for all users" on public.settings;
drop policy if exists profiles_select_self               on public.profiles;
drop policy if exists profiles_select_admin              on public.profiles;

do $$
begin
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'settings' and policyname = 'settings_read_all') then
    alter policy settings_read_all on public.settings to authenticated;
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. The rest of 0017.
-- ---------------------------------------------------------------------------

-- 3a. No TRUNCATE / REFERENCES / TRIGGER for signed-in users, now or later.
do $$
declare
  r record;
begin
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  loop
    execute format('revoke truncate, references, trigger on public.%I from authenticated, anon', r.relname);
  end loop;
end;
$$;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;

-- 3b. The browser never writes these; their SECURITY DEFINER writers do not
--     need the grants. SELECT stays: the summary view reads as the caller.
do $$
declare
  v_t text;
begin
  foreach v_t in array array['tutoring_attempts', 'math_attempt_log', 'session_start_log',
                             'game_sessions', 'math_attempts', 'professors'] loop
    if to_regclass('public.' || v_t) is not null then
      execute format('revoke insert, update, delete on public.%I from authenticated', v_t);
    end if;
  end loop;

  -- SELECT only where 0017 kept it: the three tables the tutoring views read
  -- as the caller, and professors (the teacher dashboard reads its own row).
  -- RLS decides which rows; nothing new is granted on game_sessions or
  -- math_attempts.
  foreach v_t in array array['tutoring_attempts', 'math_attempt_log', 'session_start_log', 'professors'] loop
    if to_regclass('public.' || v_t) is not null then
      execute format('grant select on public.%I to authenticated', v_t);
    end if;
  end loop;
end;
$$;

-- 3c. "Add section" (admin-dashboard.js) inserts into sections directly.
--     RLS (sections_admin_write) keeps it to admins. A serial id also needs
--     its sequence, so that is granted too -- for this table's sequences only.
grant select, insert on public.sections to authenticated;
do $$
declare
  r record;
begin
  for r in
    select s.oid::regclass::text as seq
      from pg_class s
      join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i')
     where s.relkind = 'S' and d.refobjid = 'public.sections'::regclass
  loop
    execute format('grant usage on sequence %s to authenticated', r.seq);
  end loop;
end;
$$;

-- 3d. RLS on for every public table.
do $$
declare
  r      record;
  v_done text := '';
begin
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', r.relname);
    v_done := v_done || r.relname || ', ';
  end loop;
  raise notice 'PIA 0024: RLS switched on for: %', coalesce(nullif(v_done, ''), 'none (already on everywhere)');
end;
$$;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT -- every account, under the authenticated role.
-- ---------------------------------------------------------------------------
do $$
declare
  t_profiles   int;  t_settings  int;  t_stage int;  t_sections int;
  t_professors int;  t_ocean     int;
  c_own int; c_profiles int; c_settings int; c_stage int; c_sections int;
  c_professors int; c_ocean int; c_fac_self int; v_fac_expected int;
  u         record;
  v_role    text;
  v_fail    text := '';
  v_checked int := 0;
begin
  select count(*) into t_profiles   from public.profiles;
  select count(*) into t_settings   from public.settings;
  select count(*) into t_stage      from public.settings where key like 'stage\_%';
  select count(*) into t_sections   from public.sections;
  select count(*) into t_professors from public.professors;
  select count(*) into t_ocean      from public.ocean_submissions;

  for u in select email, lower(trim(coalesce(role, 'student'))) as role
             from public.profiles where email is not null order by email loop
    select count(*) into v_fac_expected from public.professors where lower(email) = lower(u.email);

    perform set_config('request.jwt.claims',
      json_build_object('email', u.email, 'role', 'authenticated',
                        'iat', extract(epoch from clock_timestamp())::bigint + 1)::text, true);
    execute 'set local role authenticated';
    select count(*) into c_own        from public.profiles where email = u.email;
    select count(*) into c_profiles   from public.profiles;
    select count(*) into c_settings   from public.settings;
    select count(*) into c_stage      from public.settings where key like 'stage\_%';
    select count(*) into c_sections   from public.sections;
    select count(*) into c_professors from public.professors;
    select count(*) into c_fac_self   from public.professors where lower(email) = lower(u.email);
    select count(*) into c_ocean      from public.ocean_submissions;
    execute 'reset role';
    v_checked := v_checked + 1;

    if u.role = 'admin' then
      if c_profiles <> t_profiles or c_settings <> t_settings or c_sections <> t_sections
         or c_professors <> t_professors or c_ocean <> t_ocean then
        v_fail := v_fail || format('admin %s sees profiles %s/%s, settings %s/%s, sections %s/%s, professors %s/%s, results %s/%s; ',
          u.email, c_profiles, t_profiles, c_settings, t_settings, c_sections, t_sections,
          c_professors, t_professors, c_ocean, t_ocean);
      end if;
    else
      if c_own < 1 then
        v_fail := v_fail || format('%s %s cannot read their own profile; ', u.role, u.email);
      end if;
      if c_stage <> t_stage then
        v_fail := v_fail || format('%s %s sees %s of %s stage flags; ', u.role, u.email, c_stage, t_stage);
      end if;
      if c_sections <> t_sections then
        v_fail := v_fail || format('%s %s sees %s of %s sections; ', u.role, u.email, c_sections, t_sections);
      end if;
      if u.role = 'teacher' and c_fac_self < v_fac_expected then
        v_fail := v_fail || format('teacher %s cannot read their faculty row; ', u.email);
      end if;
    end if;
  end loop;

  perform set_config('request.jwt.claims', '', true);

  if v_fail <> '' then
    raise exception 'PIA 0024 ABORT (nothing changed): %', v_fail using errcode = 'P0001';
  end if;
  raise notice 'PIA 0024 OK: all % accounts keep their access.', v_checked;
end;
$$;

-- Writes and the admin guard.
do $$
declare
  v_admin   text;
  v_student text;
  v_rows    int;
begin
  select email into v_admin from public.profiles
   where lower(trim(role)) = 'admin' order by email limit 1;
  select email into v_student from public.profiles
   where lower(trim(coalesce(role, 'student'))) = 'student' order by email limit 1;

  -- (a) An admin can add a section.
  if v_admin is not null then
    begin
      perform set_config('request.jwt.claims',
        json_build_object('email', v_admin, 'role', 'authenticated',
                          'iat', extract(epoch from clock_timestamp())::bigint + 1)::text, true);
      execute 'set local role authenticated';
      insert into public.sections (name) values ('pia-0024-probe');
      execute 'reset role';
      raise exception 'probe done' using errcode = 'P0002';
    exception
      when sqlstate 'P0002' then
        raise notice 'PIA 0024 OK: an admin can add a section.';
      when others then
        raise exception 'PIA 0024 ABORT: an admin can no longer add a section (%). Rolling back.', sqlerrm
          using errcode = 'P0001';
    end;
  end if;

  -- (b) A student cannot.
  if v_student is not null then
    begin
      perform set_config('request.jwt.claims',
        json_build_object('email', v_student, 'role', 'authenticated',
                          'iat', extract(epoch from clock_timestamp())::bigint + 1)::text, true);
      execute 'set local role authenticated';
      insert into public.sections (name) values ('pia-0024-probe');
      get diagnostics v_rows = row_count;
      execute 'reset role';
      raise exception 'PIA 0024 ABORT: a student could add a section. Rolling back.' using errcode = 'P0001';
    exception
      when insufficient_privilege then
        raise notice 'PIA 0024 OK: a student cannot add a section.';
    end;
  end if;

  -- (c) An admin cannot remove their own account.
  if v_admin is not null then
    begin
      perform set_config('request.jwt.claims',
        json_build_object('email', v_admin, 'role', 'authenticated',
                          'iat', extract(epoch from clock_timestamp())::bigint + 1)::text, true);
      execute 'set local role authenticated';
      perform public.admin_delete_user(v_admin);
      execute 'reset role';
      raise exception 'PIA 0024 ABORT: an admin removed their own account. Rolling back.' using errcode = 'P0001';
    exception
      when others then
        if sqlerrm not like '%cannot remove your own account%' then raise; end if;
        raise notice 'PIA 0024 OK: an admin cannot remove their own account.';
    end;

    -- (d) The last admin cannot be removed. Every other admin is demoted
    --     inside this probe so v_admin is the last one; all of it rolls back.
    perform set_config('request.jwt.claims', '', true);
    begin
      update public.profiles set role = 'teacher'
       where lower(trim(role)) = 'admin' and email <> v_admin;
      begin
        perform public.admin_delete_user__inner(v_admin);
        raise exception 'PIA 0024 ABORT: removing the only remaining admin was allowed. Rolling back.'
          using errcode = 'P0001';
      exception
        when others then
          -- Match the guard's own wording exactly, so this ABORT above can
          -- never be mistaken for the guard firing.
          if sqlerrm not like '%is the last administrator and cannot be removed%' then raise; end if;
          raise notice 'PIA 0024 OK: the last administrator cannot be removed.';
      end;
      raise exception 'probe done' using errcode = 'P0002';
    exception
      when sqlstate 'P0002' then null;
    end;
  end if;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Report -- every public table (RLS state and who may touch it), every
-- policy, every function a signed-in user can call. Anything still open is
-- listed first, marked REVIEW.
with items as (
  select 'table' as kind,
         c.relname::text as name,
         case when not c.relrowsecurity then '*** REVIEW: RLS off ***' else 'RLS on' end as guard,
         'policies: ' || (select count(*) from pg_policy p where p.polrelid = c.oid)
           || '; authenticated: ' || coalesce((select string_agg(privilege_type, ',' order by privilege_type)
                                                 from information_schema.role_table_grants g
                                                where g.table_schema = 'public' and g.table_name = c.relname
                                                  and g.grantee = 'authenticated'), 'none')
           || '; anon: ' || coalesce((select string_agg(privilege_type, ',' order by privilege_type)
                                        from information_schema.role_table_grants g
                                       where g.table_schema = 'public' and g.table_name = c.relname
                                         and g.grantee = 'anon'), 'none') as definition
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
  union all
  select 'policy',
         tablename || ' / ' || policyname,
         case when permissive = 'RESTRICTIVE' then 'restrictive (narrows only)'
              when coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ '(jwt_is_current|pia_caller_role)'
                   then 'revocation-aware'
              when coalesce(qual, 'false') = 'false' and coalesce(with_check, 'false') = 'false'
                   then 'denies everything'
              else '*** REVIEW: not revocation-aware ***' end,
         cmd || ' to ' || array_to_string(roles, ',')
             || coalesce(' USING ' || qual, '')
             || coalesce(' CHECK ' || with_check, '')
    from pg_policies
   where schemaname = 'public'
  union all
  select 'function',
         p.oid::regprocedure::text,
         case when pg_get_functiondef(p.oid) ~ 'jwt_is_current'  then 'revocation check'
              when pg_get_functiondef(p.oid) ~ 'pia_caller_role' then 'admin guard (via pia_caller_role)'
              when p.proname = 'release_device' then 'unguarded by design (frees the caller''s own slot)'
              when p.proname in ('pia_stage_open', 'pia_can_enter_stage', 'pia_session_state',
                                 'pia_replay_decision_tree', 'current_email', 'current_role_name',
                                 'current_user_role', 'current_user_section', 'is_admin', 'is_teacher')
                   then 'read-only helper, by design'
              else '*** REVIEW: no check ***' end,
         null
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.prosecdef
     and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')
)
select kind, name, guard, definition
  from items
 order by guard like '***%' desc, kind, name;
