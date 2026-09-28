-- ============================================================================
-- PIA 0022 -- A REVOKED SESSION IS REFUSED EVERYWHERE, FOR EVERY ROLE
-- ============================================================================
-- After "Sign out everywhere" (0021), a revoked browser can no longer renew
-- its token, and the profiles policies refuse the token it still holds. Two
-- kinds of access ignored that until the token expired:
--
--   * SECURITY DEFINER functions -- the student functions and the admin_*
--     functions. They bypass RLS and take the caller's identity straight from
--     auth.jwt(), so a revoked token could still save answers, claim a device
--     slot, open a stage or delete an account.
--   * Every admin / teacher check built on pia_caller_role() -- the admin_*
--     wrappers (0011), the policies on settings, sections, professors and the
--     research tables (0017, 0018), and the profile write guard (0001).
--
-- This closes both with the same test the profiles policies already use,
-- jwt_is_current() (documented in 0020): a token issued before
-- profiles.sessions_revoked_at is stale.
--
-- 1. STUDENT FUNCTIONS refuse a revoked token first thing:
--        if not public.jwt_is_current() then
--          raise exception 'PIA: this session was signed out. Please sign in again.'
--            using errcode = '42501';
--        end if;
--    submit_ocean_results, set_student_stage, claim_device, serve_problem,
--    consume_hint, reveal_solution, record_problem_result_v2,
--    record_problem_result (if present), resume_or_start_game_session,
--    start_game_session, check_math_answer, end_game_session.
--
-- 2. pia_caller_role() RETURNS NULL FOR A REVOKED TOKEN, so every role check
--    built on it treats the caller as nobody -- admin, teacher and student
--    alike, in functions and in policies.
--
-- 3. ADMIN FUNCTIONS get the same explicit check as the student ones: every
--    admin_* function signed-in users can call (the 0011 wrappers and the
--    ones with their own guard). With (2) they would already refuse; this
--    makes them refuse with the "signed out" message rather than "only an
--    admin may call", and covers any that check the role another way.
--
-- Deliberately NOT guarded:
--   release_device    a signing-out device must still be able to free its
--                     slot (and revocation already empties the list);
--   jwt_is_current, pia_stage_open, pia_can_enter_stage, pia_session_state,
--   pia_replay_decision_tree -- read-only helpers with no side effects;
--   admin_*__inner    not callable from the browser; their wrapper is guarded.
--
-- HOW -- for (1) and (3) the check is INSERTED into each live definition
-- instead of the function being retyped from a migration file: 0013 rewrote
-- the messages inside many of these in place, and several were never in a
-- file (start_game_session, check_math_answer, end_game_session, and admin
-- functions created in the dashboard). Each definition is read with
-- pg_get_functiondef(), the check goes in right after the body's first
-- BEGIN, and the result is re-executed -- nothing else changes, and owners
-- and privileges are kept. pia_caller_role() is a one-line SQL function
-- defined only in 0001, so (2) replaces it outright, after confirming the
-- live copy is that definition.
--
-- SAFE TO RE-RUN: anything already calling jwt_is_current() is skipped. A
-- missing student function is reported and skipped. SQL-language functions
-- cannot take an IF, so they are reported instead of changed.
--
-- The postflight proves it with real accounts under the authenticated role:
-- a revoked student and a revoked admin are refused, and a current student
-- and a current admin still get through. Any failure rolls back all of it.
-- Every probe is itself rolled back, so no data changes.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1 + 3. Insert the check into the student and admin functions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_students text[] := array[
    'submit_ocean_results', 'set_student_stage', 'claim_device',
    'serve_problem', 'consume_hint', 'reveal_solution',
    'record_problem_result_v2', 'record_problem_result',
    'resume_or_start_game_session', 'start_game_session',
    'check_math_answer', 'end_game_session'
  ];
  -- Real line breaks inside one plain literal: no escape processing to get
  -- wrong, and the inserted lines read like the rest of each body.
  v_guard text := '
  if not public.jwt_is_current() then
    raise exception ''PIA: this session was signed out. Please sign in again.''
      using errcode = ''42501'';
  end if;
';
  v_name    text;
  r         record;
  v_def     text;
  v_new     text;
  v_guarded text := '';
  v_already text := '';
  v_sql     text := '';
  v_missing text := '';
begin
  foreach v_name in array v_students loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name
    ) then
      v_missing := v_missing || v_name || ', ';
    end if;
  end loop;

  -- Every overload of each student function, and every admin function the
  -- browser can reach.
  for r in
    select p.oid, p.oid::regprocedure::text as sig, l.lanname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l  on l.oid = p.prolang
     where n.nspname = 'public'
       and p.prokind = 'f'
       and (p.proname = any (v_students)
            or (p.proname like 'admin\_%'
                and p.proname not like '%\_\_inner'
                and has_function_privilege('authenticated', p.oid, 'EXECUTE')))
     order by p.proname
  loop
    v_def := pg_get_functiondef(r.oid);

    if v_def ~ 'jwt_is_current' then
      v_already := v_already || r.sig || ', ';
      continue;
    end if;

    if r.lanname <> 'plpgsql' then
      v_sql := v_sql || r.sig || ' (' || r.lanname || '), ';
      continue;
    end if;

    -- pg_get_functiondef always opens the body with a dollar-quote on the AS
    -- line. In Postgres the FIRST quantifier decides whether the whole match
    -- is shortest or longest, so both are lazy (*?): the match ends at the
    -- FIRST whole-word BEGIN after the AS line -- the end of the DECLARE
    -- section -- never at a later nested BEGIN.
    v_new := regexp_replace(v_def, '(AS \$[a-z_0-9]*?\$.*?\mbegin\M)', '\1' || v_guard, 'i');

    if v_new = v_def then
      raise exception 'PIA 0022 ABORT: could not find the body''s BEGIN in %. Nothing was changed.', r.sig
        using errcode = 'P0001';
    end if;

    -- A malformed result fails here, and the whole migration rolls back.
    execute v_new;
    v_guarded := v_guarded || r.sig || ', ';
  end loop;

  raise notice 'PIA 0022 guarded: %', coalesce(nullif(v_guarded, ''), 'none');
  raise notice 'PIA 0022 already guarded: %', coalesce(nullif(v_already, ''), 'none');
  raise notice 'PIA 0022 student functions not found (skipped): %', coalesce(nullif(v_missing, ''), 'none');
  if v_sql <> '' then
    raise warning 'PIA 0022: SQL-language functions cannot take the check and were left unchanged: %', v_sql;
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. pia_caller_role() -- NULL for a revoked token.
--    Confirm production still has 0001's definition before replacing it.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('public.pia_caller_role()'::regprocedure);
begin
  if v_def !~ 'jwt_is_current' and v_def !~ 'coalesce\(p\.role, ''student''\)' then
    raise exception
      'PIA 0022 ABORT: pia_caller_role() is not the definition from 0001, so it was not replaced. Nothing was changed.'
      using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.pia_caller_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  -- The caller's role, RLS-bypassing so the profiles policies do not recurse
  -- -- and NULL once their session has been revoked (0022), so every admin,
  -- teacher and student check built on this refuses a stale token.
  select case when public.jwt_is_current() then
    (select lower(trim(coalesce(p.role, 'student')))
       from public.profiles p
      where p.email = (auth.jwt() ->> 'email')
      limit 1)
  end;
$$;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT -- prove it with real accounts, in both directions, for a
-- student (claim_device) and an admin (admin_revoke_device, asked to remove
-- a device that does not exist). Each probe runs in its own sub-block and is
-- rolled back, so no row changes.
-- ---------------------------------------------------------------------------
do $$
declare
  v_student text;
  v_admin   text;
begin
  if pg_get_functiondef('public.claim_device(text)'::regprocedure) !~ 'jwt_is_current' then
    raise exception 'PIA 0022 ABORT: claim_device did not receive the check.' using errcode = 'P0001';
  end if;
  if pg_get_functiondef('public.pia_caller_role()'::regprocedure) !~ 'jwt_is_current' then
    raise exception 'PIA 0022 ABORT: pia_caller_role() was not replaced.' using errcode = 'P0001';
  end if;

  select email into v_student from public.profiles
   where lower(trim(coalesce(role, 'student'))) = 'student' order by email limit 1;
  select email into v_admin from public.profiles
   where lower(trim(role)) = 'admin' order by email limit 1;

  -- ---- STUDENT ----------------------------------------------------------
  if v_student is null then
    raise notice 'PIA 0022: no student profile to probe with -- skipped.';
  else
    -- (a) A token issued BEFORE a revocation is refused.
    begin
      update public.profiles set sessions_revoked_at = now() where email = v_student;
      perform set_config('request.jwt.claims',
        json_build_object('email', v_student, 'role', 'authenticated',
                          'iat', extract(epoch from now())::bigint - 60)::text, true);
      execute 'set local role authenticated';
      perform public.claim_device('pia-0022-probe');
      execute 'reset role';
      raise exception 'PIA 0022 ABORT: a revoked student token could still call claim_device -- rolling back.'
        using errcode = 'P0001';
    exception
      when insufficient_privilege then
        raise notice 'PIA 0022 OK: a revoked student token is refused (42501).';
    end;

    -- (b) A CURRENT token still gets through. The deliberate P0002 rolls
    --     back whatever claim_device changed.
    begin
      perform set_config('request.jwt.claims',
        json_build_object('email', v_student, 'role', 'authenticated',
                          'iat', extract(epoch from clock_timestamp())::bigint + 1)::text, true);
      execute 'set local role authenticated';
      perform public.claim_device('pia-0022-probe');
      execute 'reset role';
      raise exception 'probe done' using errcode = 'P0002';
    exception
      when sqlstate 'P0002' then
        raise notice 'PIA 0022 OK: a current student token is let through.';
      when insufficient_privilege then
        raise exception 'PIA 0022 ABORT: the check refused a CURRENT student token -- students would be locked out. Rolling back.'
          using errcode = 'P0001';
    end;
  end if;

  -- ---- ADMIN ------------------------------------------------------------
  if v_admin is null then
    raise notice 'PIA 0022: no admin profile to probe with -- skipped.';
  else
    -- (c) A revoked admin token: pia_caller_role() is NULL, and an admin
    --     function refuses it.
    begin
      update public.profiles set sessions_revoked_at = now() where email = v_admin;
      perform set_config('request.jwt.claims',
        json_build_object('email', v_admin, 'role', 'authenticated',
                          'iat', extract(epoch from now())::bigint - 60)::text, true);
      execute 'set local role authenticated';
      if public.pia_caller_role() is not null then
        raise exception 'PIA 0022 ABORT: pia_caller_role() still answers for a revoked admin token -- rolling back.'
          using errcode = 'P0001';
      end if;
      perform public.admin_revoke_device(v_admin, 'pia-0022-probe');
      execute 'reset role';
      raise exception 'PIA 0022 ABORT: a revoked admin token could still call admin_revoke_device -- rolling back.'
        using errcode = 'P0001';
    exception
      when insufficient_privilege then
        raise notice 'PIA 0022 OK: a revoked admin token is refused (42501).';
    end;

    -- (d) A CURRENT admin token still works: pia_caller_role() says admin,
    --     and the admin function runs (removing nothing).
    begin
      perform set_config('request.jwt.claims',
        json_build_object('email', v_admin, 'role', 'authenticated',
                          'iat', extract(epoch from clock_timestamp())::bigint + 1)::text, true);
      execute 'set local role authenticated';
      if public.pia_caller_role() is distinct from 'admin' then
        raise exception 'PIA 0022 ABORT: pia_caller_role() no longer recognises a CURRENT admin -- rolling back.'
          using errcode = 'P0001';
      end if;
      perform public.admin_revoke_device(v_admin, 'pia-0022-probe');
      execute 'reset role';
      raise exception 'probe done' using errcode = 'P0002';
    exception
      when sqlstate 'P0002' then
        raise notice 'PIA 0022 OK: a current admin token is let through.';
      when insufficient_privilege then
        raise exception 'PIA 0022 ABORT: the check refused a CURRENT admin token -- admins would be locked out. Rolling back.'
          using errcode = 'P0001';
    end;
  end if;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Report -- (1) every SECURITY DEFINER function signed-in users can call
-- (these bypass RLS, so each needs its own check), and (2) every policy
-- signed-in users are subject to. Anything not revocation-aware is listed
-- first, marked REVIEW.
with items as (
  select 'function' as kind,
         p.oid::regprocedure::text as name,
         case when pg_get_functiondef(p.oid) ~ 'jwt_is_current'  then 'revocation check'
              when pg_get_functiondef(p.oid) ~ 'pia_caller_role' then 'admin guard (revocation-aware via pia_caller_role)'
              when p.proname in ('release_device', 'jwt_is_current', 'pia_stage_open',
                                 'pia_can_enter_stage', 'pia_session_state',
                                 'pia_replay_decision_tree', 'pia_caller_role')
                   then 'unguarded by design'
              else '*** REVIEW: no check ***' end as guard
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.prosecdef
     and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  union all
  select 'policy',
         tablename || ' / ' || policyname || ' (' || cmd || ')',
         case when coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ '(jwt_is_current|pia_caller_role)'
                   then 'revocation-aware'
              when coalesce(qual, 'false') = 'false' and coalesce(with_check, 'false') = 'false'
                   then 'denies everything'
              else '*** REVIEW: not revocation-aware ***' end
    from pg_policies
   where schemaname = 'public'
     and (roles && array['authenticated', 'public']::name[])
)
select kind, name, guard
  from items
 order by guard like '***%' desc, kind, name;
