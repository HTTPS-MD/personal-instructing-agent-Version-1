-- ============================================================================
-- PIA 0053 -- TYPING STUDENT NUMBERS BY HAND
-- ============================================================================
-- For the admin who adds students one at a time and has no spreadsheet:
--
--   admin_students_with_numbers(section)   the section's students with the number
--                                          each already has (empty when none), so the
--                                          admin page can show one box per student.
--   admin_set_student_number(email, number) REPLACED so that a number already given
--                                          to another student says so in plain words
--                                          instead of a database error.
--
-- Requires 0052. SAFE TO RE-RUN. No table or row is changed.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.student_numbers') is null
     or to_regprocedure('public.pia_require_admin()') is null then
    raise exception 'PIA 0053 ABORT (nothing changed): apply 0052 first.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.admin_students_with_numbers(p_section text)
returns table (email text, full_name text, number text)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pia_require_admin();
  return query
    select p.email, p.full_name, sn.number
      from public.profiles p
      left join public.student_numbers sn on sn.email = lower(p.email)
     where trim(p.section) = trim(p_section)
       and lower(trim(coalesce(p.role, 'student'))) = 'student'
       and p.email is not null
     order by p.full_name;
end;
$$;

create or replace function public.admin_set_student_number(p_email text, p_number text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key   text := public.pia_number_key(p_number);
  v_owner text;
begin
  perform public.pia_require_admin();
  if v_key !~ '^[0-9]{11}$' then
    raise exception 'PIA: a student number has 11 digits.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where lower(email) = lower(trim(p_email))) then
    raise exception 'PIA: no student is registered with that email.' using errcode = 'P0002';
  end if;

  select sn.email into v_owner
    from public.student_numbers sn
   where sn.number_key = v_key and sn.email <> lower(trim(p_email));
  if v_owner is not null then
    raise exception 'PIA: that number already belongs to another student (%).', v_owner using errcode = 'P0001';
  end if;

  insert into public.student_numbers (email, number_key, number)
  values (lower(trim(p_email)), v_key, trim(p_number))
  on conflict (email) do update set number_key = excluded.number_key, number = excluded.number, updated_at = now();
end;
$$;

revoke all on function public.admin_students_with_numbers(text), public.admin_set_student_number(text, text) from public, anon;
grant execute on function public.admin_students_with_numbers(text), public.admin_set_student_number(text, text) to authenticated;

commit;

-- ROLLBACK: drop function if exists public.admin_students_with_numbers(text);
--   (admin_set_student_number keeps working; 0052's version can be restored by re-running 0052.)
