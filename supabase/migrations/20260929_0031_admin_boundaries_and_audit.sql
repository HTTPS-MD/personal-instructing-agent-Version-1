-- ============================================================================
-- PIA 0031 -- ADMINISTRATORS CANNOT ACT ON EACH OTHER; A SECURITY AUDIT LOG
-- ============================================================================
-- THE THREAT. One compromised administrator login could lock every other
-- administrator out: set their device limit to 1, revoke their devices,
-- demote them, change their email (and so where their password resets go),
-- or delete their accounts. Every one of those was possible, most of them
-- straight from the browser: the policy profiles_admin_all lets an admin
-- UPDATE and DELETE any profile row, and the profile write guard (0001)
-- waves admins through without looking.
--
-- THE RULE, enforced by the database:
--   A signed-in user -- through ANY path: a direct table write, a known RPC,
--   or a function created in the dashboard that this repo has never seen --
--   cannot change or delete ANOTHER administrator's profile, cannot promote
--   an existing account to administrator, and cannot change their own role.
--   An administrator can change their own max_devices, only within 2..10.
--
--   Who CAN: the project owner, from the Supabase dashboard (the SQL editor
--   or the service key). Those requests carry no signed-in user, so the rule
--   does not apply to them. That is the break-glass path, on purpose: its
--   protection is the Supabase account's own login, not this app's.
--
-- HOW:
--   1. pia_admin_boundaries -- a BEFORE trigger on profiles. Because it
--      guards the ROW, it covers every path at once. A refused change aborts
--      the whole statement, so an RPC that did other work first (deleted a
--      session, deleted answers) is rolled back with it.
--   2. pia_protect_admin_target(target, action) -- called at the top of the
--      five admin RPCs that name a target account. For admin_update_user_email
--      and admin_create_auth_user it is essential: they change the sign-in
--      account in auth.users, which the profiles trigger never sees. For the
--      other three it gives a clear message before any work is done. It is
--      inserted IN PLACE into each live definition (as 0022 did), so the
--      bodies -- several of which were created in the dashboard -- are not
--      retyped. Each function that is not installed is reported and skipped.
--   3. security_audit_log -- append-only. An AFTER trigger on profiles
--      records: accounts created (staff) and deleted (anyone), role changes,
--      device-limit changes, email changes, devices removed and sessions
--      revoked (on an administrator, or by someone other than the owner).
--      Administrators can read it; nobody can edit or delete it through the
--      API. Each row names the signed-in actor; no actor = the project owner.
--
--      REFUSED attempts cannot be kept in the table: a refusal aborts its own
--      transaction, and the log row would roll back with it. They are written
--      to the Postgres log instead (RAISE WARNING "PIA security: refused ...",
--      Supabase dashboard -> Logs -> Postgres), which is not rolled back.
--
-- EXISTING DATA. Administrator rows with max_devices below 2 are raised to 2.
--
-- SAFE TO RE-RUN. The postflight exercises every rule as a real admin under
-- RLS, against a temporary second administrator, and rolls everything back.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- PREFLIGHT
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.pia_caller_role()') is null or to_regprocedure('public.jwt_is_current()') is null then
    raise exception 'PIA 0031 ABORT (nothing changed): pia_caller_role() / jwt_is_current() are missing.'
      using errcode = 'P0001';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'PIA 0031 ABORT (nothing changed): public.profiles is missing.' using errcode = 'P0001';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 1. The audit log
-- ---------------------------------------------------------------------------
create table if not exists public.security_audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_email  text,                         -- null = the project owner (no signed-in user)
  actor_role   text,
  action       text not null,
  target_email text,
  detail       jsonb not null default '{}'::jsonb
);
create index if not exists security_audit_log_at_idx on public.security_audit_log (at desc);

alter table public.security_audit_log enable row level security;
revoke all on public.security_audit_log from public, anon, authenticated;
grant select on public.security_audit_log to authenticated;

drop policy if exists security_audit_log_admin_read on public.security_audit_log;
create policy security_audit_log_admin_read on public.security_audit_log
  for select to authenticated
  using (public.pia_caller_role() = 'admin' and public.jwt_is_current());

comment on table public.security_audit_log is
  'Security-relevant changes to accounts (0031). Append-only: written by triggers, readable by admins.';


-- ---------------------------------------------------------------------------
-- 2. Existing data: administrators get at least two devices.
-- ---------------------------------------------------------------------------
update public.profiles
   set max_devices = 2
 where lower(trim(coalesce(role, ''))) = 'admin'
   and coalesce(max_devices, 1) < 2;


-- ---------------------------------------------------------------------------
-- 3. The boundary, on the row itself
-- ---------------------------------------------------------------------------
create or replace function public.pia_refuse(p_actor text, p_what text, p_target text)
returns void
language plpgsql
as $$
begin
  -- Survives the rollback the exception below causes: the Postgres log.
  raise warning 'PIA security: refused "%" by % on %', p_what, coalesce(p_actor, 'owner'), coalesce(p_target, '-');
  raise exception 'PIA: an administrator cannot %. Only the project owner can, from the Supabase dashboard.', p_what
    using errcode = '42501';
end;
$$;

create or replace function public.pia_admin_boundaries()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   text := lower(nullif(auth.jwt() ->> 'email', ''));
  v_old_adm boolean := false;
  v_new_adm boolean := false;
  v_self    boolean := false;
begin
  if tg_op <> 'INSERT' then
    v_old_adm := lower(trim(coalesce(old.role, ''))) = 'admin';
    v_self    := v_actor is not null and lower(old.email) = v_actor;
  end if;
  if tg_op <> 'DELETE' then
    v_new_adm := lower(trim(coalesce(new.role, ''))) = 'admin';
  end if;

  -- No signed-in user: the project owner (SQL editor, service key). Anything
  -- goes, except that an administrator keeps at least two devices.
  if v_actor is null then
    if tg_op <> 'DELETE' then
      if v_new_adm and coalesce(new.max_devices, 1) < 2 then new.max_devices := 2; end if;
      return new;
    end if;
    return old;
  end if;

  if tg_op = 'DELETE' then
    if v_old_adm then
      perform public.pia_refuse(v_actor, 'remove an administrator account', old.email);
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- "Add administrator" writes a NEW row; the limit floor applies to it.
    if v_new_adm and coalesce(new.max_devices, 1) < 2 then new.max_devices := 2; end if;
    return new;
  end if;

  -- UPDATE
  if v_old_adm and not v_self then
    if to_jsonb(new) is distinct from to_jsonb(old) then
      perform public.pia_refuse(v_actor, 'change another administrator''s account', old.email);
    end if;
    return new;
  end if;

  if v_old_adm and v_self then
    if not v_new_adm then
      perform public.pia_refuse(v_actor, 'change their own role', old.email);
    end if;
    if new.max_devices is distinct from old.max_devices
       and (new.max_devices is null or new.max_devices < 2 or new.max_devices > 10) then
      raise exception 'PIA: an administrator''s device limit must be between 2 and 10.' using errcode = '23514';
    end if;
    -- A direct write would leave the sign-in account on the old address.
    if current_user = 'authenticated' and new.email is distinct from old.email then
      perform public.pia_refuse(v_actor, 'change their own email here', old.email);
    end if;
    return new;
  end if;

  -- Not an admin row. Promotion makes a new administrator out of an existing
  -- participant or professor; new administrators come only from "Add
  -- administrator", which creates a fresh account.
  if v_new_adm then
    perform public.pia_refuse(v_actor, 'promote an existing account to administrator', old.email);
  end if;
  return new;
end;
$$;

-- Runs before the older write guard (triggers fire in name order), so an
-- admin's own refusal message is the one that comes back.
drop trigger if exists trg_admin_boundaries on public.profiles;
create trigger trg_admin_boundaries
  before insert or update or delete on public.profiles
  for each row execute function public.pia_admin_boundaries();


-- ---------------------------------------------------------------------------
-- 4. The audit trigger
-- ---------------------------------------------------------------------------
create or replace function public.pia_audit_profiles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  text := lower(nullif(auth.jwt() ->> 'email', ''));
  v_arole  text;
  v_old    jsonb;
  v_new    jsonb;
  v_target text;
  v_owner  boolean;
  v_admin  boolean;
  v_gone   jsonb;
begin
  if v_actor is not null then v_arole := public.pia_caller_role(); end if;

  if tg_op = 'INSERT' then
    if lower(trim(coalesce(new.role, ''))) in ('admin', 'teacher') then
      insert into public.security_audit_log (actor_email, actor_role, action, target_email, detail)
      values (v_actor, v_arole, 'account.created', new.email,
              jsonb_build_object('role', lower(trim(new.role))));
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into public.security_audit_log (actor_email, actor_role, action, target_email, detail)
    values (v_actor, v_arole, 'account.deleted', old.email,
            jsonb_build_object('role', lower(trim(coalesce(old.role, 'student')))));
    return old;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  v_target := new.email;
  v_owner := v_actor is not null and lower(old.email) = v_actor;
  v_admin := lower(trim(coalesce(old.role, ''))) = 'admin';

  if (v_old ->> 'role') is distinct from (v_new ->> 'role') then
    insert into public.security_audit_log (actor_email, actor_role, action, target_email, detail)
    values (v_actor, v_arole, 'role.changed', v_target,
            jsonb_build_object('from', v_old ->> 'role', 'to', v_new ->> 'role'));
  end if;

  if (v_old -> 'max_devices') is distinct from (v_new -> 'max_devices') then
    insert into public.security_audit_log (actor_email, actor_role, action, target_email, detail)
    values (v_actor, v_arole, 'device_limit.changed', v_target,
            jsonb_build_object('from', v_old -> 'max_devices', 'to', v_new -> 'max_devices'));
  end if;

  if (v_old ->> 'email') is distinct from (v_new ->> 'email') then
    insert into public.security_audit_log (actor_email, actor_role, action, target_email, detail)
    values (v_actor, v_arole, 'email.changed', v_target,
            jsonb_build_object('from', v_old ->> 'email', 'to', v_new ->> 'email'));
  end if;

  -- Ordinary sign-ins and sign-outs change these on every student's own row;
  -- only an administrator's row, or someone else acting on the row, is logged.
  if v_admin or not v_owner then
    select coalesce(jsonb_agg(d), '[]'::jsonb) into v_gone
      from jsonb_array_elements_text(coalesce(v_old -> 'active_devices', '[]'::jsonb)) d
     where not (coalesce(v_new -> 'active_devices', '[]'::jsonb) ? d);
    if jsonb_array_length(v_gone) > 0 then
      insert into public.security_audit_log (actor_email, actor_role, action, target_email, detail)
      values (v_actor, v_arole, 'devices.removed', v_target, jsonb_build_object('devices', v_gone));
    end if;

    if (v_old -> 'sessions_revoked_at') is distinct from (v_new -> 'sessions_revoked_at') then
      insert into public.security_audit_log (actor_email, actor_role, action, target_email, detail)
      values (v_actor, v_arole, 'sessions.revoked', v_target, '{}'::jsonb);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_audit_profiles on public.profiles;
create trigger trg_audit_profiles
  after insert or update or delete on public.profiles
  for each row execute function public.pia_audit_profiles();


-- ---------------------------------------------------------------------------
-- 5. The same rule at the top of the admin RPCs that name a target account
-- ---------------------------------------------------------------------------
create or replace function public.pia_protect_admin_target(p_target text, p_action text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor  text := lower(nullif(auth.jwt() ->> 'email', ''));
  v_target text := lower(trim(coalesce(p_target, '')));
begin
  if v_actor is null or v_target = '' or v_target = v_actor then
    return;   -- the owner, or one's own account (each RPC's own rules apply)
  end if;
  if exists (select 1 from public.profiles
              where lower(email) = v_target and lower(trim(coalesce(role, ''))) = 'admin') then
    perform public.pia_refuse(v_actor, p_action || ' another administrator', v_target);
  end if;
end;
$$;

revoke all on function public.pia_refuse(text, text, text)             from public, anon, authenticated;
revoke all on function public.pia_admin_boundaries()                   from public, anon, authenticated;
revoke all on function public.pia_audit_profiles()                     from public, anon, authenticated;
revoke all on function public.pia_protect_admin_target(text, text)     from public, anon, authenticated;

do $$
declare
  spec     text[];
  r        record;
  v_def    text;
  v_head   text;
  v_body   text;
  v_new    text;
  v_marker int;
  v_done   int := 0;
begin
  foreach spec slice 1 in array array[
    array['admin_delete_user',        'target_email', 'remove'],
    array['admin_revoke_sessions',    'p_email',      'sign out'],
    array['admin_revoke_device',      'p_email',      'revoke the devices of'],
    array['admin_update_user_email',  'target_email', 'change the email of'],
    array['admin_create_auth_user',   'target_email', 'reset the sign-in account of']
  ] loop
    for r in
      select p.oid, p.proname, p.proargnames, l.lanname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_language l on l.oid = p.prolang
       where n.nspname = 'public' and p.proname = spec[1]
    loop
      if not (spec[2] = any(coalesce(r.proargnames, array[]::text[]))) then
        raise notice 'PIA 0031: %(%) has no parameter named % -- not guarded.', r.proname, r.oid::regprocedure, spec[2];
        continue;
      end if;
      if r.lanname <> 'plpgsql' then
        raise exception 'PIA 0031 ABORT: % is written in %, so the guard cannot be inserted. Rolling back.',
          r.oid::regprocedure, r.lanname using errcode = 'P0001';
      end if;

      v_def := pg_get_functiondef(r.oid);
      if position('pia_protect_admin_target' in v_def) > 0 then
        raise notice 'PIA 0031: % is already guarded.', r.oid::regprocedure;
        v_done := v_done + 1;
        continue;
      end if;

      -- The first BEGIN of the body, i.e. after the header's AS $function$.
      v_marker := position('$function$' in v_def);
      if v_marker = 0 then
        raise exception 'PIA 0031 ABORT: cannot find the body of %. Rolling back.', r.oid::regprocedure
          using errcode = 'P0001';
      end if;
      v_head := left(v_def, v_marker + length('$function$') - 1);
      v_body := substr(v_def, v_marker + length('$function$'));
      v_new  := regexp_replace(v_body, '\m(begin)\M',
                  format(E'\\1\n  perform public.pia_protect_admin_target(%s, %L);', spec[2], spec[3]), 'i');
      if v_new = v_body then
        raise exception 'PIA 0031 ABORT: no BEGIN found in %. Rolling back.', r.oid::regprocedure using errcode = 'P0001';
      end if;

      execute v_head || v_new;
      v_done := v_done + 1;
      raise notice 'PIA 0031: % now refuses to act on another administrator.', r.oid::regprocedure;
    end loop;
  end loop;

  if v_done = 0 then
    raise notice 'PIA 0031: none of the admin RPCs was found to guard.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT -- as a real admin, against a temporary second admin. Rolled back.
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin   text;
  v_other   text := 'pia-0031-probe-admin@example.invalid';
  v_student text;
  v_iat     bigint := extract(epoch from clock_timestamp())::bigint + 5;
  v_rows    int;
  v_fail    text := '';
  v_step    text;
  v_logged  int;
begin
  if has_table_privilege('authenticated', 'public.security_audit_log', 'INSERT')
     or has_table_privilege('authenticated', 'public.security_audit_log', 'UPDATE')
     or has_table_privilege('authenticated', 'public.security_audit_log', 'DELETE') then
    raise exception 'PIA 0031 ABORT: signed-in users can write the audit log.' using errcode = 'P0001';
  end if;

  select email into v_admin from public.profiles
   where lower(trim(role)) = 'admin' order by email limit 1;
  select email into v_student from public.profiles
   where lower(trim(coalesce(role, 'student'))) = 'student' order by email limit 1;

  if v_admin is null then
    raise notice 'PIA 0031: no administrator to rehearse with -- skipped.';
    return;
  end if;

  begin
    -- The other administrator, created by the owner (no signed-in user).
    perform set_config('request.jwt.claims', '', true);
    insert into public.profiles (email, full_name, role, status, max_devices)
    values (v_other, 'PIA 0031 probe', 'admin', 'active', 1);
    if (select max_devices from public.profiles where email = v_other) <> 2 then
      v_fail := v_fail || 'a new admin row kept a limit below 2; ';
    end if;

    perform set_config('request.jwt.claims', json_build_object(
      'email', v_admin, 'role', 'authenticated', 'iat', v_iat)::text, true);
    execute 'set local role authenticated';

    -- Each attempt on the other admin must be refused.
    foreach v_step in array array[
      format('update public.profiles set max_devices = 1 where email = %L', v_other),
      format('update public.profiles set role = %L where email = %L', 'student', v_other),
      format('update public.profiles set active_devices = %L where email = %L', '{pia-0031-probe-device}', v_other),
      format('delete from public.profiles where email = %L', v_other),
      format('select public.admin_delete_user(%L)', v_other),
      format('select public.admin_revoke_sessions(%L)', v_other),
      format('select public.admin_revoke_device(%L, null)', v_other),
      format('update public.profiles set role = %L where email = %L', 'student', v_admin),
      format('update public.profiles set max_devices = 1 where email = %L', v_admin)
    ] loop
      begin
        execute v_step;
        get diagnostics v_rows = row_count;
        -- A function that is not installed raises 42883 and lands below.
        v_fail := v_fail || 'NOT refused: ' || v_step || '; ';
      exception
        when insufficient_privilege or check_violation then null;       -- refused, as it should be
        when undefined_function then null;                              -- that RPC is not installed
      end;
    end loop;

    if v_student is not null then
      begin
        execute format('update public.profiles set role = %L where email = %L', 'admin', v_student);
        v_fail := v_fail || 'NOT refused: promoting a student to admin; ';
      exception when insufficient_privilege then null;
      end;
    end if;

    -- What an admin may still do: their own limit, within 2..10.
    update public.profiles set max_devices = 3 where email = v_admin;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then v_fail := v_fail || 'an admin could not set their own limit to 3; '; end if;

    execute 'reset role';

    select count(*) into v_logged from public.security_audit_log
     where action = 'device_limit.changed' and lower(target_email) = lower(v_admin)
       and lower(actor_email) = lower(v_admin) and at >= now();
    if v_logged < 1 then v_fail := v_fail || 'the own-limit change was not audited; '; end if;

    select count(*) into v_logged from public.security_audit_log
     where action = 'account.created' and target_email = v_other and actor_email is null;
    if v_logged < 1 then v_fail := v_fail || 'the new admin was not audited; '; end if;

    -- The owner can still do anything, including demoting that admin.
    perform set_config('request.jwt.claims', '', true);
    update public.profiles set role = 'student' where email = v_other;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then v_fail := v_fail || 'the project owner could not change an admin; '; end if;

    if v_fail <> '' then
      raise exception 'PIA 0031 ABORT: %', v_fail using errcode = 'P0001';
    end if;
    raise exception 'rehearsal done' using errcode = 'P0002';
  exception
    when sqlstate 'P0002' then
      raise notice 'PIA 0031 OK: another administrator cannot be changed, demoted, removed, signed out or have devices revoked; promotion and self-demotion are refused; an admin sets only their own limit (2..10); changes are audited; the project owner is unrestricted.';
  end;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Report
select p.oid::regprocedure::text as function,
       case when pg_get_functiondef(p.oid) ~ 'pia_protect_admin_target' then 'guarded' else 'NOT guarded' end as guard
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('admin_delete_user', 'admin_revoke_sessions', 'admin_revoke_device',
                     'admin_update_user_email', 'admin_create_auth_user')
 order by 1;
