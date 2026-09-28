-- ============================================================================
-- PIA 0023 -- EVERY POLICY AND FUNCTION IS REVOCATION-AWARE
-- ============================================================================
-- 0022's report listed what was still reachable by a revoked token:
--
--   17 POLICIES -- older rules written in the dashboard before the migrations
--   existed (profiles_select_self, settings_admin_write, "Allow public access
--   to sections", attempts_select_teacher, ...). Permissive policies are
--   OR-ed, so each one is a door on its own: while any of them ignores
--   revocation, a revoked token still gets through it. Three are on profiles
--   and are the very policies 0009 set out to fix -- 0009's changes are not
--   in production (its self-verification most likely aborted it), so until
--   now the profiles revocation check was bypassed too.
--
--   2 FUNCTIONS with side effects -- enforce_device_limit(text), the old
--   device RPC that claim_device (0012) replaced and the app no longer
--   calls, and guard_session_start().
--
--   6 HELPERS -- current_email, current_role_name, current_user_role,
--   current_user_section, is_admin, is_teacher. They only report facts about
--   the caller and grant nothing by themselves; access comes from the
--   policies and functions that use them, which are all revocation-aware
--   once this runs. The postflight confirms they write nothing.
--
-- WHAT THIS DOES
--
-- 1. Every permissive policy signed-in users are subject to that does not yet
--    consult revocation gets "and the token is current" added:
--        USING      ((<existing>) and (select public.jwt_is_current()))
--        WITH CHECK ((<existing>) and (select public.jwt_is_current()))
--    For a current token each policy allows EXACTLY what it allowed before;
--    only a revoked token is turned away. Nothing is dropped, so no page
--    loses access it relies on. (The sub-select lets Postgres evaluate the
--    check once per query instead of once per row.)
--
-- 2. enforce_device_limit(text) can no longer be called from the browser.
--    Nothing in the app calls it, and as SECURITY DEFINER it was a second,
--    unguarded way to write active_devices. Its execute grant is revoked,
--    not the function dropped: restoring it is one GRANT.
--
-- 3. guard_session_start() gets the same "signed out" check as 0022's
--    functions, inserted into its live definition the same way.
--
-- NOT CHANGED, and why: restrictive policies (they only ever narrow access,
-- e.g. 0015's settings lockdown), deny-all policies, and policies that
-- already use jwt_is_current() or pia_caller_role().
--
-- WHAT THIS DOES NOT DECIDE: several of these older policies duplicate the
-- ones 0017 wrote, and at least one looks far too broad ("Allow public
-- access to sections", FOR ALL). After this migration they are all
-- revocation-aware, but removing them needs their exact definitions. The
-- report at the end prints every policy's full definition for that review.
--
-- SAFE TO RE-RUN: anything already revocation-aware is skipped.
--
-- The postflight proves it on profiles with real accounts under the
-- authenticated role: a current student sees their own row and a current
-- admin sees every row; revoked, both see nothing. Any failure rolls back
-- all of it. Every probe is itself rolled back.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Policies.
-- ---------------------------------------------------------------------------
do $$
declare
  v_cond  constant text := '(select public.jwt_is_current())';
  r       record;
  v_using text;
  v_check text;
  v_done  text := '';
begin
  for r in
    select pol.polname,
           c.relname,
           pg_get_expr(pol.polqual,      pol.polrelid) as qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check
      from pg_policy pol
      join pg_class c     on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and pol.polpermissive
       -- PUBLIC (0) or authenticated: the policies a signed-in token meets.
       and (0 = any (pol.polroles) or 'authenticated'::regrole::oid = any (pol.polroles))
     order by c.relname, pol.polname
  loop
    continue when coalesce(r.qual, '') || ' ' || coalesce(r.with_check, '')
                  ~ '(jwt_is_current|pia_caller_role)';
    continue when coalesce(r.qual, 'false') = 'false' and coalesce(r.with_check, 'false') = 'false';

    v_using := case when r.qual       is not null then format('(%s) and %s', r.qual,       v_cond) end;
    v_check := case when r.with_check is not null then format('(%s) and %s', r.with_check, v_cond) end;

    if v_using is not null and v_check is not null then
      execute format('alter policy %I on public.%I using (%s) with check (%s)',
                     r.polname, r.relname, v_using, v_check);
    elsif v_using is not null then
      execute format('alter policy %I on public.%I using (%s)', r.polname, r.relname, v_using);
    else
      execute format('alter policy %I on public.%I with check (%s)', r.polname, r.relname, v_check);
    end if;

    v_done := v_done || r.relname || ' / ' || r.polname || ', ';
  end loop;

  raise notice 'PIA 0023 made revocation-aware: %', coalesce(nullif(v_done, ''), 'none');
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. enforce_device_limit -- out of the browser's reach.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'enforce_device_limit'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    raise notice 'PIA 0023: % is no longer callable from the browser.', r.sig;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. guard_session_start -- the 0022 check, inserted into the live body.
-- ---------------------------------------------------------------------------
do $$
declare
  v_guard text := '
  if not public.jwt_is_current() then
    raise exception ''PIA: this session was signed out. Please sign in again.''
      using errcode = ''42501'';
  end if;
';
  r     record;
  v_def text;
  v_new text;
begin
  for r in
    select p.oid, p.oid::regprocedure::text as sig, l.lanname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l  on l.oid = p.prolang
     where n.nspname = 'public' and p.proname = 'guard_session_start'
  loop
    v_def := pg_get_functiondef(r.oid);
    if v_def ~ 'jwt_is_current' then
      raise notice 'PIA 0023: % already checks revocation.', r.sig;
      continue;
    end if;
    if r.lanname <> 'plpgsql' then
      raise warning 'PIA 0023: % is %, not plpgsql; left unchanged -- send me its definition.', r.sig, r.lanname;
      continue;
    end if;

    -- Same insertion as 0022: right after the body's first BEGIN (both
    -- quantifiers lazy, so never at a later nested BEGIN).
    v_new := regexp_replace(v_def, '(AS \$[a-z_0-9]*?\$.*?\mbegin\M)', '\1' || v_guard, 'i');
    if v_new = v_def then
      raise exception 'PIA 0023 ABORT: could not find the body''s BEGIN in %. Nothing was changed.', r.sig
        using errcode = 'P0001';
    end if;

    execute v_new;
    raise notice 'PIA 0023: % now refuses a revoked token.', r.sig;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT
-- ---------------------------------------------------------------------------
do $$
declare
  v_total   int;
  v_student text;
  v_admin   text;
  v_seen    int;
  v_fn      text;
begin
  -- The six helpers must be read-only, or "grants nothing by itself" is false.
  foreach v_fn in array array['current_email', 'current_role_name', 'current_user_role',
                              'current_user_section', 'is_admin', 'is_teacher'] loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_fn
         and pg_get_functiondef(p.oid) ~* '\m(insert|update|delete|truncate)\M'
    ) then
      raise exception 'PIA 0023 ABORT: helper %() writes data -- it needs its own check. Rolling back.', v_fn
        using errcode = 'P0001';
    end if;
  end loop;

  select count(*) into v_total from public.profiles;
  select email into v_student from public.profiles
   where lower(trim(coalesce(role, 'student'))) = 'student' order by email limit 1;
  select email into v_admin from public.profiles
   where lower(trim(role)) = 'admin' order by email limit 1;

  -- ---- STUDENT: current sees exactly their own row -----------------------
  if v_student is not null then
    begin
      perform set_config('request.jwt.claims',
        json_build_object('email', v_student, 'role', 'authenticated',
                          'iat', extract(epoch from clock_timestamp())::bigint + 1)::text, true);
      execute 'set local role authenticated';
      select count(*) into v_seen from public.profiles;
      execute 'reset role';
      -- Zero means locked out. More than one is not a revocation problem
      -- (it is whatever the policies allow a student to see), so it is
      -- reported, not treated as a failure.
      if v_seen < 1 then
        raise exception 'PIA 0023 ABORT: a current student can no longer see their own profile -- students would be locked out. Rolling back.'
          using errcode = 'P0001';
      end if;
      raise exception 'probe done: %', v_seen using errcode = 'P0002';
    exception when sqlstate 'P0002' then
      raise notice 'PIA 0023 OK: a current student can read their profile (sees % row(s)).', substring(sqlerrm from '[0-9]+$');
    end;

    -- ---- STUDENT: revoked sees nothing -------------------------------------
    begin
      update public.profiles set sessions_revoked_at = now() where email = v_student;
      perform set_config('request.jwt.claims',
        json_build_object('email', v_student, 'role', 'authenticated',
                          'iat', extract(epoch from now())::bigint - 60)::text, true);
      execute 'set local role authenticated';
      select count(*) into v_seen from public.profiles;
      execute 'reset role';
      if v_seen <> 0 then
        raise exception 'PIA 0023 ABORT: a revoked student still sees % profile row(s). Rolling back.', v_seen
          using errcode = 'P0001';
      end if;
      raise exception 'probe done' using errcode = 'P0002';
    exception when sqlstate 'P0002' then
      raise notice 'PIA 0023 OK: a revoked student sees nothing.';
    end;
  end if;

  -- ---- ADMIN: current sees every row ---------------------------------------
  if v_admin is not null then
    begin
      perform set_config('request.jwt.claims',
        json_build_object('email', v_admin, 'role', 'authenticated',
                          'iat', extract(epoch from clock_timestamp())::bigint + 1)::text, true);
      execute 'set local role authenticated';
      select count(*) into v_seen from public.profiles;
      execute 'reset role';
      if v_seen < v_total then
        raise exception 'PIA 0023 ABORT: a current admin sees only % of % profile rows. Rolling back.', v_seen, v_total
          using errcode = 'P0001';
      end if;
      raise exception 'probe done' using errcode = 'P0002';
    exception when sqlstate 'P0002' then
      raise notice 'PIA 0023 OK: a current admin sees all % profiles.', v_total;
    end;

    -- ---- ADMIN: revoked sees nothing ---------------------------------------
    begin
      update public.profiles set sessions_revoked_at = now() where email = v_admin;
      perform set_config('request.jwt.claims',
        json_build_object('email', v_admin, 'role', 'authenticated',
                          'iat', extract(epoch from now())::bigint - 60)::text, true);
      execute 'set local role authenticated';
      select count(*) into v_seen from public.profiles;
      execute 'reset role';
      if v_seen <> 0 then
        raise exception 'PIA 0023 ABORT: a revoked admin still sees % profile row(s). Rolling back.', v_seen
          using errcode = 'P0001';
      end if;
      raise exception 'probe done' using errcode = 'P0002';
    exception when sqlstate 'P0002' then
      raise notice 'PIA 0023 OK: a revoked admin sees nothing.';
    end;
  end if;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Report -- every function and policy a signed-in user meets, what makes it
-- revocation-aware, and each policy's full definition (for the review of the
-- older, duplicated ones). Anything still open is listed first.
with items as (
  select 'function' as kind,
         p.oid::regprocedure::text as name,
         case when pg_get_functiondef(p.oid) ~ 'jwt_is_current'  then 'revocation check'
              when pg_get_functiondef(p.oid) ~ 'pia_caller_role' then 'admin guard (via pia_caller_role)'
              when p.proname in ('release_device', 'jwt_is_current', 'pia_stage_open',
                                 'pia_can_enter_stage', 'pia_session_state',
                                 'pia_replay_decision_tree', 'pia_caller_role',
                                 'current_email', 'current_role_name', 'current_user_role',
                                 'current_user_section', 'is_admin', 'is_teacher')
                   then 'read-only helper, by design'
              else '*** REVIEW: no check ***' end as guard,
         null::text as definition
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.prosecdef
     and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')
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
     and (roles && array['authenticated', 'public']::name[])
)
select kind, name, guard, definition
  from items
 order by guard like '***%' desc, kind, name;
