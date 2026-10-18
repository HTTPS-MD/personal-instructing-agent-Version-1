-- ============================================================================
-- PIA 0058 -- ROLL CALL: THE ADMIN MARKS WHO IS PRESENT, THE STUDENT WALKS IN
-- ============================================================================
-- Replaces "ask to be let in, wait, get ticked" with a roll call. While an
-- attendance is open the admin marks each student present (check) or absent
-- (cross). A student marked present who types their number goes straight into
-- the game; anyone else is told to see the admin. A number gets in ONCE per
-- attendance: a second computer is refused and the row shows it, and the admin
-- can let that student back in.
--
--   attendance_marks                      one row per student per attendance
--   admin_set_attendance(section, email, present)   true / false, null clears
--   admin_attendance(section)             marks of the open attendance
--   admin_let_back_in(section, email)     lets a refused student try again
--
-- Requires 0052. SAFE TO RE-RUN. The old request tables are left alone.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.checkins') is null
     or to_regprocedure('public.pia_require_admin()') is null then
    raise exception 'PIA 0058 ABORT (nothing changed): apply 0052 first.' using errcode = 'P0001';
  end if;
end;
$$;

create table if not exists public.attendance_marks (
  checkin_id    uuid        not null,
  email         text        not null,
  present       boolean     not null,
  entered_at    timestamptz,
  refused_count int         not null default 0,
  marked_at     timestamptz not null default now(),
  primary key (checkin_id, email)
);
alter table public.attendance_marks enable row level security;
revoke all on public.attendance_marks from public, anon, authenticated;

create or replace function public.admin_set_attendance(p_section text, p_email text, p_present boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  perform public.pia_require_admin();
  select c.id into v_id from public.checkins c
   where c.section = trim(p_section) and c.stopped_at is null and c.ends_at > now();
  if v_id is null then
    raise exception 'Attendance is not open for this section.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles p
                  where lower(p.email) = v_email and trim(p.section) = trim(p_section)
                    and lower(trim(coalesce(p.role, 'student'))) = 'student') then
    raise exception 'That student is not in this section.' using errcode = 'P0001';
  end if;
  if p_present is null then
    delete from public.attendance_marks where checkin_id = v_id and email = v_email;
  else
    insert into public.attendance_marks (checkin_id, email, present)
    values (v_id, v_email, p_present)
    on conflict (checkin_id, email) do update set present = excluded.present, marked_at = now();
  end if;
end;
$$;

create or replace function public.admin_attendance(p_section text)
returns table (email text, present boolean, entered boolean, refused int)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pia_require_admin();
  return query
    select m.email, m.present, (m.entered_at is not null), m.refused_count
      from public.attendance_marks m
      join public.checkins c on c.id = m.checkin_id
     where c.section = trim(p_section) and c.stopped_at is null and c.ends_at > now();
end;
$$;

create or replace function public.admin_let_back_in(p_section text, p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pia_require_admin();
  update public.attendance_marks m
     set entered_at = null, refused_count = 0
    from public.checkins c
   where c.id = m.checkin_id and c.section = trim(p_section)
     and c.stopped_at is null and c.ends_at > now()
     and m.email = lower(trim(coalesce(p_email, '')));
end;
$$;

revoke all on function public.admin_set_attendance(text, text, boolean) from public, anon;
revoke all on function public.admin_attendance(text) from public, anon;
revoke all on function public.admin_let_back_in(text, text) from public, anon;
grant execute on function public.admin_set_attendance(text, text, boolean) to authenticated;
grant execute on function public.admin_attendance(text) to authenticated;
grant execute on function public.admin_let_back_in(text, text) to authenticated;

commit;

-- ROLLBACK: drop function if exists public.admin_set_attendance(text,text,boolean);
--   drop function if exists public.admin_attendance(text);
--   drop function if exists public.admin_let_back_in(text,text);
--   drop table if exists public.attendance_marks;
