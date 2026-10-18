-- ============================================================================
-- PIA 0057 -- RENAME AND DELETE A SECTION
-- ============================================================================
--   admin_rename_section(old, new)   the new name goes everywhere the old one
--                                    was: sections, students, professors,
--                                    attendance, requests, stage overrides.
--   admin_delete_section(name)       only an EMPTY section: no student, no
--                                    professor assigned. Anything else is
--                                    refused, so nobody is ever left without
--                                    a section.
--
-- Admin only. Requires 0052. SAFE TO RE-RUN.
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.pia_require_admin()') is null
     or to_regclass('public.checkins') is null then
    raise exception 'PIA 0057 ABORT (nothing changed): apply 0052 first.' using errcode = 'P0001';
  end if;
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

  update public.sections       set name = v_new             where name = v_old;
  update public.profiles       set section = v_new          where section = v_old;
  update public.professors     set assigned_section = v_new where assigned_section = v_old;
  update public.checkins       set section = v_new          where section = v_old;
  update public.join_requests  set section = v_new          where section = v_old;
  update public.stage_overrides set section = v_new         where section = v_old;
end;
$$;

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
  if exists (select 1 from public.profiles where section = v_name) then
    raise exception 'This section still has students. Move them first.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.professors where assigned_section = v_name) then
    raise exception 'A professor is assigned to this section.' using errcode = 'P0001';
  end if;
  delete from public.checkins        where section = v_name;
  delete from public.join_requests   where section = v_name;
  delete from public.stage_overrides where section = v_name;
  delete from public.sections        where name = v_name;
end;
$$;

revoke all on function public.admin_rename_section(text, text) from public, anon;
revoke all on function public.admin_delete_section(text) from public, anon;
grant execute on function public.admin_rename_section(text, text) to authenticated;
grant execute on function public.admin_delete_section(text) to authenticated;

commit;
