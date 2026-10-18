-- ============================================================================
-- PIA 0051 -- CLOSE THE ANONYMOUS FUNCTION SURFACE, PIN THE LAST search_path
-- ============================================================================
-- Source: the Supabase Security Advisor (linter 0011 / 0028 / 0029), 7 Oct 2026.
--
-- 1. anon_security_definer_function_executable (15 functions).
--    Postgres grants EXECUTE on every new function to PUBLIC, and `anon` inherits
--    it. Migration 0011 revoked from public/anon on the __inner functions but the
--    wrappers it created (admin_create_auth_user, admin_reset_password,
--    admin_register_teacher, admin_grant_stage, ...) kept the default grant.
--    Nothing was open: each wrapper refuses a caller whose pia_caller_role() is
--    not 'admin'. This removes the second line of defence being the ONLY line.
--
-- 2. function_search_path_mutable (14 functions).
--    0039 / 0045 / 0038 re-created pia_* helpers with CREATE OR REPLACE and no SET
--    clause, which drops the search_path 0012 had pinned.
--
-- NOT touched, on purpose:
--    * authenticated EXECUTE. The student/staff RPCs and the policy helpers
--      (is_admin, current_email, jwt_is_current, ...) must stay callable by
--      signed-in users; RLS policies run as the caller.
--    * jwt_is_current() keeps anon EXECUTE: assets/js/function.js calls it, and a
--      request made while a token is refreshing arrives as anon. Today it answers
--      "no" to anon; revoking would make that an error (read as "unknown"). That
--      is a behaviour change to decide separately, not a side effect of this one.
--    * Leaked-password protection (Auth setting, Pro plan only).
--
-- WHY THE GRANT TO authenticated IS REPEATED:
--    `revoke ... from public` also removes the implicit grant authenticated was
--    relying on for helpers that never had an explicit one. So every non-trigger
--    function that had it gets an explicit grant back, and the block checks, per function,
--    that authenticated can still execute exactly what it could before.
--
-- TRIGGER FUNCTIONS (handle_new_student_auth, profiles_guard_privileged_columns,
--    guard_session_start): Postgres checks EXECUTE only when
--    the trigger is created, never when it fires. They are revoked from everyone.
--    Chosen by return type = trigger, so a function that is not a trigger is
--    never treated as one.
--
-- ONE TRANSACTION. Any failed assertion rolls everything back. Rollback for a
-- committed run is at the bottom. No data changes.
-- ============================================================================

begin;

do $$
declare
  r            record;
  v_fail       text := '';
  v_unguarded  text := '';
  v_grants     int  := 0;
  v_triggers   int  := 0;
  v_pinned     int  := 0;
  v_had_auth   boolean;
  v_is_trigger boolean;
  v_anon_names text[] := array[
    'admin_create_auth_user','admin_delete_user','admin_grant_stage',
    'admin_register_teacher','admin_reset_password','admin_revoke_sessions',
    'current_email','current_role_name','current_user_role','current_user_section',
    'handle_new_student_auth','is_admin','is_teacher',
    'profiles_guard_privileged_columns','guard_session_start'
  ];
  v_pin_names text[] := array[
    'pia_window_expired','pia_step_required','pia_step_label','pia_clock_json',
    'pia_step_confirm_kind','pia_has_working','pia_is_final_format','pia_format_final',
    'handle_new_student_auth','pia_replay_decision_tree','pia_session_state',
    'enforce_device_limit','pia_can_enter_stage','pia_tier_label','pia_refuse'
  ];
begin
  -- ------------------------------------------------------------------------
  -- PART 1 -- anon (and the PUBLIC default) off the flagged functions.
  -- ------------------------------------------------------------------------
  for r in
    select p.oid, p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           p.prorettype = 'trigger'::regtype          as is_trigger
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and p.proname = any (v_anon_names)
  loop
    v_had_auth   := has_function_privilege('authenticated', r.oid, 'EXECUTE');
    v_is_trigger := r.is_trigger;

    execute format('revoke all on function public.%I(%s) from public, anon', r.proname, r.args);

    if v_is_trigger then
      execute format('revoke all on function public.%I(%s) from authenticated', r.proname, r.args);
      v_triggers := v_triggers + 1;
    else
      -- Never widen: only functions authenticated could already run get the grant back.
      if v_had_auth then
        execute format('grant execute on function public.%I(%s) to authenticated, service_role',
                       r.proname, r.args);
      end if;
      v_grants := v_grants + 1;
    end if;

    if has_function_privilege('anon', r.oid, 'EXECUTE') then
      v_fail := v_fail || r.proname || '(' || r.args || ') still executable by anon; ';
    end if;
    if v_is_trigger and has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      v_fail := v_fail || r.proname || ' (trigger) still executable by authenticated; ';
    end if;
    if not v_is_trigger and v_had_auth and not has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      v_fail := v_fail || r.proname || '(' || r.args || ') LOST authenticated execute; ';
    end if;

    -- The admin wrappers must still carry their own role check.
    if r.proname like 'admin\_%' and r.proname not like '%\_\_inner'
       and pg_get_functiondef(r.oid) !~* '(is_admin|current_user_role|pia_caller_role)' then
      v_unguarded := v_unguarded || r.proname || ', ';
    end if;
  end loop;

  if v_unguarded <> '' then
    raise notice 'PIA 0051 REVIEW: no role check found in the body of: %  (anon is closed now; check authenticated access)', v_unguarded;
  end if;

  -- ------------------------------------------------------------------------
  -- PART 2 -- pin search_path on helpers that lost it.
  -- ------------------------------------------------------------------------
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and p.proname = any (v_pin_names)
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  loop
    execute format('alter function public.%I(%s) set search_path = public, pg_temp', r.proname, r.args);
    v_pinned := v_pinned + 1;
  end loop;

  for r in
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f' and p.proname = any (v_pin_names)
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  loop
    v_fail := v_fail || r.proname || ' has no search_path; ';
  end loop;

  if v_fail <> '' then
    raise exception 'PIA 0051 ABORT (nothing changed): %', v_fail;
  end if;

  raise notice 'PIA 0051: % function(s) closed to anon and kept for authenticated, % trigger function(s) closed to everyone, % search_path(s) pinned.',
    v_grants, v_triggers, v_pinned;
end;
$$;

commit;

-- ============================================================================
-- VERIFY (read-only, run after the commit). Expect 0 rows:
--
--   select p.proname, pg_get_function_identity_arguments(p.oid)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.prosecdef
--      and has_function_privilege('anon', p.oid, 'EXECUTE')
--      and p.proname <> 'jwt_is_current';
--
-- Then in the app: staff sign-in, a student game session, and one admin action
-- (e.g. open/close a stage). Then Advisors -> Rerun linter.
--
-- ROLLBACK of a committed run (restores the old, wider grants):
--   grant execute on function public.<name>(<args>) to public, anon;
-- for the functions listed in v_anon_names above. Not needed for search_path:
-- pinning it cannot change behaviour of these functions.
-- ============================================================================
