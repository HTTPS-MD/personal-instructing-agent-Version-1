-- ============================================================================
-- PIA 0054 -- STUDENT NUMBERS FOR THE ROSTER TABLE
-- ============================================================================
-- The Students page shows one box per student for the student number. It asks for
-- the numbers of the students on the page in one call:
--
--   admin_numbers_for(emails)   email + number for each of those students that
--                               has one. Admin only.
--
-- Requires 0052. SAFE TO RE-RUN. No table or row is changed.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.student_numbers') is null
     or to_regprocedure('public.pia_require_admin()') is null then
    raise exception 'PIA 0054 ABORT (nothing changed): apply 0052 first.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.admin_numbers_for(p_emails text[])
returns table (email text, number text)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pia_require_admin();
  return query
    select sn.email, sn.number
      from public.student_numbers sn
     where sn.email in (select lower(trim(e)) from unnest(coalesce(p_emails, '{}')) as e);
end;
$$;

revoke all on function public.admin_numbers_for(text[]) from public, anon;
grant execute on function public.admin_numbers_for(text[]) to authenticated;

commit;

-- ROLLBACK: drop function if exists public.admin_numbers_for(text[]);
