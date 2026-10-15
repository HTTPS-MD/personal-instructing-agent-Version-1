-- ============================================================================
-- PIA 0052 -- STUDENT-NUMBER DOOR: CHECK-IN, REQUESTS THE ADMIN LETS IN
-- ============================================================================
-- Students stop signing in with an email and password. In the computer lab they
-- type their student number, confirm their name, and WAIT. An admin who can see
-- the lab ticks the students they see and lets them in; only then does the
-- student's own browser receive a session for their EXISTING account (the
-- join-with-number Edge Function). Nothing about profiles, RLS, stages or the
-- one-device rule changes.
--
-- Everything here is ADMIN-controlled. Teachers are spectators and get no
-- function that changes anything.
--
--   student_numbers   email -> 11-digit student number. A separate table, not a
--                     column on profiles, so a student's own profile policy can
--                     never reach it.
--   checkins          one OPEN row per section at most. While no check-in is open
--                     the door answers every number the same way and reads no name.
--   join_requests     one row per "let me in": section, a hash of the secret the
--                     student's browser made, waiting | let_in, delivered once.
--   join_attempts     failed tries, for rate limiting (kept one day).
--
--   admin_start_checkin(section, minutes)   5 to 120 minutes, then it closes itself
--   admin_stop_checkin(section)             the door closes; people already in go on
--   admin_checkin_overview()                sections, open check-ins, who is waiting
--   admin_let_in(ids uuid[])                lets in the ticked requests
--   admin_set_student_number(email, number)
--   admin_import_student_numbers(rows jsonb)   [{email, number}, ...]
--
-- All four tables have RLS on and NO policies: only the service role (the Edge
-- Function) and the security-definer functions below can touch them.
--
-- Requires pia_caller_role() / jwt_is_current() / current_email() (0031, 0051).
-- SAFE TO RE-RUN. No existing table or row is changed.
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.pia_caller_role()') is null
     or to_regprocedure('public.jwt_is_current()') is null
     or to_regprocedure('public.current_email()') is null then
    raise exception 'PIA 0052 ABORT (nothing changed): pia_caller_role() / jwt_is_current() / current_email() are missing -- apply 0031 first.'
      using errcode = 'P0001';
  end if;
end;
$$;

create table if not exists public.student_numbers (
  email      text primary key,
  number_key text not null unique check (number_key ~ '^[0-9]{11}$'),
  number     text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.checkins (
  id         uuid primary key default gen_random_uuid(),
  section    text not null,
  started_at timestamptz not null default now(),
  ends_at    timestamptz not null,
  stopped_at timestamptz,
  started_by text
);
create unique index if not exists checkins_one_open_per_section
  on public.checkins (section) where stopped_at is null;

create table if not exists public.join_requests (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  section     text not null,
  secret_hash text not null,
  status      text not null default 'waiting' check (status in ('waiting', 'let_in')),
  created_at  timestamptz not null default now(),
  let_in_at   timestamptz,
  delivered   boolean not null default false
);
create index if not exists join_requests_waiting_idx on public.join_requests (status, created_at desc);

create table if not exists public.join_attempts (
  id  bigserial primary key,
  key text        not null,
  ok  boolean     not null,
  at  timestamptz not null default now()
);
create index if not exists join_attempts_key_at_idx on public.join_attempts (key, at desc);

alter table public.student_numbers enable row level security;
alter table public.checkins        enable row level security;
alter table public.join_requests   enable row level security;
alter table public.join_attempts   enable row level security;

revoke all on public.student_numbers, public.checkins, public.join_requests, public.join_attempts
  from public, anon, authenticated;
revoke all on sequence public.join_attempts_id_seq from public, anon, authenticated;


create or replace function public.pia_number_key(p_number text)
returns text
language sql
immutable
set search_path = public
as $$ select regexp_replace(coalesce(p_number, ''), '[^0-9]', '', 'g') $$;
revoke all on function public.pia_number_key(text) from public, anon;
grant execute on function public.pia_number_key(text) to authenticated, service_role;


create or replace function public.pia_require_admin()
returns void
language plpgsql
set search_path = public
as $$
begin
  if public.pia_caller_role() is distinct from 'admin' or not public.jwt_is_current() then
    raise exception 'PIA: only an administrator can do this.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.pia_require_admin() from public, anon;
grant execute on function public.pia_require_admin() to authenticated;


create or replace function public.admin_start_checkin(p_section text, p_minutes int default 15)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_section text := trim(p_section);
  v_id      uuid;
begin
  perform public.pia_require_admin();
  if nullif(v_section, '') is null then
    raise exception 'PIA: choose a section.' using errcode = 'P0001';
  end if;
  if p_minutes is null or p_minutes < 5 or p_minutes > 120 then
    raise exception 'PIA: check-in stays open between 5 and 120 minutes.' using errcode = 'P0001';
  end if;

  update public.checkins set stopped_at = now() where section = v_section and stopped_at is null;
  insert into public.checkins (section, ends_at, started_by)
  values (v_section, now() + make_interval(mins => p_minutes), public.current_email())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.admin_stop_checkin(p_section text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pia_require_admin();
  update public.checkins set stopped_at = now() where section = trim(p_section) and stopped_at is null;
end;
$$;

-- Lets in the ticked requests. Only a request that is still waiting, under 20
-- minutes old, for a section whose check-in is still open.
create or replace function public.admin_let_in(p_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  perform public.pia_require_admin();
  update public.join_requests r
     set status = 'let_in', let_in_at = now()
   where r.id = any (coalesce(p_ids, '{}'))
     and r.status = 'waiting'
     and r.created_at > now() - interval '20 minutes'
     and exists (select 1 from public.checkins c
                  where c.section = r.section and c.stopped_at is null and c.ends_at > now());
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.admin_set_student_number(p_email text, p_number text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := public.pia_number_key(p_number);
begin
  perform public.pia_require_admin();
  if v_key !~ '^[0-9]{11}$' then
    raise exception 'PIA: a student number has 11 digits.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where lower(email) = lower(trim(p_email))) then
    raise exception 'PIA: no student is registered with that email.' using errcode = 'P0002';
  end if;
  insert into public.student_numbers (email, number_key, number)
  values (lower(trim(p_email)), v_key, trim(p_number))
  on conflict (email) do update set number_key = excluded.number_key, number = excluded.number, updated_at = now();
end;
$$;

create or replace function public.admin_import_student_numbers(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_count int := 0;
begin
  perform public.pia_require_admin();
  for r in select * from jsonb_to_recordset(p_rows) as x(email text, number text) loop
    perform public.admin_set_student_number(r.email, r.number);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.admin_checkin_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pia_require_admin();

  -- Housekeeping: nothing older than a day is of any use.
  delete from public.join_requests where created_at < now() - interval '1 day';
  delete from public.join_attempts where at < now() - interval '1 day';

  return jsonb_build_object(
    'sections', coalesce((
      select jsonb_agg(jsonb_build_object(
               'section', s.section, 'students', s.n, 'without_number', s.missing) order by s.section)
        from (select trim(p.section) as section, count(*) as n,
                     count(*) filter (where sn.email is null) as missing
                from public.profiles p
                left join public.student_numbers sn on sn.email = lower(p.email)
               where lower(trim(coalesce(p.role, 'student'))) = 'student' and nullif(trim(p.section), '') is not null
               group by trim(p.section)) s), '[]'::jsonb),
    'open', coalesce((
      select jsonb_agg(jsonb_build_object('section', c.section, 'ends_at', c.ends_at) order by c.section)
        from public.checkins c where c.stopped_at is null and c.ends_at > now()), '[]'::jsonb),
    'waiting', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'section', w.section, 'full_name', w.full_name, 'created_at', w.created_at,
               'duplicate', w.dupes > 1) order by w.created_at)
        from (select r.id, r.section, p.full_name, r.created_at,
                     count(*) over (partition by r.email) as dupes
                from public.join_requests r
                left join public.profiles p on lower(p.email) = r.email
               where r.status = 'waiting' and r.created_at > now() - interval '20 minutes'
                 and exists (select 1 from public.checkins c
                              where c.section = r.section and c.stopped_at is null and c.ends_at > now())) w),
      '[]'::jsonb));
end;
$$;

revoke all on function public.admin_start_checkin(text, int), public.admin_stop_checkin(text),
  public.admin_let_in(uuid[]), public.admin_set_student_number(text, text),
  public.admin_import_student_numbers(jsonb), public.admin_checkin_overview() from public, anon;
grant execute on function public.admin_start_checkin(text, int), public.admin_stop_checkin(text),
  public.admin_let_in(uuid[]), public.admin_set_student_number(text, text),
  public.admin_import_student_numbers(jsonb), public.admin_checkin_overview() to authenticated;


do $$
begin
  if has_table_privilege('anon', 'public.student_numbers', 'select')
     or has_table_privilege('authenticated', 'public.student_numbers', 'select')
     or has_table_privilege('authenticated', 'public.checkins', 'select')
     or has_table_privilege('authenticated', 'public.join_requests', 'select')
     or has_table_privilege('authenticated', 'public.join_attempts', 'select') then
    raise exception 'PIA 0052 ABORT: a door table is readable by anon or authenticated.' using errcode = 'P0001';
  end if;
  raise notice 'PIA 0052 OK: student numbers, check-in and join requests are admin-only. Load the numbers with admin_import_student_numbers().';
end;
$$;

commit;

-- ROLLBACK (only if nothing depends on it):
--   drop function if exists public.admin_checkin_overview(), public.admin_import_student_numbers(jsonb),
--     public.admin_set_student_number(text, text), public.admin_let_in(uuid[]),
--     public.admin_stop_checkin(text), public.admin_start_checkin(text, int),
--     public.pia_require_admin(), public.pia_number_key(text);
--   drop table if exists public.join_attempts, public.join_requests, public.checkins, public.student_numbers;
