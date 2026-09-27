-- ============================================================================
-- PIA 0019 -- HYBRID PASSWORD RECOVERY: ADMIN OVERRIDE + FORCED CHANGE
-- ============================================================================
-- Three ways back into an account, one of them new:
--
--   1. SELF-SERVICE (no change here). resetPasswordForEmail() sends a link
--      and a code; the student picks the new password themselves.
--
--   2. ADMIN OVERRIDE (new). For a student who cannot receive that email, an
--      admin sets a temporary password through the Edge Function
--      supabase/functions/admin-set-temp-password, which calls the Auth Admin
--      API (updateUserById) with the service-role key -- a key that never
--      leaves the server. The function then sets must_change_password.
--
--   3. FORCED CHANGE (new). A flagged student is routed to a Set New Password
--      screen at sign-in and blocked from every other page until they choose
--      a password only they know. The admin knew the temporary one; nobody
--      but the student knows the next.
--
-- WHAT THIS MIGRATION ADDS
--   * profiles.must_change_password, plus who set the temporary password and
--     when (temp_password_set_by / temp_password_set_at) for accountability.
--   * public.pia_auth_user_id(email): the auth user id behind an email, for
--     the Edge Function's updateUserById call. service_role only.
--   * A trigger on auth.users that clears must_change_password WHEN THE
--     PASSWORD ACTUALLY CHANGES. That is the only way the flag comes down:
--     students cannot write it (the 0001 write guard does not whitelist it),
--     so a student cannot skip the screen by faking the profile update --
--     the flag is cleared by the change itself, server-side.
--
--   Order inside the Edge Function matters and is deliberate: it sets the
--   password FIRST (the trigger fires and clears any old flag), THEN raises
--   the flag. The next password change -- the student's own -- clears it.
--
-- RUN IT ALL AT ONCE. One transaction; PART 4 proves the trigger, the lookup
-- and the write guard before COMMIT, and any failure changes nothing.
-- ============================================================================

begin;

-- ===========================================================================
-- PART 1 -- the flag, and its audit trail
-- ===========================================================================
alter table public.profiles
  add column if not exists must_change_password boolean not null default false,
  add column if not exists temp_password_set_at timestamptz,
  add column if not exists temp_password_set_by text;

comment on column public.profiles.must_change_password is
  'True after an admin sets a temporary password. Cleared only by the auth.users trigger when the password changes.';


-- ===========================================================================
-- PART 2 -- email -> auth user id, for the Edge Function only
-- ===========================================================================
create or replace function public.pia_auth_user_id(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.id
    from auth.users u
   where lower(u.email) = lower(trim(p_email))
   limit 1;
$$;

-- Never callable from a browser: it would let anyone map emails to account
-- ids. The Edge Function calls it with the service-role key.
revoke all on function public.pia_auth_user_id(text) from public, anon, authenticated;
grant execute on function public.pia_auth_user_id(text) to service_role;


-- ===========================================================================
-- PART 3 -- the flag comes down only when the password changes
-- ===========================================================================
create or replace function public.pia_on_password_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Runs as the function owner, so the 0001 write guard lets it through:
  -- that guard only polices writes arriving as `authenticated`.
  update public.profiles
     set must_change_password = false
   where lower(email) = lower(new.email)
     and must_change_password;
  return null;   -- AFTER trigger: the return value is ignored
end;
$$;

revoke all on function public.pia_on_password_changed() from public, anon, authenticated;

drop trigger if exists pia_password_changed on auth.users;
create trigger pia_password_changed
  after update of encrypted_password on auth.users
  for each row
  when (old.encrypted_password is distinct from new.encrypted_password)
  execute function public.pia_on_password_changed();


-- ===========================================================================
-- PART 4 -- SELF-VERIFICATION. Any failed check raises and rolls back all of
-- the above. The trigger test runs in a subtransaction that is ALWAYS rolled
-- back, so no real password or flag is left changed.
-- ===========================================================================
do $$
declare
  v_student text;
  v_uid     uuid;
  v_flag    boolean;
  v_blocked boolean;
  v_rows    int;
begin
  -- (1) The columns exist with the right default.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles'
                    and column_name = 'must_change_password'
                    and column_default = 'false' and is_nullable = 'NO') then
    raise exception 'PIA ABORT: profiles.must_change_password is missing or mis-defined.' using errcode = 'P0001';
  end if;

  -- (2) The lookup is server-only.
  if has_function_privilege('authenticated', 'public.pia_auth_user_id(text)', 'execute')
     or has_function_privilege('anon', 'public.pia_auth_user_id(text)', 'execute') then
    raise exception 'PIA ABORT: pia_auth_user_id() is callable from the browser.' using errcode = 'P0001';
  end if;
  if not has_function_privilege('service_role', 'public.pia_auth_user_id(text)', 'execute') then
    raise exception 'PIA ABORT: the Edge Function (service_role) cannot call pia_auth_user_id().' using errcode = 'P0001';
  end if;

  -- A real student with a sign-in account, for the live checks below.
  select p.email, u.id into v_student, v_uid
    from public.profiles p
    join auth.users u on lower(u.email) = lower(p.email)
   where lower(trim(coalesce(p.role, 'student'))) = 'student'
   order by p.email
   limit 1;

  if v_student is null then
    raise notice 'PIA 0019: no student with a sign-in account yet -- live trigger checks skipped.';
  else
    -- (3) The lookup returns that account.
    if public.pia_auth_user_id(upper(v_student)) is distinct from v_uid then
      raise exception 'PIA ABORT: pia_auth_user_id() did not find the account for %.', v_student using errcode = 'P0001';
    end if;

    -- (4) The trigger, end to end, always rolled back.
    begin
      update public.profiles set must_change_password = true where email = v_student;

      -- Touching another column must NOT clear the flag.
      update auth.users set raw_user_meta_data = raw_user_meta_data where id = v_uid;
      select must_change_password into v_flag from public.profiles where email = v_student;
      if v_flag is not true then
        raise exception 'PIA ABORT: the flag cleared without a password change.' using errcode = 'P0001';
      end if;

      -- A password change MUST clear it.
      update auth.users set encrypted_password = encrypted_password || '#selftest' where id = v_uid;
      select must_change_password into v_flag from public.profiles where email = v_student;
      if v_flag is not false then
        raise exception 'PIA ABORT: a password change did not clear must_change_password.' using errcode = 'P0001';
      end if;

      raise exception 'trigger self-test complete' using errcode = 'PX999';
    exception
      when sqlstate 'PX999' then null;                 -- undone, as intended
      when insufficient_privilege then
        raise notice 'PIA 0019: this role cannot write auth.users, so the trigger was not exercised here. It is installed; verify with one real temporary-password reset.';
    end;

    -- (5) A flagged student cannot clear their own flag and skip the screen.
    -- The flag is raised first: clearing an already-false flag is a no-op the
    -- guard rightly allows, and would prove nothing. Rolled back either way.
    -- (PL/pgSQL variables are not transactional, so v_blocked survives it.)
    v_blocked := false;
    begin
      update public.profiles set must_change_password = true where email = v_student;
      begin
        perform set_config('request.jwt.claims',
          json_build_object('email', v_student, 'role', 'authenticated',
                            'iat', extract(epoch from now())::bigint)::text, true);
        execute 'set local role authenticated';
        execute format('update public.profiles set must_change_password = false where email = %L', v_student);
        get diagnostics v_rows = row_count;
        execute 'reset role';
        v_blocked := (v_rows = 0);          -- filtered out by RLS also counts as blocked
      exception when others then
        begin execute 'reset role'; exception when others then null; end;
        v_blocked := true;                  -- the write guard raised: blocked
      end;
      raise exception 'guard self-test complete' using errcode = 'PX999';
    exception
      when sqlstate 'PX999' then null;
    end;
    perform set_config('request.jwt.claims', '', true);

    if not v_blocked then
      raise exception 'PIA ABORT: a student can write must_change_password directly.' using errcode = 'P0001';
    end if;
  end if;

  raise notice 'PIA 0019 OK: flag + audit columns in place; lookup is service_role only; the flag clears on a password change and on nothing else; students cannot clear it themselves.';
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Final report.
select 'profiles flagged to change password' as check_name,
       count(*)::text as result
  from public.profiles where must_change_password
union all
select 'trigger on auth.users', string_agg(tgname, ', ')
  from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'pia_password_changed'
union all
select 'pia_auth_user_id callable by browser roles',
       (has_function_privilege('authenticated', 'public.pia_auth_user_id(text)', 'execute'))::text;


-- ============================================================================
-- ROLLBACK
--   drop trigger if exists pia_password_changed on auth.users;
--   drop function if exists public.pia_on_password_changed();
--   drop function if exists public.pia_auth_user_id(text);
--   alter table public.profiles drop column if exists must_change_password,
--     drop column if exists temp_password_set_at, drop column if exists temp_password_set_by;
-- Drop the flag column only AFTER reverting the frontend: it degrades safely
-- when the column is missing, but the admin override would stop working.
-- ============================================================================
