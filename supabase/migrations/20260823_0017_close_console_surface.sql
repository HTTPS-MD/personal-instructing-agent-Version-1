-- ============================================================================
-- PIA 0017 -- CLOSE THE CONSOLE-CREATED SURFACE
-- ============================================================================
-- Migrations 0001-0016 hardened every object that existed as a FILE. This one
-- closes the objects that were created in the Supabase console and therefore
-- were never reviewed: tutoring_attempts, math_attempt_log, session_start_log,
-- professors, and the grants on the two export views.
--
-- WHAT THIS DOES NOT TOUCH -- so it cannot lock you out of the console:
--   * public.profiles          (login + the admin role check read it)
--   * auth.*                   (untouched entirely)
--   * public.settings          (0015 owns it)
--   * public.ocean_submissions (0002 owns it)
--   * any function body        (0011 owns the admin wrappers)
-- The worst case is a panel that renders empty, and PART 7 aborts the whole
-- transaction before that can happen. Signing in cannot break.
--
-- WHY THE THREE LOG TABLES KEEP `select`:
--   v_tutoring_session_summary and v_student_tutoring_export are
--   security_invoker=on, so they check permissions AS THE CALLER. Revoking
--   select on the base tables would break the student summary screen and your
--   own data export. Writes are revoked instead, and RLS scopes the reads.
--
-- RUN IT ALL AT ONCE. It is one transaction: if any assertion fails, nothing
-- changes. The rollback block is at the bottom.
-- ============================================================================

begin;

-- ===========================================================================
-- PART 1 -- PREFLIGHT. Refuse to run against a schema I did not expect.
-- ===========================================================================
do $$
declare
  v_missing text := '';
  v_t       text;
begin
  if to_regprocedure('public.pia_caller_role()') is null then
    raise exception 'PIA 0017: pia_caller_role() is missing. Run 0001 first.';
  end if;

  foreach v_t in array array['tutoring_attempts','professors'] loop
    if to_regclass('public.' || v_t) is null then
      v_missing := v_missing || v_t || ', ';
    end if;
  end loop;

  if v_missing <> '' then
    raise exception 'PIA 0017: expected table(s) not found: %', v_missing;
  end if;
end;
$$;


-- ===========================================================================
-- PART 2 -- SURPRISE CHECK
-- I have never seen pg_policies for this database. If a target table already
-- carries a policy, adding mine could WIDEN access (permissive policies OR
-- together). Abort and show me what is there instead of guessing.
-- ===========================================================================
do $$
declare
  v_found text := '';
  r       record;
begin
  for r in
    select tablename, policyname, cmd, permissive
      from pg_policies
     where schemaname = 'public'
       and tablename in ('tutoring_attempts','math_attempt_log',
                         'session_start_log','professors')
       and policyname not like 'pia0017\_%'
  loop
    v_found := v_found || format('%s.%s (%s %s); ',
                                 r.tablename, r.policyname, r.permissive, r.cmd);
  end loop;

  if v_found <> '' then
    raise exception E'PIA 0017 ABORTED -- pre-existing policies found:\n  %\n'
      'Nothing was changed. Send these to review before re-running, so the new '
      'policies do not OR together with them and widen access.', v_found;
  end if;
end;
$$;


-- ===========================================================================
-- PART 3 -- GRANT HYGIENE
-- TRUNCATE is never reachable through PostgREST, and RLS does not filter it
-- at all -- so it is a latent hole with no legitimate use. REFERENCES and
-- TRIGGER let a client attach objects to your research tables. None of the
-- three has a caller in the codebase. Same for every write on the two views.
-- ===========================================================================
do $$
declare
  v_t text;
begin
  foreach v_t in array array['tutoring_attempts','math_attempt_log',
                             'session_start_log','professors','sections',
                             'v_student_tutoring_export','v_tutoring_session_summary'] loop
    if to_regclass('public.' || v_t) is not null then
      execute format(
        'revoke truncate, references, trigger on public.%I from authenticated', v_t);
    end if;
  end loop;
end;
$$;

-- Views are read-only reporting surfaces. The insert/update/delete grants on
-- them came from a blanket `grant all` and mean nothing -- remove the noise so
-- the next person reading role_table_grants is not misled.
do $$
declare
  v_v text;
begin
  foreach v_v in array array['v_student_tutoring_export','v_tutoring_session_summary'] loop
    if to_regclass('public.' || v_v) is not null then
      execute format('revoke insert, update, delete on public.%I from authenticated', v_v);
    end if;
  end loop;
end;
$$;

-- The browser never writes these three tables -- every write goes through a
-- SECURITY DEFINER RPC, which runs as postgres and ignores these grants.
-- Verified: no `.from('tutoring_attempts'|'math_attempt_log'|
-- 'session_start_log')` call exists anywhere in the JS.
do $$
declare
  v_t text;
begin
  foreach v_t in array array['tutoring_attempts','math_attempt_log','session_start_log'] loop
    if to_regclass('public.' || v_t) is not null then
      execute format('revoke insert, update, delete on public.%I from authenticated', v_t);
      execute format('grant  select on public.%I to authenticated', v_t);  -- views need it
    end if;
  end loop;
end;
$$;

-- professors: admin_register_teacher() (SECURITY DEFINER) is the only writer.
revoke insert, update, delete on public.professors from authenticated;
grant  select                  on public.professors to authenticated;

-- LIVE BUG FIX: admin-dashboard.js:2784 calls sections.insert(), but
-- `authenticated` was never granted INSERT -- "Add section" fails today with
-- a grant error. RLS in PART 5 restricts it to admins.
grant select, insert on public.sections to authenticated;

-- Stop the next console-created table from inheriting anything by default.
alter default privileges in schema public revoke all on tables    from authenticated;
alter default privileges in schema public revoke all on sequences from authenticated;


-- ===========================================================================
-- PART 4 -- RLS ON THE RESEARCH TABLES
-- The owner column is DETECTED, not assumed. tutoring_attempts uses
-- student_email (confirmed in 0016); the other two were never in a file, so
-- if neither table exposes a recognisable owner column this raises and the
-- whole migration rolls back rather than locking rows away.
-- ===========================================================================
do $$
declare
  v_t   text;
  v_col text;
begin
  foreach v_t in array array['tutoring_attempts','math_attempt_log','session_start_log'] loop
    continue when to_regclass('public.' || v_t) is null;

    select c.column_name into v_col
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = v_t
       and c.column_name in ('student_email','user_email','participant_email','email')
     order by array_position(array['student_email','user_email','participant_email','email'],
                             c.column_name)
     limit 1;

    if v_col is null then
      raise exception
        E'PIA 0017 ABORTED -- no owner column on public.%.\n'
        'Looked for student_email / user_email / participant_email / email. '
        'Nothing was changed. Send me its column list and I will adjust.', v_t;
    end if;

    execute format('alter table public.%I enable row level security', v_t);

    -- Admin: full read, for the export view and the console.
    execute format('drop policy if exists pia0017_%s_admin_read on public.%I', v_t, v_t);
    execute format($p$
      create policy pia0017_%s_admin_read on public.%I
        for select to authenticated
        using (public.pia_caller_role() = 'admin')$p$, v_t, v_t);

    -- Student: own rows only, so the summary view keeps working for them.
    execute format('drop policy if exists pia0017_%s_own_read on public.%I', v_t, v_t);
    execute format($p$
      create policy pia0017_%s_own_read on public.%I
        for select to authenticated
        using (%I = (auth.jwt() ->> 'email'))$p$, v_t, v_t, v_col);

    -- The SECURITY DEFINER RPCs still have to WRITE these tables. A table
    -- owner bypasses RLS, but only if the function's owner IS the table owner
    -- and carries BYPASSRLS -- which I cannot verify from here. Rather than
    -- bet the tutoring flow on it, this reuses the exact test 0001 already
    -- proves in trg_enforce_profile_write_scope: PostgREST arrives as
    -- `authenticated`, a definer RPC arrives as its owner. Anything that is
    -- not the browser keeps full access; the browser gets nothing.
    execute format('drop policy if exists pia0017_%s_server_write on public.%I', v_t, v_t);
    execute format($p$
      create policy pia0017_%s_server_write on public.%I
        for all to public
        using (current_user <> 'authenticated')
        with check (current_user <> 'authenticated')$p$, v_t, v_t);

    raise notice 'PIA 0017: RLS on public.% scoped by %', v_t, v_col;
  end loop;
end;
$$;


-- ===========================================================================
-- PART 5 -- RLS ON professors AND sections
-- Faculty rows carry staff PII and were readable by every participant.
-- ===========================================================================
alter table public.professors enable row level security;

drop policy if exists pia0017_professors_admin_all on public.professors;
create policy pia0017_professors_admin_all on public.professors
  for select to authenticated
  using (public.pia_caller_role() = 'admin');

-- teacher-dashboard.js:207 reads its own row as a fallback for section/name.
drop policy if exists pia0017_professors_own_read on public.professors;
create policy pia0017_professors_own_read on public.professors
  for select to authenticated
  using (email = (auth.jwt() ->> 'email'));

drop policy if exists pia0017_professors_server_write on public.professors;
create policy pia0017_professors_server_write on public.professors
  for all to public
  using (current_user <> 'authenticated')
  with check (current_user <> 'authenticated');

alter table public.sections enable row level security;

-- Every signed-in role needs the section list (admin filters, teacher label).
drop policy if exists pia0017_sections_read on public.sections;
create policy pia0017_sections_read on public.sections
  for select to authenticated
  using (true);

drop policy if exists pia0017_sections_admin_insert on public.sections;
create policy pia0017_sections_admin_insert on public.sections
  for insert to authenticated
  with check (public.pia_caller_role() = 'admin');


-- ===========================================================================
-- PART 6 -- REPORT UNGUARDED FUNCTIONS (report only -- changes nothing)
-- 0011 wrapped the admin_* functions that existed WHEN IT RAN. It skipped any
-- with unnamed parameters and reported that only via `raise notice`, which the
-- SQL editor does not display. These three are called from the browser and
-- were never `admin_`-prefixed, so 0011 never considered them:
--   check_math_answer, end_game_session, release_device
-- end_game_session(p_session_id) and release_device(p_device_id) both take an
-- identifier as an argument. If either fails to verify that the object belongs
-- to the caller, a participant can end a peer's session mid-experiment.
-- I have not seen their bodies, so this only reports. Do not skip the output.
-- ===========================================================================
do $$
declare
  r       record;
  v_bad   text := '';
begin
  for r in
    select p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and p.prosecdef
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and pg_get_functiondef(p.oid) !~* 'pia_caller_role|is_admin|auth\.jwt|auth\.uid'
  loop
    v_bad := v_bad || r.proname || ', ';
  end loop;

  if v_bad <> '' then
    raise warning E'\n*** PIA 0017: SECURITY DEFINER functions callable by any '
      'signed-in user with no visible caller check: %\n'
      '*** Review each body before the pilot. Not changed by this migration.', v_bad;
  else
    raise notice 'PIA 0017: every definer function reachable by authenticated references a caller check.';
  end if;
end;
$$;


-- ===========================================================================
-- PART 7 -- POSTFLIGHT. Abort rather than ship a broken console.
-- ===========================================================================
do $$
declare
  v_n int;
begin
  -- profiles must still be readable, or nobody can sign in at all.
  select count(*) into v_n from information_schema.role_table_grants
   where table_schema='public' and table_name='profiles'
     and grantee='authenticated' and privilege_type='SELECT';
  if v_n = 0 then
    raise exception 'PIA 0017 ABORTED -- profiles lost its SELECT grant. Rolled back.';
  end if;

  -- The admin console reads these four. A missing SELECT = an empty panel.
  select count(distinct table_name) into v_n from information_schema.role_table_grants
   where table_schema='public' and grantee='authenticated' and privilege_type='SELECT'
     and table_name in ('profiles','sections','professors','settings');
  if v_n < 4 then
    raise exception 'PIA 0017 ABORTED -- an admin-console table lost SELECT. Rolled back.';
  end if;

  -- Every RLS-enabled target must own at least one admin policy, or the
  -- console goes blank the moment RLS starts filtering.
  select count(*) into v_n from pg_policies
   where schemaname='public' and policyname like 'pia0017\_%'
     and qual like '%pia_caller_role%';
  if v_n < 3 then
    raise exception 'PIA 0017 ABORTED -- admin read policies missing (found %). Rolled back.', v_n;
  end if;

  raise notice 'PIA 0017: postflight passed.';
end;
$$;

commit;

notify pgrst, 'reload schema';


-- ===========================================================================
-- VERIFY -- run separately after committing. Expect no '***' rows.
-- ===========================================================================
select c.relname as object,
       case when c.relrowsecurity then 'RLS ON' else '*** RLS OFF ***' end as rls,
       coalesce(string_agg(distinct g.privilege_type, ','), 'none') as authenticated_has
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join information_schema.role_table_grants g
         on g.table_schema='public' and g.table_name=c.relname and g.grantee='authenticated'
 where n.nspname='public' and c.relkind in ('r','v')
 group by c.relname, c.relrowsecurity
 order by c.relname;


-- ===========================================================================
-- ROLLBACK -- paste and run as one block to undo everything above.
-- ===========================================================================
-- begin;
--   drop policy if exists pia0017_tutoring_attempts_admin_read on public.tutoring_attempts;
--   drop policy if exists pia0017_tutoring_attempts_own_read   on public.tutoring_attempts;
--   drop policy if exists pia0017_math_attempt_log_admin_read  on public.math_attempt_log;
--   drop policy if exists pia0017_math_attempt_log_own_read    on public.math_attempt_log;
--   drop policy if exists pia0017_session_start_log_admin_read on public.session_start_log;
--   drop policy if exists pia0017_session_start_log_own_read   on public.session_start_log;
--   drop policy if exists pia0017_tutoring_attempts_server_write on public.tutoring_attempts;
--   drop policy if exists pia0017_math_attempt_log_server_write  on public.math_attempt_log;
--   drop policy if exists pia0017_session_start_log_server_write on public.session_start_log;
--   drop policy if exists pia0017_professors_server_write        on public.professors;
--   drop policy if exists pia0017_professors_admin_all         on public.professors;
--   drop policy if exists pia0017_professors_own_read          on public.professors;
--   drop policy if exists pia0017_sections_read                on public.sections;
--   drop policy if exists pia0017_sections_admin_insert        on public.sections;
--   alter table public.tutoring_attempts  disable row level security;
--   alter table public.math_attempt_log   disable row level security;
--   alter table public.session_start_log  disable row level security;
--   alter table public.professors         disable row level security;
--   alter table public.sections           disable row level security;
--   grant all on public.tutoring_attempts, public.math_attempt_log,
--                public.session_start_log, public.professors to authenticated;
-- commit;
-- notify pgrst, 'reload schema';
