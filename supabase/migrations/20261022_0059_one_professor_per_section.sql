-- ============================================================================
-- PIA 0059 -- ONE PROFESSOR PER SECTION, A PROFESSOR MAY HAVE SEVERAL SECTIONS
-- ============================================================================
-- Until now a professor had ONE section (professors.assigned_section) and two
-- professors could share a section. Now:
--
--   professor_sections (email, section)   section is UNIQUE: one professor per
--                                         section; an email may appear many times
--
--   admin_set_section_professor(section, email)   give a section to a professor,
--                                         or clear it (email null). Admin only.
--   admin_professor_sections()            every (professor, section) pair. Admin only.
--   teacher_my_sections()                 the caller's sections and the one in use.
--   teacher_set_section(section)          a teacher switches the section they are
--                                         looking at (only one of their own).
--
-- NOTHING ABOUT WHAT A TEACHER CAN SEE CHANGES. teacher_class_status() (0026) still
-- reads the teacher's profiles.section; switching section just moves that value
-- among the sections the admin gave them. professors.assigned_section is kept as
-- the professor's first section, so everything that reads it keeps working.
--
-- A section that already has a professor cannot be given to a second one.
--
-- 0057 is replaced here so that deleting or renaming a section also looks at
-- professor_sections.
--
-- Requires 0052 and 0057. SAFE TO RE-RUN.
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.pia_require_admin()') is null
     or to_regclass('public.professors') is null
     or to_regprocedure('public.admin_delete_section(text)') is null then
    raise exception 'PIA 0059 ABORT (nothing changed): apply 0052 and 0057 first.' using errcode = 'P0001';
  end if;
end;
$$;

create table if not exists public.professor_sections (
  email   text not null,
  section text not null,
  primary key (email, section),
  unique (section)
);
alter table public.professor_sections enable row level security;
revoke all on public.professor_sections from public, anon, authenticated;

-- One professor per section. Where two had the same section, the one who has a
-- teacher profile (can actually sign in) keeps it, else the first by email.
insert into public.professor_sections (email, section)
select distinct on (trim(f.assigned_section)) lower(f.email), trim(f.assigned_section)
  from public.professors f
  left join public.profiles p on lower(p.email) = lower(f.email) and lower(trim(p.role)) = 'teacher'
 where nullif(trim(f.assigned_section), '') is not null
 order by trim(f.assigned_section), (p.email is null), lower(f.email)
on conflict do nothing;

-- Keep a professor's assigned_section and the teacher profile's section in step with the table.
create or replace function public.pia_sync_professor(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_first text;
begin
  select ps.section into v_first from public.professor_sections ps where ps.email = v_email order by ps.section limit 1;
  update public.professors set assigned_section = v_first where lower(email) = v_email;
  update public.profiles p
     set section = case when exists (select 1 from public.professor_sections ps where ps.email = v_email and ps.section = p.section)
                        then p.section else v_first end
   where lower(p.email) = v_email and lower(trim(coalesce(p.role, ''))) = 'teacher';
end;
$$;
revoke all on function public.pia_sync_professor(text) from public, anon, authenticated;

do $$
declare r record;
begin
  for r in select lower(email) as email from public.professors loop
    perform public.pia_sync_professor(r.email);
  end loop;
end;
$$;

-- A professor added with a section (admin_register_teacher writes assigned_section) gets the row;
-- a section that already has someone else is refused.
create or replace function public.professors_claim_section()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_section text := nullif(trim(coalesce(new.assigned_section, '')), '');
begin
  if v_section is null then return new; end if;
  if exists (select 1 from public.professor_sections ps where ps.section = v_section and ps.email <> lower(new.email)) then
    raise exception 'That section already has a professor.' using errcode = 'P0001';
  end if;
  insert into public.professor_sections (email, section) values (lower(new.email), v_section) on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists professors_claim_section on public.professors;
create trigger professors_claim_section
  before insert or update of assigned_section on public.professors
  for each row execute function public.professors_claim_section();

create or replace function public.admin_set_section_professor(p_section text, p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_section text := trim(coalesce(p_section, ''));
  v_email   text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_old     text;
begin
  perform public.pia_require_admin();
  if not exists (select 1 from public.sections where name = v_section) then
    raise exception 'That section no longer exists.' using errcode = 'P0001';
  end if;
  if v_email is not null and not exists (select 1 from public.professors where lower(email) = v_email) then
    raise exception 'That professor was not found.' using errcode = 'P0001';
  end if;
  select ps.email into v_old from public.professor_sections ps where ps.section = v_section;
  delete from public.professor_sections where section = v_section;
  if v_email is not null then
    insert into public.professor_sections (email, section) values (v_email, v_section);
  end if;
  if v_old is not null then perform public.pia_sync_professor(v_old); end if;
  if v_email is not null then perform public.pia_sync_professor(v_email); end if;
end;
$$;

create or replace function public.admin_professor_sections()
returns table (email text, section text)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pia_require_admin();
  return query select ps.email, ps.section from public.professor_sections ps order by ps.section;
end;
$$;

create or replace function public.teacher_my_sections()
returns table (section text, in_use boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
begin
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;
  if public.pia_caller_role() is distinct from 'teacher' then
    raise exception 'PIA: only a teacher can do this.' using errcode = '42501';
  end if;
  return query
    select ps.section,
           coalesce(ps.section = (select p.section from public.profiles p where lower(p.email) = v_email limit 1), false)
      from public.professor_sections ps
     where ps.email = v_email
     order by ps.section;
end;
$$;

create or replace function public.teacher_set_section(p_section text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
begin
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;
  if public.pia_caller_role() is distinct from 'teacher' then
    raise exception 'PIA: only a teacher can do this.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.professor_sections ps where ps.email = v_email and ps.section = trim(coalesce(p_section, ''))) then
    raise exception 'That is not one of your sections.' using errcode = '42501';
  end if;
  update public.profiles set section = trim(p_section)
   where lower(email) = v_email and lower(trim(coalesce(role, ''))) = 'teacher';
end;
$$;

-- Deleting and renaming a section now also look at professor_sections.
create or replace function public.admin_delete_section(p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := trim(coalesce(p_name, ''));
begin
  perform public.pia_require_admin();
  if exists (select 1 from public.profiles where section = v_name and lower(trim(coalesce(role, 'student'))) = 'student') then
    raise exception 'This section still has students. Move them first.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.professor_sections where section = v_name) then
    raise exception 'A professor is assigned to this section.' using errcode = 'P0001';
  end if;
  delete from public.checkins        where section = v_name;
  delete from public.join_requests   where section = v_name;
  delete from public.stage_overrides where section = v_name;
  delete from public.sections        where name = v_name;
end;
$$;

create or replace function public.admin_rename_section(p_old text, p_new text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text := trim(coalesce(p_old, ''));
  v_new text := trim(coalesce(p_new, ''));
begin
  perform public.pia_require_admin();
  if v_new = '' then raise exception 'Type the new section name.' using errcode = 'P0001'; end if;
  if length(v_new) > 40 then raise exception 'Keep the name under 40 characters.' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.sections where name = v_old) then
    raise exception 'That section no longer exists.' using errcode = 'P0001';
  end if;
  if v_new = v_old then return; end if;
  if exists (select 1 from public.sections where lower(name) = lower(v_new) and name <> v_old) then
    raise exception 'A section with that name already exists.' using errcode = 'P0001';
  end if;
  update public.sections          set name = v_new             where name = v_old;
  update public.profiles          set section = v_new          where section = v_old;
  update public.professors        set assigned_section = v_new where assigned_section = v_old;
  update public.professor_sections set section = v_new         where section = v_old;
  update public.checkins          set section = v_new          where section = v_old;
  update public.join_requests     set section = v_new          where section = v_old;
  update public.stage_overrides   set section = v_new          where section = v_old;
end;
$$;

revoke all on function public.admin_set_section_professor(text, text) from public, anon;
revoke all on function public.admin_professor_sections() from public, anon;
revoke all on function public.teacher_my_sections() from public, anon;
revoke all on function public.teacher_set_section(text) from public, anon;
revoke all on function public.admin_delete_section(text) from public, anon;
revoke all on function public.admin_rename_section(text, text) from public, anon;
grant execute on function public.admin_set_section_professor(text, text) to authenticated;
grant execute on function public.admin_professor_sections() to authenticated;
grant execute on function public.teacher_my_sections() to authenticated;
grant execute on function public.teacher_set_section(text) to authenticated;
grant execute on function public.admin_delete_section(text) to authenticated;
grant execute on function public.admin_rename_section(text, text) to authenticated;

-- Postflight: one professor per section, and every pair points at a real professor.
do $$
begin
  if exists (select 1 from public.professor_sections group by section having count(*) > 1) then
    raise exception 'PIA 0059 ABORT: a section has more than one professor.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.professor_sections ps
              where not exists (select 1 from public.professors f where lower(f.email) = ps.email)) then
    raise exception 'PIA 0059 ABORT: a section points at a professor who does not exist.' using errcode = 'P0001';
  end if;
end;
$$;

commit;

-- ROLLBACK: drop trigger if exists professors_claim_section on public.professors;
--   drop function if exists public.professors_claim_section();
--   drop function if exists public.admin_set_section_professor(text,text);
--   drop function if exists public.admin_professor_sections();
--   drop function if exists public.teacher_my_sections();
--   drop function if exists public.teacher_set_section(text);
--   drop function if exists public.pia_sync_professor(text);
--   drop table if exists public.professor_sections;
--   (then re-run 0057 to restore admin_delete_section / admin_rename_section)
