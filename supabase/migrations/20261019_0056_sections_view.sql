-- ============================================================================
-- PIA 0056 -- DATA FOR THE SECTIONS PAGE
-- ============================================================================
-- The Sections page opens with one card per section and, inside a section, shows
-- that section's attendance and its students:
--
--   admin_section_students(section)   a section's students with the student number,
--                                     condition, stage, status and whether OCEAN is
--                                     done. Admin only.
--   admin_checkin_overview()          REPLACED: the same, and each section now also
--                                     says how many of its students finished OCEAN.
--
-- Requires 0052. SAFE TO RE-RUN. No table or row is changed.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.student_numbers') is null
     or to_regclass('public.checkins') is null
     or to_regprocedure('public.pia_require_admin()') is null then
    raise exception 'PIA 0056 ABORT (nothing changed): apply 0052 first.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.admin_section_students(p_section text)
returns table (email text, full_name text, number text, group_type text, current_stage text, status text, is_ocean_done boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pia_require_admin();
  return query
    select p.email, p.full_name, sn.number, p.group_type, p.current_stage, p.status,
           coalesce(p.is_ocean_done, false)
      from public.profiles p
      left join public.student_numbers sn on sn.email = lower(p.email)
     where trim(p.section) = trim(p_section)
       and lower(trim(coalesce(p.role, 'student'))) = 'student'
       and p.email is not null
     order by lower(p.full_name);
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
               'section', s.section, 'students', s.n, 'without_number', s.missing, 'ocean_done', s.ocean) order by s.section)
        from (select trim(p.section) as section, count(*) as n,
                     count(*) filter (where sn.email is null) as missing,
                     count(*) filter (where coalesce(p.is_ocean_done, false)) as ocean
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

revoke all on function public.admin_section_students(text), public.admin_checkin_overview() from public, anon;
grant execute on function public.admin_section_students(text), public.admin_checkin_overview() to authenticated;

commit;

-- ROLLBACK: drop function if exists public.admin_section_students(text);
--   (re-run 0052 to restore the previous admin_checkin_overview.)
