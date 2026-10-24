-- PIA 0064: the teacher sees their section's roster, read-only, and nothing sensitive.
--
-- WHY. The teacher console is being rebuilt in the homepage look as a plain roster: who is in the
-- section, who is online, where they are, and (while a roll call is open) who the admin marked
-- present. A teacher cannot read student rows directly (0026), so this one function is the only
-- door, and it returns ONLY these columns:
--
--   student_key   an opaque id (md5 of the email), never the email
--   full_name     the student's name
--   online        reported in within the last 2 minutes
--   stage         'waiting' | 'setting_up' | 'tutoring'. OCEAN and Character Selection are one label
--                 ("setting_up") because Character Selection would reveal the research group.
--   attendance    'present' | 'absent' | 'not_marked' while a roll call is open for the section,
--                 otherwise null
--
-- It returns NO student number, no email, no OCEAN result, no research group, no tutor persona,
-- no score, no answer and no lesson progress. A teacher can only call it for their own section.
-- Read-only: it changes nothing.
--
-- teacher_class_status (0026) stays as it is; the new teacher page no longer uses it.
-- Requires 0026 (student_presence), 0052 (checkins) and 0058 (attendance_marks). SAFE TO RE-RUN.
begin;

do $$
begin
  if to_regclass('public.student_presence') is null
     or to_regclass('public.checkins') is null
     or to_regclass('public.attendance_marks') is null
     or to_regprocedure('public.pia_caller_role()') is null
     or to_regprocedure('public.jwt_is_current()') is null then
    raise exception 'PIA 0064 ABORT (nothing changed): apply 0026, 0052 and 0058 first.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.teacher_section_roster()
returns table (
  student_key text,
  full_name   text,
  online      boolean,
  stage       text,
  attendance  text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email   text := lower(auth.jwt() ->> 'email');
  v_section text;
  v_checkin uuid;
begin
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;
  if public.pia_caller_role() is distinct from 'teacher' then
    raise exception 'PIA: only a teacher can view a class.' using errcode = '42501';
  end if;

  -- The teacher's own section: their profile, else the faculty record the admin assigned.
  select coalesce(
           nullif(trim(p.section), ''),
           (select nullif(trim(f.assigned_section), '') from public.professors f
             where lower(f.email) = v_email limit 1))
    into v_section
    from public.profiles p
   where lower(p.email) = v_email
   limit 1;

  if v_section is null then
    return;
  end if;

  select c.id into v_checkin
    from public.checkins c
   where c.section = v_section and c.stopped_at is null and c.ends_at > now()
   order by c.started_at desc
   limit 1;

  return query
    select md5(lower(p.email)),
           coalesce(nullif(trim(p.full_name), ''), 'Unnamed student'),
           coalesce(sp.last_seen > now() - interval '2 minutes', false),
           case p.current_stage
             when 'OCEAN'               then 'setting_up'
             when 'Character Selection' then 'setting_up'
             when 'Tutoring Dashboard'  then 'tutoring'
             else 'waiting'
           end,
           case when v_checkin is null then null
                else coalesce((select case when m.present then 'present' else 'absent' end
                                 from public.attendance_marks m
                                where m.checkin_id = v_checkin and lower(m.email) = lower(p.email)),
                              'not_marked')
           end
      from public.profiles p
      left join public.student_presence sp on lower(sp.student_email) = lower(p.email)
     where p.section = v_section
       and lower(trim(coalesce(p.role, 'student'))) = 'student'
     order by p.full_name;
end;
$$;

revoke all on function public.teacher_section_roster() from public, anon;
grant execute on function public.teacher_section_roster() to authenticated;

commit;
