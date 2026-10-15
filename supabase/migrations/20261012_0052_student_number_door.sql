-- ============================================================================
-- PIA 0052 -- STUDENT-NUMBER DOOR: OPEN CLASS, ATTENDANCE, STUDENT NUMBERS
-- ============================================================================
-- Students stop signing in with an email and password. In the computer lab they
-- type their student number; the join-with-number Edge Function opens a session
-- for their EXISTING account when ALL of these hold:
--   1. the number is on the roster (student_numbers),
--   2. the admin has opened a class for the student's section and it has not
--      closed (class_sessions),
--   3. the admin has not marked the student absent for it (class_attendance).
-- Nothing about profiles, RLS, stages or the one-device rule changes.
--
-- Everything here is ADMIN-controlled. Teachers are spectators and get no
-- function that changes anything.
--
--   student_numbers   email -> student number. A separate table, not a column
--                     on profiles, so a student's own profile policy can never
--                     reach it. RLS on, no policies.
--   class_sessions    one OPEN row per section at most (closed_at is null).
--   class_attendance  one row per student per class; present by default.
--   join_attempts     failed / successful tries, for rate limiting.
--
--   admin_open_class(section, minutes)      opens it; everyone present.
--   admin_close_class(section)
--   admin_set_attendance(class_id, email, present)
--   admin_set_student_number(email, number)
--   admin_import_student_numbers(rows jsonb)   [{email, number}, ...]
--   admin_class_overview()                  open classes + attendance, for the page
--
-- Requires pia_caller_role() / jwt_is_current() (0031).
-- SAFE TO RE-RUN. No existing table or row is changed.
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.pia_caller_role()') is null
     or to_regprocedure('public.jwt_is_current()') is null then
    raise exception 'PIA 0052 ABORT (nothing changed): pia_caller_role() / jwt_is_current() are missing -- apply 0031 first.'
      using errcode = 'P0001';
  end if;
end;
$$;

create table if not exists public.student_numbers (
  email      text primary key,
  number_key text not null unique check (number_key ~ '^[A-Z0-9]{4,24}$'),
  number     text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.class_sessions (
  id         uuid primary key default gen_random_uuid(),
  section    text not null,
  opened_at  timestamptz not null default now(),
  closes_at  timestamptz not null,
  closed_at  timestamptz,
  opened_by  text
);
create unique index if not exists class_sessions_one_open_per_section
  on public.class_sessions (section) where closed_at is null;

create table if not exists public.class_attendance (
  class_id uuid not null references public.class_sessions (id) on delete cascade,
  email    text not null,
  present  boolean not null default true,
  primary key (class_id, email)
);

create table if not exists public.join_attempts (
  id  bigserial primary key,
  key text        not null,
  ok  boolean     not null,
  at  timestamptz not null default now()
);
create index if not exists join_attempts_key_at_idx on public.join_attempts (key, at desc);

alter table public.student_numbers   enable row level security;
alter table public.class_sessions    enable row level security;
alter table public.class_attendance  enable row level security;
alter table public.join_attempts     enable row level security;

revoke all on public.student_numbers, public.class_sessions, public.class_attendance, public.join_attempts
  from public, anon, authenticated;
revoke all on sequence public.join_attempts_id_seq from public, anon, authenticated;


create or replace function public.pia_number_key(p_number text)
returns text
language sql
immutable
set search_path = public
as $$ select upper(regexp_replace(coalesce(p_number, ''), '[^A-Za-z0-9]', '', 'g')) $$;
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


create or replace function public.admin_open_class(p_section text, p_minutes int default 120)
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
  if p_minutes is null or p_minutes < 15 or p_minutes > 480 then
    raise exception 'PIA: a class stays open between 15 minutes and 8 hours.' using errcode = 'P0001';
  end if;

  update public.class_sessions set closed_at = now()
   where section = v_section and closed_at is null;

  insert into public.class_sessions (section, closes_at, opened_by)
  values (v_section, now() + make_interval(mins => p_minutes), public.current_email())
  returning id into v_id;

  insert into public.class_attendance (class_id, email, present)
  select v_id, p.email, true
    from public.profiles p
   where trim(p.section) = v_section
     and lower(trim(coalesce(p.role, 'student'))) = 'student'
     and p.email is not null;

  return v_id;
end;
$$;

create or replace function public.admin_close_class(p_section text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pia_require_admin();
  update public.class_sessions set closed_at = now()
   where section = trim(p_section) and closed_at is null;
end;
$$;

create or replace function public.admin_set_attendance(p_class uuid, p_email text, p_present boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pia_require_admin();
  insert into public.class_attendance (class_id, email, present)
  values (p_class, lower(trim(p_email)), coalesce(p_present, true))
  on conflict (class_id, email) do update set present = excluded.present;
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
  if v_key !~ '^[A-Z0-9]{4,24}$' then
    raise exception 'PIA: a student number has 4 to 24 letters and digits.' using errcode = 'P0001';
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

create or replace function public.admin_class_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pia_require_admin();
  return jsonb_build_object(
    'sections', coalesce((
      select jsonb_agg(jsonb_build_object('section', s.section, 'students', s.n) order by s.section)
        from (select trim(section) as section, count(*) as n
                from public.profiles
               where lower(trim(coalesce(role, 'student'))) = 'student' and nullif(trim(section), '') is not null
               group by trim(section)) s), '[]'::jsonb),
    'open', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'section', c.section, 'closes_at', c.closes_at,
               'students', (
                 select jsonb_agg(jsonb_build_object(
                          'email', p.email, 'full_name', p.full_name,
                          'number', n.number, 'present', coalesce(a.present, true)) order by p.full_name)
                   from public.profiles p
                   left join public.student_numbers n on n.email = lower(p.email)
                   left join public.class_attendance a on a.class_id = c.id and a.email = lower(p.email)
                  where trim(p.section) = c.section
                    and lower(trim(coalesce(p.role, 'student'))) = 'student')
             ) order by c.section)
        from public.class_sessions c
       where c.closed_at is null and c.closes_at > now()), '[]'::jsonb));
end;
$$;

revoke all on function public.admin_open_class(text, int), public.admin_close_class(text),
  public.admin_set_attendance(uuid, text, boolean), public.admin_set_student_number(text, text),
  public.admin_import_student_numbers(jsonb), public.admin_class_overview() from public, anon;
grant execute on function public.admin_open_class(text, int), public.admin_close_class(text),
  public.admin_set_attendance(uuid, text, boolean), public.admin_set_student_number(text, text),
  public.admin_import_student_numbers(jsonb), public.admin_class_overview() to authenticated;


do $$
begin
  if has_table_privilege('anon', 'public.student_numbers', 'select')
     or has_table_privilege('authenticated', 'public.student_numbers', 'select')
     or has_table_privilege('authenticated', 'public.class_sessions', 'select')
     or has_table_privilege('authenticated', 'public.class_attendance', 'select') then
    raise exception 'PIA 0052 ABORT: a door table is readable by anon or authenticated.' using errcode = 'P0001';
  end if;
  raise notice 'PIA 0052 OK: student numbers, open class and attendance are admin-only. Import the numbers with admin_import_student_numbers().';
end;
$$;

commit;

-- ROLLBACK (only if nothing depends on it):
--   drop function if exists public.admin_class_overview(), public.admin_import_student_numbers(jsonb),
--     public.admin_set_student_number(text, text), public.admin_set_attendance(uuid, text, boolean),
--     public.admin_close_class(text), public.admin_open_class(text, int),
--     public.pia_require_admin(), public.pia_number_key(text);
--   drop table if exists public.join_attempts, public.class_attendance, public.class_sessions, public.student_numbers;
