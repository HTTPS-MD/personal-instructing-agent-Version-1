-- PIA 0048: make the closing time live.
--   1. tutoring_status() also says how many seconds are left until the closing time (null when
--      none is set or it has passed). The page uses it only to lock at the exact moment; it is
--      never drawn, so students still see no time anywhere.
--   2. app_config and question_bank are added to the realtime publication, so an admin's save
--      reaches the other admins' screens at once. (Row changes are still filtered by the
--      existing row-level security: only admins can read these tables.)
-- Read-only function change; the publication change adds no data. Nothing is deleted.
begin;

do $$
begin
  if to_regprocedure('public.tutoring_status()') is null then
    raise exception 'PIA 0048 requires tutoring_status() (apply 0045 first).';
  end if;
end;
$$;

create or replace function public.tutoring_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email  text := public.pia_game_email();
  v_closes timestamptz;
begin
  select c.game_closes_at into v_closes from public.app_config c where c.id = 1;
  return jsonb_build_object(
    'closed', v_closes is not null and v_closes <= now(),
    'seconds_to_close',
      case when v_closes is not null and v_closes > now()
           then ceil(extract(epoch from (v_closes - now())))::int end);
end;
$$;

revoke all on function public.tutoring_status() from public, anon;
grant execute on function public.tutoring_status() to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                    and schemaname = 'public' and tablename = 'app_config') then
      alter publication supabase_realtime add table public.app_config;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                    and schemaname = 'public' and tablename = 'question_bank') then
      alter publication supabase_realtime add table public.question_bank;
    end if;
  end if;
end;
$$;

commit;
