-- ============================================================================
-- PIA 0055 -- WHICH OF THESE STUDENT NUMBERS ARE TAKEN
-- ============================================================================
-- The Add students dialog asks, before it creates anything, whether any of the
-- numbers typed already belong to a student:
--
--   admin_numbers_taken(numbers)   one row per number that is already used:
--                                  the number, the student's name and email.
--                                  Admin only.
--
-- Requires 0052. SAFE TO RE-RUN. No table or row is changed.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.student_numbers') is null
     or to_regprocedure('public.pia_require_admin()') is null
     or to_regprocedure('public.pia_number_key(text)') is null then
    raise exception 'PIA 0055 ABORT (nothing changed): apply 0052 first.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.admin_numbers_taken(p_numbers text[])
returns table (number_key text, full_name text, email text)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pia_require_admin();
  return query
    select sn.number_key, p.full_name, sn.email
      from public.student_numbers sn
      left join public.profiles p on lower(p.email) = sn.email
     where sn.number_key in (select public.pia_number_key(n) from unnest(coalesce(p_numbers, '{}')) as n);
end;
$$;

revoke all on function public.admin_numbers_taken(text[]) from public, anon;
grant execute on function public.admin_numbers_taken(text[]) to authenticated;

commit;

-- ROLLBACK: drop function if exists public.admin_numbers_taken(text[]);
