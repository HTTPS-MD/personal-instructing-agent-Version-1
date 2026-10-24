-- PIA 0062: close the sessions of students who have gone quiet.
--
-- WHY. A student who closes the tab (or whose page is killed) leaves two things behind: an open
-- game window (game_windows.ended_at is null) and the "in a tutoring session" / "signed in" marks
-- on the profile. Nothing ever cleared them, so the admin showed "Active session" for children who
-- left weeks ago, and every window's Duration kept growing (one read 470 hours).
--
-- RULE. A student is QUIET when student_presence.last_seen is older than 20 minutes (or there is
-- no row). A signed-in student page reports in every 45 seconds while it is visible, and the idle
-- sign-out ends a minimised page after about 16 minutes, so 20 quiet minutes means the page is gone.
-- For every quiet student:
--   * each of their open game windows is closed at the time of their LAST ACTIVITY (the latest
--     answer, hint or step), with ended_reason = 'idle', or 'idle-long' when the window spans more
--     than 6 hours (a human should look at those);
--   * profiles.is_in_game becomes false and profiles.active_devices is emptied.
-- Nothing else is touched: no answer, score, OCEAN result or stage.
--
-- HOW OFTEN. Every 5 minutes, by pg_cron, when the extension can be enabled here. If it cannot,
-- the function still exists: schedule it from Database > Cron, or call it by hand.
--
--   select public.pia_close_idle_game_sessions(true);    -- DRY RUN: only counts, changes nothing
--   select public.pia_close_idle_game_sessions();        -- does it
--
-- NOTE. The first run also closes the three windows left open on purpose by the manual cleanup of
-- 2026-10-24 (0, 1 and about 6,658 minutes). They are tagged 'idle' / 'idle-long', so they can be
-- found again.
--
-- Requires 0039 (game_windows, step tables) and 0026 (student_presence). SAFE TO RE-RUN.
begin;

do $$
begin
  if to_regclass('public.game_windows') is null
     or to_regclass('public.student_presence') is null
     or to_regclass('public.step_events') is null then
    raise exception 'PIA 0062 ABORT (nothing changed): apply 0026 and 0039 first.' using errcode = 'P0001';
  end if;
end;
$$;

-- The open windows whose student has been quiet for 20 minutes, with their last activity.
create or replace function public.pia_idle_game_windows()
returns table (session_id uuid, student_email text, window_no int, started_at timestamptz, last_activity timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select w.session_id, w.student_email, w.window_no, w.started_at,
         greatest(w.started_at, coalesce(a.last_activity, w.started_at)) as last_activity
    from public.game_windows w
    left join lateral (
      select max(t) as last_activity
        from (
          select max(e.happened_at) as t from public.step_events e
           where e.session_id = w.session_id and e.student_email = w.student_email and e.happened_at >= w.started_at
          union all
          select max(h.taken_at) from public.step_hints h
           where h.session_id = w.session_id and h.student_email = w.student_email and h.taken_at >= w.started_at
          union all
          select max(s.updated_at) from public.step_states s
           where s.session_id = w.session_id and s.student_email = w.student_email and s.updated_at >= w.started_at
        ) x
    ) a on true
   where w.ended_at is null
     and not exists (
           select 1 from public.student_presence sp
            where lower(sp.student_email) = lower(w.student_email)
              and sp.last_seen > now() - interval '20 minutes');
$$;

create or replace function public.pia_close_idle_game_sessions(p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_windows  int := 0;
  v_profiles int := 0;
begin
  if p_dry_run then
    select count(*) into v_windows from public.pia_idle_game_windows();
    select count(*) into v_profiles
      from public.profiles p
     where lower(trim(coalesce(p.role, 'student'))) = 'student'
       and (p.is_in_game or coalesce(array_length(p.active_devices, 1), 0) > 0)
       and not exists (select 1 from public.student_presence sp
                        where lower(sp.student_email) = lower(p.email)
                          and sp.last_seen > now() - interval '20 minutes');
    return jsonb_build_object('dry_run', true, 'windows_would_close', v_windows, 'profiles_would_clear', v_profiles);
  end if;

  update public.game_windows w
     set ended_at     = i.last_activity,
         ended_reason = case when i.last_activity - i.started_at > interval '6 hours' then 'idle-long' else 'idle' end
    from public.pia_idle_game_windows() i
   where w.session_id = i.session_id
     and w.student_email = i.student_email
     and w.window_no = i.window_no
     and w.ended_at is null;
  get diagnostics v_windows = row_count;

  update public.profiles p
     set is_in_game = false,
         active_devices = '{}'
   where lower(trim(coalesce(p.role, 'student'))) = 'student'
     and (p.is_in_game or coalesce(array_length(p.active_devices, 1), 0) > 0)
     and not exists (select 1 from public.student_presence sp
                      where lower(sp.student_email) = lower(p.email)
                        and sp.last_seen > now() - interval '20 minutes');
  get diagnostics v_profiles = row_count;

  return jsonb_build_object('dry_run', false, 'windows_closed', v_windows, 'profiles_cleared', v_profiles);
end;
$$;

-- Only the database itself (the schedule below) and an administrator in the SQL Editor run these.
revoke all on function public.pia_idle_game_windows()                 from public, anon, authenticated;
revoke all on function public.pia_close_idle_game_sessions(boolean)   from public, anon, authenticated;

-- Every 5 minutes. Skipped with a notice (not an error) if pg_cron cannot be enabled here.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'pia-close-idle-game-sessions';
  perform cron.schedule('pia-close-idle-game-sessions', '*/5 * * * *', 'select public.pia_close_idle_game_sessions()');
exception when others then
  raise notice 'PIA 0062: the function is installed but the 5-minute schedule was NOT created (%). Schedule it in Database > Cron.', sqlerrm;
end;
$$;

commit;
