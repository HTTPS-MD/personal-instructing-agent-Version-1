-- PIA 0063: a deleted student takes their student number (and door records) with them.
--
-- WHY. 0052 gave every student a number in public.student_numbers, keyed by email. Deleting a
-- participant (admin_delete_user, 0021) removes the profile, the auth user and the responses, but it
-- was written before 0052 and does not know about that table. The number stayed behind, still
-- "belonging" to an email that no longer exists, so adding the same student again failed with
-- "<email> already has this number" while the student could not be found anywhere.
--
-- WHAT.
--   1. ONE TIME: numbers that belong to no profile are removed. A copy goes to
--      student_numbers_orphans_backup_20261025 first (locked: nobody can read it through the API).
--   2. FROM NOW ON: a trigger on profiles. Whenever a profile is deleted, by any path, that
--      student's number, waiting join requests and roll-call marks are deleted with it.
-- Nothing else is touched. No other student, no answer, score or OCEAN result.
--
-- Requires 0052 (student_numbers, join_requests) and 0058 (attendance_marks). SAFE TO RE-RUN.
begin;

do $$
begin
  if to_regclass('public.student_numbers') is null
     or to_regclass('public.join_requests') is null
     or to_regclass('public.attendance_marks') is null then
    raise exception 'PIA 0063 ABORT (nothing changed): apply 0052 and 0058 first.' using errcode = 'P0001';
  end if;
end;
$$;

-- 1. The numbers that belong to nobody: backup, then delete.
drop table if exists public.student_numbers_orphans_backup_20261025;
create table public.student_numbers_orphans_backup_20261025 as
select n.*
  from public.student_numbers n
 where not exists (select 1 from public.profiles p where lower(p.email) = lower(n.email));

alter table public.student_numbers_orphans_backup_20261025 enable row level security;
revoke all on public.student_numbers_orphans_backup_20261025 from public, anon, authenticated;

do $$
declare
  v_orphans  int;
  v_profiles int;
begin
  select count(*) into v_orphans  from public.student_numbers_orphans_backup_20261025;
  select count(*) into v_profiles from public.profiles;
  -- A sane run removes a handful. Many, or an empty profiles table, means something is wrong.
  if v_profiles = 0 or v_orphans > 30 then
    raise exception 'STOP: % orphan numbers and % profiles. Nothing was changed.', v_orphans, v_profiles;
  end if;

  delete from public.student_numbers n
   using public.student_numbers_orphans_backup_20261025 b
   where n.email = b.email;
end;
$$;

-- 2. From now on.
create or replace function public.pia_forget_deleted_student()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.student_numbers   where lower(email) = lower(old.email);
  delete from public.join_requests     where lower(email) = lower(old.email);
  delete from public.attendance_marks  where lower(email) = lower(old.email);
  return old;
end;
$$;

revoke all on function public.pia_forget_deleted_student() from public, anon, authenticated;

drop trigger if exists trg_pia_forget_deleted_student on public.profiles;
create trigger trg_pia_forget_deleted_student
  after delete on public.profiles
  for each row execute function public.pia_forget_deleted_student();

commit;
